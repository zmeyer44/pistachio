import { expect, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES, type ChromeViewId } from "@pistachio/shell-contracts/chrome";

/**
 * The app renders the shell window plus one page per chrome view — the
 * WebContentsViews above the tab views (drag capture, find, the bookmark
 * card, and the notice stack), each
 * loading the renderer with a hash naming it
 * (main/chrome-view.ts). Playwright lists all of them as "windows", in
 * whichever order they finish loading — so pick by URL, never by position.
 *
 * The shell is defined as the page that is NOT any chrome view, read off
 * CHROME_VIEW_HASHES rather than a list written out here: a new view added
 * to that record would otherwise silently answer to `shellPage`.
 */
function isChromeView(page: Page, view: ChromeViewId): boolean {
  return page.url().endsWith(CHROME_VIEW_HASHES[view]);
}

function isShell(page: Page): boolean {
  return !Object.values(CHROME_VIEW_HASHES).some((hash) => page.url().endsWith(hash));
}

async function pageWhere(app: ElectronApplication, predicate: (page: Page) => boolean): Promise<Page> {
  const found = app.windows().find(predicate);
  if (found !== undefined) return found;
  return app.waitForEvent("window", { predicate });
}

/**
 * The settings a spec written before the home page (@pistachio/shell-contracts/home)
 * stands on: the first tab is a web page, a native view over its window on
 * the desk. A spec whose subject is something else seeds these so its
 * premise still holds; its own sections — its own home page, its layout —
 * win over them.
 *
 * (`newTab: "address"` is the web's since 2026-10-09: on the desktop the desk
 * is always up, and ⌘T always puts a new tab out on it as a window on the
 * home page — docs/spaces.md §1. It no longer asks for an address there;
 * the seed is kept for the web's specs, and is harmless here.)
 */
export function pageFirst(settings: { general?: Record<string, unknown> } & Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...settings,
    general: { homePage: "url", homeUrl: "https://www.google.com/", newTab: "address", ...settings.general },
  };
}

export const shellPage = (app: ElectronApplication): Promise<Page> => pageWhere(app, isShell);
export const dragPage = (app: ElectronApplication): Promise<Page> =>
  pageWhere(app, (page) => isChromeView(page, "drag"));
export const findPage = (app: ElectronApplication): Promise<Page> =>
  pageWhere(app, (page) => isChromeView(page, "find"));
export const bookmarkToastPage = (app: ElectronApplication): Promise<Page> =>
  pageWhere(app, (page) => isChromeView(page, "bookmark"));
export const noticePage = (app: ElectronApplication): Promise<Page> =>
  pageWhere(app, (page) => isChromeView(page, "notice"));

/**
 * The chrome is on screen, and the desk with it: main has answered the first
 * snapshot, the sidebar layout has mounted its ground (in whichever mode
 * `layout.sidebar` a spec seeded), and the desk — the desktop's surface
 * since 2026-10-09, always up (docs/spaces.md) — shows the current space,
 * open (its windows may still be coming to rest: desk-harness's settled).
 *
 * The agent console is NOT a launch readiness signal: `consoleOpenOnLaunch`
 * defaults to false, so a fresh profile opens with the console closed and
 * `agent-panel` unmounted. A spec that needs the console open asks for it —
 * seed `general.consoleOpenOnLaunch` in settings.json, or send the shell
 * `openConsole` (on the desk ⌘I asks the desk's Bar instead).
 */
export async function shellReady(app: ElectronApplication): Promise<Page> {
  const shell = await shellPage(app);
  await shell.waitForLoadState("domcontentloaded");
  await expect(shell.getByTestId("chrome-layout-ground")).toBeVisible();
  await expect(shell.getByTestId("desk-surface")).toBeAttached();
  await expect(shell.locator('.desk-stage[data-phase="open"]')).toHaveCount(1);
  return shell;
}

/**
 * The tab views main has on screen, bottom to top, with their boxes — the
 * pages, live, not their stills; the chrome's own views (CHROME_VIEW_HASHES)
 * left out. Every spec's one read of what main shows.
 */
export function liveViews(app: ElectronApplication): Promise<Array<{ url: string; bounds: { x: number; y: number; width: number; height: number } }>> {
  return app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return window.contentView.children.flatMap((child) => {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return [];
      const url = (child as WebContentsView).webContents.getURL();
      return Object.values(hashes).some((hash) => url.endsWith(hash)) ? [] : [{ url, bounds: (child as WebContentsView).getBounds() }];
    });
  }, CHROME_VIEW_HASHES);
}
