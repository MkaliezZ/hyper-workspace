import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  Subject,
  RunInput,
  EngineId,
  EngineAdapter,
  EventKind,
  ArtifactRevision,
  TaskInput,
} from "@hyper/contracts";
import { Database } from "../db/database.js";
import { assertMember } from "./security.js";
import { maskKey, stableDigest, Vault } from "./credentials.js";
import { reviseArtifactVersion } from "./artifacts.js";
import { ProjectAccess } from "./project-access.js";
import { ModelService } from "./models.js";

export class WorkspaceService {
  constructor(
    readonly db: Database,
    readonly engines: Map<EngineId, EngineAdapter>,
  ) {
    this.access = new ProjectAccess(db);
  }
  readonly access: ProjectAccess;
  async conversation(s: Subject, id: string) {
    await assertMember(this.db, s);
    const r = await this.db.pool.query(
      "SELECT c.*,p.name,p.goal FROM cw_conversations c JOIN cw_projects p ON p.id=c.project_id WHERE c.id=$1 AND c.workspace_id=$2",
      [id, s.workspaceId],
    );
    if (!r.rowCount) throw new NotFoundException("会话不存在或无权访问。");
    await this.access.assert(s, r.rows[0].project_id);
    return r.rows[0];
  }
  async view(s: Subject, projectId?: string) {
    await assertMember(this.db, s);
    if (projectId) await this.access.assert(s, projectId);
    const projects = await this.access.list(s);
    const project = projectId
      ? projects.find((p) => p.id === projectId)
      : (projects.find((p) => p.name === "产品共创") ?? projects[0]);
    if (!project) throw new NotFoundException("工作区尚无可访问项目。");
    const [messages, tasks, artifacts] = await Promise.all([
      this.db.pool.query(
        'SELECT id,author,role,content,metadata,created_at AS "createdAt" FROM cw_messages WHERE conversation_id=$1 AND workspace_id=$2 ORDER BY position',
        [project.conversationId, s.workspaceId],
      ),
      this.db.pool.query(
        "SELECT id,title,assignee,status,to_char(due_date,'YYYY-MM-DD') AS \"dueDate\" FROM cw_tasks WHERE project_id=$1 AND workspace_id=$2 ORDER BY created_at,id",
        [project.id, s.workspaceId],
      ),
      this.db.pool.query(
        'SELECT a.id,a.title,a.current_version AS version,a.status,v.content,v.created_at AS "createdAt" FROM cw_artifacts a JOIN cw_artifact_versions v ON v.artifact_id=a.id AND v.version=a.current_version WHERE a.project_id=$1 AND a.workspace_id=$2 ORDER BY a.created_at DESC',
        [project.id, s.workspaceId],
      ),
    ]);
    await this.access.assert(s, project.id);
    return {
      user: {
        id: s.id,
        name: s.name,
        workspaceId: s.workspaceId,
        role: await assertMember(this.db, s),
        demo: s.demo,
      },
      projects,
      project,
      messages: messages.rows,
      tasks: tasks.rows,
      artifacts: artifacts.rows,
      engines: Object.fromEntries(
        [...this.engines].map(([k, e]) => [k, e.describeCapabilities()]),
      ),
    };
  }
  async createProject(s: Subject, name: string, goal: string) {
    await assertMember(this.db, s);
    return this.db.tx(async (c) => {
      const id = randomUUID(),
        conversationId = randomUUID();
      await c.query(
        "INSERT INTO cw_projects(id,workspace_id,name,goal) VALUES($1,$2,$3,$4)",
        [id, s.workspaceId, name, goal],
      );
      await c.query(
        "INSERT INTO cw_conversations(id,workspace_id,project_id) VALUES($1,$2,$3)",
        [conversationId, s.workspaceId, id],
      );
      return { id, name, goal, conversationId };
    });
  }
  async talkProject(s: Subject, roomId: string) {
    const scope = await this.access.room(s, roomId);
    return (
      (
        await this.db.pool.query(
          'SELECT p.id,p.name,p.goal,c.id AS "conversationId" FROM cw_project_sources x JOIN cw_projects p ON p.id=x.project_id JOIN cw_conversations c ON c.project_id=p.id WHERE x.workspace_id=$1 AND x.provider_key=$2 AND x.conversation_ref=$3',
          [s.workspaceId, scope.providerKey, roomId],
        )
      ).rows[0] ?? null
    );
  }
  async createTalkProject(
    s: Subject,
    roomId: string,
    name: string,
    goal: string,
  ) {
    const scope = await this.access.room(s, roomId);
    return this.db.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        s.workspaceId + scope.providerKey + roomId,
      ]);
      const existing = (
        await c.query(
          'SELECT p.id,p.name,p.goal,c.id AS "conversationId" FROM cw_project_sources x JOIN cw_projects p ON p.id=x.project_id JOIN cw_conversations c ON c.project_id=p.id WHERE x.workspace_id=$1 AND x.provider_key=$2 AND x.conversation_ref=$3',
          [s.workspaceId, scope.providerKey, roomId],
        )
      ).rows[0];
      if (existing) {
        if (existing.name !== name || existing.goal !== goal)
          throw new ConflictException(
            "此会话已有关联项目，请返回后打开现有项目。",
          );
        return existing;
      }
      const id = randomUUID(),
        conversationId = randomUUID();
      await c.query(
        "INSERT INTO cw_projects(id,workspace_id,name,goal) VALUES($1,$2,$3,$4)",
        [id, s.workspaceId, name, goal],
      );
      await c.query(
        "INSERT INTO cw_conversations(id,workspace_id,project_id) VALUES($1,$2,$3)",
        [conversationId, s.workspaceId, id],
      );
      await c.query(
        "INSERT INTO cw_project_sources(project_id,workspace_id,provider_key,source_kind,conversation_ref,created_by) VALUES($1,$2,$3,'nextcloud-talk',$4,$5)",
        [id, s.workspaceId, scope.providerKey, roomId, s.id],
      );
      return { id, name, goal, conversationId };
    });
  }
  async message(s: Subject, conversationId: string, content: string) {
    await this.conversation(s, conversationId);
    const id = randomUUID();
    await this.db.pool.query(
      "INSERT INTO cw_messages(id,workspace_id,conversation_id,author_id,author,role,content) VALUES($1,$2,$3,$4,$5,'user',$6)",
      [id, s.workspaceId, conversationId, s.id, s.name, content],
    );
    return { id };
  }
  async createTask(s: Subject, conversationId: string, input: TaskInput) {
    const c = await this.conversation(s, conversationId);
    const id = randomUUID();
    await this.db.pool.query(
      "INSERT INTO cw_tasks(id,workspace_id,project_id,title,assignee,due_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        id,
        s.workspaceId,
        c.project_id,
        input.title,
        input.assignee,
        input.dueDate,
        s.id,
      ],
    );
    return { id, ...input, status: "open" };
  }
  async patchTask(
    s: Subject,
    id: string,
    patch: { status?: string; title?: string },
  ) {
    await assertMember(this.db, s);
    const target = (
      await this.db.pool.query(
        "SELECT project_id FROM cw_tasks WHERE id=$1 AND workspace_id=$2",
        [id, s.workspaceId],
      )
    ).rows[0];
    if (!target) throw new NotFoundException("待办不存在。");
    await this.access.assert(s, target.project_id);
    const r = await this.db.pool.query(
      "UPDATE cw_tasks SET status=COALESCE($1,status),title=COALESCE($2,title) WHERE id=$3 AND workspace_id=$4 RETURNING id,title,assignee,status",
      [patch.status ?? null, patch.title ?? null, id, s.workspaceId],
    );
    if (!r.rowCount) throw new NotFoundException("待办不存在。");
    return r.rows[0];
  }
  async artifact(s: Subject, id: string) {
    await assertMember(this.db, s);
    await this.artifactProject(s, id);
    const r = await this.db.pool.query(
      'SELECT a.id,a.title,v.version AS version,a.status,v.content,v.feedback,v.source_message_ids AS "sourceMessageIds",v.created_at AS "createdAt" FROM cw_artifacts a JOIN cw_artifact_versions v ON v.artifact_id=a.id WHERE a.id=$1 AND a.workspace_id=$2 ORDER BY v.version DESC',
      [id, s.workspaceId],
    );
    if (!r.rowCount) throw new NotFoundException("成果不存在。");
    return {
      current: r.rows[0],
      versions: r.rows,
      history: r.rows,
    };
  }
  async revise(s: Subject, id: string, input: ArtifactRevision) {
    await assertMember(this.db, s);
    const projectId = await this.artifactProject(s, id);
    return this.db.tx((c) => reviseArtifactVersion(c, s, id, input, projectId));
  }
  private async artifactProject(s: Subject, id: string) {
    const target = (
      await this.db.pool.query(
        "SELECT project_id FROM cw_artifacts WHERE id=$1 AND workspace_id=$2",
        [id, s.workspaceId],
      )
    ).rows[0];
    if (!target) throw new NotFoundException("成果不存在。");
    await this.access.assert(s, target.project_id);
    return target.project_id as string;
  }
  async search(s: Subject, query: string) {
    await assertMember(this.db, s);
    if (!query.trim()) return [];
    const projectIds = await this.access.visibleIds(s);
    const r = await this.db.pool.query(
      "SELECT id,title,content,type,project_id,source_ref AS \"sourceRef\",source_version AS \"sourceVersion\" FROM cw_assets WHERE workspace_id=$1 AND deleted_at IS NULL AND validity='active' AND (visibility='workspace' OR owner_id=$2) AND (project_id IS NULL OR project_id=ANY($4::uuid[])) AND (title ILIKE $3 OR content ILIKE $3) ORDER BY created_at DESC LIMIT 30",
      [
        s.workspaceId,
        s.id,
        "%" + query.replace(/[\\%_]/g, "\\$&") + "%",
        projectIds,
      ],
    );
    const current = new Set(await this.access.visibleIds(s));
    return r.rows
      .filter((row) => !row.project_id || current.has(row.project_id))
      .map(({ project_id, ...row }) => row);
  }
  async models(s: Subject) {
    await assertMember(this.db, s);
    return (
      await this.db.pool.query(
        "SELECT id,name,provider,endpoint,model,purpose,CASE WHEN owner_id IS NULL THEN 'workspace' ELSE 'personal' END AS scope,key_hint AS \"keyHint\",verified_at AS \"verifiedAt\" FROM cw_model_profiles WHERE workspace_id=$1 AND (owner_id IS NULL OR owner_id=$2) ORDER BY created_at",
        [s.workspaceId, s.id],
      )
    ).rows;
  }
  async saveModel(s: Subject, input: any) {
    const role = await assertMember(this.db, s);
    if (input.scope === "workspace" && role !== "admin")
      throw new ForbiddenException("工作区模型由管理员配置。");
    const endpoint = new URL(input.endpoint);
    if (!["https:", "http:"].includes(endpoint.protocol))
      throw new BadRequestException("模型地址必须使用 HTTP 或 HTTPS。");
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new BadRequestException("模型地址不能携带凭据或查询参数。");
    const id = randomUUID();
    const encrypted = input.apiKey ? new Vault().encrypt(input.apiKey) : null;
    await this.db.pool.query(
      "INSERT INTO cw_model_profiles(id,workspace_id,owner_id,name,provider,endpoint,model,purpose,credential_enc,key_hint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        id,
        s.workspaceId,
        input.scope === "workspace" ? null : s.id,
        input.name,
        input.provider,
        input.endpoint,
        input.model,
        input.purpose,
        encrypted,
        input.apiKey ? maskKey(input.apiKey) : null,
      ],
    );
    return { id, name: input.name, verifiedAt: null };
  }
  async startRun(s: Subject, input: RunInput) {
    const conversation = await this.conversation(s, input.conversationId);
    if (
      input.engine === "fixture" &&
      (!s.demo || process.env.DEMO_MODE !== "true")
    )
      throw new ForbiddenException("演示执行仅用于演示会话。");
    const engine = this.engines.get(input.engine);
    if (!engine?.describeCapabilities().configured)
      throw new BadRequestException(
        input.engine + " 执行器尚未配置；不能将演示流程作为真实引擎。",
      );
    let expectedVersion: number | null = null;
    if (input.workflow === "revise_artifact") {
      if (!input.artifactId)
        throw new BadRequestException("请指定要修改的成果。");
      const artifact = (
        await this.db.pool.query(
          "SELECT current_version FROM cw_artifacts WHERE id=$1 AND workspace_id=$2 AND project_id=$3",
          [input.artifactId, s.workspaceId, conversation.project_id],
        )
      ).rows[0];
      if (!artifact) throw new NotFoundException("成果不在当前项目中。");
      expectedVersion = artifact.current_version;
    }
    const model =
      input.engine === "fixture"
        ? undefined
        : await new ModelService(this.db).resolve(
            s,
            "chat",
            input.modelProfileId,
          );
    const providers = engine.describeCapabilities().modelProviders;
    if (model && providers && !providers.includes(model.provider))
      throw new BadRequestException(
        "所选执行器当前不支持这条连接的 API 类型，请选择兼容连接。",
      );
    const inputHash = stableDigest({ ...input, idempotencyKey: undefined });
    const id = randomUUID();
    const r = await this.db.pool.query(
      "INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,artifact_id,idempotency_key,input_hash,demo,model_profile_id,expected_artifact_version,identity_credential_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(workspace_id,actor_id,idempotency_key) DO NOTHING RETURNING id,state",
      [
        id,
        s.workspaceId,
        s.id,
        input.conversationId,
        input.engine,
        input.workflow,
        input.instruction,
        input.artifactId ?? null,
        input.idempotencyKey,
        inputHash,
        s.demo,
        model?.id ?? null,
        expectedVersion,
        s.identityCredentialId ?? null,
      ],
    );
    if (r.rowCount) return { ...r.rows[0], created: true };
    const old = (
      await this.db.pool.query(
        "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, input.idempotencyKey],
      )
    ).rows[0];
    if (old.input_hash !== inputHash)
      throw new ConflictException("相同幂等键不能用于不同任务。");
    return { id: old.id, state: old.state, created: false };
  }
  async getRun(s: Subject, id: string) {
    await assertMember(this.db, s);
    const target = (
      await this.db.pool.query(
        "SELECT conversation_id FROM cw_runs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3",
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
    if (!target) throw new NotFoundException("执行不存在或无权访问。");
    await this.conversation(s, target.conversation_id);
    const r = await this.db.pool.query(
      'SELECT id,state,engine,workflow,instruction,result,error,context_refs AS "contextRefs",created_at AS "createdAt",updated_at AS "updatedAt" FROM cw_runs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3',
      [id, s.workspaceId, s.id],
    );
    if (!r.rowCount) throw new NotFoundException("执行不存在或无权访问。");
    return r.rows[0];
  }
  async events(s: Subject, id: string, after = 0) {
    await this.getRun(s, id);
    return (
      await this.db.pool.query(
        'SELECT event_id AS "eventId",run_id AS "runId",sequence,kind,data,occurred_at AS "occurredAt",\'1.0.0\' AS "schemaVersion" FROM cw_run_events WHERE run_id=$1 AND sequence>$2 ORDER BY sequence',
        [id, after],
      )
    ).rows;
  }
  async cancel(s: Subject, id: string) {
    await assertMember(this.db, s);
    const owned = await this.db.pool.query(
      "SELECT id FROM cw_runs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3",
      [id, s.workspaceId, s.id],
    );
    if (!owned.rowCount) throw new NotFoundException("执行不存在或无权访问。");
    await this.db.tx(async (c) => {
      const r = await c.query(
        "UPDATE cw_runs SET state='cancelled',updated_at=now() WHERE id=$1 AND state IN ('queued','running','waiting_input','waiting_confirmation') RETURNING id",
        [id],
      );
      if (r.rowCount)
        await appendEvent(c, id, "run.cancelled", {
          message: "已停止后续执行；已完成操作保留。",
        });
    });
    return (
      await this.db.pool.query(
        "SELECT id,state FROM cw_runs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3",
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
  }
}
export async function appendEvent(
  c: PoolClient,
  runId: string,
  kind: EventKind,
  data: Record<string, unknown>,
) {
  const r = await c.query(
    "UPDATE cw_runs SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence-1 AS sequence",
    [runId],
  );
  await c.query(
    "INSERT INTO cw_run_events(event_id,run_id,sequence,kind,data) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), runId, r.rows[0].sequence, kind, data],
  );
}
