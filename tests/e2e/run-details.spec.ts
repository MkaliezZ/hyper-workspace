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
  await page.getByRole("button", { name: "查看执行详情", exact: true }).click();
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
