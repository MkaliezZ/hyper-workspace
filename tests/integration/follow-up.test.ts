import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import type { EngineRequest, PlannedAction, Subject } from "@hyper/contracts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Use an isolated _test database.");
const db = new Database(url);
before(async () => {
  process.env.DEMO_MODE = "true";
  await db.migrate();
});
after(async () => db.close());
async function setup() {
  const workspaceId = randomUUID();
  const s: Subject = {
    id: randomUUID(),
    workspaceId,
    name: "跟进测试员工",
    role: "admin",
    demo: true,
  };
  const peer: Subject = {
    ...s,
    id: randomUUID(),
    name: "同事",
    role: "member",
  };
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name) VALUES($1,'Follow-up synthetic test')",
    [workspaceId],
  );
  for (const actor of [s, peer]) {
    await db.pool.query("INSERT INTO cw_users(id,name) VALUES($1,$2)", [
      actor.id,
      actor.name,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role) VALUES($1,$2,$3)",
      [workspaceId, actor.id, actor.role],
    );
  }
  const service = new WorkspaceService(db, engineRegistry()),
    processor = new RunProcessor(service);
  const project = await service.createProject(
    s,
    "当前项目",
    "验证安静且有据的跟进",
  );
  const task = await service.createTask(s, project.conversationId, {
    title: "待办甲",
    assignee: "员工甲",
    dueDate: "2026-11-02",
  });
  const start = (actor = s) =>
    service.startRun(actor, {
      conversationId: project.conversationId,
      workflow: "follow_up",
      engine: "fixture",
      instruction: "检查当前待办变化。",
      idempotencyKey: randomUUID(),
    });
  const check = async (actor = s) => {
    const run = await start(actor);
    await processor.process(run.id);
    const result = await service.getRun(actor, run.id);
    assert.equal(result.state, "succeeded", result.error);
    return { run, receipt: result.result.receipts[0], result };
  };
  const messages = async () =>
    (
      await db.pool.query(
        "SELECT * FROM cw_messages WHERE conversation_id=$1 ORDER BY position",
        [project.conversationId],
      )
    ).rows;
  const baseline = async () =>
    (
      await db.pool.query(
        "SELECT * FROM cw_follow_up_baselines WHERE project_id=$1",
        [project.id],
      )
    ).rows[0];
  const stub = (
    execute?: (r: EngineRequest) => Promise<void>,
    actions?: PlannedAction[],
  ) =>
    service.engines.set("fixture", {
      id: "fixture",
      describeCapabilities: () => ({
        configured: true,
        operations: ["follow_up"],
        evidence: "test-only",
      }),
      execute: async (r) => {
        await execute?.(r);
        return {
          text: "Untrusted model: all tasks completed and external colleagues notified.",
          actions: actions ?? [{ tool: "follow_up.check", args: {} }],
          evidence: "fixture",
        };
      },
    });
  return {
    s,
    peer,
    service,
    processor,
    project,
    task,
    start,
    check,
    messages,
    baseline,
    stub,
  };
}

