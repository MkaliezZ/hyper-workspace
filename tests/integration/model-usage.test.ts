import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import {
  ModelService,
  complete,
  embed,
} from "../../apps/api/src/core/models.js";
import { ModelUsageService } from "../../apps/api/src/core/model-usage.js";
import { RunModelGateway } from "../../apps/api/src/core/model-gateway.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import type { Subject } from "@hyper/contracts";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Use isolated _test database.");
const db = new Database(url);
before(async () => {
  process.env.DEMO_MODE = "true";
  await db.migrate();
});
after(async () => db.close());
async function setup(t: any, mode = "json") {
  const requests: any[] = [];
  let responseMode = mode;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const c of req) text += c;
    const body = JSON.parse(text);
    requests.push({ body, authorization: req.headers.authorization });
    if (responseMode === "error") {
      res.writeHead(429);
      res.end('{"error":"upstream-private-error-key"}');
      return;
    }
    if (
      responseMode === "stream" ||
      responseMode === "partial" ||
      responseMode === "hang"
    ) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        'data: {"choices":[{"delta":{"content":"Synthetic reply"}}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n',
      );
      if (responseMode === "hang") return;
      if (responseMode === "stream") res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/embeddings")
      res.end(
        JSON.stringify({
          data: body.input.map((_: any, i: number) => ({
            index: i,
            embedding: [1, 2],
          })),
          usage: { prompt_tokens: 3, total_tokens: 3 },
        }),
      );
    else
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "OK" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            total_tokens: 16,
            prompt_tokens_details: { cached_tokens: 3 },
          },
        }),
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as any).port,
    workspaceId = randomUUID();
  const actor: Subject = {
      id: randomUUID(),
      name: "Usage owner",
      workspaceId,
      role: "admin",
      demo: true,
    },
    peer: Subject = {
      ...actor,
      id: randomUUID(),
      role: "member",
      name: "Usage peer",
    };
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name) VALUES($1,'Synthetic model usage')",
    [workspaceId],
  );
  for (const s of [actor, peer]) {
    await db.pool.query("INSERT INTO cw_users(id,name) VALUES($1,$2)", [
      s.id,
      s.name,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role) VALUES($1,$2,$3)",
      [workspaceId, s.id, s.role],
    );
  }
  const service = new WorkspaceService(db, engineRegistry()),
    project = await service.createProject(
      actor,
      "Usage test",
      "Observe actual request metadata",
    );
  const key = "synthetic-usage-key-" + randomUUID();
  const profile = await service.saveModel(actor, {
    name: "Usage connection",
    provider: "openai-compatible",
    endpoint: `http://127.0.0.1:${port}/v1`,
    model: "usage-fixture",
    apiKey: key,
    purpose: "chat",
    scope: "personal",
  });
  const connection = await new ModelService(db).resolve(
      actor,
      "chat",
      profile.id,
    ),
    runId = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,idempotency_key,input_hash,demo,model_profile_id,state) VALUES($1,$2,$3,$4,'dsh','chat','Synthetic usage run',$6,'synthetic',true,$5,'running')",
    [runId, workspaceId, actor.id, project.conversationId, profile.id, runId],
  );
  return {
    actor,
    peer,
    service,
    project,
    profile,
    key,
    connection,
    runId,
    requests,
    setMode: (v: string) => {
      responseMode = v;
    },
    usage: new ModelUsageService(db),
  };
}
const send = (model: any, body: any = {}) =>
  fetch(model.endpoint + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + model.apiKey,
    },
    body: JSON.stringify({
      model: model.model,
      messages: [
        { role: "user", content: "private-prompt-must-not-be-in-ledger" },
      ],
      max_tokens: 4096,
      ...body,
    }),
  });
