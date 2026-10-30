import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ModelSpendingPlan, type Subject } from "@hyper/contracts";
import type { Pool, PoolClient } from "pg";
import type { Database } from "../db/database.js";
import type { ProviderUsage } from "./model-usage.js";
import { assertMember } from "./security.js";
import { stableDigest } from "./credentials.js";
export class SpendLimitError extends BadRequestException {}
export const micros = (value: string) =>
  BigInt(value.split(".")[0]!) * 1000000n +
  BigInt((value.split(".")[1] ?? "").padEnd(6, "0"));
export const picos = (value: string) =>
  BigInt(value.split(".")[0]!) * 1000000000000n +
  BigInt((value.split(".")[1] ?? "").padEnd(12, "0"));
export function units(value: bigint | string, scale = 12): string {
  const n = BigInt(value),
    negative = n < 0n,
    raw = (negative ? -n : n).toString().padStart(scale + 1, "0");
  const tail = raw.slice(-scale).replace(/0+$/, "");
  return (
    (negative ? "-" : "") + raw.slice(0, -scale) + (tail ? "." + tail : "")
  );
}
/** Rates are micro-currency per million tokens: multiplying tokens produces pico-currency exactly. */
export function estimateUsage(
  price: any,
  usage: ProviderUsage,
  transport: string,
) {
  if (
    usage.status !== "reported" ||
    transport !== "completed" ||
    usage.inputTokens === null
  )
    return null;
  const input = BigInt(usage.inputTokens),
    read =
      usage.cacheReadTokens === null ? null : BigInt(usage.cacheReadTokens),
    write =
      usage.cacheWriteTokens === null ? null : BigInt(usage.cacheWriteTokens);
  const base = BigInt(price.input_rate),
    readRate = BigInt(price.cache_read_rate),
    writeRate = BigInt(price.cache_write_rate),
    outputRate = BigInt(price.output_rate);
  const remaining = input - (read ?? 0n) - (write ?? 0n);
  if (remaining < 0n) return null;
  const possibilities = [
    base,
    ...(read === null ? [readRate] : []),
    ...(write === null ? [writeRate] : []),
  ];
  const upper = possibilities.reduce((a, b) => (a > b ? a : b)),
    lower = possibilities.reduce((a, b) => (a < b ? a : b));
  return {
    amount:
      remaining * upper +
      (read ?? 0n) * readRate +
      (write ?? 0n) * writeRate +
      BigInt(usage.outputTokens ?? 0) * outputRate,
    upper: remaining > 0n && upper !== lower,
  };
}
type Queryable = Pool | PoolClient;
type Plan = ModelSpendingPlan;
export class ModelSpendingService {
  constructor(readonly db: Database) {}
  static async lock(c: PoolClient, profileId: string) {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "model-spending:" + profileId,
    ]);
  }
  async target(c: Queryable, s: Subject, plan: Plan) {
    const profileId =
      plan.operation === "configure"
        ? plan.modelProfileId
        : (
            await c.query(
              "SELECT model_profile_id FROM cw_model_requests WHERE id=$1 AND workspace_id=$2",
              [plan.requestId, s.workspaceId],
            )
          ).rows[0]?.model_profile_id;
    if (!profileId) throw new NotFoundException("费用目标不存在或不可访问。");
    return profileId as string;
  }
  async authorize(c: Queryable, s: Subject, profileId: string, lock = false) {
    const member = (
      await c.query(
        "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2" +
          (lock ? " FOR SHARE" : ""),
        [s.workspaceId, s.id],
      )
    ).rows[0];
    const model = (
      await c.query(
        "SELECT id,owner_id,purpose,provider FROM cw_model_profiles WHERE id=$1 AND workspace_id=$2",
        [profileId, s.workspaceId],
      )
    ).rows[0];
    if (
      !member ||
      !model ||
      (model.owner_id ? model.owner_id !== s.id : member.role !== "admin")
    )
      throw new ForbiddenException(
        "只有个人连接的所有者或工作区连接的管理员可以管理此费用账户。",
      );
    return model;
  }
  async prepare(s: Subject, raw: Plan) {
    const plan = ModelSpendingPlan.parse(raw);
    await assertMember(this.db, s);
    const profileId = await this.target(this.db.pool, s, plan);
    await this.authorize(this.db.pool, s, profileId);
    if (plan.operation === "configure") {
      const current = (
        await this.db.pool.query(
          "SELECT revision FROM cw_model_spend_controls WHERE model_profile_id=$1",
          [profileId],
        )
      ).rows[0];
      if ((current?.revision ?? 0) !== plan.expectedRevision)
        throw new ConflictException("费用配置已更新，请重新读取后确认。");
    } else {
      const row = (
        await this.db.pool.query(
          "SELECT charge_revision FROM cw_model_requests WHERE id=$1 AND workspace_id=$2",
          [plan.requestId, s.workspaceId],
        )
      ).rows[0];
      if (row?.charge_revision !== plan.expectedRevision)
        throw new ConflictException("费用核对记录已更新，请重新读取。");
    }
    return { profileId, plan };
  }
  async balance(
    c: Queryable,
    profileId: string,
    currency: string,
    exclude?: string,
  ) {
    return (
      await c.query(
        `SELECT count(*) FILTER(WHERE cost_status IN ('unpriced','unknown') AND (budget_revision IS NULL OR settled_at IS NOT NULL OR started_at<now()-interval '5 minutes'))::int AS unknown,
      count(*) FILTER(WHERE charge_review_required)::int AS review,
      count(*) FILTER(WHERE cost_currency IS NOT NULL AND cost_currency<>$2)::int AS mismatched,
      COALESCE(sum(COALESCE(declared_cost_picos,estimated_cost_picos,0)) FILTER(WHERE cost_currency=$2),0)::text AS spent,
      COALESCE(sum(reserved_picos) FILTER(WHERE declared_cost_picos IS NULL AND estimated_cost_picos IS NULL),0)::text AS held
      FROM cw_model_requests WHERE model_profile_id=$1 AND ($3::uuid IS NULL OR id<>$3) AND started_at >= (date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
        [profileId, currency, exclude ?? null],
      )
    ).rows[0];
  }
  /** Called in the request-admission transaction, before any upstream network I/O. */
  async admit(c: PoolClient, profileId: string, requestId: string) {
    await ModelSpendingService.lock(c, profileId);
    const control = (
      await c.query(
        "SELECT * FROM cw_model_spend_controls WHERE model_profile_id=$1",
        [profileId],
      )
    ).rows[0];
    if (!control) return;
    let reserve = 0n;
    if (control.daily_limit_picos !== null) {
      const balance = await this.balance(
        c,
        profileId,
        control.currency,
        requestId,
      );
      if (balance.unknown || balance.review || balance.mismatched)
        throw new SpendLimitError(
          "此连接今日有未知或待核对费用，已暂停新模型请求；请由有权人员核对。",
        );
      reserve = BigInt(control.reservation_picos);
      if (
        BigInt(balance.spent) + BigInt(balance.held) + reserve >
        BigInt(control.daily_limit_picos)
      )
        throw new SpendLimitError(
          "此连接今日可用预算不足以预留本次请求，未发出新的模型请求。",
        );
    }
    await c.query(
      "UPDATE cw_model_requests SET price_version=$2,cost_currency=$3,cost_status='unknown',reserved_picos=$4,budget_revision=$5 WHERE id=$1",
      [
        requestId,
        control.revision,
        control.currency,
        reserve.toString(),
        control.daily_limit_picos === null ? null : control.revision,
      ],
    );
  }
  async settle(
    c: PoolClient,
    row: any,
    usage: ProviderUsage,
    transport: string,
  ) {
    if (!row.price_version) return;
    const price = (
      await c.query(
        "SELECT * FROM cw_model_price_versions WHERE model_profile_id=$1 AND version=$2",
        [row.model_profile_id, row.price_version],
      )
    ).rows[0];
    const estimate = price ? estimateUsage(price, usage, transport) : null;
    const needsReview =
      !!row.budget_revision &&
      (!estimate || estimate.amount > BigInt(row.reserved_picos));
    await c.query(
      `UPDATE cw_model_requests SET estimated_cost_picos=$2,cost_status=CASE WHEN declared_cost_picos IS NOT NULL THEN 'declared' ELSE $3 END,
      charge_review_required=CASE WHEN declared_cost_picos IS NOT NULL THEN false ELSE $4 END WHERE id=$1`,
      [
        row.id,
        estimate?.amount.toString() ?? null,
        estimate
          ? estimate.upper
            ? "upper_estimate"
            : "estimated"
          : "unknown",
        needsReview,
      ],
    );
  }
  async apply(
    c: PoolClient,
    s: Subject,
    raw: Plan,
    key: string,
    runId?: string,
  ) {
    const plan = ModelSpendingPlan.parse(raw),
      profileId = await this.target(c, s, plan);
    await ModelSpendingService.lock(c, profileId);
    await this.authorize(c, s, profileId, true);
    const hash = stableDigest(plan),
      prior = (
        await c.query(
          "SELECT input_hash,receipt FROM cw_model_spend_actions WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, key],
        )
      ).rows[0];
    if (prior) {
      if (prior.input_hash !== hash)
        throw new ConflictException("费用操作幂等键冲突。");
      return prior.receipt;
    }
    let receipt: any;
    if (plan.operation === "configure") {
      const current = (
        await c.query(
          "SELECT revision FROM cw_model_spend_controls WHERE model_profile_id=$1 FOR UPDATE",
          [profileId],
        )
      ).rows[0];
      if ((current?.revision ?? 0) !== plan.expectedRevision)
        throw new ConflictException("费用配置已更新，请重新读取后确认。");
      const balance = await this.balance(c, profileId, plan.currency);
      if (balance.mismatched)
        throw new ConflictException(
          "此连接今日已有其他币种记录，不能混算或自动换汇；请使用另一连接或次日调整。",
        );
      const rates = [
          plan.inputPerMillion,
          plan.outputPerMillion,
          plan.cacheReadPerMillion,
          plan.cacheWritePerMillion,
        ].map(micros),
        hold = picos(plan.requestReservation),
        limit = plan.dailyLimit === null ? null : picos(plan.dailyLimit);
      if (limit !== null && rates.some((x) => x > 0n) && hold === 0n)
        throw new BadRequestException(
          "非零单价启用预算时，每请求预留金额须大于零。",
        );
      const revision = plan.expectedRevision + 1;
      await c.query(
        "INSERT INTO cw_model_price_versions(model_profile_id,version,currency,input_rate,output_rate,cache_read_rate,cache_write_rate,source_note,declared_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          profileId,
          revision,
          plan.currency,
          ...rates.map(String),
          plan.source,
          s.id,
        ],
      );
      await c.query(
        `INSERT INTO cw_model_spend_controls(model_profile_id,revision,currency,daily_limit_picos,reservation_picos) VALUES($1,$2,$3,$4,$5) ON CONFLICT(model_profile_id) DO UPDATE SET revision=EXCLUDED.revision,currency=EXCLUDED.currency,daily_limit_picos=EXCLUDED.daily_limit_picos,reservation_picos=EXCLUDED.reservation_picos`,
        [
          profileId,
          revision,
          plan.currency,
          limit?.toString() ?? null,
          hold.toString(),
        ],
      );
      receipt = {
        tool: "spending.manage",
        operation: "configure",
        modelProfileId: profileId,
        revision,
        currency: plan.currency,
        dailyLimit: plan.dailyLimit,
        requestReservation: plan.requestReservation,
        prices: "employee-declared",
      };
    } else {
      const row = (
        await c.query(
          "SELECT *,started_at >= (date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS is_today FROM cw_model_requests WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
          [plan.requestId, s.workspaceId],
        )
      ).rows[0];
      if (row.charge_revision !== plan.expectedRevision)
        throw new ConflictException("费用核对记录已更新，请重新读取。");
      if (
        !row.settled_at &&
        Date.now() - new Date(row.started_at).getTime() < 300000
      )
        throw new ConflictException(
          "此请求可能仍在进行，请等待结算；中断未结算记录至少等待五分钟后核对。",
        );
      if (row.cost_currency && row.cost_currency !== plan.currency)
        throw new BadRequestException(
          "核对币种必须与原请求一致，不执行自动换汇。",
        );
      const control = (
        await c.query(
          "SELECT currency FROM cw_model_spend_controls WHERE model_profile_id=$1",
          [profileId],
        )
      ).rows[0];
      if (
        !row.cost_currency &&
        row.is_today &&
        control &&
        control.currency !== plan.currency
      )
        throw new BadRequestException(
          "无价格请求的核对币种须与此连接当前账户币种一致。",
        );
      await c.query(
        "UPDATE cw_model_requests SET declared_cost_picos=$2,cost_currency=$3,cost_status='declared',charge_revision=charge_revision+1,charge_review_required=false WHERE id=$1",
        [row.id, picos(plan.amount).toString(), plan.currency],
      );
      receipt = {
        tool: "spending.manage",
        operation: "reconcile",
        modelProfileId: profileId,
        requestId: row.id,
        revision: row.charge_revision + 1,
        currency: plan.currency,
        amount: plan.amount,
        evidenceType: "employee-declared-not-provider-verified",
      };
    }
    await c.query(
      "INSERT INTO cw_model_spend_actions(id,workspace_id,actor_id,model_profile_id,source_run_id,idempotency_key,input_hash,plan,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        randomUUID(),
        s.workspaceId,
        s.id,
        profileId,
        runId ?? null,
        key,
        hash,
        plan,
        receipt,
      ],
    );
    return receipt;
  }
  async save(s: Subject, raw: Plan, key: string) {
    await assertMember(this.db, s);
    return this.db.tx((c) => this.apply(c, s, raw, key));
  }
  async view(s: Subject, profileId?: string) {
    const role = await assertMember(this.db, s);
    const profiles = (
      await this.db.pool.query(
        `SELECT m.id,m.name,m.model,m.provider,m.purpose,m.owner_id AS "ownerId",c.revision,c.currency,c.daily_limit_picos,c.reservation_picos,p.input_rate,p.output_rate,p.cache_read_rate,p.cache_write_rate,p.source_note
      FROM cw_model_profiles m LEFT JOIN cw_model_spend_controls c ON c.model_profile_id=m.id LEFT JOIN cw_model_price_versions p ON p.model_profile_id=m.id AND p.version=c.revision
      WHERE m.workspace_id=$1 AND (m.owner_id IS NULL OR m.owner_id=$2) AND ($3::uuid IS NULL OR m.id=$3) ORDER BY m.created_at DESC,m.id LIMIT 50`,
        [s.workspaceId, s.id, profileId ?? null],
      )
    ).rows;
    const rows = [];
    for (const row of profiles) {
      const canManage =
        row.ownerId === s.id || (row.ownerId === null && role === "admin");
      const balance = row.revision
        ? await this.balance(this.db.pool, row.id, row.currency)
        : null;
      const requests = canManage
        ? (
            await this.db.pool.query(
              `SELECT id,charge_revision AS revision,cost_currency AS currency,cost_status AS status,estimated_cost_picos,declared_cost_picos,reserved_picos,charge_review_required AS "reviewRequired",started_at AS "startedAt",settled_at AS "settledAt"
        FROM cw_model_requests WHERE model_profile_id=$1 AND started_at>=now()-interval '30 days' ORDER BY (cost_status IN ('unpriced','unknown') OR charge_review_required) DESC,started_at DESC,id LIMIT 100`,
              [row.id],
            )
          ).rows.map((r) => ({
            ...r,
            estimate:
              r.estimated_cost_picos === null
                ? null
                : units(r.estimated_cost_picos),
            declared:
              r.declared_cost_picos === null
                ? null
                : units(r.declared_cost_picos),
            reserved: units(r.reserved_picos),
          }))
        : [];
      const history = canManage
        ? (
            await this.db.pool.query(
              `SELECT a.plan,a.receipt,a.created_at AS "createdAt",u.name AS "actorName" FROM cw_model_spend_actions a JOIN cw_users u ON u.id=a.actor_id WHERE a.model_profile_id=$1 ORDER BY a.created_at DESC,a.id LIMIT 20`,
              [row.id],
            )
          ).rows
        : [];
      rows.push({
        id: row.id,
        name: row.name,
        model: row.model,
        purpose: row.purpose,
        canManage,
        revision: row.revision ?? 0,
        currency: row.currency ?? null,
        dailyLimit:
          row.daily_limit_picos === null || row.daily_limit_picos === undefined
            ? null
            : units(row.daily_limit_picos),
        requestReservation:
          row.reservation_picos === null || row.reservation_picos === undefined
            ? "0"
            : units(row.reservation_picos),
        inputPerMillion:
          row.input_rate === null ? null : units(row.input_rate, 6),
        outputPerMillion:
          row.output_rate === null ? null : units(row.output_rate, 6),
        cacheReadPerMillion:
          row.cache_read_rate === null ? null : units(row.cache_read_rate, 6),
        cacheWritePerMillion:
          row.cache_write_rate === null ? null : units(row.cache_write_rate, 6),
        source: canManage ? row.source_note : undefined,
        balance: balance
          ? {
              known: units(balance.spent),
              held: units(balance.held),
              unknown: balance.unknown,
              review: balance.review,
              remaining:
                row.daily_limit_picos === null
                  ? null
                  : units(
                      BigInt(row.daily_limit_picos) -
                        BigInt(balance.spent) -
                        BigInt(balance.held),
                    ),
            }
          : null,
        requests,
        history,
      });
    }
    if ((await assertMember(this.db, s)) !== role)
      throw new ForbiddenException("费用查看权限已变化，请重新读取。");
    return { dayBoundary: "UTC", scope: "per-model-connection", rows };
  }
}
