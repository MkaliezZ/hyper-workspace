import { test } from "node:test";
import { exerciseNativeBusiness } from "./business-contract.js";
test(
  "Real Hermes isolates employee models, native tools and receipts",
  { timeout: 90000 },
  () => exerciseNativeBusiness("hermes"),
);
test(
  "DSH to Hermes and back preserves product artifact IDs, sources and versions",
  { timeout: 120000 },
  () => exerciseNativeBusiness("dsh", "hermes"),
);
