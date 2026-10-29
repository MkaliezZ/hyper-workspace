import { Database } from "./db/database.js";
import { WorkspaceService } from "./core/workspace.js";
import { RunProcessor } from "./core/processor.js";
import { engineRegistry } from "./engines/adapters.js";
import { startWorkerHealth } from "./core/worker-health.js";
const db = new Database();
const worker = new RunProcessor(new WorkspaceService(db, engineRegistry()));
await worker.start(true);
const stopHealth = await startWorkerHealth(db, process.env.WORKER_HEALTH_FILE);
console.log("Hyper Workspace worker started.");
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => {
    void stopHealth()
      .then(() => worker.stop())
      .then(() => db.close())
      .then(() => process.exit(0));
  });
