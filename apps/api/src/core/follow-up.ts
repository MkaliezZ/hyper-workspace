import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Subject, Task } from "@hyper/contracts";
import { stableDigest } from "./credentials.js";

type Field = "title" | "assignee" | "status" | "dueDate";
const fields: Field[] = ["title", "assignee", "status", "dueDate"];
interface Change {
  kind: "added" | "updated" | "removed";
  id: string;
  before: Task | null;
  after: Task | null;
  fields: Field[];
}
export interface FollowUpReceipt {
  tool: "follow_up.check";
  projectId: string;
  reason: "baseline" | "unchanged" | "changed";
  notify: boolean;
  pending: Task[];
  changes: Change[];
  baselineRunId: string | null;
  observedAt: string;
  stateDigest: string;
  notificationMessageId: string | null;
  summary: string;
}

/** Only the host compares current product facts. No model-supplied state or recipients. */
export class FollowUpService {
  static async tasks(
    c: Pick<PoolClient, "query">,
    workspaceId: string,
    projectId: string,
  ): Promise<Task[]> {
    const result = await c.query(
      `SELECT id,title,assignee,status,to_char(due_date,'YYYY-MM-DD') AS "dueDate"
       FROM cw_tasks WHERE workspace_id=$1 AND project_id=$2 ORDER BY id LIMIT 1001`,
      [workspaceId, projectId],
    );
    if (result.rows.length > 1000)
      throw new Error(
        "当前项目超过 1000 项待办，本次未更新跟进基线，请缩小项目范围。",
      );
    return result.rows;
  }

  static async check(
    c: PoolClient,
    s: Subject,
    run: { id: string; conversation_id: string },
    projectId: string,
    evidence: "fixture" | "runtime",
  ): Promise<FollowUpReceipt> {
    // This short transaction serializes all engines/employees on the same project.
    // Source/engine calls stay outside this lock; task reads are one SQL snapshot.
    const project = await c.query(
      `SELECT p.id FROM cw_projects p JOIN cw_conversations v
       ON v.project_id=p.id AND v.workspace_id=p.workspace_id
       WHERE p.id=$1 AND p.workspace_id=$2 AND v.id=$3 FOR NO KEY UPDATE OF p`,
      [projectId, s.workspaceId, run.conversation_id],
    );
    if (!project.rowCount) throw new Error("跟进项目范围已变化。");
    const previous = (
      await c.query(
        "SELECT snapshot,last_run_id FROM cw_follow_up_baselines WHERE project_id=$1 AND workspace_id=$2",
        [projectId, s.workspaceId],
      )
    ).rows[0];
    const tasks = await this.tasks(c, s.workspaceId, projectId);
    const current = new Map(tasks.map((t) => [t.id, t]));
    const before = new Map<string, Task>(
      (previous?.snapshot ?? []).map((t: Task) => [t.id, t]),
    );
    const changes: Change[] = [];
    if (previous) {
      for (const task of tasks) {
        const old = before.get(task.id);
        const changed = old ? fields.filter((f) => old[f] !== task[f]) : [];
        if (!old || changed.length)
          changes.push({
            kind: old ? "updated" : "added",
            id: task.id,
            before: old ?? null,
            after: task,
            fields: old ? changed : [...fields],
          });
      }
      for (const task of before.values())
        if (!current.has(task.id))
          changes.push({
            kind: "removed",
            id: task.id,
            before: task,
            after: null,
            fields: [],
          });
    }
    const pending = tasks.filter((t) => t.status === "open");
    const reason = !previous
      ? "baseline"
      : changes.length
        ? "changed"
        : "unchanged";
    const summary =
      reason === "baseline"
        ? `已建立待办检查基线，当前 ${pending.length} 项待处理；本次未向项目发消息。`
        : reason === "unchanged"
          ? `待办无变化，当前 ${pending.length} 项待处理；本次未向项目发消息。`
          : this.summary(changes, pending.length);
    const receipt: FollowUpReceipt = {
      tool: "follow_up.check",
      projectId,
      reason,
      notify: changes.length > 0,
      pending,
      changes,
      baselineRunId: previous?.last_run_id ?? null,
      observedAt: (
        await c.query("SELECT clock_timestamp() AS at")
      ).rows[0].at.toISOString(),
      stateDigest: stableDigest(tasks),
      notificationMessageId: changes.length ? randomUUID() : null,
      summary,
    };
    await c.query(
      `INSERT INTO cw_follow_up_baselines(project_id,workspace_id,snapshot,last_run_id)
       VALUES($1,$2,$3,$4) ON CONFLICT(project_id,workspace_id)
       DO UPDATE SET snapshot=EXCLUDED.snapshot,last_run_id=EXCLUDED.last_run_id,checked_at=clock_timestamp()`,
      [projectId, s.workspaceId, JSON.stringify(tasks), run.id],
    );
    // The notification, baseline and caller's action receipt commit together.
    // A crash after this action cannot silently consume a change without its message.
    if (receipt.notificationMessageId)
      await c.query(
        `INSERT INTO cw_messages(id,workspace_id,conversation_id,author,role,content,metadata)
         VALUES($1,$2,$3,'协作助手','assistant',$4,$5)`,
        [
          receipt.notificationMessageId,
          s.workspaceId,
          run.conversation_id,
          summary,
          {
            runId: run.id,
            evidence,
            receipts: [
              {
                tool: receipt.tool,
                projectId,
                stateDigest: receipt.stateDigest,
                observedAt: receipt.observedAt,
                notificationMessageId: receipt.notificationMessageId,
                changeCount: changes.length,
              },
            ],
          },
        ],
      );
    return receipt;
  }

  private static summary(changes: Change[], pending: number) {
    const count = (kind: Change["kind"]) =>
      changes.filter((c) => c.kind === kind).length;
    const labels: Record<Field, string> = {
      title: "事项",
      assignee: "负责人",
      status: "状态",
      dueDate: "截止日期",
    };
    const value = (task: Task, field: Field) =>
      field === "status"
        ? task.status === "done"
          ? "已完成"
          : "待处理"
        : (task[field] ?? "未设置");
    const details = changes.slice(0, 10).map((change) => {
      if (change.kind === "added") return "- 新增：" + change.after!.title;
      if (change.kind === "removed")
        return "- 移出当前待办：" + change.before!.title;
      return (
        "- 更新：" +
        change.after!.title +
        "（" +
        change.fields
          .map(
            (field) =>
              labels[field] +
              "：" +
              value(change.before!, field) +
              " → " +
              value(change.after!, field),
          )
          .join("；") +
        "）"
      );
    });
    if (changes.length > 10)
      details.push(`另有 ${changes.length - 10} 项变化，完整差异见执行回执。`);
    return (
      `待办有 ${changes.length} 项变化：新增 ${count("added")} 项，更新 ${count("updated")} 项，移出 ${count("removed")} 项。当前 ${pending} 项待处理。\n` +
      details.join("\n")
    );
  }
}
