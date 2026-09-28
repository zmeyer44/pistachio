/**
 * The desk end to end (docs/desk.md): a tab group opens as free windows over
 * the surface, with its tabs in an inventory down the side. A thumbnail
 * pulls out into a window; a window moves by its frame, sticks to edges,
 * tiles into an armed edge zone, coasts when thrown, resizes by its corner,
 * is put away onto the inventory, and — with the grab key held — is taken
 * from anywhere on its live page. Leaving gives the surface back as panes.
 *
 * Native page views are checked where the shell cannot see them: main's
 * own view boxes must match the holes the desk windows leave for them.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { pageFirst, shellReady } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/desk");

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


interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The tab views main has on screen, bottom to top, with their boxes. */
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

/**
 * The window as a person sees it: the shell with every live page composited
 * over it at its box, in stacking order. Playwright's own screenshot is the
 * shell's document alone — the pages are other views.
 */
async function capture(app: ElectronApplication, shell: Page, filename: string): Promise<void> {
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

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).first().boundingBox();
  if (found === null) throw new Error(`${selector} has no box`);
  return found;
}

const windowSelector = (tabId: string): string => `[data-testid="desk-window"][data-tab-id="${tabId}"]`;

/** The desk is at rest: nothing entering, nothing in hand, nothing still flying or settling. */
async function settled(shell: Page): Promise<void> {
  await expect(shell.locator('.desk-stage[data-phase="open"]')).toHaveCount(1);
  await expect(shell.locator(".desk-stage[data-gesture]")).toHaveCount(0);
  await expect(shell.locator('[data-testid="desk-window"][data-flight]')).toHaveCount(0);
  // Springs settle within a second; give the last layout a frame to reach main.
  await shell.waitForTimeout(900);
}

/** A slow drag: the pointer stops before letting go, so it is a placement, not a throw. */
async function place(shell: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await shell.mouse.move(from.x, from.y);
  await shell.mouse.down();
  await shell.mouse.move(from.x + 6, from.y, { steps: 2 });
  for (let step = 1; step <= 12; step += 1) {
    await shell.mouse.move(from.x + ((to.x - from.x) * step) / 12, from.y + ((to.y - from.y) * step) / 12);
    await shell.waitForTimeout(16);
  }
  await shell.waitForTimeout(160);
  await shell.mouse.up();
}

/** A flick: a few fast frames and a release while still moving. */
async function fling(shell: Page, from: { x: number; y: number }, by: { x: number; y: number }): Promise<void> {
  await shell.mouse.move(from.x, from.y);
  await shell.mouse.down();
  await shell.mouse.move(from.x + 6, from.y, { steps: 2 });
  for (let step = 1; step <= 5; step += 1) {
    await shell.mouse.move(from.x + (by.x * step) / 5, from.y + (by.y * step) / 5);
    await shell.waitForTimeout(12);
  }
  await shell.mouse.up();
}

function center(rect: Box): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Main's box for the tab's view equals the hole its desk window leaves (a pixel of rounding either way). */
async function expectLiveIn(app: ElectronApplication, shell: Page, url: string, tabId: string): Promise<void> {
  await expect
    .poll(async () => {
      const hole = await box(shell, `${windowSelector(tabId)} [data-testid="desk-window-page"]`);
      const view = (await liveViews(app)).find((candidate) => candidate.url === url);
      if (view === undefined) return "no live view";
      const off = Math.max(
        Math.abs(view.bounds.x - hole.x),
        Math.abs(view.bounds.y - hole.y),
        Math.abs(view.bounds.width - hole.width),
        Math.abs(view.bounds.height - hole.height),
      );
      return off <= 1.5 ? "aligned" : `off by ${off.toFixed(1)}: view ${JSON.stringify(view.bounds)} hole ${JSON.stringify(hole)}`;
    })
    .toBe("aligned");
}

