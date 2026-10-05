import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication } from "@playwright/test";

/**
 * What every desktop spec needs to start the app, written once: the Electron
 * binary, a fresh profile seeded with the spec's settings, and the launch.
 * Profiles go under the run's own temp folder (scripts/test-tmpdir.mjs,
 * e2e/playwright.config.ts `globalSetup`), which is removed when the run
 * ends, so a spec does not clean up after itself.
 */

/**
 * The Electron binary: PISTACHIO_ELECTRON_PATH when set (a git worktree, whose
 * offline install skips the binary's download), else this package's own.
 * Undefined unless it is a complete app bundle.
 */
export function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [process.env["PISTACHIO_ELECTRON_PATH"], join(process.cwd(), "node_modules/electron", suffix)].find(
    (candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

/** The Electron binary, or a failure that says how to get one. */
export function electronExecutable(): string {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) {
    throw new Error("No complete Electron runtime is installed. Run pnpm install or set PISTACHIO_ELECTRON_PATH.");
  }
  return executablePath;
}

export interface LaunchOptions {
  /** settings.json for the profile, written before the launch. */
  settings?: Record<string, unknown>;
  /** Other files to seed in the profile, by path relative to it: JSON values are written as JSON. */
  files?: Record<string, unknown>;
  /** Added to the app's environment, after PISTACHIO_E2E and the profile. */
  env?: Record<string, string | undefined>;
  /** Extra command-line arguments after the app path. */
  args?: string[];
  /** Launch on an existing profile (a relaunch) instead of making one. */
  userData?: string;
  /** The profile folder's name prefix, which shows up in a kept run's temp folder. */
  name?: string;
  /**
   * Playwright's prefers-color-scheme emulation, laid on every page it attaches
   * to (light unless said). `null` lifts it: the pages answer to the app's
   * scheme (nativeTheme) and the OS, as they do outside a spec.
   */
  colorScheme?: null | "light" | "dark";
}

export interface LaunchedApp {
  app: ElectronApplication;
  userData: string;
}

/** A new profile under the run's temp folder. */
export function newProfile(name = "spec"): Promise<string> {
  return mkdtemp(join(tmpdir(), `pistachio-${name}-`));
}

/** Seed a profile and launch the app on it, in end-to-end mode. */
export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const userData = options.userData ?? (await newProfile(options.name));
  if (options.settings !== undefined) await writeFile(join(userData, "settings.json"), JSON.stringify(options.settings));
  for (const [path, content] of Object.entries(options.files ?? {})) {
    const target = join(userData, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, typeof content === "string" ? content : JSON.stringify(content));
  }
  const app = await electron.launch({
    args: [".", ...(options.args ?? [])],
    cwd: process.cwd(),
    executablePath: electronExecutable(),
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData, ...options.env },
    ...(options.colorScheme === undefined ? {} : { colorScheme: options.colorScheme }),
  });
  return { app, userData };
}

/**
 * Whether specs write their screenshots. Nothing asserts on them — they are
 * for a person reviewing a change — so a run writes none unless
 * PISTACHIO_E2E_CAPTURE=1. (Playwright keeps a screenshot of any failure
 * either way.) A capture helper returns at once, sleeps and all, when this
 * is false.
 */
export const captureEnabled = process.env["PISTACHIO_E2E_CAPTURE"] === "1";
