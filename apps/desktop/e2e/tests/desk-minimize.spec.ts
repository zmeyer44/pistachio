/**
 * Minimized desk windows end to end (docs/desk.md, "Minimize"): the
 * window's Minimize button shrinks it into the shelf at the desk's foot,
 * beside the sidebar, peeking up a quarter of its height, its page shown as if
 * zoomed to 50% (laid out twice the window's size, and only that tab: its
 * site's other tab is untouched) and live, its view cut short at the desk's
 * edge. The pointer on it — on its frame, or on its live page, which main
 * relays — raises it into view, and a click lands on the page where it is
 * drawn. The next one stacks to the right, overlapping it by half. Dragged
 * out it is a minimized window like any other, resized and still zoomed;
 * the shelf lies over the windows there, their pages cut short of it;
 * Expand gives each its box and its page
 * its own size back; Collapse (the old Put away) sends one into the sidebar.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { pageFirst, shellReady } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/desk-minimize");

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [process.env["PISTACHIO_ELECTRON_PATH"], join(process.cwd(), "node_modules/electron", suffix)].find(
    (candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

function api<T>(shell: Page, call: (pistachio: PistachioApi) => Promise<T>): Promise<T> {
  return shell.evaluate(`(${call.toString()})(window.pistachio)`) as Promise<T>;
}

const snapshot = (shell: Page): Promise<ShellSnapshot> => api(shell, (pistachio) => pistachio.getSnapshot());

/** One of a window's less-used controls, on its frame's menu (⋯): minimize, mask, a document's own. */
async function fromFrameMenu(shell: Page, win: Locator, testId: string): Promise<void> {
  await win.getByTestId("desk-window-more").click();
  await shell.locator(`[data-testid="context-menu"] [data-testid="${testId}"]`).click();
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).first().boundingBox();
  if (found === null) throw new Error(`${selector} has no box`);
  return found;
}

function near(actual: number, expected: number, within = 2): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(within);
}

/** The tab views main has on screen, with their boxes. */
function liveViews(app: ElectronApplication): Promise<Array<{ url: string; bounds: Box }>> {
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

/** A tab's view's box, whether it is on screen or not. */
function viewBounds(app: ElectronApplication, url: string): Promise<Box | null> {
  return app.evaluate(({ BrowserWindow }, url) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window?.contentView.children.find((child) => "webContents" in child && (child as WebContentsView).webContents.getURL() === url) as WebContentsView | undefined;
    return view === undefined ? null : view.getBounds();
  }, url);
}

/** The desk's shelf view (main's "shelf" chrome view) on screen, and its box; null while it is not. */
function shelfView(app: ElectronApplication): Promise<Box | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window?.contentView.children.find(
      (child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith("#shelf") && (child as WebContentsView).getVisible(),
    ) as WebContentsView | undefined;
    return view === undefined ? null : view.getBounds();
  });
}

/** A mouse event on the shelf view, as the person's pointer would reach it. */
function shelfMouse(app: ElectronApplication, type: "mouseMove" | "mouseLeave", x: number, y: number): Promise<void> {
  return app.evaluate(
    async ({ webContents }, { type, x, y }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith("#shelf"));
      if (contents === undefined) throw new Error("no shelf view");
      contents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y) });
      await new Promise((done) => setTimeout(done, 60));
    },
    { type, x, y },
  );
}

/** Run a script in the tab's page. */
function inPage<T>(app: ElectronApplication, url: string, script: string): Promise<T> {
  return app.evaluate(
    async ({ webContents }, { url, script }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
      if (contents === undefined) throw new Error(`no page at ${url}`);
      return contents.executeJavaScript(script) as Promise<T>;
    },
    { url, script },
  );
}

/** The tab's page and its zoom factor: what it lays out at, and whether the site's zoom was touched. */
function pageSize(app: ElectronApplication, url: string): Promise<{ width: number; height: number; zoom: number }> {
  return app.evaluate(
    async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
      if (contents === undefined) throw new Error(`no page at ${url}`);
      const [width, height] = (await contents.executeJavaScript("[innerWidth, innerHeight]")) as [number, number];
      return { width, height, zoom: contents.getZoomFactor() };
    },
    url,
  );
}

