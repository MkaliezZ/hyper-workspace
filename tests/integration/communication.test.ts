import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { Subject } from "@hyper/contracts";
import { Database } from "../../apps/api/src/db/database.js";
import { Vault } from "../../apps/api/src/core/credentials.js";
import { requireNextcloud } from "../../apps/api/src/providers/nextcloud.js";
import { CommunicationService } from "../../apps/api/src/core/communication.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Use an isolated TEST_DATABASE_URL ending in _test.");
const db = new Database(url),
  service = new CommunicationService(db),
  workspace = randomUUID();
const people = new Map<
  string,
  { password: string; group: boolean; subject: Subject }
>();
type Room = {
  id: string;
  members: Set<string>;
  messages: any[];
  readOnly: boolean;
  post: "ok" | "reject" | "drop-before" | "drop-after";
  readDenied: boolean;
  posts: number;
  readAlias?: string;
};
const rooms = new Map<string, Room>();
let nextId = 100;
function room(members = ["alice", "bob"]) {
  const id = randomUUID().replaceAll("-", "").slice(0, 16),
    r: Room = {
      id,
      members: new Set(members),
      messages: [],
      readOnly: false,
      post: "ok",
      readDenied: false,
      posts: 0,
    };
  rooms.set(id, r);
  return r;
}
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const parsed = new URL(req.url!, "http://127.0.0.1"),
    auth = Buffer.from(
      req.headers.authorization?.replace(/^Basic /, "") ?? "",
      "base64",
    ).toString(),
    colon = auth.indexOf(":"),
    uid = auth.slice(0, colon),
    person = people.get(uid);
  const json = (data: unknown, status = 200) => {
    res.writeHead(status);
    res.end(JSON.stringify({ ocs: { meta: { statuscode: status }, data } }));
  };
  if (!person || person.password !== auth.slice(colon + 1)) {
    res.writeHead(401);
    res.end("{}");
    return;
  }
  if (parsed.pathname === "/ocs/v2.php/cloud/user") {
    json({ id: uid, displayname: uid });
    return;
  }
  if (parsed.pathname === "/ocs/v2.php/cloud/users/" + uid + "/groups") {
    json({ groups: person.group ? ["members"] : [] });
    return;
  }
  const metadata = (r: Room) => ({
    token: r.id,
    displayName: "来源会话 " + r.id,
    actorType: "users",
    actorId: uid,
    participantType: r.members.has(uid) ? 3 : 0,
    readOnly: r.readOnly ? 1 : 0,
  });
  if (parsed.pathname.endsWith("/v4/room")) {
    json([...rooms.values()].filter((r) => r.members.has(uid)).map(metadata));
    return;
  }
  const id = parsed.pathname.split("/").at(-1)!,
    r = rooms.get(id);
  if (!r || !r.members.has(uid)) {
    res.writeHead(404);
    res.end('{"private":"do-not-log-source"}');
    return;
  }
  if (parsed.pathname.includes("/v4/room/")) {
    json(metadata(r));
    return;
  }
  if (req.method === "POST") {
    r.posts++;
    if (r.post === "reject") {
      res.writeHead(403);
      res.end('{"private":"do-not-log-source"}');
      return;
    }
    if (r.post === "drop-before") {
      res.destroy();
      return;
    }
    const form = new URLSearchParams(raw);
    const message = {
      id: nextId++,
      token: id,
      actorType: "users",
      actorId: uid,
      actorDisplayName: uid,
      timestamp: Math.floor(Date.now() / 1000),
      message: form.get("message"),
      referenceId: form.get("referenceId"),
      messageType: "comment",
      messageParameters: {},
    };
    r.messages.push(message);
    if (r.post === "drop-after") {
      res.destroy();
      return;
    }
    json(message, 201);
    return;
  }
  if (r.readDenied) {
    res.writeHead(403);
    res.end("{}");
    return;
  }
  assert.equal(parsed.searchParams.get("setReadMarker"), "0");
  assert.equal(parsed.searchParams.get("noStatusUpdate"), "1");
  assert.equal(parsed.searchParams.get("markNotificationsAsRead"), "0");
  const before = Number(
      parsed.searchParams.get("lastKnownMessageId") || Number.MAX_SAFE_INTEGER,
    ),
    include = parsed.searchParams.get("includeLastKnown") === "1",
    limit = Number(parsed.searchParams.get("limit"));
  const values = r.messages
    .filter((m) => (include ? m.id <= before : m.id < before))
    .slice(-limit)
    .reverse();
  if (values.length)
    res.setHeader("X-Chat-Last-Given", String(values.at(-1).id));
  json(
    r.readAlias
      ? values.map((message) => ({ ...message, actorDisplayName: r.readAlias }))
      : values,
  );
});
before(async () => {
  process.env.CREDENTIAL_MASTER_KEY = "ab".repeat(32);
  process.env.NEXTCLOUD_TALK_ENABLED = "true";
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.NEXTCLOUD_URL =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  delete process.env.NEXTCLOUD_INTERNAL_URL;
  process.env.NEXTCLOUD_WORKSPACE_ID = workspace;
  process.env.NEXTCLOUD_MEMBER_GROUP = "members";
  process.env.NEXTCLOUD_BOOTSTRAP_ADMIN_IDS = "[]";
  await db.migrate();
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name)VALUES($1,'Communication protocol fixture')",
    [workspace],
  );
  for (const name of ["alice", "bob", "outsider"]) {
    const uid = randomUUID(),
      identity = randomUUID(),
      credential = randomUUID(),
      password = "synthetic-device-" + randomUUID();
    await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
      uid,
      name,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,'member')",
      [workspace, uid],
    );
    await db.pool.query(
      "INSERT INTO cw_external_identities(id,provider_key,remote_uid,user_id,workspace_id)VALUES($1,$2,$3,$4,$5)",
      [identity, requireNextcloud().providerKey, name, uid, workspace],
    );
    await db.pool.query(
      "INSERT INTO cw_identity_credentials(id,identity_id,login_name,credential_enc)VALUES($1,$2,$3,$4)",
      [credential, identity, name, new Vault().encrypt(password)],
    );
    people.set(name, {
      password,
      group: true,
      subject: {
        id: uid,
        name,
        workspaceId: workspace,
        role: "member",
        demo: false,
        identityCredentialId: credential,
      },
    });
  }
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});
const s = (name = "alice") => people.get(name)!.subject;

