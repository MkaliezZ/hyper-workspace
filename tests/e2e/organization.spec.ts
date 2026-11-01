import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
async function open(page: Page) {
  await page.request.post("/api/auth/demo", { data: {} });
  await page.goto("/");
  await expect(page).toHaveTitle(/Hyper Workspace/);
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "通讯录", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "组织通讯录", exact: true });
  await expect(panel.getByText("林晓", { exact: true })).toBeVisible();
  return panel;
}
test("Organization UI saves departments with the shared manual/AI service, exact member identity and mobile layout", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const panel = await open(page),
    name = "合成组织 " + randomUUID().slice(0, 5);
  await panel.getByRole("button", { name: "新建部门", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "新建部门", exact: true });
  await dialog.getByRole("textbox", { name: "部门名称" }).fill(name);
  await expect(
    dialog.getByRole("button", { name: "保存组织操作", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "保存组织操作", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByRole("button", { name, exact: true })).toBeVisible();
  const row = panel
    .locator(".organization-people li")
    .filter({ has: page.getByText("林晓", { exact: true }) });
  await row.getByRole("button", { name: "调整部门" }).click();
  dialog = page.getByRole("dialog", { name: "调整员工部门", exact: true });
  await expect(dialog).toContainText("产品 ID：");
  const departments = await (
      await page.request.get("/api/organization")
    ).json(),
    department = departments.departments.find((d: any) => d.name === name);
  await dialog
    .getByRole("combobox", { name: "员工所属部门", exact: true })
    .selectOption(department.id);
  await dialog
    .getByRole("combobox", { name: "组织保存方式", exact: true })
    .selectOption("ai");
  await dialog
    .getByRole("combobox", { name: "组织执行服务", exact: true })
    .selectOption("fixture");
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "AI 保存组织操作", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("AI 操作已有实际回执");
  await expect(row).toContainText(name);
  await page.screenshot({
    path: "/tmp/hyper-organization-desktop.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    panel.getByRole("textbox", { name: "查找企业联系人" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  const firstContact = await row
    .getByText("林晓", { exact: true })
    .boundingBox();
  expect(firstContact).not.toBeNull();
  expect(firstContact!.y + firstContact!.height).toBeLessThan(844);
  await page.screenshot({
    path: "/tmp/hyper-organization-mobile.png",
    fullPage: false,
  });
  expect(errors).toEqual([]);
});
test("Lost organization receipt freezes the original operation and retries the same key without duplication", async ({
  page,
}) => {
  const panel = await open(page),
    name = "回执核对 " + randomUUID().slice(0, 5),
    keys: string[] = [];
  let lost = true;
  await page.route("**/api/organization", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().postDataJSON().idempotencyKey);
    const actual = await route.fetch();
    if (lost) {
      lost = false;
      return route.abort("failed");
    }
    await route.fulfill({ response: actual });
  });
  await panel.getByRole("button", { name: "新建部门", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建部门", exact: true });
  await dialog.getByRole("textbox", { name: "部门名称" }).fill(name);
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "保存组织操作", exact: true })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "部门名称" }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "核对并重试原组织操作", exact: true }),
  ).toBeVisible();
  // The modal remains open so the original request cannot be silently replaced.
  await dialog
    .getByRole("button", { name: "核对并重试原组织操作", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const current = await (await page.request.get("/api/organization")).json();
  expect(current.departments.filter((d: any) => d.name === name)).toHaveLength(
    1,
  );
});
test("Denied organization refresh clears contacts and delayed responses cannot restore private directory state", async ({
  page,
}) => {
  const panel = await open(page);
  let release!: () => void, seen!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve)),
    started = new Promise<void>((resolve) => (seen = resolve));
  let calls = 0;
  await page.route("**/api/organization?**", async (route) => {
    calls++;
    if (calls === 1) {
      const response = await route.fetch();
      seen();
      await gate;
      try {
        await route.fulfill({ response });
      } catch {}
      return;
    }
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        message: "Synthetic organization permission revoked",
      }),
    });
  });
  await panel
    .getByRole("button", { name: "重新读取通讯录", exact: true })
    .click();
  await started;
  await panel
    .getByRole("button", { name: "重新读取通讯录", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText(
    "Synthetic organization permission revoked",
  );
  release();
  await expect(panel.getByText("林晓", { exact: true })).toHaveCount(0);
  await expect(
    panel.getByRole("textbox", { name: "查找企业联系人" }),
  ).toHaveValue("");
});
