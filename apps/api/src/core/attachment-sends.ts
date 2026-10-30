import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  AttachmentSendPlan,
  MAX_ATTACHMENT_BYTES,
  type AttachmentSendReceipt,
  type Subject,
} from "@hyper/contracts";
import type { Database } from "../db/database.js";
import type { PoolClient } from "pg";
import { sourceConnection } from "./source-connection.js";
import { NextcloudTalkProvider } from "../providers/nextcloud-talk.js";
import { NextcloudFilesProvider } from "../providers/nextcloud-files.js";
import { NextcloudRoomShareProvider } from "../providers/nextcloud-shares.js";
import { ProjectAccess } from "./project-access.js";
import { assertMember } from "./security.js";
import { digest, stableDigest } from "./credentials.js";
import { ExecutionPolicyService } from "./execution-policy.js";
type RunDispatch = {
  row: any;
  lease: string;
  contextBytes?: number;
  actionCount?: number;
};
function receipt(row: any): AttachmentSendReceipt {
  return {
    kind: "attachment",
    id: row.id,
    state: row.state,
    roomId: row.conversation_ref,
    fileId: row.plan.expectedFileId,
    name: row.file_name,
    sourceShareId: row.source_share_id ?? null,
    sourceMessageId: row.source_message_id ?? null,
    sourceRunId: row.source_run_id ?? null,
    error: row.error ?? null,
    acknowledgedAt: row.acknowledged_at ?? null,
    requestedPermissions: 1,
  };
}
export class AttachmentSendService {
  constructor(readonly db: Database) {}
  private async connection(s: Subject, write = false) {
    if (
      process.env.NEXTCLOUD_TALK_ENABLED !== "true" ||
      (write && process.env.NEXTCLOUD_FILES_ENABLED !== "true")
    )
      throw new ServiceUnavailableException(
        "附件发送需要启用企业消息和企业文件。",
      );
    const source = await sourceConnection(this.db, s);
    return {
      ...source,
      talk: new NextcloudTalkProvider(
        source.config,
        source.credentials,
        source.remoteUid,
      ),
      files: new NextcloudFilesProvider(
        source.config,
        source.credentials,
        source.remoteUid,
      ),
    };
  }
  async prepare(s: Subject, raw: AttachmentSendPlan, projectId?: string) {
    const plan = AttachmentSendPlan.parse(raw),
      source = await this.connection(s, true);
    if (projectId) {
      const access = new ProjectAccess(this.db);
      await access.assert(s, projectId);
      const binding = await access.binding(s, projectId);
      if (
        binding?.provider_key !== source.config.providerKey ||
        binding.conversation_ref !== plan.roomId
      )
        throw new ForbiddenException("附件目标必须是当前项目关联的确切会话。");
    }
    const room = await source.talk.room(plan.roomId);
    if (room.readOnly)
      throw new ForbiddenException("此会话只读，不能发送附件。");
    const file = await source.files.stat(plan.path);
    if (
      file.kind !== "file" ||
      file.id !== plan.expectedFileId ||
      file.etag !== plan.expectedEtag
    )
      throw new ConflictException("所选文件或版本已变化，请重新选择。");
    if (file.size > MAX_ATTACHMENT_BYTES)
      throw new BadRequestException("首版附件发送支持 8 MiB 内文件。");
    await source.files.assertReadable(file);
    return { plan, source, room, file };
  }
  private async guard(
    c: PoolClient,
    s: Subject,
    plan: AttachmentSendPlan,
    sourceIdentity: { providerKey: string; remoteUid: string },
    run?: RunDispatch,
  ) {
    if (run) {
      await ExecutionPolicyService.lock(c, s.workspaceId);
      const current = (
        await c.query(
          "SELECT * FROM cw_runs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 FOR UPDATE",
          [run.row.id, s.workspaceId, s.id],
        )
      ).rows[0];
      if (
        !current ||
        current.state !== "running" ||
        current.lease_owner !== run.lease ||
        current.workflow !== "share_attachment" ||
        stableDigest(AttachmentSendPlan.parse(current.attachment_plan)) !==
          stableDigest(plan)
      )
        throw new ConflictException("附件执行已停止或目标已变化。");
      await new ExecutionPolicyService(this.db).check(
        c,
        s,
        current,
        run.contextBytes,
        run.actionCount,
      );
      const binding = (
        await c.query(
          "SELECT x.provider_key,x.conversation_ref FROM cw_conversations v JOIN cw_project_sources x ON x.project_id=v.project_id AND x.workspace_id=v.workspace_id WHERE v.id=$1 AND v.workspace_id=$2 FOR SHARE OF x",
          [current.conversation_id, s.workspaceId],
        )
      ).rows[0];
      if (
        binding?.provider_key !== sourceIdentity.providerKey ||
        binding.conversation_ref !== plan.roomId
      )
        throw new ForbiddenException("附件项目来源已变化，未投递。");
    }
    if (
      !(
        await c.query(
          "SELECT user_id FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
          [s.workspaceId, s.id],
        )
      ).rowCount
    )
      throw new ForbiddenException("工作区权限已撤销。");
    if (
      !(
        await c.query(
          "SELECT c.id FROM cw_identity_credentials c JOIN cw_external_identities i ON i.id=c.identity_id WHERE c.id=$1 AND i.user_id=$2 AND i.workspace_id=$3 AND i.provider_key=$4 AND i.remote_uid=$5 AND c.disabled_at IS NULL FOR SHARE OF c,i",
          [
            s.identityCredentialId,
            s.id,
            s.workspaceId,
            sourceIdentity.providerKey,
            sourceIdentity.remoteUid,
          ],
        )
      ).rowCount
    )
      throw new ForbiddenException("来源身份已失效。");
  }
  private async owned(s: Subject, id: string) {
    const row = (
      await this.db.pool.query(
        "SELECT * FROM cw_attachment_sends WHERE id=$1 AND workspace_id=$2 AND actor_id=$3",
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("附件发送回执不存在。");
    return row;
  }
  private async authorized(s: Subject, id: string) {
    const source = await this.connection(s),
      row = await this.owned(s, id);
    if (
      source.config.providerKey !== row.provider_key ||
      source.remoteUid !== row.source_actor_id
    )
      throw new ForbiddenException("附件发送来源身份已变化。");
    await source.talk.room(row.conversation_ref);
    return { source, row };
  }
  async get(s: Subject, id: string) {
    await this.authorized(s, id);
    await this.expire(id);
    return receipt(await this.owned(s, id));
  }
  private async expire(id: string) {
    await this.db.pool.query(
      "UPDATE cw_attachment_sends SET state='recovery_required',error='delivery_unknown',updated_at=now() WHERE id=$1 AND state='sending' AND updated_at<now()-interval '45 seconds'",
      [id],
    );
  }
  async pending(s: Subject, roomId: string) {
    const source = await this.connection(s);
    await source.talk.room(roomId);
    await this.db.pool.query(
      "UPDATE cw_attachment_sends SET state='recovery_required',error='delivery_unknown',updated_at=now() WHERE workspace_id=$1 AND actor_id=$2 AND provider_key=$3 AND conversation_ref=$4 AND state='sending' AND updated_at<now()-interval '45 seconds'",
      [s.workspaceId, s.id, source.config.providerKey, roomId],
    );
    const rows = await this.db.pool.query(
      "SELECT * FROM cw_attachment_sends WHERE workspace_id=$1 AND actor_id=$2 AND provider_key=$3 AND source_actor_id=$4 AND conversation_ref=$5 AND state IN ('sending','recovery_required') AND acknowledged_at IS NULL ORDER BY created_at LIMIT 20",
      [
        s.workspaceId,
        s.id,
        source.config.providerKey,
        source.remoteUid,
        roomId,
      ],
    );
    return rows.rows.map(receipt);
  }
  async activity(s: Subject, roomId: string) {
    const sends = await this.pending(s, roomId);
    const runs = (
      await this.db.pool.query(
        "SELECT r.id,r.state,r.error,r.created_at AS \"createdAt\",a.state AS \"deliveryState\" FROM cw_runs r LEFT JOIN cw_attachment_sends a ON a.source_run_id=r.id WHERE r.workspace_id=$1 AND r.actor_id=$2 AND r.workflow='share_attachment' AND r.attachment_plan->>'roomId'=$3 ORDER BY r.created_at DESC LIMIT 20",
        [s.workspaceId, s.id, roomId],
      )
    ).rows;
    const source = await this.connection(s);
    await source.talk.room(roomId);
    const history = (
      await this.db.pool.query(
        "SELECT * FROM cw_attachment_sends WHERE workspace_id=$1 AND actor_id=$2 AND provider_key=$3 AND source_actor_id=$4 AND conversation_ref=$5 ORDER BY created_at DESC LIMIT 20",
        [
          s.workspaceId,
          s.id,
          source.config.providerKey,
          source.remoteUid,
          roomId,
        ],
      )
    ).rows.map(receipt);
    return { sends, runs, history };
  }
  private async observe(s: Subject, id: string) {
    const { source, row } = await this.authorized(s, id);
    const candidates = row.source_message_id
      ? [await source.talk.find(row.conversation_ref, row.source_message_id)]
      : (await source.talk.messages(row.conversation_ref)).messages;
    const found = candidates.find(
      (m) =>
        m &&
        m.referenceId === row.reference_id &&
        m.authorId === "users:" + row.source_actor_id &&
        m.attachments?.some((f) => f.id === row.plan.expectedFileId),
    );
    if (found) {
      await assertMember(this.db, s);
      await source.talk.room(row.conversation_ref);
      await this.db.pool.query(
        "UPDATE cw_attachment_sends SET state='succeeded',source_message_id=$2,error=NULL,updated_at=now() WHERE id=$1 AND state IN ('sending','recovery_required')",
        [id, found.id],
      );
    }
    return !!found;
  }
  async reconcile(s: Subject, id: string) {
    await this.get(s, id);
    const { row } = await this.authorized(s, id);
    if (row.state === "recovery_required") await this.observe(s, id);
    return this.get(s, id);
  }
  async acknowledge(s: Subject, id: string) {
    const old = await this.get(s, id);
    if (old.state !== "recovery_required")
      throw new ConflictException("此附件尚在发送或已有明确结果。");
    await this.db.pool.query(
      "UPDATE cw_attachment_sends SET acknowledged_at=now(),updated_at=now() WHERE id=$1 AND state='recovery_required'",
      [id],
    );
    return this.get(s, id);
  }
  async send(
    s: Subject,
    raw: AttachmentSendPlan,
    key: string,
    run?: RunDispatch,
  ) {
    const plan = AttachmentSendPlan.parse(raw),
      source = await this.connection(s, true);
    const hash = stableDigest({ provider: source.config.providerKey, plan });
    const prior = (
      await this.db.pool.query(
        "SELECT id,params_hash FROM cw_attachment_sends WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.params_hash !== hash)
        throw new ConflictException("附件发送幂等键冲突。");
      return this.get(s, prior.id);
    }
    const projectId = run
      ? (
          await this.db.pool.query(
            "SELECT project_id FROM cw_conversations WHERE id=$1 AND workspace_id=$2",
            [run.row.conversation_id, s.workspaceId],
          )
        ).rows[0]?.project_id
      : undefined;
    if (run && !projectId) throw new ForbiddenException("附件执行项目不可用。");
    const prepared = await this.prepare(s, plan, projectId);
    if (
      prepared.source.config.providerKey !== source.config.providerKey ||
      prepared.source.remoteUid !== source.remoteUid
    )
      throw new ConflictException("附件来源身份已变化。");
    const row = await this.db.tx(async (c) => {
      await this.guard(
        c,
        s,
        plan,
        { providerKey: source.config.providerKey, remoteUid: source.remoteUid },
        run,
      );
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "attachment-key:" + s.workspaceId + ":" + s.id + ":" + key,
      ]);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "attachment:" +
          s.workspaceId +
          s.id +
          source.config.providerKey +
          plan.roomId,
      ]);
      const old = (
        await c.query(
          "SELECT * FROM cw_attachment_sends WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, key],
        )
      ).rows[0];
      if (old) {
        if (old.params_hash !== hash)
          throw new ConflictException("附件发送幂等键冲突。");
        return { row: old, created: false };
      }
      if (
        (
          await c.query(
            "SELECT id FROM cw_attachment_sends WHERE workspace_id=$1 AND actor_id=$2 AND provider_key=$3 AND conversation_ref=$4 AND state IN ('sending','recovery_required') AND acknowledged_at IS NULL LIMIT 1",
            [s.workspaceId, s.id, source.config.providerKey, plan.roomId],
          )
        ).rowCount
      )
        throw new ConflictException("此会话有附件发送结果待核对。");
      const inserted = (
        await c.query(
          "INSERT INTO cw_attachment_sends(id,workspace_id,actor_id,identity_credential_id,provider_key,source_actor_id,conversation_ref,idempotency_key,params_hash,plan,file_name,reference_id,state,source_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'sending',$13) RETURNING *",
          [
            randomUUID(),
            s.workspaceId,
            s.id,
            s.identityCredentialId,
            source.config.providerKey,
            source.remoteUid,
            plan.roomId,
            key,
            hash,
            plan,
            prepared.file.name,
            digest(randomUUID()),
            run?.row.id ?? null,
          ],
        )
      ).rows[0];
      return { row: inserted, created: true };
    });
    if (!row.created) return this.get(s, row.row.id);
    const id = row.row.id;
    let attempted = false;
    try {
      // Revalidate source/file and Run immediately before dispatch. No network call holds a DB transaction.
      const current = await this.prepare(s, plan, projectId);
      if (
        stableDigest({
          config: current.source.config,
          credentials: current.source.credentials,
          uid: current.source.remoteUid,
        }) !==
        stableDigest({
          config: prepared.source.config,
          credentials: prepared.source.credentials,
          uid: prepared.source.remoteUid,
        })
      )
        throw new ConflictException("附件来源连接已变化。");
      await this.db.tx(async (c) => {
        await this.guard(
          c,
          s,
          plan,
          {
            providerKey: current.source.config.providerKey,
            remoteUid: current.source.remoteUid,
          },
          run,
        );
        const updated = await c.query(
          "UPDATE cw_attachment_sends SET attempted_at=now(),updated_at=now() WHERE id=$1 AND state='sending'",
          [id],
        );
        if (!updated.rowCount)
          throw new ConflictException("附件发送已进入待核对，未再次投递。");
      });
      attempted = true;
      try {
        const shareId = await new NextcloudRoomShareProvider(
          current.source.config,
          current.source.credentials,
        ).share(plan, row.row.reference_id);
        await this.db.pool.query(
          "UPDATE cw_attachment_sends SET source_share_id=$2,updated_at=now() WHERE id=$1",
          [id, shareId],
        );
      } catch {
        /* A 4xx can follow delivery: always reconcile the unique reference, never repost. */
      }
      if (!(await this.observe(s, id)))
        await this.db.pool.query(
          "UPDATE cw_attachment_sends SET state='recovery_required',error='delivery_unknown',updated_at=now() WHERE id=$1 AND state='sending'",
          [id],
        );
    } catch {
      await this.db.pool.query(
        "UPDATE cw_attachment_sends SET state=$2,error=$3,updated_at=now() WHERE id=$1 AND state='sending'",
        [
          id,
          attempted ? "recovery_required" : "failed",
          attempted ? "delivery_unknown" : "pre_dispatch_rejected",
        ],
      );
    }
    return this.get(s, id);
  }
}
