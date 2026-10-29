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
  view.engines.dsh = {
    configured: true,
    operations: ["read_file"],
    evidence: "UI protocol fixture",
  };
  view.engines.hermes = {
    configured: true,
    operations: ["read_file"],
    evidence: "UI protocol fixture",
    modelProviders: ["openai-compatible"],
  };
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

const readingId = "60000000-0000-4000-8000-000000000001",
  runId = "70000000-0000-4000-8000-000000000001";
async function readingFile(page: any) {
  await page.route("**/api/files/list", (r: any) => r.fulfill({ json: [] }));
  await page.route("**/api/files/imports", (r: any) =>
    r.fulfill({
      json: [{ id, title, state: "ready", sourceVersion: "v1:hash" }],
    }),
  );
  await page.route("**/api/files/imports/" + id, (r: any) =>
    r.fulfill({ json: { id, title, content, sourceVersion: "v1:hash" } }),
  );
  await page.route("**/api/models", (r: any) =>
    r.fulfill({
      json: [
        {
          id: "80000000-0000-4000-8000-000000000001",
          name: "个人阅读模型 · 测试连接",
          purpose: "chat",
          provider: "openai-compatible",
        },
      ],
    }),
  );
}
test("Personal AI reading chooses engine/model, resumes a saved result and preserves editable versions on desktop and mobile", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await readingFile(page);
  let starts = 0,
    cancelled = false;
  let finished = false,
    version = 1,
    text = "测试生成内容：所选文件强调来源与版本。";
  await page.route("**/api/files/imports/" + id + "/readings", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      expect(body.engine).toBe("hermes");
      expect(body.expectedSourceVersion).toBe("v1:hash");
      expect(body.modelProfileId).toBe("80000000-0000-4000-8000-000000000001");
      expect(body).not.toHaveProperty("apiKey");
      finished = true;
      starts++;
      return route.fulfill({
        json: {
          id: starts === 1 ? runId : runId.replace(/1$/, "2"),
          state: "queued",
        },
      });
    }
    return route.fulfill({
      json: {
        readings: finished
          ? [{ id: readingId, version, engine: "hermes" }]
          : [],
        runs: [],
      },
    });
  });
  await page.route("**/api/runs/**", (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().url()).toContain("/cancel");
      cancelled = true;
      return route.fulfill({ json: { state: "cancelled" } });
    }
    const first = route.request().url().endsWith(runId);
    return route.fulfill({
      json: {
        id: runId,
        state: first ? "succeeded" : cancelled ? "cancelled" : "running",
        result: first
          ? { receipts: [{ tool: "file.reading.save", id: readingId }] }
          : undefined,
      },
    });
  });
  await page.route("**/api/files/readings/" + readingId, (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      expect(body.expectedVersion).toBe(1);
      text = body.content;
      version = 2;
      return route.fulfill({ json: { id: readingId, version } });
    }
    return route.fulfill({
      json: {
        id: readingId,
        sourceVersion: "v1:hash",
        question: "概括当前文件",
        version,
        content: text,
        versions: [
          { version: 1, content: "测试生成初稿" },
          ...(version === 2 ? [{ version: 2, content: text }] : []),
        ],
      },
    });
  });
  await start(page, request);
  await page.getByRole("button", { name: "查看文本", exact: true }).click();
  await page
    .getByRole("button", { name: "AI 阅读此文件", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "执行器", exact: true })
    .selectOption("hermes");
  await page
    .getByRole("combobox", { name: "阅读模型", exact: true })
    .selectOption("80000000-0000-4000-8000-000000000001");
  await page
    .getByRole("textbox", { name: "阅读问题", exact: true })
    .fill("概括当前文件");
  await page.getByRole("button", { name: "开始个人阅读", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "修改解读", exact: true });
  await expect(editor).toHaveValue(text);
  await editor.fill("人工修订：确认来源与版本后再使用解读。");
  await page.getByRole("button", { name: "保存解读修订", exact: true }).click();
  await expect(page.getByText("当前修订 v2", { exact: false })).toBeVisible();
  await expect(page).toHaveTitle(/Hyper Workspace/);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(await page.locator("body").innerText()).toContain(
    "用 AI 阅读当前版本",
  );
  expect(errors).toEqual([]);
  await page
    .getByRole("region", { name: "个人 AI 文件阅读", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".runtime/file-reading-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await editor.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({ path: ".runtime/file-reading-mobile.png" });
  await page
    .getByRole("textbox", { name: "阅读问题", exact: true })
    .fill("再次核对这份文件");
  await page.getByRole("button", { name: "开始个人阅读", exact: true }).click();
  await page.getByRole("button", { name: "停止阅读", exact: true }).click();
  expect(cancelled).toBe(true);
  await expect(
    page.getByRole("button", { name: "停止阅读", exact: true }),
  ).toHaveCount(0);
  await expect(editor).toHaveValue("人工修订：确认来源与版本后再使用解读。");
});
test("Lost file scope clears personal AI editors and a delayed private response cannot restore them", async ({
  page,
  request,
}) => {
  test.setTimeout(45000);
  await readingFile(page);
  let checks = 0;
  let revoked = false,
    release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/files/imports", async (route) => {
    if (revoked) {
      checks++;
      await new Promise((resolve) => setTimeout(resolve, 9000));
    }
    return route.fulfill({
      json: [
        {
          id,
          title: revoked ? "来源暂不可用的文件" : title,
          state: revoked ? "unavailable" : "ready",
          sourceVersion: revoked ? undefined : "v1:hash",
        },
      ],
    });
  });
  await page.route("**/api/files/imports/" + id + "/readings", (route) =>
    route.fulfill({
      json: {
        readings: [{ id: readingId, version: 1, engine: "dsh" }],
        runs: [],
      },
    }),
  );
  await page.route("**/api/files/readings/" + readingId, async (route) => {
    await gate;
    await route.fulfill({
      json: {
        id: readingId,
        sourceVersion: "v1:hash",
        question: "private",
        version: 1,
        content: "late-private-reading-sentinel",
        versions: [],
      },
    });
  });
  await start(page, request);
  await page.getByRole("button", { name: "查看文本", exact: true }).click();
  await page
    .getByRole("button", { name: "AI 阅读此文件", exact: true })
    .click();
  const pending = page.waitForRequest("**/api/files/readings/" + readingId);
  await page
    .getByRole("button", { name: "DSH · 解读 v1", exact: true })
    .click();
  await pending;
  revoked = true;
  await expect(
    page.getByRole("region", { name: "文件文本预览", exact: true }),
  ).toHaveCount(0, { timeout: 25000 });
  expect(checks).toBe(1);
  release();
  await expect(
    page.getByRole("textbox", { name: "修改解读", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("late-private-reading-sentinel")).toHaveCount(0);
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
