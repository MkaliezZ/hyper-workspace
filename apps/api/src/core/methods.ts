import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  MethodActionInput,
  MethodDraft,
  MethodPlan,
  MethodReference,
  type Subject,
} from "@hyper/contracts";
import type { Database } from "../db/database.js";
import { assertMember } from "./security.js";
import { ProjectAccess } from "./project-access.js";
import { lockArtifact } from "./artifacts.js";
import { stableDigest } from "./credentials.js";

const select = `SELECT m.*,v.title,v.kind,v.content,u.name AS maintainer_name,p.name AS project_name,a.title AS source_title
 FROM cw_methods m JOIN cw_method_versions v ON v.method_id=m.id AND v.version=m.current_version
 JOIN cw_users u ON u.id=m.maintainer_id JOIN cw_projects p ON p.id=m.project_id JOIN cw_artifacts a ON a.id=m.source_artifact_id`;
const draftOperation = (plan: MethodPlan) =>
  plan.operation === "create" || plan.operation === "revise";
function checkVersion(
  row: any,
  plan: Exclude<MethodPlan, { operation: "create" }>,
) {
  if (
    row.current_version !== plan.expectedVersion ||
    row.revision !== plan.expectedRevision
  )
    throw new ConflictException("方法内容或发布状态已变化，请重新读取后操作。");
}
function visible(row: any, s: Subject, role: string) {
  return (
    row.state === "published" || row.maintainer_id === s.id || role === "admin"
  );
}
function canManage(row: any, s: Subject, role: string) {
  return row.maintainer_id === s.id || role === "admin";
}
function output(row: any, s: Subject, role: string) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    sourceTitle: row.source_title,
    maintainerId: row.maintainer_id,
    maintainerName: row.maintainer_name,
    sourceArtifactId: row.source_artifact_id,
    sourceVersion: row.source_artifact_version,
    version: row.current_version,
    revision: row.revision,
    state: row.state,
    verification: row.verification,
    evidence: row.verification_evidence,
    scope: row.publication_scope,
    title: row.title,
    kind: row.kind,
    content: row.content,
    canManage: canManage(row, s, role),
    canPublishWorkspace: role === "admin",
  };
}

/** Published methods remain subordinate to source access and never become Policy. */
export class MethodsService {
  readonly access: ProjectAccess;
  constructor(readonly db: Database) {
    this.access = new ProjectAccess(db);
  }

