import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import {
  ModelService,
  complete,
  embed,
} from "../../apps/api/src/core/models.js";
import { ModelSpendingService } from "../../apps/api/src/core/model-spending.js";
import { OrganizationBudgetService } from "../../apps/api/src/core/organization-budgets.js";
import type { Subject, OrganizationBudgetPlan } from "@hyper/contracts";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Use isolated _test database.");
const db = new Database(url);
before(async () => {
  process.env.DEMO_MODE = "true";
  await db.migrate();
});
after(() => db.close());
async function setup(t: any) {
  let mode = "normal",
    calls = 0,
    release = () => {},
    seen = () => {};
  const arrived = new Promise<void>((r) => {
    seen = r;
  });
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls++;
    seen();
    if (mode === "hold")
      await new Promise<void>((r) => {
        release = r;
      });
    const embedding = req.url?.endsWith("/embeddings");
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        ...(embedding
          ? { data: [{ index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }] }
          : {
              choices: [
                { message: { content: "Synthetic company budget response" } },
              ],
            }),
        ...(mode === "missing"
          ? {}
          : {
              usage: {
                prompt_tokens: 1000,
                ...(embedding ? {} : { completion_tokens: 1000 }),
                total_tokens: embedding ? 1000 : 2000,
              },
            }),
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    release();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const workspaceId = randomUUID(),
    actor: Subject = {
      id: randomUUID(),
      workspaceId,
      name: "Synthetic company admin",
      role: "admin",
      demo: true,
    },
    peer: Subject = {
      ...actor,
      id: randomUUID(),
      name: "Synthetic personal owner",
      role: "member",
    };
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name)VALUES($1,'Synthetic aggregate budgets')",
    [workspaceId],
  );
  for (const s of [actor, peer]) {
    await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
      s.id,
      s.name,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,$3)",
      [workspaceId, s.id, s.role],
    );
  }
  const work = new WorkspaceService(db, engineRegistry()),
    finance = new ModelSpendingService(db),
    budget = new OrganizationBudgetService(db),
    models = new ModelService(db);
  const endpoint = "http://127.0.0.1:" + (server.address() as any).port;
  const profiles = await Promise.all(
    [actor, peer].map((s) =>
      work.saveModel(s, {
        name: "Synthetic private connection",
        provider: "openai-compatible",
        endpoint,
        model: "company-budget-fixture",
        purpose: "chat",
        scope: "personal",
        apiKey: "synthetic-private-key-" + s.id,
      }),
    ),
  );
  async function price(extra: any = {}) {
    return budget.save(
      actor,
      {
        operation: "budget_price",
        provider: "openai-compatible",
        endpoint,
        model: "company-budget-fixture",
        purpose: "chat",
        expectedRevision: 0,
        currency: "USD",
        inputPerMillion: "1",
        outputPerMillion: "1",
        cacheReadPerMillion: "1",
        cacheWritePerMillion: "1",
        source: "Synthetic administrator declaration; not a supplier invoice",
        confirmed: true,
        ...extra,
      },
      randomUUID(),
    );
  }
  async function control(extra: any = {}) {
    return budget.save(
      actor,
      {
        operation: "budget_configure",
        scope: "workspace",
        projectId: null,
        expectedRevision: 0,
        currency: "USD",
        dailyLimit: "0.006",
        requestReservation: "0.004",
        confirmed: true,
        ...extra,
      },
      randomUUID(),
    );
  }
  async function call(i = 0) {
    const s = i ? peer : actor;
    return complete(
      await models.resolve(s, "chat", profiles[i]!.id),
      "Synthetic budget request",
      64,
    );
  }
  return {
    actor,
    peer,
    work,
    finance,
    budget,
    models,
    profiles,
    endpoint,
    price,
    control,
    call,
    arrived,
    mode: (x: string) => {
      mode = x;
    },
    release: () => release(),
    calls: () => calls,
  };
}
test("Independent company prices defeat personal zero prices and serialize two different connections before HTTP", async (t) => {
  const f = await setup(t);
  await f.price();
  await f.control();
  for (const [i, s] of [f.actor, f.peer].entries())
    await f.finance.save(
      s,
      {
        operation: "configure",
        modelProfileId: f.profiles[i]!.id,
        expectedRevision: 0,
        currency: "USD",
        inputPerMillion: "0",
        outputPerMillion: "0",
        cacheReadPerMillion: "0",
        cacheWritePerMillion: "0",
        dailyLimit: null,
        requestReservation: "0",
        source: "Synthetic personal zero price",
        confirmed: true,
      },
      randomUUID(),
    );
  f.mode("hold");
  const first = f.call();
  await f.arrived;
  await assert.rejects(f.call(1), /跨连接可用预算不足/);
  assert.equal(f.calls(), 1);
  f.release();
  await first;
  f.mode("normal");
  await f.call(1);
  await assert.rejects(f.call(), /跨连接可用预算不足/);
  assert.equal(f.calls(), 2);
  const state = await f.budget.view(f.actor, null);
  assert.equal(state.controls[0]!.balance.known, "0.004");
  assert.equal(
    state.costsByCurrency.find((c) => c.currency === "USD").known,
    "0.004",
  );
  assert.equal(state.charges.length, 2);
  assert.ok(state.charges.every((x) => x.estimate === "0.002"));
  const personal = (await f.finance.view(f.actor, f.profiles[0]!.id)).rows[0];
  assert.equal(personal.requests[0].estimate, "0");
});
test("Missing company approval blocks verification without an upstream request and unpriced history is not erased by enablement", async (t) => {
  const f = await setup(t);
  await f.control();
  await assert.rejects(
    f.models.verify(f.actor, f.profiles[0]!.id),
    /尚无管理员确认/,
  );
  assert.equal(f.calls(), 0);
  await f.control({ expectedRevision: 1, dailyLimit: null });
  await f.call();
  assert.equal(f.calls(), 1);
  await f.price();
  await f.control({ expectedRevision: 2 });
  await assert.rejects(f.call(), /未知/);
  assert.equal(f.calls(), 1);
  const charges = (await f.budget.view(f.actor, null)).charges;
  assert.equal(charges.length, 1);
  assert.equal(charges[0]!.status, "unpriced");
  await f.budget.save(
    f.actor,
    {
      operation: "budget_reconcile",
      requestId: charges[0]!.id,
      expectedRevision: 0,
      currency: "USD",
      amount: "0.001",
      evidence:
        "Synthetic admin statement after examining the response, not an invoice",
      confirmed: true,
    },
    randomUUID(),
  );
  await f.call();
  assert.equal(f.calls(), 2);
});
test("Partial supplier accounting pauses company budget; a personal declaration cannot clear company unknown", async (t) => {
  const f = await setup(t);
  await f.price();
  await f.control({ dailyLimit: "1" });
  f.mode("missing");
  await f.call();
  const charge = (await f.budget.view(f.actor, null)).charges[0]!;
  assert.equal(charge.status, "unknown");
  assert.equal(charge.reviewRequired, true);
  await f.finance.save(
    f.actor,
    {
      operation: "reconcile",
      requestId: charge.id,
      expectedRevision: 0,
      currency: "USD",
      amount: "0",
      evidence: "Synthetic private statement only",
      confirmed: true,
    },
    randomUUID(),
  );
  await assert.rejects(f.call(1), /未知/);
  assert.equal(f.calls(), 1);
  await assert.rejects(
    f.budget.save(
      f.peer,
      {
        operation: "budget_reconcile",
        requestId: charge.id,
        expectedRevision: 0,
        currency: "USD",
        amount: "0",
        evidence: "Unauthorized company override",
        confirmed: true,
      },
      randomUUID(),
    ),
    /仅当前工作区管理员/,
  );
  await f.budget.save(
    f.actor,
    {
      operation: "budget_reconcile",
      requestId: charge.id,
      expectedRevision: 0,
      currency: "USD",
      amount: "0.002",
      evidence: "Synthetic company declaration, no supplier invoice claim",
      confirmed: true,
    },
    randomUUID(),
  );
  f.mode("normal");
  await f.call(1);
  assert.equal(f.calls(), 2);
});
test("Company immutable price version, explicit zero, currency boundaries and same-key replay preserve their original accounting", async (t) => {
  const f = await setup(t);
  await f.price();
  await f.control({ dailyLimit: "1" });
  await f.call();
  await f.price({
    expectedRevision: 1,
    inputPerMillion: "0",
    outputPerMillion: "0",
    cacheReadPerMillion: "0",
    cacheWritePerMillion: "0",
  });
  await f.call();
  const costs = (
    await db.pool.query(
      "SELECT price_version,estimated_picos::text FROM cw_budget_charges WHERE workspace_id=$1 ORDER BY started_at",
      [f.actor.workspaceId],
    )
  ).rows;
  assert.deepEqual(
    costs.map((x) => [x.price_version, x.estimated_picos]),
    [
      [1, "2000000000"],
      [2, "0"],
    ],
  );
  const plan: OrganizationBudgetPlan = {
      operation: "budget_configure",
      scope: "workspace",
      projectId: null,
      expectedRevision: 1,
      currency: "USD",
      dailyLimit: "0",
      requestReservation: "0",
      confirmed: true,
    },
    key = randomUUID();
  const a = await f.budget.save(f.actor, plan, key),
    b = await f.budget.save(f.actor, plan, key);
  assert.deepEqual(a, b);
  await assert.rejects(
    f.budget.save(f.actor, { ...plan, dailyLimit: "1" }, key),
    /幂等键冲突/,
  );
  await assert.rejects(
    f.control({ expectedRevision: 2, currency: "CNY" }),
    /其他币种/,
  );
  await assert.rejects(f.call(), /跨连接可用预算不足/);
  assert.equal(f.calls(), 2);
  const free = await setup(t);
  await free.price({
    inputPerMillion: "0",
    outputPerMillion: "0",
    cacheReadPerMillion: "0",
    cacheWritePerMillion: "0",
  });
  await free.control({ dailyLimit: "0", requestReservation: "0" });
  await free.call();
  assert.equal(free.calls(), 1);
});

