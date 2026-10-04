import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  // A temp folder for the run's profiles, removed when it ends (e2e/tests/app.ts).
  globalSetup: "../../../scripts/test-tmpdir.mjs",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: "line",
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
