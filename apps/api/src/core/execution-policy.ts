import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import {
  ExecutionPolicyPlan,
  ExecutionRules,
  EngineId,
  Workflow,
  type Subject,
} from "@hyper/contracts";
import type { PoolClient, Pool } from "pg";
import type { Database } from "../db/database.js";
import { assertMember } from "./security.js";
import { ProjectAccess } from "./project-access.js";
import { stableDigest } from "./credentials.js";

type Queryable = Pool | PoolClient;
/** Only controlled host messages; safe to show for private file workflows. */
export class ExecutionLimitError extends BadRequestException {}
type Layer = {
  scope: string;
  scopeId: string;
  revision: number;
  rules: ExecutionRules;
};
export const defaultExecutionRules = {
  maxContextBytes: 100000,
  maxOutputTokens: 4096,
  maxDurationSeconds: 180,
  maxActions: 30,
  engines: EngineId.options as string[],
  workflows: Workflow.options as string[],
  expression: "balanced",
};
export function intersectRules(layers: ExecutionRules[]) {
  const result = { ...defaultExecutionRules };
  for (const rules of layers) {
    for (const key of [
      "maxContextBytes",
      "maxOutputTokens",
      "maxDurationSeconds",
      "maxActions",
    ] as const)
      if (rules[key] !== undefined)
        result[key] = Math.min(result[key], rules[key]!);
    if (rules.engines)
      result.engines = result.engines.filter((x) =>
        rules.engines!.includes(x as any),
      );
    if (rules.workflows)
      result.workflows = result.workflows.filter((x) =>
        rules.workflows!.includes(x as any),
      );
    if (rules.expression) result.expression = rules.expression;
  }
  return result;
}
export class ExecutionPolicyService {
  constructor(readonly db: Database) {}
  static async lock(c: PoolClient, workspaceId: string) {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "execution-policy:" + workspaceId,
    ]);
  }
  async layers(c: Queryable, s: Subject, projectId?: string): Promise<Layer[]> {
    const rows = await c.query(
      `SELECT scope,scope_id AS "scopeId",revision,rules FROM cw_execution_policies
      WHERE workspace_id=$1 AND ((scope='workspace' AND scope_id=$1) OR (scope='project' AND scope_id=$2) OR (scope='personal' AND scope_id=$3))
      ORDER BY CASE scope WHEN 'workspace' THEN 1 WHEN 'project' THEN 2 ELSE 3 END`,
      [s.workspaceId, projectId ?? null, s.id],
    );
    return rows.rows.map((row) => ({
      ...row,
      rules: ExecutionRules.parse(row.rules),
    }));
  }
  async view(s: Subject, projectId: string) {
    const role = await assertMember(this.db, s);
    await new ProjectAccess(this.db).assert(s, projectId);
    const layers = await this.layers(this.db.pool, s, projectId);
    const counters = await this.db.pool.query(
      `SELECT count(*)::int AS workspace,
      count(*) FILTER(WHERE project_id=$2)::int AS project,count(*) FILTER(WHERE actor_id=$3)::int AS personal
      FROM cw_policy_admissions WHERE workspace_id=$1 AND admitted_at >= (date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
      [s.workspaceId, projectId, s.id],
    );
    await assertMember(this.db, s);
    await new ProjectAccess(this.db).assert(s, projectId);
    return {
      layers,
      effective: intersectRules(layers.map((x) => x.rules)),
      counts: counters.rows[0],
      canManageShared: role === "admin",
      dayBoundary: "UTC",
    };
  }
  async prepare(s: Subject, projectId: string, raw: ExecutionPolicyPlan) {
    const plan = ExecutionPolicyPlan.parse(raw);
    const role = await assertMember(this.db, s);
    await new ProjectAccess(this.db).assert(s, projectId);
    if (plan.scope !== "personal" && role !== "admin")
      throw new ForbiddenException("只有工作区管理员可以修改共享执行规则。");
    const id =
      plan.scope === "workspace"
        ? s.workspaceId
        : plan.scope === "project"
          ? projectId
          : s.id;
    const current = (
      await this.db.pool.query(
        "SELECT revision FROM cw_execution_policies WHERE workspace_id=$1 AND scope=$2 AND scope_id=$3",
        [s.workspaceId, plan.scope, id],
      )
    ).rows[0];
    if ((current?.revision ?? 0) !== plan.expectedRevision)
      throw new ConflictException("执行规则已更新，请重新读取后确认。");
    return { plan, scopeId: id };
  }
  async apply(
    c: PoolClient,
    s: Subject,
    projectId: string,
    raw: ExecutionPolicyPlan,
    key: string,
    sourceRunId?: string,
  ) {
    const plan = ExecutionPolicyPlan.parse(raw);
    await ExecutionPolicyService.lock(c, s.workspaceId);
    const role = (
      await c.query(
        "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
        [s.workspaceId, s.id],
      )
    ).rows[0]?.role;
    if (!role || (plan.scope !== "personal" && role !== "admin"))
      throw new ForbiddenException("执行规则修改权限已撤销。");
    if (
      !(
        await c.query(
          "SELECT id FROM cw_projects WHERE workspace_id=$1 AND id=$2",
          [s.workspaceId, projectId],
        )
      ).rowCount
    )
      throw new ForbiddenException("项目范围无效。");
    const scopeId =
      plan.scope === "workspace"
        ? s.workspaceId
        : plan.scope === "project"
          ? projectId
          : s.id;
    const hash = stableDigest({ plan, scopeId });
    const prior = (
      await c.query(
        "SELECT input_hash,receipt FROM cw_execution_policy_changes WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.input_hash !== hash)
        throw new ConflictException("规则操作幂等键冲突。");
      return prior.receipt;
    }
    const current = (
      await c.query(
        "SELECT revision FROM cw_execution_policies WHERE workspace_id=$1 AND scope=$2 AND scope_id=$3 FOR UPDATE",
        [s.workspaceId, plan.scope, scopeId],
      )
    ).rows[0];
    if ((current?.revision ?? 0) !== plan.expectedRevision)
      throw new ConflictException("执行规则已更新，请重新读取后确认。");
    const revision = plan.expectedRevision + 1;
    await c.query(
      `INSERT INTO cw_execution_policies(workspace_id,scope,scope_id,revision,rules,updated_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(workspace_id,scope,scope_id) DO UPDATE SET revision=EXCLUDED.revision,rules=EXCLUDED.rules,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,
      [s.workspaceId, plan.scope, scopeId, revision, plan.rules, s.id],
    );
    const receipt = {
      tool: "policy.configure",
      scope: plan.scope,
      scopeId,
      revision,
      rules: plan.rules,
    };
    await c.query(
      `INSERT INTO cw_execution_policy_changes(id,workspace_id,actor_id,scope,scope_id,revision,rules,source_run_id,idempotency_key,input_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        randomUUID(),
        s.workspaceId,
        s.id,
        plan.scope,
        scopeId,
        revision,
        plan.rules,
        sourceRunId ?? null,
        key,
        hash,
        receipt,
      ],
    );
    return receipt;
  }
  async save(
    s: Subject,
    projectId: string,
    raw: ExecutionPolicyPlan,
    key: string,
  ) {
    // An identical retry remains readable after revision advancement; ACL still checked.
    await assertMember(this.db, s);
    await new ProjectAccess(this.db).assert(s, projectId);
    return this.db.tx((c) => this.apply(c, s, projectId, raw, key));
  }
  async projectId(c: Queryable, run: any): Promise<string | undefined> {
    if (!run.conversation_id) return undefined; // Personal source files do not inherit unrelated project rules.
    return (
      await c.query(
        "SELECT project_id FROM cw_conversations WHERE id=$1 AND workspace_id=$2",
        [run.conversation_id, run.workspace_id],
      )
    ).rows[0]?.project_id;
  }
  async admit(s: Subject, run: any) {
    return this.db.tx(async (c) => {
      await ExecutionPolicyService.lock(c, s.workspaceId);
      const row = (
        await c.query(
          "SELECT state,execution_policy_snapshot FROM cw_runs WHERE id=$1 FOR UPDATE",
          [run.id],
        )
      ).rows[0];
      if (row?.state !== "running") throw new Error("执行已停止。");
      if (row.execution_policy_snapshot) return row.execution_policy_snapshot;
      if (
        !(
          await c.query(
            "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
            [s.workspaceId, s.id],
          )
        ).rowCount
      )
        throw new ForbiddenException("执行权限已撤销。");
      const projectId = await this.projectId(c, run),
        layers = await this.layers(c, s, projectId);
      const taskRules = ExecutionRules.omit({ dailyRuns: true }).parse(
        run.task_rules ?? {},
      );
      const effective = intersectRules([
        ...layers.map((x) => x.rules),
        taskRules,
      ]);
      this.assertAllowed(run, effective);
      for (const layer of layers) {
        if (layer.rules.dailyRuns === undefined) continue;
        const used = (
          await c.query(
            `SELECT count(*)::int AS n FROM cw_policy_admissions WHERE workspace_id=$1
          AND admitted_at >= (date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
          AND ($2='workspace' OR ($2='project' AND project_id=$3) OR ($2='personal' AND actor_id=$3))`,
            [s.workspaceId, layer.scope, layer.scopeId],
          )
        ).rows[0].n;
        if (used >= layer.rules.dailyRuns)
          throw new BadRequestException(
            "今日 AI 执行次数已达有效规则上限（UTC 日界）。",
          );
      }
      const snapshot = {
        schemaVersion: 1,
        policyVersion: run.policy_version,
        layers,
        taskRules,
        effective,
        admittedAt: new Date().toISOString(),
        projectId,
      };
      await c.query(
        "INSERT INTO cw_policy_admissions(run_id,workspace_id,project_id,actor_id) VALUES($1,$2,$3,$4)",
        [run.id, s.workspaceId, projectId ?? null, s.id],
      );
      await c.query(
        "UPDATE cw_runs SET execution_policy_snapshot=$2 WHERE id=$1",
        [run.id, snapshot],
      );
      return snapshot;
    });
  }
  assertAllowed(run: any, effective: ReturnType<typeof intersectRules>) {
    if (
      !effective.engines.includes(run.engine) ||
      !effective.workflows.includes(run.workflow)
    )
      throw new ForbiddenException("当前执行规则不允许此执行器或工作类型。");
  }
  async check(
    c: Queryable,
    s: Subject,
    run: any,
    contextBytes?: number,
    actions?: number,
  ) {
    if (!run.execution_policy_snapshot) throw new Error("缺少执行规则快照。");
    const layers = await this.layers(c, s, await this.projectId(c, run));
    // Relaxation applies to new Runs only. Current restrictions always narrow the admitted snapshot.
    const effective = intersectRules([
      run.execution_policy_snapshot.effective,
      ...layers.map((x) => x.rules),
      run.execution_policy_snapshot.taskRules,
    ]);
    this.assertAllowed(run, effective);
    if (
      Date.now() - Date.parse(run.execution_policy_snapshot.admittedAt) >
      effective.maxDurationSeconds * 1000
    )
      throw new ExecutionLimitError("执行已达到有效时限。");
    if (contextBytes !== undefined && contextBytes > effective.maxContextBytes)
      throw new ExecutionLimitError(
        effective.maxContextBytes === 100000
          ? "当前上下文超过 100 KB，请缩小讨论范围或拆分成果后重试。"
          : `当前上下文超过有效执行规则的 ${effective.maxContextBytes} 字节上限，请缩小范围。`,
      );
    if (actions !== undefined && actions > effective.maxActions)
      throw new ExecutionLimitError("本次业务动作数量超过有效执行规则上限。");
    return effective;
  }
}
