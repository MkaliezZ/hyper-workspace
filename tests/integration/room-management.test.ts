import { createRoomManagementScope } from "../fixtures/room-management-scope.js";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Subject } from "@hyper/contracts";
import { RoomManagementPlan } from "@hyper/contracts/room-management";
import { Database } from "../../apps/api/src/db/database.js";
import { Vault, stableDigest } from "../../apps/api/src/core/credentials.js";
import { requireNextcloud } from "../../apps/api/src/providers/nextcloud.js";
import { RoomManagementService } from "../../apps/api/src/core/room-management.js";
import { TalkManagementFixture } from "../fixtures/talk-management.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Use isolated _test database.");
const db = new Database(url);
before(() => db.migrate());
after(() => db.close());
async function setup() {
  return createRoomManagementScope(db);
}

test("Communication preferences use current source state, stable receipts and same-key replay without persisting private content", async () => {
  const f = await setup();
  try {
    const plan = await f.plan("notify", { level: 3 }),
      key = randomUUID(),
      result = await f.service.execute(f.actor, plan, key);
    assert.equal(result.state, "succeeded");
    assert.equal(f.source.writes.length, 1);
    assert.equal(
      (await f.service.read(f.actor, f.room.token)).rooms[0]!.notificationLevel,
      3,
    );
    const replay = await f.service.execute(f.actor, plan, key);
    assert.equal(replay.id, result.id);
    assert.equal(f.source.writes.length, 1);
    await assert.rejects(
      f.service.execute(f.actor, { ...plan, level: 1 }, key),
      /相同通信操作键/,
    );
    const activity = await f.service.activity(f.actor);
    assert.equal(activity.length, 1);
    assert.ok(!JSON.stringify(activity).includes("synthetic-password"));
    assert.equal((activity[0] as any).plan, undefined);
    assert.equal((await f.service.activity(f.peer)).length, 0);
  } finally {
    await f.close();
  }
});
test("Concurrent identical communication intents dispatch at most once and share one durable operation", async () => {
  const f = await setup();
  try {
    const plan = await f.plan("favorite", { enabled: true }),
      key = randomUUID();
    const results = await Promise.all([
      f.service.execute(f.actor, plan, key),
      f.service.execute(f.actor, plan, key),
    ]);
    assert.equal(results[0].id, results[1].id);
    assert.equal(f.source.writes.length, 1);
    assert.equal(
      (await f.service.receipt(f.actor, results[0].id)).state,
      "succeeded",
    );
  } finally {
    await f.close();
  }
});
test("Product administrators cannot override source group roles; a normal product member with source ownership can manage the group", async () => {
  const f = await setup();
  try {
    await assert.rejects(
      f.service.execute(
        f.peer,
        await f.plan("rename", { name: "不能越权" }, f.peer),
        randomUUID(),
      ),
      /来源群主|来源权限/,
    );
    assert.equal(f.source.writes.length, 0);
    const result = await f.service.execute(
      f.actor,
      await f.plan("rename", { name: "来源群主确认的名字" }),
      randomUUID(),
    );
    assert.equal(result.state, "succeeded");
    assert.equal(f.room.name, "来源群主确认的名字");
    await assert.rejects(
      f.service.execute(
        f.actor,
        {
          operation: "create_direct",
          bindingRef: (await f.service.read(f.actor)).bindingRef,
          uid: "outsider",
          confirmed: true,
        },
        randomUUID(),
      ),
      /成员范围/,
    );
  } finally {
    await f.close();
  }
});
test("Read markers change only the selected visible position; a negative unread marker and already-effective state remain explicit", async () => {
  const f = await setup();
  try {
    const messageId = String(f.room.messages[0]!.id);
    const read = await f.service.execute(
      f.actor,
      await f.plan("mark_read", { messageId }),
      randomUUID(),
    );
    assert.equal(read.state, "succeeded");
    const before = f.source.writes.length;
    const noOp = await f.service.execute(
      f.actor,
      await f.plan("mark_read", { messageId }),
      randomUUID(),
    );
    assert.equal(noOp.outcome, "already_effective");
    assert.equal(f.source.writes.length, before);
    const unread = await f.service.execute(
      f.actor,
      await f.plan("mark_unread"),
      randomUUID(),
    );
    assert.equal(unread.state, "succeeded");
    assert.equal(
      (await f.service.read(f.actor, f.room.token)).rooms[0]!.lastReadMessage,
      "-1",
    );
  } finally {
    await f.close();
  }
});
test("Member changes bind exact UIDs and attendee instances, with separate confirmed moderator grant and removal", async () => {
  const f = await setup();
  try {
    await f.service.execute(
      f.actor,
      await f.plan("add_member", { uid: "other" }),
      randomUUID(),
    );
    let person = (
      await f.service.read(f.actor, f.room.token)
    ).participants!.rows.find((p) => p.uid === "other")!;
    await f.service.execute(
      f.actor,
      await f.plan("moderator", {
        uid: person.uid,
        attendeeId: person.attendeeId,
        enabled: true,
      }),
      randomUUID(),
    );
    assert.equal(f.room.people.get("other")!.type, 2);
    await assert.rejects(
      f.service.execute(
        f.actor,
        await f.plan("remove_member", {
          uid: person.uid,
          attendeeId: person.attendeeId,
        }),
        randomUUID(),
      ),
      /先明确撤销/,
    );
    await f.service.execute(
      f.actor,
      await f.plan("moderator", {
        uid: person.uid,
        attendeeId: person.attendeeId,
        enabled: false,
      }),
      randomUUID(),
    );
    const old = await f.plan("remove_member", {
      uid: person.uid,
      attendeeId: person.attendeeId,
    });
    f.room.people.set("other", { type: 3, id: 9999 });
    const writes = f.source.writes.length;
    await assert.rejects(
      f.service.execute(f.actor, old, randomUUID()),
      /已变化/,
    );
    assert.equal(f.source.writes.length, writes);
    person = (
      await f.service.read(f.actor, f.room.token)
    ).participants!.rows.find((p) => p.uid === "other")!;
    await f.service.execute(
      f.actor,
      await f.plan("remove_member", {
        uid: person.uid,
        attendeeId: person.attendeeId,
      }),
      randomUUID(),
    );
    assert.equal(f.room.people.has("other"), false);
  } finally {
    await f.close();
  }
});
test("An unknown group creation survives lost acknowledgment and never guesses a same-name room or repeats POST during reconciliation", async () => {
  const f = await setup();
  try {
    const plan = await f.create(),
      key = randomUUID();
    f.source.loseNext = true;
    const lost = await f.service.execute(f.actor, plan, key);
    assert.equal(lost.state, "recovery_required");
    assert.equal(lost.roomId, null);
    assert.equal(f.source.writes.length, 1);
    assert.equal((await f.service.execute(f.actor, plan, key)).id, lost.id);
    assert.equal(
      (await f.service.reconcile(f.actor, lost.id)).state,
      "recovery_required",
    );
    assert.equal(f.source.writes.length, 1);
    await assert.rejects(
      f.service.execute(f.actor, plan, randomUUID()),
      /已有通信操作待核对/,
    );
    const ack = await f.service.acknowledge(f.actor, lost.id);
    assert.equal(ack.state, "recovery_required");
    assert.ok(ack.acknowledgedAt);
    const deliberate = await f.service.execute(
      f.actor,
      await f.create(),
      randomUUID(),
    );
    assert.equal(deliberate.state, "succeeded");
    assert.equal(
      [...f.source.rooms.values()].filter((r) => r.name === plan.name).length,
      2,
    );
  } finally {
    await f.close();
  }
});
test("Partial group creation retains the real room and successful invitations, stops rejected steps and requires explicit continuation", async () => {
  const f = await setup();
  try {
    f.source.rejectInvitationFor = "other";
    const plan = await f.create(["peer", "other"]),
      result = await f.service.execute(f.actor, plan, randomUUID());
    assert.equal(result.state, "recovery_required");
    assert.equal(result.completedSteps, 2);
    assert.equal(result.totalSteps, 3);
    assert.ok(result.roomId);
    const room = f.source.rooms.get(result.roomId!)!;
    assert.equal(room.people.has("peer"), true);
    assert.equal(room.people.has("other"), false);
    const before = f.source.writes.length;
    assert.equal(
      (await f.service.reconcile(f.actor, result.id)).state,
      "recovery_required",
    );
    assert.equal(f.source.writes.length, before);
    await f.service.acknowledge(f.actor, result.id);
    f.source.rejectInvitationFor = undefined;
    const view = await f.service.read(f.actor, room.token),
      current = view.rooms[0]!;
    const add = await f.service.execute(
      f.actor,
      {
        operation: "add_member",
        bindingRef: view.bindingRef,
        roomId: room.token,
        expected: current.expected.add_member,
        uid: "other",
        confirmed: true,
      },
      randomUUID(),
    );
    assert.equal(add.state, "succeeded");
    assert.ok(room.people.has("other"));
    assert.equal(
      (await f.service.receipt(f.actor, result.id)).state,
      "recovery_required",
    );
  } finally {
    await f.close();
  }
});
test("Stopping an already-dispatched group call preserves its effect but prevents every later invitation", async () => {
  const f = await setup();
  let release!: () => void;
  try {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    f.source.beforeWrite = async (path) => {
      if (path.endsWith("/room")) {
        entered();
        await gate;
      }
    };
    const pending = f.service.execute(f.actor, await f.create(), randomUUID());
    await started;
    const id = (
      await db.pool.query(
        "SELECT id FROM cw_room_commands WHERE workspace_id=$1 AND actor_id=$2 ORDER BY created_at DESC LIMIT 1",
        [f.actor.workspaceId, f.actor.id],
      )
    ).rows[0].id;
    assert.equal(
      (await f.service.stop(f.actor, id)).state,
      "recovery_required",
    );
    release();
    const result = await pending;
    assert.equal(result.state, "recovery_required");
    assert.equal(f.source.writes.length, 1);
    assert.ok(result.roomId);
    assert.equal(f.source.rooms.get(result.roomId!)!.people.size, 1);
  } finally {
    release?.();
    await f.close();
  }
});
test("Source membership revoked after the first external effect stops further work and denies cached command details", async () => {
  const f = await setup();
  try {
    f.source.afterWrite = (path) => {
      if (path.endsWith("/room")) f.source.members.delete("operator");
    };
    await assert.rejects(
      f.service.execute(f.actor, await f.create(), randomUUID()),
      (error: any) => error?.getStatus?.() === 403,
    );
    assert.equal(f.source.writes.length, 1);
    const row = (
      await db.pool.query(
        "SELECT id,state FROM cw_room_commands WHERE workspace_id=$1 AND actor_id=$2",
        [f.actor.workspaceId, f.actor.id],
      )
    ).rows[0];
    assert.equal(row.state, "recovery_required");
    await assert.rejects(f.service.receipt(f.actor, row.id));
  } finally {
    await f.close();
  }
});
test("A stale dispatch with no source acknowledgment remains unknown even if the current source state happens to match", async () => {
  const f = await setup();
  try {
    const plan = await f.plan("notify", { level: 3 }),
      id = randomUUID(),
      key = randomUUID(),
      sourceConfig = requireNextcloud();
    await db.pool.query(
      "INSERT INTO cw_room_commands(id,workspace_id,actor_id,identity_credential_id,provider_key,binding_ref,remote_uid,operation,plan,params_hash,idempotency_key,source_room_ref,state,updated_at)VALUES($1,$2,$3,$4,$5,$6,'operator','notify',$7,$8,$9,$10,'dispatching',clock_timestamp()-interval '2 minutes')",
      [
        id,
        f.actor.workspaceId,
        f.actor.id,
        f.actor.identityCredentialId,
        sourceConfig.providerKey,
        plan.bindingRef,
        plan,
        stableDigest(RoomManagementPlan.parse(plan)),
        key,
        f.room.token,
      ],
    );
    await db.pool.query(
      "INSERT INTO cw_room_command_steps(command_id,sequence,operation,state,dispatched_at)VALUES($1,0,'notify','unknown',clock_timestamp()-interval '2 minutes')",
      [id],
    );
    f.room.preferences.set("operator", { level: 3, favorite: false, read: 0 });
    assert.equal(
      (await f.service.receipt(f.actor, id)).state,
      "recovery_required",
    );
    assert.equal(
      (await f.service.reconcile(f.actor, id)).state,
      "recovery_required",
    );
    assert.equal(
      (await f.service.execute(f.actor, plan, key)).state,
      "recovery_required",
    );
    assert.equal(f.source.writes.length, 0);
  } finally {
    await f.close();
  }
});

