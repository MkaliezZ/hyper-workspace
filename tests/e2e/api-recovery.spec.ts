import { test, expect } from "@playwright/test";

test("Empty gateway and malformed responses preserve drafts and never display raw JSON parser errors", async ({
  page,
}) => {
  await page.request.post("/api/auth/demo", { data: {} });
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "讨论内容" })).toBeVisible();
  let posts = 0;
  await page.route("**/api/conversations/*/messages", (route) => {
    posts++;
    return route.fulfill({
      status: posts === 1 ? 502 : 201,
      contentType: "text/plain",
      body: posts === 1 ? "" : "<html>secret proxy diagnostic</html>",
    });
  });
  const draft = page.getByRole("textbox", { name: "讨论内容" });
  await draft.fill("合成测试：空响应后保留此草稿，不重复发送");
  for (let i = 1; i <= 2; i++) {
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("核对原操作状态");
    await expect(page.getByRole("alert")).not.toContainText(
      /Unexpected|json|secret proxy/,
    );
    await expect(draft).toHaveValue("合成测试：空响应后保留此草稿，不重复发送");
    expect(posts).toBe(i);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(draft).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test("Run polling recovers from an empty response and clears only its own transient banner", async ({
  page,
}) => {
  await page.request.post("/api/auth/demo", { data: {} });
  const id = "74000000-0000-4000-8000-000000000001";
  let recovered = false,
    polls = 0;
  await page.route("**/api/runs", (route) =>
    route.fulfill({ json: { id, state: "queued" } }),
  );
  await page.route("**/api/runs/" + id, (route) => {
    polls++;
    return recovered
      ? route.fulfill({
          json: {
            id,
            state: "succeeded",
            engine: "fixture",
            result: { text: "合成测试：已恢复并核对运行回执", receipts: [] },
          },
        })
      : route.fulfill({ status: 503, body: "" });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "发起任务", exact: true }).click();
  await page
    .getByRole("combobox", { name: "执行服务", exact: true })
    .selectOption("fixture");
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("服务暂时不可用");
  expect(polls).toBeGreaterThan(0);
  recovered = true;
  await expect(page.locator(".run-strip")).toContainText("已完成");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "API 类型", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/hyper-json-recovery-desktop.png" });
});
