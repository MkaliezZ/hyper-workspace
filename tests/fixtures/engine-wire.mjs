// Deterministic protocol fixture, NOT either engine or an AI model.
import { createInterface } from "node:readline";
const mode = process.argv[2];
const send = (frame) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const final = JSON.stringify({ text: "protocol-fixture-result", actions: [] });
let sessionId = "",
  ready = false;
if (mode.startsWith("hermes")) {
  ready = true;
  notify("event", { type: "gateway.ready", session_id: "", payload: {} });
}
for await (const raw of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(raw);
  if (!method) continue;
  if (mode === "dsh") {
    if (method === "initialize") {
      if (!params.provider || !params.model)
        throw new Error("missing model route");
      reply(id, {
        serverInfo: {
          name: "deepseek-harness-sdk-runtime",
          version: "0.0.1",
        },
      });
    } else if (method === "session/prompt") {
      if (!Array.isArray(params.contentBlocks) || params.content !== undefined)
        throw new Error("wrong prompt shape");
      sessionId = params.sessionId;
      reply(id, { messageId: "fixture-enqueue-receipt" });
    } else if (method === "session/wait") {
      notify("session.event", {
        sessionId: "another-session",
        event: {
          type: "assistant/message",
          data: { message: { content: [{ type: "text", text: "wrong" }] } },
        },
      });
      notify("session.event", {
        sessionId,
        event: {
          type: "assistant/message",
          data: { message: { content: [{ type: "text", text: final }] } },
        },
      });
      notify("session.event", {
        sessionId,
        event: { type: "turn/end", data: { reason: { kind: "completed" } } },
      });
      reply(id, {});
    }
  } else {
    if (method === "client.capabilities") {
      if (!ready || !params.server_requests)
        throw new Error("missing capabilities");
      reply(id, { ok: true });
    } else if (method === "session.create") {
      if (!params.cwd || !params.close_on_disconnect)
        throw new Error("missing isolation metadata");
      sessionId = "hermes-wire-fixture";
      reply(id, { session_id: sessionId });
    } else if (method === "prompt.submit") {
      if (typeof params.text !== "string" || params.prompt !== undefined)
        throw new Error("wrong prompt shape");
      reply(id, { status: "streaming" });
      notify("event", {
        type: "message.complete",
        session_id: "another-session",
        payload: { text: "wrong", status: "complete" },
      });
      setTimeout(
        () =>
          notify("event", {
            type: "message.complete",
            session_id: sessionId,
            payload: {
              text: final,
              status: mode === "hermes-error" ? "error" : "complete",
            },
          }),
        30,
      );
    }
  }
}
