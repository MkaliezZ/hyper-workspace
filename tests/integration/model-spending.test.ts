import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { ModelService, complete } from "../../apps/api/src/core/models.js";
import { ModelSpendingService } from "../../apps/api/src/core/model-spending.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { ModelSpendingPlan, type Subject } from "@hyper/contracts";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Use isolated _test database.");
const db = new Database(url);
before(async () => {
  process.env.DEMO_MODE = "true";
  await db.migrate();
});
after(() => db.close());
async function setup(t: any, shared = false) {
  let mode = "normal",
    calls = 0,
    release = () => {},
    seen = () => {};
  const arrived = new Promise<void>((resolve) => {
    seen = resolve;
  });
  const server = createServer(async (req, res) => {
    for await (const c of req) {
    }
    calls++;
    seen();
    if (mode === "hold")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "OK" } }],
        ...(mode === "missing"
          ? {}
          : {
              usage: {
                prompt_tokens: 1000,
                completion_tokens: 1000,
                total_tokens: 2000,
              },
            }),
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const workspaceId = randomUUID(),
    actor: Subject = {
      id: randomUUID(),
      name: "Spending owner",
      workspaceId,
      role: "admin",
      demo: true,
    },
    peer: Subject = {
      ...actor,
      id: randomUUID(),
      role: "member",
      name: "Spending peer",
    };
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name) VALUES($1,'Synthetic model finance')",
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
    finance = new ModelSpendingService(db),
    project = await service.createProject(
      actor,
      "Synthetic spending project",
      "Versioned prices and admission controls",
    );
  const profile = await service.saveModel(actor, {
    name: "Finance fixture",
    provider: "openai-compatible",
    endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    model: "finance-fixture",
    apiKey: "synthetic-finance-key",
    purpose: "chat",
    scope: shared ? "workspace" : "personal",
  });
  const connection = await new ModelService(db).resolve(
    actor,
    "chat",
    profile.id,
  );
  const plan = (overrides: any = {}) =>
    ModelSpendingPlan.parse({
      operation: "configure",
      modelProfileId: profile.id,
      expectedRevision: 0,
      currency: "CNY",
      inputPerMillion: "1",
      outputPerMillion: "2",
      cacheReadPerMillion: "1",
      cacheWritePerMillion: "1",
      dailyLimit: null,
      requestReservation: "0",
      source: "Synthetic unit rates, not supplier prices",
      confirmed: true,
      ...overrides,
    });
  const save = (overrides: any = {}, s = actor, key = randomUUID()) =>
    finance.save(s, plan(overrides), key);
  const requests = async () =>
    (
      await db.pool.query(
        "SELECT * FROM cw_model_requests WHERE model_profile_id=$1 ORDER BY started_at,id",
        [profile.id],
      )
    ).rows;
  const reconcile = (request: any, amount = "0.003", overrides: any = {}) =>
    ModelSpendingPlan.parse({
      operation: "reconcile",
      requestId: request.id,
      expectedRevision: request.charge_revision,
      currency: "CNY",
      amount,
      evidence:
        "Synthetic employee-provided supplier statement, not independently verified",
      confirmed: true,
      ...overrides,
    });
  return {
    actor,
    peer,
    service,
    finance,
    project,
    profile,
    connection,
    plan,
    save,
    requests,
    reconcile,
    calls: () => calls,
    setMode: (v: string) => {
      mode = v;
    },
    arrived,
    release: () => release(),
  };
}
test("Each actual request pins its price version and currency; later price changes cannot rewrite history", async (t) => {
  const f = await setup(t);
  await f.save();
  await complete(f.connection, "Synthetic request");
  await f.save({
    expectedRevision: 1,
    inputPerMillion: "2",
    outputPerMillion: "4",
    cacheReadPerMillion: "2",
    cacheWritePerMillion: "2",
  });
  await complete(f.connection, "Another synthetic request");
  const rows = await f.requests();
  assert.equal(rows[0].price_version, 1);
  assert.equal(rows[0].estimated_cost_picos, "3000000000");
  assert.equal(rows[1].price_version, 2);
  assert.equal(rows[1].estimated_cost_picos, "6000000000");
  await assert.rejects(
    f.save({ expectedRevision: 2, currency: "USD" }),
    /币种/,
  );
  const view = await f.finance.view(f.actor);
  assert.equal(view.rows[0].balance.known, "0.009");
  assert.equal(view.rows[0].currency, "CNY");
});
test("Concurrent reservation is atomic, failed admission sends no HTTP request and completed cost releases the hold", async (t) => {
  const f = await setup(t);
  await f.save({ dailyLimit: "0.01", requestReservation: "0.01" });
  f.setMode("hold");
  const first = complete(f.connection, "Held request");
  await f.arrived;
  await assert.rejects(complete(f.connection, "Must not send"), /预算/);
  assert.equal(f.calls(), 1);
  assert.equal((await f.requests()).length, 1);
  f.setMode("normal");
  f.release();
  await first;
  let view = await f.finance.view(f.actor);
  assert.equal(view.rows[0].balance.known, "0.003");
  assert.equal(view.rows[0].balance.held, "0");
  assert.equal(view.rows[0].balance.remaining, "0.007");
  await assert.rejects(
    complete(f.connection, "Reservation still too high"),
    /预算/,
  );
  await f.save({
    expectedRevision: 1,
    dailyLimit: "0.01",
    requestReservation: "0.005",
  });
  await complete(f.connection, "Second admitted request");
  await assert.rejects(complete(f.connection, "Third must not send"), /预算/);
  assert.equal(f.calls(), 2);
});
test("Unknown charges retain reservation and freeze new requests until explicit authorized, versioned reconciliation", async (t) => {
  const f = await setup(t, true);
  await f.save({ dailyLimit: "1", requestReservation: "0.01" });
  f.setMode("missing");
  await complete(f.connection, "Unknown provider usage");
  await assert.rejects(complete(f.connection, "Blocked until review"), /未知/);
  let rows = await f.requests();
  assert.equal(rows[0].cost_status, "unknown");
  assert.equal(rows[0].reserved_picos, "10000000000");
  await assert.rejects(
    f.finance.save(f.peer, f.reconcile(rows[0]), randomUUID()),
    /管理员/,
  );
  const key = randomUUID(),
    plan = f.reconcile(rows[0], "0.005");
  const receipt = await f.finance.save(f.actor, plan, key);
  assert.equal(receipt.evidenceType, "employee-declared-not-provider-verified");
  assert.deepEqual(await f.finance.save(f.actor, plan, key), receipt);
  await assert.rejects(f.finance.save(f.actor, plan, randomUUID()), /已更新/);
  f.setMode("normal");
  await complete(f.connection, "After declared reconciliation");
  const view = await f.finance.view(f.actor);
  assert.equal(view.rows[0].balance.known, "0.008");
  assert.equal(view.rows[0].balance.held, "0");
  assert.equal(view.rows[0].balance.unknown, 0);
});
test("A cost exceeding its authorized reservation is visible and pauses subsequent spending rather than inventing a hard supplier cap", async (t) => {
  const f = await setup(t);
  await f.save({ dailyLimit: "0.02", requestReservation: "0.001" });
  await complete(f.connection, "Actual quote exceeds hold");
  const row = (await f.requests())[0];
  assert.equal(row.estimated_cost_picos, "3000000000");
  assert.equal(row.charge_review_required, true);
  await assert.rejects(
    complete(f.connection, "Stop additional spend"),
    /待核对/,
  );
  await f.finance.save(f.actor, f.reconcile(row), randomUUID());
  await f.save({
    expectedRevision: 1,
    dailyLimit: "0.02",
    requestReservation: "0.005",
  });
  await complete(f.connection, "Reviewed and increased hold");
  assert.equal((await f.requests())[1].charge_review_required, false);
  await f.save({
    expectedRevision: 2,
    dailyLimit: "0.001",
    requestReservation: "0.005",
  });
  await assert.rejects(
    complete(f.connection, "Lowered limit applies to new calls"),
    /预算/,
  );
  assert.equal(f.calls(), 2);
});
test("Unpriced history is not silently backfilled or free; pending calls cannot be reconciled and prior UTC days do not consume today's budget", async (t) => {
  const f = await setup(t);
  await complete(f.connection, "Before prices exist");
  const old = (await f.requests())[0];
  await f.save({ dailyLimit: "1", requestReservation: "0.01" });
  await assert.rejects(
    complete(f.connection, "Historical unknown blocks"),
    /未知/,
  );
  assert.equal((await f.requests())[0].price_version, null);
  await f.finance.save(f.actor, f.reconcile(old, "0.004"), randomUUID());
  await complete(f.connection, "Now explicitly reconciled");
  await db.pool.query(
    "UPDATE cw_model_requests SET started_at=now()-interval '2 days' WHERE model_profile_id=$1",
    [f.profile.id],
  );
  await f.save({
    expectedRevision: 1,
    dailyLimit: "0.01",
    requestReservation: "0.01",
  });
  await complete(f.connection, "Fresh day balance");
  const pending = (await f.requests()).at(-1)!;
  await db.pool.query(
    "UPDATE cw_model_requests SET settled_at=NULL,started_at=now() WHERE id=$1",
    [pending.id],
  );
  await assert.rejects(
    f.finance.save(f.actor, f.reconcile(pending), randomUUID()),
    /仍在进行/,
  );
});
test("AI finance operations apply only the confirmed plan, keep evidence out of model context and honor live admin loss", async (t) => {
  for (const revoke of [false, true]) {
    const f = await setup(t, true);
    let called = 0;
    f.service.engines.get("fixture")!.execute = async (r) => {
      called++;
      assert.ok(!r.context.includes("evidence-private-marker"));
      assert.ok(!r.context.includes("discussion-private-marker"));
      if (revoke)
        await db.pool.query(
          "UPDATE cw_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
          [f.actor.workspaceId, f.actor.id],
        );
      return {
        text: "Provider invoice verified (model claim)",
        actions: [{ tool: "spending.manage", args: {} }],
        evidence: "fixture",
      };
    };
    await f.service.message(
      f.actor,
      f.project.conversationId,
      "discussion-private-marker",
    );
    const input = {
      conversationId: f.project.conversationId,
      engine: "fixture" as const,
      workflow: "manage_spending" as const,
      instruction: "Only execute my confirmed configuration.",
      spendingPlan: f.plan({ source: "evidence-private-marker" }),
      idempotencyKey: randomUUID(),
    };
    const run = await f.service.startRun(f.actor, input);
    await new RunProcessor(f.service).process(run.id);
    const result = await f.service.getRun(f.actor, run.id);
    assert.equal(result.state, revoke ? "failed" : "succeeded", result.error);
    assert.equal(called, 1);
    if (!revoke) {
      assert.equal(result.result.receipts[0].revision, 1);
      assert.equal(
        result.result.text.includes("Provider invoice verified"),
        false,
      );
      assert.equal((await f.service.startRun(f.actor, input)).id, run.id);
      f.setMode("missing");
      await complete(
        f.connection,
        "Synthetic unknown charge for AI reconciliation",
      );
      const unknown = (await f.requests())[0];
      const review = await f.service.startRun(f.actor, {
        ...input,
        idempotencyKey: randomUUID(),
        spendingPlan: f.reconcile(unknown, "0.000000000001", {
          evidence: "evidence-private-marker",
        }),
      });
      await new RunProcessor(f.service).process(review.id);
      const reviewed = await f.service.getRun(f.actor, review.id);
      assert.equal(reviewed.state, "succeeded", reviewed.error);
      assert.equal(reviewed.result.receipts[0].amount, "0.000000000001");
      assert.equal((await f.requests())[0].declared_cost_picos, "1");
      f.service.engines.get("fixture")!.execute = async () => ({
        text: "Choose a different currency",
        actions: [
          { tool: "spending.manage", args: { currency: "USD", amount: "0" } },
        ],
        evidence: "fixture",
      });
      const malicious = await f.service.startRun(f.actor, {
        ...input,
        idempotencyKey: randomUUID(),
        spendingPlan: f.plan({ expectedRevision: 1 }),
      });
      await new RunProcessor(f.service).process(malicious.id);
      assert.equal(
        (await f.service.getRun(f.actor, malicious.id)).state,
        "failed",
      );
      assert.equal((await f.finance.view(f.actor)).rows[0].revision, 1);
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
  }
});
test("Current roles and profile ownership govern finance; audit failure rolls back prices, budgets and canonical receipts together", async (t) => {
  const f = await setup(t),
    other = await setup(t);
  await assert.rejects(f.finance.save(f.peer, f.plan(), randomUUID()));
  await assert.rejects(other.finance.save(other.actor, f.plan(), randomUUID()));
  assert.equal((await f.finance.view(f.peer)).rows.length, 0);
  const name = "finance_journal_" + randomUUID().replaceAll("-", "");
  await db.pool.query(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.workspace_id='${f.actor.workspaceId}' THEN RAISE EXCEPTION 'Synthetic finance journal failure'; END IF; RETURN NEW; END$$`,
  );
  await db.pool.query(
    `CREATE TRIGGER ${name} BEFORE INSERT ON cw_model_spend_actions FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );
  try {
    await assert.rejects(f.save(), /journal failure/);
    assert.equal(
      (
        await db.pool.query(
          "SELECT version FROM cw_model_price_versions WHERE model_profile_id=$1",
          [f.profile.id],
        )
      ).rowCount,
      0,
    );
    assert.equal((await f.finance.view(f.actor)).rows[0].revision, 0);
  } finally {
    await db.pool.query(`DROP TRIGGER ${name} ON cw_model_spend_actions`);
    await db.pool.query(`DROP FUNCTION ${name}()`);
  }
});
test("A demotion during a finance read cannot return the administrator's old request or evidence history", async (t) => {
  const f = await setup(t, true);
  await f.save();
  await complete(f.connection, "Synthetic company model request");
  const pool = db.pool as any,
    original = pool.query.bind(pool);
  let changed = false;
  pool.query = async (...args: any[]) => {
    const result = await original(...args);
    if (
      !changed &&
      String(args[0]).includes("cw_model_spend_actions a JOIN") &&
      args[1]?.[0] === f.profile.id
    ) {
      changed = true;
      await original(
        "UPDATE cw_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
        [f.actor.workspaceId, f.actor.id],
      );
    }
    return result;
  };
  try {
    await assert.rejects(f.finance.view(f.actor), /查看权限已变化/);
  } finally {
    pool.query = original;
  }
  const view = await f.finance.view(f.actor);
  assert.equal(view.rows[0].canManage, false);
  assert.deepEqual(view.rows[0].requests, []);
  assert.deepEqual(view.rows[0].history, []);
  assert.equal(view.rows[0].source, undefined);
});
