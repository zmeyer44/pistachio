/**
 * The desk's now playing (docs/desk.md, "Now playing"): a window playing
 * something has a Pop out button on its frame; pressed, the window goes into
 * its row and its media plays on — on the rail, a video as a floating player
 * (the page's own picture, main's media preview, with the "pip" view's
 * controls over it) and audio as a button in the rail that moves with how
 * loud it is, a card of the stack's controls beside it on hover; in the
 * whole sidebar, the media stack's card. Screenshots (PISTACHIO_E2E_CAPTURE=1)
 * in e2e/screenshots/desk-now-playing/, composited with the live pages and
 * the pip view.
 */

import { createServer, type Server } from "node:http";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import { deskPipSlot } from "@pistachio/shell-contracts/desk";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { BrowserMediaInfo } from "@pistachio/shell-contracts/media";
import { demoPortalHtml, demoToneWav } from "../../src/main/demo-page";
import { box, createGroup, createTab, launchDesk, openMore, openTabs, screenshots, selectSpace, selectTab, settled, snapshot, type Box } from "./desk-harness";

let server: Server;
let ORIGIN: string;
// Served over loopback with byte ranges, so the real player seeks and its sound can be captured (same origin).
test.beforeAll(async () => {
  const wav = Buffer.from(demoToneWav());
  server = createServer((request, response) => {
    if (request.url === "/test.wav") {
      const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? "");
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(Number(match[2]), wav.length - 1) : wav.length - 1;
      response.writeHead(match ? 206 : 200, {
        "content-type": "audio/wav",
        "accept-ranges": "bytes",
        "content-length": end - start + 1,
        ...(match ? { "content-range": `bytes ${String(start)}-${String(end)}/${String(wav.length)}` } : {}),
      });
      response.end(wav.subarray(start, end + 1));
    } else {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(demoPortalHtml());
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The media fixture did not start");
  ORIGIN = `http://127.0.0.1:${String(address.port)}`;
});
test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

/** The window as a person sees it, the pip view (the floating player's controls) with the pages. */
const capture = screenshots("desk-now-playing", ["pip"]);

const call = <T>(shell: Page, run: (pistachio: PistachioApi) => Promise<T>): Promise<T> => shell.evaluate(`(${run.toString()})(window.pistachio)`) as Promise<T>;
const mediaOf = async (shell: Page, tabId: string): Promise<BrowserMediaInfo | null> =>
  (await call(shell, (pistachio) => pistachio.getMedia())).find((item) => item.tabId === tabId) ?? null;

/** Force-close capture fixtures if Electron does not finish quitting. */
async function closeApp(app: ElectronApplication): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const killAfter = new Promise<void>((done) => {
    timer = setTimeout(() => {
      app.process().kill("SIGKILL");
      done();
    }, 10_000);
  });
  await Promise.race([app.close(), killAfter]);
  if (timer !== undefined) clearTimeout(timer);
}

async function pageAt(app: ElectronApplication, url: string): Promise<Page> {
  await expect.poll(() => app.windows().some((page) => page.url() === url)).toBe(true);
  return app.windows().find((candidate) => candidate.url() === url)!;
}

/** The pip view's page (the floating player's face). */
async function pipPage(app: ElectronApplication): Promise<Page> {
  await expect.poll(() => app.windows().some((page) => page.url().endsWith(CHROME_VIEW_HASHES.pip))).toBe(true);
  return app.windows().find((candidate) => candidate.url().endsWith(CHROME_VIEW_HASHES.pip))!;
}

/** Every shown view of the window: its page's URL, its box. */
function shownViews(app: ElectronApplication): Promise<Array<{ url: string; bounds: Box }>> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    return window.contentView.children.flatMap((child) => {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return [];
      const view = child as WebContentsView;
      return [{ url: view.webContents.getURL(), bounds: view.getBounds() }];
    });
  });
}

const viewAt = async (app: ElectronApplication, ending: string): Promise<Box | null> => (await shownViews(app)).find((view) => view.url.endsWith(ending))?.bounds ?? null;

function near(a: Box | null, b: Box, within = 2): boolean {
  return a !== null && (["x", "y", "width", "height"] as const).every((key) => Math.abs(a[key] - b[key]) <= within);
}

