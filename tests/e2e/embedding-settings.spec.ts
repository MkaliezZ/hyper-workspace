import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

test("Embedding capacity is persisted and verified while chat connections omit the embedding option", async ({
  page,
}, testInfo) => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    expect(body.input.every((text: string) => text.length <= 400)).toBe(true);
    requests++;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: body.input.map((_: string, index: number) => ({
          index,
          embedding: [1, ...Array(511).fill(0)],
        })),
        usage: { prompt_tokens: 2, total_tokens: 2 },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "进入演示工作区" }).click();
    await page
      .getByLabel("应用导航", { exact: true })
      .getByRole("button", { name: "设置", exact: true })
      .click();
    const capacity = page.getByRole("spinbutton", {
      name: "向量模型单次输入上限（字符）",
      exact: true,
    });
    await expect(capacity).toHaveCount(0);
    await page
      .getByRole("combobox", { name: "模型用途", exact: true })
      .selectOption("embedding");
    await expect(capacity).toHaveValue("4000");
    await capacity.fill("400");
    const name = "合成中文向量连接 " + randomUUID().slice(0, 6);
    await page.getByLabel("连接名称", { exact: true }).fill(name);
    await page
      .getByLabel("服务地址", { exact: true })
      .fill(`http://127.0.0.1:${(server.address() as any).port}/v1`);
    await page
      .getByLabel("模型名称", { exact: true })
      .fill("synthetic-embedding-model");
    await page
      .getByLabel("API Key", { exact: true })
      .fill("synthetic-browser-embedding");
    const saved = page.waitForRequest(
      (r) => r.url().endsWith("/api/models") && r.method() === "POST",
    );
    await page
      .getByRole("button", { name: "保存连接（未验证）", exact: true })
      .click();
    expect((await saved).postDataJSON().embeddingInputChars).toBe(400);
    await page.reload();
    await page
      .getByLabel("应用导航", { exact: true })
      .getByRole("button", { name: "设置", exact: true })
      .click();
    const row = page
      .locator(".model-row")
      .filter({ has: page.getByText(name, { exact: true }) });
    await expect(row).toContainText("输入上限 400 字符");
    await row.getByRole("button", { name: "验证连接", exact: true }).click();
    await expect(row).toContainText("已验证连接");
    expect(requests).toBe(1);
    await page
      .getByRole("combobox", { name: "模型用途", exact: true })
      .selectOption("embedding");
    await capacity.fill("400");
    await page.screenshot({
      path: testInfo.outputPath("embedding-settings.png"),
      fullPage: true,
    });
    await page
      .getByRole("combobox", { name: "模型用途", exact: true })
      .selectOption("chat");
    await expect(capacity).toHaveCount(0);
    await page.getByLabel("连接名称", { exact: true }).fill(name + " chat");
    await page
      .getByLabel("服务地址", { exact: true })
      .fill("http://127.0.0.1:1/v1");
    await page.getByLabel("模型名称", { exact: true }).fill("synthetic-chat");
    const chat = page.waitForRequest(
      (r) => r.url().endsWith("/api/models") && r.method() === "POST",
    );
    await page
      .getByRole("button", { name: "保存连接（未验证）", exact: true })
      .click();
    expect((await chat).postDataJSON()).not.toHaveProperty(
      "embeddingInputChars",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
