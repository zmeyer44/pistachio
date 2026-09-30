/**
 * The desk end to end (docs/desk.md): a tab group opens as free windows over
 * the surface, with its tabs as icons in a dock down the side. An icon
 * dragged out becomes a window; a window moves by its frame, sticks to
 * edges, tiles into an armed edge zone, coasts when thrown, resizes by its
 * corner, is put away into the dock, and — with the grab key held — is taken
 * from anywhere on its live page. Leaving gives the surface back as panes.
 *
 * Native page views are checked where the shell cannot see them: main's
 * own view boxes must match the holes the desk windows leave for them.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { crc32, deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES, TRAFFIC_LIGHTS_H } from "@pistachio/shell-contracts/chrome";
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
const iconSelector = (tabId: string): string => `[data-testid="desk-dock-icon"][data-tab-id="${tabId}"] .desk-dock-tile`;

/** The dock's column (DOCK_W) and the gap beside it: the desk's windows start this far into the stage. */
const DOCK_COLUMN = 60 + 8;

/** The desk is at rest: nothing entering, nothing in hand, nothing still flying or settling. */
async function settled(shell: Page): Promise<void> {
  await expect(shell.locator('.desk-stage[data-phase="open"]')).toHaveCount(1);
  await expect(shell.locator(".desk-stage[data-gesture]")).toHaveCount(0);
  await expect(shell.locator('[data-testid="desk-window"][data-flight]')).toHaveCount(0);
  // Springs settle within a second; give the last layout a frame to reach main.
  await shell.waitForTimeout(900);
}

/** The dock's More card up: its button hovered, and the card drawn once the pages under it have given way. */
async function openMore(shell: Page): Promise<void> {
  await shell.getByTestId("desk-more").hover();
  await expect(shell.locator('[data-testid="desk-more-card"][data-shown]')).toHaveCount(1);
}

/** Leave the desk: its way out is on the More card. */
async function leaveDesk(shell: Page): Promise<void> {
  await openMore(shell);
  await shell.getByTestId("desk-leave").click();
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

/**
 * Move the window off the real cursor, if it rests over it. A drag's native
 * layer relays where the REAL pointer is, and Playwright's pointer is not
 * that one: a real cursor over the window would pull a drag to it.
 */
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

/** A square PNG of one colour: a favicon a page can declare without an image on disk. */
function solidPng(size: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Two sites for the dock's icons, at https://dock.test: one declaring an
 * apple-touch-icon (its app icon), one with only a 32px favicon (drawn on a
 * tile). Served by intercepting https in the pages' session and the
 * shell's — the shell only loads images over https — and every other
 * address goes to the network as before.
 */
async function serveDockSites(app: ElectronApplication): Promise<string> {
  const touch = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><rect width="180" height="180" fill="#e5484d"/><text x="90" y="124" font-family="Helvetica" font-size="112" font-weight="700" text-anchor="middle" fill="white">A</text></svg>`;
  const page = (title: string, head: string, colour: string): string =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body style="margin:0;font:15px -apple-system,sans-serif;background:${colour}"><main style="padding:40px"><h1>${title}</h1><p>A page for the desk's dock.</p></main></body></html>`;
  const files: Record<string, { type: string; body: string; base64?: boolean }> = {
    "/app": { type: "text/html; charset=utf-8", body: page("Atlas App", '<link rel="apple-touch-icon" href="/touch.svg"><link rel="icon" href="/favicon.png" sizes="32x32">', "#fff4f2") },
    "/plain": { type: "text/html; charset=utf-8", body: page("Plain Site", '<link rel="icon" href="/favicon.png" sizes="32x32">', "#f2f6ff") },
    "/touch.svg": { type: "image/svg+xml", body: touch },
    // A stand-in for a video page: a header, a player a click (or Space) plays and pauses, and more page below.
    "/player": {
      type: "text/html; charset=utf-8",
      body: `<!doctype html><html><head><meta charset="utf-8"><title>Player</title><style>
body{margin:0;font:15px -apple-system,sans-serif;background:#fafafa}
header{height:64px;background:#222;color:#fff;display:flex;align-items:center;padding:0 24px;font-weight:600}
main{padding:24px 40px}
#player{position:relative;width:480px;height:270px;background:#111;color:#fff;display:grid;place-items:center;font:600 28px -apple-system,sans-serif;border-radius:12px;cursor:pointer;user-select:none}
#fullscreen{position:absolute;top:8px;right:8px;width:44px;height:28px;font-size:12px}
#player[data-playing]{background:#c0262d}
</style></head><body><header>Player demo</header><main><div id="player"><span id="state">Paused</span><button id="fullscreen">Full</button></div><p>More of the page, below the player, that a mask leaves out.</p></main>
<script>
const player = document.getElementById("player");
window.toggles = 0;
window.headerPresses = 0;
document.querySelector("header").addEventListener("mousedown", () => { window.headerPresses += 1; });
const toggle = () => { window.toggles += 1; const playing = !player.hasAttribute("data-playing"); player.toggleAttribute("data-playing", playing); document.getElementById("state").textContent = playing ? "Playing" : "Paused"; };
player.addEventListener("click", toggle);
document.getElementById("fullscreen").addEventListener("click", (event) => { event.stopPropagation(); void player.requestFullscreen(); });
addEventListener("keydown", (event) => { if (event.key === " ") { event.preventDefault(); toggle(); } });
</script></body></html>`,
    },
    "/favicon.png": { type: "image/png", body: solidPng(32, [46, 125, 220]).toString("base64"), base64: true },
  };
  await app.evaluate(({ BrowserWindow, net, webContents }, files) => {
    const shell = BrowserWindow.getAllWindows()[0]!.webContents.session;
    const pages = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("pistachio://demo"))!.session;
    const respond = (request: Request): Response | Promise<Response> => {
      const url = new URL(request.url);
      if (url.hostname !== "dock.test") return net.fetch(request, { bypassCustomProtocolHandlers: true });
      const file = files[url.pathname];
      if (file === undefined) return new Response(null, { status: 404 });
      return new Response(file.base64 === true ? Buffer.from(file.body, "base64") : file.body, { headers: { "content-type": file.type } });
    };
    for (const session of new Set([shell, pages])) session.protocol.handle("https", respond);
  }, files);
  return "https://dock.test";
}

test("a tab group's desk: pull out, move, stick, tile, throw, resize, put away, grab from the page, new tab, leave", async () => {
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
    await clearOfCursor(app);
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
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(4);
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await settled(shell);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await capture(app, shell, "01-desk-open.png");

    // ── 2. Drag a tab's icon out of the dock: it becomes its window ──────────
    const stage = await box(shell, ".desk-stage");
    const thumb = await box(shell, iconSelector(ids[1]!));
    await place(shell, center(thumb), { x: stage.x + stage.width * 0.45, y: stage.y + stage.height * 0.12 });
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
    const usableLeft = stage.x + DOCK_COLUMN;
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
    // (Hard enough to cross the whole row: the sidebar is away while the desk is up.)
    await fling(shell, { x: bar3.x + bar3.width - 110, y: bar3.y + bar3.height / 2 }, { x: 100, y: 0 });
    await settled(shell);
    const thrown = await box(shell, windowSelector(ids[0]!));
    // Let go 100px on; a placement would have stopped there. The throw carried it to the wall.
    expect(thrown.x).toBeGreaterThan(released.x + 100 + 10);
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
    // Shift is the snap key too: held, it lights a tile; let go once the
    // press is taken, the window is placed freely.
    const pageHole = await box(shell, `${windowSelector(ids[0]!)} [data-testid="desk-window-page"]`);
    const grabBefore = await box(shell, windowSelector(ids[0]!));
    const grabSteps = (steps: { keys?: "down" | "up"; press?: "down" | "up"; from: number; to: number }) =>
      app!.evaluate(
        async ({ BrowserWindow, webContents }, { url, hole, steps }) => {
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
          const held: Array<"shift"> = steps.keys === "down" ? ["shift"] : [];
          // Shift goes down first, as a person holds it — main follows the key, not the press.
          if (steps.keys === "down") contents.sendInputEvent({ type: "keyDown", keyCode: "Shift", modifiers: ["shift"] });
          if (steps.keys === "up") contents.sendInputEvent({ type: "keyUp", keyCode: "Shift", modifiers: [] });
          await wait(30);
          if (steps.press === "down") contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, modifiers: [...held, "leftbuttondown"], ...at(0, 0) });
          for (let step = steps.from; step <= steps.to; step += 1) {
            await wait(20);
            contents.sendInputEvent({ type: "mouseMove", button: "left", modifiers: [...held, "leftbuttondown"], ...at(-12 * step, 6 * step) });
          }
          if (steps.press === "up") {
            await wait(180);
            contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, modifiers: held, ...at(-12 * steps.to, 6 * steps.to) });
          }
        },
        { url: urls[0]!, hole: pageHole, steps },
      );
    await grabSteps({ keys: "down", press: "down", from: 1, to: 3 });
    await expect(shell.locator(".desk-zone[data-on][data-snap]")).toHaveCount(1);
    await grabSteps({ keys: "up", from: 4, to: 10, press: "up" });
    await settled(shell);
    const grabbed = await box(shell, windowSelector(ids[0]!));
    expect(Math.abs(grabbed.x - (grabBefore.x - 120))).toBeLessThan(20);
    expect(Math.abs(grabbed.y - (grabBefore.y + 60))).toBeLessThan(20);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await capture(app, shell, "06-grabbed-from-page.png");

    // ── 8. Put a window away: the dock slides off, and its Minimize pad takes it ─
    const bar4 = await box(shell, `${windowSelector(ids[1]!)} .desk-window-bar`);
    const rail = await box(shell, '[data-testid="desk-drop-away"]');
    await shell.mouse.move(bar4.x + 60, bar4.y + bar4.height / 2);
    await shell.mouse.down();
    await shell.mouse.move(bar4.x + 66, bar4.y + bar4.height / 2, { steps: 2 });
    for (let step = 1; step <= 12; step += 1) {
      await shell.mouse.move(bar4.x + 60 + (rail.x + rail.width / 2 - bar4.x - 60) * (step / 12), bar4.y + 20 + step * 10);
      await shell.waitForTimeout(16);
    }
    await expect(shell.locator('[data-testid="desk-dock"][data-hidden]')).toHaveCount(1);
    await expect(shell.locator('[data-testid="desk-drop-away"][data-armed]')).toHaveCount(1);
    await expect(shell.locator('[data-testid="desk-drop-close"][data-armed]')).toHaveCount(0);
    await capture(app, shell, "07-put-away-armed.png");
    await shell.waitForTimeout(150);
    await shell.mouse.up();
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await expect(shell.locator('[data-testid="desk-dock"][data-hidden]')).toHaveCount(0);
    await settled(shell);

    // ── 9. The Feel menu closes on a press in a live page, and on Escape struck
    //      there — neither of which the shell hears itself (main relays them) ─
    const pageInput = (events: Array<"press" | "escape">) =>
      app!.evaluate(
        ({ webContents }, { url, events }) => {
          const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
          for (const event of events) {
            if (event === "escape") {
              contents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
              contents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
            } else {
              contents.sendInputEvent({ type: "mouseDown", x: 240, y: 160, button: "left", clickCount: 1 });
              contents.sendInputEvent({ type: "mouseUp", x: 240, y: 160, button: "left", clickCount: 1 });
            }
          }
        },
        { url: urls[0]!, events },
      );
    for (const input of ["press", "escape"] as const) {
      // (Clicked up, it stays up until something closes it.)
      await shell.getByTestId("desk-more").click();
      await expect(shell.locator('[data-testid="desk-more-card"][data-shown]')).toHaveCount(1);
      await pageInput([input]);
      await expect(shell.getByTestId("desk-more-card")).toHaveCount(0);
    }

    // ── 10. New tab: it joins the group, and comes out onto the desk in use ────
    await shell.getByTestId("desk-new-tab").click();
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(5);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    const added = (await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-group")!.tabIds.find((tabId) => !ids.includes(tabId))!;
    expect((await snapshot(shell)).tabs.find((tab) => tab.id === added)?.url).toBe("pistachio://demo/invoices");
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(added);
    await expect(shell.locator(`[data-testid="desk-dock-icon"][data-tab-id="${added}"][data-focused]`)).toHaveCount(1);
    await expect(shell.locator(`${windowSelector(added)}`)).toHaveCount(1);
    await settled(shell);
    await capture(app, shell, "07c-new-tab.png");

    // ── 11. The variants (Feel, on the More card): Snap tiles every throw; the frames change ─
    await openMore(shell);
    await shell.waitForTimeout(200);
    await capture(app, shell, "07b-feel-menu.png");
    await shell.getByTestId("desk-variant-physics").click();
    await expect(shell.getByTestId("desk-variant-physics")).toHaveAttribute("data-value", "snap");
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("desk-more-card")).toHaveCount(0);
    // Every tab out, by its icon, then tiled.
    for (const tabId of ids) {
      if ((await shell.locator(windowSelector(tabId)).count()) > 0) continue;
      await shell.locator(iconSelector(tabId)).click();
      await expect(shell.locator(windowSelector(tabId))).toHaveCount(1);
      await settled(shell);
    }
    await expect(shell.getByTestId("desk-window")).toHaveCount(5);
    await openMore(shell);
    await shell.getByTestId("desk-tile").click();
    await expect(shell.getByTestId("desk-more-card")).toHaveCount(0);
    await settled(shell);
    await capture(app, shell, "08-all-out-tiled.png");
    for (const chrome of ["tab", "bare"]) {
      await openMore(shell);
      await shell.getByTestId("desk-variant-chrome").click();
      await expect(shell.getByTestId("desk-variant-chrome")).toHaveAttribute("data-value", chrome);
      await shell.keyboard.press("Escape");
      await settled(shell);
      await capture(app, shell, `09-frame-${chrome}.png`);
    }
    await openMore(shell);
    await shell.getByTestId("desk-variant-chrome").click();
    await expect(shell.getByTestId("desk-variant-chrome")).toHaveAttribute("data-value", "bar");
    await shell.keyboard.press("Escape");

    // ── 12. Leave: the window in use becomes the pane again ────────────────────
    const inUse = (await snapshot(shell)).activeTabId!;
    await leaveDesk(shell);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(0);
    await expect(shell.getByTestId("browser-surface")).toBeVisible();
    await expect.poll(async () => (await liveViews(app!)).length).toBe(1);
    // (The sidebar slides back in beside the pane, which narrows with it.)
    await expect
      .poll(async () => {
        const pane = await box(shell, "[data-pane-tab-id]");
        const [view] = await liveViews(app!);
        return Math.abs(view!.bounds.width - pane.width) < 2;
      })
      .toBe(true);
    expect((await snapshot(shell)).activeTabId).toBe(inUse);
    await capture(app, shell, "10-left.png");
  } finally {
    await app?.close();
  }
});

