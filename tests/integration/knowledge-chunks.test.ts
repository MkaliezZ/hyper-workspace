import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Database } from "../../apps/api/src/db/database.js";
import { KnowledgeService } from "../../apps/api/src/core/knowledge.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { KnowledgeContextService } from "../../apps/api/src/core/knowledge-context.js";
import { KnowledgePlan, RunInput } from "@hyper/contracts";
import {
  engineRegistry,
  FixtureAdapter,
} from "../../apps/api/src/engines/adapters.js";
import type { Subject } from "@hyper/contracts";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated _test database required");
const db = new Database(url),
  knowledge = new KnowledgeService(db),
  workspace = new WorkspaceService(db, engineRegistry()),
  wid = randomUUID(),
  project = randomUUID(),
  calls: string[][] = [];
let profile: string,
  otherProfile: string,
  hook: (() => Promise<void>) | undefined;
const actor: Subject = {
    id: randomUUID(),
    name: "Synthetic index owner",
    workspaceId: wid,
    role: "admin",
    demo: true,
  },
  peer: Subject = {
    ...actor,
    id: randomUUID(),
    name: "Synthetic index peer",
    role: "member",
  };
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  assert.ok(Array.isArray(body.input));
  calls.push(body.input);
  if (hook) {
    const act = hook;
    hook = undefined;
    await act();
  }
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      data: body.input.map((input: string, index: number) => ({
        index,
        embedding: input.includes("唯一目标") ? [1, 0] : [0, 1],
      })),
      usage: { prompt_tokens: 10, total_tokens: 10 },
    }),
  );
});
before(async () => {
  process.env.CREDENTIAL_MASTER_KEY = "ab".repeat(32);
  await db.migrate();
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name)VALUES($1,'Synthetic chunk index')",
    [wid],
  );
  for (const s of [actor, peer]) {
    await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
      s.id,
      s.name,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,$3)",
      [wid, s.id, s.role],
    );
  }
  await db.pool.query(
    "INSERT INTO cw_projects(id,workspace_id,name)VALUES($1,$2,'Synthetic knowledge project')",
    [project, wid],
  );
  await db.pool.query(
    "INSERT INTO cw_conversations(id,workspace_id,project_id)VALUES($1,$2,$3)",
    [randomUUID(), wid, project],
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint =
    "http://127.0.0.1:" + (server.address() as { port: number }).port + "/v1";
  for (let i = 0; i < 2; i++) {
    const row = await workspace.saveModel(actor, {
      name: "Synthetic embedding " + i,
      provider: "openai-compatible",
      endpoint,
      model: "synthetic-chunk-2d",
      purpose: "embedding",
      scope: "workspace",
      apiKey: "synthetic-chunk-key",
    });
    if (i === 0) profile = row.id;
    else otherProfile = row.id;
  }
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});
async function asset(content: string, visibility = "workspace") {
  const id = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_assets(id,workspace_id,project_id,owner_id,title,content,type,source_version,visibility)VALUES($1,$2,$3,$4,'Synthetic indexed file',$5,'text','1',$6)",
    [id, wid, project, actor.id, content, visibility],
  );
  return id;
}