test("Zero budget and project attribution constrain host-bound Runs across connections while another project remains separate", async (t) => {
  const f = await setup(t);
  await f.price();
  await f.control({ dailyLimit: "1" });
  const p = randomUUID(),
    q = randomUUID();
  for (const id of [p, q]) {
    await db.pool.query(
      "INSERT INTO cw_projects(id,workspace_id,name)VALUES($1,$2,'Synthetic scoped spending')",
      [id, f.actor.workspaceId],
    );
    await db.pool.query(
      "INSERT INTO cw_conversations(id,workspace_id,project_id)VALUES($1,$2,$3)",
      [randomUUID(), f.actor.workspaceId, id],
    );
  }
  await f.control({
    scope: "project",
    projectId: p,
    dailyLimit: "0.004",
    requestReservation: "0.004",
  });
  const { RunModelGateway } = await import(
    "../../apps/api/src/core/model-gateway.js"
  );
  async function run(projectId: string, i = 0) {
    const s = i ? f.peer : f.actor,
      profile = f.profiles[i]!,
      id = randomUUID(),
      conversation = (
        await db.pool.query(
          "SELECT id FROM cw_conversations WHERE project_id=$1",
          [projectId],
        )
      ).rows[0].id;
    await db.pool.query(
      "INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,state,model_profile_id,idempotency_key,input_hash,demo)VALUES($1,$2,$3,$4,'dsh','discussion_to_minutes','Synthetic budget Run','running',$5,$6,'synthetic',true)",
      [id, s.workspaceId, s.id, conversation, profile.id, randomUUID()],
    );
    const gateway = new RunModelGateway(
      await f.models.resolve(s, "chat", profile.id),
      id,
      new AbortController().signal,
      async () => ({ maxOutputTokens: 64 }),
    );
    try {
      const connection = await gateway.start(),
        r = await fetch(connection.endpoint + "/chat/completions", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + connection.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: connection.model,
            messages: [{ role: "user", content: "Synthetic budget request" }],
            projectId: q,
          }),
        });
      await r.text();
      return { status: r.status, id };
    } finally {
      await gateway.close();
    }
  }
  const a = await run(p);
  assert.equal(a.status, 200);
  assert.equal(f.calls(), 1);
  assert.equal((await run(p, 1)).status, 502);
  assert.equal(f.calls(), 1);
  assert.equal((await run(q, 1)).status, 200);
  assert.equal(f.calls(), 2);
  const ledger = (
    await db.pool.query(
      "SELECT project_id,count(*)::int n FROM cw_budget_charges WHERE workspace_id=$1 GROUP BY project_id",
      [f.actor.workspaceId],
    )
  ).rows;
  assert.equal(ledger.length, 2);
  assert.ok(ledger.every((x) => x.n === 1));
  await f.control({
    scope: "project",
    projectId: q,
    expectedRevision: 0,
    dailyLimit: "0",
  });
  assert.equal((await run(q)).status, 502);
  assert.equal(f.calls(), 2);
});

