/**
 * The desk end to end (docs/desk.md): a tab group opens as free windows over
 * the surface, and the sidebar beside it is its dock — its rail of icons, or
 * the whole sidebar (⌘S). A tab's row dragged out becomes a window; a window moves by its frame, sticks to
 * edges, tiles into an armed edge zone, coasts when thrown, resizes by its
 * corner, is put away into the sidebar, and — with the grab key held — is taken
 * from anywhere on its live page. Leaving gives the surface back as panes.
 *
 * Native page views are checked where the shell cannot see them: main's
 * own view boxes must match the holes the desk windows leave for them.
 *
 * Each describe is one launch, its tests run in order on it, each leaving
 * the desk as the next expects it. The engine's own arithmetic — a filled
 * window letting go of the desk, the snap tiles, the seams, the eased
 * timings — is desk-engine.test, desk-geometry.test and desk-eased.test's.
 */

import { crc32, deflateSync } from "node:zlib";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { TRAFFIC_LIGHTS_H } from "@pistachio/shell-contracts/chrome";
import { IPC, type PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { TabGroupColor, TabGroupCommand } from "@pistachio/shell-contracts/tab-groups";
import {
  box,
  center,
  createGroup,
  createTab,
  fromFrameMenu,
  groupSelector,
  INVOICES,
  launchDesk,
  leaveDesk,
  liveViews,
  openGroupDesk,
  openMore,
  openTabs,
  rowSelector,
  screenshots,
  selectTab,
  settled,
  snapshot,
  tabGroupCommand,
  VENDOR,
  windowSelector,
  type Box,
} from "./desk-harness";

const capture = screenshots("desk");

/** A tab's row's mark: its window out on the desk ("out"), or in use there ("focused"). */
const markSelector = (tabId: string, mark?: "out" | "focused"): string => `${rowSelector(tabId)} [data-testid="desk-row-mark"]${mark === undefined ? "" : `[data-mark="${mark}"]`}`;

/** Where the desk's windows go: the whole of its card (the Bar's notch and the shelf lie over its foot, the windows there cut short of them). */
const usableOf = (stage: Box): Box => ({ x: stage.x, y: stage.y, width: stage.width, height: stage.height });

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

/** The desk's notch view (main's "notch" chrome view) on screen, and its box; null while it is not. */
function notchView(app: ElectronApplication): Promise<Box | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window?.contentView.children.find(
      (child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith("#notch") && (child as WebContentsView).getVisible(),
    ) as WebContentsView | undefined;
    return view === undefined ? null : view.getBounds();
  });
}

/** A mouse event on the notch view, as the person's pointer would reach it. */
function notchMouse(app: ElectronApplication, type: "mouseMove" | "mouseLeave", x: number, y: number): Promise<void> {
  return app.evaluate(
    async ({ webContents }, { type, x, y }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith("#notch"));
      if (contents === undefined) throw new Error("no notch view");
      contents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y) });
      await new Promise((done) => setTimeout(done, 60));
    },
    { type, x, y },
  );
}