test("a window filling the desk lets go of it as it is dragged, and Shift lands windows in the tile it lights", async () => {
  test.setTimeout(120_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-snap-"));
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
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    const shell = await shellReady(app);
    const urls = ["pistachio://demo/invoices", "pistachio://demo/vendors/atlas-medical"];
    await expect.poll(async () => (await snapshot(shell)).tabs.length).toBeGreaterThanOrEqual(1);
    await shell.evaluate((address) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(address), urls[1]!);
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url)).length).toBe(2);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    const ids = urls.map((url) => byUrl.get(url)!);
    await shell.evaluate((tabIds) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id: "desk-snap", tabIds, title: "Split", color: "blue" }), ids);
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), ids[0]!);
    const group = shell.getByTestId("tab-group");
    await group.getByTestId("tab-group-header").hover();
    await group.getByTestId("tab-group-desk").click();
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await settled(shell);

    const stage = await box(shell, ".desk-stage");
    const usable = { x: stage.x + DOCK_COLUMN, y: stage.y, width: stage.width - DOCK_COLUMN, height: stage.height };
    const half = (usable.width - 8) / 2;

    // ── 1. Fill the desk ────────────────────────────────────────────────────
    await shell.locator(`${windowSelector(ids[0]!)} button[aria-label="Fill the desk"]`).click();
    await settled(shell);
    const filled = await box(shell, windowSelector(ids[0]!));
    expect(Math.abs(filled.width - usable.width)).toBeLessThan(2);
    expect(Math.abs(filled.height - usable.height)).toBeLessThan(2);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await capture(app, shell, "11-filled.png");

    // ── 2. Drag it by its title bar: it lets go of the desk, held by its bar ──
    const bar = await box(shell, `${windowSelector(ids[0]!)} .desk-window-bar`);
    const hold = { x: bar.x + bar.width * 0.4, y: bar.y + bar.height / 2 };
    await shell.mouse.move(hold.x, hold.y);
    await shell.mouse.down();
    await shell.mouse.move(hold.x + 6, hold.y + 4, { steps: 2 });
    const carryTo = { x: hold.x + 40, y: hold.y + 160 };
    for (let step = 1; step <= 12; step += 1) {
      await shell.mouse.move(hold.x + ((carryTo.x - hold.x) * step) / 12, hold.y + ((carryTo.y - hold.y) * step) / 12);
      await shell.waitForTimeout(16);
    }
    await shell.waitForTimeout(500);
    const carried = await box(shell, `${windowSelector(ids[0]!)} .desk-window-card`);
    expect(carried.width).toBeLessThan(usable.width * 0.8);
    expect(carried.height).toBeLessThan(usable.height * 0.9);
    // Still held by the bar (the lift scales about the pointer, so the bar stays under it).
    const carriedBar = await box(shell, `${windowSelector(ids[0]!)} .desk-window-bar`);
    expect(carryTo.y).toBeGreaterThan(carriedBar.y - 2);
    expect(carryTo.y).toBeLessThan(carriedBar.y + carriedBar.height + 2);
    expect(carryTo.x).toBeGreaterThan(carriedBar.x);
    expect(carryTo.x).toBeLessThan(carriedBar.x + carriedBar.width);
    await capture(app, shell, "12-let-go-of-the-desk.png");

    // ── 3. Shift goes down, the pointer standing still: snap mode lights a tile ─
    // Through main's relay of a page's keys (a page has the keyboard), and
    // Playwright's own modifier, which its pointer events will carry.
    const pressShift = (type: "keyDown" | "keyUp") =>
      app.evaluate(
        ({ webContents }, { url, type }) => {
          const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
          contents.sendInputEvent({ type, keyCode: "Shift", modifiers: type === "keyDown" ? ["shift"] : [] });
        },
        { url: urls[0]!, type },
      );
    await pressShift("keyDown");
    await shell.keyboard.down("Shift");
    await expect(shell.locator(".desk-zone[data-on][data-snap]")).toHaveCount(1);
    await expect(shell.locator(".desk-stage[data-snapping]")).toHaveCount(1);
    await expect(shell.locator(`${windowSelector(ids[0]!)}[data-aiming]`)).toHaveCount(1);
    await capture(app, shell, "13-snap-armed.png");

    // ── 4. Over the desk's right third: the right half lights, and takes it ──
    const right = { x: usable.x + usable.width * 0.86, y: usable.y + usable.height * 0.5 };
    for (let step = 1; step <= 12; step += 1) {
      await shell.mouse.move(carryTo.x + ((right.x - carryTo.x) * step) / 12, carryTo.y + ((right.y - carryTo.y) * step) / 12);
      await shell.waitForTimeout(16);
    }
    await shell.waitForTimeout(260);
    const lit = await box(shell, ".desk-zone");
    expect(Math.abs(lit.x - (usable.x + half + 8))).toBeLessThan(2);
    expect(Math.abs(lit.width - half)).toBeLessThan(2);
    expect(Math.abs(lit.height - usable.height)).toBeLessThan(2);
    await capture(app, shell, "14-snap-right-half.png");
    await shell.mouse.up();
    await settled(shell);
    const rightHalf = await box(shell, windowSelector(ids[0]!));
    expect(Math.abs(rightHalf.x - (usable.x + half + 8))).toBeLessThan(2);
    expect(Math.abs(rightHalf.width - half)).toBeLessThan(2);
    expect(Math.abs(rightHalf.height - usable.height)).toBeLessThan(2);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);

    // ── 5. Shift still held, the other tab's icon dragged out of the dock: the left half ─
    const thumb = await box(shell, iconSelector(ids[1]!));
    const left = { x: usable.x + usable.width * 0.12, y: usable.y + usable.height * 0.5 };
    await shell.mouse.move(center(thumb).x, center(thumb).y);
    await shell.mouse.down();
    await shell.mouse.move(center(thumb).x + 6, center(thumb).y, { steps: 2 });
    for (let step = 1; step <= 14; step += 1) {
      await shell.mouse.move(center(thumb).x + ((left.x - center(thumb).x) * step) / 14, center(thumb).y + ((left.y - center(thumb).y) * step) / 14);
      await shell.waitForTimeout(16);
    }
    await shell.waitForTimeout(260);
    await expect(shell.locator(".desk-zone[data-on][data-snap]")).toHaveCount(1);
    await shell.mouse.up();
    await shell.keyboard.up("Shift");
    await pressShift("keyUp");
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell);
    const leftHalf = await box(shell, windowSelector(ids[1]!));
    expect(Math.abs(leftHalf.x - usable.x)).toBeLessThan(2);
    expect(Math.abs(leftHalf.width - half)).toBeLessThan(2);
    expect(Math.abs(leftHalf.height - usable.height)).toBeLessThan(2);
    await expect(shell.locator(".desk-stage[data-snapping]")).toHaveCount(0);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await expectLiveIn(app, shell, urls[1]!, ids[1]!);
    await capture(app, shell, "15-split.png");

    // ── 6. A tall half, dragged by its bar: it lets go of the desk's height, its width kept ─
    const tallBar = await box(shell, `${windowSelector(ids[0]!)} .desk-window-bar`);
    const grip = { x: tallBar.x + tallBar.width * 0.5, y: tallBar.y + tallBar.height / 2 };
    await shell.mouse.move(grip.x, grip.y);
    await shell.mouse.down();
    await shell.mouse.move(grip.x - 6, grip.y + 4, { steps: 2 });
    const lowered = { x: grip.x - 80, y: grip.y + 120 };
    for (let step = 1; step <= 12; step += 1) {
      await shell.mouse.move(grip.x + ((lowered.x - grip.x) * step) / 12, grip.y + ((lowered.y - grip.y) * step) / 12);
      await shell.waitForTimeout(16);
    }
    await shell.waitForTimeout(500);
    // (Lifted in hand: drawn a little larger than it is.)
    const tallCarried = await box(shell, `${windowSelector(ids[0]!)} .desk-window-card`);
    expect(tallCarried.height).toBeGreaterThan(usable.height * 0.7);
    expect(tallCarried.height).toBeLessThan(usable.height * 0.8);
    expect(tallCarried.width).toBeGreaterThan(half * 0.97);
    expect(tallCarried.width).toBeLessThan(half * 1.06);
    await capture(app, shell, "15b-tall-half-let-go.png");

    // ── 7. Shift through the middle: the centre tile, even with the pointer high in the
    //      top third (where a centred window's bar is); only at the top, the whole desk ─
    await pressShift("keyDown");
    await shell.keyboard.down("Shift");
    const centred = { x: usable.x + usable.width * 0.5, y: usable.y + usable.height * 0.11 };
    for (let step = 1; step <= 12; step += 1) {
      await shell.mouse.move(lowered.x + ((centred.x - lowered.x) * step) / 12, lowered.y + ((centred.y - lowered.y) * step) / 12);
      await shell.waitForTimeout(16);
    }
    await shell.waitForTimeout(260);
    await expect(shell.locator(".desk-zone[data-on][data-snap]")).toHaveCount(1);
    const centreTile = await box(shell, ".desk-zone");
    expect(Math.abs(centreTile.width - usable.width * 0.66)).toBeLessThan(3);
    expect(Math.abs(centreTile.x + centreTile.width / 2 - (usable.x + usable.width / 2))).toBeLessThan(3);
    await capture(app, shell, "15c-snap-centre.png");
    const top = { x: centred.x, y: usable.y + 12 };
    for (let step = 1; step <= 8; step += 1) {
      await shell.mouse.move(centred.x, centred.y + ((top.y - centred.y) * step) / 8);
      await shell.waitForTimeout(16);
    }
    await shell.waitForTimeout(260);
    const wholeTile = await box(shell, ".desk-zone");
    expect(Math.abs(wholeTile.width - usable.width)).toBeLessThan(3);
    expect(Math.abs(wholeTile.height - usable.height)).toBeLessThan(3);
    await capture(app, shell, "15d-snap-top.png");
    // Back down into the middle, and let go: centred.
    for (let step = 1; step <= 8; step += 1) {
      await shell.mouse.move(centred.x, top.y + ((centred.y + 60 - top.y) * step) / 8);
      await shell.waitForTimeout(16);
    }
    await shell.waitForTimeout(260);
    await shell.mouse.up();
    await shell.keyboard.up("Shift");
    await pressShift("keyUp");
    await settled(shell);
    const landed = await box(shell, windowSelector(ids[0]!));
    expect(Math.abs(landed.width - usable.width * 0.66)).toBeLessThan(3);
    expect(Math.abs(landed.x + landed.width / 2 - (usable.x + usable.width / 2))).toBeLessThan(3);
  } finally {
    await app.close();
  }
});

