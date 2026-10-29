import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--add-runtime-key") {
  if (args.length !== 3)
    throw new Error(
      "Usage: node scripts/deploy-init.mjs --add-runtime-key input-file new-output-file",
    );
  const previous = await readFile(resolve(args[1]), "utf8");
  if (/^\s*(?:export\s+)?DB_RUNTIME_PASSWORD\s*=/m.test(previous))
    throw new Error(
      "Runtime key already configured; preserve the existing configuration.",
    );
  const existingSecrets = [];
  for (const name of ["DB_PASSWORD", "CREDENTIAL_MASTER_KEY"]) {
    const matches = [
      ...previous.matchAll(new RegExp("^" + name + "=(.*)$", "gm")),
    ];
    if (matches.length !== 1 || !/^[a-f0-9]{64}$/i.test(matches[0][1]))
      throw new Error(
        "Existing configuration must contain one valid " + name + ".",
      );
    existingSecrets.push(matches[0][1]);
  }
  if (new Set(existingSecrets).size !== 2)
    throw new Error(
      "Preserve independent database and encryption secrets; inspect the existing configuration.",
    );
  const output = resolve(args[2]);
  await writeFile(
    output,
    previous +
      (previous.endsWith("\n") ? "" : "\n") +
      "DB_RUNTIME_PASSWORD=" +
      randomBytes(32).toString("hex") +
      "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    "Created upgraded private configuration: " +
      output +
      ". The original file and existing secrets are unchanged.",
  );
  process.exit(0);
}
if (args.length > 1)
  throw new Error("Usage: node scripts/deploy-init.mjs [output-file]");
const path = resolve(args[0] ?? ".env.compose");
let text = await readFile(
  new URL("../deploy/compose.env.example", import.meta.url),
  "utf8",
);
text = text
  .replace("GENERATE_DATABASE_PASSWORD", randomBytes(32).toString("hex"))
  .replace(
    "GENERATE_RUNTIME_DATABASE_PASSWORD",
    randomBytes(32).toString("hex"),
  )
  .replace("GENERATE_CREDENTIAL_MASTER_KEY", randomBytes(32).toString("hex"))
  .replace("GENERATE_WORKSPACE_UUID", randomUUID());
await writeFile(path, text, { flag: "wx", mode: 0o600 });
console.log(
  "Created private deployment configuration: " +
    path +
    ". Edit source settings before startup.",
);
