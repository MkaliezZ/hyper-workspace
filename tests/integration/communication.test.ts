import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { Subject } from "@hyper/contracts";
import { Database } from "../../apps/api/src/db/database.js";
import { Vault } from "../../apps/api/src/core/credentials.js";
import { requireNextcloud } from "../../apps/api/src/providers/nextcloud.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { KnowledgeService } from "../../apps/api/src/core/knowledge.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { CommunicationService } from "../../apps/api/src/core/communication.js";
import { ReplyDraftService } from "../../apps/api/src/core/reply-drafts.js";
import { SourceFileService } from "../../apps/api/src/core/source-files.js";
import { DavFixture } from "../fixtures/dav.js";
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
let directRoomQueries = 0;
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
const embeddingInputs: string[][] = [];
const dav = new DavFixture();
let revokeEmbeddingFile: ReturnType<DavFixture["add"]> | undefined;
let revokeEmbeddingRoom: Room | undefined;
let duringFileEmbedding: (() => Promise<void>) | undefined;
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (req.url?.startsWith("/v1/embeddings")) {
    const body = JSON.parse(raw);
    embeddingInputs.push(body.input);
    if (duringFileEmbedding) {
      const change = duringFileEmbedding;
      duringFileEmbedding = undefined;
      await change();
    }
    if (
      revokeEmbeddingFile &&
      body.input.some((text: string) =>
        text.includes("file-revoke-during-embedding"),
      )
    )
      revokeEmbeddingFile.blockedDownloads.add("alice");
    if (
      revokeEmbeddingRoom &&
      body.input.some((text: string) => text.includes("revoke-while-indexing"))
    )
      revokeEmbeddingRoom.members.delete("alice");
    res.end(
      JSON.stringify({
        data: body.input.map((_: string, index: number) => ({
          index,
          embedding: [1, 0],
        })),
      }),
    );
    return;
  }
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
  if (dav.handle(req, res, uid)) return;
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
  if (parsed.pathname.includes("/v4/room/")) directRoomQueries++;
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
  process.env.NEXTCLOUD_FILES_ENABLED = "true";
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
  assert.equal(
    directRoomQueries,
    0,
    "Revoked/guessed room tokens must be rejected from the live membership list without probing the protected token endpoint",
  );
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

function sourceMessage(r: Room, content: string) {
  r.messages.push({
    id: nextId++,
    token: r.id,
    actorType: "users",
    actorId: "bob",
    actorDisplayName: "Bob",
    timestamp: Math.floor(Date.now() / 1000),
    message: content,
    messageType: "comment",
    messageParameters: {},
  });
}
function scopedWorkspace(execute: any) {
  const engines = engineRegistry();
  engines.set("dsh", {
    id: "dsh",
    describeCapabilities: () => ({
      configured: true,
      operations: ["discussion_to_minutes"],
      evidence: "protocol-fixture",
    }),
    execute,
  });
  return new WorkspaceService(db, engines);
}
async function chatProfile(work: WorkspaceService) {
  return work.saveModel(s(), {
    name: "scope fixture",
    provider: "openai-compatible",
    endpoint: "http://127.0.0.1:1/v1",
    model: "fixture",
    purpose: "chat",
    scope: "personal",
    apiKey: "synthetic-chat-key",
  });
}

