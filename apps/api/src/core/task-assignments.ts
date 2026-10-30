import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { TaskAssignmentPlan, type Subject } from "@hyper/contracts";
import type { PoolClient } from "pg";
import type { Database } from "../db/database.js";
import { ProjectAccess } from "./project-access.js";
import { DirectoryService, type AssignmentProof } from "./directory.js";
import { lockTask, recordTaskVersion } from "./tasks.js";
import { stableDigest } from "./credentials.js";
export class TaskAssignmentService {
  constructor(readonly db: Database) {}
  async prepare(s: Subject, projectId: string, raw: TaskAssignmentPlan) {
    const plan = TaskAssignmentPlan.parse(raw);
    await new ProjectAccess(this.db).assert(s, projectId);
    const task = (
      await this.db.pool.query(
        "SELECT id,version FROM cw_tasks WHERE id=$1 AND workspace_id=$2 AND project_id=$3",
        [plan.taskId, s.workspaceId, projectId],
      )
    ).rows[0];
    if (!task) throw new BadRequestException("待办不在当前项目。");
    if (task.version !== plan.expectedVersion)
      throw new ConflictException("待办已更新，请重新读取后分配。");
    const proof = plan.assigneeId
      ? await new DirectoryService(this.db).resolve(
          s,
          projectId,
          plan.assigneeId,
        )
      : undefined;
    return { plan, proof };
  }
  async save(
    s: Subject,
    projectId: string,
    raw: TaskAssignmentPlan,
    key: string,
  ) {
    const plan = TaskAssignmentPlan.parse(raw);
    await new ProjectAccess(this.db).assert(s, projectId);
    const old = (
      await this.db.pool.query(
        "SELECT input_hash,receipt FROM cw_task_assignment_actions WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, key],
      )
    ).rows[0];
    if (old) {
      if (old.input_hash !== stableDigest({ projectId, plan }))
        throw new ConflictException("员工分配幂等键冲突。");
      return old.receipt;
    }
    const prepared = await this.prepare(s, projectId, plan);
    return this.db.tx((c) =>
      this.apply(c, s, projectId, plan, prepared.proof, key),
    );
  }
  async apply(
    c: PoolClient,
    s: Subject,
    projectId: string,
    raw: TaskAssignmentPlan,
    proof: AssignmentProof | undefined,
    key: string,
    runId?: string,
  ) {
    const plan = TaskAssignmentPlan.parse(raw),
      current = await lockTask(c, s, plan.taskId, projectId);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "task-assignment:" + s.workspaceId + ":" + s.id + ":" + key,
    ]);
    if (
      !(
        await c.query(
          "SELECT user_id FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
          [s.workspaceId, s.id],
        )
      ).rowCount
    )
      throw new ForbiddenException("工作区权限已撤销。");
    const hash = stableDigest({ projectId, plan }),
      old = (
        await c.query(
          "SELECT input_hash,receipt FROM cw_task_assignment_actions WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, key],
        )
      ).rows[0];
    if (old) {
      if (old.input_hash !== hash)
        throw new ConflictException("员工分配幂等键冲突。");
      return old.receipt;
    }
    if (current.version !== plan.expectedVersion)
      throw new ConflictException("待办已更新，请重新读取后分配。");
    if (plan.assigneeId)
      await DirectoryService.validate(c, s, projectId, plan.assigneeId, proof);
    const name = plan.assigneeId ? proof!.name : "待分配";
    const changed =
      (current.assigneeId ?? null) !== plan.assigneeId ||
      current.assignee !== name;
    let task = current;
    if (changed) {
      await c.query(
        "INSERT INTO cw_task_versions(task_id,workspace_id,version,snapshot,channel) VALUES($1,$2,$3,$4,'legacy_snapshot') ON CONFLICT(task_id,version) DO NOTHING",
        [
          current.id,
          s.workspaceId,
          current.version,
          JSON.stringify({
            title: current.title,
            assignee: current.assignee,
            assigneeId: current.assigneeId ?? null,
            dueDate: current.dueDate,
            status: current.status,
          }),
        ],
      );
      task = (
        await c.query(
          'UPDATE cw_tasks SET assignee_id=$2,assignee=$3,version=version+1 WHERE id=$1 AND workspace_id=$4 RETURNING id,title,assignee,assignee_id AS "assigneeId",to_char(due_date,\'YYYY-MM-DD\') AS "dueDate",status,version',
          [plan.taskId, plan.assigneeId, name, s.workspaceId],
        )
      ).rows[0];
      await recordTaskVersion(c, s, task, runId);
    }
    const receipt = {
      tool: "task.assign",
      ...task,
      changed,
      assigneeId: plan.assigneeId,
      sourceUid: proof?.sourceUid ?? null,
      employeeAssignment: "explicit-identity-not-notification",
      policyVersion: "1.0.0",
    };
    await c.query(
      "INSERT INTO cw_task_assignment_actions(workspace_id,actor_id,idempotency_key,input_hash,task_id,source_run_id,evidence,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        s.workspaceId,
        s.id,
        key,
        hash,
        plan.taskId,
        runId ?? null,
        {
          identityId: proof?.identityId ?? null,
          sourceUid: proof?.sourceUid ?? null,
          bindingHash: proof?.bindingHash ?? null,
        },
        receipt,
      ],
    );
    return receipt;
  }
}
