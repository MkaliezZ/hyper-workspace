import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { source, password, origin, login } from "./helpers";
import { modelFixture } from "../runtime/business-contract";
test("Real Talk history search reaches old messages with exact live source readback, both engines and current membership denial", async ({
  browser,
}) => {
  test.setTimeout(240000);
  const alice = await login(browser, "search-alice"),
    bob = await login(browser, "search-bob"),
    headers = { Origin: origin };
  async function talk(
    uid: string,
    path: string,
    method = "GET",
    body?: Record<string, string>,
  ) {
    const r = await fetch(source + "/ocs/v2.php/apps/spreed/api/" + path, {
      method,
      headers: {
        Authorization:
          "Basic " + Buffer.from(uid + ":" + password).toString("base64"),
        "OCS-APIRequest": "true",
        Accept: "application/json",
        ...(body
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body: body ? new URLSearchParams(body) : undefined,
      redirect: "error",
    });
    expect(r.ok).toBeTruthy();
    return (await r.json()).ocs.data;
  }
  const room = await talk("search-alice", "v4/room", "POST", {
    roomType: "2",
    roomName: "Synthetic history " + randomUUID(),
  });
  const key = "synthetic-search-" + randomUUID(),
    model = modelFixture([key], (body) => {
      expect(JSON.stringify(body.messages)).not.toContain("历史搜索私密关键词");
    });
  await new Promise<void>((resolve) =>
    model.server.listen(0, "127.0.0.1", resolve),
  );
  try {
    await talk(
      "search-alice",
      "v4/room/" + room.token + "/participants",
      "POST",
      { newParticipant: "search-bob", source: "users" },
    );
    const target = await talk("search-alice", "v1/chat/" + room.token, "POST", {
      message: "历史搜索私密关键词：旧讨论决定由设施组维护北侧阀门。",
    });
    for (let i = 0; i < 102; i++)
      await talk("search-alice", "v1/chat/" + room.token, "POST", {
        message: "Recent synthetic unrelated message " + i,
      });
    const latest = await (
      await alice.context.request.get(
        origin + `/api/talk/rooms/${room.token}/messages`,
      )
    ).json();
    expect(
      latest.messages.some((m: any) => String(m.id) === String(target.id)),
    ).toBe(false);
    const management = await (
      await alice.context.request.get(
        origin + `/api/talk/management?roomId=${room.token}`,
      )
    ).json();
    const endpoint =
      origin +
      `/api/talk/rooms/${room.token}/search?` +
      new URLSearchParams({
        q: "历史搜索私密关键词",
        bindingRef: management.bindingRef,
      });
    const response = await alice.context.request.get(endpoint);
    expect(response.status()).toBe(200);
    const page = await response.json();
    expect(page.scope).toBe("source-history");
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].id).toBe(String(target.id));
    expect(page.messages[0].content).toContain("北侧阀门");
    const connection = await alice.context.request.post(
      origin + "/api/models",
      {
        headers,
        data: {
          name: "Synthetic source history model",
          provider: "openai-compatible",
          endpoint: `http://127.0.0.1:${(model.server.address() as any).port}/v1`,
          model: "native-test-model",
          purpose: "chat",
          scope: "personal",
          apiKey: key,
        },
      },
    );
    expect(connection.status()).toBe(201);
    const profile = await connection.json();
    for (const engine of ["dsh", "hermes"]) {
      const started = await alice.context.request.post(
        origin + "/api/talk/management/runs",
        {
          headers,
          data: {
            engine,
            modelProfileId: profile.id,
            idempotencyKey: randomUUID(),
            plan: {
              operation: "read",
              bindingRef: management.bindingRef,
              roomId: room.token,
              search: { query: "历史搜索私密关键词" },
            },
          },
        },
      );
      expect(started.status()).toBe(201);
      const run = await started.json();
      await expect
        .poll(
          async () => {
            const r = await alice.context.request.get(
              origin + "/api/runs/" + run.id,
            );
            return r.ok() ? (await r.json()).state : "denied";
          },
          { timeout: 60000 },
        )
        .toBe("succeeded");
      const actual = await (
        await alice.context.request.get(origin + "/api/runs/" + run.id)
      ).json();
      expect(actual.result.receipts[0]).toMatchObject({
        search: true,
        resultCount: 1,
        scope: "source-history",
      });
      expect(JSON.stringify(actual.result)).not.toContain("历史搜索私密关键词");
    }
    expect(model.calls()).toBe(2);
    const afterSearch = await (
      await alice.context.request.get(
        origin + `/api/talk/management?roomId=${room.token}`,
      )
    ).json();
    expect(afterSearch.rooms[0].lastReadMessage).toBe(
      management.rooms[0].lastReadMessage,
    );
    expect(afterSearch.rooms[0].notificationLevel).toBe(
      management.rooms[0].notificationLevel,
    );
    const bobManagement = await (
      await bob.context.request.get(
        origin + `/api/talk/management?roomId=${room.token}`,
      )
    ).json();
    const bobEndpoint =
      origin +
      `/api/talk/rooms/${room.token}/search?` +
      new URLSearchParams({
        q: "历史搜索私密关键词",
        bindingRef: bobManagement.bindingRef,
      });
    expect((await bob.context.request.get(bobEndpoint)).status()).toBe(200);
    const bobAfter = await (
      await bob.context.request.get(
        origin + `/api/talk/management?roomId=${room.token}`,
      )
    ).json();
    expect(bobAfter.rooms[0].lastReadMessage).toBe(
      bobManagement.rooms[0].lastReadMessage,
    );
    await talk(
      "search-bob",
      "v4/room/" + room.token + "/participants/self",
      "DELETE",
    );
    const denied = await bob.context.request.get(bobEndpoint);
    expect([403, 404]).toContain(denied.status());
    expect(await denied.text()).not.toContain("北侧阀门");
  } finally {
    model.server.closeAllConnections();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
    await alice.context.close();
    await bob.context.close();
  }
});