test("Follow-up baseline is quiet; factual task differences merge into one atomic project receipt", async () => {
  const f = await setup();
  const other = await f.service.createProject(f.s, "其他项目", "不在检查范围");
  await f.service.createTask(f.s, other.conversationId, {
    title: "private-other-project-marker",
    assignee: "别人",
    dueDate: null,
  });
  await f.service.message(
    f.s,
    f.project.conversationId,
    "source-discussion-marker-not-needed",
  );
  f.stub(async (r) => {
    assert.match(r.context, /待办甲|待办甲已更新/);
    assert.ok(!r.context.includes("private-other-project-marker"));
    assert.ok(!r.context.includes("source-discussion-marker-not-needed"));
  });
  const first = await f.check();
  assert.equal(first.receipt.reason, "baseline");
  assert.equal(first.receipt.notify, false);
  assert.equal(first.receipt.pending.length, 1);
  assert.deepEqual(first.result.contextRefs.length, 1);
  assert.equal((await f.messages()).length, 1); // Only the employee's message.
  const quiet = await f.check(f.peer);
  assert.equal(quiet.receipt.reason, "unchanged");
  assert.equal(quiet.receipt.baselineRunId, first.run.id);
  await db.pool.query(
    "UPDATE cw_tasks SET title='待办甲已更新',assignee='员工乙',due_date='2026-11-03',status='done' WHERE id=$1",
    [f.task.id],
  );
  const added = await f.service.createTask(f.s, f.project.conversationId, {
    title: "新增事项",
    assignee: "员工乙",
    dueDate: null,
  });
  const changed = await f.check();
  assert.equal(changed.receipt.reason, "changed");
  assert.deepEqual(
    changed.receipt.changes.find((c: any) => c.id === f.task.id).fields,
    ["title", "assignee", "status", "dueDate"],
  );
  assert.equal(changed.receipt.changes.length, 2);
  assert.deepEqual(
    changed.receipt.pending.map((t: any) => t.id),
    [added.id],
  );
  const notices = (await f.messages()).filter((m) => m.role === "assistant");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].id, changed.receipt.notificationMessageId);
  assert.equal(
    notices[0].metadata.receipts[0].stateDigest,
    changed.receipt.stateDigest,
  );
  assert.match(notices[0].content, /待处理 → 已完成/);
  assert.ok(!notices[0].content.includes("Untrusted model"));
  await f.processor.process(changed.run.id);
  assert.equal((await f.messages()).length, 2);
  await db.pool.query("DELETE FROM cw_tasks WHERE id=$1", [added.id]);
  const removed = await f.check();
  assert.equal(removed.receipt.changes[0].kind, "removed");
  assert.equal(removed.receipt.changes[0].after, null);
  assert.equal((await f.baseline()).last_run_id, removed.run.id);
  assert.equal((await f.check()).receipt.notify, false);
});

test("Concurrent employees share one project baseline and emit one change message", async () => {
  const f = await setup();
  await f.check();
  await f.service.patchTask(f.s, f.task.id, { status: "done" });
  const [a, b] = await Promise.all([f.start(), f.start(f.peer)]);
  await Promise.all([f.processor.process(a.id), f.processor.process(b.id)]);
  const results = await Promise.all([
    f.service.getRun(f.s, a.id),
    f.service.getRun(f.peer, b.id),
  ]);
  assert.ok(results.every((r) => r.state === "succeeded"));
  assert.deepEqual(results.map((r) => r.result.receipts[0].notify).sort(), [
    false,
    true,
  ]);
  assert.equal((await f.messages()).length, 1);
  await assert.rejects(f.service.getRun(f.peer, a.id));
  assert.equal((await f.service.view(f.peer, f.project.id)).messages.length, 1);
});

test("Follow-up ignores proposed overrides, rejects repeated actions and leaves cancelled checks quiet", async () => {
  const f = await setup();
  await assert.rejects(
    f.service.startRun(f.s, {
      conversationId: f.project.conversationId,
      workflow: "follow_up",
      engine: "fixture",
      artifactId: randomUUID(),
      instruction: "只检查待办",
      idempotencyKey: randomUUID(),
    }),
    /不接受成果目标/,
  );
  for (const actions of [
    [
      {
        tool: "follow_up.check",
        args: { projectId: randomUUID(), notify: true },
      },
    ],
    [
      { tool: "follow_up.check", args: {} },
      { tool: "follow_up.check", args: {} },
    ],
  ] as PlannedAction[][]) {
    f.stub(undefined, actions);
    const run = await f.start();
    await f.processor.process(run.id);
    assert.equal((await f.service.getRun(f.s, run.id)).state, "failed");
    assert.equal(await f.baseline(), undefined);
  }
  const run = await f.start();
  await f.service.cancel(f.s, run.id);
  await f.processor.process(run.id);
  assert.equal((await f.service.getRun(f.s, run.id)).state, "cancelled");
  assert.equal((await f.messages()).length, 0);
  const outsider = await setup();
  await assert.rejects(
    f.service.startRun(outsider.s, {
      conversationId: f.project.conversationId,
      workflow: "follow_up",
      engine: "fixture",
      instruction: "不得跨范围",
      idempotencyKey: randomUUID(),
    }),
  );
});

