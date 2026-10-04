import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // A temp folder for the run's profiles and fixtures, removed at the end.
    globalSetup: ["../../scripts/test-tmpdir.mjs"],
  },
});
