import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { MethodsService } from "../../apps/api/src/core/methods.js";
import { KnowledgeService } from "../../apps/api/src/core/knowledge.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { MethodPlan, RunInput, type Subject } from "@hyper/contracts";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Use an isolated _test database.");
const db = new Database(url);
before(async () => {
  process.env.DEMO_MODE = "true";
  process.env.CREDENTIAL_MASTER_KEY = "ab".repeat(32);
  await db.migrate();
});
after(async () => db.close());
const draft = {
  title: "Synthetic reusable method",
  kind: "sop" as const,
  content: "synthetic-method-guidance: check evidence before saving a result.",
};
async function setup(execute?: any) {
  const workspaceId = randomUUID(),
    owner: Subject = {
      id: randomUUID(),
      workspaceId,
      name: "Method maintainer",
      role: "member",
      demo: true,
    },
    peer: Subject = { ...owner, id: randomUUID(), name: "Method reader" },
    admin: Subject = {
      ...owner,
      id: randomUUID(),
      name: "Method admin",
      role: "admin",
    };
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name) VALUES($1,'Methods synthetic test')",
    [workspaceId],
  );
  for (const s of [owner, peer, admin]) {
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
    processor = new RunProcessor(service),
    methods = new MethodsService(db);
  const project = await service.createProject(
    owner,
    "Method source project",
    "Retain provenance without policy promotion",
  );
  await service.message(
    owner,
    project.conversationId,
    "discussion-body-must-not-enter-method-generation",
  );
  const artifactId = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_artifacts(id,workspace_id,project_id,title,created_by) VALUES($1,$2,$3,'Synthetic source artifact',$4)",
    [artifactId, workspaceId, project.id, owner.id],
  );
  await db.pool.query(
    "INSERT INTO cw_artifact_versions(artifact_id,version,content,created_by) VALUES($1,1,'selected-source-artifact-body',$2)",
    [artifactId, owner.id],
  );
  const createPlan: MethodPlan = {
    operation: "create",
    sourceArtifactId: artifactId,
    expectedSourceVersion: 1,
  };
  const record = (
    plan: MethodPlan,
    actor = owner,
    body: any = undefined,
    key = randomUUID(),
  ) =>
    methods.record(actor, project.id, {
      plan,
      ...(body ? { draft: body } : {}),
      idempotencyKey: key,
    });
  const create = () => record(createPlan, owner, draft);
  const target = (m: any) => ({
    methodId: m.id,
    expectedVersion: m.version,
    expectedRevision: m.revision,
  });
  const publish = async (scope: "project" | "workspace" = "project") => {
    const created = await create();
    const verified = await record({
      operation: "verify",
      ...target(created),
      evidence: "Employee checked this synthetic example and its evidence.",
      confirmed: true,
    });
    return record(
      { operation: "publish", ...target(verified), scope, confirmed: true },
      scope === "workspace" ? admin : owner,
    );
  };
  const start = (plan: MethodPlan, key = randomUUID()) =>
    service.startRun(owner, {
      conversationId: project.conversationId,
      workflow: "manage_method",
      methodPlan: plan,
      engine: "fixture",
      instruction: "Use only this selected source and my confirmed operation.",
      idempotencyKey: key,
    });
  const refs = (m: any) => [
    { id: m.id, version: m.version, revision: m.revision },
  ];
  const reuse = (
    m: any,
    conversationId = project.conversationId,
    key = randomUUID(),
  ) =>
    service.startRun(owner, {
      conversationId,
      workflow: "discussion_to_minutes",
      engine: "fixture",
      methodRefs: refs(m),
      instruction:
        "Apply the selected published method as guidance, not current facts.",
      idempotencyKey: key,
    });
  return {
    owner,
    peer,
    admin,
    service,
    processor,
    methods,
    project,
    artifactId,
    createPlan,
    record,
    create,
    target,
    publish,
    start,
    refs,
    reuse,
    engines,
  };
}
const result = (tool: string, args: any) => ({
  text: "Model claims the company independently verified and published this",
  actions: [{ tool, args }],
  evidence: "fixture",
});

