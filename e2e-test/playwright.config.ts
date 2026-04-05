import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,         // 2 min per test (on-chain ops are slow)
  expect: { timeout: 15_000 },
  fullyParallel: false,     // Sequential — tests depend on prior state
  retries: 1,
  workers: 1,               // Single worker — shared blockchain state
  reporter: [
    ["html", { outputFolder: "reports/html" }],
    ["json", { outputFile: "reports/results.json" }],
    ["list"],
  ],
  use: {
    baseURL: process.env.FRONTEND_URL || "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: undefined, // We use Docker — frontend is already running
});
