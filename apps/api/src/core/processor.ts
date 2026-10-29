import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { PgBoss } from "pg-boss";
import {
  TaskInput,
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
import { reviseArtifactVersion } from "./artifacts.js";
import { ModelService } from "./models.js";
import { assertRunScope, loadRunContext } from "./run-context.js";
import { FollowUpService } from "./follow-up.js";
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
      await event("run.started", {
        engine: run.engine,
        evidence: run.engine === "fixture" ? "fixture" : "runtime-unverified",
        policyVersion: run.policy_version,
        modelProfileId: run.model_profile_id,
      });
      const scope = await loadRunContext(this.service, subject, run);
      const { context, sourceIds, contextRefs } = scope;
      if (scope.live)
        scopeTimer = setInterval(() => {
          if (scopeChecking) return;
          scopeChecking = true;
          void assertRunScope(this.service, subject, run)
            .catch(() => abort.abort(new Error("来源权限或版本已变化。")))
            .finally(() => {
              scopeChecking = false;
            });
        }, 15000);
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
      if (Buffer.byteLength(context + run.instruction, "utf8") > 100000) {
        if (isFileWorkflow(run.workflow)) throw new ReadingInputLimit();
        throw new Error(
          "当前上下文超过 100 KB，请缩小讨论范围或拆分成果后重试。",
        );
      }
      const result = await adapter.execute({
        runId,
        subject,
        instruction: run.instruction,
        workflow: run.workflow,
        context,
        policy:
          policy.product_principle +
          "\n" +
          policy.policies.map((p: any) => p.id + " " + p.principle).join("\n"),
        workdir,
        model: modelConnection,
        signal: abort.signal,
        onProgress: (text) =>
          event("progress.updated", {
            text: isFileWorkflow(run.workflow)
              ? "正在阅读所选个人文件。"
              : text,
          }),
      });
      abort.signal.throwIfAborted();
      const allowed = toolsForWorkflow(run.workflow);
      if (result.actions.some((action) => !allowed.includes(action.tool)))
        throw new Error("本次工作类型未授权该业务动作。");
      const required =
        run.workflow === "discussion_to_minutes" ||
        run.workflow === "project_report"
          ? ["artifact.create", "project.report"]
          : run.workflow === "revise_artifact"
            ? ["artifact.revise"]
            : run.workflow === "follow_up"
              ? ["follow_up.check"]
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
      if (isFileWorkflow(run.workflow) && result.actions.length !== 1)
        throw new Error("一次文件阅读必须只保存一条个人解读。");
      if (run.workflow === "draft_reply" && result.actions.length !== 1)
        throw new Error("一次起草必须只准备一条会话回复。");
      if (run.workflow === "follow_up" && result.actions.length !== 1)
        throw new Error("一次待办检查必须只执行一次状态比较。");
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
          ),
        );
      }
      await assertRunScope(this.service, subject, run);
      await db.tx(async (c) => {
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
            error instanceof ReadingInputLimit
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
  ) {
    if (!toolsForWorkflow(run.workflow).includes(action.tool))
      throw new Error("本次工作类型未授权该业务动作。");
    return this.service.db.tx(async (c) => {
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
      if (action.tool === "file.reading.save") {
        const input = z
          .object({ content: z.string().trim().min(1).max(20000) })
          .strict()
          .parse(action.args);
        receipt = await FileReadingService.save(c, s, run, input.content);
      } else if (action.tool === "task.create") {
        const input = TaskInput.parse(action.args);
        const id = randomUUID();
        await c.query(
          "INSERT INTO cw_tasks(id,workspace_id,project_id,title,assignee,due_date,created_by,source_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            id,
            s.workspaceId,
            conv.project_id,
            input.title,
            input.assignee,
            input.dueDate,
            s.id,
            run.id,
          ],
        );
        receipt = { tool: action.tool, id, ...input };
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
