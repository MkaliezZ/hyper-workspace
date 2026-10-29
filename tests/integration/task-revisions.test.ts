import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { RunInput, TaskPatch, type Subject } from "@hyper/contracts";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Use an isolated _test database.");
const db = new Database(url);
before(async () => {
  process.env.DEMO_MODE = "true";
  await db.migrate();
});
after(async () => db.close());
async function setup(execute?: any) {
  const workspaceId = randomUUID(),
    owner: Subject = {
      id: randomUUID(),
      workspaceId,
      name: "Task owner",
      role: "member",
      demo: true,
    },
    peer: Subject = { ...owner, id: randomUUID(), name: "Task peer" };
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name) VALUES($1,'Task revision synthetic fixture')",
    [workspaceId],
  );
  for (const actor of [owner, peer]) {
    await db.pool.query("INSERT INTO cw_users(id,name) VALUES($1,$2)", [
      actor.id,
      actor.name,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
      [workspaceId, actor.id],
    );
  }
  const engines = engineRegistry();
  if (execute) engines.get("fixture")!.execute = execute;
  const service = new WorkspaceService(db, engines),
    processor = new RunProcessor(service);
  const project = await service.createProject(
    owner,
    "Task revision",
    "Version-bound collaboration",
  );
  await service.message(
    owner,
    project.conversationId,
    "discussion-must-not-enter-task-model",
  );
  const task = await service.createTask(owner, project.conversationId, {
    title: "Original task",
    assignee: "Label only",
    dueDate: "2026-11-10",
  });
  const input = (key = randomUUID()) => ({
    conversationId: project.conversationId,
    engine: "fixture" as const,
    workflow: "revise_task" as const,
    taskId: task.id,
    expectedTaskVersion: 1,
    instruction: "Change the selected product task record only.",
    idempotencyKey: key,
  });
  return {
    owner,
    peer,
    service,
    processor,
    project,
    task,
    input,
    start: (key?: string) => service.startRun(owner, input(key)),
  };
}
const proposal = (args: any) => ({
  text: "Model claims actual physical work verified",
  evidence: "fixture",
  actions: [{ tool: "task.update", args }],
});

test("Task edits retain canonical versions, clear nullable dates and expose honest legacy snapshots", async () => {
  const f = await setup();
  let detail = await f.service.task(f.owner, f.task.id);
  assert.equal(detail.history.length, 1);
  assert.equal(detail.history[0].channel, "human");
  const changed = await f.service.patchTask(f.peer, f.task.id, {
    expectedVersion: 1,
    title: "Revised task",
    assignee: "New label",
    dueDate: null,
    status: "done",
  });
  assert.equal(changed.version, 2);
  assert.equal(changed.dueDate, null);
  assert.equal(changed.status, "done");
  const noop = await f.service.patchTask(f.peer, f.task.id, {
    expectedVersion: 2,
    status: "done",
  });
  assert.equal(noop.version, 2);
  assert.equal(noop.changed, false);
  await assert.rejects(
    f.service.patchTask(f.owner, f.task.id, {
      expectedVersion: 1,
      title: "Stale overwrite",
    }),
    /已更新/,
  );
  detail = await f.service.task(f.owner, f.task.id);
  assert.equal(detail.history.length, 2);
  assert.equal(detail.history[0].actorId, f.peer.id);
  assert.equal(detail.history[1].snapshot.title, "Original task");
  const legacy = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_tasks(id,workspace_id,project_id,title,created_by) VALUES($1,$2,$3,'Legacy current state',$4)",
    [legacy, f.owner.workspaceId, f.project.id, f.owner.id],
  );
  await f.service.patchTask(f.owner, legacy, {
    expectedVersion: 1,
    title: "Tracked update",
  });
  const history = (await f.service.task(f.owner, legacy)).history;
  assert.equal(history[1].channel, "legacy_snapshot");
  assert.equal(history[1].actorId, null);
  assert.equal(history[1].snapshot.title, "Legacy current state");
});