async function ai(f: Awaited<ReturnType<typeof setup>>, execute?: any) {
  const { WorkspaceService } = await import(
      "../../apps/api/src/core/workspace.js"
    ),
    { RunProcessor } = await import("../../apps/api/src/core/processor.js"),
    { engineRegistry } = await import("../../apps/api/src/engines/adapters.js");
  const engines = engineRegistry();
  engines.set("dsh", {
    id: "dsh",
    describeCapabilities: () => ({
      configured: true,
      operations: ["manage_communication"],
      evidence: "protocol-fixture",
    }),
    execute:
      execute ??
      (async (request: any) => {
        assert.ok(
          request.context.includes("Host-bound communication operation."),
        );
        for (const secret of [f.room.name, "synthetic-password", "同名员工"])
          assert.ok(!request.context.includes(secret));
        return {
          text: "model-claim-is-not-a-receipt",
          evidence: "fixture",
          actions: [{ tool: "communication.manage", args: {} }],
        };
      }),
  });
  const work = new WorkspaceService(db, engines),
    processor = new RunProcessor(work);
  const model = await work.saveModel(f.actor, {
    name: "Synthetic room management",
    provider: "openai-compatible",
    endpoint: "http://127.0.0.1:1/v1",
    model: "protocol",
    purpose: "chat",
    scope: "personal",
    apiKey: "synthetic-no-supplier-call",
  });
  const start = async (plan: any, taskRules?: any, key = randomUUID()) => {
    const { RoomManagementRunInput } = await import(
      "@hyper/contracts/room-management"
    );
    return work.startRoomManagementRun(
      f.actor,
      RoomManagementRunInput.parse({
        plan,
        engine: "dsh",
        modelProfileId: model.id,
        idempotencyKey: key,
        taskRules,
      }),
    );
  };
  return { work, processor, engines, start };
}
async function link(
  f: Awaited<ReturnType<typeof setup>>,
  token: string,
  rules: any,
) {
  const project = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_projects(id,workspace_id,name,goal)VALUES($1,$2,'Synthetic linked room','No unrelated context')",
    [project, f.actor.workspaceId],
  );
  await db.pool.query(
    "INSERT INTO cw_project_sources(project_id,workspace_id,provider_key,source_kind,conversation_ref,created_by)VALUES($1,$2,$3,'nextcloud-talk',$4,$5)",
    [
      project,
      f.actor.workspaceId,
      requireNextcloud().providerKey,
      token,
      f.actor.id,
    ],
  );
  await db.pool.query(
    "INSERT INTO cw_execution_policies(workspace_id,scope,scope_id,revision,rules,updated_by)VALUES($1,'project',$2,1,$3,$4)",
    [f.actor.workspaceId, project, rules, f.actor.id],
  );
  return project;
}
test("Standalone AI communication uses the host-bound service, private metadata and stable Run replay without any conversation", async () => {
  const f = await setup();
  try {
    const a = await ai(f),
      plan = await f.plan("favorite", { enabled: true }),
      key = randomUUID(),
      run = await a.start(plan, undefined, key);
    await a.processor.process(run.id);
    const result = await a.work.getRun(f.actor, run.id);
    assert.equal(result.state, "succeeded");
    assert.equal(result.result.receipts[0].state, "succeeded");
    assert.equal((await a.start(plan, undefined, key)).id, run.id);
    assert.equal(f.source.writes.length, 1);
    assert.ok(!JSON.stringify(result).includes("model-claim-is-not-a-receipt"));
    assert.equal(result.roomManagementPlan, undefined);
    assert.equal(
      (
        await db.pool.query(
          "SELECT conversation_id,runtime_cleaned_at FROM cw_runs WHERE id=$1",
          [run.id],
        )
      ).rows[0].conversation_id,
      null,
    );
    assert.equal(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM cw_messages WHERE workspace_id=$1",
          [f.actor.workspaceId],
        )
      ).rows[0].n,
      0,
    );
    const read = await a.start({
      operation: "read",
      bindingRef: plan.bindingRef,
    });
    await a.processor.process(read.id);
    const receipt = (await a.work.getRun(f.actor, read.id)).result.receipts[0];
    assert.equal(receipt.roomCount, 1);
    assert.equal(receipt.rows, undefined);
    assert.ok(!JSON.stringify(receipt).includes(f.room.name));
    await assert.rejects(a.work.getRun(f.peer, run.id));
  } finally {
    await f.close();
  }
});
test("AI cannot substitute source parameters or bypass the actual target project's action policy", async () => {
  const f = await setup();
  try {
    const a = await ai(f, async () => ({
      text: "forged",
      evidence: "fixture",
      actions: [{ tool: "communication.manage", args: { uid: "outsider" } }],
    }));
    const malicious = await a.start(await f.plan("notify", { level: 3 }));
    await a.processor.process(malicious.id);
    assert.equal((await a.work.getRun(f.actor, malicious.id)).state, "failed");
    assert.equal(f.source.writes.length, 0);
    await link(f, f.room.token, { maxActions: 0 });
    const blocked = await a.start(await f.plan("notify", { level: 3 }));
    await a.processor.process(blocked.id);
    assert.equal((await a.work.getRun(f.actor, blocked.id)).state, "failed");
    assert.equal(f.source.writes.length, 0);
  } finally {
    await f.close();
  }
});
test("A group macro counts its real source steps and refuses the whole dispatch when the confirmed task action limit is too small", async () => {
  const f = await setup();
  try {
    const a = await ai(f),
      run = await a.start(await f.create(["peer", "other"]), { maxActions: 2 });
    await a.processor.process(run.id);
    assert.equal((await a.work.getRun(f.actor, run.id)).state, "failed");
    assert.equal(f.source.writes.length, 0);
    assert.equal((await f.service.activity(f.actor)).length, 0);
  } finally {
    await f.close();
  }
});
test("Cancelling AI during a dispatched group POST retains its eventual fact and stops every later source invitation", async () => {
  const f = await setup();
  let release: () => void = () => {};
  try {
    const a = await ai(f),
      run = await a.start(await f.create());
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (release = r));
    f.source.beforeWrite = async (path) => {
      if (path.endsWith("/room")) {
        entered();
        await gate;
      }
    };
    const pending = a.processor.process(run.id);
    await started;
    await a.work.cancel(f.actor, run.id);
    release();
    await pending;
    assert.equal((await a.work.getRun(f.actor, run.id)).state, "cancelled");
    assert.equal(f.source.writes.length, 1);
    const record = (await f.service.activity(f.actor))[0]!;
    assert.equal(record.state, "recovery_required");
    assert.equal(record.completedSteps, 1);
    assert.equal(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM cw_actions WHERE run_id=$1",
          [run.id],
        )
      ).rows[0].n,
      1,
    );
  } finally {
    release();
    await f.close();
  }
});
test("A newly linked project's tighter policy stops the next step of an already-created group", async () => {
  const f = await setup();
  try {
    const a = await ai(f),
      run = await a.start(await f.create(["peer", "other"]));
    f.source.afterWrite = async (path) => {
      if (path.endsWith("/room")) {
        const newest = [...f.source.rooms.values()].at(-1)!;
        await link(f, newest.token, { maxActions: 1 });
      }
    };
    await a.processor.process(run.id);
    assert.equal(
      (await a.work.getRun(f.actor, run.id)).state,
      "recovery_required",
    );
    assert.equal(f.source.writes.length, 1);
    assert.equal((await f.service.activity(f.actor))[0]!.completedSteps, 1);
  } finally {
    await f.close();
  }
});
test("The actor can read their safe AI receipt after intentionally leaving a room, without restoring room or project visibility", async () => {
  const f = await setup();
  try {
    f.room.people.get("peer")!.type = 2;
    const a = await ai(f),
      plan = await f.plan("leave"),
      key = randomUUID(),
      run = await a.start(plan, undefined, key);
    await a.processor.process(run.id);
    const result = await a.work.getRun(f.actor, run.id);
    assert.equal(result.state, "succeeded");
    assert.equal(result.result.receipts[0].scopeAvailable, false);
    assert.equal((await a.start(plan, undefined, key)).id, run.id);
    await assert.rejects(f.service.read(f.actor, f.room.token));
    assert.equal(f.source.writes.length, 1);
  } finally {
    await f.close();
  }
});