test("the dock: app icons, a preview on hover, a click opens where there is room, and an icon dragged out is its window in hand", async () => {
  test.setTimeout(120_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-dock-"));
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
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    const shell = await shellReady(app);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === "pistachio://demo/invoices")).toBe(true);
    const origin = await serveDockSites(app);
    const urls = ["pistachio://demo/invoices", `${origin}/app`, `${origin}/plain`];
    await expect.poll(async () => (await snapshot(shell)).tabs.length).toBeGreaterThanOrEqual(1);
    for (const url of urls.slice(1)) await shell.evaluate((address) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(address), url);
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url)).length).toBe(3);
    // The app's page declares its icon; main reads it once the page is up.
    await expect.poll(async () => (await snapshot(shell)).tabs.find((tab) => tab.url === urls[1])?.appIconUrl ?? null).toBe(`${origin}/touch.svg`);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    const ids = urls.map((url) => byUrl.get(url)!);
    await shell.evaluate((tabIds) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id: "desk-dock", tabIds, title: "Dock", color: "purple" }), ids);
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), ids[0]!);
    const group = shell.getByTestId("tab-group");
    await group.getByTestId("tab-group-header").hover();
    await group.getByTestId("tab-group-desk").click();
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(3);
    await settled(shell);

    // ── 1. Each tab as an app: the app icon a site declares, else its favicon on a tile ─
    await expect(shell.locator(`${iconSelector(ids[1]!)} img.desk-app-icon-full`)).toHaveAttribute("src", `${origin}/touch.svg`);
    await expect(shell.locator(`${iconSelector(ids[2]!)} .desk-app-icon-tile img`)).toHaveCount(1);
    // A dot beside the tab out on the desk — the longer one, as its window is in use.
    await expect(shell.locator('[data-testid="desk-dock-icon"][data-on-desk]')).toHaveCount(1);
    await expect(shell.locator(`[data-testid="desk-dock-icon"][data-tab-id="${ids[0]!}"][data-focused]`)).toHaveCount(1);

    const stage = await box(shell, ".desk-stage");
    const usable = { x: stage.x + DOCK_COLUMN, y: stage.y, width: stage.width - DOCK_COLUMN, height: stage.height };
    const half = (usable.width - 8) / 2;
    await shell.locator(`${windowSelector(ids[0]!)} button[aria-label="Fill the desk"]`).click();
    await settled(shell);

    // ── 2. Hover an icon: its preview, beside it, over the live page ─────────────
    const appIcon = await box(shell, iconSelector(ids[1]!));
    await shell.mouse.move(center(appIcon).x, center(appIcon).y);
    const preview = shell.locator(`[data-testid="desk-dock-preview"][data-tab-id="${ids[1]!}"][data-shown]`);
    await expect(preview).toHaveCount(1);
    await expect(preview).toContainText("Atlas App");
    await shell.waitForTimeout(250);
    await capture(app, shell, "16-dock-preview.png");

    // ── 3. Click it: the desk is filled by one window, so that one gives up half ─
    await shell.mouse.down();
    await shell.mouse.up();
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await shell.mouse.move(stage.x + stage.width * 0.6, stage.y + stage.height * 0.5);
    await settled(shell);
    const leftHalf = await box(shell, windowSelector(ids[0]!));
    const rightHalf = await box(shell, windowSelector(ids[1]!));
    expect(Math.abs(leftHalf.x - usable.x)).toBeLessThan(2);
    expect(Math.abs(leftHalf.width - half)).toBeLessThan(2);
    expect(Math.abs(rightHalf.x - (usable.x + half + 8))).toBeLessThan(2);
    expect(Math.abs(rightHalf.width - half)).toBeLessThan(2);
    await expect(shell.locator('[data-testid="desk-dock-icon"][data-on-desk]')).toHaveCount(2);
    await expect(shell.locator(`[data-testid="desk-dock-icon"][data-tab-id="${ids[1]!}"][data-focused]`)).toHaveCount(1);
    await expectLiveIn(app, shell, urls[1]!, ids[1]!);
    await capture(app, shell, "17-dock-click-split.png");

    // ── 4. Click the icon of a window already out: it comes to the top, in use ───
    await shell.locator(iconSelector(ids[0]!)).click();
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(ids[0]);
    await expect(shell.locator(`[data-testid="desk-dock-icon"][data-tab-id="${ids[0]!}"][data-focused]`)).toHaveCount(1);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);

    // ── 5. Drag the app's icon: in hand it is an icon, and pulled clear it is its window ─
    const from = center(await box(shell, iconSelector(ids[1]!)));
    await shell.mouse.move(from.x, from.y);
    await shell.mouse.down();
    await shell.mouse.move(from.x + 8, from.y + 6, { steps: 2 });
    await shell.mouse.move(from.x + 18, from.y + 16, { steps: 2 });
    await expect(shell.locator(".desk-dock-ghost[data-on]")).toHaveCount(1);
    await capture(app, shell, "18-dock-icon-in-hand.png");
    const hand = { x: usable.x + 320, y: usable.y + 140 };
    for (let step = 1; step <= 12; step += 1) {
      await shell.mouse.move(from.x + 18 + ((hand.x - from.x - 18) * step) / 12, from.y + 16 + ((hand.y - from.y - 16) * step) / 12);
      await shell.waitForTimeout(16);
    }
    await expect(shell.locator(".desk-dock-ghost[data-on]")).toHaveCount(0);
    // It flies to the hand held by its title bar — a full-height half, too tall
    // to carry, scaled down to four fifths of the desk's height, its shape kept.
    await shell.waitForTimeout(600);
    const inHand = await box(shell, `${windowSelector(ids[1]!)} .desk-window-bar`);
    expect(hand.y).toBeGreaterThan(inHand.y - 2);
    expect(hand.y).toBeLessThan(inHand.y + inHand.height + 2);
    expect(hand.x).toBeGreaterThan(inHand.x);
    expect(hand.x).toBeLessThan(inHand.x + inHand.width * 0.5);
    await capture(app, shell, "19-dock-window-to-hand.png");
    await shell.mouse.up();
    await settled(shell);
    const dropped = await box(shell, windowSelector(ids[1]!));
    expect(Math.abs(dropped.height - usable.height * 0.8)).toBeLessThan(2);
    expect(Math.abs(dropped.width / dropped.height - half / usable.height)).toBeLessThan(0.01);
    const droppedBar = await box(shell, `${windowSelector(ids[1]!)} .desk-window-bar`);
    expect(Math.abs(droppedBar.y + droppedBar.height / 2 - hand.y)).toBeLessThan(16);
    await expectLiveIn(app, shell, urls[1]!, ids[1]!);

    // ── 6. Drag out the icon of a tab not on the desk: a fresh window, held by its bar ─
    const plain = center(await box(shell, iconSelector(ids[2]!)));
    const dropAt = { x: usable.x + usable.width * 0.45, y: usable.y + usable.height * 0.16 };
    await place(shell, plain, dropAt);
    await expect(shell.getByTestId("desk-window")).toHaveCount(3);
    await settled(shell);
    const plainBar = await box(shell, `${windowSelector(ids[2]!)} .desk-window-bar`);
    expect(Math.abs(plainBar.y + plainBar.height / 2 - dropAt.y)).toBeLessThan(16);
    await expect(shell.locator('[data-testid="desk-dock-icon"][data-on-desk]')).toHaveCount(3);
    await expectLiveIn(app, shell, urls[2]!, ids[2]!);
    await capture(app, shell, "20-dock-dragged-out.png");

    // ── 7. Carry it to the desk's leading edge: the dock slides away, and its
    //      pads stand in its column; the lower one closes the tab ─────────────
    const closePad = await box(shell, '[data-testid="desk-drop-close"]');
    const grip = { x: plainBar.x + 90, y: plainBar.y + plainBar.height / 2 };
    await shell.mouse.move(grip.x, grip.y);
    await shell.mouse.down();
    await shell.mouse.move(grip.x - 8, grip.y + 4, { steps: 2 });
    await expect(shell.locator('[data-testid="desk-dock"][data-hidden]')).toHaveCount(1);
    await expect(shell.locator(".desk-drops[data-shown]")).toHaveCount(0);
    // Near the edge the pads show; in the desk's edge band it is the left half that lights.
    const band = { x: usable.x + 12, y: usable.y + usable.height * 0.5 };
    for (let step = 1; step <= 10; step += 1) {
      await shell.mouse.move(grip.x + ((band.x - grip.x) * step) / 10, grip.y + ((band.y - grip.y) * step) / 10);
      await shell.waitForTimeout(16);
    }
    await expect(shell.locator(".desk-drops[data-shown]")).toHaveCount(1);
    await expect(shell.locator(".desk-zone[data-on]")).toHaveCount(1);
    await expect(shell.locator(".desk-drop[data-armed]")).toHaveCount(0);
    await shell.waitForTimeout(250);
    await capture(app, shell, "21-dock-pads-left-half.png");
    // Past the desk's edge, low down: Close.
    const onClose = center(closePad);
    for (let step = 1; step <= 8; step += 1) {
      await shell.mouse.move(band.x + ((onClose.x - band.x) * step) / 8, band.y + ((onClose.y - band.y) * step) / 8);
      await shell.waitForTimeout(16);
    }
    await expect(shell.locator('[data-testid="desk-drop-close"][data-armed]')).toHaveCount(1);
    await expect(shell.locator(".desk-zone[data-on]")).toHaveCount(0);
    await shell.waitForTimeout(250);
    await capture(app, shell, "22-dock-pads-close.png");
    await shell.mouse.up();
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.id === ids[2])).toBe(false);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(2);
    await expect(shell.locator('[data-testid="desk-dock"][data-hidden]')).toHaveCount(0);
    await settled(shell);
    await capture(app, shell, "23-dock-back.png");
  } finally {
    await app.close();
  }
});

test("⇧⌫ with the pointer on a dock icon closes that tab, wherever the keyboard is, and the page never hears it", async () => {
  test.setTimeout(120_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-dock-close-"));
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
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    const shell = await shellReady(app);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === "pistachio://demo/invoices")).toBe(true);
    const origin = await serveDockSites(app);
    const urls = ["pistachio://demo/invoices", `${origin}/app`, `${origin}/plain`, `${origin}/player`];
    for (const url of urls.slice(1)) await shell.evaluate((address) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(address), url);
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url)).length).toBe(4);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    const ids = urls.map((url) => byUrl.get(url)!);
    const [invoices, atlas, plain, player] = ids as [string, string, string, string];
    await shell.evaluate((tabIds) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id: "desk-close", tabIds, title: "Close", color: "blue" }), ids);
    // The desk opens on the app's page: its window is in use, and its page has the keyboard.
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), atlas);
    const group = shell.getByTestId("tab-group");
    await group.getByTestId("tab-group-header").hover();
    await group.getByTestId("tab-group-desk").click();
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(4);
    await settled(shell);
    await expectLiveIn(app, shell, urls[1]!, atlas);

    /** A page's webContents, by its address. */
    const inPage = <T,>(url: string, run: string): Promise<T> =>
      app.evaluate(({ webContents }, { url, run }) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.executeJavaScript(run), { url, run }) as Promise<T>;
    // Every key the app's page hears, from here on; and the keyboard is the page's.
    await inPage(urls[1]!, `window.heard = []; addEventListener("keydown", (event) => heard.push((event.shiftKey ? "⇧" : "") + event.key), true); 0`);
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.focus(), urls[1]!);
    /** ⇧⌫ struck in a view: a page's (by its address), or the shell's own. */
    const shiftBackspace = (into: string | "shell", repeat = false): Promise<void> =>
      app.evaluate(
        ({ BrowserWindow, webContents }, { into, repeat }) => {
          const contents = into === "shell" ? BrowserWindow.getAllWindows()[0]!.webContents : webContents.getAllWebContents().find((candidate) => candidate.getURL() === into)!;
          const modifiers: Array<"shift" | "isautorepeat"> = repeat ? ["shift", "isautorepeat"] : ["shift"];
          contents.sendInputEvent({ type: "keyDown", keyCode: "Backspace", modifiers });
          contents.sendInputEvent({ type: "keyUp", keyCode: "Backspace", modifiers: ["shift"] });
        },
        { into, repeat },
      );
    const hoverIcon = async (tabId: string): Promise<void> => {
      const icon = center(await box(shell, iconSelector(tabId)));
      await shell.mouse.move(icon.x, icon.y);
      // Shown once the pages beside the dock have given way: main has long heard the icon is hovered.
      await expect(shell.locator(`[data-testid="desk-dock-preview"][data-tab-id="${tabId}"][data-shown]`)).toHaveCount(1);
    };
    const tabIdsNow = async (): Promise<string[]> => (await snapshot(shell)).tabs.map((tab) => tab.id);

    // ── 1. On a tab only in the dock, the keyboard the page's: that tab closes, and the page hears nothing ─
    await hoverIcon(plain);
    await capture(app, shell, "44-dock-close-hover.png");
    await shiftBackspace(urls[1]!);
    await expect.poll(tabIdsNow).not.toContain(plain);
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(3);
    await expect(shell.locator(`[data-testid="desk-dock-icon"][data-tab-id="${plain}"]`)).toHaveCount(0);
    expect(await inPage<string[]>(urls[1]!, "heard")).toEqual([]);

    // ── 2. Held down, it closes one tab, not one per repeat (the repeats never reach the page either) ─
    await hoverIcon(invoices);
    await shiftBackspace(urls[1]!, true);
    await shell.waitForTimeout(400);
    expect(await tabIdsNow()).toContain(invoices);
    expect(await inPage<string[]>(urls[1]!, "heard")).toEqual([]);
    await shiftBackspace(urls[1]!);
    await expect.poll(tabIdsNow).not.toContain(invoices);
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(2);

    // ── 3. On a tab out on the desk, struck in the shell: its window goes with it, and the desk stays up ─
    await shell.locator(iconSelector(player)).click();
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell);
    await hoverIcon(player);
    await shiftBackspace("shell");
    await expect.poll(tabIdsNow).not.toContain(player);
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(1);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(atlas);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);
    await capture(app, shell, "45-dock-closed.png");

    // ── 4. Off the icons, ⇧⌫ is the page's again, and closes nothing ─────────────────
    const stage = await box(shell, ".desk-stage");
    await shell.mouse.move(stage.x + stage.width * 0.6, stage.y + stage.height * 0.5);
    await expect(shell.locator('[data-testid="desk-dock-preview"]')).toHaveCount(0);
    await shell.waitForTimeout(300);
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.focus(), urls[1]!);
    await shiftBackspace(urls[1]!);
    await expect.poll(() => inPage<string[]>(urls[1]!, "heard")).toEqual(["⇧Backspace"]);
    expect(await tabIdsNow()).toContain(atlas);
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("on a desk the window buttons stay, ⌘T brings a new tab out as a window, and ⌘L or a click on a window's title edits its address", async () => {
  test.setTimeout(120_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-keys-"));
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
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    const shell = await shellReady(app);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === "pistachio://demo/invoices")).toBe(true);
    const origin = await serveDockSites(app);
    const urls = [`${origin}/app`, `${origin}/plain`];
    for (const url of urls) await shell.evaluate((address) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(address), url);
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url)).length).toBe(2);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    const [atlas, plain] = urls.map((url) => byUrl.get(url)!) as [string, string];
    await shell.evaluate((tabIds) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id: "desk-keys", tabIds, title: "Keys", color: "green" }), [atlas, plain]);
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), atlas);
    // Every time main shows or hides the window's buttons, from here on.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const record = globalThis as unknown as { buttons: boolean[] };
      record.buttons = [];
      const set = window.setWindowButtonVisibility.bind(window);
      window.setWindowButtonVisibility = (visible: boolean) => {
        record.buttons.push(visible);
        set(visible);
      };
    });
    const group = shell.getByTestId("tab-group");
    await group.getByTestId("tab-group-header").hover();
    await group.getByTestId("tab-group-desk").click();
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(2);
    await settled(shell);

    // ── 1. The sidebar is away, the window's buttons are not; the dock keeps clear of them ─
    await shell.waitForTimeout(400);
    expect(await app.evaluate(() => (globalThis as unknown as { buttons: boolean[] }).buttons)).not.toContain(false);
    const clip = await box(shell, ".desk-dock-clip");
    expect(clip.y).toBeGreaterThanOrEqual(TRAFFIC_LIGHTS_H - 1);
    await capture(app, shell, "46-desk-buttons.png");

    /** A shortcut struck in a page, as a person's keys reach it (main's relay of the page's keys). */
    const strike = (url: string, keyCode: string): Promise<void> =>
      app.evaluate(
        ({ webContents }, { url, keyCode }) => {
          const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
          contents.focus();
          contents.sendInputEvent({ type: "keyDown", keyCode: "Meta", modifiers: ["meta"] });
          contents.sendInputEvent({ type: "keyDown", keyCode, modifiers: ["meta"] });
          contents.sendInputEvent({ type: "keyUp", keyCode, modifiers: ["meta"] });
          contents.sendInputEvent({ type: "keyUp", keyCode: "Meta", modifiers: [] });
        },
        { url, keyCode },
      );
    const address = shell.getByTestId("address-input");
    /** The palette up over the desk: the pages under it put down (drawn by the shell), its entrance done. */
    const paletteShown = async (): Promise<void> => {
      await expect(shell.getByTestId("url-bar")).toBeVisible();
      await expect.poll(async () => (await liveViews(app)).length).toBe(0);
      await shell.waitForTimeout(400);
    };

    // ── 2. ⌘L in the window's page: the address palette, on its tab ─────────────
    await strike(urls[0]!, "l");
    await paletteShown();
    await expect(address).toHaveValue(urls[0]!);
    await capture(app, shell, "47-desk-cmd-l.png");
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);

    // ── 3. ⌘T: a new tab in the group, out on the desk as the window in use (the dock's +) ─
    await expectLiveIn(app, shell, urls[0]!, atlas);
    await strike(urls[0]!, "t");
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(3);
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-keys")?.tabIds.length).toBe(3);
    const added = await snapshot(shell);
    const fresh = added.tabGroups.find((candidate) => candidate.id === "desk-keys")!.tabIds.find((tabId) => tabId !== atlas && tabId !== plain)!;
    expect(added.tabs.find((tab) => tab.id === fresh)?.url).toBe("pistachio://demo/invoices");
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(fresh);
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);
    await settled(shell);
    await capture(app, shell, "48-desk-cmd-t.png");

    // ── 4. A click on the other window's title: that tab in use, and its address to edit ─
    // (Tiled first: the new window came out over it.)
    await openMore(shell);
    await shell.getByTestId("desk-tile").click();
    await settled(shell);
    await shell.locator(`${windowSelector(atlas)} [data-testid="desk-window-address"]`).click();
    await paletteShown();
    await expect(address).toHaveValue(urls[0]!);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(atlas);
    await capture(app, shell, "49-desk-title-click.png");
    // Typed and entered, the window's page goes there, and the desk stays up.
    await address.fill(`${origin}/plain`);
    await address.press("Enter");
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    await expect.poll(async () => (await snapshot(shell)).tabs.find((tab) => tab.id === atlas)?.url).toBe(`${origin}/plain`);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
  } finally {
    await app.close();
  }
});

