import { stat } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect, test, type Browser, type ElectronApplication, type Page } from "@playwright/test";
import { BUILTIN_BACKGROUNDS } from "@pistachio/live-share/effects";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { LiveShareState } from "@pistachio/shell-contracts/live-share";
import { captureEnabled } from "./app";
import { imageColour, isBlurred, isPlainCamera, lookOf, savePicture, showsScene, type Look } from "./camera-look";
import { launchDesk, snapshot } from "./desk-harness";
import { knock, linkToken, poll, serveFakeGuest, startLiveControl, type GuestSite, type LiveControl } from "./live-host-harness";
import { startLiveKit, type LiveKitServer } from "./livekit-harness";

/**
 * The host camera's background, for real (docs/live-share.md §1 The host's
 * "background"): in the packaged app's loading path — the live-host page
 * from `pistachio-app://live-host`, its segmenter's WASM and model from the
 * build's own `out/renderer/live/mediapipe/`, under a policy that lets only
 * that page compile WebAssembly — choosing Blur and then a scene on the Live
 * card puts them behind the host on the camera a guest receives.
 *
 * The app runs on Chromium's fake camera (`--use-fake-device-for-media-stream`),
 * which answers a tab capture with "Requested device not found": so the
 * shared space holds only the home page, a shell-drawn window (its picture
 * cut from a capture of the shell's own page, docs/live-share.md §6.6), and
 * no page's tab is captured; the camera is what is watched. The guest is the fake
 * guest page (live-host-harness.ts) watching the host's camera; the fake
 * camera has no person in it, so the segmenter takes the whole picture for
 * background (camera-look.ts says how each effect shows). Skipped without
 * `livekit-server` on PATH.
 */

type Bridge = { pistachio: PistachioApi };

interface FakeGuest {
  join(url: string, token: string): Promise<string>;
  watchCamera(identity: string): void;
}

const HOME = "pistachio://home/";
const CAMERA = 'video[data-camera="host"]';

const liveShare = (shell: Page): Promise<LiveShareState> => shell.evaluate(() => (window as unknown as Bridge).pistachio.getLiveShare());
const command = (shell: Page, body: Parameters<PistachioApi["liveShare"]>[0]): Promise<void> => shell.evaluate((input) => (window as unknown as Bridge).pistachio.liveShare(input), body);

const screenshots = join(process.cwd(), "e2e/screenshots/live-share-backgrounds");

