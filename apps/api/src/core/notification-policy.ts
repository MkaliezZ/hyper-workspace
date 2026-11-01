import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Subject } from "@hyper/contracts";
import {
  NotificationField,
  NotificationPlan,
  NotificationRules,
} from "@hyper/contracts/notifications";
import type { Database } from "../db/database.js";
import { assertMember } from "./security.js";
import { ProjectAccess } from "./project-access.js";
import { stableDigest } from "./credentials.js";
import { ExecutionPolicyService } from "./execution-policy.js";
type Queryable = Pick<PoolClient, "query">;
type Layer = {
  scope: "workspace" | "project" | "personal";
  scopeId: string;
  revision: number;
  rules: NotificationRules;
};
const defaultImportant: NotificationField[] = [
  "added",
  "removed",
  "assignee",
  "status",
  "dueDate",
];
export function effectiveNotifications(layers: Layer[]) {
  let mode: "all" | "important" | "quiet" = "all",
    interval = 0,
    important: NotificationField[] | undefined;
  for (const layer of layers) {
    const rules = NotificationRules.parse(layer.rules);
    if (rules.mode === "quiet") mode = "quiet";
    else if (rules.mode === "important" && mode !== "quiet") mode = "important";
    interval = Math.max(interval, rules.minIntervalMinutes ?? 0);
    if (rules.importantFields !== undefined)
      important =
        important === undefined
          ? [...rules.importantFields]
          : important.filter((field) => rules.importantFields!.includes(field));
  }
  return {
    mode,
    importantFields: important ?? [...defaultImportant],
    minIntervalMinutes: interval,
    layers: layers.map(({ scope, scopeId, revision }) => ({
      scope,
      scopeId,
      revision,
    })),
  };
}
export function notificationDecision(
  effective: ReturnType<typeof effectiveNotifications>,
  changes: { kind: string; fields: string[] }[],
  lastNotification: string | Date | null,
  now: Date,
) {
  if (!changes.length)
    return { notify: false, reason: "unchanged", nextEligibleAt: null };
  if (effective.mode === "quiet")
    return { notify: false, reason: "quiet", nextEligibleAt: null };
  const important = changes.some((change) =>
    change.kind === "added" || change.kind === "removed"
      ? effective.importantFields.includes(change.kind)
      : change.fields.some((field) =>
          effective.importantFields.includes(
            (field === "assigneeId" ? "assignee" : field) as NotificationField,
          ),
        ),
  );
  if (effective.mode === "important" && !important)
    return { notify: false, reason: "not_important", nextEligibleAt: null };
  if (lastNotification && effective.minIntervalMinutes > 0) {
    const next = new Date(
      new Date(lastNotification).getTime() +
        effective.minIntervalMinutes * 60000,
    );
    if (!Number.isFinite(next.getTime()))
      throw new BadRequestException("上次提醒时间无法核对，未发布新消息。");
    if (next.getTime() > now.getTime())
      return {
        notify: false,
        reason: "rate_limited",
        nextEligibleAt: next.toISOString(),
      };
  }
  return { notify: true, reason: "published", nextEligibleAt: null };
}
/** Governs follow-up publication only. It grants no data access, performs no external push and never trusts model importance claims. */
export class NotificationPolicyService {
  constructor(readonly db: Database) {}
  static async lock(c: PoolClient, workspaceId: string) {
    await ExecutionPolicyService.lock(c, workspaceId);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "notification-policy:" + workspaceId,
    ]);
  }
  static async layers(
    c: Queryable,
    s: Subject,
    projectId: string,
  ): Promise<Layer[]> {
    return (
      await c.query(
        `SELECT scope,scope_id AS "scopeId",revision,rules FROM cw_notification_policies
   WHERE workspace_id=$1 AND ((scope='workspace' AND scope_id=$1) OR (scope='project' AND scope_id=$2) OR (scope='personal' AND scope_id=$3))
   ORDER BY CASE scope WHEN 'workspace' THEN 1 WHEN 'project' THEN 2 ELSE 3 END`,
        [s.workspaceId, projectId, s.id],
      )
    ).rows.map((row) => ({
      ...row,
      rules: NotificationRules.parse(row.rules),
    }));
  }
  async view(s: Subject, projectId: string) {
    const role = await assertMember(this.db, s);
    await new ProjectAccess(this.db).assert(s, projectId);
    const layers = await NotificationPolicyService.layers(
      this.db.pool,
      s,
      projectId,
    );
    const changes = (
      await this.db.pool.query(
        `SELECT id,scope,scope_id AS "scopeId",revision,receipt,idempotency_key AS "requestKey",created_at AS "createdAt" FROM cw_notification_policy_changes WHERE workspace_id=$1 AND actor_id=$2 AND ((scope='workspace' AND scope_id=$1) OR (scope='project' AND scope_id=$3) OR (scope='personal' AND scope_id=$2)) ORDER BY created_at DESC,id DESC LIMIT 20`,
        [s.workspaceId, s.id, projectId],
      )
    ).rows;
    const recentRuns = (
      await this.db.pool.query(
        `SELECT r.id,r.state,r.engine,r.notification_plan->>'operation' AS operation,r.idempotency_key AS "requestKey",r.created_at AS "createdAt" FROM cw_runs r JOIN cw_conversations v ON v.id=r.conversation_id AND v.workspace_id=r.workspace_id WHERE r.workspace_id=$1 AND r.actor_id=$2 AND v.project_id=$3 AND r.workflow='manage_notifications' ORDER BY r.created_at DESC,r.id DESC LIMIT 20`,
        [s.workspaceId, s.id, projectId],
      )
    ).rows;
    await new ProjectAccess(this.db).assert(s, projectId);
    const roleNow = await assertMember(this.db, s);
    return {
      layers,
      effective: effectiveNotifications(layers),
      canManageShared: role === "admin" && roleNow === "admin",
      recentChanges: changes,
      recentRuns,
    };
  }
  private scopeId(
    s: Subject,
    projectId: string,
    plan: Extract<NotificationPlan, { operation: "configure" }>,
  ) {
    return plan.scope === "workspace"
      ? s.workspaceId
      : plan.scope === "project"
        ? projectId
        : s.id;
  }
  async prepare(s: Subject, projectId: string, raw: unknown) {
    const plan = NotificationPlan.parse(raw),
      role = await assertMember(this.db, s);
    await new ProjectAccess(this.db).assert(s, projectId);
    if (plan.operation === "read") return { plan };
    if (plan.scope !== "personal" && role !== "admin")
      throw new ForbiddenException(
        "只有当前管理员可以修改工作区或项目提醒规则。",
      );
    const scopeId = this.scopeId(s, projectId, plan);
    const row = (
      await this.db.pool.query(
        "SELECT revision FROM cw_notification_policies WHERE workspace_id=$1 AND scope=$2 AND scope_id=$3",
        [s.workspaceId, plan.scope, scopeId],
      )
    ).rows[0];
    if ((row?.revision ?? 0) !== plan.expectedRevision)
      throw new ConflictException("提醒规则已变化，请重新读取后确认。");
    return { plan, scopeId };
  }
  async apply(
    c: PoolClient,
    s: Subject,
    projectId: string,
    raw: unknown,
    key: string,
    sourceRunId?: string,
  ) {
    const plan = NotificationPlan.parse(raw);
    if (plan.operation !== "configure")
      throw new BadRequestException("此入口只保存明确的提醒规则。");
    await NotificationPolicyService.lock(c, s.workspaceId);
    const role = (
      await c.query(
        "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
        [s.workspaceId, s.id],
      )
    ).rows[0]?.role;
    if (!role) throw new ForbiddenException("工作区权限已撤销。");
    const scopeId = this.scopeId(s, projectId, plan),
      hash = stableDigest({ plan, scopeId });
    const prior = (
      await c.query(
        "SELECT params_hash,receipt FROM cw_notification_policy_changes WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.params_hash !== hash)
        throw new ConflictException("相同提醒请求键不能更换参数。");
      return prior.receipt;
    }
    if (plan.scope !== "personal" && role !== "admin")
      throw new ForbiddenException("共享提醒规则修改权限已撤销。");
    if (
      !(
        await c.query(
          "SELECT id FROM cw_projects WHERE id=$1 AND workspace_id=$2",
          [projectId, s.workspaceId],
        )
      ).rowCount
    )
      throw new ForbiddenException("项目范围已失效。");
    const current = (
      await c.query(
        "SELECT revision FROM cw_notification_policies WHERE workspace_id=$1 AND scope=$2 AND scope_id=$3",
        [s.workspaceId, plan.scope, scopeId],
      )
    ).rows[0];
    if ((current?.revision ?? 0) !== plan.expectedRevision)
      throw new ConflictException("提醒规则已变化，未覆盖新版本。");
    const revision = (current?.revision ?? 0) + 1,
      id = randomUUID(),
      receipt = {
        tool: "notifications.manage",
        operation: "configure",
        id,
        scope: plan.scope,
        scopeId,
        revision,
        rules: plan.rules,
      };
    await c.query(
      "INSERT INTO cw_notification_policies(workspace_id,scope,scope_id,revision,rules,updated_by)VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,scope,scope_id)DO UPDATE SET revision=EXCLUDED.revision,rules=EXCLUDED.rules,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()",
      [s.workspaceId, plan.scope, scopeId, revision, plan.rules, s.id],
    );
    await c.query(
      "INSERT INTO cw_notification_policy_changes(id,workspace_id,actor_id,scope,scope_id,revision,rules,source_run_id,idempotency_key,params_hash,receipt)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        id,
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
  async save(s: Subject, projectId: string, raw: unknown, key: string) {
    const plan = NotificationPlan.parse(raw);
    if (plan.operation === "read") return this.view(s, projectId);
    await assertMember(this.db, s);
    await new ProjectAccess(this.db).assert(s, projectId);
    // Known own receipts can be replayed after a later revision or role change, never rerun.
    const scopeId = this.scopeId(s, projectId, plan),
      hash = stableDigest({ plan, scopeId });
    const prior = (
      await this.db.pool.query(
        "SELECT params_hash,receipt FROM cw_notification_policy_changes WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.params_hash !== hash)
        throw new ConflictException("相同提醒请求键不能更换参数。");
      return prior.receipt;
    }
    await this.prepare(s, projectId, plan);
    return this.db.tx((c) => this.apply(c, s, projectId, plan, key));
  }
}
