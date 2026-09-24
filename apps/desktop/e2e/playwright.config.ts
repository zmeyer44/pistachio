import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: "line",
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
