import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { demoPortalHtml, demoToneWav } from "../../src/main/demo-page";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import type { WebContentsView } from "electron";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

let audioServer: Server;
let AUDIO_URL: string;
// The protocol fixture lacks byte ranges. Serve the same offline assets over
// loopback so seeking exercises the real Chromium player and production IPC.
test.beforeAll(async () => {
  const wav = Buffer.from(demoToneWav());
  audioServer = createServer((request, response) => {
    if (request.url === "/test.wav") {
      const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? "");
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2]
        ? Math.min(Number(match[2]), wav.length - 1)
        : wav.length - 1;
      response.writeHead(match ? 206 : 200, {
        "content-type": "audio/wav",
        "accept-ranges": "bytes",
        "content-length": end - start + 1,
        ...(match
          ? { "content-range": `bytes ${start}-${end}/${wav.length}` }
          : {}),
      });
      response.end(wav.subarray(start, end + 1));
    } else {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(demoPortalHtml());
    }
  });
  await new Promise<void>((done) => audioServer.listen(0, "127.0.0.1", done));
  const address = audioServer.address();
  if (!address || typeof address === "string")
    throw new Error("Audio fixture did not start");
  AUDIO_URL = `http://127.0.0.1:${address.port}/invoices`;
});
test.afterAll(async () => {
  await new Promise<void>((done) => audioServer.close(() => done()));
});

const MEDIA_URL = "pistachio://demo/invoices?media-stack";
const screenshotDirectory = join(process.cwd(), "e2e/screenshots/media-stack");

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", executableSuffix),
    resolve(
      process.cwd(),
      "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron",
      executableSuffix,
    ),
  ];
  return candidates.find(
    (candidate) =>
      candidate !== undefined &&
      existsSync(candidate) &&
      existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function settled(element: Locator): Promise<void> {
  await expect
    .poll(() =>
      element.evaluate((node) =>
        node
          .getAnimations({ subtree: true })
          .some((animation) => animation.playState === "running"),
      ),
    )
    .toBe(false);
}

/** Force-close capture-stream fixtures if Electron does not finish quitting. */
async function closeMediaApp(app: ElectronApplication): Promise<void> {
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
  await expect
    .poll(() => app.windows().some((page) => page.url() === url))
    .toBe(true);
  const page = app.windows().find((candidate) => candidate.url() === url);
  if (page === undefined) throw new Error(`No Electron page at ${url}`);
  return page;
}

/** Install a player for the app-owned offline WAV fixture. */
async function installPlayer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const audio = document.createElement("audio");
    audio.id = "test-audio";
    audio.loop = true;
    audio.src = new URL("/test.wav", location.href).href;
    const button = document.createElement("button");
    button.id = "start-media";
    button.textContent = "Start media";
    button.addEventListener("click", () => void audio.play());
    document.body.prepend(button, audio);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "Loop Theory",
      artist: "Pistachio Radio",
      album: "Focus Signals",
      artwork: [
        {
          src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' rx='12' fill='%232f7d4a'/><circle cx='32' cy='32' r='12' fill='%23ffffff'/></svg>",
        },
      ],
    });
  });
}

/** Install a real, continuously-painted video without a network fixture. */
async function installVideoPlayer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable");
    let frame = 0;
    let animationFrame = 0;
    const paint = () => {
      frame += 1;
      context.fillStyle = `hsl(${String(frame % 360)} 54% 24%)`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#f4f1e8";
      context.font = "600 28px sans-serif";
      context.fillText("Continuum", 82, 100);
      animationFrame = requestAnimationFrame(paint);
    };
    paint();

    const video = document.createElement("video");
    video.id = "test-video";
    video.controls = true;
    video.playsInline = true;
    video.style.width = "320px";
    video.style.height = "180px";
    const stream = canvas.captureStream(12);
    video.srcObject = stream;
    const button = document.createElement("button");
    button.id = "start-video";
    button.textContent = "Start video";
    button.addEventListener("click", () => void video.play());
    document.body.prepend(button, video, canvas);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "Continuum",
      artist: "Pistachio Pictures",
    });
    (window as unknown as { stopTestVideo: () => void }).stopTestVideo = () => {
      cancelAnimationFrame(animationFrame);
      for (const track of stream.getTracks()) track.stop();
      video.pause();
      video.srcObject = null;
    };
  });
}