test("Embedding and connection verification consume the same workspace money ledger; attributable embedding honors project limits", async (t) => {
  const f = await setup(t);
  await f.price();
  await f.price({ purpose: "embedding" });
  await f.control({ dailyLimit: "0.004", requestReservation: "0.002" });
  const model = await f.work.saveModel(f.actor, {
    name: "Synthetic embedding budget",
    provider: "openai-compatible",
    endpoint: f.endpoint,
    model: "company-budget-fixture",
    purpose: "embedding",
    scope: "personal",
    apiKey: "synthetic-embedding-key",
  });
  await embed(await f.models.resolve(f.actor, "embedding", model.id), [
    "synthetic private document",
  ]);
  await f.models.verify(f.actor, f.profiles[0]!.id);
  await assert.rejects(
    embed(await f.models.resolve(f.actor, "embedding", model.id), [
      "synthetic blocked query",
    ]),
    /跨连接可用预算不足/,
  );
  assert.equal(f.calls(), 2);
  const costs = (await f.budget.view(f.actor, null)).charges;
  assert.equal(costs.length, 2);
  assert.deepEqual(costs.map((x) => x.estimate).sort(), ["0.001", "0.002"]);
  await f.control({ expectedRevision: 1, dailyLimit: "1" });
  const projectId = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_projects(id,workspace_id,name)VALUES($1,$2,'Synthetic embedding project')",
    [projectId, f.actor.workspaceId],
  );
  await f.control({
    scope: "project",
    projectId,
    dailyLimit: "0",
    requestReservation: "0.002",
  });
  await assert.rejects(
    embed(await f.models.resolve(f.actor, "embedding", model.id, projectId), [
      "synthetic project text",
    ]),
    /跨连接可用预算不足/,
  );
  assert.equal(f.calls(), 2);
});

