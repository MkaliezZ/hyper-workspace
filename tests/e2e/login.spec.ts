import { test, expect } from "@playwright/test";

test("Enterprise login keeps authorization in the source window and supports a visible poll retry", async ({
  page,
  context,
  request,
}) => {
  // Clearly scoped UI fixture: production Login Flow is checked separately against real Nextcloud.
  await request.post("/api/auth/demo", { data: {} });
  const fixture = await (await request.get("/api/workspace")).json();
  let authenticated = false,
    polls = 0;
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      status: authenticated ? 200 : 401,
      json: authenticated ? fixture : { message: "请登录" },
    }),
  );
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { demoEnabled: false, nextcloudConfigured: true } }),
  );
  await page.route("**/api/auth/nextcloud/start", (route) =>
    route.fulfill({
      json: {
        flowId: "10000000-0000-4000-8000-000000000002",
        loginUrl: "http://127.0.0.1:9876/index.php/login/v2/flow/fixture",
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      },
    }),
  );
  await context.route("http://127.0.0.1:9876/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<p>Source authorization UI protocol fixture</p>",
    }),
  );
  await page.route("**/api/auth/nextcloud/poll", (route) => {
    polls++;
    if (polls === 2)
      return route.fulfill({
        status: 503,
        json: { message: "身份服务暂时不可用，请重试。" },
      });
    if (polls >= 3) authenticated = true;
    return route.fulfill({
      json: { state: authenticated ? "complete" : "pending" },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "使用企业账号登录" }).click();
  await expect(
    page.getByRole("link", { name: "打开企业登录页面" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("暂时不可用");
  await page.getByRole("button", { name: "重试查询" }).click();
  await expect(
    page.getByRole("heading", { name: "产品共创", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "使用企业账号登录" }),
  ).toHaveCount(0);
});

test("Pending enterprise authorization can be cancelled from a narrow screen", async ({
  page,
  context,
}) => {
  let cancelled = false;
  await page.route("**/api/workspace", (route) =>
    route.fulfill({ status: 401, json: { message: "请登录" } }),
  );
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { demoEnabled: false, nextcloudConfigured: true } }),
  );
  await page.route("**/api/auth/nextcloud/start", (route) =>
    route.fulfill({
      json: {
        flowId: "10000000-0000-4000-8000-000000000003",
        loginUrl: "http://127.0.0.1:9876/index.php/login/v2/flow/fixture",
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      },
    }),
  );
  await context.route("http://127.0.0.1:9876/**", (route) =>
    route.fulfill({ body: "Source UI protocol fixture" }),
  );
  await page.route("**/api/auth/nextcloud/poll", (route) =>
    route.fulfill({ json: { state: "pending" } }),
  );
  await page.route("**/api/auth/nextcloud/cancel", (route) => {
    cancelled = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "使用企业账号登录" }).click();
  await expect(page.getByText("等待授权…", { exact: true })).toBeVisible();
  await page.screenshot({ path: ".runtime/login-desktop-review.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "取消登录" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({ path: ".runtime/login-mobile-review.png" });
  await page.getByRole("button", { name: "取消登录" }).click();
  expect(cancelled).toBe(true);
  await expect(
    page.getByRole("button", { name: "使用企业账号登录" }),
  ).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
});