test("Concurrent human method creation replays one canonical receipt and preserves the original source snapshot after later source edits", async () => {
  const f = await setup(),
    key = randomUUID();
  const [first, second] = await Promise.all([
    f.record(f.createPlan, f.owner, draft, key),
    f.record(f.createPlan, f.owner, draft, key),
  ]);
  assert.deepEqual(second, first);
  assert.equal(
    (
      await db.pool.query("SELECT id FROM cw_methods WHERE workspace_id=$1", [
        f.owner.workspaceId,
      ])
    ).rowCount,
    1,
  );
  await assert.rejects(
    f.record(
      f.createPlan,
      f.owner,
      { ...draft, title: "Different input" },
      key,
    ),
    /幂等键/,
  );
  await f.service.revise(f.owner, f.artifactId, {
    content: "A later source artifact version",
    feedback: "Source changed after candidate capture.",
    expectedVersion: 1,
  });
  assert.deepEqual(await f.record(f.createPlan, f.owner, draft, key), first);
  assert.equal(
    (await f.methods.get(f.owner, first.id)).current.sourceVersion,
    1,
  );
  await assert.rejects(f.create(), /来源成果已变化/);
});

test("Method lifecycle retains provenance, separates employee verification and publication, and hides unpublished history from readers", async () => {
  const f = await setup(),
    m = await f.create();
  assert.equal(m.state, "candidate");
  assert.equal(m.verification, "candidate");
  await assert.rejects(f.methods.get(f.peer, m.id));
  assert.equal(
    (await f.service.search(f.owner, "Synthetic reusable")).length,
    0,
  );
  await assert.rejects(
    f.record({
      operation: "publish",
      ...f.target(m),
      scope: "project",
      confirmed: true,
    }),
    /先由员工/,
  );
  await assert.rejects(
    f.record({ operation: "revise", ...f.target(m) }, f.peer, draft),
    /无权|维护人/,
  );
  const revised = await f.record(
    { operation: "revise", ...f.target(m) },
    f.owner,
    { ...draft, title: "Published synthetic method" },
  );
  const verified = await f.record({
    operation: "verify",
    ...f.target(revised),
    evidence: "Actual employee declaration, not model quality evidence.",
    confirmed: true,
  });
  await assert.rejects(
    f.record({
      operation: "publish",
      ...f.target(verified),
      scope: "workspace",
      confirmed: true,
    }),
    /管理员/,
  );
  const key = randomUUID(),
    plan: MethodPlan = {
      operation: "publish",
      ...f.target(verified),
      scope: "project",
      confirmed: true,
    };
  const published = await f.record(plan, f.owner, undefined, key);
  assert.equal(published.version, 2);
  assert.equal(published.revision, 4);
  assert.deepEqual(await f.record(plan, f.owner, undefined, key), published);
  const reader = await f.methods.get(f.peer, m.id);
  assert.deepEqual(
    reader.versions.map((x: any) => x.version),
    [2],
  );
  assert.deepEqual(
    reader.actions.map((x: any) => x.operation),
    ["publish"],
  );
  assert.equal(reader.current.sourceArtifactId, f.artifactId);
  assert.equal(reader.current.sourceVersion, 1);
  assert.equal((await f.methods.get(f.owner, m.id)).versions.length, 2);
  assert.equal(
    (await f.service.search(f.peer, "Published synthetic method"))[0].id,
    m.id,
  );
  const withdrawn = await f.record({
    operation: "withdraw",
    ...f.target(published),
    reason: "Retired synthetic practice.",
    confirmed: true,
  });
  assert.equal(withdrawn.state, "withdrawn");
  await assert.rejects(f.methods.get(f.peer, m.id));
  assert.equal(
    (await f.service.search(f.peer, "Published synthetic method")).length,
    0,
  );
  const newer = await f.record(
    { operation: "revise", ...f.target(withdrawn) },
    f.owner,
    draft,
  );
  assert.equal(newer.version, 3);
  assert.equal(newer.verification, "candidate");
  assert.equal(newer.state, "candidate");
  assert.equal((await f.methods.get(f.owner, m.id)).current.evidence, "");
});

