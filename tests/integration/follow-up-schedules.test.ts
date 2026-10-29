import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { FollowUpScheduleService } from "../../apps/api/src/core/follow-up-schedules.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { RunInput, type FollowUpPlan, type Subject } from "@hyper/contracts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Use an isolated _test database.");
const db = new Database(url),
  workspaces: string[] = [];
before(async () => {
  process.env.DEMO_MODE = "true";
  await db.migrate();
});
afterEach(async () => {
  await db.pool.query(
    "UPDATE cw_follow_up_schedules SET state='cancelled',next_check_at=NULL,version=version+1 WHERE workspace_id=ANY($1::uuid[])",
    [workspaces],
  );
  await db.pool.query(
    "UPDATE cw_runs SET state='cancelled' WHERE workspace_id=ANY($1::uuid[]) AND state IN ('queued','running')",
    [workspaces],
  );
});
after(async () => db.close());
async function setup() {
  const workspaceId = randomUUID();
  workspaces.push(workspaceId);
  const s: Subject = {
    id: randomUUID(),
    workspaceId,
    name: "调度测试员工",
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
    "INSERT INTO cw_workspaces(id,name) VALUES($1,'Schedule synthetic test')",
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
    scheduler = new FollowUpScheduleService(service),
    processor = new RunProcessor(service);
  const project = await service.createProject(
    s,
    "定时跟进测试",
    "明确授权范围与检查次数",
  );
  const task = await service.createTask(s, project.conversationId, {
    title: "真实产品测试待办",
    assignee: s.name,
    dueDate: null,
  });
  const configure = (plan: FollowUpPlan, key = randomUUID()) =>
    scheduler.configure(s, project.conversationId, {
      plan,
      engine: "fixture",
      idempotencyKey: key,
    });
  const create = (maxChecks = 4) =>
    configure({ operation: "create", intervalMinutes: 15, maxChecks });
  const row = async (id: string) =>
    (
      await db.pool.query("SELECT * FROM cw_follow_up_schedules WHERE id=$1", [
        id,
      ])
    ).rows[0];
  const due = (id: string) =>
    db.pool.query(
      "UPDATE cw_follow_up_schedules SET next_check_at=clock_timestamp()-interval '1 minute' WHERE id=$1 AND state='active'",
      [id],
    );
  return {
    s,
    peer,
    service,
    scheduler,
    processor,
    project,
    task,
    configure,
    create,
    row,
    due,
  };
}

test("Durable schedule admits one Run across workers, avoids overlap and stops at its finite check budget", async () => {
  const f = await setup(),
    key = randomUUID(),
    plan = { operation: "create", intervalMinutes: 15, maxChecks: 2 } as const;
  const created = await f.configure(plan, key);
  assert.equal((await f.configure(plan, key)).id, created.id);
  await assert.rejects(
    f.configure({ ...plan, maxChecks: 3 }, key),
    /相同幂等键/,
  );
  const admitted = (
    await Promise.all([
      f.scheduler.dispatchDue(),
      new FollowUpScheduleService(f.service).dispatchDue(),
    ])
  ).flat();
  assert.equal(admitted.length, 1);
  await assert.rejects(
    db.pool.query(
      "UPDATE cw_runs SET follow_up_schedule_version=NULL WHERE id=$1",
      [admitted[0]],
    ),
    /check constraint/,
  );
  let row = await f.row(created.id);
  assert.equal(row.checks_started, 1);
  assert.equal(row.last_run_id, admitted[0]);
  assert.ok(new Date(row.next_check_at).getTime() - Date.now() > 14 * 60000);
  await f.due(created.id);
  assert.deepEqual(await f.scheduler.dispatchDue(), []);
  await f.processor.process(admitted[0]!);
  assert.equal(
    (await f.service.getRun(f.s, admitted[0]!)).result.receipts[0].notify,
    false,
  );
  await f.service.patchTask(f.s, f.task.id, { status: "done" });
  const second = await f.scheduler.dispatchDue();
  assert.equal(second.length, 1);
  row = await f.row(created.id);
  assert.equal(row.state, "completed");
  assert.equal(row.checks_started, 2);
  await f.processor.process(second[0]!);
  assert.equal(
    (await f.service.getRun(f.s, second[0]!)).result.receipts[0].notify,
    true,
  );
  assert.deepEqual(await f.scheduler.dispatchDue(), []);
  assert.equal((await f.service.view(f.s, f.project.id)).messages.length, 1);
});

test("Pause stops queued and in-flight checks; resume uses a new generation without reviving cancelled Runs", async () => {
  const f = await setup(),
    created = await f.create();
  const [queued] = await f.scheduler.dispatchDue();
  assert.ok(queued);
  const paused = await f.configure({
    operation: "pause",
    scheduleId: created.id,
    expectedVersion: 1,
  });
  assert.equal(paused.state, "paused");
  await f.processor.process(queued);
  assert.equal((await f.service.getRun(f.s, queued)).state, "cancelled");
  await assert.rejects(
    f.configure({
      operation: "resume",
      scheduleId: created.id,
      expectedVersion: 1,
    }),
    /配置已变化/,
  );
  const resumed = await f.configure({
    operation: "resume",
    scheduleId: created.id,
    expectedVersion: paused.version,
  });
  assert.equal(resumed.state, "active");
  const [inFlight] = await f.scheduler.dispatchDue();
  assert.ok(inFlight);
  f.service.engines.set("fixture", {
    id: "fixture",
    describeCapabilities: () => ({
      configured: true,
      operations: ["follow_up"],
      evidence: "test-only",
    }),
    execute: async () => {
      await f.configure({
        operation: "pause",
        scheduleId: created.id,
        expectedVersion: resumed.version,
      });
      return {
        text: "Must not notify",
        actions: [{ tool: "follow_up.check", args: {} }],
        evidence: "fixture",
      };
    },
  });
  await f.processor.process(inFlight);
  assert.equal((await f.service.getRun(f.s, inFlight)).state, "cancelled");
  assert.equal(
    (
      await db.pool.query("SELECT id FROM cw_actions WHERE run_id=$1", [
        inFlight,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await db.pool.query(
        "SELECT project_id FROM cw_follow_up_baselines WHERE project_id=$1",
        [f.project.id],
      )
    ).rowCount,
    0,
  );
});

test("Schedule limits, actor ownership, project scope and configuration versions are enforced by the shared service", async () => {
  const f = await setup();
  for (const plan of [
    { operation: "create", intervalMinutes: 1, maxChecks: 1 },
    { operation: "create", intervalMinutes: 15, maxChecks: 97 },
    {
      operation: "create",
      intervalMinutes: 15,
      maxChecks: 1,
      actorId: f.peer.id,
    },
  ])
    await assert.rejects(f.configure(plan as any));
  const created = await f.create();
  await assert.rejects(f.create(), /已有活动/);
  assert.deepEqual(
    await f.scheduler.list(f.peer, f.project.conversationId),
    [],
  );
  await assert.rejects(
    f.scheduler.configure(
      { ...f.peer, role: "admin" },
      f.project.conversationId,
      {
        plan: {
          operation: "cancel",
          scheduleId: created.id,
          expectedVersion: 1,
        },
        engine: "fixture",
        idempotencyKey: randomUUID(),
      },
    ),
    /无权操作/,
  );
  const other = await f.service.createProject(f.s, "另一个项目", "隔离范围");
  await assert.rejects(
    f.scheduler.configure(f.s, other.conversationId, {
      plan: { operation: "cancel", scheduleId: created.id, expectedVersion: 1 },
      engine: "fixture",
      idempotencyKey: randomUUID(),
    }),
    /无权操作/,
  );
  const cancelled = await f.configure({
    operation: "cancel",
    scheduleId: created.id,
    expectedVersion: 1,
  });
  await assert.rejects(
    f.configure({
      operation: "resume",
      scheduleId: created.id,
      expectedVersion: cancelled.version,
    }),
    /不能恢复/,
  );
  assert.deepEqual(await f.scheduler.dispatchDue(), []);
});

test("Expired dispatch leases survive service restart; failed checks or revoked membership pause future spending", async () => {
  const f = await setup(),
    created = await f.create();
  await db.pool.query(
    "UPDATE cw_follow_up_schedules SET lease_owner=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1",
    [created.id, randomUUID()],
  );
  assert.deepEqual(await f.scheduler.dispatchDue(), []);
  await db.pool.query(
    "UPDATE cw_follow_up_schedules SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [created.id],
  );
  const [run] = await new FollowUpScheduleService(f.service).dispatchDue();
  assert.ok(run);
  f.service.engines.set("fixture", {
    id: "fixture",
    describeCapabilities: () => ({
      configured: true,
      operations: ["follow_up"],
      evidence: "test-only",
    }),
    execute: async () => {
      throw new Error("Synthetic model failure");
    },
  });
  await f.processor.process(run);
  await f.due(created.id);
  assert.deepEqual(await f.scheduler.dispatchDue(), []);
  let row = await f.row(created.id);
  assert.equal(row.state, "paused");
  assert.equal(row.checks_started, 1);
  await f.configure({
    operation: "resume",
    scheduleId: created.id,
    expectedVersion: row.version,
  });
  await db.pool.query(
    "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [f.s.workspaceId, f.s.id],
  );
  assert.deepEqual(await f.scheduler.dispatchDue(), []);
  row = await f.row(created.id);
  assert.equal(row.state, "paused");
  assert.equal(row.checks_started, 1);
  assert.ok(!JSON.stringify(row.last_error).includes("Synthetic model"));
});

test("Cancellation during dispatch validation prevents an orphan executable Run", async () => {
  const f = await setup(),
    created = await f.create();
  const original = f.service.runModel.bind(f.service);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  f.service.runModel = async (...args) => {
    enter();
    await gate;
    return original(...args);
  };
  const dispatch = f.scheduler.dispatchDue();
  await entered;
  await f.configure({
    operation: "cancel",
    scheduleId: created.id,
    expectedVersion: 1,
  });
  release();
  assert.deepEqual(await dispatch, []);
  assert.equal((await f.row(created.id)).checks_started, 0);
  assert.equal(
    (
      await db.pool.query(
        "SELECT id FROM cw_runs WHERE follow_up_schedule_id=$1",
        [created.id],
      )
    ).rowCount,
    0,
  );
});

test("AI configuration executes only the employee-bound plan and preserves replay receipts and private scope", async () => {
  const f = await setup();
  const input = RunInput.parse({
    conversationId: f.project.conversationId,
    workflow: "configure_follow_up",
    engine: "fixture",
    instruction: "按选定条件创建跟进。",
    followUpPlan: { operation: "create", intervalMinutes: 30, maxChecks: 3 },
    idempotencyKey: randomUUID(),
  });
  const run = await f.service.startRun(f.s, input);
  await f.processor.process(run.id);
  const result = await f.service.getRun(f.s, run.id);
  assert.equal(result.state, "succeeded", result.error);
  const receipt = result.result.receipts[0];
  assert.equal(receipt.intervalMinutes, 30);
  assert.equal(receipt.maxChecks, 3);
  assert.equal((await f.row(receipt.id)).source_run_id, run.id);
  assert.equal((await f.service.startRun(f.s, input)).id, run.id);
  assert.equal((await f.service.view(f.s, f.project.id)).messages.length, 0);
  await assert.rejects(f.service.getRun(f.peer, run.id));
  f.service.engines.set("fixture", {
    id: "fixture",
    describeCapabilities: () => ({
      configured: true,
      operations: ["follow_up", "configure_follow_up"],
      evidence: "test-only",
    }),
    execute: async () => ({
      text: "Override limits",
      actions: [{ tool: "follow_up.configure", args: { maxChecks: 96 } }],
      evidence: "fixture",
    }),
  });
  const pause = await f.service.startRun(f.s, {
    ...input,
    followUpPlan: {
      operation: "pause",
      scheduleId: receipt.id,
      expectedVersion: 1,
    },
    idempotencyKey: randomUUID(),
  });
  await f.processor.process(pause.id);
  assert.equal((await f.service.getRun(f.s, pause.id)).state, "failed");
  assert.equal((await f.row(receipt.id)).state, "active");
  await assert.rejects(
    f.service.startRun(f.s, {
      ...input,
      workflow: "follow_up",
      idempotencyKey: randomUUID(),
    }),
    /不接受跟进配置/,
  );
  f.service.engines.set("fixture", {
    id: "fixture",
    describeCapabilities: () => ({
      configured: true,
      operations: ["follow_up"],
      evidence: "test-only",
    }),
    execute: async () => {
      throw new Error("Must not execute unsupported configuration");
    },
  });
  await assert.rejects(
    f.service.startRun(f.s, { ...input, idempotencyKey: randomUUID() }),
    /未声明跟进配置能力/,
  );
  assert.equal((await f.service.startRun(f.s, input)).id, run.id);
});

test("A committed AI configuration in recovery cannot start spending until the employee explicitly resumes", async () => {
  const f = await setup();
  const original = f.service.access.assert.bind(f.service.access);
  f.service.access.assert = async (...args) => {
    await original(...args);
    if (
      (
        await db.pool.query(
          "SELECT id FROM cw_follow_up_schedules WHERE project_id=$1",
          [f.project.id],
        )
      ).rowCount
    )
      throw new Error("Synthetic scope loss after configuration commit");
    return undefined;
  };
  const run = await f.service.startRun(f.s, {
    conversationId: f.project.conversationId,
    workflow: "configure_follow_up",
    engine: "fixture",
    instruction: "创建明确的有限跟进。",
    followUpPlan: { operation: "create", intervalMinutes: 15, maxChecks: 2 },
    idempotencyKey: randomUUID(),
  });
  await f.processor.process(run.id);
  assert.equal(
    (await db.pool.query("SELECT state FROM cw_runs WHERE id=$1", [run.id]))
      .rows[0].state,
    "recovery_required",
  );
  assert.deepEqual(await f.scheduler.dispatchDue(), []);
  const schedule = (
    await db.pool.query(
      "SELECT * FROM cw_follow_up_schedules WHERE project_id=$1",
      [f.project.id],
    )
  ).rows[0];
  assert.equal(schedule.state, "paused");
  assert.equal(schedule.checks_started, 0);
  f.service.access.assert = original;
  await f.configure({
    operation: "resume",
    scheduleId: schedule.id,
    expectedVersion: schedule.version,
  });
  assert.equal((await f.row(schedule.id)).source_run_id, null);
  assert.equal((await f.scheduler.dispatchDue()).length, 1);
});