test("Company CAS, role recheck, cross-domain idempotency, audit rollback and private view boundaries are enforced", async (t) => {
  const f = await setup(t),
    plan: OrganizationBudgetPlan = {
      operation: "budget_configure",
      scope: "workspace",
      projectId: null,
      expectedRevision: 0,
      currency: "USD",
      dailyLimit: "1",
      requestReservation: "0.01",
      confirmed: true,
    };
  const proof = await f.budget.prepare(f.actor, plan);
  await db.pool.query(
    "UPDATE cw_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
    [f.actor.workspaceId, f.actor.id],
  );
  await assert.rejects(
    db.tx((c) =>
      f.budget.apply(c, f.actor, plan, randomUUID(), undefined, proof.proof),
    ),
    /仅当前工作区管理员/,
  );
  await assert.rejects(f.budget.view(f.actor, null), /仅当前工作区管理员/);
  await db.pool.query(
    "UPDATE cw_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",
    [f.actor.workspaceId, f.actor.id],
  );
  const key = randomUUID();
  await f.budget.save(f.actor, plan, key);
  const privatePlan = {
    operation: "configure" as const,
    modelProfileId: f.profiles[0]!.id,
    expectedRevision: 0,
    currency: "USD" as const,
    inputPerMillion: "0",
    outputPerMillion: "0",
    cacheReadPerMillion: "0",
    cacheWritePerMillion: "0",
    dailyLimit: null,
    requestReservation: "0",
    source: "Synthetic private only",
    confirmed: true as const,
  };
  await assert.rejects(f.finance.save(f.actor, privatePlan, key), /幂等键冲突/);
  const privateKey = randomUUID();
  await f.finance.save(f.actor, privatePlan, privateKey);
  await assert.rejects(
    f.budget.save(f.actor, { ...plan, expectedRevision: 1 }, privateKey),
    /幂等键冲突/,
  );
  await assert.rejects(
    f.budget.save(f.actor, plan, randomUUID()),
    /版本已变化/,
  );
  const trigger = "budget_audit_" + randomUUID().replaceAll("-", "");
  await db.pool.query(
    `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.workspace_id='${f.actor.workspaceId}'::uuid THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END$$`,
  );
  await db.pool.query(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON cw_budget_actions FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
  );
  try {
    await assert.rejects(
      f.budget.save(
        f.actor,
        { ...plan, expectedRevision: 1, dailyLimit: "0" },
        randomUUID(),
      ),
      /Synthetic audit failure/,
    );
  } finally {
    await db.pool.query(`DROP TRIGGER ${trigger} ON cw_budget_actions`);
    await db.pool.query(`DROP FUNCTION ${trigger}()`);
  }
  assert.equal((await f.budget.view(f.actor, null)).controls[0]!.revision, 1);
  const payload = JSON.stringify(await f.budget.view(f.actor, null));
  assert.ok(!payload.includes(f.profiles[1]!.id));
  assert.ok(!payload.includes("synthetic-private-key"));
  assert.ok(!payload.includes("Synthetic private only"));
});

