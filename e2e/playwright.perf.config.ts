import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./perf",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [["list"]],
  outputDir: "./test-results/perf",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  use: {
    ...devices["Pixel 5"],
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
