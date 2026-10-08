import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES, type ChromeViewId } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import type { TabGroupColor, TabGroupCommand } from "@pistachio/shell-contracts/tab-groups";
import { captureEnabled, launchApp, type LaunchOptions } from "./app";
import { pageFirst, shellReady } from "./windows";

/**
 * What the desk's specs share (docs/desk.md): the launch at the desk's own
 * size, tabs and groups made through the shell's API, the desk opened from
 * a group's row, the wait for its windows to come to rest, and the
 * screenshots a person reviewing a change may ask for.
 */

export const INVOICES = "pistachio://demo/invoices";
export const VENDOR = "pistachio://demo/vendors/atlas-medical";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

type WithPistachio = { pistachio: PistachioApi };

export function api<T>(shell: Page, call: (pistachio: PistachioApi) => Promise<T>): Promise<T> {
  return shell.evaluate(`(${call.toString()})(window.pistachio)`) as Promise<T>;
}

export const snapshot = (shell: Page): Promise<ShellSnapshot> => api(shell, (pistachio) => pistachio.getSnapshot());

export const createTab = (shell: Page, url: string): Promise<unknown> =>
  shell.evaluate((address) => (window as unknown as WithPistachio).pistachio.createTab(address), url);

export const selectTab = (shell: Page, tabId: string): Promise<unknown> =>
  shell.evaluate((id) => (window as unknown as WithPistachio).pistachio.selectTab(id), tabId);

export const tabGroupCommand = (shell: Page, command: TabGroupCommand): Promise<unknown> =>
  shell.evaluate((body) => (window as unknown as WithPistachio).pistachio.tabGroupCommand(body), command);

export const createGroup = (shell: Page, id: string, tabIds: readonly string[], title: string, color: TabGroupColor): Promise<unknown> =>
  tabGroupCommand(shell, { type: "create", id, tabIds: [...tabIds], title, color });

/**
 * A tab on each address not open yet, every one of them there before this
 * returns: their ids, in the order given (an address open twice: its last).
 */
export async function openTabs(shell: Page, urls: readonly string[]): Promise<string[]> {
  const open = new Set((await snapshot(shell)).tabs.map((tab) => tab.url));
  for (const url of urls) if (!open.has(url)) await createTab(shell, url);
  await expect.poll(async () => {
    const now = new Set((await snapshot(shell)).tabs.map((tab) => tab.url));
    return urls.filter((url) => !now.has(url));
  }).toEqual([]);
  const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
  return urls.map((url) => byUrl.get(url)!);
}

export interface DeskLaunch {
  app: ElectronApplication;
  shell: Page;
  userData: string;
}

/** A desk window's frame (the Feel's Frame; the shell's DeskChrome). */
export type DeskFrame = "bar" | "tab" | "bare" | "drawer";

/**
 * The app at the desk's size (1440 × 900), off the real cursor, its chrome
 * up and — on a new profile — its first tab on `homeUrl` (the demo's
 * invoices unless said), seeded so the first tab is a page, and its desk
 * windows framed by `chrome`: the Title bar unless said, the frame the
 * desk's specs were written for (the default until 2026-10-07, when the
 * Drawer became it).
 */
export async function launchDesk(options: Omit<LaunchOptions, "settings"> & { homeUrl?: string; chrome?: DeskFrame } = {}): Promise<DeskLaunch> {
  const { homeUrl = INVOICES, chrome = "bar", ...launch } = options;
  const fresh = launch.userData === undefined;
  const { app, userData } = await launchApp({
    ...launch,
    name: `desk-${launch.name ?? "spec"}`,
    settings: fresh ? pageFirst({ onboarding: { completed: true, completedAt: null }, general: { homeUrl } }) : undefined,
  });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
  });
  await clearOfCursor(app);
  const shell = await shellReady(app);
  if (fresh) await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === homeUrl)).toBe(true);
  if (fresh && chrome !== "drawer") await frameDeskWindows(shell, chrome);
  return { app, shell, userData };
}

/**
 * Frame the desk's windows with `chrome`, as the More card's Feel would:
 * the desk keeps its Feel in the shell's storage and reads it as the shell
 * loads, so it is written there and the shell loaded again.
 */
