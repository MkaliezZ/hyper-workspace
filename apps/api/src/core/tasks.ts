import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { TaskInput, TaskPatch, type Subject } from "@hyper/contracts";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

/** Human and AI creation share validation, membership, scope and database readback. */
export async function createProjectTask(
  c: PoolClient,
  subject: Subject,
  projectId: string,
  raw: TaskInput,
  sourceRunId?: string,
) {
  const input = TaskInput.parse(raw);
  const member = await c.query(
    "SELECT 1 FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
    [subject.workspaceId, subject.id],
  );
  if (!member.rowCount) throw new ForbiddenException("工作区权限已撤销。");
  const project = await c.query(
    "SELECT id FROM cw_projects WHERE id=$1 AND workspace_id=$2 FOR KEY SHARE",
    [projectId, subject.workspaceId],
  );
  if (!project.rowCount)
    throw new NotFoundException("项目不存在或不在本次授权范围。");
  const task = (
    await c.query(
      `INSERT INTO cw_tasks(id,workspace_id,project_id,title,assignee,due_date,created_by,source_run_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id,title,assignee,to_char(due_date,'YYYY-MM-DD') AS "dueDate",status,version`,
      [
        randomUUID(),
        subject.workspaceId,
        projectId,
        input.title,
        input.assignee,
        input.dueDate,
        subject.id,
        sourceRunId ?? null,
      ],
    )
  ).rows[0];
  await recordTaskVersion(c, subject, task, sourceRunId);
  return task;
}

export async function lockTask(
  c: PoolClient,
  subject: Subject,
  id: string,
  projectId?: string,
) {
  const row = (
    await c.query(
      `SELECT id,project_id,title,assignee,to_char(due_date,'YYYY-MM-DD') AS "dueDate",status,version
     FROM cw_tasks WHERE id=$1 AND workspace_id=$2 AND ($3::uuid IS NULL OR project_id=$3) FOR UPDATE`,
      [id, subject.workspaceId, projectId ?? null],
    )
  ).rows[0];
  if (!row) throw new NotFoundException("待办不存在或不在本次授权项目。");
  return row;
}

async function recordTaskVersion(
  c: PoolClient,
  subject: Subject,
  task: any,
  sourceRunId?: string,
) {
  const snapshot = {
    title: task.title,
    assignee: task.assignee,
    dueDate: task.dueDate,
    status: task.status,
  };
  await c.query(
    `INSERT INTO cw_task_versions(task_id,workspace_id,version,snapshot,actor_id,identity_credential_id,source_run_id,channel)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      task.id,
      subject.workspaceId,
      task.version,
      JSON.stringify(snapshot),
      subject.id,
      subject.identityCredentialId ?? null,
      sourceRunId ?? null,
      sourceRunId ? "ai" : "human",
    ],
  );
}

export async function patchProjectTask(
  c: PoolClient,
  subject: Subject,
  id: string,
  raw: TaskPatch,
  projectId?: string,
  sourceRunId?: string,
) {
  const patch = TaskPatch.parse(raw),
    current = await lockTask(c, subject, id, projectId);
  const member = await c.query(
    "SELECT 1 FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
    [subject.workspaceId, subject.id],
  );
  if (!member.rowCount) throw new ForbiddenException("工作区权限已撤销。");
  if (
    patch.expectedVersion !== undefined &&
    patch.expectedVersion !== current.version
  )
    throw new ConflictException("待办已更新，请重新读取当前版本后再修改。");
  // Direct seed/legacy inserts may lack tracked history. Capture only the
  // current pre-edit state; never infer who made earlier changes or when.
  await c.query(
    `INSERT INTO cw_task_versions(task_id,workspace_id,version,snapshot,channel)
    VALUES($1,$2,$3,$4,'legacy_snapshot') ON CONFLICT(task_id,version) DO NOTHING`,
    [
      id,
      subject.workspaceId,
      current.version,
      JSON.stringify({
        title: current.title,
        assignee: current.assignee,
        dueDate: current.dueDate,
        status: current.status,
      }),
    ],
  );
  const fields = ["title", "assignee", "dueDate", "status"] as const;
  if (
    !fields.some(
      (key) => patch[key] !== undefined && patch[key] !== current[key],
    )
  )
    return { ...current, changed: false };
  const task = (
    await c.query(
      `UPDATE cw_tasks SET title=COALESCE($2,title),assignee=COALESCE($3,assignee),
    due_date=CASE WHEN $4 THEN $5::date ELSE due_date END,status=COALESCE($6,status),version=version+1
    WHERE id=$1 AND version=$7 RETURNING id,title,assignee,to_char(due_date,'YYYY-MM-DD') AS "dueDate",status,version`,
      [
        id,
        patch.title ?? null,
        patch.assignee ?? null,
        patch.dueDate !== undefined,
        patch.dueDate ?? null,
        patch.status ?? null,
        current.version,
      ],
    )
  ).rows[0];
  if (!task) throw new ConflictException("待办版本已变化，未保存修改。");
  await recordTaskVersion(c, subject, task, sourceRunId);
  return { ...task, changed: true };
}
