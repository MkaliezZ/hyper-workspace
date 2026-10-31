import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DecisionDraft, DecisionPlan, type Subject } from "@hyper/contracts";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import {
  engineRegistry,
  FixtureAdapter,
} from "../../apps/api/src/engines/adapters.js";
import { RunInput } from "@hyper/contracts";
import { Database } from "../../apps/api/src/db/database.js";
import { DecisionService } from "../../apps/api/src/core/decisions.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated _test database required");
const db = new Database(url),
  service = new DecisionService(db),
  workspace = randomUUID(),
  otherWorkspace = randomUUID(),
  people = new Map<string, Subject>();
let project: string, otherProject: string, conversation: string;
before(async () => {
  await db.migrate();
  for (const id of [workspace, otherWorkspace])
    await db.pool.query(
      "INSERT INTO cw_workspaces(id,name)VALUES($1,'Decision database fixture')",
      [id],
    );
  for (const [name, role, wid] of [
    ["alice", "member", workspace],
    ["bob", "member", workspace],
    ["admin", "admin", workspace],
    ["other", "admin", otherWorkspace],
  ] as const) {
    const id = randomUUID();
    await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
      id,
      name,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,$3)",
      [wid, id, role],
    );
    people.set(name, { id, name, role, workspaceId: wid, demo: true });
  }
  project = await makeProject();
  otherProject = await makeProject();
  conversation = (
    await db.pool.query("SELECT id FROM cw_conversations WHERE project_id=$1", [
      project,
    ])
  ).rows[0].id;
});
after(async () => {
  await db.close();
});
const s = (name = "alice") => people.get(name)!;
async function makeProject() {
  const id = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_projects(id,workspace_id,name)VALUES($1,$2,'Synthetic decision project')",
    [id, workspace],
  );
  await db.pool.query(
    "INSERT INTO cw_conversations(id,workspace_id,project_id)VALUES($1,$2,$3)",
    [randomUUID(), workspace, id],
  );
  return id;
}
const draft = (title = "合成方向") =>
  DecisionDraft.parse({
    title,
    content: "这是合成的待确认提议。",
    rationale: "合成依据。",
  });
const create = (name = "alice", title = "合成方向", p = project) =>
  service.mutate(s(name), p, {
    plan: { operation: "create" },
    draft: draft(title),
    sourceRefs: [],
    idempotencyKey: randomUUID(),
  });
const manage = (
  id: string,
  version: number,
  operation: "confirm" | "withdraw",
  name = "alice",
) =>
  service.mutate(s(name), project, {
    plan: {
      operation,
      decisionId: id,
      expectedVersion: version,
      confirmed: true,
    },
    sourceRefs: [],
    idempotencyKey: randomUUID(),
  });
