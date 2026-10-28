import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "进入演示工作区" }).click();
  await expect(
    page.getByRole("heading", { name: "产品共创", exact: true }),
  ).toBeVisible();
});
test("discussion, persisted task, artifact revision and labelled fixture execution", async ({
  page,
}) => {
  const message = "浏览器验证：" + Date.now();
  const taskTitle = "浏览器验证待办 " + Date.now();
  await page.getByRole("textbox", { name: "讨论内容" }).fill(message);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "添加待办", exact: true }).click();
  await page.getByLabel("待办事项").fill(taskTitle);
  await page.getByLabel("负责人", { exact: true }).fill("测试负责人");
  await page
    .getByRole("button", { name: "创建待办", exact: true })
    .last()
    .click();
  await page.getByRole("tab", { name: "任务", exact: true }).click();
  await expect(
    page.getByText(taskTitle, { exact: true }).first(),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "产品共创", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "成果", exact: true }).click();
  await page.locator(".artifact-list-row").first().click();
  await page
    .getByRole("textbox", { name: "成果内容", exact: true })
    .fill("浏览器保存的成果第二版。");
  await page.getByRole("button", { name: "保存新版本" }).click();
  await page.getByRole("button", { name: "发起任务", exact: true }).click();
  await page
    .getByRole("combobox", { name: "执行服务", exact: true })
    .selectOption("fixture");
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect(page.locator(".run-strip")).toContainText("已完成", {
    timeout: 20000,
  });
});
test("mobile keeps conversation and composer accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("textbox", { name: "讨论内容" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  expect(overflow).toBe(false);
});
test("model configuration and knowledge search stay usable on a narrow screen", async ({
  page,
}) => {
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "API 类型", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "模型用途", exact: true })
    .selectOption("embedding");
  await expect(page.getByLabel("API Key", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "展开导航", exact: true }).click();
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "知识库", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "检索资料", exact: true })
    .fill("团队协作约定");
  await page.getByRole("button", { name: "检索", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "建立语义索引", exact: true }).first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test("failed message delivery keeps the draft", async ({ page }) => {
  await page.route("**/api/conversations/*/messages", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "测试：消息未送出" }),
    }),
  );
  await page.getByRole("textbox", { name: "讨论内容" }).fill("这份草稿应保留");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("消息未送出");
  await expect(page.getByRole("textbox", { name: "讨论内容" })).toHaveValue(
    "这份草稿应保留",
  );
});
