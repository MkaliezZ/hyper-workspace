import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(
  new URL("../scripts/deploy-nextcloud.mjs", import.meta.url),
);
const secret = "private-value-must-not-be-printed";
test("Source database tool defaults to an offline preflight despite private environment values", () => {
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: "invalid-" + secret,
      HYPER_NEXTCLOUD_DB_PASSWORD: secret,
    },
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).databaseRequests, 0);
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(secret));
});
test("Source database tool rejects unrelated database targets and invalid options without exposing supplied secrets", () => {
  for (const args of [["--execute"], ["--execute", secret], [secret]]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "postgres://hyper:" + secret + "@127.0.0.1/hyper",
        HYPER_NEXTCLOUD_DB_PASSWORD: "ab".repeat(32),
      },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(secret));
    assert.match(result.stderr, /Nextcloud database initialization failed/);
  }
});
