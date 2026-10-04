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
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { BrowserMediaInfo } from "@pistachio/shell-contracts/media";
import { demoPortalHtml, demoToneWav } from "../../src/main/demo-page";
import { box, createGroup, createTab, launchDesk, openGroupDesk, openTabs, screenshots, selectTab, settled, snapshot, type Box } from "./desk-harness";

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
    await openGroupDesk(shell, "media");
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
    await expect.poll(() => viewAt(app, CHROME_VIEW_HASHES.pip).then((bounds) => near(bounds, pipBox))).toBe(true);
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

    // ── 4. Moved: a press on the picture, held — the drag layer's samples — and it stays where it is let go ─
    const send = (channel: string, payload: unknown): Promise<void> =>
      app.evaluate(({ BrowserWindow }, { channel, payload }) => BrowserWindow.getAllWindows()[0]!.webContents.send(channel, payload), { channel, payload });
    const from = { x: pipBox.x + 160, y: pipBox.y + 90 };
    await send("pistachio:desk-pip-input", { type: "grab", ...from });
    for (let step = 1; step <= 6; step += 1) await send("pistachio:drag-sample", { x: from.x + step * 60, y: from.y - step * 50, phase: "move" });
    // Held, the drag layer keeps the pointer: the player raised as it follows (its pip view) stays under it.
    const topView = (): Promise<string> =>
      app.evaluate(({ BrowserWindow }) => {
        const children = BrowserWindow.getAllWindows()[0]!.contentView.children;
        const top = children[children.length - 1] as WebContentsView;
        return top.webContents.getURL();
      });
    await expect.poll(async () => (await topView()).endsWith(CHROME_VIEW_HASHES.drag)).toBe(true);
    await send("pistachio:drag-sample", { x: from.x + 360, y: from.y - 300, phase: "up" });
    await expect.poll(async () => (await box(shell, '[data-testid="desk-pip"]')).x).toBeCloseTo(pipBox.x + 360, -1);
    const moved = await box(shell, '[data-testid="desk-pip"]');
    expect(Math.abs(moved.y - (pipBox.y - 300))).toBeLessThan(2);
    await expect.poll(() => viewAt(app, "?video").then((bounds) => near(bounds, moved))).toBe(true);
    expect(await shell.evaluate(() => localStorage.getItem("pistachio.desk.pip.v1"))).not.toBe(null);

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