test("AI method drafting and confirmed management use the same services, preserve employee decisions and never publish model raw text", async () => {
  const seen: string[] = [];
  const f = await setup(async (r: any) => {
    seen.push(r.context);
    return r.context.includes("Host-bound method draft.")
      ? result("method.write", draft)
      : result("method.manage", {});
  });
  const key = randomUUID(),
    run = await f.start(f.createPlan, key);
  await f.processor.process(run.id);
  const saved = await f.service.getRun(f.owner, run.id),
    m = saved.result.receipts[0];
  assert.equal(saved.state, "succeeded", saved.error);
  assert.equal(m.state, "candidate");
  assert.equal(m.sourceRunId, run.id);
  assert.equal((await f.start(f.createPlan, key)).id, run.id);
  assert.ok(seen[0].includes("selected-source-artifact-body"));
  assert.ok(
    !seen[0].includes("discussion-body-must-not-enter-method-generation"),
  );
  const verify = await f.start({
    operation: "verify",
    ...f.target(m),
    evidence: "Explicit employee validation evidence.",
    confirmed: true,
  });
  await f.processor.process(verify.id);
  const verified = (await f.service.getRun(f.owner, verify.id)).result
    .receipts[0];
  assert.equal(verified.verification, "employee_verified");
  assert.equal(verified.evidence, "Explicit employee validation evidence.");
  assert.ok(!seen[1].includes("synthetic-method-guidance"));
  assert.ok(!seen[1].includes("selected-source-artifact-body"));
  const publish = await f.start({
    operation: "publish",
    ...f.target(verified),
    scope: "project",
    confirmed: true,
  });
  await f.processor.process(publish.id);
  assert.equal((await f.methods.get(f.peer, m.id)).current.state, "published");
  assert.equal(
    (
      await db.pool.query(
        "SELECT id FROM cw_messages WHERE metadata->>'runId'=ANY($1::text[])",
        [[run.id, verify.id, publish.id]],
      )
    ).rowCount,
    0,
  );
  assert.ok(
    !(await f.service.getRun(f.owner, publish.id)).result.text.includes(
      "company independently",
    ),
  );
  await assert.rejects(f.service.getRun(f.peer, run.id));
  f.engines.get("fixture")!.execute = async () =>
    result("method.manage", { scope: "workspace" });
  const withdraw = await f.start({
    operation: "withdraw",
    ...f.target((await f.methods.get(f.owner, m.id)).current),
    reason: "Confirmed retirement.",
    confirmed: true,
  });
  await f.processor.process(withdraw.id);
  assert.equal((await f.service.getRun(f.owner, withdraw.id)).state, "failed");
  assert.equal((await f.methods.get(f.owner, m.id)).current.state, "published");
  assert.throws(() =>
    MethodPlan.parse({
      operation: "verify",
      ...f.target(m),
      evidence: "unconfirmed",
    }),
  );
  assert.throws(() =>
    RunInput.parse({
      conversationId: f.project.conversationId,
      workflow: "manage_method",
      engine: "fixture",
      methodPlan: f.createPlan,
      actorId: f.admin.id,
      instruction: "spoof",
      idempotencyKey: randomUUID(),
    }),
  );
});