/** Main's box for the tab's view equals the hole its desk window leaves (a pixel of rounding either way; of two tabs on one address, one's). */
async function expectLiveIn(app: ElectronApplication, shell: Page, url: string, tabId: string): Promise<void> {
  await expect
    .poll(async () => {
      const hole = await box(shell, `${windowSelector(tabId)} [data-testid="desk-window-page"]`);
      const offs = (await liveViews(app))
        .filter((candidate) => candidate.url === url)
        .map((view) => ({
          view,
          off: Math.max(Math.abs(view.bounds.x - hole.x), Math.abs(view.bounds.y - hole.y), Math.abs(view.bounds.width - hole.width), Math.abs(view.bounds.height - hole.height)),
        }))
        .sort((a, b) => a.off - b.off);
      const best = offs[0];
      if (best === undefined) return "no live view";
      return best.off <= 1.5 ? "aligned" : `off by ${best.off.toFixed(1)}: view ${JSON.stringify(best.view.bounds)} hole ${JSON.stringify(hole)}`;
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
 * Two sites for the desk's tabs, at https://dock.test: one declaring an
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

/** ⌘ (and ⌥, with `alt`) and a key, struck where the keyboard is: a page's (by its address), or the shell's. */
function strike(app: ElectronApplication, into: string | "shell", keyCode: string, alt = false): Promise<void> {
  return app.evaluate(
    ({ BrowserWindow, webContents }, { into, keyCode, alt }) => {
      const contents = into === "shell" ? BrowserWindow.getAllWindows()[0]!.webContents : webContents.getAllWebContents().find((candidate) => candidate.getURL() === into)!;
      const held: Array<"meta" | "alt"> = alt ? ["meta", "alt"] : ["meta"];
      contents.focus();
      contents.sendInputEvent({ type: "keyDown", keyCode: "Meta", modifiers: ["meta"] });
      if (alt) contents.sendInputEvent({ type: "keyDown", keyCode: "Alt", modifiers: held });
      contents.sendInputEvent({ type: "keyDown", keyCode, modifiers: held });
      contents.sendInputEvent({ type: "keyUp", keyCode, modifiers: held });
      if (alt) contents.sendInputEvent({ type: "keyUp", keyCode: "Alt", modifiers: ["meta"] });
      contents.sendInputEvent({ type: "keyUp", keyCode: "Meta", modifiers: [] });
    },
    { into, keyCode, alt },
  );
}

/** Shift going down or up in a page, as main relays a page's keys (a page has the keyboard). */
function pressShift(app: ElectronApplication, url: string, type: "keyDown" | "keyUp"): Promise<void> {
  return app.evaluate(
    ({ webContents }, { url, type }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      contents.sendInputEvent({ type, keyCode: "Shift", modifiers: type === "keyDown" ? ["shift"] : [] });
    },
    { url, type },
  );
}

const overlap = (a: Box, b: Box): boolean => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

test.describe.serial("a tab group's desk, from its first window to leaving it", { tag: ["@desk", "@sidebar"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  const urls = [INVOICES, VENDOR, "pistachio://demo/invoices?page=north", "pistachio://demo/invoices?page=south"];
  let ids: string[];
  let stage: Box;
  /** The tab the sidebar's New tab made: on the desk's first address too. */
  let added: string;
  /** Off the sidebar, and off the Bar at the desk's foot (grown under the pointer, it puts the pages under it down). */
  const awayFromDock = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.6);

  test.beforeAll(async () => {
    ({ app, shell } = await launchDesk({ name: "journey" }));
    ids = await openTabs(shell, urls);
    await createGroup(shell, "desk-group", ids, "Research", "blue");
    await selectTab(shell, ids[0]!);
    await expect(shell.locator(groupSelector("desk-group"))).toHaveCount(1);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("a tab group's desk: pull out, move, stick, tile, throw, resize, grab from the page, Shift's tile, put away, new tab", async () => {
    test.setTimeout(120_000);

    // ── 1. Open the desk: the page in view becomes the first window ───────────
    await openGroupDesk(shell, "desk-group");
    await expect(shell.getByTestId("desk-surface")).toBeVisible();
    // The sidebar is its rail, the group's rows its icons; the window out is marked on its row.
    await expect(shell.locator('[data-testid="sidebar-motion-slot"][data-rail]')).toHaveCount(1);
    await expect(shell.locator(`${rowSelector(ids[3]!)}`)).toHaveCount(1);
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await expect(shell.locator(markSelector(ids[0]!, "focused"))).toHaveCount(1);
    await settled(shell, app);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await capture(app, shell, "01-desk-open.png");

    // ── 2. Drag a tab's row out of the sidebar: it becomes its window ─────────
    stage = await box(shell, ".desk-stage");
    const thumb = await box(shell, rowSelector(ids[1]!));
    await place(shell, center(thumb), { x: stage.x + stage.width * 0.45, y: stage.y + stage.height * 0.12 });
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell, app);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(ids[1]);
    await expectLiveIn(app, shell, urls[1]!, ids[1]!);
    await capture(app, shell, "02-pulled-out.png");

    // ── 3. Move a window by its title bar: it goes where it is put ────────────
    const bar = await box(shell, `${windowSelector(ids[1]!)} .desk-window-bar`);
    const before = await box(shell, windowSelector(ids[1]!));
    await place(shell, { x: bar.x + 60, y: bar.y + bar.height / 2 }, { x: bar.x + 60 - 140, y: bar.y + bar.height / 2 + 70 });
    await settled(shell, app);
    const moved = await box(shell, windowSelector(ids[1]!));
    expect(Math.abs(moved.x - (before.x - 140))).toBeLessThan(16);
    expect(Math.abs(moved.y - (before.y + 70))).toBeLessThan(16);
    await expectLiveIn(app, shell, urls[1]!, ids[1]!);

    // ── 4. Push it into the left edge: the left half is armed, and taken ─────
    const usableLeft = stage.x;
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
    await settled(shell, app);
    const half = await box(shell, windowSelector(ids[1]!));
    expect(Math.abs(half.x - usableLeft)).toBeLessThan(2);
    expect(Math.abs(half.y - stage.y)).toBeLessThan(2);
    expect(Math.abs(half.width - (usableOf(stage).width - 8) / 2)).toBeLessThan(2);
    expect(Math.abs(half.height - usableOf(stage).height)).toBeLessThan(2);
    await expectLiveIn(app, shell, urls[1]!, ids[1]!);
    // Down to the desk's foot, under the Bar's notch, its page whole: the notch is main's notch view, over the live page.
    const notch = await box(shell, '[data-testid="desk-bar"][data-compact]');
    expect(notch.y + notch.height).toBeCloseTo(stage.y + stage.height, 0);
    const halfPage = await box(shell, `${windowSelector(ids[1]!)} [data-testid="desk-window-page"]`);
    expect(Math.abs(halfPage.y + halfPage.height - (stage.y + stage.height - 5))).toBeLessThan(2);
    await expect.poll(() => notchView(app)).not.toBeNull();
    const overPage = (await notchView(app))!;
    expect(Math.abs(overPage.x - (notch.x - 10))).toBeLessThanOrEqual(1);
    expect(Math.abs(overPage.y - notch.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(overPage.width - (notch.width + 20))).toBeLessThanOrEqual(1);
    await capture(app, shell, "04-left-half.png");
    // The pointer on the notch view is on the Bar: it grows (the page under it giving way), and the view goes.
    await notchMouse(app, "mouseMove", overPage.width / 2, overPage.height / 2);
    await expect(shell.locator('[data-testid="desk-bar"]:not([data-compact])')).toHaveCount(1);
    await expect.poll(() => notchView(app)).toBeNull();
    // (The pointer is over the shell's Bar now, where the view was; then it goes.)
    await shell.mouse.move(overPage.x + overPage.width / 2, overPage.y + overPage.height / 2);
    await shell.mouse.move(stage.x + stage.width * 0.75, stage.y + 60, { steps: 4 });
    await expect(shell.locator('[data-testid="desk-bar"][data-compact]')).toHaveCount(1);
    // Back to its idle size over the live page, the view is back over it.
    await expect.poll(() => notchView(app), { timeout: 5_000 }).not.toBeNull();
    // (The pointer that came onto the view leaves it, as a person's does: a view that never heard it go would
    // still have it when it next shows, and grow the Bar.)
    await notchMouse(app, "mouseLeave", -1, -1);
    await expect(shell.locator('[data-testid="desk-bar"][data-compact]')).toHaveCount(1);

    // ── 5. Throw the other window: it coasts on to the far edge and lies there ─
    // (By the visible end of its bar — the half-width window covers the rest.)
    const bar3 = await box(shell, `${windowSelector(ids[0]!)} .desk-window-bar`);
    const released = await box(shell, windowSelector(ids[0]!));
    // (Hard enough to cross the whole row: the sidebar is away while the desk is up.)
    await fling(shell, { x: bar3.x + bar3.width - 110, y: bar3.y + bar3.height / 2 }, { x: 100, y: 0 });
    await settled(shell, app);
    const thrown = await box(shell, windowSelector(ids[0]!));
    // Let go 100px on; a placement would have stopped there. The throw carried it to the wall: the card's edge.
    expect(thrown.x).toBeGreaterThan(released.x + 100 + 10);
    expect(Math.abs(thrown.x + thrown.width - (stage.x + stage.width))).toBeLessThan(2);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await capture(app, shell, "05-thrown.png");

    // ── 6. Resize by the corner ────────────────────────────────────────────────
    const corner = await box(shell, `${windowSelector(ids[0]!)} [data-desk-edge="sw"]`);
    const sized = await box(shell, windowSelector(ids[0]!));
    await place(shell, center(corner), { x: center(corner).x + 120, y: center(corner).y - 140 });
    await settled(shell, app);
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
      app.evaluate(
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
    await settled(shell, app);
    const grabbed = await box(shell, windowSelector(ids[0]!));
    expect(Math.abs(grabbed.x - (grabBefore.x - 120))).toBeLessThan(20);
    expect(Math.abs(grabbed.y - (grabBefore.y + 60))).toBeLessThan(20);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await capture(app, shell, "06-grabbed-from-page.png");

    // ── 7b. Shift held to the end of a drag by the title bar: the tile it lights takes the window ─
    // (Main's relay of the page's Shift — a page has the keyboard — and Playwright's own modifier, which its pointer events carry.)
    const usable = usableOf(stage);
    const halfWidth = (usable.width - 8) / 2;
    const bar5 = await box(shell, `${windowSelector(ids[0]!)} .desk-window-bar`);
    const hold = { x: bar5.x + 60, y: bar5.y + bar5.height / 2 };
    const right = { x: usable.x + usable.width * 0.86, y: usable.y + usable.height * 0.5 };
    await shell.mouse.move(hold.x, hold.y);
    await shell.mouse.down();
    await shell.mouse.move(hold.x + 6, hold.y + 4, { steps: 2 });
    // Carried halfway, then Shift goes down, the pointer standing still: snap mode lights a tile.
    for (let step = 1; step <= 6; step += 1) {
      await shell.mouse.move(hold.x + ((right.x - hold.x) * step) / 12, hold.y + ((right.y - hold.y) * step) / 12);
      await shell.waitForTimeout(16);
    }
    await expect(shell.locator('.desk-stage[data-gesture="move"]')).toHaveCount(1);
    await pressShift(app, urls[0]!, "keyDown");
    await shell.keyboard.down("Shift");
    await expect(shell.locator(".desk-zone[data-on][data-snap]")).toHaveCount(1);
    for (let step = 7; step <= 12; step += 1) {
      await shell.mouse.move(hold.x + ((right.x - hold.x) * step) / 12, hold.y + ((right.y - hold.y) * step) / 12);
      await shell.waitForTimeout(16);
    }
    // The right half lights.
    await expect
      .poll(async () => {
        const lit = await box(shell, ".desk-zone");
        return Math.max(Math.abs(lit.x - (usable.x + halfWidth + 8)), Math.abs(lit.width - halfWidth), Math.abs(lit.height - usable.height));
      })
      .toBeLessThan(2);
    await capture(app, shell, "14-snap-right-half.png");
    await shell.mouse.up();
    await shell.keyboard.up("Shift");
    await pressShift(app, urls[0]!, "keyUp");
    await settled(shell, app);
    const rightHalf = await box(shell, windowSelector(ids[0]!));
    expect(Math.abs(rightHalf.x - (usable.x + halfWidth + 8))).toBeLessThan(2);
    expect(Math.abs(rightHalf.width - halfWidth)).toBeLessThan(2);
    expect(Math.abs(rightHalf.height - usable.height)).toBeLessThan(2);
    await expect(shell.locator(".desk-stage[data-snapping]")).toHaveCount(0);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);

    // ── 8. Put a window away: the drop rail over the sidebar, its Collapse pad takes it ─
    const bar4 = await box(shell, `${windowSelector(ids[1]!)} .desk-window-bar`);
    const rail = await box(shell, '[data-testid="desk-drop-away"]');
    expect(rail.x + rail.width).toBeLessThanOrEqual(stage.x);
    await shell.mouse.move(bar4.x + 60, bar4.y + bar4.height / 2);
    await shell.mouse.down();
    await shell.mouse.move(bar4.x + 66, bar4.y + bar4.height / 2, { steps: 2 });
    for (let step = 1; step <= 12; step += 1) {
      await shell.mouse.move(bar4.x + 60 + (rail.x + rail.width / 2 - bar4.x - 60) * (step / 12), bar4.y + 20 + step * 10);
      await shell.waitForTimeout(16);
    }
    await expect(shell.locator(".desk-drops[data-shown]")).toHaveCount(1);
    await expect(shell.locator('[data-testid="desk-drop-away"][data-armed]')).toHaveCount(1);
    await expect(shell.locator('[data-testid="desk-drop-close"][data-armed]')).toHaveCount(0);
    await capture(app, shell, "07-put-away-armed.png");
    await shell.waitForTimeout(150);
    await shell.mouse.up();
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await expect(shell.locator(".desk-drops[data-shown]")).toHaveCount(0);
    await expect(shell.locator(markSelector(ids[1]!))).toHaveCount(0);
    await settled(shell, app);

    // ── 9. The Feel menu closes on a press in a live page, and on Escape struck
    //      there — neither of which the shell hears itself (main relays them) ─
    const pageInput = (events: Array<"press" | "escape">) =>
      app.evaluate(
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

    // ── 10. New tab (the sidebar's): it joins the group, and comes out onto the desk in use ─
    await shell.getByTestId("new-tab-button").click();
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-group")!.tabIds.length).toBe(5);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    added = (await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-group")!.tabIds.find((tabId) => !ids.includes(tabId))!;
    expect((await snapshot(shell)).tabs.find((tab) => tab.id === added)?.url).toBe(INVOICES);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(added);
    await expect(shell.locator(markSelector(added, "focused"))).toHaveCount(1);
    await expect(shell.locator(`${windowSelector(added)}`)).toHaveCount(1);
    await settled(shell, app);
    await capture(app, shell, "07c-new-tab.png");
  });

  test("windows a gutter apart resize together from the gutter, as a split view's panes do", async () => {
    test.setTimeout(60_000);
    // A third window out, by its row, then all three tiled from the More card.
    await shell.locator(rowSelector(ids[1]!)).click();
    await expect(shell.locator(windowSelector(ids[1]!))).toHaveCount(1);
    await awayFromDock();
    await settled(shell, app);
    await openMore(shell);
    await shell.getByTestId("desk-tile").click();
    await awayFromDock();
    await settled(shell, app);

    // ── 1. Tiled: a half on the left, two quarters stacked on the right, a gutter between each ─
    // (The Bar idle at the foot: grown, it would put the pages under it down.)
    await expect(shell.locator('[data-testid="desk-bar"][data-compact]')).toHaveCount(1);
    const live: Record<string, string> = { [ids[0]!]: urls[0]!, [ids[1]!]: urls[1]!, [added]: INVOICES };
    const trio = Object.keys(live);
    const tiles = new Map(await Promise.all(trio.map(async (tabId) => [tabId, await box(shell, windowSelector(tabId))] as const)));
    const [leftId] = [...tiles].sort(([, a], [, b]) => a.x - b.x)[0]!;
    const [topId, bottomId] = trio.filter((tabId) => tabId !== leftId).sort((a, b) => tiles.get(a)!.y - tiles.get(b)!.y) as [string, string];
    const order = [leftId, topId, bottomId];
    const boxes = async (): Promise<[Box, Box, Box]> => (await Promise.all(order.map((tabId) => box(shell, windowSelector(tabId))))) as [Box, Box, Box];
    const [left, top, bottom] = await boxes();
    expect(Math.abs(top.x - (left.x + left.width) - 8)).toBeLessThan(1);
    expect(Math.abs(bottom.x - top.x)).toBeLessThan(1);
    expect(Math.abs(bottom.y - (top.y + top.height) - 8)).toBeLessThan(1);
    for (const tabId of order) await expectLiveIn(app, shell, live[tabId]!, tabId);
    await capture(app, shell, "70-seams-tiled.png");

    /** What is under a point of the shell: a window's resize edge's cursor, or nothing. */
    const cursorAt = (point: { x: number; y: number }): Promise<string | null> =>
      shell.evaluate(({ x, y }) => {
        const found = document.elementFromPoint(x, y)?.closest<HTMLElement>(".desk-window-edge") ?? null;
        return found === null ? null : getComputedStyle(found).cursor;
      }, point);

    // ── 2. The gutter between the half and the quarters: the pointer finds a resize edge there, and dragging it moves all three ─
    const gutter = { x: left.x + left.width + 4, y: top.y + top.height / 2 };
    expect(await cursorAt(gutter)).toBe("ew-resize");
    await shell.mouse.move(gutter.x, gutter.y);
    await shell.mouse.down();
    for (let step = 1; step <= 12; step += 1) {
      await shell.mouse.move(gutter.x + (140 * step) / 12, gutter.y);
      await shell.waitForTimeout(16);
    }
    // In hand: both sides are already their new size.
    await expect
      .poll(async () => {
        const [heldLeft, heldTop, heldBottom] = await boxes();
        return Math.max(Math.abs(heldLeft.width - (left.width + 140)), Math.abs(heldTop.x - (top.x + 140)), Math.abs(heldBottom.x - (bottom.x + 140)));
      })
      .toBeLessThan(2);
    await capture(app, shell, "71-seams-gutter-in-hand.png");
    await shell.mouse.up();
    await settled(shell, app);
    const [wideLeft, narrowTop, narrowBottom] = await boxes();
    expect(Math.abs(wideLeft.x - left.x)).toBeLessThan(1);
    expect(Math.abs(wideLeft.width - (left.width + 140))).toBeLessThan(2);
    for (const [after, before] of [
      [narrowTop, top],
      [narrowBottom, bottom],
    ] as const) {
      expect(Math.abs(after.x - (before.x + 140))).toBeLessThan(2);
      // The far edge holds still, and the gutter stays a gutter.
      expect(Math.abs(after.x + after.width - (before.x + before.width))).toBeLessThan(1);
      expect(Math.abs(after.x - (wideLeft.x + wideLeft.width) - 8)).toBeLessThan(1);
      expect(Math.abs(after.y - before.y)).toBeLessThan(1);
      expect(Math.abs(after.height - before.height)).toBeLessThan(1);
    }
    for (const tabId of order) await expectLiveIn(app, shell, live[tabId]!, tabId);
    await capture(app, shell, "72-seams-gutter-moved.png");
  });

  test("the More card holds the arrangements, with keyboard shortcuts struck in a page or the shell, Glide's deceleration, and the way out: the window in use is the pane again", async () => {
    test.setTimeout(60_000);
    const trio = [ids[0]!, ids[1]!, added];
    const boxes = async (): Promise<Box[]> => Promise.all(trio.map((tabId) => box(shell, windowSelector(tabId))));

    // ── 1. The desk's buttons head the rail: the whole sidebar, and More; the arrangements are on More's card, with their keys ─
    await expect(shell.getByTestId("desk-rail-toggle")).toBeVisible();
    await expect(shell.getByTestId("desk-more")).toBeVisible();
    await openMore(shell);
    await expect(shell.getByTestId("desk-tile")).toContainText("⌘⌥T");
    await expect(shell.getByTestId("desk-cascade")).toContainText("⌘⌥C");
    await awayFromDock();
    await expect(shell.getByTestId("desk-more-card")).toHaveCount(0);

    // ── 2. ⌘⌥C in a window's page: the windows cascade, each a step down and along from the last ─
    await strike(app, urls[1]!, "c", true);
    await settled(shell, app);
    const cascaded = (await boxes()).sort((a, b) => a.x - b.x);
    for (let index = 1; index < cascaded.length; index += 1) {
      expect(cascaded[index]!.x).toBeGreaterThan(cascaded[index - 1]!.x + 8);
      expect(cascaded[index]!.y).toBeGreaterThan(cascaded[index - 1]!.y + 8);
      expect(overlap(cascaded[index]!, cascaded[index - 1]!)).toBe(true);
    }
    await capture(app, shell, "61-desk-cascade-key.png");

    // ── 3. ⌘⌥T with the shell holding the keyboard: tiled, side by side, beside the sidebar ─
    await strike(app, "shell", "t", true);
    await settled(shell, app);
    const tiled = await boxes();
    for (const a of tiled) {
      expect(a.x).toBeGreaterThan(stage.x - 2);
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
    await capture(app, shell, "63-desk-more-deceleration.png");
    await shell.getByTestId("desk-variant-physics").click();
    await expect(shell.getByTestId("desk-variant-physics")).toHaveAttribute("data-value", "snap");
    await expect(deceleration.locator('input[type="range"]')).toBeDisabled();
    // The card stayed up through all of that: the pointer is on it.
    await expect(shell.locator('[data-testid="desk-more-card"][data-shown]')).toHaveCount(1);
    await shell.getByTestId("desk-variant-physics").click({ modifiers: ["Shift"] });
    await expect(shell.getByTestId("desk-variant-physics")).toHaveAttribute("data-value", "glide");
    await expect(deceleration.locator('input[type="range"]')).toBeEnabled();

    // ── 5. The way out is on the card too: the window in use becomes the pane again ─
    const inUse = (await snapshot(shell)).activeTabId!;
    await shell.getByTestId("desk-leave").click();
    await expect(shell.getByTestId("desk-surface")).toHaveCount(0);
    await expect(shell.getByTestId("browser-surface")).toBeVisible();
    await expect.poll(async () => (await liveViews(app)).length).toBe(1);
    // (The sidebar slides back in beside the pane, which narrows with it.)
    await expect
      .poll(async () => {
        const pane = await box(shell, "[data-pane-tab-id]");
        const [view] = await liveViews(app);
        return Math.abs(view!.bounds.width - pane.width) < 2;
      })
      .toBe(true);
    expect((await snapshot(shell)).activeTabId).toBe(inUse);
    await capture(app, shell, "10-left.png");
    // With no desk up, the keys are no one's: nothing happens.
    await strike(app, "shell", "t", true);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(0);
  });
});

test.describe.serial("the sidebar as the desk's dock", { tag: ["@desk", "@sidebar", "@tabs"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let urls: string[];
  let ids: string[];
  let stranger: string;

  test.beforeAll(async () => {
    ({ app, shell } = await launchDesk({ name: "dock" }));
    const origin = await serveDockSites(app);
    urls = [INVOICES, `${origin}/app`, `${origin}/plain`];
    const all = await openTabs(shell, [...urls, VENDOR]);
    ids = all.slice(0, 3);
    stranger = all[3]!;
    await createGroup(shell, "desk-dock", ids, "Dock", "purple");
    await selectTab(shell, ids[0]!);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("the sidebar is the desk's dock: a row's click opens where there is room, a row dragged out is its window in hand, a stranger's row dropped joins the group, ⌘S widens the rail, and its drop rail closes", async () => {
    test.setTimeout(120_000);
    await openGroupDesk(shell, "desk-dock");
    await expect(shell.getByTestId("desk-surface")).toBeVisible();
    await settled(shell, app);

    // ── 1. The sidebar is its rail: every row its icon, the group's Context under its tabs; the window out marked ─
    await expect(shell.locator('[data-testid="sidebar-motion-slot"][data-rail]')).toHaveCount(1);
    await expect(shell.getByTestId("desk-row-mark")).toHaveCount(1);
    await expect(shell.locator(markSelector(ids[0]!, "focused"))).toHaveCount(1);
    await expect(shell.locator('[data-testid="tab-group"] [data-testid="desk-stack"]')).toHaveCount(1);
    const railRow = await box(shell, rowSelector(ids[1]!));
    expect(railRow.width).toBeLessThanOrEqual(40);

    const stage = await box(shell, ".desk-stage");
    const usable = usableOf(stage);
    const half = (usable.width - 8) / 2;
    await shell.locator(`${windowSelector(ids[0]!)} button[aria-label="Fill the desk"]`).click();
    await settled(shell, app);

    // ── 2. Click a row: the desk is filled by one window, so that one gives up half ─
    await shell.locator(rowSelector(ids[1]!)).click();
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await shell.mouse.move(stage.x + stage.width * 0.6, stage.y + stage.height * 0.5);
    await settled(shell, app);
    const leftHalf = await box(shell, windowSelector(ids[0]!));
    const rightHalf = await box(shell, windowSelector(ids[1]!));
    expect(Math.abs(leftHalf.x - usable.x)).toBeLessThan(2);
    expect(Math.abs(leftHalf.width - half)).toBeLessThan(2);
    expect(Math.abs(rightHalf.x - (usable.x + half + 8))).toBeLessThan(2);
    expect(Math.abs(rightHalf.width - half)).toBeLessThan(2);
    await expect(shell.getByTestId("desk-row-mark")).toHaveCount(2);
    await expect(shell.locator(markSelector(ids[1]!, "focused"))).toHaveCount(1);
    await expectLiveIn(app, shell, urls[1]!, ids[1]!);
    await capture(app, shell, "17-row-click-split.png");

    // ── 3. Click the row of a window already out: it comes to the top, in use ───
    await shell.locator(rowSelector(ids[0]!)).click();
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(ids[0]);
    await expect(shell.locator(markSelector(ids[0]!, "focused"))).toHaveCount(1);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);

    // ── 4. Drag that row out over the desk: its window comes to the hand, held by its title bar ─
    const from = center(await box(shell, rowSelector(ids[1]!)));
    await shell.mouse.move(from.x, from.y);
    await shell.mouse.down();
    await shell.mouse.move(from.x + 4, from.y + 6, { steps: 2 });
    await shell.mouse.move(from.x + 10, from.y + 12, { steps: 2 });
    const hand = { x: usable.x + 320, y: usable.y + 140 };
    for (let step = 1; step <= 12; step += 1) {
      await shell.mouse.move(from.x + 10 + ((hand.x - from.x - 10) * step) / 12, from.y + 12 + ((hand.y - from.y - 12) * step) / 12);
      await shell.waitForTimeout(16);
    }
    await expect(shell.locator('.desk-stage[data-gesture="move"]')).toHaveCount(1);
    // It flies to the hand held by its title bar — a full-height half, too tall
    // to carry, scaled down to four fifths of the desk's height, its shape kept.
    // (Arrived: the bar under the hand, and still from one look to the next.)
    let lastBar = "";
    await expect
      .poll(async () => {
        const inHand = await box(shell, `${windowSelector(ids[1]!)} .desk-window-bar`);
        const still = JSON.stringify(inHand) === lastBar;
        lastBar = JSON.stringify(inHand);
        return still && hand.y > inHand.y - 2 && hand.y < inHand.y + inHand.height + 2 && hand.x > inHand.x && hand.x < inHand.x + inHand.width * 0.5;
      })
      .toBe(true);
    await capture(app, shell, "19-row-window-to-hand.png");
    await shell.mouse.up();
    await settled(shell, app);
    const dropped = await box(shell, windowSelector(ids[1]!));
    expect(Math.abs(dropped.height - usable.height * 0.8)).toBeLessThan(2);
    expect(Math.abs(dropped.width / dropped.height - half / usable.height)).toBeLessThan(0.01);
    const droppedBar = await box(shell, `${windowSelector(ids[1]!)} .desk-window-bar`);
    expect(Math.abs(droppedBar.y + droppedBar.height / 2 - hand.y)).toBeLessThan(16);
    await expectLiveIn(app, shell, urls[1]!, ids[1]!);

    // ── 5. Drag out the row of a tab not on the desk: a fresh window, held by its bar ─
    const plain = center(await box(shell, rowSelector(ids[2]!)));
    const dropAt = { x: usable.x + usable.width * 0.45, y: usable.y + usable.height * 0.16 };
    await place(shell, plain, dropAt);
    await expect(shell.getByTestId("desk-window")).toHaveCount(3);
    await settled(shell, app);
    const plainBar = await box(shell, `${windowSelector(ids[2]!)} .desk-window-bar`);
    expect(Math.abs(plainBar.y + plainBar.height / 2 - dropAt.y)).toBeLessThan(16);
    await expect(shell.getByTestId("desk-row-mark")).toHaveCount(3);
    await expectLiveIn(app, shell, urls[2]!, ids[2]!);
    await capture(app, shell, "20-row-dragged-out.png");

    // ── 6. ⌘S: the whole sidebar, the desk narrowing beside it; the rows say their titles ─
    await shell.keyboard.press("Meta+s");
    await expect(shell.locator('[data-testid="sidebar-motion-slot"]:not([data-rail])[data-desk]')).toHaveCount(1);
    await expect.poll(async () => (await box(shell, ".desk-stage")).x).toBeGreaterThan(stage.x + 120);
    await settled(shell, app);
    await expect(shell.locator(`${rowSelector(ids[2]!)}`)).toContainText("Plain Site");
    await expect(shell.locator('[data-testid="desk-stack"] .desk-context-label')).toBeVisible();
    await capture(app, shell, "20b-whole-sidebar.png");

    // ── 7. A row from outside the group let go over the desk: the tab joins the group, its window there ─
    const wide = await box(shell, ".desk-stage");
    const strangerRow = center(await box(shell, rowSelector(stranger)));
    // (High on the desk: a window that would reach past its foot is kept on it, and the bar would not be under the pointer.)
    const strangerAt = { x: wide.x + wide.width * 0.6, y: wide.y + 80 };
    await place(shell, strangerRow, strangerAt);
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-dock")!.tabIds.includes(stranger)).toBe(true);
    await expect(shell.locator(windowSelector(stranger))).toHaveCount(1);
    await settled(shell, app);
    const strangerBar = await box(shell, `${windowSelector(stranger)} .desk-window-bar`);
    expect(Math.abs(strangerBar.y + strangerBar.height / 2 - strangerAt.y)).toBeLessThan(16);
    await expect(shell.locator(markSelector(stranger, "focused"))).toHaveCount(1);
    await capture(app, shell, "20c-stranger-joined.png");

    // ── 8. ⌘S again: the rail, and the desk wide again ──────────────────────────
    await shell.keyboard.press("Meta+s");
    await expect(shell.locator('[data-testid="sidebar-motion-slot"][data-rail]')).toHaveCount(1);
    await expect.poll(async () => (await box(shell, ".desk-stage")).x).toBeLessThan(stage.x + 2);
    await settled(shell, app);

    // ── 9. Carry a window to the desk's leading edge: the drop rail stands over the
    //      sidebar; the lower pad closes the tab ─────────────────────────────────
    const closePad = await box(shell, '[data-testid="desk-drop-close"]');
    expect(closePad.x + closePad.width).toBeLessThanOrEqual(stage.x);
    // (The stranger's window, on top.)
    const bar = await box(shell, `${windowSelector(stranger)} .desk-window-bar`);
    const grip = { x: bar.x + 90, y: bar.y + bar.height / 2 };
    await shell.mouse.move(grip.x, grip.y);
    await shell.mouse.down();
    await shell.mouse.move(grip.x - 8, grip.y + 4, { steps: 2 });
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
    await capture(app, shell, "21-drop-rail-left-half.png");
    // Past the desk's edge, over the sidebar, low down: Close.
    const onClose = center(closePad);
    for (let step = 1; step <= 8; step += 1) {
      await shell.mouse.move(band.x + ((onClose.x - band.x) * step) / 8, band.y + ((onClose.y - band.y) * step) / 8);
      await shell.waitForTimeout(16);
    }
    await expect(shell.locator('[data-testid="desk-drop-close"][data-armed]')).toHaveCount(1);
    await expect(shell.locator(".desk-zone[data-on]")).toHaveCount(0);
    await capture(app, shell, "22-drop-rail-close.png");
    await shell.mouse.up();
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.id === stranger)).toBe(false);
    await expect(shell.getByTestId("desk-window")).toHaveCount(3);
    await expect(shell.locator(rowSelector(stranger))).toHaveCount(0);
    await expect(shell.locator(".desk-drops[data-shown]")).toHaveCount(0);
    await settled(shell, app);
    await capture(app, shell, "23-closed.png");

    // ── 10. The footer's menu on the rail hangs out over the desk, in front of it: the pages give way
    //       to their pictures, as for a context menu, and the menu is what the pointer finds there ─
    await shell.getByTestId("sidebar-menu-button").click();
    const footerMenu = shell.locator('[data-testid="sidebar-menu"][data-shown]');
    await expect(footerMenu).toBeVisible();
    await expect.poll(async () => (await liveViews(app)).length).toBe(0);
    const panel = await box(shell, '[data-testid="sidebar-menu"]');
    expect(panel.x + panel.width).toBeGreaterThan(stage.x + 40);
    const over = { x: stage.x + 30, y: panel.y + panel.height / 2 };
    expect(await shell.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="sidebar-menu"]') !== null, over)).toBe(true);
    await capture(app, shell, "23b-footer-menu.png");
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("sidebar-menu")).toHaveCount(0);
    await expect.poll(async () => (await liveViews(app)).length).toBeGreaterThan(0);

    // ── 11. A row chosen is its window's, as the Dock's icon was: minimized, it grows back, in use ─
    await fromFrameMenu(shell, windowSelector(ids[2]!), "desk-minimize");
    await settled(shell, app);
    await expect(shell.locator(windowSelector(ids[2]!))).toHaveAttribute("data-mini", "parked");
    await shell.locator(rowSelector(ids[2]!)).click();
    await settled(shell, app);
    await expect(shell.locator(windowSelector(ids[2]!))).not.toHaveAttribute("data-mini", /.+/);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(ids[2]);
    await expect(shell.locator(markSelector(ids[2]!, "focused"))).toHaveCount(1);

    // ── 12. …and collapsed, the last window out — its tab still the one in use — it comes back out ─
    for (const tabId of [ids[0]!, ids[1]!, ids[2]!]) {
      // (Each to the top first, by its row, unless it is the one in use.)
      if ((await shell.locator(windowSelector(tabId)).getAttribute("data-focused")) === null) {
        await shell.locator(rowSelector(tabId)).click();
        await settled(shell, app);
      }
      await shell.locator(`${windowSelector(tabId)} [data-testid="desk-collapse"]`).click();
      await settled(shell, app);
    }
    await expect(shell.getByTestId("desk-window")).toHaveCount(0);
    expect((await snapshot(shell)).activeTabId).toBe(ids[2]);
    await shell.locator(rowSelector(ids[2]!)).click();
    await expect(shell.locator(windowSelector(ids[2]!))).toHaveCount(1);
    await settled(shell, app);
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    await expectLiveIn(app, shell, urls[2]!, ids[2]!);
    // Out and in use, its row is the address, as any tab's in use is.
    await shell.locator(rowSelector(ids[2]!)).click();
    await expect(shell.getByTestId("url-bar")).toBeVisible();
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
  });

  test("a window on the desk is never asleep: a sleeping tab's window wakes as it comes out, and no desk window is put to sleep", async () => {
    test.setTimeout(60_000);
    // The invoices' tab sleeps; the plain site's is the one in use.
    const [sleeper, inUse] = [ids[0]!, ids[2]!];
    const lifecycleOf = async (tabId: string): Promise<string | undefined> => (await snapshot(shell)).tabs.find((tab) => tab.id === tabId)?.lifecycle;

    // ── 1. Both tabs out on the desk, then the desk left: its windows are saved ─
    await shell.locator(rowSelector(sleeper)).click();
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell, app);
    await shell.locator(rowSelector(inUse)).click();
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(inUse);
    await settled(shell, app);
    await leaveDesk(shell);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(0);

    // ── 2. The one tab goes to sleep while the desk is away ─────────────
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.suspendTab(tabId), sleeper);
    await expect.poll(() => lifecycleOf(sleeper)).toBe("suspended");

    // ── 3. Reopened, the desk brings its window back, and its tab wakes by itself: nothing asks for a click ─
    await openGroupDesk(shell, "desk-dock");
    await expect(shell.getByTestId("desk-surface")).toBeVisible();
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await expect.poll(() => lifecycleOf(sleeper), { timeout: 15_000 }).toBe("live");
    expect((await snapshot(shell)).activeTabId).toBe(inUse);
    await settled(shell, app);
    await expect(shell.getByText("click to wake")).toHaveCount(0);
    await expect(shell.locator(windowSelector(sleeper)).getByText("Waking…")).toHaveCount(0);
    await capture(app, shell, "75-desk-woken.png");

    // ── 4. A window on the desk is never put to sleep, even when it is not the one in use ─
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.suspendTab(tabId), sleeper);
    // (Nothing to wait on: a tab that sleeps says so at once.)
    await shell.waitForTimeout(500);
    expect(await lifecycleOf(sleeper)).toBe("live");
  });
});

test("on the rail the favorites are one folder: its sheet slides out of the rail over the desk, the pages under it giving way, by pointer, click or keyboard", { tag: ["@desk", "@sidebar"] }, async () => {
  test.setTimeout(120_000);
  const favorites = [
    ["Vendor", VENDOR],
    ["Docs", "https://docs.example.org/"],
    ["Mail", "pistachio://demo/auth/relying-party?favorite=mail"],
    ["Calendar", "https://calendar.example.net/"],
    ["News", "https://news.example.com/"],
    ["Wiki", "https://wiki.example.org/"],
    ["Bank", "https://bank.example.com/"],
  ];
  const { app, shell } = await launchDesk({
    name: "rail-favorites",
    files: {
      "sidebar.json": { version: 1, spaces: { work: { favorites: favorites.map(([title, url], index) => ({ id: `fav-${String(index)}`, url, title, faviconUrl: null })), entries: [] } } },
    },
  });
  try {
    await createTab(shell, "pistachio://demo/auth/relying-party");
    await expect.poll(async () => (await snapshot(shell)).tabs.length).toBe(2);
    const ids = (await snapshot(shell)).tabs.map((tab) => tab.id);
    // A tab outside the group, its row on the rail too: it can be dropped onto the favorites.
    await createTab(shell, "pistachio://demo/invoices?outside=1");
    await expect.poll(async () => (await snapshot(shell)).tabs.length).toBe(3);
    const outside = (await snapshot(shell)).tabs.find((tab) => !ids.includes(tab.id))!.id;
    await createGroup(shell, "desk-favorites", ids, "Northstar", "blue");
    // One favorite's page open (Mail's, a local page), outside the group.
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.sidebarCommand({ type: "open", anchorId: "fav-2" }));
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.anchorId === "fav-2")).toBe(true);
    await selectTab(shell, ids[0]!);
    await openGroupDesk(shell, "desk-favorites");
    await expect(shell.locator('[data-testid="sidebar-motion-slot"][data-rail]')).toHaveCount(1);
    await settled(shell, app);
    const stage = await box(shell, ".desk-stage");
    const away = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.6);
    await away();

    // ── 1. One folder in place of a row per favorite: the first four icons and the count ─
    const folder = shell.getByTestId("rail-favorites");
    await expect(folder).toHaveAttribute("aria-label", "Favorites, 7");
    await expect(folder.locator(".rail-favorites-mark")).toHaveCount(4);
    const folderBox = await box(shell, '[data-testid="rail-favorites"]');
    expect(folderBox.height).toBe(32);
    // Under it, the favorites whose pages are open: Mail's (named as its page is, its address under the name).
    const openRows = shell.getByTestId("rail-favorite-open");
    await expect(openRows).toHaveCount(1);
    await expect(openRows.first()).toHaveAttribute("aria-label", /, open$/);
    await expect(openRows.first()).toHaveAttribute("title", /favorite=mail/);
    expect((await box(shell, '[data-testid="rail-favorite-open"]')).y).toBeGreaterThanOrEqual(folderBox.y + folderBox.height);
    const sheet = shell.getByTestId("rail-favorites-sheet");
    await expect(sheet).not.toHaveAttribute("data-open", /.*/);
    // Shut, its tiles are out of reach (inert, unseen).
    await expect(sheet).toHaveJSProperty("inert", true);

    // ── 2. The pointer resting on it: the sheet slides out of the rail's edge, over the desk, once the pages under it have given way ─
    await folder.hover();
    await expect(sheet).toHaveAttribute("data-shown", "");
    const sheetBox = await box(shell, '[data-testid="rail-favorites-sheet"]');
    const slot = await box(shell, '[data-testid="sidebar-motion-slot"]');
    expect(Math.abs(sheetBox.x - (slot.x + slot.width))).toBeLessThanOrEqual(1);
    expect(sheetBox.y).toBeLessThanOrEqual(folderBox.y);
    await expect(sheet.getByTestId("favorite-tile")).toHaveCount(7);
    for (const view of await liveViews(app)) {
      const clear = view.bounds.x >= sheetBox.x + sheetBox.width || view.bounds.y >= sheetBox.y + sheetBox.height || view.bounds.y + view.bounds.height <= sheetBox.y;
      expect(clear, `a live page under the sheet: ${JSON.stringify(view.bounds)}`).toBe(true);
    }
    await capture(app, shell, "24-rail-favorites.png");
    // It goes a moment after the pointer leaves it and the folder.
    await away();
    await expect(sheet).not.toHaveAttribute("data-open", /.*/, { timeout: 2_000 });

    // ── 3. A click pins it out: the pointer leaving keeps it; Escape puts it away ─
    await folder.click();
    await expect(sheet).toHaveAttribute("data-shown", "");
    await away();
    // (Past the moment a sheet the pointer left lingers: RailFavorites' LINGER_MS, 300ms.)
    await shell.waitForTimeout(700);
    await expect(sheet).toHaveAttribute("data-open", "");
    await shell.keyboard.press("Escape");
    await expect(sheet).not.toHaveAttribute("data-open", /.*/);

    // ── 4. The keyboard: Enter brings it out on its first favorite, the arrows move through them, Escape goes back to the folder ─
    await folder.focus();
    await shell.keyboard.press("Enter");
    await expect(sheet).toHaveAttribute("data-shown", "");
    await expect.poll(() => shell.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null)).toBe("Vendor");
    await shell.keyboard.press("ArrowRight");
    await expect.poll(() => shell.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null)).toBe("Docs");
    await shell.keyboard.press("ArrowDown");
    await expect.poll(() => shell.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null)).toBe("News");
    await shell.keyboard.press("Escape");
    await expect(sheet).not.toHaveAttribute("data-open", /.*/);
    await expect.poll(() => shell.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null)).toBe("rail-favorites");

    // ── 5. A row dragged onto the folder opens the sheet, and its grid takes the drop ─
    const from = center(await box(shell, rowSelector(outside)));
    const onFolder = center(folderBox);
    await shell.mouse.move(from.x, from.y);
    await shell.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await shell.mouse.move(from.x + ((onFolder.x - from.x) * step) / 10, from.y + ((onFolder.y - from.y) * step) / 10);
      await shell.waitForTimeout(16);
    }
    await expect(sheet).toHaveAttribute("data-open", "");
    await expect(sheet).toHaveAttribute("data-shown", "");
    const lastTile = await box(shell, '[data-testid="rail-favorites-sheet"] [data-testid="favorite-tile"] >> nth=-1');
    const into = { x: lastTile.x + lastTile.width + 20, y: lastTile.y + lastTile.height / 2 };
    for (let step = 1; step <= 10; step += 1) {
      await shell.mouse.move(onFolder.x + ((into.x - onFolder.x) * step) / 10, onFolder.y + ((into.y - onFolder.y) * step) / 10);
      await shell.waitForTimeout(16);
    }
    await shell.mouse.up();
    await expect.poll(async () => (await snapshot(shell)).sidebar.favorites.length).toBe(8);
    // (Not the desk's: the tab stays out of the group, no window for it.)
    expect((await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-favorites")?.tabIds).not.toContain(outside);
    await expect(folder).toHaveAttribute("aria-label", "Favorites, 8");
    // Its page is the new favorite's, open: under the folder with Mail's.
    await expect(openRows).toHaveCount(2);
    await away();
    await expect(sheet).not.toHaveAttribute("data-open", /.*/, { timeout: 2_000 });

    // ── 6. The middle button on an open favorite's row closes its page, and the row goes ─
    await shell.locator('[data-testid="rail-favorite-open"][title*="favorite=mail"]').click({ button: "middle" });
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.anchorId === "fav-2")).toBe(false);
    await expect(openRows).toHaveCount(1);
    await expect(shell.locator('[data-testid="rail-favorite-open"][title*="favorite=mail"]')).toHaveCount(0);

    // ── 7. A favorite chosen opens it, as from the whole sidebar: its page on a desk of its own — its page's group's, with a Bar ─
    await folder.hover();
    await expect(sheet).toHaveAttribute("data-shown", "");
    await sheet.getByRole("listitem", { name: "Vendor" }).click();
    await expect
      .poll(async () => {
        const now = await snapshot(shell);
        return now.tabs.find((tab) => tab.id === now.activeTabId)?.url ?? null;
      })
      .toBe(VENDOR);
    const vendorTab = (await snapshot(shell)).activeTabId!;
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);
    await expect(shell.locator(windowSelector(vendorTab))).toHaveCount(1);
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await expect.poll(async () => (await snapshot(shell)).anchorGroups?.find((group) => group.tabIds.includes(vendorTab))?.anchorId ?? null).not.toBe(null);
    await expect(shell.getByTestId("desk-bar")).toHaveCount(1);
    // Its window put away, its tab is still the one in use: the favorite chosen again brings the window back out.
    await settled(shell, app);
    await shell.locator(windowSelector(vendorTab)).getByTestId("desk-collapse").click();
    await expect(shell.locator(windowSelector(vendorTab))).toHaveCount(0);
    expect((await snapshot(shell)).activeTabId).toBe(vendorTab);
    // (Its desk up, its page's row is the list's, under the favorites — not one of the folder's open rows.)
    await expect(shell.locator(`[data-testid="rail-favorite-open"][data-live-tab-id="${vendorTab}"]`)).toHaveCount(0);
    await expect(shell.locator(`[data-testid="entry-tabs"] [data-tab-id="${vendorTab}"]`)).toHaveCount(1);
    await folder.hover();
    await expect(sheet).toHaveAttribute("data-shown", "");
    await sheet.getByRole("listitem", { name: "Vendor" }).click();
    await expect(shell.locator(windowSelector(vendorTab))).toHaveCount(1);
    // ⌘I puts the keyboard in its Bar, as on any group's desk, rather than opening the console.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("pistachio:shell-command", { type: "toggleConsole" }));
    await expect(shell.getByTestId("desk-bar-input")).toBeFocused();
    await expect(shell.getByTestId("agent-panel")).not.toBeVisible();
  } finally {
    await app.close();
  }
});

