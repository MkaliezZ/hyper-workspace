import { test, expect } from "@playwright/test";
import { randomUUID, randomBytes } from "node:crypto";
import { Database } from "../../apps/api/src/db/database.js";
import { source, password, origin, login } from "./helpers";
const db = new Database(process.env.TEST_DATABASE_URL);
test.afterAll(async () => {
  await db.close();
});
async function talk(
  uid: string,
  path: string,
  method = "GET",
  data?: Record<string, string>,
) {
  const response = await fetch(
    source +
      "/ocs/v2.php/apps/spreed/api/" +
      path +
      (path.includes("?") ? "&" : "?") +
      "format=json",
    {
      method,
      redirect: "error",
      headers: {
        Accept: "application/json",
        "OCS-APIRequest": "true",
        Authorization:
          "Basic " + Buffer.from(uid + ":" + password).toString("base64"),
        ...(data
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body: data ? new URLSearchParams(data) : undefined,
    },
  );
  expect(response.status).toBeLessThan(300);
  const body = await response.json();
  return body.ocs.data;
}
test("Real Talk group messages use employee credentials, read back sends and deny removed members", async ({
  browser,
}) => {
  const room = await talk("talk-alice", "v4/room", "POST", {
    roomType: "2",
    roomName: "Hyper Talk CI Shared",
  });
  await talk("talk-alice", "v4/room/" + room.token + "/participants", "POST", {
    newParticipant: "talk-bob",
    source: "users",
  });
  const initial = "来自真实 Talk 的测试消息";
  await talk("talk-alice", "v1/chat/" + room.token, "POST", {
    message: initial,
    referenceId: randomBytes(32).toString("hex"),
  });
  const alice = await login(browser, "talk-alice"),
    bob = await login(browser, "talk-bob"),
    outside = await login(browser, "talk-outsider");
  try {
    for (const user of [alice, bob, outside]) {
      await expect(
        user.page.getByRole("heading", { name: "团队讨论", exact: true }),
      ).toBeVisible();
      await user.page
        .getByRole("navigation", { name: "工作区导航" })
        .getByRole("button", { name: "企业消息", exact: true })
        .click();
    }
    await alice.page
      .getByRole("button", { name: "Hyper Talk CI Shared", exact: true })
      .click();
    await bob.page
      .getByRole("button", { name: "Hyper Talk CI Shared", exact: true })
      .click();
    await expect(alice.page.getByText(initial, { exact: true })).toBeVisible();
    await expect(bob.page.getByText(initial, { exact: true })).toBeVisible();
    await expect(
      outside.page.getByRole("button", {
        name: "Hyper Talk CI Shared",
        exact: true,
      }),
    ).toHaveCount(0);
    const denied = await outside.context.request.get(
      origin + "/api/talk/rooms/" + room.token + "/messages",
    );
    expect([403, 404]).toContain(denied.status());
    const message = "Hyper 产品发送并回读的真实 Talk 消息";
    await alice.page
      .getByRole("textbox", { name: "企业消息内容" })
      .fill(message);
    await alice.page
      .getByRole("button", { name: "发送消息", exact: true })
      .click();
    await expect(
      alice.page.getByRole("textbox", { name: "企业消息内容" }),
    ).toHaveValue("");
    await expect(bob.page.getByText(message, { exact: true })).toBeVisible();
    const key = randomUUID(),
      body = { content: "Hyper Talk 幂等验证", idempotencyKey: key };
    const [one, two] = await Promise.all([
      alice.context.request.post(
        origin + "/api/talk/rooms/" + room.token + "/messages",
        { headers: { Origin: origin }, data: body },
      ),
      alice.context.request.post(
        origin + "/api/talk/rooms/" + room.token + "/messages",
        { headers: { Origin: origin }, data: body },
      ),
    ]);
    expect(one.status()).toBe(201);
    expect(two.status()).toBe(201);
    const a = await one.json(),
      b = await two.json();
    expect(a.id).toBe(b.id);
    const receipt = await alice.context.request.get(
      origin + "/api/talk/sends/" + a.id,
    );
    expect((await receipt.json()).state).toBe("succeeded");
    const native = await talk(
      "talk-bob",
      "v1/chat/" + room.token + "?lookIntoFuture=0&setReadMarker=0&limit=100",
    );
    expect(native.filter((m: any) => m.message === body.content)).toHaveLength(
      1,
    );
    expect(
      (
        await db.pool.query("SELECT id FROM cw_messages WHERE content=$1", [
          message,
        ])
      ).rowCount,
    ).toBe(0);
    const forged = await alice.context.request.post(
      origin + "/api/talk/rooms/" + room.token + "/messages",
      { headers: { Origin: origin }, data: { ...body, actorId: "talk-bob" } },
    );
    expect(forged.status()).toBe(400);
    const participants = await talk(
        "talk-alice",
        "v4/room/" + room.token + "/participants",
      ),
      participant = participants.find(
        (p: any) => p.actorType === "users" && p.actorId === "talk-bob",
      );
    expect(participant).toBeTruthy();
    await talk("talk-alice", "v4/room/" + room.token + "/attendees", "DELETE", {
      attendeeId: String(participant.attendeeId),
    });
    await expect
      .poll(async () =>
        (
          await bob.context.request.get(
            origin + "/api/talk/rooms/" + room.token + "/messages",
          )
        ).status(),
      )
      .toBe(404);
    await expect(bob.page.getByText(message, { exact: true })).toHaveCount(0);
    expect(
      (
        await alice.context.request.get(
          origin + "/api/talk/rooms/" + room.token + "/messages",
        )
      ).status(),
    ).toBe(200);
    expect(receipt.headers()["cache-control"]).toBe("no-store");
  } finally {
    await alice.context.close();
    await bob.context.close();
    await outside.context.close();
  }
});
test("Real one-to-one Talk messages are available without importing them into product projects", async ({
  browser,
}) => {
  const room = await talk("talk-alice", "v4/room", "POST", {
      roomType: "1",
      invite: "talk-bob",
    }),
    user = await login(browser, "talk-alice");
  try {
    await expect(
      user.page.getByRole("heading", { name: "团队讨论", exact: true }),
    ).toBeVisible();
    const response = await user.context.request.get(origin + "/api/talk/rooms");
    expect(response.status()).toBe(200);
    expect((await response.json()).some((r: any) => r.id === room.token)).toBe(
      true,
    );
    const sent = await user.context.request.post(
      origin + "/api/talk/rooms/" + room.token + "/messages",
      {
        headers: { Origin: origin },
        data: { content: "一对一通信验证", idempotencyKey: randomUUID() },
      },
    );
    expect(sent.status()).toBe(201);
    expect((await sent.json()).state).toBe("succeeded");
    expect(
      (
        await talk(
          "talk-bob",
          "v1/chat/" +
            room.token +
            "?lookIntoFuture=0&setReadMarker=0&limit=100",
        )
      ).some((m: any) => m.message === "一对一通信验证"),
    ).toBe(true);
  } finally {
    await user.context.close();
  }
});
