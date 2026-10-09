import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, type ElectronApplication } from "@playwright/test";
import type { SidebarMode } from "@pistachio/shell-contracts/settings";
import { shellPage } from "./windows";

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
  /**
   * The sidebar's mode (`layout.sidebar`: whole, a rail, or hidden until the
   * pointer comes to the edge — docs/spaces.md §3), written into settings.json
   * before the launch, over what `settings` says (on a relaunch, into the
   * profile's own file). Unsaid, the profile's (whole, on a new one).
   */
  sidebar?: SidebarMode;
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
  /** The window's content size, set as soon as the app is up (the desk's specs stand on 1440 × 900). */
  size?: { width: number; height: number };
  /**
   * Move the window off the real cursor, if it rests over it: a drag's native
   * layer relays where the REAL pointer is, which is not Playwright's, so a
   * real cursor over the window would pull a drag to it (clearOfCursor).
   */
  clearOfCursor?: boolean;
  /**
   * The desk's Feel (DeskVariants, the More card's: its Frame, Throw, …), as
   * a person would have set it. The desk keeps it in the shell's own storage
   * (localStorage `pistachio.desk.v1`), which no profile file seeds, and reads
   * it as the shell loads: so it is written once the shell is up and the shell
   * is loaded again — a second cold start, the path a reload takes anyway
   * (docs/spaces.md §2). (Seeding it before the launch would need main to hand
   * the shell a seed; there is no such hook yet.) Settings a spec seeds win
   * over nothing here: the Feel is not a setting.
   */
  deskFeel?: DeskFeelSeed;
}

/** What `deskFeel` may seed: the desk's variants (packages/shell-ui lib/desk/store.ts DeskVariants), any of them. */
export interface DeskFeelSeed {
  physics?: "glide" | "snap" | "free";
  spring?: "snappy" | "bouncy" | "smooth" | "eased";
  motion?: "lifted" | "live";
  chrome?: "bar" | "tab" | "bare" | "drawer";
  grab?: "shift" | "alt" | "meta" | "off";
  layout?: "smart" | "hand";
  deceleration?: number;
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
  const settings = options.sidebar === undefined ? options.settings : await withSidebar(userData, options.settings, options.sidebar);
  if (settings !== undefined) await writeFile(join(userData, "settings.json"), JSON.stringify(settings));
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
  const size = options.size;
  if (size !== undefined)
    await app.evaluate(({ BrowserWindow }, { width, height }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(width, height);
    }, size);
  if (options.clearOfCursor === true) await clearOfCursor(app);
  if (options.deskFeel !== undefined) await seedDeskFeel(app, options.deskFeel);
  return { app, userData };
}

/** `settings` (or, unsaid, the profile's own settings.json) with the sidebar's mode in its layout. */
async function withSidebar(userData: string, settings: Record<string, unknown> | undefined, sidebar: SidebarMode): Promise<Record<string, unknown>> {
  const base = settings ?? (JSON.parse(await readFile(join(userData, "settings.json"), "utf8").catch(() => "{}")) as Record<string, unknown>);
  const layout = typeof base["layout"] === "object" && base["layout"] !== null ? (base["layout"] as Record<string, unknown>) : {};
  return { ...base, layout: { ...layout, sidebar } };
}

/**
 * Move the window off the real cursor, if it rests over it. A drag's native
 * layer relays where the REAL pointer is, and Playwright's pointer is not
 * that one: a real cursor over the window would pull a drag to it (and its
 * hover reach the sidebar).
 */
export async function clearOfCursor(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    const inside = cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width && cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height;
    if (!inside) return;
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    const x = cursor.x - area.x > bounds.width + 20 ? area.x : cursor.x + 20 + bounds.width <= area.x + area.width ? cursor.x + 20 : null;
    const y = cursor.y - area.y > bounds.height + 20 ? area.y : cursor.y + 20 + bounds.height <= area.y + area.height ? cursor.y + 20 : null;
    if (x !== null) window.setPosition(x, bounds.y);
    else if (y !== null) window.setPosition(bounds.x, y);
  });
}

/**
 * The desk's Feel written where the desk reads it (LaunchOptions.deskFeel),
 * over whatever is there, and the shell loaded again to read it.
 */
async function seedDeskFeel(app: ElectronApplication, feel: DeskFeelSeed): Promise<void> {
  const shell = await shellPage(app);
  await shell.waitForLoadState("domcontentloaded");
  await expect(shell.getByTestId("chrome-layout-ground")).toBeVisible();
  const variants = (): Promise<unknown> =>
    shell.evaluate(() => (JSON.parse(localStorage.getItem("pistachio.desk.v1") ?? "{}") as { variants?: unknown }).variants);
  await shell.evaluate((seed) => {
    const saved = JSON.parse(localStorage.getItem("pistachio.desk.v1") ?? "{}") as { variants?: Record<string, unknown> };
    localStorage.setItem("pistachio.desk.v1", JSON.stringify({ ...saved, version: 2, variants: { ...saved.variants, ...seed } }));
  }, feel);
  await shell.reload();
  await expect(shell.getByTestId("chrome-layout-ground")).toBeVisible();
  expect(await variants()).toMatchObject({ ...feel });
}

/**
 * Whether specs write their screenshots. Nothing asserts on them — they are
 * for a person reviewing a change — so a run writes none unless
 * PISTACHIO_E2E_CAPTURE=1. (Playwright keeps a screenshot of any failure
 * either way.) A capture helper returns at once, sleeps and all, when this
 * is false.
 */
export const captureEnabled = process.env["PISTACHIO_E2E_CAPTURE"] === "1";