test("Content and governance revisions serialize concurrent edits and reject model-before/model-during stale proposals", async () => {
  let calls = 0;
  const f = await setup(async () => {
      calls++;
      return result("method.write", draft);
    }),
    m = await f.create();
  const outcomes = await Promise.allSettled([
    f.record({ operation: "revise", ...f.target(m) }, f.owner, {
      ...draft,
      title: "First",
    }),
    f.record({ operation: "revise", ...f.target(m) }, f.owner, {
      ...draft,
      title: "Second",
    }),
  ]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  const current = (await f.methods.get(f.owner, m.id)).current;
  const queued = await f.start({ operation: "revise", ...f.target(current) });
  const next = await f.record(
    { operation: "revise", ...f.target(current) },
    f.owner,
    { ...draft, title: "Human wins before model" },
  );
  await f.processor.process(queued.id);
  assert.equal(calls, 0);
  assert.equal((await f.service.getRun(f.owner, queued.id)).state, "failed");
  f.engines.get("fixture")!.execute = async () => {
    calls++;
    await f.record({ operation: "revise", ...f.target(next) }, f.owner, {
      ...draft,
      title: "Human wins during model",
    });
    return result("method.write", {
      ...draft,
      title: "Must not replace human",
    });
  };
  const active = await f.start({ operation: "revise", ...f.target(next) });
  await f.processor.process(active.id);
  assert.equal(calls, 1);
  assert.equal((await f.service.getRun(f.owner, active.id)).state, "failed");
  assert.equal(
    (await f.methods.get(f.owner, m.id)).current.title,
    "Human wins during model",
  );
});

test("Published method reuse pins context, provenance and private usage records, and withdrawal blocks queued and in-flight artifact writes", async () => {
  let calls = 0;
  const f = await setup(async (r: any) => {
      calls++;
      assert.ok(r.context.includes(draft.content));
      assert.ok(r.context.includes("NOT policy"));
      return result("artifact.create", {
        title: "Derived synthetic artifact",
        content: "Method-derived draft, not policy.",
      });
    }),
    m = await f.publish();
  const reuseKey = randomUUID();
  const run = await f.reuse(m, f.project.conversationId, reuseKey);
  await f.processor.process(run.id);
  const saved = await f.service.getRun(f.owner, run.id);
  assert.equal(saved.state, "succeeded", saved.error);
  const ref = "method:" + m.id + "@" + m.version + "#" + m.revision;
  assert.ok(saved.contextRefs.includes(ref));
  const artifact = await f.service.artifact(
    f.owner,
    saved.result.receipts[0].id,
  );
  assert.ok(artifact.current.sourceMessageIds.includes(ref));
  assert.equal(
    (
      await db.pool.query(
        "SELECT source_version FROM cw_asset_links WHERE from_id=$1 AND to_id=$2 AND relation='reused_method'",
        [artifact.current.id, m.id],
      )
    ).rows[0].source_version,
    "1:3",
  );
  assert.equal((await f.methods.get(f.owner, m.id)).uses.length, 1);
  assert.equal((await f.methods.get(f.peer, m.id)).uses.length, 0);
  await f.processor.process(run.id);
  assert.equal(calls, 1);
  const queued = await f.reuse(m);
  const withdrawn = await f.record({
    operation: "withdraw",
    ...f.target(m),
    reason: "Retire before next dispatch.",
    confirmed: true,
  });
  assert.equal(
    (await f.reuse(m, f.project.conversationId, reuseKey)).id,
    run.id,
  );
  await f.processor.process(queued.id);
  assert.equal(calls, 1);
  assert.equal((await f.service.getRun(f.owner, queued.id)).state, "failed");
  const republished = await f.record({
    operation: "publish",
    ...f.target(withdrawn),
    scope: "project",
    confirmed: true,
  });
  f.engines.get("fixture")!.execute = async () => {
    calls++;
    await f.record({
      operation: "withdraw",
      ...f.target(republished),
      reason: "Retire while model works.",
      confirmed: true,
    });
    return result("artifact.create", {
      title: "Must not save",
      content: "Stale method content",
    });
  };
  const active = await f.reuse(republished);
  await f.processor.process(active.id);
  assert.equal(calls, 2);
  assert.equal((await f.service.getRun(f.owner, active.id)).state, "failed");
  assert.equal(
    (
      await db.pool.query("SELECT id FROM cw_actions WHERE run_id=$1", [
        active.id,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (await f.methods.get(f.owner, m.id)).uses.find(
      (x: any) => x.runId === active.id,
    ).state,
    "failed",
  );
});

test("Method IDs, publication role and source intersections cannot be widened by cross-project or workspace references", async () => {
  const f = await setup(),
    outside = await setup(),
    m = await f.publish(),
    other = await f.service.createProject(
      f.owner,
      "Other method target",
      "Check scope",
    );
  await assert.rejects(f.methods.get(outside.owner, m.id));
  await assert.rejects(f.reuse(m, other.conversationId), /范围/);
  await assert.rejects(
    f.methods.references(f.owner, f.project.id, [...f.refs(m), ...f.refs(m)]),
    /重复/,
  );
  await assert.rejects(
    f.record(
      {
        operation: "create",
        sourceArtifactId: outside.artifactId,
        expectedSourceVersion: 1,
      },
      f.owner,
      draft,
    ),
  );
  const withdrawn = await f.record({
    operation: "withdraw",
    ...f.target(m),
    reason: "Switch verified publication scope.",
    confirmed: true,
  });
  const global = await f.record(
    {
      operation: "publish",
      ...f.target(withdrawn),
      scope: "workspace",
      confirmed: true,
    },
    f.admin,
  );
  assert.equal(
    (await f.methods.references(f.peer, other.id, f.refs(global))).length,
    1,
  );
  const staleRole = await f.record({
    operation: "withdraw",
    ...f.target(global),
    reason: "Check current admin role.",
    confirmed: true,
  });
  const plan: MethodPlan = {
    operation: "publish",
    ...f.target(staleRole),
    scope: "workspace",
    confirmed: true,
  };
  await f.methods.prepare(f.admin, plan, f.project.id);
  await db.pool.query(
    "UPDATE cw_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
    [f.admin.workspaceId, f.admin.id],
  );
  await assert.rejects(
    db.tx((c) =>
      MethodsService.apply(
        c,
        f.admin,
        f.project.id,
        plan,
        undefined,
        randomUUID(),
      ),
    ),
    /管理权限|管理员/,
  );
  await db.pool.query(
    "UPDATE cw_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",
    [f.admin.workspaceId, f.admin.id],
  );
  // An explicit provider fixture grants preflight source reads; transaction guards still must prevent widening.
  await db.pool.query(
    "INSERT INTO cw_project_sources(project_id,workspace_id,provider_key,source_kind,conversation_ref,created_by) VALUES($1,$2,'synthetic','nextcloud-talk','methodroom01',$3)",
    [f.project.id, f.owner.workspaceId, f.owner.id],
  );
  f.methods.access.assert = async () => undefined;
  await assert.rejects(f.methods.prepare(f.admin, plan, f.project.id), /来源/);
  await assert.rejects(
    db.tx((c) =>
      MethodsService.apply(
        c,
        f.admin,
        f.project.id,
        plan,
        undefined,
        randomUUID(),
      ),
    ),
    /来源/,
  );
});

test("Queued cancellation and membership loss during generation prevent method writes, and audit failure rolls back content and asset state", async () => {
  let calls = 0;
  const f = await setup(async () => {
    calls++;
    return result("method.write", draft);
  });
  const cancelled = await f.start(f.createPlan);
  await f.service.cancel(f.owner, cancelled.id);
  await f.processor.process(cancelled.id);
  assert.equal(calls, 0);
  f.engines.get("fixture")!.execute = async () => {
    calls++;
    await db.pool.query(
      "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
      [f.owner.workspaceId, f.owner.id],
    );
    return result("method.write", draft);
  };
  const revoked = await f.start(f.createPlan);
  await f.processor.process(revoked.id);
  assert.equal(calls, 1);
  assert.equal(
    (
      await db.pool.query("SELECT id FROM cw_methods WHERE workspace_id=$1", [
        f.owner.workspaceId,
      ])
    ).rowCount,
    0,
  );
  await db.pool.query(
    "INSERT INTO cw_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
    [f.owner.workspaceId, f.owner.id],
  );
  const m = await f.create(),
    trigger = "method_fail_" + randomUUID().replaceAll("-", "");
  await db.pool.query(
    `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.method_id='${m.id}'::uuid THEN RAISE EXCEPTION 'injected method audit failure'; END IF; RETURN NEW; END $$`,
  );
  await db.pool.query(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON cw_method_actions FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
  );
  try {
    await assert.rejects(
      f.record({ operation: "revise", ...f.target(m) }, f.owner, {
        ...draft,
        title: "Must roll back",
      }),
      /injected method audit failure/,
    );
    const detail = await f.methods.get(f.owner, m.id);
    assert.equal(detail.current.version, 1);
    assert.equal(detail.current.title, draft.title);
    assert.equal(detail.versions.length, 1);
    const asset = (
      await db.pool.query(
        "SELECT title,source_version,validity FROM cw_assets WHERE id=$1",
        [m.id],
      )
    ).rows[0];
    assert.deepEqual(asset, {
      title: draft.title,
      source_version: "1:1",
      validity: "inactive",
    });
  } finally {
    await db.pool.query(`DROP TRIGGER ${trigger} ON cw_method_actions`);
    await db.pool.query(`DROP FUNCTION ${trigger}()`);
  }
});

test("Withdrawal invalidates keyword and semantic results and cannot be undone by an embedding response already in flight", async () => {
  const f = await setup(),
    m = await f.publish();
  let during: undefined | (() => Promise<void>);
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    if (during) {
      const fn = during;
      during = undefined;
      await fn();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const profile = await f.service.saveModel(f.owner, {
      name: "Synthetic methods embedding",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:" + (server.address() as any).port + "/v1",
      model: "method-vector-2d",
      purpose: "embedding",
      scope: "personal",
      apiKey: "synthetic-method-embedding-key",
    });
    const knowledge = new KnowledgeService(db);
    assert.deepEqual(
      (await knowledge.index(f.owner, [m.id], profile.id)).indexed,
      [m.id],
    );
    assert.equal(
      (await knowledge.semantic(f.owner, "Synthetic method", profile.id))[0].id,
      m.id,
    );
    during = async () => {
      await f.record({
        operation: "withdraw",
        ...f.target(m),
        reason: "Retired during semantic request.",
        confirmed: true,
      });
    };
    assert.equal(
      (await knowledge.semantic(f.owner, "Synthetic method", profile.id))
        .length,
      0,
    );
    const withdrawn = (await f.methods.get(f.owner, m.id)).current;
    const republished = await f.record({
      operation: "publish",
      ...f.target(withdrawn),
      scope: "project",
      confirmed: true,
    });
    during = async () => {
      await f.record({
        operation: "withdraw",
        ...f.target(republished),
        reason: "Retired during index request.",
        confirmed: true,
      });
    };
    const indexed = await knowledge.index(f.owner, [m.id], profile.id);
    assert.deepEqual(indexed.indexed, []);
    assert.deepEqual(indexed.skipped, [m.id]);
    assert.equal(
      (
        await db.pool.query("SELECT embedding FROM cw_assets WHERE id=$1", [
          m.id,
        ])
      ).rows[0].embedding,
      null,
    );
    assert.deepEqual(
      await MethodsService.filterAssets(db, [
        { id: m.id, sourceRef: "method:" + m.id, sourceVersion: "1:3" },
      ]),
      [],
    );
    // Corrupt cache flags cannot turn a withdrawn governed method into knowledge.
    await db.pool.query(
      "UPDATE cw_assets SET validity='active',visibility='workspace',source_ref='artifact:corrupted-cache',source_version='1:3',embedding='[1,0]'::vector,embedding_profile_id=$2,embedding_dimensions=2,embedding_model='method-vector-2d',embedding_source_version='1:3',embedding_version='text-v1' WHERE id=$1",
      [m.id, profile.id],
    );
    await assert.rejects(
      knowledge.index(f.owner, [m.id], profile.id),
      /方法未发布|撤回/,
    );
    assert.equal(
      (await f.service.search(f.owner, "Synthetic reusable method")).length,
      0,
    );
    assert.equal(
      (await knowledge.semantic(f.owner, "Synthetic method", profile.id))
        .length,
      0,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