/** A real, continuously painted video, without a network fixture. */
async function installVideoPlayer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d")!;
    let frame = 0;
    const paint = (): void => {
      frame += 1;
      context.fillStyle = `hsl(${String(frame % 360)} 54% 24%)`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#f4f1e8";
      context.font = "600 28px sans-serif";
      context.fillText("Continuum", 82, 100);
      requestAnimationFrame(paint);
    };
    paint();
    const video = document.createElement("video");
    video.id = "test-video";
    video.playsInline = true;
    video.style.width = "320px";
    video.style.height = "180px";
    video.srcObject = canvas.captureStream(12);
    const button = document.createElement("button");
    button.id = "start-video";
    button.textContent = "Start video";
    button.addEventListener("click", () => void video.play());
    document.body.prepend(button, video, canvas);
    navigator.mediaSession.metadata = new MediaMetadata({ title: "Continuum", artist: "Pistachio Pictures" });
  });
}

/** The offline tone, looping. */
async function installAudioPlayer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const audio = document.createElement("audio");
    audio.id = "test-audio";
    audio.loop = true;
    audio.src = new URL("/test.wav", location.href).href;
    const button = document.createElement("button");
    button.id = "start-audio";
    button.textContent = "Start audio";
    button.addEventListener("click", () => void audio.play());
    document.body.prepend(button, audio);
    navigator.mediaSession.metadata = new MediaMetadata({ title: "Loop Theory", artist: "Pistachio Radio" });
  });
}

