import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { ArtifactReviewService } from "../../apps/api/src/core/artifact-reviews.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import {
  ArtifactReviewInput,
  RunInput,
  type Subject,
  type ArtifactReviewPlan,
} from "@hyper/contracts";
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
  const owner: Subject = {
    id: randomUUID(),
    workspaceId,
    name: "成果创建人",
    role: "member",
    demo: true,
  };
  const peer: Subject = { ...owner, id: randomUUID(), name: "普通同事" },
    admin: Subject = {
      ...owner,
      id: randomUUID(),
      name: "管理员",
      role: "admin",
    };
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name) VALUES($1,'Artifact review synthetic test')",
    [workspaceId],
  );
  for (const actor of [owner, peer, admin]) {
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
    reviews = new ArtifactReviewService(db),
    processor = new RunProcessor(service);
  const project = await service.createProject(
    owner,
    "验收测试项目",
    "准确绑定员工决定与版本",
  );
  const artifactId = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_artifacts(id,workspace_id,project_id,title,created_by) VALUES($1,$2,$3,'Review target',$4)",
    [artifactId, workspaceId, project.id, owner.id],
  );
  await db.pool.query(
    "INSERT INTO cw_artifact_versions(artifact_id,version,content,created_by) VALUES($1,1,'private-artifact-body-marker',$2)",
    [artifactId, owner.id],
  );
  const plan = (
    decision: ArtifactReviewPlan["decision"] = "accept",
    expectedReviewRevision = 0,
    expectedVersion = 1,
  ): ArtifactReviewPlan => ({
    expectedVersion,
    expectedReviewRevision,
    decision,
    feedback: "已逐项核对选定版本，保存明确意见。",
    confirmed: true,
  });
  const record = (input = plan(), actor = owner, key = randomUUID()) =>
    reviews.record(actor, artifactId, { ...input, idempotencyKey: key });
  const start = (input = plan(), actor = owner, key = randomUUID()) =>
    service.startRun(actor, {
      conversationId: project.conversationId,
      workflow: "review_artifact",
      artifactId,
      artifactReviewPlan: input,
      engine: "fixture",
      instruction: "严格代执行我确认的验收决定，不自行判断质量。",
      idempotencyKey: key,
    });
  return {
    owner,
    peer,
    admin,
    service,
    reviews,
    processor,
    project,
    artifactId,
    plan,
    record,
    start,
  };
}

test("Employee acceptance is version-bound and durable; new versions reopen as drafts without losing review history", async () => {
  const f = await setup(),
    key = randomUUID();
  await assert.rejects(
    db.pool.query(
      "UPDATE cw_artifacts SET status='accepted',accepted_version=1,review_revision=1 WHERE id=$1",
      [f.artifactId],
    ),
    /foreign key/,
  );
  const accepted = await f.record(f.plan(), f.owner, key);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.reviewerAuthority, "creator");
  assert.equal(accepted.channel, "human");
  let detail = await f.service.artifact(f.owner, f.artifactId);
  assert.equal(detail.current.acceptedVersion, 1);
  assert.equal(detail.current.reviewRevision, 1);
  assert.equal(detail.reviews.length, 1);
  assert.equal(detail.reviews[0].version, 1);
  assert.equal((await f.record(f.plan(), f.owner, key)).id, accepted.id);
  await assert.rejects(
    f.record({ ...f.plan(), feedback: "不同意见" }, f.owner, key),
    /相同幂等键/,
  );
  await f.service.revise(f.peer, f.artifactId, {
    content: "人工修改的第二版",
    feedback: "按真实情况修改",
    expectedVersion: 1,
  });
  detail = await f.service.artifact(f.owner, f.artifactId);
  assert.equal(detail.current.version, 2);
  assert.equal(detail.current.status, "draft");
  assert.equal(detail.current.acceptedVersion, null);
  assert.equal(detail.current.reviewRevision, 0);
  assert.equal(detail.versions[1].status, "accepted");
  assert.equal(detail.versions[1].acceptedVersion, 1);
  assert.equal(detail.versions[1].reviewRevision, 1);
  assert.equal(detail.reviews[0].status, "accepted");
  assert.equal(detail.reviews[0].version, 1);
  assert.equal((await f.record(f.plan(), f.owner, key)).id, accepted.id);
  await assert.rejects(f.record(f.plan()), /版本已变化/);
  const required = await f.record(f.plan("request_changes", 0, 2));
  assert.equal(required.status, "changes_requested");
  const reopened = await f.record(f.plan("reopen", 1, 2));
  assert.equal(reopened.status, "draft");
  assert.equal(
    (await f.service.artifact(f.owner, f.artifactId)).reviews.length,
    3,
  );
});