test("Resolved connection tuples cannot race a price-approved model/address change before request admission", async (t) => {
  const f = await setup(t);
  await f.price();
  await f.control({ dailyLimit: "1" });
  const connection = await f.models.resolve(f.actor, "chat", f.profiles[0]!.id);
  await db.pool.query(
    "UPDATE cw_model_profiles SET model='different-synthetic-model' WHERE id=$1",
    [f.profiles[0]!.id],
  );
  await assert.rejects(
    complete(connection, "Synthetic stale connection", 64),
    /已不可访问/,
  );
  assert.equal(f.calls(), 0);
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int n FROM cw_budget_charges WHERE workspace_id=$1",
        [f.actor.workspaceId],
      )
    ).rows[0].n,
    0,
  );
});

test("Project rule changes require current source permission while company financial review exposes no deleted-source business content", async (t) => {
  const { createRoomManagementScope } = await import(
    "../fixtures/room-management-scope.js"
  );
  const f = await createRoomManagementScope(db);
  t.after(() => f.close());
  const work = new WorkspaceService(db, engineRegistry()),
    budget = new OrganizationBudgetService(db),
    project = await work.createTalkProject(
      f.peer,
      f.room.token,
      "Synthetic company finance source",
      "Synthetic source access intersection",
    );
  await budget.save(
    f.peer,
    {
      operation: "budget_configure",
      scope: "project",
      projectId: project.id,
      expectedRevision: 0,
      currency: "USD",
      dailyLimit: "1",
      requestReservation: "0.01",
      confirmed: true,
    },
    randomUUID(),
  );
  const profile = await work.saveModel(f.peer, {
      name: "Synthetic finance privacy",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:1",
      model: "synthetic-only",
      purpose: "chat",
      scope: "personal",
      apiKey: "synthetic-not-used",
    }),
    requestId = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_model_requests(id,workspace_id,actor_id,model_profile_id,purpose,model,provider,settled_at)VALUES($1,$2,$3,$4,'chat','synthetic-only','openai-compatible',clock_timestamp())",
    [requestId, f.peer.workspaceId, f.peer.id, profile.id],
  );
  await db.pool.query(
    "INSERT INTO cw_budget_charges(request_id,workspace_id,project_id,started_at)VALUES($1,$2,$3,clock_timestamp())",
    [requestId, f.peer.workspaceId, project.id],
  );
  f.room.people.delete("peer");
  await assert.rejects(
    budget.save(
      f.peer,
      {
        operation: "budget_configure",
        scope: "project",
        projectId: project.id,
        expectedRevision: 1,
        currency: "USD",
        dailyLimit: "0",
        requestReservation: "0",
        confirmed: true,
      },
      randomUUID(),
    ),
  );
  const companyView = await budget.view(f.peer, null),
    charge = companyView.charges.find((c) => c.id === requestId)!;
  assert.equal(charge.scope, "other-project");
  assert.equal(charge.projectId, null);
  assert.ok(!JSON.stringify(companyView).includes(project.id));
  await budget.save(
    f.peer,
    {
      operation: "budget_reconcile",
      requestId,
      expectedRevision: 0,
      currency: "USD",
      amount: "0.002",
      evidence:
        "Synthetic independent company financial statement, no source reading",
      confirmed: true,
    },
    randomUUID(),
  );
  await assert.rejects(work.conversation(f.peer, project.conversationId));
  assert.equal(
    (await budget.view(f.peer, null)).charges.find((c) => c.id === requestId)!
      .declared,
    "0.002",
  );
  assert.equal(f.source.writes.length, 0);
});