test("a tab group's desk: pull out, move, stick, tile, throw, resize, put away, grab from the page, leave", async () => {
  test.setTimeout(150_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify(pageFirst({ onboarding: { completed: true, completedAt: null }, general: { homeUrl: "pistachio://demo/invoices" } })),
  );
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      cwd: process.cwd(),
      executablePath,
      env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
    });
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setContentSize(1440, 900);
    });
    const shell = await shellReady(app);
    const urls = [
      "pistachio://demo/invoices",
      "pistachio://demo/vendors/atlas-medical",
      "pistachio://demo/invoices?page=north",
      "pistachio://demo/invoices?page=south",
    ];
    await expect.poll(async () => (await snapshot(shell)).tabs.length).toBeGreaterThanOrEqual(1);
    for (const url of urls.slice(1)) await shell.evaluate((address) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(address), url);
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url)).length).toBeGreaterThanOrEqual(4);
    const tabs = (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url));
    const byUrl = new Map(tabs.map((tab) => [tab.url, tab.id]));
    const ids = urls.map((url) => byUrl.get(url)!);
    await shell.evaluate((tabIds) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id: "desk-group", tabIds, title: "Research", color: "blue" }), ids);
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), ids[0]!);
    const group = shell.getByTestId("tab-group");
    await expect(group).toHaveCount(1);

    // ── 1. Open the desk: the page in view becomes the first window ───────────
    await group.getByTestId("tab-group-header").hover();
    await group.getByTestId("tab-group-desk").click();
    await expect(shell.getByTestId("desk-surface")).toBeVisible();
    await expect(shell.getByTestId("desk-thumb")).toHaveCount(4);
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await settled(shell);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await capture(app, shell, "01-desk-open.png");

    // ── 2. Pull a tab out of the inventory ────────────────────────────────────
    const stage = await box(shell, ".desk-stage");
    const thumb = await box(shell, `[data-testid="desk-thumb"][data-tab-id="${ids[1]!}"] .desk-thumb-shot`);
    await place(shell, center(thumb), { x: stage.x + stage.width * 0.72, y: stage.y + stage.height * 0.45 });
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(ids[1]);
    await expectLiveIn(app, shell, urls[1]!, ids[1]!);
    await capture(app, shell, "02-pulled-out.png");

    // ── 3. Move a window by its title bar: it goes where it is put ────────────
    const bar = await box(shell, `${windowSelector(ids[1]!)} .desk-window-bar`);
    const before = await box(shell, windowSelector(ids[1]!));
    await place(shell, { x: bar.x + 60, y: bar.y + bar.height / 2 }, { x: bar.x + 60 - 140, y: bar.y + bar.height / 2 + 70 });
    await settled(shell);
    const moved = await box(shell, windowSelector(ids[1]!));
    expect(Math.abs(moved.x - (before.x - 140))).toBeLessThan(16);
    expect(Math.abs(moved.y - (before.y + 70))).toBeLessThan(16);
    await expectLiveIn(app, shell, urls[1]!, ids[1]!);

    // ── 4. Push it into the left edge: the left half is armed, and taken ─────
    const usableLeft = stage.x + 176 + 8;
    const bar2 = await box(shell, `${windowSelector(ids[1]!)} .desk-window-bar`);
    await shell.mouse.move(bar2.x + 60, bar2.y + bar2.height / 2);
    await shell.mouse.down();
    await shell.mouse.move(bar2.x + 66, bar2.y + bar2.height / 2, { steps: 2 });
    for (let step = 1; step <= 12; step += 1) {
      await shell.mouse.move(bar2.x + 60 + ((usableLeft + 4 - bar2.x - 60) * step) / 12, stage.y + stage.height / 2);
      await shell.waitForTimeout(16);
    }
    await expect(shell.locator(".desk-zone[data-on]")).toHaveCount(1);
    await capture(app, shell, "03-edge-zone-armed.png");
    await shell.waitForTimeout(150);
    await shell.mouse.up();
    await settled(shell);
    const half = await box(shell, windowSelector(ids[1]!));
    expect(Math.abs(half.x - usableLeft)).toBeLessThan(2);
    expect(Math.abs(half.width - (stage.x + stage.width - usableLeft - 8) / 2)).toBeLessThan(2);
    expect(Math.abs(half.height - stage.height)).toBeLessThan(2);
    await expectLiveIn(app, shell, urls[1]!, ids[1]!);
    await capture(app, shell, "04-left-half.png");

    // ── 5. Throw the other window: it coasts on to the far edge and lies there ─
    // (By the visible end of its bar — the half-width window covers the rest.)
    const bar3 = await box(shell, `${windowSelector(ids[0]!)} .desk-window-bar`);
    const released = await box(shell, windowSelector(ids[0]!));
    await fling(shell, { x: bar3.x + bar3.width - 110, y: bar3.y + bar3.height / 2 }, { x: 60, y: 0 });
    await settled(shell);
    const thrown = await box(shell, windowSelector(ids[0]!));
    // Let go 60px on; a placement would have stopped there. The throw carried it to the wall.
    expect(thrown.x).toBeGreaterThan(released.x + 60 + 10);
    expect(Math.abs(thrown.x + thrown.width - (stage.x + stage.width))).toBeLessThan(2);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await capture(app, shell, "05-thrown.png");

    // ── 6. Resize by the corner ────────────────────────────────────────────────
    const corner = await box(shell, `${windowSelector(ids[0]!)} [data-desk-edge="sw"]`);
    const sized = await box(shell, windowSelector(ids[0]!));
    await place(shell, center(corner), { x: center(corner).x + 120, y: center(corner).y - 140 });
    await settled(shell);
    const resized = await box(shell, windowSelector(ids[0]!));
    expect(resized.width).toBeLessThan(sized.width - 80);
    expect(resized.height).toBeLessThan(sized.height - 100);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);

    // ── 7. Grab a live page with Shift held: main hands the press to the desk ─
    const pageHole = await box(shell, `${windowSelector(ids[0]!)} [data-testid="desk-window-page"]`);
    const grabBefore = await box(shell, windowSelector(ids[0]!));
    await app.evaluate(
      async ({ BrowserWindow, webContents }, { url, hole }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
        const content = window.getContentBounds();
        const local = { x: 120, y: 90 };
        const at = (dx: number, dy: number) => ({
          x: local.x + dx,
          y: local.y + dy,
          globalX: content.x + hole.x + local.x + dx,
          globalY: content.y + hole.y + local.y + dy,
        });
        const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
        // Shift goes down first, as a person holds it — main follows the key, not the press.
        contents.sendInputEvent({ type: "keyDown", keyCode: "Shift", modifiers: ["shift"] });
        await wait(30);
        contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, modifiers: ["shift", "leftbuttondown"], ...at(0, 0) });
        for (let step = 1; step <= 10; step += 1) {
          await wait(20);
          contents.sendInputEvent({ type: "mouseMove", button: "left", modifiers: ["shift", "leftbuttondown"], ...at(-12 * step, 6 * step) });
        }
        await wait(180);
        contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, modifiers: ["shift"], ...at(-120, 60) });
        await wait(30);
        contents.sendInputEvent({ type: "keyUp", keyCode: "Shift", modifiers: [] });
      },
      { url: urls[0]!, hole: pageHole },
    );
    await settled(shell);
    const grabbed = await box(shell, windowSelector(ids[0]!));
    expect(Math.abs(grabbed.x - (grabBefore.x - 120))).toBeLessThan(20);
    expect(Math.abs(grabbed.y - (grabBefore.y + 60))).toBeLessThan(20);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await capture(app, shell, "06-grabbed-from-page.png");

    // ── 8. Put a window away on the inventory ─────────────────────────────────
    const bar4 = await box(shell, `${windowSelector(ids[1]!)} .desk-window-bar`);
    const rail = await box(shell, '[data-testid="desk-rail"]');
    await shell.mouse.move(bar4.x + 60, bar4.y + bar4.height / 2);
    await shell.mouse.down();
    await shell.mouse.move(bar4.x + 66, bar4.y + bar4.height / 2, { steps: 2 });
    for (let step = 1; step <= 12; step += 1) {
      await shell.mouse.move(bar4.x + 60 + (rail.x + rail.width / 2 - bar4.x - 60) * (step / 12), bar4.y + 20 + step * 10);
      await shell.waitForTimeout(16);
    }
    await expect(shell.locator('[data-testid="desk-rail"][data-armed]')).toHaveCount(1);
    await capture(app, shell, "07-put-away-armed.png");
    await shell.waitForTimeout(150);
    await shell.mouse.up();
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await settled(shell);

    // ── 9. The variants: Snap tiles every throw; the frames change ─────────────
    await shell.getByTestId("desk-variant-physics").click();
    await expect(shell.getByTestId("desk-variant-physics")).toHaveAttribute("data-value", "snap");
    await shell.getByRole("button", { name: "Every tab out, tiled" }).click();
    await expect(shell.getByTestId("desk-window")).toHaveCount(4);
    await settled(shell);
    await capture(app, shell, "08-gathered-tiled.png");
    for (const chrome of ["tab", "bare"]) {
      await shell.getByTestId("desk-variant-chrome").click();
      await expect(shell.getByTestId("desk-variant-chrome")).toHaveAttribute("data-value", chrome);
      await settled(shell);
      await capture(app, shell, `09-frame-${chrome}.png`);
    }
    await shell.getByTestId("desk-variant-chrome").click();
    await expect(shell.getByTestId("desk-variant-chrome")).toHaveAttribute("data-value", "bar");

    // ── 10. Leave: the window in use becomes the pane again ────────────────────
    const inUse = (await snapshot(shell)).activeTabId!;
    await shell.getByTestId("desk-leave").click();
    await expect(shell.getByTestId("desk-surface")).toHaveCount(0);
    await expect(shell.getByTestId("browser-surface")).toBeVisible();
    await expect.poll(async () => (await liveViews(app!)).length).toBe(1);
    const pane = await box(shell, '[data-pane-tab-id]');
    const [view] = await liveViews(app);
    expect(Math.abs(view!.bounds.width - pane.width)).toBeLessThan(2);
    expect((await snapshot(shell)).activeTabId).toBe(inUse);
    await capture(app, shell, "10-left.png");
  } finally {
    await app?.close();
  }
});

