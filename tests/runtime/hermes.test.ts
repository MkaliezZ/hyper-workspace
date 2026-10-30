import { test } from "node:test";
import { exerciseNativeBusiness } from "./business-contract.js";
test(
  "Real Hermes isolates employee models, native tools and receipts",
  { timeout: 210000 },
  () => exerciseNativeBusiness("hermes"),
);
test(
  "DSH to Hermes and back preserves product artifact IDs, sources and versions",
  { timeout: 180000 },
  () => exerciseNativeBusiness("dsh", "hermes"),
);
