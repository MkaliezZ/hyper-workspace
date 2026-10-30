import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { WorkBriefService } from "../../apps/api/src/core/work-briefs.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { RunInput, WorkBriefContent, type Subject } from "@hyper/contracts";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Use isolated _test database.");
const db = new Database(url);
before(async () => {
  process.env.DEMO_MODE = "true";
  await db.migrate();
});
after(() => db.close());
const draft = {
  title: "Synthetic project delivery",
  goal: "Produce a usable plan",
  scope: "Only this authorized project",
  constraints: "No external sends",
  completionCriteria: "Editable plan and factual receipts",
  questions: ["Who uses the result?"],
};
async function setup(execute?: any) {
  const workspaceId = randomUUID(),
    owner: Subject = {
      id: randomUUID(),
      workspaceId,
      name: "Brief owner",
      role: "member",
      demo: true,
    },
    peer = { ...owner, id: randomUUID(), name: "Brief peer" };
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name) VALUES($1,'Work brief synthetic fixture')",
    [workspaceId],
  );
  for (const s of [owner, peer]) {
    await db.pool.query("INSERT INTO cw_users(id,name) VALUES($1,$2)", [
      s.id,
      s.name,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
      [workspaceId, s.id],
    );
  }
  const engines = engineRegistry();
  if (execute) engines.get("fixture")!.execute = execute;
  const service = new WorkspaceService(db, engines),
    briefs = new WorkBriefService(db),
    processor = new RunProcessor(service);
  const project = await service.createProject(
    owner,
    "Brief synthetic project",
    "Persist understanding and confirmations",
  );
  await service.message(
    owner,
    project.conversationId,
    "discussion-not-authorized-for-brief-context",
  );
  const save = (
    plan: any,
    content: any = undefined,
    key = randomUUID(),
    s = owner,
  ) => briefs.save(s, project.id, plan, content, key);
  const create = () => save({ operation: "create" }, draft);
  const detail = (id: string, s = owner) => briefs.get(s, project.id, id);
  const start = (plan: any, key = randomUUID()) =>
    service.startRun(
      owner,
      RunInput.parse({
        conversationId: project.conversationId,
        engine: "fixture",
        workflow: "manage_brief",
        briefPlan: plan,
        instruction:
          "Organize the explicit goal; unknown details require employee answers.",
        idempotencyKey: key,
      }),
    );
  const run = async (plan: any) => {
    const r = await start(plan);
    await processor.process(r.id);
    return service.getRun(owner, r.id);
  };
  async function ready() {
    const b = await create();
    let d = await detail(b.briefId);
    const a = await save({
      operation: "answer",
      briefId: b.briefId,
      expectedVersion: b.version,
      answers: [
        {
          questionId: d.current.questions[0].id,
          answer: "Project planning team",
        },
      ],
    });
    return save({
      operation: "confirm",
      briefId: b.briefId,
      expectedVersion: a.version,
      confirmed: true,
    });
  }
  return {
    owner,
    peer,
    service,
    briefs,
    processor,
    project,
    engines,
    save,
    create,
    detail,
    start,
    run,
    ready,
  };
}
test("Briefs require explicit scope, criteria and employee answers; versions, replay and project binding persist", async () => {
  const f = await setup(),
    b = await f.create();
  let d = await f.detail(b.briefId);
  assert.equal(d.current.status, "needs_input");
  assert.equal(d.history.length, 1);
  await assert.rejects(
    f.save({
      operation: "confirm",
      briefId: b.briefId,
      expectedVersion: 1,
      confirmed: true,
    }),
    /澄清/,
  );
  await assert.rejects(
    f.briefs.reference(db.pool, f.owner, f.project.id, {
      id: b.briefId,
      version: 1,
    }),
    /未确认/,
  );
  const plan = {
      operation: "answer",
      briefId: b.briefId,
      expectedVersion: 1,
      answers: [{ questionId: d.current.questions[0].id, answer: "Team A" }],
    },
    key = randomUUID();
  const answer = await f.save(plan, undefined, key);
  assert.equal(answer.version, 2);
  assert.deepEqual(await f.save(plan, undefined, key), answer);
  await assert.rejects(
    f.save(
      { ...plan, answers: [{ ...plan.answers[0], answer: "Changed" }] },
      undefined,
      key,
    ),
    /幂等/,
  );
  await assert.rejects(
    f.save(
      { operation: "revise", briefId: b.briefId, expectedVersion: 1 },
      draft,
    ),
    /已更新/,
  );
  const confirmed = await f.save({
    operation: "confirm",
    briefId: b.briefId,
    expectedVersion: 2,
    confirmed: true,
  });
  assert.equal(confirmed.status, "confirmed");
  const ref = { id: b.briefId, version: confirmed.version };
  assert.equal(
    (await f.briefs.reference(db.pool, f.peer, f.project.id, ref)).id,
    b.briefId,
  );
  const other = await f.service.createProject(
    f.owner,
    "Other project",
    "Keep source scope",
  );
  await assert.rejects(
    f.briefs.reference(db.pool, f.owner, other.id, ref),
    /当前项目/,
  );
  await f.save(
    {
      operation: "revise",
      briefId: b.briefId,
      expectedVersion: confirmed.version,
    },
    { ...draft, title: "Changed title" },
  );
  d = await f.detail(b.briefId);
  assert.equal(d.current.questions[0].answer, "Team A");
  assert.equal(d.current.confirmed_by, null);
  assert.equal(d.current.status, "draft");
  await assert.rejects(
    f.briefs.reference(db.pool, f.owner, f.project.id, ref),
    /未确认/,
  );
  const updated = await f.save(
    {
      operation: "revise",
      briefId: b.briefId,
      expectedVersion: d.current.version,
    },
    { ...draft, questions: ["A different decision?"] },
  );
  d = await f.detail(updated.briefId);
  assert.equal(d.current.questions[0].answer, null);
  assert.equal(d.current.status, "needs_input");
  const incomplete = await f.save(
    { operation: "create" },
    { ...draft, scope: "", completionCriteria: "", questions: [] },
  );
  await assert.rejects(
    f.save({
      operation: "confirm",
      briefId: incomplete.briefId,
      expectedVersion: 1,
      confirmed: true,
    }),
    /范围/,
  );
});
test("Current maintainer/admin rights and membership control writes, confirmations and private-source reads", async () => {
  const f = await setup(),
    b = await f.create();
  assert.equal((await f.detail(b.briefId, f.peer)).canManage, false);
  await assert.rejects(
    f.save(
      { operation: "reopen", briefId: b.briefId, expectedVersion: 1 },
      undefined,
      randomUUID(),
      { ...f.peer, role: "admin" },
    ),
    /维护人/,
  );
  await db.pool.query(
    "UPDATE cw_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",
    [f.owner.workspaceId, f.peer.id],
  );
  await f.save(
    { operation: "reopen", briefId: b.briefId, expectedVersion: 1 },
    undefined,
    randomUUID(),
    f.peer,
  );
  await db.pool.query(
    "UPDATE cw_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
    [f.owner.workspaceId, f.peer.id],
  );
  await assert.rejects(
    f.save(
      {
        operation: "confirm",
        briefId: b.briefId,
        expectedVersion: 2,
        confirmed: true,
      },
      undefined,
      randomUUID(),
      { ...f.peer, role: "admin" },
    ),
    /维护人/,
  );
  await db.pool.query(
    "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [f.owner.workspaceId, f.owner.id],
  );
  await assert.rejects(f.detail(b.briefId), /revoked|撤销/);
  await assert.rejects(
    f.save({ operation: "reopen", briefId: b.briefId, expectedVersion: 2 }),
    /revoked|撤销/,
  );
  assert.equal(
    (
      await db.pool.query("SELECT version FROM cw_work_briefs WHERE id=$1", [
        b.briefId,
      ])
    ).rows[0].version,
    2,
  );
});
test("AI draft, exact employee answer/confirmation and pinned execution use shared product objects and receipts", async () => {
  const f = await setup();
  const adapter = f.engines.get("fixture")!,
    execute = adapter.execute.bind(adapter);
  let sawBrief = false;
  adapter.execute = async (r) => {
    if (r.workflow === "manage_brief") {
      assert.ok(!r.context.includes("discussion-not-authorized"));
    }
    if (r.workflow === "discussion_to_minutes") {
      assert.match(r.context, /Employee-confirmed work brief/);
      assert.match(r.context, /Team with explicit answer/);
      sawBrief = true;
    }
    return execute(r);
  };
  let r = await f.run({ operation: "create" });
  assert.equal(r.state, "succeeded");
  let b = r.result.receipts[0],
    d = await f.detail(b.briefId);
  assert.equal(d.history[0].sourceRunId, r.id);
  assert.equal(d.current.status, "needs_input");
  r = await f.run({
    operation: "answer",
    briefId: b.briefId,
    expectedVersion: b.version,
    answers: [
      {
        questionId: d.current.questions[0].id,
        answer: "Team with explicit answer",
      },
    ],
  });
  assert.equal(r.state, "succeeded");
  b = r.result.receipts[0];
  r = await f.run({
    operation: "confirm",
    briefId: b.briefId,
    expectedVersion: b.version,
    confirmed: true,
  });
  assert.equal(r.state, "succeeded");
  b = r.result.receipts[0];
  const input = RunInput.parse({
    conversationId: f.project.conversationId,
    workflow: "discussion_to_minutes",
    engine: "fixture",
    instruction: "Follow the confirmed brief",
    briefRef: { id: b.briefId, version: b.version },
    idempotencyKey: randomUUID(),
  });
  const started = await f.service.startRun(f.owner, input);
  await f.processor.process(started.id);
  const result = await f.service.getRun(f.owner, started.id);
  assert.equal(result.state, "succeeded");
  assert.ok(sawBrief);
  assert.ok(
    result.contextRefs.includes("work-brief:" + b.briefId + "@" + b.version),
  );
  assert.equal(result.briefRef.version, b.version);
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM cw_messages WHERE conversation_id=$1 AND role='assistant'",
        [f.project.conversationId],
      )
    ).rows[0].n,
    1,
  );
  assert.equal((await f.service.startRun(f.owner, input)).id, started.id);
});
test("AI cannot choose answers, approval, extra writes or foreign scope; invalid workflows and unconfirmed refs fail", async () => {
  const f = await setup(async () => ({
    text: "Pretend approved",
    evidence: "fixture",
    actions: [{ tool: "brief.write", args: { ...draft, confirmed: true } }],
  }));
  const r = await f.run({ operation: "create" });
  assert.equal(r.state, "failed");
  assert.equal((await f.briefs.list(f.owner, f.project.id)).length, 0);
  f.engines.get("fixture")!.execute = async () => ({
    text: "Pretend confirmation",
    evidence: "fixture",
    actions: [{ tool: "brief.manage", args: { approved: true } }],
  });
  const b = await f.create();
  const bad = await f.run({
    operation: "confirm",
    briefId: b.briefId,
    expectedVersion: 1,
    confirmed: true,
  });
  assert.equal(bad.state, "failed");
  assert.equal((await f.detail(b.briefId)).current.version, 1);
  await assert.rejects(
    f.service.startRun(
      f.owner,
      RunInput.parse({
        conversationId: f.project.conversationId,
        workflow: "usage_report",
        engine: "fixture",
        instruction: "Bad target",
        briefRef: { id: b.briefId, version: 1 },
        idempotencyKey: randomUUID(),
      }),
    ),
    /不接受/,
  );
  await assert.rejects(
    f.service.startRun(
      f.owner,
      RunInput.parse({
        conversationId: f.project.conversationId,
        workflow: "discussion_to_minutes",
        engine: "fixture",
        instruction: "Not confirmed",
        briefRef: { id: b.briefId, version: 1 },
        idempotencyKey: randomUUID(),
      }),
    ),
    /未确认/,
  );
  await assert.rejects(
    f.service.startRun(
      f.owner,
      RunInput.parse({
        conversationId: f.project.conversationId,
        workflow: "manage_brief",
        engine: "fixture",
        instruction: "Missing plan",
        idempotencyKey: randomUUID(),
      }),
    ),
    /明确操作/,
  );
});
test("A reopened brief between preflight and the action transaction blocks real business writes", async () => {
  const f = await setup(),
    b = await f.ready();
  let intercept = false;
  const adapter = f.engines.get("fixture")!,
    execute = adapter.execute.bind(adapter);
  adapter.execute = async (r) => {
    const result = await execute(r);
    intercept = true;
    return result;
  };
  const tx = db.tx.bind(db);
  (db as any).tx = async (fn: any) => {
    if (intercept) {
      intercept = false;
      await f.save({
        operation: "reopen",
        briefId: b.briefId,
        expectedVersion: b.version,
      });
    }
    return tx(fn);
  };
  try {
    const r = await f.service.startRun(
      f.owner,
      RunInput.parse({
        conversationId: f.project.conversationId,
        workflow: "discussion_to_minutes",
        engine: "fixture",
        instruction: "Do work",
        briefRef: { id: b.briefId, version: b.version },
        idempotencyKey: randomUUID(),
      }),
    );
    await f.processor.process(r.id);
    const result = await f.service.getRun(f.owner, r.id);
    assert.equal(result.state, "failed");
    assert.match(result.error, /任务说明/);
    assert.equal(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM cw_artifacts WHERE project_id=$1",
          [f.project.id],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    (db as any).tx = tx;
  }
});
test("Concurrent edits serialize and audit failure rolls back content, version and idempotency receipt", async () => {
  const f = await setup(),
    b = await f.create();
  const plan = { operation: "revise", briefId: b.briefId, expectedVersion: 1 };
  const results = await Promise.allSettled([
    f.save(plan, { ...draft, title: "A" }),
    f.save(plan, { ...draft, title: "B" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const d = await f.detail(b.briefId),
    tx = db.tx.bind(db);
  (db as any).tx = (fn: any) =>
    tx(async (c) => {
      const query = c.query.bind(c);
      (c as any).query = (sql: any, ...args: any[]) => {
        if (
          typeof sql === "string" &&
          sql.startsWith("INSERT INTO cw_work_brief_versions")
        )
          throw Error("Synthetic audit storage failure");
        return query(sql, ...(args as any));
      };
      try {
        return await fn(c);
      } finally {
        (c as any).query = query;
      }
    });
  try {
    await assert.rejects(
      f.save(
        {
          operation: "revise",
          briefId: b.briefId,
          expectedVersion: d.current.version,
        },
        { ...draft, title: "Must rollback" },
      ),
      /audit/,
    );
  } finally {
    (db as any).tx = tx;
  }
  const after = await f.detail(b.briefId);
  assert.equal(after.current.version, d.current.version);
  assert.equal(after.current.content.title, d.current.content.title);
  assert.equal(after.history.length, 2);
});
