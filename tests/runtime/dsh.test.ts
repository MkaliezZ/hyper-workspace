import { test } from "node:test";
import { exerciseNativeBusiness } from "./business-contract.js";
test(
  "Real DSH isolates employee models, native tools and receipts",
  { timeout: 90000 },
  () => exerciseNativeBusiness("dsh"),
);
