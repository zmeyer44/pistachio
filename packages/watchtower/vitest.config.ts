import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A temp folder for the run's archives and fixtures, removed at the end.
    globalSetup: ["../../scripts/test-tmpdir.mjs"],
  },
});
