import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { z } from "zod";
import type { NextcloudConfig, SourceCredentials } from "./nextcloud.js";
import { SourceRejected, TalkCursor, TalkToken } from "./nextcloud-talk.js";
const Uid = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const SourceRoom = z.object({
  token: TalkToken,
  actorType: z.string(),
  actorId: Uid,
  participantType: z.number().int(),
  type: z.number().int(),
  name: z.string().max(255).default(""),
  displayName: z.string().max(10000),
  readOnly: z.number().int().optional(),
  isFavorite: z.boolean().optional(),
  notificationLevel: z.number().int().min(0).max(3).optional(),
  unreadMessages: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  unreadMention: z.boolean().optional(),
  lastReadMessage: z
    .number()
    .int()
    .min(-2)
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  objectType: z.string().max(255).optional(),
  breakoutRoomMode: z.number().int().min(0).max(3).optional(),
  lastMessage: z.unknown().optional(),
  hasCall: z.boolean().optional(),
  canLeaveConversation: z.boolean().optional(),
  canDeleteConversation: z.boolean().optional(),
});
export interface ManagedRoom {
  id: string;
  type: number;
  name: string;
  displayName: string;
  participantType: number;
  objectType: string | null;
  breakoutRoomMode: number | null;
  readOnly: boolean | null;
  favorite: boolean | null;
  notificationLevel: number | null;
  unreadMessages: number | null;
  unreadMention: boolean | null;
  lastReadMessage: string | null;
  hasCall: boolean | null;
  canLeave: boolean | null;
  canDelete: boolean | null;
}
export interface ManagedParticipant {
  uid: string;
  name: string;
  participantType: number;
  attendeeId: number;
}
export type SourceRoomChange =
  | { operation: "notify"; roomId: string; level: number }
  | { operation: "favorite"; roomId: string; enabled: boolean }
  | { operation: "mark_read"; roomId: string; messageId: string }
  | { operation: "mark_unread"; roomId: string }
  | { operation: "rename"; roomId: string; name: string }
  | { operation: "add_member"; roomId: string; uid: string }
  | { operation: "remove_member"; roomId: string; attendeeId: number }
  | {
      operation: "moderator";
      roomId: string;
      attendeeId: number;
      enabled: boolean;
    }
  | { operation: "leave"; roomId: string }
  | { operation: "delete"; roomId: string };
