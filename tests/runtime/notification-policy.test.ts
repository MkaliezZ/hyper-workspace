import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { createRoomManagementScope } from "../fixtures/room-management-scope.js";
import { modelFixture } from "./business-contract.js";

test(
  "Native DSH/Hermes share notification preferences without allowing a quiet actor to consume another employee's pending changes",
  { timeout: 240000 },
  async () => {
    const url = process.env.TEST_DATABASE_URL;
    assert.ok(url && new URL(url).pathname.endsWith("_test"));
    const db = new Database(url),
      originalDir = process.env.RUNTIME_DIR,
      dir = await mkdtemp(join(tmpdir(), "hyper-notification-native-")),
      key = "synthetic-notification-" + randomUUID();
    let source:
      | Awaited<ReturnType<typeof createRoomManagementScope>>
      | undefined;
    const fixture = modelFixture([key], (body) => {
      const context = JSON.stringify(body.messages);
      if (context.includes("Host-bound notification policy operation.")) {
        for (const value of [
          "Synthetic private notification task",
          "合成来源私群",
          "synthetic-password",
          '"mode":"quiet"',
        ])
          assert.ok(!context.includes(value));
      }
    });
    process.env.RUNTIME_DIR = dir;
    await new Promise<void>((r) => fixture.server.listen(0, "127.0.0.1", r));
    try {
      await db.migrate();
      source = await createRoomManagementScope(db);
      const f = source,
        work = new WorkspaceService(db, engineRegistry()),
        processor = new RunProcessor(work);
      for (const engine of ["dsh", "hermes"] as const)
        assert.equal(
          work.engines.get(engine)!.describeCapabilities().configured,
          true,
        );
      const project = await work.createTalkProject(
          f.actor,
          f.room.token,
          "Synthetic native notification project",
          "Preserve pending facts",
        ),
        task = await work.createTask(f.actor, project.conversationId, {
          title: "Synthetic private notification task",
          assignee: "Synthetic employee",
          dueDate: null,
        }),
        model = await work.saveModel(f.peer, {
          name: "Native notification protocol",
          provider: "openai-compatible",
          endpoint:
            "http://127.0.0.1:" +
            (fixture.server.address() as { port: number }).port +
            "/v1",
          model: "native-test-model",
          purpose: "chat",
          scope: "workspace",
          apiKey: key,
        });
      async function run(
        actor: typeof f.actor,
        engine: "dsh" | "hermes",
        plan?: any,
      ) {
        const started = await work.startRun(actor, {
          conversationId: project.conversationId,
          workflow: plan ? "manage_notifications" : "follow_up",
          engine,
          instruction: plan
            ? "Use only the confirmed reminder operation"
            : "native-follow-up-fixture",
          ...(plan ? { notificationPlan: plan } : {}),
          modelProfileId: model.id,
          idempotencyKey: randomUUID(),
        });
        await processor.process(started.id);
        const actual = await work.getRun(actor, started.id);
        assert.equal(actual.state, "succeeded", actual.error);
        assert.equal(actual.result.evidence, "runtime");
        return actual.result.receipts[0];
      }
      const configured = await run(f.actor, "dsh", {
        operation: "configure",
        scope: "personal",
        expectedRevision: 0,
        rules: { mode: "quiet" },
        confirmed: true,
      });
      assert.equal(configured.revision, 1);
      assert.equal((await run(f.actor, "dsh")).reason, "baseline");
      await work.patchTask(f.actor, task.id, {
        expectedVersion: 1,
        status: "done",
      });
      const quiet = await run(f.actor, "hermes");
      assert.equal(quiet.notify, false);
      assert.equal(quiet.notification.reason, "quiet");
      assert.equal((await run(f.peer, "hermes")).notify, true);
      const read = await run(f.actor, "hermes", { operation: "read" });
      assert.equal(read.effective.mode, "quiet");
      const messages = (
        await db.pool.query(
          "SELECT metadata FROM cw_messages WHERE conversation_id=$1",
          [project.conversationId],
        )
      ).rows;
      assert.equal(messages.length, 1);
      assert.ok(!JSON.stringify(messages).includes("personal"));
      assert.equal(fixture.calls(), 5);
      assert.equal(
        f.source.writes.length,
        0,
        "Product follow-up does not send a source Talk message",
      );
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
      await source?.close();
      await db.close();
      if (originalDir === undefined) delete process.env.RUNTIME_DIR;
      else process.env.RUNTIME_DIR = originalDir;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
