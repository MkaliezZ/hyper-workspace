import { readFile } from "node:fs/promises";
try {
  const r = JSON.parse(await readFile(process.env.WORKER_HEALTH_FILE, "utf8"));
  if (
    !Number.isSafeInteger(r.pid) ||
    r.pid < 1 ||
    !Number.isFinite(r.updatedAt) ||
    Date.now() - r.updatedAt > 15000 ||
    r.updatedAt > Date.now() + 1000
  )
    process.exit(1);
  process.kill(r.pid, 0);
} catch {
  process.exit(1);
}
