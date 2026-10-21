import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test, type Browser, type ElectronApplication, type Page } from "@playwright/test";
import type { LiveHostReport, LiveShareState } from "@pistachio/shell-contracts/live-share";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { captureEnabled } from "./app";
import { createGroup, launchDesk, openFeel, openMore, railSpace, selectSpace, settled, showFrame, snapshot, tabGroupCommand, windowSelector } from "./desk-harness";
import { knock, linkToken, serveFakeGuest, startLiveControl, type GuestSite, type LiveControl } from "./live-host-harness";
import { startLiveKit, type LiveKitServer } from "./livekit-harness";

/**
 * Windows the shell draws, live for guests (docs/live-share.md §6.6): a
 * space holding a terminal (⌘J) and the home page, shared for real — control
 * in process, a spawned `livekit-server`, a fake guest on
 * `@pistachio/live-share/room` alone. The live-host app captures the shell's
 * own page and cuts each window's page box out of it: the guest receives the
 * terminal as `win:<tab>` at its page box's shape, its pixels the
 * terminal's (a line printed on a colour nothing else has, found where the
 * shell draws it), and the home window as its own. Anything of the shell's
 * over the whole desk holds both pictures — the address palette (⌘L), a
 * context menu — the frame says `paused`, and nothing new comes, only the
 * last picture again once a second: a guest who joins under the palette is
 * shown that, not the palette; closed, they run again; so in another space.
 * Something whose box is known holds only the window it lies over: the Live
 * card beside the terminal holds the home window under it and the terminal's
 * picture runs on, chat and all; a frame button's tooltip holds its own
 * window alone. And the word that
 * something covers the terminal held back in main for 200 ms changes
 * nothing a guest sees: every frame bears the mark of the report it was
 * painted under and is cut only by that report's word, so not one frame of
 * the palette reaches the guest. A participant the host never let in gets
 * no picture of them. The terminal carried across a green desk, alone on it
 * (a person's hand: the pointer moved every frame): no crop the live-host
 * app cuts, nor any frame the guest shows, has green at its edges — carried
 * lifted (grown and turned with the throw) its picture is held, carried as
 * it is it runs on while it moves, and home's with it. Skipped without
 * `livekit-server` on PATH.
 */

const SPACE = "pairing";
/** The terminal's line, on a colour nothing else on the desk has: rgb(255, 0, 170). */
const MARK = String.raw`printf '\e[48;2;255;0;170m%s\e[0m\n' "                    LIVE-SHELL-WINDOWS                    "`;

type Bridge = { pistachio: PistachioApi };

interface Inbound {
  topic: string;
  body: Record<string, unknown>;
  from: { identity: string | null; role: string };
  at: number;
}

interface FakeGuest {
  join(url: string, token: string): Promise<string>;
  inbox(topic?: string): Inbound[];
  send(topic: string, body: unknown): Promise<void>;
  watch(windowId: string, width: number, height: number): void;
  picture(): { frames: number; width: number; height: number; tracks: number; blanks: number };
  ended(): string | null;
}

interface DeskWindow {
  id: string;
  kind: string;
  track: string | null;
  paused: boolean;
  page: { x: number; y: number; w: number; h: number };
}

/** A region of a picture, as fractions of its width and height. */
interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

const liveShare = (shell: Page): Promise<LiveShareState> => shell.evaluate(() => (window as unknown as Bridge).pistachio.getLiveShare());
const command = (shell: Page, body: Parameters<PistachioApi["liveShare"]>[0]): Promise<void> => shell.evaluate((input) => (window as unknown as Bridge).pistachio.liveShare(input), body);

/** The fake guest on `page` (live-host-harness.ts). */
type GuestWindow = { guest: FakeGuest };
const joinRoom = (page: Page, ticket: { url: string; token: string }): Promise<string> => page.evaluate(({ url, token }) => (window as unknown as GuestWindow).guest.join(url, token), ticket);
const watch = (page: Page, windowId: string, width: number, height: number): Promise<void> =>
  page.evaluate(([id, w, h]) => (window as unknown as GuestWindow).guest.watch(id, w, h), [windowId, width, height] as const);
const pictureOn = (page: Page): Promise<ReturnType<FakeGuest["picture"]>> => page.evaluate(() => (window as unknown as GuestWindow).guest.picture());

/** What the terminal shows, as the shell's registry has it (lib/terminal/sessions.ts's e2e hook). */
function terminalText(shell: Page, id: string): Promise<string> {
  return shell.evaluate((terminal) => String((globalThis as unknown as { __pistachioTerminals?: Record<string, (id: string) => unknown> }).__pistachioTerminals?.["text"]?.(terminal) ?? ""), id);
}

/** Where rgb(255, 0, 170) lies in an RGBA picture, as fractions of it; null if it is not there. */
const MAGENTA_IN = `function magentaIn(data, width, height) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const at = (y * width + x) * 4;
    if (data[at] > 200 && data[at + 1] < 80 && data[at + 2] > 120 && data[at + 2] < 220) {
      count += 1; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return count < 50 ? null : { x: minX / width, y: minY / height, w: (maxX - minX + 1) / width, h: (maxY - minY + 1) / height };
}`;

/** How a region (fractions) of an RGBA picture looks: its mean brightness, and their spread. */
const LOOK_OF = `function lookOf(data, width, height, region) {
  const x0 = Math.floor(region.x * width), y0 = Math.floor(region.y * height);
  const x1 = Math.ceil((region.x + region.w) * width), y1 = Math.ceil((region.y + region.h) * height);
  let sum = 0, squares = 0, count = 0;
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
    const at = (y * width + x) * 4;
    const value = 0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2];
    sum += value; squares += value * value; count += 1;
  }
  const mean = sum / Math.max(1, count);
  return { mean: Math.round(mean), spread: Math.round(Math.sqrt(Math.max(0, squares / Math.max(1, count) - mean * mean))) };
}`;

