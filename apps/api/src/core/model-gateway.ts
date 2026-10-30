import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { once } from "node:events";
import type { ModelConnection } from "./models.js";
import {
  providerUsage,
  unknownUsage,
  type ProviderUsage,
} from "./model-usage.js";

/** Per-Run loopback gateway. The child receives only this short-lived capability, never the provider Key. */
export class RunModelGateway {
  private server = createServer((req, res) => {
    const task = this.handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end('{"error":"Model gateway request failed"}');
      } else res.destroy();
    });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  });
  private key = randomBytes(32).toString("base64url");
  private pending = new Set<Promise<void>>();
  private controllers = new Set<AbortController>();
  constructor(
    private connection: ModelConnection,
    private runId: string,
    private signal: AbortSignal,
    private authorize: () => Promise<{ maxOutputTokens: number }>,
  ) {}
  async start(): Promise<ModelConnection> {
    this.signal.throwIfAborted();
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Model gateway did not bind.");
    return {
      id: this.connection.id,
      provider: this.connection.provider,
      model: this.connection.model,
      purpose: "chat",
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      apiKey: this.key,
    };
  }
  private authenticated(req: IncomingMessage) {
    const credential =
      req.headers.authorization?.replace(/^Bearer /, "") ??
      req.headers["x-api-key"];
    if (typeof credential !== "string") return false;
    const actual = Buffer.from(credential),
      expected = Buffer.from(this.key);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (!this.authenticated(req)) {
      res.writeHead(401);
      res.end();
      return;
    }
    const anthropic = this.connection.provider === "anthropic",
      path = anthropic ? "/messages" : "/chat/completions";
    if (
      req.method === "GET" &&
      (req.url === "/v1/models" ||
        req.url === `/v1/models/${encodeURIComponent(this.connection.model)}`)
    ) {
      this.signal.throwIfAborted();
      await this.authorize();
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: this.connection.model,
              object: "model",
              owned_by: "configured-provider",
            },
          ],
        }),
      );
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1" + path) {
      res.writeHead(404);
      res.end();
      return;
    }
    const pieces: Buffer[] = [];
    let size = 0;
    for await (const piece of req) {
      size += piece.length;
      if (size > 1024 * 1024) {
        res.writeHead(413);
        res.end();
        return;
      }
      pieces.push(piece);
    }
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(pieces).toString("utf8"));
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      body.model !== this.connection.model ||
      !Array.isArray(body.messages) ||
      (body.tools !== undefined &&
        (!Array.isArray(body.tools) || body.tools.length > 0)) ||
      (body.functions !== undefined &&
        (!Array.isArray(body.functions) || body.functions.length > 0)) ||
      (body.n !== undefined && body.n !== 1)
    ) {
      res.writeHead(400);
      res.end();
      return;
    }
    this.signal.throwIfAborted();
    const limits = await this.authorize();
    const capField =
      body.max_completion_tokens !== undefined && body.max_tokens === undefined
        ? "max_completion_tokens"
        : "max_tokens";
    const requested = body[capField] ?? limits.maxOutputTokens;
    if (!Number.isSafeInteger(requested) || requested < 1) {
      res.writeHead(400);
      res.end();
      return;
    }
    body[capField] = Math.min(requested, limits.maxOutputTokens);
    if (
      body.max_tokens !== undefined &&
      body.max_completion_tokens !== undefined
    ) {
      if (
        !Number.isSafeInteger(body.max_completion_tokens) ||
        body.max_completion_tokens < 1
      ) {
        res.writeHead(400);
        res.end();
        return;
      }
      body.max_completion_tokens = Math.min(
        body.max_completion_tokens,
        limits.maxOutputTokens,
      );
    }
    const accounting = this.connection.accounting;
    if (!accounting) throw new Error("Missing model request accounting.");
    const id = await accounting.begin("run", this.runId);
    let usage = unknownUsage(),
      transport: "unknown" | "completed" | "rejected" = "unknown",
      status: number | undefined;
    const controller = new AbortController();
    this.controllers.add(controller);
    let collector: UsageCollector | undefined;
    let settled = false;
    const closed = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", closed);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (anthropic) {
        headers["anthropic-version"] = "2023-06-01";
        if (this.connection.apiKey)
          headers["x-api-key"] = this.connection.apiKey;
      } else if (this.connection.apiKey)
        headers.Authorization = "Bearer " + this.connection.apiKey;
      const response = await fetch(
        this.connection.endpoint.replace(/\/+$/, "") + path,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.any([
            this.signal,
            controller.signal,
            AbortSignal.timeout(180000),
          ]),
        },
      );
      status = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        transport = "rejected";
        res.writeHead(response.status, { "Content-Type": "application/json" });
        res.end('{"error":"Configured model service rejected the request"}');
        return;
      }
      if (!response.body) throw new Error("Missing model body.");
      const streaming = response.headers
        .get("content-type")
        ?.includes("text/event-stream");
      res.writeHead(response.status, {
        "Content-Type": streaming ? "text/event-stream" : "application/json",
        "Cache-Control": "no-store",
      });
      collector = new UsageCollector(this.connection.provider, !!streaming);
      let received = 0;
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > 4 * 1024 * 1024)
          throw new Error("Model response exceeded bounded transport.");
        collector.push(chunk);
        if (!res.write(Buffer.from(chunk)))
          await once(res, "drain", {
            signal: AbortSignal.any([this.signal, controller.signal]),
          });
      }
      usage = collector.finish();
      transport = collector.complete ? "completed" : "unknown";
      // Settle before telling the child that the HTTP response has ended.
      await accounting.settle(id, usage, transport, status);
      settled = true;
      res.end();
    } finally {
      res.off("close", closed);
      this.controllers.delete(controller);
      if (transport === "unknown" && collector) usage = collector.finish(true);
      // A crash/abort/rejection still leaves an honest row, never silently a free call.
      if (!settled) await accounting.settle(id, usage, transport, status);
    }
  }
  async close() {
    for (const c of this.controllers) c.abort();
    this.server.closeAllConnections();
    if (this.server.listening)
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await Promise.allSettled([...this.pending]);
  }
}
/** Bounded transient parsing. Neither raw content nor arbitrary upstream usage fields leave this collector. */
export class UsageCollector {
  complete = false;
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private json = "";
  private raw: any;
  private invalid = false;
  private failed = false;
  private result?: ProviderUsage;
  constructor(
    private provider: string,
    private streaming: boolean,
  ) {}
  push(bytes: Uint8Array) {
    const text = this.decoder.write(Buffer.from(bytes));
    if (!this.streaming) {
      this.json += text;
      if (this.json.length > 2 * 1024 * 1024) {
        this.json = "";
        this.invalid = true;
      }
      return;
    }
    this.pending += text;
    let index: number;
    while ((index = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, index).trim();
      this.pending = this.pending.slice(index + 1);
      this.line(line);
    }
    if (this.pending.length > 1024 * 1024) {
      this.pending = "";
      this.invalid = true;
    }
  }
  private line(line: string) {
    if (!line.startsWith("data:")) return;
    const value = line.slice(5).trim();
    if (value === "[DONE]") {
      this.complete = true;
      return;
    }
    let event: any;
    try {
      event = JSON.parse(value);
    } catch {
      this.invalid = true;
      return;
    }
    if (event?.type === "error" || event?.error) this.failed = true;
    if (this.provider === "anthropic") {
      if (event.type === "message_stop") this.complete = true;
      const usage =
        event.type === "message_start"
          ? event.message?.usage
          : event.type === "message_delta"
            ? event.usage
            : undefined;
      if (usage && typeof usage === "object")
        this.raw = { ...this.raw, ...usage }; // cumulative counters, not deltas
    } else if (event?.usage !== undefined && event.usage !== null)
      this.raw = event.usage;
  }
  finish(interrupted = false): ProviderUsage {
    if (this.result) return this.result;
    const tail = this.decoder.end();
    if (this.streaming) {
      this.line((this.pending + tail).trim());
    } else {
      try {
        this.raw = JSON.parse(this.json + tail)?.usage;
        this.complete = true;
      } catch {
        this.invalid = true;
      }
    }
    if (this.failed) this.complete = false;
    let result = providerUsage(this.provider, this.raw);
    if (this.invalid) result = { ...unknownUsage(), status: "invalid" };
    else if ((!this.complete || interrupted) && result.status === "reported")
      result.status = "partial";
    this.result = result;
    return result;
  }
}
