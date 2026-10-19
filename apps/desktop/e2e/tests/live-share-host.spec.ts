import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { chromium, expect, test, type Browser, type ElectronApplication, type Page } from "@playwright/test";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { LiveDeskReport, LiveRect, LiveShareState } from "@pistachio/shell-contracts/live-share";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { captureEnabled } from "./app";
import { launchDesk, snapshot, tabGroupCommand } from "./desk-harness";
import { knock, linkToken, poll, serveFakeGuest, startLiveControl, type GuestSite, type LiveControl } from "./live-host-harness";
import { startLiveKit, type LiveKitServer } from "./livekit-harness";
import { noticePage } from "./windows";

/**
 * Hosting a space live, for real (docs/live-share.md §6): the app signed in
 * with a signed-out Mac's anonymous account, control in process, a spawned
 * `livekit-server`, and a fake guest — a Chromium page on
 * `@pistachio/live-share/room` alone. Sharing opens the live-host window
 * exactly over the browser's and its app joins the room; nothing is
 * captured until a guest is let in; a guest knocks (control's `lv.knock`,
 * through the room) and is let in; they are sent the room as it is and see
 * the shared window's page live, at its own shape — and at its new one when
 * it is resized, on the same track; the host's pointer and theirs, their
 * ink, pings, chat and reactions cross the room both ways and show in the
 * live-host window; on a window the host allows, their click, typing and
 * scrolling land on the page (and a ⌘W of theirs closes nothing, nor does
 * a click of theirs on a link with Ctrl, ⌘ or Shift open a menu, tab or
 * window of the host's), and a drag of theirs is let go when the host takes
 * the window back; the outline of a window guests may use goes under the
 * browser's own surfaces over the desk (a notice, the Live card); a guest
 * removed and back with their token gets nothing; stopping ends the room for
 * them. Skipped without `livekit-server` on PATH.
 */

const TARGET = `<!doctype html>
<html><head><title>Live target</title><style>
  body { margin: 0; font: 16px sans-serif; }
  #tick { position: fixed; top: 4px; right: 8px; }
  #field { position: absolute; left: 40px; top: 160px; width: 300px; height: 32px; }
  #note { position: absolute; left: 40px; top: 100px; width: 300px; height: 40px; }
  #away { position: fixed; right: 8px; bottom: 8px; width: 120px; height: 24px; }
  .tall { height: 6000px; background: linear-gradient(white, skyblue); }
</style></head><body>
<div id="tick">0</div><input id="field" aria-label="field"><div id="note" contenteditable></div><a id="away" href="/away">away</a><div class="tall"></div>
<script>
  window.__downs = [];
  window.__ups = 0;
  window.__keyups = [];
  addEventListener("mousedown", (event) => window.__downs.push({ x: event.clientX, y: event.clientY }));
  addEventListener("mouseup", () => (window.__ups += 1));
  addEventListener("keyup", (event) => window.__keyups.push(event.key));
  let frame = 0;
  (function paint() { document.getElementById("tick").textContent = String(frame++); requestAnimationFrame(paint); })();
</script></body></html>`;

async function targetSite(): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(TARGET);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return server;
}

type Bridge = { pistachio: PistachioApi };

/** A message the fake guest received. */
interface Inbound {
  topic: string;
  body: Record<string, unknown>;
  from: { identity: string | null; role: string };
}

/** The fake guest page's handle (live-host-harness.ts). */
interface FakeGuest {
  join(url: string, token: string): Promise<string>;
  inbox(topic?: string): Inbound[];
  send(topic: string, body: unknown): Promise<void>;
  watch(windowId: string, width: number, height: number): void;
  /** The window's video: frames drawn, its size, the tracks it was shown from and how often it was left with none. */
  picture(): { frames: number; width: number; height: number; tracks: number; blanks: number };
  /** When it joined, and when the first window's picture came (ms since the epoch). */
  times(): { joined: number | null; window: number | null };
  ended(): string | null;
}

const liveShare = (shell: Page): Promise<LiveShareState> => shell.evaluate(() => (window as unknown as Bridge).pistachio.getLiveShare());
const command = (shell: Page, body: Parameters<PistachioApi["liveShare"]>[0]): Promise<void> => shell.evaluate((input) => (window as unknown as Bridge).pistachio.liveShare(input), body);

/** The browser's window and the live-host window, told apart by what they load. */
function windowBoxes(app: ElectronApplication): Promise<{ content: Electron.Rectangle; host: Electron.Rectangle | null; hostFocusable: boolean | null; windows: number }> {
  return app.evaluate(({ BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows();
    const host = all.find((window) => window.webContents.getURL().endsWith("#live-host")) ?? null;
    const main = all.find((window) => window !== host)!;
    return { content: main.getContentBounds(), host: host?.getBounds() ?? null, hostFocusable: host?.isFocusable() ?? null, windows: all.length };
  });
}

/** Run in the tab's page. */
function inPage<T>(app: ElectronApplication, url: string, script: string): Promise<T> {
  return app.evaluate(async ({ webContents }, { url, script }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
    if (contents === undefined) throw new Error(`no page at ${url}`);
    return (await contents.executeJavaScript(script)) as T;
  }, { url, script }) as Promise<T>;
}

/**
 * The video the live-host window captures now — its windows' captures (the
 * host's camera is off in this spec) — found on its heap through the
 * DevTools protocol, since the app keeps them to itself: live video tracks
 * with a size of their own (a peer connection's receivers, of which LiveKit
 * keeps several, have none).
 */
async function liveVideoTracks(page: Page): Promise<Array<{ label: string; width?: number; height?: number }>> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const prototype = await cdp.send("Runtime.evaluate", { expression: "MediaStreamTrack.prototype" });
    const found = await cdp.send("Runtime.queryObjects", { prototypeObjectId: prototype.result.objectId! });
    const live = await cdp.send("Runtime.callFunctionOn", {
      objectId: found.objects.objectId!,
      functionDeclaration:
        "function () { return this.filter((track) => track.kind === 'video' && track.readyState === 'live' && track.getSettings().width !== undefined).map((track) => ({ label: track.label, width: track.getSettings().width, height: track.getSettings().height })); }",
      returnByValue: true,
    });
    return live.result.value as Array<{ label: string; width?: number; height?: number }>;
  } finally {
    await cdp.detach();
  }
}