/** A region of the guest's video (the fake guest's one watched window), as LOOK_OF says. */
function lookOnGuest(guest: Page, region: Region): Promise<{ mean: number; spread: number }> {
  return guest.evaluate(
    ([finder, area]) => {
      const video = document.querySelector("video")!;
      const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(video, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      return (new Function(`return (${finder})`)() as (data: Uint8ClampedArray, width: number, height: number, region: Region) => { mean: number; spread: number })(pixels, canvas.width, canvas.height, area);
    },
    [LOOK_OF, region] as const,
  );
}

/**
 * From now on, the look of `region` of every frame the guest's video shows
 * (its one watched window), with when it was shown: `window.__looks`.
 */
function lookAtEveryFrame(guest: Page, region: Region): Promise<void> {
  return guest.evaluate(
    ([finder, area]) => {
      const video = document.querySelector("video")!;
      const looks: Array<{ at: number; mean: number }> = [];
      (window as unknown as { __looks: typeof looks }).__looks = looks;
      const lookOf = new Function(`return (${finder})`)() as (data: Uint8ClampedArray, width: number, height: number, region: Region) => { mean: number; spread: number };
      const canvas = new OffscreenCanvas(2, 2);
      const look = (): void => {
        if (video.videoWidth > 0) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const context = canvas.getContext("2d", { willReadFrequently: true })!;
          context.drawImage(video, 0, 0);
          looks.push({ at: Date.now(), mean: lookOf(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, area).mean });
        }
        video.requestVideoFrameCallback(look);
      };
      video.requestVideoFrameCallback(look);
    },
    [LOOK_OF, region] as const,
  );
}

const looksSince = (guest: Page, since: number): Promise<Array<{ at: number; mean: number }>> =>
  guest.evaluate((from) => (window as unknown as { __looks: Array<{ at: number; mean: number }> }).__looks.filter((look) => look.at >= from), since);

/**
 * From now on, when the live-host app read a frame of the shell's picture (the
 * one copy it takes of each, its mark's few pixels) and when it cut a window
 * out of one (a frame made of a frame's region): `window.__shellFrames`.
 */
function countShellFrames(host: Page): Promise<void> {
  return host.evaluate(() => {
    const seen = { reads: [] as number[], cuts: [] as number[] };
    (window as unknown as { __shellFrames: typeof seen }).__shellFrames = seen;
    const copyTo = VideoFrame.prototype.copyTo;
    VideoFrame.prototype.copyTo = function (this: VideoFrame, ...args: Parameters<VideoFrame["copyTo"]>) {
      seen.reads.push(Date.now());
      return copyTo.apply(this, args);
    };
    window.VideoFrame = new Proxy(VideoFrame, {
      construct(target, args: ConstructorParameters<typeof VideoFrame>) {
        if ((args[1] as VideoFrameInit | undefined)?.visibleRect !== undefined) seen.cuts.push(Date.now());
        return Reflect.construct(target, args) as VideoFrame;
      },
    });
  });
}

const shellFramesBetween = (host: Page, from: number, to: number): Promise<{ reads: number; cuts: number }> =>
  host.evaluate(
    ([start, end]) => {
      const seen = (window as unknown as { __shellFrames: { reads: number[]; cuts: number[] } }).__shellFrames;
      const within = (at: number): boolean => at >= start && at <= end;
      return { reads: seen.reads.filter(within).length, cuts: seen.cuts.filter(within).length };
    },
    [from, to] as const,
  );

/**
 * Main's handling of the shell's desk reports held back `ms` each (null: as it
 * was): the word that something covers the desk late, as a stalled main
 * would have it — the order kept, nothing dropped.
 */
function holdBackReports(app: ElectronApplication, ms: number | null): Promise<void> {
  return app.evaluate(
    ({ ipcMain }, { channel, wait }) => {
      type Listener = (...args: unknown[]) => void;
      const kept = globalThis as { __liveDeskListeners?: Listener[] };
      const now = ipcMain.listeners(channel) as Listener[];
      for (const listener of now) ipcMain.removeListener(channel, listener);
      if (wait === null) {
        for (const listener of kept.__liveDeskListeners ?? now) ipcMain.on(channel, listener);
        delete kept.__liveDeskListeners;
        return;
      }
      kept.__liveDeskListeners = now;
      ipcMain.on(channel, (...args: unknown[]) => void setTimeout(() => now.forEach((listener) => listener(...args)), wait));
    },
    { channel: "pistachio:live-desk-set", wait: ms },
  );
}

/** A region of a box of the browser window's own picture (what the Mac shows, the live-host window aside), as LOOK_OF says. */
function lookOnHost(app: ElectronApplication, box: { x: number; y: number; w: number; h: number }, region: Region): Promise<{ mean: number; spread: number }> {
  return app.evaluate(async ({ BrowserWindow }, { box: rect, area, finder }) => {
    const main = BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().endsWith("#live-host"))!;
    const image = await main.webContents.capturePage({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.w), height: Math.round(rect.h) });
    const { width, height } = image.getSize();
    const bgra = image.toBitmap();
    const rgba = new Uint8ClampedArray(bgra.length);
    for (let at = 0; at < bgra.length; at += 4) {
      rgba[at] = bgra[at + 2]!;
      rgba[at + 1] = bgra[at + 1]!;
      rgba[at + 2] = bgra[at]!;
      rgba[at + 3] = 255;
    }
    return (new Function(`return (${finder})`)() as (data: Uint8ClampedArray, width: number, height: number, region: Region) => { mean: number; spread: number })(rgba, width, height, area);
  }, { box, area: region, finder: LOOK_OF });
}

/** The line as a guest's video shows it (the fake guest's one watched window). */
function lineOnGuestPage(guest: Page): Promise<Region | null> {
  return guest.evaluate((finder) => {
    const video = document.querySelector("video");
    if (video === null || video.videoWidth === 0) return null;
    const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(video, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return (new Function(`return (${finder})`)() as (data: Uint8ClampedArray, width: number, height: number) => Region | null)(pixels, canvas.width, canvas.height);
  }, MAGENTA_IN);
}

/** The line as the shell draws it, in the terminal's page box (the browser window's own picture of it). */
function lineOnHost(app: ElectronApplication, box: { x: number; y: number; w: number; h: number }): Promise<Region | null> {
  return app.evaluate(async ({ BrowserWindow }, { box: rect, finder }) => {
    const main = BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().endsWith("#live-host"))!;
    const image = await main.webContents.capturePage({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.w), height: Math.round(rect.h) });
    const { width, height } = image.getSize();
    const bgra = image.toBitmap();
    const rgba = new Uint8ClampedArray(bgra.length);
    for (let at = 0; at < bgra.length; at += 4) {
      rgba[at] = bgra[at + 2]!;
      rgba[at + 1] = bgra[at + 1]!;
      rgba[at + 2] = bgra[at]!;
      rgba[at + 3] = 255;
    }
    return (new Function(`return (${finder})`)() as (data: Uint8ClampedArray, width: number, height: number) => Region | null)(rgba, width, height);
  }, { box, finder: MAGENTA_IN });
}

/**
 * The desk's ground in a colour nothing on it has, its well's shading off,
 * and every window on it but `alone` hidden (null: as it was): a pixel of
 * that green in the window's picture lay beside the window.
 */
