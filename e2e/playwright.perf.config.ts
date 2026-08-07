import { defineConfig, devices } from "@playwright/test";

const harnessOnly = process.env.PICAN_PERF_HARNESS_ONLY === "1";

export default defineConfig({
  testDir: "./perf",
  testMatch: harnessOnly ? "harness.spec.ts" : "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  repeatEach: 1,
  timeout: 120_000,
  reporter: [["list"]],
  outputDir: "./test-results/perf",
  globalSetup: harnessOnly ? undefined : "./global-setup.ts",
  globalTeardown: harnessOnly ? undefined : "./global-teardown.ts",
  use: {
    ...devices["Pixel 5"],
    headless: process.env.PICAN_PERF_HEADED !== "1",
    trace: "retain-on-failure",
    video: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "Pixel 5 Chromium perf",
      use: {
        browserName: "chromium",
        launchOptions: {
          args: ["--enable-precise-memory-info"],
        },
      },
    },
  ],
});