test("Company ledger paging preserves sub-millisecond timestamps and exact price lookup reaches catalogs beyond the first page", async (t) => {
  const f = await setup(t),
    requests = Array.from({ length: 105 }, () => randomUUID()),
    stamp = (
      await db.pool.query(
        "SELECT date_trunc('second',clock_timestamp())::text AS stamp",
      )
    ).rows[0].stamp;
  for (const id of requests) {
    await db.pool.query(
      "INSERT INTO cw_model_requests(id,workspace_id,actor_id,model_profile_id,purpose,model,provider,started_at,settled_at)VALUES($1,$2,$3,$4,'chat','company-budget-fixture','openai-compatible',$5::timestamptz+interval '123 microseconds',clock_timestamp())",
      [id, f.actor.workspaceId, f.actor.id, f.profiles[0]!.id, stamp],
    );
  }
  await db.pool.query(
    "INSERT INTO cw_budget_charges(request_id,workspace_id,started_at)SELECT id,workspace_id,started_at FROM cw_model_requests WHERE workspace_id=$1",
    [f.actor.workspaceId],
  );
  const first = await f.budget.view(f.actor, null),
    second = await f.budget.view(f.actor, null, { before: first.nextBefore });
  assert.equal(first.charges.length, 100);
  assert.equal(second.charges.length, 5);
  assert.equal(
    new Set([...first.charges, ...second.charges].map((x) => x.id)).size,
    105,
  );
  assert.equal(second.nextBefore, null);
  const id = second.charges[0]!.id;
  await f.budget.save(
    f.actor,
    {
      operation: "budget_reconcile",
      requestId: id,
      expectedRevision: 0,
      currency: "USD",
      amount: "0.001",
      evidence: "Synthetic historical unknown retained and reviewed",
      confirmed: true,
    },
    randomUUID(),
  );
  assert.equal(
    (await f.budget.view(f.actor, null, { requestId: id })).charges[0]!
      .declared,
    "0.001",
  );
  assert.equal(
    (
      await f.budget.view(f.actor, null, {
        pendingOnly: true,
        before: first.nextBefore,
      })
    ).charges.length,
    4,
  );
  await assert.rejects(
    f.budget.view(f.peer, null, { before: first.nextBefore }),
    /仅当前工作区管理员/,
  );
  await assert.rejects(
    f.budget.view(f.actor, null, { before: randomUUID() }),
    /分页位置已失效/,
  );
  await f.price();
  for (let i = 0; i < 105; i++)
    await f.price({ model: "synthetic-catalog-" + i });
  const catalog = await f.budget.view(f.actor, null);
  assert.equal(catalog.prices.length, 100);
  const omitted = (
    await db.pool.query(
      "SELECT * FROM cw_budget_price_versions WHERE workspace_id=$1",
      [f.actor.workspaceId],
    )
  ).rows.find((x) => !catalog.prices.some((p) => p.priceKey === x.price_key));
  assert.ok(omitted);
  assert.equal(
    (
      await f.budget.lookup(f.actor, {
        provider: omitted.provider,
        endpoint: omitted.endpoint,
        model: omitted.model,
        purpose: omitted.purpose,
      })
    ).price.revision,
    1,
  );
  const found = await f.budget.lookup(f.actor, {
    provider: "openai-compatible",
    endpoint: f.endpoint + "/",
    model: "company-budget-fixture",
    purpose: "chat",
  });
  assert.equal(found.price.revision, 1);
  assert.equal(found.price.inputPerMillion, "1");
  await assert.rejects(
    f.budget.lookup(f.peer, {
      provider: "openai-compatible",
      endpoint: f.endpoint,
      model: "company-budget-fixture",
      purpose: "chat",
    }),
    /仅当前工作区管理员/,
  );
  await assert.rejects(
    f.budget.lookup(f.actor, {
      provider: "openai-compatible",
      endpoint: "https://synthetic-secret@example.invalid",
      model: "company-budget-fixture",
      purpose: "chat",
    }),
    /不含凭据/,
  );
});

test("Unknown in-flight reservations cannot be immediately declared away and over-reservation actual estimates pause later requests", async (t) => {
  const f = await setup(t);
  await f.price();
  await f.control({ dailyLimit: "1" });
  const connection = await f.models.resolve(f.actor, "chat", f.profiles[0]!.id),
    id = await connection.accounting!.begin("verification");
  const plan: OrganizationBudgetPlan = {
    operation: "budget_reconcile",
    requestId: id,
    expectedRevision: 0,
    currency: "USD",
    amount: "0",
    evidence:
      "Synthetic crash before upstream transport; explicit fixture no-call observation",
    confirmed: true,
  };
  await assert.rejects(f.budget.save(f.actor, plan, randomUUID()), /仍在执行/);
  assert.equal(f.calls(), 0);
  await db.pool.query(
    "UPDATE cw_model_requests SET started_at=clock_timestamp()-interval '6 minutes' WHERE id=$1",
    [id],
  );
  await db.pool.query(
    "UPDATE cw_budget_charges SET started_at=clock_timestamp()-interval '6 minutes' WHERE request_id=$1",
    [id],
  );
  await f.budget.save(f.actor, plan, randomUUID());
  assert.equal(
    (await f.budget.view(f.actor, null, { requestId: id })).charges[0]!
      .declared,
    "0",
  );
  await f.price({
    expectedRevision: 1,
    inputPerMillion: "100",
    outputPerMillion: "100",
    cacheReadPerMillion: "100",
    cacheWritePerMillion: "100",
  });
  await f.call();
  assert.equal(f.calls(), 1);
  const charge = (await f.budget.view(f.actor, null)).charges.find(
    (x) => x.id !== id,
  )!;
  assert.equal(charge.estimate, "0.2");
  assert.equal(charge.reviewRequired, true);
  await assert.rejects(f.call(1), /待核对/);
  assert.equal(f.calls(), 1);
  await f.budget.save(
    f.actor,
    {
      ...plan,
      requestId: charge.id,
      amount: "0.2",
      evidence:
        "Synthetic explicit company statement, original high estimate retained",
    },
    randomUUID(),
  );
  const original = (
    await db.pool.query(
      "SELECT estimated_picos::text,declared_picos::text FROM cw_budget_charges WHERE request_id=$1",
      [charge.id],
    )
  ).rows[0];
  assert.equal(original.estimated_picos, original.declared_picos);
});