test("a desk opened from a tab outside its group stays up on the group's tab, beneath Settings", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-entry-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify(pageFirst({ onboarding: { completed: true, completedAt: null }, general: { homeUrl: "pistachio://demo/invoices" } })),
  );
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellReady(app);
    const urls = ["pistachio://demo/vendors/atlas-medical", "pistachio://demo/invoices?page=north", "pistachio://demo/invoices?page=outside"];
    for (const url of urls) await shell.evaluate((address) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(address), url);
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url)).length).toBe(3);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    const grouped = [byUrl.get(urls[0]!)!, byUrl.get(urls[1]!)!];
    const outside = byUrl.get(urls[2]!)!;
    await shell.evaluate((tabIds) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id: "desk-entry", tabIds, title: "Entry", color: "green" }), grouped);
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), outside);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(outside);

    // The tab in view is not the group's: the desk opens on the group's, and stays.
    const group = shell.getByTestId("tab-group");
    await group.getByTestId("tab-group-header").hover();
    await group.getByTestId("tab-group-desk").click();
    await expect.poll(async () => grouped.includes((await snapshot(shell)).activeTabId ?? "")).toBe(true);
    await settled(shell);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);

    // Settings covers the whole surface, the desk's inventory included. The
    // desk's page has the keyboard, so ⌘, arrives as main relays it from there.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("pistachio:shell-command", { type: "runShortcut", id: "openSettings" });
    });
    const settings = shell.getByTestId("settings-page");
    await expect(settings).toBeVisible();
    const rail = await box(shell, ".desk-rail");
    const onTop = await shell.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="settings-page"]') !== null,
      center(rail),
    );
    expect(onTop).toBe(true);
  } finally {
    await app.close();
  }
});
