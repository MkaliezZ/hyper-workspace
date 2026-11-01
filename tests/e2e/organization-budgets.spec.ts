import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { modelFixture } from "../runtime/business-contract.js";
async function open(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "进入演示工作区" }).click();
  await expect(
    page.getByRole("heading", { name: "产品共创", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  const name = "企业预算合成验收 " + randomUUID().slice(0, 7);
  await page.getByLabel("项目名称", { exact: true }).fill(name);
  await page
    .getByLabel("当前目标", { exact: true })
    .fill("合成预算界面验收，不是公司账单");
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
  await page.getByRole("tab", { name: "企业预算", exact: true }).click();
  return {
    project,
    panel: page.getByRole("region", { name: "企业预算", exact: true }),
  };
}

test("Company price approval and cross-connection project budgets support direct and native AI actions, deny before HTTP and remain usable on mobile", async ({
  page,
}, info) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const key = "synthetic-budget-ui-" + randomUUID(),
    privateNote = "synthetic-private-company-price-" + randomUUID();
  const fixture = modelFixture(
    [key],
    (body) => {
      expect(JSON.stringify(body.messages)).not.toContain(privateNote);
    },
    () => ({
      text: "Synthetic native budget result",
      actions: [{ tool: "spending.manage", args: {} }],
    }),
  );
  await new Promise<void>((r) => fixture.server.listen(0, "127.0.0.1", r));
  try {
    const { project, panel } = await open(page),
      endpoint =
        "http://127.0.0.1:" + (fixture.server.address() as any).port + "/v1";
    const response = await page.request.post("/api/models", {
      data: {
        name: "Synthetic company budget UI",
        provider: "openai-compatible",
        endpoint,
        model: "native-test-model",
        apiKey: key,
        purpose: "chat",
        scope: "personal",
      },
    });
    expect(response.ok()).toBeTruthy();
    const profile = await response.json();
    await panel
      .getByLabel("企业费用操作", { exact: true })
      .selectOption("prices");
    await panel.getByLabel("企业模型地址", { exact: true }).fill(endpoint);
    await panel
      .getByLabel("企业模型名称", { exact: true })
      .fill("native-test-model");
    await panel.getByLabel("企业计价币种", { exact: true }).selectOption("USD");
    for (const label of [
      "企业普通输入单价 / 百万 token",
      "企业输出单价 / 百万 token",
      "企业缓存读取单价 / 百万 token",
      "企业缓存写入单价 / 百万 token",
    ])
      await panel.getByLabel(label, { exact: true }).fill("1");
    await panel.getByLabel("企业计价依据", { exact: true }).fill(privateNote);
    await expect(
      panel.getByRole("button", { name: "保存企业费用操作", exact: true }),
    ).toBeDisabled();
    await panel.getByRole("checkbox", { name: /我已核对企业范围/ }).check();
    await panel
      .getByRole("button", { name: "保存企业费用操作", exact: true })
      .click();
    await expect(panel.getByRole("status")).toContainText("操作已保存");
    await panel
      .getByLabel("企业费用操作", { exact: true })
      .selectOption("limits");
    await panel.getByLabel("企业预算币种", { exact: true }).selectOption("USD");
    await panel.getByLabel("企业每日预算上限", { exact: true }).fill("0");
    await panel.getByLabel("企业每请求预留金额", { exact: true }).fill("0.004");
    await panel.getByRole("checkbox", { name: /我已核对企业范围/ }).check();
    await panel
      .getByRole("button", { name: "保存企业费用操作", exact: true })
      .click();
    await expect(panel).toContainText("当前企业预算版本：1");
    await panel.getByLabel("企业每日预算上限", { exact: true }).fill("1");
    await panel
      .getByLabel("企业费用保存方式", { exact: true })
      .selectOption("ai");
    await panel
      .getByLabel("企业费用执行服务", { exact: true })
      .selectOption("dsh");
    await panel
      .getByLabel("企业费用执行连接", { exact: true })
      .selectOption(profile.id);
    await panel.getByRole("checkbox", { name: /我已核对企业范围/ }).check();
    let started = page.waitForResponse(
      (r) => r.url().endsWith("/api/runs") && r.request().method() === "POST",
    );
    await panel
      .getByRole("button", { name: "发起 AI 企业费用操作", exact: true })
      .click();
    const blocked = await (await started).json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/runs/" + blocked.id)).json())
            .state,
        { timeout: 60000 },
      )
      .toBe("failed");
    expect(fixture.calls()).toBe(0);
    await expect(panel.getByRole("status")).toContainText("未完成");
    await panel
      .getByLabel("企业费用保存方式", { exact: true })
      .selectOption("direct");
    await panel.getByRole("checkbox", { name: /我已核对企业范围/ }).check();
    await panel
      .getByRole("button", { name: "保存企业费用操作", exact: true })
      .click();
    await expect(panel).toContainText("当前企业预算版本：2");
    await panel.getByLabel("企业每日预算上限", { exact: true }).fill("0.5");
    await panel
      .getByLabel("企业费用保存方式", { exact: true })
      .selectOption("ai");
    await panel.getByRole("checkbox", { name: /我已核对企业范围/ }).check();
    started = page.waitForResponse(
      (r) => r.url().endsWith("/api/runs") && r.request().method() === "POST",
    );
    await panel
      .getByRole("button", { name: "发起 AI 企业费用操作", exact: true })
      .click();
    const successful = await (await started).json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/runs/" + successful.id)).json())
            .state,
        { timeout: 60000 },
      )
      .toBe("succeeded");
    await expect(panel).toContainText("当前企业预算版本：3");
    expect(fixture.calls()).toBe(1);
    const actual = await (
      await page.request.get(
        "/api/organization-budgets?projectId=" + project.id,
      )
    ).json();
    expect(
      actual.controls.find((c: any) => c.scope === "project"),
    ).toMatchObject({ revision: 3, dailyLimit: "0.5", currency: "USD" });
    expect(
      actual.charges.filter((c: any) => c.projectId === project.id),
    ).toHaveLength(1);
    await expect(panel).toContainText("今日企业金额（分币种）");
    await panel.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: info.outputPath("organization-budget-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      panel.getByLabel("企业每日预算上限", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await panel.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: info.outputPath("organization-budget-mobile.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    fixture.server.closeAllConnections();
    await new Promise<void>((r) => fixture.server.close(() => r()));
  }
});