/** The tab's native view's box in the window. */
function viewBox(app: ElectronApplication, url: string): Promise<Electron.Rectangle> {
  return app.evaluate(({ webContents, BrowserWindow }, page) => {
    const main = BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().endsWith("#live-host"))!;
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === page)!;
    const child = main.contentView.children.find((candidate) => "webContents" in candidate && (candidate as Electron.WebContentsView).webContents === contents) as Electron.WebContentsView;
    return child.getBounds();
  }, url);
}

const screenshots = join(process.cwd(), "e2e/screenshots/live-share-host");

/**
 * The browser's window as the host sees it: the shell's page, every view
 * shown over it (the tabs' pages, a notice) at its box in stacking order,
 * and the live-host window's laid over all of it (two windows, and neither
 * capture holds the other; a window's capture holds none of its views),
 * composed on a canvas in `canvasPage`.
 */
async function captureHostDesk(app: ElectronApplication, canvasPage: Page, filename: string): Promise<void> {
  if (!captureEnabled) return;
  // (capturePage can hand back a frame from before the latest paint.)
  await new Promise((done) => setTimeout(done, 400));
  const shots = await app.evaluate(async ({ BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows();
    const host = all.find((window) => window.webContents.getURL().endsWith("#live-host"));
    const main = all.find((window) => window !== host)!;
    const base = (await main.capturePage()).toDataURL();
    const views: Array<{ url: string; bounds: Electron.Rectangle }> = [];
    for (const child of main.contentView.children) {
      if (!("webContents" in child) || !child.getVisible()) continue;
      const view = child as Electron.WebContentsView;
      views.push({ url: (await view.webContents.capturePage()).toDataURL(), bounds: view.getBounds() });
    }
    const over = host === undefined ? null : (await host.webContents.capturePage()).toDataURL();
    return { base, views, over };
  });
  const png = await canvasPage.evaluate(async ({ base, views, over }) => {
    const load = (src: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = src;
      });
    const under = await load(base);
    const canvas = document.createElement("canvas");
    canvas.width = under.naturalWidth;
    canvas.height = under.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(under, 0, 0);
    for (const view of views) {
      const image = await load(view.url);
      // (Captures are the device's pixels; a view's box is the window's own px.)
      const factor = image.naturalWidth / Math.max(1, view.bounds.width);
      context.drawImage(image, view.bounds.x * factor, view.bounds.y * factor, view.bounds.width * factor, view.bounds.height * factor);
    }
    if (over !== null) context.drawImage(await load(over), 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }, shots);
  await mkdir(screenshots, { recursive: true });
  await writeFile(join(screenshots, filename), Buffer.from(png, "base64"));
}

/** A box in the window, px (Playwright's). */
type Box = { x: number; y: number; width: number; height: number };

/** The notice in front, once it has come to rest: its box in the window (the notice view's box, and the card's in it). */
async function restingToast(app: ElectronApplication, notices: Page): Promise<Box> {
  const card = notices.locator('[data-testid="notice-card"][data-depth="0"][data-phase="live"]');
  await expect(card).toBeVisible();
  let last = "";
  await expect
    .poll(async () => {
      const now = JSON.stringify(await card.boundingBox());
      const still = now === last;
      last = now;
      return still;
    }, { intervals: [100] })
    .toBe(true);
  const inView = JSON.parse(last) as Box;
  const view = await app.evaluate(({ BrowserWindow }, hash) => {
    const main = BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().endsWith("#live-host"))!;
    const child = main.contentView.children.find((candidate) => "webContents" in candidate && (candidate as Electron.WebContentsView).webContents.getURL().endsWith(hash)) as Electron.WebContentsView;
    return child.getBounds();
  }, CHROME_VIEW_HASHES.notice);
  return { x: view.x + inView.x, y: view.y + inView.y, width: inView.width, height: inView.height };
}

/** How many of the live-host window's pixels in `box` (window px) it draws anything on (its capture's alpha). */
function paintedIn(app: ElectronApplication, box: Box): Promise<number> {
  return app.evaluate(async ({ BrowserWindow }, area) => {
    const host = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith("#live-host"))!;
    const x = Math.floor(area.x);
    const y = Math.floor(area.y);
    const image = await host.webContents.capturePage({ x, y, width: Math.max(1, Math.ceil(area.x + area.width) - x), height: Math.max(1, Math.ceil(area.y + area.height) - y) });
    const bitmap = image.toBitmap();
    let painted = 0;
    for (let index = 3; index < bitmap.length; index += 4) if (bitmap[index]! > 8) painted += 1;
    return painted;
  }, box);
}

