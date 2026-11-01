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
  "Native DSH and Hermes retain structured task deadlines and canonical readback without inferring employee identity or repeating a completed Run",
  { timeout: 180000 },
  async () => {
    const url = process.env.TEST_DATABASE_URL;
    assert.ok(url && new URL(url).pathname.endsWith("_test"));
    const db = new Database(url),
      original = process.env.RUNTIME_DIR,
      directory = await mkdtemp(join(tmpdir(), "hyper-native-task-create-")),
      key = "synthetic-task-create-" + randomUUID();
    let scope:
      | Awaited<ReturnType<typeof createRoomManagementScope>>
      | undefined;
    const fixture = modelFixture([key], undefined, () => ({
      text: "Synthetic protocol result; not a receipt",
      actions: [
        {
          tool: "artifact.create",
          args: {
            title: "Synthetic task source",
            content:
              "Synthetic task deadline is 2026-11-04; employee identity still needs explicit assignment.",
          },
        },
        {
          tool: "task.create",
          args: {
            title: "Synthetic task without a date hidden in its title",
            assignee: "operator",
            dueDate: "2026-11-04",
          },
        },
      ],
    }));
    process.env.RUNTIME_DIR = directory;
    await new Promise<void>((r) => fixture.server.listen(0, "127.0.0.1", r));
    try {
      await db.migrate();
      scope = await createRoomManagementScope(db);
      const f = scope,
        work = new WorkspaceService(db, engineRegistry()),
        processor = new RunProcessor(work);
      const project = await work.createTalkProject(
          f.actor,
          f.room.token,
          "Synthetic native deadline source",
          "Retain structured task fields",
        ),
        model = await work.saveModel(f.actor, {
          name: "Native task-create protocol",
          provider: "openai-compatible",
          endpoint:
            "http://127.0.0.1:" +
            (fixture.server.address() as any).port +
            "/v1",
          model: "native-test-model",
          purpose: "chat",
          scope: "personal",
          apiKey: key,
        });
      const ids: string[] = [];
      for (const engine of ["dsh", "hermes"] as const) {
        const input = {
          conversationId: project.conversationId,
          workflow: "discussion_to_minutes" as const,
          engine,
          instruction:
            "Create one synthetic task with dueDate 2026-11-04, retaining the label without guessing an employee ID.",
          modelProfileId: model.id,
          idempotencyKey: randomUUID(),
        };
        const run = await work.startRun(f.actor, input);
        await processor.process(run.id);
        const result = await work.getRun(f.actor, run.id);
        assert.equal(result.state, "succeeded", result.error);
        assert.equal(result.result.evidence, "runtime");
        const receipt = result.result.receipts.find(
          (r: any) => r.tool === "task.create",
        );
        assert.equal(receipt.dueDate, "2026-11-04");
        assert.equal(receipt.assignee, "operator");
        assert.equal(receipt.assigneeId, null);
        assert.equal(receipt.status, "open");
        const actual = await work.task(f.actor, receipt.id);
        assert.equal(actual.current.dueDate, receipt.dueDate);
        assert.equal(actual.current.assigneeId, null);
        assert.equal(actual.current.status, "open");
        ids.push(receipt.id);
        const replay = await work.startRun(f.actor, input);
        assert.equal(replay.id, run.id);
        assert.equal(replay.created, false);
        await processor.process(replay.id);
        assert.equal(
          (await work.task(f.actor, receipt.id)).current.version,
          actual.current.version,
        );
      }
      assert.equal(new Set(ids).size, 2);
      assert.equal(fixture.calls(), 2);
      assert.equal(
        (
          await db.pool.query(
            "SELECT count(*)::int n FROM cw_tasks WHERE project_id=$1",
            [project.id],
          )
        ).rows[0].n,
        2,
      );
      assert.equal(f.source.writes.length, 0);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
      await scope?.close();
      await db.close();
      if (original === undefined) delete process.env.RUNTIME_DIR;
      else process.env.RUNTIME_DIR = original;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
