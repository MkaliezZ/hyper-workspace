import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { DshAdapter, HermesAdapter } from "../apps/api/src/engines/adapters.js";
import { JsonRpcProcess } from "../apps/api/src/engines/rpc.js";
import type { EngineRequest } from "@hyper/contracts";
test("Pinned DSH/Hermes wire fixtures normalize delayed final results with session isolation", async () => {
  const workdir = await mkdtemp(join(tmpdir(), "hyper-engine-test-"));
  const request: EngineRequest = {
    runId: "run-1",
    subject: {
      id: "employee",
      name: "Test",
      workspaceId: "w",
      demo: false,
      role: "member",
    },
    workflow: "chat",
    context: "authorized data",
    policy: "P04 P07",
    instruction: "run contract fixture",
    workdir,
    signal: new AbortController().signal,
    onProgress: async () => {},
  };
  const command = (mode: string) => [
    process.execPath,
    resolve("tests/fixtures/engine-wire.mjs"),
    mode,
  ];
  try {
    const dsh = new DshAdapter(command("dsh"), {
      provider: "hyper-model",
      model: "fixture-model",
    });
    const hermes = new HermesAdapter(command("hermes"));
    for (const engine of [dsh, hermes])
      assert.deepEqual(await engine.execute(request), {
        text: "protocol-fixture-result",
        actions: [],
        evidence: "runtime",
      });
    await assert.rejects(
      new HermesAdapter(command("hermes-error")).execute(request),
      /did not complete/,
    );
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});
test("Notification waits terminate on cancellation and closed transport", async () => {
  const rpc = new JsonRpcProcess(
    [process.execPath, resolve("tests/fixtures/rpc-server.mjs")],
    tmpdir(),
    {},
    1000,
  );
  const abort = new AbortController();
  const waiting = rpc.waitForNotification("event", () => true, abort.signal);
  abort.abort();
  await assert.rejects(waiting, /cancelled/);
  const closed = rpc.waitForNotification(
    "event",
    () => true,
    new AbortController().signal,
  );
  const closing = rpc.close();
  assert.equal(rpc.close(), closing);
  await closing;
  await assert.rejects(closed, /closed/);
  assert.throws(() => rpc.start(), /closed/);
});
