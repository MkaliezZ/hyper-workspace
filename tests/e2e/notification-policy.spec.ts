import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function settings(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "进入演示工作区" }).click();
  await expect(
    page.getByRole("heading", { name: "产品共创", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("应用导航", { exact: true })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await page.getByRole("tab", { name: "跟进提醒", exact: true }).click();
  return page.getByRole("region", { name: "跟进提醒", exact: true });
}
const policy = (revision = 0, rules: any = {}, admin = true) => ({
  layers: revision
    ? [{ scope: "personal", scopeId: "synthetic-employee", revision, rules }]
    : [],
  effective: {
    mode: rules.mode ?? "all",
    importantFields: rules.importantFields ?? [
      "added",
      "removed",
      "assignee",
      "status",
      "dueDate",
    ],
    minIntervalMinutes: rules.minIntervalMinutes ?? 0,
  },
  canManageShared: admin,
  recentChanges: [],
});

test("Reminder rules save directly and through AI with private receipts, inherited criteria and desktop/mobile controls", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "进入演示工作区" }).click();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  const name = "提醒验收 " + randomUUID().slice(0, 7);
  await page.getByLabel("项目名称", { exact: true }).fill(name);
  await page
    .getByLabel("当前目标", { exact: true })
    .fill("合成提醒项目，保护待通知变化");
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/projects") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  const project = await (await created).json();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page
    .getByLabel("应用导航", { exact: true })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await page.getByRole("tab", { name: "跟进提醒", exact: true }).click();
  const panel = page.getByRole("region", { name: "跟进提醒", exact: true });
  await panel.getByLabel("提醒规则范围").selectOption("project");
  await panel.getByLabel("提醒模式", { exact: true }).selectOption("important");
  await panel.getByLabel("自定义重要变化条件").check();
  const criteria = panel.getByRole("group", { name: "重要变化条件" });
  for (const checkbox of await criteria.getByRole("checkbox").all())
    await checkbox.uncheck();
  await criteria.getByLabel("状态", { exact: true }).check();
  await panel.getByLabel("最短合并间隔（分钟）").fill("30");
  await expect(
    panel.getByRole("button", { name: "保存提醒规则", exact: true }),
  ).toBeDisabled();
  await panel.getByRole("checkbox", { name: /我已核对提醒/ }).check();
  await panel
    .getByRole("button", { name: "保存提醒规则", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("提醒规则已保存");
  await expect(panel).toContainText("当前提醒版本：1");
  await expect(panel).toContainText("仅重要变化 · 合并间隔 30 分钟");
  await panel.getByLabel("提醒模式", { exact: true }).selectOption("quiet");
  await panel.getByLabel("提醒保存方式").selectOption("ai");
  await panel.getByLabel("提醒执行服务").selectOption("fixture");
  await panel.getByRole("checkbox", { name: /我已核对提醒/ }).check();
  const started = page.waitForResponse(
    (r) => r.url().endsWith("/api/runs") && r.request().method() === "POST",
  );
  await panel
    .getByRole("button", { name: "发起 AI 提醒配置", exact: true })
    .click();
  const run = await (await started).json();
  await expect(panel).toContainText("当前提醒版本：2", { timeout: 20000 });
  const actual = await (await page.request.get("/api/runs/" + run.id)).json();
  expect(actual.state).toBe("succeeded");
  expect(actual.result.receipts[0]).toMatchObject({
    scope: "project",
    revision: 2,
    rules: {
      mode: "quiet",
      importantFields: ["status"],
      minIntervalMinutes: 30,
    },
  });
  await panel
    .getByRole("button", { name: "AI 回读提醒规则", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText(
    "AI 已回读当前有效规则",
    { timeout: 20000 },
  );
  const view = await (
    await page.request.get(`/api/workspace?projectId=${project.id}`)
  ).json();
  expect(view.messages).toHaveLength(0);
  await panel.getByLabel("自定义重要变化条件").uncheck();
  await panel.getByLabel("最短合并间隔（分钟）").fill("");
  await panel.getByLabel("提醒模式", { exact: true }).selectOption("inherit");
  await panel.getByLabel("提醒保存方式").selectOption("direct");
  await panel.getByRole("checkbox", { name: /我已核对提醒/ }).check();
  const saved = page.waitForRequest(
    (r) => r.url().endsWith("/notification-policy") && r.method() === "POST",
  );
  await panel
    .getByRole("button", { name: "保存提醒规则", exact: true })
    .click();
  expect((await saved).postDataJSON().plan.rules).toEqual({});
  await expect(panel).toContainText("当前提醒版本：3");
  await page.screenshot({ path: info.outputPath("notification-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByLabel("提醒规则范围")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("notification-mobile.png") });
  expect(errors).toEqual([]);
});

test("An ambiguous reminder save freezes its canonical plan and retries exactly the same request key", async ({
  page,
}) => {
  const bodies: any[] = [];
  let revision = 0;
  await page.route("**/api/projects/*/notification-policy", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: policy(revision, { mode: "quiet" }) });
    bodies.push(route.request().postDataJSON());
    revision = 1;
    return bodies.length === 1
      ? route.fulfill({ status: 503, body: "" })
      : route.fulfill({ json: { revision: 1 } });
  });
  const panel = await settings(page);
  await panel.getByLabel("提醒模式", { exact: true }).selectOption("quiet");
  await panel.getByRole("checkbox", { name: /我已核对提醒/ }).check();
  await panel
    .getByRole("button", { name: "保存提醒规则", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "重试原提醒请求" }),
  ).toBeVisible();
  await expect(panel.getByLabel("提醒模式", { exact: true })).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "重新读取提醒规则" }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "重试原提醒请求" }).click();
  await expect(panel).toContainText("当前提醒版本：1");
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0].plan.rules).toEqual({ mode: "quiet" });
});

