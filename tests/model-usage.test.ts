import { test } from "node:test";
import assert from "node:assert/strict";
import { providerUsage } from "../apps/api/src/core/model-usage.js";
import { UsageCollector } from "../apps/api/src/core/model-gateway.js";
test("Provider accounting keeps aggregate/cache/reasoning categories disjoint and never fabricates absent zeros", () => {
  const v = providerUsage("deepseek", {
    prompt_tokens: 100,
    completion_tokens: 25,
    total_tokens: 125,
    prompt_cache_hit_tokens: 40,
    completion_tokens_details: { reasoning_tokens: 10 },
  });
  assert.equal(v.inputTokens, 100);
  assert.equal(v.outputTokens, 25);
  assert.equal(v.cacheReadTokens, 40);
  assert.equal(v.reasoningTokens, 10);
  assert.equal(v.status, "reported");
  assert.equal(providerUsage("openai-compatible", undefined).status, "unknown");
  assert.equal(
    providerUsage("openai-compatible", {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    }).status,
    "reported",
  );
  assert.equal(
    providerUsage("openai-compatible", { prompt_tokens: 3 }).outputTokens,
    null,
  );
  assert.equal(
    providerUsage("openai-compatible", { prompt_tokens: 3 }).status,
    "partial",
  );
  assert.equal(
    providerUsage(
      "openai-compatible",
      { prompt_tokens: 3, total_tokens: 3 },
      true,
    ).status,
    "reported",
  );
  for (const raw of [
    { prompt_tokens: -1 },
    { prompt_tokens: "3" },
    { prompt_tokens: 2, completion_tokens: 1, total_tokens: 8 },
    { prompt_tokens: 3, completion_tokens: 1, prompt_cache_hit_tokens: 4 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.equal(providerUsage("openai-compatible", raw).status, "invalid");
});
test("SSE accounting tolerates byte boundaries and repeated cumulative counters without adding them twice", () => {
  const c = new UsageCollector("openai-compatible", true);
  const raw =
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"usage":{"prompt_tokens":8,"completion_tokens":6,"total_tokens":14}}\r\n\r\ndata: {"usage":{"prompt_tokens":8,"completion_tokens":6,"total_tokens":14}}\n\ndata: [DONE]\n\n';
  for (const b of Buffer.from(raw)) c.push(Buffer.from([b]));
  assert.deepEqual(c.finish(), {
    status: "reported",
    inputTokens: 8,
    outputTokens: 6,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  });
  const lost = new UsageCollector("openai-compatible", true);
  lost.push(
    Buffer.from('data: {"usage":{"prompt_tokens":8,"completion_tokens":6}}\n'),
  );
  assert.equal(lost.finish().status, "partial");
});
test("Anthropic cumulative input/cache/output updates and error/truncation remain honest", () => {
  const c = new UsageCollector("anthropic", true);
  for (const event of [
    {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 2,
          output_tokens: 1,
        },
      },
    },
    { type: "message_delta", usage: { output_tokens: 3 } },
    { type: "message_delta", usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ])
    c.push(Buffer.from("data: " + JSON.stringify(event) + "\n\n"));
  assert.equal(c.finish().inputTokens, 16);
  assert.equal(c.finish().outputTokens, 7);
  assert.equal(c.finish().status, "reported");
  const noCaches = providerUsage("anthropic", {
    input_tokens: 10,
    output_tokens: 7,
  });
  assert.equal(noCaches.inputTokens, null);
  assert.equal(noCaches.status, "partial");
  const e = new UsageCollector("anthropic", true);
  e.push(
    Buffer.from('data: {"type":"error","error":{"message":"do-not-log"}}\n\n'),
  );
  assert.equal(e.finish().status, "unknown");
  assert.equal(e.complete, false);
  const bad = new UsageCollector("deepseek", true);
  bad.push(Buffer.from("data: {broken}\n\ndata: [DONE]\n\n"));
  assert.equal(bad.finish().status, "invalid");
});
