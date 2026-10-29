import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { EngineId, FollowUpPlan, Subject } from "@hyper/contracts";
import {
  FollowUpPlan as PlanSchema,
  FollowUpConfiguration,
} from "@hyper/contracts";
import type { WorkspaceService } from "./workspace.js";
import { appendEvent } from "./workspace.js";
import { assertMember } from "./security.js";
import { stableDigest } from "./credentials.js";

function summary(row: any) {
  return {
    id: row.id,
    state: row.state,
    version: row.version,
    engine: row.engine,
    modelProfileId: row.model_profile_id,
    intervalMinutes: row.interval_minutes,
    maxChecks: row.max_checks,
    checksStarted: row.checks_started,
    nextCheckAt: row.next_check_at,
    expiresAt: row.expires_at,
    lastRunId: row.last_run_id,
    lastError: row.last_error,
  };
}
export interface PreparedFollowUp {
  plan: FollowUpPlan;
  projectId: string;
  conversationId: string;
  engine: EngineId;
  modelProfileId?: string;
}
/** Never trust a queued schedule after pause/cancel, device changes or expiry. */
export async function assertScheduledRun(
  c: Pick<PoolClient, "query">,
  run: any,
  lock = false,
) {
  if (!run.follow_up_schedule_id) return;
  const row = await c.query(
    `SELECT id FROM cw_follow_up_schedules
    WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND conversation_id=$4
    AND version=$5 AND last_run_id=$6 AND state IN ('active','completed') AND expires_at>clock_timestamp()
    AND identity_credential_id IS NOT DISTINCT FROM $7::uuid
    AND (source_run_id IS NULL OR EXISTS(SELECT 1 FROM cw_runs r WHERE r.id=source_run_id AND r.state='succeeded')) ${lock ? "FOR SHARE" : ""}`,
    [
      run.follow_up_schedule_id,
      run.workspace_id,
      run.actor_id,
      run.conversation_id,
      run.follow_up_schedule_version,
      run.id,
      run.identity_credential_id,
    ],
  );
  if (!row.rowCount)
    throw new Error("定时跟进已暂停、取消、过期或授权已变化。");
}

