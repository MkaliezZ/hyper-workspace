import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { Database } from "../../apps/api/src/db/database.js";
import { Vault } from "../../apps/api/src/core/credentials.js";
const source = process.env.NEXTCLOUD_URL!,
  password = process.env.NC_TEST_PASSWORD!,
  origin = "http://127.0.0.1:5173";
const db = new Database(process.env.TEST_DATABASE_URL);
if (!source || !password || !process.env.TEST_DATABASE_URL?.endsWith("_test"))
  throw new Error(
    "Only an isolated synthetic Nextcloud test environment is allowed.",
  );
test.afterAll(async () => {
  await db.close();
});
async function grant(popup: Page, uid: string) {
  await popup.getByRole("link", { name: "Log in", exact: true }).click();
  await popup.locator('input[name="user"]').fill(uid);
  await popup.locator('input[name="password"]').fill(password);
  await popup
    .locator('form[name="login"]')
    .locator('button[type="submit"]')
    .click();
  await popup
    .getByRole("button", { name: "Grant access", exact: true })
    .click();
}
async function login(browser: Browser, uid: string) {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  await page.goto(origin);
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "使用企业账号登录" }).click();
  await grant(await popup, uid);
  return { context, page };
}
async function group(method: "POST" | "DELETE", uid: string) {
  const response = await fetch(
    source + "/ocs/v2.php/cloud/users/" + uid + "/groups?format=json",
    {
      method,
      headers: {
        Authorization:
          "Basic " + Buffer.from("nc-admin:" + password).toString("base64"),
        "OCS-APIRequest": "true",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ groupid: "hyper-members" }),
      redirect: "error",
    },
  );
  expect(response.status).toBe(200);
  expect((await response.json()).ocs.meta.statuscode).toBe(200);
}
async function view(context: BrowserContext) {
  return context.request.get(origin + "/api/workspace");
}

test("Real Nextcloud Login Flow v2 returns a source-backed product session and persists a discussion", async ({
  browser,
}) => {
  const { context, page } = await login(browser, "employee-one");
  try {
    await expect(
      page.getByRole("heading", { name: "团队讨论", exact: true }),
    ).toBeVisible();
    const response = await view(context),
      workspace = await response.json();
    expect(response.status()).toBe(200);
    expect(workspace.user.role).toBe("admin");
    expect(workspace.user.demo).toBe(false);
    expect(workspace.user.identityCredentialId).toBeUndefined();
    const cookies = await context.cookies(origin),
      session = cookies.find((c) => c.name === "hyper_session")!;
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toBe("Strict");
    expect(await page.evaluate(() => document.cookie)).not.toContain(
      "hyper_session",
    );
    const message = "真实 Nextcloud 测试账号授权后的产品讨论";
    await page.getByRole("textbox", { name: "讨论内容" }).fill(message);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    const sourceIdentity = (
      await db.pool.query(
        "SELECT remote_uid FROM cw_external_identities WHERE user_id=$1",
        [workspace.user.id],
      )
    ).rows[0];
    expect(sourceIdentity.remote_uid).toBe("employee-one");
  } finally {
    await context.close();
  }
});
test("Real per-device app token revocation and source group removal constrain subsequent product requests", async ({
  browser,
}) => {
  const one = await login(browser, "employee-two"),
    two = await login(browser, "employee-two");
  try {
    await expect(
      one.page.getByRole("heading", { name: "团队讨论", exact: true }),
    ).toBeVisible();
    await expect(
      two.page.getByRole("heading", { name: "团队讨论", exact: true }),
    ).toBeVisible();
    const first = await (await view(one.context)).json(),
      second = await (await view(two.context)).json();
    expect(first.user.id).toBe(second.user.id);
    expect(first.user.role).toBe("member");
    const sessionCookie = (await one.context.cookies(origin)).find(
      (c) => c.name === "hyper_session",
    )!.value;
    const { digest } = await import("../../apps/api/src/core/credentials.js");
    const credential = (
      await db.pool.query(
        "SELECT c.login_name,c.credential_enc FROM cw_sessions s JOIN cw_identity_credentials c ON c.id=s.identity_credential_id WHERE s.token_hash=$1",
        [digest(sessionCookie)],
      )
    ).rows[0];
    const token = new Vault().decrypt(credential.credential_enc);
    const revoked = await fetch(
      source + "/ocs/v2.php/core/apppassword?format=json",
      {
        method: "DELETE",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(credential.login_name + ":" + token).toString("base64"),
          "OCS-APIRequest": "true",
        },
        redirect: "error",
      },
    );
    expect(revoked.status).toBe(200);
    expect((await view(one.context)).status()).toBe(401);
    expect((await view(two.context)).status()).toBe(200);
    await group("DELETE", "employee-two");
    expect((await view(two.context)).status()).toBe(403);
    await group("POST", "employee-two");
    const again = await login(browser, "employee-two");
    try {
      await expect(again.page.getByRole("alert")).toContainText(
        "产品权限已撤销",
      );
    } finally {
      await again.context.close();
    }
  } finally {
    await one.context.close();
    await two.context.close();
  }
});
test("Upstream admin status does not grant product admin; flow endpoints enforce Origin and browser binding", async ({
  browser,
  request,
}) => {
  const { context, page } = await login(browser, "nc-admin");
  try {
    await expect(
      page.getByRole("heading", { name: "团队讨论", exact: true }),
    ).toBeVisible();
    expect((await (await view(context)).json()).user.role).toBe("member");
    const wrong = await request.post(origin + "/api/auth/nextcloud/start", {
      headers: { Origin: "https://attacker.invalid" },
      data: {},
    });
    expect(wrong.status()).toBe(403);
    const start = await context.request.post(
      origin + "/api/auth/nextcloud/start",
      { headers: { Origin: origin }, data: {} },
    );
    const flow = await start.json();
    expect(start.status()).toBe(201);
    expect(Object.keys(flow).sort()).toEqual([
      "expiresAt",
      "flowId",
      "loginUrl",
    ]);
    const stolen = await request.post(origin + "/api/auth/nextcloud/poll", {
      headers: { Origin: origin },
      data: { flowId: flow.flowId },
    });
    expect(stolen.status()).toBe(403);
    expect(
      (
        await context.request.post(origin + "/api/auth/nextcloud/cancel", {
          headers: { Origin: origin },
          data: { flowId: flow.flowId },
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await context.request.post(origin + "/api/auth/nextcloud/poll", {
          headers: { Origin: origin },
          data: { flowId: flow.flowId },
        })
      ).status(),
    ).toBe(410);
    // Cancelling a separate pending flow must preserve the existing device session.
    expect((await view(context)).status()).toBe(200);
    expect(
      (
        await context.request.post(origin + "/api/auth/logout", {
          headers: { Origin: origin },
          data: {},
        })
      ).status(),
    ).toBe(201);
    expect((await view(context)).status()).toBe(401);
  } finally {
    await context.close();
  }
});