test("Citation reads enforce exact version, scope, current content and whole Unicode boundaries", async () => {
  const context = new KnowledgeContextService(db),
    id = await asset("甲😀乙：精确引用", "private");
  const input = { assetId: id, sourceVersion: "1", start: 1, end: 3 };
  const row = await context.citation(actor, input);
  assert.equal(row.content, "😀");
  assert.equal(row.reference, `asset:${id}@1#chars=1-3`);
  await assert.rejects(() => context.citation(peer, input));
  await assert.rejects(() => context.citation(actor, { ...input, start: 2 }));
  await assert.rejects(() => context.citation(actor, { ...input, end: 2 }));
  await assert.rejects(() => context.citation(actor, { ...input, end: 5000 }));
  await db.pool.query(
    "UPDATE cw_assets SET source_version='2',content='新的原文' WHERE id=$1",
    [id],
  );
  await assert.rejects(() => context.citation(actor, input));
});
test("Long documents index in bounded batches, retrieve exact chunk citations across files and keep model spaces separate", async () => {
  const text =
      "Background sentence. ".repeat(2500) +
      "\n唯一目标：合成中部证据，不是整份文档摘要。\n" +
      "Ending sentence. ".repeat(3000),
    first = await asset(text),
    second = await asset("另一份共享资料包含唯一目标。");
  const before = calls.length,
    result = await knowledge.index(actor, [first, second], profile);
  assert.equal(result.indexed.length, 2);
  assert.ok(result.chunks > 32);
  assert.ok(calls.length - before >= 2);
  assert.ok(
    calls
      .slice(before)
      .every(
        (batch) =>
          batch.length <= 32 && batch.every((input) => input.length < 2400),
      ),
  );
  const found = await knowledge.semantic(peer, "唯一目标", profile),
    hit = found.find((row) => row.id === first)!;
  assert.ok(hit);
  assert.ok(hit.content.includes("合成中部证据"));
  assert.ok(hit.chunks.length <= 3);
  for (const chunk of hit.chunks) {
    assert.equal(chunk.content, text.slice(chunk.start, chunk.end));
    assert.ok(chunk.reference.includes("@1#chars="));
  }
  assert.ok(found.some((row) => row.id === second));
  assert.equal(
    (await knowledge.semantic(peer, "唯一目标", otherProfile)).length,
    0,
  );
});
test("Private data is rejected before embedding dispatch and current changes physically clear derived chunk text/vectors", async () => {
  const id = await asset("private-chunk-sentinel", "private"),
    before = calls.length;
  await assert.rejects(() => knowledge.index(peer, [id], profile));
  assert.equal(calls.length, before);
  await knowledge.index(actor, [id], profile);
  assert.ok(
    !(await knowledge.semantic(peer, "private", profile)).some(
      (row) => row.id === id,
    ),
  );
  assert.ok(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM cw_asset_chunks WHERE asset_id=$1",
        [id],
      )
    ).rows[0].n > 0,
  );
  await db.pool.query(
    "UPDATE cw_assets SET content='Changed body without same cached index' WHERE id=$1",
    [id],
  );
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM cw_asset_chunks WHERE asset_id=$1",
        [id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await db.pool.query("SELECT embedding FROM cw_assets WHERE id=$1", [id]))
      .rows[0].embedding,
    null,
  );
});
test("Source changes during the first batch stop stale later dispatch and cannot commit a partial asset index", async () => {
  const id = await asset("Long synthetic content. ".repeat(5000)),
    before = calls.length;
  hook = async () => {
    await db.pool.query(
      "UPDATE cw_assets SET source_version='2',content='new authoritative body' WHERE id=$1",
      [id],
    );
  };
  const result = await knowledge.index(actor, [id], profile);
  assert.deepEqual(result.indexed, []);
  assert.deepEqual(result.skipped, [id]);
  assert.equal(calls.length, before + 1);
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM cw_asset_chunks WHERE asset_id=$1",
        [id],
      )
    ).rows[0].n,
    0,
  );
});
test("A result read before a concurrent mutation is discarded by the final source/version check", async () => {
  const id = await asset("唯一目标：合成查询竞态。");
  await knowledge.index(actor, [id], profile);
  const original = db.pool.query.bind(db.pool);
  let changed = false;
  (db.pool as any).query = async (...args: any[]) => {
    const result = await (original as any)(...args);
    if (
      !changed &&
      typeof args[0] === "string" &&
      args[0].includes("FROM cw_asset_chunks c JOIN")
    ) {
      changed = true;
      await original("UPDATE cw_assets SET source_version='2' WHERE id=$1", [
        id,
      ]);
    }
    return result;
  };
  try {
    assert.ok(
      !(await knowledge.semantic(actor, "唯一目标", profile)).some(
        (row) => row.id === id,
      ),
    );
    assert.equal(changed, true);
  } finally {
    db.pool.query = original;
  }
});