test("a window may lie behind the dock: its still under the dock's glass, and the dock steps aside for it in use; the dock's tools have tooltips; the sidebar is away meanwhile", async () => {
  test.setTimeout(120_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-behind-"));
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
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    const shell = await shellReady(app);
    const urls = ["pistachio://demo/invoices", "pistachio://demo/vendors/atlas-medical"];
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === urls[0])).toBe(true);
    await shell.evaluate((address) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(address), urls[1]!);
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url)).length).toBe(2);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    const ids = urls.map((url) => byUrl.get(url)!);
    await shell.evaluate((tabIds) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id: "desk-behind", tabIds, title: "Behind", color: "orange" }), ids);
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), ids[0]!);
    // Main shows and hides the macOS window buttons; Electron has no getter, so note what it last asked for.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const noted = globalThis as unknown as { windowButtons?: boolean };
      const set = window.setWindowButtonVisibility.bind(window);
      window.setWindowButtonVisibility = (visible: boolean) => {
        noted.windowButtons = visible;
        set(visible);
      };
    });
    const windowButtons = (): Promise<boolean> =>
      app.evaluate(() => (globalThis as unknown as { windowButtons?: boolean }).windowButtons ?? true);
    const sidebarAway = shell.locator('[data-testid="sidebar-pane"][data-hidden]');
    const paneBefore = await box(shell, "[data-pane-tab-id]");
    await expect(sidebarAway).toHaveCount(0);
    const group = shell.getByTestId("tab-group");
    await group.getByTestId("tab-group-header").hover();
    await group.getByTestId("tab-group-desk").click();
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(2);
    await settled(shell);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    const stage = await box(shell, ".desk-stage");
    // The sidebar is put away while the desk is up — the window buttons stay, the dock clear of them — and the desk has the whole row.
    await expect(sidebarAway).toHaveCount(1);
    expect((await box(shell, '[data-testid="sidebar-motion-slot"]')).width).toBeLessThan(12);
    expect(stage.x).toBeLessThan(paneBefore.x - 100);
    expect(stage.x).toBeLessThan(12);
    await shell.waitForTimeout(400);
    expect(await windowButtons()).toBe(true);
    expect((await box(shell, ".desk-dock-clip")).y).toBeGreaterThanOrEqual(TRAFFIC_LIGHTS_H - 1);
    await capture(app, shell, "24a-sidebar-away.png");
    // Where the dock's shelf and its icons rest (they slide away when it steps aside).
    const shelf = await box(shell, ".desk-dock-shelf");
    const otherIcon = center(await box(shell, iconSelector(ids[1]!)));
    const dockHidden = shell.locator('[data-testid="desk-dock"][data-hidden]');
    const tucked = shell.locator(`${windowSelector(ids[0]!)}[data-drawn]`);
    const isLive = async (url: string): Promise<boolean> => (await liveViews(app)).some((view) => view.url === url);

    // ── 1. Carry the window in behind the dock (by its bar, well along it, clear of the edge's zones) ─
    const bar = await box(shell, `${windowSelector(ids[0]!)} .desk-window-bar`);
    const start = await box(shell, windowSelector(ids[0]!));
    const leftEdge = stage.x + 16;
    const hold = { x: bar.x + 320, y: bar.y + bar.height / 2 };
    await place(shell, hold, { x: hold.x - (start.x - leftEdge), y: hold.y });
    await settled(shell);
    const behind = await box(shell, windowSelector(ids[0]!));
    // It stays where it was put — it no longer springs back to the dock's edge.
    expect(Math.abs(behind.x - leftEdge)).toBeLessThan(3);
    expect(behind.x).toBeLessThan(stage.x + DOCK_COLUMN - 20);
    // The dock over it; the window is its still, under the dock's glass — no live page there to paint over the dock.
    await expect(dockHidden).toHaveCount(0);
    await expect(tucked).toHaveCount(1);
    await expect.poll(() => isLive(urls[0]!)).toBe(false);
    const dockOnTop = await shell.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest(".desk-dock-shelf") !== null,
      { x: shelf.x + shelf.width / 2, y: shelf.y + shelf.height / 2 },
    );
    expect(dockOnTop).toBe(true);
    await shell.waitForTimeout(300);
    await capture(app, shell, "24-behind-the-dock.png");

    // ── 2. Click into it: the window in use must be live, so the dock steps aside ─
    await shell.mouse.click(behind.x + 420, behind.y + 220);
    await expect(dockHidden).toHaveCount(1);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(ids[0]);
    await shell.waitForTimeout(400);
    await capture(app, shell, "25-dock-aside.png");

    // ── 3. The pointer comes to the dock's place over that live page (main hears it): the dock is back ─
    const view = (await liveViews(app)).find((candidate) => candidate.url === urls[0])!;
    const atDock = { x: Math.round(stage.x + 30 - view.bounds.x), y: Math.round(shelf.y + shelf.height / 2 - view.bounds.y) };
    expect(atDock.x).toBeGreaterThan(0);
    await app.evaluate(
      ({ webContents }, { url, at }) => {
        const page = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
        if (page === undefined) throw new Error(`no page at ${url}`);
        page.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y });
      },
      { url: urls[0]!, at: atDock },
    );
    await expect(dockHidden).toHaveCount(0);
    await expect(tucked).toHaveCount(1);
    await expect.poll(() => isLive(urls[0]!)).toBe(false);
    await shell.waitForTimeout(450);
    await capture(app, shell, "26-dock-back-at-the-pointer.png");

    // ── 4. Off the dock's place, over the window again: aside once more, the page live ─
    await shell.mouse.move(behind.x + 460, behind.y + 260);
    await expect(dockHidden).toHaveCount(1);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);

    // ── 5. Back to the dock and use the other tab: the dock stays, over the window behind it ─
    await shell.mouse.move(otherIcon.x, otherIcon.y);
    await expect(dockHidden).toHaveCount(0);
    await shell.waitForTimeout(450);
    await shell.mouse.click(otherIcon.x, otherIcon.y);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(ids[1]);
    await expectLiveIn(app, shell, urls[1]!, ids[1]!);
    await shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.5);
    await shell.waitForTimeout(300);
    await expect(dockHidden).toHaveCount(0);
    await expect(tucked).toHaveCount(1);
    // Filling the desk still keeps clear of the dock.
    await shell.locator(`${windowSelector(ids[1]!)} button[aria-label="Fill the desk"]`).click();
    await settled(shell);
    const filled = await box(shell, windowSelector(ids[1]!));
    expect(Math.abs(filled.x - (stage.x + DOCK_COLUMN))).toBeLessThan(2);
    await capture(app, shell, "27-dock-over-the-window-behind.png");

    // ── 6. The dock's tools: New tab says what it does in a tooltip beside the dock, over the
    //      live page; More shows its card there for as long as the pointer is on it ─
    const toolAt = async (label: string): Promise<{ x: number; y: number }> =>
      center(await box(shell, `.desk-dock-tools button[aria-label="${label}"]`));
    const shownTip = (label: string) => shell.locator('[data-testid="desk-dock-tip"][data-shown]', { hasText: label });
    const plus = await toolAt("New tab");
    await shell.mouse.move(plus.x, plus.y);
    await expect(shownTip("New tab")).toHaveCount(1);
    const tipBox = await box(shell, '[data-testid="desk-dock-tip"][data-shown]');
    // Clear of the shelf, level with its button.
    expect(tipBox.x).toBeGreaterThan(shelf.x + shelf.width + 4);
    expect(Math.abs(tipBox.y + tipBox.height / 2 - plus.y)).toBeLessThan(3);
    // The page it is drawn over gave way to its still, or it would paint over the tooltip.
    await expect.poll(() => isLive(urls[1]!)).toBe(false);
    await shell.waitForTimeout(250);
    await capture(app, shell, "28-dock-tooltip.png");
    // More: no tooltip, its card instead, beside the dock, its foot level with the button's.
    const more = await toolAt("More");
    await shell.mouse.move(more.x, more.y);
    const card = shell.locator('[data-testid="desk-more-card"][data-shown]');
    await expect(card).toHaveCount(1);
    await expect(shell.getByTestId("desk-dock-tip")).toHaveCount(0);
    const cardBox = await box(shell, '[data-testid="desk-more-card"]');
    const moreButton = await box(shell, '.desk-dock-tools button[aria-label="More"]');
    expect(cardBox.x).toBeGreaterThan(shelf.x + shelf.width + 4);
    expect(Math.abs(cardBox.y + cardBox.height - (moreButton.y + moreButton.height))).toBeLessThan(3);
    for (const name of ["Tile the windows", "Cascade the windows", "Leave the desk"]) await expect(card).toContainText(name);
    await expect(card.getByTestId("desk-variants")).toContainText("Deceleration");
    await expect.poll(() => isLive(urls[1]!)).toBe(false);
    await shell.waitForTimeout(250);
    await capture(app, shell, "28b-dock-more-card.png");
    // Across the gap and onto the card, it stays; off it, it goes, and the page is live again.
    const tileItem = center(await box(shell, '[data-testid="desk-tile"]'));
    await shell.mouse.move(cardBox.x - 4, more.y, { steps: 3 });
    await shell.mouse.move(tileItem.x, tileItem.y, { steps: 4 });
    await shell.waitForTimeout(450);
    await expect(card).toHaveCount(1);
    await shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.5);
    await expect(shell.getByTestId("desk-more-card")).toHaveCount(0);
    await expectLiveIn(app, shell, urls[1]!, ids[1]!);
    // And Tile tiles: the window behind the dock comes out beside it.
    await openMore(shell);
    await shell.getByTestId("desk-tile").click();
    await expect(shell.getByTestId("desk-more-card")).toHaveCount(0);
    await settled(shell);
    const tiledBehind = await box(shell, windowSelector(ids[0]!));
    const tiledFilled = await box(shell, windowSelector(ids[1]!));
    expect(Math.min(tiledBehind.x, tiledFilled.x)).toBeGreaterThan(stage.x + DOCK_COLUMN - 2);

    // ── 7. Leave: the row goes back to panes, and the sidebar comes back beside them ─
    await shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.5);
    await leaveDesk(shell);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(0);
    await expect(sidebarAway).toHaveCount(0);
    await expect(shell.getByTestId("sidebar-pane")).toBeVisible();
    await expect.poll(windowButtons).toBe(true);
    await expect
      .poll(async () => {
        const pane = await box(shell, "[data-pane-tab-id]");
        const view = (await liveViews(app)).find((candidate) => candidate.url === urls[1]);
        return view !== undefined && Math.abs(pane.x - paneBefore.x) < 2 && Math.abs(view.bounds.width - pane.width) < 2;
      })
      .toBe(true);
    await shell.waitForTimeout(300);
    await capture(app, shell, "29-left-sidebar-back.png");
  } finally {
    await app.close();
  }
});