test("Action storage failure rolls back baseline and message; a later check reports the unconsumed change", async () => {
  const f = await setup(),
    first = await f.check();
  await f.service.patchTask(f.s, f.task.id, { status: "done" });
  const run = await f.start();
  const suffix = randomUUID().replaceAll("-", "");
  const fn = "follow_fault_" + suffix;
  await db.pool.query(
    `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id='${run.id}'::uuid THEN RAISE EXCEPTION 'Synthetic action persistence fault'; END IF; RETURN NEW; END $$`,
  );
  await db.pool.query(
    `CREATE TRIGGER ${fn} BEFORE INSERT ON cw_actions FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
  );
  try {
    await f.processor.process(run.id);
  } finally {
    await db.pool.query(`DROP TRIGGER ${fn} ON cw_actions`);
    await db.pool.query(`DROP FUNCTION ${fn}()`);
  }
  assert.equal((await f.service.getRun(f.s, run.id)).state, "failed");
  assert.equal((await f.baseline()).last_run_id, first.run.id);
  assert.equal((await f.messages()).length, 0);
  const retry = await f.check();
  assert.equal(retry.receipt.notify, true);
  assert.equal((await f.messages()).length, 1);
});

test("Host rereads task facts after model work; a post-action interruption preserves its message and receipt", async () => {
  const f = await setup();
  await f.check();
  f.stub(async () => {
    await f.service.patchTask(f.s, f.task.id, { status: "done" });
  });
  const original = f.service.access.assert.bind(f.service.access);
  f.service.access.assert = async (...args) => {
    await original(...args);
    // Simulate permission loss after the atomic business action, before Run publication.
    if ((await f.messages()).length)
      throw new Error("Synthetic source permission loss");
    return undefined;
  };
  const run = await f.start();
  await f.processor.process(run.id);
  assert.equal(
    (await db.pool.query("SELECT state FROM cw_runs WHERE id=$1", [run.id]))
      .rows[0].state,
    "recovery_required",
  );
  assert.equal((await f.messages()).length, 1);
  const action = (
    await db.pool.query("SELECT result FROM cw_actions WHERE run_id=$1", [
      run.id,
    ])
  ).rows[0];
  assert.equal(action.result.changes[0].after.status, "done");
  assert.equal(action.result.notify, true);
  f.service.access.assert = original;
  assert.equal((await f.check()).receipt.notify, false);
  assert.equal((await f.messages()).length, 1);
});

test("Oversized task scope fails before engine dispatch and database rejects mismatched workspace baselines", async () => {
  const f = await setup();
  let calls = 0;
  f.stub(async () => {
    calls++;
  });
  await db.pool.query(
    "INSERT INTO cw_tasks(id,workspace_id,project_id,title,created_by) SELECT gen_random_uuid(),$1,$2,'scope-guard',$3 FROM generate_series(1,1000)",
    [f.s.workspaceId, f.project.id, f.s.id],
  );
  const run = await f.start();
  await f.processor.process(run.id);
  const result = await f.service.getRun(f.s, run.id);
  assert.equal(result.state, "failed");
  assert.match(result.error, /1000 项待办/);
  assert.equal(calls, 0);
  assert.equal(await f.baseline(), undefined);
  const other = await setup();
  await assert.rejects(
    db.pool.query(
      "INSERT INTO cw_follow_up_baselines(project_id,workspace_id,snapshot,last_run_id) VALUES($1,$2,'[]',$3)",
      [f.project.id, other.s.workspaceId, run.id],
    ),
    /foreign key/,
  );
});
