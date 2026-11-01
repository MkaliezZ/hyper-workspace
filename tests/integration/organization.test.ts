import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Subject } from "@hyper/contracts";
import { RunInput } from "@hyper/contracts";
import { Database } from "../../apps/api/src/db/database.js";
import { OrganizationService } from "../../apps/api/src/core/organization.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Use an isolated _test database.");
const db = new Database(url);
before(async () => {
  process.env.DEMO_MODE = "true";
  await db.migrate();
});
after(async () => db.close());
async function setup() {
  const workspaceId = randomUUID();
  const admin: Subject = {
    id: randomUUID(),
    workspaceId,
    name: "组织管理员",
    role: "admin",
    demo: true,
  };
  const member: Subject = {
    ...admin,
    id: randomUUID(),
    name: "陈 同名",
    role: "member",
  };
  const another: Subject = { ...member, id: randomUUID() };
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name)VALUES($1,'Synthetic organization')",
    [workspaceId],
  );
  for (const s of [admin, member, another]) {
    await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
      s.id,
      s.name,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,$3)",
      [workspaceId, s.id, s.role],
    );
  }
  const organization = new OrganizationService(db),
    engines = engineRegistry(),
    service = new WorkspaceService(db, engines),
    processor = new RunProcessor(service);
  const project = await service.createProject(
    admin,
    "组织验证项目",
    "No permission expansion",
  );
  const save = (plan: any, actor = admin, key = randomUUID()) =>
    organization.save(
      actor,
      { bindingKey: "demo:workspace-members", ...plan },
      key,
    );
  const create = (name: string, revision = 0, parentId: string | null = null) =>
    save({
      operation: "create_department",
      name,
      parentId,
      expectedRevision: revision,
      confirmed: true,
    });
  const start = (plan: any, actor = admin, key = randomUUID()) =>
    service.startRun(
      actor,
      RunInput.parse({
        conversationId: project.conversationId,
        workflow: "manage_organization",
        organizationPlan: { bindingKey: "demo:workspace-members", ...plan },
        engine: "fixture",
        instruction: "仅执行当前明确选择",
        idempotencyKey: key,
      }),
    );
  return {
    admin,
    member,
    another,
    organization,
    engines,
    service,
    processor,
    project,
    save,
    create,
    start,
  };
}
test("Organization directory preserves duplicate names, paginates, searches and rejects cross-workspace scope", async () => {
  const f = await setup();
  const view = await f.organization.read(f.member);
  assert.equal(view.origin, "demo");
  assert.equal(view.canManage, false);
  assert.equal(view.rows.length, 3);
  const found = await f.organization.read(f.member, { query: "陈" });
  assert.equal(found.rows.length, 2);
  assert.notEqual(found.rows[0].uid, found.rows[1].uid);
  for (let i = 0; i < 35; i++) {
    const id = randomUUID();
    await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
      id,
      "分页员工 " + i,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,'member')",
      [f.admin.workspaceId, id],
    );
  }
  const firstPage = await f.organization.read(f.member),
    secondPage = await f.organization.read(f.member, { offset: 30 });
  assert.equal(firstPage.rows.length, 30);
  assert.equal(firstPage.nextOffset, 30);
  assert.equal(secondPage.rows.length, 8);
  assert.equal(secondPage.nextOffset, null);
  assert.equal(
    new Set([...firstPage.rows, ...secondPage.rows].map((r) => r.uid)).size,
    38,
  );
  const parent = await f.create("研发");
  await assert.rejects(
    f.organization.read(f.member, { departmentId: randomUUID() }),
  );
  const other = await setup();
  await assert.rejects(
    other.organization.read(other.admin, { departmentId: parent.departmentId }),
  );
});
test("Organization mutations share CAS, idempotency, audit and strict current-admin authorization", async () => {
  const f = await setup(),
    key = randomUUID(),
    plan = {
      operation: "create_department",
      name: "产品",
      parentId: null,
      expectedRevision: 0,
      confirmed: true,
    };
  const saved = await f.save(plan, f.admin, key);
  assert.deepEqual(await f.save(plan, f.admin, key), saved);
  assert.equal((await f.organization.read(f.admin)).recentChanges.length, 1);
  assert.equal((await f.organization.read(f.member)).recentChanges.length, 0);
  await assert.rejects(
    f.save({ ...plan, name: "冲突" }, f.admin, key),
    /幂等键/,
  );
  await assert.rejects(f.create("过期"), /已更新/);
  await assert.rejects(
    f.save({ ...plan, expectedRevision: 1 }, f.member),
    /管理员/,
  );
  await db.pool.query(
    "UPDATE cw_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
    [f.admin.workspaceId, f.admin.id],
  );
  await assert.rejects(
    f.save({ ...plan, expectedRevision: 1 }, f.admin),
    /管理员/,
  );
  const audit = (
    await db.pool.query(
      "SELECT count(*)::int AS n FROM cw_organization_changes WHERE workspace_id=$1",
      [f.admin.workspaceId],
    )
  ).rows[0];
  assert.equal(audit.n, 1);
});
test("Organization rejects cycles, same-level duplicates and deletion of occupied departments; assignments never add project permissions", async () => {
  const f = await setup(),
    parent = await f.create("研发"),
    child = await f.create("平台", 1, parent.departmentId as string);
  await assert.rejects(
    f.create("平台", 2, parent.departmentId as string),
    /同名/,
  );
  await assert.rejects(
    f.save({
      operation: "update_department",
      departmentId: parent.departmentId,
      name: "研发",
      parentId: child.departmentId,
      expectedRevision: 2,
      confirmed: true,
    }),
    /循环/,
  );
  await assert.rejects(
    f.save({
      operation: "delete_department",
      departmentId: parent.departmentId,
      expectedRevision: 2,
      confirmed: true,
    }),
    /子部门/,
  );
  await f.save({
    operation: "assign_department",
    uid: f.member.id,
    departmentId: child.departmentId,
    expectedRevision: 2,
    confirmed: true,
  });
  assert.equal(
    (await f.organization.read(f.member, { departmentId: child.departmentId }))
      .rows.length,
    1,
  );
  await assert.rejects(
    f.save({
      operation: "delete_department",
      departmentId: child.departmentId,
      expectedRevision: 3,
      confirmed: true,
    }),
    /成员/,
  );
  await assert.rejects(
    f.save({
      operation: "assign_department",
      uid: randomUUID(),
      departmentId: child.departmentId,
      expectedRevision: 3,
      confirmed: true,
    }),
    /范围/,
  );
  await f.save({
    operation: "assign_department",
    uid: f.member.id,
    departmentId: null,
    expectedRevision: 3,
    confirmed: true,
  });
  await f.save({
    operation: "delete_department",
    departmentId: child.departmentId,
    expectedRevision: 4,
    confirmed: true,
  });
  assert.equal((await f.organization.read(f.member)).revision, 5);
});
test("Organization roles use exact verified IDs and role revisions; stale authority and self-demotion are refused", async () => {
  const f = await setup();
  const plan = {
    operation: "change_role",
    userId: f.member.id,
    role: "admin",
    expectedRole: "member",
    expectedRoleRevision: 1,
    expectedMembershipId: (await f.organization.read(f.admin)).rows.find(
      (r) => r.id === f.member.id,
    )!.membershipId!,
    expectedRevision: 0,
    confirmed: true,
  };
  const receipt = await f.save(plan);
  assert.equal(receipt.roleRevision, 2);
  assert.equal((await f.organization.read(f.member)).canManage, true);
  await assert.rejects(f.save({ ...plan, expectedRevision: 1 }), /已更新/);
  await assert.rejects(
    f.save({
      ...plan,
      userId: f.admin.id,
      expectedRole: "admin",
      expectedMembershipId: (await f.organization.read(f.member)).rows.find(
        (r) => r.id === f.admin.id,
      )!.membershipId!,
      role: "member",
      expectedRevision: 1,
    }),
    /另一位管理员/,
  );
  await f.save(
    {
      ...plan,
      userId: f.admin.id,
      expectedRole: "admin",
      expectedMembershipId: (await f.organization.read(f.member)).rows.find(
        (r) => r.id === f.admin.id,
      )!.membershipId!,
      role: "member",
      expectedRevision: 1,
    },
    f.member,
  );
  await assert.rejects(f.create("不能越权", 2), /管理员/);
  assert.equal((await f.organization.read(f.admin)).canManage, false);
});
test("AI organization tools apply only the host-confirmed plan and return metadata, never model-selected permissions or a persistent employee roster", async () => {
  const f = await setup(),
    run = await f.start({
      operation: "create_department",
      name: "AI 组织",
      parentId: null,
      expectedRevision: 0,
      confirmed: true,
    });
  await f.processor.process(run.id);
  const result = await f.service.getRun(f.admin, run.id);
  assert.equal(result.state, "succeeded");
  assert.equal(result.result.receipts[0].operation, "create_department");
  assert.equal(
    (await f.organization.read(f.member)).departments[0].name,
    "AI 组织",
  );
  const read = await f.start(
    { operation: "read", query: { query: "陈" } },
    f.member,
  );
  await f.processor.process(read.id);
  const current = await f.service.getRun(f.member, read.id);
  assert.equal(current.state, "succeeded");
  assert.equal(current.result.receipts[0].count, 2);
  assert.equal(current.result.receipts[0].rows, undefined);
  assert.ok(!JSON.stringify(current.result).includes("陈 同名"));
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM cw_messages WHERE conversation_id=$1",
        [f.project.conversationId],
      )
    ).rows[0].n,
    0,
  );
  f.engines.get("fixture")!.execute = async () => ({
    text: "forged",
    actions: [
      {
        tool: "organization.manage",
        args: { role: "admin", userId: f.member.id },
      },
    ],
    evidence: "fixture",
  });
  const malicious = await f.start({ operation: "read", query: {} });
  await f.processor.process(malicious.id);
  assert.equal((await f.service.getRun(f.admin, malicious.id)).state, "failed");
});
test("Concurrent organization edits admit one current revision, and revoked administrators cannot use queued AI changes", async () => {
  const f = await setup();
  const results = await Promise.allSettled([f.create("一"), f.create("二")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const run = await f.start({
    operation: "create_department",
    name: "撤权后禁止",
    parentId: null,
    expectedRevision: 1,
    confirmed: true,
  });
  await db.pool.query(
    "UPDATE cw_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
    [f.admin.workspaceId, f.admin.id],
  );
  await f.processor.process(run.id);
  assert.equal((await f.service.getRun(f.admin, run.id)).state, "failed");
  assert.equal((await f.organization.read(f.member)).departments.length, 1);
});
test("A revoked and regranted membership cannot reuse an old role confirmation even when the role revision matches", async () => {
  const f = await setup(),
    before = (await f.organization.read(f.admin)).rows.find(
      (r) => r.id === f.member.id,
    )!;
  const plan = {
    operation: "change_role",
    userId: f.member.id,
    role: "admin",
    expectedRole: "member",
    expectedRoleRevision: 1,
    expectedMembershipId: before.membershipId,
    expectedRevision: 0,
    confirmed: true,
  };
  await db.pool.query(
    "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [f.admin.workspaceId, f.member.id],
  );
  await db.pool.query(
    "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,'member')",
    [f.admin.workspaceId, f.member.id],
  );
  await assert.rejects(f.save(plan), /已更新/);
  const after = (await f.organization.read(f.admin)).rows.find(
    (r) => r.id === f.member.id,
  )!;
  assert.notEqual(after.membershipId, before.membershipId);
  assert.equal(after.roleRevision, before.roleRevision);
  await f.save({ ...plan, expectedMembershipId: after.membershipId });
  assert.equal((await f.organization.read(f.member)).canManage, true);
});
