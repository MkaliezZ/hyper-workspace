import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunEvent } from "@hyper/contracts";
import { receiptList } from "../apps/web/src/components/RunDetails.js";

const receipt = { tool: "task.assign", id: "task", version: 2, assignee: "甲" };
function completed(data: Record<string, unknown>, sequence: number): RunEvent {
  return {
    eventId: "event-" + sequence,
    runId: "run",
    sequence,
    kind: "action.completed",
    schemaVersion: "1.0.0",
    occurredAt: new Date(0).toISOString(),
    data,
  };
}
const info = {
  id: "run",
  state: "failed" as const,
  engine: "hermes",
  error: "执行未完成，先核对已发生操作。",
  result: null,
};

test("Incomplete Run history preserves separate completed actions even with identical receipts", () => {
  const events = [completed(receipt, 1), completed({ ...receipt }, 2)];
  assert.deepEqual(receiptList(info, events), [receipt, receipt]);
});

test("Terminal receipts and events match one-for-one without hiding distinct operation results", () => {
  const different = { ...receipt, assignee: "乙" };
  const result = { receipts: [receipt, { ...receipt }, different] };
  const events = [
    completed({ ...receipt }, 1),
    completed({ ...receipt }, 2),
    completed(different, 3),
  ];
  assert.deepEqual(receiptList({ ...info, result }, events), result.receipts);
  assert.deepEqual(
    receiptList({ ...info, result: { receipts: [receipt] } }, events),
    result.receipts,
  );
});
