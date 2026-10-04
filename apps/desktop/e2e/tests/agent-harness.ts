import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { captureEnabled } from "./app";

/**
 * What the agent-console specs share: the shell's own snapshot, the page a
 * tab is showing, and the screenshots a person reviewing a change asks for
 * (PISTACHIO_E2E_CAPTURE=1). Nothing asserts on a screenshot, so a capture
 * helper returns at once — any settling wait with it — when capture is off.
 */

const screenshotRoot = join(process.cwd(), "e2e/screenshots");

/** The shell's snapshot, as the renderer reads it. */
export function snapshot(shell: Page): Promise<ShellSnapshot> {
  return shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot());
}

/** The active tab's address, or null. */
export async function activeTabUrl(shell: Page): Promise<string | null> {
  const current = await snapshot(shell);
  return current.tabs.find((tab) => tab.id === current.activeTabId)?.url ?? null;
}

/** Chromium may give a standard-scheme address a trailing slash; accept both. */
export function sameAddress(candidate: string | null, url: string): boolean {
  return candidate === url || candidate === `${url}/`;
}

/** The Electron page showing `url`, once one is. */
export async function pageAt(app: ElectronApplication, url: string): Promise<Page> {
  await expect.poll(() => app.windows().some((page) => sameAddress(page.url(), url))).toBe(true);
  const page = app.windows().find((candidate) => sameAddress(candidate.url(), url));
  if (page === undefined) throw new Error(`No Electron page at ${url}`);
  return page;
}

/**
 * The whole window — shell and the page views beside it — as the person
 * sees it, to e2e/screenshots/<folder>/<filename>. `settleMs` lets a motion
 * finish first; it is only waited when a capture is taken.
 */
export async function captureWindow(app: ElectronApplication, folder: string, filename: string, settleMs = 0): Promise<void> {
  if (!captureEnabled) return;
  if (settleMs > 0) await new Promise((done) => setTimeout(done, settleMs));
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await mkdir(join(screenshotRoot, folder), { recursive: true });
  await writeFile(join(screenshotRoot, folder, filename), Buffer.from(png, "base64"));
}

/**
 * The shell's own page, to e2e/screenshots/<folder>/<filename>. Animations
 * are frozen — a playing media card never settles — and it never hangs.
 */
export async function captureShell(shell: Page, folder: string, filename: string): Promise<void> {
  if (!captureEnabled) return;
  await mkdir(join(screenshotRoot, folder), { recursive: true });
  await shell.screenshot({ path: join(screenshotRoot, folder, filename), animations: "disabled", timeout: 15_000 });
}