test("a mask: a region chosen from a page is all the window shows, live and still usable, scaled like a picture, and the page never reflows", async () => {
  test.setTimeout(120_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-mask-"));
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
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    const shell = await shellReady(app);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === "pistachio://demo/invoices")).toBe(true);
    const origin = await serveDockSites(app);
    const urls = [`${origin}/player`, "pistachio://demo/vendors/atlas-medical"];
    for (const url of urls) await shell.evaluate((address) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(address), url);
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url)).length).toBe(2);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    const ids = urls.map((url) => byUrl.get(url)!);
    await shell.evaluate((tabIds) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id: "desk-mask", tabIds, title: "Mask", color: "green" }), ids);
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), ids[0]!);
    const group = shell.getByTestId("tab-group");
    await group.getByTestId("tab-group-header").hover();
    await group.getByTestId("tab-group-desk").click();
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(2);
    await settled(shell);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);

    /** Run script in the page itself (its own window: no mask is visible to it). */
    const inPage = <T,>(script: string): Promise<T> =>
      app.evaluate(
        ({ webContents }, { url, script }) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.executeJavaScript(script),
        { url: urls[0]!, script },
      ) as Promise<T>;
    const pageWidth = await inPage<number>("innerWidth");
    const win = windowSelector(ids[0]!);
    /** A click on the page's view at a point of it, as main hears one from the pointer (it maps it, masked). */
    const clickPage = (point: { x: number; y: number }): Promise<void> =>
      app.evaluate(
        async ({ webContents }, { url, point }) => {
          const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
          contents.sendInputEvent({ type: "mouseMove", ...point });
          contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
          await new Promise((done) => setTimeout(done, 40));
          contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
          await new Promise((done) => setTimeout(done, 120));
        },
        { url: urls[0]!, point },
      );
    const before = await box(shell, win);
    const page = await box(shell, `${win} [data-testid="desk-window-page"]`);

    // ── 1. Mask: the page freezes and dims; a drag over it picks the region ────
    await shell.mouse.move(page.x + page.width / 2, before.y + 10);
    await shell.locator(`${win} [data-testid="desk-mask"]`).click();
    const selector = shell.locator(`${win} [data-testid="desk-mask-selector"]`);
    await expect(selector).toBeVisible();
    // The player: 40px in, under a 64px header and 24px of padding, 480 × 270.
    const region = { x: 40, y: 88, w: 480, h: 270 };
    await shell.mouse.move(page.x + region.x, page.y + region.y);
    await shell.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await shell.mouse.move(page.x + region.x + (region.w * step) / 10, page.y + region.y + (region.h * step) / 10);
      await shell.waitForTimeout(16);
    }
    await expect(shell.locator(`${win} .desk-mask-size`)).toHaveText(`${region.w} × ${region.h}`);
    await capture(app, shell, "30-mask-choosing.png");
    await shell.mouse.up();

    // ── 2. The window is the region, where it was, live — the page still laid out at its width ─
    await expect(shell.locator(`${win}[data-masked]`)).toHaveCount(1);
    await settled(shell);
    const masked = await box(shell, win);
    expect(Math.abs(masked.width - region.w)).toBeLessThan(2);
    expect(Math.abs(masked.height - (region.h + 18))).toBeLessThan(2);
    expect(Math.abs(masked.x - (page.x + region.x))).toBeLessThan(2);
    expect(Math.abs(masked.y + 18 - (page.y + region.y))).toBeLessThan(2);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    expect(await inPage<number>("innerWidth")).toBe(pageWidth);

    // ── 2b. Still the page: a click on the region plays the player — even at the
    // region's corner, where the page's own idea of the point would be its header ─
    await clickPage({ x: 240, y: 135 });
    await expect.poll(() => inPage<number>("window.toggles")).toBe(1);
    expect(await inPage<string>("document.getElementById('state').textContent")).toBe("Playing");
    await shell.waitForTimeout(250);
    await capture(app, shell, "31-masked-playing.png");
    await clickPage({ x: 6, y: 6 });
    await expect.poll(() => inPage<number>("window.toggles")).toBe(2);
    expect(await inPage<number>("window.headerPresses")).toBe(0);
    // Clicks are the page's: the window stays where it is.
    const stayed = await box(shell, win);
    expect(Math.abs(stayed.x - masked.x)).toBeLessThan(1);
    expect(Math.abs(stayed.y - masked.y)).toBeLessThan(1);
    await capture(app, shell, "31-masked.png");

    // ── 2c. The player's own fullscreen button: the page is itself on the whole screen, and masked again after ─
    const fullscreen = (): Promise<boolean> => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen());
    await clickPage({ x: region.w - 8 - 22, y: 8 + 14 });
    await expect.poll(() => inPage<string | null>("document.fullscreenElement?.id ?? null")).toBe("player");
    await expect.poll(fullscreen, { timeout: 15_000 }).toBe(true);
    await expect
      .poll(
        async () => {
          const view = (await liveViews(app)).find((candidate) => candidate.url === urls[0]);
          const content = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentBounds());
          return view !== undefined && view.bounds.width === content.width && (await inPage<number>("innerWidth")) === content.width;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    // (Not awaited: its promise settles only as the window's own transition ends.)
    await inPage("void document.exitFullscreen(); 0");
    await expect.poll(fullscreen, { timeout: 15_000 }).toBe(false);
    await expect(shell.locator(`${win}[data-masked]`)).toHaveCount(1);
    await settled(shell);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await expect.poll(() => inPage<number>("innerWidth")).toBe(pageWidth);
    // The page's toggles were only the two clicks: the fullscreen button's click was its own.
    expect(await inPage<number>("window.toggles")).toBe(2);

    // ── 3. Resized by its corner: the picture scales, its shape kept; the page does not reflow ─
    const corner = await box(shell, `${win} [data-desk-edge="se"]`);
    await place(shell, center(corner), { x: center(corner).x + region.w / 2, y: center(corner).y + 40 });
    await settled(shell);
    const scaled = await box(shell, win);
    expect(Math.abs(scaled.width - region.w * 1.5)).toBeLessThan(3);
    expect(Math.abs((scaled.height - 18) / scaled.width - region.h / region.w)).toBeLessThan(0.01);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    expect(await inPage<number>("innerWidth")).toBe(pageWidth);
    // Scaled, a click still finds the player: the point is mapped at the new scale.
    await clickPage({ x: Math.round(scaled.width - 12), y: Math.round(scaled.height - 18 - 12) });
    await expect.poll(() => inPage<number>("window.toggles")).toBe(3);
    await shell.waitForTimeout(300);
    await capture(app, shell, "32-masked-scaled.png");

    // ── 4. Moved by its handle, its size kept ─────────────────────────────────
    const handle = await box(shell, `${win} .desk-window-pill`);
    await place(shell, center(handle), { x: center(handle).x - 80, y: center(handle).y + 60 });
    await settled(shell);
    const moved = await box(shell, win);
    expect(Math.abs(moved.x - (scaled.x - 80))).toBeLessThan(20);
    expect(Math.abs(moved.y - (scaled.y + 60))).toBeLessThan(20);
    expect(Math.abs(moved.width - scaled.width)).toBeLessThan(2);

    // ── 5. Unmask: the whole window back around the region, the page as it was ─
    await shell.locator(`${win} [data-testid="desk-unmask"]`).click();
    await expect(shell.locator(`${win}[data-masked]`)).toHaveCount(0);
    await settled(shell);
    const whole = await box(shell, win);
    expect(Math.abs(whole.width - before.width)).toBeLessThan(2);
    expect(Math.abs(whole.height - before.height)).toBeLessThan(2);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    expect(await inPage<number>("innerWidth")).toBe(pageWidth);
    await capture(app, shell, "33-unmasked.png");

    // ── 6. Masked again, and the desk left: the pane is the whole page, laid out at the pane's width ─
    const pageAgain = await box(shell, `${win} [data-testid="desk-window-page"]`);
    await shell.mouse.move(pageAgain.x + pageAgain.width / 2, whole.y + 10);
    await shell.locator(`${win} [data-testid="desk-mask"]`).click();
    await expect(shell.locator(`${win} [data-testid="desk-mask-selector"]`)).toBeVisible();
    await shell.mouse.move(pageAgain.x + 60, pageAgain.y + 60);
    await shell.mouse.down();
    await shell.mouse.move(pageAgain.x + 360, pageAgain.y + 260, { steps: 8 });
    await shell.mouse.up();
    await expect(shell.locator(`${win}[data-masked]`)).toHaveCount(1);
    await settled(shell);
    const leftAt = await box(shell, win);
    await shell.mouse.move(10, 10);
    await leaveDesk(shell);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(0);
    await expect
      .poll(async () => {
        const pane = await box(shell, "[data-pane-tab-id]");
        const view = (await liveViews(app)).find((candidate) => candidate.url === urls[0]);
        if (view === undefined) return "no live view";
        const width = await inPage<number>("innerWidth");
        return Math.abs(view.bounds.width - pane.width) < 2 && width === view.bounds.width ? "whole" : `view ${view.bounds.width}, pane ${pane.width}, page ${width}`;
      })
      .toBe("whole");
    await capture(app, shell, "34-left-unmasked.png");

    /** Open the group's desk from its row in the sidebar. */
    const openDesk = async (): Promise<void> => {
      await group.getByTestId("tab-group-header").hover();
      await group.getByTestId("tab-group-desk").click();
      await expect(shell.getByTestId("desk-surface")).toHaveCount(1);
    };
    const leaveAndWait = async (): Promise<void> => {
      await shell.mouse.move(10, 10);
      await leaveDesk(shell);
      await expect(shell.getByTestId("desk-surface")).toHaveCount(0);
      await expect(shell.locator('[data-testid="sidebar-pane"]:not([data-hidden])')).toHaveCount(1);
    };

    // ── 7. Reopened on the other tab: the masked window comes out of the dock masked, as it was left ─
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), ids[1]!);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(ids[1]);
    await openDesk();
    await expect(shell.locator(`${win}[data-masked]`)).toHaveCount(1);
    await settled(shell);
    const back = await box(shell, win);
    expect(Math.abs(back.width - leftAt.width)).toBeLessThan(2);
    expect(Math.abs(back.height - leftAt.height)).toBeLessThan(2);
    expect(Math.abs(back.x - leftAt.x)).toBeLessThan(3);
    expect(Math.abs(back.y - leftAt.y)).toBeLessThan(3);
    // Brought forward (the window in view may lie over it), it is the live region again, and still the page.
    await shell.mouse.click(center(await box(shell, `${win} .desk-window-pill`)).x, center(await box(shell, `${win} .desk-window-pill`)).y);
    await settled(shell);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await expect.poll(() => inPage<number>("innerWidth")).toBe(pageWidth);
    const togglesBefore = await inPage<number>("window.toggles");
    await clickPage({ x: Math.round(back.width / 2), y: Math.round((back.height - 18) / 2) });
    await expect.poll(() => inPage<number>("window.toggles")).toBe(togglesBefore + 1);
    await capture(app, shell, "35-reopened-masked.png");

    // ── 8. Reopened on the masked window itself: it lifts off whole, is masked again, and goes where it was left ─
    await leaveAndWait();
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), ids[0]!);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(ids[0]);
    await openDesk();
    await expect(shell.locator(`${win}[data-masked]`)).toHaveCount(1, { timeout: 10_000 });
    await settled(shell);
    const again = await box(shell, win);
    expect(Math.abs(again.width - leftAt.width)).toBeLessThan(2);
    expect(Math.abs(again.x - leftAt.x)).toBeLessThan(3);
    expect(Math.abs(again.y - leftAt.y)).toBeLessThan(3);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await expect.poll(() => inPage<number>("innerWidth")).toBe(pageWidth);
    await capture(app, shell, "36-reopened-on-mask.png");
  } finally {
    await app.close();
  }
});