test("background playback becomes a fully controllable sidebar stack", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-media-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }),
  );
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });

  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const originalTabId = await shell.evaluate(async (url) => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      const snapshot = await api.getSnapshot();
      await api.createTab(url);
      if (snapshot.activeTabId === null) throw new Error("No original tab");
      return snapshot.activeTabId;
    }, AUDIO_URL);
    const mediaPage = await pageAt(app, AUDIO_URL);
    await installPlayer(mediaPage);
    await expect
      .poll(() =>
        mediaPage
          .locator("#test-audio")
          .evaluate((audio) => (audio as HTMLAudioElement).readyState),
      )
      .toBeGreaterThan(0);
    await mediaPage.locator("#start-media").click();
    await expect
      .poll(() =>
        mediaPage
          .locator("#test-audio")
          .evaluate((audio) => (audio as HTMLAudioElement).paused),
      )
      .toBe(false);
    await expect
      .poll(() =>
        shell.evaluate(async () => {
          const media = await (
            window as unknown as { pistachio: PistachioApi }
          ).pistachio.getMedia();
          return media[0]?.title ?? null;
        }),
      )
      .toBe("Loop Theory");

    // It does not cover a page that is currently visible, then appears after
    // the short-sound guard once that playback is in the background.
    await expect(shell.getByTestId("media-stack")).toHaveCount(0);
    await shell.evaluate(async (tabId) => {
      await (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.selectTab(tabId);
    }, originalTabId);
    await expect
      .poll(() =>
        shell.evaluate(async (url) => {
          const snapshot = await (
            window as unknown as { pistachio: PistachioApi }
          ).pistachio.getSnapshot();
          return snapshot.tabs.find((tab) => tab.url === url)?.id ?? null;
        }, AUDIO_URL),
      )
      .not.toBeNull();
    const mediaTabId = await shell.evaluate(async (url) => {
      const snapshot = await (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.getSnapshot();
      return snapshot.tabs.find((tab) => tab.url === url)?.id ?? "";
    }, AUDIO_URL);
    const stack = shell.getByTestId("media-stack");
    await expect(stack).toBeVisible();
    await expect(stack).toContainText("Loop Theory");
    await expect(stack.locator(".media-card-main")).toContainText(
      "Pistachio Radio",
    );
    await expect(
      stack.getByTestId(`media-source-favicon-${mediaTabId}`),
    ).toBeVisible();
    await expect(stack.getByTestId(`media-play-${mediaTabId}`)).toHaveAttribute(
      "data-primary",
      "true",
    );

    const play = stack.getByRole("button", { name: "Pause", exact: true });
    await play.click();
    await expect(
      stack.getByRole("button", { name: "Play", exact: true }),
    ).toBeVisible();
    await stack.getByRole("button", { name: "Play", exact: true }).click();
    await expect(
      stack.getByRole("button", { name: "Pause", exact: true }),
    ).toBeVisible();

    const mediaTab = shell.locator(`[data-tab-id="${mediaTabId}"]`);
    const audioIndicator = mediaTab.getByTestId("tab-audio-indicator");
    await expect(audioIndicator).toHaveAccessibleName(
      /Mute audio from Northstar/,
    );
    await audioIndicator.click();
    await expect(stack.getByTestId(`media-mute-${mediaTabId}`)).toHaveAttribute(
      "aria-label",
      "Unmute",
    );
    await expect(audioIndicator).toHaveAccessibleName(
      /Unmute audio from Northstar/,
    );

    await stack.hover();
    await expect(
      stack.getByRole("slider", { name: /Seek Loop Theory/ }),
    ).toBeVisible();
    await expect(
      stack.getByRole("button", { name: "Show playing tab" }),
    ).toBeVisible();
    await mkdir(screenshotDirectory, { recursive: true });
    // Let the fan-out and the details' fade settle so the capture shows the open card.
    await settled(stack);
    await shell.screenshot({
      path: join(screenshotDirectory, "expanded-stack.png"),
    });

    // Speed opens a popup without moving the trigger or neighboring controls.
    const rateTrigger = stack.getByTestId("media-rate-trigger");
    const frontCard = stack.getByTestId(`media-card-${mediaTabId}`);
    const geometry = () =>
      frontCard.evaluate((element) => {
        const trigger = element
          .querySelector(".media-rate-trigger")!
          .getBoundingClientRect();
        const skip = element
          .querySelector(".media-skip-controls")!
          .getBoundingClientRect();
        return {
          width: trigger.width,
          x: skip.x,
          height: element.getBoundingClientRect().height,
        };
      });
    await expect(rateTrigger).toHaveText("1x");
    const restingGeometry = await geometry();
    await rateTrigger.click();
    const rateCard = shell.getByTestId("media-rate-card");
    await expect(rateCard).toBeVisible();
    const speed = rateCard.getByRole("slider", {
      name: "Playback speed",
      exact: true,
    });
    await expect(speed).toBeFocused();
    await speed.press("ArrowRight");
    await speed.press("ArrowRight");
    await speed.press("ArrowRight");
    await expect
      .poll(() =>
        mediaPage
          .locator("#test-audio")
          .evaluate((audio) => (audio as HTMLAudioElement).playbackRate),
      )
      .toBe(1.75);
    await expect(rateTrigger).toHaveText("1.75x");
    expect(await geometry()).toEqual(restingGeometry);
    await settled(rateCard);
    await shell.screenshot({
      path: join(screenshotDirectory, "rate-slider.png"),
    });
    await rateCard
      .getByRole("button", { name: "Reset playback speed to 1x" })
      .click();
    await expect
      .poll(() =>
        mediaPage
          .locator("#test-audio")
          .evaluate((audio) => (audio as HTMLAudioElement).playbackRate),
      )
      .toBe(1);
    await shell.keyboard.press("Escape");
    await expect(rateCard).toHaveCount(0);
    await expect(rateTrigger).toBeFocused();

    // Seeking still reaches the real player; timestamp labels sit below the bar.
    await frontCard.getByRole("button", { name: "Pause", exact: true }).click();
    const seek = frontCard.getByRole("slider", { name: "Seek Loop Theory" });
    await expect
      .poll(() =>
        mediaPage
          .locator("#test-audio")
          .evaluate((audio) => (audio as HTMLAudioElement).paused),
      )
      .toBe(true);
    // Start away from the lower bound: a looping fixture can pause within the
    // range's first 0.1s step, where Home would not emit an input change.
    await seek.press("ArrowRight");
    await expect
      .poll(() =>
        mediaPage
          .locator("#test-audio")
          .evaluate((audio) => (audio as HTMLAudioElement).currentTime),
      )
      .toBeGreaterThan(0.05);
    await seek.press("Home");
    await expect
      .poll(() =>
        mediaPage
          .locator("#test-audio")
          .evaluate((audio) => (audio as HTMLAudioElement).currentTime),
      )
      .toBe(0);
    await expect(seek).toHaveValue("0");
    await seek.press("ArrowRight");
    await expect
      .poll(() =>
        mediaPage
          .locator("#test-audio")
          .evaluate((audio) =>
            Math.round((audio as HTMLAudioElement).currentTime * 10),
          ),
      )
      .toBe(1);
    // The 15-second seeks reach the real player too, clamped to the clip: the
    // fixture is shorter than one step, so forward lands on its end and back
    // returns to its start.
    const currentTime = () =>
      mediaPage
        .locator("#test-audio")
        .evaluate((audio) => (audio as HTMLAudioElement).currentTime);
    await frontCard.getByTestId(`media-forward-${mediaTabId}`).click();
    await expect.poll(currentTime).toBeGreaterThan(7);
    await frontCard.getByTestId(`media-back-${mediaTabId}`).click();
    await expect.poll(currentTime).toBe(0);
    const times = await frontCard.locator(".media-times").boundingBox();
    const track = await seek.boundingBox();
    expect(times!.y).toBeGreaterThanOrEqual(track!.y + track!.height);
    await frontCard
      .getByRole("button", { name: "Unmute", exact: true })
      .click();
    await expect
      .poll(() =>
        shell.evaluate(
          async () =>
            (
              await (
                window as unknown as { pistachio: PistachioApi }
              ).pistachio.getMedia()
            )[0]?.muted,
        ),
      )
      .toBe(false);

    // Page-owned previous/next handlers remain available when the source advertises them.
    await mediaPage.evaluate(() => {
      for (const action of ["Previous", "Next"]) {
        const button = document.createElement("button");
        button.setAttribute("aria-label", `${action} track`);
        button.textContent = action;
        button.addEventListener("click", () =>
          document.body.setAttribute("data-track-action", action),
        );
        document.body.prepend(button);
      }
      document
        .getElementById("test-audio")!
        .dispatchEvent(new Event("durationchange"));
    });
    await expect(
      frontCard.getByRole("button", { name: "Next track", exact: true }),
    ).toBeVisible();
    await frontCard
      .getByRole("button", { name: "Next track", exact: true })
      .click();
    await expect(mediaPage.locator("body")).toHaveAttribute(
      "data-track-action",
      "Next",
    );
    await frontCard
      .getByRole("button", { name: "Previous track", exact: true })
      .click();
    await expect(mediaPage.locator("body")).toHaveAttribute(
      "data-track-action",
      "Previous",
    );

    // Only metadata reveals the close button. Leaving returns to a compact progress strip.
    await seek.hover();
    const dismiss = frontCard.getByRole("button", {
      name: "Dismiss media control",
    });
    await expect(dismiss).toBeHidden();
    await frontCard.getByTestId(`media-identity-${mediaTabId}`).hover();
    await expect(dismiss).toBeVisible();
    await settled(frontCard);
    await shell.screenshot({
      path: join(screenshotDirectory, "metadata-dismiss.png"),
    });
    await shell.mouse.move(800, 100);
    await expect
      .poll(() =>
        frontCard.evaluate((element) => element.getBoundingClientRect().height),
      )
      .toBe(54);
    await expect(frontCard.locator(".media-compact-progress")).toBeVisible();
    await shell.screenshot({
      path: join(screenshotDirectory, "compact-stack.png"),
    });

    const sidebarBefore = await shell
      .getByTestId("sidebar-tab-list")
      .boundingBox();
    const lightSurface = await frontCard.evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
    await shell.evaluate(() =>
      (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.updateSettings({ appearance: { scheme: "dark" } }),
    );
    await expect(shell.locator("html")).toHaveAttribute(
      "data-color-scheme",
      "dark",
    );
    await expect
      .poll(() =>
        frontCard.evaluate((node) => getComputedStyle(node).backgroundColor),
      )
      .not.toBe(lightSurface);
    await frontCard.getByTestId(`media-identity-${mediaTabId}`).hover();
    await settled(frontCard);
    await shell.screenshot({
      path: join(screenshotDirectory, "dark-expanded-stack.png"),
    });
    await rateTrigger.click();
    await settled(rateCard);
    await shell.screenshot({
      path: join(screenshotDirectory, "dark-speed-slider.png"),
    });
    await speed.press("Escape");
    const sidebarAfter = await shell
      .getByTestId("sidebar-tab-list")
      .boundingBox();
    expect(sidebarAfter?.x).toBe(sidebarBefore?.x);
    expect(sidebarAfter?.width).toBe(sidebarBefore?.width);
    await shell.emulateMedia({ reducedMotion: "reduce" });
    await frontCard.getByTestId(`media-identity-${mediaTabId}`).hover();
    await dismiss.click();
    await expect(stack).toHaveCount(0);
  } finally {
    await closeMediaApp(app);
  }
});

