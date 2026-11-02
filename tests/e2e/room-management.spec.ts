import { test, expect, type Page } from "@playwright/test";
const token = "manage0001",
  id = "d5000000-0000-4000-8000-000000000001",
  binding = "a".repeat(64);
const expected = Object.fromEntries(
  [
    "notify",
    "favorite",
    "mark_read",
    "mark_unread",
    "rename",
    "add_member",
    "remove_member",
    "moderator",
    "leave",
    "delete",
  ].map((op) => [op, "b".repeat(64)]),
);
async function start(page: Page) {
  await page.request.post("/api/auth/demo", { data: {} });
  const view = await (await page.request.get("/api/workspace")).json();
  view.user.demo = false;
  for (const engine of ["dsh", "hermes"])
    view.engines[engine] = {
      configured: true,
      operations: ["manage_communication"],
      evidence: "UI protocol fixture",
      modelProviders: ["openai-compatible"],
    };
  await page.route("**/api/workspace", (r) => r.fulfill({ json: view }));
  await page.route("**/api/auth/status", (r) =>
    r.fulfill({ json: { nextcloudConfigured: true, demoEnabled: true } }),
  );
  await page.route("**/api/models", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/talk/rooms", (r) =>
    r.fulfill({
      json: [
        {
          id: token,
          name: "合成通信验收群",
          readOnly: false,
          unreadMessages: 3,
          unreadMention: true,
        },
      ],
    }),
  );
  await page.route("**/api/talk/rooms/*/messages*", (r) =>
    r.fulfill({
      json: {
        messages: [
          {
            id: "41",
            author: "同名员工",
            authorId: "users:peer",
            content: "合成消息位置",
            createdAt: "2026-10-30T10:00:00Z",
            kind: "comment",
            referenceId: "",
            version: "1",
            expiresAt: null,
          },
        ],
        before: null,
      },
    }),
  );
  for (const suffix of ["sends", "drafts", "attachment-uploads"])
    await page.route("**/api/talk/rooms/*/" + suffix, (r) =>
      r.fulfill({ json: [] }),
    );
  await page.route("**/api/talk/rooms/*/attachment-sends", (r) =>
    r.fulfill({ json: { sends: [], runs: [] } }),
  );
  await page.route("**/api/talk/rooms/*/project", (r) =>
    r.fulfill({ json: { project: { name: "合成关联项目" } } }),
  );
  const data = {
    bindingRef: binding,
    actorUid: "operator",
    checkedAt: new Date().toISOString(),
    features: [
      "notification-levels",
      "favorites",
      "chat-read-marker",
      "chat-unread",
    ],
    rooms: [
      {
        id: token,
        type: 2,
        name: "合成通信验收群",
        displayName: "合成通信验收群",
        participantType: 1,
        objectType: "",
        hasCall: false,
        breakoutRoomMode: 0,
        canDelete: true,
        canLeave: true,
        favorite: false,
        notificationLevel: 2,
        unreadMessages: 3,
        unreadMention: true,
        lastReadMessage: "40",
        expected,
      },
    ],
    participants: {
      rows: [
        {
          uid: "operator",
          name: "当前员工",
          participantType: 1,
          attendeeId: 1,
        },
        { uid: "peer", name: "同名员工", participantType: 3, attendeeId: 2 },
      ],
      unsupported: 0,
    },
  };
  await page.route("**/api/talk/management?*", (r) =>
    r.fulfill({ json: data }),
  );
  await page.route("**/api/talk/management/commands", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ json: [] })
      : r.fulfill({ json: { id, state: "succeeded" } }),
  );
  await page.route("**/api/organization?*", (r) =>
    r.fulfill({
      json: {
        rows: [
          { uid: "peer", name: "同名员工" },
          { uid: "other", name: "同名员工" },
        ],
        partial: false,
        nextOffset: null,
      },
    }),
  );
  await page.goto("/");
  await expect(page).toHaveTitle(/Hyper Workspace/);
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "企业消息", exact: true })
    .click();
  await expect(page.getByLabel("未读 3 条")).toBeVisible();
  const roomButton = page.getByRole("button", {
    name: "合成通信验收群",
    exact: true,
  });
  await expect(roomButton).toBeVisible();
  await expect(roomButton).toHaveAccessibleDescription("未读 3 条，有人提及我");
  await page
    .getByRole("button", { name: "会话与通知管理", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "会话与通知管理",
    exact: true,
  });
  await expect(dialog).toContainText("未读 3");
  return { dialog, data };
}
test("History search pages beyond loaded messages and shares a private host-bound AI read; denied refresh clears results", async ({
  page,
}, testInfo) => {
  const { dialog } = await start(page);
  let denied = false,
    searches = 0,
    captured: any;
  const message = (id: string, content: string) => ({
    id,
    content,
    author: "合成员工",
    authorId: "users:peer",
    createdAt: "2026-10-30T10:00:00Z",
    kind: "comment",
    version: "1",
    expiresAt: null,
    referenceId: "",
  });
  await page.route("**/api/talk/rooms/*/search?*", (r) => {
    searches++;
    const query = new URL(r.request().url()).searchParams;
    expect(query.get("bindingRef")).toBe(binding);
    expect(query.get("q")).toBe("历史交付");
    return denied
      ? r.fulfill({ status: 403, json: { message: "合成来源权限已撤销" } })
      : r.fulfill({
          json: {
            roomId: token,
            scope: "source-history",
            messages: query.has("cursor")
              ? [message("8", "历史交付：补充说明")]
              : [message("7", "历史交付：旧讨论中的决定")],
            cursor: query.has("cursor") ? null : "20",
            complete: query.has("cursor"),
          },
        });
  });
  await dialog
    .getByRole("combobox", { name: "通信操作", exact: true })
    .selectOption("read");
  await expect(
    dialog.getByRole("combobox", { name: "通信执行方式", exact: true }),
  ).toHaveValue("ai");
  await dialog.getByLabel("历史消息关键词", { exact: true }).fill("历史交付");
  await dialog
    .getByRole("button", { name: "直接搜索历史", exact: true })
    .click();
  await expect(
    dialog.getByText("历史交付：旧讨论中的决定", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "继续读取搜索结果", exact: true })
    .click();
  await expect(
    dialog.getByText("历史交付：补充说明", { exact: true }),
  ).toBeVisible();
  await page.route("**/api/talk/management/runs", (r) => {
    captured = r.request().postDataJSON();
    return r.fulfill({ json: { id, state: "queued" } });
  });
  await page.route("**/api/runs/" + id, (r) =>
    r.fulfill({
      json: {
        id,
        state: "succeeded",
        result: { receipts: [{ search: true, resultCount: 1, roomId: token }] },
      },
    }),
  );
  await dialog
    .getByRole("combobox", { name: "通信执行服务", exact: true })
    .selectOption("hermes");
  await dialog
    .getByRole("button", { name: "AI 搜索历史消息", exact: true })
    .click();
  await expect.poll(() => searches).toBe(3);
  expect(captured.plan).toEqual({
    operation: "read",
    roomId: token,
    bindingRef: binding,
    search: { query: "历史交付" },
  });
  expect(captured.engine).toBe("hermes");
  await expect(
    dialog.getByText("历史交付：旧讨论中的决定", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("message-history-search.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    false,
  );
  await expect(
    dialog.getByRole("textbox", { name: "历史消息关键词", exact: true }),
  ).toBeVisible();
  denied = true;
  await dialog
    .getByRole("button", { name: "直接搜索历史", exact: true })
    .click();
  await expect(dialog).toContainText("通信范围未就绪");
  await expect(
    dialog.getByText("历史交付：旧讨论中的决定", { exact: true }),
  ).toHaveCount(0);
});
test("Communication UI binds manual notifications to the exact source version and remains readable on desktop and mobile", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const { dialog } = await start(page);
  const writes: any[] = [];
  await page.route("**/api/talk/management/commands", (r) => {
    if (r.request().method() === "GET") return r.fulfill({ json: [] });
    writes.push(r.request().postDataJSON());
    return r.fulfill({ json: { id, state: "succeeded" } });
  });
  const submit = dialog.getByRole("button", {
    name: "执行通信操作",
    exact: true,
  });
  await expect(submit).toBeDisabled();
  await dialog
    .getByRole("combobox", { name: "消息通知", exact: true })
    .selectOption("3");
  await dialog.getByRole("checkbox", { name: /我确认所选会话/ }).check();
  await submit.click();
  await expect(dialog.getByRole("status")).toContainText("来源确认与回读");
  expect(writes).toHaveLength(1);
  expect(writes[0].plan).toEqual({
    operation: "notify",
    bindingRef: binding,
    roomId: token,
    expected: expected.notify,
    confirmed: true,
    level: 3,
  });
  await dialog
    .getByRole("combobox", { name: "通信操作", exact: true })
    .selectOption("remove_member");
  await expect(dialog).toContainText("合成关联项目");
  await dialog
    .getByRole("combobox", { name: "当前群成员", exact: true })
    .selectOption("peer");
  await expect(dialog).toContainText("成员实例 2");
  await page.screenshot({
    path: "/tmp/hyper-room-management-desktop.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  expect(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    false,
  );
  await page.screenshot({
    path: "/tmp/hyper-room-management-mobile.png",
    fullPage: false,
  });
  expect(errors).toEqual([]);
});
test("An unknown group response freezes the selected UIDs and reuses the original body and request key", async ({
  page,
}) => {
  const { dialog } = await start(page),
    writes: any[] = [];
  await page.route("**/api/talk/management/commands", (r) => {
    if (r.request().method() === "GET") return r.fulfill({ json: [] });
    writes.push(r.request().postDataJSON());
    return writes.length === 1
      ? r.fulfill({ status: 200, body: "" })
      : r.fulfill({ json: { id, state: "recovery_required" } });
  });
  await dialog
    .getByRole("combobox", { name: "通信操作", exact: true })
    .selectOption("create_group");
  await dialog
    .getByRole("textbox", { name: "群名称", exact: true })
    .fill("合成新群");
  await dialog.getByRole("button", { name: "查找员工", exact: true }).click();
  await dialog
    .getByRole("checkbox", { name: "同名员工 · UID peer", exact: true })
    .check();
  await dialog.getByRole("checkbox", { name: /我确认所选会话/ }).check();
  await dialog
    .getByRole("button", { name: "执行通信操作", exact: true })
    .click();
  await expect(dialog).toContainText("当前选择已冻结");
  await expect(
    dialog.getByRole("textbox", { name: "群名称", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "关闭", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "使用原请求核对回执", exact: true })
    .click();
  await expect(dialog).toContainText("未自动重发");
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0].plan.uids).toEqual(["peer"]);
});
test("Communication UI uses Hermes for an explicit read and clears private controls after current-source denial", async ({
  page,
}) => {
  const { dialog } = await start(page),
    writes: any[] = [];
  await page.route("**/api/talk/management/runs", (r) => {
    writes.push(r.request().postDataJSON());
    return r.fulfill({ json: { id, state: "queued" } });
  });
  await page.route("**/api/runs/" + id, (r) =>
    r.fulfill({
      json: {
        id,
        state: "succeeded",
        result: {
          receipts: [
            { tool: "communication.manage", operation: "read", roomCount: 1 },
          ],
        },
      },
    }),
  );
  await dialog
    .getByRole("combobox", { name: "通信操作", exact: true })
    .selectOption("read");
  await dialog
    .getByRole("combobox", { name: "通信执行服务", exact: true })
    .selectOption("hermes");
  await dialog
    .getByRole("button", { name: "AI 查询会话", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("AI 操作已有实际回执");
  expect(writes).toHaveLength(1);
  expect(writes[0].engine).toBe("hermes");
  expect(writes[0].plan).toEqual({
    operation: "read",
    bindingRef: binding,
    roomId: token,
  });
  await page.route("**/api/talk/management?*", (r) =>
    r.fulfill({ status: 403, json: { message: "来源权限已撤销" } }),
  );
  await dialog
    .getByRole("button", { name: "重新读取来源", exact: true })
    .click();
  await expect(dialog).toContainText("来源权限已撤销");
  await expect(dialog.getByText("未读 3", { exact: false })).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "AI 查询会话", exact: true }),
  ).toBeDisabled();
});