test("Decision creates a stable unconfirmed object, versions edits and confirms only an explicit exact version", async () => {
  const key = randomUUID(),
    input = {
      plan: { operation: "create" as const },
      draft: draft(),
      sourceRefs: [],
      idempotencyKey: key,
    };
  const initial = await service.mutate(s(), project, input);
  assert.equal(initial.state, "proposed");
  assert.equal(initial.version, 1);
  assert.equal(
    (await service.current(s(), project)).some((r) => r.id === initial.id),
    false,
  );
  const edit = await service.mutate(s(), project, {
    plan: { operation: "revise", decisionId: initial.id, expectedVersion: 1 },
    draft: draft("员工修订"),
    sourceRefs: [],
    idempotencyKey: randomUUID(),
  });
  assert.equal(edit.version, 2);
  await assert.rejects(() => manage(initial.id, 1, "confirm"), /版本已变化/);
  const result = await manage(initial.id, 2, "confirm");
  assert.equal(result.state, "confirmed");
  assert.equal(result.version, 3);
  const read = await service.get(s(), initial.id);
  assert.equal(read.current.title, "员工修订");
  assert.equal(read.current.confirmedBy, s().id);
  assert.equal(read.history.length, 3);
  assert.equal(read.history[2]!.state, "proposed");
  assert.ok(
    (await service.current(s(), project)).some(
      (r) => r.id === initial.id && r.version === 3,
    ),
  );
  assert.deepEqual(await service.mutate(s(), project, input), initial);
  await assert.rejects(
    () => service.mutate(s(), project, { ...input, draft: draft("不同输入") }),
    /幂等键/,
  );
  await assert.rejects(
    () =>
      service.mutate(s(), project, {
        plan: {
          operation: "revise",
          decisionId: initial.id,
          expectedVersion: 3,
        },
        draft: draft(),
        sourceRefs: [],
        idempotencyKey: randomUUID(),
      }),
    /已确认决定/,
  );
  assert.equal(
    DecisionPlan.safeParse({
      operation: "confirm",
      decisionId: initial.id,
      expectedVersion: 3,
      confirmed: false,
    }).success,
    false,
  );
});
test("Same-key and competing-version concurrent writes cannot duplicate a decision or overwrite another edit", async () => {
  const input = {
    plan: { operation: "create" as const },
    draft: draft(),
    sourceRefs: [],
    idempotencyKey: randomUUID(),
  };
  const [a, b] = await Promise.all([
    service.mutate(s(), project, input),
    service.mutate(s(), project, input),
  ]);
  assert.equal(a.id, b.id);
  const results = await Promise.allSettled(
    ["one", "two"].map((title) =>
      service.mutate(s(), project, {
        plan: { operation: "revise", decisionId: a.id, expectedVersion: 1 },
        draft: draft(title),
        sourceRefs: [],
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await service.get(s(), a.id)).history.length, 2);
});
test("Current role, creator and project scope gate every decision operation and historical receipt", async () => {
  const a = await create();
  await assert.rejects(() => manage(a.id, 1, "confirm", "bob"), /创建人/);
  await assert.rejects(() => service.get(s("other"), a.id), /不存在/);
  await assert.rejects(() => service.get(s(), a.id, otherProject), /不存在/);
  await assert.rejects(
    () =>
      service.mutate({ ...s("bob"), role: "admin" }, project, {
        plan: {
          operation: "withdraw",
          decisionId: a.id,
          expectedVersion: 1,
          confirmed: true,
        },
        sourceRefs: [],
        idempotencyKey: randomUUID(),
      }),
    /创建人/,
  );
  await manage(a.id, 1, "confirm", "admin");
  await db.pool.query(
    "UPDATE cw_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
    [workspace, s("admin").id],
  );
  await assert.rejects(() => manage(a.id, 2, "withdraw", "admin"), /创建人/);
  await db.pool.query(
    "UPDATE cw_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",
    [workspace, s("admin").id],
  );
  await db.pool.query(
    "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [workspace, s().id],
  );
  await assert.rejects(() => service.get(s(), a.id));
  await db.pool.query(
    "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,'member')",
    [workspace, s().id],
  );
});
test("Replacement atomically confirms the new proposal, supersedes the exact old version and preserves both histories", async () => {
  const old = await create();
  await manage(old.id, 1, "confirm");
  const next = await create("alice", "替代方向");
  const key = randomUUID(),
    input = {
      plan: {
        operation: "confirm" as const,
        decisionId: next.id,
        expectedVersion: 1,
        confirmed: true as const,
        supersedes: { id: old.id, version: 2 },
      },
      sourceRefs: [],
      idempotencyKey: key,
    };
  const result = await service.mutate(s(), project, input);
  assert.equal(result.state, "confirmed");
  assert.deepEqual(result.superseded, { id: old.id, version: 3 });
  const before = await service.get(s(), old.id),
    after = await service.get(s(), next.id);
  assert.equal(before.current.state, "superseded");
  assert.equal(before.current.supersededBy, next.id);
  assert.equal(after.current.supersedesId, old.id);
  assert.equal(before.current.confirmedBy, s().id);
  const current = await service.current(s(), project);
  assert.ok(current.some((d) => d.id === next.id));
  assert.ok(!current.some((d) => d.id === old.id));
  assert.deepEqual(await service.mutate(s(), project, input), result);
  await assert.rejects(() => manage(old.id, 3, "confirm"), /待确认/);
  const foreign = await create("alice", "另一项目", otherProject),
    candidate = await create();
  await assert.rejects(
    () =>
      service.mutate(s(), project, {
        ...input,
        idempotencyKey: randomUUID(),
        plan: {
          ...input.plan,
          decisionId: candidate.id,
          supersedes: { id: foreign.id, version: 1 },
        },
      }),
    /不存在/,
  );
  await assert.rejects(
    () =>
      service.mutate(s(), project, {
        ...input,
        idempotencyKey: randomUUID(),
        plan: {
          ...input.plan,
          decisionId: candidate.id,
          supersedes: { id: candidate.id, version: 1 },
        },
      }),
    /自己/,
  );
});
test("Replacement failure rolls back both states, versions, relations and action receipts", async () => {
  const old = await create();
  await manage(old.id, 1, "confirm");
  const next = await create();
  await db.pool.query(
    "CREATE OR REPLACE FUNCTION decision_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.snapshot->>'title'='FAIL_SYNTHETIC_ONLY' THEN RAISE EXCEPTION 'synthetic fail'; END IF; RETURN NEW; END $$",
  );
  await service.mutate(s(), project, {
    plan: { operation: "revise", decisionId: next.id, expectedVersion: 1 },
    draft: draft("FAIL_SYNTHETIC_ONLY"),
    sourceRefs: [],
    idempotencyKey: randomUUID(),
  });
  await db.pool.query(
    "CREATE TRIGGER decision_fixture_fail BEFORE INSERT ON cw_decision_versions FOR EACH ROW EXECUTE FUNCTION decision_fixture_fail()",
  );
  try {
    await assert.rejects(
      () =>
        service.mutate(s(), project, {
          plan: {
            operation: "confirm",
            decisionId: next.id,
            expectedVersion: 2,
            confirmed: true,
            supersedes: { id: old.id, version: 2 },
          },
          sourceRefs: [],
          idempotencyKey: randomUUID(),
        }),
      /synthetic fail/,
    );
  } finally {
    await db.pool.query(
      "DROP TRIGGER decision_fixture_fail ON cw_decision_versions",
    );
    await db.pool.query("DROP FUNCTION decision_fixture_fail()");
  }
  assert.equal((await service.get(s(), old.id)).current.state, "confirmed");
  assert.equal((await service.get(s(), old.id)).history.length, 2);
  assert.equal((await service.get(s(), next.id)).current.state, "proposed");
});
test("Versioned discussion references reject stale proposals, redact derived history and retain explicitly adopted business records", async () => {
  const message = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_messages(id,workspace_id,conversation_id,author_id,author,role,content)VALUES($1,$2,$3,$4,'Synthetic employee','user','合成原始依据')",
    [message, workspace, conversation, s().id],
  );
  const source = (await service.sources(s(), project)).find((row) =>
    row.id.startsWith("message:" + message + "@"),
  )!;
  assert.ok(source);
  const a = await service.mutate(s(), project, {
    plan: { operation: "create" },
    draft: draft("来源提议"),
    sourceRefs: [source.id],
    idempotencyKey: randomUUID(),
  });
  const b = await service.mutate(s(), project, {
    plan: { operation: "create" },
    draft: draft("员工采纳记录"),
    sourceRefs: [source.id],
    idempotencyKey: randomUUID(),
  });
  await manage(b.id, 1, "confirm");
  await db.pool.query(
    "UPDATE cw_messages SET content='合成变更后的依据' WHERE id=$1",
    [message],
  );
  const hidden = await service.get(s(), a.id);
  assert.equal(hidden.current.content, null);
  assert.equal(hidden.current.basisAvailable, false);
  assert.ok(hidden.history.every((row) => row.content === null));
  await assert.rejects(() => manage(a.id, 1, "confirm"), /依据当前不可核验/);
  const retained = await service.get(s(), b.id);
  assert.equal(retained.current.title, "员工采纳记录");
  assert.equal(retained.current.basisAvailable, false);
  assert.equal(retained.history[1]!.content, null);
  assert.equal(
    (await service.list(s(), project)).find((row) => row.id === a.id)!.title,
    "依据当前不可核验的提议",
  );
  await manage(a.id, 1, "withdraw");
  assert.equal((await service.get(s(), a.id)).current.content, null);
});
test("Task/artifact relationships bind current same-project versions and persist in the product relation directory", async () => {
  const task = randomUUID(),
    artifact = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_tasks(id,workspace_id,project_id,title,created_by)VALUES($1,$2,$3,'Synthetic task',$4)",
    [task, workspace, project, s().id],
  );
  await db.pool.query(
    "INSERT INTO cw_artifacts(id,workspace_id,project_id,title,created_by)VALUES($1,$2,$3,'Synthetic artifact',$4)",
    [artifact, workspace, project, s().id],
  );
  const input = {
    plan: { operation: "create" as const },
    draft: {
      ...draft(),
      links: [
        { kind: "task" as const, id: task, version: 1 },
        { kind: "artifact" as const, id: artifact, version: 1 },
      ],
    },
    sourceRefs: [],
    idempotencyKey: randomUUID(),
  };
  const a = await service.mutate(s(), project, input);
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*) FROM cw_asset_links WHERE from_id=$1",
        [a.id],
      )
    ).rows[0].count,
    "2",
  );
  await db.pool.query("UPDATE cw_tasks SET version=2 WHERE id=$1", [task]);
  await assert.rejects(() => manage(a.id, 1, "confirm"), /关联待办或成果/);
  await assert.rejects(
    () =>
      service.mutate(s(), otherProject, {
        ...input,
        idempotencyKey: randomUUID(),
      }),
    /当前项目/,
  );
});
test("Host proofs bind scope/operation, recheck membership and allow AI provenance without giving the model confirmation authority", async () => {
  const plan = DecisionPlan.parse({ operation: "create" }),
    proof = await service.prepare(s(), project, plan),
    content = draft("AI 待确认提议");
  const run = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,idempotency_key,input_hash,decision_plan)VALUES($1,$2,$3,$4,'fixture','manage_decision','Synthetic core fixture',$5,'fixture',$6)",
    [run, workspace, s().id, conversation, run, { operation: "create" }],
  );
  const a = await db.tx((c) =>
    service.apply(c, s(), project, plan, content, proof, "ai-core-" + run, run),
  );
  assert.equal(a.state, "proposed");
  assert.equal(a.sourceRunId, run);
  assert.equal((await service.get(s(), a.id)).current.channel, "ai_assisted");
  await assert.rejects(
    () =>
      db.tx((c) =>
        service.apply(
          c,
          s(),
          otherProject,
          plan,
          content,
          proof,
          "bad-project",
        ),
      ),
    /来源已变化/,
  );
  const confirm = DecisionPlan.parse({
    operation: "confirm",
    decisionId: a.id,
    expectedVersion: 1,
    confirmed: true,
  });
  await assert.rejects(
    () =>
      db.tx((c) =>
        service.apply(
          c,
          s(),
          project,
          confirm,
          undefined,
          proof,
          "bad-operation",
        ),
      ),
    /已检查目标/,
  );
  await db.pool.query(
    "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [workspace, s().id],
  );
  await assert.rejects(
    () =>
      db.tx((c) =>
        service.apply(c, s(), project, plan, content, proof, "after-revoke"),
      ),
    /撤销/,
  );
  await db.pool.query(
    "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,'member')",
    [workspace, s().id],
  );
});

