import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { PgBoss } from "pg-boss";
import {
  TaskInput,
  TaskRewrite,
  toolsForWorkflow,
  isFileWorkflow,
  type EngineId,
  type Subject,
  type PlannedAction,
} from "@hyper/contracts";
import { Database } from "../db/database.js";
import { WorkspaceService, appendEvent } from "./workspace.js";
import { assertMember } from "./security.js";
import { stableDigest } from "./credentials.js";
import { reviseArtifactVersion, lockArtifact } from "./artifacts.js";
import { ArtifactReviewService } from "./artifact-reviews.js";
import { createProjectTask, patchProjectTask, lockTask } from "./tasks.js";
import { MethodsService } from "./methods.js";
import { ModelService } from "./models.js";
import { RunModelGateway } from "./model-gateway.js";
import { ModelUsageService } from "./model-usage.js";
import {
  ExecutionPolicyService,
  ExecutionLimitError,
} from "./execution-policy.js";
import { assertRunScope, loadRunContext } from "./run-context.js";
import { FollowUpService } from "./follow-up.js";
import {
  FollowUpScheduleService,
  assertScheduledRun,
  type PreparedFollowUp,
} from "./follow-up-schedules.js";
import {
  FileReadingService,
  ReadingVersionConflict,
  ReadingInputLimit,
} from "./file-readings.js";
async function purgeFileRuntime(db: Database, id: string) {
  await rm(resolve(process.env.RUNTIME_DIR ?? ".runtime/runs", id), {
    recursive: true,
    force: true,
  });
  await db.pool.query(
    "UPDATE cw_runs SET runtime_cleaned_at=clock_timestamp() WHERE id=$1 AND source_file_asset_id IS NOT NULL",
    [id],
  );
}
export class RunProcessor {
  readonly boss: PgBoss;
  private sweep?: NodeJS.Timeout;
  private consumeSchedules = false;
  private scheduling = false;
  constructor(readonly service: WorkspaceService) {
    this.boss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "hyper_jobs",
      createSchema: process.env.QUEUE_SCHEMA_PRECREATED !== "true",
    });
    this.boss.on("error", () =>
      console.error("Background queue error; inspect service health."),
    );
  }
  async start(consume = false) {
    await this.boss.start();
    await this.boss.createQueue("hyper-run", { retryLimit: 0 });
    if (consume) {
      this.consumeSchedules = true;
      await this.boss.work<{ runId: string }>(
        "hyper-run",
        { pollingIntervalSeconds: 1, localConcurrency: 2 },
        async (jobs) => {
          for (const job of jobs) await this.process(job.data.runId);
        },
      );
      await this.reconcile();
      this.sweep = setInterval(
        () => void this.reconcile().catch(() => {}),
        15000,
      );
    }
  }
  async enqueue(runId: string) {
    await this.boss.send("hyper-run", { runId }, { singletonKey: runId });
  }
  async stop() {
    this.consumeSchedules = false;
    if (this.sweep) clearInterval(this.sweep);
    await this.boss.stop({ graceful: true, timeout: 3000 });
  }
  async reconcile() {
    const db = this.service.db;
    await db.tx(async (c) => {
      const expired = await c.query(
        "UPDATE cw_runs SET state='recovery_required',error='执行租约已过期，需要核对已完成操作。',updated_at=now() WHERE state='running' AND lease_expires_at<now() RETURNING id",
      );
      for (const run of expired.rows)
        await appendEvent(c, run.id, "run.recovery_required", {
          message: "执行中断，未自动重试业务动作。",
        });
    });
    for (const r of (
      await db.pool.query(
        "SELECT id FROM cw_runs WHERE state='queued' AND created_at<now()-interval '2 seconds' LIMIT 100",
      )
    ).rows)
      await this.enqueue(r.id);
    for (const r of (
      await db.pool.query(
        "SELECT id FROM cw_runs WHERE source_file_asset_id IS NOT NULL AND runtime_cleaned_at IS NULL AND state NOT IN ('queued','running') ORDER BY updated_at LIMIT 100",
      )
    ).rows)
      await purgeFileRuntime(db, r.id);
    // Source validation must not delay queue recovery or worker health startup.
    void this.dispatchSchedules().catch(() =>
      console.error(
        "Scheduled follow-up dispatch failed; inspect database and worker health.",
      ),
    );
  }
  private async dispatchSchedules() {
    if (!this.consumeSchedules || this.scheduling) return;
    this.scheduling = true;
    try {
      for (const id of await new FollowUpScheduleService(
        this.service,
      ).dispatchDue()) {
        if (!this.consumeSchedules) return;
        await this.enqueue(id);
      }
    } finally {
      this.scheduling = false;
    }
  }
  async process(runId: string) {
    const db = this.service.db,
      lease = randomUUID();
    const run = (
      await db.pool.query(
        "UPDATE cw_runs SET state='running',lease_owner=$2,lease_expires_at=now()+interval '45 seconds',updated_at=now() WHERE id=$1 AND state='queued' RETURNING *",
        [runId, lease],
      )
    ).rows[0];
    if (!run) return;
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(new Error("Task time limit exceeded.")),
      180000,
    );
    const heartbeat = setInterval(() => {
      void db.pool
        .query(
          "UPDATE cw_runs SET lease_expires_at=now()+interval '45 seconds' WHERE id=$1 AND lease_owner=$2 AND state='running' RETURNING id",
          [runId, lease],
        )
        .then((r) => {
          if (!r.rowCount)
            abort.abort(new Error("Task stopped or lease lost."));
        })
        .catch(() =>
          abort.abort(new Error("Execution lease could not be renewed.")),
        );
    }, 1000);
    let scopeTimer: ReturnType<typeof setInterval> | undefined;
    let scopeChecking = false;
    let lastSourceCheck = Date.now();
    const executionPolicy = new ExecutionPolicyService(db);
    let contextBytes: number | undefined;
    let modelGateway: RunModelGateway | undefined;
    const event = (kind: any, data: Record<string, unknown>) =>
      db.tx((c) => appendEvent(c, runId, kind, data));
    try {
      const actor = (
        await db.pool.query(
          "SELECT u.id,u.name,m.role FROM cw_users u JOIN cw_members m ON m.user_id=u.id WHERE u.id=$1 AND m.workspace_id=$2",
          [run.actor_id, run.workspace_id],
        )
      ).rows[0];
      if (!actor) throw new Error("工作区权限已撤销。");
      const subject: Subject = {
        ...actor,
        workspaceId: run.workspace_id,
        demo: run.demo,
        identityCredentialId: run.identity_credential_id ?? undefined,
      };
      await assertMember(db, subject);
      run.execution_policy_snapshot = await executionPolicy.admit(subject, run);
      await event("run.started", {
        engine: run.engine,
        evidence: run.engine === "fixture" ? "fixture" : "runtime-unverified",
        policyVersion: run.policy_version,
        modelProfileId: run.model_profile_id,
        executionPolicy: run.execution_policy_snapshot,
      });
      await event("usage.updated", {
        kind: "execution-admission",
        count: 1,
        dayBoundary: "UTC",
        note: "计数是获准执行次数，不是供应商请求数、token 或费用。",
      });
      const scope = await loadRunContext(this.service, subject, run);
      const { context, sourceIds, contextRefs } = scope;
      if (run.execution_policy_snapshot)
        scopeTimer = setInterval(() => {
          if (scopeChecking) return;
          scopeChecking = true;
          const checkSource =
            scope.live && Date.now() - lastSourceCheck >= 15000;
          if (checkSource) lastSourceCheck = Date.now();
          void Promise.all([
            executionPolicy.check(db.pool, subject, run, contextBytes),
            ...(checkSource
              ? [assertRunScope(this.service, subject, run)]
              : []),
          ])
            .catch((error) =>
              abort.abort(
                error instanceof ExecutionLimitError
                  ? error
                  : new Error("来源权限、版本或有效执行规则已变化。"),
              ),
            )
            .finally(() => {
              scopeChecking = false;
            });
        }, 1000);
      const snapshot = await db.pool.query(
        "UPDATE cw_runs SET context_refs=$2 WHERE id=$1 AND lease_owner=$3 AND state='running' RETURNING id",
        [runId, JSON.stringify(contextRefs), lease],
      );
      if (!snapshot.rowCount) throw new Error("Task stopped.");
      const policy = JSON.parse(
        await readFile(
          new URL(
            "../../../../docs/handoff-v1/AI-IM基线/product-baseline.v1.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const workdir = resolve(
        process.env.RUNTIME_DIR ?? ".runtime/runs",
        runId,
      );
      await mkdir(workdir, { recursive: true, mode: 0o700 });
      const adapter = this.service.engines.get(run.engine as EngineId);
      if (!adapter) throw new Error("Unknown engine.");
      const modelConnection =
        run.engine === "fixture"
          ? undefined
          : await new ModelService(db).resolve(
              subject,
              "chat",
              run.model_profile_id,
            );
      await assertRunScope(this.service, subject, run);
      abort.signal.throwIfAborted();
      contextBytes = Buffer.byteLength(context + run.instruction, "utf8");
      const limits = await executionPolicy.check(
        db.pool,
        subject,
        run,
        contextBytes,
      );
      await new MethodsService(db).recordPrepared(subject, run);
      await assertRunScope(this.service, subject, run);
      const engineModel = modelConnection
        ? await (modelGateway = new RunModelGateway(
            modelConnection,
            runId,
            abort.signal,
            async () => {
              await assertRunScope(this.service, subject, run);
              return executionPolicy.check(db.pool, subject, run, contextBytes);
            },
          )).start()
        : undefined;
      const result = await adapter.execute({
        runId,
        subject,
        instruction: run.instruction,
        workflow: run.workflow,
        context,
        policy:
          policy.product_principle +
          "\n" +
          policy.policies.map((p: any) => p.id + " " + p.principle).join("\n") +
          "\nEmployee expression preference: " +
          limits.expression +
          ". This changes presentation only; preserve required facts, uncertainty and action receipts.",
        limits,
        workdir,
        model: engineModel,
        signal: abort.signal,
        onProgress: (text) =>
          event("progress.updated", {
            text: isFileWorkflow(run.workflow)
              ? "正在阅读所选个人文件。"
              : text,
          }),
      });
      abort.signal.throwIfAborted();
      await executionPolicy.check(
        db.pool,
        subject,
        run,
        contextBytes,
        result.actions.length,
      );
      const allowed = toolsForWorkflow(run.workflow);
      if (result.actions.some((action) => !allowed.includes(action.tool)))
        throw new Error("本次工作类型未授权该业务动作。");
      const required =
        run.workflow === "discussion_to_minutes" ||
        run.workflow === "project_report"
          ? ["artifact.create", "project.report"]
          : run.workflow === "usage_report"
            ? ["usage.report"]
            : run.workflow === "configure_policy"
              ? ["policy.configure"]
              : run.workflow === "manage_method"
                ? [
                    ["create", "revise"].includes(run.method_plan.operation)
                      ? "method.write"
                      : "method.manage",
                  ]
                : run.workflow === "revise_artifact"
                  ? ["artifact.revise"]
                  : run.workflow === "revise_task"
                    ? ["task.update"]
                    : run.workflow === "review_artifact"
                      ? ["artifact.review"]
                      : run.workflow === "follow_up"
                        ? ["follow_up.check"]
                        : run.workflow === "configure_follow_up"
                          ? ["follow_up.configure"]
                          : run.workflow === "draft_reply"
                            ? ["communication.draft"]
                            : isFileWorkflow(run.workflow)
                              ? ["file.reading.save"]
                              : [];
      if (
        required.length &&
        !result.actions.some((action) => required.includes(action.tool))
      )
        throw new Error("执行器没有提出本次工作要求的成果操作，不能报告完成。");
      if (run.workflow === "revise_artifact" && result.actions.length !== 1)
        throw new Error("一次修订必须对应一个明确的成果版本。");
      if (run.workflow === "manage_method" && result.actions.length !== 1)
        throw new Error("一次方法管理只接受一个明确操作。");
      if (run.workflow === "configure_policy" && result.actions.length !== 1)
        throw new Error("一次执行规则配置只接受一个明确操作。");
      if (run.workflow === "usage_report" && result.actions.length !== 1)
        throw new Error("一次用量查询只接受一个实际回读操作。");
      if (run.workflow === "revise_task" && result.actions.length !== 1)
        throw new Error("一次待办修改必须只对应一个明确版本。");
      if (run.workflow === "review_artifact" && result.actions.length !== 1)
        throw new Error("一次验收必须只记录一个明确决定。");
      if (isFileWorkflow(run.workflow) && result.actions.length !== 1)
        throw new Error("一次文件阅读必须只保存一条个人解读。");
      if (run.workflow === "draft_reply" && result.actions.length !== 1)
        throw new Error("一次起草必须只准备一条会话回复。");
      if (run.workflow === "follow_up" && result.actions.length !== 1)
        throw new Error("一次待办检查必须只执行一次状态比较。");
      if (run.workflow === "configure_follow_up" && result.actions.length !== 1)
        throw new Error("一次跟进配置必须只执行一个明确操作。");
      const receipts: Record<string, unknown>[] = [];
      for (const [index, action] of result.actions.entries()) {
        await assertRunScope(this.service, subject, run);
        abort.signal.throwIfAborted();
        receipts.push(
          await this.applyAction(
            subject,
            run,
            lease,
            action,
            index,
            sourceIds,
            result.evidence,
            "configuration" in scope ? scope.configuration : undefined,
            contextBytes,
            result.actions.length,
          ),
        );
      }
      await assertRunScope(this.service, subject, run);
      await db.tx(async (c) => {
        await ExecutionPolicyService.lock(c, subject.workspaceId);
        // A confirmed policy change may disable its own workflow; its committed receipt still completes.
        if (run.workflow !== "configure_policy")
          await executionPolicy.check(
            c,
            subject,
            run,
            contextBytes,
            result.actions.length,
          );
        await assertScheduledRun(c, run, true);
        const member = await c.query(
          "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
          [subject.workspaceId, subject.id],
        );
        if (!member.rowCount)
          throw new Error("工作区权限已撤销，不能发布执行结果。");
        if (isFileWorkflow(run.workflow))
          await FileReadingService.lockSource(
            c,
            subject,
            run.source_file_asset_id,
            run.expected_file_version,
          );
        const current = await c.query(
          "SELECT state FROM cw_runs WHERE id=$1 AND lease_owner=$2 FOR UPDATE",
          [runId, lease],
        );
        if (current.rows[0]?.state !== "running") return;
        if (
          run.workflow !== "draft_reply" &&
          run.workflow !== "follow_up" &&
          run.workflow !== "configure_follow_up" &&
          run.workflow !== "configure_policy" &&
          run.workflow !== "usage_report" &&
          run.workflow !== "review_artifact" &&
          run.workflow !== "revise_task" &&
          run.workflow !== "manage_method" &&
          !isFileWorkflow(run.workflow)
        )
          await c.query(
            "INSERT INTO cw_messages(id,workspace_id,conversation_id,author,role,content,metadata) VALUES($1,$2,$3,'协作助手','assistant',$4,$5)",
            [
              randomUUID(),
              run.workspace_id,
              run.conversation_id,
              result.text,
              { runId, evidence: result.evidence, receipts },
            ],
          );
        await c.query(
          "UPDATE cw_runs SET state='succeeded',result=$2,updated_at=now(),lease_expires_at=NULL WHERE id=$1",
          [
            runId,
            {
              text:
                run.workflow === "draft_reply"
                  ? "回复草稿已保存，尚未发送。"
                  : run.workflow === "follow_up"
                    ? receipts[0]!.summary
                    : run.workflow === "configure_follow_up"
                      ? "定时跟进配置已保存。"
                      : run.workflow === "configure_policy"
                        ? "已保存员工确认的执行规则，后续执行按有效限制检查。"
                        : run.workflow === "usage_report"
                          ? "已回读本人的模型用量记录；不完整用量与费用仍明确标记为未知。"
                          : run.workflow === "review_artifact"
                            ? "已记录员工对指定成果版本的验收决定。"
                            : run.workflow === "manage_method"
                              ? "方法操作已保存，请核对实际状态和版本；不代表模型独立验证了方法。"
                              : run.workflow === "revise_task"
                                ? "待办记录已核对并保存；不代表实际工作已独立验收。"
                                : isFileWorkflow(run.workflow)
                                  ? "个人文件解读已保存。"
                                  : result.text,
              receipts,
              evidence: result.evidence,
            },
          ],
        );
        await appendEvent(c, runId, "run.completed", {
          receipts,
          evidence: result.evidence,
        });
      });
    } catch (error) {
      await db.tx(async (c) => {
        const current = (
          await c.query("SELECT state FROM cw_runs WHERE id=$1 FOR UPDATE", [
            runId,
          ])
        ).rows[0];
        if (!current || current.state !== "running") return;
        const actions = await c.query(
          "SELECT id FROM cw_actions WHERE run_id=$1 AND state='completed'",
          [runId],
        );
        const state = actions.rowCount ? "recovery_required" : "failed";
        const message = isFileWorkflow(run.workflow)
          ? error instanceof ReadingVersionConflict ||
            error instanceof ReadingInputLimit ||
            error instanceof ExecutionLimitError
            ? error.message
            : "文件阅读未完成，请检查来源、模型或重新发起。"
          : error instanceof Error
            ? error.message
            : "执行失败。";
        await c.query(
          "UPDATE cw_runs SET state=$2,error=$3,updated_at=now(),lease_expires_at=NULL WHERE id=$1",
          [runId, state, message],
        );
        await appendEvent(
          c,
          runId,
          state === "failed" ? "run.failed" : "run.recovery_required",
          { message },
        );
      });
    } finally {
      await modelGateway?.close();
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (scopeTimer) clearInterval(scopeTimer);
      if (isFileWorkflow(run.workflow))
        await purgeFileRuntime(db, runId).catch(() =>
          console.error(
            "Private runtime cleanup failed; inspect runtime storage.",
          ),
        );
    }
  }
  private async applyAction(
    s: Subject,
    run: any,
    lease: string,
    action: PlannedAction,
    index: number,
    sourceIds: string[],
    evidence: "fixture" | "runtime",
    configuration?: PreparedFollowUp,
    contextBytes?: number,
    actionCount?: number,
  ) {
    if (!toolsForWorkflow(run.workflow).includes(action.tool))
      throw new Error("本次工作类型未授权该业务动作。");
    return this.service.db.tx(async (c) => {
      await ExecutionPolicyService.lock(c, s.workspaceId);
      await new ExecutionPolicyService(this.service.db).check(
        c,
        s,
        run,
        contextBytes,
        actionCount,
      );
      await assertScheduledRun(c, run, true);
      // Match scheduled checks: target schedule before Run/member locks.
      if (configuration)
        await FollowUpScheduleService.lockTarget(c, s, configuration);
      if (run.method_refs?.length || run.workflow === "manage_method") {
        const scope = (
          await c.query(
            "SELECT project_id FROM cw_conversations WHERE id=$1 AND workspace_id=$2",
            [run.conversation_id, s.workspaceId],
          )
        ).rows[0];
        if (!scope) throw new Error("方法项目范围不可用。");
        if (run.method_refs?.length)
          await MethodsService.lockReferences(
            c,
            s,
            scope.project_id,
            run.method_refs,
          );
        if (run.workflow === "manage_method")
          await MethodsService.lockTarget(
            c,
            s,
            run.method_plan,
            scope.project_id,
          );
      }
      if (run.workflow === "revise_task") {
        const target = (
          await c.query(
            "SELECT project_id FROM cw_conversations WHERE id=$1 AND workspace_id=$2",
            [run.conversation_id, s.workspaceId],
          )
        ).rows[0];
        if (!target) throw new Error("待办项目范围不可用。");
        await lockTask(c, s, run.task_id, target.project_id);
      }
      if (["revise_artifact", "review_artifact"].includes(run.workflow)) {
        const scope = (
          await c.query(
            "SELECT project_id FROM cw_conversations WHERE id=$1 AND workspace_id=$2",
            [run.conversation_id, s.workspaceId],
          )
        ).rows[0];
        if (!scope) throw new Error("成果项目范围不可用。");
        await lockArtifact(c, s, run.artifact_id, scope.project_id);
      }
      if (isFileWorkflow(run.workflow))
        await FileReadingService.lockSource(
          c,
          s,
          run.source_file_asset_id,
          run.expected_file_version,
        );
      const current = (
        await c.query(
          "SELECT state,lease_owner FROM cw_runs WHERE id=$1 FOR UPDATE",
          [run.id],
        )
      ).rows[0];
      if (current?.state !== "running" || current.lease_owner !== lease)
        throw new Error("Task stopped.");
      const member = await c.query(
        "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
        [s.workspaceId, s.id],
      );
      if (!member.rowCount) throw new Error("Workspace access revoked.");
      const key = run.id + ":" + index;
      const prior = (
        await c.query(
          "SELECT result,params_hash FROM cw_actions WHERE idempotency_key=$1",
          [key],
        )
      ).rows[0];
      const hash = stableDigest(action);
      if (prior) {
        if (prior.params_hash !== hash)
          throw new Error("Action idempotency conflict.");
        return prior.result;
      }
      const conv = (
        await c.query(
          "SELECT project_id FROM cw_conversations WHERE id=$1 AND workspace_id=$2",
          [run.conversation_id, s.workspaceId],
        )
      ).rows[0];
      if (!conv && !isFileWorkflow(run.workflow))
        throw new Error("Conversation unavailable.");
      let receipt: Record<string, unknown>;
      if (action.tool === "usage.report") {
        z.object({}).strict().parse(action.args);
        const usage = await new ModelUsageService(this.service.db).view(s);
        receipt = {
          tool: "usage.report",
          summary: usage.summary,
          costStatus: usage.costStatus,
          note: usage.note,
        };
      } else if (action.tool === "policy.configure") {
        z.object({}).strict().parse(action.args);
        receipt = await new ExecutionPolicyService(this.service.db).apply(
          c,
          s,
          conv.project_id,
          run.policy_plan,
          "configure-policy:" + run.id,
          run.id,
        );
      } else if (action.tool === "file.reading.save") {
        const input = z
          .object({ content: z.string().trim().min(1).max(20000) })
          .strict()
          .parse(action.args);
        receipt = await FileReadingService.save(c, s, run, input.content);
      } else if (
        action.tool === "method.write" ||
        action.tool === "method.manage"
      ) {
        const writing = ["create", "revise"].includes(
          run.method_plan.operation,
        );
        if ((action.tool === "method.write") !== writing)
          throw new Error("方法操作与员工指定计划不符。");
        if (!writing) z.object({}).strict().parse(action.args);
        receipt = await MethodsService.apply(
          c,
          s,
          conv.project_id,
          run.method_plan,
          writing ? action.args : undefined,
          run.id + ":" + index,
          run.id,
        );
        await appendEvent(c, run.id, "method.updated", receipt);
      } else if (action.tool === "task.update") {
        const input = TaskRewrite.parse(action.args);
        receipt = {
          tool: action.tool,
          ...(await patchProjectTask(
            c,
            s,
            run.task_id,
            { ...input, expectedVersion: run.expected_task_version },
            conv.project_id,
            run.id,
          )),
        };
        await appendEvent(c, run.id, "task.updated", receipt);
      } else if (action.tool === "task.create") {
        const input = TaskInput.parse(action.args);
        receipt = {
          tool: action.tool,
          ...(await createProjectTask(c, s, conv.project_id, input, run.id)),
        };
      } else if (
        action.tool === "artifact.create" ||
        action.tool === "project.report"
      ) {
        const title = String(action.args.title ?? "项目成果").slice(0, 300),
          content = action.args.content;
        if (
          typeof content !== "string" ||
          !content.trim() ||
          content.length > 100000
        )
          throw new Error("成果内容无效。");
        const id = randomUUID();
        await c.query(
          "INSERT INTO cw_artifacts(id,workspace_id,project_id,title,created_by) VALUES($1,$2,$3,$4,$5)",
          [id, s.workspaceId, conv.project_id, title, s.id],
        );
        await c.query(
          "INSERT INTO cw_artifact_versions(artifact_id,version,content,source_message_ids,created_by) VALUES($1,1,$2,$3,$4)",
          [id, content, JSON.stringify(sourceIds), s.id],
        );
        await c.query(
          "INSERT INTO cw_assets(id,workspace_id,project_id,owner_id,title,content,type,source_ref,source_version) VALUES($1,$2,$3,$4,$5,$6,'artifact',$7,'1')",
          [
            randomUUID(),
            s.workspaceId,
            conv.project_id,
            s.id,
            title,
            content,
            "artifact:" + id,
          ],
        );
        receipt = { tool: action.tool, id, title, version: 1 };
        await appendEvent(c, run.id, "artifact.updated", receipt);
      } else if (action.tool === "artifact.review") {
        z.object({}).strict().parse(action.args);
        receipt = await ArtifactReviewService.apply(
          c,
          s,
          run.artifact_id,
          run.artifact_review_plan,
          conv.project_id,
          "review:" + run.id,
          run.id,
        );
        await appendEvent(c, run.id, "artifact.updated", {
          id: run.artifact_id,
          version: receipt.version,
          status: receipt.status,
          reviewId: receipt.id,
          reviewRevision: receipt.reviewRevision,
        });
      } else if (action.tool === "artifact.revise") {
        const id = run.artifact_id;
        if (!id) throw new Error("No artifact was authorized for revision.");
        if (
          action.args.artifactId !== undefined &&
          action.args.artifactId !== id
        )
          throw new Error("修改目标不属于本次授权成果。");
        const content = action.args.content;
        if (
          typeof content !== "string" ||
          !content.trim() ||
          content.length > 100000
        )
          throw new Error("修订内容无效。");
        const revision = await reviseArtifactVersion(
          c,
          s,
          id,
          {
            content,
            feedback: run.instruction,
            expectedVersion: run.expected_artifact_version,
          },
          conv.project_id,
          sourceIds,
        );
        receipt = { tool: action.tool, ...revision };
        await appendEvent(c, run.id, "artifact.updated", receipt);
      } else if (action.tool === "communication.draft") {
        const input = z
          .object({ content: z.string().trim().min(1).max(20000) })
          .strict()
          .parse(action.args);
        const scope = (
          await c.query(
            "SELECT conversation_ref FROM cw_project_sources WHERE project_id=$1 AND workspace_id=$2",
            [conv.project_id, s.workspaceId],
          )
        ).rows[0];
        if (!scope) throw new Error("回复草稿必须绑定企业会话来源。");
        const id = randomUUID();
        await c.query(
          "INSERT INTO cw_communication_drafts(id,workspace_id,project_id,actor_id,source_run_id,content,source_message_ids) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            id,
            s.workspaceId,
            conv.project_id,
            s.id,
            run.id,
            input.content,
            JSON.stringify(sourceIds),
          ],
        );
        receipt = {
          tool: action.tool,
          id,
          roomId: scope.conversation_ref,
          state: "draft",
        };
      } else if (action.tool === "follow_up.configure") {
        z.object({}).strict().parse(action.args);
        if (!configuration) throw new Error("跟进配置范围缺失。");
        receipt = await FollowUpScheduleService.apply(
          c,
          s,
          configuration,
          "configure:" + run.id,
          stableDigest(configuration),
          run.id,
        );
      } else if (action.tool === "follow_up.check") {
        z.object({}).strict().parse(action.args);
        receipt = {
          ...(await FollowUpService.check(
            c,
            s,
            run,
            conv.project_id,
            evidence,
          )),
        };
      } else throw new Error("Tool is not allowed.");
      if (
        ["artifact.create", "project.report", "artifact.revise"].includes(
          action.tool,
        )
      )
        for (const ref of run.method_refs ?? [])
          await c.query(
            `INSERT INTO cw_asset_links(id,workspace_id,from_id,to_id,relation,source_version) VALUES($1,$2,$3,$4,'reused_method',$5) ON CONFLICT(workspace_id,from_id,to_id,relation) DO UPDATE SET source_version=EXCLUDED.source_version`,
            [
              randomUUID(),
              s.workspaceId,
              receipt.id,
              ref.id,
              ref.version + ":" + ref.revision,
            ],
          );
      await c.query(
        "INSERT INTO cw_actions(id,workspace_id,actor_id,run_id,tool,params_hash,idempotency_key,state,result) VALUES($1,$2,$3,$4,$5,$6,$7,'completed',$8)",
        [
          randomUUID(),
          s.workspaceId,
          s.id,
          run.id,
          action.tool,
          hash,
          key,
          receipt,
        ],
      );
      await appendEvent(c, run.id, "action.completed", receipt);
      return receipt;
    });
  }
}