test("Source project binding is stable and product admins cannot bypass room scope for direct object access", async () => {
  const r = room(),
    work = new WorkspaceService(db, engineRegistry());
  const [project, same] = await Promise.all([
    work.createTalkProject(s(), r.id, "Restricted project", "Restricted goal"),
    work.createTalkProject(s(), r.id, "Restricted project", "Restricted goal"),
  ]);
  assert.equal(project.id, same.id);
  await assert.rejects(
    work.createTalkProject(s(), r.id, "Another goal", "different"),
    /已有/,
  );
  await db.pool.query(
    "UPDATE cw_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",
    [workspace, s("outsider").id],
  );
  assert.ok(
    !(await work.access.list(s("outsider"))).some((p) => p.id === project.id),
  );
  await assert.rejects(work.view(s("outsider"), project.id));
  await assert.rejects(
    work.message(s("outsider"), project.conversationId, "not allowed"),
  );
  const task = await work.createTask(s(), project.conversationId, {
    title: "Scoped task",
    assignee: "Bob",
    dueDate: null,
  });
  await assert.rejects(
    work.patchTask(s("outsider"), task.id, { status: "done" }),
  );
  const artifact = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_artifacts(id,workspace_id,project_id,title,created_by)VALUES($1,$2,$3,'Restricted artifact',$4)",
    [artifact, workspace, project.id, s().id],
  );
  await db.pool.query(
    "INSERT INTO cw_artifact_versions(artifact_id,version,content,created_by)VALUES($1,1,'Private content',$2)",
    [artifact, s().id],
  );
  await assert.rejects(work.artifact(s("outsider"), artifact));
  await assert.rejects(
    work.revise(s("outsider"), artifact, {
      expectedVersion: 1,
      content: "forbidden",
      feedback: "",
    }),
  );
  await work.revise(s("bob"), artifact, {
    expectedVersion: 1,
    content: "Authorized peer edit",
    feedback: "",
  });
  r.readDenied = true;
  await assert.rejects(work.artifact(s(), artifact));
  assert.ok(!(await work.access.list(s())).some((p) => p.id === project.id));
  r.readDenied = false;
  r.members.delete("bob");
  await assert.rejects(work.artifact(s("bob"), artifact));
  assert.equal((await work.artifact(s(), artifact)).current.version, 2);
});
test("AI uses authorized source text with immutable references and stops business writes after room revocation", async () => {
  const r = room();
  sourceMessage(r, "source-private-sentinel");
  let observed = "",
    revoke = false;
  const work = scopedWorkspace(async (request: any) => {
    observed = request.context;
    if (revoke) r.members.delete("alice");
    return {
      text: "fixture result",
      evidence: "fixture",
      actions:
        request.workflow === "revise_artifact"
          ? [
              {
                tool: "artifact.revise",
                args: { content: "revised-with-new-source" },
              },
            ]
          : [
              {
                tool: "artifact.create",
                args: {
                  title: "Scoped AI result",
                  content: "source-derived-private-artifact",
                },
              },
            ],
    };
  });
  const project = await work.createTalkProject(
    s(),
    r.id,
    "AI source project",
    "Summarize the authorized room",
  );
  await chatProfile(work);
  const input = {
    conversationId: project.conversationId,
    workflow: "discussion_to_minutes" as const,
    engine: "dsh" as const,
    instruction: "Summarize",
    idempotencyKey: randomUUID(),
  };
  const processor = new RunProcessor(work),
    first = await work.startRun(s(), input);
  await processor.process(first.id);
  assert.ok(observed.includes("source-private-sentinel"));
  assert.ok(!observed.includes(people.get("alice")!.password));
  const result = await work.getRun(s(), first.id);
  assert.equal(result.state, "succeeded");
  assert.match(result.contextRefs[0], /^talk:.*@[0-9]+:[a-f0-9]{64}$/);
  const artifact = result.result.receipts[0].id;
  assert.ok(
    (await work.artifact(s(), artifact)).current.sourceMessageIds.includes(
      result.contextRefs[0],
    ),
  );
  await assert.rejects(work.getRun(s("outsider"), first.id));
  await assert.rejects(work.events(s("outsider"), first.id));
  sourceMessage(r, "new-source-fact-for-revision");
  const revision = await work.startRun(s(), {
    ...input,
    workflow: "revise_artifact",
    artifactId: artifact,
    idempotencyKey: randomUUID(),
  });
  await processor.process(revision.id);
  const revisionResult = await work.getRun(s(), revision.id);
  assert.equal(revisionResult.state, "succeeded", revisionResult.error);
  const revised = await work.artifact(s(), artifact);
  assert.equal(revised.current.version, 2);
  assert.ok(observed.includes("new-source-fact-for-revision"));
  assert.ok(observed.includes("source-derived-private-artifact"));
  const revisionRun = await work.getRun(s(), revision.id);
  assert.ok(revisionRun.contextRefs.includes("artifact:" + artifact + "@1"));
  assert.ok(
    revisionRun.contextRefs
      .filter((ref: string) => !ref.startsWith("artifact:"))
      .every((ref: string) => revised.current.sourceMessageIds.includes(ref)),
  );
  const queued = await work.startRun(s(), {
    ...input,
    idempotencyKey: randomUUID(),
  });
  revoke = true;
  const second = await work.startRun(s(), {
    ...input,
    idempotencyKey: randomUUID(),
  });
  await processor.process(second.id);
  const state = (
    await db.pool.query("SELECT state FROM cw_runs WHERE id=$1", [second.id])
  ).rows[0].state;
  assert.equal(state, "failed");
  assert.equal(
    (
      await db.pool.query("SELECT id FROM cw_actions WHERE run_id=$1", [
        second.id,
      ])
    ).rowCount,
    0,
  );
  await assert.rejects(work.getRun(s(), first.id));
  const cancelled = await work.cancel(s(), queued.id);
  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(Object.keys(cancelled).sort(), ["id", "state"]);
});
test("Keyword, indexing and pgvector queries inherit source project access and reject revoked writes", async () => {
  const r = room(),
    work = new WorkspaceService(db, engineRegistry()),
    project = await work.createTalkProject(
      s(),
      r.id,
      "Indexed private project",
      "Keep scoped facts private",
    );
  const asset = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_assets(id,workspace_id,project_id,owner_id,title,content,type,source_version)VALUES($1,$2,$3,$4,'scope-search-sentinel','source-private-knowledge','text','1')",
    [asset, workspace, project.id, s().id],
  );
  assert.equal(
    (await work.search(s("outsider"), "scope-search-sentinel")).length,
    0,
  );
  assert.equal((await work.search(s(), "scope-search-sentinel")).length, 1);
  const model = await work.saveModel(s("outsider"), {
      name: "Shared embedding fixture",
      provider: "openai-compatible",
      endpoint: process.env.NEXTCLOUD_URL + "/v1",
      model: "fixture-vector",
      purpose: "embedding",
      scope: "workspace",
      apiKey: "synthetic-embedding",
    }),
    knowledge = new KnowledgeService(db);
  const before = embeddingInputs.length;
  await assert.rejects(knowledge.index(s("outsider"), [asset], model.id));
  assert.equal(embeddingInputs.length, before);
  assert.deepEqual((await knowledge.index(s(), [asset], model.id)).indexed, [
    asset,
  ]);
  assert.equal(
    (await knowledge.semantic(s("outsider"), "query", model.id)).some(
      (row) => row.id === asset,
    ),
    false,
  );
  assert.equal(
    (await knowledge.semantic(s(), "query", model.id)).some(
      (row) => row.id === asset,
    ),
    true,
  );
  await db.pool.query(
    "UPDATE cw_assets SET content='revoke-while-indexing',source_version='2',embedding=NULL WHERE id=$1",
    [asset],
  );
  revokeEmbeddingRoom = r;
  assert.deepEqual((await knowledge.index(s(), [asset], model.id)).indexed, []);
  assert.equal(
    (
      await db.pool.query("SELECT embedding FROM cw_assets WHERE id=$1", [
        asset,
      ])
    ).rows[0].embedding,
    null,
  );
  assert.equal((await work.search(s(), "scope-search-sentinel")).length, 0);
  revokeEmbeddingRoom = undefined;
});
test("Oversized authorized source context fails before dispatching a model request", async () => {
  const r = room();
  for (let i = 0; i < 4; i++) sourceMessage(r, "x".repeat(30000));
  let calls = 0;
  const work = scopedWorkspace(async () => {
      calls++;
      return { text: "unreachable", evidence: "fixture", actions: [] };
    }),
    project = await work.createTalkProject(
      s(),
      r.id,
      "Long source project",
      "Use a bounded context",
    );
  await chatProfile(work);
  const run = await work.startRun(s(), {
    conversationId: project.conversationId,
    workflow: "discussion_to_minutes",
    engine: "dsh",
    instruction: "Summarize",
    idempotencyKey: randomUUID(),
  });
  await new RunProcessor(work).process(run.id);
  const result = await work.getRun(s(), run.id);
  assert.equal(calls, 0);
  assert.equal(result.state, "failed");
  assert.match(result.error, /100 KB/);
});

