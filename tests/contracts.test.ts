import { test } from "node:test";
import assert from "node:assert/strict";
import { RunInput, assertTransition } from "@hyper/contracts";
import { Vault } from "../apps/api/src/core/security.js";
import { runtimeCommand, JsonRpcProcess } from "../apps/api/src/engines/rpc.js";
import { FixtureAdapter } from "../apps/api/src/engines/adapters.js";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
test("Run input refuses client-provided identity and unknown tools", () => {
  assert.throws(() =>
    RunInput.parse({
      conversationId: "00000000-0000-4000-8000-000000000001",
      workflow: "chat",
      instruction: "hi",
      idempotencyKey: "12345678",
      actorId: "admin",
    }),
  );
});
test("Terminal runs cannot silently restart", () => {
  assert.throws(() => assertTransition("succeeded", "running"));
  assert.throws(() => assertTransition("cancelled", "succeeded"));
  assert.doesNotThrow(() => assertTransition("running", "recovery_required"));
});
test("Credential encryption is authenticated and randomized", () => {
  const v = new Vault("ab".repeat(32)),
    a = v.encrypt("test-only-secret"),
    b = v.encrypt("test-only-secret");
  assert.notEqual(a, b);
  assert.equal(v.decrypt(a), "test-only-secret");
  assert.throws(() => new Vault("cd".repeat(32)).decrypt(a));
  assert.throws(() => new Vault("invalid"));
});
test("Runtime launch accepts argv, never a shell expression", () => {
  assert.throws(() => runtimeCommand("node --eval malicious"));
  assert.throws(() => runtimeCommand("[]"));
  assert.deepEqual(runtimeCommand('["node","a.mjs"]'), ["node", "a.mjs"]);
});
test("Real stdio transport handles responses, errors and bounded timeouts without inheriting credentials", async () => {
  process.env.HYPER_TEST_SECRET = "must-not-reach-child";
  const rpc = new JsonRpcProcess(
    [process.execPath, resolve("tests/fixtures/rpc-server.mjs")],
    tmpdir(),
    {},
    300,
  );
  try {
    assert.deepEqual(await rpc.request("echo", { value: 42 }), {
      method: "echo",
      params: { value: 42 },
    });
    assert.deepEqual(await rpc.request("env"), { secretPresent: false });
    await assert.rejects(rpc.request("error"), /Runtime RPC failed \(-32000\)/);
    await assert.rejects(rpc.request("hang"), /timed out/);
  } finally {
    await rpc.close();
    delete process.env.HYPER_TEST_SECRET;
  }
});
test("Fixture execution cannot be used as a real employee model", async () => {
  const engine = new FixtureAdapter();
  await assert.rejects(
    engine.execute({
      runId: "fixture",
      subject: {
        id: "u",
        name: "user",
        workspaceId: "w",
        role: "member",
        demo: false,
      },
      workflow: "chat",
      instruction: "hi",
      context: "",
      policy: "",
      workdir: tmpdir(),
      signal: new AbortController().signal,
      onProgress: async () => {},
    }),
    /explicitly enabled demo/,
  );
});