test("a window playing something pops out: on the rail, a video floats over the desk with its controls on it, audio is a button in the rail moving with its sound; the whole sidebar takes them as cards", { tag: ["@desk", "@media"] }, async () => {
  test.setTimeout(120_000);
  const VIDEO_URL = `${ORIGIN}/invoices?video`;
  const AUDIO_URL = `${ORIGIN}/invoices?audio`;
  const { app, shell } = await launchDesk({ name: "now-playing", homeUrl: VIDEO_URL });
  try {
    const [video, audio] = (await openTabs(shell, [VIDEO_URL, AUDIO_URL])) as [string, string];
    await createGroup(shell, "media", [video, audio], "Media", "purple");
    // Both playing, each started in its page while it is the one in view.
    const choose = async (tabId: string): Promise<void> => {
      await selectTab(shell, tabId);
      await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(tabId);
    };
    await choose(video);
    const videoPage = await pageAt(app, VIDEO_URL);
    await installVideoPlayer(videoPage);
    await videoPage.locator("#start-video").click();
    await expect.poll(() => videoPage.locator("#test-video").evaluate((element) => (element as HTMLVideoElement).paused)).toBe(false);
    await expect.poll(async () => (await mediaOf(shell, video))?.playing ?? false).toBe(true);
    await choose(audio);
    const audioPage = await pageAt(app, AUDIO_URL);
    await installAudioPlayer(audioPage);
    await audioPage.locator("#start-audio").click();
    await expect.poll(async () => (await mediaOf(shell, audio))?.playing ?? false).toBe(true);

    // The group's desk, both windows out.
    await selectSpace(shell, "media");
    await expect(shell.locator('[data-testid="sidebar-motion-slot"][data-rail]')).toHaveCount(1);
    await expect(shell.locator('.desk-stage[data-phase="open"]')).toHaveCount(1);
    const windowOf = (tabId: string) => shell.locator(`[data-testid="desk-window"][data-tab-id="${tabId}"]`);
    const rowOf = (tabId: string) => shell.locator(`[data-testid="sidebar-tab-list"] [role="tab"][data-tab-id="${tabId}"]`);
    if ((await windowOf(audio).count()) === 0) await rowOf(audio).click();
    if ((await windowOf(video).count()) === 0) await rowOf(video).click();
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell, app);

    // ── 1. Each window playing something has Pop out on its frame ───────────
    await expect(windowOf(video).getByTestId("desk-pop-out")).toHaveAttribute("aria-label", "Pop out the video");
    await expect(windowOf(audio).getByTestId("desk-pop-out")).toHaveAttribute("aria-label", "Pop out the audio");
    await capture(app, shell, "01-pop-out-buttons.png");

    // ── 2. The video popped out: its window goes, and it floats over the desk, its page's own picture ─
    await windowOf(video).getByTestId("desk-pop-out").click();
    await expect(windowOf(video)).toHaveCount(0);
    const pip = shell.getByTestId("desk-pip");
    await expect(pip).toHaveCount(1);
    const pipBox = await box(shell, '[data-testid="desk-pip"]');
    expect(pipBox.width).toBe(320);
    expect(pipBox.height).toBe(180);
    await expect.poll(() => viewAt(app, "?video").then((bounds) => near(bounds, pipBox))).toBe(true);
    // (Its view stands out from the picture all round, the ring its edges are on.)
    await expect.poll(() => viewAt(app, CHROME_VIEW_HASHES.pip).then((bounds) => near(bounds, deskPipSlot(pipBox)))).toBe(true);
    await expect.poll(async () => (await mediaOf(shell, video))?.playing ?? false).toBe(true);
    await capture(app, shell, "02-video-floating.png", 600);
    // Settings over the window: the picture comes down, and nothing of the player lies over Settings.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("pistachio:shell-command", { type: "runShortcut", id: "openSettings" }));
    await expect(shell.getByTestId("settings-page")).toBeVisible();
    await expect(pip).toHaveAttribute("data-covered", "raised");
    expect(await pip.evaluate((el) => getComputedStyle(el).visibility)).toBe("hidden");
    await expect.poll(() => viewAt(app, CHROME_VIEW_HASHES.pip)).toBe(null);
    await shell.getByRole("button", { name: "Close settings" }).click();
    await expect(shell.getByTestId("settings-page")).toHaveCount(0);
    await expect(pip).not.toHaveAttribute("data-covered");
    await expect.poll(() => viewAt(app, "?video").then((bounds) => near(bounds, pipBox))).toBe(true);
    // The screenshot selector (⌘⇧2) likewise: nothing of the player lies over the area being chosen.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("pistachio:shell-command", { type: "runShortcut", id: "screenshotArea" }));
    await expect(shell.locator("[data-testid='screenshot-overlay'][data-ready]")).toHaveCount(1);
    await expect(pip).toHaveAttribute("data-covered", "raised");
    await expect.poll(() => viewAt(app, CHROME_VIEW_HASHES.pip)).toBe(null);
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("screenshot-overlay")).toHaveCount(0);
    await expect(pip).not.toHaveAttribute("data-covered");
    await expect.poll(() => viewAt(app, "?video").then((bounds) => near(bounds, pipBox))).toBe(true);

    // ── 3. Its controls are the pip view's, over the picture while the pointer is on it ─
    const face = await pipPage(app);
    const faceView = face.getByTestId("desk-pip-view");
    await expect(faceView).not.toHaveAttribute("data-shown", "");
    await faceView.hover();
    await expect(faceView).toHaveAttribute("data-shown", "");
    await capture(app, shell, "03-video-controls.png");
    await face.getByTestId("desk-pip-play").click();
    await expect.poll(async () => (await mediaOf(shell, video))?.playing ?? true).toBe(false);
    // Paused, the controls stay up: the play button is what it wants.
    await face.mouse.move(2, 2);
    await face.getByTestId("desk-pip-play").click();
    await expect.poll(async () => (await mediaOf(shell, video))?.playing ?? false).toBe(true);

    // ── 3b. Its own volume: the slider beside the speaker, out while the pointer is on it, sets the page's player
    //        alone; all the way down it is silent, and Unmute brings it back where it was ─
    const elementVolume = (): Promise<number> => videoPage.locator("#test-video").evaluate((element) => (element as HTMLVideoElement).volume);
    const slider = face.getByTestId("desk-pip-volume");
    await faceView.hover();
    await face.getByTestId("desk-pip-mute").hover();
    await expect.poll(() => slider.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(40);
    await capture(app, shell, "03a-video-volume.png");
    await slider.fill("0.4");
    await expect.poll(elementVolume).toBeCloseTo(0.4, 2);
    await expect.poll(async () => (await mediaOf(shell, video))?.volume ?? 1).toBeCloseTo(0.4, 2);
    await slider.blur();
    await slider.fill("0");
    await expect.poll(elementVolume).toBe(0);
    await expect.poll(async () => (await mediaOf(shell, video))?.muted ?? false).toBe(true);
    await face.getByTestId("desk-pip-mute").click();
    await expect.poll(elementVolume).toBeCloseTo(0.4, 2);
    await expect.poll(async () => (await mediaOf(shell, video))?.muted ?? true).toBe(false);
    await face.mouse.move(2, 2);

    // ── 4. Moved: a press on the picture, held and dragged, and it stays where it is let go ─
    // The OS gives a press's moves and release to the view it began on, whatever is raised over it since: they go
    // to the pip view, as the real pointer's would, at window points (the view moving under them as it follows).
    const pipMouse = (type: "mouseDown" | "mouseMove" | "mouseUp", at: { x: number; y: number }): Promise<void> =>
      app.evaluate(
        ({ BrowserWindow }, { type, at, hash }) => {
          const view = BrowserWindow.getAllWindows()[0]!.contentView.children.find(
            (child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith(hash),
          ) as WebContentsView;
          const bounds = view.getBounds();
          view.webContents.sendInputEvent({
            type,
            x: at.x - bounds.x,
            y: at.y - bounds.y,
            globalX: at.x + 1000,
            globalY: at.y + 1000,
            button: "left",
            clickCount: 1,
            modifiers: type === "mouseMove" ? ["leftbuttondown"] : [],
          });
        },
        { type, at, hash: CHROME_VIEW_HASHES.pip },
      );
    const dragLayerUp = async (): Promise<boolean> => (await viewAt(app, CHROME_VIEW_HASHES.drag)) !== null;
    // Between the controls at its head and its middle.
    const from = { x: pipBox.x + 160, y: pipBox.y + 55 };
    await pipMouse("mouseDown", from);
    await expect.poll(dragLayerUp).toBe(true);
    for (let step = 1; step <= 5; step += 1) await pipMouse("mouseMove", { x: from.x + step * 60, y: from.y - step * 50 });
    // (The last again until it lands: a real cursor resting over the window, where the harness could not move it
    // from, is relayed once by the drag layer as it comes up under it.)
    await expect
      .poll(async () => {
        await pipMouse("mouseMove", { x: from.x + 360, y: from.y - 300 });
        return (await box(shell, '[data-testid="desk-pip"]')).x;
      })
      .toBeCloseTo(pipBox.x + 360, -1);
    // Held, the drag layer keeps the rest of the window, over the player's pip view as it follows.
    const topView = (): Promise<string> =>
      app.evaluate(({ BrowserWindow }) => {
        const children = BrowserWindow.getAllWindows()[0]!.contentView.children;
        const top = children[children.length - 1] as WebContentsView;
        return top.webContents.getURL();
      });
    await expect.poll(async () => (await topView()).endsWith(CHROME_VIEW_HASHES.drag)).toBe(true);
    await pipMouse("mouseUp", { x: from.x + 360, y: from.y - 300 });
    // Let go, the move is over: no second click wanted to put it down.
    await expect.poll(dragLayerUp).toBe(false);
    const moved = await box(shell, '[data-testid="desk-pip"]');
    expect(Math.abs(moved.x - (pipBox.x + 360))).toBeLessThan(2);
    expect(Math.abs(moved.y - (pipBox.y - 300))).toBeLessThan(2);
    await expect.poll(() => viewAt(app, "?video").then((bounds) => near(bounds, moved))).toBe(true);
    expect(await shell.evaluate(() => localStorage.getItem("pistachio.desk.pip.v1"))).not.toBe(null);
    // A click on the picture moves nothing, and leaves nothing holding the pointer (once its face has
    // heard the release, its word of the press has gone ahead of it to main, and on to the shell).
    await face.evaluate(() => {
      (window as { pipReleased?: Promise<void> }).pipReleased = new Promise((done) => window.addEventListener("pointerup", () => done(), { once: true }));
    });
    await pipMouse("mouseDown", { x: moved.x + 160, y: moved.y + 55 });
    await pipMouse("mouseUp", { x: moved.x + 160, y: moved.y + 55 });
    await face.evaluate(() => (window as { pipReleased?: Promise<void> }).pipReleased);
    await shell.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
    await expect.poll(dragLayerUp).toBe(false);
    expect(near(await box(shell, '[data-testid="desk-pip"]'), moved)).toBe(true);

    // ── 4b. Resized: a corner held and dragged, its shape kept; an edge, no smaller than its controls want ─
    const pipNow = (): Promise<Box> => box(shell, '[data-testid="desk-pip"]');
    // Each drag's last move again until it lands, as above.
    const resize = async (at: { x: number; y: number }, to: { x: number; y: number }, width: number): Promise<Box> => {
      await pipMouse("mouseDown", at);
      await expect.poll(dragLayerUp).toBe(true);
      await expect
        .poll(async () => {
          await pipMouse("mouseMove", to);
          return (await pipNow()).width;
        })
        .toBe(width);
      await pipMouse("mouseUp", to);
      await expect.poll(dragLayerUp).toBe(false);
      return pipNow();
    };
    // On the ring just outside the picture's corner: the opposite corner holds still.
    const corner = { x: moved.x + moved.width + 2, y: moved.y + moved.height + 2 };
    const grown = await resize(corner, { x: corner.x + 160, y: corner.y + 40 }, 480);
    expect(near(grown, { x: moved.x, y: moved.y, width: 480, height: 270 })).toBe(true);
    await expect.poll(() => viewAt(app, "?video").then((bounds) => near(bounds, grown))).toBe(true);
    await expect.poll(() => viewAt(app, CHROME_VIEW_HASHES.pip).then((bounds) => near(bounds, deskPipSlot(grown)))).toBe(true);
    expect(JSON.parse((await shell.evaluate(() => localStorage.getItem("pistachio.desk.pip.v1"))) ?? "null")).toMatchObject({ width: 480 });
    await capture(app, shell, "03b-video-resized.png");
    // The left edge pulled far in: its right edge holds still, and it stops at its smallest.
    const west = { x: grown.x - 3, y: grown.y + grown.height / 2 };
    const shrunk = await resize(west, { x: west.x + 400, y: west.y }, 240);
    expect(near(shrunk, { x: grown.x + grown.width - 240, y: grown.y, width: 240, height: 135 })).toBe(true);
    await expect.poll(() => viewAt(app, "?video").then((bounds) => near(bounds, shrunk))).toBe(true);

    // ── 5. The audio popped out: a button in the rail, moving with how loud the page measures it ─
    await windowOf(audio).getByTestId("desk-pop-out").click();
    await expect(windowOf(audio)).toHaveCount(0);
    const railButton = shell.getByTestId(`rail-media-${audio}`);
    await expect(railButton).toBeVisible();
    await expect(railButton).toHaveAttribute("data-playing", "true");
    await expect.poll(async () => Number((await railButton.getAttribute("data-level")) ?? "0")).toBeGreaterThan(0);
    await capture(app, shell, "04-audio-rail-button.png");

    // ── 6. Resting on it: a card beside the rail with the stack's controls; a click pauses it, a play button then ─
    await railButton.hover();
    const card = shell.getByTestId("rail-media-card");
    await expect(card).toHaveAttribute("data-shown", "");
    await expect(card.getByTestId(`media-back-${audio}`)).toBeVisible();
    await capture(app, shell, "05-audio-card.png");
    // Its speed's popup open, the pointer on it: the card stays, whatever the media says meanwhile (muted, and back).
    await card.getByTestId("media-rate-trigger").click();
    const ratePopup = shell.getByTestId("media-rate-card");
    await expect(ratePopup).toBeVisible();
    await ratePopup.hover();
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.controlMedia(tabId, { type: "mute" }), audio);
    await expect.poll(async () => (await mediaOf(shell, audio))?.muted ?? false).toBe(true);
    // (Nothing to wait on: a card the media's word put away would have gone by now.)
    await shell.waitForTimeout(600);
    await expect(card).toHaveCount(1);
    await expect(ratePopup).toBeVisible();
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.controlMedia(tabId, { type: "mute" }), audio);
    await expect.poll(async () => (await mediaOf(shell, audio))?.muted ?? true).toBe(false);
    await card.getByTestId("media-rate-trigger").click();
    await expect(ratePopup).toHaveCount(0);
    await railButton.hover();
    await railButton.click();
    await expect.poll(async () => (await mediaOf(shell, audio))?.playing ?? true).toBe(false);
    await expect(railButton).not.toHaveAttribute("data-playing");
    await shell.mouse.move(900, 450);
    await expect(card).toHaveCount(0);

    // ── 7. The whole sidebar (⌘S): the video goes into the stack's card, its picture there ─
    await shell.getByTestId("desk-rail-toggle").click();
    await expect(shell.locator('[data-testid="sidebar-motion-slot"]:not([data-rail])[data-desk]')).toHaveCount(1);
    await expect(pip).toHaveCount(0);
    const videoCard = shell.getByTestId(`media-video-${video}`);
    await expect(videoCard).toBeVisible();
    // (Against the card's box as it stands each time: it may still be coming in.)
    await expect.poll(async () => near(await viewAt(app, "?video"), await box(shell, `[data-testid="media-video-${video}"]`), 3)).toBe(true);
    await expect.poll(() => viewAt(app, CHROME_VIEW_HASHES.pip)).toBe(null);
    await capture(app, shell, "06-whole-sidebar-card.png");

    // ── 8. Back to the rail, and back to the desk from the player: its window comes out again ─
    await shell.getByTestId("desk-rail-toggle").click();
    await expect(shell.locator('[data-testid="sidebar-motion-slot"][data-rail]')).toHaveCount(1);
    await expect(pip).toHaveCount(1);
    const face2 = await pipPage(app);
    await face2.getByTestId("desk-pip-view").hover();
    await face2.getByTestId("desk-pip-return").click();
    await expect(windowOf(video)).toHaveCount(1);
    await expect(pip).toHaveCount(0);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(video);

    // ── 9. Popped out as the desk's last window, its tab still the one in use: back to the desk all the same ─
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await windowOf(video).getByTestId("desk-pop-out").click();
    await expect(windowOf(video)).toHaveCount(0);
    await expect(pip).toHaveCount(1);
    expect((await snapshot(shell)).activeTabId).toBe(video);
    // A page come out on the empty desk since — its view made above the picture — goes under the floating player.
    const OTHER_URL = `${ORIGIN}/invoices?other`;
    await createTab(shell, OTHER_URL);
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === "media")?.tabIds.length ?? 0).toBe(3);
    const other = (await snapshot(shell)).tabs.find((tab) => tab.url === OTHER_URL)!.id;
    await expect(windowOf(other)).toHaveCount(1);
    const stackIndex = (ending: string): Promise<number> =>
      app.evaluate(({ BrowserWindow }, ending) => BrowserWindow.getAllWindows()[0]!.contentView.children.findIndex((child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith(ending)), ending);
    await expect.poll(async () => (await stackIndex("?video")) > (await stackIndex("?other"))).toBe(true);
    await expect.poll(() => viewAt(app, "?video").then((bounds) => bounds !== null)).toBe(true);
    const face3 = await pipPage(app);
    await face3.getByTestId("desk-pip-view").hover({ position: { x: 40, y: 90 } });
    await face3.getByTestId("desk-pip-return").click();
    await expect(windowOf(video)).toHaveCount(1);
    await expect(pip).toHaveCount(0);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(video);

    // ── 10. Put away as any window is (not popped out), watched: it floats too; muted there, the whole sidebar still has it ─
    await settled(shell, app);
    await windowOf(video).getByTestId("desk-collapse").click();
    await expect(windowOf(video)).toHaveCount(0);
    await expect(pip).toHaveCount(1);
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.controlMedia(tabId, { type: "mute" }), video);
    await expect.poll(async () => (await mediaOf(shell, video))?.muted ?? false).toBe(true);
    await expect(pip).toHaveCount(1);
    await shell.getByTestId("desk-rail-toggle").click();
    await expect(shell.locator('[data-testid="sidebar-motion-slot"]:not([data-rail])[data-desk]')).toHaveCount(1);
    await expect(shell.getByTestId(`media-card-${video}`)).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

