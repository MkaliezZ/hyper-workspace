import { createServer } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const embeddingModel = "local-bge-small-zh-v1.5-q8";
export const inputCharacters = 400;
export async function verifyEmbeddingModel(cache) {
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
  return lock;
}
export async function embeddingRuntime({
  cache,
  credential,
  serviceId = "evaluation",
  port = 0,
  publicStats = false,
}) {
  await verifyEmbeddingModel(cache);
  const { pipeline, env } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  env.backends.onnx.wasm.numThreads = 1;
  const extractor = await pipeline(
    "feature-extraction",
    resolve(cache, "model"),
    {
      dtype: "q8",
      device: "cpu",
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    },
  );
  const expected = Buffer.from("Bearer " + credential);
  let calls = 0,
    texts = 0,
    pending = 0;
  let queue = Promise.resolve();
  const authorized = (req) => {
    const actual = Buffer.from(req.headers.authorization ?? "");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  };
  const reply = (res, code, data) => {
    if (!res.destroyed) {
      res.writeHead(code, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    }
  };
  const server = createServer((req, res) => {
    void handle(req, res).catch(() =>
      reply(res, 500, { error: "Local embedding request failed" }),
    );
  });
  async function handle(req, res) {
    if (req.method === "GET" && req.url === "/health")
      return reply(res, 200, {
        status: "ok",
        serviceId,
        model: embeddingModel,
        dimensions: 512,
        inputCharacters,
      });
    if (
      req.method === "GET" &&
      req.url === "/stats" &&
      (publicStats || authorized(req))
    )
      return reply(res, 200, {
        calls,
        texts,
        model: embeddingModel,
        dimensions: 512,
      });
    if (!authorized(req))
      return reply(res, 401, { error: "Authentication required" });
    if (req.method === "GET" && req.url === "/v1/models")
      return reply(res, 200, {
        object: "list",
        data: [
          {
            id: embeddingModel,
            object: "model",
            input_characters: inputCharacters,
            dimensions: 512,
          },
        ],
      });
    if (req.method !== "POST" || req.url !== "/v1/embeddings")
      return reply(res, 404, { error: "Unsupported endpoint" });
    if (pending >= 8)
      return reply(res, 429, {
        error: "Local model busy; retry explicitly later",
      });
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 200000)
        return reply(res, 413, { error: "Request too large" });
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(res, 400, { error: "Invalid request" });
    }
    if (
      body.model !== embeddingModel ||
      !Array.isArray(body.input) ||
      !body.input.length ||
      body.input.length > 32 ||
      body.input.some(
        (s) => typeof s !== "string" || !s.trim() || s.length > inputCharacters,
      )
    )
      return reply(res, 400, {
        error:
          "Inputs require 1-32 non-empty texts, each at most 400 characters; split documents without truncation",
      });
    if (pending >= 8)
      return reply(res, 429, {
        error: "Local model busy; retry explicitly later",
      });
    pending++;
    const execute = async () => {
      if (res.destroyed) return;
      const encoded = await extractor.tokenizer(body.input, {
        padding: true,
        truncation: false,
      });
      if (encoded.input_ids.dims[1] > 512)
        return reply(res, 400, {
          error: "Input exceeds model token capacity; no truncation",
        });
      const promptTokens = Array.from(encoded.attention_mask.data).reduce(
        (n, value) => n + Number(value),
        0,
      );
      const result = await extractor(body.input, {
        pooling: "cls",
        normalize: true,
        truncation: false,
      });
      calls++;
      texts += body.input.length;
      reply(res, 200, {
        object: "list",
        model: embeddingModel,
        usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
        data: result.tolist().map((embedding, index) => ({
          object: "embedding",
          index,
          embedding,
        })),
      });
    };
    const job = queue.then(execute);
    queue = job.catch(() => {});
    try {
      await job;
    } finally {
      pending--;
    }
  }
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", ok);
  });
  return {
    server,
    endpoint: "http://127.0.0.1:" + server.address().port + "/v1",
    async close() {
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
      await queue;
      await extractor.dispose();
    },
  };
}
