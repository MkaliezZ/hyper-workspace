import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { issueSession } from "../../apps/api/src/core/security.js";
import { randomUUID } from "node:crypto";
import { AttachmentUploadInput, type Subject } from "@hyper/contracts";
import {
  AttachmentUploadService,
  uploadDigest,
} from "../../apps/api/src/core/attachment-uploads.js";
import { Database } from "../../apps/api/src/db/database.js";
import { Vault } from "../../apps/api/src/core/credentials.js";
import { requireNextcloud } from "../../apps/api/src/providers/nextcloud.js";
import { DavFixture } from "../fixtures/dav.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated _test database required");
const db = new Database(url),
  service = new AttachmentUploadService(db),
  workspace = randomUUID(),
  dav = new DavFixture();
const people = new Map<string, { subject: Subject; password: string }>(),
  rooms = new Map<string, { members: Set<string>; readOnly: boolean }>();
let puts = 0,
  mode = "ok",
  afterPut: (() => Promise<void>) | undefined;
const server = createServer(async (req, res) => {
  const parsed = new URL(req.url!, "http://127.0.0.1"),
    auth = Buffer.from(
      req.headers.authorization?.replace(/^Basic /, "") ?? "",
      "base64",
    ).toString(),
    colon = auth.indexOf(":"),
    uid = auth.slice(0, colon),
    person = people.get(uid);
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ocs: { meta: { statuscode: status }, data } }));
  };
  if (!person || person.password !== auth.slice(colon + 1))
    return json({}, 401);
  if (parsed.pathname === "/ocs/v2.php/cloud/user")
    return json({ id: uid, displayname: uid });
  if (parsed.pathname.endsWith("/groups")) return json({ groups: ["members"] });
  if (parsed.pathname.startsWith("/ocs/v2.php/apps/spreed/api/")) {
    if (parsed.pathname.endsWith("/room"))
      return json(
        Array.from(rooms)
          .filter(([, r]) => r.members.has(uid))
          .map(([id, r]) => ({
            token: id,
            displayName: "Synthetic upload room",
            actorType: "users",
            actorId: uid,
            participantType: 1,
            readOnly: r.readOnly ? 1 : 0,
          })),
      );
    const id = parsed.pathname.split("/").at(-1)!,
      room = rooms.get(id);
    return room?.members.has(uid)
      ? json({
          token: id,
          displayName: "Synthetic upload room",
          actorType: "users",
          actorId: uid,
          participantType: 1,
          readOnly: room.readOnly ? 1 : 0,
        })
      : json({}, 404);
  }
  if (req.method === "PUT") {
    puts++;
    assert.equal(req.headers["if-none-match"], "*");
    assert.equal(req.headers["content-type"], "application/octet-stream");
    assert.ok(parsed.pathname.startsWith("/remote.php/dav/files/" + uid + "/"));
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks),
      path = parsed.pathname.split("/").slice(5).map(decodeURIComponent);
    if (mode === "drop-before") {
      req.socket.destroy();
      return;
    }
    if (mode === "collision") {
      res.writeHead(412);
      res.end();
      return;
    }
    const file = dav.add(
      uid,
      path,
      mode === "corrupt" ? Buffer.alloc(bytes.length) : bytes,
      "application/octet-stream",
    );
    if (mode === "change-after-read")
      file.afterRead = () => {
        file.etag = '"v2"';
      };
    if (afterPut) {
      const f = afterPut;
      afterPut = undefined;
      await f();
    }
    if (mode === "drop-after") {
      req.socket.destroy();
      return;
    }
    res.writeHead(201);
    res.end();
    return;
  }
  if (dav.handle(req, res, uid)) return;
  json({}, 404);
});
before(async () => {
  process.env.CREDENTIAL_MASTER_KEY = "ab".repeat(32);
  process.env.NEXTCLOUD_FILES_ENABLED = "true";
  process.env.NEXTCLOUD_TALK_ENABLED = "true";
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.NEXTCLOUD_URL =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  delete process.env.NEXTCLOUD_INTERNAL_URL;
  process.env.NEXTCLOUD_WORKSPACE_ID = workspace;
  process.env.NEXTCLOUD_MEMBER_GROUP = "members";
  process.env.NEXTCLOUD_BOOTSTRAP_ADMIN_IDS = "[]";
  await db.migrate();
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name)VALUES($1,'Upload protocol fixture')",
    [workspace],
  );
  for (const name of ["alice", "bob"]) {
    const id = randomUUID(),
      identity = randomUUID(),
      credential = randomUUID(),
      password = "synthetic-" + randomUUID();
    await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
      id,
      name,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,'member')",
      [workspace, id],
    );
    await db.pool.query(
      "INSERT INTO cw_external_identities(id,provider_key,remote_uid,user_id,workspace_id)VALUES($1,$2,$3,$4,$5)",
      [identity, requireNextcloud().providerKey, name, id, workspace],
    );
    await db.pool.query(
      "INSERT INTO cw_identity_credentials(id,identity_id,login_name,credential_enc)VALUES($1,$2,$3,$4)",
      [credential, identity, name, new Vault().encrypt(password)],
    );
    people.set(name, {
      password,
      subject: {
        id,
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
  await new Promise<void>((r) => server.close(() => r()));
  await db.close();
});
const s = (name = "alice") => people.get(name)!.subject;
function fixture() {
  const roomId = randomUUID().replaceAll("-", "").slice(0, 16);
  rooms.set(roomId, { members: new Set(["alice", "bob"]), readOnly: false });
  mode = "ok";
  const bytes = Buffer.from([0, 1, 2, 255, 128, 65, 66, 13, 10]);
  const input = AttachmentUploadInput.parse({
    roomId,
    name: "合成附件.bin",
    size: bytes.length,
    sha256: uploadDigest(bytes),
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  return { input, bytes, room: rooms.get(roomId)! };
}
test("Upload validates bounded explicit metadata, private intent, exact bytes and at most one conditional PUT under concurrency", async () => {
  const { input, bytes } = fixture();
  for (const patch of [
    { name: "../secret" },
    { name: "a\\b" },
    { name: "😀".repeat(80) },
    { size: 0 },
    { size: 8388609 },
    { sha256: "bad" },
    { confirmed: false },
    { extra: "recipient" },
  ])
    assert.equal(
      AttachmentUploadInput.safeParse({ ...input, ...patch }).success,
      false,
    );
  const before = puts,
    [a, b] = await Promise.all([
      service.create(s(), input),
      service.create(s(), input),
    ]);
  assert.equal(a.id, b.id);
  assert.equal(a.state, "prepared");
  assert.equal(puts, before);
  await assert.rejects(
    () => service.create(s(), { ...input, name: "other.bin" }),
    /同一上传键/,
  );
  await assert.rejects(
    () => service.upload(s(), a.id, Buffer.alloc(bytes.length)),
    /SHA-256/,
  );
  assert.equal(puts, before);
  const result = await Promise.all([
    service.upload(s(), a.id, bytes),
    service.upload(s(), a.id, bytes),
  ]);
  assert.equal(puts, before + 1);
  const receipt = await service.get(s(), a.id);
  assert.equal(receipt.state, "succeeded");
  assert.ok(receipt.file);
  assert.deepEqual(
    dav.files.find((f) => f.id === receipt.file!.id)!.content,
    bytes,
  );
  assert.match(receipt.file!.name, new RegExp("^" + a.id + "--"));
  assert.ok(result.some((r) => r.state === "succeeded"));
  assert.equal((await service.upload(s(), a.id, bytes)).id, a.id);
  assert.equal(puts, before + 1);
  assert.equal(
    (
      await db.pool.query(
        "SELECT source_file,sha256 FROM cw_attachment_uploads WHERE id=$1",
        [a.id],
      )
    ).rows[0].sha256,
    input.sha256,
  );
  await assert.rejects(() => service.get(s("bob"), a.id), /不存在/);
  assert.equal((await service.list(s("bob"), input.roomId)).length, 0);
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*) FROM cw_attachment_sends WHERE workspace_id=$1",
        [workspace],
      )
    ).rows[0].count,
    "0",
  );
});
test("Lost upload acknowledgment resolves only from current exact bytes, with no second PUT", async () => {
  const { input, bytes } = fixture(),
    intent = await service.create(s(), input),
    before = puts;
  mode = "drop-after";
  const result = await service.upload(s(), intent.id, bytes);
  assert.equal(result.state, "succeeded");
  assert.ok(result.file);
  assert.equal(puts, before + 1);
  assert.equal(
    (await new AttachmentUploadService(db).get(s(), intent.id)).state,
    "succeeded",
  );
  assert.equal(
    (await service.upload(s(), intent.id, bytes)).state,
    "succeeded",
  );
  assert.equal(puts, before + 1);
});
test("Unknown uploads survive restart, do not trust missing or corrupt bytes and never blindly reupload", async () => {
  const { input, bytes } = fixture(),
    intent = await service.create(s(), input),
    before = puts;
  mode = "drop-before";
  assert.equal(
    (await service.upload(s(), intent.id, bytes)).state,
    "recovery_required",
  );
  const restarted = new AttachmentUploadService(db);
  assert.equal(
    (await restarted.reconcile(s(), intent.id)).state,
    "recovery_required",
  );
  await service.upload(s(), intent.id, bytes);
  assert.equal(puts, before + 1);
  await assert.rejects(
    () => service.create(s(), { ...input, idempotencyKey: randomUUID() }),
    /未结束/,
  );
  const row = (
    await db.pool.query(
      "SELECT source_path FROM cw_attachment_uploads WHERE id=$1",
      [intent.id],
    )
  ).rows[0];
  const file = dav.add(
    "alice",
    row.source_path,
    Buffer.alloc(bytes.length),
    "application/octet-stream",
  );
  assert.equal(
    (await restarted.reconcile(s(), intent.id)).state,
    "recovery_required",
  );
  file.content = bytes;
  file.etag = '"v3"';
  assert.equal((await restarted.reconcile(s(), intent.id)).state, "succeeded");
  assert.equal(puts, before + 1);
});
test("Conditional collision never overwrites; changing versions during readback remain unknown", async () => {
  const a = fixture(),
    x = await service.create(s(), a.input);
  mode = "collision";
  assert.equal((await service.upload(s(), x.id, a.bytes)).state, "failed");
  const b = fixture(),
    y = await service.create(s(), b.input);
  mode = "change-after-read";
  assert.equal(
    (await service.upload(s(), y.id, b.bytes)).state,
    "recovery_required",
  );
  assert.equal((await service.get(s(), y.id)).file, null);
});
test("Prepared abandon races safely, unknown acknowledgment only releases blocking, and old upload cannot dispatch", async () => {
  const { input, bytes } = fixture(),
    old = await service.create(s(), input),
    before = puts;
  assert.equal((await service.release(s(), old.id)).state, "failed");
  assert.equal((await service.upload(s(), old.id, bytes)).state, "failed");
  assert.equal(puts, before);
  const next = await service.create(s(), {
    ...input,
    idempotencyKey: randomUUID(),
  });
  mode = "drop-before";
  assert.equal(
    (await service.upload(s(), next.id, bytes)).state,
    "recovery_required",
  );
  const released = await service.release(s(), next.id);
  assert.equal(released.state, "recovery_required");
  assert.ok(released.acknowledgedAt);
  assert.equal(released.file, null);
  const fresh = await service.create(s(), {
    ...input,
    idempotencyKey: randomUUID(),
  });
  assert.notEqual(fresh.id, next.id);
  assert.equal(fresh.state, "prepared");
});
test("Current room, product membership and credential revocation gate dispatch and all private receipts", async () => {
  const { input, bytes, room } = fixture(),
    intent = await service.create(s(), input),
    before = puts;
  room.readOnly = true;
  await assert.rejects(() => service.upload(s(), intent.id, bytes), /只读/);
  assert.equal(puts, before);
  room.readOnly = false;
  room.members.delete("alice");
  await assert.rejects(() => service.upload(s(), intent.id, bytes));
  assert.equal(puts, before);
  room.members.add("alice");
  await db.pool.query(
    "UPDATE cw_identity_credentials SET disabled_at=now() WHERE id=$1",
    [s().identityCredentialId],
  );
  await assert.rejects(() => service.upload(s(), intent.id, bytes));
  await assert.rejects(() => service.get(s(), intent.id));
  assert.equal(puts, before);
  await db.pool.query(
    "UPDATE cw_identity_credentials SET disabled_at=NULL WHERE id=$1",
    [s().identityCredentialId],
  );
  afterPut = async () => {
    room.members.delete("alice");
  };
  await assert.rejects(() => service.upload(s(), intent.id, bytes));
  assert.equal(puts, before + 1);
  const fact = (
    await db.pool.query("SELECT state FROM cw_attachment_uploads WHERE id=$1", [
      intent.id,
    ])
  ).rows[0];
  assert.equal(fact.state, "recovery_required");
  room.members.add("alice");
  const found = await service.reconcile(s(), intent.id);
  assert.equal(found.state, "succeeded");
  dav.files.find((f) => f.id === found.file!.id)!.etag = '"changed"';
  const changed = await service.get(s(), intent.id);
  assert.equal(changed.state, "succeeded");
  assert.equal(changed.file, null);
});
test("Concurrent abandon/dispatch cannot claim no upload after PUT; stale intents cannot issue delayed PUT", async () => {
  const a = fixture(),
    intent = await service.create(s(), a.input),
    before = puts;
  await Promise.allSettled([
    service.upload(s(), intent.id, a.bytes),
    service.release(s(), intent.id),
  ]);
  const result = await service.get(s(), intent.id);
  assert.ok(puts === before || puts === before + 1);
  assert.equal(result.state, puts === before ? "failed" : "succeeded");
  const b = fixture(),
    stale = await service.create(s(), b.input);
  await db.pool.query(
    "UPDATE cw_attachment_uploads SET state='uploading',attempted_at=now()-interval '1 minute',updated_at=now()-interval '1 minute' WHERE id=$1",
    [stale.id],
  );
  const n = puts;
  assert.equal((await service.get(s(), stale.id)).state, "recovery_required");
  await service.upload(s(), stale.id, b.bytes);
  assert.equal(puts, n);
  await db.pool.query(
    "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [workspace, s().id],
  );
  await assert.rejects(() => service.list(s(), b.input.roomId));
  await assert.rejects(() => service.reconcile(s(), stale.id));
  await db.pool.query(
    "INSERT INTO cw_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
    [workspace, s().id],
  );
});