test("a window playing a video with another window over it shows its page live, not a still, and its own page again once it is uncovered", { tag: ["@desk", "@media"] }, async () => {
  test.setTimeout(120_000);
  const VIDEO_URL = `${ORIGIN}/invoices?video`;
  const OTHER_URL = `${ORIGIN}/invoices?other`;
  const { app, shell } = await launchDesk({ name: "live-picture", homeUrl: VIDEO_URL });
  try {
    const [video, other] = (await openTabs(shell, [VIDEO_URL, OTHER_URL])) as [string, string];
    await createGroup(shell, "watch", [video, other], "Watch", "blue");
    await selectTab(shell, video);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(video);
    const videoPage = await pageAt(app, VIDEO_URL);
    await installVideoPlayer(videoPage);
    await videoPage.locator("#start-video").click();
    await expect.poll(async () => (await mediaOf(shell, video))?.playing ?? false).toBe(true);

    await selectSpace(shell, "watch");
    await expect(shell.locator('.desk-stage[data-phase="open"]')).toHaveCount(1);
    const windowOf = (tabId: string) => shell.locator(`[data-testid="desk-window"][data-tab-id="${tabId}"]`);
    const rowOf = (tabId: string) => shell.locator(`[data-testid="sidebar-tab-list"] [role="tab"][data-tab-id="${tabId}"]`);
    await expect(shell.getByTestId("desk-window")).not.toHaveCount(0);
    await settled(shell, app);
    if ((await windowOf(video).count()) === 0) await rowOf(video).click();
    if ((await windowOf(other).count()) === 0) await rowOf(other).click();
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell, app);
    // Cascaded, so one lies over the other (a row's click puts a window out beside a filling one, not over it).
    await openMore(shell);
    await shell.getByTestId("desk-cascade").click();
    const stage = await box(shell, ".desk-stage");
    await shell.mouse.move(stage.x + stage.width * 0.9, stage.y + stage.height * 0.95);
    await settled(shell, app);
    const videoView = (): Promise<boolean> =>
      app.evaluate(({ BrowserWindow }, url) => {
        const view = BrowserWindow.getAllWindows()[0]!.contentView.children.find((child) => "webContents" in child && (child as WebContentsView).webContents.getURL() === url) as WebContentsView;
        return view.getVisible();
      }, VIDEO_URL);
    const live = windowOf(video).getByTestId("desk-live-picture");

    // In use, the video's window is its own page.
    await selectTab(shell, video);
    await expect.poll(videoView).toBe(true);
    await expect(live).toHaveCount(0);

    // The other window in use, over it: the video's window is drawn, from a capture of its page that moves as it plays.
    await selectTab(shell, other);
    const [videoBox, otherBox] = [await box(shell, `[data-testid="desk-window"][data-tab-id="${video}"]`), await box(shell, `[data-testid="desk-window"][data-tab-id="${other}"]`)];
    expect(videoBox.x < otherBox.x + otherBox.width && otherBox.x < videoBox.x + videoBox.width && videoBox.y < otherBox.y + otherBox.height && otherBox.y < videoBox.y + videoBox.height, "the windows overlap").toBe(true);
    await expect.poll(videoView).toBe(false);
    await expect(live).toHaveAttribute("data-shown", "", { timeout: 15_000 });
    const frames = await live.evaluate(
      (element) =>
        new Promise<number>((done) => {
          const player = element as HTMLVideoElement;
          let count = 0;
          const start = performance.now();
          const tick = (): void => {
            count += 1;
            if (performance.now() - start < 1000) player.requestVideoFrameCallback(tick);
            else done(count);
          };
          player.requestVideoFrameCallback(tick);
          setTimeout(() => done(count), 2000);
        }),
    );
    expect(frames).toBeGreaterThan(5);

    // In use again: its own page, and the capture let go.
    await selectTab(shell, video);
    await expect.poll(videoView).toBe(true);
    await expect(live).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});