test("Worker saves an AI proposal, records explicit management, rejects stale targets and never accepts model-supplied confirmation", async () => {
  process.env.DEMO_MODE = "true";
  const workspaceService = new WorkspaceService(db, engineRegistry()),
    processor = new RunProcessor(workspaceService);
  const queue = async (plan: any, instruction = "合成 AI 决定测试") =>
    workspaceService.startRun(
      s(),
      RunInput.parse({
        conversationId: conversation,
        workflow: "manage_decision",
        engine: "fixture",
        decisionPlan: plan,
        instruction,
        idempotencyKey: randomUUID(),
      }),
    );
  const queued = await queue({ operation: "create" });
  await processor.process(queued.id);
  const first = await workspaceService.getRun(s(), queued.id);
  assert.equal(first.state, "succeeded", first.error);
  const receipt = first.result.receipts[0];
  assert.equal(receipt.state, "proposed");
  assert.ok(
    (await service.get(s(), receipt.id)).current.sourceRefs.every(
      (ref: string) => ref.startsWith("message:"),
    ),
  );
  const confirm = await queue({
    operation: "confirm",
    decisionId: receipt.id,
    expectedVersion: 1,
    confirmed: true,
  });
  await processor.process(confirm.id);
  assert.equal(
    (await workspaceService.getRun(s(), confirm.id)).state,
    "succeeded",
  );
  assert.equal((await service.get(s(), receipt.id)).current.state, "confirmed");
  const proposed = await create(),
    stale = await queue({
      operation: "confirm",
      decisionId: proposed.id,
      expectedVersion: 1,
      confirmed: true,
    });
  await service.mutate(s(), project, {
    plan: { operation: "revise", decisionId: proposed.id, expectedVersion: 1 },
    draft: draft("人工抢先修订"),
    sourceRefs: [],
    idempotencyKey: randomUUID(),
  });
  await processor.process(stale.id);
  assert.equal((await workspaceService.getRun(s(), stale.id)).state, "failed");
  assert.equal((await service.get(s(), proposed.id)).current.state, "proposed");
  const pending = await create(),
    malicious = new FixtureAdapter();
  malicious.execute = async () => ({
    text: "synthetic model claim",
    evidence: "fixture",
    actions: [
      {
        tool: "decision.manage",
        args: { decisionId: pending.id, confirmed: true },
      },
    ],
  });
  const registry = engineRegistry();
  registry.set("fixture", malicious);
  const unsafeWorkspace = new WorkspaceService(db, registry),
    unsafeProcessor = new RunProcessor(unsafeWorkspace),
    bad = await unsafeWorkspace.startRun(
      s(),
      RunInput.parse({
        conversationId: conversation,
        workflow: "manage_decision",
        engine: "fixture",
        decisionPlan: {
          operation: "confirm",
          decisionId: pending.id,
          expectedVersion: 1,
          confirmed: true,
        },
        instruction: "合成管理参数越界",
        idempotencyKey: randomUUID(),
      }),
    );
  await unsafeProcessor.process(bad.id);
  assert.equal((await unsafeWorkspace.getRun(s(), bad.id)).state, "failed");
  assert.equal((await service.get(s(), pending.id)).current.state, "proposed");
  const cancelled = await queue({ operation: "create" });
  await workspaceService.cancel(s(), cancelled.id);
  await processor.process(cancelled.id);
  assert.equal(
    (await workspaceService.getRun(s(), cancelled.id)).state,
    "cancelled",
  );
});
