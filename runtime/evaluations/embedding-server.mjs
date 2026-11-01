import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(
      JSON.stringify({
        mode: "preflight",
        requestsSent: 0,
        model: "local-bge-small-zh-v1.5-q8",
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
  const lock = JSON.parse(
    await readFile(
      new URL("./embedding-model.lock.json", import.meta.url),
      "utf8",
    ),
  );
  for (const file of lock.files) {
    const data = await readFile(resolve(cache, "model", file.path));
    if (
      data.length !== file.bytes ||
      createHash("sha256").update(data).digest("hex") !== file.sha256
    )
      throw Error("Pinned model integrity mismatch");
  }
  const { pipeline, env } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  env.backends.onnx.wasm.numThreads = 1;
  const path = resolve(cache, "model");
  const extractor = await pipeline("feature-extraction", path, {
    dtype: "q8",
    device: "cpu",
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
  });
  let calls = 0,
    texts = 0;
  const model = "local-bge-small-zh-v1.5-q8";
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/stats") {
      res.end(JSON.stringify({ calls, texts, model, dimensions: 512 }));
      return;
    }
    if (
      req.method !== "POST" ||
      req.url !== "/v1/embeddings" ||
      req.headers.authorization !==
        "Bearer synthetic-local-embedding-evaluation"
    ) {
      res.writeHead(403);
      res.end("{}");
      return;
    }
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 200000) {
        res.writeHead(413);
        res.end("{}");
        return;
      }
    }
    try {
      const body = JSON.parse(raw);
      if (
        body.model !== model ||
        !Array.isArray(body.input) ||
        body.input.length > 32 ||
        body.input.some((s) => typeof s !== "string" || s.length > 400)
      ) {
        res.writeHead(400);
        res.end(
          JSON.stringify({
            error:
              "Evaluation is limited to short synthetic text; do not silently truncate long documents.",
          }),
        );
        return;
      }
      const encoded = await extractor.tokenizer(body.input, {
        padding: true,
        truncation: false,
      });
      if (encoded.input_ids.dims[1] > 512) {
        res.writeHead(400);
        res.end("{}");
        return;
      }
      const promptTokens = Array.from(encoded.attention_mask.data).reduce(
        (n, x) => n + Number(x),
        0,
      );
      calls++;
      texts += body.input.length;
      const result = await extractor(body.input, {
        pooling: "cls",
        normalize: true,
        truncation: false,
      });
      res.end(
        JSON.stringify({
          model,
          object: "list",
          usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
          data: result
            .tolist()
            .map((embedding, index) => ({
              object: "embedding",
              index,
              embedding,
            })),
        }),
      );
    } catch {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Local embedding inference failed" }));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await writeFile(
    resolve(cache, "server.json"),
    JSON.stringify({
      pid: process.pid,
      endpoint: "http://127.0.0.1:" + server.address().port + "/v1",
      model,
      dimensions: 512,
    }) + "\n",
    { mode: 0o600 },
  );
  console.log(
    "Pinned local embedding server ready; synthetic evaluation only.",
  );
  function stop() {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
main().catch(() => {
  console.error(
    "Local embedding evaluation server unavailable; check optional dependencies and pinned local weights. No remote model fallback.",
  );
  process.exitCode = 1;
});