test("Multi-file context binds selected versions and private worker answers retain real positions without publishing", async () => {
  process.env.DEMO_MODE = "true";
  const first = await asset("甲资料唯一目标：合成第一证据。"),
    second = await asset("乙资料唯一目标：合成第二证据。"),
    unselected = await asset("UNSELECTED_PRIVATE_SENTINEL", "private");
  const plan = KnowledgePlan.parse({
    query: "比较唯一目标",
    assetRefs: [
      { id: first, sourceVersion: "1" },
      { id: second, sourceVersion: "1" },
    ],
  });
  const context = await new KnowledgeContextService(db).context(actor, plan);
  assert.equal(context.sourceSummary.length, 2);
  assert.ok(context.excerpts.some((row) => row.assetId === first));
  assert.ok(context.excerpts.some((row) => row.assetId === second));
  assert.ok(!JSON.stringify(context).includes("UNSELECTED_PRIVATE_SENTINEL"));
  for (const excerpt of context.excerpts) {
    const content = (
      await db.pool.query("SELECT content FROM cw_assets WHERE id=$1", [
        excerpt.assetId,
      ])
    ).rows[0].content;
    assert.equal(excerpt.content, content.slice(excerpt.start, excerpt.end));
  }
  const conversation = (
      await db.pool.query(
        "SELECT id FROM cw_conversations WHERE project_id=$1",
        [project],
      )
    ).rows[0].id,
    before = (
      await db.pool.query(
        "SELECT count(*) FROM cw_messages WHERE conversation_id=$1",
        [conversation],
      )
    ).rows[0].count;
  const queued = await workspace.startRun(
    actor,
    RunInput.parse({
      conversationId: conversation,
      engine: "fixture",
      workflow: "query_knowledge",
      knowledgePlan: plan,
      instruction: "合成资料比较",
      idempotencyKey: randomUUID(),
    }),
  );
  await new RunProcessor(workspace).process(queued.id);
  const run = await workspace.getRun(actor, queued.id);
  assert.equal(run.state, "succeeded", run.error);
  assert.ok(run.knowledgeAnswer.content.includes(context.sourceRefs[0]));
  assert.equal(run.knowledgeAnswer.citations.length, 2);
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*) FROM cw_messages WHERE conversation_id=$1",
        [conversation],
      )
    ).rows[0].count,
    before,
  );
  await assert.rejects(() => workspace.getRun(peer, queued.id));
  await db.pool.query(
    "UPDATE cw_assets SET content='Updated source body' WHERE id=$1",
    [first],
  );
  await assert.rejects(() => workspace.getRun(actor, queued.id));
  const cleared = (
    await db.pool.query(
      "SELECT instruction,result,knowledge_answer FROM cw_runs WHERE id=$1",
      [queued.id],
    )
  ).rows[0];
  assert.equal(cleared.instruction, "");
  assert.equal(cleared.result, null);
  assert.equal(cleared.knowledge_answer, null);
  assert.ok(
    (
      await db.pool.query("SELECT result FROM cw_actions WHERE run_id=$1", [
        queued.id,
      ])
    ).rows.every((row) => !row.result.content),
  );
  assert.ok(unselected);
});
test("Source mutation during model execution and fabricated citations cannot save a private answer", async () => {
  const conversation = (
      await db.pool.query(
        "SELECT id FROM cw_conversations WHERE project_id=$1",
        [project],
      )
    ).rows[0].id,
    id = await asset("合成并发来源。"),
    plan = KnowledgePlan.parse({
      query: "说明来源",
      assetRefs: [{ id, sourceVersion: "1" }],
    });
  const adapter = new FixtureAdapter();
  adapter.execute = async (request) => {
    await db.pool.query(
      "UPDATE cw_assets SET source_version='2',content='source changed during model' WHERE id=$1",
      [id],
    );
    return {
      text: "not authoritative",
      evidence: "fixture",
      actions: [
        { tool: "knowledge.answer", args: { content: "stale answer" } },
      ],
    };
  };
  const registry = engineRegistry();
  registry.set("fixture", adapter);
  const service = new WorkspaceService(db, registry),
    processor = new RunProcessor(service),
    queued = await service.startRun(
      actor,
      RunInput.parse({
        conversationId: conversation,
        engine: "fixture",
        workflow: "query_knowledge",
        knowledgePlan: plan,
        instruction: "合成并发问答",
        idempotencyKey: randomUUID(),
      }),
    );
  await processor.process(queued.id);
  assert.equal(
    (
      await db.pool.query("SELECT knowledge_answer FROM cw_runs WHERE id=$1", [
        queued.id,
      ])
    ).rows[0].knowledge_answer,
    null,
  );
  await assert.rejects(() => service.getRun(actor, queued.id));
  const other = await asset("合成可读来源。");
  adapter.execute = async () => ({
    text: "not authoritative",
    evidence: "fixture",
    actions: [
      {
        tool: "knowledge.answer",
        args: { content: "invented [asset:" + randomUUID() + "@1#chars=0-10]" },
      },
    ],
  });
  const bad = await service.startRun(
    actor,
    RunInput.parse({
      conversationId: conversation,
      engine: "fixture",
      workflow: "query_knowledge",
      knowledgePlan: {
        query: "查询",
        assetRefs: [{ id: other, sourceVersion: "1" }],
      },
      instruction: "合成假引用",
      idempotencyKey: randomUUID(),
    }),
  );
  await processor.process(bad.id);
  const outcome = await service.getRun(actor, bad.id);
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.knowledgeAnswer, null);
});
test("Hard deletion clears dependent answers before removing source mappings", async () => {
  const id = await asset("将删除的合成来源。"),
    conversation = (
      await db.pool.query(
        "SELECT id FROM cw_conversations WHERE project_id=$1",
        [project],
      )
    ).rows[0].id;
  const queued = await workspace.startRun(
    actor,
    RunInput.parse({
      conversationId: conversation,
      engine: "fixture",
      workflow: "query_knowledge",
      knowledgePlan: { query: "说明", assetRefs: [{ id, sourceVersion: "1" }] },
      instruction: "合成删除验证",
      idempotencyKey: randomUUID(),
    }),
  );
  await new RunProcessor(workspace).process(queued.id);
  assert.equal((await workspace.getRun(actor, queued.id)).state, "succeeded");
  await db.pool.query("DELETE FROM cw_assets WHERE id=$1", [id]);
  assert.equal(
    (
      await db.pool.query("SELECT knowledge_answer FROM cw_runs WHERE id=$1", [
        queued.id,
      ])
    ).rows[0].knowledge_answer,
    null,
  );
  await assert.rejects(() => workspace.getRun(actor, queued.id));
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM cw_run_knowledge_sources WHERE run_id=$1",
        [queued.id],
      )
    ).rows[0].n,
    0,
  );
});
