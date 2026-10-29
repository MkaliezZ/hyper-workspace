import { spawnSync } from "node:child_process";
import { applicationConfig } from "../apps/api/dist/core/application-config.js";
import { nextcloudConfig } from "../apps/api/dist/providers/nextcloud.js";
import { configureRuntimeDatabase, RUNTIME_ROLE } from "./deploy-database.mjs";
applicationConfig();
if (!/^[a-f0-9]{64}$/i.test(process.env.CREDENTIAL_MASTER_KEY ?? ""))
  throw new Error("CREDENTIAL_MASTER_KEY must be 64 hex characters.");
if (!/^[a-f0-9]{64}$/i.test(process.env.DB_PASSWORD ?? ""))
  throw new Error("DB_PASSWORD must be 64 hex characters.");
if (
  !/^[a-f0-9]{64}$/i.test(process.env.DB_RUNTIME_PASSWORD ?? "") ||
  new Set([
    process.env.DB_PASSWORD,
    process.env.DB_RUNTIME_PASSWORD,
    process.env.CREDENTIAL_MASTER_KEY,
  ]).size !== 3
)
  throw new Error(
    "Use independent 64-hex database administrator, runtime and credential encryption secrets.",
  );
const demo = process.env.DEMO_MODE === "true";
if (!demo && (!nextcloudConfig() || !process.env.WORKSPACE_NAME?.trim()))
  throw new Error(
    "Configure Nextcloud identity and WORKSPACE_NAME before enterprise startup.",
  );
const adminUrl = process.env.DATABASE_URL;
// Validate the dedicated database and existing role before applying product migrations.
await configureRuntimeDatabase(adminUrl, process.env.DB_RUNTIME_PASSWORD);
for (const command of ["migrate", demo ? "seed" : "workspace:init"]) {
  const env = { ...process.env };
  if (command !== "migrate") {
    await configureRuntimeDatabase(adminUrl, process.env.DB_RUNTIME_PASSWORD);
    const runtimeUrl = new URL(adminUrl);
    runtimeUrl.username = RUNTIME_ROLE;
    runtimeUrl.password = process.env.DB_RUNTIME_PASSWORD;
    env.DATABASE_URL = runtimeUrl.toString();
    delete env.DB_PASSWORD;
    delete env.DB_RUNTIME_PASSWORD;
  }
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "dist/db/cli.js", command],
    { cwd: new URL("../apps/api/", import.meta.url), stdio: "inherit", env },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
}
