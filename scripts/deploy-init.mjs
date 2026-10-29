import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const args = process.argv.slice(2);
if (args.length > 1)
  throw new Error("Usage: node scripts/deploy-init.mjs [output-file]");
const path = resolve(args[0] ?? ".env.compose");
let text = await readFile(
  new URL("../deploy/compose.env.example", import.meta.url),
  "utf8",
);
text = text
  .replace("GENERATE_DATABASE_PASSWORD", randomBytes(32).toString("hex"))
  .replace("GENERATE_CREDENTIAL_MASTER_KEY", randomBytes(32).toString("hex"))
  .replace("GENERATE_WORKSPACE_UUID", randomUUID());
await writeFile(path, text, { flag: "wx", mode: 0o600 });
console.log(
  "Created private deployment configuration: " +
    path +
    ". Edit source settings before startup.",
);
