import { test, expect } from "@playwright/test";
import { writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
async function fixture(request: any) {
  await request.post("/api/auth/demo", { data: {} });
  return (await request.get("/api/workspace")).json();
}
const scoped = {
  id: "10000000-0000-4000-8000-000000000111",
  conversationId: "10000000-0000-4000-8000-000000000222",
  name: "受限项目空间",
  goal: "整理获准会话中的工作事项",
  source: { kind: "nextcloud-talk", roomId: "source0001", name: "设计协作" },
};
test("A source room opens a new scoped project and makes the AI input scope visible", async ({
  page,
  request,
}) => {
  const base = await fixture(request);
  base.user.demo = false;
  let created = false;
  await page.route("**/api/workspace*", (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).searchParams.get("projectId") ===
        scoped.id
          ? {
              ...base,
              projects: [...base.projects, scoped],
              project: scoped,
              messages: [],
              tasks: [],
              artifacts: [],
            }
          : base,
    }),
  );
  await page.route("**/api/talk/rooms", (route) =>
    route.fulfill({
      json: [{ id: "source0001", name: "设计协作", readOnly: false }],
    }),
  );
  await page.route("**/api/talk/rooms/*/messages*", (route) =>
    route.fulfill({ json: { messages: [], before: null } }),
  );
  await page.route("**/api/talk/rooms/*/sends", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/talk/rooms/*/project", (route) =>
    route.fulfill({ json: { project: created ? scoped : null } }),
  );
  await page.route("**/api/projects/from-talk", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      roomId: "source0001",
      name: scoped.name,
      goal: scoped.goal,
    });
    created = true;
    return route.fulfill({ json: scoped });
  });
  await page.route("**/api/models", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "企业消息", exact: true })
    .click();
  await page.getByRole("button", { name: "项目空间", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("来源会话成员");
  await page.getByLabel("项目名称", { exact: true }).fill(scoped.name);
  await page.getByLabel("当前目标", { exact: true }).fill(scoped.goal);
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: scoped.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "工作记录", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".project-source-banner")).toContainText(
    "访问范围随来源会话成员变化",
  );
  await page.screenshot({ path: ".runtime/source-project-review.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({ path: ".runtime/source-project-mobile-review.png" });
  await page.getByRole("button", { name: "展开导航", exact: true }).click();
  await page.getByRole("button", { name: "发起任务", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("所选模型连接");
  await expect(page.getByRole("dialog")).toContainText(
    "不会自动发布到企业会话",
  );
  await page
    .getByRole("textbox", { name: "工作要求", exact: true })
    .fill("private-run-draft");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.setViewportSize({ width: 1504, height: 1045 });
  await page
    .getByRole("button", { name: base.project.name, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: base.project.name, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "发起任务", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "工作要求", exact: true }),
  ).toHaveValue("请把当前讨论整理成纪要，保留明确分工与时间。");
});
test("Revoked source access closes private editors and prevents draft transfer into another project", async ({
  page,
  request,
}) => {
  test.setTimeout(45000);
  const base = await fixture(request);
  base.user.demo = false;
  let revoked = false;
  const privateArtifact = {
    id: "10000000-0000-4000-8000-000000000333",
    title: "私有来源成果",
    content: "private-artifact-body-sentinel",
    version: 1,
    status: "draft",
    createdAt: new Date().toISOString(),
  };
  const privateView = {
    ...base,
    project: scoped,
    projects: [...base.projects, scoped],
    messages: [],
    tasks: [],
    artifacts: [privateArtifact],
  };
  await page.route("**/api/workspace*", (route) => {
    const id = new URL(route.request().url()).searchParams.get("projectId");
    if (id === scoped.id && revoked)
      return route.fulfill({ status: 404, json: { message: "项目不可访问" } });
    return route.fulfill({ json: revoked ? base : privateView });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: scoped.name, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "讨论内容" })
    .fill("private-draft-must-not-cross-project");
  await page.getByText(privateArtifact.title, { exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("成果");
  revoked = true;
  await expect(
    page.getByRole("heading", { name: base.project.name, exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "讨论内容" })).toHaveValue("");
  await expect(
    page.getByText(privateArtifact.title, { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(scoped.name, { exact: true })).toHaveCount(0);
});
test("Private runtime files cannot be served by the frontend development server", async ({
  request,
}) => {
  const path = resolve(".runtime", "private-web-probe-" + Date.now() + ".txt"),
    marker = "synthetic-private-runtime-marker";
  try {
    await writeFile(path, marker);
    const response = await request.get("/@fs/" + path);
    expect(response.status()).toBe(403);
    expect(await response.text()).not.toContain(marker);
  } finally {
    await rm(path, { force: true });
  }
});