test("Multi-project indexing splits supplier batches so every known project retains its own monetary quota", async (t) => {
  const f = await setup(t);
  await f.price({ purpose: "embedding" });
  await f.control({ dailyLimit: "1", requestReservation: "0.01" });
  const profile = await f.work.saveModel(f.actor, {
    name: "Synthetic grouped embedding budget",
    provider: "openai-compatible",
    endpoint: f.endpoint,
    model: "company-budget-fixture",
    purpose: "embedding",
    scope: "personal",
    apiKey: "synthetic-grouped-key",
  });
  const projects = [randomUUID(), randomUUID()],
    assets: string[] = [];
  for (const id of projects) {
    await db.pool.query(
      "INSERT INTO cw_projects(id,workspace_id,name)VALUES($1,$2,'Synthetic indexing scope')",
      [id, f.actor.workspaceId],
    );
    await db.pool.query(
      "INSERT INTO cw_conversations(id,workspace_id,project_id)VALUES($1,$2,$3)",
      [randomUUID(), f.actor.workspaceId, id],
    );
    await f.control({
      scope: "project",
      projectId: id,
      dailyLimit: "0.01",
      requestReservation: "0.002",
    });
  }
  for (const projectId of [...projects, null]) {
    const id = randomUUID();
    assets.push(id);
    await db.pool.query(
      "INSERT INTO cw_assets(id,workspace_id,project_id,owner_id,title,content,type,source_version)VALUES($1,$2,$3,$4,'Synthetic index asset','Synthetic bounded project text','text','synthetic-v1')",
      [id, f.actor.workspaceId, projectId, f.actor.id],
    );
  }
  const { KnowledgeService } = await import(
    "../../apps/api/src/core/knowledge.js"
  );
  await new KnowledgeService(db).index(f.actor, assets, profile.id);
  assert.equal(f.calls(), 3);
  const charges = (
    await db.pool.query(
      "SELECT project_id,estimated_picos::text FROM cw_budget_charges WHERE workspace_id=$1",
      [f.actor.workspaceId],
    )
  ).rows;
  assert.equal(charges.length, 3);
  assert.deepEqual(
    charges.map((x) => x.project_id).sort(),
    [...projects, null].sort(),
  );
  assert.ok(charges.every((x) => x.estimated_picos === "1000000000"));
  await f.control({
    scope: "project",
    projectId: projects[0],
    expectedRevision: 1,
    dailyLimit: "0",
    requestReservation: "0.002",
  });
  await assert.rejects(
    new KnowledgeService(db).index(f.actor, [assets[0]!], profile.id),
    /跨连接可用预算不足/,
  );
  assert.equal(f.calls(), 3);
  const order = assets.slice(0, 2).sort();
  const firstProject = order[0] === assets[0] ? projects[0]! : projects[1]!,
    secondProject = order[1] === assets[0] ? projects[0]! : projects[1]!;
  for (const [projectId, amount] of [
    [firstProject, "1"],
    [secondProject, "0"],
  ] as const) {
    const revision = (await f.budget.view(f.actor, projectId)).controls.find(
      (c) => c.scope === "project",
    )!.revision;
    await f.control({
      scope: "project",
      projectId,
      expectedRevision: revision,
      dailyLimit: amount,
      requestReservation: "0.002",
    });
  }
  await assert.rejects(
    new KnowledgeService(db).index(f.actor, assets.slice(0, 2), profile.id),
    /此前已完成 1 批模型请求/,
  );
  assert.equal(f.calls(), 4);
});