test.describe.serial("the desk's keys: ⇧⌫ on a row, the window buttons, ⌘T, ⌘L and a window's title", { tag: ["@desk", "@sidebar", "@tabs", "@address"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let origin: string;
  let urls: string[];
  let ids: string[];

  test.beforeAll(async () => {
    ({ app, shell } = await launchDesk({ name: "keys" }));
    origin = await serveDockSites(app);
    urls = [INVOICES, `${origin}/app`, `${origin}/plain`, `${origin}/player`];
    ids = await openTabs(shell, urls);
    await createGroup(shell, "desk-close", ids, "Close", "blue");
    // Whether main says a tab's row is under the pointer (DeskState.dockHover), as the shell tells it.
    await app.evaluate(({ ipcMain }, channel) => {
      ipcMain.on(channel, (_event, state: { dockHover?: boolean } | null) => {
        (globalThis as unknown as { deskDockHover: boolean }).deskDockHover = state?.dockHover === true;
      });
    }, IPC.deskSet);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("⇧⌫ with the pointer on a tab's row in the sidebar closes that tab, wherever the keyboard is, and the page never hears it", async () => {
    test.setTimeout(90_000);
    const [invoices, atlas, plain, player] = ids as [string, string, string, string];
    // The desk opens on the app's page: its window is in use, and its page has the keyboard.
    await selectTab(shell, atlas);
    await openGroupDesk(shell, "desk-close");
    const groupRows = shell.locator('[data-testid="tab-group"] [role="tab"]');
    await expect(groupRows).toHaveCount(4);
    await settled(shell, app);
    await expectLiveIn(app, shell, urls[1]!, atlas);
    const stage = await box(shell, ".desk-stage");

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
    const dockHover = (): Promise<boolean> => app.evaluate(() => (globalThis as unknown as { deskDockHover?: boolean }).deskDockHover === true);
    /** The pointer off the rows, and main told so. */
    const offRows = async (): Promise<void> => {
      await shell.mouse.move(stage.x + stage.width * 0.6, stage.y + stage.height * 0.5);
      await expect.poll(dockHover).toBe(false);
    };
    /** The pointer onto a row — from off the rows, so main hears a row come under it once the shell holds this one. */
    const hoverRow = async (tabId: string): Promise<void> => {
      await offRows();
      const row = center(await box(shell, rowSelector(tabId)));
      await shell.mouse.move(row.x, row.y);
      await expect.poll(dockHover).toBe(true);
    };
    const tabIdsNow = async (): Promise<string[]> => (await snapshot(shell)).tabs.map((tab) => tab.id);

    // ── 1. On a tab not out on the desk, the keyboard the page's: that tab closes, and the page hears nothing ─
    await hoverRow(plain);
    await capture(app, shell, "44-row-close-hover.png");
    await shiftBackspace(urls[1]!);
    await expect.poll(tabIdsNow).not.toContain(plain);
    await expect(groupRows).toHaveCount(3);
    await expect(shell.locator(rowSelector(plain))).toHaveCount(0);
    expect(await inPage<string[]>(urls[1]!, "heard")).toEqual([]);

    // ── 2. Held down, it closes one tab, not one per repeat (the repeats never reach the page either) ─
    await hoverRow(invoices);
    await shiftBackspace(urls[1]!, true);
    // (Nothing to wait on: a repeat that closed the tab would have done so by now.)
    await shell.waitForTimeout(400);
    expect(await tabIdsNow()).toContain(invoices);
    expect(await inPage<string[]>(urls[1]!, "heard")).toEqual([]);
    await shiftBackspace(urls[1]!);
    await expect.poll(tabIdsNow).not.toContain(invoices);
    await expect(groupRows).toHaveCount(2);

    // ── 3. On a tab out on the desk, struck in the shell: its window goes with it, and the desk stays up ─
    await shell.locator(rowSelector(player)).click();
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell, app);
    await hoverRow(player);
    await shiftBackspace("shell");
    await expect.poll(tabIdsNow).not.toContain(player);
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await expect(groupRows).toHaveCount(1);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(atlas);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);
    await capture(app, shell, "45-row-closed.png");

    // ── 4. Off the rows, ⇧⌫ is the page's again, and closes nothing ─────────────────
    await offRows();
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.focus(), urls[1]!);
    await shiftBackspace(urls[1]!);
    await expect.poll(() => inPage<string[]>(urls[1]!, "heard")).toEqual(["⇧Backspace"]);
    expect(await tabIdsNow()).toContain(atlas);
    await expect(groupRows).toHaveCount(1);
  });

  test("on a desk the window buttons hide with the rail and come back with the whole sidebar, ⌘T brings a new tab out as a window, and ⌘L or a click on a window's title edits its address", async () => {
    test.setTimeout(90_000);
    // The group again two tabs — the app's, and the plain site's anew — and the desk opened afresh on the app's.
    const atlas = ids[1]!;
    await leaveDesk(shell);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(0);
    await createTab(shell, urls[2]!);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === urls[2])).toBe(true);
    const plain = (await snapshot(shell)).tabs.find((tab) => tab.url === urls[2])!.id;
    await tabGroupCommand(shell, { type: "addTab", groupId: "desk-close", tabId: plain });
    await selectTab(shell, atlas);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(atlas);
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
    await openGroupDesk(shell, "desk-close");
    const groupRows = shell.locator('[data-testid="tab-group"] [role="tab"]');
    await expect(groupRows).toHaveCount(2);
    await settled(shell, app);

    // ── 1. The sidebar is the desk's rail: the window's buttons are hidden (they would hang over the desk's
    //       corner), and the rail's head takes their place; the whole sidebar brings them back, the rail hides them again ─
    const buttonsNow = async (): Promise<boolean | undefined> => (await app.evaluate(() => (globalThis as unknown as { buttons: boolean[] }).buttons)).at(-1);
    await expect.poll(buttonsNow).toBe(false);
    const head = await box(shell, '[data-testid="desk-rail-toggle"]');
    expect(head.y).toBeLessThan(TRAFFIC_LIGHTS_H);
    await capture(app, shell, "46-desk-buttons.png");
    await shell.getByTestId("desk-rail-toggle").click();
    await expect(shell.locator('[data-testid="sidebar-motion-slot"]:not([data-rail])[data-desk]')).toHaveCount(1);
    await expect.poll(buttonsNow).toBe(true);
    await settled(shell, app);
    await shell.getByTestId("desk-rail-toggle").click();
    await expect(shell.locator('[data-testid="sidebar-motion-slot"][data-rail]')).toHaveCount(1);
    await expect.poll(buttonsNow).toBe(false);
    await settled(shell, app);

    const address = shell.getByTestId("address-input");
    /** The palette up over the desk: the pages under it put down (drawn by the shell). */
    const paletteShown = async (): Promise<void> => {
      await expect(shell.getByTestId("url-bar")).toBeVisible();
      await expect.poll(async () => (await liveViews(app)).length).toBe(0);
    };

    // ── 2. ⌘L in the window's page: the address palette, on its tab ─────────────
    await strike(app, urls[1]!, "l");
    await paletteShown();
    await expect(address).toHaveValue(urls[1]!);
    await capture(app, shell, "47-desk-cmd-l.png");
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);

    // ── 3. ⌘T: a new tab in the group, out on the desk as the window in use (the sidebar's New tab) ─
    await expectLiveIn(app, shell, urls[1]!, atlas);
    await strike(app, urls[1]!, "t");
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await expect(groupRows).toHaveCount(3);
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-close")?.tabIds.length).toBe(3);
    const added = await snapshot(shell);
    const fresh = added.tabGroups.find((candidate) => candidate.id === "desk-close")!.tabIds.find((tabId) => tabId !== atlas && tabId !== plain)!;
    expect(added.tabs.find((tab) => tab.id === fresh)?.url).toBe(INVOICES);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(fresh);
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);
    await settled(shell, app);
    await capture(app, shell, "48-desk-cmd-t.png");

    // ── 4. A click on the other window's title: that tab in use, and its address to edit ─
    // (Tiled first: the new window came out over it.)
    await openMore(shell);
    await shell.getByTestId("desk-tile").click();
    await settled(shell, app);
    await shell.locator(`${windowSelector(atlas)} [data-testid="desk-window-address"]`).click();
    await paletteShown();
    await expect(address).toHaveValue(urls[1]!);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(atlas);
    await capture(app, shell, "49-desk-title-click.png");
    // Typed and entered, the window's page goes there, and the desk stays up.
    await address.fill(`${origin}/plain`);
    await address.press("Enter");
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    await expect.poll(async () => (await snapshot(shell)).tabs.find((tab) => tab.id === atlas)?.url).toBe(`${origin}/plain`);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
  });
});

