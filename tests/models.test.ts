import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  complete,
  embed,
  type ModelConnection,
} from "../apps/api/src/core/models.js";

test("Provider HTTP calls keep credentials per request, reject redirects and hide upstream errors", async () => {
  const received: { path: string; auth?: string; key?: string; body: any }[] =
    [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    received.push({
      path: req.url!,
      auth: req.headers.authorization,
      key: req.headers["x-api-key"] as string | undefined,
      body,
    });
    res.setHeader("Content-Type", "application/json");
    if (body.model === "redirect") {
      res.writeHead(307, { Location: "/stolen" });
      res.end();
      return;
    }
    if (body.model === "error") {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "secret-value-from-upstream" }));
      return;
    }
    if (req.url?.endsWith("/embeddings"))
      res.end(
        JSON.stringify({
          data:
            body.model === "bad-vector"
              ? [{ index: 0, embedding: [0, 0] }]
              : [
                  { index: 1, embedding: [0, 1] },
                  { index: 0, embedding: [1, 0] },
                ],
        }),
      );
    else
      res.end(
        JSON.stringify(
          req.url?.endsWith("/messages")
            ? { content: [{ type: "text", text: "OK" }] }
            : { choices: [{ message: { content: "OK" } }] },
        ),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connection: ModelConnection = {
    id: "test",
    provider: "openai-compatible",
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    model: "test-model",
    apiKey: "employee-a-only",
    purpose: "chat",
  };
  try {
    await Promise.all([
      complete(connection, "a"),
      complete(
        { ...connection, provider: "anthropic", apiKey: "employee-b-only" },
        "b",
      ),
    ]);
    assert.equal(
      received.find((r) => r.path.endsWith("/chat/completions"))?.auth,
      "Bearer employee-a-only",
    );
    const anthropic = received.find((r) => r.path.endsWith("/messages"));
    assert.equal(anthropic?.key, "employee-b-only");
    assert.equal(anthropic?.auth, undefined);
    await assert.rejects(
      complete({ ...connection, model: "error" }, "a"),
      (e) =>
        e instanceof Error &&
        e.message.includes("401") &&
        !e.message.includes("secret-value"),
    );
    await assert.rejects(complete({ ...connection, model: "redirect" }, "a"));
    assert.equal(
      received.some((r) => r.path === "/stolen"),
      false,
    );
    assert.deepEqual(
      await embed({ ...connection, purpose: "embedding" }, ["one", "two"]),
      [
        [1, 0],
        [0, 1],
      ],
    );
    await assert.rejects(
      embed({ ...connection, purpose: "embedding", model: "bad-vector" }, [
        "one",
      ]),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
