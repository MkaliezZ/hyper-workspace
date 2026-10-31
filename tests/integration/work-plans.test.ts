import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkProposal, WorkPlanResponse, type Subject } from "@hyper/contracts";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { WorkPlanService } from "../../apps/api/src/core/work-plans.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { createProjectArtifact } from "../../apps/api/src/core/artifacts.js";
import { ExecutionPolicyService } from "../../apps/api/src/core/execution-policy.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated _test database required.");
const db = new Database(url);
before(async () => {
  await db.migrate();
});
after(async () => db.close());
const proposal = (operations: any[], questions: string[] = []): WorkProposal =>
  WorkProposal.parse({
    summary: "Synthetic scoped work plan",
    operations,
    questions,
  });
async function setup(raw: WorkProposal) {
  const workspaceId = randomUUID(),
    owner: Subject = {
      id: randomUUID(),
      workspaceId,
      name: "合成员工甲",
      role: "admin",
      demo: true,
    },
    peer: Subject = {
      ...owner,
      id: randomUUID(),
      name: "同名员工",
      role: "member",
    };
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name)VALUES($1,'Synthetic work planning')",
    [workspaceId],
  );
  for (const s of [owner, peer]) {
    await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
      s.id,
      s.name,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,$3)",
      [workspaceId, s.id, s.role],
    );
  }
  const engines = engineRegistry(),
    service = new WorkspaceService(db, engines),
    plans = new WorkPlanService(db),
    processor = new RunProcessor(service),
    project = await service.createProject(
      owner,
      "Synthetic scope",
      "Do not infer business success from generated text",
    );
  await service.message(
    owner,
    project.conversationId,
    "Synthetic evidence for this scoped plan.",
  );
  const contexts: string[] = [];
  let calls = 0,
    hook: (() => Promise<void>) | undefined;
  engines.get("fixture")!.execute = async (request) => {
    contexts.push(request.context);
    calls++;
    if (hook) await hook();
    return {
      text: "Model falsely claims all operations already executed",
      actions: [{ tool: "work.plan", args: raw }],
      evidence: "fixture",
    };
  };
  const start = () =>
    service.startRun(owner, {
      conversationId: project.conversationId,
      workflow: "plan_work",
      instruction:
        "Create only a proposal, clarify identities and versions before execution.",
      engine: "fixture",
      idempotencyKey: randomUUID(),
    });
  const process = async () => {
    const r = await start();
    await processor.process(r.id);
    return r;
  };
  const respond = (
    id: string,
    revision: number,
    body: any = {},
    actor = owner,
  ) =>
    plans.respond(
      actor,
      id,
      WorkPlanResponse.parse({
        expectedRevision: revision,
        idempotencyKey: randomUUID(),
        ...body,
      }),
    );
  return {
    owner,
    peer,
    service,
    plans,
    processor,
    project,
    start,
    process,
    respond,
    calls: () => calls,
    contexts,
    setHook: (value: () => Promise<void>) => {
      hook = value;
    },
  };
}
const task = (name = "我") => ({
  operation: "create_task",
  title: "合成待办",
  assignee: { name },
  dueDate: null,
});
test("Saved clarification can explicitly trigger another model phase without reusing private runtime files or executing work before confirmation", async () => {
  const raw = proposal([task()], ["请明确交付对象"]),
    f = await setup(raw),
    r = await f.process();
  await f.respond(r.id, 1, {
    answers: [{ key: "question:0", text: "面向合成验收人员" }],
  });
  f.setHook(async () => {
    raw.questions = [];
    (raw.operations[0] as any).title = "已根据合成验收人员调整的待办";
  });
  const request = WorkPlanResponse.parse({
    expectedRevision: 2,
    regenerate: true,
    idempotencyKey: randomUUID(),
  });
  const next = await f.plans.respond(f.owner, r.id, request);
  assert.equal(next.state, "queued");
  assert.deepEqual(await f.plans.respond(f.owner, r.id, request), next);
  await f.processor.process(r.id);
  const current = await f.plans.view(f.owner, r.id);
  assert.equal(current.state, "waiting_confirmation");
  assert.equal(current.revision, 4);
  assert.match(f.contexts[1]!, /面向合成验收人员/);
  assert.equal(f.calls(), 2);
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM cw_tasks WHERE project_id=$1",
        [f.project.id],
      )
    ).rows[0].n,
    0,
  );
  await f.respond(r.id, 4, { confirmed: true });
  assert.equal(f.calls(), 2);
  assert.equal(
    (
      await db.pool.query("SELECT title FROM cw_tasks WHERE project_id=$1", [
        f.project.id,
      ])
    ).rows[0].title,
    "已根据合成验收人员调整的待办",
  );
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM cw_run_wait_periods WHERE run_id=$1",
        [r.id],
      )
    ).rows[0].n,
    2,
  );
});
test("Task targets changed during generation require an explicit new-version selection and preserve real employee assignment", async () => {
  const raw = proposal([
      {
        operation: "update_task",
        target: { name: "合成旧待办" },
        status: "done",
        assignee: { name: "同名员工" },
      },
    ]),
    f = await setup(raw);
  const original = await f.service.createTask(
    f.owner,
    f.project.conversationId,
    { title: "合成旧待办", assignee: "待分配", dueDate: null },
  );
  f.setHook(async () => {
    await f.service.patchTask(f.owner, original.id, {
      title: "人工已改名",
      expectedVersion: 1,
    });
  });
  const r = await f.process(),
    view = await f.plans.view(f.owner, r.id);
  assert.equal(view.state, "waiting_input");
  assert.equal(view.questions[0].key, "0:target");
  await f.respond(r.id, 1, {
    selections: [{ key: "0:target", id: original.id, version: 2 }],
  });
  await f.respond(r.id, 2, { confirmed: true });
  const actual = await f.service.task(f.owner, original.id);
  assert.equal(actual.current.title, "人工已改名");
  assert.equal(actual.current.status, "done");
  assert.equal(actual.current.assigneeId, f.peer.id);
});
test("Plan preparation writes no business objects; confirmation atomically creates task, exact employee assignment and artifact with idempotent receipts", async () => {
  const f = await setup(
      proposal([
        task(),
        {
          operation: "create_artifact",
          title: "合成成果",
          content: "Synthetic candidate deliverable",
        },
      ]),
    ),
    r = await f.process();
  const view = await f.plans.view(f.owner, r.id);
  assert.equal(view.state, "waiting_confirmation");
  assert.equal(view.resolved["0:assignee"].id, f.owner.id);
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM cw_tasks WHERE project_id=$1",
        [f.project.id],
      )
    ).rows[0].n,
    0,
  );
  const input = WorkPlanResponse.parse({
    expectedRevision: view.revision,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const [a, b] = await Promise.all([
    f.plans.respond(f.owner, r.id, input),
    f.plans.respond(f.owner, r.id, input),
  ]);
  assert.deepEqual(a, b);
  assert.equal(a.state, "succeeded");
  assert.equal(a.receipts.length, 3);
  assert.equal(f.calls(), 1);
  assert.equal(
    (
      await db.pool.query(
        "SELECT assignee_id FROM cw_tasks WHERE project_id=$1",
        [f.project.id],
      )
    ).rows[0].assignee_id,
    f.owner.id,
  );
  const done = await f.service.getRun(f.owner, r.id);
  assert.match(done.result.text, /实际|确切/);
  assert.doesNotMatch(done.result.text, /Model falsely/);
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM cw_artifacts WHERE project_id=$1",
        [f.project.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM cw_work_plan_versions WHERE run_id=$1",
        [r.id],
      )
    ).rows[0].n,
    2,
  );
  await assert.rejects(() =>
    f.respond(r.id, view.revision, { confirmed: true }, f.peer),
  );
  await assert.rejects(
    () => f.plans.respond(f.owner, r.id, { ...input, confirmed: false }),
    /幂等/,
  );
});
test("Duplicate employee names and missing scope require separate persisted answers and explicit identity selection before confirmation", async () => {
  const f = await setup(proposal([task("同名员工")], ["请明确交付对象"])),
    same = { ...f.peer, id: randomUUID() };
  await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
    same.id,
    same.name,
  ]);
  await db.pool.query(
    "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,'member')",
    [same.workspaceId, same.id],
  );
  const r = await f.process(),
    view = await f.plans.view(f.owner, r.id);
  assert.equal(view.state, "waiting_input");
  assert.equal(view.questions.length, 2);
  await assert.rejects(() => f.respond(r.id, 1, { confirmed: true }), /先保存/);
  await assert.rejects(
    () =>
      f.respond(r.id, 1, {
        selections: [{ key: "0:assignee", id: randomUUID() }],
      }),
    /范围/,
  );
  const first = await f.respond(r.id, 1, {
    answers: [{ key: "question:0", text: "合成验收人员" }],
  });
  assert.equal(first.state, "waiting_input");
  const second = await f.respond(r.id, 2, {
    selections: [{ key: "0:assignee", id: same.id }],
  });
  assert.equal(second.state, "waiting_confirmation");
  assert.equal(
    (await new WorkPlanService(db).view(f.owner, r.id)).answers["question:0"],
    "合成验收人员",
  );
  const final = await f.respond(r.id, 3, { confirmed: true });
  assert.equal(final.state, "succeeded");
  assert.equal(
    (
      await db.pool.query(
        "SELECT assignee_id FROM cw_tasks WHERE project_id=$1",
        [f.project.id],
      )
    ).rows[0].assignee_id,
    same.id,
  );
});
test("Old artifact versions and concurrent target updates require explicit current-version selection; a failed later action rolls back earlier creations", async () => {
  const f = await setup(
    proposal([
      task(),
      {
        operation: "revise_artifact",
        target: { name: "同名方案", version: 1 },
        content: "Synthetic whole-body replacement",
      },
    ]),
  );
  const artifact = await db.tx((c) =>
    createProjectArtifact(c, f.owner, f.project.id, {
      title: "同名方案",
      content: "Original version",
    }),
  );
  await f.service.revise(f.owner, artifact.id, {
    content: "Current version",
    expectedVersion: 1,
    feedback: "Synthetic update",
  });
  const r = await f.process(),
    view = await f.plans.view(f.owner, r.id);
  assert.equal(view.state, "waiting_input");
  const answer = await f.respond(r.id, 1, {
    selections: [{ key: "1:target", id: artifact.id, version: 2 }],
  });
  assert.equal(answer.state, "waiting_confirmation");
  await f.service.revise(f.owner, artifact.id, {
    content: "Manual race version",
    expectedVersion: 2,
    feedback: "Race",
  });
  await assert.rejects(() => f.respond(r.id, 2, { confirmed: true }), /先保存/);
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM cw_tasks WHERE project_id=$1",
        [f.project.id],
      )
    ).rows[0].n,
    0,
  );
  const refreshed = await f.plans.view(f.owner, r.id);
  assert.equal(refreshed.questions[0].choices![0].version, 3);
  await f.respond(r.id, 2, {
    selections: [{ key: "1:target", id: artifact.id, version: 3 }],
  });
  const revision = (await f.plans.view(f.owner, r.id)).revision;
  await db.pool.query(
    "CREATE FUNCTION test_plan_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.feedback='Synthetic scoped work plan' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$",
  );
  await db.pool.query(
    "CREATE TRIGGER test_plan_rollback BEFORE INSERT ON cw_artifact_versions FOR EACH ROW EXECUTE FUNCTION test_plan_rollback()",
  );
  try {
    await assert.rejects(
      () => f.respond(r.id, revision, { confirmed: true }),
      /synthetic audit failure/,
    );
  } finally {
    await db.pool.query(
      "DROP TRIGGER test_plan_rollback ON cw_artifact_versions",
    );
    await db.pool.query("DROP FUNCTION test_plan_rollback()");
  }
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM cw_tasks WHERE project_id=$1",
        [f.project.id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await f.plans.view(f.owner, r.id)).state,
    "waiting_confirmation",
  );
  const final = await f.respond(r.id, revision, { confirmed: true });
  assert.equal(final.state, "succeeded");
  assert.equal(
    (await f.service.artifact(f.owner, artifact.id)).current.version,
    4,
  );
});
test("Human takeover creates a revision, invalidates old confirmation and retains the original AI proposal", async () => {
  const f = await setup(proposal([task()])),
    r = await f.process(),
    view = await f.plans.view(f.owner, r.id);
  const next = proposal([{ ...task(), title: "人工修改的合成待办" }]);
  const input = {
    expectedRevision: 1,
    proposal: next,
    idempotencyKey: randomUUID(),
  };
  const result = await f.plans.edit(f.owner, r.id, input);
  assert.equal(result.revision, 2);
  assert.deepEqual(await f.plans.edit(f.owner, r.id, input), result);
  await assert.rejects(
    () => f.respond(r.id, view.revision, { confirmed: true }),
    /变化/,
  );
  await f.respond(r.id, 2, { confirmed: true });
  assert.equal(
    (
      await db.pool.query("SELECT title FROM cw_tasks WHERE project_id=$1", [
        f.project.id,
      ])
    ).rows[0].title,
    "人工修改的合成待办",
  );
  const versions = (
    await db.pool.query(
      "SELECT proposal,channel FROM cw_work_plan_versions WHERE run_id=$1 ORDER BY revision",
      [r.id],
    )
  ).rows;
  assert.equal(versions[0].proposal.operations[0].title, "合成待办");
  assert.equal(versions[1].channel, "human_edit");
  assert.equal(f.calls(), 1);
});
test("Cancellation, member removal and source mutation deny pending plan writes and private reads", async () => {
  const f = await setup(proposal([task()])),
    r = await f.process();
  await f.service.cancel(f.owner, r.id);
  await assert.rejects(
    () => f.respond(r.id, 1, { confirmed: true }),
    /取消|变化/,
  );
  const second = await f.process();
  await db.pool.query(
    "UPDATE cw_messages SET content='Mutated source evidence' WHERE conversation_id=$1",
    [f.project.conversationId],
  );
  await assert.rejects(() => f.plans.view(f.owner, second.id), /依据|来源/);
  await assert.rejects(() => f.respond(second.id, 1, { confirmed: true }));
  await db.pool.query(
    "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [f.owner.workspaceId, f.owner.id],
  );
  await assert.rejects(() => f.plans.view(f.owner, r.id));
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM cw_tasks WHERE project_id=$1",
        [f.project.id],
      )
    ).rows[0].n,
    0,
  );
});
test("Waiting time is excluded from active execution limits while current restrictions and total business action limits still apply", async () => {
  const f = await setup(proposal([task()])),
    r = await f.process(),
    row = (await db.pool.query("SELECT * FROM cw_runs WHERE id=$1", [r.id]))
      .rows[0];
  row.execution_policy_snapshot.admittedAt = new Date(
    Date.now() - 3600000,
  ).toISOString();
  await db.pool.query(
    "UPDATE cw_runs SET execution_policy_snapshot=$2 WHERE id=$1",
    [r.id, row.execution_policy_snapshot],
  );
  await db.pool.query(
    "UPDATE cw_run_wait_periods SET started_at=clock_timestamp()-interval '1 hour' WHERE run_id=$1",
    [r.id],
  );
  const result = await f.respond(r.id, 1, { confirmed: true });
  assert.equal(result.state, "succeeded");
  const g = await setup(proposal([task()])),
    q = await g.process();
  await new ExecutionPolicyService(db).save(
    g.owner,
    g.project.id,
    {
      scope: "personal",
      expectedRevision: 0,
      rules: { maxActions: 1 },
      confirmed: true,
    },
    randomUUID(),
  );
  await assert.rejects(
    () => g.respond(q.id, 1, { confirmed: true }),
    /动作数量/,
  );
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM cw_tasks WHERE project_id=$1",
        [g.project.id],
      )
    ).rows[0].n,
    0,
  );
});
