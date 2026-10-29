import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  DocumentExtractor,
  MAX_DOCUMENT_BYTES,
} from "../apps/api/src/core/document-extraction.js";
const config = {
  python: process.execPath,
  script: fileURLToPath(
    new URL("./fixtures/document-process.mjs", import.meta.url),
  ),
  timeoutMs: 1000,
  stdoutLimit: 512 * 1024,
  stderrLimit: 16 * 1024,
};
test("Document process receives no product credentials and rejects partial or mismatched output", async () => {
  process.env.DOCUMENT_TEST_SECRET = "private-environment-sentinel";
  try {
    const host = new DocumentExtractor(config);
    assert.equal(
      (await host.extract(Buffer.from("environment"), "pdf")).format,
      "pdf",
    );
    for (const value of ["invalid", "mismatch", "failed"])
      await assert.rejects(
        host.extract(Buffer.from(value), "pdf"),
        /解析结果不完整/,
      );
    await assert.rejects(
      host.extract(Buffer.alloc(MAX_DOCUMENT_BYTES + 1), "pdf"),
      /8 MiB/,
    );
  } finally {
    delete process.env.DOCUMENT_TEST_SECRET;
  }
});
test("Document process limits stdout, stderr and wall time without exposing diagnostic bytes", async () => {
  const host = new DocumentExtractor(config);
  for (const [input, expected] of [
    ["stdout", /结果超过/],
    ["stderr", /限额内/],
    ["hang", /超时/],
  ] as const) {
    await assert.rejects(
      host.extract(Buffer.from(input), "pdf"),
      (error: Error) => {
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /private-diagnostic/);
        return true;
      },
    );
  }
  await assert.rejects(
    new DocumentExtractor({
      ...config,
      python: "/missing-document-python",
    }).extract(Buffer.from("x"), "pdf"),
    /无法启动/,
  );
});
test("Document cancellation and two-process backpressure release capacity after children exit", async () => {
  const host = new DocumentExtractor(config),
    a = new AbortController(),
    b = new AbortController();
  const first = host.extract(Buffer.from("hang"), "pdf", a.signal),
    second = host.extract(Buffer.from("hang"), "pdf", b.signal);
  const completed = Promise.allSettled([first, second]);
  await assert.rejects(host.extract(Buffer.from("environment"), "pdf"), /繁忙/);
  a.abort();
  b.abort();
  const results = await completed;
  for (const r of results) {
    assert.equal(r.status, "rejected");
    if (r.status === "rejected") assert.match(r.reason.message, /取消/);
  }
  assert.equal(
    (await host.extract(Buffer.from("environment"), "pdf")).format,
    "pdf",
  );
});