async function frameDeskWindows(shell: Page, chrome: DeskFrame): Promise<void> {
  const framed = (): Promise<unknown> =>
    shell.evaluate(() => (JSON.parse(localStorage.getItem("pistachio.desk.v1") ?? "{}") as { variants?: { chrome?: unknown } }).variants?.chrome);
  await shell.evaluate((chrome) => {
    const saved = JSON.parse(localStorage.getItem("pistachio.desk.v1") ?? "{}") as { variants?: Record<string, unknown> };
    localStorage.setItem("pistachio.desk.v1", JSON.stringify({ ...saved, version: 2, variants: { ...saved.variants, chrome } }));
  }, chrome);
  await shell.reload();
  await expect(shell.getByTestId("chrome-layout-ground")).toBeVisible();
  expect(await framed()).toBe(chrome);
}

/** A tab group's row in the sidebar (its icon on the rail). */
export const groupSelector = (groupId: string): string => `[data-testid="tab-group"][data-group-id="${groupId}"]`;

/** Open a group's desk from its row: its header's desk button. */
export async function openGroupDesk(shell: Page, groupId: string): Promise<void> {
  const group = shell.locator(groupSelector(groupId));
  await group.getByTestId("tab-group-header").hover();
  await group.getByTestId("tab-group-desk").click();
}

export const windowSelector = (tabId: string): string => `[data-testid="desk-window"][data-tab-id="${tabId}"]`;
/** A tab's row in the sidebar — the desk's dock — whether it is drawn whole or as the rail. */
export const rowSelector = (tabId: string): string => `[data-testid="sidebar-tab-list"] [role="tab"][data-tab-id="${tabId}"]`;

export async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).first().boundingBox();
  if (found === null) throw new Error(`${selector} has no box`);
  return found;
}

export function center(rect: Box): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** One of a window's less-used controls, on its frame's menu (⋯): mask, minimize, a document's own. */
export async function fromFrameMenu(shell: Page, win: string | Locator, testId: string): Promise<void> {
  await (typeof win === "string" ? shell.locator(win) : win).getByTestId("desk-window-more").click();
  await shell.locator(`[data-testid="context-menu"] [data-testid="${testId}"]`).click();
}

/** The desk's card up: its button in the sidebar hovered, and the card drawn once the pages under it have given way. */
export async function openMore(shell: Page): Promise<void> {
  await shell.getByTestId("desk-more").hover();
  await expect(shell.locator('[data-testid="desk-more-card"][data-shown]')).toHaveCount(1);
}

/** Leave the desk: its way out is on the More card. */
export async function leaveDesk(shell: Page): Promise<void> {
  await openMore(shell);
  await shell.getByTestId("desk-leave").click();
}

/** The nub's menu let out, as a click on the nub lets it out: its droplets (the prompt, the microphone, past chats), drawn once the pages under them have given way. */
export async function openNubMenu(shell: Page): Promise<void> {
  const nub = shell.getByTestId("desk-nub");
  if ((await nub.getAttribute("aria-expanded")) !== "true") {
    await nub.hover();
    await nub.click();
  }
  await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(1);
}

/** The Bar's pill out of the nub's prompt droplet, as a person opens it, so its field and buttons can be used. */
export async function reachBar(shell: Page): Promise<void> {
  const bar = shell.getByTestId("desk-bar");
  if ((await bar.getAttribute("data-compact")) !== null) {
    await openNubMenu(shell);
    await shell.getByTestId("desk-nub-prompt").click();
  }
  await expect(bar).not.toHaveAttribute("data-compact", "");
}

/** The conversations, grown out of the nub's past-chats droplet. */
export async function openChats(shell: Page): Promise<void> {
  await openNubMenu(shell);
  await shell.getByTestId("desk-nub-chats").click();
  await expect(shell.locator('[data-testid="desk-conversations"][data-shown]')).toHaveCount(1);
}

/** The pill's tray let out, as the pointer on its plus lets it out: attach, a new conversation. */
export async function openTray(shell: Page): Promise<void> {
  await reachBar(shell);
  await shell.getByTestId("desk-bar-more").hover();
  await expect(shell.getByTestId("desk-bar-tray")).toHaveAttribute("data-open", "");
}