test("Direct verification and embedding record provider usage without keys, prompts, fabricated output or peer access", async (t) => {
  const f = await setup(t);
  assert.equal(
    await complete(f.connection, "private-prompt-must-not-be-in-ledger", 64),
    "OK",
  );
  await new ModelService(db).verify(f.actor, f.profile.id);
  const vectorProfile = await f.service.saveModel(f.actor, {
    name: "Vector",
    provider: "openai-compatible",
    endpoint: f.connection.endpoint,
    model: "vector-fixture",
    apiKey: f.key,
    purpose: "embedding",
    scope: "personal",
  });
  const vectors = await embed(
    await new ModelService(db).resolve(f.actor, "embedding", vectorProfile.id),
    ["private-vector-input"],
  );
  assert.deepEqual(vectors, [[1, 2]]);
  const view = await f.usage.view(f.actor);
  assert.equal(view.summary.requests, 3);
  assert.equal(view.summary.reported, 3);
  assert.equal(view.summary.reportedInputTokens, 27);
  assert.equal(view.summary.reportedOutputTokens, 8);
  assert.equal(
    view.rows.find((x) => x.purpose === "embedding")!.outputTokens,
    null,
  );
  const encoded = JSON.stringify(
    (
      await db.pool.query(
        "SELECT * FROM cw_model_requests WHERE workspace_id=$1",
        [f.actor.workspaceId],
      )
    ).rows,
  );
  for (const secret of [
    f.key,
    "private-prompt-must-not-be-in-ledger",
    "private-vector-input",
  ])
    assert.equal(encoded.includes(secret), false);
  assert.equal((await f.usage.view(f.peer)).summary.requests, 0);
});
test("Loopback gateway pins the configured model, upstream credential and output cap and admits only bound authenticated endpoints", async (t) => {
  const f = await setup(t),
    gateway = new RunModelGateway(
      f.connection,
      f.runId,
      new AbortController().signal,
      async () => ({ maxOutputTokens: 128 }),
    );
  const model = await gateway.start();
  t.after(() => gateway.close());
  assert.notEqual(model.apiKey, f.key);
  assert.equal((await send({ ...model, apiKey: "wrong" })).status, 401);
  assert.equal((await send(model, { model: "different" })).status, 400);
  assert.equal((await send(model, { tools: [{ name: "shell" }] })).status, 400);
  assert.equal(
    (
      await fetch(model.endpoint + "/embeddings", {
        method: "POST",
        headers: { Authorization: "Bearer " + model.apiKey },
      })
    ).status,
    404,
  );
  assert.equal(f.requests.length, 0);
  const response = await send(model);
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(f.requests[0].authorization, "Bearer " + f.key);
  assert.equal(f.requests[0].body.max_tokens, 128);
  const view = await f.usage.view(f.actor);
  assert.equal(view.summary.requests, 1);
  assert.equal(view.rows[0].runId, f.runId);
  assert.equal(view.rows[0].usageStatus, "reported");
  assert.equal(
    (await f.service.getRun(f.actor, f.runId)).modelUsage.requests,
    1,
  );
  const events = await f.service.events(f.actor, f.runId);
  assert.equal(
    events.filter(
      (e) => e.kind === "usage.updated" && e.data.kind === "provider-response",
    ).length,
    1,
  );
});
test("Streaming, missing terminal frames and HTTP rejection preserve distinct actual usage and unknown outcomes", async (t) => {
  const f = await setup(t, "stream"),
    gateway = new RunModelGateway(
      f.connection,
      f.runId,
      new AbortController().signal,
      async () => ({ maxOutputTokens: 128 }),
    );
  const model = await gateway.start();
  t.after(() => gateway.close());
  await (await send(model, { stream: true })).text();
  f.setMode("partial");
  await (await send(model, { stream: true })).text();
  f.setMode("error");
  const rejected = await send(model);
  assert.equal(rejected.status, 429);
  assert.equal(
    (await rejected.text()).includes("upstream-private-error-key"),
    false,
  );
  const view = await f.usage.view(f.actor);
  assert.equal(view.summary.requests, 3);
  assert.equal(view.summary.reported, 1);
  assert.equal(view.summary.incomplete, 2);
  assert.ok(
    view.rows.some(
      (x) => x.usageStatus === "partial" && x.transport === "unknown",
    ),
  );
  assert.ok(
    view.rows.some(
      (x) =>
        x.usageStatus === "unknown" &&
        x.transport === "rejected" &&
        x.inputTokens === null,
    ),
  );
});
test("Cancellation and live scope loss close model access while retaining the already attempted request", async (t) => {
  const f = await setup(t, "hang"),
    abort = new AbortController();
  let allowed = true;
  const gateway = new RunModelGateway(
    f.connection,
    f.runId,
    abort.signal,
    async () => {
      if (!allowed) throw Error("scope revoked");
      return { maxOutputTokens: 128 };
    },
  );
  const model = await gateway.start();
  t.after(() => gateway.close());
  const response = await send(model, { stream: true }),
    body = response.text();
  void body.catch(() => {});
  abort.abort();
  await assert.rejects(body);
  await gateway.close();
  let view = await f.usage.view(f.actor);
  assert.equal(view.summary.requests, 1);
  assert.equal(view.rows[0].transport, "unknown");
  assert.equal(view.rows[0].usageStatus, "partial");
  const next = new RunModelGateway(
    f.connection,
    f.runId,
    new AbortController().signal,
    async () => {
      if (!allowed) throw Error("scope revoked");
      return { maxOutputTokens: 128 };
    },
  );
  const nextModel = await next.start();
  t.after(() => next.close());
  allowed = false;
  assert.equal((await send(nextModel)).status, 502);
  assert.equal(f.requests.length, 1);
  view = await f.usage.view(f.actor);
  assert.equal(view.summary.requests, 1);
  await db.pool.query(
    "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [f.actor.workspaceId, f.actor.id],
  );
  await assert.rejects(f.usage.view(f.actor));
});
test("AI usage readback is personal, host-grounded and cannot choose another employee or publish model claims", async (t) => {
  const f = await setup(t);
  await complete(f.connection, "synthetic", 64);
  await f.service.message(
    f.actor,
    f.project.conversationId,
    "discussion-private-marker-must-not-enter-usage-context",
  );
  let malicious = false;
  f.service.engines.get("fixture")!.execute = async (r) => {
    assert.ok(!r.context.includes("discussion-private-marker"));
    return {
      text: "Invented zero currency invoice",
      actions: [
        { tool: "usage.report", args: malicious ? { actorId: f.peer.id } : {} },
      ],
      evidence: "fixture",
    };
  };
  const processor = new RunProcessor(f.service);
  for (const bad of [false, true]) {
    malicious = bad;
    const run = await f.service.startRun(f.actor, {
      conversationId: f.project.conversationId,
      workflow: "usage_report",
      engine: "fixture",
      instruction: "Read my real ledger.",
      idempotencyKey: randomUUID(),
    });
    await processor.process(run.id);
    const result = await f.service.getRun(f.actor, run.id);
    assert.equal(result.state, bad ? "failed" : "succeeded", result.error);
    if (!bad) {
      assert.equal(result.result.receipts[0].summary.requests, 1);
      assert.equal(result.result.text.includes("Invented"), false);
    }
    await assert.rejects(f.service.getRun(f.peer, run.id));
  }
  assert.equal(
    (
      await db.pool.query(
        "SELECT id FROM cw_messages WHERE conversation_id=$1 AND role='assistant'",
        [f.project.conversationId],
      )
    ).rowCount,
    0,
  );
});
test("A settlement-event storage failure retains an unknown request instead of claiming free consumption or a successful receipt", async (t) => {
  const f = await setup(t),
    name = "usage_audit_" + randomUUID().replaceAll("-", "");
  await db.pool.query(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.run_id='${f.runId}' AND NEW.kind='usage.updated' THEN RAISE EXCEPTION 'Synthetic usage event failure'; END IF; RETURN NEW; END$$`,
  );
  await db.pool.query(
    `CREATE TRIGGER ${name} BEFORE INSERT ON cw_run_events FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );
  const gateway = new RunModelGateway(
    f.connection,
    f.runId,
    new AbortController().signal,
    async () => ({ maxOutputTokens: 128 }),
  );
  try {
    const model = await gateway.start();
    await assert.rejects(async () => {
      const response = await send(model);
      await response.text();
    });
    await gateway.close();
    const view = await f.usage.view(f.actor);
    assert.equal(f.requests.length, 1);
    assert.equal(view.rows[0].usageStatus, "unknown");
    assert.equal(view.rows[0].settledAt, null);
    assert.equal(view.rows[0].inputTokens, null);
    assert.equal(
      (
        await db.pool.query("SELECT next_sequence FROM cw_runs WHERE id=$1", [
          f.runId,
        ])
      ).rows[0].next_sequence,
      1,
    );
  } finally {
    await gateway.close();
    await db.pool.query(`DROP TRIGGER ${name} ON cw_run_events`);
    await db.pool.query(`DROP FUNCTION ${name}()`);
  }
});
