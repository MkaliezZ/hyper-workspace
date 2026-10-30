import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { ExecutionPolicyService } from "../../apps/api/src/core/execution-policy.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { ExecutionPolicyPlan, RunInput, type Subject } from "@hyper/contracts";
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
  const workspaceId = randomUUID();
  const admin: Subject = {
    id: randomUUID(),
    workspaceId,
    name: "Policy administrator",
    role: "admin",
    demo: true,
  };
  const member: Subject = {
    ...admin,
    id: randomUUID(),
    name: "Policy member",
    role: "member",
  };
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name) VALUES($1,'Synthetic execution rules fixture')",
    [workspaceId],
  );
  for (const s of [admin, member]) {
    await db.pool.query("INSERT INTO cw_users(id,name) VALUES($1,$2)", [
      s.id,
      s.name,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role) VALUES($1,$2,$3)",
      [workspaceId, s.id, s.role],
    );
  }
  const engines = engineRegistry();
  if (execute) engines.get("fixture")!.execute = execute;
  const service = new WorkspaceService(db, engines),
    policy = new ExecutionPolicyService(db),
    processor = new RunProcessor(service);
  const project = await service.createProject(
    admin,
    "Policy project",
    "Enforced bounds",
  );
  const input = (overrides: any = {}) =>
    RunInput.parse({
      conversationId: project.conversationId,
      engine: "fixture",
      workflow: "chat",
      instruction: "Explain this synthetic project.",
      idempotencyKey: randomUUID(),
      ...overrides,
    });
  const save = (
    scope: string,
    rules: any,
    actor = admin,
    revision = 0,
    key = randomUUID(),
  ) =>
    policy.save(
      actor,
      project.id,
      ExecutionPolicyPlan.parse({
        scope,
        rules,
        expectedRevision: revision,
        confirmed: true,
      }),
      key,
    );
  return { admin, member, service, policy, processor, project, input, save };
}
const answer = {
  text: "Synthetic fixture answer",
  actions: [],
  evidence: "fixture" as const,
};
test("Layered rules intersect hard limits and preserve administrator authority, personal ownership and CAS history", async () => {
  const f = await setup();
  await f.save("workspace", {
    maxOutputTokens: 1000,
    maxActions: 4,
    engines: ["fixture", "dsh"],
    expression: "concise",
  });
  await f.save("project", {
    maxOutputTokens: 3000,
    maxActions: 2,
    engines: ["fixture", "hermes"],
    expression: "detailed",
  });
  await f.save(
    "personal",
    { maxOutputTokens: 500, expression: "balanced" },
    f.member,
  );
  const view = await f.policy.view(f.member, f.project.id);
  assert.equal(view.effective.maxOutputTokens, 500);
  assert.equal(view.effective.maxActions, 2);
  assert.deepEqual(view.effective.engines, ["fixture"]);
  assert.equal(view.effective.expression, "balanced");
  await assert.rejects(f.save("workspace", {}, f.member, 1), /权限/);
  const key = randomUUID(),
    plan = ExecutionPolicyPlan.parse({
      scope: "project",
      rules: { maxActions: 1 },
      expectedRevision: 1,
      confirmed: true,
    });
  const saved = await f.policy.save(f.admin, f.project.id, plan, key);
  assert.equal(
    (await f.policy.save(f.admin, f.project.id, plan, key)).revision,
    saved.revision,
  );
  await assert.rejects(
    f.policy.save(
      f.admin,
      f.project.id,
      { ...plan, rules: { maxActions: 2 } },
      key,
    ),
    /幂等键/,
  );
  await assert.rejects(f.save("project", {}, f.admin, 1), /已更新/);
  const other = await setup();
  await assert.rejects(f.policy.view(other.admin, f.project.id));
  assert.equal(
    (await f.policy.view(f.admin, f.project.id)).layers.some(
      (x) => x.scope === "personal",
    ),
    false,
  );
});
test("A Run carries effective revisions and tighter task limits to model dispatch without publishing another person's preferences", async () => {
  let request: any;
  const f = await setup(async (r: any) => {
    request = r;
    return answer;
  });
  await f.save("workspace", {
    maxOutputTokens: 800,
    maxContextBytes: 5000,
    maxDurationSeconds: 40,
  });
  await f.save("personal", { expression: "concise" }, f.member);
  const run = await f.service.startRun(
    f.member,
    f.input({
      taskRules: {
        maxOutputTokens: 128,
        maxActions: 0,
        maxDurationSeconds: 10,
      },
    }),
  );
  await f.processor.process(run.id);
  const saved = await f.service.getRun(f.member, run.id);
  assert.equal(saved.state, "succeeded", saved.error);
  assert.equal(request.limits.maxOutputTokens, 128);
  assert.equal(request.limits.maxDurationSeconds, 10);
  assert.match(request.policy, /preference: concise/);
  assert.equal(saved.executionPolicy.layers.length, 2);
  assert.equal(saved.executionPolicy.taskRules.maxActions, 0);
  await assert.rejects(f.service.getRun(f.admin, run.id));
  assert.equal(
    (await f.policy.view(f.member, f.project.id)).counts.personal,
    1,
  );
});
test("Concurrent daily admission is atomic, counts dispatched attempts once and uses the current UTC day", async () => {
  let calls = 0;
  const f = await setup(async () => {
    calls++;
    return answer;
  });
  await f.save("workspace", { dailyRuns: 1 });
  const a = await f.service.startRun(f.member, f.input()),
    b = await f.service.startRun(f.admin, f.input());
  await Promise.all([f.processor.process(a.id), f.processor.process(b.id)]);
  const runs = await db.pool.query(
    "SELECT state,error FROM cw_runs WHERE id=ANY($1::uuid[])",
    [[a.id, b.id]],
  );
  assert.equal(runs.rows.filter((r) => r.state === "succeeded").length, 1);
  assert.match(
    runs.rows.find((r) => r.state === "failed").error,
    /今日 AI 执行次数/,
  );
  assert.equal(calls, 1);
  await f.processor.process(a.id);
  await f.processor.process(b.id);
  assert.equal(
    (await f.policy.view(f.admin, f.project.id)).counts.workspace,
    1,
  );
  await db.pool.query(
    "UPDATE cw_policy_admissions SET admitted_at=now()-interval '2 days' WHERE workspace_id=$1",
    [f.admin.workspaceId],
  );
  const next = await f.service.startRun(f.member, f.input());
  await f.processor.process(next.id);
  assert.equal((await f.service.getRun(f.member, next.id)).state, "succeeded");
});
test("Queued policy reductions reject before model dispatch; context size and workflow/engine restrictions fail closed", async () => {
  for (const rules of [
    { engines: [] },
    { workflows: [] },
    { dailyRuns: 0 },
    { maxContextBytes: 1024 },
  ]) {
    let calls = 0;
    const f = await setup(async () => {
      calls++;
      return answer;
    });
    const run = await f.service.startRun(
      f.member,
      f.input({ instruction: "Synthetic long input ".repeat(120) }),
    );
    await f.save("project", rules);
    await f.processor.process(run.id);
    assert.equal((await f.service.getRun(f.member, run.id)).state, "failed");
    assert.equal(calls, 0);
  }
});
test("A running policy reduction blocks all proposed writes; later relaxation cannot enlarge an admitted Run", async () => {
  for (const relax of [false, true]) {
    let f: any;
    f = await setup(async () => {
      await f.save("workspace", { maxActions: relax ? 30 : 0 }, f.admin, 1);
      return {
        text: "Model claim",
        evidence: "fixture",
        actions: [
          {
            tool: "artifact.create",
            args: { title: "Forbidden write", content: "Must not save" },
          },
        ],
      };
    });
    await f.save("workspace", { maxActions: relax ? 0 : 30 });
    const run = await f.service.startRun(
      f.member,
      f.input({ workflow: "discussion_to_minutes" }),
    );
    await f.processor.process(run.id);
    const state = await f.service.getRun(f.member, run.id);
    assert.equal(state.state, "failed", state.error);
    assert.match(state.error, /动作数量/);
    assert.equal(
      (
        await db.pool.query("SELECT id FROM cw_actions WHERE run_id=$1", [
          run.id,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await db.pool.query("SELECT id FROM cw_artifacts WHERE project_id=$1", [
          f.project.id,
        ])
      ).rowCount,
      0,
    );
  }
});
test("AI configuration changes exactly the confirmed scope and version, supports replay, and cannot accept model-chosen values", async () => {
  const f = await setup();
  const input = f.input({
    workflow: "configure_policy",
    policyPlan: {
      scope: "personal",
      expectedRevision: 0,
      rules: { maxActions: 3, expression: "concise" },
      confirmed: true,
    },
  });
  const run = await f.service.startRun(f.member, input);
  await f.processor.process(run.id);
  const saved = await f.service.getRun(f.member, run.id);
  assert.equal(saved.state, "succeeded", saved.error);
  assert.equal(saved.result.receipts[0].revision, 1);
  assert.equal((await f.service.startRun(f.member, input)).id, run.id);
  assert.match(saved.contextRefs[0], /^execution-policy:personal:/);
  assert.equal(
    (await f.policy.view(f.member, f.project.id)).effective.maxActions,
    3,
  );
  assert.equal(
    (await f.policy.view(f.admin, f.project.id)).effective.maxActions,
    30,
  );
  for (const args of [{ rules: { maxActions: 30 } }, { scope: "workspace" }]) {
    const bad = await setup(async () => ({
      text: "Bad policy",
      actions: [{ tool: "policy.configure", args }],
      evidence: "fixture",
    }));
    const started = await bad.service.startRun(
      bad.member,
      bad.input({
        workflow: "configure_policy",
        policyPlan: {
          scope: "personal",
          expectedRevision: 0,
          rules: {},
          confirmed: true,
        },
      }),
    );
    await bad.processor.process(started.id);
    assert.equal(
      (await bad.service.getRun(bad.member, started.id)).state,
      "failed",
    );
    assert.equal(
      (await bad.policy.view(bad.member, bad.project.id)).layers.length,
      0,
    );
  }
});
test("An administrator losing authority during model execution cannot change shared rules; stale plans preserve the newer revision", async () => {
  for (const revoke of [true, false]) {
    let f: any;
    f = await setup(async () => {
      if (revoke)
        await db.pool.query(
          "UPDATE cw_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
          [f.admin.workspaceId, f.admin.id],
        );
      else await f.save("project", { maxActions: 2 });
      return {
        text: "Claimed",
        actions: [{ tool: "policy.configure", args: {} }],
        evidence: "fixture",
      };
    });
    const started = await f.service.startRun(
      f.admin,
      f.input({
        workflow: "configure_policy",
        policyPlan: {
          scope: "project",
          expectedRevision: 0,
          rules: { maxActions: 4 },
          confirmed: true,
        },
      }),
    );
    await f.processor.process(started.id);
    assert.equal((await f.service.getRun(f.admin, started.id)).state, "failed");
    const view = await f.policy.view(f.admin, f.project.id);
    assert.equal(view.effective.maxActions, revoke ? 30 : 2);
  }
});
test("Configured deadlines abort an active model turn and prevent publication", async () => {
  const f = await setup(
    async (r: any) =>
      new Promise((resolve, reject) => {
        r.signal.addEventListener("abort", () => reject(r.signal.reason), {
          once: true,
        });
      }),
  );
  await f.save("project", { maxDurationSeconds: 5 });
  const run = await f.service.startRun(f.member, f.input());
  await f.processor.process(run.id);
  const result = await f.service.getRun(f.member, run.id);
  assert.equal(result.state, "failed");
  assert.match(result.error, /有效时限/);
});
test("Cancellation retains only actual admissions, and audit failure rolls back the complete policy change", async () => {
  let f: any;
  f = await setup(async (r: any) => {
    await f.service.cancel(f.member, r.runId);
    return answer;
  });
  const queued = await f.service.startRun(f.member, f.input());
  await f.service.cancel(f.member, queued.id);
  await f.processor.process(queued.id);
  assert.equal(
    (await f.policy.view(f.member, f.project.id)).counts.personal,
    0,
  );
  const active = await f.service.startRun(f.member, f.input());
  await f.processor.process(active.id);
  assert.equal(
    (await f.service.getRun(f.member, active.id)).state,
    "cancelled",
  );
  assert.equal(
    (await f.policy.view(f.member, f.project.id)).counts.personal,
    1,
  );
  const name = "fail_policy_" + randomUUID().replaceAll("-", "");
  await db.pool.query(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.workspace_id='${f.admin.workspaceId}' THEN RAISE EXCEPTION 'Synthetic policy journal failure'; END IF; RETURN NEW; END$$`,
  );
  await db.pool.query(
    `CREATE TRIGGER ${name} BEFORE INSERT ON cw_execution_policy_changes FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );
  try {
    await assert.rejects(
      f.save("project", { maxActions: 1 }),
      /journal failure/,
    );
    assert.equal((await f.policy.view(f.admin, f.project.id)).layers.length, 0);
  } finally {
    await db.pool.query(`DROP TRIGGER ${name} ON cw_execution_policy_changes`);
    await db.pool.query(`DROP FUNCTION ${name}()`);
  }
});
