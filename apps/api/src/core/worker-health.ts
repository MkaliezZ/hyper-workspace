import { writeFile, rename, rm } from "node:fs/promises";
import type { Database } from "../db/database.js";
/** Opt-in container heartbeat: only successful database probes refresh liveness. */
export async function startWorkerHealth(db: Database, path?: string) {
  if (!path) return async () => {};
  let stopped = false,
    inFlight = false;
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await db.pool.query("SELECT 1");
      if (stopped) return;
      await writeFile(
        path + ".tmp",
        JSON.stringify({ pid: process.pid, updatedAt: Date.now() }),
        { mode: 0o600 },
      );
      if (!stopped) await rename(path + ".tmp", path);
    } catch {
    } finally {
      inFlight = false;
    }
  };
  await tick();
  const timer = setInterval(() => void tick(), 5000);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await rm(path, { force: true });
    await rm(path + ".tmp", { force: true });
  };
}
