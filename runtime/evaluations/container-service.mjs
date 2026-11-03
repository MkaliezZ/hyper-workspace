import { resolve } from "node:path";
import { readLocalEmbeddingConfig } from "./local-config.mjs";
import { embeddingRuntime } from "./embedding-runtime.mjs";
async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(
      JSON.stringify({
        mode: "preflight",
        requestsSent: 0,
        execute:
          "--serve with an owned private configuration and pinned model files",
      }),
    );
    return;
  }
  if (args.length !== 1 || args[0] !== "--serve")
    throw Error("Invalid arguments");
  const path = process.env.HYPER_EMBEDDING_CONFIG;
  if (!path) throw Error("Private service configuration is required");
  const config = await readLocalEmbeddingConfig(path);
  if (config.port !== 3116)
    throw Error("Container service configuration must use port 3116");
  const runtime = await embeddingRuntime({
    cache: resolve(".runtime/embedding-eval"),
    credential: config.credential,
    serviceId: config.serviceId,
    port: config.port,
    host: process.env.HYPER_EMBEDDING_BIND_HOST ?? "127.0.0.1",
  });
  console.log("Hyper Workspace optional CPU embedding service ready.");
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void runtime
        .close()
        .then(() => {
          process.exitCode = 0;
        })
        .catch(() => {
          process.exitCode = 1;
        });
    });
}
main().catch(() => {
  console.error(
    "Embedding service unavailable; check private configuration, file ownership and pinned weights.",
  );
  process.exitCode = 1;
});