  async list(s: Subject, projectId: string) {
    const role = await assertMember(this.db, s);
    await this.access.assert(s, projectId);
    const allowed = await this.access.visibleIds(s);
    const rows = (
      await this.db.pool.query(
        select +
          ` WHERE m.workspace_id=$1 AND m.project_id=ANY($2::uuid[])
      AND (m.project_id=$3 OR (m.state='published' AND m.publication_scope='workspace'))
      AND (m.state='published' OR m.maintainer_id=$4 OR $5='admin') ORDER BY m.updated_at DESC,m.id LIMIT 50`,
        [s.workspaceId, allowed, projectId, s.id, role],
      )
    ).rows;
    const current = new Set(await this.access.visibleIds(s));
    const roleNow = await assertMember(this.db, s);
    const snapshots = (
      await this.db.pool.query(
        "SELECT id,revision FROM cw_methods WHERE id=ANY($1::uuid[])",
        [rows.map((row) => row.id)],
      )
    ).rows;
    return rows
      .filter(
        (row) =>
          visible(row, s, roleNow) &&
          snapshots.some((x) => x.id === row.id && x.revision === row.revision),
      )
      .filter((row) => current.has(row.project_id))
      .map((row) => output(row, s, roleNow));
  }
  async row(s: Subject, id: string) {
    const role = await assertMember(this.db, s);
    const row = (
      await this.db.pool.query(
        select + " WHERE m.id=$1 AND m.workspace_id=$2",
        [id, s.workspaceId],
      )
    ).rows[0];
    if (!row || !visible(row, s, role))
      throw new NotFoundException("方法不存在或无权访问。");
    await this.access.assert(s, row.project_id);
    return { row, role };
  }
  async get(s: Subject, id: string) {
    const { row, role } = await this.row(s, id);
    const versions = (
      await this.db.pool.query(
        `SELECT v.version,v.title,v.kind,v.content,v.actor_id AS "actorId",u.name AS "actorName",v.source_run_id AS "sourceRunId",v.created_at AS "createdAt" FROM cw_method_versions v JOIN cw_users u ON u.id=v.actor_id WHERE method_id=$1 AND ($2 OR EXISTS(SELECT 1 FROM cw_method_actions a WHERE a.method_id=v.method_id AND a.version=v.version AND a.operation='publish')) ORDER BY version DESC LIMIT 20`,
        [id, canManage(row, s, role)],
      )
    ).rows;
    const actions = (
      await this.db.pool.query(
        `SELECT operation,version,revision,receipt,created_at AS "createdAt" FROM cw_method_actions WHERE method_id=$1 AND ($2 OR operation='publish') ORDER BY revision DESC LIMIT 20`,
        [id, canManage(row, s, role)],
      )
    ).rows;
    const uses = (
      await this.db.pool.query(
        `SELECT x.run_id AS "runId",x.method_version AS version,x.method_revision AS revision,x.context_prepared_at AS "contextPreparedAt",r.state FROM cw_method_uses x JOIN cw_runs r ON r.id=x.run_id WHERE x.method_id=$1 AND r.actor_id=$2 ORDER BY x.context_prepared_at DESC LIMIT 20`,
        [id, s.id],
      )
    ).rows;
    await this.access.assert(s, row.project_id);
    // A concurrent withdrawal must not expose candidate/withdrawn details to readers.
    const fresh = await this.row(s, id);
    if (fresh.row.revision !== row.revision)
      throw new ConflictException("方法已变化，请重新读取。");
    return { current: output(row, s, role), versions, actions, uses };
  }
  async prepare(s: Subject, raw: MethodPlan, projectId: string) {
    const plan = MethodPlan.parse(raw),
      role = await assertMember(this.db, s);
    await this.access.assert(s, projectId);
    if (plan.operation === "create") {
      const artifact = (
        await this.db.pool.query(
          `SELECT a.*,v.content FROM cw_artifacts a JOIN cw_artifact_versions v ON v.artifact_id=a.id AND v.version=a.current_version WHERE a.id=$1 AND a.workspace_id=$2 AND a.project_id=$3`,
          [plan.sourceArtifactId, s.workspaceId, projectId],
        )
      ).rows[0];
      if (!artifact) throw new NotFoundException("来源成果不在当前项目。");
      if (artifact.current_version !== plan.expectedSourceVersion)
        throw new ConflictException("来源成果已变化，请重新选择版本。");
      return {
        plan,
        source: {
          id: artifact.id,
          title: artifact.title,
          version: artifact.current_version,
          content: artifact.content,
          status: artifact.status,
        },
      };
    }
    const { row } = await this.row(s, plan.methodId);
    if (row.project_id !== projectId)
      throw new NotFoundException("请从方法的来源项目管理。");
    if (!canManage(row, s, role))
      throw new ForbiddenException(
        "仅维护人或有来源访问权限的管理员可管理方法。",
      );
    checkVersion(row, plan);
    MethodsService.checkTransition(row, plan, role);
    if (
      plan.operation === "publish" &&
      plan.scope === "workspace" &&
      (await this.access.binding(s, projectId))
    )
      throw new ForbiddenException(
        "来源关联方法仅支持来源项目内发布，不能扩大来源权限。",
      );
    return { plan, method: output(row, s, role) };
  }
  static checkTransition(
    row: any,
    plan: Exclude<MethodPlan, { operation: "create" }>,
    role: string,
  ) {
    if (plan.operation === "publish") {
      if (row.verification !== "employee_verified")
        throw new ConflictException("先由员工确认验证依据，再发布方法。");
      if (row.state === "published")
        throw new ConflictException("方法已发布，请核对当前发布记录。");
      if (plan.scope === "workspace" && role !== "admin")
        throw new ForbiddenException("工作区级发布需要当前工作区管理员权限。");
    }
    if (plan.operation === "verify" && row.state !== "candidate")
      throw new ConflictException("请先将方法修订为候选，再记录验证依据。");
    if (plan.operation === "withdraw" && row.state === "withdrawn")
      throw new ConflictException("方法已经撤回。");
  }
  async record(s: Subject, projectId: string, raw: MethodActionInput) {
    const input = MethodActionInput.parse(raw);
    await assertMember(this.db, s);
    await this.access.assert(s, projectId);
    const hash = stableDigest({
      projectId,
      plan: input.plan,
      draft: input.draft,
    });
    const old = (
      await this.db.pool.query(
        "SELECT input_hash,receipt,method_id FROM cw_method_actions WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, input.idempotencyKey],
      )
    ).rows[0];
    if (old) {
      await this.row(s, old.method_id);
      if (old.input_hash !== hash)
        throw new ConflictException("相同幂等键不能用于不同方法操作。");
      return old.receipt;
    }
    await this.prepare(s, input.plan, projectId);
    return this.db.tx(async (c) => {
      await MethodsService.lockTarget(c, s, input.plan, projectId);
      return MethodsService.apply(
        c,
        s,
        projectId,
        input.plan,
        input.draft,
        input.idempotencyKey,
      );
    });
  }
  static async lockTarget(
    c: PoolClient,
    s: Subject,
    plan: MethodPlan,
    projectId: string,
  ) {
    if (plan.operation === "create")
      return lockArtifact(c, s, plan.sourceArtifactId, projectId);
    const row = (
      await c.query(
        "SELECT * FROM cw_methods WHERE id=$1 AND workspace_id=$2 AND project_id=$3 FOR UPDATE",
        [plan.methodId, s.workspaceId, projectId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("方法不在当前项目。");
    return row;
  }
  static async apply(
    c: PoolClient,
    s: Subject,
    projectId: string,
    raw: MethodPlan,
    rawDraft: unknown,
    key: string,
    sourceRunId?: string,
  ) {
    const plan = MethodPlan.parse(raw);
    const draft = draftOperation(plan)
      ? MethodDraft.parse(rawDraft)
      : undefined;
    if (!draftOperation(plan) && rawDraft !== undefined)
      throw new BadRequestException("管理操作不接受模型生成的内容或决定。");
    const target = await MethodsService.lockTarget(c, s, plan, projectId);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "method:" + s.workspaceId + ":" + s.id + ":" + key,
    ]);
    const member = (
      await c.query(
        "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
        [s.workspaceId, s.id],
      )
    ).rows[0];
    if (!member) throw new ForbiddenException("工作区权限已撤销。");
    const hash = stableDigest({ projectId, plan, draft });
    const old = (
      await c.query(
        "SELECT input_hash,receipt FROM cw_method_actions WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, key],
      )
    ).rows[0];
    if (old) {
      if (old.input_hash !== hash)
        throw new ConflictException("相同幂等键不能用于不同方法操作。");
      return old.receipt;
    }
    let id: string;
    if (plan.operation === "create") {
      if (target.current_version !== plan.expectedSourceVersion)
        throw new ConflictException("来源成果版本已变化。");
      id = randomUUID();
      await c.query(
        `INSERT INTO cw_assets(id,workspace_id,project_id,owner_id,title,content,type,source_ref,source_version,visibility,validity) VALUES($1,$2,$3,$4,$5,$6,'method',$7,'1:1','private','inactive')`,
        [
          id,
          s.workspaceId,
          projectId,
          s.id,
          draft!.title,
          draft!.content,
          "method:" + id,
        ],
      );
      await c.query(
        `INSERT INTO cw_methods(id,workspace_id,project_id,maintainer_id,source_artifact_id,source_artifact_version) VALUES($1,$2,$3,$4,$5,$6)`,
        [
          id,
          s.workspaceId,
          projectId,
          s.id,
          plan.sourceArtifactId,
          plan.expectedSourceVersion,
        ],
      );
      await c.query(
        `INSERT INTO cw_asset_links(id,workspace_id,from_id,to_id,relation,source_version) VALUES($1,$2,$3,$4,'derived_from',$5)`,
        [
          randomUUID(),
          s.workspaceId,
          id,
          plan.sourceArtifactId,
          String(plan.expectedSourceVersion),
        ],
      );
    } else {
      id = target.id;
      if (!canManage(target, s, member.role))
        throw new ForbiddenException("当前主体没有方法管理权限。");
      checkVersion(target, plan);
      MethodsService.checkTransition(target, plan, member.role);
      if (
        plan.operation === "publish" &&
        plan.scope === "workspace" &&
        (
          await c.query(
            "SELECT 1 FROM cw_project_sources WHERE project_id=$1",
            [projectId],
          )
        ).rowCount
      )
        throw new ForbiddenException("来源关联方法不能发布到整个工作区。");
      if (plan.operation === "revise")
        await c.query(
          "UPDATE cw_methods SET current_version=current_version+1,state='candidate',verification='candidate',verification_evidence='',publication_scope='project' WHERE id=$1",
          [id],
        );
      if (plan.operation === "verify")
        await c.query(
          "UPDATE cw_methods SET verification='employee_verified',verification_evidence=$2 WHERE id=$1",
          [id, plan.evidence],
        );
      if (plan.operation === "publish")
        await c.query(
          "UPDATE cw_methods SET state='published',publication_scope=$2 WHERE id=$1",
          [id, plan.scope],
        );
      if (plan.operation === "withdraw")
        await c.query("UPDATE cw_methods SET state='withdrawn' WHERE id=$1", [
          id,
        ]);
      await c.query(
        "UPDATE cw_methods SET revision=revision+1,updated_at=clock_timestamp() WHERE id=$1",
        [id],
      );
    }
    const row = (await c.query("SELECT * FROM cw_methods WHERE id=$1", [id]))
      .rows[0];
    if (draft)
      await c.query(
        `INSERT INTO cw_method_versions(method_id,version,title,kind,content,actor_id,source_run_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          row.current_version,
          draft.title,
          draft.kind,
          draft.content,
          s.id,
          sourceRunId ?? null,
        ],
      );
    const version = (
      await c.query(
        "SELECT title,content FROM cw_method_versions WHERE method_id=$1 AND version=$2",
        [id, row.current_version],
      )
    ).rows[0];
    await c.query(
      `UPDATE cw_assets SET title=$2,content=$3,source_version=$4,visibility=CASE WHEN $5 THEN 'workspace' ELSE 'private' END,validity=CASE WHEN $5 THEN 'active' ELSE 'inactive' END,updated_at=clock_timestamp(),embedding=NULL,embedding_profile_id=NULL,embedding_dimensions=NULL,embedding_source_version=NULL,embedding_model=NULL,embedding_version=NULL,indexed_at=NULL WHERE id=$1`,
      [
        id,
        version.title,
        version.content,
        row.current_version + ":" + row.revision,
        row.state === "published",
      ],
    );
    const receipt = {
      tool: draftOperation(plan) ? "method.write" : "method.manage",
      id,
      operation: plan.operation,
      version: row.current_version,
      revision: row.revision,
      state: row.state,
      verification: row.verification,
      scope: row.publication_scope,
      maintainerId: row.maintainer_id,
      sourceArtifactId: row.source_artifact_id,
      sourceVersion: row.source_artifact_version,
      evidence: row.verification_evidence,
      reason: plan.operation === "withdraw" ? plan.reason : null,
      confirmed: !draftOperation(plan),
      actorId: s.id,
      actorRole: member.role,
      authority:
        plan.operation === "publish" && plan.scope === "workspace"
          ? "workspace_admin"
          : row.maintainer_id === s.id
            ? "maintainer"
            : "workspace_admin",
      sourceRunId: sourceRunId ?? null,
      policyVersion: "1.0.0",
    };
    await c.query(
      `INSERT INTO cw_method_actions(id,workspace_id,method_id,actor_id,identity_credential_id,source_run_id,operation,version,revision,input_hash,idempotency_key,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        randomUUID(),
        s.workspaceId,
        id,
        s.id,
        s.identityCredentialId ?? null,
        sourceRunId ?? null,
        plan.operation,
        row.current_version,
        row.revision,
        hash,
        key,
        receipt,
      ],
    );
    return receipt;
  }
  async references(s: Subject, projectId: string, raw: MethodReference[]) {
    const refs = MethodReference.array().max(3).parse(raw);
    if (refs.length) {
      await assertMember(this.db, s);
      await this.access.assert(s, projectId);
    }
    if (new Set(refs.map((ref) => ref.id)).size !== refs.length)
      throw new BadRequestException("不能重复选择同一方法。");
    const result = [];
    for (const ref of refs) {
      const { row, role } = await this.row(s, ref.id);
      if (
        row.state !== "published" ||
        row.verification !== "employee_verified" ||
        row.current_version !== ref.version ||
        row.revision !== ref.revision ||
        (row.project_id !== projectId && row.publication_scope !== "workspace")
      )
        throw new ConflictException(
          "方法已更新、撤回或不在本次复用范围，请重新选择。",
        );
      if (
        row.project_id !== projectId &&
        (await this.access.binding(s, row.project_id))
      )
        throw new ForbiddenException("来源关联方法只能在来源项目内复用。");
      result.push(output(row, s, role));
    }
    return result;
  }
  static async lockReferences(
    c: PoolClient,
    s: Subject,
    projectId: string,
    refs: MethodReference[],
  ) {
    for (const ref of [...refs].sort((a, b) => a.id.localeCompare(b.id))) {
      const row = (
        await c.query(
          "SELECT * FROM cw_methods WHERE id=$1 AND workspace_id=$2 FOR SHARE",
          [ref.id, s.workspaceId],
        )
      ).rows[0];
      if (
        !row ||
        row.state !== "published" ||
        row.verification !== "employee_verified" ||
        row.current_version !== ref.version ||
        row.revision !== ref.revision ||
        (row.project_id !== projectId && row.publication_scope !== "workspace")
      )
        throw new ConflictException("复用方法已变化，旧结果未保存。");
      if (
        row.project_id !== projectId &&
        (
          await c.query(
            "SELECT 1 FROM cw_project_sources WHERE project_id=$1",
            [row.project_id],
          )
        ).rowCount
      )
        throw new ForbiddenException("来源关联方法不能跨项目复用。");
    }
  }
  async recordPrepared(s: Subject, run: any) {
    if (!run.method_refs?.length) return;
    const conversation = (
      await this.db.pool.query(
        "SELECT project_id FROM cw_conversations WHERE id=$1 AND workspace_id=$2",
        [run.conversation_id, s.workspaceId],
      )
    ).rows[0];
    await this.references(s, conversation.project_id, run.method_refs);
    await this.db.tx(async (c) => {
      await MethodsService.lockReferences(
        c,
        s,
        conversation.project_id,
        run.method_refs,
      );
      for (const ref of run.method_refs)
        await c.query(
          "INSERT INTO cw_method_uses(run_id,method_id,method_version,method_revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [run.id, ref.id, ref.version, ref.revision],
        );
    });
  }
  static async filterAssets(db: Database, rows: any[]) {
    if (!rows.length) return rows;
    const current = (
      await db.pool.query(
        `SELECT m.id,a.source_version,
      (m.state='published' AND m.verification='employee_verified' AND a.validity='active' AND a.deleted_at IS NULL
       AND a.workspace_id=m.workspace_id AND a.project_id=m.project_id AND a.owner_id=m.maintainer_id
       AND a.type='method' AND a.source_ref='method:'||m.id::text
       AND a.source_version=m.current_version::text||':'||m.revision::text) AS valid
      FROM cw_methods m JOIN cw_assets a ON a.id=m.id WHERE m.id=ANY($1::uuid[])`,
        [rows.map((row) => row.id)],
      )
    ).rows;
    return rows.filter((row) => {
      const method = current.find((x) => x.id === row.id);
      return method
        ? method.valid && method.source_version === row.sourceVersion
        : !row.sourceRef?.startsWith("method:");
    });
  }
}
