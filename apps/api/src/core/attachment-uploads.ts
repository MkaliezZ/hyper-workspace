import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import {
  AttachmentUploadInput,
  type AttachmentUploadReceipt,
  type SourceFile,
  type Subject,
} from "@hyper/contracts";
import type { PoolClient } from "pg";
import type { Database } from "../db/database.js";
import { stableDigest } from "./credentials.js";
import { sourceConnection } from "./source-connection.js";
import { assertMember } from "./security.js";
import {
  NextcloudFilesProvider,
  UploadPathConflict,
} from "../providers/nextcloud-files.js";
import { NextcloudTalkProvider } from "../providers/nextcloud-talk.js";
export const uploadDigest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function receipt(
  row: any,
  file: SourceFile | null = null,
): AttachmentUploadReceipt {
  return {
    id: row.id,
    name: row.file_name,
    size: row.byte_size,
    state: row.state,
    error: row.error ?? null,
    acknowledgedAt: row.acknowledged_at ?? null,
    file,
  };
}
/** Upload is private employee input. Sharing is a separate, confirmed manual/AI action. */
export class AttachmentUploadService {
  constructor(readonly db: Database) {}
  private async connection(s: Subject) {
    if (
      process.env.NEXTCLOUD_FILES_ENABLED !== "true" ||
      process.env.NEXTCLOUD_TALK_ENABLED !== "true"
    )
      throw new ServiceUnavailableException(
        "本机附件上传需要企业文件和企业消息。",
      );
    const source = await sourceConnection(this.db, s);
    return {
      ...source,
      files: new NextcloudFilesProvider(
        source.config,
        source.credentials,
        source.remoteUid,
      ),
      talk: new NextcloudTalkProvider(
        source.config,
        source.credentials,
        source.remoteUid,
      ),
    };
  }
  private async guard(
    c: PoolClient,
    s: Subject,
    source: { config: { providerKey: string }; remoteUid: string },
  ) {
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
            source.config.providerKey,
            source.remoteUid,
          ],
        )
      ).rowCount
    )
      throw new ForbiddenException("来源身份已失效。");
  }
  private async owned(s: Subject, id: string) {
    const row = (
      await this.db.pool.query(
        "SELECT * FROM cw_attachment_uploads WHERE id=$1 AND workspace_id=$2 AND actor_id=$3",
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("上传记录不存在。");
    return row;
  }
  private async authorized(s: Subject, id: string) {
    const source = await this.connection(s),
      row = await this.owned(s, id);
    if (
      source.config.providerKey !== row.provider_key ||
      source.remoteUid !== row.source_actor_id
    )
      throw new ForbiddenException("上传来源身份已变化。");
    await source.talk.room(row.conversation_ref);
    return { source, row };
  }
  private async expire(s: Subject) {
    await this.db.pool.query(
      "UPDATE cw_attachment_uploads SET state='recovery_required',error='upload_unknown',updated_at=now() WHERE workspace_id=$1 AND actor_id=$2 AND state='uploading' AND updated_at<now()-interval '45 seconds'",
      [s.workspaceId, s.id],
    );
  }
  async create(s: Subject, raw: AttachmentUploadInput) {
    const input = AttachmentUploadInput.parse(raw),
      source = await this.connection(s);
    const room = await source.talk.room(input.roomId);
    if (room.readOnly)
      throw new ForbiddenException("此会话只读，不能准备附件。");
    const hash = stableDigest({
      provider: source.config.providerKey,
      ...input,
    });
    await this.expire(s);
    const id = await this.db.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "upload:" + s.workspaceId + ":" + s.id,
      ]);
      await this.guard(c, s, source);
      const prior = (
        await c.query(
          "SELECT * FROM cw_attachment_uploads WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.params_hash !== hash)
          throw new ConflictException("同一上传键不能更换文件或目标。");
        return prior.id as string;
      }
      if (
        (
          await c.query(
            "SELECT id FROM cw_attachment_uploads WHERE workspace_id=$1 AND actor_id=$2 AND provider_key=$3 AND conversation_ref=$4 AND state IN ('prepared','uploading','recovery_required') AND acknowledged_at IS NULL",
            [s.workspaceId, s.id, source.config.providerKey, input.roomId],
          )
        ).rowCount
      )
        throw new ConflictException(
          "此会话有未结束的上传，请先核对或放弃未开始的上传。",
        );
      const id = randomUUID(),
        path = [id + "--" + input.name];
      await c.query(
        "INSERT INTO cw_attachment_uploads(id,workspace_id,actor_id,identity_credential_id,provider_key,source_actor_id,conversation_ref,idempotency_key,params_hash,file_name,source_path,byte_size,sha256,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'prepared')",
        [
          id,
          s.workspaceId,
          s.id,
          s.identityCredentialId,
          source.config.providerKey,
          source.remoteUid,
          input.roomId,
          input.idempotencyKey,
          hash,
          input.name,
          JSON.stringify(path),
          input.size,
          input.sha256,
        ],
      );
      return id;
    });
    return this.get(s, id);
  }
  /** Also used before the raw parser: reject unauthorized requests before reading binary bytes. */
  async authorizeContent(s: Subject, id: string) {
    const { row } = await this.authorized(s, id);
    return { size: row.byte_size as number };
  }
  async get(s: Subject, id: string) {
    const { source } = await this.authorized(s, id);
    await this.expire(s);
    const row = await this.owned(s, id);
    let file: SourceFile | null = null;
    if (row.state === "succeeded" && row.source_file) {
      try {
        const current = await source.files.stat(row.source_path);
        if (
          current.kind === "file" &&
          current.id === row.source_file.id &&
          current.etag === row.source_file.etag &&
          current.size === row.byte_size
        ) {
          await source.files.assertReadable(current);
          file = current;
        }
      } catch {
        /* Upload fact remains; changed/deleted source cannot be selected for sharing. */
      }
    }
    await assertMember(this.db, s);
    await source.talk.room(row.conversation_ref);
    return receipt(row, file);
  }
  async list(s: Subject, roomId: string) {
    const source = await this.connection(s);
    await source.talk.room(roomId);
    await this.expire(s);
    const rows = (
      await this.db.pool.query(
        "SELECT * FROM cw_attachment_uploads WHERE workspace_id=$1 AND actor_id=$2 AND provider_key=$3 AND source_actor_id=$4 AND conversation_ref=$5 ORDER BY created_at DESC LIMIT 20",
        [
          s.workspaceId,
          s.id,
          source.config.providerKey,
          source.remoteUid,
          roomId,
        ],
      )
    ).rows;
    await assertMember(this.db, s);
    await source.talk.room(roomId);
    return rows.map((r) => receipt(r));
  }
  private async observe(s: Subject, id: string) {
    const { source, row } = await this.authorized(s, id);
    if (!["uploading", "recovery_required"].includes(row.state)) return;
    const file = await source.files.stat(row.source_path);
    if (file.kind !== "file" || file.size !== row.byte_size) return;
    const bytes = await source.files.download(file);
    if (uploadDigest(bytes) !== row.sha256) return;
    const current = await source.files.stat(row.source_path);
    if (
      current.id !== file.id ||
      current.etag !== file.etag ||
      current.size !== file.size
    )
      return;
    await source.talk.room(row.conversation_ref);
    await this.db.tx(async (c) => {
      await this.guard(c, s, source);
      await c.query(
        "UPDATE cw_attachment_uploads SET state='succeeded',source_file=$2,error=NULL,updated_at=now() WHERE id=$1 AND state IN ('uploading','recovery_required')",
        [id, JSON.stringify(file)],
      );
    });
  }
  async upload(s: Subject, id: string, bytes: Buffer) {
    const { source, row } = await this.authorized(s, id);
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length !== row.byte_size ||
      uploadDigest(bytes) !== row.sha256
    )
      throw new BadRequestException(
        "文件字节与确认的大小或 SHA-256 不符，请重新选择。",
      );
    const room = await source.talk.room(row.conversation_ref);
    if (room.readOnly) throw new ForbiddenException("此会话已变为只读。");
    const dispatch = await this.db.tx(async (c) => {
      await this.guard(c, s, source);
      return !!(
        await c.query(
          "UPDATE cw_attachment_uploads SET state='uploading',attempted_at=now(),updated_at=now() WHERE id=$1 AND state='prepared' RETURNING id",
          [id],
        )
      ).rowCount;
    });
    if (!dispatch) return this.get(s, id);
    try {
      // No network call or file bytes inside a database transaction; conditional PUT exactly once per intent.
      await source.files.uploadNew(row.source_path, bytes);
      await this.observe(s, id);
    } catch (e) {
      if (e instanceof UploadPathConflict) {
        await this.db.pool.query(
          "UPDATE cw_attachment_uploads SET state='failed',error='path_exists_not_overwritten',updated_at=now() WHERE id=$1 AND state IN ('uploading','recovery_required')",
          [id],
        );
        return this.get(s, id);
      }
      // Lost response can follow a real write. Only content/version readback may resolve it.
      await this.observe(s, id).catch(() => {});
    }
    await this.db.pool.query(
      "UPDATE cw_attachment_uploads SET state='recovery_required',error='upload_unknown',updated_at=now() WHERE id=$1 AND state='uploading'",
      [id],
    );
    return this.get(s, id);
  }
  async reconcile(s: Subject, id: string) {
    await this.get(s, id);
    const { row } = await this.authorized(s, id);
    if (row.state === "recovery_required")
      await this.observe(s, id).catch(() => {});
    return this.get(s, id);
  }
  async release(s: Subject, id: string) {
    const { row } = await this.authorized(s, id);
    if (row.state === "prepared")
      await this.db.pool.query(
        "UPDATE cw_attachment_uploads SET state='failed',error='abandoned_before_upload',updated_at=now() WHERE id=$1 AND state='prepared'",
        [id],
      );
    else if (row.state === "recovery_required")
      await this.db.pool.query(
        "UPDATE cw_attachment_uploads SET acknowledged_at=now(),updated_at=now() WHERE id=$1 AND state='recovery_required'",
        [id],
      );
    else throw new ConflictException("上传尚在进行或已有明确结果。");
    return this.get(s, id);
  }
}
