import { test, expect } from "@playwright/test";
const id = "50000000-0000-4000-8000-000000000001",
  title = "项目说明.md",
  content = "测试资料：先确认来源与版本，再形成可修改成果。";
async function start(page: any, request: any) {
  await request.post("/api/auth/demo", { data: {} });
  const view = await (await request.get("/api/workspace")).json();
  view.user.demo = false;
  view.tasks = [];
  view.artifacts = [];
  await page.route("**/api/workspace", (route: any) =>
    route.fulfill({ json: view }),
  );
  await page.route("**/api/auth/status", (route: any) =>
    route.fulfill({
      json: {
        demoEnabled: true,
        nextcloudConfigured: true,
        filesEnabled: true,
      },
    }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "知识库", exact: true })
    .click();
  await page.getByRole("tab", { name: "企业文件", exact: true }).click();
}
test("Explicit file selection imports only the selected source version and builds an index after a separate action", async ({
  page,
  request,
}) => {
  let imported = false,
    indexes = 0;
  await page.route("**/api/files/list", (route) => {
    const path = route.request().postDataJSON().path;
    return route.fulfill({
      json: path.length
        ? [
            {
              id: "20",
              path: ["项目资料", title],
              name: title,
              kind: "file",
              size: Buffer.byteLength(content),
              mime: "text/markdown",
              etag: '"v1"',
              importable: true,
            },
          ]
        : [
            {
              id: "10",
              path: ["项目资料"],
              name: "项目资料",
              kind: "directory",
              size: 0,
              mime: "",
              etag: '"dir"',
              importable: false,
            },
          ],
    });
  });
  await page.route("**/api/files/imports", (route) =>
    route.fulfill({
      json: imported
        ? [{ id, title, state: "ready", sourceVersion: "v1:hash" }]
        : [],
    }),
  );
  await page.route("**/api/files/import", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      path: ["项目资料", title],
      expectedId: "20",
      expectedEtag: '"v1"',
    });
    imported = true;
    return route.fulfill({ json: { id, title, sourceVersion: "v1:hash" } });
  });
  await page.route("**/api/files/imports/*", (route) =>
    route.fulfill({ json: { id, title, content, sourceVersion: "v1:hash" } }),
  );
  await page.route("**/api/knowledge/index", (route) => {
    indexes++;
    expect(route.request().postDataJSON()).toEqual({ assetIds: [id] });
    return route.fulfill({ json: { indexed: [id] } });
  });
  await start(page, request);
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await page.getByRole("button", { name: "导入个人资料", exact: true }).click();
  expect(indexes).toBe(0);
  await page.getByRole("button", { name: "查看文本", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "文件文本预览" }),
  ).toContainText(content);
  await page.screenshot({ path: ".runtime/files-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page
    .getByRole("region", { name: "文件文本预览" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".runtime/files-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "建立语义索引", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已建立个人文件");
  expect(indexes).toBe(1);
});
test("Lost or changed file access removes cached previews and private knowledge excerpts", async ({
  page,
  request,
}) => {
  let revoked = false;
  await page.route("**/api/files/list", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/files/imports", (route) =>
    route.fulfill({
      json: [
        {
          id,
          title: revoked ? "来源暂不可用的文件" : title,
          state: revoked ? "unavailable" : "ready",
          sourceVersion: revoked ? undefined : "v1:hash",
        },
      ],
    }),
  );
  await page.route("**/api/files/imports/*", (route) =>
    route.fulfill({ json: { id, title, content, sourceVersion: "v1:hash" } }),
  );
  await page.route("**/api/knowledge?*", (route) =>
    route.fulfill({
      json: [
        { id, title, content, type: "source_file", sourceVersion: "v1:hash" },
      ],
    }),
  );
  await start(page, request);
  await page.getByRole("button", { name: "查看文本", exact: true }).click();
  await expect(page.getByText(content, { exact: true })).toBeVisible();
  revoked = true;
  await page.getByRole("button", { name: "刷新文件权限", exact: true }).click();
  await expect(page.getByText(content, { exact: true })).toHaveCount(0);
  revoked = false;
  await page.getByRole("tab", { name: "知识检索", exact: true }).click();
  await page
    .getByRole("textbox", { name: "检索资料", exact: true })
    .fill("测试");
  await page.getByRole("button", { name: "检索", exact: true }).click();
  await expect(page.getByText(content, { exact: true })).toBeVisible();
  revoked = true;
  await expect(page.getByText(content, { exact: true })).toHaveCount(0, {
    timeout: 15000,
  });
});