test.describe.serial("live share: hosting a space in a real room", { tag: ["@share"] }, () => {
  let livekit: LiveKitServer;
  let control: LiveControl;
  let site: Server;
  let guestSite: GuestSite;
  let browser: Browser;
  let url: string;
  let app: ElectronApplication;
  let shell: Page;
  let host: Page;
  let guest: Page;
  let compositor: Page;
  let tabId: string;
  let groupId: string;
  let identity: string;
  let token: string;
  let view: Electron.Rectangle;
  let stage: { x: number; y: number; width: number; height: number };
  let desk: LiveDeskReport;

  const inbox = (topic: string): Promise<Inbound[]> => guest.evaluate((name) => (window as unknown as { guest: FakeGuest }).guest.inbox(name), topic);
  const send = (topic: string, body: unknown): Promise<void> => guest.evaluate(([name, message]) => (window as unknown as { guest: FakeGuest }).guest.send(name, message), [topic, body] as const);
  const input = (event: Record<string, unknown>): Promise<void> => send("lv.input", { w: tabId, e: event });
  const press = async (x: number, y: number): Promise<void> => {
    await input({ type: "mouseDown", x, y, button: "left", buttons: 1, clickCount: 1, modifiers: [] });
    await input({ type: "mouseUp", x, y, button: "left", buttons: 0, clickCount: 1, modifiers: [] });
  };
  const downs = (): Promise<Array<{ x: number; y: number }>> => inPage(app, url, "window.__downs");

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    livekit = await startLiveKit();
    control = await startLiveControl(livekit);
    site = await targetSite();
    url = `http://127.0.0.1:${String((site.address() as AddressInfo).port)}/`;
    guestSite = await serveFakeGuest();
    browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
    const context = await browser.newContext();
    guest = await context.newPage();
    await guest.goto(guestSite.url);
    await guest.waitForFunction(() => "guest" in window);
    compositor = await context.newPage();
    // Accounts on (a signed-out Mac's anonymous one, made by control), as hosting needs.
    ({ app, shell } = await launchDesk({
      name: "live-share-host",
      homeUrl: url,
      // (No fake camera here: Chromium's fake devices answer a tab capture with "Requested device not found".)
      args: ["--use-mock-keychain"],
      env: { PISTACHIO_E2E: "0", PISTACHIO_CONTROL_URL: control.url, PISTACHIO_ANONYMOUS: "1" },
    }));
    const tabs = await snapshot(shell);
    tabId = tabs.tabs.find((tab) => tab.url === url)!.id;
    groupId = tabs.currentGroupId!;
    expect(groupId).toBeTruthy();
    // The page is live on the desk before anything is captured or pressed.
    await expect.poll(() => inPage<number>(app, url, "window.innerWidth")).toBeGreaterThan(0);
  });

  test.afterAll(async () => {
    await app?.close();
    await browser?.close();
    await guestSite?.close();
    await new Promise((done) => site?.close(done));
    await control?.close();
    await livekit?.stop();
  });

  test("sharing opens the live-host window over the browser's, and its app joins the room", async () => {
    test.setTimeout(60_000);
    // Nobody shares yet: the room's session was never made (it is the first share's, not the launch's). Made here,
    // fromPartition says whether it is new; the share made after uses this one.
    const madeNow = await app.evaluate(({ app: electronApp, session }) => {
      let made = false;
      const heard = (): void => void (made = true);
      electronApp.on("session-created", heard);
      session.fromPartition("live-host");
      electronApp.off("session-created", heard);
      return made;
    });
    expect(madeNow).toBe(true);
    await command(shell, { type: "start", groupId, hostName: "Zach" });
    await expect.poll(async () => (await liveShare(shell)).status, { timeout: 20_000 }).toBe("live");
    await expect.poll(() => app.windows().some((page) => page.url().endsWith("#live-host"))).toBe(true);
    host = app.windows().find((page) => page.url().endsWith("#live-host"))!;
    // What the host app says of itself (a capture it could not take, a room it could not join), for a failure's story.
    host.on("console", (message) => {
      if (message.text().startsWith("[live-host]")) console.info(message.text());
    });
    await expect(host.locator("body[data-live-host='ready']")).toHaveCount(1);
    await expect.poll(async () => (await liveShare(shell)).connection, { timeout: 20_000 }).toBe("connected");
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-connection", "connected");

    const boxes = await windowBoxes(app);
    expect(boxes.host).toEqual(boxes.content);
    expect(boxes.hostFocusable).toBe(false);
    // The window reads what strangers send: its renderer is sandboxed (the shell's is not), and its preload is its own —
    // the room's members, not the shell's API.
    const sandboxed = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const metrics = electronApp.getAppMetrics();
      const of = (contents: Electron.WebContents) => metrics.find((metric) => metric.pid === contents.getOSProcessId())?.sandboxed ?? null;
      const all = BrowserWindow.getAllWindows();
      const live = all.find((window) => window.webContents.getURL().endsWith("#live-host"))!;
      return { host: of(live.webContents), shell: of(all.find((window) => window !== live)!.webContents) };
    });
    expect(sandboxed).toEqual({ host: true, shell: false });
    expect(await host.evaluate(() => Object.keys((window as unknown as { pistachio: object }).pistachio).sort())).toEqual([
      "liveHostAppearance",
      "liveHostConfig",
      "liveHostShellSource",
      "liveHostSource",
      "onLiveHostEvent",
      "sendLiveHostReport",
    ]);
    // Its WebRTC is the room's own; every page keeps the proxied-only policy.
    const policies = await app.evaluate(({ webContents }, page) => {
      const all = webContents.getAllWebContents();
      return {
        host: all.find((contents) => contents.getURL().endsWith("#live-host"))?.getWebRTCIPHandlingPolicy(),
        page: all.find((contents) => contents.getURL() === page)?.getWebRTCIPHandlingPolicy(),
      };
    }, url);
    expect(policies).toEqual({ host: "default", page: "disable_non_proxied_udp" });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().endsWith("#live-host"))!.setContentSize(1280, 820);
    });
    await expect.poll(async () => {
      const next = await windowBoxes(app);
      return next.host !== null && next.content.width === 1280 && JSON.stringify(next.host) === JSON.stringify(next.content);
    }).toBe(true);

    // The shared space's desk as the shell reports it: its one window, where its view is.
    await expect.poll(async () => (await shell.locator(".desk-stage").boundingBox())?.width ?? 0).toBeGreaterThan(0);
    const box = (await shell.locator(".desk-stage").boundingBox())!;
    stage = box;
    view = await viewBox(app, url);
    desk = {
      groupId,
      stage: { w: box.width, h: box.height },
      stageInWindow: { x: box.x, y: box.y, w: box.width, h: box.height },
      windows: [{ id: tabId, kind: "page", frame: { x: view.x - box.x, y: view.y - box.y - 30, w: view.width, h: view.height + 30 }, page: { x: view.x - box.x, y: view.y - box.y, w: view.width, h: view.height }, focused: true, minimized: false, masked: false, covered: false }],
      settled: true,
      shellCovered: false,
      covers: [],
      viewport: { w: 1280, h: 820 },
      mark: 60_000,
    };
    await shell.evaluate((body) => (window as unknown as Bridge).pistachio.setLiveDesk(body), desk);
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-present", "");
    await expect(host.getByTestId("live-host-pill")).toBeVisible();
    await expect(host.getByTestId("live-host-faces")).toBeVisible();

    // Nothing at rest animates for good (§9): not in this window, which lies over the whole browser's, nor the shell's
    // live mark — a few pulses, then still. Nor does this window blur a backdrop it does not have.
    const forever = (page: Page, within: string | null): Promise<number> =>
      page.evaluate(
        (selector) =>
          document.getAnimations().filter((animation) => {
            const target = (animation.effect as KeyframeEffect | null)?.target ?? null;
            return animation.effect?.getComputedTiming().iterations === Infinity && (selector === null || target?.closest(selector) != null);
          }).length,
        within,
      );
    expect(await forever(host, null)).toBe(0);
    expect(await host.getByTestId("live-host-pill").evaluate((pill) => getComputedStyle(pill).backdropFilter)).toBe("none");
    await expect(shell.getByTestId("live-mark")).not.toHaveCount(0);
    expect(await forever(shell, ".live-mark, .live-card-badge")).toBe(0);
  });

  test("a guest knocks through the room, is let in, and gets the room: the desk, and the window's page live at its shape", async () => {
    test.setTimeout(60_000);
    const share = await liveShare(shell);
    token = linkToken(share.link!);
    const request = await knock(control.url, token, "Ann");
    expect(request.status).toBe("pending");
    // Control's knock reaches the host through the room (the lobby is read only every 15 s).
    await expect.poll(async () => (await liveShare(shell)).knocks.map((knocked) => knocked.requestId), { timeout: 8_000 }).toContain(request.requestId);
    // Live this long with nobody in: no window is captured (a capture keeps its page rendering, for nobody).
    expect(await liveVideoTracks(host)).toEqual([]);
    await command(shell, { type: "admit", requestId: request.requestId });
    await expect.poll(async () => (await poll(control.url, token, request)).status).toBe("admitted");
    const { livekit: ticket } = await poll(control.url, token, request);
    identity = await guest.evaluate(([room, key]) => (window as unknown as { guest: FakeGuest }).guest.join(room, key), [ticket!.url, ticket!.token] as const);
    expect(identity).toBe(`g_${request.requestId}`);
    // The host's app told main who came in.
    await expect.poll(async () => (await liveShare(shell)).participants.map((participant) => participant.identity)).toEqual([identity]);
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-guests", "1");

    // Saying hello, they are sent the room: the desk with the shared window, streamed.
    await send("lv.hello", {});
    await expect.poll(async () => (await inbox("lv.sync")).length).toBeGreaterThan(0);
    const sync = (await inbox("lv.sync")).at(-1)!;
    expect(sync.from).toEqual({ identity: "host", role: "host" });
    const synced = sync.body["desk"] as { hostPresent: boolean; windows: Array<{ id: string; track: string | null }> };
    expect(synced.hostPresent).toBe(true);
    expect(synced.windows.map((window) => [window.id, window.track])).toEqual([[tabId, `win:${tabId}`]]);

    // The window's page, live, at its own shape.
    const aspect = view.width / view.height;
    await guest.evaluate(([windowId, width, height]) => (window as unknown as { guest: FakeGuest }).guest.watch(windowId, width, height), [tabId, 640, Math.round(640 / aspect)] as const);
    await expect.poll(async () => (await guest.evaluate(() => (window as unknown as { guest: FakeGuest }).guest.picture())).frames, { timeout: 20_000 }).toBeGreaterThan(20);
    const picture = await guest.evaluate(() => (window as unknown as { guest: FakeGuest }).guest.picture());
    console.info(`[live-share-host] the guest sees ${JSON.stringify(picture)} of a ${String(view.width)}×${String(view.height)} page`);
    expect(Math.abs(picture.width / picture.height - aspect)).toBeLessThan(0.02);
    // Captured from the first guest let in: one capture, and the window's picture in the room soon after they joined.
    expect(await liveVideoTracks(host)).toHaveLength(1);
    const times = await guest.evaluate(() => (window as unknown as { guest: FakeGuest }).guest.times());
    console.info(`[live-share-host] the window's picture came ${String(times.window! - times.joined!)} ms after the first guest joined`);
    expect(times.window! - times.joined!).toBeLessThan(5_000);
    if (captureEnabled) {
      await mkdir(screenshots, { recursive: true });
      await guest.screenshot({ path: join(screenshots, "00-guest-sees-the-window.png") });
    }
  });

  test("a window resized, smaller or larger, is resized in place: the guest keeps its one track, at each new shape", async () => {
    test.setTimeout(60_000);
    const picture = (): Promise<ReturnType<FakeGuest["picture"]>> => guest.evaluate(() => (window as unknown as { guest: FakeGuest }).guest.picture());
    const [shared] = desk.windows;
    const before = await picture();
    expect(before).toMatchObject({ tracks: 1, blanks: 0 });
    // Narrower; then wider and shorter; then back to the page's own size (a capture is never larger than its page).
    for (const [w, h] of [
      [Math.round(shared!.page.w * 0.6), shared!.page.h],
      [Math.round(shared!.page.w * 0.85), Math.round(shared!.page.h * 0.7)],
      [shared!.page.w, shared!.page.h],
    ] as const) {
      const resized: LiveDeskReport = { ...desk, windows: [{ ...shared!, frame: { ...shared!.frame, w, h: h + 30 }, page: { ...shared!.page, w, h } }] };
      await shell.evaluate((body) => (window as unknown as Bridge).pistachio.setLiveDesk(body), resized);
      await expect
        .poll(async () => {
          const seen = await picture();
          return seen.height > 0 && Math.abs(seen.width / seen.height - w / h) < 0.02;
        }, { timeout: 15_000, message: `the guest's picture at ${String(w)}×${String(h)}` })
        .toBe(true);
    }
    const after = await picture();
    console.info(`[live-share-host] resized twice and back: the guest saw ${String(after.frames - before.frames)} frames on ${String(after.tracks)} track(s), blank ${String(after.blanks)} time(s)`);
    // The same publication all along: never unpublished, never blank, its picture going on.
    expect(after).toMatchObject({ tracks: 1, blanks: 0 });
    expect(after.frames).toBeGreaterThan(before.frames);
    expect(await liveVideoTracks(host)).toHaveLength(1);
  });

  test("pointers and ink cross the room both ways and show in the live-host window", async () => {
    // The host's pointer, as main polls it, goes out as lv.cursor.
    await app.evaluate(({ webContents }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith("#live-host"))!;
      contents.send("pistachio:live-host-event", { type: "pointer", at: { x: 0.3, y: 0.4 } });
    });
    await expect.poll(async () => (await inbox("lv.cursor")).some((message) => message.from.identity === "host" && message.body["x"] === 0.3 && message.body["y"] === 0.4)).toBe(true);

    // The guest's pointer, over the stage where it is on theirs, with their name.
    await send("lv.cursor", { x: 0.5, y: 0.5, tool: "pointer" });
    const pointer = host.locator(`.lv-cursor[data-cursor="${identity}"]`);
    await expect(pointer).toHaveCount(1);
    await expect.poll(async () => {
      const tip = await pointer.evaluate((node) => new DOMMatrix(getComputedStyle(node).transform));
      return Math.round(Math.hypot(tip.e - (stage.x + stage.width / 2), tip.f - (stage.y + stage.height / 2)));
    }).toBeLessThanOrEqual(2);
    await expect(pointer.locator(".lv-cursor-name")).toHaveText("Ann");

    // A stroke of theirs lands on the host's board; a ping of theirs ripples.
    await send("lv.ink", { op: "begin", id: `${identity}:1`, tool: "pen", color: "#E54D2E", size: 0.004, pts: [0.3, 0.3, 0.35, 0.32] });
    await send("lv.ink", { op: "add", id: `${identity}:1`, pts: [0.4, 0.36, 0.45, 0.42, 0.5, 0.45, 0.55, 0.43] });
    await send("lv.ink", { op: "end", id: `${identity}:1` });
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-strokes", "1");
    await send("lv.ping", { x: 0.62, y: 0.5 });
    await expect(host.locator(".lv-ping")).toHaveCount(1);
    await captureHostDesk(app, compositor, "01-guest-pointer-ink-ping.png");

    // A late hello brings the stroke in the sync (asked again while unanswered: a guest is sent the room at most every
    // 2 s); the host's clear takes it off everyone's board.
    const syncs = (await inbox("lv.sync")).length;
    await expect
      .poll(async () => {
        if ((await inbox("lv.sync")).length === syncs) await send("lv.hello", {});
        return ((await inbox("lv.sync")).at(-1)?.body["strokes"] as unknown[] | undefined)?.length ?? 0;
      })
      .toBe(1);
    await command(shell, { type: "clearInk" });
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-strokes", "0");
    await expect.poll(async () => (await inbox("lv.ink")).some((message) => message.from.identity === "host" && message.body["op"] === "clear" && message.body["scope"] === "all")).toBe(true);
  });

  test("chat and reactions cross the room", async () => {
    await command(shell, { type: "chat", text: "Welcome in" });
    await expect.poll(async () => (await inbox("lv.chat")).map((message) => message.body["text"])).toContain("Welcome in");
    await send("lv.chat", { id: `${identity}:hi`, text: "Thanks!" });
    await expect.poll(async () => (await liveShare(shell)).chat.map((message) => `${message.from}: ${message.text}`)).toEqual(["host: Welcome in", `${identity}: Thanks!`]);
    await send("lv.react", { emoji: "🎉" });
    await expect(host.locator(".lv-reaction")).toHaveText("🎉");
  });

  test("in another space, the host is away: guests hear so and the desk's marks go; the faces and the pill stay", async () => {
    const lastDesk = async (): Promise<boolean | undefined> => (await inbox("lv.desk")).at(-1)?.body["hostPresent"] as boolean | undefined;
    await tabGroupCommand(shell, { type: "create", id: "elsewhere", tabIds: [], title: "Elsewhere", select: true });
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).toBe("elsewhere");
    await expect.poll(lastDesk).toBe(false);
    expect((await liveShare(shell)).hostAway).toBe(true);
    await expect(host.getByTestId("live-host")).not.toHaveAttribute("data-present", /.*/);
    await expect(host.locator(".live-host-desk")).toHaveAttribute("data-away", "");
    await expect(host.getByTestId("live-host-pill")).toBeVisible();
    await expect(host.getByTestId("live-host-faces")).toBeVisible();
    await captureHostDesk(app, compositor, "02-host-away.png");

    await tabGroupCommand(shell, { type: "select", groupId });
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).toBe(groupId);
    await shell.evaluate((body) => (window as unknown as Bridge).pistachio.setLiveDesk(body), desk);
    await expect.poll(lastDesk).toBe(true);
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-present", "");
    await expect(host.locator(".live-host-desk")).not.toHaveAttribute("data-away", /.*/);
    await tabGroupCommand(shell, { type: "ungroup", groupId: "elsewhere" });
  });

  test("the host draws over the desk with the pen, and Escape gives the desk back", async () => {
    await command(shell, { type: "setDrawing", drawing: { tool: "pen", color: "#3E63DD" } });
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-drawing", "pen");
    // The window takes the pointer (and the keyboard) while the host draws.
    await expect.poll(() => windowBoxes(app).then((boxes) => boxes.hostFocusable)).toBe(true);
    const at = (x: number, y: number): [number, number] => [stage.x + x * stage.width, stage.y + y * stage.height];
    await host.mouse.move(...at(0.2, 0.6));
    await host.mouse.down();
    for (let step = 1; step <= 12; step += 1) await host.mouse.move(...at(0.2 + step * 0.03, 0.6 + Math.sin(step / 2) * 0.05));
    await host.mouse.up();
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-strokes", "1");
    // The stroke went out as the room's protocol has it: begun, added to in batches, ended, all under one id of the host's.
    await expect.poll(async () => (await inbox("lv.ink")).filter((message) => message.from.identity === "host" && message.body["op"] !== "clear").map((message) => message.body["op"]).at(-1)).toBe("end");
    const stroke = (await inbox("lv.ink")).filter((message) => message.from.identity === "host" && message.body["op"] !== "clear");
    expect(stroke[0]?.body).toMatchObject({ op: "begin", tool: "pen", color: "#3E63DD" });
    expect(new Set(stroke.map((message) => message.body["id"]))).toEqual(new Set([stroke[0]?.body["id"]]));
    expect(String(stroke[0]?.body["id"])).toMatch(/^host:\d+$/);
    // The host's pointer goes out with the pen.
    await app.evaluate(({ webContents }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith("#live-host"))!;
      contents.send("pistachio:live-host-event", { type: "pointer", at: { x: 0.6, y: 0.6 } });
    });
    await expect.poll(async () => (await inbox("lv.cursor")).at(-1)?.body).toEqual({ x: 0.6, y: 0.6, tool: "pen" });
    await captureHostDesk(app, compositor, "03-host-drawing.png");

    await host.keyboard.press("Escape");
    await expect.poll(async () => (await liveShare(shell)).drawing).toBeNull();
    await expect(host.getByTestId("live-host")).not.toHaveAttribute("data-drawing", /.*/);
    await expect.poll(() => windowBoxes(app).then((boxes) => boxes.hostFocusable)).toBe(false);
    await command(shell, { type: "clearInk" });
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-strokes", "0");
  });

  test("on a window the host allows, a guest's click, typing and scrolling land on the page; otherwise nothing does", async () => {
    // The marks of earlier are gone (each takes itself away when its moment is over).
    await expect(host.locator(".lv-ping, .lv-reaction")).toHaveCount(0);
    // Not allowed yet: nothing reaches the page.
    await press(0.5, 0.5);
    await new Promise((done) => setTimeout(done, 500));
    expect(await downs()).toEqual([]);

    await command(shell, { type: "setControllable", windowId: tabId, allowed: true });
    await expect(host.locator(`.live-host-outline[data-window="${tabId}"]`)).toHaveCount(1);
    await expect.poll(async () => ((await inbox("lv.desk")).at(-1)?.body["windows"] as Array<{ controllable: boolean }> | undefined)?.[0]?.controllable).toBe(true);

    const size = await inPage<[number, number]>(app, url, "[innerWidth, innerHeight]");
    await press(0.25, 0.4);
    await expect.poll(downs).toHaveLength(1);
    const [click] = await downs();
    console.info(`[live-share-host] a guest's click at (0.25, 0.4) of ${JSON.stringify(size)} landed at ${JSON.stringify(click)}`);
    expect(Math.abs(click!.x - 0.25 * size[0])).toBeLessThanOrEqual(2);
    expect(Math.abs(click!.y - 0.4 * size[1])).toBeLessThanOrEqual(2);
    // They are the one using it: main says so, the room hears it, the outline wears their name.
    await expect.poll(async () => (await liveShare(shell)).using).toEqual([{ windowId: tabId, identity }]);
    await expect.poll(async () => (await inbox("lv.grant")).at(-1)?.body).toEqual({ w: tabId, user: identity });
    await expect(host.locator(`.live-host-outline[data-window="${tabId}"] .live-host-outline-label`)).toHaveText("Ann");
    await captureHostDesk(app, compositor, "04-guest-using-a-window.png");

    const middle = (id: string) => inPage<{ x: number; y: number }>(app, url, `(() => { const box = document.getElementById("${id}").getBoundingClientRect(); return { x: (box.left + box.width / 2) / innerWidth, y: (box.top + box.height / 2) / innerHeight }; })()`);
    const typeKey = async (key: string, code: string, text: string, modifiers: string[] = []): Promise<void> => {
      await input({ type: "keyDown", key, code, modifiers });
      await input({ type: "char", text, modifiers });
      await input({ type: "keyUp", key, code, modifiers });
    };
    const field = await middle("field");
    await press(field.x, field.y);
    await expect.poll(() => inPage<string>(app, url, "document.activeElement?.id ?? ''")).toBe("field");
    for (const key of "hello") await typeKey(key, `Key${key.toUpperCase()}`, key);
    await expect.poll(() => inPage<string>(app, url, `document.getElementById("field").value`)).toBe("hello");
    // Shift+Enter in a contenteditable breaks the line, where Enter alone would start a paragraph: Shift goes on its char.
    const note = await middle("note");
    await press(note.x, note.y);
    await expect.poll(() => inPage<string>(app, url, "document.activeElement?.id ?? ''")).toBe("note");
    await typeKey("a", "KeyA", "a");
    await typeKey("Enter", "Enter", "\r", ["shift"]);
    await typeKey("b", "KeyB", "b");
    await expect.poll(() => inPage<string>(app, url, `document.getElementById("note").innerHTML`)).toBe("a<br>b");

    // A guest's ⌘W is the page's alone: the app closes nothing.
    const before = (await snapshot(shell)).tabs.length;
    await input({ type: "keyDown", key: "w", code: "KeyW", modifiers: ["meta"] });
    await input({ type: "keyUp", key: "w", code: "KeyW", modifiers: ["meta"] });
    await new Promise((done) => setTimeout(done, 500));
    expect((await snapshot(shell)).tabs.length).toBe(before);

    await input({ type: "wheel", x: 0.5, y: 0.6, dx: 0, dy: 400, modifiers: [] });
    await expect.poll(() => inPage<number>(app, url, "scrollY")).toBeGreaterThan(100);

    // Under desk zoom (the page laid out at twice its view, drawn at half), a press lands where the guest saw it.
    const zoomedView = await app.evaluate(({ webContents, BrowserWindow }, page) => {
      const main = BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().endsWith("#live-host"))!;
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === page)!;
      const child = main.contentView.children.find((candidate) => "webContents" in candidate && (candidate as Electron.WebContentsView).webContents === contents) as Electron.WebContentsView;
      const { width, height } = child.getBounds();
      contents.enableDeviceEmulation({ screenPosition: "desktop", screenSize: { width: 0, height: 0 }, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0, viewSize: { width: width / 0.5, height: height / 0.5 }, scale: 0.5 });
      return { width, height };
    }, url);
    await expect.poll(() => inPage<number>(app, url, "innerWidth")).toBe(zoomedView.width * 2);
    const zoomed = await inPage<[number, number]>(app, url, "[innerWidth, innerHeight]");
    const pressed = (await downs()).length;
    await press(0.75, 0.5);
    await expect.poll(async () => (await downs()).length).toBe(pressed + 1);
    const zoomedClick = (await downs()).at(-1)!;
    expect(Math.abs(zoomedClick.x - 0.75 * zoomed[0])).toBeLessThanOrEqual(3);
    expect(Math.abs(zoomedClick.y - 0.5 * zoomed[1])).toBeLessThanOrEqual(3);
    await app.evaluate(({ webContents }, page) => webContents.getAllWebContents().find((candidate) => candidate.getURL() === page)!.disableDeviceEmulation(), url);

    // A guest's click on a link with ⌘, Shift or Ctrl held: Chromium would make it a tab, a window, the host's context
    // menu — asked of main only after the click is sent, past telling whose it was. None opens, and the page stays.
    await app.evaluate(({ webContents }, page) => {
      const counted = globalThis as { __pageMenus?: number };
      counted.__pageMenus = 0;
      webContents.getAllWebContents().find((candidate) => candidate.getURL() === page)!.on("context-menu", () => (counted.__pageMenus! += 1));
    }, url);
    const opened = async (): Promise<{ tabs: number; windows: number; menus: number }> => ({
      tabs: (await snapshot(shell)).tabs.length,
      windows: (await windowBoxes(app)).windows,
      menus: await app.evaluate(() => (globalThis as { __pageMenus?: number }).__pageMenus ?? 0),
    });
    const unopened = await opened();
    const link = await inPage<{ x: number; y: number }>(app, url, `(() => { const box = document.getElementById("away").getBoundingClientRect(); return { x: (box.left + box.width / 2) / innerWidth, y: (box.top + box.height / 2) / innerHeight }; })()`);
    const linkDowns = (await downs()).length;
    for (const modifiers of [["meta"], ["shift"], ["control"]]) {
      await input({ type: "mouseDown", ...link, button: "left", buttons: 1, clickCount: 1, modifiers });
      await input({ type: "mouseUp", ...link, button: "left", buttons: 0, clickCount: 1, modifiers });
    }
    // A plain click after them, mid-page, lands once they have all been through: anything they asked for is asked by
    // then. It alone reached the page.
    await press(0.5, 0.5);
    const landed = async (): Promise<string[]> => (await downs()).slice(linkDowns).map(({ y }) => (y > size[1] * 0.75 ? "link" : "mid-page"));
    await expect.poll(async () => (await landed()).includes("mid-page")).toBe(true);
    expect(await opened()).toEqual(unopened);
    expect(await landed()).toEqual(["mid-page"]);
    expect(await inPage<string>(app, url, "location.pathname")).toBe("/");

    // A drag and a key under way as the host takes the window back: the page is let go of both, not left holding them.
    const ups = (): Promise<number> => inPage(app, url, "window.__ups");
    const upsBefore = await ups();
    const downsBefore = (await downs()).length;
    await input({ type: "mouseDown", x: 0.5, y: 0.5, button: "left", buttons: 1, clickCount: 1, modifiers: [] });
    await input({ type: "mouseMove", x: 0.55, y: 0.5, button: "left", buttons: 1, clickCount: 0, modifiers: [] });
    await input({ type: "keyDown", key: "Shift", code: "ShiftLeft", modifiers: ["shift"] });
    await expect.poll(async () => (await downs()).length).toBe(downsBefore + 1);
    expect(await ups()).toBe(upsBefore);

    // Not allowed any more: the window is the host's alone again.
    await command(shell, { type: "setControllable", windowId: tabId, allowed: false });
    await expect.poll(ups).toBe(upsBefore + 1);
    await expect.poll(() => inPage<string[]>(app, url, "window.__keyups")).toContain("Shift");
    await expect.poll(async () => (await liveShare(shell)).using).toEqual([]);
    await expect(host.locator(".live-host-outline")).toHaveCount(0);
    const count = (await downs()).length;
    await press(0.5, 0.5);
    await new Promise((done) => setTimeout(done, 500));
    expect(await downs()).toHaveLength(count);
    // (The guest's own release of the drag, refused with the rest, was the page's already.)
    expect(await ups()).toBe(upsBefore + 1);

    // They ask for it, and the host says no on the card: the host's app tells them (and only them) so.
    await send("lv.ask", { w: tabId });
    await expect.poll(async () => (await liveShare(shell)).asks.map((ask) => ask.windowId)).toEqual([tabId]);
    await command(shell, { type: "answerAsk", identity, windowId: tabId, allow: false });
    await expect.poll(async () => (await inbox("lv.refused")).map((message) => ({ from: message.from.identity, body: message.body }))).toEqual([{ from: "host", body: { w: tabId } }]);
  });

  test("the browser's own surfaces lie over a window's outline: a notice, the Live card", async () => {
    test.setTimeout(60_000);
    await command(shell, { type: "setControllable", windowId: tabId, allowed: true });
    const outline = host.locator(`.live-host-outline[data-window="${tabId}"]`);
    await expect(outline).toHaveCount(1);
    // What the window's marks are cut by (window px), as the live-host app has it: nothing (null), or everything.
    const marks = host.getByTestId("live-host-marks");
    const cut = async (): Promise<LiveRect[] | "all" | null> => {
      const value = await marks.getAttribute("data-cut");
      return value === null || value === "all" ? value : (JSON.parse(value) as LiveRect[]);
    };
    const cutHolds = async (box: Box): Promise<boolean> => {
      const rects = await cut();
      return Array.isArray(rects) && rects.some((over) => over.x <= box.x && over.y <= box.y && over.x + over.w >= box.x + box.width && over.y + over.h >= box.y + box.height);
    };

    // A notice at the foot of the browser surface, as the shell says one — once the shell's own have run out (the
    // chat's, 8 s): the shell says its list again only as that changes.
    const notices = await noticePage(app);
    await expect(notices.getByTestId("notice-card")).toHaveCount(0, { timeout: 15_000 });
    const say = (items: unknown[]): Promise<void> =>
      shell.evaluate((list) => {
        const surface = document.querySelector(".browser-surface")!.getBoundingClientRect();
        (window as unknown as Bridge).pistachio.setNotices({ items: list as never, position: "bottom", anchor: { x: surface.left, y: surface.top, width: surface.width, height: surface.height } });
      }, items);
    await say([{ id: 9_001, message: "Ana left", tone: "neutral", actionLabel: null, bumps: 0 }]);
    const toast = await restingToast(app, notices);
    // The window drawn across it: its foot runs through the toast's middle, and on past its left end.
    const [shared] = desk.windows;
    const frame = { x: toast.x - stage.x - 160, y: 60, w: 160 + toast.width / 2, h: toast.y + toast.height / 2 - stage.y - 60 };
    const across: LiveDeskReport = { ...desk, windows: [{ ...shared!, frame, page: { x: frame.x, y: frame.y + 30, w: frame.w, h: frame.h - 30 } }], covers: [], mark: 60_001 };
    await shell.evaluate((body) => (window as unknown as Bridge).pistachio.setLiveDesk(body), across);
    await expect.poll(async () => Math.round((await outline.boundingBox())?.y ?? 0)).toBe(Math.round(stage.y + frame.y));
    // Under the toast the outline is not drawn; beside it, it is.
    await expect.poll(() => paintedIn(app, toast), { message: "the outline is drawn over the toast" }).toBe(0);
    expect(await paintedIn(app, { x: toast.x - 140, y: toast.y + toast.height / 2 - 4, width: 120, height: 8 })).toBeGreaterThan(0);
    expect(await cutHolds(toast)).toBe(true);
    await captureHostDesk(app, compositor, "05-a-notice-over-the-outline.png");
    // The toast gone (its exit played), the outline is whole again.
    await say([]);
    await expect(notices.getByTestId("notice-card")).toHaveCount(0);
    await expect.poll(cut).toBeNull();
    await expect.poll(() => paintedIn(app, toast)).toBeGreaterThan(0);

    // The Live card, opened from the pill: the outline goes under the card's column (its top glides, unmeasured).
    await host.evaluate(() => (window as unknown as { pistachio: { sendLiveHostReport(report: unknown): void } }).pistachio.sendLiveHostReport({ type: "openCard" }));
    const liveCard = shell.getByTestId("live-card");
    await expect(liveCard).toHaveAttribute("data-shown", "");
    const card = (await liveCard.boundingBox())!;
    await expect.poll(() => cutHolds(card)).toBe(true);
    // (The desk reported again as the card came up: the outline is round the window as it stands, filling the desk.)
    const standing = (await outline.boundingBox())!;
    const column = { x: stage.x - 6, y: stage.y - 6, width: card.x + card.width + 12 - stage.x, height: stage.height + 12 };
    await expect.poll(() => paintedIn(app, column), { message: "the outline is drawn in the Live card's column" }).toBe(0);
    expect(await paintedIn(app, { x: card.x + card.width + 24, y: standing.y + standing.height - 4, width: 120, height: 8 })).toBeGreaterThan(0);
    await captureHostDesk(app, compositor, "06-the-live-card-over-the-outline.png");
    await shell.keyboard.press("Escape");
    await expect(liveCard).toHaveCount(0);
    await expect.poll(() => paintedIn(app, column)).toBeGreaterThan(0);

    await command(shell, { type: "setControllable", windowId: tabId, allowed: false });
    await expect(outline).toHaveCount(0);
  });

  test("with anyone let in, a second guest comes straight in, and the host removes them from their face", async () => {
    await command(shell, { type: "setAdmission", admission: "open" });
    await expect.poll(async () => (await liveShare(shell)).admission).toBe("open");
    const request = await knock(control.url, token, "Bo");
    expect(request.status).toBe("admitted");
    const second = await guest.context().newPage();
    await second.goto(guestSite.url);
    await second.waitForFunction(() => "guest" in window);
    const bo = await second.evaluate(([room, key]) => (window as unknown as { guest: FakeGuest }).guest.join(room, key), [request.livekit!.url, request.livekit!.token] as const);
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-guests", "2");
    const face = host.locator(`.lv-face[data-face="${bo}"]`);
    await face.hover();
    await face.getByRole("button", { name: "Remove Bo" }).click();
    await expect.poll(() => second.evaluate(() => (window as unknown as { guest: FakeGuest }).guest.ended()), { timeout: 15_000 }).toBe("removed");
    await expect.poll(async () => (await liveShare(shell)).participants.map((participant) => participant.identity)).toEqual([identity]);
    await expect(face).toHaveCount(0);
    await second.close();

    // LiveKit does not revoke a removed guest's token: their client comes back with it, and is shown out again at once.
    const again = await guest.context().newPage();
    await again.goto(guestSite.url);
    await again.waitForFunction(() => "guest" in window);
    // Back this soon, they may never have left to the room's clients (LiveKit says a participant has gone a moment
    // after removing them): the identity keeps its place, only its sid says it is someone new — to the host's room only
    // as LiveKit makes them active, about two seconds in; the host app tells main then, and main shows them out. (Back
    // later, LiveKit announces them about as late.) Ann, told by the host that she alone is let in, is with nobody but
    // the host meanwhile: her word goes to the host alone, and she never shows them.
    await guest.evaluate((who) => {
      type Seen = FakeGuest & { participants(): Array<{ identity: string }> };
      const fake = (window as unknown as { guest: Seen }).guest;
      const state = { saw: false, timer: 0 as unknown as ReturnType<typeof setInterval> };
      let n = 0;
      state.timer = setInterval(() => {
        state.saw ||= fake.participants().some((person) => person.identity === who);
        void fake.send("lv.chat", { id: `ann-back-${String((n += 1))}`, text: "for the room alone" });
      }, 200);
      (window as unknown as { annWatch: typeof state }).annWatch = state;
    }, bo);
    // The host's pointer moving all the while, for the room to send to whoever it sends to.
    await app.evaluate(({ webContents }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith("#live-host"))!;
      let step = 0;
      (globalThis as { __hostPointer?: ReturnType<typeof setInterval> }).__hostPointer = setInterval(() => {
        step += 1;
        contents.send("pistachio:live-host-event", { type: "pointer", at: { x: 0.2 + (step % 40) / 100, y: 0.5 } });
      }, 20);
    });
    const annCursors = (await inbox("lv.cursor")).length;
    const out = await again.evaluate(async ([room, key, windowId, ann]) => {
      const fake = (window as unknown as { guest: FakeGuest }).guest;
      await fake.join(room, key);
      const joined = Date.now();
      // As a guest would: show the shared window, and ask for the room.
      fake.watch(windowId, 320, 200);
      await fake.send("lv.hello", {});
      while (fake.ended() === null && Date.now() - joined < 10_000) await new Promise((done) => setTimeout(done, 5));
      const from = (who: string) => fake.inbox().filter((message) => message.from.identity === who).map((message) => message.topic);
      return { ended: fake.ended(), joined, at: Date.now(), picture: fake.picture(), fromHost: from("host"), fromAnn: from(ann) };
    }, [request.livekit!.url, request.livekit!.token, tabId, identity] as const);
    await app.evaluate(() => clearInterval((globalThis as { __hostPointer?: ReturnType<typeof setInterval> }).__hostPointer));
    const ann = await guest.evaluate(() => {
      const state = (window as unknown as { annWatch: { saw: boolean; timer: ReturnType<typeof setInterval> } }).annWatch;
      clearInterval(state.timer);
      return { saw: state.saw };
    });
    console.info(
      `[live-share-host] a removed guest back in the room was shown out again ${String(out.at - out.joined)} ms after they joined; meanwhile they drew ${String(out.picture.frames)} frames of the window, heard ${JSON.stringify(out.fromHost)} from the host and ${JSON.stringify(out.fromAnn)} from Ann`,
    );
    expect(out.ended).toBe("removed");
    expect(out.at - out.joined).toBeLessThan(5_000);
    // Never one of the share's guests meanwhile: no window's picture (they could not subscribe), and nothing the host
    // sends — no sync for their hello, no desk, no pointer — while Ann, let in, heard the pointer all along. Nor
    // anything of Ann's, who kept talking to the room, and never showed them.
    expect(out.picture).toMatchObject({ frames: 0, tracks: 0 });
    expect(out.fromHost).toEqual([]);
    expect(out.fromAnn).toEqual([]);
    expect(ann.saw).toBe(false);
    expect((await inbox("lv.cursor")).length).toBeGreaterThan(annCursors);
    await expect.poll(async () => (await liveShare(shell)).chat.some((message) => message.text === "for the room alone")).toBe(true);
    expect((await liveShare(shell)).participants.map((participant) => participant.identity)).toEqual([identity]);
    await again.close();
  });

  test("the pill's stop ends the room for the guest and takes the live-host window down", async () => {
    await host.getByRole("button", { name: "Stop sharing" }).click();
    await expect.poll(async () => (await liveShare(shell)).status).toBe("idle");
    expect((await liveShare(shell)).ended).toBe("stopped");
    await expect.poll(() => guest.evaluate(() => (window as unknown as { guest: FakeGuest }).guest.ended()), { timeout: 15_000 }).toBe("ended");
    const info = (await (await fetch(`${control.url}/v1/live/join/${token}`)).json()) as { status: string };
    expect(info.status).toBe("ended");
    await expect.poll(async () => (await windowBoxes(app)).windows).toBe(1);
  });
});