test("Manual group dispatch exposes its durable command while the response is pending and keeps Stop available", async ({
  page,
}) => {
  const { dialog } = await start(page);
  let active = false,
    stopped = false,
    release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/talk/management/commands", async (r) => {
    if (r.request().method() === "GET")
      return r.fulfill({
        json: active
          ? [
              {
                id,
                operation: "create_group",
                state: stopped ? "recovery_required" : "dispatching",
                roomId: token,
                scopeAvailable: true,
                completedSteps: 0,
                totalSteps: 2,
                steps: [
                  {
                    sequence: 0,
                    operation: "create_group",
                    state: "dispatching",
                  },
                ],
                acknowledgedAt: null,
              },
            ]
          : [],
      });
    active = true;
    await gate;
    await r.fulfill({ json: { id, state: "recovery_required" } });
  });
  await page.route(
    "**/api/talk/management/commands/" + id + "/stop",
    async (r) => {
      stopped = true;
      release();
      await r.fulfill({ json: { id, state: "recovery_required" } });
    },
  );
  try {
    await dialog
      .getByRole("combobox", { name: "通信操作", exact: true })
      .selectOption("create_group");
    await dialog
      .getByRole("textbox", { name: "群名称", exact: true })
      .fill("合成可停止群");
    await dialog.getByRole("button", { name: "查找员工", exact: true }).click();
    await dialog
      .getByRole("checkbox", { name: "同名员工 · UID peer", exact: true })
      .check();
    await dialog.getByRole("checkbox", { name: /我确认所选会话/ }).check();
    await dialog
      .getByRole("button", { name: "执行通信操作", exact: true })
      .click();
    const stop = dialog.getByRole("button", {
      name: "停止此操作后续步骤",
      exact: true,
    });
    await expect(stop).toBeEnabled();
    await expect(
      dialog.getByRole("button", { name: "关闭", exact: true }),
    ).toBeDisabled();
    await stop.click();
    await expect(dialog).toContainText("未自动重发");
    expect(stopped).toBe(true);
  } finally {
    release();
  }
});
test("A denied contact read invalidates an older in-flight source refresh and prevents private controls from returning", async ({
  page,
}) => {
  const { dialog, data } = await start(page);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  await dialog
    .getByRole("combobox", { name: "通信操作", exact: true })
    .selectOption("create_group");
  await page.route("**/api/talk/management?*", async (r) => {
    entered();
    await gate;
    await r.fulfill({ json: data }).catch(() => {});
  });
  await page.route("**/api/organization?*", (r) =>
    r.fulfill({ status: 403, json: { message: "合成来源已撤权" } }),
  );
  try {
    await dialog
      .getByRole("button", { name: "重新读取来源", exact: true })
      .click();
    await started;
    await dialog.getByRole("button", { name: "查找员工", exact: true }).click();
    await expect(dialog).toContainText("合成来源已撤权");
    release();
    await expect(dialog).toContainText("通信范围未就绪");
    await expect(dialog.getByText("未读 3", { exact: false })).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "执行通信操作", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
});