test.describe.serial("a mask: a region of a page as the whole window", { tag: ["@desk"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let urls: string[];
  let ids: string[];
  const win = (): string => windowSelector(ids[0]!);
  /** Run script in the player's page itself (its own window: no mask is visible to it). */
  const inPage = <T,>(script: string): Promise<T> =>
    app.evaluate(({ webContents }, { url, script }) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.executeJavaScript(script), {
      url: urls[0]!,
      script,
    }) as Promise<T>;
  /** A click on the page's view at a point of it, as main hears one from the pointer (it maps it, masked). */
  const clickPage = (point: { x: number; y: number }): Promise<void> =>
    app.evaluate(
      async ({ webContents }, { url, point }) => {
        const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
        contents.sendInputEvent({ type: "mouseMove", ...point });
        contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
        await new Promise((done) => setTimeout(done, 40));
        contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
      },
      { url: urls[0]!, point },
    );
  /** The player: 40px in, under a 64px header and 24px of padding, 480 × 270. */
  const region = { x: 40, y: 88, w: 480, h: 270 };

  test.beforeAll(async () => {
    ({ app, shell } = await launchDesk({ name: "mask" }));
    const origin = await serveDockSites(app);
    urls = [`${origin}/player`, VENDOR];
    ids = await openTabs(shell, urls);
    await createGroup(shell, "desk-mask", ids, "Mask", "green");
    await selectTab(shell, ids[0]!);
    await openGroupDesk(shell, "desk-mask");
    await expect(shell.locator('[data-testid="tab-group"] [role="tab"]')).toHaveCount(2);
    await settled(shell, app);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("a mask never lets its page see a resize, and its region can be edited: the whole page shown faded around it, edges dragged, Done or Escape", async () => {
    test.setTimeout(90_000);
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
    const page = await box(shell, `${win()} [data-testid="desk-window-page"]`);

    // ── 1. Mask the player: the page never sees its size change, not for a frame ─
    await shell.mouse.move(page.x + page.width / 2, page.y - 10);
    await fromFrameMenu(shell, win(), "desk-mask");
    await expect(shell.locator(`${win()} [data-testid="desk-mask-selector"]`)).toBeVisible();
    await shell.mouse.move(page.x + region.x, page.y + region.y);
    await shell.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await shell.mouse.move(page.x + region.x + (region.w * step) / 10, page.y + region.y + (region.h * step) / 10);
      await shell.waitForTimeout(16);
    }
    await shell.mouse.up();
    await expect(shell.locator(`${win()}[data-masked]`)).toHaveCount(1);
    await settled(shell, app);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    // (Nothing to wait on: a resize the page saw would have reached it by now.)
    await shell.waitForTimeout(300);
    expect(await inPage<string[]>("window.__sizes")).toEqual([]);
    expect(await inPage<number>("innerWidth")).toBe(pageWidth);
    expect(await inPage<number>("innerHeight")).toBe(pageHeight);
    const masked = await box(shell, win());

    // ── 2. Edit mask (the window in use): the whole page, faded, around the region ─
    await fromFrameMenu(shell, win(), "desk-edit-mask");
    const editor = shell.locator(`${win()} [data-testid="desk-mask-editor"]`);
    await expect(editor).toHaveAttribute("data-shown", "");
    await expect(editor).toHaveAttribute("data-whole", "");
    await expect(shell.locator(`${win()}[data-editing="shown"]`)).toHaveCount(1);
    // Every picture the editor shows is of the whole page, in the page's shape: never one
    // taken before its view had the size for it (the region's box, scaled up and cropped).
    const shapes: number[] = [];
    for (let sample = 0; sample < 16; sample += 1) {
      const shape = await shell.evaluate((selector) => {
        const image = document.querySelector<HTMLImageElement>(selector);
        return image !== null && image.complete && image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : null;
      }, `${win()} [data-testid="desk-mask-editor"][data-shown] .desk-mask-editor-shot img`);
      if (shape !== null) shapes.push(shape);
      await shell.waitForTimeout(40);
    }
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) expect(Math.abs(shape - pageWidth / pageHeight)).toBeLessThan(0.03);
    // The page's own view is down meanwhile; the editor's region is where the window's was.
    await expect.poll(async () => (await liveViews(app)).some((view) => view.url === urls[0])).toBe(false);
    const editRegion = await box(shell, `${win()} [data-testid="desk-mask-editor-region"]`);
    expect(Math.abs(editRegion.x - masked.x)).toBeLessThan(2);
    expect(Math.abs(editRegion.y - (masked.y + 18))).toBeLessThan(2);
    expect(Math.abs(editRegion.width - region.w)).toBeLessThan(2);
    await capture(app, shell, "37-mask-editing.png");

    // ── 3. Drag the bottom-right corner out: the region grows over the page ────
    const corner = center(await box(shell, `${win()} [data-handle="se"]`));
    await shell.mouse.move(corner.x, corner.y);
    await shell.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await shell.mouse.move(corner.x + (80 * step) / 8, corner.y + (40 * step) / 8);
      await shell.waitForTimeout(16);
    }
    await expect(shell.locator(`${win()} [data-testid="desk-mask-editor"] .desk-mask-size`)).toHaveText(`${region.w + 80} × ${region.h + 40}`);
    await capture(app, shell, "38-mask-edit-dragging.png");
    await shell.mouse.up();

    // ── 4. Done: the window is the new region, live, where it lies on the page ──
    await shell.getByTestId("desk-mask-edit-done").click();
    await expect(editor).toHaveCount(0);
    await settled(shell, app);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    const edited = await box(shell, win());
    expect(Math.abs(edited.x - masked.x)).toBeLessThan(2);
    expect(Math.abs(edited.y - masked.y)).toBeLessThan(2);
    expect(Math.abs(edited.width - (region.w + 80))).toBeLessThan(2);
    expect(Math.abs(edited.height - (region.h + 40 + 18))).toBeLessThan(2);
    // Still the page, its clicks mapped through the new region: the player plays.
    await clickPage({ x: 240, y: 135 });
    await expect.poll(() => inPage<number>("window.toggles")).toBe(1);
    await capture(app, shell, "39-mask-edited.png");
    // And through all of it, the page never saw its size change.
    expect(await inPage<string[]>("window.__sizes")).toEqual([]);
    expect(await inPage<number>("innerWidth")).toBe(pageWidth);

    // ── 5. Edit again, move the region, and Escape: nothing changes ──────────────
    await fromFrameMenu(shell, win(), "desk-edit-mask");
    await expect(editor).toHaveAttribute("data-shown", "");
    const inside = center(await box(shell, `${win()} [data-testid="desk-mask-editor-region"]`));
    await shell.mouse.move(inside.x, inside.y);
    await shell.mouse.down();
    await shell.mouse.move(inside.x + 30, inside.y + 30, { steps: 4 });
    await shell.mouse.up();
    await shell.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await settled(shell, app);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    const kept = await box(shell, win());
    expect(Math.abs(kept.x - edited.x)).toBeLessThan(2);
    expect(Math.abs(kept.width - edited.width)).toBeLessThan(2);
    expect(await inPage<string[]>("window.__sizes")).toEqual([]);

    // ── 6. Unmask: the whole page back around the region — and the page, laid out at its
    //      own box all along, never sees its size change, not for a frame of the way back ─
    await shell.locator(`${win()} [data-testid="desk-unmask"]`).click();
    await expect(shell.locator(`${win()}[data-masked]`)).toHaveCount(0);
    await settled(shell, app);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    // (Nothing to wait on: a resize the page saw would have reached it by now.)
    await shell.waitForTimeout(300);
    expect(await inPage<string[]>("window.__sizes")).toEqual([]);
    expect(await inPage<number>("innerWidth")).toBe(pageWidth);
    expect(await inPage<number>("innerHeight")).toBe(pageHeight);
    const whole = await box(shell, `${win()} [data-testid="desk-window-page"]`);
    expect(Math.abs(whole.width - pageWidth)).toBeLessThan(2);
    expect(Math.abs(whole.height - pageHeight)).toBeLessThan(2);
    await capture(app, shell, "39d-unmasked.png");
  });

  test("a mask: a region chosen from a page is all the window shows, live and still usable, scaled like a picture, and the page never reflows", async () => {
    test.setTimeout(120_000);
    // The player as it was loaded: paused, untouched.
    await inPage("window.toggles = 0; window.headerPresses = 0; document.getElementById('player').removeAttribute('data-playing'); document.getElementById('state').textContent = 'Paused'; 0");
    const pageWidth = await inPage<number>("innerWidth");
    const before = await box(shell, win());
    const page = await box(shell, `${win()} [data-testid="desk-window-page"]`);

    // ── 1. Mask: the page freezes and dims; a drag over it picks the region ────
    await shell.mouse.move(page.x + page.width / 2, before.y + 10);
    await fromFrameMenu(shell, win(), "desk-mask");
    const selector = shell.locator(`${win()} [data-testid="desk-mask-selector"]`);
    await expect(selector).toBeVisible();
    await shell.mouse.move(page.x + region.x, page.y + region.y);
    await shell.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await shell.mouse.move(page.x + region.x + (region.w * step) / 10, page.y + region.y + (region.h * step) / 10);
      await shell.waitForTimeout(16);
    }
    await expect(shell.locator(`${win()} .desk-mask-size`)).toHaveText(`${region.w} × ${region.h}`);
    await capture(app, shell, "30-mask-choosing.png");
    await shell.mouse.up();

    // ── 2. The window is the region, where it was, live — the page still laid out at its width ─
    await expect(shell.locator(`${win()}[data-masked]`)).toHaveCount(1);
    await settled(shell, app);
    const masked = await box(shell, win());
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
    await capture(app, shell, "31-masked-playing.png");
    await clickPage({ x: 6, y: 6 });
    await expect.poll(() => inPage<number>("window.toggles")).toBe(2);
    expect(await inPage<number>("window.headerPresses")).toBe(0);
    // Clicks are the page's: the window stays where it is.
    const stayed = await box(shell, win());
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
    await expect(shell.locator(`${win()}[data-masked]`)).toHaveCount(1);
    await settled(shell, app);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await expect.poll(() => inPage<number>("innerWidth")).toBe(pageWidth);
    // The page's toggles were only the two clicks: the fullscreen button's click was its own.
    expect(await inPage<number>("window.toggles")).toBe(2);

    // ── 3. Resized by its corner: the picture scales, its shape kept; the page does not reflow ─
    const corner = await box(shell, `${win()} [data-desk-edge="se"]`);
    await place(shell, center(corner), { x: center(corner).x + region.w / 2, y: center(corner).y + 40 });
    await settled(shell, app);
    const scaled = await box(shell, win());
    expect(Math.abs(scaled.width - region.w * 1.5)).toBeLessThan(3);
    expect(Math.abs((scaled.height - 18) / scaled.width - region.h / region.w)).toBeLessThan(0.01);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    expect(await inPage<number>("innerWidth")).toBe(pageWidth);
    // Scaled, a click still finds the player: the point is mapped at the new scale.
    await clickPage({ x: Math.round(scaled.width - 12), y: Math.round(scaled.height - 18 - 12) });
    await expect.poll(() => inPage<number>("window.toggles")).toBe(3);
    await capture(app, shell, "32-masked-scaled.png");

    // ── 4. Moved by its handle, its size kept ─────────────────────────────────
    const handle = await box(shell, `${win()} .desk-window-pill`);
    await place(shell, center(handle), { x: center(handle).x - 80, y: center(handle).y + 60 });
    await settled(shell, app);
    const moved = await box(shell, win());
    expect(Math.abs(moved.x - (scaled.x - 80))).toBeLessThan(20);
    expect(Math.abs(moved.y - (scaled.y + 60))).toBeLessThan(20);
    expect(Math.abs(moved.width - scaled.width)).toBeLessThan(2);

    // ── 5. Unmask: the whole window back around the region, the page as it was ─
    await shell.locator(`${win()} [data-testid="desk-unmask"]`).click();
    await expect(shell.locator(`${win()}[data-masked]`)).toHaveCount(0);
    await settled(shell, app);
    const whole = await box(shell, win());
    expect(Math.abs(whole.width - before.width)).toBeLessThan(2);
    expect(Math.abs(whole.height - before.height)).toBeLessThan(2);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    expect(await inPage<number>("innerWidth")).toBe(pageWidth);
    await capture(app, shell, "33-unmasked.png");

    // ── 6. Masked again, and the desk left: the pane is the whole page, laid out at the pane's width ─
    const pageAgain = await box(shell, `${win()} [data-testid="desk-window-page"]`);
    await shell.mouse.move(pageAgain.x + pageAgain.width / 2, whole.y + 10);
    await fromFrameMenu(shell, win(), "desk-mask");
    await expect(shell.locator(`${win()} [data-testid="desk-mask-selector"]`)).toBeVisible();
    await shell.mouse.move(pageAgain.x + 60, pageAgain.y + 60);
    await shell.mouse.down();
    await shell.mouse.move(pageAgain.x + 360, pageAgain.y + 260, { steps: 8 });
    await shell.mouse.up();
    await expect(shell.locator(`${win()}[data-masked]`)).toHaveCount(1);
    await settled(shell, app);
    const leftAt = await box(shell, win());
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

    const leaveAndWait = async (): Promise<void> => {
      await shell.mouse.move(10, 10);
      await leaveDesk(shell);
      await expect(shell.getByTestId("desk-surface")).toHaveCount(0);
      await expect(shell.locator('[data-testid="sidebar-pane"]:not([data-hidden])')).toHaveCount(1);
    };

    // ── 7. Reopened on the other tab: the masked window comes out of the dock masked, as it was left ─
    await selectTab(shell, ids[1]!);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(ids[1]);
    await openGroupDesk(shell, "desk-mask");
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);
    await expect(shell.locator(`${win()}[data-masked]`)).toHaveCount(1);
    await settled(shell, app);
    const back = await box(shell, win());
    expect(Math.abs(back.width - leftAt.width)).toBeLessThan(2);
    expect(Math.abs(back.height - leftAt.height)).toBeLessThan(2);
    expect(Math.abs(back.x - leftAt.x)).toBeLessThan(3);
    expect(Math.abs(back.y - leftAt.y)).toBeLessThan(3);
    // Brought forward (the window in view may lie over it), it is the live region again, and still the page.
    await shell.mouse.click(center(await box(shell, `${win()} .desk-window-pill`)).x, center(await box(shell, `${win()} .desk-window-pill`)).y);
    await settled(shell, app);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await expect.poll(() => inPage<number>("innerWidth")).toBe(pageWidth);
    const togglesBefore = await inPage<number>("window.toggles");
    await clickPage({ x: Math.round(back.width / 2), y: Math.round((back.height - 18) / 2) });
    await expect.poll(() => inPage<number>("window.toggles")).toBe(togglesBefore + 1);
    await capture(app, shell, "35-reopened-masked.png");

    // ── 8. Reopened on the masked window itself: it lifts off whole, is masked again, and goes where it was left ─
    await leaveAndWait();
    await selectTab(shell, ids[0]!);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(ids[0]);
    await openGroupDesk(shell, "desk-mask");
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);
    await expect(shell.locator(`${win()}[data-masked]`)).toHaveCount(1, { timeout: 10_000 });
    await settled(shell, app);
    const again = await box(shell, win());
    expect(Math.abs(again.width - leftAt.width)).toBeLessThan(2);
    expect(Math.abs(again.x - leftAt.x)).toBeLessThan(3);
    expect(Math.abs(again.y - leftAt.y)).toBeLessThan(3);
    await expectLiveIn(app, shell, urls[0]!, ids[0]!);
    await expect.poll(() => inPage<number>("innerWidth")).toBe(pageWidth);
    await capture(app, shell, "36-reopened-on-mask.png");
  });
});

