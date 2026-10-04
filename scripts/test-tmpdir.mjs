/**
 * A temp folder for one test run, removed when the run ends.
 *
 * Tests make their profiles and fixtures with `mkdtemp(join(tmpdir(), …))`
 * and mostly leave them behind: before this, runs had left eleven thousand
 * `pistachio-*` folders (6.7 GB) in the system temp folder. Rather than ask
 * every test to clean up after itself, the runner points TMPDIR at a folder
 * of the run's own before any worker starts — `os.tmpdir()` reads TMPDIR on
 * every call, and the workers (and the Electron apps they launch, which
 * inherit `process.env`) are spawned after this — and deletes that one
 * folder at the end.
 *
 * Used as a global setup by vitest (`globalSetup` in a package's
 * vitest.config.ts) and Playwright (apps/desktop/e2e/global-setup.ts); both
 * accept a setup that returns its teardown.
 *
 * PISTACHIO_KEEP_TEST_TMP=1 keeps the folder and says where it is, for
 * looking at a failed run's profiles.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup() {
  const previous = process.env["TMPDIR"];
  const dir = mkdtempSync(join(tmpdir(), "pistachio-test-run-"));
  process.env["TMPDIR"] = dir;
  return () => {
    if (previous === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = previous;
    if (process.env["PISTACHIO_KEEP_TEST_TMP"] === "1") {
      console.log(`Test temp files kept in ${dir}`);
      return;
    }
    rmSync(dir, { recursive: true, force: true });
  };
}
