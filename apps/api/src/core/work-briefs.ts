import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  WorkBriefContent,
  WorkBriefPlan,
  BriefReference,
  type Subject,
} from "@hyper/contracts";
import type { Pool, PoolClient } from "pg";
import type { Database } from "../db/database.js";
import { ProjectAccess } from "./project-access.js";
import { stableDigest } from "./credentials.js";
type Queryable = Pool | PoolClient;
export class WorkBriefService {
  constructor(readonly db: Database) {}
  static async lock(c: PoolClient, id: string) {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "work-brief:" + id,
    ]);
  }
  async row(c: Queryable, s: Subject, id: string, projectId: string) {
    const r = (
      await c.query(
        "SELECT * FROM cw_work_briefs WHERE id=$1 AND workspace_id=$2 AND project_id=$3",
        [id, s.workspaceId, projectId],
      )
    ).rows[0];
    if (!r) throw new NotFoundException("任务说明不存在或不在当前项目。");
    return r;
  }
  async manage(c: Queryable, s: Subject, row: any, lock = false) {
    const member = (
      await c.query(
        "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2" +
          (lock ? " FOR SHARE" : ""),
        [s.workspaceId, s.id],
      )
    ).rows[0];
    if (!member || (row && row.owner_id !== s.id && member.role !== "admin"))
      throw new ForbiddenException(
        "只有说明维护人或当前管理员可以修改和确认。",
      );
    return member.role;
  }
  async prepare(s: Subject, projectId: string, raw: WorkBriefPlan) {
    const plan = WorkBriefPlan.parse(raw);
    await new ProjectAccess(this.db).assert(s, projectId);
    const row =
      plan.operation === "create"
        ? undefined
        : await this.row(this.db.pool, s, plan.briefId, projectId);
    await this.manage(this.db.pool, s, row);
    if (
      row &&
      row.version !== ("expectedVersion" in plan ? plan.expectedVersion : 0)
    )
      throw new ConflictException("任务说明已更新，请重新读取。");
    return row;
  }
  async reference(c: Queryable, s: Subject, projectId: string, raw: unknown) {
    const ref = BriefReference.parse(raw),
      row = await this.row(c, s, ref.id, projectId);
    if (row.version !== ref.version || row.status !== "confirmed")
      throw new ConflictException(
        "任务说明未确认或已变化，请完成澄清并确认当前版本后重新发起。",
      );
    return row;
  }
  async get(s: Subject, projectId: string, id: string) {
    const access = new ProjectAccess(this.db);
    await access.assert(s, projectId);
    const current = await this.row(this.db.pool, s, id, projectId);
    const history = (
      await this.db.pool.query(
        'SELECT version,snapshot,actor_id AS "actorId",source_run_id AS "sourceRunId",created_at AS "createdAt" FROM cw_work_brief_versions WHERE brief_id=$1 AND workspace_id=$2 AND version<=$3 ORDER BY version DESC LIMIT 20',
        [id, s.workspaceId, current.version],
      )
    ).rows;
    await access.assert(s, projectId);
    const member = (
      await this.db.pool.query(
        "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
        [s.workspaceId, s.id],
      )
    ).rows[0];
    if (!member) throw new ForbiddenException("工作区权限已撤销。");
    return {
      current,
      history,
      canManage: current.owner_id === s.id || member.role === "admin",
    };
  }
  async list(s: Subject, projectId: string) {
    const access = new ProjectAccess(this.db);
    await access.assert(s, projectId);
    const rows = (
      await this.db.pool.query(
        "SELECT id,version,status,content->>'title' AS title,owner_id AS \"ownerId\" FROM cw_work_briefs WHERE workspace_id=$1 AND project_id=$2 ORDER BY updated_at DESC,id LIMIT 100",
        [s.workspaceId, projectId],
      )
    ).rows;
    await access.assert(s, projectId);
    return rows;
  }
  async save(
    s: Subject,
    projectId: string,
    plan: WorkBriefPlan,
    draft: WorkBriefContent | undefined,
    key: string,
  ) {
    await new ProjectAccess(this.db).assert(s, projectId);
    return this.db.tx((c) => this.apply(c, s, projectId, plan, draft, key));
  }
  async apply(
    c: PoolClient,
    s: Subject,
    projectId: string,
    raw: WorkBriefPlan,
    rawDraft: WorkBriefContent | undefined,
    key: string,
    runId?: string,
  ) {
    const plan = WorkBriefPlan.parse(raw);
    const writing = plan.operation === "create" || plan.operation === "revise";
    if (writing !== !!rawDraft)
      throw new BadRequestException(
        "请为说明创建/修改提供内容；其他操作不能改写内容。",
      );
    const draft = rawDraft ? WorkBriefContent.parse(rawDraft) : undefined;
    // Per-actor action lock also serializes creation/replay before a target exists.
    if (plan.operation !== "create")
      await WorkBriefService.lock(c, plan.briefId);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "work-brief-action:" + s.workspaceId + ":" + s.id + ":" + key,
    ]);
    const row =
      plan.operation === "create"
        ? undefined
        : await this.row(c, s, plan.briefId, projectId);
    await this.manage(c, s, row, true);
    if (
      !(
        await c.query(
          "SELECT id FROM cw_projects WHERE id=$1 AND workspace_id=$2 FOR KEY SHARE",
          [projectId, s.workspaceId],
        )
      ).rowCount
    )
      throw new NotFoundException("项目不可访问。");
    const hash = stableDigest({ projectId, plan, draft }),
      old = (
        await c.query(
          "SELECT input_hash,receipt FROM cw_work_brief_actions WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, key],
        )
      ).rows[0];
    if (old) {
      if (old.input_hash !== hash)
        throw new ConflictException("任务说明幂等键冲突。");
      return old.receipt;
    }
    if (
      row &&
      row.version !== ("expectedVersion" in plan ? plan.expectedVersion : 0)
    )
      throw new ConflictException("任务说明已更新，请重新读取。");
    const id = row?.id ?? randomUUID(),
      version = (row?.version ?? 0) + 1;
    let content = draft
      ? {
          title: draft.title,
          goal: draft.goal,
          scope: draft.scope,
          constraints: draft.constraints,
          completionCriteria: draft.completionCriteria,
        }
      : row.content;
    let questions: any[] = row?.questions ?? [];
    if (
      draft &&
      JSON.stringify(questions.map((q) => q.question)) !==
        JSON.stringify(draft.questions)
    )
      questions = draft.questions.map((question) => ({
        id: randomUUID(),
        question,
        answer: null,
        answeredBy: null,
      }));
    if (plan.operation === "answer") {
      const ids = new Set<string>();
      for (const a of plan.answers) {
        if (
          ids.has(a.questionId) ||
          !questions.some((q) => q.id === a.questionId)
        )
          throw new BadRequestException(
            "澄清目标无效或重复，请重新读取当前问题。",
          );
        ids.add(a.questionId);
      }
      questions = questions.map((q) => {
        const a = plan.answers.find((a) => a.questionId === q.id);
        return a ? { ...q, answer: a.answer, answeredBy: s.id } : q;
      });
    }
    const missing =
      !content.scope ||
      !content.completionCriteria ||
      questions.some((q) => !q.answer);
    if (plan.operation === "confirm" && missing)
      throw new BadRequestException(
        "请补齐范围、完成标准并回答全部澄清问题后确认。",
      );
    const status =
      plan.operation === "confirm"
        ? "confirmed"
        : missing
          ? "needs_input"
          : "draft";
    const confirmedBy = status === "confirmed" ? s.id : null;
    await c.query(
      "INSERT INTO cw_work_briefs(id,workspace_id,project_id,owner_id,version,status,content,questions,confirmed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,status=EXCLUDED.status,content=EXCLUDED.content,questions=EXCLUDED.questions,confirmed_by=EXCLUDED.confirmed_by,updated_at=clock_timestamp()",
      [
        id,
        s.workspaceId,
        projectId,
        row?.owner_id ?? s.id,
        version,
        status,
        content,
        JSON.stringify(questions),
        confirmedBy,
      ],
    );
    const snapshot = {
      id,
      version,
      status,
      content,
      questions,
      confirmedBy,
      policyVersion: "1.0.0",
      channel: runId ? "ai" : "human",
    };
    await c.query(
      "INSERT INTO cw_work_brief_versions(brief_id,workspace_id,version,snapshot,actor_id,source_run_id) VALUES($1,$2,$3,$4,$5,$6)",
      [id, s.workspaceId, version, snapshot, s.id, runId ?? null],
    );
    const receipt = {
      tool: writing ? "brief.write" : "brief.manage",
      briefId: id,
      version,
      status,
      operation: plan.operation,
      sourceRunId: runId ?? null,
      policyVersion: "1.0.0",
    };
    await c.query(
      "INSERT INTO cw_work_brief_actions(workspace_id,actor_id,idempotency_key,input_hash,receipt) VALUES($1,$2,$3,$4,$5)",
      [s.workspaceId, s.id, key, hash, receipt],
    );
    return receipt;
  }
}