async function preparedReply(
  r: Room,
  content = "private-ai-reply-sentinel",
  args?: Record<string, unknown>,
) {
  const work = scopedWorkspace(async () => ({
    text: "model-text-must-not-appear-in-project",
    evidence: "fixture",
    actions: [{ tool: "communication.draft", args: args ?? { content } }],
  }));
  const project = await work.createTalkProject(
    s(),
    r.id,
    "Reply project " + r.id,
    "Prepare a reply for review",
  );
  await chatProfile(work);
  const run = await work.startRun(s(), {
    conversationId: project.conversationId,
    workflow: "draft_reply",
    engine: "dsh",
    instruction: "Prepare, never send",
    idempotencyKey: randomUUID(),
  });
  const processor = new RunProcessor(work);
  await Promise.all([processor.process(run.id), processor.process(run.id)]);
  const result = await work.getRun(s(), run.id);
  return {
    work,
    project,
    run: result,
    draftId: result.result?.receipts?.[0]?.id,
  };
}
test("Reply drafting is private, source-bound and durable; engine text never becomes a project message or a delivery receipt", async () => {
  const r = room();
  sourceMessage(r, "reply-source-evidence");
  const { work, project, run, draftId } = await preparedReply(r);
  assert.equal(run.state, "succeeded", run.error);
  assert.equal(run.result.text, "回复草稿已保存，尚未发送。");
  assert.equal(r.posts, 0);
  const drafts = new ReplyDraftService(db),
    own = await drafts.get(s(), draftId);
  assert.equal(own.content, "private-ai-reply-sentinel");
  assert.equal(own.roomId, r.id);
  assert.deepEqual(own.sourceMessageIds, run.contextRefs);
  assert.equal((await drafts.list(s(), r.id)).length, 1);
  assert.equal((await drafts.list(s("bob"), r.id)).length, 0);
  await assert.rejects(drafts.get(s("bob"), draftId));
  await assert.rejects(drafts.get(s("outsider"), draftId));
  assert.equal((await work.view(s("bob"), project.id)).messages.length, 0);
  assert.equal(
    (await work.search(s("bob"), "private-ai-reply-sentinel")).length,
    0,
  );
  assert.equal(
    (
      await db.pool.query(
        "SELECT id FROM cw_communication_drafts WHERE source_run_id=$1",
        [run.id],
      )
    ).rowCount,
    1,
  );
  const local = await work.createProject(
    s(),
    "Public project",
    "No communication target",
  );
  await assert.rejects(
    work.startRun(s(), {
      conversationId: local.conversationId,
      workflow: "draft_reply",
      engine: "dsh",
      instruction: "Prepare",
      idempotencyKey: randomUUID(),
    }),
    /关联项目/,
  );
});
test("Reviewed draft sends bind the employee, source room and edited content; new retry keys cannot duplicate delivery", async () => {
  const r = room(),
    other = room();
  const { draftId } = await preparedReply(r);
  await assert.rejects(
    service.send(s("bob"), r.id, "stolen", randomUUID(), draftId),
  );
  await assert.rejects(
    service.send(s(), other.id, "wrong room", randomUUID(), draftId),
  );
  assert.equal(r.posts + other.posts, 0);
  const key = randomUUID();
  const result = await service.send(
    s(),
    r.id,
    "human-reviewed-edited-reply",
    key,
    draftId,
  );
  assert.equal(result.state, "succeeded");
  assert.equal(
    (await service.send(s(), r.id, "human-reviewed-edited-reply", key, draftId))
      .id,
    result.id,
  );
  await assert.rejects(
    service.send(
      s(),
      r.id,
      "human-reviewed-edited-reply",
      randomUUID(),
      draftId,
    ),
    /发送记录/,
  );
  assert.equal(r.posts, 1);
  const row = (
    await db.pool.query("SELECT * FROM cw_communication_sends WHERE id=$1", [
      result.id,
    ])
  ).rows[0];
  assert.equal(row.draft_id, draftId);
  assert.equal(row.draft_modified, true);
  assert.equal(
    JSON.stringify(row).includes("human-reviewed-edited-reply"),
    false,
  );
  r.members.delete("alice");
  await assert.rejects(new ReplyDraftService(db).get(s(), draftId));
  await assert.rejects(new ReplyDraftService(db).list(s(), r.id));
  await assert.rejects(
    service.send(s(), r.id, "revoked", randomUUID(), draftId),
  );
});
test("Unknown draft delivery remains unknown after acknowledgement; only reconciliation can confirm it", async () => {
  const r = room();
  const { draftId } = await preparedReply(r);
  r.post = "drop-after";
  const receipt = await service.send(
    s(),
    r.id,
    "reviewed message",
    randomUUID(),
    draftId,
  );
  assert.equal(receipt.state, "recovery_required");
  await service.acknowledge(s(), receipt.id);
  await assert.rejects(
    service.send(s(), r.id, "reviewed message", randomUUID(), draftId),
    /发送记录/,
  );
  assert.equal(
    (await new ReplyDraftService(db).list(s(), r.id))[0].sendState,
    "recovery_required",
  );
  assert.equal((await service.reconcile(s(), receipt.id)).state, "succeeded");
  assert.equal(
    (await new ReplyDraftService(db).list(s(), r.id))[0].sendState,
    "succeeded",
  );
  assert.equal(r.posts, 1);
});
test("Reply drafting rejects model-selected recipients and cannot save after source revocation", async () => {
  const r = room();
  const invalid = await preparedReply(r, "unused", {
    content: "attempt",
    roomId: "otherroom",
  });
  assert.equal(invalid.run.state, "failed");
  assert.equal(invalid.draftId, undefined);
  const work = scopedWorkspace(async () => {
    r.members.delete("alice");
    return {
      text: "claimed done",
      evidence: "fixture",
      actions: [
        { tool: "communication.draft", args: { content: "revoked proposal" } },
      ],
    };
  });
  await chatProfile(work);
  const started = await work.startRun(s(), {
    conversationId: invalid.project.conversationId,
    workflow: "draft_reply",
    engine: "dsh",
    instruction: "Prepare",
    idempotencyKey: randomUUID(),
  });
  await new RunProcessor(work).process(started.id);
  assert.equal(
    (await db.pool.query("SELECT state FROM cw_runs WHERE id=$1", [started.id]))
      .rows[0].state,
    "failed",
  );
  assert.equal(
    (
      await db.pool.query(
        "SELECT id FROM cw_communication_drafts WHERE source_run_id=$1",
        [started.id],
      )
    ).rowCount,
    0,
  );
  assert.equal(r.posts, 0);
});

