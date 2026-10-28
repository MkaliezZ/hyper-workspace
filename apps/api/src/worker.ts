import { Database } from "./db/database.js";
import { WorkspaceService } from "./core/workspace.js";
import { RunProcessor } from "./core/processor.js";
import { engineRegistry } from "./engines/adapters.js";
const db = new Database();
const worker = new RunProcessor(new WorkspaceService(db, engineRegistry()));
await worker.start(true);
console.log("Hyper Workspace worker started.");
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => {
    void worker
      .stop()
      .then(() => db.close())
      .then(() => process.exit(0));
  });
