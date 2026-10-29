import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/nextcloud",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 15000 },
  use: {
    baseURL: "http://127.0.0.1:5173",
    ...devices["Desktop Chrome"],
    channel: "chromium",
    trace: "off",
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    timeout: 60000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
