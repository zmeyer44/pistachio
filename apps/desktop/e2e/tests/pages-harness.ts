import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { captureEnabled } from "./app";
import { fromFrameMenu, reachFrame, windowSelector } from "./desk-harness";
import { liveViews } from "./windows";

/**
 * What the address, home, pages, site and popup specs share: finding a page
 * among the app's windows, reading main's tabs and views, the context menu
 * and the site-info popover, and the screenshots a person reviewing a change
 * asks for (PISTACHIO_E2E_CAPTURE=1, ./app.ts `captureEnabled`). Every
 * capture helper returns at once, sleeps and all, when that is off.
 */

const SCREENSHOTS = join(process.cwd(), "e2e/screenshots");

async function save(name: string, png: Buffer): Promise<void> {
  const path = join(SCREENSHOTS, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, png);
}

/**
 * The window as the shell draws it, saved as e2e/screenshots/`name`.
 * capturePage hands back the last frame composited, which can trail the DOM
 * by a beat: `settleMs` lets a fade or a just-made change land first.
 */
export async function captureShell(app: ElectronApplication, name: string, settleMs = 0): Promise<void> {
  if (!captureEnabled) return;
  if (settleMs > 0) await new Promise((done) => setTimeout(done, settleMs));
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await save(name, Buffer.from(png, "base64"));
}

/** A tab's own pixels — a native view the shell's capture does not show — found by its address. */
export async function captureView(app: ElectronApplication, urlPrefix: string, name: string): Promise<void> {
  if (!captureEnabled) return;
  const png = await app.evaluate(async ({ webContents }, prefix) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(prefix));
    if (contents === undefined) throw new Error(`No view shows ${prefix}`);
    return (await contents.capturePage()).toPNG().toString("base64");
  }, urlPrefix);
  await save(name, Buffer.from(png, "base64"));
}

/** Playwright's own screenshot of one page (a chrome view, a popup, a tab), saved as e2e/screenshots/`name`. */
export async function capturePage(
  page: Page,
  name: string,
  options: { fullPage?: boolean; settleMs?: number; animations?: "disabled" | "allow" } = {},
): Promise<void> {
  if (!captureEnabled) return;
  if (options.settleMs !== undefined) await new Promise((done) => setTimeout(done, options.settleMs));
  await mkdir(dirname(join(SCREENSHOTS, name)), { recursive: true });
  await page.screenshot({ path: join(SCREENSHOTS, name), fullPage: options.fullPage, animations: options.animations });
}

/**
 * The newest open page whose address matches — a URL, or a test of the page.
 * Newest, because a page just closed (a tab replaced, a Glance dismissed) can
 * linger in the list for a moment beside the one that took its place.
 */
export async function pageAt(app: ElectronApplication, match: string | ((page: Page) => boolean)): Promise<Page> {
  const matches = typeof match === "string" ? (page: Page) => page.url() === match : match;
  const newest = () => app.windows().filter((page) => !page.isClosed() && matches(page)).at(-1);
  await expect.poll(() => newest() !== undefined, { message: `no page at ${String(match)}` }).toBe(true);
  return newest()!;
}

/** Tab views main is showing, live (the chrome's own views excluded): none while the shell draws the page (home, the brief) or a still. */
export async function visibleTabViews(app: ElectronApplication): Promise<number> {
  return (await liveViews(app)).length;
}

/** The person's tabs, in order (the agent's left out). */
export function humanTabs(shell: Page): Promise<Array<{ id: string; url: string; title: string; anchorId: string | null }>> {
  return shell.evaluate(async () => {
    const snapshot = await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot();
    return snapshot.tabs.filter((tab) => tab.kind === "human").map(({ id, url, title, anchorId }) => ({ id, url, title, anchorId }));
  });
}

/** The address of the tab in front, or null. */
export function activeUrl(shell: Page): Promise<string | null> {
  return shell.evaluate(async () => {
    const snapshot = await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot();
    return snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId)?.url ?? null;
  });
}

/** Open `url` in a new tab and close every other: a test's clean start on a window that has been used. */
export async function openAlone(shell: Page, url: string): Promise<void> {
  await shell.evaluate(async (target) => {
    const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
    const before = await api.getSnapshot();
    await api.createTab(target);
    for (const tab of before.tabs) await api.closeTab(tab.id);
  }, url);
}

/** Right-click a row or tile and pick a menu item by name. */
export async function pick(shell: Page, target: Locator, item: string | RegExp): Promise<void> {
  await target.click({ button: "right" });
  const menu = shell.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: item }).click();
  await expect(menu).toHaveCount(0);
}

/**
 * The site-info popover of the tab in use, opened as a person does on the
 * desk: from its window's ⋯ (the frame's menu, desk-harness's fromFrameMenu),
 * the frame brought within reach first (a Drawer that is in comes out).
 */
export async function openSiteInfo(shell: Page, app: ElectronApplication): Promise<Locator> {
  const tabId = await shell.evaluate(async () => (await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot()).activeTabId);
  if (tabId === null) throw new Error("no tab in use to show the site of");
  await reachFrame(app, shell, tabId);
  await fromFrameMenu(shell, windowSelector(tabId), "desk-page-site-info");
  const popover = shell.getByTestId("site-info-popover");
  await expect(popover).toBeVisible();
  return popover;
}
