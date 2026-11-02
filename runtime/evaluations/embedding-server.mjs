import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { embeddingRuntime, embeddingModel } from "./embedding-runtime.mjs";
async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(
      JSON.stringify({
        mode: "preflight",
        requestsSent: 0,
        model: embeddingModel,
        listen: "loopback dynamic port",
        inputLimit: "400 characters and 512 tokens; longer inputs rejected",
        execute:
          "Install optional evaluation dependencies and pinned weights, then --execute",
      }),
    );
    return;
  }
  if (args.length !== 1 || args[0] !== "--execute")
    throw Error("Invalid arguments");
  const cache = resolve(".runtime/embedding-eval");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const runtime = await embeddingRuntime({
    cache,
    credential: "synthetic-local-embedding-evaluation",
    publicStats: true,
  });
  await writeFile(
    resolve(cache, "server.json"),
    JSON.stringify({
      pid: process.pid,
      endpoint: runtime.endpoint,
      model: embeddingModel,
      dimensions: 512,
    }) + "\n",
    { mode: 0o600 },
  );
  console.log(
    "Pinned local embedding server ready; synthetic evaluation only.",
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(
      signal,
      () =>
        void runtime.close().then(() => {
          process.exitCode = 0;
        }),
    );
}
main().catch(() => {
  console.error(
    "Local embedding evaluation server unavailable; check optional dependencies and pinned local weights. No remote model fallback.",
  );
  process.exitCode = 1;
});