test("a playing video becomes a live extension of the sidebar mini player", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-video-mini-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }),
  );
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });

  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const originalTabId = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      const snapshot = await api.getSnapshot();
      await api.createTab("pistachio://demo/invoices?media-stack");
      if (snapshot.activeTabId === null) throw new Error("No original tab");
      return snapshot.activeTabId;
    });
    const mediaPage = await pageAt(app, MEDIA_URL);
    await installVideoPlayer(mediaPage);
    await mediaPage.locator("#start-video").click();
    await expect
      .poll(() =>
        mediaPage
          .locator("#test-video")
          .evaluate((video) => (video as HTMLVideoElement).paused),
      )
      .toBe(false);
    await expect
      .poll(() =>
        shell.evaluate(async () => {
          const media = await (
            window as unknown as { pistachio: PistachioApi }
          ).pistachio.getMedia();
          return media[0]?.hasVideo ?? false;
        }),
      )
      .toBe(true);

    const mediaTabId = await shell.evaluate(async () => {
      const snapshot = await (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.getSnapshot();
      return (
        snapshot.tabs.find(
          (tab) => tab.url === "pistachio://demo/invoices?media-stack",
        )?.id ?? ""
      );
    });

    // A paused video is known media, but leaving its tab must not trigger the
    // sidebar player unless it was actively being watched at that transition.
    await mediaPage
      .locator("#test-video")
      .evaluate((video) => (video as HTMLVideoElement).pause());
    await expect
      .poll(() =>
        mediaPage
          .locator("#test-video")
          .evaluate((video) => (video as HTMLVideoElement).paused),
      )
      .toBe(true);
    await expect
      .poll(() =>
        shell.evaluate(async (tabId) => {
          const media = await (
            window as unknown as { pistachio: PistachioApi }
          ).pistachio.getMedia();
          return media.find((item) => item.tabId === tabId)?.playing ?? null;
        }, mediaTabId),
      )
      .toBe(false);
    await shell.evaluate(async (tabId) => {
      await (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.selectTab(tabId);
    }, originalTabId);
    await expect(shell.getByTestId("media-stack")).toHaveCount(0);

    await shell.evaluate(async (tabId) => {
      await (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.selectTab(tabId);
    }, mediaTabId);
    await mediaPage.locator("#start-video").click();
    await expect
      .poll(() =>
        mediaPage
          .locator("#test-video")
          .evaluate((video) => (video as HTMLVideoElement).paused),
      )
      .toBe(false);

    // Neither does a clip playing with its sound off — a timeline's autoplay,
    // not a session worth carrying into the sidebar.
    await mediaPage.locator("#test-video").evaluate((video) => {
      (video as HTMLVideoElement).muted = true;
    });
    await expect
      .poll(() =>
        shell.evaluate(async (tabId) => {
          const media = await (
            window as unknown as { pistachio: PistachioApi }
          ).pistachio.getMedia();
          const item = media.find((candidate) => candidate.tabId === tabId);
          return item === undefined
            ? null
            : { playing: item.playing, muted: item.muted };
        }, mediaTabId),
      )
      .toEqual({ playing: true, muted: true });
    await shell.evaluate(async (tabId) => {
      await (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.selectTab(tabId);
    }, originalTabId);
    await expect(shell.getByTestId("media-stack")).toHaveCount(0);

    await shell.evaluate(async (tabId) => {
      await (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.selectTab(tabId);
    }, mediaTabId);
    await mediaPage.locator("#test-video").evaluate((video) => {
      (video as HTMLVideoElement).muted = false;
    });
    await expect
      .poll(() =>
        shell.evaluate(async (tabId) => {
          const media = await (
            window as unknown as { pistachio: PistachioApi }
          ).pistachio.getMedia();
          const item = media.find((candidate) => candidate.tabId === tabId);
          return item === undefined
            ? null
            : { playing: item.playing, muted: item.muted };
        }, mediaTabId),
      )
      .toEqual({ playing: true, muted: false });

    // What the page is looking at while it owns a pane: the sidebar card is
    // a fraction of that box, and none of this may follow the video there.
    const paneView = await mediaPage.evaluate(() => {
      const filler = document.createElement("div");
      filler.style.cssText = "width:100%;height:400vw";
      document.body.append(filler);
      window.scrollTo(0, 1_200);
      return { width: window.innerWidth, height: window.innerHeight };
    });
    await expect
      .poll(() => mediaPage.evaluate(() => Math.round(window.scrollY)))
      .toBe(1_200);

    await shell.evaluate(async (tabId) => {
      await (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.selectTab(tabId);
    }, originalTabId);
    const miniVideo = shell.getByTestId(`media-video-${mediaTabId}`);
    await expect(miniVideo).toBeVisible();
    await expect(shell.getByTestId("media-stack")).toContainText("Continuum");
    await expect
      .poll(() =>
        mediaPage.evaluate(() =>
          document.documentElement.hasAttribute("data-pistachio-mini-video"),
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        mediaPage
          .locator("#test-video")
          .evaluate((video) => (video as HTMLVideoElement).paused),
      )
      .toBe(false);

    // The footer menu opens upward over the card. Its video is a native view
    // above the shell page, so the menu can only show by the view coming
    // down while the menu is up; it returns, still playing, once it closes.
    await shell.getByTestId("sidebar-menu-button").hover();
    await expect(shell.getByTestId("sidebar-menu")).toBeVisible();
    await expect
      .poll(() =>
        mediaPage.evaluate(() =>
          document.documentElement.hasAttribute("data-pistachio-mini-video"),
        ),
      )
      .toBe(false);
    await expect(shell.getByTestId("media-stack")).toBeVisible();
    await shell.mouse.move(800, 100);
    await expect(shell.getByTestId("sidebar-menu")).toHaveCount(0);
    await expect
      .poll(() =>
        mediaPage.evaluate(() =>
          document.documentElement.hasAttribute("data-pistachio-mini-video"),
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        mediaPage
          .locator("#test-video")
          .evaluate((video) => (video as HTMLVideoElement).paused),
      )
      .toBe(false);

    // A modal over the PAGE leaves the sidebar alone. The settings page fills
    // the content hole and a Glance recesses the owner's pane; through both,
    // the card's page stays presented and its native view stays up — it is
    // beside what is drawn over the page, not under it.
    const previewUp = () =>
      mediaPage.evaluate(() =>
        document.documentElement.hasAttribute("data-pistachio-mini-video"),
      );
    const previewViewVisible = () =>
      app.evaluate(({ BrowserWindow }, url) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window === undefined)
          throw new Error("Pistachio window is unavailable");
        return window.contentView.children.some(
          (child) =>
            "webContents" in child &&
            (child as WebContentsView).webContents.getURL() === url &&
            child.getVisible(),
        );
      }, MEDIA_URL);
    await shell.keyboard.press("Meta+,");
    await expect(shell.getByTestId("settings-page")).toBeVisible();
    await expect.poll(previewViewVisible).toBe(true);
    expect(await previewUp()).toBe(true);
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("settings-page")).toHaveCount(0);

    await shell.evaluate(async (tabId) => {
      await (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.navigate(tabId, "pistachio://demo/invoices");
    }, originalTabId);
    const owner = await pageAt(app, "pistachio://demo/invoices");
    await owner.locator("#vendor-record-link").click({ modifiers: ["Alt"] });
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    await expect.poll(previewViewVisible).toBe(true);
    expect(await previewUp()).toBe(true);
    await expect
      .poll(() =>
        mediaPage
          .locator("#test-video")
          .evaluate((video) => (video as HTMLVideoElement).paused),
      )
      .toBe(false);
    await shell.getByTestId("glance-close").click();
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await expect.poll(previewViewVisible).toBe(true);

    // The address bar's veil covers the whole window, sidebar included: the
    // preview comes down for it and returns on close, still playing.
    await shell.keyboard.press("Meta+L");
    await expect.poll(previewUp).toBe(false);
    await shell.keyboard.press("Escape");
    await expect.poll(previewUp).toBe(true);
    await expect.poll(previewViewVisible).toBe(true);
    await expect
      .poll(() =>
        mediaPage
          .locator("#test-video")
          .evaluate((video) => (video as HTMLVideoElement).paused),
      )
      .toBe(false);

    // The card composes the page by scaling the view, never by resizing the
    // document: a page that reflowed into a ~230px box would re-lay out (a
    // feed would recycle the rows holding the very element being played) and
    // lose the offset the person left behind.
    expect(
      await mediaPage.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        scrollY: Math.round(window.scrollY),
        connected: document.getElementById("test-video")?.isConnected === true,
      })),
    ).toEqual({ ...paneView, scrollY: 1_200, connected: true });

    const bounds = await miniVideo.boundingBox();
    expect(bounds).not.toBeNull();
    expect((bounds?.width ?? 0) / (bounds?.height ?? 1)).toBeCloseTo(16 / 9, 1);
    // The video fills exactly the band of that kept viewport the card covers.
    expect(
      await mediaPage.locator("#test-video").evaluate((video) => {
        const rect = video.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          ratio: Math.round((rect.width / rect.height) * 100) / 100,
        };
      }),
    ).toEqual({
      x: 0,
      y: 0,
      ratio:
        Math.round(((bounds?.width ?? 0) / (bounds?.height ?? 1)) * 100) / 100,
    });
    const card = shell.getByTestId(`media-card-${mediaTabId}`);
    const baseControls = card.locator(".media-card-main");
    const extraControls = shell.getByRole("button", {
      name: "Show playing tab",
      includeHidden: true,
    });
    // Establish the native view's leave boundary before asserting its resting
    // state; Electron retains the CDP pointer when it recomposes the page.
    await mediaPage
      .locator("#test-video")
      .dispatchEvent("pointerout", { relatedTarget: null });
    await shell.mouse.move(800, 100);
    await expect
      .poll(() =>
        card.evaluate((element) => element.getBoundingClientRect().height),
      )
      .toBe((bounds?.height ?? 0) + 70);
    await expect
      .poll(() =>
        extraControls.evaluate(
          (button) =>
            getComputedStyle(button.closest(".media-card-details")!).opacity,
        ),
      )
      .toBe("0");
    await mkdir(screenshotDirectory, { recursive: true });
    await shell.screenshot({
      path: join(screenshotDirectory, "video-mini-player.png"),
    });
    await mediaPage
      .locator("#test-video")
      .screenshot({
        path: join(screenshotDirectory, "native-video-frame.png"),
      });

    // The video frame and compact metadata remain visible at rest. Hovering
    // the native video expands only its own card.
    await mediaPage.mouse.move(
      (bounds?.width ?? 0) / 2,
      (bounds?.height ?? 0) / 2,
    );
    await expect
      .poll(() =>
        card.evaluate((element) => element.getBoundingClientRect().height),
      )
      .toBe((bounds?.height ?? 0) + 158);
    await expect
      .poll(() =>
        extraControls.evaluate(
          (button) =>
            getComputedStyle(button.closest(".media-card-details")!).opacity,
        ),
      )
      .toBe("1");
    await settled(card);
    await shell.screenshot({
      path: join(screenshotDirectory, "video-mini-player-compact-controls.png"),
    });

    // Metadata hover keeps the playback controls open and reveals dismissal.
    await baseControls.hover();
    await expect
      .poll(() =>
        card.evaluate((element) => element.getBoundingClientRect().height),
      )
      .toBe((bounds?.height ?? 0) + 158);
    await expect
      .poll(() =>
        extraControls.evaluate(
          (button) =>
            getComputedStyle(button.closest(".media-card-details")!).opacity,
        ),
      )
      .toBe("1");
    await settled(card);
    await shell.screenshot({
      path: join(
        screenshotDirectory,
        "video-mini-player-expanded-controls.png",
      ),
    });

    // Pointer activation can retain DOM focus, but that mouse focus must not
    // pin the card open after the pointer leaves. Pausing an already-open
    // mini-player still keeps it available for resuming.
    await card.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(
      card.getByRole("button", { name: "Play", exact: true }),
    ).toBeVisible();
    await expect(shell.getByTestId("media-stack")).toBeVisible();
    await card.getByRole("button", { name: "Play", exact: true }).click();
    await expect(
      card.getByRole("button", { name: "Pause", exact: true }),
    ).toBeVisible();
    await mediaPage
      .locator("#test-video")
      .dispatchEvent("pointerout", { relatedTarget: null });
    await shell.mouse.move(800, 100);
    await expect
      .poll(() =>
        card.evaluate((element) => ({
          focused: element.contains(document.activeElement),
          focusVisible: element.matches(":has(:focus-visible)"),
        })),
      )
      .toEqual({ focused: true, focusVisible: false });
    await expect
      .poll(() =>
        card.evaluate((element) => ({
          height: element.getBoundingClientRect().height,
          nativeHover: element
            .closest(".media-stack")!
            .getAttribute("data-video-hovered"),
          stackHover: element.closest(".media-stack")!.matches(":hover"),
          cardHover: element.matches(":hover"),
          focused: element.matches(":has(:focus-visible)"),
        })),
      )
      .toEqual({
        height: (bounds?.height ?? 0) + 70,
        nativeHover: null,
        stackHover: false,
        cardHover: false,
        focused: false,
      });

    // Shift-Tab from play reaches the compact metadata button; keyboard focus expands its card.
    await shell.keyboard.press("Shift+Tab");
    await expect
      .poll(() =>
        card.evaluate((element) => element.matches(":has(:focus-visible)")),
      )
      .toBe(true);
    await expect
      .poll(() =>
        card.evaluate((element) => element.getBoundingClientRect().height),
      )
      .toBe((bounds?.height ?? 0) + 158);
    await card
      .getByRole("button", { name: "Picture in Picture", exact: true })
      .click();
    await expect
      .poll(() =>
        mediaPage.evaluate(() => document.pictureInPictureElement !== null),
      )
      .toBe(true);
    await expect(shell.getByTestId("media-stack")).toHaveCount(0);
    await mediaPage.evaluate(() => document.exitPictureInPicture());
    await expect(card).toBeVisible();
    await baseControls.hover();
    await expect(extraControls).toBeVisible();
    await extraControls.click();
    await expect(shell.getByTestId("media-stack")).toHaveCount(0);
    await expect
      .poll(() =>
        mediaPage.evaluate(() =>
          document.documentElement.hasAttribute("data-pistachio-mini-video"),
        ),
      )
      .toBe(false);
    await expect
      .poll(() =>
        mediaPage
          .locator("#test-video")
          .evaluate((video) => (video as HTMLVideoElement).paused),
      )
      .toBe(false);
    // Back in its pane: the same viewport, the same place in the page.
    await expect
      .poll(() =>
        mediaPage.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
          scrollY: Math.round(window.scrollY),
        })),
      )
      .toEqual({ ...paneView, scrollY: 1_200 });
  } finally {
    const mediaPage = app
      .windows()
      .find((candidate) => candidate.url() === MEDIA_URL);
    if (mediaPage !== undefined) {
      await mediaPage
        .evaluate(() => {
          (
            window as unknown as { stopTestVideo?: () => void }
          ).stopTestVideo?.();
        })
        .catch(() => undefined);
    }
    await closeMediaApp(app);
  }
});

