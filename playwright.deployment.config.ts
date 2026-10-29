import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/deployment",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180000,
  use: { baseURL: "http://127.0.0.1:8080", trace: "retain-on-failure" },
  projects: [
    {
      name: "container-chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
        viewport: { width: 1504, height: 1045 },
      },
    },
  ],
});
