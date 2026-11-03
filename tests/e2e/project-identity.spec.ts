import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("Identical project names expose distinct goals and IDs and execute only in the selected conversation", async ({
  page,
}) => {
  await page.request.post("/api/auth/demo", { data: {} });
  const suffix = randomUUID().slice(0, 8);
  const name = "合成同名项目 " + suffix;
  const goals = ["合成第一目标 " + suffix, "合成第二目标 " + suffix];
  const projects = [];
  const messages = [];
  for (const goal of goals) {
    const response = await page.request.post("/api/projects", {
      data: { name, goal },
    });
    expect(response.ok()).toBeTruthy();
    const project = await response.json();
    projects.push(project);
    const message = await page.request.post(
      "/api/conversations/" + project.conversationId + "/messages",
      { data: { content: "仅属于 " + goal } },
    );
    expect(message.ok()).toBeTruthy();
    messages.push(await message.json());
  }
  await page.goto("/");
  const list = page.locator(".project-list");
  await expect(list.getByRole("button").filter({ hasText: name })).toHaveCount(
    2,
  );
  const first = list.getByRole("button", { name: new RegExp(goals[0]) });
  const second = list.getByRole("button", { name: new RegExp(goals[1]) });
  await expect(first).toContainText(projects[0].id.slice(0, 8));
  await expect(second).toContainText(projects[1].id.slice(0, 8));
  await first.click();
  await expect(
    page.getByText("仅属于 " + goals[0], { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("仅属于 " + goals[1], { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "发起任务", exact: true }).click();
  await page
    .getByRole("combobox", { name: "执行服务", exact: true })
    .selectOption("fixture");
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/runs") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  const response = await created;
  expect(response.request().postDataJSON().conversationId).toBe(
    projects[0].conversationId,
  );
  const started = await response.json();
  await expect(page.locator(".run-strip")).toContainText("已完成", {
    timeout: 20000,
  });
  const run = await (await page.request.get("/api/runs/" + started.id)).json();
  const receipt = run.result.receipts.find(
    (value: { tool: string }) => value.tool === "artifact.create",
  );
  expect(receipt?.id).toBeTruthy();
  const artifact = await (
    await page.request.get("/api/artifacts/" + receipt.id)
  ).json();
  expect(artifact.current.sourceMessageIds).toContain(messages[0].id);
  expect(artifact.current.sourceMessageIds).not.toContain(messages[1].id);
  const other = await (
    await page.request.get("/api/workspace?projectId=" + projects[1].id)
  ).json();
  expect(
    other.artifacts.some((row: { id: string }) => row.id === receipt.id),
  ).toBe(false);
  await second.click();
  await expect(
    page.getByText("仅属于 " + goals[1], { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("仅属于 " + goals[0], { exact: true }),
  ).toHaveCount(0);
});
