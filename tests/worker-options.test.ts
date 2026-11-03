import test from "node:test";
import assert from "node:assert/strict";
import { workerRunConcurrency } from "../apps/api/src/core/worker-options.js";

test("Worker concurrency preserves the default and permits a serial pilot worker", () => {
  const previous = process.env.WORKER_RUN_CONCURRENCY;
  delete process.env.WORKER_RUN_CONCURRENCY;
  try {
    assert.equal(workerRunConcurrency(), 2);
    for (let n = 1; n <= 8; n++)
      assert.equal(workerRunConcurrency(String(n)), n);
  } finally {
    if (previous === undefined) delete process.env.WORKER_RUN_CONCURRENCY;
    else process.env.WORKER_RUN_CONCURRENCY = previous;
  }
});

test("Worker refuses invalid concurrency rather than silently using an unsafe fallback", () => {
  for (const value of ["", "0", "9", "-1", "1.5", "01", " 1", "two"])
    assert.throws(() => workerRunConcurrency(value), /integer from 1 to 8/);
});