export class FollowUpScheduleService {
  constructor(readonly service: WorkspaceService) {}
  private get db() {
    return this.service.db;
  }
  async owned(s: Subject, id: string, conversationId?: string) {
    await assertMember(this.db, s);
    const row = (
      await this.db.pool.query(
        `SELECT * FROM cw_follow_up_schedules
      WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND ($4::uuid IS NULL OR conversation_id=$4)`,
        [id, s.workspaceId, s.id, conversationId ?? null],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("跟进不存在或无权操作。");
    return row;
  }
  async list(s: Subject, conversationId: string) {
    await this.service.conversation(s, conversationId);
    const rows = await this.db.pool.query(
      `SELECT * FROM cw_follow_up_schedules
      WHERE workspace_id=$1 AND actor_id=$2 AND conversation_id=$3 ORDER BY created_at DESC LIMIT 20`,
      [s.workspaceId, s.id, conversationId],
    );
    await this.service.conversation(s, conversationId);
    return rows.rows.map(summary);
  }
  async prepare(
    s: Subject,
    conversationId: string,
    plan: FollowUpPlan,
    engine: EngineId,
    modelProfileId?: string,
  ): Promise<PreparedFollowUp> {
    plan = PlanSchema.parse(plan);
    if (plan.operation === "create") {
      const conversation = await this.service.conversation(s, conversationId);
      const model = await this.service.runModel(s, engine, modelProfileId);
      if (
        !this.service.engines
          .get(engine)
          ?.describeCapabilities()
          .operations.includes("follow_up")
      )
        throw new BadRequestException("所选执行器不支持待办检查。");
      return {
        plan,
        conversationId,
        projectId: conversation.project_id,
        engine,
        modelProfileId: model?.id,
      };
    }
    const row = await this.owned(s, plan.scheduleId, conversationId);
    if (row.version !== plan.expectedVersion)
      throw new ConflictException("跟进配置已变化，请刷新后操作。");
    if (plan.operation === "resume") {
      await this.service.conversation(s, conversationId);
      await this.service.runModel(
        s,
        row.engine,
        row.model_profile_id ?? undefined,
      );
      if (
        !this.service.engines
          .get(row.engine)
          ?.describeCapabilities()
          .operations.includes("follow_up")
      )
        throw new BadRequestException("跟进执行器尚未配置待办检查能力。");
    }
    return {
      plan,
      conversationId,
      projectId: row.project_id,
      engine: row.engine,
      modelProfileId: row.model_profile_id ?? undefined,
    };
  }
  async configure(
    s: Subject,
    conversationId: string,
    input: {
      plan: FollowUpPlan;
      engine: EngineId;
      modelProfileId?: string;
      idempotencyKey: string;
    },
  ) {
    input = FollowUpConfiguration.parse(input);
    await assertMember(this.db, s);
    if (input.plan.operation === "create" || input.plan.operation === "resume")
      await this.service.conversation(s, conversationId);
    const hash = stableDigest({
      ...input,
      conversationId,
      idempotencyKey: undefined,
    });
    const prior = (
      await this.db.pool.query(
        `SELECT input_hash,result FROM cw_follow_up_configuration_receipts
      WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3`,
        [s.workspaceId, s.id, input.idempotencyKey],
      )
    ).rows[0];
    if (prior) {
      if (prior.input_hash !== hash)
        throw new ConflictException("相同幂等键不能用于不同跟进配置。");
      return prior.result;
    }
    const prepared = await this.prepare(
      s,
      conversationId,
      input.plan,
      input.engine,
      input.modelProfileId,
    );
    return this.db.tx((c) =>
      FollowUpScheduleService.apply(c, s, prepared, input.idempotencyKey, hash),
    );
  }
  static async apply(
    c: PoolClient,
    s: Subject,
    p: PreparedFollowUp,
    key: string,
    hash: string,
    sourceRunId?: string,
  ) {
    // Serialize configuration retries without keeping locks across source/model IO.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      s.workspaceId + ":" + s.id + ":" + key,
    ]);
    const prior = (
      await c.query(
        `SELECT input_hash,result FROM cw_follow_up_configuration_receipts
      WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3`,
        [s.workspaceId, s.id, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.input_hash !== hash)
        throw new ConflictException("相同幂等键不能用于不同跟进配置。");
      return prior.result;
    }
    let row = await this.lockTarget(c, s, p);
    const member = await c.query(
      "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
      [s.workspaceId, s.id],
    );
    if (!member.rowCount) throw new NotFoundException("工作区权限已撤销。");
    if (p.plan.operation === "create") {
      await c.query(
        "SELECT id FROM cw_projects WHERE id=$1 AND workspace_id=$2 FOR NO KEY UPDATE",
        [p.projectId, s.workspaceId],
      );
      if (
        (
          await c.query(
            "SELECT id FROM cw_follow_up_schedules WHERE workspace_id=$1 AND actor_id=$2 AND project_id=$3 AND state IN ('active','paused')",
            [s.workspaceId, s.id, p.projectId],
          )
        ).rowCount
      )
        throw new ConflictException(
          "你在此项目已有活动或暂停的跟进，请先管理或取消它。",
        );
      row = (
        await c.query(
          `INSERT INTO cw_follow_up_schedules(id,workspace_id,project_id,conversation_id,actor_id,
        identity_credential_id,demo,engine,model_profile_id,interval_minutes,max_checks,next_check_at,idempotency_key,input_hash,source_run_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp(),$12,$13,$14) RETURNING *`,
          [
            randomUUID(),
            s.workspaceId,
            p.projectId,
            p.conversationId,
            s.id,
            s.identityCredentialId,
            s.demo,
            p.engine,
            p.modelProfileId,
            p.plan.intervalMinutes,
            p.plan.maxChecks,
            key,
            hash,
            sourceRunId,
          ],
        )
      ).rows[0];
    } else {
      if (row.version !== p.plan.expectedVersion)
        throw new ConflictException("跟进配置已变化，请刷新后操作。");
      const operation = p.plan.operation;
      if (operation === "pause" && row.state !== "active")
        throw new ConflictException("只有运行中的跟进可以暂停。");
      if (
        operation === "resume" &&
        (row.state !== "paused" ||
          row.checks_started >= row.max_checks ||
          new Date(row.expires_at).getTime() <= Date.now())
      )
        throw new ConflictException(
          "此跟进不能恢复，请核对状态、次数或到期时间。",
        );
      const state =
        operation === "resume"
          ? "active"
          : operation === "pause"
            ? "paused"
            : "cancelled";
      row = (
        await c.query(
          `UPDATE cw_follow_up_schedules SET state=$2,version=version+1,
        next_check_at=CASE WHEN $2='active' THEN clock_timestamp() ELSE NULL END,
        identity_credential_id=CASE WHEN $2='active' THEN $3::uuid ELSE identity_credential_id END,
        source_run_id=CASE WHEN $2='active' THEN $4::uuid ELSE source_run_id END,
        lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
          [row.id, state, s.identityCredentialId ?? null, sourceRunId ?? null],
        )
      ).rows[0];
      const stopped = await c.query(
        `UPDATE cw_runs SET state='cancelled',lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE follow_up_schedule_id=$1 AND state IN ('queued','running','waiting_input','waiting_confirmation') RETURNING id`,
        [row.id],
      );
      for (const run of stopped.rows)
        await appendEvent(c, run.id, "run.cancelled", {
          message: "跟进配置已变化，已停止后续执行；已完成操作保留。",
        });
    }
    const result = { tool: "follow_up.configure", ...summary(row) };
    await c.query(
      `INSERT INTO cw_follow_up_configuration_receipts(workspace_id,actor_id,idempotency_key,input_hash,result)
      VALUES($1,$2,$3,$4,$5)`,
      [s.workspaceId, s.id, key, hash, result],
    );
    return result;
  }
  static async lockTarget(
    c: PoolClient,
    s: Subject,
    p: PreparedFollowUp,
  ): Promise<any> {
    if (p.plan.operation === "create") return undefined;
    const row = (
      await c.query(
        "SELECT * FROM cw_follow_up_schedules WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND conversation_id=$4 FOR UPDATE",
        [p.plan.scheduleId, s.workspaceId, s.id, p.conversationId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("跟进不存在或无权操作。");
    return row;
  }

  async dispatchDue(): Promise<string[]> {
    // A failed or uncertain previous Run requires a person to resume; do not spend repeatedly.
    await this.db.pool
      .query(`UPDATE cw_follow_up_schedules s SET state='paused',version=version+1,next_check_at=NULL,
      lease_owner=NULL,lease_expires_at=NULL,last_error='上次检查或配置未完成，请核对最近执行后恢复。',updated_at=clock_timestamp()
      WHERE state='active' AND (
        EXISTS(SELECT 1 FROM cw_runs r WHERE r.id=s.last_run_id AND r.follow_up_schedule_version=s.version AND r.state IN ('failed','cancelled','recovery_required'))
        OR EXISTS(SELECT 1 FROM cw_runs r WHERE r.id=s.source_run_id AND r.state IN ('failed','cancelled','recovery_required')))`);
    await this.db.pool
      .query(`UPDATE cw_follow_up_schedules SET state='completed',next_check_at=NULL,lease_owner=NULL,lease_expires_at=NULL
      WHERE state='active' AND (expires_at<=clock_timestamp() OR checks_started>=max_checks)`);
    const lease = randomUUID();
    const claimed = await this.db.tx((c) =>
      c.query(
        `UPDATE cw_follow_up_schedules SET lease_owner=$1,lease_expires_at=clock_timestamp()+interval '90 seconds'
      WHERE id IN (SELECT s.id FROM cw_follow_up_schedules s WHERE state='active' AND next_check_at<=clock_timestamp()
        AND (lease_expires_at IS NULL OR lease_expires_at<clock_timestamp())
        AND (source_run_id IS NULL OR EXISTS(SELECT 1 FROM cw_runs r WHERE r.id=s.source_run_id AND r.state='succeeded'))
        AND NOT EXISTS(SELECT 1 FROM cw_runs r WHERE r.id=s.last_run_id AND r.follow_up_schedule_version=s.version AND r.state<>'succeeded')
        ORDER BY next_check_at,id LIMIT 4 FOR UPDATE SKIP LOCKED) RETURNING *`,
        [lease],
      ),
    );
    const runs: string[] = [];
    await Promise.all(
      claimed.rows.map(async (schedule) => {
        try {
          const actor = (
            await this.db.pool.query(
              "SELECT u.id,u.name,m.role FROM cw_users u JOIN cw_members m ON m.user_id=u.id WHERE u.id=$1 AND m.workspace_id=$2",
              [schedule.actor_id, schedule.workspace_id],
            )
          ).rows[0];
          if (!actor) throw new Error("Schedule membership revoked");
          const s: Subject = {
            ...actor,
            workspaceId: schedule.workspace_id,
            demo: schedule.demo,
            identityCredentialId: schedule.identity_credential_id ?? undefined,
          };
          await this.service.conversation(s, schedule.conversation_id);
          await this.service.runModel(
            s,
            schedule.engine,
            schedule.model_profile_id ?? undefined,
          );
          if (
            !this.service.engines
              .get(schedule.engine)
              ?.describeCapabilities()
              .operations.includes("follow_up")
          )
            throw new Error("Schedule engine unavailable");
          const run = await this.db.tx(async (c) => {
            const current = (
              await c.query(
                `SELECT * FROM cw_follow_up_schedules WHERE id=$1 AND lease_owner=$2 AND version=$3
            AND state='active' AND lease_expires_at>clock_timestamp() AND expires_at>clock_timestamp() AND checks_started<max_checks FOR UPDATE`,
                [schedule.id, lease, schedule.version],
              )
            ).rows[0];
            if (!current) return null;
            const member = await c.query(
              "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
              [s.workspaceId, s.id],
            );
            if (!member.rowCount)
              throw new Error("Schedule membership revoked");
            const id = randomUUID(),
              slot = current.checks_started + 1;
            await c.query(
              `INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,idempotency_key,input_hash,
            demo,model_profile_id,identity_credential_id,follow_up_schedule_id,follow_up_schedule_version)
            VALUES($1,$2,$3,$4,$5,'follow_up','检查当前项目待办变化；无变化保持静默。',$6,$7,$8,$9,$10,$11,$12)`,
              [
                id,
                s.workspaceId,
                s.id,
                current.conversation_id,
                current.engine,
                "schedule:" + current.id + ":" + slot,
                stableDigest({
                  schedule: current.id,
                  slot,
                  version: current.version,
                }),
                s.demo,
                current.model_profile_id,
                s.identityCredentialId,
                current.id,
                current.version,
              ],
            );
            await c.query(
              `UPDATE cw_follow_up_schedules SET checks_started=$2,last_run_id=$3,
            state=CASE WHEN $2>=max_checks THEN 'completed' ELSE 'active' END,
            next_check_at=CASE WHEN $2>=max_checks THEN NULL ELSE clock_timestamp()+interval_minutes*interval '1 minute' END,
            lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=clock_timestamp() WHERE id=$1`,
              [current.id, slot, id],
            );
            return id;
          });
          if (run) runs.push(run);
        } catch {
          await this.db.pool.query(
            `UPDATE cw_follow_up_schedules SET state='paused',version=version+1,next_check_at=NULL,
          lease_owner=NULL,lease_expires_at=NULL,last_error='无法核验跟进授权、来源或模型，请检查后恢复。',updated_at=clock_timestamp()
          WHERE id=$1 AND lease_owner=$2 AND version=$3 AND state='active'`,
            [schedule.id, lease, schedule.version],
          );
        }
      }),
    );
    return runs;
  }
}
