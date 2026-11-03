import { test, expect } from "@playwright/test";

test("Run details fetch authorized receipts on demand, fold process records, fit mobile and clear after sign-out", async ({
  page,
}) => {
  let eventReads = 0;
  page.on("response", (response) => {
    if (
      response.ok() &&
      /\/api\/runs\/[^/]+\/history(?:\?|$)/.test(response.url())
    )
      eventReads++;
  });
  await page.request.post("/api/auth/demo", { data: {} });
  await page.goto("/");
  await page.getByRole("button", { name: "发起任务", exact: true }).click();
  await page
    .getByRole("combobox", { name: "执行服务", exact: true })
    .selectOption("fixture");
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect(page.locator(".run-strip")).toContainText("已完成", {
    timeout: 20000,
  });
  expect(eventReads).toBe(0);
  // A real saved Run must remain reachable after local React state is gone.
  await page.reload();
  await page.getByRole("tab", { name: "执行记录", exact: true }).click();
  const history = page.getByRole("region", {
    name: "本人执行记录",
    exact: true,
  });
  await history.locator("li button").first().click();
  const dialog = page.getByRole("dialog", { name: "执行详情", exact: true });
  await expect(dialog.locator(".run-receipts li").first()).toBeVisible();
  expect(eventReads).toBe(1);
  await expect(dialog).toContainText("演示执行 · 已完成");
  await expect(dialog.locator(".run-detail-events ol")).not.toBeVisible();
  await page.screenshot({
    path: "/tmp/hyper-run-details-desktop.png",
    fullPage: false,
  });
  await dialog.locator("summary").click();
  await expect(
    dialog
      .locator(".run-detail-events")
      .getByRole("listitem")
      .filter({ hasText: "执行完成" }),
  ).toBeVisible();
  await expect(dialog).toContainText("执行编号：");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(false);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: "/tmp/hyper-run-details-mobile.png",
    fullPage: false,
  });
  await page.context().clearCookies();
  await dialog.getByRole("button", { name: "刷新详情", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.locator(".run-receipts")).toHaveCount(0);
  await expect(dialog.locator(".run-detail-events")).toHaveCount(0);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("Protocol follow-up and method-management receipts show their actual operation and state", async ({
  page,
}) => {
  await page.request.post("/api/auth/demo", { data: {} });
  const id = "74000000-0000-4000-8000-000000000002";
  await page.route("**/api/runs", (route) =>
    route.fulfill({ json: { id, state: "queued" } }),
  );
  await page.route("**/api/runs/" + id, (route) =>
    route.fulfill({
      json: {
        id,
        state: "succeeded",
        engine: "fixture",
        error: null,
        result: {
          receipts: [
            {
              tool: "follow_up.check",
              notify: false,
              summary: "合成协议：没有变化",
            },
            {
              tool: "method.manage",
              operation: "withdraw",
              state: "withdrawn",
              version: 1,
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/runs/" + id + "/history", (route) =>
    route.fulfill({ json: { events: [], after: 0, hasMore: false } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "发起任务", exact: true }).click();
  await page
    .getByRole("combobox", { name: "执行服务", exact: true })
    .selectOption("fixture");
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect(page.locator(".run-strip")).toContainText("已完成");
  await page.getByRole("button", { name: "查看执行详情", exact: true }).click();
  const receipts = page
    .getByRole("dialog", { name: "执行详情", exact: true })
    .locator(".run-receipts");
  await expect(
    receipts.getByText("核对项目变化", { exact: true }),
  ).toBeVisible();
  await expect(receipts).toContainText("本次保持静默，没有发送提醒。");
  await expect(receipts.getByText("撤回方法", { exact: true })).toBeVisible();
  await expect(receipts).toContainText("状态：已撤回");
  await expect(receipts).not.toContainText("业务操作");
});