test("Company budget history reads preserve draft versions and permission loss discards private drafts plus late responses", async ({
  page,
}) => {
  const state: any = { revision: 1, limit: "1", denied: false, hold: false };
  let release = () => {},
    arrived = () => {};
  const waiting = new Promise<void>((r) => {
    arrived = r;
  });
  const prices = [
    {
      priceKey: "synthetic-price-key",
      revision: 1,
      provider: "openai-compatible",
      endpoint: "https://synthetic.invalid",
      model: "Synthetic private model",
      purpose: "chat",
      currency: "USD",
      inputPerMillion: "1",
      outputPerMillion: "1",
      cacheReadPerMillion: "1",
      cacheWritePerMillion: "1",
      source: "synthetic-private-source-note",
    },
  ];
  const data = () => ({
    controls: ["workspace", "project"].map((scope) => ({
      scope,
      projectId: scope === "workspace" ? null : "synthetic-project",
      revision: scope === "project" ? state.revision : 0,
      currency: "USD",
      dailyLimit: scope === "project" ? state.limit : null,
      requestReservation: "0.01",
      balance: {
        known: "0",
        held: "0",
        unknown: 0,
        review: 0,
        mismatched: 0,
        remaining: state.limit,
      },
    })),
    prices,
    charges: [],
    nextBefore: null,
    history: [],
    note: "Synthetic company budget fixture",
  });
  await page.route("**/api/organization-budgets?*", async (route) => {
    const snapshot = data();
    if (state.denied)
      return route.fulfill({
        status: 403,
        json: { message: "合成测试：企业管理权限已撤销。" },
      });
    if (state.hold) {
      state.hold = false;
      arrived();
      await new Promise<void>((r) => {
        release = r;
      });
    }
    await route.fulfill({ json: snapshot });
  });
  const posted: any[] = [];
  await page.route("**/api/model-spending", async (route) => {
    const body = route.request().postDataJSON();
    posted.push(body);
    if (body.plan.expectedRevision !== state.revision)
      return route.fulfill({
        status: 409,
        json: { message: "合成测试：企业版本已变化，请重新读取。" },
      });
    state.revision++;
    state.limit = body.plan.dailyLimit;
    await route.fulfill({
      json: {
        tool: "spending.manage",
        operation: "budget_configure",
        revision: state.revision,
      },
    });
  });
  const { panel } = await open(page);
  await panel.getByLabel("企业每日预算上限", { exact: true }).fill("0.9");
  state.revision = 2;
  state.limit = "0.5";
  await panel
    .getByRole("button", { name: "重新读取企业账本", exact: true })
    .click();
  await expect(panel).toContainText("当前企业预算版本：2 · 表单依据版本：1");
  await expect(
    panel.getByLabel("企业每日预算上限", { exact: true }),
  ).toHaveValue("0.9");
  await panel.getByRole("checkbox", { name: /我已核对企业范围/ }).check();
  await panel
    .getByRole("button", { name: "保存企业费用操作", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("版本已变化");
  expect(posted[0].plan.expectedRevision).toBe(1);
  await panel
    .getByRole("button", { name: "将当前额度读入表单", exact: true })
    .click();
  await expect(
    panel.getByLabel("企业每日预算上限", { exact: true }),
  ).toHaveValue("0.5");
  await panel.getByLabel("企业每日预算上限", { exact: true }).fill("0.8");
  await panel.getByRole("checkbox", { name: /我已核对企业范围/ }).check();
  await panel
    .getByRole("button", { name: "保存企业费用操作", exact: true })
    .click();
  await expect(panel).toContainText("当前企业预算版本：3");
  expect(posted[1].plan.expectedRevision).toBe(2);
  await panel
    .getByLabel("企业费用操作", { exact: true })
    .selectOption("prices");
  await panel
    .getByLabel("企业计价条目", { exact: true })
    .selectOption("synthetic-price-key");
  await panel
    .getByLabel("企业计价依据", { exact: true })
    .fill("synthetic-private-unsaved-draft");
  prices[0]!.revision = 2;
  await panel
    .getByRole("button", { name: "重新读取企业账本", exact: true })
    .click();
  await expect(panel.getByLabel("企业计价依据", { exact: true })).toHaveValue(
    "synthetic-private-unsaved-draft",
  );
  await expect(panel).toContainText("表单计价依据版本：1");
  await panel.getByRole("checkbox", { name: /我已核对企业范围/ }).check();
  await panel
    .getByRole("button", { name: "保存企业费用操作", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("版本已变化");
  expect(posted[2].plan.expectedRevision).toBe(1);
  state.hold = true;
  await panel
    .getByRole("button", { name: "重新读取企业账本", exact: true })
    .click();
  await waiting;
  state.denied = true;
  await panel
    .getByRole("button", { name: "重新读取企业账本", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("权限已撤销");
  release();
  await expect(panel.getByLabel("企业计价依据", { exact: true })).toHaveCount(
    0,
  );
  await expect(panel).not.toContainText("synthetic-private");
  await expect(panel.getByLabel("企业费用操作", { exact: true })).toHaveCount(
    0,
  );
});
