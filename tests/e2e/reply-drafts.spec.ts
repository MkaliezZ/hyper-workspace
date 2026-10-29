import { test, expect } from "@playwright/test";
const draftId = "40000000-0000-4000-8000-000000000001";
const runId = "40000000-0000-4000-8000-000000000002";
const sourceProject = {
  id: "40000000-0000-4000-8000-000000000003",
  conversationId: "40000000-0000-4000-8000-000000000004",
  name: "回复协作空间",
  goal: "明确本周分工",
  source: { kind: "nextcloud-talk", roomId: "source0001", name: "设计协作" },
};
const reply = {
  id: draftId,
  runId,
  roomId: "source0001",
  roomName: "设计协作",
  content: "测试草稿：接口方案已确认，我会在周五前更新进展。",
  createdAt: "2026-10-29T06:30:00Z",
  sourceMessageIds: ["talk:synthetic:1"],
};
async function fixture(page: any, request: any) {
  await request.post("/api/auth/demo", { data: {} });
  const base = await (await request.get("/api/workspace")).json();
  base.user.demo = false;
  await page.route("**/api/workspace*", (route: any) =>
    route.fulfill({
      json:
        new URL(route.request().url()).searchParams.get("projectId") ===
        sourceProject.id
          ? {
              ...base,
              project: sourceProject,
              projects: [...base.projects, sourceProject],
              messages: [],
              artifacts: [],
              tasks: [],
            }
          : base,
    }),
  );
  await page.route("**/api/talk/rooms", (route: any) =>
    route.fulfill({
      json: [
        { id: "source0001", name: "设计协作", readOnly: false },
        { id: "source0002", name: "联调协作", readOnly: false },
      ],
    }),
  );
  await page.route("**/api/talk/rooms/*/project", (route: any) =>
    route.fulfill({ json: { project: sourceProject } }),
  );
  await page.route("**/api/talk/rooms/*/sends", (route: any) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/models", (route: any) =>
    route.fulfill({ json: [] }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "企业消息", exact: true })
    .click();
}
test("AI drafting prepares a private editable reply; sending uses the existing receipt path and preserves the selected source", async ({
  page,
  request,
}) => {
  let started = false,
    sent = false;
  const sends: any[] = [];
  await page.route("**/api/talk/rooms/*/messages*", (route) => {
    if (route.request().method() === "POST") {
      sends.push(route.request().postDataJSON());
      sent = true;
      return route.fulfill({
        json: {
          id: runId,
          state: "succeeded",
          sourceMessageId: "555",
          error: null,
          acknowledgedAt: null,
        },
      });
    }
    return route.fulfill({ json: { messages: [], before: null } });
  });
  await page.route("**/api/talk/rooms/*/drafts", (route) =>
    route.fulfill({
      json:
        started && route.request().url().includes("source0001")
          ? [
              {
                id: draftId,
                runId,
                engine: "hermes",
                createdAt: reply.createdAt,
                sendState: sent ? "succeeded" : null,
                sendId: sent ? runId : null,
              },
            ]
          : [],
    }),
  );
  await page.route("**/api/talk/drafts/*", (route) =>
    route.fulfill({ json: reply }),
  );
  await page.route("**/api/runs", (route) => {
    const body = route.request().postDataJSON();
    expect(body.workflow).toBe("draft_reply");
    expect(body.engine).toBe("hermes");
    expect(body.conversationId).toBe(sourceProject.conversationId);
    started = true;
    return route.fulfill({
      json: { id: runId, state: "queued", created: true },
    });
  });
  await page.route("**/api/runs/*", (route) =>
    route.fulfill({
      json: {
        id: runId,
        state: "succeeded",
        workflow: "draft_reply",
        engine: "hermes",
        result: {
          text: "回复草稿已保存，尚未发送。",
          receipts: [
            {
              tool: "communication.draft",
              id: draftId,
              roomId: "source0001",
              state: "draft",
            },
          ],
        },
      },
    }),
  );
  await fixture(page, request);
  await page.getByRole("button", { name: "AI 起草回复", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "工作类型", exact: true }),
  ).toHaveValue("draft_reply");
  await page
    .getByRole("combobox", { name: "执行服务", exact: true })
    .selectOption("hermes");
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await page.getByRole("button", { name: "查看回复草稿", exact: true }).click();
  await expect(page.getByRole("region", { name: "AI 回复草稿" })).toContainText(
    reply.content,
  );
  expect(sends).toHaveLength(0);
  await expect(
    page.getByRole("textbox", { name: "企业消息内容", exact: true }),
  ).toHaveValue("");
  await page.screenshot({ path: ".runtime/reply-draft-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({ path: ".runtime/reply-draft-mobile.png" });
  await page.getByRole("button", { name: "放入发送框", exact: true }).click();
  await page
    .getByRole("textbox", { name: "企业消息内容", exact: true })
    .fill("检查后的实际回复");
  await page.getByRole("button", { name: "联调协作", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "企业消息内容", exact: true }),
  ).toHaveValue("");
  await page.getByRole("button", { name: "设计协作", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "企业消息内容", exact: true }),
  ).toHaveValue("检查后的实际回复");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "企业消息内容", exact: true }),
  ).toHaveValue("");
  expect(sends).toHaveLength(1);
  expect(sends[0].draftId).toBe(draftId);
  expect(sends[0].content).toBe("检查后的实际回复");
});
test("Saved reply previews never overwrite manual text, and lost source access clears private AI content", async ({
  page,
  request,
}) => {
  let revoked = false;
  await page.route("**/api/talk/rooms/*/messages*", (route) =>
    route.fulfill(
      revoked
        ? { status: 404, json: { message: "来源权限失效" } }
        : { json: { messages: [], before: null } },
    ),
  );
  await page.route("**/api/talk/rooms/*/drafts", (route) =>
    route.fulfill({
      json: [
        {
          id: draftId,
          runId,
          engine: "dsh",
          createdAt: reply.createdAt,
          sendState: null,
          sendId: null,
        },
      ],
    }),
  );
  await page.route("**/api/talk/drafts/*", (route) =>
    route.fulfill({ json: reply }),
  );
  await fixture(page, request);
  await page
    .getByRole("textbox", { name: "企业消息内容", exact: true })
    .fill("原有人工草稿");
  await page.getByText("我的 AI 草稿", { exact: false }).click();
  await page.getByRole("button", { name: "预览草稿", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "企业消息内容", exact: true }),
  ).toHaveValue("原有人工草稿");
  await page.getByRole("button", { name: "替换当前草稿", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "企业消息内容", exact: true }),
  ).toHaveValue(reply.content);
  revoked = true;
  await expect(
    page.getByRole("textbox", { name: "企业消息内容", exact: true }),
  ).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByText(reply.content, { exact: true })).toHaveCount(0);
  revoked = false;
  await page.getByRole("button", { name: "刷新企业会话", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "企业消息内容", exact: true }),
  ).toHaveValue("");
});
