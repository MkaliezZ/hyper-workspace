import { test, expect } from "@playwright/test";
async function workspace(page: any, request: any) {
  await page.route("**/api/talk/rooms/*/attachment-sends", (route: any) =>
    route.fulfill({ json: { sends: [], runs: [] } }),
  );
  await request.post("/api/auth/demo", { data: {} });
  const fixture = await (await request.get("/api/workspace")).json();
  fixture.user.demo = false;
  await page.route("**/api/workspace", (route: any) =>
    route.fulfill({ json: fixture }),
  );
  await page.route("**/api/talk/rooms/*/drafts", (route: any) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/talk/rooms", (route: any) =>
    route.fulfill({
      json: [
        { id: "source0001", name: "设计协作", readOnly: false },
        { id: "source0002", name: "项目联调", readOnly: false },
      ],
    }),
  );
}
const initial = {
  id: "102",
  authorId: "users:peer",
  author: "陈远",
  content: "接口方案已确认，周五前完成联调。",
  createdAt: "2026-10-29T01:00:00Z",
  kind: "comment",
  referenceId: "",
  version: "1",
  expiresAt: null,
};
async function attachmentWorkspace(page: any, request: any) {
  await workspace(page, request);
  const fixture = await (await request.get("/api/workspace")).json();
  fixture.user.demo = false;
  for (const engine of ["dsh", "hermes"])
    fixture.engines[engine] = {
      configured: true,
      operations: ["share_attachment"],
      evidence: "UI protocol fixture",
      modelProviders: ["openai-compatible"],
    };
  await page.route("**/api/workspace", (route: any) =>
    route.fulfill({ json: fixture }),
  );
  await page.route("**/api/auth/status", (route: any) =>
    route.fulfill({
      json: {
        demoEnabled: true,
        filesEnabled: true,
        nextcloudConfigured: true,
      },
    }),
  );
  await page.route("**/api/talk/rooms/*/messages*", (route: any) =>
    route.fulfill({ json: { messages: [initial], before: null } }),
  );
  await page.route("**/api/talk/rooms/*/sends", (route: any) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/talk/rooms/*/project", (route: any) =>
    route.fulfill({
      json: {
        project: {
          id: "71000000-0000-4000-8000-000000000001",
          conversationId: "71000000-0000-4000-8000-000000000002",
        },
      },
    }),
  );
  await page.route("**/api/models", (route: any) =>
    route.fulfill({
      json: [
        {
          id: "71000000-0000-4000-8000-000000000003",
          name: "合成附件模型",
          purpose: "chat",
          provider: "openai-compatible",
        },
      ],
    }),
  );
  const file = {
    path: ["协作资料", "合成项目说明.md"],
    id: "881",
    name: "合成项目说明.md",
    etag: '"selected-v1"',
    size: 1200,
    kind: "file",
    mime: "text/markdown",
    importable: true,
  };
  await page.route("**/api/files/list", (route: any) =>
    route.fulfill({
      json: route.request().postDataJSON().path.length
        ? [file]
        : [
            {
              ...file,
              id: "880",
              name: "协作资料",
              path: ["协作资料"],
              kind: "directory",
              size: 0,
            },
          ],
    }),
  );
  return { file };
}
test("Attachment selection, explicit confirmation, unknown receipts and AI queued execution remain scoped and usable on mobile", async ({
  page,
  request,
}) => {
  const { file } = await attachmentWorkspace(page, request);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (
      ["error", "warning"].includes(message.type()) &&
      !message.text().includes("401 (Unauthorized)")
    )
      errors.push(message.text());
  });
  let sends: any[] = [],
    runs: any[] = [];
  const posts: any[] = [];
  let ai: any;
  const receipt = {
    kind: "attachment",
    id: "71000000-0000-4000-8000-000000000010",
    roomId: "source0001",
    fileId: file.id,
    name: file.name,
    state: "recovery_required",
    sourceMessageId: null,
    sourceShareId: null,
    sourceRunId: null,
    error: "delivery_unknown",
    acknowledgedAt: null,
    requestedPermissions: 1,
  };
  await page.route("**/api/talk/rooms/*/attachment-sends", (route) =>
    route.fulfill({
      json: {
        sends: route.request().url().includes("source0001") ? sends : [],
        runs,
        history: sends,
      },
    }),
  );
  await page.route("**/api/talk/rooms/*/attachments", (route) => {
    posts.push(route.request().postDataJSON());
    sends = [receipt];
    return route.fulfill({ json: receipt });
  });
  await page.route("**/api/talk/attachment-sends/*/reconcile", (route) =>
    route.fulfill({ json: receipt }),
  );
  await page.route("**/api/talk/attachment-sends/*/acknowledge", (route) => {
    sends = [];
    return route.fulfill({
      json: { ...receipt, acknowledgedAt: new Date().toISOString() },
    });
  });
  await page.route("**/api/runs", (route) => {
    ai = route.request().postDataJSON();
    runs = [
      {
        id: "71000000-0000-4000-8000-000000000020",
        state: "queued",
        error: null,
      },
    ];
    return route.fulfill({ json: runs[0] });
  });
  await page.route("**/api/runs/*/cancel", (route) => {
    runs = [];
    return route.fulfill({ json: { state: "cancelled" } });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "企业消息", exact: true })
    .click();
  await expect(page).toHaveTitle(/Hyper Workspace/);
  expect(page.url()).toBe("http://127.0.0.1:5173/");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.getByRole("button", { name: "发送附件", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "发送企业附件" });
  await dialog.getByRole("button", { name: /协作资料.*文件夹/ }).click();
  await dialog.getByRole("button", { name: /合成项目说明.md/ }).click();
  await dialog
    .getByRole("textbox", { name: "附件说明" })
    .fill("合成资料，请核对当前版本");
  await expect(
    dialog.getByRole("button", { name: "确认发送附件", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await page.screenshot({ path: "/tmp/hyper-attachment-send-desktop.png" });
  await dialog
    .getByRole("button", { name: "确认发送附件", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(posts).toHaveLength(1);
  expect(posts[0].plan).toEqual({
    roomId: "source0001",
    path: file.path,
    expectedFileId: file.id,
    expectedEtag: file.etag,
    caption: "合成资料，请核对当前版本",
    confirmed: true,
  });
  await expect(
    page.getByRole("button", { name: "发送附件", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "企业消息", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "核对附件发送", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "核对附件发送", exact: true }).click();
  expect(posts).toHaveLength(1);
  await page
    .getByRole("button", { name: "已查看来源，继续发送", exact: true })
    .click();
  await page.getByRole("button", { name: "发送附件", exact: true }).click();
  await dialog.getByRole("button", { name: /协作资料.*文件夹/ }).click();
  await dialog.getByRole("button", { name: /合成项目说明.md/ }).click();
  await dialog
    .getByRole("combobox", { name: "附件执行方式" })
    .selectOption("ai");
  await dialog
    .getByRole("combobox", { name: "附件执行器" })
    .selectOption("hermes");
  await dialog
    .getByRole("combobox", { name: "附件执行模型" })
    .selectOption("71000000-0000-4000-8000-000000000003");
  await dialog.getByRole("checkbox").check();
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog
    .getByRole("button", { name: "让 AI 发送附件", exact: true })
    .scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({ path: "/tmp/hyper-attachment-send-mobile.png" });
  await dialog
    .getByRole("button", { name: "让 AI 发送附件", exact: true })
    .click();
  expect(ai.engine).toBe("hermes");
  expect(ai.attachmentPlan.roomId).toBe("source0001");
  expect(ai.attachmentPlan.expectedFileId).toBe(file.id);
  expect(ai.workflow).toBe("share_attachment");
  await expect(
    page.getByText("AI 附件执行 · 排队中", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "发送附件", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "停止附件执行", exact: true }).click();
  await expect(
    page.getByText("AI 附件执行 · 排队中", { exact: true }),
  ).toHaveCount(0);
  expect(posts).toHaveLength(1);
  expect(errors).toEqual([]);
});
test("Denied attachment file reads close private selection and late model responses cannot restore it", async ({
  page,
  request,
}) => {
  await attachmentWorkspace(page, request);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    seen = new Promise<void>((r) => (entered = r));
  await page.route("**/api/models", async (route) => {
    entered();
    await gate;
    await route.fulfill({
      json: [
        {
          id: "71000000-0000-4000-8000-000000000003",
          name: "private-late-attachment-model",
          purpose: "chat",
          provider: "openai-compatible",
        },
      ],
    });
  });
  await page.route("**/api/files/list", (route) =>
    route.fulfill({ status: 403, json: { message: "合成附件权限已撤销" } }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "企业消息", exact: true })
    .click();
  await page.getByRole("button", { name: "发送附件", exact: true }).click();
  await seen;
  await expect(page.getByRole("dialog", { name: "发送企业附件" })).toHaveCount(
    0,
  );
  release();
  await page.getByRole("button", { name: "项目联调", exact: true }).click();
  await expect(
    page.getByText("private-late-attachment-model", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "发送企业附件" })).toHaveCount(
    0,
  );
});
test("Enterprise messages isolate room drafts, preserve retry keys and use source pages", async ({
  page,
  request,
}) => {
  await workspace(page, request);
  let fail = true;
  const posts: any[] = [];
  const messages = [initial];
  await page.route("**/api/talk/rooms/*/sends", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/talk/rooms/*/messages*", async (route) => {
    if (route.request().method() === "GET") {
      const older = new URL(route.request().url()).searchParams.has("before");
      return route.fulfill({
        json: {
          messages: older
            ? [{ ...initial, id: "99", content: "更早的讨论依据" }]
            : messages,
          before: older ? null : "100",
        },
      });
    }
    posts.push(route.request().postDataJSON());
    if (fail)
      return route.fulfill({
        status: 503,
        json: { message: "测试：发送响应暂不可用" },
      });
    messages.push({
      ...initial,
      id: "103",
      authorId: "users:self",
      author: "林晓",
      content: posts.at(-1).content,
    });
    return route.fulfill({
      json: {
        id: "10000000-0000-4000-8000-000000000001",
        state: "succeeded",
        sourceMessageId: "103",
        error: null,
        acknowledgedAt: null,
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "企业消息", exact: true })
    .click();
  await expect(page.getByText(initial.content, { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "企业消息内容" }).fill("设计组草稿");
  await page.getByRole("button", { name: "项目联调", exact: true }).click();
  await page.getByRole("textbox", { name: "企业消息内容" }).fill("联调组草稿");
  await page.getByRole("button", { name: "设计协作", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "企业消息内容" })).toHaveValue(
    "设计组草稿",
  );
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("发送响应暂不可用");
  await expect(page.getByRole("textbox", { name: "企业消息内容" })).toHaveValue(
    "设计组草稿",
  );
  fail = false;
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "企业消息内容" })).toHaveValue(
    "",
  );
  expect(posts).toHaveLength(2);
  expect(posts[0].idempotencyKey).toBe(posts[1].idempotencyKey);
  await page.getByRole("button", { name: "更早消息" }).click();
  await expect(page.getByText("更早的讨论依据", { exact: true })).toBeVisible();
  await expect(page.getByText(initial.content, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "返回最新" }).click();
  await expect(page.getByText(initial.content, { exact: true })).toBeVisible();
  await page.screenshot({ path: ".runtime/talk-desktop-review.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("textbox", { name: "企业消息内容" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({ path: ".runtime/talk-mobile-review.png" });
});
test("Unknown sends survive reload through receipts and require reconciliation or explicit continuation", async ({
  page,
  request,
}) => {
  await workspace(page, request);
  let pending = true,
    posts = 0;
  const receipt = {
    id: "10000000-0000-4000-8000-000000000002",
    state: "recovery_required",
    sourceMessageId: null,
    error: "delivery_unknown",
    acknowledgedAt: null,
  };
  await page.route("**/api/talk/rooms/*/sends", (route) =>
    route.fulfill({ json: pending ? [receipt] : [] }),
  );
  await page.route("**/api/talk/rooms/*/messages*", (route) => {
    if (route.request().method() === "POST") {
      posts++;
      return route.fulfill({ json: { ...receipt, state: "succeeded" } });
    }
    return route.fulfill({ json: { messages: [initial], before: null } });
  });
  await page.route("**/api/talk/sends/*/reconcile", (route) =>
    route.fulfill({ json: receipt }),
  );
  await page.route("**/api/talk/sends/*/acknowledge", (route) => {
    pending = false;
    return route.fulfill({
      json: { ...receipt, acknowledgedAt: new Date().toISOString() },
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "企业消息", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "企业消息内容" }),
  ).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("尚未确认");
  await page.reload();
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "企业消息", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "企业消息内容" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "核对发送结果" }).click();
  await expect(
    page.getByRole("textbox", { name: "企业消息内容" }),
  ).toBeDisabled();
  expect(posts).toBe(0);
  await page.getByRole("button", { name: "已查看来源，继续" }).click();
  await expect(
    page.getByRole("textbox", { name: "企业消息内容" }),
  ).toBeEnabled();
  await page
    .getByRole("textbox", { name: "企业消息内容" })
    .fill("核对后的新发送意图");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "企业消息内容" })).toHaveValue(
    "",
  );
  expect(posts).toBe(1);
});

test("Attachment cards use protected routes, download opaque bytes and clear when switching rooms", async ({
  page,
  request,
}) => {
  await workspace(page, request);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (value) => {
    if (
      ["error", "warning"].includes(value.type()) &&
      !value.text().includes("401 (Unauthorized)")
    )
      errors.push(value.text());
  });
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({
      json: {
        demoEnabled: true,
        filesEnabled: true,
        nextcloudConfigured: true,
      },
    }),
  );
  await page.route("**/api/talk/rooms/*/sends", (route) =>
    route.fulfill({ json: [] }),
  );
  const attachment = {
    id: "1234",
    name: "合成附件-设计评审与实施说明.html",
    size: 2048,
    mime: "text/html",
    etag: "current-v1",
    downloadable: true,
  };
  await page.route("**/api/talk/rooms/*/messages*", (route) =>
    route.fulfill({
      json: {
        messages: route.request().url().includes("source0001")
          ? [
              {
                ...initial,
                content: "合成资料：请核对这份附件的当前版本。",
                attachments: [attachment],
              },
              {
                ...initial,
                id: "103",
                content: "较大附件",
                attachments: [
                  {
                    ...attachment,
                    id: "1235",
                    name: "较大的演示录像.mp4",
                    size: 20 * 1024 * 1024,
                    mime: "video/mp4",
                    downloadable: false,
                  },
                ],
              },
            ]
          : [],
        before: null,
      },
    }),
  );
  await page.route(
    "**/api/talk/rooms/*/messages/*/attachments/*/download?*",
    (route) =>
      route.fulfill({
        contentType: "application/octet-stream",
        headers: {
          "Content-Disposition":
            "attachment; filename=synthetic-attachment.html",
        },
        body: "<script>synthetic-opaque-download</script>",
      }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "企业消息", exact: true })
    .click();
  await expect(page).toHaveTitle(/Hyper Workspace/);
  expect(page.url()).toBe("http://127.0.0.1:5173/");
  await expect(page.getByText(attachment.name, { exact: true })).toBeVisible();
  const open = page.getByRole("link", {
    name: "在来源中查看 " + attachment.name,
    exact: true,
  });
  await expect(open).toHaveAttribute(
    "href",
    "/api/talk/rooms/source0001/messages/102/attachments/1234/open?etag=current-v1",
  );
  await expect(open).toHaveAttribute("rel", "noopener noreferrer");
  await expect(
    page.getByRole("link", { name: "下载 较大的演示录像.mp4", exact: true }),
  ).toHaveCount(0);
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "下载 " + attachment.name, exact: true })
    .click();
  expect((await downloading).suggestedFilename()).toBe(
    "synthetic-attachment.html",
  );
  await expect(page.getByText(/AI 尚未读取附件正文/).first()).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/hyper-attachments-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(open).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({ path: "/tmp/hyper-attachments-mobile.png" });
  await page.getByRole("button", { name: "项目联调", exact: true }).click();
  await expect(page.getByRole("list", { name: "消息附件" })).toHaveCount(0);
  expect(errors).toEqual([]);
});
