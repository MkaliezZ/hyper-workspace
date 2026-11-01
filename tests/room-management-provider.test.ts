import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { NextcloudRoomManagementProvider } from "../apps/api/src/providers/nextcloud-room-management.js";
import { SourceRejected } from "../apps/api/src/providers/nextcloud-talk.js";
let active = true,
  writeMode = "valid",
  sparse = false;
const requests: { url: URL; method: string; body: URLSearchParams }[] = [];
const room = () => ({
  token: "scope123",
  type: 2,
  name: "Synthetic private group",
  displayName: "Synthetic private group",
  actorType: "users",
  actorId: "employee-one",
  participantType: 1,
  objectType: "",
  breakoutRoomMode: 0,
  ...(sparse
    ? {}
    : {
        readOnly: 0,
        isFavorite: false,
        notificationLevel: 2,
        unreadMessages: 3,
        unreadMention: true,
        lastReadMessage: 40,
        canDeleteConversation: true,
        canLeaveConversation: false,
      }),
  lastMessage: { message: "private message must not escape" },
});
const server = createServer(async (req, res) => {
  assert.equal(
    req.headers.authorization,
    "Basic " +
      Buffer.from("employee-one:synthetic-password").toString("base64"),
  );
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url!, "http://synthetic.invalid");
  requests.push({ url, method: req.method!, body: new URLSearchParams(raw) });
  res.setHeader("Content-Type", "application/json");
  const send = (data: unknown, code = 100) =>
    res.end(JSON.stringify({ ocs: { meta: { statuscode: code }, data } }));
  if (req.method !== "GET") {
    if (writeMode === "empty") return void res.end();
    if (writeMode === "rejected")
      return void send({ private: "do not display upstream body" }, 403);
    if (writeMode === "unknown") {
      res.writeHead(503);
      return void res.end("private gateway body");
    }
    if (url.pathname.endsWith("/room")) {
      const direct = new URLSearchParams(raw).get("roomType") === "1";
      res.writeHead(direct ? 200 : 201);
      return void send({ ...room(), type: direct ? 1 : 2 });
    }
    return void send([]);
  }
  if (url.pathname.endsWith("/capabilities"))
    return void send({
      capabilities: {
        spreed: {
          features: [
            "chat-read-marker",
            "chat-unread",
            "notification-levels",
            "favorites",
          ],
        },
      },
    });
  if (url.pathname.endsWith("/participants"))
    return void send([
      {
        actorType: "users",
        actorId: "employee-one",
        displayName: "当前员工",
        participantType: 1,
        attendeeId: 11,
        email: "secret email",
        phoneNumber: "secret phone",
      },
      {
        actorType: "users",
        actorId: "employee-two",
        displayName: "员工二",
        participantType: 3,
        attendeeId: 12,
        statusMessage: "secret status",
      },
      {
        actorType: "guests",
        actorId: "",
        displayName: "Unsupported guest",
        participantType: 4,
        attendeeId: 13,
      },
    ]);
  return void send(active ? [room()] : []);
});
let provider: NextcloudRoomManagementProvider;
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  provider = new NextcloudRoomManagementProvider(
    {
      publicUrl: base,
      transportUrl: base,
      providerKey: "synthetic-room",
      workspaceId: "synthetic",
      memberGroup: "synthetic-staff",
      bootstrapAdminIds: [],
    },
    { loginName: "employee-one", appPassword: "synthetic-password" },
    "employee-one",
  );
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
test("Room management reads current capabilities and bounded employee metadata without message bodies or private participant attributes", async () => {
  assert.ok((await provider.capabilities()).includes("notification-levels"));
  const current = await provider.room("scope123");
  assert.equal(current.unreadMessages, 3);
  assert.equal(current.lastReadMessage, "40");
  assert.ok(!JSON.stringify(current).includes("private message"));
  const people = await provider.participants("scope123");
  assert.equal(people.rows[1]!.uid, "employee-two");
  assert.equal(people.rows[1]!.attendeeId, 12);
  assert.equal(people.unsupported, 1);
  assert.equal(people.rows.length, 2);
  assert.ok(!/secret/.test(JSON.stringify(people)));
  sparse = true;
  const unknown = await provider.room("scope123");
  assert.equal(unknown.unreadMessages, null);
  assert.equal(unknown.notificationLevel, null);
  assert.equal(unknown.canDelete, null);
  sparse = false;
});
test("Room management uses fixed source routes, exact attendee IDs and explicit mark-read positions, never an implicit poll write", async () => {
  await provider.change({ operation: "notify", roomId: "scope123", level: 3 });
  assert.equal(requests.at(-1)!.body.get("level"), "3");
  await provider.change({
    operation: "mark_read",
    roomId: "scope123",
    messageId: "41",
  });
  assert.equal(
    requests.at(-1)!.url.pathname,
    "/ocs/v2.php/apps/spreed/api/v1/chat/scope123/read",
  );
  assert.equal(requests.at(-1)!.body.get("lastReadMessage"), "41");
  await provider.change({
    operation: "remove_member",
    roomId: "scope123",
    attendeeId: 12,
  });
  assert.equal(
    requests.at(-1)!.url.pathname,
    "/ocs/v2.php/apps/spreed/api/v4/room/scope123/attendees",
  );
  assert.equal(requests.at(-1)!.body.get("attendeeId"), "12");
  await provider.change({
    operation: "moderator",
    roomId: "scope123",
    attendeeId: 12,
    enabled: false,
  });
  assert.equal(requests.at(-1)!.method, "DELETE");
  assert.ok(requests.at(-1)!.url.pathname.endsWith("/moderators"));
  await provider.change({
    operation: "favorite",
    roomId: "scope123",
    enabled: false,
  });
  assert.equal(requests.at(-1)!.method, "DELETE");
  const before = requests.filter((r) => r.method !== "GET").length;
  await provider.room("scope123");
  await provider.participants("scope123");
  assert.equal(requests.filter((r) => r.method !== "GET").length, before);
});
test("Room creation distinguishes an existing direct conversation from a new private group and does not invent unsupported source correlation fields", async () => {
  const direct = await provider.create("direct", "employee-two");
  assert.equal(direct.created, false);
  assert.equal(requests.at(-1)!.body.get("invite"), "employee-two");
  const group = await provider.create("group", "明确合成私群");
  assert.equal(group.created, true);
  assert.deepEqual([...requests.at(-1)!.body.keys()].sort(), [
    "roomName",
    "roomType",
  ]);
  await assert.rejects(provider.create("group", " "));
});
test("Revoked room scope prevents writes; rejected source operations and ambiguous empty or gateway replies remain distinct and sanitized", async () => {
  active = false;
  const before = requests.filter((r) => r.method !== "GET").length;
  await assert.rejects(
    provider.change({ operation: "notify", roomId: "scope123", level: 1 }),
  );
  assert.equal(requests.filter((r) => r.method !== "GET").length, before);
  active = true;
  writeMode = "rejected";
  await assert.rejects(
    provider.change({ operation: "notify", roomId: "scope123", level: 1 }),
    (e) =>
      e instanceof SourceRejected &&
      e.getStatus() === 403 &&
      !e.message.includes("private"),
  );
  for (const mode of ["empty", "unknown"]) {
    writeMode = mode;
    await assert.rejects(
      provider.change({ operation: "notify", roomId: "scope123", level: 1 }),
      (e) =>
        !(e instanceof SourceRejected) &&
        !String(e).includes("private gateway"),
    );
  }
  writeMode = "valid";
  await assert.rejects(
    provider.change({ operation: "notify", roomId: "../other", level: 1 }),
  );
});