test("Actual HTTP upload authenticates before bounded raw parsing and leaves global JSON limits unchanged", async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const origin = "http://127.0.0.1:" + port;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/api/src/main.ts"],
    {
      env: {
        ...process.env,
        DATABASE_URL: url,
        TSX_TSCONFIG_PATH: "apps/api/tsconfig.json",
        API_PORT: String(port),
        API_HOST: "127.0.0.1",
        APP_ORIGIN: origin,
        SERVE_WEB: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  child.stdout?.on("data", (chunk) => {
    logs = (logs + chunk).slice(-2000);
  });
  child.stderr?.on("data", (chunk) => {
    logs = (logs + chunk).slice(-2000);
  });
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null)
        throw new Error("API fixture exited: " + logs);
      try {
        await fetch(origin + "/api/auth/status");
        ready = true;
        break;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ready, "API fixture did not start");
    const a = fixture(),
      intent = await service.create(s(), a.input),
      before = puts;
    const session = await issueSession(
        db,
        s().id,
        workspace,
        false,
        s().identityCredentialId,
      ),
      other = await issueSession(
        db,
        s("bob").id,
        workspace,
        false,
        s("bob").identityCredentialId,
      );
    const endpoint =
        origin + "/api/talk/attachment-uploads/" + intent.id + "/content",
      headers = {
        Origin: origin,
        Authorization: "Bearer " + session,
        "Content-Type": "application/octet-stream",
      };
    const send = (extra: Record<string, string> = {}, body: Buffer = a.bytes) =>
      fetch(endpoint, {
        method: "PUT",
        headers: { ...headers, ...extra },
        body: new Uint8Array(body),
      });
    assert.equal((await send({ Authorization: "" })).status, 401);
    assert.equal(
      (await send({ Authorization: "Bearer " + other })).status,
      404,
    );
    assert.equal(
      (await send({ Origin: "https://foreign.invalid" })).status,
      403,
    );
    assert.equal((await send({ "Content-Type": "text/plain" })).status, 415);
    assert.equal((await send({ "Content-Encoding": "gzip" })).status, 415);
    assert.equal((await send({}, Buffer.from("short"))).status, 400);
    assert.equal((await send({}, Buffer.alloc(a.bytes.length))).status, 400);
    const stream = Readable.toWeb(Readable.from([Buffer.alloc(8388609)]));
    const oversized = await fetch(endpoint, {
      method: "PUT",
      headers,
      body: stream,
      duplex: "half",
    } as any);
    assert.equal(oversized.status, 413);
    const largeJson = await fetch(origin + "/api/talk/attachment-uploads", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x".repeat(200000) }),
    });
    assert.equal(largeJson.status, 413);
    assert.equal(puts, before);
    const result = await send();
    assert.equal(result.status, 200);
    const saved = (await result.json()) as any;
    assert.equal(saved.state, "succeeded");
    assert.equal(saved.file.size, a.bytes.length);
    assert.equal(puts, before + 1);
    assert.equal((await send()).status, 200);
    assert.equal(puts, before + 1);
    const boundary = Buffer.alloc(8 * 1024 * 1024, 0x93);
    const maxIntent = await service.create(s(), {
      ...a.input,
      name: "boundary.bin",
      size: boundary.length,
      sha256: uploadDigest(boundary),
      idempotencyKey: randomUUID(),
    });
    const maxResult = await fetch(
      origin + "/api/talk/attachment-uploads/" + maxIntent.id + "/content",
      { method: "PUT", headers, body: new Uint8Array(boundary) },
    );
    assert.equal(maxResult.status, 200);
    const maxReceipt = (await maxResult.json()) as any;
    assert.equal(maxReceipt.state, "succeeded");
    assert.equal(maxReceipt.file.size, 8388608);
    assert.equal(puts, before + 2);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
});
