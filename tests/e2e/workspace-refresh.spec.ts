import { test, expect } from "@playwright/test";

test("Source workspace refresh does not overlap slow reads and resumes after completion", async ({
  page,
}) => {
  await page.request.post("/api/auth/demo", { data: {} });
  const response = await page.request.get("/api/workspace");
  expect(response.ok()).toBeTruthy();
  const workspace = await response.json();
  // Only the browser response is a source-bound fixture. No external identity,
  // provider permissions or actual source API is replaced in this UI test.
  workspace.project.source = {
    provider: "nextcloud",
    roomId: "slow-refresh-fixture",
  };
  let refreshing = false,
    reads = 0,
    active = 0,
    maximum = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/workspace(?:\?.*)?$/, async (route) => {
    if (refreshing) {
      reads++;
      active++;
      maximum = Math.max(maximum, active);
      await gate;
      active--;
    }
    await route.fulfill({ json: workspace });
  });
  await page.clock.install();
  try {
    await page.goto("/");
    await expect(
      page.getByRole("navigation", { name: "工作区导航" }),
    ).toBeVisible();
    refreshing = true;
    await page.clock.runFor(10050);
    await expect.poll(() => reads).toBe(1);
    await page.clock.runFor(30000);
    expect(reads).toBe(1);
    expect(maximum).toBe(1);
    release();
    await expect.poll(() => active).toBe(0);
    // Allow the response and React update to finish before the next interval.
    await page.waitForLoadState("networkidle");
    await page.clock.runFor(10000);
    await expect.poll(() => reads).toBe(2);
    expect(maximum).toBe(1);
  } finally {
    release();
  }
});