test("A stale reminder edit reloads the authoritative revision and requires fresh confirmation", async ({
  page,
}) => {
  let revision = 1;
  await page.route("**/api/projects/*/notification-policy", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: policy(revision, {
          mode: revision === 1 ? "important" : "quiet",
        }),
      });
    revision = 2;
    return route.fulfill({
      status: 409,
      json: { message: "提醒规则已变化，未覆盖新版本。" },
    });
  });
  const panel = await settings(page);
  await panel.getByLabel("提醒模式", { exact: true }).selectOption("all");
  await panel.getByRole("checkbox", { name: /我已核对提醒/ }).check();
  await panel
    .getByRole("button", { name: "保存提醒规则", exact: true })
    .click();
  await expect(panel).toContainText("当前提醒版本：2");
  await expect(panel.getByLabel("提醒模式", { exact: true })).toHaveValue(
    "quiet",
  );
  await expect(
    panel.getByRole("checkbox", { name: /我已核对提醒/ }),
  ).not.toBeChecked();
  await expect(
    panel.getByRole("button", { name: "重试原提醒请求" }),
  ).toHaveCount(0);
});

test("Source permission loss clears private preferences and excludes stale load responses", async ({
  page,
}) => {
  let reads = 0,
    deny = false,
    release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/projects/*/notification-policy", async (route) => {
    reads++;
    if (!deny) {
      await waiting;
      await route
        .fulfill({ json: policy(8, { mode: "quiet" }) })
        .catch(() => {});
    } else
      await route.fulfill({
        status: 403,
        json: { message: "当前来源权限已撤销。" },
      });
  });
  const panel = await settings(page);
  await expect.poll(() => reads).toBeGreaterThanOrEqual(1);
  deny = true;
  await panel.getByRole("button", { name: "重新读取提醒规则" }).click();
  await expect(panel.getByRole("alert")).toContainText("来源权限已撤销");
  release();
  await expect(panel.getByLabel("提醒规则范围")).toHaveCount(0);
  await page.getByRole("tab", { name: "模型连接", exact: true }).click();
  await page.getByRole("tab", { name: "跟进提醒", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("来源权限已撤销");
  await expect(panel.getByLabel("提醒规则范围")).toHaveCount(0);
});

test("Ordinary employees may read shared reminder rules and edit only their personal preference", async ({
  page,
}) => {
  await page.route("**/api/projects/*/notification-policy", (r) =>
    r.fulfill({ json: policy(1, { mode: "quiet" }, false) }),
  );
  const panel = await settings(page);
  await panel.getByLabel("提醒规则范围").selectOption("workspace");
  await expect(panel.getByLabel("提醒模式", { exact: true })).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "保存提醒规则", exact: true }),
  ).toBeDisabled();
  await panel.getByLabel("提醒规则范围").selectOption("personal");
  await expect(panel.getByLabel("提醒模式", { exact: true })).toBeEnabled();
  await expect(panel).toContainText("只约束由本人发起");
});

test("A lost AI admission can be recovered by the original private request key without submitting another Run", async ({
  page,
}) => {
  const id = randomUUID();
  let attempt: any,
    writes = 0;
  await page.route("**/api/projects/*/notification-policy", (r) =>
    r.fulfill({
      json: {
        ...policy(),
        recentRuns: attempt
          ? [
              {
                id,
                state: "succeeded",
                engine: "fixture",
                operation: "read",
                requestKey: attempt.idempotencyKey,
              },
            ]
          : [],
      },
    }),
  );
  await page.route("**/api/runs", (r) => {
    attempt = r.request().postDataJSON();
    writes++;
    return r.fulfill({ status: 503, body: "" });
  });
  await page.route("**/api/runs/" + id, (r) =>
    r.fulfill({
      json: {
        id,
        state: "succeeded",
        workflow: "manage_notifications",
        engine: "fixture",
        result: { text: "已回读有效提醒规则", receipts: [] },
      },
    }),
  );
  const panel = await settings(page);
  await panel.getByLabel("提醒执行服务").selectOption("fixture");
  await panel
    .getByRole("button", { name: "AI 回读提醒规则", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "重试原提醒请求" }),
  ).toBeVisible();
  await panel
    .getByRole("button", { name: "核对本人提醒操作", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "重试原提醒请求" }),
  ).toHaveCount(0);
  await expect(panel.getByRole("status")).toContainText(
    "AI 已回读当前有效规则",
  );
  expect(writes).toBe(1);
});