test("a mask never lets its page see a resize, and its region can be edited: the whole page shown faded around it, edges dragged, Done or Escape", async () => {
  test.setTimeout(120_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-mask-edit-"));
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
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    const shell = await shellReady(app);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === "pistachio://demo/invoices")).toBe(true);
    const origin = await serveDockSites(app);
    const urls = [`${origin}/player`, "pistachio://demo/vendors/atlas-medical"];
    for (const url of urls) await shell.evaluate((address) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(address), url);
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url)).length).toBe(2);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    const ids = urls.map((url) => byUrl.get(url)!);
    await shell.evaluate((tabIds) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id: "desk-mask-edit", tabIds, title: "Mask", color: "green" }), ids);
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), ids[0]!);
    const group = shell.getByTestId("tab-group");
    await group.getByTestId("tab-group-header").hover();
    await group.getByTestId("tab-group-desk").click();
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(2);
    await settled(shell);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);

    const inPage = <T,>(script: string): Promise<T> =>
      app.evaluate(
        ({ webContents }, { url, script }) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.executeJavaScript(script),
        { url: urls[0]!, script },
      ) as Promise<T>;
    const clickPage = (point: { x: number; y: number }): Promise<void> =>
      app.evaluate(
        async ({ webContents }, { url, point }) => {
          const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
          contents.sendInputEvent({ type: "mouseMove", ...point });
          contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
          await new Promise((done) => setTimeout(done, 40));
          contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
          await new Promise((done) => setTimeout(done, 120));
        },
        { url: urls[0]!, point },
      );
    /** Everything the page could notice of its size, from now on: every resize, and every width a max-width query saw. */
    await inPage(`(() => {
      window.__sizes = [];
      const note = (why) => window.__sizes.push(why + " " + innerWidth + "x" + innerHeight);
      addEventListener("resize", () => note("resize"));
      visualViewport.addEventListener("resize", () => note("visual"));
      const narrow = matchMedia("(max-width: " + (innerWidth - 1) + "px)");
      narrow.addEventListener("change", () => note("media"));
      new ResizeObserver(() => note("observed")).observe(document.documentElement);
      return true;
    })()`);
    // A ResizeObserver reports once as it starts observing: that is not the page resizing.
    await expect.poll(() => inPage<string[]>("window.__sizes")).toHaveLength(1);
    await inPage("window.__sizes.length = 0");
    const pageWidth = await inPage<number>("innerWidth");
    const pageHeight = await inPage<number>("innerHeight");
    const win = windowSelector(ids[0]!);
    const page = await box(shell, `${win} [data-testid="desk-window-page"]`);

    // ── 1. Mask the player: the page never sees its size change, not for a frame ─
    await shell.mouse.move(page.x + page.width / 2, page.y - 10);
    await shell.locator(`${win} [data-testid="desk-mask"]`).click();
    await expect(shell.locator(`${win} [data-testid="desk-mask-selector"]`)).toBeVisible();
    const region = { x: 40, y: 88, w: 480, h: 270 };
    await shell.mouse.move(page.x + region.x, page.y + region.y);
    await shell.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await shell.mouse.move(page.x + region.x + (region.w * step) / 10, page.y + region.y + (region.h * step) / 10);
      await shell.waitForTimeout(16);
    }
    await shell.mouse.up();
    await expect(shell.locator(`${win}[data-masked]`)).toHaveCount(1);
    await settled(shell);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await shell.waitForTimeout(300);
    expect(await inPage<string[]>("window.__sizes")).toEqual([]);
    expect(await inPage<number>("innerWidth")).toBe(pageWidth);
    expect(await inPage<number>("innerHeight")).toBe(pageHeight);
    const masked = await box(shell, win);

    // ── 2. Edit mask (the window in use): the whole page, faded, around the region ─
    await shell.locator(`${win} [data-testid="desk-edit-mask"]`).click();
    const editor = shell.locator(`${win} [data-testid="desk-mask-editor"]`);
    await expect(editor).toHaveAttribute("data-shown", "");
    await expect(editor).toHaveAttribute("data-whole", "");
    await expect(shell.locator(`${win}[data-editing="shown"]`)).toHaveCount(1);
    // Every picture the editor shows is of the whole page, in the page's shape: never one
    // taken before its view had the size for it (the region's box, scaled up and cropped).
    const shapes: number[] = [];
    for (let sample = 0; sample < 16; sample += 1) {
      const shape = await shell.evaluate((selector) => {
        const image = document.querySelector<HTMLImageElement>(selector);
        return image !== null && image.complete && image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : null;
      }, `${win} [data-testid="desk-mask-editor"][data-shown] .desk-mask-editor-shot img`);
      if (shape !== null) shapes.push(shape);
      await shell.waitForTimeout(40);
    }
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) expect(Math.abs(shape - pageWidth / pageHeight)).toBeLessThan(0.03);
    // The page's own view is down meanwhile; the editor's region is where the window's was.
    await expect.poll(async () => (await liveViews(app)).some((view) => view.url === urls[0])).toBe(false);
    const editRegion = await box(shell, `${win} [data-testid="desk-mask-editor-region"]`);
    expect(Math.abs(editRegion.x - masked.x)).toBeLessThan(2);
    expect(Math.abs(editRegion.y - (masked.y + 18))).toBeLessThan(2);
    expect(Math.abs(editRegion.width - region.w)).toBeLessThan(2);
    await shell.waitForTimeout(200);
    await capture(app, shell, "37-mask-editing.png");

    // ── 3. Drag the bottom-right corner out: the region grows over the page ────
    const corner = center(await box(shell, `${win} [data-handle="se"]`));
    await shell.mouse.move(corner.x, corner.y);
    await shell.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await shell.mouse.move(corner.x + (80 * step) / 8, corner.y + (40 * step) / 8);
      await shell.waitForTimeout(16);
    }
    await expect(shell.locator(`${win} [data-testid="desk-mask-editor"] .desk-mask-size`)).toHaveText(`${region.w + 80} × ${region.h + 40}`);
    await capture(app, shell, "38-mask-edit-dragging.png");
    await shell.mouse.up();

    // ── 4. Done: the window is the new region, live, where it lies on the page ──
    await shell.getByTestId("desk-mask-edit-done").click();
    await expect(editor).toHaveCount(0);
    await settled(shell);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    const edited = await box(shell, win);
    expect(Math.abs(edited.x - masked.x)).toBeLessThan(2);
    expect(Math.abs(edited.y - masked.y)).toBeLessThan(2);
    expect(Math.abs(edited.width - (region.w + 80))).toBeLessThan(2);
    expect(Math.abs(edited.height - (region.h + 40 + 18))).toBeLessThan(2);
    // Still the page, its clicks mapped through the new region: the player plays.
    await clickPage({ x: 240, y: 135 });
    await expect.poll(() => inPage<number>("window.toggles")).toBe(1);
    await shell.waitForTimeout(250);
    await capture(app, shell, "39-mask-edited.png");
    // And through all of it, the page never saw its size change.
    expect(await inPage<string[]>("window.__sizes")).toEqual([]);
    expect(await inPage<number>("innerWidth")).toBe(pageWidth);

    // ── 5. Edit again, move the region, and Escape: nothing changes ──────────────
    await shell.locator(`${win} [data-testid="desk-edit-mask"]`).click();
    await expect(editor).toHaveAttribute("data-shown", "");
    const inside = center(await box(shell, `${win} [data-testid="desk-mask-editor-region"]`));
    await shell.mouse.move(inside.x, inside.y);
    await shell.mouse.down();
    await shell.mouse.move(inside.x + 30, inside.y + 30, { steps: 4 });
    await shell.mouse.up();
    await shell.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await settled(shell);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    const kept = await box(shell, win);
    expect(Math.abs(kept.x - edited.x)).toBeLessThan(2);
    expect(Math.abs(kept.width - edited.width)).toBeLessThan(2);
    expect(await inPage<string[]>("window.__sizes")).toEqual([]);

    // ── 6. Unmask: the whole page back around the region — and the page, laid out at its
    //      own box all along, never sees its size change, not for a frame of the way back ─
    await shell.locator(`${win} [data-testid="desk-unmask"]`).click();
    await expect(shell.locator(`${win}[data-masked]`)).toHaveCount(0);
    await capture(app, shell, "39b-unmasking.png");
    await shell.waitForTimeout(120);
    await capture(app, shell, "39c-unmasking-later.png");
    await settled(shell);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await shell.waitForTimeout(300);
    expect(await inPage<string[]>("window.__sizes")).toEqual([]);
    expect(await inPage<number>("innerWidth")).toBe(pageWidth);
    expect(await inPage<number>("innerHeight")).toBe(pageHeight);
    const whole = await box(shell, `${win} [data-testid="desk-window-page"]`);
    expect(Math.abs(whole.width - pageWidth)).toBeLessThan(2);
    expect(Math.abs(whole.height - pageHeight)).toBeLessThan(2);
    await capture(app, shell, "39d-unmasked.png");
  } finally {
    await app.close();
  }
});

test("the dock lists the Space's other groups; choosing one passes the desk to it, each group's windows going home and coming back where they were left", async () => {
  test.setTimeout(150_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-groups-"));
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
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    const shell = await shellReady(app);
    const urls = [
      "pistachio://demo/invoices",
      "pistachio://demo/vendors/atlas-medical",
      "pistachio://demo/invoices?page=north",
      "pistachio://demo/invoices?page=south",
      "pistachio://demo/invoices?page=east",
    ];
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === urls[0])).toBe(true);
    for (const url of urls.slice(1)) await shell.evaluate((address) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(address), url);
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url)).length).toBe(urls.length);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    const ids = urls.map((url) => byUrl.get(url)!);
    const [a0, a1, b0, b1, b2] = ids as [string, string, string, string, string];
    const create = (id: string, tabIds: string[], title: string, color: string): Promise<unknown> =>
      shell.evaluate(
        ({ id, tabIds, title, color }) =>
          (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id, tabIds, title, color } as never),
        { id, tabIds, title, color },
      );
    await create("desk-a", [a0, a1], "Research", "blue");
    await create("desk-b", [b0, b1, b2], "Regions", "orange");
    // The tab used last in Regions: south, so it is the one Regions opens on.
    for (const tabId of [b1, b0, b2, a0]) {
      await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(id), tabId);
      await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(tabId);
    }
    const header = shell.locator('[data-testid="tab-group"]').filter({ hasText: "Research" }).getByTestId("tab-group-header");
    await header.hover();
    await shell.locator('[data-testid="tab-group"]').filter({ hasText: "Research" }).getByTestId("tab-group-desk").click();
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(2);
    await settled(shell);

    // ── 1. Under the group's tabs, the Space's other group: its tabs' icons in a pile ─
    const groupIcon = (id: string) => shell.locator(`[data-testid="desk-dock-group"][data-group-id="${id}"]`);
    await expect(shell.getByTestId("desk-dock-group")).toHaveCount(1);
    await expect(groupIcon("desk-b")).toBeVisible();
    await expect(groupIcon("desk-b").getByTestId("favicon-cluster")).toHaveCount(1);
    const stage = await box(shell, ".desk-stage");
    /** Off the dock: its preview and tooltips cover the pages beside it, which are stills meanwhile. */
    const awayFromDock = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.95);
    // Research: a second window out, both moved to where they are to be left.
    await shell.locator(iconSelector(a1)).click();
    await awayFromDock();
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell);
    await expectLiveIn(app, shell, urls[1]!, a1);
    const researchLeft = { [a0]: await box(shell, windowSelector(a0)), [a1]: await box(shell, windowSelector(a1)) };
    // Hovered, its card: its desk drawn small as it would come out — never
    // on a desk, its tab used last alone, pictured — and its name.
    await groupIcon("desk-b").hover();
    const groupCard = (id: string) => shell.locator(`[data-testid="desk-dock-group-card"][data-group-id="${id}"][data-shown]`);
    await expect(groupCard("desk-b")).toContainText("Regions");
    await expect(groupCard("desk-b")).toContainText("3 tabs · 1 on its desk");
    await expect(groupCard("desk-b").getByTestId("desk-sketch-window")).toHaveCount(1);
    await expect(groupCard("desk-b").locator(`[data-testid="desk-sketch-window"][data-tab-id="${b2}"][data-focused]`)).toHaveCount(1);
    await expect(groupCard("desk-b").locator("img.desk-still")).toHaveCount(1);
    await shell.waitForTimeout(250);
    await capture(app, shell, "40-dock-groups.png");

    // ── 2. Choose Regions: Research goes into its icon, Regions opens on the tab used last ─
    await groupIcon("desk-b").click();
    await shell.waitForTimeout(140);
    await capture(app, shell, "41-group-switching.png");
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(3);
    await expect(groupIcon("desk-a")).toBeVisible();
    await expect(groupIcon("desk-b")).toHaveCount(0);
    await awayFromDock();
    await settled(shell);
    // Never on a desk: its tab used last, alone, in the middle.
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await expect(shell.locator(windowSelector(b2))).toHaveCount(1);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(b2);
    await expectLiveIn(app, shell, urls[4]!, b2);
    await expect(shell.getByTestId("desk-surface")).toBeVisible();
    await capture(app, shell, "42-group-switched.png");
    // Regions: another window out, then left as it is.
    await shell.locator(iconSelector(b0)).click();
    await awayFromDock();
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell);
    const regionsLeft = { [b0]: await box(shell, windowSelector(b0)), [b2]: await box(shell, windowSelector(b2)) };

    // ── 3. Research's card: its desk as it was left, drawn small ─────────────
    await groupIcon("desk-a").hover();
    await expect(groupCard("desk-a").getByTestId("desk-sketch-window")).toHaveCount(2);
    await expect(groupCard("desk-a").locator(`[data-testid="desk-sketch-window"][data-tab-id="${a1}"][data-focused]`)).toHaveCount(1);
    await expect(groupCard("desk-a").locator("img.desk-still")).toHaveCount(2);
    // (Settled out of its opening motion before it is measured.)
    await shell.waitForTimeout(250);
    const sketch = await box(shell, '[data-testid="desk-dock-group-card"] [data-testid="desk-sketch"]');
    const scale = stage.width / sketch.width;
    expect(Math.abs(sketch.height * scale - stage.height)).toBeLessThan(4);
    for (const tabId of [a0, a1]) {
      const small = await box(shell, `[data-testid="desk-sketch-window"][data-tab-id="${tabId}"]`);
      const was = researchLeft[tabId]!;
      expect(Math.abs(stage.x + (small.x - sketch.x) * scale - was.x)).toBeLessThan(6);
      expect(Math.abs(stage.y + (small.y - sketch.y) * scale - was.y)).toBeLessThan(6);
      expect(Math.abs(small.width * scale - was.width)).toBeLessThan(6);
      expect(Math.abs(small.height * scale - was.height)).toBeLessThan(6);
    }
    await capture(app, shell, "42b-group-card.png");

    // ── 3b. Back to Research: its windows come back where they were left ──────
    await groupIcon("desk-a").click();
    await awayFromDock();
    await settled(shell);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    for (const tabId of [a0, a1]) {
      const now = await box(shell, windowSelector(tabId));
      const was = researchLeft[tabId]!;
      expect(Math.abs(now.x - was.x)).toBeLessThan(3);
      expect(Math.abs(now.y - was.y)).toBeLessThan(3);
      expect(Math.abs(now.width - was.width)).toBeLessThan(3);
      expect(Math.abs(now.height - was.height)).toBeLessThan(3);
    }
    // The window on top when it was left is the one in use again.
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(a1);
    await expectLiveIn(app, shell, urls[1]!, a1);
    await capture(app, shell, "43-group-back.png");

    // ── 4. And Regions again, as it was left ─────────────────────────────────────
    await groupIcon("desk-b").click();
    await awayFromDock();
    await settled(shell);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    for (const tabId of [b0, b2]) {
      const now = await box(shell, windowSelector(tabId));
      const was = regionsLeft[tabId]!;
      expect(Math.abs(now.x - was.x)).toBeLessThan(3);
      expect(Math.abs(now.y - was.y)).toBeLessThan(3);
    }
    await expectLiveIn(app, shell, urls[2]!, b0);

    // ── 4b. To Research and straight back, Regions' windows still on their way home:
    // they turn round, to where they were left ─
    await groupIcon("desk-a").click();
    await groupIcon("desk-b").click({ force: true });
    await awayFromDock();
    await settled(shell);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    for (const tabId of [b0, b2]) {
      const now = await box(shell, windowSelector(tabId));
      const was = regionsLeft[tabId]!;
      expect(Math.abs(now.x - was.x)).toBeLessThan(3);
      expect(Math.abs(now.y - was.y)).toBeLessThan(3);
    }
    await expectLiveIn(app, shell, urls[2]!, b0);

    // ── 5. Leave: the window in use is the pane, and the desk is gone ──────────
    await leaveDesk(shell);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(0);
    await expect(shell.getByTestId("browser-surface")).toBeVisible();
    expect((await snapshot(shell)).activeTabId).toBe(b0);
  } finally {
    await app.close();
  }
});