test("a window playing a video behind a window filling the desk: its video floats, and is its window's again once that one is let down", { tag: ["@desk", "@media"] }, async () => {
  test.setTimeout(120_000);
  const VIDEO_URL = `${ORIGIN}/invoices?video`;
  const OTHER_URL = `${ORIGIN}/invoices?other`;
  const { app, shell } = await launchDesk({ name: "behind-filled", homeUrl: VIDEO_URL });
  try {
    const [video, other] = (await openTabs(shell, [VIDEO_URL, OTHER_URL])) as [string, string];
    await createGroup(shell, "watch", [video, other], "Watch", "blue");
    await selectTab(shell, video);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(video);
    const videoPage = await pageAt(app, VIDEO_URL);
    await installVideoPlayer(videoPage);
    await videoPage.locator("#start-video").click();
    await expect.poll(async () => (await mediaOf(shell, video))?.playing ?? false).toBe(true);

    await selectSpace(shell, "watch");
    await expect(shell.locator('.desk-stage[data-phase="open"]')).toHaveCount(1);
    const windowOf = (tabId: string) => shell.locator(`[data-testid="desk-window"][data-tab-id="${tabId}"]`);
    const rowOf = (tabId: string) => shell.locator(`[data-testid="sidebar-tab-list"] [role="tab"][data-tab-id="${tabId}"]`);
    await expect(shell.getByTestId("desk-window")).not.toHaveCount(0);
    await settled(shell, app);
    if ((await windowOf(video).count()) === 0) await rowOf(video).click();
    if ((await windowOf(other).count()) === 0) await rowOf(other).click();
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell, app);
    const pip = shell.getByTestId("desk-pip");
    await expect(pip).toHaveCount(0);

    // The other window in use, filling the desk: the video's window is behind it, out of sight — its video floats,
    // the page's own picture, and its window draws no live picture of it there.
    await selectTab(shell, other);
    await windowOf(other).getByRole("button", { name: "Fill the desk" }).click();
    await expect(pip).toHaveCount(1);
    await expect(pip).toHaveAttribute("data-tab-id", video);
    await settled(shell, app);
    const pipBox = await box(shell, '[data-testid="desk-pip"]');
    await expect.poll(async () => near((await shownViews(app)).find((view) => view.url === VIDEO_URL)?.bounds ?? null, pipBox)).toBe(true);
    await expect(windowOf(video).getByTestId("desk-live-picture")).toHaveCount(0);
    await expect.poll(async () => (await mediaOf(shell, video))?.playing ?? false).toBe(true);
    await capture(app, shell, "08-behind-a-filled-window.png");

    // Let down: the video is its window's again, playing on.
    await windowOf(other).getByRole("button", { name: "Restore" }).click();
    await expect(pip).toHaveCount(0);
    await settled(shell, app);
    await expect.poll(async () => (await shownViews(app)).some((view) => view.url === VIDEO_URL && near(view.bounds, pipBox))).toBe(false);
    await expect.poll(async () => (await mediaOf(shell, video))?.playing ?? false).toBe(true);
  } finally {
    await closeApp(app);
  }
});

