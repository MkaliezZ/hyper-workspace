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
  FileReadingInput,
  FileReadingRevisionInput,
  RunInput,
  EngineId,
  EngineAdapter,
  EventKind,
  ArtifactRevision,
  TaskInput,
  TaskPatch,
} from "@hyper/contracts";
import { isFileWorkflow } from "@hyper/contracts";
import { Database } from "../db/database.js";
import { assertMember } from "./security.js";
import { maskKey, stableDigest, Vault } from "./credentials.js";
import { reviseArtifactVersion } from "./artifacts.js";
import { ProjectAccess } from "./project-access.js";
import { SourceFileService } from "./source-files.js";
import { FileReadingService } from "./file-readings.js";
import { ModelService } from "./models.js";
import { FollowUpScheduleService } from "./follow-up-schedules.js";
import { ArtifactReviewService } from "./artifact-reviews.js";
import { createProjectTask, patchProjectTask } from "./tasks.js";

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
        "SELECT id,title,assignee,status,to_char(due_date,'YYYY-MM-DD') AS \"dueDate\",version FROM cw_tasks WHERE project_id=$1 AND workspace_id=$2 ORDER BY created_at,id",
        [project.id, s.workspaceId],
      ),
      this.db.pool.query(
        'SELECT a.id,a.title,a.current_version AS version,a.status,a.review_revision AS "reviewRevision",a.accepted_version AS "acceptedVersion",v.content,v.created_at AS "createdAt" FROM cw_artifacts a JOIN cw_artifact_versions v ON v.artifact_id=a.id AND v.version=a.current_version WHERE a.project_id=$1 AND a.workspace_id=$2 ORDER BY a.created_at DESC',
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
    const conversation = await this.conversation(s, conversationId);
    return this.db.tx((c) =>
      createProjectTask(c, s, conversation.project_id, input),
    );
  }
  async task(s: Subject, id: string, projectId?: string) {
    await assertMember(this.db, s);
    const target = (
      await this.db.pool.query(
        `SELECT id,project_id AS "projectId",title,assignee,status,to_char(due_date,'YYYY-MM-DD') AS "dueDate",version
      FROM cw_tasks WHERE id=$1 AND workspace_id=$2 AND ($3::uuid IS NULL OR project_id=$3)`,
        [id, s.workspaceId, projectId ?? null],
      )
    ).rows[0];
    if (!target) throw new NotFoundException("待办不存在。");
    await this.access.assert(s, target.projectId);
    const history = await this.db.pool.query(
      `SELECT v.version,v.snapshot,v.actor_id AS "actorId",u.name AS "actorName",v.channel,v.policy_version AS "policyVersion",v.source_run_id AS "sourceRunId",v.created_at AS "createdAt"
      FROM cw_task_versions v LEFT JOIN cw_users u ON u.id=v.actor_id WHERE task_id=$1 AND workspace_id=$2 AND version<=$3 ORDER BY version DESC LIMIT 20`,
      [id, s.workspaceId, target.version],
    );
    await this.access.assert(s, target.projectId);
    return { current: target, history: history.rows };
  }
  async patchTask(s: Subject, id: string, patch: TaskPatch) {
    const { current } = await this.task(s, id);
    return this.db.tx((c) =>
      patchProjectTask(c, s, id, patch, current.projectId),
    );
  }
  async artifact(s: Subject, id: string) {
    const role = await assertMember(this.db, s);
    const projectId = await this.artifactProject(s, id);
    const r = await this.db.pool.query(
      `SELECT a.id,a.title,v.version,a.created_by,
      CASE WHEN v.version=a.current_version THEN a.status ELSE coalesce(r.status_after,'draft') END AS status,
      CASE WHEN v.version=a.current_version THEN a.review_revision ELSE coalesce(r.review_revision,0) END AS "reviewRevision",
      CASE WHEN v.version=a.current_version THEN a.accepted_version WHEN r.status_after='accepted' THEN v.version END AS "acceptedVersion",
      v.content,v.feedback,v.source_message_ids AS "sourceMessageIds",v.created_at AS "createdAt"
      FROM cw_artifacts a JOIN cw_artifact_versions v ON v.artifact_id=a.id
      LEFT JOIN LATERAL(SELECT status_after,review_revision FROM cw_artifact_reviews
        WHERE artifact_id=a.id AND artifact_version=v.version ORDER BY review_revision DESC LIMIT 1) r ON true
      WHERE a.id=$1 AND a.workspace_id=$2 ORDER BY v.version DESC`,
      [id, s.workspaceId],
    );
    if (!r.rowCount) throw new NotFoundException("成果不存在。");
    const reviews = await this.db.pool.query(
      `SELECT r.id,r.artifact_version AS version,r.review_revision AS "reviewRevision",
      r.reviewer_id AS "reviewerId",u.name AS "reviewerName",r.reviewer_authority AS "reviewerAuthority",r.policy_version AS "policyVersion",r.decision,r.status_before AS "statusBefore",r.status_after AS status,
      r.feedback,r.confirmed,r.channel,r.source_run_id AS "sourceRunId",r.created_at AS "createdAt"
      FROM cw_artifact_reviews r JOIN cw_users u ON u.id=r.reviewer_id WHERE r.artifact_id=$1 AND r.workspace_id=$2
      ORDER BY r.artifact_version DESC,r.review_revision DESC LIMIT 50`,
      [id, s.workspaceId],
    );
    await this.access.assert(s, projectId);
    return {
      current: r.rows[0],
      versions: r.rows,
      history: r.rows,
      canReview: role === "admin" || r.rows[0].created_by === s.id,
      reviews: reviews.rows,
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
    const files = new SourceFileService(this.db),
      fileAccess = await files.verify(s);
    const r = await this.db.pool.query(
      'SELECT id,title,content,type,project_id,EXISTS(SELECT 1 FROM cw_source_files f WHERE f.asset_id=cw_assets.id) AS "fileSource",source_ref AS "sourceRef",source_version AS "sourceVersion" FROM cw_assets WHERE workspace_id=$1 AND deleted_at IS NULL AND validity=\'active\' AND (visibility=\'workspace\' OR owner_id=$2) AND (project_id IS NULL OR project_id=ANY($4::uuid[])) AND (NOT EXISTS(SELECT 1 FROM cw_source_files f WHERE f.asset_id=cw_assets.id) OR id=ANY($5::uuid[])) AND (title ILIKE $3 OR content ILIKE $3) ORDER BY created_at DESC LIMIT 30',
      [
        s.workspaceId,
        s.id,
        "%" + query.replace(/[\\%_]/g, "\\$&") + "%",
        projectIds,
        [...fileAccess.allowed.keys()],
      ],
    );
    const current = new Set(await this.access.visibleIds(s));
    const finalFiles = await files.verify(
      s,
      r.rows.filter((row) => row.fileSource).map((row) => row.id),
    );
    return r.rows
      .filter((row) => !row.project_id || current.has(row.project_id))
      .filter(
        (row) =>
          !row.fileSource ||
          finalFiles.allowed.get(row.id) === row.sourceVersion,
      )
      .map(({ project_id, fileSource, ...row }) => row);
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
  async runModel(s: Subject, engineId: EngineId, modelProfileId?: string) {
    if (engineId === "fixture" && (!s.demo || process.env.DEMO_MODE !== "true"))
      throw new ForbiddenException("演示执行仅用于演示会话。");
    const engine = this.engines.get(engineId);
    if (!engine?.describeCapabilities().configured)
      throw new BadRequestException(
        engineId + " 执行器尚未配置；不能将演示流程作为真实引擎。",
      );
    const model =
      engineId === "fixture"
        ? undefined
        : await new ModelService(this.db).resolve(s, "chat", modelProfileId);
    const providers = engine.describeCapabilities().modelProviders;
    if (model && providers && !providers.includes(model.provider))
      throw new BadRequestException(
        "所选执行器当前不支持这条连接的 API 类型，请选择兼容连接。",
      );
    return model;
  }
  async startFileRun(s: Subject, assetId: string, input: FileReadingInput) {
    const files = new SourceFileService(this.db);
    await files.assertVersion(s, assetId, input.expectedSourceVersion);
    if (
      !this.engines
        .get(input.engine)
        ?.describeCapabilities()
        .operations.includes("read_file")
    )
      throw new BadRequestException("执行器尚未声明文件阅读能力。");
    const model = await this.runModel(s, input.engine, input.modelProfileId);
    const inputHash = stableDigest({
      ...input,
      assetId,
      workflow: "read_file",
      idempotencyKey: undefined,
    });
    const r = await this.db.pool.query(
      "INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,idempotency_key,input_hash,demo,model_profile_id,identity_credential_id,source_file_asset_id,expected_file_version) VALUES($1,$2,$3,NULL,$4,'read_file',$5,$6,$7,false,$8,$9,$10,$11) ON CONFLICT(workspace_id,actor_id,idempotency_key) DO NOTHING RETURNING id,state",
      [
        randomUUID(),
        s.workspaceId,
        s.id,
        input.engine,
        input.instruction,
        input.idempotencyKey,
        inputHash,
        model?.id,
        s.identityCredentialId,
        assetId,
        input.expectedSourceVersion,
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
  async startFileReadingRevision(
    s: Subject,
    readingId: string,
    input: FileReadingRevisionInput,
  ) {
    const reading = await new FileReadingService(this.db).get(s, readingId);
    const inputHash = stableDigest({
      ...input,
      readingId,
      assetId: reading.assetId,
      sourceVersion: reading.sourceVersion,
      workflow: "revise_file_reading",
      idempotencyKey: undefined,
    });
    const replay = (row: any) => {
      if (row.input_hash !== inputHash)
        throw new ConflictException("相同幂等键不能用于不同任务。");
      return { id: row.id, state: row.state, created: false };
    };
    const lookup = (client: Pick<PoolClient, "query">) =>
      client.query(
        "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, input.idempotencyKey],
      );
    const old = (await lookup(this.db.pool)).rows[0];
    if (old) return replay(old);
    if (reading.version !== input.expectedVersion)
      throw new ConflictException("解读版本已变化，请重新读取后修改。");
    if (reading.version >= 10)
      throw new BadRequestException("当前每条解读最多保留 10 个版本。");
    if (
      !this.engines
        .get(input.engine)
        ?.describeCapabilities()
        .operations.includes("revise_file_reading")
    )
      throw new BadRequestException("执行器尚未声明文件解读修订能力。");
    const model = await this.runModel(s, input.engine, input.modelProfileId);
    return this.db.tx(async (c) => {
      await FileReadingService.lockSource(
        c,
        s,
        reading.assetId,
        reading.sourceVersion,
      );
      const existing = (await lookup(c)).rows[0];
      if (existing) return replay(existing);
      const target = (
        await c.query(
          `SELECT current_version FROM cw_file_readings WHERE id=$1 AND workspace_id=$2
        AND actor_id=$3 AND source_asset_id=$4 AND source_version=$5 AND invalidated_at IS NULL FOR SHARE`,
          [
            readingId,
            s.workspaceId,
            s.id,
            reading.assetId,
            reading.sourceVersion,
          ],
        )
      ).rows[0];
      if (!target || target.current_version !== input.expectedVersion)
        throw new ConflictException("解读版本已变化，请重新读取后修改。");
      const result = await c.query(
        `INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,idempotency_key,
        input_hash,demo,model_profile_id,identity_credential_id,source_file_asset_id,expected_file_version,source_file_reading_id,expected_reading_version)
        VALUES($1,$2,$3,NULL,$4,'revise_file_reading',$5,$6,$7,false,$8,$9,$10,$11,$12,$13)
        ON CONFLICT(workspace_id,actor_id,idempotency_key) DO NOTHING RETURNING id,state`,
        [
          randomUUID(),
          s.workspaceId,
          s.id,
          input.engine,
          input.instruction,
          input.idempotencyKey,
          inputHash,
          model?.id,
          s.identityCredentialId,
          reading.assetId,
          reading.sourceVersion,
          readingId,
          input.expectedVersion,
        ],
      );
      if (result.rowCount) return { ...result.rows[0], created: true };
      return replay((await lookup(c)).rows[0]);
    });
  }
  async startRun(s: Subject, input: RunInput) {
    if (isFileWorkflow(input.workflow))
      throw new BadRequestException("请从个人文件阅读入口发起。");
    const conversation = await this.conversation(s, input.conversationId);
    if (input.workflow === "configure_follow_up") {
      if (!input.followUpPlan || input.artifactId)
        throw new BadRequestException("请明确指定跟进配置与范围。");
      const old = (
        await this.db.pool.query(
          "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (old) {
        if (
          old.input_hash !==
          stableDigest({ ...input, idempotencyKey: undefined })
        )
          throw new ConflictException("相同幂等键不能用于不同任务。");
        return { id: old.id, state: old.state, created: false };
      }
      if (
        !this.engines
          .get(input.engine)
          ?.describeCapabilities()
          .operations.includes("configure_follow_up")
      )
        throw new BadRequestException("所选执行器未声明跟进配置能力。");
      await new FollowUpScheduleService(this).prepare(
        s,
        input.conversationId,
        input.followUpPlan,
        input.engine,
        input.modelProfileId,
      );
    } else if (input.followUpPlan)
      throw new BadRequestException("此工作类型不接受跟进配置。");
    if (input.workflow === "follow_up" && input.artifactId)
      throw new BadRequestException("待办检查不接受成果目标。");
    if (
      input.workflow === "draft_reply" &&
      !(await this.access.binding(s, conversation.project_id))
    )
      throw new BadRequestException("请先从企业会话创建关联项目，再起草回复。");
    let expectedVersion: number | null = null;
    if (input.workflow === "revise_task") {
      if (!input.taskId || !input.expectedTaskVersion || input.artifactId)
        throw new BadRequestException("请指定待办、当前版本和修改要求。");
      const old = (
        await this.db.pool.query(
          "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (old) {
        if (
          old.input_hash !==
          stableDigest({ ...input, idempotencyKey: undefined })
        )
          throw new ConflictException("相同幂等键不能用于不同任务。");
        return { id: old.id, state: old.state, created: false };
      }
      if (
        !this.engines
          .get(input.engine)
          ?.describeCapabilities()
          .operations.includes("revise_task")
      )
        throw new BadRequestException("所选执行器未声明待办修改能力。");
      const task = await this.task(s, input.taskId, conversation.project_id);
      if (task.current.version !== input.expectedTaskVersion)
        throw new ConflictException("待办已更新，请重新读取后修改。");
    } else if (input.taskId || input.expectedTaskVersion)
      throw new BadRequestException("此工作类型不接受待办修改目标。");
    if (input.workflow === "review_artifact") {
      if (!input.artifactId || !input.artifactReviewPlan)
        throw new BadRequestException("请指定成果、版本和明确验收决定。");
      const old = (
        await this.db.pool.query(
          "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (old) {
        if (
          old.input_hash !==
          stableDigest({ ...input, idempotencyKey: undefined })
        )
          throw new ConflictException("相同幂等键不能用于不同任务。");
        return { id: old.id, state: old.state, created: false };
      }
      if (
        !this.engines
          .get(input.engine)
          ?.describeCapabilities()
          .operations.includes("review_artifact")
      )
        throw new BadRequestException("所选执行器未声明验收代执行能力。");
      await new ArtifactReviewService(this.db).prepare(
        s,
        input.artifactId,
        input.artifactReviewPlan,
        conversation.project_id,
      );
      expectedVersion = input.artifactReviewPlan.expectedVersion;
    } else if (input.artifactReviewPlan)
      throw new BadRequestException("此工作类型不接受验收决定。");
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
    const model = await this.runModel(s, input.engine, input.modelProfileId);
    const inputHash = stableDigest({ ...input, idempotencyKey: undefined });
    const id = randomUUID();
    const r = await this.db.pool.query(
      "INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,artifact_id,idempotency_key,input_hash,demo,model_profile_id,expected_artifact_version,identity_credential_id,follow_up_plan,artifact_review_plan,task_id,expected_task_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT(workspace_id,actor_id,idempotency_key) DO NOTHING RETURNING id,state",
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
        input.followUpPlan ?? null,
        input.artifactReviewPlan ?? null,
        input.taskId ?? null,
        input.expectedTaskVersion ?? null,
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
        "SELECT conversation_id,source_file_asset_id,expected_file_version,(instruction='') AS source_redacted FROM cw_runs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3",
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
    if (!target) throw new NotFoundException("执行不存在或无权访问。");
    if (target.source_file_asset_id && target.source_redacted)
      throw new NotFoundException("文件执行已因来源失效而清理。");
    if (target.source_file_asset_id)
      await new SourceFileService(this.db).assertVersion(
        s,
        target.source_file_asset_id,
        target.expected_file_version,
      );
    else await this.conversation(s, target.conversation_id);
    const r = await this.db.pool.query(
      'SELECT id,state,engine,workflow,artifact_id AS "artifactId",task_id AS "taskId",instruction,result,error,context_refs AS "contextRefs",created_at AS "createdAt",updated_at AS "updatedAt" FROM cw_runs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3',
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