/** A mouse event on the tab's page, as the person's would reach it (main's mouse hook sees it). */
function pageMouse(app: ElectronApplication, url: string, type: "mouseMove" | "mouseLeave" | "click", x: number, y: number): Promise<void> {
  return app.evaluate(
    async ({ webContents }, { url, type, x, y }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
      if (contents === undefined) throw new Error(`no page at ${url}`);
      if (type === "click") {
        contents.sendInputEvent({ type: "mouseMove", x, y });
        contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
        await new Promise((done) => setTimeout(done, 40));
        contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      } else contents.sendInputEvent({ type, x, y });
      await new Promise((done) => setTimeout(done, 60));
    },
    { url, type, x, y },
  );
}

/** The window as a person sees it: the shell with every live page composited over it at its box (desk.spec.ts). */
async function capture(app: ElectronApplication, shell: Page, filename: string): Promise<void> {
  await shell.waitForTimeout(400);
  const layers = await app.evaluate(async ({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const base = (await window.capturePage()).toDataURL();
    const views: Array<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }> = [];
    for (const child of window.contentView.children) {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) continue;
      const view = child as WebContentsView;
      if (Object.values(hashes).some((hash) => view.webContents.getURL().endsWith(hash))) continue;
      views.push({ dataUrl: (await view.webContents.capturePage()).toDataURL(), bounds: view.getBounds() });
    }
    return { base, views };
  }, CHROME_VIEW_HASHES);
  const png = await shell.evaluate(async ({ base, views }) => {
    const load = (src: string): Promise<HTMLImageElement> =>
      new Promise((done, fail) => {
        const image = new Image();
        image.onload = () => done(image);
        image.onerror = fail;
        image.src = src;
      });
    const ground = await load(base);
    const canvas = document.createElement("canvas");
    canvas.width = ground.naturalWidth;
    canvas.height = ground.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(ground, 0, 0);
    const scale = ground.naturalWidth / window.innerWidth;
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
  }, layers);
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

