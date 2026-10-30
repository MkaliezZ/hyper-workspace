import { test } from "node:test";
import assert from "node:assert/strict";
import { MoneyAmount } from "@hyper/contracts";
import {
  micros,
  picos,
  units,
  estimateUsage,
} from "../apps/api/src/core/model-spending.js";
import { providerUsage } from "../apps/api/src/core/model-usage.js";
test("Currency arithmetic retains pico-unit precision, decimal boundaries and explicit zero without floats", () => {
  assert.equal(micros("0.000001"), 1n);
  assert.equal(picos("1.000001"), 1000001000000n);
  assert.equal(units(1n), "0.000000000001");
  assert.equal(picos("0.000000000001"), 1n);
  assert.equal(units(-1n), "-0.000000000001");
  for (const value of ["1e3", "-1", "00.1", ".2", "0.0000001", "NaN", " 1"])
    assert.equal(MoneyAmount.safeParse(value).success, false);
  assert.equal(MoneyAmount.safeParse("0").success, true);
});
test("Price estimates count input/cache/output once and conservatively bound unknown cache categories", () => {
  const price = {
    input_rate: "1000000",
    output_rate: "2000000",
    cache_read_rate: "100000",
    cache_write_rate: "1500000",
  };
  const use = providerUsage("anthropic", {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 10,
  });
  const quote = estimateUsage(price, use, "completed")!;
  assert.equal(quote.amount, 159000000n);
  assert.equal(quote.upper, false);
  const uncertain = estimateUsage(
    price,
    providerUsage("openai-compatible", {
      prompt_tokens: 150,
      completion_tokens: 20,
    }),
    "completed",
  )!;
  assert.equal(uncertain.amount, 265000000n);
  assert.equal(uncertain.upper, true);
  assert.equal(
    estimateUsage(price, providerUsage("openai-compatible", {}), "completed"),
    null,
  );
  assert.equal(estimateUsage(price, use, "unknown"), null);
});
test("Historical prices remain independent inputs and free or embedding prices do not invent missing usage", () => {
  const usage = providerUsage("openai-compatible", {
      prompt_tokens: 1,
      completion_tokens: 0,
    }),
    p = {
      input_rate: "1",
      output_rate: "0",
      cache_read_rate: "1",
      cache_write_rate: "1",
    };
  assert.equal(
    units(estimateUsage(p, usage, "completed")!.amount),
    "0.000000000001",
  );
  const free = {
    ...p,
    input_rate: "0",
    cache_read_rate: "0",
    cache_write_rate: "0",
  };
  assert.equal(estimateUsage(free, usage, "completed")!.amount, 0n);
  assert.equal(
    estimateUsage(free, providerUsage("openai-compatible", {}), "completed"),
    null,
  );
  const embedding = providerUsage(
    "openai-compatible",
    { prompt_tokens: 3, total_tokens: 3 },
    true,
  );
  assert.equal(estimateUsage(p, embedding, "completed")!.amount, 3n);
});