test("only one background video plays at a time, and every card stays in reach", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-two-videos-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }),
  );
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  const SECOND_URL = "pistachio://demo/invoices?media-stack-2";

  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const originalTabId = await shell.evaluate(async () => {
      const snapshot = await (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.getSnapshot();
      await (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.createTab("pistachio://demo/invoices?media-stack");
      if (snapshot.activeTabId === null) throw new Error("No original tab");
      return snapshot.activeTabId;
    });
    const tabIdFor = (url: string) =>
      shell.evaluate(async (target) => {
        const snapshot = await (
          window as unknown as { pistachio: PistachioApi }
        ).pistachio.getSnapshot();
        return snapshot.tabs.find((tab) => tab.url === target)?.id ?? "";
      }, url);
    const playingOf = (tabId: string) =>
      shell.evaluate(async (target) => {
        const media = await (
          window as unknown as { pistachio: PistachioApi }
        ).pistachio.getMedia();
        return media.find((item) => item.tabId === target)?.playing ?? null;
      }, tabId);

    // First video: watched, then left behind for the sidebar.
    const firstPage = await pageAt(app, MEDIA_URL);
    await installVideoPlayer(firstPage);
    await firstPage.locator("#start-video").click();
    const firstTabId = await tabIdFor(MEDIA_URL);
    await expect.poll(() => playingOf(firstTabId)).toBe(true);
    await shell.evaluate(async (tabId) => {
      await (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.selectTab(tabId);
    }, originalTabId);
    await expect(shell.getByTestId(`media-video-${firstTabId}`)).toBeVisible();

    // Second video started in a pane: the sidebar's video yields to it.
    await shell.evaluate(async (url) => {
      await (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.createTab(url);
    }, SECOND_URL);
    const secondPage = await pageAt(app, SECOND_URL);
    await installVideoPlayer(secondPage);
    await secondPage.locator("#start-video").click();
    const secondTabId = await tabIdFor(SECOND_URL);
    await expect.poll(() => playingOf(secondTabId)).toBe(true);
    await expect.poll(() => playingOf(firstTabId)).toBe(false);
    await expect
      .poll(() =>
        firstPage
          .locator("#test-video")
          .evaluate((video) => (video as HTMLVideoElement).paused),
      )
      .toBe(true);

    // Leaving it: the playing video takes the front with the live picture,
    // and the paused one is still in the stack behind it, visible above the
    // picture rather than hidden under it.
    await shell.evaluate(async (tabId) => {
      await (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.selectTab(tabId);
    }, originalTabId);
    const stack = shell.getByTestId("media-stack");
    const front = shell.getByTestId(`media-card-${secondTabId}`);
    const behind = shell.getByTestId(`media-card-${firstTabId}`);
    await expect(shell.getByTestId(`media-video-${secondTabId}`)).toBeVisible();
    await expect(behind).toHaveCount(1);
    await expect(shell.getByTestId(`media-video-${firstTabId}`)).toHaveCount(0);
    // Its peek is a strip just above the picture's top edge; the rest of the
    // card tucks behind the front one.
    await settled(stack);
    const rest = await Promise.all([front.boundingBox(), behind.boundingBox()]);
    expect(rest[0]).not.toBeNull();
    expect(rest[1]).not.toBeNull();
    expect(rest[1]?.y ?? 0).toBeLessThan(rest[0]?.y ?? 0);
    expect(rest[1]?.y ?? 0).toBeGreaterThanOrEqual((rest[0]?.y ?? 0) - 12);
    await mkdir(screenshotDirectory, { recursive: true });
    await shell.screenshot({
      path: join(screenshotDirectory, "two-videos-rest.png"),
    });

    // Fanned out, both cards are full rows with their own controls. The peek
    // is what there is to point at: the card's centre is behind the picture.
    await shell.mouse.move(
      (rest[1]?.x ?? 0) + (rest[1]?.width ?? 0) / 2,
      (rest[1]?.y ?? 0) + 2,
    );
    await expect(
      behind.getByRole("button", { name: "Play", exact: true }),
    ).toBeVisible();
    await expect(
      front.getByRole("button", { name: "Pause", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        behind.evaluate((element) => element.getBoundingClientRect().height),
      )
      .toBe(142);
    await expect
      .poll(() =>
        front.evaluate((element) =>
          element.parentElement!.hasAttribute("data-expanded"),
        ),
      )
      .toBe(false);
    const fanned = await Promise.all([
      front.boundingBox(),
      behind.boundingBox(),
    ]);
    expect((fanned[1]?.y ?? 0) + (fanned[1]?.height ?? 0)).toBeLessThanOrEqual(
      fanned[0]?.y ?? 0,
    );
    await settled(stack);
    await shell.screenshot({
      path: join(screenshotDirectory, "two-videos-fanned.png"),
    });

    // Playing the paused card pauses the other and hands it the picture.
    await behind.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(() => playingOf(firstTabId)).toBe(true);
    await expect.poll(() => playingOf(secondTabId)).toBe(false);
    await expect
      .poll(() =>
        secondPage
          .locator("#test-video")
          .evaluate((video) => (video as HTMLVideoElement).paused),
      )
      .toBe(true);
    await expect(shell.getByTestId(`media-video-${firstTabId}`)).toBeVisible();
    await expect(shell.getByTestId(`media-video-${secondTabId}`)).toHaveCount(
      0,
    );
    await expect(stack.locator(".media-card")).toHaveCount(2);
    const closing = shell.getByTestId(`media-card-${firstTabId}`);
    const survivor = shell.getByTestId(`media-card-${secondTabId}`);
    await closing.getByTestId(`media-identity-${firstTabId}`).hover();
    await settled(stack);
    const motion = shell.evaluate(
      ({ closingId, survivorId }) =>
        new Promise<Array<{ height: number; y: number }>>((done) => {
          const closing = document.querySelector(
            `[data-media-id="${closingId}"]`,
          )!;
          const survivor = document.querySelector(
            `[data-media-id="${survivorId}"]`,
          )!;
          const frames: Array<{ height: number; y: number }> = [];
          const start = performance.now();
          const sample = () => {
            frames.push({
              height: closing.getBoundingClientRect().height,
              y: survivor.getBoundingClientRect().y,
            });
            if (performance.now() - start < 650) requestAnimationFrame(sample);
            else done(frames);
          };
          requestAnimationFrame(sample);
        }),
      { closingId: firstTabId, survivorId: secondTabId },
    );
    await closing
      .getByRole("button", { name: "Dismiss media control" })
      .click();
    await expect(closing).toHaveCount(0);
    await expect(survivor).toBeVisible();
    const frames = await motion;
    const initialHeight = frames[0]!.height;
    expect(
      frames.some(
        (frame) => frame.height > 0 && frame.height < initialHeight - 1,
      ),
    ).toBe(true);
    expect(
      new Set(frames.map((frame) => Math.round(frame.y))).size,
    ).toBeGreaterThan(3);
    await settled(stack);
    await shell.screenshot({
      path: join(screenshotDirectory, "survivor-after-dismiss.png"),
    });
  } finally {
    for (const url of [MEDIA_URL, SECOND_URL]) {
      const page = app.windows().find((candidate) => candidate.url() === url);
      if (page !== undefined) {
        await page
          .evaluate(() => {
            (
              window as unknown as { stopTestVideo?: () => void }
            ).stopTestVideo?.();
          })
          .catch(() => undefined);
      }
    }
    await closeMediaApp(app);
  }
});

test("a video in a page's own floating miniplayer fills the sidebar card, not its corner", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-page-miniplayer-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }),
  );
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });

  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const originalTabId = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      const snapshot = await api.getSnapshot();
      await api.createTab("pistachio://demo/invoices?media-stack");
      if (snapshot.activeTabId === null) throw new Error("No original tab");
      return snapshot.activeTabId;
    });
    const mediaPage = await pageAt(app, MEDIA_URL);
    await installVideoPlayer(mediaPage);
    // YouTube's miniplayer: the player moved into a small fixed box in the
    // corner, with will-change: transform. That makes the box the containing
    // block of the video's position: fixed, which pinned the presented
    // picture to the box and left the card showing the page's top-left.
    await mediaPage.evaluate(() => {
      const box = document.createElement("div");
      box.style.cssText =
        "position:fixed;right:24px;bottom:24px;width:320px;height:180px;will-change:opacity,transform";
      box.append(document.getElementById("test-video")!);
      document.body.append(box);
    });
    await mediaPage.locator("#start-video").click();
    await expect
      .poll(() =>
        mediaPage
          .locator("#test-video")
          .evaluate((video) => (video as HTMLVideoElement).paused),
      )
      .toBe(false);
    const mediaTabId = await shell.evaluate(async () => {
      const snapshot = await (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.getSnapshot();
      return (
        snapshot.tabs.find(
          (tab) => tab.url === "pistachio://demo/invoices?media-stack",
        )?.id ?? ""
      );
    });

    await shell.evaluate(async (tabId) => {
      await (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.selectTab(tabId);
    }, originalTabId);
    await expect(shell.getByTestId(`media-video-${mediaTabId}`)).toBeVisible();
    await expect
      .poll(() =>
        mediaPage.evaluate(() =>
          document.documentElement.hasAttribute("data-pistachio-mini-video"),
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        mediaPage.locator("#test-video").evaluate((video) => {
          const rect = video.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: Math.round(rect.width) };
        }),
      )
      .toEqual({
        x: 0,
        y: 0,
        width: await mediaPage.evaluate(() => window.innerWidth),
      });
    await shell.screenshot({
      path: join(screenshotDirectory, "page-miniplayer-fills-card.png"),
    });
  } finally {
    await app.windows()
      .find((candidate) => candidate.url() === MEDIA_URL)
      ?.evaluate(() => {
        (window as unknown as { stopTestVideo?: () => void }).stopTestVideo?.();
      })
      .catch(() => undefined);
    await closeMediaApp(app);
  }
});

