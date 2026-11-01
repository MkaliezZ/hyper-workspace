import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  BudgetPriceIdentity,
  OrganizationBudgetPlan,
  type Subject,
} from "@hyper/contracts";
import type { Pool, PoolClient } from "pg";
import type { Database } from "../db/database.js";
import { stableDigest } from "./credentials.js";
import { assertMember } from "./security.js";
import { ProjectAccess } from "./project-access.js";
import {
  estimateUsage,
  micros,
  picos,
  units,
  SpendLimitError,
} from "./money.js";
import type { ProviderUsage } from "./model-usage.js";

type Queryable = Pool | PoolClient;
export interface BudgetProof {
  planHash: string;
  projectId: string | null;
  bindingHash: string;
}
const today = "(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')";
/** Company prices and accounting never trust a personal profile owner's price/declaration. */
export class OrganizationBudgetService {
  readonly access: ProjectAccess;
  constructor(readonly db: Database) {
    this.access = new ProjectAccess(db);
  }
  static async lock(c: PoolClient, workspaceId: string) {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "organization-budget:" + workspaceId,
    ]);
  }
  static endpoint(raw: string) {
    const url = new URL(raw);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      raw.length > 2048
    )
      throw new BadRequestException(
        "企业计价地址仅接受不含凭据、查询或片段的 HTTP(S) 模型地址。",
      );
    return raw.replace(/\/+$/, "");
  }
  static priceKey(p: {
    provider: string;
    endpoint: string;
    model: string;
    purpose: string;
  }) {
    return stableDigest([
      p.provider,
      OrganizationBudgetService.endpoint(p.endpoint),
      p.model,
      p.purpose,
    ]);
  }
  async admin(c: Queryable, s: Subject, lock = false) {
    const r = await c.query(
      "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2" +
        (lock ? " FOR SHARE" : ""),
      [s.workspaceId, s.id],
    );
    if (r.rows[0]?.role !== "admin")
      throw new ForbiddenException(
        "仅当前工作区管理员可管理企业计价、预算与企业费用声明。",
      );
    if (
      s.identityCredentialId &&
      !(
        await c.query(
          `SELECT c.id FROM cw_identity_credentials c JOIN cw_external_identities i ON i.id=c.identity_id WHERE c.id=$1 AND i.workspace_id=$2 AND i.user_id=$3 AND c.disabled_at IS NULL` +
            (lock ? " FOR SHARE OF c,i" : ""),
          [s.identityCredentialId, s.workspaceId, s.id],
        )
      ).rowCount
    )
      throw new ForbiddenException("企业身份凭据已失效。");
  }
  async project(c: Queryable, s: Subject, p: OrganizationBudgetPlan) {
    if (p.operation === "budget_price") return null;
    if (p.operation === "budget_configure") {
      if ((p.scope === "workspace") !== (p.projectId === null))
        throw new BadRequestException(
          "工作区预算不绑定项目；项目预算必须绑定确切项目。",
        );
      return p.projectId;
    }
    const row = (
      await c.query(
        "SELECT project_id FROM cw_budget_charges WHERE request_id=$1 AND workspace_id=$2",
        [p.requestId, s.workspaceId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("企业费用记录不存在或无权访问。");
    return row.project_id as string | null;
  }
  async prepare(s: Subject, raw: OrganizationBudgetPlan, checkRevision = true) {
    const plan = OrganizationBudgetPlan.parse(raw);
    await assertMember(this.db, s);
    await this.admin(this.db.pool, s);
    const projectId = await this.project(this.db.pool, s, plan);
    // Financial reconciliation reads only independent company amounts. It never
    // grants source access and remains possible after that source is deleted.
    if (projectId && plan.operation !== "budget_reconcile")
      await this.access.assert(s, projectId);
    const binding =
      projectId && plan.operation !== "budget_reconcile"
        ? await this.access.binding(s, projectId)
        : null;
    if (checkRevision) await this.revision(this.db.pool, s, plan);
    return {
      plan,
      profileId:
        "organization-budget:" +
        (plan.operation === "budget_reconcile"
          ? s.workspaceId
          : (projectId ?? s.workspaceId)),
      proof: {
        planHash: stableDigest(plan),
        projectId,
        bindingHash: stableDigest(binding ?? null),
      } satisfies BudgetProof,
    };
  }
  async revision(c: Queryable, s: Subject, p: OrganizationBudgetPlan) {
    let actual: number;
    if (p.operation === "budget_price")
      actual =
        (
          await this.price(
            c,
            s.workspaceId,
            OrganizationBudgetService.priceKey(p),
          )
        )?.version ?? 0;
    else if (p.operation === "budget_configure")
      actual =
        (
          await c.query(
            "SELECT revision FROM cw_budget_controls WHERE workspace_id=$1 AND scope_id=$2",
            [s.workspaceId, p.projectId ?? s.workspaceId],
          )
        ).rows[0]?.revision ?? 0;
    else
      actual =
        (
          await c.query(
            "SELECT revision FROM cw_budget_charges WHERE workspace_id=$1 AND request_id=$2",
            [s.workspaceId, p.requestId],
          )
        ).rows[0]?.revision ?? -1;
    if (actual !== p.expectedRevision)
      throw new ConflictException(
        "企业费用或规则版本已变化，请重新读取后确认。",
      );
  }
  async price(
    c: Queryable,
    workspaceId: string,
    key: string,
    version?: number,
  ) {
    return (
      await c.query(
        "SELECT * FROM cw_budget_price_versions WHERE workspace_id=$1 AND price_key=$2 AND ($3::integer IS NULL OR version=$3) ORDER BY version DESC LIMIT 1",
        [workspaceId, key, version ?? null],
      )
    ).rows[0];
  }
  async balance(
    c: Queryable,
    workspaceId: string,
    currency: string,
    projectId: string | null,
  ) {
    const hold = projectId ? "q.project_reserved" : "q.workspace_reserved",
      rev = projectId ? "q.project_revision" : "q.workspace_revision";
    return (
      await c.query(
        `SELECT
      count(*) FILTER(WHERE q.status IN ('unpriced','unknown') AND (${rev} IS NULL OR m.settled_at IS NOT NULL OR q.started_at<now()-interval '5 minutes'))::int AS unknown,
      count(*) FILTER(WHERE q.review_required)::int AS review,
      count(*) FILTER(WHERE q.currency IS NOT NULL AND q.currency<>$2)::int AS mismatched,
      COALESCE(sum(COALESCE(q.declared_picos,q.estimated_picos,0)) FILTER(WHERE q.currency=$2),0)::text AS spent,
      COALESCE(sum(${hold}) FILTER(WHERE q.currency=$2 AND q.declared_picos IS NULL AND q.estimated_picos IS NULL),0)::text AS held
      FROM cw_budget_charges q JOIN cw_model_requests m ON m.id=q.request_id WHERE q.workspace_id=$1 AND ($3::uuid IS NULL OR q.project_id=$3) AND q.started_at>=${today}`,
        [workspaceId, currency, projectId],
      )
    ).rows[0];
  }
  /** Caller already holds workspace then profile locks; all checks precede upstream I/O. */
  async admit(
    c: PoolClient,
    s: Subject,
    profileId: string,
    requestId: string,
    projectContext?: { id: string; bindingHash: string },
  ) {
    const request = (
      await c.query(
        `SELECT m.started_at::text AS started_at,p.provider,p.endpoint,p.model,p.purpose AS model_purpose,v.project_id
      FROM cw_model_requests m JOIN cw_model_profiles p ON p.id=m.model_profile_id AND p.workspace_id=m.workspace_id
      LEFT JOIN cw_runs r ON r.id=m.run_id AND r.workspace_id=m.workspace_id
      LEFT JOIN cw_conversations v ON v.id=r.conversation_id AND v.workspace_id=m.workspace_id
      WHERE m.id=$1 AND m.workspace_id=$2 AND m.model_profile_id=$3`,
        [requestId, s.workspaceId, profileId],
      )
    ).rows[0];
    if (!request)
      throw new Error("Company accounting request scope unavailable.");
    if (projectContext) {
      if (request.project_id && request.project_id !== projectContext.id)
        throw new Error("Conflicting host project accounting scope.");
      if (
        !(
          await c.query(
            "SELECT id FROM cw_projects WHERE id=$1 AND workspace_id=$2 FOR SHARE",
            [projectContext.id, s.workspaceId],
          )
        ).rowCount
      )
        throw new Error("Project accounting scope revoked.");
      const binding = (
        await c.query(
          "SELECT * FROM cw_project_sources WHERE project_id=$1 AND workspace_id=$2 FOR SHARE",
          [projectContext.id, s.workspaceId],
        )
      ).rows[0];
      if (stableDigest(binding ?? null) !== projectContext.bindingHash)
        throw new Error("Project accounting source changed.");
      request.project_id = projectContext.id;
    }
    const controls = (
      await c.query(
        "SELECT * FROM cw_budget_controls WHERE workspace_id=$1 AND (scope_id=$1 OR project_id=$2) AND daily_limit_picos IS NOT NULL ORDER BY scope",
        [s.workspaceId, request.project_id ?? null],
      )
    ).rows;
    let price: any,
      key: string | null = null;
    try {
      key = OrganizationBudgetService.priceKey({
        ...request,
        purpose: request.model_purpose,
      });
      price = await this.price(c, s.workspaceId, key);
    } catch (error) {
      if (controls.length)
        throw new SpendLimitError(
          "模型地址没有获准的企业计价依据，未发出新请求。",
        );
    }
    if (controls.length && !price)
      throw new SpendLimitError(
        "此模型尚无管理员确认的企业计价依据，未发出新请求。",
      );
    let workspace: any, project: any;
    for (const control of controls) {
      const label = control.scope === "workspace" ? "工作区" : "项目";
      if (control.currency !== price.currency)
        throw new SpendLimitError(
          label + "预算与获准价格币种不同，不自动换汇，未发出新请求。",
        );
      const balance = await this.balance(
        c,
        s.workspaceId,
        control.currency,
        control.project_id,
      );
      if (balance.unknown || balance.review || balance.mismatched)
        throw new SpendLimitError(
          label + "今日存在未知、待核对或混合币种企业费用，已暂停新请求。",
        );
      const reserve = BigInt(control.reservation_picos);
      if (
        reserve === 0n &&
        [
          "input_rate",
          "output_rate",
          "cache_read_rate",
          "cache_write_rate",
        ].some((k) => BigInt(price[k]) > 0n)
      )
        throw new SpendLimitError(
          label + "预算的每请求预留须大于零，未发出新请求。",
        );
      if (
        BigInt(balance.spent) + BigInt(balance.held) + reserve >
        BigInt(control.daily_limit_picos)
      )
        throw new SpendLimitError(
          label + "跨连接可用预算不足，未发出新模型请求。",
        );
      if (control.scope === "workspace") workspace = control;
      else project = control;
    }
    await c.query(
      `INSERT INTO cw_budget_charges(request_id,workspace_id,project_id,started_at,price_key,price_version,currency,status,workspace_revision,project_revision,workspace_reserved,project_reserved)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        requestId,
        s.workspaceId,
        request.project_id ?? null,
        request.started_at,
        price ? key : null,
        price?.version ?? null,
        price?.currency ?? null,
        price ? "unknown" : "unpriced",
        workspace?.revision ?? null,
        project?.revision ?? null,
        workspace?.reservation_picos ?? "0",
        project?.reservation_picos ?? "0",
      ],
    );
  }
  async settle(
    c: PoolClient,
    row: any,
    usage: ProviderUsage,
    transport: string,
  ) {
    const charge = (
      await c.query(
        "SELECT * FROM cw_budget_charges WHERE request_id=$1 AND workspace_id=$2 FOR UPDATE",
        [row.id, row.workspace_id],
      )
    ).rows[0];
    if (!charge?.price_version) return;
    const price = await this.price(
        c,
        row.workspace_id,
        charge.price_key,
        charge.price_version,
      ),
      estimate = price ? estimateUsage(price, usage, transport) : null;
    const review =
      !!(
        charge.workspace_revision &&
        (!estimate || estimate.amount > BigInt(charge.workspace_reserved))
      ) ||
      !!(
        charge.project_revision &&
        (!estimate || estimate.amount > BigInt(charge.project_reserved))
      );
    await c.query(
      `UPDATE cw_budget_charges SET estimated_picos=$2,status=CASE WHEN declared_picos IS NOT NULL THEN 'declared' ELSE $3 END,review_required=CASE WHEN declared_picos IS NOT NULL THEN false ELSE $4 END WHERE request_id=$1`,
      [
        row.id,
        estimate?.amount.toString() ?? null,
        estimate
          ? estimate.upper
            ? "upper_estimate"
            : "estimated"
          : "unknown",
        review,
      ],
    );
  }
  async apply(
    c: PoolClient,
    s: Subject,
    raw: OrganizationBudgetPlan,
    key: string,
    runId: string | undefined,
    proof: BudgetProof | undefined,
  ) {
    const plan = OrganizationBudgetPlan.parse(raw);
    await OrganizationBudgetService.lock(c, s.workspaceId);
    await this.admin(c, s, true);
    const projectId = await this.project(c, s, plan);
    if (
      !proof ||
      proof.planHash !== stableDigest(plan) ||
      proof.projectId !== projectId
    )
      throw new ForbiddenException("企业预算缺少当前权限核对。");
    if (projectId && plan.operation !== "budget_reconcile") {
      const p = (
        await c.query(
          "SELECT id FROM cw_projects WHERE id=$1 AND workspace_id=$2 FOR SHARE",
          [projectId, s.workspaceId],
        )
      ).rows[0];
      if (!p) throw new NotFoundException("预算项目已失效。");
      const binding = (
        await c.query(
          "SELECT * FROM cw_project_sources WHERE project_id=$1 AND workspace_id=$2 FOR SHARE",
          [projectId, s.workspaceId],
        )
      ).rows[0];
      if (stableDigest(binding ?? null) !== proof.bindingHash)
        throw new ConflictException("项目来源已变化，请重新核对权限。");
    }
    if (
      (
        await c.query(
          "SELECT 1 FROM cw_model_spend_actions WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, key],
        )
      ).rowCount
    )
      throw new ConflictException("费用操作幂等键冲突。");
    const hash = stableDigest(plan),
      prior = (
        await c.query(
          "SELECT input_hash,receipt FROM cw_budget_actions WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, key],
        )
      ).rows[0];
    if (prior) {
      if (prior.input_hash !== hash)
        throw new ConflictException("企业费用操作幂等键冲突。");
      return prior.receipt;
    }
    await this.revision(c, s, plan);
    let receipt: any;
    if (plan.operation === "budget_price") {
      const priceKey = OrganizationBudgetService.priceKey(plan),
        version = plan.expectedRevision + 1;
      await c.query(
        `INSERT INTO cw_budget_price_versions(workspace_id,price_key,version,provider,endpoint,model,purpose,currency,input_rate,output_rate,cache_read_rate,cache_write_rate,source_note,declared_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          s.workspaceId,
          priceKey,
          version,
          plan.provider,
          OrganizationBudgetService.endpoint(plan.endpoint),
          plan.model,
          plan.purpose,
          plan.currency,
          ...[
            plan.inputPerMillion,
            plan.outputPerMillion,
            plan.cacheReadPerMillion,
            plan.cacheWritePerMillion,
          ].map((x) => micros(x).toString()),
          plan.source,
          s.id,
        ],
      );
      receipt = {
        tool: "spending.manage",
        operation: plan.operation,
        priceKey,
        revision: version,
        currency: plan.currency,
        prices: "administrator-declared",
        notInvoice: true,
      };
    } else if (plan.operation === "budget_configure") {
      const balance = await this.balance(
        c,
        s.workspaceId,
        plan.currency,
        projectId,
      );
      if (balance.mismatched && plan.dailyLimit !== null)
        throw new ConflictException(
          "今日已有其他币种企业费用，不能混算或自动换汇。",
        );
      const revision = plan.expectedRevision + 1;
      await c.query(
        `INSERT INTO cw_budget_controls(workspace_id,scope,scope_id,project_id,revision,currency,daily_limit_picos,reservation_picos) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(workspace_id,scope_id) DO UPDATE SET revision=EXCLUDED.revision,currency=EXCLUDED.currency,daily_limit_picos=EXCLUDED.daily_limit_picos,reservation_picos=EXCLUDED.reservation_picos`,
        [
          s.workspaceId,
          plan.scope,
          projectId ?? s.workspaceId,
          projectId,
          revision,
          plan.currency,
          plan.dailyLimit === null ? null : picos(plan.dailyLimit).toString(),
          picos(plan.requestReservation).toString(),
        ],
      );
      receipt = {
        tool: "spending.manage",
        operation: plan.operation,
        scope: plan.scope,
        projectId,
        revision,
        currency: plan.currency,
        dailyLimit: plan.dailyLimit,
        requestReservation: plan.requestReservation,
        existingUnknown: balance.unknown,
        existingReview: balance.review,
      };
    } else {
      const charge = (
        await c.query(
          `SELECT q.*,m.settled_at,q.started_at<now()-interval '5 minutes' AS stale FROM cw_budget_charges q JOIN cw_model_requests m ON m.id=q.request_id WHERE q.request_id=$1 AND q.workspace_id=$2 FOR UPDATE OF q`,
          [plan.requestId, s.workspaceId],
        )
      ).rows[0];
      if (!charge.settled_at && !charge.stale)
        throw new ConflictException(
          "企业请求仍在执行；至少等待五分钟并核对实际回执。",
        );
      if (charge.currency && charge.currency !== plan.currency)
        throw new BadRequestException("请使用该企业记录的原币种，不自动换汇。");
      await c.query(
        "UPDATE cw_budget_charges SET declared_picos=$2,currency=$3,status='declared',review_required=false,revision=revision+1 WHERE request_id=$1",
        [plan.requestId, picos(plan.amount).toString(), plan.currency],
      );
      receipt = {
        tool: "spending.manage",
        operation: plan.operation,
        requestId: plan.requestId,
        revision: plan.expectedRevision + 1,
        currency: plan.currency,
        amount: plan.amount,
        source: "administrator-declared",
        notInvoice: true,
      };
    }
    await c.query(
      "INSERT INTO cw_budget_actions(id,workspace_id,actor_id,project_id,source_run_id,idempotency_key,input_hash,plan,receipt)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        randomUUID(),
        s.workspaceId,
        s.id,
        projectId,
        runId ?? null,
        key,
        hash,
        plan,
        receipt,
      ],
    );
    return receipt;
  }
  async save(s: Subject, raw: OrganizationBudgetPlan, key: string) {
    const prepared = await this.prepare(s, raw, false);
    return this.db.tx((c) =>
      this.apply(c, s, prepared.plan, key, undefined, prepared.proof),
    );
  }
  priceOutput(x: any) {
    return {
      priceKey: x.price_key,
      revision: x.version,
      provider: x.provider,
      endpoint: x.endpoint,
      model: x.model,
      purpose: x.purpose,
      currency: x.currency,
      inputPerMillion: units(x.input_rate, 6),
      outputPerMillion: units(x.output_rate, 6),
      cacheReadPerMillion: units(x.cache_read_rate, 6),
      cacheWritePerMillion: units(x.cache_write_rate, 6),
      source: x.source_note,
    };
  }
  async lookup(s: Subject, raw: unknown) {
    const identity = BudgetPriceIdentity.parse(raw);
    await assertMember(this.db, s);
    await this.admin(this.db.pool, s);
    const priceKey = OrganizationBudgetService.priceKey(identity),
      row = await this.price(this.db.pool, s.workspaceId, priceKey);
    await assertMember(this.db, s);
    await this.admin(this.db.pool, s);
    return { priceKey, price: row ? this.priceOutput(row) : null };
  }
  async view(
    s: Subject,
    projectId: string | null,
    options: {
      before?: string;
      pendingOnly?: boolean;
      requestId?: string;
    } = {},
  ) {
    await assertMember(this.db, s);
    await this.admin(this.db.pool, s);
    if (projectId) await this.access.assert(s, projectId);
    const controls = (
      await this.db.pool.query(
        "SELECT * FROM cw_budget_controls WHERE workspace_id=$1 AND (scope_id=$1 OR project_id=$2) ORDER BY scope",
        [s.workspaceId, projectId],
      )
    ).rows;
    const summaries = [];
    for (const [scope, id] of [
      ["workspace", null],
      ...(projectId ? [["project", projectId]] : []),
    ] as const) {
      const row = controls.find((x) => x.scope === scope),
        currency = row?.currency ?? "CNY";
      const balance = await this.balance(
        this.db.pool,
        s.workspaceId,
        currency,
        id,
      );
      summaries.push({
        scope,
        projectId: id,
        revision: row?.revision ?? 0,
        currency,
        dailyLimit:
          row?.daily_limit_picos == null ? null : units(row.daily_limit_picos),
        requestReservation: units(row?.reservation_picos ?? "0"),
        balance: {
          known: units(balance.spent),
          held: units(balance.held),
          unknown: balance.unknown,
          review: balance.review,
          mismatched: balance.mismatched,
          remaining:
            !row ||
            row.daily_limit_picos === null ||
            balance.unknown ||
            balance.review ||
            balance.mismatched
              ? null
              : units(
                  BigInt(row.daily_limit_picos) -
                    BigInt(balance.spent) -
                    BigInt(balance.held),
                ),
        },
      });
    }
    const costsByCurrency = (
      await this.db.pool.query(
        `SELECT currency,COALESCE(sum(COALESCE(declared_picos,estimated_picos,0)),0)::text AS known,count(*)::int AS requests,count(*) FILTER(WHERE status IN ('unpriced','unknown'))::int AS unknown,count(*) FILTER(WHERE review_required)::int AS review FROM cw_budget_charges WHERE workspace_id=$1 AND started_at>=${today} GROUP BY currency ORDER BY currency NULLS LAST`,
        [s.workspaceId],
      )
    ).rows.map((x) => ({ ...x, known: units(x.known) }));
    const prices = (
      await this.db.pool.query(
        "SELECT DISTINCT ON(price_key) * FROM cw_budget_price_versions WHERE workspace_id=$1 ORDER BY price_key,version DESC LIMIT 100",
        [s.workspaceId],
      )
    ).rows.map((x) => this.priceOutput(x));
    const cursor = options.before
      ? (
          await this.db.pool.query(
            "SELECT started_at::text AS started_cursor,request_id FROM cw_budget_charges WHERE workspace_id=$1 AND request_id=$2",
            [s.workspaceId, options.before],
          )
        ).rows[0]
      : null;
    if (options.before && !cursor)
      throw new NotFoundException(
        "企业账本分页位置已失效，请从最新记录重新读取。",
      );
    const chargeRows = (
      await this.db.pool.query(
        `SELECT q.* FROM cw_budget_charges q WHERE q.workspace_id=$1 AND q.started_at>=now()-interval '30 days'
      AND ($2::boolean=false OR q.status IN ('unpriced','unknown') OR q.review_required)
      AND ($3::timestamptz IS NULL OR (q.started_at,q.request_id)<($3,$4::uuid))
      AND ($5::uuid IS NULL OR q.request_id=$5)
      ORDER BY q.started_at DESC,q.request_id DESC LIMIT 101`,
        [
          s.workspaceId,
          !!options.pendingOnly,
          cursor?.started_cursor ?? null,
          cursor?.request_id ?? null,
          options.requestId ?? null,
        ],
      )
    ).rows;
    const nextBefore =
      chargeRows.length > 100 ? chargeRows[99]!.request_id : null;
    const charges = chargeRows.slice(0, 100).map((x) => ({
      id: x.request_id,
      projectId: x.project_id === projectId ? x.project_id : null,
      scope:
        x.project_id === null
          ? "workspace"
          : x.project_id === projectId
            ? "project"
            : "other-project",
      revision: x.revision,
      currency: x.currency,
      status: x.status,
      estimate: x.estimated_picos === null ? null : units(x.estimated_picos),
      declared: x.declared_picos === null ? null : units(x.declared_picos),
      workspaceReserved: units(x.workspace_reserved),
      projectReserved: units(x.project_reserved),
      reviewRequired: x.review_required,
      startedAt: x.started_at,
    }));
    const history = (
      await this.db.pool.query(
        `SELECT plan,receipt,created_at AS "createdAt" FROM cw_budget_actions WHERE workspace_id=$1 AND (project_id IS NULL OR project_id=$2 OR plan->>'operation'='budget_reconcile') ORDER BY created_at DESC,id LIMIT 20`,
        [s.workspaceId, projectId],
      )
    ).rows;
    if (projectId) await this.access.assert(s, projectId);
    await assertMember(this.db, s);
    await this.admin(this.db.pool, s);
    return {
      controls: summaries,
      costsByCurrency,
      prices,
      charges,
      nextBefore,
      history,
      note: "企业管理员声明计价与独立账本；个人单价/声明不改变企业金额。UTC 请求发起日，不自动换汇。未知不是零，不承诺供应商账单硬封顶。",
      detailsScope:
        "Company financial amounts only across workspace connections; source/business content, identities and personal profile prices/metadata are not exposed. Other project identifiers are redacted; project-rule management still requires source access.",
    };
  }
}