async function fileEmbedding(work: WorkspaceService) {
  return work.saveModel(s(), {
    name: "file embedding",
    provider: "openai-compatible",
    endpoint: requireNextcloud().transportUrl + "/v1",
    model: "file-vector",
    purpose: "embedding",
    scope: "personal",
    apiKey: "synthetic-file-vector-key",
  });
}
test("Explicit file imports preserve IDs and source provenance without publishing employee content", async () => {
  const source = dav.add(
    "alice",
    ["资料", "private-file-alpha.md"],
    "file-alpha-private-sentinel",
  );
  const files = new SourceFileService(db),
    work = new WorkspaceService(db, engineRegistry());
  const listing = await files.list(s(), ["资料"]);
  assert.ok(listing.some((f) => f.id === source.id));
  const [first, same] = await Promise.all([
    files.import(s(), source.path, source.id, source.etag),
    files.import(s(), source.path, source.id, source.etag),
  ]);
  assert.equal(first.id, same.id);
  assert.equal(
    (await files.get(s(), first.id)).content,
    "file-alpha-private-sentinel",
  );
  assert.equal(
    (
      await db.pool.query("SELECT visibility FROM cw_assets WHERE id=$1", [
        first.id,
      ])
    ).rows[0].visibility,
    "private",
  );
  assert.equal(
    (await work.search(s("bob"), "file-alpha-private-sentinel")).length,
    0,
  );
  await assert.rejects(files.get(s("bob"), first.id));
  const before = embeddingInputs.length;
  await assert.rejects(new KnowledgeService(db).index(s("bob"), [first.id]));
  assert.equal(embeddingInputs.length, before);
  const profile = await fileEmbedding(work);
  await new KnowledgeService(db).index(s(), [first.id], profile.id);
  const indexed = (
    await db.pool.query("SELECT indexed_at FROM cw_assets WHERE id=$1", [
      first.id,
    ])
  ).rows[0].indexed_at;
  await files.import(s(), source.path, source.id, source.etag);
  assert.deepEqual(
    (
      await db.pool.query("SELECT indexed_at FROM cw_assets WHERE id=$1", [
        first.id,
      ])
    ).rows[0].indexed_at,
    indexed,
  );
  assert.equal(
    (
      await new KnowledgeService(db).semantic(s(), "private alpha", profile.id)
    ).some((row) => row.id === first.id),
    true,
  );
  // Renaming may retain the source ETag. An embedding for the old title must not overwrite the refreshed asset.
  duringFileEmbedding = async () => {
    source.path = ["资料", "renamed-private-file.md"];
    const renamed = await files.import(
      s(),
      source.path,
      source.id,
      source.etag,
    );
    assert.equal(renamed.id, first.id);
    assert.notEqual(renamed.sourceVersion, first.sourceVersion);
  };
  try {
    const renamed = await new KnowledgeService(db).index(
      s(),
      [first.id],
      profile.id,
    );
    assert.deepEqual(renamed.indexed, []);
    assert.deepEqual(renamed.skipped, [first.id]);
  } finally {
    duringFileEmbedding = undefined;
  }
  assert.equal(
    (
      await db.pool.query("SELECT embedding FROM cw_assets WHERE id=$1", [
        first.id,
      ])
    ).rows[0].embedding,
    null,
  );
});
test("A changed or replaced source file cannot serve old text or vectors; refresh retains the exact stable object", async () => {
  const source = dav.add("alice", ["versioned.md"], "file-version-one"),
    files = new SourceFileService(db),
    work = new WorkspaceService(db, engineRegistry()),
    knowledge = new KnowledgeService(db);
  const imported = await files.import(s(), source.path, source.id, source.etag),
    profile = await fileEmbedding(work);
  await knowledge.index(s(), [imported.id], profile.id);
  source.content = Buffer.from("file-version-two");
  source.etag = '"new-version"';
  assert.equal((await work.search(s(), "file-version-one")).length, 0);
  const stale = (
    await db.pool.query(
      "SELECT content,embedding,validity FROM cw_assets WHERE id=$1",
      [imported.id],
    )
  ).rows[0];
  assert.equal(stale.content, "");
  assert.equal(stale.embedding, null);
  assert.equal(stale.validity, "stale");
  await assert.rejects(files.get(s(), imported.id));
  assert.equal((await files.refresh(s(), imported.id)).id, imported.id);
  assert.equal((await files.get(s(), imported.id)).content, "file-version-two");
  assert.equal(
    (await knowledge.semantic(s(), "file version", profile.id)).some(
      (row) => row.id === imported.id,
    ),
    false,
  );
  const previous = source.id;
  source.id = String(dav.next++);
  source.etag = '"replacement"';
  await assert.rejects(files.refresh(s(), imported.id), /替换/);
  assert.equal((await work.search(s(), "file-version-two")).length, 0);
  const replacement = await files.import(
    s(),
    source.path,
    source.id,
    source.etag,
  );
  assert.notEqual(replacement.id, imported.id);
  assert.notEqual(source.id, previous);
});
test("Metadata-only permission and source outages never authorize cached file content", async () => {
  const source = dav.add(
      "alice",
      ["download-control.md"],
      "file-download-private-sentinel",
    ),
    files = new SourceFileService(db),
    work = new WorkspaceService(db, engineRegistry());
  const imported = await files.import(s(), source.path, source.id, source.etag);
  source.blockedDownloads.add("alice");
  assert.equal(
    (await files.list(s(), [])).some((f) => f.id === source.id),
    true,
  );
  assert.equal(
    (await work.search(s(), "file-download-private-sentinel")).length,
    0,
  );
  assert.equal(
    (
      await db.pool.query("SELECT content FROM cw_assets WHERE id=$1", [
        imported.id,
      ])
    ).rows[0].content,
    "",
  );
  source.blockedDownloads.clear();
  await files.refresh(s(), imported.id);
  dav.outage = true;
  try {
    await assert.rejects(files.get(s(), imported.id));
    assert.equal(
      (await work.search(s(), "file-download-private-sentinel")).length,
      0,
    );
    assert.equal(
      (
        await db.pool.query("SELECT content FROM cw_assets WHERE id=$1", [
          imported.id,
        ])
      ).rows[0].content,
      "file-download-private-sentinel",
    );
  } finally {
    dav.outage = false;
  }
  assert.equal(
    (await files.get(s(), imported.id)).content,
    "file-download-private-sentinel",
  );
  process.env.NEXTCLOUD_FILES_ENABLED = "false";
  try {
    assert.equal(
      (await work.search(s(), "file-download-private-sentinel")).length,
      0,
    );
  } finally {
    process.env.NEXTCLOUD_FILES_ENABLED = "true";
  }
});
test("Source revocation during embedding skips the vector write; a corrupted workspace flag cannot bypass file ownership", async () => {
  const source = dav.add(
      "alice",
      ["embedding-control.md"],
      "file-revoke-during-embedding",
    ),
    files = new SourceFileService(db),
    work = new WorkspaceService(db, engineRegistry()),
    knowledge = new KnowledgeService(db);
  const imported = await files.import(s(), source.path, source.id, source.etag),
    profile = await fileEmbedding(work);
  revokeEmbeddingFile = source;
  try {
    const result = await knowledge.index(s(), [imported.id], profile.id);
    assert.deepEqual(result.indexed, []);
    assert.deepEqual(result.skipped, [imported.id]);
  } finally {
    revokeEmbeddingFile = undefined;
  }
  assert.equal(
    (
      await db.pool.query("SELECT embedding FROM cw_assets WHERE id=$1", [
        imported.id,
      ])
    ).rows[0].embedding,
    null,
  );
  source.blockedDownloads.clear();
  await files.refresh(s(), imported.id);
  await db.pool.query(
    "UPDATE cw_assets SET visibility='workspace' WHERE id=$1",
    [imported.id],
  );
  assert.equal(
    (await work.search(s("bob"), "file-revoke-during-embedding")).length,
    0,
  );
  await assert.rejects(knowledge.index(s("bob"), [imported.id]));
});
test("A torn file read never becomes an active asset", async () => {
  const source = dav.add("alice", ["torn.md"], "old-file-snapshot"),
    files = new SourceFileService(db);
  source.afterRead = () => {
    source.content = Buffer.from("new-file-snapshot");
    source.etag = '"changed-during-read"';
  };
  await assert.rejects(
    files.import(s(), source.path, source.id, source.etag),
    /变化/,
  );
  assert.equal(
    (
      await db.pool.query(
        "SELECT asset_id FROM cw_source_files WHERE remote_file_id=$1 AND workspace_id=$2",
        [source.id, workspace],
      )
    ).rowCount,
    0,
  );
});
