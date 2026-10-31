import { test } from "node:test";
import assert from "node:assert/strict";
import {
  textChunks,
  selectTextChunks,
} from "../apps/api/src/core/text-chunks.js";
test("Chunk positions cover exact text with bounded overlap and never tear Unicode pairs", () => {
  const text = "第一段😀保留原始位置。\n".repeat(400) + "唯一结尾𠮷";
  const chunks = textChunks(text);
  assert.ok(chunks.length > 2);
  assert.equal(chunks[0]!.start, 0);
  assert.equal(chunks.at(-1)!.end, text.length);
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.ordinal, index);
    assert.equal(chunk.content, text.slice(chunk.start, chunk.end));
    assert.ok(chunk.content.length <= 2000);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk.content));
    if (index) {
      assert.ok(chunk.start < chunks[index - 1]!.end);
      assert.ok(chunk.start > chunks[index - 1]!.start);
    }
  }
});
test("Long text excerpt selection locates middle evidence and labels partial or unmatched context", () => {
  const text =
      "普通背景。".repeat(3000) +
      "\n第二阶段唯一负责人为合成员工。\n" +
      "其他背景。".repeat(3000),
    selection = selectTextChunks(text, "第二阶段负责人", 3);
  assert.equal(selection.partial, true);
  assert.equal(selection.matched, true);
  assert.ok(
    selection.chunks.some((chunk) => chunk.content.includes("唯一负责人")),
  );
  assert.ok(selection.chunks.some((chunk) => chunk.start > 0));
  assert.equal(selectTextChunks(text, "zzzz-unmatched", 2).matched, false);
  assert.throws(() => textChunks("x".repeat(180001)));
});