test("Queued AI mutations reserve the source scope across manual dispatch and a second Run, while the same Run key remains safe", async () => {
  const f = await setup();
  try {
    const a = await ai(f),
      plan = await f.create(),
      key = randomUUID(),
      first = await a.start(plan, undefined, key);
    assert.equal((await a.start(plan, undefined, key)).id, first.id);
    await assert.rejects(a.start(plan), /已有通信任务/);
    await assert.rejects(
      f.service.execute(f.actor, plan, randomUUID()),
      /已有通信 AI 任务/,
    );
    assert.equal(f.source.writes.length, 0);
    await a.work.cancel(f.actor, first.id);
    const next = await a.start(plan);
    await a.processor.process(next.id);
    assert.equal((await a.work.getRun(f.actor, next.id)).state, "succeeded");
    assert.equal(f.source.writes.length, 2);
  } finally {
    await f.close();
  }
});

test("Unsupported participants and breakout conversations fail closed before any group-management source write", async () => {
  const f = await setup();
  try {
    f.room.people.set("outsider", { type: 4, id: 900 });
    await assert.rejects(
      f.service.execute(
        f.actor,
        await f.plan("rename", { name: "Must not change" }),
        randomUUID(),
      ),
      /不支持的成员/,
    );
    assert.equal(f.source.writes.length, 0);
    f.room.people.delete("outsider");
    const metadata = f.source.metadata.bind(f.source);
    f.source.metadata = (room, actor) => ({
      ...metadata(room, actor),
      breakoutRoomMode: 1,
    });
    await assert.rejects(
      f.service.execute(
        f.actor,
        await f.plan("rename", { name: "Must not rename breakout" }),
        randomUUID(),
      ),
      /分组讨论/,
    );
    assert.equal(f.source.writes.length, 0);
  } finally {
    await f.close();
  }
});
test("Failed-before-dispatch AI Runs keep a safe own receipt and stable request key after the source confirmation becomes stale", async () => {
  const f = await setup();
  try {
    const a = await ai(f),
      plan = await f.plan("notify", { level: 3 }),
      key = randomUUID(),
      run = await a.start(plan, undefined, key);
    f.room.preferences.set("operator", { level: 1, favorite: false, read: 0 });
    await a.processor.process(run.id);
    const record = await a.work.getRun(f.actor, run.id);
    assert.equal(record.state, "failed");
    assert.equal((await a.start(plan, undefined, key)).id, run.id);
    assert.equal(f.source.writes.length, 0);
    assert.ok(!JSON.stringify(record).includes(f.room.name));
  } finally {
    await f.close();
  }
});

