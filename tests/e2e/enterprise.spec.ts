import { test, expect } from "@playwright/test";
async function workspace(page: any, request: any) {
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