/** Move the window out from under the real cursor, whose hover would otherwise reach the desk (desk.spec.ts). */
async function clearOfCursor(app: ElectronApplication): Promise<void> {
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

async function settled(shell: Page): Promise<void> {
  await expect(shell.locator('.desk-stage[data-phase="open"]')).toHaveCount(1);
  await expect(shell.locator(".desk-stage[data-gesture]")).toHaveCount(0);
  await expect(shell.locator('[data-testid="desk-window"][data-flight]')).toHaveCount(0);
  await shell.waitForTimeout(900);
}

const windowSelector = (tabId: string): string => `[data-testid="desk-window"][data-tab-id="${tabId}"]`;

const INVOICES = "pistachio://demo/invoices";
const VENDOR = "pistachio://demo/vendors/atlas-medical";
const ACCOUNTS = "pistachio://demo/auth/relying-party";
/** A minimized window (the least a window may be), its page box inside the title bar frame, and that box at 50%. */
const MINI = { w: 300, h: 200 };
const MINI_PAGE = { w: 290, h: 161 };
/** Where the shelf begins: in from the desk's leading edge, clear of its rounded corner (the engine's SHELF_INSET). */
const LEFT = 18;

test("minimized windows: parked peeking at the desk's foot, zoomed out and live, raised by the pointer, stacked, dragged out, resized, expanded", async () => {
  test.setTimeout(180_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-minimize-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst({ onboarding: { completed: true, completedAt: null }, general: { homeUrl: INVOICES } })));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    await clearOfCursor(app);
    const shell = await shellReady(app);
    const pageErrors: string[] = [];
    shell.on("pageerror", (error) => pageErrors.push(error.message));
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === INVOICES)).toBe(true);
    for (const address of [VENDOR, ACCOUNTS]) {
      await shell.evaluate((url) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url), address);
      await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === address)).toBe(true);
    }
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    const invoice = byUrl.get(INVOICES)!;
    const vendor = byUrl.get(VENDOR)!;
    const accounts = byUrl.get(ACCOUNTS)!;
    await shell.evaluate(
      (tabIds) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id: "desk-mini", tabIds, title: "Northstar", color: "blue" }),
      [invoice, vendor, accounts],
    );
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), invoice);
    const group = shell.getByTestId("tab-group");
    await group.getByTestId("tab-group-header").hover();
    await group.getByTestId("tab-group-desk").click();
    await expect(shell.locator('[data-testid="tab-group"] [role="tab"]')).toHaveCount(3);
    await settled(shell);
    // The vendor and the accounts out too: three windows.
    for (const tabId of [vendor, accounts]) {
      await shell.locator(`[data-testid="sidebar-tab-list"] [role="tab"][data-tab-id="${tabId}"]`).click();
      await settled(shell);
    }
    await expect(shell.locator('[data-testid="desk-window"]')).toHaveCount(3);
    const stage = await box(shell, ".desk-stage");
    const foot = stage.y + stage.height;
    // A parked window peeks up from the desk card's foot, cut off there: the surface's gutter below stays clear.
    const edge = foot;
    /** Where the shelf's windows peek up from, and the line the desk's windows keep above. */
    // (A quarter of it shows: its title bar and a strip of its page.)
    const peekY = edge - MINI.h / 4;
    /** Where a minimized window let go parks: in the shelf's band, from a gap above where they peek up. */
    const shelfTop = peekY - 8;
    const away = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.7, stage.y + 40);
    await away();
    const invoiceWindow = shell.locator(windowSelector(invoice));
    const vendorWindow = shell.locator(windowSelector(vendor));
    // The invoice in use, on top.
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), invoice);
    await settled(shell);
    const invoiceBefore = await box(shell, windowSelector(invoice));
    const invoicePageBefore = await pageSize(app, INVOICES);
    await capture(app, shell, "01-three-windows.png");

    // ── 1. Minimize: into the shelf at the desk's foot, beside the sidebar, three quarters of it below the desk's edge ─
    await fromFrameMenu(shell, invoiceWindow, "desk-minimize");
    await settled(shell);
    await expect(invoiceWindow).toHaveAttribute("data-mini", "parked");
    const parked = await box(shell, windowSelector(invoice));
    near(parked.x, stage.x + LEFT);
    near(parked.y, peekY);
    near(parked.width, MINI.w);
    near(parked.height, MINI.h);
    // Its page is zoomed out: laid out at twice its box. Its site's other tab, and the site's own zoom, untouched.
    await expect.poll(() => pageSize(app, INVOICES)).toEqual({ width: MINI_PAGE.w * 2, height: MINI_PAGE.h * 2, zoom: 1 });
    const vendorView = (await viewBounds(app, VENDOR))!;
    await expect.poll(() => pageSize(app, VENDOR)).toEqual({ width: vendorView.width, height: vendorView.height, zoom: 1 });
    // Live while it peeks: its view cut short at the desk's edge.
    await expect
      .poll(async () => (await liveViews(app)).find((view) => view.url === INVOICES)?.bounds ?? null)
      .toEqual({ x: Math.round(parked.x + 5), y: Math.round(parked.y + 34), width: MINI_PAGE.w, height: Math.round(edge - (parked.y + 34)) });
    // The shelf lies over the windows at the desk's foot: a live page under it stops where it peeks up.
    for (const url of [VENDOR, ACCOUNTS]) {
      const view = (await liveViews(app)).find((candidate) => candidate.url === url);
      if (view !== undefined && view.bounds.x < parked.x + parked.width && parked.x < view.bounds.x + view.bounds.width)
        expect(view.bounds.y + view.bounds.height).toBeLessThanOrEqual(peekY + 1);
    }
    await capture(app, shell, "02-minimized.png");

    // ── 2. The pointer on its live page (main's word) raises it into view; a click lands where the page is drawn ─
    await pageMouse(app, INVOICES, "mouseMove", 120, 8);
    await expect(invoiceWindow).toHaveAttribute("data-raised", "");
    await expect.poll(async () => Math.round((await box(shell, windowSelector(invoice))).y)).toBe(Math.round(foot - MINI.h - 8));
    await expect
      .poll(async () => (await liveViews(app)).find((view) => view.url === INVOICES)?.bounds.height ?? 0)
      .toBe(MINI_PAGE.h);
    await inPage(app, INVOICES, "window.__pressed = []; addEventListener('mousedown', (event) => __pressed.push([event.clientX, event.clientY]), true); true");
    await pageMouse(app, INVOICES, "click", 100, 60);
    await expect.poll(() => inPage<number[][]>(app, INVOICES, "window.__pressed")).toEqual([[200, 120]]);
    await capture(app, shell, "03-raised.png");
    // Off its page: back down a moment later.
    await pageMouse(app, INVOICES, "mouseLeave", 120, 8);
    await expect(invoiceWindow).not.toHaveAttribute("data-raised", "");
    await expect.poll(async () => Math.round((await box(shell, windowSelector(invoice))).y)).toBe(Math.round(peekY));

    // ── 3. The next one stacks to the right, overlapping it by half, and over it; the pointer on its frame raises only it ─
    await fromFrameMenu(shell, vendorWindow, "desk-minimize");
    await settled(shell);
    await expect(vendorWindow).toHaveAttribute("data-mini", "parked");
    const second = await box(shell, windowSelector(vendor));
    near(second.x, stage.x + LEFT + MINI.w / 2);
    near(second.y, peekY);
    const z = async (selector: string): Promise<number> => Number(await shell.locator(selector).evaluate((el) => getComputedStyle(el).zIndex));
    expect(await z(windowSelector(vendor))).toBeGreaterThan(await z(windowSelector(invoice)));
    await shell.mouse.move(second.x + MINI.w - 60, second.y + 17);
    await expect(vendorWindow).toHaveAttribute("data-raised", "");
    await expect(invoiceWindow).not.toHaveAttribute("data-raised", "");
    await shell.waitForTimeout(600);
    await capture(app, shell, "04-stacked-one-raised.png");
    await away();
    await expect(vendorWindow).not.toHaveAttribute("data-raised", "");
    await settled(shell);

    // ── 4. Dragged out by its title bar: out on the desk, still minimized and zoomed; the shelf closes up ─
    const grip = { x: second.x + MINI.w - 80, y: second.y + 17 };
    await shell.mouse.move(grip.x, grip.y);
    await shell.mouse.down();
    for (let step = 1; step <= 24; step += 1) await shell.mouse.move(grip.x + step * 22, grip.y - step * 18);
    // Held still before letting go: set down, not thrown.
    await shell.waitForTimeout(250);
    await shell.mouse.move(grip.x + 24 * 22, grip.y - 24 * 18);
    await shell.waitForTimeout(150);
    await shell.mouse.up();
    await settled(shell);
    await expect(vendorWindow).toHaveAttribute("data-mini", "free");
    const free = await box(shell, windowSelector(vendor));
    near(free.width, MINI.w);
    near(free.height, MINI.h);
    expect(free.y + free.height).toBeLessThanOrEqual(shelfTop + 1);
    near((await box(shell, windowSelector(invoice))).x, stage.x + LEFT);
    // Resized from its corner, its page is laid out at twice its new box.
    const corner = await box(shell, `${windowSelector(vendor)} [data-desk-edge="se"]`);
    await shell.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await shell.mouse.down();
    for (let step = 1; step <= 10; step += 1) await shell.mouse.move(corner.x + corner.width / 2 + step * 12, corner.y + corner.height / 2 + step * 8);
    await shell.waitForTimeout(150);
    await shell.mouse.up();
    await settled(shell);
    const resized = await box(shell, windowSelector(vendor));
    expect(resized.width).toBeGreaterThan(MINI.w + 100);
    await expect
      .poll(async () => (await pageSize(app, VENDOR)).width)
      .toBe(Math.round(resized.width - 10) * 2);
    await capture(app, shell, "05-dragged-out-resized.png");

    // ── 5. Filling the desk, a window grows into it as its live page, laid out at the desk's size from the start
    //       — never its still stretched to it — the shelf over its foot ─
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), accounts);
    await settled(shell);
    await inPage(app, ACCOUNTS, "window.__widths = [[Date.now(), innerWidth]]; (function tick() { if (__widths.at(-1)[1] !== innerWidth) __widths.push([Date.now(), innerWidth]); requestAnimationFrame(tick); })(); true");
    const accountsBefore = (await pageSize(app, ACCOUNTS)).width;
    const fillAt = await shell.evaluate((selector) => {
      const samples: boolean[] = [];
      (window as unknown as { __fillDrawn: boolean[] }).__fillDrawn = samples;
      const at = Date.now();
      document.querySelector<HTMLElement>(`${selector} button[aria-label="Fill the desk"]`)!.click();
      let left = 40;
      const sample = (): void => {
        samples.push(document.querySelector(selector)!.hasAttribute("data-drawn"));
        if ((left -= 1) > 0) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return at;
    }, windowSelector(accounts));
    await settled(shell);
    const filled = await box(shell, windowSelector(accounts));
    // The whole card, its whole page live under the parked window, which main's shelf view draws over it.
    near(filled.y + filled.height, foot, 3);
    await expect.poll(async () => {
      const view = (await liveViews(app)).find((candidate) => candidate.url === ACCOUNTS);
      return view === undefined ? null : Math.abs(view.bounds.y + view.bounds.height - (foot - 5)) <= 1;
    }).toBe(true);
    await expect.poll(() => shelfView(app)).not.toBeNull();
    const shelfBox = (await shelfView(app))!;
    near(shelfBox.x, stage.x + LEFT - 2, 2);
    near(shelfBox.y, peekY - 2, 2);
    near(shelfBox.y + shelfBox.height, foot, 2);
    expect(await shell.evaluate(() => (window as unknown as { __fillDrawn: boolean[] }).__fillDrawn.filter(Boolean))).toEqual([]);
    const fillWidths = await inPage<Array<[number, number]>>(app, ACCOUNTS, "__widths");
    expect(fillWidths[0]![1]).toBe(accountsBefore);
    // Straight to the filled page's width, at once, and nothing after.
    expect(fillWidths.slice(1).map(([, width]) => width)).toEqual([Math.round(filled.width - 10)]);
    expect(fillWidths[1]![0] - fillAt).toBeLessThan(150);

    // ── 6. Expand: back to the box it had, its page at its own size again. The pointer onto the shelf view raises it,
    //       as onto its frame, and over the page it rises the shell's again ─
    await shelfMouse(app, "mouseMove", 62, 19);
    await expect(invoiceWindow).toHaveAttribute("data-raised", "");
    await expect.poll(() => shelfView(app)).toBeNull();
    await shell.mouse.move(parked.x + 60, peekY + 17);
    await expect(invoiceWindow).toHaveAttribute("data-raised", "");
    await invoiceWindow.getByTestId("desk-expand").click();
    await settled(shell);
    await expect(invoiceWindow).not.toHaveAttribute("data-mini", /.+/);
    const back = await box(shell, windowSelector(invoice));
    near(back.x, invoiceBefore.x, 3);
    near(back.y, invoiceBefore.y, 3);
    near(back.width, invoiceBefore.width, 3);
    near(back.height, invoiceBefore.height, 3);
    await expect.poll(() => pageSize(app, INVOICES)).toEqual(invoicePageBefore);
    // The shelf is empty: the window filling the desk keeps its whole page again (the Bar's notch lies over it, cutting nothing).
    const filledNow = await box(shell, windowSelector(accounts));
    near(filledNow.y + filledNow.height, foot, 3);
    await expect.poll(async () => {
      const page = await box(shell, `${windowSelector(accounts)} [data-testid="desk-window-page"]`);
      return Math.round(page.y + page.height);
    }).toBe(Math.round(foot - 5));
    await capture(app, shell, "06-expanded.png");

    // ── 7. Snapped as any window is — into the left half, at the desk's edge — it is a window at its own size again ─
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), vendor);
    await settled(shell);
    await expect(vendorWindow).toHaveAttribute("data-mini", "free");
    const carried = await box(shell, windowSelector(vendor));
    const hold = { x: carried.x + 60, y: carried.y + 17 };
    // (In the desk's leading edge band, its first 30px.)
    const zoneAt = { x: stage.x + 12, y: stage.y + stage.height * 0.45 };
    await shell.mouse.move(hold.x, hold.y);
    await shell.mouse.down();
    for (let step = 1; step <= 24; step += 1) await shell.mouse.move(hold.x + ((zoneAt.x - hold.x) * step) / 24, hold.y + ((zoneAt.y - hold.y) * step) / 24);
    await shell.waitForTimeout(250);
    await shell.mouse.move(zoneAt.x, zoneAt.y);
    await expect(shell.locator(".desk-zone[data-on]")).toHaveCount(1);
    await shell.mouse.up();
    await settled(shell);
    await expect(vendorWindow).not.toHaveAttribute("data-mini", /.+/);
    const half = await box(shell, windowSelector(vendor));
    near(half.x, stage.x);
    near(half.y, stage.y);
    near(half.width, (stage.width - 8) / 2);
    const halfView = (await viewBounds(app, VENDOR))!;
    await expect.poll(() => pageSize(app, VENDOR)).toEqual({ width: halfView.width, height: halfView.height, zoom: 1 });
    await capture(app, shell, "07-snapped-to-a-half.png");

    // ── 8. Collapse (the old Put away) sends a minimized window into the sidebar ─
    await fromFrameMenu(shell, vendorWindow, "desk-minimize");
    await settled(shell);
    await expect(vendorWindow).toHaveAttribute("data-mini", "parked");
    await vendorWindow.getByTestId("desk-collapse").click();
    await expect(vendorWindow).toHaveCount(0);
    await expect(shell.locator('[data-testid="desk-window"]')).toHaveCount(2);
    // Its page is its own size again.
    await expect.poll(async () => (await pageSize(app, VENDOR)).zoom).toBe(1);

    // ── 9. Leave, from the More card: the window in use grows into the pane as its live page, laid out at the
    //       pane's box from the start — never a picture of its window stretched to it, nor laid out anew there ─
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), invoice);
    await settled(shell);
    await inPage(app, INVOICES, "window.__widths = [[Date.now(), innerWidth]]; (function tick() { if (__widths.at(-1)[1] !== innerWidth) __widths.push([Date.now(), innerWidth]); requestAnimationFrame(tick); })(); true");
    const before = (await pageSize(app, INVOICES)).width;
    await shell.getByTestId("desk-more").click();
    await expect(shell.locator('[data-testid="desk-more-card"][data-shown]')).toHaveCount(1);
    await shell.waitForTimeout(300);
    // Every frame from the click on: is the window its still, or its live page?
    const clickedAt = await shell.evaluate((selector) => {
      const samples: boolean[] = [];
      (window as unknown as { __leaveDrawn: boolean[] }).__leaveDrawn = samples;
      const button = document.querySelector<HTMLElement>('[data-testid="desk-leave"]')!;
      const at = Date.now();
      button.click();
      // From the next frame: the click's own task has not drawn the window anew yet.
      const sample = (): void => {
        const el = document.querySelector(selector);
        if (el === null) return;
        samples.push(el.hasAttribute("data-drawn"));
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return at;
    }, windowSelector(invoice));
    await expect(shell.getByTestId("desk-surface")).toHaveCount(0);
    // Live from the first frame (drawn under the card a moment before, it no longer waits on it).
    const drawnFrames = await shell.evaluate(() => (window as unknown as { __leaveDrawn: boolean[] }).__leaveDrawn);
    expect(drawnFrames.length).toBeGreaterThan(3);
    expect(drawnFrames.filter(Boolean)).toEqual([]);
    // Its page went from its window's width straight to the pane's, at once (the sidebar sliding back in narrows it after).
    const widths = await inPage<Array<[number, number]>>(app, INVOICES, "__widths");
    expect(widths[0]![1]).toBe(before);
    expect(widths[1]![1]).toBe(Math.round(stage.width));
    expect(widths[1]![0] - clickedAt).toBeLessThan(150);
    for (let index = 2; index < widths.length; index += 1) expect(widths[index]![1]).toBeLessThan(widths[index - 1]![1]);

    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("a desk reopened after a relaunch, a minimized window's tab asleep: the tab wakes zoomed out, and the app stays up", async () => {
  test.setTimeout(180_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-mini-relaunch-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst({ onboarding: { completed: true, completedAt: null }, general: { homeUrl: INVOICES } })));
  const launch = async (): Promise<{ app: ElectronApplication; shell: Page; exits: Array<string | null> }> => {
    const app = await electron.launch({ args: ["."], cwd: process.cwd(), executablePath, env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData } });
    const exits: Array<string | null> = [];
    app.process().on("exit", (_code, signal) => exits.push(signal));
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    await clearOfCursor(app);
    return { app, shell: await shellReady(app), exits };
  };
  const openDesk = async (shell: Page): Promise<void> => {
    const group = shell.getByTestId("tab-group");
    await group.getByTestId("tab-group-header").hover();
    await group.getByTestId("tab-group-desk").click();
  };

  // ── 1. A desk with a window minimized into the shelf, left, and the app quit ─
  let vendor = "";
  {
    const { app, shell } = await launch();
    try {
      await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === INVOICES)).toBe(true);
      for (const address of [VENDOR, ACCOUNTS]) {
        await shell.evaluate((url) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url), address);
        await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === address)).toBe(true);
      }
      const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
      const invoice = byUrl.get(INVOICES)!;
      vendor = byUrl.get(VENDOR)!;
      await shell.evaluate(
        (tabIds) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id: "desk-relaunch", tabIds, title: "Northstar", color: "blue" }),
        [invoice, vendor, byUrl.get(ACCOUNTS)!],
      );
      await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), invoice);
      await openDesk(shell);
      await settled(shell);
      await shell.locator(`[data-testid="sidebar-tab-list"] [role="tab"][data-tab-id="${vendor}"]`).click();
      await settled(shell);
      await fromFrameMenu(shell, shell.locator(windowSelector(vendor)), "desk-minimize");
      await settled(shell);
      await expect(shell.locator(windowSelector(vendor))).toHaveAttribute("data-mini", "parked");
      await shell.keyboard.press("Meta+Alt+Backslash");
      await expect(shell.getByTestId("desk-surface")).toHaveCount(0);
      await shell.waitForTimeout(500);
    } finally {
      await app.close();
    }
  }

  // ── 2. Relaunched, the group's tabs asleep: its desk opens on its saved windows, the minimized one's tab woken
  //       (as every window's is) and its page zoomed out once it has one — never before, which crashed main ─
  const { app, shell, exits } = await launch();
  try {
    await expect.poll(async () => (await snapshot(shell)).tabGroups.some((group) => group.id === "desk-relaunch")).toBe(true);
    await openDesk(shell);
    await settled(shell);
    await expect(shell.locator(windowSelector(vendor))).toHaveAttribute("data-mini", "parked");
    await expect.poll(() => pageSize(app, VENDOR), { timeout: 15_000 }).toEqual({ width: MINI_PAGE.w * 2, height: MINI_PAGE.h * 2, zoom: 1 });
    expect(exits).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
  }
});
