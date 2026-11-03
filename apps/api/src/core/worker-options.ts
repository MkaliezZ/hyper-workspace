export function workerRunConcurrency(
  value = process.env.WORKER_RUN_CONCURRENCY,
): number {
  if (value === undefined) return 2;
  if (!/^[1-8]$/.test(value))
    throw new Error("WORKER_RUN_CONCURRENCY must be an integer from 1 to 8");
  return Number(value);
}
