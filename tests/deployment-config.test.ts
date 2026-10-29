import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { applicationConfig } from "../apps/api/src/core/application-config.js";
test("Deployment configuration preserves loopback defaults and rejects ambiguous or insecure public production origins", () => {
  assert.deepEqual(applicationConfig({ APP_ORIGIN: "http://127.0.0.1:5173" }), {
    host: "127.0.0.1",
    port: 3100,
    secureCookie: false,
    serveWeb: false,
  });
  assert.equal(
    applicationConfig({
      APP_ORIGIN: "https://workspace.example.com",
      NODE_ENV: "production",
      API_HOST: "0.0.0.0",
      SERVE_WEB: "true",
    }).secureCookie,
    true,
  );
  for (const origin of [
    "http://workspace.example.com",
    "https://workspace.example.com/path",
    "https://user:secret@workspace.example.com",
    "https://workspace.example.com/",
    "file:///tmp/file",
  ])
    assert.throws(() =>
      applicationConfig({ APP_ORIGIN: origin, NODE_ENV: "production" }),
    );
  assert.throws(() =>
    applicationConfig({
      APP_ORIGIN: "http://localhost",
      API_HOST: "example.com",
    }),
  );
});
test("Private deployment initialization generates independent secrets and cannot overwrite an existing configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hyper-deploy-"));
  const path = join(dir, "compose.env");
  try {
    const r = spawnSync(process.execPath, ["scripts/deploy-init.mjs", path], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const text = await readFile(path, "utf8"),
      key = text.match(/^CREDENTIAL_MASTER_KEY=(.+)$/m)![1]!,
      password = text.match(/^DB_PASSWORD=(.+)$/m)![1]!,
      runtimePassword = text.match(/^DB_RUNTIME_PASSWORD=(.+)$/m)![1]!;
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.match(runtimePassword, /^[a-f0-9]{64}$/);
    assert.equal(new Set([key, password, runtimePassword]).size, 3);
    assert.ok(
      [key, password, runtimePassword].every(
        (secret) => !r.stdout.includes(secret),
      ),
    );
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.notEqual(
      spawnSync(process.execPath, ["scripts/deploy-init.mjs", path], {
        encoding: "utf8",
      }).status,
      0,
    );
    assert.equal(await readFile(path, "utf8"), text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Upgrading a private Compose configuration preserves the original and existing secrets and refuses overwrite or duplicate runtime keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hyper-deploy-upgrade-"));
  const original = join(dir, "old.env"),
    output = join(dir, "new.env");
  const old =
    "# existing configuration\nDB_PASSWORD=" +
    "ab".repeat(32) +
    "\nCREDENTIAL_MASTER_KEY=" +
    "cd".repeat(32) +
    "\nAPP_ORIGIN=https://workspace.example.com\n";
  const upgrade = (input = original, target = output) =>
    spawnSync(
      process.execPath,
      ["scripts/deploy-init.mjs", "--add-runtime-key", input, target],
      { encoding: "utf8" },
    );
  try {
    await writeFile(original, old, { mode: 0o600 });
    const r = upgrade();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(await readFile(original, "utf8"), old);
    const next = await readFile(output, "utf8");
    assert.ok(next.startsWith(old));
    assert.match(
      next.slice(old.length),
      /^DB_RUNTIME_PASSWORD=[a-f0-9]{64}\n$/,
    );
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.notEqual(upgrade().status, 0);
    assert.notEqual(upgrade(output, join(dir, "duplicate.env")).status, 0);
    assert.equal(await readFile(output, "utf8"), next);
    const secret = next.match(/^DB_RUNTIME_PASSWORD=(.+)$/m)![1]!;
    assert.ok(!r.stdout.includes(secret));
    const malformed = join(dir, "malformed.env");
    await writeFile(malformed, old + "DB_PASSWORD=invalid-duplicate\n", {
      mode: 0o600,
    });
    assert.notEqual(
      upgrade(malformed, join(dir, "invalid-output.env")).status,
      0,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Container worker health rejects stale, malformed and missing heartbeats", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hyper-health-")),
    path = join(dir, "health.json");
  const check = () =>
    spawnSync(process.execPath, ["scripts/worker-health.mjs"], {
      env: { ...process.env, WORKER_HEALTH_FILE: path },
    }).status;
  try {
    assert.equal(check(), 1);
    await writeFile(path, "bad");
    assert.equal(check(), 1);
    await writeFile(
      path,
      JSON.stringify({ pid: process.pid, updatedAt: Date.now() - 30000 }),
    );
    assert.equal(check(), 1);
    await writeFile(
      path,
      JSON.stringify({ pid: process.pid, updatedAt: Date.now() }),
    );
    assert.equal(check(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