/** P03/P04/P07: current employee only. Source credentials, guest status, email and message bodies never leave this boundary. */
export class NextcloudRoomManagementProvider {
  constructor(
    readonly config: NextcloudConfig,
    private credentials: Pick<SourceCredentials, "loginName" | "appPassword">,
    readonly remoteUid: string,
  ) {
    if (!credentials.loginName || /[\r\n:]/.test(credentials.loginName))
      throw new ForbiddenException("来源凭据格式无效。");
    Uid.parse(remoteUid);
  }
  private async request(
    path: string,
    method = "GET",
    values?: Record<string, string>,
  ) {
    let response: Response;
    try {
      response = await fetch(
        this.config.transportUrl +
          "/ocs/v2.php/" +
          path +
          (path.includes("?") ? "&" : "?") +
          "format=json",
        {
          method,
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
            ...(values
              ? { "Content-Type": "application/x-www-form-urlencoded" }
              : {}),
          },
          ...(values ? { body: new URLSearchParams(values) } : {}),
        },
      );
    } catch {
      throw new ServiceUnavailableException(
        "无法确认会话管理请求的来源响应，请核对原操作。",
      );
    }
    if (
      response.status >= 400 &&
      response.status < 500 &&
      ![408, 425, 499].includes(response.status)
    ) {
      await response.body?.cancel().catch(() => {});
      throw new SourceRejected(response.status);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ServiceUnavailableException(
        "会话管理来源暂时不可用，请核对原操作。",
      );
    }
    let body: any;
    try {
      if (Number(response.headers.get("content-length") ?? 0) > 8 * 1024 * 1024)
        throw Error();
      const reader = response.body?.getReader();
      if (!reader) throw Error();
      const parts: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          bytes += result.value.length;
          if (bytes > 8 * 1024 * 1024) throw Error();
          parts.push(result.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)),
      );
    } catch {
      await response.body?.cancel().catch(() => {});
      throw new ServiceUnavailableException(
        "会话管理来源响应无效或超过限制，请核对原操作。",
      );
    }
    const code = Number(body?.ocs?.meta?.statuscode);
    if (code >= 400 && code < 500 && ![408, 425, 499].includes(code))
      throw new SourceRejected(code);
    if ([997, 998].includes(code))
      throw new SourceRejected(code === 997 ? 401 : 404);
    if (
      !(code === 100 || (code >= 200 && code < 300)) ||
      body?.ocs?.data === undefined
    )
      throw new ServiceUnavailableException(
        "会话管理来源返回未知状态，请核对原操作。",
      );
    return { data: body.ocs.data, status: response.status };
  }
  private parseRoom(raw: unknown): ManagedRoom {
    const value = SourceRoom.safeParse(raw);
    if (!value.success)
      throw new ServiceUnavailableException("当前会话信息格式不受支持。");
    const r = value.data;
    if (
      r.actorType !== "users" ||
      r.actorId !== this.remoteUid ||
      ![1, 2, 3].includes(r.participantType)
    )
      throw new ForbiddenException("当前员工没有此会话的正式成员权限。");
    return {
      id: r.token,
      type: r.type,
      name: r.name,
      displayName: r.displayName || "未命名会话",
      participantType: r.participantType,
      objectType: r.objectType ?? null,
      breakoutRoomMode: r.breakoutRoomMode ?? null,
      readOnly: r.readOnly === undefined ? null : r.readOnly !== 0,
      favorite: r.isFavorite ?? null,
      notificationLevel: r.notificationLevel ?? null,
      unreadMessages: r.unreadMessages ?? null,
      unreadMention: r.unreadMention ?? null,
      lastReadMessage:
        r.lastReadMessage === undefined ? null : String(r.lastReadMessage),
      hasCall: r.hasCall ?? null,
      canLeave: r.canLeaveConversation ?? null,
      canDelete: r.canDeleteConversation ?? null,
    };
  }
  async capabilities() {
    const result = await this.request("cloud/capabilities");
    const features = z
      .array(z.string().max(200))
      .max(1000)
      .safeParse(result.data?.capabilities?.spreed?.features);
    if (!features.success)
      throw new ServiceUnavailableException("无法核对当前通信服务能力。");
    return features.data;
  }
  async rooms() {
    const result = await this.request(
      "apps/spreed/api/v4/room?noStatusUpdate=1&includeStatus=0&includeLastMessage=0",
    );
    if (!Array.isArray(result.data) || result.data.length > 1000)
      throw new ServiceUnavailableException(
        "会话目录超过 1000 项或格式无效，未将截取结果视为完整目录。",
      );
    const rows: ManagedRoom[] = [];
    for (const raw of result.data) {
      const parsed = SourceRoom.safeParse(raw);
      if (!parsed.success)
        throw new ServiceUnavailableException("会话目录包含不受支持的数据。");
      if (
        parsed.data.actorType === "users" &&
        parsed.data.actorId === this.remoteUid &&
        [1, 2, 3].includes(parsed.data.participantType)
      )
        rows.push(this.parseRoom(raw));
    }
    if (new Set(rows.map((r) => r.id)).size !== rows.length)
      throw new ServiceUnavailableException("来源返回重复会话身份。");
    return rows;
  }
  async room(id: string) {
    TalkToken.parse(id);
    const room = (await this.rooms()).find((r) => r.id === id);
    if (!room) throw new NotFoundException("会话不存在或当前员工已被移除。");
    return room;
  }
  async participants(id: string) {
    await this.room(id);
    const result = await this.request(
      "apps/spreed/api/v4/room/" +
        TalkToken.parse(id) +
        "/participants?includeStatus=0",
    );
    if (!Array.isArray(result.data) || result.data.length > 2000)
      throw new ServiceUnavailableException("会话成员超过 2000 人或格式无效。");
    const rows: ManagedParticipant[] = [];
    let unsupported = 0;
    const schema = z.object({
      actorType: z.string(),
      actorId: Uid,
      displayName: z.string().max(10000),
      participantType: z.number().int(),
      attendeeId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    });
    for (const raw of result.data) {
      const kind = z
        .object({ actorType: z.string(), participantType: z.number().int() })
        .safeParse(raw);
      if (!kind.success)
        throw new ServiceUnavailableException("会话成员身份无法核对。");
      if (
        kind.data.actorType !== "users" ||
        ![1, 2, 3].includes(kind.data.participantType)
      ) {
        unsupported++;
        continue;
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success)
        throw new ServiceUnavailableException("会话成员身份无法核对。");
      const p = parsed.data;
      if (p.actorType !== "users" || ![1, 2, 3].includes(p.participantType)) {
        unsupported++;
        continue;
      }
      rows.push({
        uid: p.actorId,
        name: p.displayName || p.actorId,
        participantType: p.participantType,
        attendeeId: p.attendeeId,
      });
    }
    if (new Set(rows.map((p) => p.uid)).size !== rows.length)
      throw new ServiceUnavailableException("来源返回重复会话成员身份。");
    return {
      rows: rows.sort((a, b) => a.uid.localeCompare(b.uid)),
      unsupported,
    };
  }
  async create(kind: "direct" | "group", value: string) {
    const params: Record<string, string> =
      kind === "direct"
        ? { roomType: "1", invite: Uid.parse(value) }
        : {
            roomType: "2",
            roomName: z.string().trim().min(1).max(255).parse(value),
          };
    const result = await this.request(
      "apps/spreed/api/v4/room",
      "POST",
      params,
    );
    return {
      room: this.parseRoom(result.data),
      created: result.status === 201,
      status: result.status,
    };
  }
  async change(command: SourceRoomChange) {
    const id = TalkToken.parse(command.roomId);
    await this.room(id);
    let path = "apps/spreed/api/v4/room/" + id,
      method = "POST",
      values: Record<string, string> | undefined;
    switch (command.operation) {
      case "notify":
        path += "/notify";
        values = {
          level: String(z.number().int().min(0).max(3).parse(command.level)),
        };
        break;
      case "favorite":
        path += "/favorite";
        method = command.enabled ? "POST" : "DELETE";
        break;
      case "mark_read":
        path = "apps/spreed/api/v1/chat/" + id + "/read";
        values = { lastReadMessage: TalkCursor.parse(command.messageId) };
        break;
      case "mark_unread":
        path = "apps/spreed/api/v1/chat/" + id + "/read";
        method = "DELETE";
        break;
      case "rename":
        method = "PUT";
        values = {
          roomName: z.string().trim().min(1).max(255).parse(command.name),
        };
        break;
      case "add_member":
        path += "/participants";
        values = { newParticipant: Uid.parse(command.uid), source: "users" };
        break;
      case "remove_member":
        path += "/attendees";
        method = "DELETE";
        values = {
          attendeeId: String(
            z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER)
              .parse(command.attendeeId),
          ),
        };
        break;
      case "moderator":
        path += "/moderators";
        method = command.enabled ? "POST" : "DELETE";
        values = {
          attendeeId: String(
            z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER)
              .parse(command.attendeeId),
          ),
        };
        break;
      case "leave":
        path += "/participants/self";
        method = "DELETE";
        break;
      case "delete":
        method = "DELETE";
        break;
    }
    const result = await this.request(path, method, values);
    return { acknowledged: true, status: result.status };
  }
}
