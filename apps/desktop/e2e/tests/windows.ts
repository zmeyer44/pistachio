import { expect, type ElectronApplication, type Page } from "@playwright/test";
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
 * stands on: the first tab is a web page with a native view over its pane,
 * and ⌘T asks for an address. A spec whose subject is something else seeds
 * these so its premise still holds; its own sections — its own home page,
 * its layout — win over them.
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
 * The chrome is on screen. Main has answered the first snapshot and one of
 * the two layouts (top tabs or sidebar) has mounted its ground — the one
 * element both layouts render, so this holds whatever `layout.mode` a spec
 * seeded.
 *
 * The agent console is NOT a launch readiness signal: `consoleOpenOnLaunch`
 * defaults to false, so a fresh profile opens with the console closed and
 * `agent-panel` unmounted. A spec that needs the console open asks for it —
 * seed `general.consoleOpenOnLaunch` in settings.json, or pick the footer
 * menu's `agent-panel-toggle` row.
 */
export async function shellReady(app: ElectronApplication): Promise<Page> {
  const shell = await shellPage(app);
  await shell.waitForLoadState("domcontentloaded");
  await expect(shell.getByTestId("chrome-layout-ground")).toBeVisible();
  return shell;
}
