import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = new URL("../scripts/real-business-smoke.ts", import.meta.url);
const sentinel = "synthetic-secret-must-not-be-echoed";
function invoke(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(script), ...args],
    {
      encoding: "utf8",
      timeout: 15000,
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: "invalid-private-database-" + sentinel,
        REAL_MODEL_PROFILE_ID: sentinel,
      },
    },
  );
}

test("Real supplier business CLI defaults to a no-call preflight even with invalid private configuration", () => {
  const result = invoke([]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  const preflight = JSON.parse(result.stdout);
  assert.equal(preflight.mode, "preflight");
  assert.equal(preflight.requestsSent, 0);
  assert.equal(preflight.executionMayBeBillable, true);
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(sentinel));
});

test("Real supplier business CLI rejects a secret used as a profile UUID and unknown arguments without echoing it", () => {
  for (const args of [["--execute"], ["--execute", sentinel]]) {
    const result = invoke(args);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.length > 0);
    assert.match(
      result.stderr,
      /Set REAL_MODEL_PROFILE_ID|Real business check did not finish/,
    );
    assert.ok(!result.stderr.includes(sentinel));
    assert.equal(result.stdout, "");
  }
});
