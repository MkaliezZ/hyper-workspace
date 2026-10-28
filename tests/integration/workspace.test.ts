import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { ModelService } from "../../apps/api/src/core/models.js";
import { KnowledgeService } from "../../apps/api/src/core/knowledge.js";
import { createServer } from "node:http";
import {
  authenticate,
  issueSession,
} from "../../apps/api/src/core/security.js";
import type { Subject, RunInput } from "@hyper/contracts";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error(
    "TEST_DATABASE_URL must point to an isolated database ending in _test.",
  );
const db = new Database(url),
  service = new WorkspaceService(db, engineRegistry()),
  processor = new RunProcessor(service);
const workspace = randomUUID(),
  otherWorkspace = randomUUID(),
  user = randomUUID(),
  colleague = randomUUID(),
  outsider = randomUUID(),
  project = randomUUID(),
  conversation = randomUUID();
const s: Subject = {
  id: user,
  name: "测试员工",
  workspaceId: workspace,
  role: "admin",
  demo: true,
};
const peer: Subject = {
  id: colleague,
  name: "另一员工",
  workspaceId: workspace,
  role: "member",
  demo: true,
};
const outside: Subject = {
  id: outsider,
  name: "外部工作区",
  workspaceId: otherWorkspace,
  role: "admin",
  demo: true,
};
before(async () => {
  process.env.DEMO_MODE = "true";
  await db.migrate();
  await db.pool.query(
    "INSERT INTO cw_users(id,name) VALUES($1,$2),($3,$4),($5,$6)",
    [user, s.name, colleague, peer.name, outsider, outside.name],
  );
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name) VALUES($1,$2),($3,$4)",
    [workspace, "集成测试", otherWorkspace, "其他工作区"],
  );
  await db.pool.query(
    "INSERT INTO cw_members(workspace_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member'),($4,$5,'admin')",
    [workspace, user, colleague, otherWorkspace, outsider],
  );
  await db.pool.query(
    "INSERT INTO cw_projects(id,workspace_id,name,goal) VALUES($1,$2,$3,$4)",
    [project, workspace, "测试项目", "验证真实数据库行为"],
  );
  await db.pool.query(
    "INSERT INTO cw_conversations(id,workspace_id,project_id) VALUES($1,$2,$3)",
    [conversation, workspace, project],
  );
  await service.message(s, conversation, "接口契约由测试员工负责，周五交付。");
});
after(async () => {
  await db.close();
});
test("Authorized workspace loads messages, tasks and artifacts together", async () => {
  const view = await service.view(s, project);
  assert.equal(view.project.id, project);
  assert.equal(view.messages[0]?.content, "接口契约由测试员工负责，周五交付。");
  assert.ok(Array.isArray(view.tasks));
  assert.ok(Array.isArray(view.artifacts));
});
test("Workspace isolation holds for direct object IDs", async () => {
  await assert.rejects(service.conversation(outside, conversation));
  await assert.rejects(service.view(outside, project));
});
test("Model profiles enforce personal priority, purpose and live workspace authorization", async () => {
  process.env.CREDENTIAL_MASTER_KEY ??= "ab".repeat(32);
  const models = new ModelService(db);
  const input = {
    name: "测试连接",
    provider: "openai-compatible",
    endpoint: "http://127.0.0.1:1/v1",
    model: "test-model",
    purpose: "chat",
  };
  const shared = await service.saveModel(s, {
    ...input,
    scope: "workspace",
    apiKey: "shared-test-key",
  });
  const personal = await service.saveModel(s, {
    ...input,
    scope: "personal",
    apiKey: "personal-test-key",
  });
  assert.equal((await models.resolve(s, "chat")).apiKey, "personal-test-key");
  assert.equal((await models.resolve(peer, "chat")).id, shared.id);
  await assert.rejects(models.resolve(peer, "chat", personal.id));
  await assert.rejects(models.resolve(outside, "chat", shared.id));
  await assert.rejects(models.resolve(s, "embedding", personal.id));
  await assert.rejects(
    service.saveModel(
      { ...peer, role: "admin" },
      { ...input, scope: "workspace" },
    ),
  );
  assert.equal(
    JSON.stringify(await service.models(s)).includes("personal-test-key"),
    false,
  );
});
test("Private knowledge is filtered before it reaches a model", async () => {
  const id = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_assets(id,workspace_id,project_id,owner_id,visibility,title,content,type,source_version) VALUES($1,$2,$3,$4,'private','私有测试','private-test-knowledge','text','1')",
    [id, workspace, project, user],
  );
  assert.equal(
    (await service.search(peer, "private-test-knowledge")).length,
    0,
  );
  assert.equal((await service.search(s, "private-test-knowledge")).length, 1);
  await db.pool.query("UPDATE cw_assets SET deleted_at=now() WHERE id=$1", [
    id,
  ]);
  assert.equal((await service.search(s, "private-test-knowledge")).length, 0);
});
test("pgvector retrieval excludes private, revoked, stale and deleted assets across model spaces", async () => {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: body.input.map((_: unknown, index: number) => ({
          index,
          embedding: [1, 0, 0],
        })),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const input = {
      name: "向量契约测试",
      provider: "openai-compatible",
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      model: "test-embedding",
      purpose: "embedding",
      scope: "workspace",
    };
    const profile = await service.saveModel(s, input);
    const otherProfile = await service.saveModel(s, input);
    const a = randomUUID(),
      privateId = randomUUID(),
      stale = randomUUID();
    for (const [id, visibility] of [
      [a, "workspace"],
      [privateId, "private"],
      [stale, "workspace"],
    ])
      await db.pool.query(
        "INSERT INTO cw_assets(id,workspace_id,owner_id,visibility,title,content,type,source_version) VALUES($1,$2,$3,$4,'中文资料','项目负责人与当前进度','text','1')",
        [id, workspace, user, visibility],
      );
    const knowledge = new KnowledgeService(db);
    assert.equal(
      (await knowledge.index(s, [a, privateId, stale], profile.id)).indexed
        .length,
      3,
    );
    const matches = await knowledge.semantic(peer, "谁负责项目？", profile.id);
    assert.deepEqual(new Set(matches.map((x) => x.id)), new Set([a, stale]));
    await assert.rejects(knowledge.index(peer, [privateId], profile.id));
    assert.equal(
      (await knowledge.semantic(peer, "项目", otherProfile.id)).length,
      0,
    );
    await db.pool.query("UPDATE cw_assets SET source_version='2' WHERE id=$1", [
      stale,
    ]);
    assert.deepEqual(
      (await knowledge.semantic(peer, "项目", profile.id)).map((x) => x.id),
      [a],
    );
    await db.pool.query("UPDATE cw_assets SET deleted_at=now() WHERE id=$1", [
      a,
    ]);
    assert.equal(
      (await knowledge.semantic(peer, "项目", profile.id)).length,
      0,
    );
    const revoked = { ...peer, workspaceId: otherWorkspace };
    await assert.rejects(knowledge.semantic(revoked, "项目", profile.id));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("Task changes persist and cross-workspace updates fail", async () => {
  const t = await service.createTask(s, conversation, {
    title: "真实待办",
    assignee: "测试员工",
    dueDate: null,
  });
  assert.equal(
    (await service.patchTask(peer, t.id, { status: "done" })).status,
    "done",
  );
  await assert.rejects(service.patchTask(outside, t.id, { status: "open" }));
});
test("Idempotency cannot be reused for different instructions", async () => {
  const input: RunInput = {
    conversationId: conversation,
    workflow: "discussion_to_minutes",
    engine: "fixture",
    instruction: "生成测试纪要",
    idempotencyKey: randomUUID(),
  };
  const a = await service.startRun(s, input),
    b = await service.startRun(s, input);
  assert.equal(a.id, b.id);
  assert.equal(b.created, false);
  await assert.rejects(
    service.startRun(s, { ...input, instruction: "different" }),
  );
  await service.cancel(s, a.id);
});
test("Concurrent delivery creates one artifact and ordered events; revisions retain history", async () => {
  const run = await service.startRun(s, {
    conversationId: conversation,
    workflow: "discussion_to_minutes",
    engine: "fixture",
    instruction: "根据已知讨论生成纪要",
    idempotencyKey: randomUUID(),
  });
  await Promise.all([processor.process(run.id), processor.process(run.id)]);
  const result = await service.getRun(s, run.id);
  assert.equal(result.state, "succeeded");
  assert.equal(result.result.evidence, "fixture");
  const receipts = result.result.receipts;
  assert.equal(receipts.length, 1);
  const artifact = await service.artifact(s, receipts[0].id);
  assert.equal(artifact.current.version, 1);
  await service.revise(s, receipts[0].id, {
    expectedVersion: 1,
    content: "第二版：保留真实负责人。",
    feedback: "明确分工",
  });
  const updated = await service.artifact(s, receipts[0].id);
  assert.equal(updated.current.version, 2);
  assert.equal(updated.history.length, 2);
  const asset = (
    await db.pool.query(
      "SELECT content,source_version,embedding FROM cw_assets WHERE source_ref=$1",
      ["artifact:" + receipts[0].id],
    )
  ).rows[0];
  assert.equal(asset.content, updated.current.content);
  assert.equal(asset.source_version, "2");
  assert.equal(asset.embedding, null);
  await assert.rejects(
    service.revise(s, receipts[0].id, {
      expectedVersion: 1,
      content: "过期修改",
      feedback: "",
    }),
  );
  const events = await service.events(s, run.id);
  assert.deepEqual(
    events.map((e) => e.sequence),
    events.map((_, i) => i + 1),
  );
  await assert.rejects(service.getRun(peer, run.id));
});
test("Cancelled queued runs perform no business action", async () => {
  const run = await service.startRun(s, {
    conversationId: conversation,
    workflow: "discussion_to_minutes",
    engine: "fixture",
    instruction: "不得执行",
    idempotencyKey: randomUUID(),
  });
  await service.cancel(s, run.id);
  await processor.process(run.id);
  assert.equal((await service.getRun(s, run.id)).state, "cancelled");
  assert.equal(
    (await db.pool.query("SELECT id FROM cw_actions WHERE run_id=$1", [run.id]))
      .rowCount,
    0,
  );
});
test("Revoked membership invalidates an existing session", async () => {
  const person = randomUUID();
  await db.pool.query("INSERT INTO cw_users(id,name) VALUES($1,$2)", [
    person,
    "撤权测试",
  ]);
  await db.pool.query(
    "INSERT INTO cw_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
    [workspace, person],
  );
  const token = await issueSession(db, person, workspace, false);
  assert.equal((await authenticate(db, token)).id, person);
  await db.pool.query(
    "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [workspace, person],
  );
  await assert.rejects(authenticate(db, token));
});