test("Reviewer authority comes from live ownership/roles and direct object scope, never the requested role", async () => {
  const f = await setup();
  assert.equal(
    (await f.service.artifact(f.peer, f.artifactId)).canReview,
    false,
  );
  await assert.rejects(
    f.record(f.plan(), { ...f.peer, role: "admin" }),
    /仅成果创建人/,
  );
  const accepted = await f.record(f.plan(), f.admin);
  assert.equal(accepted.reviewerAuthority, "workspace_admin");
  const outsider = await setup();
  await assert.rejects(
    f.reviews.record(outsider.admin, f.artifactId, {
      ...f.plan(),
      idempotencyKey: randomUUID(),
    }),
    /不存在/,
  );
  await db.pool.query(
    "UPDATE cw_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
    [f.admin.workspaceId, f.admin.id],
  );
  await assert.rejects(f.record(f.plan("reopen", 1), f.admin), /仅成果创建人/);
  await assert.rejects(
    f.reviews.record(f.owner, f.artifactId, {
      ...f.plan(),
      confirmed: false,
      idempotencyKey: randomUUID(),
    } as any),
  );
});

test("Concurrent review decisions cannot overwrite unseen feedback on the same artifact version", async () => {
  const f = await setup();
  const results = await Promise.allSettled([
    f.record(f.plan(), f.owner),
    f.record(f.plan("request_changes"), f.admin),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  assert.match(rejected.reason.message, /验收意见已变化/);
  const detail = await f.service.artifact(f.owner, f.artifactId);
  assert.equal(detail.current.reviewRevision, 1);
  assert.equal(detail.reviews.length, 1);
  await assert.rejects(
    db.pool.query(
      "UPDATE cw_artifacts SET status='accepted',accepted_version=NULL WHERE id=$1",
      [f.artifactId],
    ),
    /check constraint/,
  );
  await assert.rejects(
    db.pool.query("UPDATE cw_artifacts SET accepted_version=99 WHERE id=$1", [
      f.artifactId,
    ]),
    /check constraint|foreign key/,
  );
});

test("AI review receives only the confirmed decision and cannot choose a new verdict, target or reviewer", async () => {
  const f = await setup();
  let calls = 0;
  f.service.engines.set("fixture", {
    id: "fixture",
    describeCapabilities: () => ({
      configured: true,
      operations: ["review_artifact"],
      evidence: "test-only",
    }),
    execute: async (r) => {
      calls++;
      assert.ok(!r.context.includes("private-artifact-body-marker"));
      assert.match(r.context, /Host-bound artifact review decision/);
      return {
        text: "The model claims it verified everything.",
        actions: [{ tool: "artifact.review", args: {} }],
        evidence: "fixture",
      };
    },
  });
  const key = randomUUID(),
    run = await f.start(f.plan(), f.owner, key);
  await f.processor.process(run.id);
  const done = await f.service.getRun(f.owner, run.id);
  assert.equal(done.state, "succeeded", done.error);
  assert.equal(done.result.receipts[0].channel, "ai_assisted");
  assert.equal(done.result.receipts[0].sourceRunId, run.id);
  assert.ok(!done.result.text.includes("model claims"));
  assert.deepEqual(done.contextRefs, ["artifact:" + f.artifactId + "@1"]);
  assert.equal(
    (await f.service.view(f.owner, f.project.id)).messages.length,
    0,
  );
  assert.equal((await f.start(f.plan(), f.owner, key)).id, run.id);
  assert.equal(calls, 1);
  await assert.rejects(f.service.getRun(f.peer, run.id));
  f.service.engines.set("fixture", {
    id: "fixture",
    describeCapabilities: () => ({
      configured: true,
      operations: ["review_artifact"],
      evidence: "test-only",
    }),
    execute: async () => ({
      text: "Override verdict",
      actions: [
        {
          tool: "artifact.review",
          args: { decision: "accept", reviewerId: f.admin.id },
        },
      ],
      evidence: "fixture",
    }),
  });
  const override = await f.start(f.plan("request_changes", 1));
  await f.processor.process(override.id);
  assert.equal((await f.service.getRun(f.owner, override.id)).state, "failed");
  assert.equal(
    (await f.service.artifact(f.owner, f.artifactId)).reviews.length,
    1,
  );
});

test("Stale versions before dispatch or during model work never receive a new acceptance", async () => {
  for (const timing of ["before", "during"]) {
    const f = await setup();
    let calls = 0;
    const revise = () =>
      f.service.revise(f.peer, f.artifactId, {
        content: "Concurrent new version",
        feedback: "更新事实",
        expectedVersion: 1,
      });
    f.service.engines.set("fixture", {
      id: "fixture",
      describeCapabilities: () => ({
        configured: true,
        operations: ["review_artifact"],
        evidence: "test-only",
      }),
      execute: async () => {
        calls++;
        if (timing === "during") await revise();
        return {
          text: "Accept",
          actions: [{ tool: "artifact.review", args: {} }],
          evidence: "fixture",
        };
      },
    });
    const run = await f.start();
    if (timing === "before") await revise();
    await f.processor.process(run.id);
    assert.equal((await f.service.getRun(f.owner, run.id)).state, "failed");
    assert.equal(calls, timing === "before" ? 0 : 1);
    const detail = await f.service.artifact(f.owner, f.artifactId);
    assert.equal(detail.current.version, 2);
    assert.equal(detail.current.status, "draft");
    assert.equal(detail.reviews.length, 0);
  }
});

test("Cancelled or revoked review Runs cannot save decisions; review and state changes roll back together", async () => {
  const f = await setup(),
    cancelled = await f.start();
  await f.service.cancel(f.owner, cancelled.id);
  await f.processor.process(cancelled.id);
  assert.equal(
    (await f.service.getRun(f.owner, cancelled.id)).state,
    "cancelled",
  );
  f.service.engines.set("fixture", {
    id: "fixture",
    describeCapabilities: () => ({
      configured: true,
      operations: ["review_artifact"],
      evidence: "test-only",
    }),
    execute: async () => {
      await db.pool.query(
        "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
        [f.owner.workspaceId, f.owner.id],
      );
      return {
        text: "Accept",
        actions: [{ tool: "artifact.review", args: {} }],
        evidence: "fixture",
      };
    },
  });
  const revoked = await f.start();
  await f.processor.process(revoked.id);
  assert.equal(
    (
      await db.pool.query(
        "SELECT id FROM cw_artifact_reviews WHERE artifact_id=$1",
        [f.artifactId],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await db.pool.query("SELECT status FROM cw_artifacts WHERE id=$1", [
        f.artifactId,
      ])
    ).rows[0].status,
    "draft",
  );
  const other = await setup(),
    suffix = randomUUID().replaceAll("-", ""),
    fn = "review_fault_" + suffix;
  await db.pool.query(
    `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${other.artifactId}'::uuid THEN RAISE EXCEPTION 'Synthetic review state fault'; END IF; RETURN NEW; END $$`,
  );
  await db.pool.query(
    `CREATE TRIGGER ${fn} BEFORE UPDATE ON cw_artifacts FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
  );
  try {
    await assert.rejects(other.record(), /Synthetic review state fault/);
  } finally {
    await db.pool.query(`DROP TRIGGER ${fn} ON cw_artifacts`);
    await db.pool.query(`DROP FUNCTION ${fn}()`);
  }
  assert.equal(
    (await other.service.artifact(other.owner, other.artifactId)).reviews
      .length,
    0,
  );
});

test("Review plans and capabilities are strict; wrong workflows and mismatched projects do not create executable Runs", async () => {
  const f = await setup();
  assert.throws(() =>
    ArtifactReviewInput.parse({
      ...f.plan(),
      idempotencyKey: randomUUID(),
      reviewerId: f.admin.id,
    }),
  );
  assert.throws(() =>
    RunInput.parse({
      conversationId: f.project.conversationId,
      workflow: "review_artifact",
      engine: "fixture",
      instruction: "Accept",
      artifactId: f.artifactId,
      artifactReviewPlan: { ...f.plan(), confirmed: false },
      idempotencyKey: randomUUID(),
    }),
  );
  await assert.rejects(
    f.service.startRun(f.owner, {
      conversationId: f.project.conversationId,
      workflow: "chat",
      engine: "fixture",
      instruction: "No bypass",
      artifactReviewPlan: f.plan(),
      idempotencyKey: randomUUID(),
    }),
    /不接受验收决定/,
  );
  const other = await f.service.createProject(
    f.owner,
    "另一个项目",
    "范围隔离",
  );
  await assert.rejects(
    f.service.startRun(f.owner, {
      conversationId: other.conversationId,
      workflow: "review_artifact",
      engine: "fixture",
      instruction: "Wrong project",
      artifactId: f.artifactId,
      artifactReviewPlan: f.plan(),
      idempotencyKey: randomUUID(),
    }),
    /当前项目/,
  );
  f.service.engines.set("fixture", {
    id: "fixture",
    describeCapabilities: () => ({
      configured: true,
      operations: ["chat"],
      evidence: "test-only",
    }),
    execute: async () => {
      throw new Error("Must not execute");
    },
  });
  await assert.rejects(f.start(), /未声明验收代执行能力/);
});