test("Concurrent task edits cannot overwrite unseen versions; direct IDs and Run targets stay scoped", async () => {
  const f = await setup(),
    other = await setup();
  const results = await Promise.allSettled([
    f.service.patchTask(f.owner, f.task.id, {
      expectedVersion: 1,
      title: "One edit",
    }),
    f.service.patchTask(f.peer, f.task.id, {
      expectedVersion: 1,
      status: "done",
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await f.service.task(f.owner, f.task.id)).history.length, 2);
  await assert.rejects(f.service.task(other.owner, f.task.id));
  await assert.rejects(
    f.service.patchTask(other.owner, f.task.id, { status: "done" }),
  );
  const project = await f.service.createProject(
    f.owner,
    "Another task project",
    "No target rebinding",
  );
  await assert.rejects(
    f.service.startRun(f.owner, {
      ...f.input(),
      conversationId: project.conversationId,
    }),
    /不存在/,
  );
  assert.equal(TaskPatch.safeParse({ expectedVersion: 1 }).success, false);
  assert.equal(
    RunInput.safeParse({ ...f.input(), actorId: f.peer.id }).success,
    false,
  );
  await assert.rejects(
    f.service.startRun(f.owner, { ...f.input(), workflow: "chat" }),
    /不接受待办/,
  );
});

test("AI edits one selected task with no discussion context and returns actual scoped audit receipts", async () => {
  let calls = 0;
  const f = await setup(async (request: any) => {
    calls++;
    assert.ok(request.context.includes("Host-bound task revision."));
    assert.ok(
      !request.context.includes("discussion-must-not-enter-task-model"),
    );
    return proposal({
      title: "AI revised label",
      assignee: "Unverified employee label",
      dueDate: null,
      status: "done",
    });
  });
  const key = randomUUID(),
    run = await f.start(key);
  await f.processor.process(run.id);
  await f.processor.process(run.id);
  const result = await f.service.getRun(f.owner, run.id);
  assert.equal(result.state, "succeeded", result.error);
  assert.equal(calls, 1);
  assert.equal(result.taskId, f.task.id);
  assert.ok(!result.result.text.includes("physical work verified"));
  assert.deepEqual(result.contextRefs, ["task:" + f.task.id + "@1"]);
  const receipt = result.result.receipts[0];
  assert.equal(receipt.id, f.task.id);
  assert.equal(receipt.version, 2);
  assert.equal(receipt.status, "done");
  const detail = await f.service.task(f.owner, f.task.id);
  assert.equal(detail.history[0].sourceRunId, run.id);
  assert.equal(detail.history[0].channel, "ai");
  assert.equal(detail.history[0].actorId, f.owner.id);
  assert.equal((await f.start(key)).id, run.id);
  await assert.rejects(f.service.getRun(f.peer, run.id));
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

test("Task versions are rechecked before model dispatch and after concurrent human edits", async () => {
  for (const during of [false, true]) {
    let calls = 0,
      f: any;
    f = await setup(async () => {
      calls++;
      if (during)
        await f.service.patchTask(f.peer, f.task.id, {
          expectedVersion: 1,
          title: "Human update during model",
        });
      return proposal({ status: "done" });
    });
    const run = await f.start();
    if (!during)
      await f.service.patchTask(f.peer, f.task.id, {
        expectedVersion: 1,
        title: "Human update before model",
      });
    await f.processor.process(run.id);
    assert.equal((await f.service.getRun(f.owner, run.id)).state, "failed");
    assert.equal(calls, during ? 1 : 0);
    const detail = await f.service.task(f.owner, f.task.id);
    assert.equal(detail.current.version, 2);
    assert.equal(detail.current.status, "open");
    assert.equal(detail.history.length, 2);
  }
});

test("Task rewrite rejects model-selected targets, versions, empty or multiple actions before writing", async () => {
  const invalid = [
    proposal({ taskId: randomUUID(), status: "done" }),
    proposal({ expectedVersion: 1, status: "done" }),
    proposal({}),
    {
      ...proposal({ status: "done" }),
      actions: [
        { tool: "task.update", args: { status: "done" } },
        { tool: "task.update", args: { title: "Extra" } },
      ],
    },
  ];
  for (const value of invalid) {
    const f = await setup(async () => value),
      run = await f.start();
    await f.processor.process(run.id);
    assert.equal((await f.service.getRun(f.owner, run.id)).state, "failed");
    assert.equal((await f.service.task(f.owner, f.task.id)).current.version, 1);
  }
});

test("Queued cancellation and live role removal prevent task revisions", async () => {
  const cancelled = await setup(),
    run = await cancelled.start();
  await cancelled.service.cancel(cancelled.owner, run.id);
  await cancelled.processor.process(run.id);
  assert.equal(
    (await cancelled.service.task(cancelled.owner, cancelled.task.id)).current
      .version,
    1,
  );
  let f: any;
  f = await setup(async () => {
    await db.pool.query(
      "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
      [f.owner.workspaceId, f.owner.id],
    );
    return proposal({ status: "done" });
  });
  const revoked = await f.start();
  await f.processor.process(revoked.id);
  assert.equal((await f.service.task(f.peer, f.task.id)).current.version, 1);
  assert.equal(
    (await db.pool.query("SELECT state FROM cw_runs WHERE id=$1", [revoked.id]))
      .rows[0].state,
    "failed",
  );
});

test("A task history storage failure rolls back the state, version and action together", async () => {
  const f = await setup(),
    suffix = randomUUID().replaceAll("-", ""),
    name = "fail_task_" + suffix;
  await db.pool.query(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.task_id='${f.task.id}' AND NEW.version=2 THEN RAISE EXCEPTION 'Synthetic task audit storage failure'; END IF; RETURN NEW; END$$`,
  );
  await db.pool.query(
    `CREATE TRIGGER ${name} BEFORE INSERT ON cw_task_versions FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );
  try {
    await assert.rejects(
      f.service.patchTask(f.owner, f.task.id, {
        expectedVersion: 1,
        status: "done",
      }),
      /audit storage failure/,
    );
    const run = await f.start();
    await f.processor.process(run.id);
    assert.equal((await f.service.getRun(f.owner, run.id)).state, "failed");
    const detail = await f.service.task(f.owner, f.task.id);
    assert.equal(detail.current.version, 1);
    assert.equal(detail.current.status, "open");
    assert.equal(detail.history.length, 1);
    assert.equal(
      (
        await db.pool.query("SELECT id FROM cw_actions WHERE run_id=$1", [
          run.id,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await db.pool.query(`DROP TRIGGER ${name} ON cw_task_versions`);
    await db.pool.query(`DROP FUNCTION ${name}()`);
  }
});