test("a window closed while another's video floats leaves the floating player its video, and a tab closed while its video floats goes", { tag: ["@desk", "@media"] }, async () => {
  test.setTimeout(120_000);
  const VIDEO_URL = `${ORIGIN}/invoices?video`;
  const CLOSING_URL = `${ORIGIN}/invoices?closing`;
  const OTHER_URL = `${ORIGIN}/invoices?other`;
  const { app, shell } = await launchDesk({ name: "close-beside-pip", homeUrl: VIDEO_URL });
  try {
    const [video, closing, other] = (await openTabs(shell, [VIDEO_URL, CLOSING_URL, OTHER_URL])) as [string, string, string];
    await createGroup(shell, "watch", [video, closing, other], "Watch", "green");
    const choose = async (tabId: string): Promise<void> => {
      await selectTab(shell, tabId);
      await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(tabId);
    };
    // The one to float plays muted, as a feed's does; the other page's player is there, not yet started.
    await choose(video);
    const videoPage = await pageAt(app, VIDEO_URL);
    await installVideoPlayer(videoPage);
    await videoPage.evaluate(() => {
      (document.getElementById("test-video") as HTMLVideoElement).muted = true;
    });
    await videoPage.locator("#start-video").click();
    await expect.poll(async () => (await mediaOf(shell, video))?.playing ?? false).toBe(true);
    await choose(closing);
    const closingPage = await pageAt(app, CLOSING_URL);
    await installVideoPlayer(closingPage);

    await selectSpace(shell, "watch");
    await expect(shell.locator('.desk-stage[data-phase="open"]')).toHaveCount(1);
    const windowOf = (tabId: string) => shell.locator(`[data-testid="desk-window"][data-tab-id="${tabId}"]`);
    const rowOf = (tabId: string) => shell.locator(`[data-testid="sidebar-tab-list"] [role="tab"][data-tab-id="${tabId}"]`);
    await expect(shell.getByTestId("desk-window")).not.toHaveCount(0);
    await settled(shell, app);
    for (const tabId of [other, closing, video]) if ((await windowOf(tabId).count()) === 0) await rowOf(tabId).click();
    await expect(shell.getByTestId("desk-window")).toHaveCount(3);
    await settled(shell, app);

    // The muted video popped out floats.
    await windowOf(video).getByTestId("desk-pop-out").click();
    await expect(windowOf(video)).toHaveCount(0);
    const pip = shell.getByTestId("desk-pip");
    await expect(pip).toHaveAttribute("data-tab-id", video);
    const pipBox = await box(shell, '[data-testid="desk-pip"]');
    await expect.poll(() => viewAt(app, "?video").then((bounds) => near(bounds, pipBox))).toBe(true);
    // The other window's video starts after it, its sound on (a page that plays once it is in use): the later of the two.
    await choose(closing);
    await closingPage.locator("#start-video").click();
    await expect.poll(async () => (await mediaOf(shell, closing))?.playing ?? false).toBe(true);

    // ── Its window closed from its frame: the page takes a moment to unload (as a heavy site's does), and all the
    // while — its window gone, another in use, its video still playing — the floating player keeps its own.
    await closingPage.evaluate(() =>
      window.addEventListener("beforeunload", () => {
        const until = Date.now() + 1000;
        while (Date.now() < until);
      }),
    );
    await shell.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { pipTabs: string[] }).pipTabs = seen;
      const note = (): void => {
        const tabId = document.querySelector<HTMLElement>('[data-testid="desk-pip"]')?.dataset["tabId"];
        if (tabId !== undefined && seen.at(-1) !== tabId) seen.push(tabId);
      };
      note();
      new MutationObserver(note).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-tab-id"] });
    });
    await windowOf(closing).getByTestId("desk-close").click();
    await expect(windowOf(closing)).toHaveCount(0);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.id === closing), { timeout: 15_000 }).toBe(false);
    expect(await shell.evaluate(() => (window as unknown as { pipTabs: string[] }).pipTabs)).toEqual([video]);
    await expect(pip).toHaveAttribute("data-tab-id", video);
    await expect.poll(() => viewAt(app, "?video").then((bounds) => near(bounds, pipBox))).toBe(true);
    await expect.poll(() => viewAt(app, "?closing")).toBe(null);

    // ── The floating video's own tab closed (a row's ×): its page goes with the player showing it, and the tab with it.
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(tabId), video);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.id === video), { timeout: 15_000 }).toBe(false);
    await expect(pip).toHaveCount(0);
    await expect.poll(async () => (await call(shell, (pistachio) => pistachio.getMedia())).length).toBe(0);
  } finally {
    await closeApp(app);
  }
});