function greenDesk(shell: Page, alone: string | null): Promise<void> {
  return shell.evaluate((tabId) => {
    document.getElementById("e2e-green-desk")?.remove();
    if (tabId === null) return;
    const style = document.createElement("style");
    style.id = "e2e-green-desk";
    style.textContent = `.desk-stage { background: rgb(0, 255, 0) !important; } .desk-stage::before { display: none !important; } [data-testid="desk-window"]:not([data-tab-id="${tabId}"]) { visibility: hidden !important; }`;
    document.head.append(style);
  }, alone);
}

/** A crop the live-host app cut out of the shell's picture: when, its region of the frame, and how many samples along its edges are the desk's green (-1: unreadable). */
interface CropSeen {
  at: number;
  rect: { x: number; y: number; width: number; height: number };
  green: number;
}

/**
 * From now on, every picture the live-host app cuts out of the shell's (a
 * frame made of a frame's region), as `window.__crops`: when, the region,
 * and how many samples along its edges are the desk's green — the chroma of
 * the region's two outermost rows and columns in the frame it is cut from
 * (I420 or NV12: a sample for 2 × 2 pixels; green lies far below the middle
 * in both, anything grey at it), less `corner` CSS px at each end, where a
 * window's corners are rounded. And when it read a frame's mark (a copy of
 * a few pixels): `window.__markReads`.
 */
function watchCrops(host: Page, corner: number): Promise<void> {
  return host.evaluate((cornerCss) => {
    type Rect = { x: number; y: number; width: number; height: number };
    const crops: Array<{ at: number; rect: Rect; green: number }> = [];
    const markReads: number[] = [];
    (window as unknown as { __crops: typeof crops; __markReads: number[] }).__crops = crops;
    (window as unknown as { __markReads: number[] }).__markReads = markReads;
    const copyTo = VideoFrame.prototype.copyTo;
    VideoFrame.prototype.copyTo = function (this: VideoFrame, ...args: Parameters<VideoFrame["copyTo"]>) {
      const rect = (args[1] as { rect?: Rect } | undefined)?.rect;
      if (rect !== undefined && rect.width <= 32 && rect.height <= 16) markReads.push(Date.now());
      return copyTo.apply(this, args);
    };
    const greenIn = async (frame: VideoFrame, rect: Rect): Promise<number> => {
      if (rect.width < 2 || rect.height < 2) return 0;
      const buffer = new Uint8Array(frame.allocationSize({ rect }));
      const planes = await frame.copyTo(buffer, { rect });
      let green = 0;
      for (let y = 0; y < rect.height / 2; y += 1)
        for (let x = 0; x < rect.width / 2; x += 1) {
          let u: number;
          let v: number;
          if (frame.format === "NV12") {
            const at = planes[1]!.offset + y * planes[1]!.stride + x * 2;
            u = buffer[at]!;
            v = buffer[at + 1]!;
          } else if (frame.format === "I420" || frame.format === "I420A") {
            u = buffer[planes[1]!.offset + y * planes[1]!.stride + x]!;
            v = buffer[planes[2]!.offset + y * planes[2]!.stride + x]!;
          } else return -1;
          if (u < 110 && v < 110) green += 1;
        }
      return green;
    };
    window.VideoFrame = new Proxy(window.VideoFrame, {
      construct(target, args: ConstructorParameters<typeof VideoFrame>) {
        const made = Reflect.construct(target, args) as VideoFrame;
        const rect = (args[1] as VideoFrameInit | undefined)?.visibleRect as Rect | undefined;
        if (rect === undefined || !(args[0] instanceof target)) return made;
        const source = (args[0] as VideoFrame).clone();
        const at = Date.now();
        const inset = Math.ceil((cornerCss * source.visibleRect!.width) / window.innerWidth / 2) * 2;
        const along = Math.max(0, rect.width - inset * 2);
        const tall = Math.max(0, rect.height - inset * 2);
        const edges: Rect[] = [
          { x: rect.x + inset, y: rect.y, width: along, height: 2 },
          { x: rect.x + inset, y: rect.y + rect.height - 2, width: along, height: 2 },
          { x: rect.x, y: rect.y + inset, width: 2, height: tall },
          { x: rect.x + rect.width - 2, y: rect.y + inset, width: 2, height: tall },
        ];
        void Promise.all(edges.map((edge) => greenIn(source, edge)))
          .then(
            (counts) => crops.push({ at, rect: { ...rect }, green: counts.includes(-1) ? -1 : counts.reduce((sum, count) => sum + count, 0) }),
            () => crops.push({ at, rect: { ...rect }, green: -1 }),
          )
          .finally(() => source.close());
        return made;
      },
    });
  }, corner);
}

const cropsBetween = (host: Page, from: number, to: number): Promise<CropSeen[]> =>
  host.evaluate(([start, end]) => (window as unknown as { __crops: CropSeen[] }).__crops.filter((crop) => crop.at >= start && crop.at <= end), [from, to] as const);

const markReadsBetween = (host: Page, from: number, to: number): Promise<number> =>
  host.evaluate(([start, end]) => (window as unknown as { __markReads: number[] }).__markReads.filter((at) => at >= start && at <= end).length, [from, to] as const);

/**
 * From now on, every frame the guest's video shows (its one watched window),
 * as `window.__edges`: when, and how many pixels of its two outermost rows
 * and columns — less `share` of its width at each end — are the desk's green
 * as decoded (green well over red and blue).
 */
function watchGuestEdges(guest: Page, share: number): Promise<void> {
  return guest.evaluate((corner) => {
    const video = document.querySelector("video")!;
    const edges: Array<{ at: number; green: number }> = [];
    (window as unknown as { __edges: typeof edges }).__edges = edges;
    const canvas = new OffscreenCanvas(2, 2);
    const look = (): void => {
      const { videoWidth: width, videoHeight: height } = video;
      if (width > 8 && height > 8) {
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        context.drawImage(video, 0, 0);
        const inset = Math.ceil(width * corner);
        const strips = [
          context.getImageData(inset, 0, width - inset * 2, 2),
          context.getImageData(inset, height - 2, width - inset * 2, 2),
          context.getImageData(0, inset, 2, height - inset * 2),
          context.getImageData(width - 2, inset, 2, height - inset * 2),
        ];
        let green = 0;
        for (const { data } of strips) for (let at = 0; at < data.length; at += 4) if (data[at + 1]! - Math.max(data[at]!, data[at + 2]!) > 60) green += 1;
        edges.push({ at: Date.now(), green });
      }
      video.requestVideoFrameCallback(look);
    };
    video.requestVideoFrameCallback(look);
  }, share);
}

