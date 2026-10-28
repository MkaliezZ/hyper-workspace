import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Node's watch mode tries to watch a missing --env-file-if-exists on Linux.
// Load it in the child instead, while retaining environment-only deployment.
const config = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(config)) process.loadEnvFile(config);
