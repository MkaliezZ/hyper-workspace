import { spawnSync } from "node:child_process";
import { applicationConfig } from "../apps/api/dist/core/application-config.js";
import { nextcloudConfig } from "../apps/api/dist/providers/nextcloud.js";
applicationConfig();
if (!/^[a-f0-9]{64}$/i.test(process.env.CREDENTIAL_MASTER_KEY ?? ""))
  throw new Error("CREDENTIAL_MASTER_KEY must be 64 hex characters.");
if (!/^[a-f0-9]{64}$/i.test(process.env.DB_PASSWORD ?? ""))
  throw new Error("DB_PASSWORD must be 64 hex characters.");
const demo = process.env.DEMO_MODE === "true";
if (!demo && (!nextcloudConfig() || !process.env.WORKSPACE_NAME?.trim()))
  throw new Error(
    "Configure Nextcloud identity and WORKSPACE_NAME before enterprise startup.",
  );
for (const command of ["migrate", demo ? "seed" : "workspace:init"]) {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "dist/db/cli.js", command],
    { cwd: new URL("../apps/api/", import.meta.url), stdio: "inherit" },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
}