test.describe.serial("passing the desk between a Space's groups", { tag: ["@desk", "@sidebar", "@tabs", "@settings"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  const urls = [
    INVOICES,
    VENDOR,
    "pistachio://demo/invoices?page=north",
    "pistachio://demo/invoices?page=south",
    "pistachio://demo/invoices?page=east",
    "pistachio://demo/invoices?page=loose",
    "pistachio://demo/invoices?page=second",
    "pistachio://demo/invoices?page=outside",
  ];
  let a0: string, a1: string, b0: string, b1: string, b2: string, loose: string, second: string, outside: string;
  const stageColor = (): Promise<string | null> => shell.evaluate(() => document.querySelector(".desk-stage")?.getAttribute("data-group-color") ?? null);
  const rowsOf = (id: string) => shell.locator(`${groupSelector(id)} [role="tab"]`);
  /**
   * Each test's own groups, never on a desk (a desk's windows are kept by its
   * group): the desk left, every group there is ungrouped, and these made.
   */
  const regroup = async (groups: Array<{ id: string; tabIds: string[]; title: string; color: TabGroupColor }>): Promise<void> => {
    if ((await shell.getByTestId("desk-surface").count()) > 0) {
      await leaveDesk(shell);
      await expect(shell.getByTestId("desk-surface")).toHaveCount(0);
    }
    for (const group of (await snapshot(shell)).tabGroups) await tabGroupCommand(shell, { type: "ungroup", groupId: group.id });
    for (const group of groups) await createGroup(shell, group.id, group.tabIds, group.title, group.color);
    await expect.poll(async () => (await snapshot(shell)).tabGroups.map((group) => group.id).sort()).toEqual(groups.map((group) => group.id).sort());
  };
  /** The desk's sidebar its rail: the desk keeps the whole sidebar (⌘S) a test before left it with. */
  const onRail = async (): Promise<void> => {
    await expect(shell.getByTestId("desk-surface")).toBeVisible();
    // (At rest first: the sidebar takes the width it was left with as the desk comes up.)
    await settled(shell, app);
    // (Its head's toggle, not ⌘S: a page has the keyboard, and Playwright's keys reach only the shell's.)
    if ((await shell.locator('[data-testid="sidebar-motion-slot"]:not([data-rail])[data-desk]').count()) > 0) await shell.getByTestId("desk-rail-toggle").click();
    await expect(shell.locator('[data-testid="sidebar-motion-slot"][data-rail]')).toHaveCount(1);
  };

  test.beforeAll(async () => {
    ({ app, shell } = await launchDesk({ name: "groups" }));
    [a0, a1, b0, b1, b2, loose, second, outside] = (await openTabs(shell, urls)) as [string, string, string, string, string, string, string, string];
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("a desk opened from a tab outside its group stays up on the group's tab, beneath Settings", async () => {
    await regroup([{ id: "desk-entry", tabIds: [a1, b0], title: "Entry", color: "green" }]);
    await selectTab(shell, outside);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(outside);

    // The tab in view is not the group's: the desk opens on the group's, and stays.
    await openGroupDesk(shell, "desk-entry");
    await expect.poll(async () => [a1, b0].includes((await snapshot(shell)).activeTabId ?? "")).toBe(true);
    await settled(shell, app);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);

    // Settings covers the whole surface, the desk's inventory included. The
    // desk's page has the keyboard, so ⌘, arrives as main relays it from there.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("pistachio:shell-command", { type: "runShortcut", id: "openSettings" });
    });
    const settings = shell.getByTestId("settings-page");
    await expect(settings).toBeVisible();
    const desk = await box(shell, ".desk-stage");
    const onTop = await shell.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="settings-page"]') !== null, center(desk));
    expect(onTop).toBe(true);
    // Closed, the desk is as it was.
    await shell.getByRole("button", { name: "Close settings" }).click();
    await expect(settings).toHaveCount(0);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);
  });


  test("choosing a tab off the desk passes the desk to its own: another group's, or a loose tab's group made for it — drawn as the tab alone, with all a group's desk has — which a group taking the tab deletes, and ⌘T grows into a group", async () => {
    test.setTimeout(120_000);
    const command = (body: TabGroupCommand): Promise<unknown> => tabGroupCommand(shell, body);
    await regroup([
      { id: "desk-a", tabIds: [a0, a1], title: "Research", color: "blue" },
      { id: "desk-b", tabIds: [b0, b1], title: "Regions", color: "orange" },
    ]);
    await selectTab(shell, a0);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(a0);
    await openGroupDesk(shell, "desk-a");
    await onRail();
    await settled(shell, app);
    const stage = await box(shell, ".desk-stage");
    const awayFromDock = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.95);
    /** The loose tab's group that holds the tab, if any. */
    const looseGroupOf = async (tabId: string) => ((await snapshot(shell)).looseGroups ?? []).find((group) => group.tabIds.includes(tabId)) ?? null;
    expect(await stageColor()).toBe("blue");

    // ── 1. Another group's tab chosen (the tab switcher, the address palette): the desk passes to that group, on that tab ─
    await selectTab(shell, b1);
    await expect.poll(stageColor).toBe("orange");
    await settled(shell, app);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);
    await expect(shell.locator(windowSelector(b1))).toHaveCount(1);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(b1);
    await expectLiveIn(app, shell, urls[3]!, b1);
    await capture(app, shell, "75-desk-passed-to-chosen-tab.png");

    // ── 2. A loose tab's row clicked: a group is made for it, drawn as the tab alone, and its desk has all a group's has ─
    await shell.locator(rowSelector(loose)).click();
    await awayFromDock();
    await expect.poll(async () => (await looseGroupOf(loose))?.id ?? null).not.toBe(null);
    const made = (await looseGroupOf(loose))!;
    expect((await snapshot(shell)).tabGroups.some((group) => group.tabIds.includes(loose))).toBe(false);
    await expect.poll(stageColor).toBe("gray");
    await settled(shell, app);
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await expect(shell.locator(windowSelector(loose))).toHaveCount(1);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(loose);
    await expectLiveIn(app, shell, urls[5]!, loose);
    // The desk's one tab: its window fills the desk.
    const alone = await box(shell, windowSelector(loose));
    const desk = await box(shell, ".desk-stage");
    for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(alone[key] - desk[key])).toBeLessThan(2);
    // No group's row in the sidebar: the tab's own, with the Stack under it; the Bar, asking about the tab.
    await expect(shell.locator(groupSelector(made.id))).toHaveCount(0);
    await expect(shell.locator(rowSelector(loose))).toHaveCount(1);
    await expect(shell.getByTestId("desk-stack")).toHaveCount(1);
    await expect(shell.getByTestId("desk-bar")).toHaveCount(1);
    await shell.evaluate(
      (groupId) => (window as unknown as { pistachio: PistachioApi }).pistachio.groupContext({ type: "addText", groupId, title: "Loose", kind: "fact", text: "Net 30 terms" }),
      made.id,
    );
    await expect(shell.getByTestId("desk-stack")).toHaveAttribute("data-count", "1");
    await capture(app, shell, "76-loose-tab-desk.png");

    // ── 3. The loose tab put in Research (its row dragged into the group): it is Research's, its group is gone, and the desk passes to Research on it ─
    await command({ type: "addTab", groupId: "desk-a", tabId: loose });
    await expect.poll(async () => (await looseGroupOf(loose))?.id ?? null).toBe(null);
    expect((await snapshot(shell)).tabGroups.find((group) => group.id === "desk-a")?.tabIds).toContain(loose);
    expect((await snapshot(shell)).tabGroups.some((group) => group.id === made.id)).toBe(false);
    await expect.poll(stageColor).toBe("blue");
    await settled(shell, app);
    await expect(shell.locator(windowSelector(loose))).toHaveCount(1);
    await expect(shell.locator(windowSelector(a0))).toHaveCount(1);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(loose);

    // ── 4. Another loose tab's desk, and ⌘T there: its group is one of two now, drawn, coloured and named as any group is ─
    await shell.locator(rowSelector(second)).click();
    await awayFromDock();
    await expect.poll(async () => (await looseGroupOf(second))?.id ?? null).not.toBe(null);
    const grown = (await looseGroupOf(second))!;
    await expect.poll(stageColor).toBe("gray");
    await settled(shell, app);
    await expectLiveIn(app, shell, urls[6]!, second);
    await strike(app, urls[6]!, "t");
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === grown.id)?.tabIds.length ?? 0).toBe(2);
    const drawn = (await snapshot(shell)).tabGroups.find((group) => group.id === grown.id)!;
    expect(drawn.loose).toBeUndefined();
    expect(drawn.color).not.toBe("gray");
    expect(await looseGroupOf(second)).toBe(null);
    const fresh = drawn.tabIds.find((tabId) => tabId !== second)!;
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(fresh);
    await expect.poll(stageColor).toBe(drawn.color);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await expect(shell.locator(windowSelector(second))).toHaveCount(1);
    await expect(shell.locator(windowSelector(fresh))).toHaveCount(1);
    await expect(shell.locator(groupSelector(grown.id))).toHaveCount(1);
    await settled(shell, app);
    await capture(app, shell, "77-loose-desk-cmd-t.png");

    // ── 4b. That group ungrouped from under its desk: the tab in use, loose now, gets a group of its own, its window
    // staying where it was (in place), and the other goes home ─
    const freshBox = await box(shell, windowSelector(fresh));
    await command({ type: "ungroup", groupId: grown.id });
    await expect.poll(async () => (await looseGroupOf(fresh))?.id ?? null).not.toBe(null);
    await expect.poll(stageColor).toBe("gray");
    await settled(shell, app);
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    const kept = await box(shell, windowSelector(fresh));
    for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(kept[key] - freshBox[key])).toBeLessThan(3);

    // ── 5. Research's tab chosen: the desk passes back to it, on that tab ─────
    await selectTab(shell, a1);
    await expect.poll(stageColor).toBe("blue");
    await settled(shell, app);
    await expect(shell.locator(windowSelector(a1))).toHaveCount(1);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(a1);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);
  });


  test("on a desk a tab's row has its menu with what the desk does with its window first, and another group's row its menu, renamed in the whole sidebar", async () => {
    test.setTimeout(120_000);
    // Research of three tabs, Regions of one.
    const a2 = b1;
    await regroup([
      { id: "menu-a", tabIds: [a0, a1, a2], title: "Research", color: "blue" },
      { id: "menu-b", tabIds: [b0], title: "Regions", color: "orange" },
    ]);
    await selectTab(shell, a0);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(a0);
    await openGroupDesk(shell, "menu-a");
    await onRail();
    await expect(rowsOf("menu-a")).toHaveCount(3);
    await settled(shell, app);

    const menu = shell.getByTestId("context-menu");
    const item = (name: string) => menu.getByRole("menuitem", { name, exact: true });
    const groupIcon = (id: string) => shell.locator(groupSelector(id));
    const groupHeader = (id: string): string => `${groupSelector(id)} [data-testid="tab-group-header"]`;
    const members = async (id: string): Promise<string[] | null> => (await snapshot(shell)).tabGroups.find((group) => group.id === id)?.tabIds ?? null;
    const stage = await box(shell, ".desk-stage");
    const awayFromDock = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.95);
    /** A right-click on a row, and its menu up (drawn once the pages have given way to their stills). */
    const menuOn = async (selector: string): Promise<void> => {
      await shell.locator(selector).click({ button: "right" });
      await expect(menu).toBeVisible();
      await expect(menu).not.toHaveClass(/opacity-0/);
    };
    const choose = async (name: string): Promise<void> => {
      await item(name).click();
      await expect(menu).toHaveCount(0);
    };

    // ── 1. A tab not out: out onto the desk, then the sidebar's own entries, with no split view ─
    await menuOn(rowSelector(a1));
    await expect(item("Open on the desk")).toBeVisible();
    for (const name of ["Pin tab", "Add to favorites", "Remove from “Research”", "New group with this tab", "Add to “Regions”", "Duplicate tab", "Suspend tab", "Close tab"]) {
      await expect(item(name)).toBeVisible();
    }
    await expect(menu.getByRole("menuitem", { name: /split/i })).toHaveCount(0);
    await expect(item("Collapse into the sidebar")).toHaveCount(0);
    await capture(app, shell, "58-row-tab-menu.png");
    await choose("Open on the desk");
    await expect(shell.locator(windowSelector(a1))).toHaveCount(1);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(a1);
    await awayFromDock();
    await settled(shell, app);

    // ── 2. A tab out on the desk: put away, or (not the window in use) brought to the front; it cannot be suspended ─
    await menuOn(rowSelector(a1));
    await expect(item("Collapse into the sidebar")).toBeVisible();
    await expect(item("Bring to front")).toHaveCount(0);
    await expect(item("Suspend tab")).toBeDisabled();
    await shell.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await menuOn(rowSelector(a0));
    await expect(item("Bring to front")).toBeVisible();
    await choose("Bring to front");
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(a0);
    await menuOn(rowSelector(a1));
    await choose("Collapse into the sidebar");
    await expect(shell.locator(windowSelector(a1))).toHaveCount(0);
    await awayFromDock();
    await settled(shell, app);

    // ── 3. Into another group from the menu: gone from the desk's group, into that group ─
    await menuOn(rowSelector(a2));
    await choose("Add to “Regions”");
    await expect.poll(() => members("menu-b")).toEqual([b0, a2]);
    await expect(rowsOf("menu-a")).toHaveCount(2);
    await expect(shell.getByTestId("desk-surface")).toBeVisible();

    // ── 4. The tab in use taken out of the group: the desk stays, on another of its tabs ─
    await menuOn(rowSelector(a1));
    await choose("Open on the desk");
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(a1);
    await awayFromDock();
    await settled(shell, app);
    await menuOn(rowSelector(a1));
    await choose("Remove from “Research”");
    await expect.poll(() => members("menu-a")).toEqual([a0]);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(a0);
    await expect(shell.getByTestId("desk-surface")).toBeVisible();
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await awayFromDock();
    await settled(shell, app);

    // ── 5. Duplicated: the copy joins the group beside it and comes out on the desk, in use ─
    await menuOn(rowSelector(a0));
    await choose("Duplicate tab");
    await expect.poll(async () => (await members("menu-a"))?.length).toBe(2);
    const copy = (await members("menu-a"))![1]!;
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(copy);
    await expect(shell.getByTestId("desk-surface")).toBeVisible();
    await expect(shell.locator(windowSelector(copy))).toHaveCount(1);
    await awayFromDock();
    await settled(shell, app);

    // ── 6. Another group's row: the sidebar's menu for the group ─────────────────
    // (A real press on the sidebar gives the shell the keyboard; Playwright's does not.)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.focus());
    await menuOn(groupHeader("menu-b"));
    for (const name of ["Rename", "New tab in group", "Open as split view", "Open as desk", "Ungroup tabs", "Close group"]) {
      await expect(item(name)).toBeVisible();
    }
    // Under the menu the pages are down; the window in use shows the picture main took of it, never a blank.
    await expect(shell.locator(`${windowSelector(copy)} [data-testid="desk-window-page"] img.desk-still`)).toHaveCount(1);
    await capture(app, shell, "59-row-group-menu.png");
    // Rename: the rail has no room for a name, so the whole sidebar comes back, the name a field in its row with the keyboard.
    await choose("Rename");
    await expect(shell.locator('[data-testid="sidebar-motion-slot"]:not([data-rail])[data-desk]')).toHaveCount(1);
    const rename = groupIcon("menu-b").getByTestId("tab-group-name-input");
    await expect(rename).toBeFocused();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.isFocused())).toBe(true);
    await shell.keyboard.press("Meta+a");
    await shell.keyboard.type("Places");
    await capture(app, shell, "60-row-group-rename.png");
    await shell.keyboard.press("Enter");
    await expect(rename).toHaveCount(0);
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === "menu-b")?.title).toBe("Places");
    // Its colour, from the swatches.
    await menuOn(groupHeader("menu-b"));
    await menu.getByTestId("group-color-green").click();
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === "menu-b")?.color).toBe("green");
    await expect(groupIcon("menu-b")).toHaveAttribute("data-group-color", "green");

    // ── 7. Open as desk: the desk passes to it in place ─────────────────────────
    await menuOn(groupHeader("menu-b"));
    await choose("Open as desk");
    await expect.poll(stageColor).toBe("green");
    await expect(shell.getByTestId("desk-surface")).toBeVisible();
    await expect(rowsOf("menu-b")).toHaveCount(2);
  });

  test("the sidebar lists the Space's other groups; on the rail a click on one passes the desk to it (its desk button, in the whole sidebar), each group's windows going home and coming back where they were left", async () => {
    test.setTimeout(120_000);
    await regroup([
      { id: "pass-a", tabIds: [a0, a1], title: "Research", color: "blue" },
      { id: "pass-b", tabIds: [b0, b1, b2], title: "Regions", color: "orange" },
    ]);
    // The tab used last in Regions: east (b2), so it is the one Regions opens on.
    for (const tabId of [b1, b0, b2, a0]) {
      await selectTab(shell, tabId);
      await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(tabId);
    }
    await openGroupDesk(shell, "pass-a");
    await onRail();
    await expect(rowsOf("pass-a")).toHaveCount(2);
    await settled(shell, app);

    // ── 1. On the rail, the Space's other group: its tabs' icons in a cluster, as the sidebar draws it ─
    const groupIcon = (id: string) => shell.locator(`${groupSelector(id)} [data-testid="tab-group-header"]`);
    await expect(groupIcon("pass-b")).toBeVisible();
    await expect(groupIcon("pass-b").getByTestId("favicon-cluster")).toHaveCount(1);
    const stage = await box(shell, ".desk-stage");
    /** Off the sidebar: a group the pointer is over peeks open. */
    const awayFromDock = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.95);
    // Research: a second window out, both moved to where they are to be left.
    await shell.locator(rowSelector(a1)).click();
    await awayFromDock();
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell, app);
    await expectLiveIn(app, shell, urls[1]!, a1);
    const researchLeft = { [a0]: await box(shell, windowSelector(a0)), [a1]: await box(shell, windowSelector(a1)) };
    await capture(app, shell, "40-sidebar-groups.png");

    // ── 2. Choose Regions: Research's windows go into its group, Regions opens on the tab used last ─
    await groupIcon("pass-b").click();
    await capture(app, shell, "41-group-switching.png", 140);
    await expect.poll(stageColor).toBe("orange");
    await awayFromDock();
    await expect(rowsOf("pass-b")).toHaveCount(3);
    await expect(groupIcon("pass-a")).toBeVisible();
    await settled(shell, app);
    // Never on a desk: its tab used last, alone, in the middle.
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await expect(shell.locator(windowSelector(b2))).toHaveCount(1);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(b2);
    await expectLiveIn(app, shell, urls[4]!, b2);
    await expect(shell.getByTestId("desk-surface")).toBeVisible();
    await capture(app, shell, "42-group-switched.png");
    // Regions: another window out, then left as it is.
    await shell.locator(rowSelector(b0)).click();
    await awayFromDock();
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell, app);
    const regionsLeft = { [b0]: await box(shell, windowSelector(b0)), [b2]: await box(shell, windowSelector(b2)) };

    // ── 3b. Back to Research: its windows come back where they were left ──────
    await groupIcon("pass-a").click();
    await awayFromDock();
    await settled(shell, app);
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
    await groupIcon("pass-b").click();
    await awayFromDock();
    await settled(shell, app);
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
    await groupIcon("pass-a").click();
    await groupIcon("pass-b").click({ force: true });
    await awayFromDock();
    await settled(shell, app);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    for (const tabId of [b0, b2]) {
      const now = await box(shell, windowSelector(tabId));
      const was = regionsLeft[tabId]!;
      expect(Math.abs(now.x - was.x)).toBeLessThan(3);
      expect(Math.abs(now.y - was.y)).toBeLessThan(3);
    }
    await expectLiveIn(app, shell, urls[2]!, b0);

    // ── 4c. In the whole sidebar (⌘S) the group's desk button passes the desk, the
    // group header's click folding it as it always does ──────────────────────
    await shell.keyboard.press("Meta+s");
    await expect(shell.locator('[data-testid="sidebar-motion-slot"]:not([data-rail])[data-desk]')).toHaveCount(1);
    await settled(shell, app);
    await groupIcon("pass-a").hover();
    await shell.locator(groupSelector("pass-a")).getByTestId("tab-group-desk").click();
    await expect.poll(stageColor).toBe("blue");
    await awayFromDock();
    await settled(shell, app);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(a1);
    await groupIcon("pass-b").hover();
    await shell.locator(groupSelector("pass-b")).getByTestId("tab-group-desk").click();
    await expect.poll(stageColor).toBe("orange");
    await awayFromDock();
    await settled(shell, app);

    // ── 5. Leave: the window in use is the pane, and the desk is gone ──────────
    await leaveDesk(shell);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(0);
    await expect(shell.getByTestId("browser-surface")).toBeVisible();
    expect((await snapshot(shell)).activeTabId).toBe(b0);
  });

});
