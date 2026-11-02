import { createServer, type ServerResponse } from "node:http";
export interface FixtureRoom {
  token: string;
  type: number;
  name: string;
  people: Map<string, { type: number; id: number }>;
  preferences: Map<string, { level: number; favorite: boolean; read: number }>;
  messages: {
    id: number;
    author: string;
    content: string;
    kind?: string;
    expirationTimestamp?: number;
  }[];
}
/** An HTTP protocol source, never a real Nextcloud or company acceptance fixture. */
export class TalkManagementFixture {
  readonly users = new Map([
    ["operator", "当前员工"],
    ["peer", "同名员工"],
    ["other", "同名员工"],
    ["outsider", "外部账号"],
  ]);
  readonly members = new Set(["operator", "peer", "other"]);
  readonly rooms = new Map<string, FixtureRoom>();
  readonly writes: {
    actor: string;
    path: string;
    method: string;
    body: Record<string, string>;
  }[] = [];
  readonly features = [
    "chat-read-marker",
    "chat-unread",
    "notification-levels",
    "favorites",
  ];
  readonly credentials = new Map<string, string>();
  loseNext = false;
  rejectNext = false;
  rejectInvitationFor: string | undefined;
  failReadback = false;
  readonly searches: {
    actor: string;
    roomId: string;
    term: string;
    cursor: string;
    limit: string;
  }[] = [];
  afterSearch: (() => void | Promise<void>) | undefined;
  transformSearch: ((value: any) => unknown) | undefined;
  beforeWrite:
    | ((path: string, actor: string) => void | Promise<void>)
    | undefined;
  afterWrite:
    | ((path: string, actor: string) => void | Promise<void>)
    | undefined;
  private nextRoom = 1;
  private nextAttendee = 1;
  private nextMessage = 41;
  readonly server = createServer(async (req, res) => {
    const auth = Buffer.from(
        req.headers.authorization?.slice(6) ?? "",
        "base64",
      ).toString(),
      actor = this.credentials.get(auth);
    if (!actor) {
      res.writeHead(401);
      res.end();
      return;
    }
    let raw = "";
    for await (const part of req) raw += part;
    const url = new URL(req.url!, "http://fixture.invalid"),
      path = url.pathname,
      body = new URLSearchParams(raw),
      method = req.method!;
    res.setHeader("Content-Type", "application/json");
    const send = (data: unknown, status = 200) => {
      res.writeHead(status);
      res.end(JSON.stringify({ ocs: { meta: { statuscode: status }, data } }));
    };
    if (path === "/ocs/v2.php/cloud/user")
      return send({
        id: actor,
        displayname: this.users.get(actor),
        enabled: true,
      });
    if (path.startsWith("/ocs/v2.php/cloud/users/") && path.endsWith("/groups"))
      return send({
        groups: this.members.has(actor) ? ["synthetic-staff"] : [],
      });
    if (path === "/ocs/v2.php/cloud/groups/synthetic-staff/users")
      return send({ users: [...this.members] });
    if (path === "/ocs/v2.php/cloud/capabilities")
      return send({ capabilities: { spreed: { features: this.features } } });
    if (path === "/ocs/v2.php/core/autocomplete/get") {
      const query = url.searchParams.get("search") ?? "";
      return send(
        [...this.users]
          .filter(([uid, name]) => uid.includes(query) || name.includes(query))
          .map(([id, label]) => ({ id, label, source: "users" })),
      );
    }
    if (
      method === "GET" &&
      path === "/ocs/v2.php/search/providers/talk-message/search"
    ) {
      const room = this.rooms.get(url.searchParams.get("conversation") ?? "");
      if (!room || !room.people.has(actor)) return send({}, 404);
      const term = url.searchParams.get("term") ?? "",
        cursor = url.searchParams.get("cursor") ?? "0",
        limit = url.searchParams.get("limit") ?? "20";
      this.searches.push({ actor, roomId: room.token, term, cursor, limit });
      const entries = room.messages
        .filter((m) => m.content.toLowerCase().includes(term.toLowerCase()))
        .sort((a, b) => b.id - a.id)
        .slice(Number(cursor), Number(cursor) + Number(limit))
        .map((m) => ({
          title: "untrusted source author snippet",
          subline: "untrusted stale snippet",
          resourceUrl: "https://untrusted.invalid/never-follow",
          attributes: { conversation: room.token, messageId: String(m.id) },
        }));
      const result = {
        isPaginated: true,
        cursor: Number(cursor) + Number(limit),
        entries,
      };
      await this.afterSearch?.();
      return send(this.transformSearch ? this.transformSearch(result) : result);
    }
    const route =
      /^\/ocs\/v2.php\/apps\/spreed\/api\/(v[14])\/(room|chat)(?:\/([a-z0-9]+))?(.*)$/.exec(
        path,
      );
    if (!route) return send({}, 404);
    const [, version, kind, token, suffix] = route;
    if (method === "GET") {
      if (!token)
        return send(
          [...this.rooms.values()]
            .filter((room) => room.people.has(actor))
            .map((room) => this.metadata(room, actor)),
        );
      const room = this.rooms.get(token);
      if (!room || !room.people.has(actor)) return send({}, 404);
      if (this.failReadback) return send({}, 503);
      if (kind === "room" && suffix === "/participants")
        return send(
          [...room.people].map(([actorId, p]) => ({
            actorType: "users",
            actorId,
            displayName: this.users.get(actorId) ?? actorId,
            participantType: p.type,
            attendeeId: p.id,
            phoneNumber: "must not escape",
          })),
        );
      if (kind === "chat") {
        const rows = [...room.messages]
          .reverse()
          .filter(
            (message) =>
              !url.searchParams.has("lastKnownMessageId") ||
              message.id < Number(url.searchParams.get("lastKnownMessageId")) ||
              (url.searchParams.get("includeLastKnown") === "1" &&
                message.id ===
                  Number(url.searchParams.get("lastKnownMessageId"))),
          )
          .slice(0, Number(url.searchParams.get("limit") ?? "100"))
          .map((message) => ({
            id: message.id,
            token: room.token,
            actorId: message.author,
            actorType: "users",
            actorDisplayName: this.users.get(message.author) ?? message.author,
            timestamp: 1793538000,
            message: message.content,
            messageType: message.kind ?? "comment",
            ...(message.expirationTimestamp
              ? { expirationTimestamp: message.expirationTimestamp }
              : {}),
            systemMessage: "",
            referenceId: "",
          }));
        res.setHeader("X-Chat-Last-Given", String(rows.at(-1)?.id ?? 1));
        return send(rows);
      }
      return send(this.metadata(room, actor));
    }
    this.writes.push({ actor, path, method, body: Object.fromEntries(body) });
    await this.beforeWrite?.(path, actor);
    if (this.rejectNext) {
      this.rejectNext = false;
      return send({ untrusted: "private source rejection body" }, 403);
    }
    let data: unknown = [],
      status = 200;
    if (kind === "room" && !token && method === "POST") {
      if (body.get("roomType") === "1") {
        const target = body.get("invite")!;
        if (!this.users.has(target)) return send({}, 404);
        let room = [...this.rooms.values()].find(
          (room) =>
            room.type === 1 &&
            room.people.size === 2 &&
            room.people.has(actor) &&
            room.people.has(target),
        );
        if (!room) {
          room = this.addRoom("", [actor, target], 1);
          status = 201;
        }
        data = this.metadata(room, actor);
      } else {
        const room = this.addRoom(body.get("roomName")!, [actor]);
        status = 201;
        data = this.metadata(room, actor);
      }
    } else {
      const room = this.rooms.get(token!);
      if (!room || !room.people.has(actor)) return send({}, 404);
      const participant = room.people.get(actor)!,
        preference = this.preference(room, actor);
      if (kind === "chat" && suffix === "/read") {
        preference.read =
          method === "DELETE" ? -1 : Number(body.get("lastReadMessage"));
      } else if (suffix === "/notify")
        preference.level = Number(body.get("level"));
      else if (suffix === "/favorite") preference.favorite = method === "POST";
      else if (suffix === "/participants/self") {
        if (!this.metadata(room, actor).canLeaveConversation)
          return send({}, 400);
        room.people.delete(actor);
      } else {
        if (participant.type > 2) return send({}, 403);
        if (suffix === "/participants") {
          const uid = body.get("newParticipant")!;
          if (this.rejectInvitationFor === uid) return send({}, 403);
          if (!this.users.has(uid)) return send({}, 404);
          if (!room.people.has(uid))
            room.people.set(uid, { type: 3, id: this.nextAttendee++ });
        } else if (suffix === "/attendees" || suffix === "/moderators") {
          const id = Number(body.get("attendeeId")),
            target = [...room.people].find(([, p]) => p.id === id);
          if (!target) return send({}, 404);
          if (target[1].type === 1) return send({}, 403);
          if (suffix === "/attendees") {
            if (target[1].type !== 3) return send({}, 400);
            room.people.delete(target[0]);
          } else target[1].type = method === "POST" ? 2 : 3;
        } else if (method === "PUT") room.name = body.get("roomName")!;
        else if (method === "DELETE") this.rooms.delete(room.token);
        else return send({}, 404);
      }
    }
    await this.afterWrite?.(path, actor);
    if (this.loseNext) {
      this.loseNext = false;
      res.destroy();
      return;
    }
    return send(data, status);
  });
  constructor() {
    for (const uid of this.users.keys())
      this.credentials.set(uid + ":synthetic-password", uid);
  }
  addRoom(name: string, uids = ["operator", "peer"], type = 2) {
    const token = "room" + String(this.nextRoom++).padStart(5, "0"),
      room: FixtureRoom = {
        token,
        type,
        name,
        people: new Map(),
        preferences: new Map(),
        messages: [],
      };
    for (const [index, uid] of uids.entries())
      room.people.set(uid, {
        type: type === 1 ? 3 : index === 0 ? 1 : 3,
        id: this.nextAttendee++,
      });
    this.rooms.set(token, room);
    this.message(room, "operator", "Synthetic message only");
    return room;
  }
  message(room: FixtureRoom, author: string, content: string) {
    const id = this.nextMessage++;
    room.messages.push({ id, author, content });
    return id;
  }
  private preference(room: FixtureRoom, uid: string) {
    let p = room.preferences.get(uid);
    if (!p) {
      p = { level: 0, favorite: false, read: 0 };
      room.preferences.set(uid, p);
    }
    return p;
  }
  metadata(room: FixtureRoom, actor: string) {
    const p = this.preference(room, actor),
      role = room.people.get(actor)!.type,
      moderators = [...room.people.values()].filter((p) => p.type <= 2).length;
    return {
      token: room.token,
      type: room.type,
      name: room.name,
      displayName:
        room.name ||
        [...room.people.keys()].filter((uid) => uid !== actor).join(","),
      actorType: "users",
      actorId: actor,
      participantType: role,
      objectType: "",
      breakoutRoomMode: 0,
      hasCall: false,
      readOnly: 0,
      isFavorite: p.favorite,
      notificationLevel: p.level,
      unreadMessages: room.messages.filter((m) => m.id > p.read).length,
      unreadMention: false,
      lastReadMessage: p.read,
      canLeaveConversation: room.type === 2 && (role === 3 || moderators > 1),
      canDeleteConversation: room.type === 2 && role <= 2,
    };
  }
  async start() {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve),
    );
    return (
      "http://127.0.0.1:" + (this.server.address() as { port: number }).port
    );
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