/**
 * A call page as Google Meet builds one: remote audio through an
 * `<audio srcObject>`, participant tiles as muted `<video srcObject>`, all
 * playing at once. Silent tones keep the run quiet; the elements are unmuted.
 */
async function installCallPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "join-call";
    button.textContent = "Join call";
    const timers: number[] = [];
    const tracks: MediaStreamTrack[] = [];
    button.addEventListener("click", () => {
      const context = new AudioContext();
      const tone = context.createOscillator();
      const silence = context.createGain();
      silence.gain.value = 0;
      const remote = context.createMediaStreamDestination();
      tone.connect(silence).connect(remote);
      tone.start();
      tracks.push(...remote.stream.getTracks());
      const audio = document.createElement("audio");
      audio.id = "call-audio";
      audio.srcObject = remote.stream;
      document.body.append(audio);
      void audio.play();
      for (let index = 0; index < 2; index += 1) {
        const canvas = document.createElement("canvas");
        canvas.width = 160;
        canvas.height = 90;
        const context2d = canvas.getContext("2d");
        if (context2d === null) throw new Error("Canvas is unavailable");
        timers.push(
          window.setInterval(() => {
            context2d.fillStyle = `hsl(${String(Date.now() % 360)} 50% 40%)`;
            context2d.fillRect(0, 0, canvas.width, canvas.height);
          }, 50),
        );
        const stream = canvas.captureStream(15);
        tracks.push(...stream.getTracks());
        const tile = document.createElement("video");
        tile.muted = true;
        tile.srcObject = stream;
        tile.style.width = "160px";
        document.body.append(tile);
        void tile.play();
      }
    });
    document.body.prepend(button);
    (window as unknown as { stopTestVideo: () => void }).stopTestVideo = () => {
      for (const timer of timers) window.clearInterval(timer);
      for (const track of tracks) track.stop();
    };
  });
}