test("Talk source membership controls room listing, direct IDs and read-only sends", async () => {
  const r = room(["alice"]);
  assert.ok((await service.rooms(s())).some((x) => x.id === r.id));
  assert.ok(!(await service.rooms(s("bob"))).some((x) => x.id === r.id));
  await assert.rejects(service.messages(s("bob"), r.id));
  r.readOnly = true;
  await assert.rejects(
    service.send(s(), r.id, "not allowed", randomUUID()),
    /只读/,
  );
  assert.equal(r.posts, 0);
  await assert.rejects(service.rooms({ ...s(), demo: true }), /企业账号/);
});
test("Read-through messages preserve IDs, render rich names once and mask deleted/expired content", async () => {
  const r = room();
  r.messages.push({
    id: nextId++,
    token: r.id,
    actorType: "users",
    actorId: "bob",
    actorDisplayName: "Bob",
    timestamp: Math.floor(Date.now() / 1000),
    message: "{one} {two}",
    messageType: "comment",
    messageParameters: { one: { name: "{two}" }, two: { name: "visible" } },
  });
  r.messages.push({
    ...r.messages[0],
    id: nextId++,
    message: "deleted-private-text",
    messageType: "comment_deleted",
  });
  r.messages.push({
    ...r.messages[0],
    id: nextId++,
    message: "expired-private-text",
    expirationTimestamp: 1,
  });
  const page = await service.messages(s(), r.id);
  assert.equal(page.messages[0].content, "{two} visible");
  assert.equal(page.messages[1].content, "此消息已删除。");
  assert.equal(page.messages.length, 2);
  assert.equal(
    (
      await db.pool.query("SELECT id FROM cw_messages WHERE workspace_id=$1", [
        workspace,
      ])
    ).rowCount,
    0,
  );
});
test("Concurrent retry keys result in one source send, validated readback and scoped metadata-only receipt", async () => {
  const r = room();
  r.readAlias = "Updated display label";
  const key = randomUUID(),
    results = await Promise.all([
      service.send(s(), r.id, "actual protocol message", key),
      service.send(s(), r.id, "actual protocol message", key),
    ]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(r.posts, 1);
  assert.equal((await service.receipt(s(), results[0].id)).state, "succeeded");
  await assert.rejects(
    service.send(s(), r.id, "different body", key),
    /相同发送键/,
  );
  await assert.rejects(service.receipt(s("bob"), results[0].id));
  const stored = (
    await db.pool.query("SELECT * FROM cw_communication_sends WHERE id=$1", [
      results[0].id,
    ])
  ).rows[0];
  assert.equal(
    JSON.stringify(stored).includes("actual protocol message"),
    false,
  );
  assert.equal(
    JSON.stringify(results).includes(people.get("alice")!.password),
    false,
  );
});
test("Lost response after a real source write enters recovery; reconciliation never posts a second message", async () => {
  const r = room();
  r.post = "drop-after";
  const key = randomUUID(),
    receipt = await service.send(s(), r.id, "response lost", key);
  assert.equal(receipt.state, "recovery_required");
  assert.equal(r.messages.length, 1);
  assert.equal(
    (await service.send(s(), r.id, "response lost", key)).id,
    receipt.id,
  );
  assert.equal(r.posts, 1);
  await assert.rejects(
    service.send(s(), r.id, "new message", randomUUID()),
    /待核对/,
  );
  assert.equal((await service.pending(s(), r.id))[0].id, receipt.id);
  assert.equal((await service.reconcile(s(), receipt.id)).state, "succeeded");
  assert.equal(r.posts, 1);
});
test("Readback rejection after acknowledgement retains an unknown outcome rather than claiming no effect", async () => {
  const r = room();
  r.readDenied = true;
  const receipt = await service.send(
    s(),
    r.id,
    "written before read rejection",
    randomUUID(),
  );
  assert.equal(r.messages.length, 1);
  assert.equal(receipt.state, "recovery_required");
  r.readDenied = false;
  assert.equal((await service.reconcile(s(), receipt.id)).state, "succeeded");
  assert.equal(r.posts, 1);
});
test("Definitive rejection and missing bounded readback have distinct receipts; manual continuation preserves unknown evidence", async () => {
  const rejected = room();
  rejected.post = "reject";
  const failed = await service.send(
    s(),
    rejected.id,
    "not written",
    randomUUID(),
  );
  assert.equal(failed.state, "failed");
  assert.equal(rejected.messages.length, 0);
  const r = room();
  r.post = "drop-before";
  const unknown = await service.send(s(), r.id, "not confirmed", randomUUID());
  assert.equal(
    (await service.reconcile(s(), unknown.id)).state,
    "recovery_required",
  );
  assert.equal(r.posts, 1);
  const ack = await service.acknowledge(s(), unknown.id);
  assert.equal(ack.state, "recovery_required");
  assert.ok(ack.acknowledgedAt);
  assert.equal((await service.pending(s(), r.id)).length, 0);
  r.post = "ok";
  assert.equal(
    (await service.send(s(), r.id, "fresh explicit intent", randomUUID()))
      .state,
    "succeeded",
  );
  assert.equal(r.posts, 2);
});
test("Stale sending intents require reconciliation; source removal immediately denies old receipts", async () => {
  const r = room();
  r.post = "drop-before";
  const receipt = await service.send(s(), r.id, "interrupted", randomUUID());
  await db.pool.query(
    "UPDATE cw_communication_sends SET state='sending',updated_at=now()-interval '1 minute' WHERE id=$1",
    [receipt.id],
  );
  assert.equal(
    (await service.pending(s(), r.id))[0].state,
    "recovery_required",
  );
  assert.equal(r.posts, 1);
  r.members.delete("alice");
  await assert.rejects(service.receipt(s(), receipt.id));
  await assert.rejects(service.messages(s(), r.id));
  assert.equal(r.posts, 1);
});
