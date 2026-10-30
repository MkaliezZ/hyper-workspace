import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { DirectoryService } from "../../apps/api/src/core/directory.js";
import { TaskAssignmentService } from "../../apps/api/src/core/task-assignments.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { RunInput, type Subject } from "@hyper/contracts";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Use isolated _test database.");
const db = new Database(url);
before(async () => {
  process.env.DEMO_MODE = "true";
  await db.migrate();
});
after(() => db.close());
async function setup() {
  const workspaceId = randomUUID(),
    owner: Subject = {
      id: randomUUID(),
      workspaceId,
      name: "Assigning employee",
      role: "member",
      demo: true,
    },
    peer = { ...owner, id: randomUUID(), name: "Same employee" },
    other = { ...owner, id: randomUUID(), name: "Same employee" };
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name)VALUES($1,'Directory synthetic fixture')",
    [workspaceId],
  );
  for (const s of [owner, peer, other]) {
    await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
      s.id,
      s.name,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,'member')",
      [workspaceId, s.id],
    );
  }
  const service = new WorkspaceService(db, engineRegistry()),
    assignments = new TaskAssignmentService(db),
    directory = new DirectoryService(db),
    processor = new RunProcessor(service),
    project = await service.createProject(
      owner,
      "Assignment fixture",
      "Real IDs and current rights",
    ),
    task = await service.createTask(owner, project.conversationId, {
      title: "Assign this task",
      assignee: "Same employee",
      dueDate: null,
    });
  const plan = (assigneeId: string | null = peer.id, expectedVersion = 1) => ({
    taskId: task.id,
    assigneeId,
    expectedVersion,
    confirmed: true as const,
  });
  const save = (p = plan(), key = randomUUID()) =>
    assignments.save(owner, project.id, p, key);
  const run = async (
    workflow: "assign_task" | "directory_report",
    p?: ReturnType<typeof plan>,
  ) => {
    const r = await service.startRun(
      owner,
      RunInput.parse({
        conversationId: project.conversationId,
        engine: "fixture",
        workflow,
        ...(p ? { taskAssignmentPlan: p } : {}),
        instruction: "Only the exact selected project and employee identity",
        idempotencyKey: randomUUID(),
      }),
    );
    await processor.process(r.id);
    return service.getRun(owner, r.id);
  };
  return {
    owner,
    peer,
    other,
    service,
    assignments,
    directory,
    processor,
    project,
    task,
    plan,
    save,
    run,
  };
}
test("Same-name employees remain distinct; direct assignment, no-op, unassignment and replay use canonical identity receipts", async () => {
  const f = await setup(),
    rows = (await f.directory.read(f.owner, f.project.id)).rows;
  assert.equal(rows.filter((p) => p.name === "Same employee").length, 2);
  assert.notEqual(
    rows.find((p) => p.id === f.peer.id)!.id,
    rows.find((p) => p.id === f.other.id)!.id,
  );
  const key = randomUUID(),
    p = f.plan(),
    a = await f.save(p, key);
  assert.equal(a.assigneeId, f.peer.id);
  assert.equal(a.assignee, "Same employee");
  assert.equal(a.version, 2);
  assert.equal(a.changed, true);
  assert.deepEqual(await f.save(p, key), a);
  await assert.rejects(f.save(f.plan(f.other.id), key), /幂等/);
  const noop = await f.save(f.plan(f.peer.id, 2));
  assert.equal(noop.changed, false);
  assert.equal(noop.version, 2);
  await assert.rejects(
    f.service.patchTask(f.owner, f.task.id, {
      assignee: "Different label",
      expectedVersion: 2,
    }),
    /员工分配/,
  );
  const cleared = await f.save(f.plan(null, 2));
  assert.equal(cleared.version, 3);
  assert.equal(cleared.assigneeId, null);
  const history = (await f.service.task(f.owner, f.task.id)).history;
  assert.equal(
    history.find((v) => v.version === 2).snapshot.assigneeId,
    f.peer.id,
  );
  assert.equal(history[0].snapshot.assigneeId, null);
});
test("A prepared identity is rejected after target or actor membership loss; historical assignments do not prevent revocation", async () => {
  const f = await setup(),
    p = f.plan(),
    prepared = await f.assignments.prepare(f.owner, f.project.id, p);
  await db.pool.query(
    "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [f.owner.workspaceId, f.peer.id],
  );
  await assert.rejects(
    db.tx((c) =>
      f.assignments.apply(
        c,
        f.owner,
        f.project.id,
        p,
        prepared.proof,
        randomUUID(),
      ),
    ),
    /离开/,
  );
  assert.equal((await f.service.task(f.owner, f.task.id)).current.version, 1);
  const q = f.plan(f.other.id),
    a = await f.save(q);
  await db.pool.query(
    "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [f.owner.workspaceId, f.other.id],
  );
  assert.equal(
    (await f.service.task(f.owner, f.task.id)).current.assigneeId,
    f.other.id,
  );
  await assert.rejects(f.save(f.plan(f.other.id, a.version)), /可分配/);
  const ready = await f.assignments.prepare(
    f.owner,
    f.project.id,
    f.plan(null, a.version),
  );
  await db.pool.query(
    "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [f.owner.workspaceId, f.owner.id],
  );
  await assert.rejects(
    db.tx((c) =>
      f.assignments.apply(
        c,
        f.owner,
        f.project.id,
        ready.plan,
        ready.proof,
        randomUUID(),
      ),
    ),
    /撤销/,
  );
});
test("AI reads the actual scoped directory and applies only the employee-confirmed identity, with no project messages", async () => {
  const f = await setup(),
    adapter = f.service.engines.get("fixture")!,
    execute = adapter.execute.bind(adapter);
  adapter.execute = async (r) => {
    if (r.workflow === "directory_report")
      assert.ok(!r.context.includes(f.peer.name));
    if (r.workflow === "assign_task") {
      assert.ok(r.context.includes(f.peer.id));
      assert.ok(!r.context.includes(f.other.id));
    }
    return execute(r);
  };
  const d = await f.run("directory_report");
  assert.equal(d.state, "succeeded");
  assert.equal(d.result.receipts[0].rows.length, 3);
  const a = await f.run("assign_task", f.plan());
  assert.equal(a.state, "succeeded");
  assert.equal(a.result.receipts[0].assigneeId, f.peer.id);
  assert.match(a.result.text, /不表示已通知/);
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
test("Model-selected targets, missing plans and cross-project task IDs cannot assign an employee", async () => {
  const f = await setup();
  f.service.engines.get("fixture")!.execute = async () => ({
    text: "Pretend success",
    evidence: "fixture",
    actions: [{ tool: "task.assign", args: { assigneeId: f.other.id } }],
  });
  const r = await f.run("assign_task", f.plan());
  assert.equal(r.state, "failed");
  assert.equal(
    (await f.service.task(f.owner, f.task.id)).current.assigneeId,
    null,
  );
  const other = await f.service.createProject(
    f.owner,
    "Different scope",
    "Do not cross projects",
  );
  await assert.rejects(
    f.assignments.save(f.owner, other.id, f.plan(), randomUUID()),
    /当前项目/,
  );
  await assert.rejects(
    f.service.startRun(
      f.owner,
      RunInput.parse({
        conversationId: f.project.conversationId,
        engine: "fixture",
        workflow: "assign_task",
        instruction: "Missing explicit plan",
        idempotencyKey: randomUUID(),
      }),
    ),
    /明确范围/,
  );
});
test("Concurrent assignments use one task version; audit storage failure rolls back task and history", async () => {
  const f = await setup(),
    r = await Promise.allSettled([
      f.save(f.plan(f.peer.id)),
      f.save(f.plan(f.other.id)),
    ]);
  assert.equal(r.filter((v) => v.status === "fulfilled").length, 1);
  const original = await f.service.task(f.owner, f.task.id),
    tx = db.tx.bind(db);
  (db as any).tx = (fn: any) =>
    tx(async (c) => {
      const query = c.query.bind(c);
      (c as any).query = (sql: any, ...args: any[]) => {
        if (
          typeof sql === "string" &&
          sql.startsWith("INSERT INTO cw_task_assignment_actions")
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
      f.save(f.plan(null, original.current.version)),
      /audit/,
    );
  } finally {
    (db as any).tx = tx;
  }
  const current = await f.service.task(f.owner, f.task.id);
  assert.equal(current.current.assigneeId, original.current.assigneeId);
  assert.equal(current.current.version, original.current.version);
  assert.equal(current.history.length, original.history.length);
});
test("Follow-up detects a changed employee ID even when both employees have the same display name", async () => {
  const f = await setup();
  let a = await f.save(f.plan(f.peer.id));
  const check = async () => {
    const r = await f.service.startRun(
      f.owner,
      RunInput.parse({
        conversationId: f.project.conversationId,
        workflow: "follow_up",
        engine: "fixture",
        instruction: "Check actual task state",
        idempotencyKey: randomUUID(),
      }),
    );
    await f.processor.process(r.id);
    return (await f.service.getRun(f.owner, r.id)).result.receipts[0];
  };
  await check();
  a = await f.save(f.plan(f.other.id, a.version));
  const changed = await check();
  assert.equal(changed.notify, true);
  assert.deepEqual(changed.changes[0].fields, ["assigneeId"]);
  assert.match(changed.summary, /员工身份/);
  assert.equal((await check()).notify, false);
});
