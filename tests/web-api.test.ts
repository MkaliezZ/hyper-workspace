import { test } from "node:test";
import assert from "node:assert/strict";
import { api, mutation, ApiError } from "../apps/web/src/api.js";

test("Web API handles empty, malformed and interrupted responses without exposing parser errors or replaying writes", async (t) => {
  let calls = 0,
    response = new Response("", { status: 502 });
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return response;
  });
  const failure = async (action: () => Promise<unknown>, status: number) => {
    await assert.rejects(action, (error: any) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /json|Unexpected|secret proxy/i);
      return true;
    });
  };
  await failure(() => api("/workspace"), 502);
  response = new Response("<html>secret proxy diagnostic</html>", {
    status: 503,
  });
  await failure(() => api("/workspace"), 503);
  response = new Response("", { status: 401 });
  await failure(() => api("/workspace"), 401);
  response = new Response('{"unfinished":', { status: 201 });
  await assert.rejects(
    () => mutation("/runs", { idempotencyKey: "original" }),
    (error: any) => {
      assert.equal(error.status, 502);
      assert.match(error.message, /核对原操作/);
      return true;
    },
  );
  assert.equal(calls, 4, "An uncertain write must never retry itself");
  response = new Response(null, { status: 204 });
  assert.equal(await api("/empty"), undefined);
  response = Response.json({ message: "当前权限已撤销。" }, { status: 403 });
  await assert.rejects(() => api("/workspace"), /当前权限已撤销/);
  response = Response.json({ ok: true });
  assert.deepEqual(await api("/workspace"), { ok: true });
});

test("Network and body interruption keep safe error semantics and deliberate cancellation is preserved", async (t) => {
  const stub = t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("secret proxy diagnostic");
  });
  await assert.rejects(
    () => mutation("/runs", {}),
    (e: any) =>
      e instanceof ApiError && e.status === 503 && /核对原操作/.test(e.message),
  );
  stub.mock.mockImplementation(
    async () =>
      ({
        ok: true,
        status: 200,
        text: async () => {
          throw new TypeError("body terminated");
        },
      }) as Response,
  );
  await assert.rejects(
    () => api("/workspace"),
    (e: any) => e instanceof ApiError && e.status === 502,
  );
  const signal = AbortSignal.abort(),
    abort = new DOMException("Cancelled", "AbortError");
  stub.mock.mockImplementation(async () => {
    throw abort;
  });
  await assert.rejects(
    () => api("/workspace", { signal }),
    (e: unknown) => e === abort,
  );
});
