import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AttachmentEtag, type Subject } from "@hyper/contracts";
import type { Database } from "../db/database.js";
import { sourceConnection } from "./source-connection.js";
import { ReplyDraftService } from "./reply-drafts.js";
import { digest, stableDigest } from "./credentials.js";
import {
  NextcloudTalkProvider,
  SourceRejected,
} from "../providers/nextcloud-talk.js";
import type { CommunicationMessage } from "@hyper/contracts";
import { NextcloudFilesProvider } from "../providers/nextcloud-files.js";
function messageDigest(message: CommunicationMessage) {
  const { author: _displayName, ...stable } = message;
  return stableDigest(stable);
}
function publicReceipt(row: any) {
  return {
    id: row.id,
    state: row.state,
    sourceMessageId: row.source_message_id ?? null,
    error: row.error ?? null,
    acknowledgedAt: row.acknowledged_at ?? null,
  };
}
export class CommunicationService {
  constructor(private db: Database) {}
  private async connection(s: Subject) {
    if (process.env.NEXTCLOUD_TALK_ENABLED !== "true")
      throw new ServiceUnavailableException(
        "企业消息尚未启用，请联系工作区管理员。",
      );
    const source = await sourceConnection(this.db, s);
    return {
      ...source,
      provider: new NextcloudTalkProvider(
        source.config,
        source.credentials,
        source.remoteUid,
      ),
    };
  }
  async rooms(s: Subject) {
    return (await this.connection(s)).provider.listRooms();
  }
  async messages(s: Subject, id: string, before?: string) {
    return (await this.connection(s)).provider.messages(id, before);
  }
  async attachment(
    s: Subject,
    roomId: string,
    messageId: string,
    fileId: string,
    etag: string,
    download = false,
  ) {
    AttachmentEtag.parse(etag);
    const source = await this.connection(s);
    const reference = await source.provider.attachment(
      roomId,
      messageId,
      fileId,
    );
    if (reference.attachment.etag !== etag)
      throw new ConflictException("附件已变化，请刷新消息后重试。");
    let bytes: Buffer | undefined;
    if (download) {
      if (process.env.NEXTCLOUD_FILES_ENABLED !== "true")
        throw new ServiceUnavailableException(
          "附件下载需要启用企业文件服务；可在来源中查看。",
        );
      if (!reference.path || !reference.attachment.downloadable)
        throw new ForbiddenException(
          "此附件不允许在产品内下载，请在来源中查看。",
        );
      const files = new NextcloudFilesProvider(
        source.config,
        source.credentials,
        source.remoteUid,
      );
      const file = await files.stat(reference.path);
      // Talk exposes the raw node etag; DAV wraps it in quotes. File IDs must also agree.
      const nodeEtag = (value: string) =>
        value.startsWith('"') && value.endsWith('"')
          ? value.slice(1, -1)
          : value;
      if (
        file.kind !== "file" ||
        file.id !== fileId ||
        nodeEtag(file.etag) !== nodeEtag(etag) ||
        file.size !== reference.attachment.size
      )
        throw new ConflictException(
          "附件引用与当前文件不符，请刷新消息后重试。",
        );
      bytes = await files.download(file);
      const after = await files.stat(reference.path);
      if (
        after.id !== file.id ||
        after.etag !== file.etag ||
        after.size !== file.size ||
        after.kind !== "file"
      )
        throw new ConflictException("下载期间附件已变化，未返回旧内容。");
      await files.assertReadable(after);
    }
    // Discard buffered bytes if the room/share/message, download policy or employee binding changed.
    const current = await source.provider.attachment(roomId, messageId, fileId);
    if (
      current.attachment.etag !== etag ||
      (download && !current.attachment.downloadable)
    )
      throw new ConflictException("附件或权限已变化，请刷新消息后重试。");
    const fresh = await this.connection(s);
    if (
      stableDigest({
        config: fresh.config,
        credentials: fresh.credentials,
        uid: fresh.remoteUid,
      }) !==
        stableDigest({
          config: source.config,
          credentials: source.credentials,
          uid: source.remoteUid,
        }) ||
      (download && process.env.NEXTCLOUD_FILES_ENABLED !== "true")
    )
      throw new ConflictException("企业连接已变化，请重新打开附件。");
    return {
      attachment: current.attachment,
      bytes,
      url: source.config.publicUrl + "/index.php/f/" + fileId,
    };
  }
  async send(
    s: Subject,
    roomId: string,
    content: string,
    key: string,
    draftId?: string,
  ) {
    const source = await this.connection(s);
    const room = await source.provider.room(roomId);
    if (room.readOnly) throw new ForbiddenException("此企业会话当前只读。");
    const draft = draftId
      ? await new ReplyDraftService(this.db).get(s, draftId)
      : undefined;
    if (draft && draft.roomId !== roomId)
      throw new ForbiddenException("回复草稿不能发送到其他会话。");
    const hash = stableDigest({
        providerKey: source.config.providerKey,
        roomId,
        content,
        ...(draftId ? { draftId } : {}),
      }),
      id = randomUUID();
    const inserted = await this.db.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        s.workspaceId + s.id + source.config.providerKey + roomId,
      ]);
      const existing = await c.query(
        "SELECT id FROM cw_communication_sends WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, key],
      );
      if (existing.rowCount) return { rowCount: 0, rows: [] };
      if (
        draftId &&
        (
          await c.query(
            "SELECT id FROM cw_communication_sends WHERE draft_id=$1 AND state IN ('sending','succeeded','recovery_required') LIMIT 1",
            [draftId],
          )
        ).rowCount
      )
        throw new ConflictException(
          "这份草稿已有发送记录，请核对原回执，不要重复发送。",
        );
      const unfinished = (
        await c.query(
          "SELECT id FROM cw_communication_sends WHERE workspace_id=$1 AND actor_id=$2 AND provider_key=$3 AND conversation_ref=$4 AND state IN ('sending','recovery_required') AND acknowledged_at IS NULL LIMIT 1",
          [s.workspaceId, s.id, source.config.providerKey, roomId],
        )
      ).rows[0];
      if (unfinished)
        throw new ConflictException(
          "此会话有一条发送结果待核对，请先处理该回执。",
        );
      return c.query(
        "INSERT INTO cw_communication_sends(id,workspace_id,actor_id,identity_credential_id,provider_key,conversation_ref,idempotency_key,params_hash,reference_id,state,draft_id,draft_modified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'sending',$10,$11) ON CONFLICT(workspace_id,actor_id,idempotency_key) DO NOTHING RETURNING *",
        [
          id,
          s.workspaceId,
          s.id,
          s.identityCredentialId,
          source.config.providerKey,
          roomId,
          key,
          hash,
          digest(randomUUID()),
          draftId ?? null,
          draft ? draft.content !== content : null,
        ],
      );
    });
    if (!inserted.rowCount) {
      const old = (
        await this.db.pool.query(
          "SELECT * FROM cw_communication_sends WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, key],
        )
      ).rows[0];
      if (old.params_hash !== hash)
        throw new ConflictException("相同发送键不能用于不同消息或会话。");
      return this.receipt(s, old.id);
    }
    const row = inserted.rows[0];
    let acknowledged = false;
    try {
      const sent = await source.provider.send(
        roomId,
        content,
        row.reference_id,
      );
      acknowledged = true;
      await this.db.pool.query(
        "UPDATE cw_communication_sends SET source_message_id=$2,source_content_hash=$3,updated_at=now() WHERE id=$1 AND state='sending'",
        [id, sent.id, messageDigest(sent)],
      );
      const fresh = await this.connection(s);
      const observed = await fresh.provider.find(roomId, sent.id);
      if (!observed || messageDigest(observed) !== messageDigest(sent))
        throw new Error("Readback mismatch");
      await this.db.pool.query(
        "UPDATE cw_communication_sends SET state='succeeded',updated_at=now() WHERE id=$1 AND state='sending'",
        [id],
      );
    } catch (error) {
      const rejected = !acknowledged && error instanceof SourceRejected;
      await this.db.pool.query(
        "UPDATE cw_communication_sends SET state=$2,error=$3,updated_at=now() WHERE id=$1 AND state='sending'",
        [
          id,
          rejected ? "failed" : "recovery_required",
          rejected ? "source_rejected" : "delivery_unknown",
        ],
      );
    }
    return this.receipt(s, id);
  }
  private async owned(s: Subject, id: string) {
    const row = (
      await this.db.pool.query(
        "SELECT * FROM cw_communication_sends WHERE id=$1 AND workspace_id=$2 AND actor_id=$3",
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("发送回执不存在。");
    return row;
  }
  async receipt(s: Subject, id: string) {
    const source = await this.connection(s),
      row = await this.owned(s, id);
    if (source.config.providerKey !== row.provider_key)
      throw new ForbiddenException("发送来源已更改。");
    await source.provider.room(row.conversation_ref);
    await this.db.pool.query(
      "UPDATE cw_communication_sends SET state='recovery_required',error='delivery_unknown',updated_at=now() WHERE id=$1 AND state='sending' AND updated_at<now()-interval '45 seconds'",
      [id],
    );
    return publicReceipt(await this.owned(s, id));
  }
  async reconcile(s: Subject, id: string) {
    const source = await this.connection(s),
      row = await this.owned(s, id);
    if (source.config.providerKey !== row.provider_key)
      throw new ForbiddenException("发送来源已更改。");
    await source.provider.room(row.conversation_ref);
    if (row.state !== "recovery_required") return this.receipt(s, id);
    let observed: CommunicationMessage | undefined;
    if (row.source_message_id)
      observed = await source.provider.find(
        row.conversation_ref,
        row.source_message_id,
      );
    else
      observed = (
        await source.provider.messages(row.conversation_ref)
      ).messages.find(
        (m) =>
          m.referenceId === row.reference_id &&
          m.authorId === "users:" + source.remoteUid,
      );
    if (
      observed &&
      observed.referenceId === row.reference_id &&
      observed.authorId === "users:" + source.remoteUid &&
      (!row.source_content_hash ||
        messageDigest(observed) === row.source_content_hash)
    )
      await this.db.pool.query(
        "UPDATE cw_communication_sends SET state='succeeded',source_message_id=$2,source_content_hash=$3,error=NULL,updated_at=now() WHERE id=$1 AND state='recovery_required'",
        [id, observed.id, messageDigest(observed)],
      );
    // Absence from a bounded source read never proves that a send did not happen. Never resend.
    return this.receipt(s, id);
  }
  async pending(s: Subject, roomId: string) {
    const source = await this.connection(s);
    await source.provider.room(roomId);
    await this.db.pool.query(
      "UPDATE cw_communication_sends SET state='recovery_required',error='delivery_unknown',updated_at=now() WHERE workspace_id=$1 AND actor_id=$2 AND provider_key=$3 AND conversation_ref=$4 AND state='sending' AND updated_at<now()-interval '45 seconds'",
      [s.workspaceId, s.id, source.config.providerKey, roomId],
    );
    return (
      await this.db.pool.query(
        "SELECT * FROM cw_communication_sends WHERE workspace_id=$1 AND actor_id=$2 AND provider_key=$3 AND conversation_ref=$4 AND state IN ('sending','recovery_required') AND acknowledged_at IS NULL ORDER BY created_at LIMIT 20",
        [s.workspaceId, s.id, source.config.providerKey, roomId],
      )
    ).rows.map(publicReceipt);
  }
  async acknowledge(s: Subject, id: string) {
    const receipt = await this.receipt(s, id);
    if (receipt.state !== "recovery_required")
      throw new ConflictException(
        "此发送尚在处理或已有明确结果，无需人工继续。",
      );
    await this.db.pool.query(
      "UPDATE cw_communication_sends SET acknowledged_at=now(),updated_at=now() WHERE id=$1 AND state='recovery_required'",
      [id],
    );
    return this.receipt(s, id);
  }
}
