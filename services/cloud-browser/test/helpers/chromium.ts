/**
 * Chromium for the Playwright-gated suites: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
 * when set, else the build Playwright's registry knows. Suites skip only
 * when neither exists on disk.
 */

import { existsSync } from "node:fs";
import { describe } from "vitest";
import { registryChromiumPath } from "../../src/config.js";

export function chromiumPath(): string | null {
  const fromEnv = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return existsSync(fromEnv) ? fromEnv : null;
  return registryChromiumPath();
}

export const CHROMIUM = chromiumPath();

/** `describe` when Chromium is available, `describe.skip` otherwise. */
export const describeChromium = CHROMIUM === null ? describe.skip : describe;
