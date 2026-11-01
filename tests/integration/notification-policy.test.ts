import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Subject } from "@hyper/contracts";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { NotificationPolicyService } from "../../apps/api/src/core/notification-policy.js";
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
    admin: Subject = {
      id: randomUUID(),
      workspaceId,
      name: "Synthetic notification admin",
      role: "admin",
      demo: true,
    },
    member: Subject = {
      ...admin,
      id: randomUUID(),
      name: "Synthetic notification employee",
      role: "member",
    },
    peer: Subject = {
      ...member,
      id: randomUUID(),
      name: "Synthetic notification peer",
    };
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name)VALUES($1,'Synthetic notification rules')",
    [workspaceId],
  );
  for (const actor of [admin, member, peer]) {
    await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
      actor.id,
      actor.name,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,$3)",
      [workspaceId, actor.id, actor.role],
    );
  }
  const work = new WorkspaceService(db, engineRegistry()),
    processor = new RunProcessor(work),
    service = new NotificationPolicyService(db),
    project = await work.createProject(
      admin,
      "Synthetic notification project",
      "Keep quiet checks from consuming unnotified changes",
    ),
    task = await work.createTask(admin, project.conversationId, {
      title: "Original synthetic task",
      assignee: "Text label",
      dueDate: "2026-11-02",
    });
  const save = (
    scope: string,
    rules: any,
    revision = 0,
    actor = admin,
    key = randomUUID(),
  ) =>
    service.save(
      actor,
      project.id,
      {
        operation: "configure",
        scope,
        rules,
        expectedRevision: revision,
        confirmed: true,
      },
      key,
    );
  const check = async (actor = admin) => {
    const run = await work.startRun(actor, {
      conversationId: project.conversationId,
      workflow: "follow_up",
      engine: "fixture",
      instruction: "Check only current authorized tasks",
      idempotencyKey: randomUUID(),
    });
    await processor.process(run.id);
    const actual = await work.getRun(actor, run.id);
    assert.equal(actual.state, "succeeded", actual.error);
    return actual.result.receipts[0];
  };
  const patch = async (changes: any) => {
    const current = (
      await db.pool.query("SELECT version FROM cw_tasks WHERE id=$1", [task.id])
    ).rows[0];
    return work.patchTask(admin, task.id, {
      expectedVersion: current.version,
      ...changes,
    });
  };
  const baseline = async () =>
    (
      await db.pool.query(
        "SELECT * FROM cw_follow_up_baselines WHERE workspace_id=$1 AND project_id=$2",
        [workspaceId, project.id],
      )
    ).rows[0];
  const messages = async () =>
    (
      await db.pool.query(
        "SELECT * FROM cw_messages WHERE workspace_id=$1 AND conversation_id=$2",
        [workspaceId, project.conversationId],
      )
    ).rows;
  return {
    admin,
    member,
    peer,
    work,
    processor,
    service,
    project,
    task,
    save,
    check,
    patch,
    baseline,
    messages,
  };
}
test("Personal notification preferences remain private, cannot widen shared restrictions and require current roles for shared edits", async () => {
  const f = await setup();
  await f.save("workspace", {
    mode: "important",
    importantFields: ["status", "dueDate"],
    minIntervalMinutes: 30,
  });
  await f.save(
    "personal",
    {
      mode: "all",
      importantFields: ["status", "title"],
      minIntervalMinutes: 0,
    },
    0,
    f.member,
  );
  const own = await f.service.view(f.member, f.project.id);
  assert.equal(own.effective.mode, "important");
  assert.deepEqual(own.effective.importantFields, ["status"]);
  assert.equal(own.effective.minIntervalMinutes, 30);
  assert.equal(own.canManageShared, false);
  const peer = await f.service.view(f.peer, f.project.id);
  assert.ok(!peer.layers.some((l) => l.scope === "personal"));
  assert.equal(peer.recentChanges.length, 0);
  await assert.rejects(
    f.save("project", { mode: "quiet" }, 0, f.member),
    /管理员/,
  );
});
test("Versioned notification saves replay exact own receipts after later changes and demotion, without permitting a new shared write", async () => {
  const f = await setup(),
    key = randomUUID(),
    first = await f.save("project", { mode: "quiet" }, 0, f.admin, key);
  await f.save("project", { mode: "all" }, 1);
  await db.pool.query(
    "UPDATE cw_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
    [f.admin.workspaceId, f.admin.id],
  );
  assert.deepEqual(
    await f.save("project", { mode: "quiet" }, 0, f.admin, key),
    first,
  );
  await assert.rejects(
    f.save("project", { mode: "important" }, 0, f.admin, key),
    /相同提醒请求键/,
  );
  await assert.rejects(f.save("project", { mode: "quiet" }, 2), /管理员/);
  assert.equal(
    (await f.service.view(f.admin, f.project.id)).canManageShared,
    false,
  );
});
test("Concurrent policy edits serialize one current revision and an audit failure rolls the configuration back", async () => {
  const f = await setup(),
    results = await Promise.allSettled([
      f.save("project", { mode: "quiet" }),
      f.save("project", { mode: "important" }),
    ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const before = (await f.service.view(f.admin, f.project.id)).layers.find(
    (l) => l.scope === "project",
  )!;
  await assert.rejects(
    db.tx(async (c) => {
      await f.service.apply(
        c,
        f.admin,
        f.project.id,
        {
          operation: "configure",
          scope: "project",
          expectedRevision: before.revision,
          rules: { mode: "all" },
          confirmed: true,
        },
        randomUUID(),
      );
      throw Error("synthetic audit rollback");
    }),
    /synthetic audit rollback/,
  );
  assert.deepEqual(
    (await f.service.view(f.admin, f.project.id)).layers.find(
      (l) => l.scope === "project",
    ),
    before,
  );
});
test("A quiet employee does not consume the common notification baseline or hide a later eligible colleague's changes", async () => {
  const f = await setup();
  await f.check();
  const initialBaseline = await f.baseline();
  await f.save("personal", { mode: "quiet" }, 0, f.member);
  await f.patch({ status: "done" });
  const quiet = await f.check(f.member);
  assert.equal(quiet.reason, "changed");
  assert.equal(quiet.notify, false);
  assert.equal(quiet.notification.reason, "quiet");
  assert.equal((await f.messages()).length, 0);
  assert.equal((await f.baseline()).last_run_id, initialBaseline.last_run_id);
  assert.equal((await f.baseline()).snapshot[0].status, "open");
  const published = await f.check(f.peer);
  assert.equal(published.notify, true);
  assert.equal(published.changes[0].after.status, "done");
  assert.equal((await f.messages()).length, 1);
  assert.equal((await f.check(f.peer)).reason, "unchanged");
  assert.equal((await f.messages()).length, 1);
});
test("Important changes trigger one merged factual notification including prior deferred minor changes", async () => {
  const f = await setup();
  await f.save("project", { mode: "important", importantFields: ["status"] });
  await f.check();
  await f.patch({ title: "A deferred minor title change" });
  const minor = await f.check();
  assert.equal(minor.notify, false);
  assert.equal(minor.notification.reason, "not_important");
  assert.equal(
    (await f.baseline()).snapshot[0].title,
    "Original synthetic task",
  );
  await f.patch({ status: "done" });
  const combined = await f.check();
  assert.equal(combined.notify, true);
  assert.deepEqual([...combined.changes[0].fields].sort(), ["status", "title"]);
  assert.equal((await f.messages()).length, 1);
  assert.match(
    (await f.messages())[0].content,
    /A deferred minor title change/,
  );
});
test("Notification cooldown uses the actual prior publication timestamp and preserves deferred changes for the next authorized check", async () => {
  const f = await setup();
  await f.save("project", { mode: "all", minIntervalMinutes: 60 });
  await f.check();
  await f.patch({ status: "done" });
  assert.equal((await f.check()).notify, true);
  const publishedAt = (await f.baseline()).last_notification_at;
  assert.ok(publishedAt);
  await f.patch({ dueDate: "2026-11-03" });
  const deferred = await f.check();
  assert.equal(deferred.notify, false);
  assert.equal(deferred.notification.reason, "rate_limited");
  assert.ok(deferred.notification.nextEligibleAt);
  assert.equal(
    (await f.baseline()).last_notification_at.toISOString(),
    publishedAt.toISOString(),
  );
  assert.equal((await f.baseline()).snapshot[0].dueDate, "2026-11-02");
  await db.pool.query(
    "UPDATE cw_follow_up_baselines SET last_notification_at=clock_timestamp()-interval '61 minutes' WHERE project_id=$1",
    [f.project.id],
  );
  const next = await f.check();
  assert.equal(next.notify, true);
  assert.equal(next.changes[0].after.dueDate, "2026-11-03");
  assert.equal((await f.messages()).length, 2);
});
test("A shared quiet rule remains authoritative over personal all-mode and does not silently consume pending facts", async () => {
  const f = await setup();
  await f.check();
  await f.save("workspace", { mode: "quiet" });
  await f.save("personal", { mode: "all" }, 0, f.member);
  await f.patch({ status: "done" });
  assert.equal((await f.check(f.member)).notify, false);
  await f.save("workspace", { mode: "all" }, 1);
  assert.equal((await f.check(f.member)).notify, true);
  assert.equal((await f.messages()).length, 1);
});

test("A notification restriction introduced during model work governs the eventual tool and cannot be overridden by model text", async () => {
  const f = await setup();
  await f.check();
  await f.patch({ status: "done" });
  f.work.engines.get("fixture")!.execute = async () => {
    await f.save("workspace", { mode: "quiet" });
    return {
      text: "The model claims it notified everyone",
      evidence: "fixture",
      actions: [{ tool: "follow_up.check", args: {} }],
    };
  };
  const actual = await f.check();
  assert.equal(actual.notify, false);
  assert.equal(actual.notification.reason, "quiet");
  assert.equal(actual.notification.layers[0].revision, 1);
  assert.equal((await f.messages()).length, 0);
  assert.equal((await f.baseline()).snapshot[0].status, "open");
});
test("Product administrators still need current source project membership when reading or configuring project reminders", async () => {
  const { createRoomManagementScope } = await import(
      "../fixtures/room-management-scope.js"
    ),
    f = await createRoomManagementScope(db);
  try {
    const work = new WorkspaceService(db, engineRegistry()),
      project = await work.createTalkProject(
        f.actor,
        f.room.token,
        "Synthetic source notification rules",
        "No source permission expansion",
      ),
      service = new NotificationPolicyService(db),
      plan = {
        operation: "configure",
        scope: "project",
        expectedRevision: 0,
        rules: { mode: "quiet" },
        confirmed: true,
      };
    await service.prepare(f.peer, project.id, plan);
    f.room.people.delete("peer");
    await assert.rejects(service.view(f.peer, project.id));
    await assert.rejects(service.save(f.peer, project.id, plan, randomUUID()));
    assert.equal(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM cw_notification_policies WHERE workspace_id=$1",
          [f.actor.workspaceId],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await f.close();
  }
});

test("AI notification configuration and read use the same product rules, private receipts and exact original Run on replay", async () => {
  const f = await setup();
  await f.work.message(
    f.admin,
    f.project.conversationId,
    "private-notification-discussion-never-sent",
  );
  const original = f.work.engines
    .get("fixture")!
    .execute.bind(f.work.engines.get("fixture")!);
  f.work.engines.get("fixture")!.execute = async (request) => {
    assert.ok(
      !request.context.includes("private-notification-discussion-never-sent"),
    );
    assert.ok(!request.context.includes("Original synthetic task"));
    return original(request);
  };
  const input = {
    conversationId: f.project.conversationId,
    engine: "fixture" as const,
    workflow: "manage_notifications" as const,
    instruction: "Apply only the confirmed rules",
    notificationPlan: {
      operation: "configure" as const,
      scope: "project" as const,
      expectedRevision: 0,
      rules: {
        mode: "important" as const,
        importantFields: ["status" as const],
      },
      confirmed: true as const,
    },
    idempotencyKey: randomUUID(),
  };
  const run = await f.work.startRun(f.admin, input);
  await f.processor.process(run.id);
  const result = await f.work.getRun(f.admin, run.id);
  assert.equal(result.state, "succeeded", result.error);
  assert.deepEqual(
    result.result.receipts[0].rules,
    input.notificationPlan.rules,
  );
  assert.equal(result.result.receipts[0].revision, 1);
  assert.equal(
    (await f.messages()).length,
    1,
    "Private AI settings must not post an assistant message",
  );
  await f.save("project", { mode: "quiet" }, 1);
  await db.pool.query(
    "UPDATE cw_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
    [f.admin.workspaceId, f.admin.id],
  );
  const replay = await f.work.startRun(f.admin, input);
  assert.equal(replay.id, run.id);
  assert.equal(replay.created, false);
  await assert.rejects(
    f.work.startRun(f.admin, {
      ...input,
      notificationPlan: { ...input.notificationPlan, rules: { mode: "all" } },
    }),
    /幂等键/,
  );
  const read = await f.work.startRun(f.admin, {
    ...input,
    notificationPlan: { operation: "read" },
    idempotencyKey: randomUUID(),
  });
  await f.processor.process(read.id);
  const readResult = await f.work.getRun(f.admin, read.id);
  assert.equal(readResult.state, "succeeded", readResult.error);
  assert.equal(readResult.result.receipts[0].effective.mode, "quiet");
  await assert.rejects(f.work.getRun(f.peer, read.id));
  assert.equal((await f.messages()).length, 1);
});

test("Model-selected notification arguments, revoked roles and revisions changed during work cannot alter any rules", async () => {
  for (const rejection of ["arguments", "role", "revision"]) {
    const f = await setup(),
      input = {
        conversationId: f.project.conversationId,
        workflow: "manage_notifications" as const,
        engine: "fixture" as const,
        instruction: "Confirmed reminder operation",
        idempotencyKey: randomUUID(),
        notificationPlan: {
          operation: "configure" as const,
          scope: "project" as const,
          expectedRevision: 0,
          rules: { mode: "important" as const },
          confirmed: true as const,
        },
      };
    f.work.engines.get("fixture")!.execute = async () => {
      if (rejection === "role")
        await db.pool.query(
          "UPDATE cw_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
          [f.admin.workspaceId, f.admin.id],
        );
      if (rejection === "revision") await f.save("project", { mode: "quiet" });
      return {
        text: "The model falsely claims rules changed",
        evidence: "fixture",
        actions: [
          {
            tool: "notifications.manage",
            args:
              rejection === "arguments"
                ? { rules: { mode: "all" }, actorId: f.peer.id }
                : {},
          },
        ],
      };
    };
    const run = await f.work.startRun(f.admin, input);
    await f.processor.process(run.id);
    const actual = await f.work.getRun(f.admin, run.id);
    assert.equal(actual.state, "failed", rejection);
    assert.ok(!actual.error.includes("falsely"));
    const layers = (await f.service.view(f.admin, f.project.id)).layers;
    assert.deepEqual(
      layers.map((l) => l.rules),
      rejection === "revision" ? [{ mode: "quiet" }] : [],
    );
    assert.equal((await f.messages()).length, 0);
  }
});

test("Own reminder audit history is restricted to the selected project, workspace and personal scope", async () => {
  const f = await setup(),
    other = await f.work.createProject(
      f.admin,
      "Other synthetic project",
      "Private history boundary",
    );
  await f.service.save(
    f.admin,
    other.id,
    {
      operation: "configure",
      scope: "project",
      expectedRevision: 0,
      rules: { mode: "quiet" },
      confirmed: true,
    },
    randomUUID(),
  );
  await f.save("personal", { minIntervalMinutes: 5 });
  const view = await f.service.view(f.admin, f.project.id);
  assert.equal(view.recentChanges.length, 1);
  assert.equal(view.recentChanges[0].scope, "personal");
  assert.ok(!JSON.stringify(view).includes(other.id));
});
