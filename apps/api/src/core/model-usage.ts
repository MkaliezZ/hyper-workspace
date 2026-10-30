import { randomUUID } from "node:crypto";
import type { Subject } from "@hyper/contracts";
import type { Database } from "../db/database.js";
import { assertMember } from "./security.js";
import { appendEvent } from "./workspace.js";
import { ModelSpendingService, units } from "./model-spending.js";
export interface ProviderUsage {
  status: "unknown" | "partial" | "reported" | "invalid";
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}
export const unknownUsage = (): ProviderUsage => ({
  status: "unknown",
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
});
/** Normalize only provider counters. Never infer missing tokens from text length or engine UI defaults. */
export function providerUsage(
  provider: string,
  raw: any,
  embedding = false,
): ProviderUsage {
  const value = unknownUsage();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return value;
  let invalid = false;
  const number = (n: unknown) => {
    if (n === undefined || n === null) return null;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
      invalid = true;
      return null;
    }
    return n;
  };
  if (provider === "anthropic") {
    const base = number(raw.input_tokens);
    value.cacheReadTokens = number(raw.cache_read_input_tokens);
    value.cacheWriteTokens = number(raw.cache_creation_input_tokens);
    if (
      base !== null &&
      value.cacheReadTokens !== null &&
      value.cacheWriteTokens !== null
    )
      value.inputTokens = number(
        base + value.cacheReadTokens + value.cacheWriteTokens,
      );
    value.outputTokens = number(raw.output_tokens);
  } else {
    value.inputTokens = number(raw.prompt_tokens ?? raw.input_tokens);
    value.outputTokens = embedding
      ? null
      : number(raw.completion_tokens ?? raw.output_tokens);
    value.cacheReadTokens = number(
      raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens,
    );
    value.reasoningTokens = number(
      raw.completion_tokens_details?.reasoning_tokens,
    );
    const total = number(raw.total_tokens);
    if (
      total !== null &&
      value.inputTokens !== null &&
      (embedding || value.outputTokens !== null) &&
      total !== value.inputTokens + (value.outputTokens ?? 0)
    )
      invalid = true;
    if (
      value.cacheReadTokens !== null &&
      value.inputTokens !== null &&
      value.cacheReadTokens > value.inputTokens
    )
      invalid = true;
    if (
      value.reasoningTokens !== null &&
      value.outputTokens !== null &&
      value.reasoningTokens > value.outputTokens
    )
      invalid = true;
  }
  if (invalid) return { ...unknownUsage(), status: "invalid" };
  value.status =
    value.inputTokens !== null && (embedding || value.outputTokens !== null)
      ? "reported"
      : Object.values(value).some((v) => typeof v === "number")
        ? "partial"
        : "unknown";
  return value;
}
/** Backend-owned accounting context, attached only to resolved model connections. */
export class ModelAccounting {
  constructor(
    readonly db: Database,
    readonly subject: Subject,
    readonly profile: { id: string; model: string; provider: string },
  ) {}
  async begin(
    purpose: "run" | "chat" | "embedding" | "verification",
    runId?: string,
  ) {
    const id = randomUUID(),
      s = this.subject;
    await this.db.tx(async (c) => {
      await ModelSpendingService.lock(c, this.profile.id);
      if (
        !(
          await c.query(
            "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
            [s.workspaceId, s.id],
          )
        ).rowCount
      )
        throw new Error("模型调用权限已撤销。");
      if (
        !(
          await c.query(
            "SELECT id FROM cw_model_profiles WHERE id=$1 AND workspace_id=$2 AND (owner_id IS NULL OR owner_id=$3)",
            [this.profile.id, s.workspaceId, s.id],
          )
        ).rowCount
      )
        throw new Error("模型连接已不可访问。");
      if (
        purpose === "run" &&
        (!runId ||
          !(
            await c.query(
              "SELECT id FROM cw_runs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND model_profile_id=$4 AND state='running'",
              [runId, s.workspaceId, s.id, this.profile.id],
            )
          ).rowCount)
      )
        throw new Error("模型执行范围已停止或不匹配。");
      await c.query(
        `INSERT INTO cw_model_requests(id,workspace_id,actor_id,model_profile_id,run_id,purpose,model,provider) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          s.workspaceId,
          s.id,
          this.profile.id,
          runId ?? null,
          purpose,
          this.profile.model,
          this.profile.provider,
        ],
      );
      await new ModelSpendingService(this.db).admit(c, this.profile.id, id);
    });
    return id;
  }
  async settle(
    id: string,
    usage: ProviderUsage,
    transport: "unknown" | "completed" | "rejected",
    httpStatus?: number,
  ) {
    return this.db.tx(async (c) => {
      await ModelSpendingService.lock(c, this.profile.id);
      const r = await c.query(
        `UPDATE cw_model_requests SET transport=$2,usage_status=$3,input_tokens=$4,output_tokens=$5,cache_read_tokens=$6,cache_write_tokens=$7,reasoning_tokens=$8,http_status=$9,settled_at=clock_timestamp()
      WHERE id=$1 AND workspace_id=$10 AND actor_id=$11 AND settled_at IS NULL RETURNING *`,
        [
          id,
          transport,
          usage.status,
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
          usage.reasoningTokens,
          httpStatus ?? null,
          this.subject.workspaceId,
          this.subject.id,
        ],
      );
      if (r.rowCount)
        await new ModelSpendingService(this.db).settle(
          c,
          r.rows[0],
          usage,
          transport,
        );
      const charge = r.rowCount
        ? (
            await c.query(
              "SELECT price_version,cost_currency,cost_status,estimated_cost_picos,declared_cost_picos,reserved_picos,charge_review_required FROM cw_model_requests WHERE id=$1",
              [id],
            )
          ).rows[0]
        : undefined;
      if (r.rows[0]?.run_id)
        await appendEvent(c, r.rows[0].run_id, "usage.updated", {
          kind: "provider-response",
          requestId: id,
          transport,
          httpStatus: httpStatus ?? null,
          usage,
          charge: charge
            ? {
                priceVersion: charge.price_version,
                currency: charge.cost_currency,
                status: charge.cost_status,
                estimate:
                  charge.estimated_cost_picos === null
                    ? null
                    : units(charge.estimated_cost_picos),
                declared:
                  charge.declared_cost_picos === null
                    ? null
                    : units(charge.declared_cost_picos),
                reserved: units(charge.reserved_picos),
                reviewRequired: charge.charge_review_required,
              }
            : undefined,
        });
      return !!r.rowCount;
    });
  }
}
export class ModelUsageService {
  constructor(readonly db: Database) {}
  async view(s: Subject) {
    await assertMember(this.db, s);
    const rows = (
      await this.db.pool.query(
        `SELECT id,model_profile_id AS "modelProfileId",run_id AS "runId",purpose,model,provider,transport,usage_status AS "usageStatus",input_tokens::float8 AS "inputTokens",output_tokens::float8 AS "outputTokens",cache_read_tokens::float8 AS "cacheReadTokens",cache_write_tokens::float8 AS "cacheWriteTokens",reasoning_tokens::float8 AS "reasoningTokens",http_status AS "httpStatus",started_at AS "startedAt",settled_at AS "settledAt",price_version AS "priceVersion",cost_currency AS "costCurrency",cost_status AS "costStatus",estimated_cost_picos,declared_cost_picos
      FROM cw_model_requests WHERE workspace_id=$1 AND actor_id=$2 AND started_at>=now()-interval '30 days' ORDER BY started_at DESC,id LIMIT 100`,
        [s.workspaceId, s.id],
      )
    ).rows.map((row) => {
      const { estimated_cost_picos, declared_cost_picos, ...safe } = row;
      return {
        ...safe,
        estimatedCost:
          estimated_cost_picos === null ? null : units(estimated_cost_picos),
        declaredCost:
          declared_cost_picos === null ? null : units(declared_cost_picos),
      };
    });
    const summary = (
      await this.db.pool.query(
        `SELECT count(*)::int AS requests,count(*) FILTER(WHERE usage_status='reported')::int AS reported,count(*) FILTER(WHERE usage_status<>'reported')::int AS incomplete,
      sum(input_tokens)::float8 AS "reportedInputTokens",sum(output_tokens)::float8 AS "reportedOutputTokens"
      FROM cw_model_requests WHERE workspace_id=$1 AND actor_id=$2 AND started_at >= (date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
        [s.workspaceId, s.id],
      )
    ).rows[0];
    const costs = (
      await this.db.pool.query(
        `SELECT cost_currency AS currency,sum(COALESCE(declared_cost_picos,estimated_cost_picos))::text AS amount,count(*) FILTER(WHERE declared_cost_picos IS NULL AND estimated_cost_picos IS NULL)::int AS unknown FROM cw_model_requests WHERE workspace_id=$1 AND actor_id=$2 AND cost_currency IS NOT NULL AND started_at >= (date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') GROUP BY cost_currency ORDER BY cost_currency`,
        [s.workspaceId, s.id],
      )
    ).rows.map((row) => ({
      ...row,
      amount: row.amount === null ? null : units(row.amount),
    }));
    await assertMember(this.db, s);
    return {
      period: "30 days, latest 100 requests",
      dayBoundary: "UTC",
      summary,
      rows,
      costs,
      costStatus: costs.length
        ? "estimates-and-declarations"
        : "not-configured",
      note: "仅汇总供应商已返回的数字；不完整用量和未定价费用保持未知。价格估算与员工核对金额均不代表系统已验证供应商账单；不同币种不混算。",
    };
  }
}
