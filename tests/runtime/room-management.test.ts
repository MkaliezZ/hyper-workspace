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
import { RoomManagementRunInput } from "@hyper/contracts/room-management";
import { createRoomManagementScope } from "../fixtures/room-management-scope.js";
import { modelFixture } from "./business-contract.js";
test(
  "Native DSH and Hermes manage the same source conversations through host-bound plans and private actual receipts",
  { timeout: 240000 },
  async () => {
    const url = process.env.TEST_DATABASE_URL;
    assert.ok(url && new URL(url).pathname.endsWith("_test"));
    const db = new Database(url),
      originalDir = process.env.RUNTIME_DIR,
      dir = await mkdtemp(join(tmpdir(), "hyper-room-native-"));
    let source:
      | Awaited<ReturnType<typeof createRoomManagementScope>>
      | undefined;
    const key = "synthetic-native-room-" + randomUUID(),
      fixture = modelFixture([key], (body) => {
        const text = JSON.stringify(body.messages);
        for (const privateValue of [
          "明确合成群",
          "合成来源私群",
          "同名员工",
          "synthetic-password",
        ])
          assert.ok(!text.includes(privateValue));
      });
    process.env.RUNTIME_DIR = dir;
    await new Promise<void>((resolve) =>
      fixture.server.listen(0, "127.0.0.1", resolve),
    );
    try {
      await db.migrate();
      source = await createRoomManagementScope(db);
      const f = source,
        work = new WorkspaceService(db, engineRegistry()),
        processor = new RunProcessor(work);
      for (const engine of ["dsh", "hermes"])
        assert.equal(
          work.engines.get(engine as any)?.describeCapabilities().configured,
          true,
        );
      const model = await work.saveModel(f.actor, {
        name: "Native room protocol",
        provider: "openai-compatible",
        endpoint:
          "http://127.0.0.1:" +
          (fixture.server.address() as { port: number }).port +
          "/v1",
        model: "native-test-model",
        purpose: "chat",
        scope: "personal",
        apiKey: key,
      });
      async function run(engine: "dsh" | "hermes", plan: any) {
        const started = await work.startRoomManagementRun(
          f.actor,
          RoomManagementRunInput.parse({
            engine,
            plan,
            modelProfileId: model.id,
            idempotencyKey: randomUUID(),
          }),
        );
        await processor.process(started.id);
        const actual = await work.getRun(f.actor, started.id);
        assert.equal(actual.state, "succeeded", JSON.stringify(actual));
        assert.equal(actual.result.evidence, "runtime");
        assert.ok(!JSON.stringify(actual.result).includes("明确合成群"));
        assert.ok(!JSON.stringify(actual.result).includes("同名员工"));
        return actual.result.receipts[0];
      }
      const group = await run("dsh", await f.create(["peer", "other"]));
      assert.equal(group.completedSteps, 3);
      assert.equal(f.source.rooms.get(group.roomId)!.people.size, 3);
      const state = await f.service.read(f.actor, group.roomId),
        room = state.rooms[0]!;
      const favorite = await run("hermes", {
        operation: "favorite",
        bindingRef: state.bindingRef,
        roomId: room.id,
        expected: room.expected.favorite,
        enabled: true,
        confirmed: true,
      });
      assert.equal(favorite.state, "succeeded");
      assert.equal(
        f.source.rooms.get(room.id)!.preferences.get("operator")!.favorite,
        true,
      );
      const read = await run("dsh", {
        operation: "read",
        bindingRef: state.bindingRef,
      });
      assert.equal(read.roomCount, 2);
      assert.equal(read.rows, undefined);
      const current = await f.service.read(f.actor, group.roomId),
        deleted = await run("hermes", {
          operation: "delete",
          bindingRef: current.bindingRef,
          roomId: room.id,
          expected: current.rooms[0]!.expected.delete,
          confirmed: true,
        });
      assert.equal(deleted.scopeAvailable, false);
      assert.equal(f.source.rooms.has(room.id), false);
      assert.equal(f.source.writes.length, 5);
      assert.equal(fixture.calls(), 4);
      assert.equal(
        (
          await db.pool.query(
            "SELECT count(*)::int AS n FROM cw_messages WHERE workspace_id=$1",
            [f.actor.workspaceId],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await new Promise<void>((resolve) =>
        fixture.server.close(() => resolve()),
      );
      await source?.close();
      await db.close();
      if (originalDir === undefined) delete process.env.RUNTIME_DIR;
      else process.env.RUNTIME_DIR = originalDir;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