test("a call's live audio never blinks a card in the stack, and a granted call has none", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-live-call-"));
  const origin = new URL(AUDIO_URL).origin;
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }),
  );
  await writeFile(
    join(userData, "enterprise-policy.json"),
    JSON.stringify({
      version: 1,
      rules: [
        {
          pattern: origin,
          permissions: { camera: "allow", microphone: "allow" },
        },
      ],
    }),
  );
  const app = await electron.launch({
    // A synthetic camera and microphone: no device, no system prompt.
    args: [".", "--use-fake-device-for-media-stream"],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });

  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const originalTabId = await shell.evaluate(async (url) => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      const snapshot = await api.getSnapshot();
      await api.createTab(url);
      if (snapshot.activeTabId === null) throw new Error("No original tab");
      return snapshot.activeTabId;
    }, AUDIO_URL);
    const callPage = await pageAt(app, AUDIO_URL);
    const callTabId = await shell.evaluate(async (url) => {
      const snapshot = await (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.getSnapshot();
      return snapshot.tabs.find((tab) => tab.url === url)?.id ?? "";
    }, AUDIO_URL);
    const select = (tabId: string) =>
      shell.evaluate(async (id) => {
        await (
          window as unknown as { pistachio: PistachioApi }
        ).pistachio.selectTab(id);
      }, tabId);
    const card = shell.getByTestId(`media-card-${callTabId}`);
    const sample = async (): Promise<boolean[]> => {
      const seen: boolean[] = [];
      for (let index = 0; index < 24; index += 1) {
        seen.push((await card.count()) > 0);
        await shell.waitForTimeout(250);
      }
      return seen;
    };

    await installCallPage(callPage);
    await callPage.locator("#join-call").click();
    await select(originalTabId);

    // Before any capture grant, the live audio is an ordinary stream: its
    // card comes and then stays. The muted tiles beside it used to take the
    // tab's pick back every few seconds, hiding the card each time.
    await expect(card).toBeVisible();
    expect(await sample()).not.toContain(false);
    await expect
      .poll(() =>
        shell.evaluate(async (tabId) => {
          const media = await (
            window as unknown as { pistachio: PistachioApi }
          ).pistachio.getMedia();
          const item = media.find((candidate) => candidate.tabId === tabId);
          return item === undefined
            ? null
            : { hasVideo: item.hasVideo, stream: item.stream, call: item.call };
        }, callTabId),
      )
      .toEqual({ hasVideo: false, stream: true, call: false });

    // Joining with the camera and microphone makes it a call: main still
    // knows the media, but the stack offers no player for it. The card's
    // exit runs out first, or the samples below would catch it leaving.
    await select(callTabId);
    await expect(shell.getByTestId("media-stack")).toHaveCount(0);
    await callPage.evaluate(async () => {
      const local = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
      const self = document.createElement("video");
      self.muted = true;
      self.srcObject = local;
      document.body.append(self);
      await self.play();
      const stop = (window as unknown as { stopTestVideo: () => void })
        .stopTestVideo;
      (window as unknown as { stopTestVideo: () => void }).stopTestVideo =
        () => {
          stop();
          for (const track of local.getTracks()) track.stop();
        };
    });
    await expect
      .poll(() =>
        shell.evaluate(async (tabId) => {
          const media = await (
            window as unknown as { pistachio: PistachioApi }
          ).pistachio.getMedia();
          return media.find((item) => item.tabId === tabId)?.call ?? null;
        }, callTabId),
      )
      .toBe(true);
    await select(originalTabId);
    expect(await sample()).not.toContain(true);
    await expect(shell.getByTestId("media-stack")).toHaveCount(0);
    await shell.screenshot({
      path: join(screenshotDirectory, "call-has-no-card.png"),
    });
  } finally {
    await callPageCleanup(app);
    await closeMediaApp(app);
  }
});

async function callPageCleanup(app: ElectronApplication): Promise<void> {
  const page = app.windows().find((candidate) => candidate.url() === AUDIO_URL);
  await page
    ?.evaluate(() => {
      (window as unknown as { stopTestVideo?: () => void }).stopTestVideo?.();
    })
    .catch(() => undefined);
}
