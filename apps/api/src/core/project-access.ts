import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { Subject } from "@hyper/contracts";
import type { Database } from "../db/database.js";
import { digest } from "./credentials.js";
import { assertMember } from "./security.js";
import { sourceConnection } from "./source-connection.js";
import {
  NextcloudTalkProvider,
  SourceRejected,
  TalkToken,
} from "../providers/nextcloud-talk.js";
interface Binding {
  project_id: string;
  workspace_id: string;
  provider_key: string;
  source_kind: "nextcloud-talk";
  conversation_ref: string;
}
export interface ProjectSource {
  kind: "nextcloud-talk";
  roomId: string;
  name: string;
}
/** Product membership and live source membership intersect for every protected object. */
export class ProjectAccess {
  constructor(private db: Database) {}
  async binding(s: Subject, projectId: string): Promise<Binding | undefined> {
    return (
      await this.db.pool.query(
        "SELECT * FROM cw_project_sources WHERE project_id=$1 AND workspace_id=$2",
        [projectId, s.workspaceId],
      )
    ).rows[0];
  }
  private async connection(s: Subject) {
    if (process.env.NEXTCLOUD_TALK_ENABLED !== "true")
      throw new ServiceUnavailableException("项目的企业会话来源尚未启用。");
    const connection = await sourceConnection(this.db, s);
    return {
      ...connection,
      provider: new NextcloudTalkProvider(
        connection.config,
        connection.credentials,
        connection.remoteUid,
      ),
    };
  }
  async room(s: Subject, id: string) {
    const connection = await this.connection(s);
    const room = await connection.provider.room(TalkToken.parse(id));
    await connection.provider.assertReadable(id);
    return { providerKey: connection.config.providerKey, room };
  }
  async assert(
    s: Subject,
    projectId: string,
  ): Promise<ProjectSource | undefined> {
    await assertMember(this.db, s);
    const project = await this.db.pool.query(
      "SELECT id FROM cw_projects WHERE id=$1 AND workspace_id=$2",
      [projectId, s.workspaceId],
    );
    if (!project.rowCount)
      throw new NotFoundException("项目不存在或无权访问。");
    const binding = await this.binding(s, projectId);
    if (!binding) return;
    if (s.demo || !s.identityCredentialId)
      throw new NotFoundException("项目不存在或无权访问。");
    const connection = await this.connection(s);
    if (connection.config.providerKey !== binding.provider_key)
      throw new NotFoundException("项目来源已变化或无权访问。");
    try {
      const room = await connection.provider.room(binding.conversation_ref);
      await connection.provider.assertReadable(binding.conversation_ref);
      return { kind: "nextcloud-talk", roomId: room.id, name: room.name };
    } catch (error) {
      if (
        error instanceof SourceRejected &&
        [403, 404, 412].includes(error.getStatus())
      )
        throw new NotFoundException("项目不存在或无权访问。");
      throw error;
    }
  }
  async list(s: Subject) {
    await assertMember(this.db, s);
    const rows = (
      await this.db.pool.query(
        'SELECT p.id,p.name,p.goal,c.id AS "conversationId",x.provider_key,x.conversation_ref FROM cw_projects p JOIN cw_conversations c ON c.project_id=p.id LEFT JOIN cw_project_sources x ON x.project_id=p.id AND x.workspace_id=p.workspace_id WHERE p.workspace_id=$1 ORDER BY p.name',
        [s.workspaceId],
      )
    ).rows;
    const local = rows
      .filter((row) => !row.provider_key)
      .map(({ provider_key, conversation_ref, ...row }) => row);
    if (
      !rows.some((row) => row.provider_key) ||
      s.demo ||
      !s.identityCredentialId ||
      process.env.NEXTCLOUD_TALK_ENABLED !== "true"
    )
      return local;
    const connection = await this.connection(s);
    let rooms;
    try {
      rooms = await connection.provider.listRooms();
    } catch (error) {
      if (
        (error instanceof SourceRejected &&
          [403, 404, 429].includes(error.getStatus())) ||
        error instanceof ServiceUnavailableException
      )
        return local;
      throw error;
    }
    const allowed = new Map(rooms.map((room) => [room.id, room]));
    const candidates = rows.filter(
      (row) =>
        row.provider_key === connection.config.providerKey &&
        allowed.has(row.conversation_ref),
    );
    const readable = new Set<string>();
    for (let offset = 0; offset < candidates.length; offset += 4)
      await Promise.all(
        candidates.slice(offset, offset + 4).map(async (row) => {
          try {
            await connection.provider.assertReadable(row.conversation_ref);
            readable.add(row.id);
          } catch (error) {
            if (
              (error instanceof SourceRejected && error.getStatus() !== 401) ||
              error instanceof ServiceUnavailableException
            )
              return;
            throw error;
          }
        }),
      );
    return rows.flatMap(({ provider_key, conversation_ref, ...row }) => {
      if (!provider_key) return [row];
      const room = allowed.get(conversation_ref);
      return readable.has(row.id) && room
        ? [
            {
              ...row,
              source: {
                kind: "nextcloud-talk",
                roomId: room.id,
                name: room.name,
              },
            },
          ]
        : [];
    });
  }

  async visibleIds(s: Subject) {
    return (await this.list(s)).map((project) => project.id as string);
  }
  async sourceMessages(s: Subject, projectId: string) {
    await this.assert(s, projectId);
    const binding = await this.binding(s, projectId);
    if (!binding) return [];
    const connection = await this.connection(s);
    if (connection.config.providerKey !== binding.provider_key)
      throw new NotFoundException("项目来源已变化。");
    const messages = (
      await connection.provider.messages(binding.conversation_ref)
    ).messages
      .filter(
        (message) =>
          message.kind === "comment" &&
          (!message.expiresAt || Date.parse(message.expiresAt) > Date.now()),
      )
      .slice(-60);
    return messages.map((message) => {
      const content =
        message.content +
        (message.attachments?.length
          ? "\n[附件引用；未读取正文，不得据文件名推断内容] " +
            JSON.stringify(
              message.attachments.map(({ id, name, mime, etag }) => ({
                id,
                name,
                mime,
                etag,
              })),
            )
          : "");
      return {
        id:
          "talk:" +
          binding.provider_key +
          ":" +
          binding.conversation_ref +
          ":" +
          message.id +
          "@" +
          message.version +
          ":" +
          digest(content),
        author: message.author,
        actorId: message.authorId,
        content,
        sourceMessageId: message.id,
        sourceVersion: message.version,
        sourceRoomId: binding.conversation_ref,
      };
    });
  }
}
