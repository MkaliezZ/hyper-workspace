import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { z } from "zod";
import type { NextcloudConfig, SourceCredentials } from "./nextcloud.js";
import type { CommunicationMessage, CommunicationRoom } from "@hyper/contracts";
import type { CommunicationProvider } from "./communication.js";
export const TalkToken = z.string().regex(/^[a-z0-9]{4,30}$/);
export const TalkCursor = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .refine((s) => BigInt(s) <= BigInt(Number.MAX_SAFE_INTEGER));
/** A definitive source rejection, safe to distinguish from ambiguous transport failure. */
export class SourceRejected extends HttpException {
  constructor(status: number) {
    super("来源拒绝了此操作，请检查会话权限或内容。", status);
  }
}
const Room = z.object({
  token: TalkToken,
  displayName: z.string(),
  actorType: z.string(),
  actorId: z.string(),
  participantType: z.number().int(),
  readOnly: z.number().int().default(0),
});
const Message = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  token: TalkToken,
  actorId: z.string(),
  actorDisplayName: z.string(),
  actorType: z.string(),
  timestamp: z.number().int().nonnegative().max(8640000000000),
  message: z.string(),
  messageType: z.string().default("comment"),
  systemMessage: z.string().default(""),
  referenceId: z.string().default(""),
  messageParameters: z
    .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .default({}),
  lastEditTimestamp: z.number().int().nonnegative().optional(),
  expirationTimestamp: z.number().int().nonnegative().optional(),
});
function iso(seconds: number) {
  return new Date(seconds * 1000).toISOString();
}
function normalized(raw: z.infer<typeof Message>): CommunicationMessage {
  const parameters = raw.messageParameters;
  let content = raw.message.replace(/\{([^{}]+)\}/g, (placeholder, key) => {
    const value = (parameters as Record<string, unknown>)[key];
    return value &&
      typeof value === "object" &&
      "name" in value &&
      typeof value.name === "string"
      ? value.name
      : placeholder;
  });
  const kind =
    raw.messageType === "comment_deleted"
      ? "deleted"
      : raw.systemMessage || raw.messageType === "system"
        ? "system"
        : raw.messageType === "comment"
          ? "comment"
          : "unsupported";
  if (kind === "deleted") content = "此消息已删除。";
  return {
    id: String(raw.id),
    authorId: raw.actorType + ":" + raw.actorId,
    author: raw.actorDisplayName || "未知成员",
    content,
    createdAt: iso(raw.timestamp),
    kind,
    referenceId: raw.referenceId,
    version: String(raw.lastEditTimestamp || raw.timestamp),
    expiresAt: raw.expirationTimestamp ? iso(raw.expirationTimestamp) : null,
  };
}
export class NextcloudTalkProvider implements CommunicationProvider {
  constructor(
    private config: NextcloudConfig,
    private credentials: Pick<SourceCredentials, "loginName" | "appPassword">,
    private remoteUid: string,
  ) {}
  private async ocs(path: string, init: RequestInit = {}) {
    let response: Response;
    try {
      response = await fetch(
        this.config.transportUrl + "/ocs/v2.php/apps/spreed/api/" + path,
        {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: {
            Accept: "application/json",
            "OCS-APIRequest": "true",
            "User-Agent": "Hyper Workspace/0.1",
            Authorization:
              "Basic " +
              Buffer.from(
                this.credentials.loginName + ":" + this.credentials.appPassword,
              ).toString("base64"),
            ...init.headers,
          },
        },
      );
    } catch {
      throw new ServiceUnavailableException(
        "无法确认企业通信服务的响应，请稍后核对。",
      );
    }
    if (response.status === 304) return { data: [], response };
    if (response.status >= 400 && response.status < 500)
      throw new SourceRejected(response.status);
    if (!response.ok)
      throw new ServiceUnavailableException("企业通信服务暂时不可用。");
    let body;
    try {
      body = await response.json();
    } catch {
      throw new ServiceUnavailableException("企业通信服务返回无效响应。");
    }
    if (
      !(
        body?.ocs?.meta?.statuscode === 100 ||
        (Number.isInteger(body?.ocs?.meta?.statuscode) &&
          body.ocs.meta.statuscode >= 200 &&
          body.ocs.meta.statuscode < 300)
      ) ||
      body.ocs.data === undefined
    )
      throw new ServiceUnavailableException("企业通信服务返回无效状态。");
    return { data: body.ocs.data, response };
  }
  private parseRoom(raw: unknown): CommunicationRoom {
    const parsed = Room.safeParse(raw);
    if (!parsed.success)
      throw new ServiceUnavailableException("企业会话格式不受支持。");
    const room = parsed.data;
    if (
      room.actorType !== "users" ||
      room.actorId !== this.remoteUid ||
      ![1, 2, 3].includes(room.participantType)
    )
      throw new ForbiddenException("当前员工不在此企业会话内。");
    return {
      id: room.token,
      name: room.displayName || "未命名会话",
      readOnly: room.readOnly !== 0,
    };
  }
  async listRooms() {
    const { data } = await this.ocs(
      "v4/room?format=json&noStatusUpdate=1&includeStatus=false",
    );
    if (!Array.isArray(data))
      throw new ServiceUnavailableException("企业会话列表格式不受支持。");
    const result: CommunicationRoom[] = [];
    for (const raw of data) {
      const p = Room.safeParse(raw);
      if (!p.success)
        throw new ServiceUnavailableException("企业会话列表格式不受支持。");
      if (
        p.data.actorType === "users" &&
        p.data.actorId === this.remoteUid &&
        [1, 2, 3].includes(p.data.participantType)
      )
        result.push(this.parseRoom(raw));
    }
    return result;
  }
  async room(id: string) {
    TalkToken.parse(id);
    return this.parseRoom(
      (await this.ocs("v4/room/" + id + "?format=json&noStatusUpdate=1")).data,
    );
  }
  private async read(
    id: string,
    before?: string,
    limit = 100,
    include = false,
  ) {
    TalkToken.parse(id);
    if (before) TalkCursor.parse(before);
    const query = new URLSearchParams({
      format: "json",
      lookIntoFuture: "0",
      limit: String(limit),
      setReadMarker: "0",
      noStatusUpdate: "1",
      markNotificationsAsRead: "0",
      includeLastKnown: include ? "1" : "0",
    });
    if (before) query.set("lastKnownMessageId", before);
    const { data, response } = await this.ocs("v1/chat/" + id + "?" + query);
    const parsed = z.array(Message).safeParse(data);
    if (!parsed.success || parsed.data.some((m) => m.token !== id))
      throw new ServiceUnavailableException("企业消息格式或来源不匹配。");
    const cursor = response.headers.get("X-Chat-Last-Given");
    return {
      messages: parsed.data
        .filter(
          (message) =>
            !message.expirationTimestamp ||
            message.expirationTimestamp > Date.now() / 1000,
        )
        .map(normalized)
        .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id))),
      before: cursor && TalkCursor.safeParse(cursor).success ? cursor : null,
    };
  }
  async assertReadable(id: string) {
    await this.read(id, undefined, 1);
  }
  async messages(id: string, before?: string) {
    await this.room(id);
    return this.read(id, before);
  }
  async send(id: string, content: string, referenceId: string) {
    if ((await this.room(id)).readOnly)
      throw new BadRequestException("此企业会话当前只读。");
    const { data } = await this.ocs("v1/chat/" + id + "?format=json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message: content, referenceId }),
    });
    const parsed = Message.safeParse(data);
    if (
      !parsed.success ||
      parsed.data.token !== id ||
      parsed.data.actorType !== "users" ||
      parsed.data.actorId !== this.remoteUid ||
      parsed.data.referenceId !== referenceId
    )
      throw new ServiceUnavailableException(
        "发送响应无法核对，请查询来源消息。",
      );
    return normalized(parsed.data);
  }
  async find(id: string, messageId: string) {
    await this.room(id);
    return (
      await this.read(id, TalkCursor.parse(messageId), 1, true)
    ).messages.find((m) => m.id === messageId);
  }
}