test.describe.serial("live share: the host camera's background, as a guest sees it", { tag: ["@share"] }, () => {
  let livekit: LiveKitServer;
  let control: LiveControl;
  let guestSite: GuestSite;
  let browser: Browser;
  let app: ElectronApplication;
  let shell: Page;
  let host: Page;
  let guest: Page;
  let plain: Look;
  const hostErrors: string[] = [];
  const hostRequests: string[] = [];

  const card = () => shell.getByTestId("live-card");
  const seen = async (test: (look: Look) => boolean): Promise<boolean> => {
    const look = await lookOf(guest, CAMERA);
    return look !== null && test(look);
  };

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    livekit = await startLiveKit();
    control = await startLiveControl(livekit);
    guestSite = await serveFakeGuest();
    browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
    guest = await (await browser.newContext()).newPage();
    await guest.goto(guestSite.url);
    await guest.waitForFunction(() => "guest" in window);
    ({ app, shell } = await launchDesk({
      name: "live-share-backgrounds",
      homeUrl: HOME,
      args: ["--use-mock-keychain", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
      env: { PISTACHIO_E2E: "0", PISTACHIO_CONTROL_URL: control.url, PISTACHIO_ANONYMOUS: "1" },
    }));
  });

  test.afterAll(async () => {
    await app?.close();
    await browser?.close();
    await guestSite?.close();
    await control?.close();
    await livekit?.stop();
  });

  test("the live-host page loads as packaged, from its own origin, and alone may compile WebAssembly", async () => {
    test.setTimeout(60_000);
    // The build put the segmenter's files beside the page (electron-builder packs all of out/).
    const renderer = join(process.cwd(), "out/renderer");
    for (const file of ["live-host.html", "live/mediapipe/wasm/vision_wasm_internal.js", "live/mediapipe/wasm/vision_wasm_internal.wasm", "live/mediapipe/selfie_segmenter.tflite"]) {
      expect((await stat(join(renderer, file))).size).toBeGreaterThan(0);
    }

    const groupId = (await snapshot(shell)).currentGroupId!;
    await command(shell, { type: "start", groupId, hostName: "Zach" });
    await expect.poll(async () => (await liveShare(shell)).status, { timeout: 20_000 }).toBe("live");
    await expect.poll(() => app.windows().some((page) => page.url().endsWith("#live-host"))).toBe(true);
    host = app.windows().find((page) => page.url().endsWith("#live-host"))!;
    host.on("request", (request) => hostRequests.push(request.url()));
    host.on("console", (message) => {
      if (message.type() === "error") hostErrors.push(message.text());
      if (message.text().startsWith("[live-host]")) console.info(message.text());
    });
    expect(host.url()).toBe("pistachio-app://live-host/live-host.html#live-host");
    await expect(host.locator("body[data-live-host='ready']")).toHaveCount(1);
    await expect.poll(async () => (await liveShare(shell)).connection, { timeout: 20_000 }).toBe("connected");

    const policy = (page: Page): Promise<string> => page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "");
    expect(await policy(host)).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(await policy(shell)).toContain("script-src 'self';");
    expect(await policy(shell)).not.toContain("wasm-unsafe-eval");
    // Nothing outside the renderer's folder is served on that origin (out/main/index.js is right beside it).
    expect(await host.evaluate(() => fetch("/..%2Fmain%2Findex.js").then((response) => response.status))).toBe(404);
  });

  test("a guest sees the host's camera come on as it is", async () => {
    test.setTimeout(60_000);
    const token = linkToken((await liveShare(shell)).link!);
    const request = await knock(control.url, token, "Ann");
    await expect.poll(async () => (await liveShare(shell)).knocks.map((knocked) => knocked.requestId), { timeout: 8_000 }).toContain(request.requestId);
    await command(shell, { type: "admit", requestId: request.requestId });
    await expect.poll(async () => (await poll(control.url, token, request)).status).toBe("admitted");
    const { livekit: ticket } = await poll(control.url, token, request);
    await guest.evaluate(([url, key]) => (window as unknown as { guest: FakeGuest }).guest.join(url, key), [ticket!.url, ticket!.token] as const);
    await guest.evaluate(() => (window as unknown as { guest: FakeGuest }).guest.watchCamera("host"));

    // The Live pill's press: the card comes up over the desk.
    await host.evaluate(() => (window as unknown as Bridge).pistachio.sendLiveHostReport({ type: "openCard" }));
    await expect(card()).toHaveAttribute("data-shown", "");
    await card().getByTestId("live-camera").click();
    await expect.poll(async () => (await liveShare(shell)).local.camera).toBe(true);
    await expect.poll(() => seen(isPlainCamera), { timeout: 20_000 }).toBe(true);
    plain = (await lookOf(guest, CAMERA))!;
  });

  test("Blur on the Live card blurs it for the guest, and a scene replaces it", async () => {
    test.setTimeout(60_000);
    const errors = hostErrors.length;
    const swatch = (key: string) => card().getByTestId(`live-background-${key}`);
    await expect(swatch("blur")).toBeEnabled();

    await swatch("blur").click();
    await expect(swatch("blur")).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => seen((look) => isBlurred(look, plain)), { timeout: 30_000 }).toBe(true);
    if (captureEnabled) {
      await savePicture(guest, CAMERA, join(screenshots, "01-guest-sees-host-blurred.png"));
      await card().screenshot({ path: join(screenshots, "01b-live-card-blur.png") });
    }

    const dusk = BUILTIN_BACKGROUNDS.find((background) => background.label === "Dusk")!;
    await swatch("Dusk").click();
    await expect(swatch("Dusk")).toHaveAttribute("aria-checked", "true");
    const colour = await imageColour(guest, dusk.url);
    await expect.poll(() => seen((look) => showsScene(look, colour, plain)), { timeout: 20_000 }).toBe(true);
    if (captureEnabled) await savePicture(guest, CAMERA, join(screenshots, "02-guest-sees-host-dusk.png"));

    await swatch("none").click();
    await expect.poll(() => seen(isPlainCamera), { timeout: 20_000 }).toBe(true);
    // Nothing failed on the way (a background that did not take comes with why, main naming the one the camera shows instead).
    expect((await liveShare(shell)).error).toBeNull();
    expect(hostErrors.slice(errors)).toEqual([]);

    // The segmenter came from the page's own origin: the build's files, through the live-host session's handler.
    console.info(`[live-share-backgrounds] the live-host page asked for ${JSON.stringify(hostRequests.filter((url) => !url.includes("/assets/")))}`);
    for (const file of ["wasm/vision_wasm_internal.js", "wasm/vision_wasm_internal.wasm", "selfie_segmenter.tflite"]) expect(hostRequests).toContain(`pistachio-app://live-host/live/mediapipe/${file}`);
    expect(hostRequests.filter((url) => /^https?:/u.test(url) && !["127.0.0.1", "localhost"].includes(new URL(url).hostname))).toEqual([]);
  });
});