test("the dock rearranges: a tab's icon among the group's tabs, a group's among the groups, and a tab let go on another group's icon goes into it", async () => {
  test.setTimeout(150_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-rearrange-"));
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
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    await clearOfCursor(app);
    const shell = await shellReady(app);
    const urls = [
      "pistachio://demo/invoices",
      "pistachio://demo/vendors/atlas-medical",
      "pistachio://demo/invoices?page=north",
      "pistachio://demo/invoices?page=south",
      "pistachio://demo/invoices?page=east",
    ];
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === urls[0])).toBe(true);
    for (const url of urls.slice(1)) await shell.evaluate((address) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(address), url);
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url)).length).toBe(urls.length);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    const [a0, a1, a2, b0, c0] = urls.map((url) => byUrl.get(url)!) as [string, string, string, string, string];
    const create = (id: string, tabIds: string[], title: string, color: string): Promise<unknown> =>
      shell.evaluate(
        ({ id, tabIds, title, color }) =>
          (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id, tabIds, title, color } as never),
        { id, tabIds, title, color },
      );
    // The row: Research, then Regions, then Vendors.
    await create("desk-a", [a0, a1, a2], "Research", "blue");
    await create("desk-b", [b0], "Regions", "orange");
    await create("desk-c", [c0], "Vendors", "green");
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(id), a0);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(a0);
    const research = shell.locator('[data-testid="tab-group"]').filter({ hasText: "Research" });
    await research.getByTestId("tab-group-header").hover();
    await research.getByTestId("tab-group-desk").click();
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(3);
    await settled(shell);

    const groupIcon = (id: string) => shell.locator(`[data-testid="desk-dock-group"][data-group-id="${id}"]`);
    const groupTile = (id: string): string => `[data-testid="desk-dock-group"][data-group-id="${id}"] .desk-dock-tile`;
    const dockTabs = (): Promise<Array<string | null>> =>
      shell.getByTestId("desk-dock-icon").evaluateAll((els) => els.map((el) => el.getAttribute("data-tab-id")));
    const dockGroups = (): Promise<Array<string | null>> =>
      shell.getByTestId("desk-dock-group").evaluateAll((els) => els.map((el) => el.getAttribute("data-group-id")));
    const members = async (id: string): Promise<string[] | null> => (await snapshot(shell)).tabGroups.find((group) => group.id === id)?.tabIds ?? null;
    /** The groups as the sidebar lists them: where their tabs sit in the row. */
    const rowGroups = async (): Promise<string[]> => {
      const { tabs, tabGroups } = await snapshot(shell);
      const at = (tabIds: string[]): number => Math.min(...tabIds.map((tabId) => tabs.findIndex((tab) => tab.id === tabId)));
      return [...tabGroups].sort((a, b) => at(a.tabIds) - at(b.tabIds)).map((group) => group.id);
    };
    /** Press an icon and carry it slowly to `to`, in the dock; `whileHeld` runs before it is let go. */
    const carry = async (from: { x: number; y: number }, to: { x: number; y: number }, whileHeld: () => Promise<void>): Promise<void> => {
      await shell.mouse.move(from.x, from.y);
      await shell.mouse.down();
      await shell.mouse.move(from.x, from.y + 6, { steps: 2 });
      for (let step = 1; step <= 12; step += 1) {
        await shell.mouse.move(from.x + ((to.x - from.x) * step) / 12, from.y + ((to.y - from.y) * step) / 12);
        await shell.waitForTimeout(16);
      }
      // The icons have made room.
      await shell.waitForTimeout(300);
      await whileHeld();
      await shell.mouse.up();
    };
    const stage = await box(shell, ".desk-stage");
    const awayFromDock = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.95);
    expect(await dockTabs()).toEqual([a0, a1, a2]);
    expect(await dockGroups()).toEqual(["desk-b", "desk-c"]);

    // ── 1. A tab's icon down the dock: the others make room, and let go, it takes that place ─
    const pitch = center(await box(shell, iconSelector(a1))).y - center(await box(shell, iconSelector(a0))).y;
    await carry(center(await box(shell, iconSelector(a0))), { x: center(await box(shell, iconSelector(a2))).x, y: center(await box(shell, iconSelector(a2))).y + 10 }, async () => {
      await expect(shell.locator(".desk-dock-icons[data-reordering]")).toHaveCount(1);
      await expect(shell.locator(".desk-dock-ghost[data-on]")).toHaveCount(1);
      // Its neighbours each moved up a place, into the room it left.
      for (const tabId of [a1, a2]) {
        const shift = await shell.locator(`[data-testid="desk-dock-icon"][data-tab-id="${tabId}"]`).evaluate((el) => getComputedStyle(el).translate);
        expect(Number.parseFloat(shift.split(" ")[1] ?? "0")).toBeCloseTo(-pitch, 0);
      }
      await capture(app, shell, "50-dock-tab-reordering.png");
    });
    await expect.poll(() => members("desk-a")).toEqual([a1, a2, a0]);
    await expect.poll(dockTabs).toEqual([a1, a2, a0]);
    await expect(shell.locator(".desk-dock-ghost[data-on]")).toHaveCount(0);
    // At rest where it went, and nothing on the desk moved.
    expect(center(await box(shell, iconSelector(a0))).y).toBeGreaterThan(center(await box(shell, iconSelector(a2))).y);
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await expect(shell.locator(windowSelector(a0))).toHaveCount(1);
    await awayFromDock();
    await settled(shell);
    await capture(app, shell, "51-dock-tab-reordered.png");

    // ── 2. A group's icon up among the groups: Vendors above Regions, in the sidebar too ─
    await carry(center(await box(shell, groupTile("desk-c"))), { x: center(await box(shell, groupTile("desk-b"))).x, y: center(await box(shell, groupTile("desk-b"))).y - 10 }, async () => {
      await expect(shell.locator(".desk-dock-groups[data-reordering]")).toHaveCount(1);
      await expect(groupIcon("desk-c")).toHaveAttribute("data-in-hand", "");
      await capture(app, shell, "52-dock-group-reordering.png");
    });
    await expect.poll(dockGroups).toEqual(["desk-c", "desk-b"]);
    await expect.poll(rowGroups).toEqual(["desk-a", "desk-c", "desk-b"]);
    // A drag is not a click: the desk is still Research's.
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(3);
    await awayFromDock();
    await settled(shell);
    await capture(app, shell, "53-dock-groups-reordered.png");

    // ── 3. A tab's icon let go on another group's, as an app into a folder: it goes into that group ─
    await carry(center(await box(shell, iconSelector(a2))), center(await box(shell, groupTile("desk-b"))), async () => {
      await expect(groupIcon("desk-b")).toHaveAttribute("data-drop-target", "");
      await expect(shell.locator(".desk-dock-ghost[data-into]")).toHaveCount(1);
      // Grown and ringed, the group's icon is whole: the groups' scroll box, which clips, has room for it.
      const reach = await shell.locator(groupTile("desk-b")).evaluate((tile) => {
        const ring = 2;
        const box = tile.getBoundingClientRect();
        const clip = tile.closest(".desk-dock-groups")!.getBoundingClientRect();
        return Math.min(box.left - ring - clip.left, clip.right - (box.right + ring), box.top - ring - clip.top, clip.bottom - (box.bottom + ring));
      });
      expect(reach).toBeGreaterThanOrEqual(0);
      await capture(app, shell, "54-dock-tab-over-group.png");
    });
    await expect.poll(() => members("desk-b")).toEqual([b0, a2]);
    await expect.poll(() => members("desk-a")).toEqual([a1, a0]);
    await expect.poll(dockTabs).toEqual([a1, a0]);
    // The group took it where it stands: it did not move to where the tab was.
    expect(await dockGroups()).toEqual(["desk-c", "desk-b"]);
    expect(await rowGroups()).toEqual(["desk-a", "desk-c", "desk-b"]);
    await expect(shell.getByTestId("desk-surface")).toBeVisible();
    expect((await snapshot(shell)).activeTabId).toBe(a0);
    await awayFromDock();
    await settled(shell);
    await capture(app, shell, "55-dock-tab-in-group.png");

    // ── 4. The icon of the window in use, into another group: its window flies into that
    //      group's icon, and the group's other tab takes over, out on the desk ─
    await carry(center(await box(shell, iconSelector(a0))), center(await box(shell, groupTile("desk-c"))), async () => {
      await expect(groupIcon("desk-c")).toHaveAttribute("data-drop-target", "");
    });
    await shell.waitForTimeout(120);
    await capture(app, shell, "56-dock-window-into-group.png");
    await expect.poll(() => members("desk-c")).toEqual([c0, a0]);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(a1);
    await expect(shell.getByTestId("desk-surface")).toBeVisible();
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(1);
    await awayFromDock();
    await settled(shell);
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await expect(shell.locator(windowSelector(a1))).toHaveCount(1);
    await expectLiveIn(app, shell, urls[1]!, a1);
    // Its card: the tab is among the group's now.
    await groupIcon("desk-c").hover();
    await expect(shell.locator('[data-testid="desk-dock-group-card"][data-group-id="desk-c"][data-shown]')).toContainText("2 tabs");
    await shell.waitForTimeout(250);
    await capture(app, shell, "57-dock-window-in-group.png");

    // ── 5. A click on a group's icon still passes the desk to it ────────────────
    await groupIcon("desk-c").click();
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(2);
    await expect(groupIcon("desk-a")).toBeVisible();
    await awayFromDock();
    await settled(shell);
  } finally {
    await app.close();
  }
});

