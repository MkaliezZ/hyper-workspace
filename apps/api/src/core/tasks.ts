import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { TaskInput, type Subject } from "@hyper/contracts";
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
  return (
    await c.query(
      `INSERT INTO cw_tasks(id,workspace_id,project_id,title,assignee,due_date,created_by,source_run_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id,title,assignee,due_date::text AS "dueDate",status`,
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
}