test("A locally revoked source credential cannot admit a new model request using an already resolved personal connection", async (t) => {
  const { createRoomManagementScope } = await import(
    "../fixtures/room-management-scope.js"
  );
  const f = await createRoomManagementScope(db);
  t.after(() => f.close());
  const work = new WorkspaceService(db, engineRegistry()),
    models = new ModelService(db),
    profile = await work.saveModel(f.actor, {
      name: "Synthetic revoked model capability",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:1",
      model: "synthetic-only",
      purpose: "chat",
      scope: "personal",
      apiKey: "synthetic-never-sent",
    }),
    connection = await models.resolve(f.actor, "chat", profile.id);
  await db.pool.query(
    "UPDATE cw_identity_credentials SET disabled_at=clock_timestamp() WHERE id=$1",
    [f.actor.identityCredentialId],
  );
  await assert.rejects(
    complete(connection, "Synthetic payload must not leave host", 64),
    /身份凭据已撤销/,
  );
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int n FROM cw_model_requests WHERE workspace_id=$1",
        [f.actor.workspaceId],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(f.source.writes.length, 0);
});

test("Role loss between company Run preparation and accounting admission stops the administrative model request before HTTP", async (t) => {
  const f = await setup(t),
    projectId = randomUUID(),
    conversationId = randomUUID(),
    runId = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_projects(id,workspace_id,name)VALUES($1,$2,'Synthetic prepared company budget')",
    [projectId, f.actor.workspaceId],
  );
  await db.pool.query(
    "INSERT INTO cw_conversations(id,workspace_id,project_id)VALUES($1,$2,$3)",
    [conversationId, f.actor.workspaceId, projectId],
  );
  const plan: OrganizationBudgetPlan = {
    operation: "budget_configure",
    scope: "workspace",
    projectId: null,
    expectedRevision: 0,
    currency: "USD",
    dailyLimit: "1",
    requestReservation: "0.01",
    confirmed: true,
  };
  await f.budget.prepare(f.actor, plan);
  await db.pool.query(
    "INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,state,model_profile_id,idempotency_key,input_hash,demo,spending_plan)VALUES($1,$2,$3,$4,'dsh','manage_spending','Synthetic admin operation','running',$5,$6,'synthetic',true,$7)",
    [
      runId,
      f.actor.workspaceId,
      f.actor.id,
      conversationId,
      f.profiles[0]!.id,
      randomUUID(),
      plan,
    ],
  );
  const connection = await f.models.resolve(f.actor, "chat", f.profiles[0]!.id);
  await db.pool.query(
    "UPDATE cw_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
    [f.actor.workspaceId, f.actor.id],
  );
  await assert.rejects(
    connection.accounting!.begin("run", runId),
    /企业费用管理权限已撤销/,
  );
  assert.equal(f.calls(), 0);
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int n FROM cw_model_requests WHERE workspace_id=$1",
        [f.actor.workspaceId],
      )
    ).rows[0].n,
    0,
  );
});

test("An explicit administrator can retire a mixed-currency gate without converting or deleting the original company statements", async (t) => {
  const f = await setup(t);
  await f.call();
  await f.price();
  await f.control();
  const charge = (await f.budget.view(f.actor, null)).charges[0]!;
  await f.budget.save(
    f.actor,
    {
      operation: "budget_reconcile",
      requestId: charge.id,
      expectedRevision: 0,
      currency: "CNY",
      amount: "0.001",
      evidence: "Synthetic explicit original-currency company statement",
      confirmed: true,
    },
    randomUUID(),
  );
  await assert.rejects(f.call(), /混合币种/);
  assert.equal(f.calls(), 1);
  await f.control({ expectedRevision: 1, dailyLimit: null });
  await f.call();
  assert.equal(f.calls(), 2);
  const state = await f.budget.view(f.actor, null);
  assert.equal(state.controls[0]!.dailyLimit, null);
  assert.equal(
    state.costsByCurrency.find((c) => c.currency === "CNY").known,
    "0.001",
  );
  assert.equal(
    state.costsByCurrency.find((c) => c.currency === "USD").known,
    "0.002",
  );
  assert.equal(state.charges.find((c) => c.id === charge.id)!.currency, "CNY");
  await assert.rejects(f.control({ expectedRevision: 2 }), /其他币种/);
});