test("A repeated direct-conversation request reports an existing source room instead of claiming another creation", async () => {
  const f = await setup();
  try {
    const plan = {
      operation: "create_direct",
      bindingRef: (await f.service.read(f.actor)).bindingRef,
      uid: "peer",
      confirmed: true,
    };
    const first = await f.service.execute(f.actor, plan, randomUUID());
    const second = await f.service.execute(f.actor, plan, randomUUID());
    assert.equal(first.sourceRoomDisposition, "created");
    assert.equal(second.sourceRoomDisposition, "existing");
    assert.equal(first.roomId, second.roomId);
    assert.equal(f.source.rooms.size, 2);
  } finally {
    await f.close();
  }
});

test("Current room removal hides source IDs in historical AI results and event receipts while preserving safe own audit state", async () => {
  const f = await setup();
  try {
    const a = await ai(f),
      run = await a.start(await f.plan("favorite", { enabled: true }));
    await a.processor.process(run.id);
    assert.equal(
      (await a.work.getRun(f.actor, run.id)).result.receipts[0].roomId,
      f.room.token,
    );
    f.room.people.delete("operator");
    const current = await a.work.getRun(f.actor, run.id);
    assert.equal(current.state, "succeeded");
    assert.equal(current.result.receipts[0].roomId, null);
    assert.equal(current.result.receipts[0].scopeAvailable, false);
    const events = await a.work.events(f.actor, run.id);
    assert.ok(!JSON.stringify(events).includes(f.room.token));
    assert.equal((await f.service.activity(f.actor))[0]!.roomId, null);
  } finally {
    await f.close();
  }
});
