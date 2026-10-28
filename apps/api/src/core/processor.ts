import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PgBoss } from "pg-boss";
import {
  TaskInput,
  type EngineId,
  type Subject,
  type PlannedAction,
} from "@hyper/contracts";
import { Database } from "../db/database.js";
import { WorkspaceService, appendEvent } from "./workspace.js";
import { assertMember, stableDigest } from "./security.js";
import { refreshArtifactIndex } from "./knowledge.js";
export class RunProcessor {
  readonly boss: PgBoss;
  private sweep?: NodeJS.Timeout;
  constructor(readonly service: WorkspaceService) {
    this.boss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "hyper_jobs",
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
      };
      await assertMember(db, subject);
      await event("run.started", {
        engine: run.engine,
        evidence: run.engine === "fixture" ? "fixture" : "runtime-unverified",
        policyVersion: run.policy_version,
      });
      const conversation = await this.service.conversation(
        subject,
        run.conversation_id,
      );
      const messages = (
        await db.pool.query(
          "SELECT id,author,content FROM cw_messages WHERE conversation_id=$1 AND workspace_id=$2 ORDER BY position DESC LIMIT 60",
          [run.conversation_id, run.workspace_id],
        )
      ).rows.reverse();
      let context = messages
        .map((m) => m.author + ": " + m.content + " [message:" + m.id + "]")
        .join("\n");
      if (run.artifact_id) {
        const a = await this.service.artifact(subject, run.artifact_id);
        context = a.current.content;
      }
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
        signal: abort.signal,
        onProgress: (text) => event("progress.updated", { text }),
      });
      abort.signal.throwIfAborted();
      const receipts: Record<string, unknown>[] = [];
      for (const [index, action] of result.actions.entries()) {
        await assertMember(db, subject);
        abort.signal.throwIfAborted();
        receipts.push(
          await this.applyAction(
            subject,
            run,
            lease,
            action,
            index,
            messages.map((m) => m.id),
          ),
        );
      }
      await db.tx(async (c) => {
        const current = await c.query(
          "SELECT state FROM cw_runs WHERE id=$1 AND lease_owner=$2 FOR UPDATE",
          [runId, lease],
        );
        if (current.rows[0]?.state !== "running") return;
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
          [runId, { text: result.text, receipts, evidence: result.evidence }],
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
        const message = error instanceof Error ? error.message : "执行失败。";
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
    }
  }
  private async applyAction(
    s: Subject,
    run: any,
    lease: string,
    action: PlannedAction,
    index: number,
    sourceIds: string[],
  ) {
    return this.service.db.tx(async (c) => {
      const current = (
        await c.query(
          "SELECT state,lease_owner FROM cw_runs WHERE id=$1 FOR UPDATE",
          [run.id],
        )
      ).rows[0];
      if (current?.state !== "running" || current.lease_owner !== lease)
        throw new Error("Task stopped.");
      const member = await c.query(
        "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
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
      if (!conv) throw new Error("Conversation unavailable.");
      let receipt: Record<string, unknown>;
      if (action.tool === "task.create") {
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
        const a = (
          await c.query(
            "SELECT * FROM cw_artifacts WHERE id=$1 AND workspace_id=$2 AND project_id=$3 FOR UPDATE",
            [id, s.workspaceId, conv.project_id],
          )
        ).rows[0];
        if (!a) throw new Error("成果不在本次授权项目。");
        const content = action.args.content;
        if (
          typeof content !== "string" ||
          !content.trim() ||
          content.length > 100000
        )
          throw new Error("修订内容无效。");
        const version = a.current_version + 1;
        await c.query(
          "INSERT INTO cw_artifact_versions(artifact_id,version,content,feedback,created_by) VALUES($1,$2,$3,$4,$5)",
          [id, version, content, run.instruction, s.id],
        );
        await c.query(
          "UPDATE cw_artifacts SET current_version=$2,status='draft' WHERE id=$1",
          [id, version],
        );
        await refreshArtifactIndex(c, s.workspaceId, id, content, version);
        receipt = { tool: action.tool, id, version };
        await appendEvent(c, run.id, "artifact.updated", receipt);
      } else if (action.tool === "follow_up.check") {
        const pending = (
          await c.query(
            "SELECT id,title,status FROM cw_tasks WHERE project_id=$1 AND workspace_id=$2 AND status='open'",
            [conv.project_id, s.workspaceId],
          )
        ).rows;
        receipt = { tool: action.tool, pending };
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