const guestEdgesBetween = (guest: Page, from: number, to: number): Promise<Array<{ at: number; green: number }>> =>
  guest.evaluate(([start, end]) => (window as unknown as { __edges: Array<{ at: number; green: number }> }).__edges.filter((edge) => edge.at >= start && edge.at <= end), [from, to] as const);

const screenshots = join(process.cwd(), "e2e/screenshots/live-share-shell-windows");

/** A window's video on the fake guest's page: its page box's shape, as large as the page's 1280 × 1000 holds. */
function fitted(page: { w: number; h: number }): [number, number] {
  const scale = Math.min(1260 / page.w, 980 / page.h);
  return [Math.round(page.w * scale), Math.round(page.h * scale)];
}

test.describe.serial("live share: windows the shell draws, live for guests", { tag: ["@share"] }, () => {
  let livekit: LiveKitServer;
  let control: LiveControl;
  let guestSite: GuestSite;
  let browser: Browser;
  let app: ElectronApplication;
  let shell: Page;
  let host: Page;
  let guest: Page;
  let homeId: string;
  let terminalTab: string;
  let terminalId: string;
  let token: string;

  const inbox = (topic: string): Promise<Inbound[]> => guest.evaluate((name) => (window as unknown as GuestWindow).guest.inbox(name), topic);
  /** The desk as the guest has it last: the newest of the frames and the sync's (the room as it was when they said hello). */
  const lastDesk = async (): Promise<{ seq: number; hostPresent: boolean; windows: DeskWindow[] } | null> => {
    type Frame = { seq: number; hostPresent: boolean; windows: DeskWindow[] };
    const frames = [...(await inbox("lv.desk")).map((message) => message.body as unknown as Frame), ...(await inbox("lv.sync")).map((message) => message.body["desk"] as Frame | null)];
    return frames.filter((frame): frame is Frame => frame !== null && frame !== undefined).sort((a, b) => a.seq - b.seq).at(-1) ?? null;
  };
  const deskWindow = async (id: string): Promise<DeskWindow | null> => (await lastDesk())?.windows.find((window) => window.id === id) ?? null;
  /** Main hears this from the live-host app, as it would from its own pieces (the Live pill pressed: `openCard`). */
  const hostReport = (report: LiveHostReport): Promise<void> => host.evaluate((body) => (window as unknown as { pistachio: { sendLiveHostReport(report: unknown): void } }).pistachio.sendLiveHostReport(body), report);
  const picture = (): Promise<ReturnType<FakeGuest["picture"]>> => pictureOn(guest);

  /** The terminal's picture is held: the frame says so, and nothing new of it reaches the guest for a second — its last picture again, once a second. */
  async function held(what: string): Promise<void> {
    await expect.poll(async () => (await deskWindow(terminalTab))?.paused, { timeout: 5_000, message: `the terminal paused under ${what}` }).toBe(true);
    // (Frames already on their way when it paused may still land: count from a moment after.)
    await new Promise((done) => setTimeout(done, 300));
    const before = (await picture()).frames;
    await new Promise((done) => setTimeout(done, 1_000));
    const after = (await picture()).frames;
    console.info(`[live-share-shell-windows] under ${what}: ${String(after - before)} frames of the terminal in 1 s`);
    // (Its last picture again, once a second: two at most in a second's count. Running, it sends 25–30.)
    expect(after - before).toBeLessThanOrEqual(2);
  }

  /** The terminal's picture runs again: the frame says so, and new frames come. */
  async function running(what: string): Promise<void> {
    await expect.poll(async () => (await deskWindow(terminalTab))?.paused, { timeout: 5_000, message: `the terminal running after ${what}` }).toBe(false);
    const before = (await picture()).frames;
    await expect.poll(async () => (await picture()).frames, { timeout: 10_000, message: `new frames after ${what}` }).toBeGreaterThan(before + 5);
  }

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    livekit = await startLiveKit();
    control = await startLiveControl(livekit);
    guestSite = await serveFakeGuest();
    browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    guest = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
    await guest.goto(guestSite.url);
    await guest.waitForFunction(() => "guest" in window);
    // zsh pointed at an empty folder: its own prompt, nothing of the person's (as terminal.spec does).
    const zdotdir = await realpath(await mkdtemp(join(tmpdir(), "live-shell-zsh-")));
    await writeFile(join(zdotdir, ".zshrc"), "bindkey -e\nPROMPT='%% '\n");
    ({ app, shell } = await launchDesk({
      name: "live-share-shell-windows",
      homeUrl: "pistachio://home/",
      args: ["--use-mock-keychain"],
      env: { PISTACHIO_E2E: "0", PISTACHIO_CONTROL_URL: control.url, PISTACHIO_ANONYMOUS: "1", SHELL: "/bin/zsh", ZDOTDIR: zdotdir },
    }));
    homeId = (await snapshot(shell)).activeTabId!;
    // (In a space: on a Home tab a new terminal would be a Home tab of its own — docs/double-sidebar.md §1.)
    await createGroup(shell, SPACE, [homeId], "Pairing", "green");
    await selectSpace(shell, SPACE);
    const before = (await snapshot(shell)).activeTabId;
    await shell.keyboard.press("Meta+J");
    await expect.poll(async () => (await snapshot(shell)).activeTabId).not.toBe(before);
    const current = await snapshot(shell);
    terminalTab = current.activeTabId!;
    terminalId = /^pistachio:\/\/terminal\/([a-f0-9]{12})$/u.exec(current.tabs.find((tab) => tab.id === terminalTab)!.url)![1]!;
    // ⌘J opened it in the space in use: the space holds both windows.
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === SPACE)?.tabIds.slice().sort()).toEqual([homeId, terminalTab].sort());
    await expect.poll(() => terminalText(shell, terminalId), { timeout: 20_000 }).toMatch(/% ?$/mu);
    await shell.keyboard.type(MARK);
    await shell.keyboard.press("Enter");
    await expect.poll(() => terminalText(shell, terminalId), { timeout: 15_000 }).toMatch(/LIVE-SHELL-WINDOWS/u);
    await settled(shell, app);
  });

  test.afterAll(async () => {
    await app?.close();
    await browser?.close();
    await guestSite?.close();
    await control?.close();
    await livekit?.stop();
  });

  test("a guest sees the terminal and the home window live: each its own track, at its page box's shape, the terminal's pixels", async () => {
    test.setTimeout(120_000);
    await command(shell, { type: "start", groupId: SPACE, hostName: "Zach" });
    await expect.poll(async () => (await liveShare(shell)).status, { timeout: 30_000 }).toBe("live");
    await expect.poll(() => app.windows().some((page) => page.url().endsWith("#live-host"))).toBe(true);
    host = app.windows().find((page) => page.url().endsWith("#live-host"))!;
    host.on("console", (message) => {
      if (message.text().startsWith("[live-host]")) console.info(message.text());
    });
    await expect.poll(async () => (await liveShare(shell)).connection, { timeout: 30_000 }).toBe("connected");
    await command(shell, { type: "setAdmission", admission: "open" });
    await expect.poll(async () => (await liveShare(shell)).admission).toBe("open");
    token = linkToken((await liveShare(shell)).link!);
    const request = await knock(control.url, token, "Ann");
    expect(request.status).toBe("admitted");
    await joinRoom(guest, request.livekit!);
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-guests", "1", { timeout: 20_000 });
    await guest.evaluate(() => (window as unknown as GuestWindow).guest.send("lv.hello", {}));

    // Both windows are the shell's, and both stream.
    await expect.poll(async () => (await lastDesk())?.windows.map((window) => [window.id, window.kind, window.track, window.paused]).sort(), { timeout: 20_000 }).toEqual(
      [
        [homeId, "shell", `win:${homeId}`, false],
        [terminalTab, "shell", `win:${terminalTab}`, false],
      ].sort(),
    );
    const page = (await deskWindow(terminalTab))!.page;
    const aspect = page.w / page.h;
    await watch(guest, terminalTab, ...fitted(page));
    await expect.poll(async () => (await picture()).frames, { timeout: 30_000 }).toBeGreaterThan(0);
    const seen = await picture();
    console.info(`[live-share-shell-windows] the guest sees the terminal at ${String(seen.width)}×${String(seen.height)} for a ${String(page.w)}×${String(page.h)} page box`);
    expect(Math.abs(seen.width / seen.height - aspect)).toBeLessThan(0.02);

    // Its pixels are the terminal's: the line, where the shell draws it in the window's page box.
    const stage = (await shell.locator(".desk-stage").boundingBox())!;
    const onHost = await lineOnHost(app, { x: stage.x + page.x, y: stage.y + page.y, w: page.w, h: page.h });
    expect(onHost).not.toBeNull();
    await expect.poll(() => lineOnGuestPage(guest), { timeout: 10_000 }).not.toBeNull();
    const onGuest = (await lineOnGuestPage(guest))!;
    console.info(`[live-share-shell-windows] the line on the host ${JSON.stringify(onHost)}, on the guest ${JSON.stringify(onGuest)}`);
    for (const key of ["x", "y", "w", "h"] as const) expect(Math.abs(onGuest[key] - onHost![key])).toBeLessThan(0.02);
    if (captureEnabled) {
      await mkdir(screenshots, { recursive: true });
      await guest.screenshot({ path: join(screenshots, "00-guest-sees-the-terminal.png") });
    }

    // The home window comes as its own picture.
    const second = await guest.context().newPage();
    await second.goto(guestSite.url);
    await second.waitForFunction(() => "guest" in window);
    const bo = await knock(control.url, token, "Bo");
    await joinRoom(second, bo.livekit!);
    const home = (await deskWindow(homeId))!.page;
    await watch(second, homeId, ...fitted(home));
    await expect.poll(async () => (await pictureOn(second)).frames, { timeout: 30_000 }).toBeGreaterThan(0);
    const homeSeen = await pictureOn(second);
    expect(Math.abs(homeSeen.width / homeSeen.height - home.w / home.h)).toBeLessThan(0.02);
    if (captureEnabled) await second.screenshot({ path: join(screenshots, "00-guest-sees-home.png") });
    await second.evaluate(() => (window as unknown as { guest: { leave(): Promise<void> } }).guest.leave());
    await second.close();
  });

  test("the address palette over the desk holds the terminal's picture; closed, it runs again", async () => {
    test.setTimeout(60_000);
    // A terminal that repaints all the while: its picture would go on coming.
    await shell.locator(`[data-testid="terminal-page"][data-terminal-id="${terminalId}"]`).click();
    await shell.keyboard.type("while :; do printf '\\r%s ' $RANDOM; sleep 0.05; done");
    await shell.keyboard.press("Enter");
    await running("the terminal repainting");
    if (captureEnabled) {
      // (The guest's picture sharpens as the room's bandwidth grows: shown once it is the terminal's own size, or after a while.)
      const page = (await deskWindow(terminalTab))!.page;
      await expect.poll(async () => (await picture()).width, { timeout: 10_000 }).toBeGreaterThanOrEqual(page.w).catch(() => undefined);
      console.info(`[live-share-shell-windows] the guest's picture of the terminal repainting: ${JSON.stringify(await picture())}`);
      await guest.screenshot({ path: join(screenshots, "01-guest-sees-the-terminal-live.png") });
      const shot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().endsWith("#live-host"))!.webContents.capturePage()).toPNG().toString("base64"));
      await writeFile(join(screenshots, "01-host-desk.png"), Buffer.from(shot, "base64"));
    }
    const pressed = Date.now();
    await shell.keyboard.press("Meta+L");
    await expect(shell.getByTestId("url-bar")).toBeVisible();
    await held("the address palette");
    const paused = (await inbox("lv.desk")).find((message) => message.at >= pressed && (message.body["windows"] as DeskWindow[]).some((window) => window.id === terminalTab && window.paused));
    console.info(`[live-share-shell-windows] the guest heard the terminal paused ${String(paused!.at - pressed)} ms after ⌘L`);
    // Not a frame of the palette reached them: on the Mac its veil darkens the terminal's blank lower part; their picture of it is the terminal's own white.
    const stage = (await shell.locator(".desk-stage").boundingBox())!;
    const page = (await deskWindow(terminalTab))!.page;
    const blank = { x: 0.05, y: 0.4, w: 0.9, h: 0.5 };
    const onMac = await lookOnHost(app, { x: stage.x + page.x, y: stage.y + page.y, w: page.w, h: page.h }, blank);
    const onGuest = await lookOnGuest(guest, blank);
    console.info(`[live-share-shell-windows] the terminal's blank part under the palette: on the Mac ${JSON.stringify(onMac)}, on the guest ${JSON.stringify(onGuest)}`);
    expect(onGuest.mean).toBeGreaterThan(240);
    expect(onGuest.mean - onMac.mean).toBeGreaterThan(10);
    // The home window's picture is held too: anything over the desk holds every window the shell draws.
    expect((await deskWindow(homeId))?.paused).toBe(true);
    if (captureEnabled) await guest.screenshot({ path: join(screenshots, "02-guest-paused-under-the-palette.png") });
    // A guest who joins under the palette is shown the terminal's last picture from before it: the line, and the terminal's own white.
    const late = await guest.context().newPage();
    await late.goto(guestSite.url);
    await late.waitForFunction(() => "guest" in window);
    const dee = await knock(control.url, token, "Dee");
    await joinRoom(late, dee.livekit!);
    const joined = Date.now();
    await watch(late, terminalTab, ...fitted(page));
    await expect.poll(async () => (await pictureOn(late)).frames, { timeout: 10_000 }).toBeGreaterThan(0);
    const shown = Date.now();
    await expect.poll(() => lineOnGuestPage(late), { timeout: 10_000 }).not.toBeNull();
    const onLate = await lookOnGuest(late, blank);
    console.info(`[live-share-shell-windows] a guest who joined under the palette was shown the terminal ${String(shown - joined)} ms after joining: its blank part ${JSON.stringify(onLate)}`);
    expect(onLate.mean).toBeGreaterThan(240);
    if (captureEnabled) await late.screenshot({ path: join(screenshots, "02-late-guest-under-the-palette.png") });
    // (Held all the while: what they were shown is the picture it went on sending while held.)
    await expect(shell.getByTestId("url-bar")).toBeVisible();
    expect((await deskWindow(terminalTab))?.paused).toBe(true);
    await late.evaluate(() => (window as unknown as { guest: { leave(): Promise<void> } }).guest.leave());
    await late.close();
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    await running("the palette closed");
  });

  test("a context menu over the desk holds it too", async () => {
    test.setTimeout(60_000);
    await railSpace(shell, SPACE).click({ button: "right" });
    await expect(shell.getByTestId("context-menu")).toBeVisible();
    await held("a context menu");
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("context-menu")).toHaveCount(0);
    await running("the menu closed");
  });

  test("the Live card beside the terminal holds the window under it, not the terminal: its picture runs on, chat and all", async () => {
    test.setTimeout(60_000);
    // Home in use, tiled: it takes the first place (the left half), the terminal the right one.
    await shell.locator(windowSelector(homeId)).click({ position: { x: 40, y: 400 } });
    await openMore(shell);
    await shell.getByTestId("desk-tile").click();
    await settled(shell, app);
    await expect.poll(async () => ((await deskWindow(terminalTab))?.page.x ?? 0) > ((await deskWindow(homeId))?.page.x ?? 0), { timeout: 10_000 }).toBe(true);
    await running("the windows tiled");
    // The Live pill pressed: the card comes up beside the sidebar.
    await hostReport({ type: "openCard" });
    const card = shell.getByTestId("live-card");
    await expect(card).toHaveAttribute("data-shown", "");
    const stage = (await shell.locator(".desk-stage").boundingBox())!;
    const cardBox = (await card.boundingBox())!;
    const terminalPage = (await deskWindow(terminalTab))!.page;
    console.info(`[live-share-shell-windows] the Live card ends at ${String(Math.round(cardBox.x + cardBox.width - stage.x))} px into the stage, the terminal's page begins at ${String(terminalPage.x)}`);
    expect(cardBox.x + cardBox.width - stage.x).toBeLessThan(terminalPage.x);
    // The home window under it is held; the terminal is not.
    await expect.poll(async () => (await deskWindow(homeId))?.paused, { timeout: 5_000 }).toBe(true);
    expect((await deskWindow(terminalTab))?.paused).toBe(false);
    let before = (await picture()).frames;
    await new Promise((done) => setTimeout(done, 1_500));
    let after = (await picture()).frames;
    console.info(`[live-share-shell-windows] beside the Live card: ${String(after - before)} new frames of the terminal in 1.5 s`);
    expect(after - before).toBeGreaterThan(5);
    // Chatting in it: the terminal's picture still runs.
    await card.getByTestId("live-tab-chat").click();
    const input = card.getByTestId("live-chat-input");
    await input.click();
    before = (await picture()).frames;
    await input.pressSequentially("watching your terminal", { delay: 20 });
    await input.press("Enter");
    await expect(card.getByTestId("live-chat-message").last()).toContainText("watching your terminal");
    await new Promise((done) => setTimeout(done, 500));
    after = (await picture()).frames;
    console.info(`[live-share-shell-windows] chatting in the Live card: ${String(after - before)} new frames of the terminal`);
    expect(after - before).toBeGreaterThan(5);
    expect((await deskWindow(terminalTab))?.paused).toBe(false);
    if (captureEnabled) {
      await mkdir(screenshots, { recursive: true });
      await guest.screenshot({ path: join(screenshots, "03-guest-sees-the-terminal-beside-the-live-card.png") });
      const shot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().endsWith("#live-host"))!.webContents.capturePage()).toPNG().toString("base64"));
      await writeFile(join(screenshots, "03-host-desk-with-the-live-card.png"), Buffer.from(shot, "base64"));
    }
    await shell.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect.poll(async () => (await deskWindow(homeId))?.paused, { timeout: 5_000 }).toBe(false);
  });

  test("a frame button's tooltip holds the window it lies over alone", async () => {
    test.setTimeout(60_000);
    await showFrame(shell, windowSelector(terminalTab));
    await shell.locator(windowSelector(terminalTab)).getByTestId("desk-close").hover();
    await expect(shell.locator('[data-testid="desk-window-tip"][data-shown]')).toHaveCount(1);
    await held("its own frame's tooltip");
    expect((await deskWindow(homeId))?.paused).toBe(false);
    // The pointer off it, onto the home window's foot: the tooltip goes, and the terminal runs again.
    const homeBox = (await shell.locator(windowSelector(homeId)).boundingBox())!;
    await shell.mouse.move(homeBox.x + homeBox.width / 2, homeBox.y + homeBox.height - 40);
    await expect(shell.locator('[data-testid="desk-window-tip"][data-shown]')).toHaveCount(0);
    await running("the tooltip gone");
  });

  test("main's word held back 200 ms: no frame painted under the palette reaches the guest, every frame cut by the report it was painted under", async () => {
    test.setTimeout(60_000);
    const blank = { x: 0.05, y: 0.4, w: 0.9, h: 0.5 };
    await lookAtEveryFrame(guest, blank);
    await countShellFrames(host);
    await running("the terminal repainting");
    await holdBackReports(app, 200);
    try {
      const pressed = Date.now();
      await shell.keyboard.press("Meta+L");
      await expect(shell.getByTestId("url-bar")).toBeVisible();
      await expect.poll(async () => (await deskWindow(terminalTab))?.paused, { timeout: 5_000 }).toBe(true);
      const paused = (await inbox("lv.desk")).find((message) => message.at >= pressed && (message.body["windows"] as DeskWindow[]).some((window) => window.id === terminalTab && window.paused))!;
      // The palette on the Mac, over the terminal: its veil darkens the terminal's blank part there.
      await new Promise((done) => setTimeout(done, 1_000));
      const stage = (await shell.locator(".desk-stage").boundingBox())!;
      const page = (await deskWindow(terminalTab))!.page;
      const onMac = await lookOnHost(app, { x: stage.x + page.x, y: stage.y + page.y, w: page.w, h: page.h }, blank);
      const looks = await looksSince(guest, pressed);
      const darkest = Math.min(255, ...looks.map((look) => look.mean));
      // Frames the shell painted while the word was on its way (past the ones in flight as ⌘L was pressed): read, none cut.
      const late = await shellFramesBetween(host, pressed + 100, paused.at - 5);
      console.info(
        `[live-share-shell-windows] main's word held back: the guest heard the terminal paused ${String(paused.at - pressed)} ms after ⌘L; meanwhile the live-host app read ${String(late.reads)} frames of the shell and cut ${String(late.cuts)}; the guest showed ${String(looks.length)} frames since ⌘L, the darkest blank part ${String(Math.round(darkest))}; on the Mac under the palette ${String(onMac.mean)}`,
      );
      expect(paused.at - pressed).toBeGreaterThanOrEqual(200);
      expect(onMac.mean).toBeLessThan(200);
      expect(late.reads).toBeGreaterThan(0);
      expect(late.cuts).toBe(0);
      // Not one frame of the palette: every one the guest showed since ⌘L is the terminal's own white.
      expect(darkest).toBeGreaterThan(230);
      await shell.keyboard.press("Escape");
      await expect(shell.getByTestId("url-bar")).toHaveCount(0);
      await running("the palette closed, its word late too");
    } finally {
      await holdBackReports(app, null);
    }
  });

  test("in another space the host is away: the shell shows that space, and nothing of it is cut", async () => {
    test.setTimeout(60_000);
    await tabGroupCommand(shell, { type: "create", id: "elsewhere", tabIds: [], title: "Elsewhere", select: true });
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).toBe("elsewhere");
    await expect.poll(async () => (await lastDesk())?.hostPresent).toBe(false);
    await held("another space");
    await selectSpace(shell, SPACE);
    await expect.poll(async () => (await lastDesk())?.hostPresent, { timeout: 10_000 }).toBe(true);
    await running("back on the space");
    await tabGroupCommand(shell, { type: "ungroup", groupId: "elsewhere" });
  });

  test("someone in the room the host never let in gets no picture of a shell-drawn window", async () => {
    test.setTimeout(60_000);
    const share = await liveShare(shell);
    const stranger = await guest.context().newPage();
    await stranger.goto(guestSite.url);
    await stranger.waitForFunction(() => "guest" in window);
    const ticket = livekit.mintToken("g_stranger", "Stranger", JSON.stringify({ role: "guest", color: "#30A46C" }), {
      roomJoin: true,
      room: `live_${share.shareId!}`,
      canPublish: true,
      canPublishSources: ["camera", "microphone"],
      canPublishData: true,
      canSubscribe: true,
      canUpdateOwnMetadata: false,
    });
    const out = await stranger.evaluate(
      async ([url, key, windowId]) => {
        const g = (window as unknown as GuestWindow).guest;
        await g.join(url, key);
        const joined = Date.now();
        g.watch(windowId, 320, 200);
        while (g.ended() === null && Date.now() - joined < 8_000) await new Promise((done) => setTimeout(done, 20));
        return { ended: g.ended(), picture: g.picture() };
      },
      [livekit.url, ticket, terminalTab] as const,
    );
    console.info(`[live-share-shell-windows] a stranger in the room: ${JSON.stringify(out)}`);
    expect(out.picture).toMatchObject({ frames: 0, tracks: 0 });
    await stranger.close();
    // Ann, let in, still has it.
    const before = (await picture()).frames;
    await expect.poll(async () => (await picture()).frames, { timeout: 10_000 }).toBeGreaterThan(before);
  });

  test("a still terminal is still given a frame a second: a guest who starts watching it then has its picture", async () => {
    test.setTimeout(60_000);
    // (The keys back in the terminal: the windows were tiled and the Live card chatted in since. A press on a window
    // not in use brings it into use first.)
    const term = shell.locator(`[data-testid="terminal-page"][data-terminal-id="${terminalId}"]`);
    await expect(async () => {
      await term.click();
      await expect(term.locator("textarea.xterm-helper-textarea")).toBeFocused({ timeout: 500 });
    }).toPass({ timeout: 10_000 });
    await shell.keyboard.press("Control+C");
    await expect.poll(() => terminalText(shell, terminalId)).toMatch(/% ?$/mu);
    // (Its cursor blinks while it is in use: in use elsewhere, nothing of it repaints.)
    await shell.locator(`[data-testid="desk-window"][data-tab-id="${homeId}"]`).click({ position: { x: 40, y: 400 } });
    await new Promise((done) => setTimeout(done, 1_500));
    const before = (await picture()).frames;
    await new Promise((done) => setTimeout(done, 4_000));
    const still = (await picture()).frames - before;
    console.info(`[live-share-shell-windows] a still terminal: ${String(still)} frames in 4 s`);
    expect(still).toBeGreaterThanOrEqual(2);
    expect(still).toBeLessThanOrEqual(12);
    const late = await guest.context().newPage();
    await late.goto(guestSite.url);
    await late.waitForFunction(() => "guest" in window);
    const cy = await knock(control.url, token, "Cy");
    await joinRoom(late, cy.livekit!);
    const page = (await deskWindow(terminalTab))!.page;
    await watch(late, terminalTab, ...fitted(page));
    await expect.poll(async () => (await pictureOn(late)).frames, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect.poll(() => lineOnGuestPage(late), { timeout: 10_000 }).not.toBeNull();
    await late.close();
  });

  test("the terminal carried across the desk: no crop takes in a pixel beside it — lifted, its picture is held; carried as it is, it runs on", async () => {
    test.setTimeout(120_000);
    // The terminal alone on a green desk: a crop of it cut where it no longer is, or not as it is drawn, takes some green in at its edges.
    await greenDesk(shell, terminalTab);
    await watchCrops(host, 12);
    await watchGuestEdges(guest, 0.03);
    try {
      /**
       * The terminal taken by its drawer and carried `by` over `frames` frames —
       * the pointer moved every frame, as a person's hand moves it (from the
       * shell's page itself: Playwright's own moves come tens of ms apart on a
       * busy machine), then let go where it is: when it was in hand, and when
       * the desk was at rest again.
       */
      const carry = async (by: { x: number; y: number }, frames: number): Promise<{ from: number; to: number; rest: number }> => {
        await showFrame(shell, windowSelector(terminalTab));
        const drawer = `${windowSelector(terminalTab)} [data-testid="desk-window-drawer"]`;
        const frame = (await shell.locator(drawer).boundingBox())!;
        const gap = (await shell.locator(`${drawer} > span.flex-1`).boundingBox())!;
        // (Low on the drawer: one at the desk's top has the top edge's zone just above it.)
        const grip = { x: gap.x + gap.width / 2, y: frame.y + frame.height - 5 };
        await shell.mouse.move(grip.x, grip.y);
        await shell.mouse.down();
        const from = Date.now();
        await shell.evaluate(
          async ({ start, path, count }) => {
            for (let step = 1; step <= count; step += 1) {
              await new Promise((done) => requestAnimationFrame(done));
              const at = { clientX: start.x + (path.x * step) / count, clientY: start.y + (path.y * step) / count };
              window.dispatchEvent(new PointerEvent("pointermove", { ...at, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1, bubbles: true }));
            }
          },
          { start: grip, path: by, count: frames },
        );
        const to = Date.now();
        await shell.mouse.move(grip.x + by.x, grip.y + by.y);
        await shell.waitForTimeout(160);
        await shell.mouse.up();
        await settled(shell, app);
        // (The last crops' edges are read a moment after they are cut, the last frames shown a moment after they come.)
        await new Promise((done) => setTimeout(done, 500));
        return { from, to, rest: Date.now() };
      };
      /**
       * What the guest and the live-host app saw of a carry: the crops of the
       * terminal (any but home's, which is all green now and is counted alone)
       * and the frames the guest showed of it, with any desk green at their edges.
       */
      const seen = async (what: string, carried: { from: number; to: number; rest: number }, homeRect: string): Promise<{ crops: CropSeen[]; greenFrames: number; inHand: number; held: boolean }> => {
        const crops = await cropsBetween(host, carried.from, carried.rest);
        const frames = await guestEdgesBetween(guest, carried.from, carried.rest);
        const inHand = frames.filter((edge) => edge.at <= carried.to).length;
        const ofHome = crops.filter((crop) => JSON.stringify(crop.rect) === homeRect);
        const ofTerminal = crops.filter((crop) => JSON.stringify(crop.rect) !== homeRect);
        const seconds = (carried.to - carried.from) / 1_000;
        const read = await markReadsBetween(host, carried.from, carried.to);
        const cutInHand = ofTerminal.filter((crop) => crop.at <= carried.to).length;
        const desks = (await inbox("lv.desk")).filter((message) => message.at >= carried.from && message.at <= carried.rest);
        const paused = desks.some((message) => (message.body["windows"] as DeskWindow[]).some((window) => window.id === terminalTab && window.paused));
        const desksInHand = desks.filter((message) => message.at <= carried.to).length;
        console.info(
          `[live-share-shell-windows] ${what}: ${seconds.toFixed(2)} s in hand, the live-host app reading ${String(read)} frames of the shell meanwhile and cutting the terminal from ${String(cutInHand)}; in all it cut the terminal ${String(ofTerminal.length)} times (${String(ofTerminal.filter((crop) => crop.green !== 0).length)} with the desk at an edge, the most ${String(Math.max(0, ...ofTerminal.map((crop) => crop.green)))} samples) and home ${String(ofHome.length)} times; the guest showed ${String(frames.length)} frames of the terminal, ${String(inHand)} while in hand (${(inHand / seconds).toFixed(1)}/s), ${String(frames.filter((edge) => edge.green > 0).length)} with the desk at an edge; it heard ${String(desksInHand)} desk frames while in hand (${(desksInHand / seconds).toFixed(1)}/s), and the frame held it: ${String(paused)}`,
        );
        return { crops: ofTerminal, greenFrames: frames.filter((edge) => edge.green > 0).length, inHand, held: paused };
      };

      // Home's crop, still: anything else cut from here on is the terminal's.
      await expect.poll(async () => new Set((await cropsBetween(host, 0, Date.now())).map((crop) => JSON.stringify(crop.rect))).size, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
      const home = (await deskWindow(homeId))!.page;
      const terminalPage = (await deskWindow(terminalTab))!.page;
      expect(home.x).toBeLessThan(terminalPage.x);
      const homeRect = JSON.stringify((await cropsBetween(host, 0, Date.now())).map((crop) => crop.rect).sort((a, b) => a.x - b.x)[0]);

      // Lifted (the desk's own Feel): carried, the window is drawn grown and turned with the throw. (Taken out of the
      // desk's trailing foot first: under the Bar's nub a window is drawn with the nub's hole in its corner — main's
      // glass fills it on the Mac, the desk's ground in the shell's picture.)
      await openFeel(shell);
      await expect(shell.getByTestId("desk-variant-motion")).toHaveAttribute("data-value", "lifted");
      const stage = (await shell.locator(".desk-stage").boundingBox())!;
      await shell.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
      await expect(shell.getByTestId("desk-more-card")).toHaveCount(0);
      await carry({ x: -300, y: 0 }, 20);
      const lifted = await seen("carried lifted", await carry({ x: -120, y: 100 }, 45), homeRect);

      // Carried as it is (Feel: Live): the window moves under the pointer, nothing else of it changes.
      await openFeel(shell);
      await shell.getByTestId("desk-variant-motion").click();
      await expect(shell.getByTestId("desk-variant-motion")).toHaveAttribute("data-value", "live");
      await shell.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
      await expect(shell.getByTestId("desk-more-card")).toHaveCount(0);
      const live = await seen("carried live", await carry({ x: 260, y: -40 }, 90), homeRect);

      for (const carried of [lifted, live]) {
        expect(carried.crops.length).toBeGreaterThan(0);
        expect(carried.crops.filter((crop) => crop.green !== 0)).toEqual([]);
        expect(carried.greenFrames).toBe(0);
      }
      // Lifted, its picture is held while it is drawn grown and turned; carried as it is, it runs on as it moves.
      expect(lifted.held).toBe(true);
      expect(live.held).toBe(false);
      expect(live.inHand).toBeGreaterThan(0);
    } finally {
      await greenDesk(shell, null);
    }
  });

  test("stopping ends it: the terminal's picture goes with the room", async () => {
    await command(shell, { type: "stop" });
    await expect.poll(async () => (await liveShare(shell)).status).toBe("idle");
    await expect.poll(() => guest.evaluate(() => (window as unknown as GuestWindow).guest.ended()), { timeout: 15_000 }).toBe("ended");
  });
});
