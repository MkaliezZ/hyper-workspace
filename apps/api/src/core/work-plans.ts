import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  WorkProposal,
  WorkPlanResponse,
  type Subject,
  type WorkOperation,
} from "@hyper/contracts";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.js";
import { ProjectAccess } from "./project-access.js";
import { assertMember } from "./security.js";
import { stableDigest, digest } from "./credentials.js";
import { DirectoryService, type AssignmentProof } from "./directory.js";
import { DecisionService } from "./decisions.js";
import { createProjectTask, patchProjectTask, lockTask } from "./tasks.js";
import {
  createProjectArtifact,
  lockArtifact,
  reviseArtifactVersion,
} from "./artifacts.js";
import { TaskAssignmentService } from "./task-assignments.js";
import { ExecutionPolicyService } from "./execution-policy.js";
import { appendEvent } from "./workspace.js";

type Choice = {
  id: string;
  name: string;
  version?: number;
  sourceUid?: string | null;
};
type Selection = { id: string | null; version?: number };
type Question = {
  key: string;
  prompt: string;
  choices?: Choice[];
  allowUnassigned?: boolean;
};
const waiting = (state: string) =>
  ["waiting_input", "waiting_confirmation"].includes(state);

/** Product-owned clarification and confirmation; never relies on an engine checkpoint. */
export class WorkPlanService {
  readonly access: ProjectAccess;
  constructor(readonly db: Database) {
    this.access = new ProjectAccess(db);
  }
  async scope(s: Subject, conversationId: string) {
    await assertMember(this.db, s);
    const row = (
      await this.db.pool.query(
        "SELECT c.project_id,p.name,p.goal FROM cw_conversations c JOIN cw_projects p ON p.id=c.project_id WHERE c.id=$1 AND c.workspace_id=$2",
        [conversationId, s.workspaceId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("工作范围不可访问。");
    await this.access.assert(s, row.project_id);
    return row;
  }
  async catalog(s: Subject, projectId: string) {
    await this.access.assert(s, projectId);
    const [directory, tasks, artifacts] = await Promise.all([
      new DirectoryService(this.db).read(s, projectId),
      this.db.pool.query(
        'SELECT id,title AS name,version,title,status,assignee,assignee_id AS "assigneeId",to_char(due_date,\'YYYY-MM-DD\') AS "dueDate" FROM cw_tasks WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at DESC,id LIMIT 101',
        [s.workspaceId, projectId],
      ),
      this.db.pool.query(
        "SELECT a.id,a.title AS name,a.current_version AS version,v.content FROM cw_artifacts a JOIN cw_artifact_versions v ON v.artifact_id=a.id AND v.version=a.current_version WHERE a.workspace_id=$1 AND a.project_id=$2 ORDER BY a.created_at DESC,a.id LIMIT 101",
        [s.workspaceId, projectId],
      ),
    ]);
    if (tasks.rows.length > 100 || artifacts.rows.length > 100)
      throw new BadRequestException(
        "当前项目超过 100 个待办或成果，请明确选择对象后使用对应修改入口；未截取后猜测同名对象。",
      );
    await this.access.assert(s, projectId);
    if (
      directory.bindingHash !==
      stableDigest((await this.access.binding(s, projectId)) ?? null)
    )
      throw new ConflictException("项目来源已变化。");
    return { directory, tasks: tasks.rows, artifacts: artifacts.rows };
  }
  async context(s: Subject, conversationId: string, runId?: string) {
    const scope = await this.scope(s, conversationId),
      catalog = await this.catalog(s, scope.project_id),
      sources = (
        await new DecisionService(this.db).sources(s, scope.project_id)
      ).slice(-40);
    const previous = runId
      ? (
          await this.db.pool.query(
            "SELECT run_id FROM cw_work_plans WHERE run_id=$1 AND workspace_id=$2 AND actor_id=$3",
            [runId, s.workspaceId, s.id],
          )
        ).rows[0]
      : undefined;
    const prior = previous ? await this.row(s, runId!) : undefined;
    let available = 30000;
    const artifacts = catalog.artifacts.map((row) => {
      const full =
        row.content.length <= 12000 && row.content.length <= available;
      if (full) available -= row.content.length;
      return {
        id: row.id,
        name: row.name,
        version: row.version,
        ...(full ? { content: row.content } : { contentUnavailable: true }),
      };
    });
    return {
      context: {
        project: { id: scope.project_id, name: scope.name, goal: scope.goal },
        sources,
        tasks: catalog.tasks,
        artifacts,
        people: catalog.directory.rows
          .slice(0, 100)
          .map(({ name, sourceUid, state }) => ({ name, sourceUid, state })),
        peoplePartial: catalog.directory.rows.length > 100,
        ...(prior
          ? {
              priorPlan: prior.proposal,
              employeeAnswers: prior.answers,
              employeeSelections: prior.selections,
              instruction:
                "Revise using these employee answers and selections; do not repeat answered questions without a new concrete gap. Preserve explicit targets/versions, do not execute.",
            }
          : {}),
      },
      sourceRefs: sources.map((row) => row.id),
      contextRefs: [
        ...catalog.tasks.map((row) => "task:" + row.id + "@" + row.version),
        ...artifacts
          .filter((row) => "content" in row)
          .map((row) => "artifact:" + row.id + "@" + row.version),
      ],
      live: true,
    };
  }
  async row(s: Subject, runId: string) {
    await assertMember(this.db, s);
    const row = (
      await this.db.pool.query(
        "SELECT p.*,r.state,r.conversation_id,r.execution_policy_snapshot,r.engine,r.workflow,r.task_rules,r.demo,r.identity_credential_id FROM cw_work_plans p JOIN cw_runs r ON r.id=p.run_id WHERE p.run_id=$1 AND p.workspace_id=$2 AND p.actor_id=$3",
        [runId, s.workspaceId, s.id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("工作计划不存在或不属于当前员工。");
    await this.access.assert(s, row.project_id);
    if (row.state !== "succeeded") {
      if (Date.parse(row.expires_at) <= Date.now())
        throw new ConflictException(
          "工作计划已超过 24 小时，请重新核对上下文后发起。",
        );
      if (
        row.binding_hash !==
          stableDigest(
            (await this.access.binding(s, row.project_id)) ?? null,
          ) ||
        !(await new DecisionService(this.db).references(
          s,
          row.project_id,
          row.source_refs,
        ))
      )
        throw new ConflictException(
          "计划依据或来源已变化，旧提议不可继续读取或执行，请重新整理。",
        );
    }
    return row;
  }
  resolve(
    s: Subject,
    proposal: WorkProposal,
    catalog: Awaited<ReturnType<WorkPlanService["catalog"]>>,
    selections: Record<string, Selection>,
    answers: Record<string, string>,
    contextRefs: string[],
  ) {
    const questions: Question[] = [],
      resolved: Record<string, Selection> = {};
    proposal.questions.forEach((prompt, index) => {
      if (!answers[`question:${index}`]?.trim())
        questions.push({ key: `question:${index}`, prompt });
    });
    const select = (
      key: string,
      selector: any,
      kind: "person" | "task" | "artifact",
    ) => {
      const choices: Choice[] =
        kind === "person"
          ? catalog.directory.rows
              .filter((p) => p.id && p.state === "available")
              .map((p) => ({ id: p.id!, name: p.name, sourceUid: p.sourceUid }))
          : catalog[kind === "task" ? "tasks" : "artifacts"].map(
              ({ id, name, version }) => ({ id, name, version }),
            );
      const explicit = selections[key];
      if (explicit?.id === null && kind === "person") {
        resolved[key] = explicit;
        return;
      }
      const exact = choices.filter(
        (c) =>
          c.name === selector.name ||
          (kind === "person" && selector.name === "我" && c.id === s.id),
      );
      const candidate = explicit
        ? choices.find(
            (c) =>
              c.id === explicit.id &&
              (kind === "person" || c.version === explicit.version),
          )
        : exact.length === 1 &&
            (selector.version === undefined ||
              selector.version === exact[0]!.version)
          ? exact[0]
          : undefined;
      const fullBody =
        kind === "person" ||
        !!explicit ||
        (candidate &&
          contextRefs.includes(
            kind + ":" + candidate.id + "@" + candidate.version,
          ));
      if (candidate && fullBody) {
        resolved[key] = {
          id: candidate.id,
          ...(candidate.version ? { version: candidate.version } : {}),
        };
        return;
      }
      const optionSet = exact.length && !explicit ? exact : choices;
      questions.push({
        key,
        prompt: `${kind === "person" ? "负责人" : kind === "task" ? "待办目标" : "成果目标"}「${selector.name}」${selector.version ? ` · 指定 v${selector.version}` : ""}需要核对：同名、缺失、版本已变或原文未完整提供。请选择当前确切对象与版本。${kind === "artifact" ? "这是完整正文替换，请先查看当前原文。" : ""}`,
        choices: optionSet,
        allowUnassigned: kind === "person",
      });
    };
    proposal.operations.forEach((operation, index) => {
      if ("target" in operation)
        select(
          `${index}:target`,
          operation.target,
          operation.operation === "update_task" ? "task" : "artifact",
        );
      if ("assignee" in operation && operation.assignee !== undefined) {
        if (operation.assignee === null)
          resolved[`${index}:assignee`] = { id: null };
        else select(`${index}:assignee`, operation.assignee, "person");
      }
    });
    const targets = Object.entries(resolved)
      .filter(([key]) => key.endsWith(":target"))
      .map(([, value]) => value.id);
    if (new Set(targets).size !== targets.length)
      throw new BadRequestException(
        "同一批次不能重复修改同一对象，请合并修改要求。",
      );
    return { questions, resolved };
  }
  async list(s: Subject, projectId: string) {
    await assertMember(this.db, s);
    await this.access.assert(s, projectId);
    const rows = (
      await this.db.pool.query(
        'SELECT p.run_id AS id,p.revision,r.state,r.engine,p.created_at AS "createdAt" FROM cw_work_plans p JOIN cw_runs r ON r.id=p.run_id WHERE p.workspace_id=$1 AND p.project_id=$2 AND p.actor_id=$3 ORDER BY p.created_at DESC LIMIT 20',
        [s.workspaceId, projectId, s.id],
      )
    ).rows;
    await this.access.assert(s, projectId);
    return rows;
  }
  async view(s: Subject, runId: string) {
    const row = await this.row(s, runId),
      catalog = await this.catalog(s, row.project_id),
      result = this.resolve(
        s,
        WorkProposal.parse(row.proposal),
        catalog,
        row.selections,
        row.answers,
        row.context_refs,
      );
    // Recheck after source/catalog reads so a cancelled or revised plan cannot return an old draft.
    const fresh = await this.row(s, runId);
    if (fresh.revision !== row.revision || fresh.state !== row.state)
      throw new ConflictException("工作计划状态已变化，请重新读取。");
    const display = Object.fromEntries(
      Object.entries(result.resolved).map(([key, value]) => {
        const person = catalog.directory.rows.find((r) => r.id === value.id),
          object = [...catalog.tasks, ...catalog.artifacts].find(
            (r) => r.id === value.id,
          );
        return [
          key,
          {
            ...value,
            name:
              value.id === null
                ? "待分配"
                : key.endsWith(":assignee")
                  ? person?.name
                  : object?.name,
            sourceUid: person?.sourceUid ?? null,
          },
        ];
      }),
    );
    return {
      runId,
      revision: row.revision,
      state: row.state,
      proposal: row.proposal,
      answers: row.answers,
      selections: row.selections,
      ...result,
      resolvedDisplay: display,
      expiresAt: row.expires_at,
    };
  }
  async propose(
    s: Subject,
    run: any,
    raw: unknown,
    sourceRefs: string[],
    contextRefs: string[],
    contextBytes: number,
    evidence: "fixture" | "runtime",
    lease: string,
  ) {
    const proposal = WorkProposal.parse(raw),
      scope = await this.scope(s, run.conversation_id),
      catalog = await this.catalog(s, scope.project_id),
      resolution = this.resolve(s, proposal, catalog, {}, {}, contextRefs),
      bindingHash = stableDigest(
        (await this.access.binding(s, scope.project_id)) ?? null,
      );
    if (
      !(await new DecisionService(this.db).references(
        s,
        scope.project_id,
        sourceRefs,
      ))
    )
      throw new ConflictException("讨论依据已变化，未保存计划。");
    return this.db.tx(async (c) => {
      await ExecutionPolicyService.lock(c, s.workspaceId);
      await new ExecutionPolicyService(this.db).check(
        c,
        s,
        run,
        contextBytes,
        proposal.operations.length,
      );
      const current = (
        await c.query(
          "SELECT state,lease_owner FROM cw_runs WHERE id=$1 FOR UPDATE",
          [run.id],
        )
      ).rows[0];
      if (current?.state !== "running" || current.lease_owner !== lease)
        throw new ConflictException("执行已取消或租约已失效。");
      await this.guard(c, s, scope.project_id, bindingHash, sourceRefs);
      const existing = (
          await c.query(
            "SELECT revision FROM cw_work_plans WHERE run_id=$1 FOR UPDATE",
            [run.id],
          )
        ).rows[0],
        revision = (existing?.revision ?? 0) + 1;
      await c.query(
        "INSERT INTO cw_work_plans(run_id,workspace_id,project_id,actor_id,proposal,selections,source_refs,binding_hash,context_refs,context_bytes,evidence,revision)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(run_id) DO UPDATE SET proposal=EXCLUDED.proposal,selections=EXCLUDED.selections,answers='{}',source_refs=EXCLUDED.source_refs,context_refs=EXCLUDED.context_refs,context_bytes=EXCLUDED.context_bytes,evidence=EXCLUDED.evidence,revision=EXCLUDED.revision,updated_at=clock_timestamp()",
        [
          run.id,
          s.workspaceId,
          scope.project_id,
          s.id,
          proposal,
          resolution.resolved,
          JSON.stringify(sourceRefs),
          bindingHash,
          JSON.stringify(contextRefs),
          contextBytes,
          evidence,
          revision,
        ],
      );
      await this.version(
        c,
        run.id,
        revision,
        proposal,
        {},
        resolution.resolved,
        "ai",
        s.identityCredentialId,
      );
      const state = resolution.questions.length
        ? "waiting_input"
        : "waiting_confirmation";
      await c.query("INSERT INTO cw_run_wait_periods(run_id)VALUES($1)", [
        run.id,
      ]);
      await c.query(
        "UPDATE cw_runs SET state=$2,result=$3,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1",
        [
          run.id,
          state,
          { text: "工作计划已整理；尚未执行业务动作。", receipts: [] },
        ],
      );
      await appendEvent(
        c,
        run.id,
        state === "waiting_input" ? "input.required" : "action.proposed",
        { revision, requestCount: resolution.questions.length },
      );
      return { runId: run.id, state, revision };
    });
  }
  private async guard(
    c: PoolClient,
    s: Subject,
    projectId: string,
    bindingHash: string,
    sourceRefs: string[] = [],
  ) {
    if (
      !(
        await c.query(
          "SELECT 1 FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
          [s.workspaceId, s.id],
        )
      ).rowCount
    )
      throw new ForbiddenException("工作区权限已撤销。");
    const binding = (
      await c.query(
        "SELECT * FROM cw_project_sources WHERE project_id=$1 AND workspace_id=$2 FOR SHARE",
        [projectId, s.workspaceId],
      )
    ).rows[0];
    if (stableDigest(binding ?? null) !== bindingHash)
      throw new ConflictException("项目来源已变化。");
    if (
      s.identityCredentialId &&
      !(
        await c.query(
          "SELECT c.id FROM cw_identity_credentials c JOIN cw_external_identities i ON i.id=c.identity_id WHERE c.id=$1 AND c.disabled_at IS NULL AND i.workspace_id=$2 AND i.user_id=$3 FOR SHARE OF c,i",
          [s.identityCredentialId, s.workspaceId, s.id],
        )
      ).rowCount
    )
      throw new ForbiddenException("当前来源登录已撤销。");
    for (const reference of sourceRefs)
      if (reference.startsWith("message:")) {
        const match = /^message:([0-9a-f-]{36})@([a-f0-9]{64})$/.exec(
          reference,
        );
        if (!match) throw new ConflictException("来源引用格式无效。");
        const message = (
          await c.query(
            "SELECT m.content FROM cw_messages m JOIN cw_conversations x ON x.id=m.conversation_id WHERE m.id=$1 AND m.workspace_id=$2 AND x.project_id=$3 FOR SHARE OF m",
            [match[1], s.workspaceId, projectId],
          )
        ).rows[0];
        if (!message || digest(message.content) !== match[2])
          throw new ConflictException("讨论依据已变化。");
      }
  }
  private async version(
    c: PoolClient,
    runId: string,
    revision: number,
    proposal: WorkProposal,
    answers: any,
    selections: any,
    channel: string,
    credentialId?: string,
  ) {
    await c.query(
      "INSERT INTO cw_work_plan_versions(run_id,revision,proposal,answers,selections,channel,identity_credential_id)VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        runId,
        revision,
        proposal,
        answers,
        selections,
        channel,
        credentialId ?? null,
      ],
    );
  }
  private async prior(
    s: Subject,
    runId: string,
    key: string,
    hash: string,
    query: PoolClient | Database["pool"] = this.db.pool,
  ) {
    const old = (
      await query.query(
        "SELECT input_hash,receipt,run_id FROM cw_work_plan_actions WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, key],
      )
    ).rows[0];
    if (old && (old.input_hash !== hash || old.run_id !== runId))
      throw new ConflictException("工作计划幂等键冲突。");
    return old?.receipt;
  }
  async respond(s: Subject, runId: string, raw: WorkPlanResponse) {
    const input = WorkPlanResponse.parse(raw),
      row = await this.row(s, runId),
      hash = stableDigest({ runId, input });
    if (input.confirmed && input.regenerate)
      throw new BadRequestException("重新整理与执行确认必须分开。");
    const old = await this.prior(s, runId, input.idempotencyKey, hash);
    if (old) return old;
    if (!waiting(row.state) || row.revision !== input.expectedRevision)
      throw new ConflictException("计划已变化、取消或执行，请重新读取。");
    const proposal = WorkProposal.parse(row.proposal),
      catalog = await this.catalog(s, row.project_id),
      initial = this.resolve(
        s,
        proposal,
        catalog,
        row.selections,
        row.answers,
        row.context_refs,
      ),
      selections = { ...row.selections },
      answers = { ...row.answers };
    const keys = [
      ...input.answers.map((a) => a.key),
      ...input.selections.map((a) => a.key),
    ];
    if (new Set(keys).size !== keys.length)
      throw new BadRequestException("澄清答案不能重复。");
    for (const answer of input.answers) {
      if (!initial.questions.some((q) => q.key === answer.key && !q.choices))
        throw new ConflictException("澄清问题已失效。");
      answers[answer.key] = answer.text;
    }
    for (const selection of input.selections) {
      const request = initial.questions.find(
        (q) => q.key === selection.key && q.choices,
      );
      if (
        !request ||
        !(
          (selection.id === null && request.allowUnassigned) ||
          request.choices!.some(
            (choice) =>
              choice.id === selection.id &&
              (choice.version === undefined ||
                choice.version === selection.version),
          )
        )
      )
        throw new ConflictException("所选对象不在当前有效澄清范围。");
      selections[selection.key] = {
        id: selection.id,
        ...(selection.version ? { version: selection.version } : {}),
      };
    }
    const resolved = this.resolve(
      s,
      proposal,
      catalog,
      selections,
      answers,
      row.context_refs,
    );
    Object.assign(selections, resolved.resolved);
    if (
      input.confirmed &&
      (keys.length ||
        resolved.questions.length ||
        row.state !== "waiting_confirmation")
    )
      throw new BadRequestException(
        "请先保存澄清结果并重新核对计划，再确认执行。",
      );
    const proofs = new Map<string, AssignmentProof>();
    if (input.confirmed)
      for (const [key, selection] of Object.entries(resolved.resolved))
        if (key.endsWith(":assignee") && selection.id)
          proofs.set(
            key,
            await new DirectoryService(this.db).resolve(
              s,
              row.project_id,
              selection.id,
            ),
          );
    return this.db.tx(async (c) => {
      await ExecutionPolicyService.lock(c, s.workspaceId);
      // Existing services lock targets before Run/member rows; retain that order.
      if (input.confirmed)
        for (const [key, target] of Object.entries(resolved.resolved).sort(
          ([a, av], [b, bv]) =>
            (av.id ?? "").localeCompare(bv.id ?? "") || a.localeCompare(b),
        ))
          if (key.endsWith(":target")) {
            const operation = proposal.operations[Number(key.split(":")[0])]!;
            if (operation.operation === "update_task")
              await lockTask(c, s, target.id!, row.project_id);
            else await lockArtifact(c, s, target.id!, row.project_id);
          }
      const current = (
        await c.query(
          "SELECT r.*,p.revision AS plan_revision FROM cw_runs r JOIN cw_work_plans p ON p.run_id=r.id WHERE r.id=$1 FOR UPDATE OF r,p",
          [runId],
        )
      ).rows[0];
      const prior = await c.query(
        "SELECT input_hash,receipt FROM cw_work_plan_actions WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, input.idempotencyKey],
      );
      if (prior.rowCount) {
        if (prior.rows[0].input_hash !== hash)
          throw new ConflictException("工作计划幂等键冲突。");
        return prior.rows[0].receipt;
      }
      if (
        !waiting(current.state) ||
        current.plan_revision !== input.expectedRevision
      )
        throw new ConflictException("计划状态已变化，未执行。");
      if (input.regenerate && !current.runtime_cleaned_at)
        throw new ConflictException("执行器正在收尾，请稍后重新读取并提交。");
      await this.guard(c, s, row.project_id, row.binding_hash, row.source_refs);
      await new ExecutionPolicyService(this.db).check(
        c,
        s,
        current,
        row.context_bytes,
        proposal.operations.length,
      );
      const receipts: any[] = [];
      if (input.confirmed) {
        await c.query(
          "UPDATE cw_run_wait_periods SET ended_at=clock_timestamp() WHERE run_id=$1 AND ended_at IS NULL",
          [runId],
        );
        for (const [index, operation] of proposal.operations.entries())
          receipts.push(
            ...(await this.apply(
              c,
              s,
              row,
              operation,
              index,
              resolved.resolved,
              proofs,
            )),
          );
        await new ExecutionPolicyService(this.db).check(
          c,
          s,
          current,
          row.context_bytes,
          receipts.length,
        );
      }
      const state = input.regenerate
          ? "queued"
          : input.confirmed
            ? "succeeded"
            : resolved.questions.length
              ? "waiting_input"
              : "waiting_confirmation",
        revision = row.revision + 1;
      await c.query(
        "UPDATE cw_work_plans SET revision=$2,selections=$3,answers=$4,updated_at=clock_timestamp() WHERE run_id=$1",
        [runId, revision, selections, answers],
      );
      await this.version(
        c,
        runId,
        revision,
        proposal,
        answers,
        selections,
        input.confirmed ? "confirmation" : "human_response",
        s.identityCredentialId,
      );
      await c.query(
        "UPDATE cw_runs SET state=$2,result=$3,error=NULL,identity_credential_id=CASE WHEN $4 THEN $5::uuid ELSE identity_credential_id END,updated_at=clock_timestamp() WHERE id=$1",
        [
          runId,
          state,
          {
            text: input.confirmed
              ? "已按确认的确切对象与版本保存业务记录，请核对回执；未发送员工通知。"
              : "澄清结果已保存，请重新核对计划。",
            receipts,
            evidence: row.evidence,
          },
          input.regenerate,
          s.identityCredentialId ?? null,
        ],
      );
      const receipt = { runId, revision, state, receipts };
      await c.query(
        "INSERT INTO cw_work_plan_actions(workspace_id,actor_id,idempotency_key,run_id,input_hash,receipt,identity_credential_id)VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          s.workspaceId,
          s.id,
          input.idempotencyKey,
          runId,
          hash,
          receipt,
          s.identityCredentialId ?? null,
        ],
      );
      await appendEvent(
        c,
        runId,
        input.confirmed
          ? "run.completed"
          : state === "waiting_input"
            ? "input.required"
            : "action.proposed",
        { revision, receipts, requestCount: resolved.questions.length },
      );
      return receipt;
    });
  }
  async edit(
    s: Subject,
    runId: string,
    input: {
      expectedRevision: number;
      proposal: WorkProposal;
      idempotencyKey: string;
    },
  ) {
    const proposal = WorkProposal.parse(input.proposal),
      row = await this.row(s, runId),
      hash = stableDigest({ runId, operation: "edit", ...input });
    const prior = await this.prior(s, runId, input.idempotencyKey, hash);
    if (prior) return prior;
    if (!waiting(row.state) || row.revision !== input.expectedRevision)
      throw new ConflictException("计划已变化，请重新读取后接管。");
    const catalog = await this.catalog(s, row.project_id),
      resolved = this.resolve(s, proposal, catalog, {}, {}, row.context_refs);
    return this.db.tx(async (c) => {
      await ExecutionPolicyService.lock(c, s.workspaceId);
      const current = (
        await c.query(
          "SELECT r.*,p.revision AS plan_revision FROM cw_runs r JOIN cw_work_plans p ON p.run_id=r.id WHERE r.id=$1 FOR UPDATE OF r,p",
          [runId],
        )
      ).rows[0];
      const old = await this.prior(s, runId, input.idempotencyKey, hash, c);
      if (old) return old;
      if (
        !waiting(current.state) ||
        current.plan_revision !== input.expectedRevision
      )
        throw new ConflictException("计划已变化，未覆盖新版本。");
      await this.guard(c, s, row.project_id, row.binding_hash, row.source_refs);
      await new ExecutionPolicyService(this.db).check(
        c,
        s,
        current,
        row.context_bytes,
        proposal.operations.length,
      );
      const revision = row.revision + 1,
        state = resolved.questions.length
          ? "waiting_input"
          : "waiting_confirmation";
      await c.query(
        "UPDATE cw_work_plans SET revision=$2,proposal=$3,selections=$4,answers='{}',updated_at=clock_timestamp() WHERE run_id=$1",
        [runId, revision, proposal, resolved.resolved],
      );
      await this.version(
        c,
        runId,
        revision,
        proposal,
        {},
        resolved.resolved,
        "human_edit",
        s.identityCredentialId,
      );
      await c.query(
        "UPDATE cw_runs SET state=$2,updated_at=clock_timestamp() WHERE id=$1",
        [runId, state],
      );
      const receipt = { runId, revision, state, receipts: [] };
      await c.query(
        "INSERT INTO cw_work_plan_actions(workspace_id,actor_id,idempotency_key,run_id,input_hash,receipt,identity_credential_id)VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          s.workspaceId,
          s.id,
          input.idempotencyKey,
          runId,
          hash,
          receipt,
          s.identityCredentialId ?? null,
        ],
      );
      await appendEvent(
        c,
        runId,
        state === "waiting_input" ? "input.required" : "action.proposed",
        {
          revision,
          channel: "human_edit",
          requestCount: resolved.questions.length,
        },
      );
      return receipt;
    });
  }
  private async apply(
    c: PoolClient,
    s: Subject,
    row: any,
    operation: WorkOperation,
    index: number,
    resolved: Record<string, Selection>,
    proofs: Map<string, AssignmentProof>,
  ) {
    const receipts: any[] = [],
      target = resolved[`${index}:target`],
      person = resolved[`${index}:assignee`];
    let task: any;
    if (operation.operation === "create_task") {
      task = await createProjectTask(
        c,
        s,
        row.project_id,
        {
          title: operation.title,
          assignee: "待分配",
          dueDate: operation.dueDate,
        },
        row.run_id,
      );
      receipts.push({ tool: "task.create", ...task });
    } else if (operation.operation === "update_task") {
      const fields = Object.fromEntries(
        ["title", "status", "dueDate"]
          .filter((key) => key in operation)
          .map((key) => [key, (operation as any)[key]]),
      );
      task = Object.keys(fields).length
        ? await patchProjectTask(
            c,
            s,
            target!.id!,
            { ...fields, expectedVersion: target!.version },
            row.project_id,
            row.run_id,
          )
        : await lockTask(c, s, target!.id!, row.project_id);
      if (!Object.keys(fields).length && task.version !== target!.version)
        throw new ConflictException("待办版本已变化。");
      receipts.push({ tool: "task.update", ...task });
    } else if (operation.operation === "create_artifact") {
      receipts.push({
        tool: "artifact.create",
        ...(await createProjectArtifact(
          c,
          s,
          row.project_id,
          operation,
          row.source_refs,
        )),
      });
    } else {
      receipts.push({
        tool: "artifact.revise",
        ...(await reviseArtifactVersion(
          c,
          s,
          target!.id!,
          {
            content: operation.content,
            feedback: row.proposal.summary,
            expectedVersion: target!.version!,
          },
          row.project_id,
          row.source_refs,
        )),
      });
    }
    if (task && person && (person.id || operation.operation === "update_task"))
      receipts.push(
        await new TaskAssignmentService(this.db).apply(
          c,
          s,
          row.project_id,
          {
            taskId: task.id,
            expectedVersion: task.version,
            assigneeId: person.id,
            confirmed: true,
          },
          proofs.get(`${index}:assignee`),
          `work-plan:${row.run_id}:${index}:assignment`,
          row.run_id,
        ),
      );
    const receipt = { operationIndex: index, receipts };
    await c.query(
      "INSERT INTO cw_actions(id,workspace_id,actor_id,run_id,tool,params_hash,idempotency_key,state,result)VALUES($1,$2,$3,$4,'work.plan',$5,$6,'completed',$7)",
      [
        randomUUID(),
        s.workspaceId,
        s.id,
        row.run_id,
        stableDigest(operation),
        `work-plan:${row.run_id}:${index}`,
        receipt,
      ],
    );
    return receipts;
  }
}