/** The tab views main has on screen, bottom to top, with their boxes. */
export function liveViews(app: ElectronApplication): Promise<Array<{ url: string; bounds: Box }>> {
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

/** How long the desk's windows must hold still, watched from the call, to be at rest. */
const QUIET_MS = 200;

/**
 * The desk is at rest: nothing entering, nothing in hand, nothing still
 * flying — and then the springs' tail: every window's box (the engine's
 * frame loop writes it into the window's style) and what it shows unchanged
 * for QUIET_MS, watched from now, so a motion an action has yet to start
 * still counts. With `app`, main's views too: the same over two reads, the
 * last layout applied.
 */
export async function settled(shell: Page, app?: ElectronApplication): Promise<void> {
  await expect(shell.locator('.desk-stage[data-phase="open"]')).toHaveCount(1);
  await expect(shell.locator(".desk-stage[data-gesture]")).toHaveCount(0);
  await expect(shell.locator('[data-testid="desk-window"][data-flight]')).toHaveCount(0);
  await shell.waitForFunction(
    ({ quiet, token }) => {
      const stage = document.querySelector(".desk-stage")?.getBoundingClientRect();
      const windows = [...document.querySelectorAll<HTMLElement>('[data-testid="desk-window"]')].map((el) =>
        [el.dataset["tabId"], el.getAttribute("style"), el.dataset["drawn"], el.dataset["mini"], el.dataset["masked"], el.dataset["focused"]].join("|"),
      );
      const signature = JSON.stringify([stage?.x, stage?.y, stage?.width, stage?.height, windows]);
      const state = window as unknown as { __deskQuiet?: { token: number; signature: string; since: number } };
      const now = performance.now();
      if (state.__deskQuiet?.token !== token || state.__deskQuiet.signature !== signature) {
        state.__deskQuiet = { token, signature, since: now };
        return false;
      }
      return now - state.__deskQuiet.since >= quiet;
    },
    { quiet: QUIET_MS, token: Math.random() },
    { polling: 40, timeout: 10_000 },
  );
  if (app === undefined) return;
  let last: string | null = null;
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await liveViews(app));
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [50] },
    )
    .toBe(true);
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

export type Capture = (app: ElectronApplication, shell: Page, filename: string, settleMs?: number, crop?: Box) => Promise<void>;

/**
 * A spec's screenshots, in e2e/screenshots/<folder>/ (or `folder` itself,
 * when it is absolute): the window as a person sees it — the shell with
 * every live page (and any chrome view named in `also`) composited over it
 * at its box, in stacking order; Playwright's own screenshot is the shell's
 * document alone — or `crop` of it (the window's own coordinates). Nothing
 * asserts on them, so they are taken only when captureEnabled
 * (PISTACHIO_E2E_CAPTURE=1), the wait for the last paint with them.
 */
export function screenshots(folder: string, also: readonly ChromeViewId[] = []): Capture {
  const directory = isAbsolute(folder) ? folder : join(process.cwd(), "e2e/screenshots", folder);
  return async (app, shell, filename, settleMs = 400, crop) => {
    if (!captureEnabled) return;
    await mkdir(directory, { recursive: true });
    // capturePage can hand back a frame from before the latest paint.
    await shell.waitForTimeout(settleMs);
    const layers = await app.evaluate(
      async ({ BrowserWindow }, { hashes, shown }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window === undefined) throw new Error("Pistachio window is unavailable");
        const base = (await window.capturePage()).toDataURL();
        const views: Array<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }> = [];
        for (const child of window.contentView.children) {
          if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) continue;
          const view = child as WebContentsView;
          const url = view.webContents.getURL();
          if (hashes.some((hash) => url.endsWith(hash)) && !shown.some((hash) => url.endsWith(hash))) continue;
          views.push({ dataUrl: (await view.webContents.capturePage()).toDataURL(), bounds: view.getBounds() });
        }
        return { base, views };
      },
      { hashes: Object.values(CHROME_VIEW_HASHES), shown: also.map((view) => CHROME_VIEW_HASHES[view]) },
    );
    const png = await shell.evaluate(async ({ base, views, crop }) => {
      const load = (src: string): Promise<HTMLImageElement> =>
        new Promise((done, fail) => {
          const image = new Image();
          image.onload = () => done(image);
          image.onerror = fail;
          image.src = src;
        });
      const ground = await load(base);
      const scale = ground.naturalWidth / window.innerWidth;
      const canvas = document.createElement("canvas");
      canvas.width = crop === null ? ground.naturalWidth : Math.round(crop.width * scale);
      canvas.height = crop === null ? ground.naturalHeight : Math.round(crop.height * scale);
      const context = canvas.getContext("2d")!;
      if (crop !== null) context.translate(-crop.x * scale, -crop.y * scale);
      context.drawImage(ground, 0, 0);
      for (const view of views) {
        const image = await load(view.dataUrl);
        const { x, y, width, height } = view.bounds;
        context.save();
        context.beginPath();
        context.roundRect(x * scale, y * scale, width * scale, height * scale, 8 * scale);
        context.clip();
        context.drawImage(image, x * scale, y * scale, width * scale, height * scale);
        context.restore();
      }
      return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
    }, { ...layers, crop: crop ?? null });
    await writeFile(join(directory, filename), Buffer.from(png, "base64"));
  };
}