test("the dock's icons have the sidebar's menus: a tab's, after what the desk does with its window, and a group's, its name edited beside its icon", async () => {
  test.setTimeout(150_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-menus-"));
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
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    await clearOfCursor(app);
    const shell = await shellReady(app);
    const urls = [
      "pistachio://demo/invoices",
      "pistachio://demo/vendors/atlas-medical",
      "pistachio://demo/invoices?page=north",
      "pistachio://demo/invoices?page=south",
    ];
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === urls[0])).toBe(true);
    for (const url of urls.slice(1)) await shell.evaluate((address) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(address), url);
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url)).length).toBe(urls.length);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    const [a0, a1, a2, b0] = urls.map((url) => byUrl.get(url)!) as [string, string, string, string];
    const create = (id: string, tabIds: string[], title: string, color: string): Promise<unknown> =>
      shell.evaluate(
        ({ id, tabIds, title, color }) =>
          (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id, tabIds, title, color } as never),
        { id, tabIds, title, color },
      );
    await create("desk-a", [a0, a1, a2], "Research", "blue");
    await create("desk-b", [b0], "Regions", "orange");
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(id), a0);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(a0);
    const research = shell.locator('[data-testid="tab-group"]').filter({ hasText: "Research" });
    await research.getByTestId("tab-group-header").hover();
    await research.getByTestId("tab-group-desk").click();
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(3);
    await settled(shell);

    const menu = shell.getByTestId("context-menu");
    const item = (name: string) => menu.getByRole("menuitem", { name, exact: true });
    const groupIcon = (id: string) => shell.locator(`[data-testid="desk-dock-group"][data-group-id="${id}"]`);
    const members = async (id: string): Promise<string[] | null> => (await snapshot(shell)).tabGroups.find((group) => group.id === id)?.tabIds ?? null;
    const stage = await box(shell, ".desk-stage");
    const awayFromDock = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.95);
    /** A right-click on an icon, and its menu up (drawn once the pages have given way to their stills). */
    const menuOn = async (selector: string): Promise<void> => {
      await shell.locator(selector).click({ button: "right" });
      await expect(menu).toBeVisible();
      await expect(menu).not.toHaveClass(/opacity-0/);
    };
    const choose = async (name: string): Promise<void> => {
      await item(name).click();
      await expect(menu).toHaveCount(0);
    };

    // ── 1. A tab in the dock: out onto the desk, then the sidebar's own entries, with no split view ─
    await menuOn(iconSelector(a1));
    await expect(item("Open on the desk")).toBeVisible();
    for (const name of ["Pin tab", "Add to favorites", "Remove from “Research”", "New group with this tab", "Add to “Regions”", "Duplicate tab", "Suspend tab", "Close tab"]) {
      await expect(item(name)).toBeVisible();
    }
    await expect(menu.getByRole("menuitem", { name: /split/i })).toHaveCount(0);
    await expect(item("Put away")).toHaveCount(0);
    await shell.waitForTimeout(200);
    await capture(app, shell, "58-dock-tab-menu.png");
    await choose("Open on the desk");
    await expect(shell.locator(windowSelector(a1))).toHaveCount(1);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(a1);
    await awayFromDock();
    await settled(shell);

    // ── 2. A tab out on the desk: put away, or (not the window in use) brought to the front; it cannot be suspended ─
    await menuOn(iconSelector(a1));
    await expect(item("Put away")).toBeVisible();
    await expect(item("Bring to front")).toHaveCount(0);
    await expect(item("Suspend tab")).toBeDisabled();
    await shell.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await menuOn(iconSelector(a0));
    await expect(item("Bring to front")).toBeVisible();
    await choose("Bring to front");
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(a0);
    await menuOn(iconSelector(a1));
    await choose("Put away");
    await expect(shell.locator(windowSelector(a1))).toHaveCount(0);
    await awayFromDock();
    await settled(shell);

    // ── 3. Into another group from the menu: gone from the dock, into that group ─
    await menuOn(iconSelector(a2));
    await choose("Add to “Regions”");
    await expect.poll(() => members("desk-b")).toEqual([b0, a2]);
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(2);
    await expect(shell.getByTestId("desk-surface")).toBeVisible();

    // ── 4. The tab in use taken out of the group: the desk stays, on another of its tabs ─
    await menuOn(iconSelector(a1));
    await choose("Open on the desk");
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(a1);
    await awayFromDock();
    await settled(shell);
    await menuOn(iconSelector(a1));
    await choose("Remove from “Research”");
    await expect.poll(() => members("desk-a")).toEqual([a0]);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(a0);
    await expect(shell.getByTestId("desk-surface")).toBeVisible();
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await awayFromDock();
    await settled(shell);

    // ── 5. Duplicated: the copy joins the group beside it and comes out on the desk, in use ─
    await menuOn(iconSelector(a0));
    await choose("Duplicate tab");
    await expect.poll(async () => (await members("desk-a"))?.length).toBe(2);
    const copy = (await members("desk-a"))![1]!;
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(copy);
    await expect(shell.getByTestId("desk-surface")).toBeVisible();
    await expect(shell.locator(windowSelector(copy))).toHaveCount(1);
    await awayFromDock();
    await settled(shell);

    // ── 6. Another group's icon: the sidebar's menu for the group (no "Keep open": a desk has no row to hold) ─
    await menuOn(`[data-testid="desk-dock-group"][data-group-id="desk-b"] .desk-dock-tile`);
    for (const name of ["Rename", "New tab in group", "Open as split view", "Open as desk", "Ungroup tabs", "Close group"]) {
      await expect(item(name)).toBeVisible();
    }
    await expect(item("Keep open")).toHaveCount(0);
    // Under the menu the pages are down; the window in use shows the picture main took of it, never a blank.
    await expect(shell.locator(`${windowSelector(copy)} [data-testid="desk-window-page"] img.desk-still`)).toHaveCount(1);
    await shell.waitForTimeout(200);
    await capture(app, shell, "59-dock-group-menu.png");
    // Rename: a field beside its icon, which has the keyboard.
    await choose("Rename");
    const rename = shell.locator('[data-testid="desk-dock-rename"][data-group-id="desk-b"][data-shown]');
    await expect(rename).toBeVisible();
    await expect(rename.getByTestId("tab-group-name-input")).toBeFocused();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.isFocused())).toBe(true);
    const iconMiddle = center(await box(shell, `[data-testid="desk-dock-group"][data-group-id="desk-b"]`)).y;
    expect(Math.abs(center(await box(shell, '[data-testid="desk-dock-rename"]')).y - iconMiddle)).toBeLessThan(2);
    await shell.keyboard.type("Places");
    await shell.waitForTimeout(250);
    await capture(app, shell, "60-dock-group-rename.png");
    await shell.keyboard.press("Enter");
    await expect(rename).toHaveCount(0);
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === "desk-b")?.title).toBe("Places");
    // Its colour, from the swatches.
    await menuOn(`[data-testid="desk-dock-group"][data-group-id="desk-b"] .desk-dock-tile`);
    await menu.getByTestId("group-color-green").click();
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === "desk-b")?.color).toBe("green");
    await expect(groupIcon("desk-b")).toHaveAttribute("data-group-color", "green");

    // ── 7. Open as desk: the desk passes to it in place ─────────────────────────
    await menuOn(`[data-testid="desk-dock-group"][data-group-id="desk-b"] .desk-dock-tile`);
    await choose("Open as desk");
    await expect(groupIcon("desk-a")).toBeVisible();
    await expect(groupIcon("desk-b")).toHaveCount(0);
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(2);
    await expect(shell.getByTestId("desk-surface")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("the More card holds the arrangements, with keyboard shortcuts struck in a page or the shell, and Glide's deceleration", async () => {
  test.setTimeout(120_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-more-"));
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
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    await clearOfCursor(app);
    const shell = await shellReady(app);
    const urls = ["pistachio://demo/invoices", "pistachio://demo/vendors/atlas-medical", "pistachio://demo/invoices?page=north"];
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === urls[0])).toBe(true);
    for (const url of urls.slice(1)) await shell.evaluate((address) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(address), url);
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url)).length).toBe(urls.length);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    const ids = urls.map((url) => byUrl.get(url)!);
    await shell.evaluate((tabIds) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id: "desk-more", tabIds, title: "More", color: "purple" }), ids);
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), ids[0]!);
    const group = shell.getByTestId("tab-group");
    await group.getByTestId("tab-group-header").hover();
    await group.getByTestId("tab-group-desk").click();
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(3);
    await settled(shell);
    const stage = await box(shell, ".desk-stage");
    const awayFromDock = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.95);
    for (const tabId of ids.slice(1)) {
      await shell.locator(iconSelector(tabId)).click();
      await expect(shell.locator(windowSelector(tabId))).toHaveCount(1);
    }
    await awayFromDock();
    await settled(shell);

    // ── 1. The dock's tools are the new tab and More; the arrangements are on More's card, with their keys ─
    await expect(shell.locator(".desk-dock-tools button")).toHaveCount(2);
    await openMore(shell);
    await expect(shell.getByTestId("desk-tile")).toContainText("⌘⌥T");
    await expect(shell.getByTestId("desk-cascade")).toContainText("⌘⌥C");
    await awayFromDock();
    await expect(shell.getByTestId("desk-more-card")).toHaveCount(0);

    /** ⌘⌥ and a key, struck where the keyboard is: the window in use's page, or the shell. */
    const strike = (target: "page" | "shell", keyCode: string, url?: string): Promise<void> =>
      app.evaluate(
        ({ BrowserWindow, webContents }, { target, keyCode, url }) => {
          const contents =
            target === "shell" ? BrowserWindow.getAllWindows()[0]!.webContents : webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
          contents.focus();
          contents.sendInputEvent({ type: "keyDown", keyCode: "Meta", modifiers: ["meta"] });
          contents.sendInputEvent({ type: "keyDown", keyCode: "Alt", modifiers: ["meta", "alt"] });
          contents.sendInputEvent({ type: "keyDown", keyCode, modifiers: ["meta", "alt"] });
          contents.sendInputEvent({ type: "keyUp", keyCode, modifiers: ["meta", "alt"] });
          contents.sendInputEvent({ type: "keyUp", keyCode: "Alt", modifiers: ["meta"] });
          contents.sendInputEvent({ type: "keyUp", keyCode: "Meta", modifiers: [] });
        },
        { target, keyCode, url },
      );
    const boxes = async (): Promise<Box[]> => Promise.all(ids.map((tabId) => box(shell, windowSelector(tabId))));
    const overlap = (a: Box, b: Box): boolean => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

    // ── 2. ⌘⌥C in the window's page: the windows cascade, each a step down and along from the last ─
    const inUse = (await snapshot(shell)).activeTabId!;
    await strike("page", "c", urls[ids.indexOf(inUse)]);
    await settled(shell);
    const cascaded = (await boxes()).sort((a, b) => a.x - b.x);
    for (let index = 1; index < cascaded.length; index += 1) {
      expect(cascaded[index]!.x).toBeGreaterThan(cascaded[index - 1]!.x + 8);
      expect(cascaded[index]!.y).toBeGreaterThan(cascaded[index - 1]!.y + 8);
      expect(overlap(cascaded[index]!, cascaded[index - 1]!)).toBe(true);
    }
    await capture(app, shell, "61-desk-cascade-key.png");

    // ── 3. ⌘⌥T with the shell holding the keyboard: tiled, side by side, beside the dock ─
    await strike("shell", "t");
    await settled(shell);
    const tiled = await boxes();
    for (const a of tiled) {
      expect(a.x).toBeGreaterThan(stage.x + DOCK_COLUMN - 2);
      for (const b of tiled) if (a !== b) expect(overlap(a, b)).toBe(false);
    }
    await capture(app, shell, "62-desk-tile-key.png");

    // ── 4. Glide's deceleration, on the card under the throw: kept on this device, and idle under another throw ─
    await openMore(shell);
    const deceleration = shell.getByTestId("desk-variant-deceleration");
    await expect(deceleration).toHaveAttribute("data-value", "28");
    await deceleration.locator('input[type="range"]').fill("50");
    await expect(deceleration).toHaveAttribute("data-value", "50");
    await expect(deceleration).toContainText("50%");
    await expect
      .poll(() => shell.evaluate(() => (JSON.parse(localStorage.getItem("pistachio.desk.v1") ?? "{}") as { variants?: { deceleration?: number } }).variants?.deceleration))
      .toBe(50);
    await shell.waitForTimeout(200);
    await capture(app, shell, "63-desk-more-deceleration.png");
    await shell.getByTestId("desk-variant-physics").click();
    await expect(shell.getByTestId("desk-variant-physics")).toHaveAttribute("data-value", "snap");
    await expect(deceleration.locator('input[type="range"]')).toBeDisabled();
    // The card stayed up through all of that: the pointer is on it.
    await expect(shell.locator('[data-testid="desk-more-card"][data-shown]')).toHaveCount(1);
    await shell.getByTestId("desk-variant-physics").click({ modifiers: ["Shift"] });
    await expect(shell.getByTestId("desk-variant-physics")).toHaveAttribute("data-value", "glide");
    await expect(deceleration.locator('input[type="range"]')).toBeEnabled();

    // ── 5. The way out is on the card too ─────────────────────────────────────
    await shell.getByTestId("desk-leave").click();
    await expect(shell.getByTestId("desk-surface")).toHaveCount(0);
    // With no desk up, the keys are no one's: nothing happens.
    await strike("shell", "t");
    await expect(shell.getByTestId("desk-surface")).toHaveCount(0);
  } finally {
    await app.close();
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
    const rail = await box(shell, ".desk-dock-shelf");
    const onTop = await shell.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="settings-page"]') !== null,
      center(rail),
    );
    expect(onTop).toBe(true);
  } finally {
    await app.close();
  }
});
