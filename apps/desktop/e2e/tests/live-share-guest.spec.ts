import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { build } from "vite";
import { BUILTIN_BACKGROUNDS } from "@pistachio/live-share/effects";
import { deviceLoginSigningBytes, exportPublicKeyRaw, generateAgreementKeypair, generateDeviceKeypair, toBase64 } from "@pistachio/sync-protocol";
import { captureEnabled } from "./app";
import { imageColour, isBlurred, isPlainCamera, lookOf, savePicture, showsScene, type Colour, type Look } from "./camera-look";
import { startLiveKit, type LiveKitServer } from "./livekit-harness";
import { chromiumPath, startWebStack, type WebStack } from "./web-harness";

/**
 * The guest page against a real room (docs/live-share.md §1 The guest, §7,
 * §12): control in process and www (the web harness), a spawned
 * `livekit-server`, a share created through control's host route with a real
 * device token — and, standing in for the Mac, a FAKE HOST: a Chromium page
 * running `LiveRoom` from a bundle made here, which joins with the share's
 * host token, streams two canvases as windows to everyone in the room and
 * takes everyone's camera (what a guest lets through is the guest page's to
 * prove), sends desk frames, moves its pointer, draws, tells the guests it
 * lets in who they are (`lv.guests`: everyone in the room as they come,
 * unless a step holds the list), answers a listed guest's `lv.hello` with
 * the list and `lv.sync`, and records what guests send it.
 *
 * The guest is a Chromium with fake camera and microphone. It walks the
 * lobby, knocks, is admitted through control, and in the room this proves
 * the wiring only the real page has: the window's video at its box, the
 * host's pointer and ink drawn over the stage, the guest's pointer reaching
 * the host, a click and typing on the window the host allows arriving with
 * the right page coordinates while the other window gets nothing, chat, a
 * second guest who joins at once — seen, heard and shown to the first only
 * once the host lists them, one hop of its list later — and leaves, and the
 * share ending. And the
 * camera's background: chosen in the lobby it is on the preview at once,
 * and on the camera the host receives; the room's menu changes it — with
 * the segmenter's files from www itself, and no request leaving the machine;
 * and a reload while admitted brings the camera back behind the background
 * chosen, from the first frame the host receives.
 */

const PAGE_ENTRY = "\0live-fake-host";

/** The fake host: a thin handle on `LiveRoom` (role host) for the spec to drive through `page.evaluate`. */
const HOST_SOURCE = `
import { LiveRoom } from "@pistachio/live-share/room";
import { LIVE_TOPICS } from "@pistachio/live-share";

let room = null;
let desk = null;
let seq = 0;
const inbox = [];
const strokes = new Map();
const chat = [];
/** The guests let in, as main's admitted list is: each is told who they are. */
let listed = [];
/** Whether the list follows the room (everyone in it, as they come), as it does unless a step holds it. */
let following = true;
/** Hellos from guests not listed yet, answered once they are. */
const waiting = new Set();
/** Everyone in the room, listed or not: they may have its windows, and it takes their cameras. */
let receivers = [];

function answer(identity) {
  void room.send("lv.guests", { guests: listed }, { to: [identity] });
  void room.send("lv.sync", { desk, strokes: [...strokes.values()], chat, grants: [] }, { to: [identity] });
}

/** Let these guests in: each told who they are, a hello waiting answered. When it went (ms since the epoch). */
async function list(guests) {
  listed = [...guests];
  const at = Date.now();
  if (listed.length > 0) await room.send("lv.guests", { guests: listed }, { to: listed });
  for (const identity of [...waiting]) {
    if (!listed.includes(identity)) continue;
    waiting.delete(identity);
    answer(identity);
  }
  return at;
}

/** A page, painted on a canvas: a header, lines of text, and a block that moves so frames keep coming. */
function paintPage(context, width, height, n, look) {
  context.fillStyle = look.ground;
  context.fillRect(0, 0, width, height);
  context.fillStyle = look.bar;
  context.fillRect(0, 0, width, 64);
  context.fillStyle = look.barText;
  context.font = "600 26px sans-serif";
  context.fillText(look.title, 32, 42);
  context.fillStyle = look.heading;
  context.font = "700 44px sans-serif";
  context.fillText(look.heading_text, 32, 150);
  context.fillStyle = look.line;
  for (let row = 0; row < 7; row += 1) context.fillRect(32, 196 + row * 38, width * (0.55 + ((row * 37) % 30) / 100), 14);
  const x = 32 + ((n * 6) % Math.max(1, width - 260));
  context.fillStyle = look.accent;
  context.beginPath();
  context.roundRect(x, height - 150, 220, 96, 14);
  context.fill();
  context.fillStyle = "#fff";
  context.font = "600 22px sans-serif";
  context.fillText("frame " + n, x + 22, height - 94);
}

const LOOKS = {
  light: { ground: "#ffffff", bar: "#f3f4f6", barText: "#30343b", heading: "#111318", heading_text: "Launch plan — Q4", line: "#e3e5e9", accent: "#3E63DD", title: "docs.example.com" },
  dark: { ground: "#0f1115", bar: "#181b21", barText: "#c9ced8", heading: "#f2f4f8", heading_text: "Release checklist", line: "#262a33", accent: "#12A594", title: "github.com/pistachio" },
};

window.host = {
  async connect(url, token) {
    room = await LiveRoom.connect({ url, token, role: "host" });
    for (const topic of Object.keys(LIVE_TOPICS)) {
      room.onMessage(topic, (body, from) => inbox.push({ topic, body, from, at: Date.now() }));
    }
    room.onMessage("lv.hello", (_body, from) => {
      if (from.identity === null) return;
      if (listed.includes(from.identity)) answer(from.identity);
      else waiting.add(from.identity);
    });
    room.on("participants", (people) => {
      const guests = people.filter((person) => person.role === "guest").map((person) => person.identity);
      if (guests.join() !== receivers.join()) {
        receivers = guests;
        room.setReceivers(guests);
      }
      if (following && guests.join() !== listed.join()) void list(guests);
    });
    room.onMessage("lv.chat", (body, from) => {
      const person = room.participants().find((p) => p.identity === from.identity);
      chat.push({ id: body.id, from: from.identity, name: person ? person.name : "?", color: person ? person.color : "#8B8D98", text: body.text, at: Date.now() });
    });
    return room.identity;
  },
  async publishCanvas(windowId, width, height, look) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    let n = 0;
    setInterval(() => paintPage(context, width, height, (n += 1), LOOKS[look]), 33);
    paintPage(context, width, height, 0, LOOKS[look]);
    await room.publishWindow(windowId, canvas.captureStream(30).getVideoTracks()[0]);
  },
  async desk(frame) {
    seq += 1;
    desk = { ...frame, seq };
    await room.send("lv.desk", desk);
  },
  cursor: (x, y) => room.send("lv.cursor", { x, y, tool: "pointer" }),
  async ink(op) {
    if (op.op === "begin") strokes.set(op.id, { id: op.id, tool: op.tool, color: op.color, size: op.size, pts: [...op.pts], done: false });
    if (op.op === "add") strokes.get(op.id)?.pts.push(...op.pts);
    if (op.op === "end") { const stroke = strokes.get(op.id); if (stroke) stroke.done = true; }
    await room.send("lv.ink", op);
  },
  chat: (id, text) => room.send("lv.chat", { id, text }),
  // Anything else a host says, to some (as the app's host does with lv.refused).
  send: (topic, body, to) => room.send(topic, body, { to }),
  inbox: () => inbox,
  participants: () => room.participants().map((p) => p.identity),
  /** Hold the list as it is (a step lets guests in by hand, with list()), or let it follow the room again. */
  follow(on) {
    following = on;
    if (on) void list(room.participants().filter((person) => person.role === "guest").map((person) => person.identity));
  },
  list,
  // A guest's camera, shown in video[data-camera="<identity>"] as it comes and goes.
  watchCamera(identity) {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.dataset.camera = identity;
    video.style.cssText = "position:fixed;left:0;top:0;width:640px;height:360px;object-fit:cover";
    document.body.append(video);
    let shown = null;
    const show = () => {
      const camera = room.participants().find((p) => p.identity === identity)?.camera ?? null;
      if (camera === shown) return;
      shown?.detach(video);
      shown = camera;
      camera?.attach(video);
    };
    room.on("participants", show);
    show();
  },
  // The guest's next camera (one published after this call): its first frame, read off the track and drawn into
  // canvas[data-first-frame="<identity>"]. Off the track, not a <video> paused at it: under load the frame a video
  // element first presents can read empty — transparent in its frame callback, black once paused there — though
  // the track carried the camera behind its blur from its first frame.
  holdFirstFrame(identity) {
    const cameraOf = () => room.participants().find((p) => p.identity === identity)?.camera ?? null;
    const before = cameraOf();
    let taken = false;
    const take = async () => {
      const camera = cameraOf();
      if (camera === null || camera === before || taken) return;
      taken = true;
      // A clone of its own: letting it go stops nothing the room shows.
      const track = camera.mediaStreamTrack.clone();
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      const { value: frame } = await reader.read();
      if (frame !== undefined) {
        const canvas = document.createElement("canvas");
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
        canvas.getContext("2d", { willReadFrequently: true }).drawImage(frame, 0, 0);
        frame.close();
        canvas.dataset.firstFrame = identity;
        canvas.style.cssText = "position:fixed;left:0;top:360px;width:640px;height:360px";
        document.body.append(canvas);
      }
      void reader.cancel();
      track.stop();
    };
    room.on("participants", () => void take());
  },
};
`;

interface Site {
  url: string;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

/** Bundle the fake host with vite and serve it on loopback. */
async function serveFakeHost(): Promise<Site> {
  const outDir = await mkdtemp(join(tmpdir(), "live-fake-host-"));
  await build({
    configFile: false,
    root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "warn",
    publicDir: false,
    plugins: [
      {
        name: "live-fake-host",
        resolveId: (id) => (id === PAGE_ENTRY ? PAGE_ENTRY : null),
        load: (id) => (id === PAGE_ENTRY ? HOST_SOURCE : null),
      },
    ],
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      modulePreload: false,
      target: "es2022",
      rollupOptions: { input: { page: PAGE_ENTRY }, output: { format: "es", entryFileNames: "page.js" } },
    },
  });
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/") {
      response.writeHead(200, { "content-type": TYPES[".html"] });
      response.end('<!doctype html><meta charset="utf-8"><title>fake host</title><body><script type="module" src="/page.js"></script></body>');
      return;
    }
    const file = normalize(join(outDir, path));
    if (!file.startsWith(outDir)) {
      response.writeHead(404).end();
      return;
    }
    readFile(file).then(
      (body) => response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body),
      () => response.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(outDir, { recursive: true, force: true });
    },
  };
}

/** Call the fake host's `window.host[method](...args)`. */
function host<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ([name, rest]) => {
      const api = (window as unknown as { host: Record<string, (...values: unknown[]) => unknown> }).host;
      const fn = api[name];
      if (fn === undefined) throw new Error(`no host.${name}`);
      return (await fn(...rest)) as T;
    },
    [method, args] as const,
  );
}

interface Received {
  topic: string;
  body: Record<string, unknown>;
  from: { identity: string | null; role: string };
}

const inboxOf = (page: Page): Promise<Received[]> => host<Received[]>(page, "inbox");

/** An `lv.input` event the host received. */
interface InputEvent {
  w: string;
  e: { type: string; x?: number; y?: number; key?: string; text?: string; button?: string; clickCount?: number };
}

const inputs = async (page: Page): Promise<InputEvent[]> => (await inboxOf(page)).filter((m) => m.topic === "lv.input").map((m) => m.body as unknown as InputEvent);

const STAGE = { w: 1440, h: 860 };
const HOST_COLOR = "#3E63DD";
const FAVICON = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#3E63DD"/><path d="M4 5h8M4 8h8M4 11h5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>').toString("base64")}`;

interface DeskChanges {
  hostPresent?: boolean;
  guestsCanDraw?: boolean;
  t1?: Record<string, unknown>;
  t2?: Record<string, unknown>;
}

/** The desk the fake host shows: the docs page (guests may use it) and the repo beside it. */
function deskFrame(changes: DeskChanges = {}): Record<string, unknown> {
  const window = (id: string, frame: { x: number; y: number; w: number; h: number }, extra: Record<string, unknown>) => ({
    id,
    kind: "page",
    title: id,
    origin: null,
    favicon: null,
    frame,
    page: frame,
    focused: false,
    minimized: false,
    controllable: false,
    track: `win:${id}`,
    paused: false,
    ...extra,
  });
  return {
    v: 1,
    stage: STAGE,
    hostPresent: changes.hostPresent ?? true,
    ...(changes.guestsCanDraw === undefined ? {} : { guestsCanDraw: changes.guestsCanDraw }),
    space: { title: "Launch plan", color: "#46A758" },
    windows: [
      window("t2", { x: 860, y: 90, w: 540, h: 660 }, { title: "pistachio/desk — Release checklist", origin: "github.com", ...changes.t2 }),
      window("t1", { x: 48, y: 48, w: 780, h: 600 }, { title: "Launch plan — Q4", origin: "docs.example.com", favicon: FAVICON, focused: true, controllable: true, ...changes.t1 }),
    ],
  };
}

const T1 = { x: 48, y: 48, w: 780, h: 600 };

const shotsDir = join(process.cwd(), "e2e", "screenshots", "live-share-guest");
async function capture(page: Page, name: string): Promise<void> {
  if (!captureEnabled) return;
  // The screen's own entrance (≤ 420 ms) is over before the picture.
  await page.waitForTimeout(500);
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
}

/** A Mac's device token: sign up, then enroll a desktop device with real keys, as the app does. */
async function deviceToken(controlUrl: string): Promise<string> {
  const api = async (path: string, body: unknown, token?: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`${controlUrl}/v1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(`${path} answered ${String(response.status)}: ${JSON.stringify(json)}`);
    return json;
  };
  const account = await api("/accounts", { email: `live-guest-${randomUUID().slice(0, 8)}@example.com`, password: "correct-horse-battery" });
  const deviceId = randomUUID();
  const signing = await generateDeviceKeypair();
  const agreement = await generateAgreementKeypair();
  const { challenge } = (await api("/auth/device-challenge", { deviceId })) as { challenge: string };
  const signature = toBase64(new Uint8Array(await crypto.subtle.sign("Ed25519", signing.privateKey, deviceLoginSigningBytes(deviceId, challenge) as BufferSource)));
  const enrolled = await api(
    "/devices/enroll",
    {
      deviceId,
      name: "E2E Mac",
      platform: "macos",
      devicePublicKey: toBase64(await exportPublicKeyRaw(signing.publicKey)),
      agreementPublicKey: toBase64(await exportPublicKeyRaw(agreement.publicKey)),
      challenge,
      signature,
    },
    account["bootstrapToken"] as string,
  );
  return enrolled["token"] as string;
}

/** The box of a guest-page element in client px. */
async function boxOf(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`${selector} has no box`);
  return box;
}

/** Frames the guest's peer connection has received for a window's video (its inbound-rtp), or null while it has none. */
function framesReceived(page: Page, windowId: string): Promise<number | null> {
  return page.evaluate(async (id) => {
    const video = document.querySelector<HTMLVideoElement>(`[data-window="${CSS.escape(id)}"] video`);
    const track = (video?.srcObject as MediaStream | null | undefined)?.getVideoTracks()[0];
    if (track === undefined) return null;
    for (const connection of (window as unknown as { peerConnections: RTCPeerConnection[] }).peerConnections) {
      const receiver = connection.getReceivers().find((each) => each.track === track);
      if (receiver === undefined) continue;
      for (const stat of (await receiver.getStats()).values()) if (stat.type === "inbound-rtp") return (stat as { framesReceived?: number }).framesReceived ?? 0;
    }
    return null;
  }, windowId);
}

/** Whether every banner showing stays clear of every window's label. */
async function bannersClearOfLabels(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const boxes = (selector: string) => [...document.querySelectorAll(selector)].map((element) => element.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
    const banners = boxes(".lvg-banner");
    const labels = boxes(".lvg-window-tab");
    return banners.length > 0 && banners.every((a) => labels.every((b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top));
  });
}

test.describe.serial("live share: the guest page with a fake host", { tag: ["@web", "@share"] }, () => {
  let livekit: LiveKitServer | undefined;
  let stack: WebStack | undefined;
  let site: Site | undefined;
  let browser: Browser | undefined;
  let fakeHost: Page;
  let guest: Page;
  let control: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;
  let shareId: string;
  let link: string;
  /** Everything the guest page asked for, what it logged as an error, each time it loaded (the link, once), and dev-server rebuilds. */
  const requested: string[] = [];
  const consoleErrors: string[] = [];
  const loads: string[] = [];
  const rebuilds: string[] = [];
  /** The guest's fake camera with no background, as the lobby first showed it. */
  let plain: Look;
  const scene = (label: string): { url: string } => BUILTIN_BACKGROUNDS.find((background) => background.label === label)!;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    livekit = await startLiveKit();
    stack = await startWebStack({
      chromium: chromiumPath(),
      name: "live-guest",
      apps: ["www"],
      livekit: { url: livekit.url, apiKey: livekit.apiKey, apiSecret: livekit.apiSecret },
    });
    const token = await deviceToken(stack.controlUrl);
    const controlUrl = stack.controlUrl;
    control = async (method, path, body) => {
      const response = await fetch(`${controlUrl}/v1/live${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? null : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
    };
    const created = await control("POST", "/shares", { title: "Launch plan", hostName: "Zach" });
    expect(created.status).toBe(201);
    shareId = (created.json["share"] as { id: string }).id;
    // Control builds links on the production site; the token is what matters.
    link = `${stack.urls.www}/live/${(created.json["link"] as string).split("/live/")[1] ?? ""}`;
    const hostTicket = created.json["livekit"] as { url: string; token: string };

    site = await serveFakeHost();
    browser = await chromium.launch({
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    });
    const hostContext = await browser.newContext();
    fakeHost = await hostContext.newPage();
    fakeHost.on("pageerror", (error) => console.log(`[fake host] ${error.message}`));
    await fakeHost.goto(site.url);
    await fakeHost.waitForFunction(() => "host" in window);
    expect(await host(fakeHost, "connect", hostTicket.url, hostTicket.token)).toBe("host");
    await host(fakeHost, "publishCanvas", "t1", 1560, 1200, "light");
    await host(fakeHost, "publishCanvas", "t2", 1080, 1320, "dark");
    await host(fakeHost, "desk", deskFrame());

    // Dark first, as the page is designed; the light variant is captured at the end.
    const guestContext = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    guest = await guestContext.newPage();
    // Every peer connection the page makes, to read what each window's video receives.
    await guest.addInitScript(() => {
      const Native = window.RTCPeerConnection;
      const all: RTCPeerConnection[] = [];
      (window as unknown as { peerConnections: RTCPeerConnection[] }).peerConnections = all;
      window.RTCPeerConnection = class extends Native {
        constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
          super(...args);
          all.push(this);
        }
      };
    });
    guest.on("pageerror", (error) => console.log(`[guest] ${error.message}`));
    // Next's dev server rebuilds the page when a file it compiled changes (another worktree edit, while
    // the spec runs): a reload, or a Fast Refresh that re-runs the app's effects and so leaves and joins
    // the room again, tears the room down under a step. Say so plainly rather than as a missing box.
    guest.on("load", () => loads.push(guest.url()));
    guest.on("request", (request) => requested.push(request.url()));
    guest.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
      if (message.text().includes("[Fast Refresh] rebuilding")) rebuilds.push(message.text());
    });
  });

  test.afterEach(() => {
    expect(loads.slice(1), "the guest page reloaded under the test (a dev-server rebuild: a file it uses changed)").toEqual([]);
    expect(rebuilds, "Next's dev server rebuilt the guest page under the test (a file it uses changed)").toEqual([]);
  });

  test.afterAll(async () => {
    await browser?.close();
    await site?.close();
    await stack?.close();
    await livekit?.stop();
  });

  test("the lobby says whose space it is, and knocking waits for the host", async () => {
    // The first visit compiles the route in Next's dev server.
    test.setTimeout(240_000);
    await guest.goto(link, { timeout: 180_000 });
    const root = guest.getByTestId("live-guest");
    await expect(root).toHaveAttribute("data-screen", "lobby", { timeout: 120_000 });
    await expect(guest.getByRole("heading", { name: "Launch plan" })).toBeVisible();
    await expect(guest.getByText("Zach is sharing")).toBeVisible();
    await guest.getByLabel("Your name").fill("Ana");
    // The fake camera is up, mirrored, before anyone joins.
    await expect.poll(() => guest.locator(".lvg-preview-video").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
    await capture(guest, "01-lobby");
    if (captureEnabled) {
      await guest.getByRole("button", { name: "Camera options" }).click();
      await capture(guest, "01b-lobby-camera-menu");
      await guest.keyboard.press("Escape");
      await guest.emulateMedia({ colorScheme: "light" });
      await capture(guest, "01c-lobby-light");
      await guest.emulateMedia({ colorScheme: "dark" });
    }

    // A background, chosen in the camera's menu, is on the preview at once: the track the room will be handed.
    const preview = ".lvg-preview-video";
    await expect.poll(async () => {
      const look = await lookOf(guest, preview);
      return look !== null && isPlainCamera(look);
    }).toBe(true);
    plain = (await lookOf(guest, preview))!;
    // The lobby is up and working without the background effects' code or files: they load when one is chosen.
    expect(requested.filter((url) => /mediapipe|track-processors|tasks-vision/u.test(url))).toEqual([]);
    const errors = consoleErrors.length;
    await guest.getByRole("button", { name: "Camera options" }).click();
    await guest.getByRole("menuitemradio", { name: "Blur" }).click();
    // The first effect starts the segmenter on SwiftShader's WebGL: tens of seconds on a loaded machine before its first frame.
    await expect.poll(async () => {
      const look = await lookOf(guest, preview);
      return look !== null && isBlurred(look, plain);
    }, { timeout: 90_000 }).toBe(true);
    await guest.getByRole("menuitemradio", { name: "Dusk" }).click();
    await expect(guest.getByRole("menuitemradio", { name: "Dusk" })).toHaveAttribute("aria-checked", "true");
    const dusk = await imageColour(guest, scene("Dusk").url);
    await expect.poll(async () => {
      const look = await lookOf(guest, preview);
      return look !== null && showsScene(look, dusk, plain);
    }, { timeout: 30_000 }).toBe(true);
    await capture(guest, "01d-lobby-background");
    await guest.keyboard.press("Escape");
    expect(consoleErrors.slice(errors)).toEqual([]);

    await guest.getByRole("button", { name: "Ask to join" }).click();
    await expect(root).toHaveAttribute("data-screen", "knocking");
    await expect(guest.getByRole("heading", { name: "Waiting for Zach to let you in" })).toBeVisible();
    await capture(guest, "02-knocking");

    // The host sees the knock in control's list and admits it.
    let requestId = "";
    await expect
      .poll(async () => {
        const knocks = (await control("GET", `/shares/${shareId}`)).json["knocks"] as Array<{ requestId: string; name: string }>;
        requestId = knocks.find((knock) => knock.name === "Ana")?.requestId ?? "";
        return requestId;
      })
      .not.toBe("");
    expect((await control("POST", `/shares/${shareId}/requests/${requestId}`, { decision: "admit" })).status).toBe(200);
    // Joining publishes the camera through the segmenter: slow when software WebGL competes for a loaded machine.
    await expect(root).toHaveAttribute("data-screen", "room", { timeout: 60_000 });
  });

  // Straight after the lobby: the room publishes the lobby's background, and this ends with none. Every later step then
  // runs without the segmenter, which in this headless Chromium is software WebGL on the page's main thread: left on,
  // it starves the page on a loaded machine (single actions took 5–7 s, step 2 overran its budget).
  test("the guest's camera reaches the host with the lobby's background, and the room's menu changes it", async () => {
    // Four backgrounds, each segmented in software (SwiftShader) before the host sees it: slow on a loaded machine.
    test.setTimeout(120_000);
    const identity = (await host<string[]>(fakeHost, "participants")).find((id) => id.startsWith("g_"))!;
    await host(fakeHost, "watchCamera", identity);
    const atHost = `video[data-camera="${identity}"]`;
    const seen = async (test: (look: Look) => boolean): Promise<boolean> => {
      const look = await lookOf(fakeHost, atHost);
      return look !== null && test(look);
    };
    const errors = consoleErrors.length;
    // As the lobby left it: the scene is the picture the room publishes.
    const dusk = await imageColour(guest, scene("Dusk").url);
    await expect.poll(() => seen((look) => showsScene(look, dusk, plain)), { timeout: 20_000 }).toBe(true);

    // The room's camera menu switches it: blur, another scene, none.
    await guest.getByRole("button", { name: "Camera options" }).click();
    await guest.getByRole("menuitemradio", { name: "Blur" }).click();
    await expect.poll(() => seen((look) => isBlurred(look, plain)), { timeout: 20_000 }).toBe(true);
    if (captureEnabled) await savePicture(fakeHost, atHost, join(shotsDir, "03d-host-sees-guest-blurred.png"));
    await guest.getByRole("menuitemradio", { name: "Lagoon" }).click();
    const lagoon: Colour = await imageColour(guest, scene("Lagoon").url);
    await expect.poll(() => seen((look) => showsScene(look, lagoon, plain)), { timeout: 20_000 }).toBe(true);
    if (captureEnabled) await savePicture(fakeHost, atHost, join(shotsDir, "03e-host-sees-guest-lagoon.png"));
    await guest.getByRole("menuitemradio", { name: "No background" }).click();
    await expect.poll(() => seen(isPlainCamera), { timeout: 20_000 }).toBe(true);
    await guest.keyboard.press("Escape");
    expect(consoleErrors.slice(errors)).toEqual([]);

    // Every request the page made stayed on this machine (www, control, the room): MediaPipe's CDN and Google's model
    // storage were never asked. The segmenter's files came from www's own origin.
    const www = new URL(link).origin;
    const remote = requested.filter((url) => /^(https?|wss?):/u.test(url) && !["127.0.0.1", "localhost"].includes(new URL(url).hostname));
    expect(remote).toEqual([]);
    for (const file of ["wasm/vision_wasm_internal.js", "wasm/vision_wasm_internal.wasm", "selfie_segmenter.tflite"]) expect(requested).toContain(`${www}/live/mediapipe/${file}`);
  });

  test("the windows stand at their places with their pages live", async () => {
    // Its waits add up past the default 45 s when the machine is loaded (each can take seconds then).
    test.setTimeout(90_000);
    // The late join was answered: the desk came in the sync.
    await expect(guest.locator('[data-window="t1"]')).toBeVisible({ timeout: 20_000 });
    await expect(guest.locator('[data-window="t2"]')).toBeVisible();
    await expect.poll(async () => (await inboxOf(fakeHost)).some((m) => m.topic === "lv.hello")).toBe(true);

    const video = guest.locator('[data-window="t1"] video');
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth), { timeout: 20_000 }).toBeGreaterThan(0);
    const frames = () => video.evaluate((element: HTMLVideoElement) => element.getVideoPlaybackQuality().totalVideoFrames);
    const before = await frames();
    await expect.poll(frames).toBeGreaterThan(before + 5);

    // The page box sits where the host's is, as a share of the stage.
    const stage = await boxOf(guest, '[data-testid="live-stage"]');
    const page = await boxOf(guest, '[data-window="t1"] [data-page]');
    expect(stage.width / stage.height).toBeCloseTo(STAGE.w / STAGE.h, 2);
    expect((page.x - stage.x) / stage.width).toBeCloseTo(T1.x / STAGE.w, 2);
    expect((page.y - stage.y) / stage.height).toBeCloseTo(T1.y / STAGE.h, 2);
    expect(page.width / stage.width).toBeCloseTo(T1.w / STAGE.w, 2);
    expect(page.height / stage.height).toBeCloseTo(T1.h / STAGE.h, 2);
    const shown = await boxOf(guest, '[data-window="t1"] video');
    expect(shown.width).toBeCloseTo(page.width, 0);

    // Double-clicking its label brings the window up to fill the view, here only; Escape puts it back.
    await guest.locator('[data-window="t1"] .lvg-window-tab').dblclick();
    await expect(guest.locator('[data-window="t1"]')).toHaveAttribute("data-filled", "");
    await expect(guest.locator('[data-window="t2"]')).toHaveAttribute("data-away", "");
    await expect.poll(async () => Math.round((await boxOf(guest, '[data-window="t1"] [data-page]')).width)).toBeGreaterThan(Math.round(page.width * 1.4));
    const filled = await boxOf(guest, '[data-window="t1"] [data-page]');
    expect(filled.width / filled.height).toBeCloseTo(T1.w / T1.h, 2);
    if (captureEnabled) await capture(guest, "03a-window-filled");
    await guest.keyboard.press("Escape");
    await expect(guest.locator('[data-window="t1"]')).not.toHaveAttribute("data-filled", "");
    await expect.poll(async () => Math.round((await boxOf(guest, '[data-window="t1"] [data-page]')).width)).toBe(Math.round(page.width));
  });

  test("a window brought up to fill the view stops the others' video at the room, and the desk brings it back", async () => {
    test.setTimeout(90_000);
    // Over a second (the time is what is measured), how many frames the other window's video received.
    const flow = async (windowId: string): Promise<number> => {
      const before = (await framesReceived(guest, windowId)) ?? 0;
      await guest.waitForTimeout(1_000);
      return ((await framesReceived(guest, windowId)) ?? 0) - before;
    };
    await expect.poll(() => flow("t2"), { timeout: 20_000 }).toBeGreaterThan(0);
    await guest.locator('[data-window="t1"] .lvg-window-tab').dblclick();
    await expect(guest.locator('[data-window="t1"]')).toHaveAttribute("data-filled", "");
    // Faded, then out of the layout: the room's adaptive stream sees it off screen and the host stops sending it.
    await expect(guest.locator('[data-window="t2"]')).toHaveAttribute("data-gone", "");
    await expect.poll(() => flow("t2"), { timeout: 20_000 }).toBe(0);
    await guest.keyboard.press("Escape");
    await expect(guest.locator('[data-window="t2"]')).not.toHaveAttribute("data-gone", "");
    await expect.poll(() => flow("t2"), { timeout: 20_000 }).toBeGreaterThan(0);
  });

  test("the host's pointer moves over the stage and its ink is drawn", async () => {
    const cursor = guest.locator('.lv-cursor[data-cursor="host"]');
    await host(fakeHost, "cursor", 0.3, 0.3);
    await expect(cursor).toBeVisible();
    await expect(cursor.locator(".lv-cursor-name")).toHaveText("Zach");
    const first = await cursor.evaluate((element: HTMLElement) => element.style.transform);
    await host(fakeHost, "cursor", 0.62, 0.55);
    await expect.poll(() => cursor.evaluate((element: HTMLElement) => element.style.transform)).not.toBe(first);
    // It glides to where it was sent, on the stage.
    const stage = await boxOf(guest, '[data-testid="live-stage"]');
    await expect
      .poll(async () => {
        const box = await boxOf(guest, '.lv-cursor[data-cursor="host"]');
        return [Math.round(((box.x - stage.x) / stage.width) * 100), Math.round(((box.y - stage.y) / stage.height) * 100)];
      })
      .toEqual([62, 55]);

    // No ink yet and no pen in hand: the ink canvases hold no pixels.
    expect(await guest.locator(".lv-ink-canvas").evaluateAll((canvases: HTMLCanvasElement[]) => canvases.map((canvas) => canvas.width * canvas.height))).toEqual([0, 0]);
    // A pen stroke across the repo window, as the Mac would draw it.
    const points: number[] = [];
    for (let n = 0; n <= 24; n += 1) points.push(0.66 + n * 0.011, 0.36 + Math.sin(n / 3.5) * 0.05);
    await host(fakeHost, "ink", { op: "begin", id: "host:1", tool: "pen", color: HOST_COLOR, size: 0.003, pts: points.slice(0, 2) });
    await host(fakeHost, "ink", { op: "add", id: "host:1", pts: points.slice(2) });
    await host(fakeHost, "ink", { op: "end", id: "host:1" });
    const [sx, sy] = [points[24]!, points[25]!];
    await expect
      .poll(() =>
        guest.locator(".lv-ink-canvas").first().evaluate((canvas: HTMLCanvasElement, [x, y]) => {
          const context = canvas.getContext("2d");
          if (context === null) return 0;
          const px = Math.round(x * canvas.width);
          const py = Math.round(y * canvas.height);
          const data = context.getImageData(px - 3, py - 3, 7, 7).data;
          let alpha = 0;
          for (let index = 3; index < data.length; index += 4) alpha = Math.max(alpha, data[index]!);
          return alpha;
        }, [sx, sy] as const),
      )
      .toBeGreaterThan(200);

    // The guest's own pointer, over the stage, for the picture.
    await guest.mouse.move(stage.x + stage.width * 0.42, stage.y + stage.height * 0.7);
    await host(fakeHost, "cursor", 0.7, 0.45);
    await guest.waitForTimeout(captureEnabled ? 400 : 0);
    await capture(guest, "03-room-ink-cursors");
  });

  test("the guest's pointer reaches the host, stage-normalized", async () => {
    const stage = await boxOf(guest, '[data-testid="live-stage"]');
    await guest.mouse.move(stage.x + stage.width * 0.5, stage.y + stage.height * 0.25, { steps: 4 });
    await expect
      .poll(async () => {
        const last = (await inboxOf(fakeHost)).filter((m) => m.topic === "lv.cursor" && m.from.identity?.startsWith("g_") === true).at(-1);
        const body = last?.body as { x?: number; y?: number } | undefined;
        return body === undefined ? null : [Math.round((body.x ?? 0) * 100), Math.round((body.y ?? 0) * 100)];
      })
      .toEqual([50, 25]);
  });

  test("the guest draws and reacts, and the host receives both", async () => {
    await guest.keyboard.press("d");
    await expect(guest.getByRole("radio", { name: "Pen" })).toBeChecked();
    const stage = await boxOf(guest, '[data-testid="live-stage"]');
    const at = (x: number, y: number): [number, number] => [stage.x + stage.width * x, stage.y + stage.height * y];
    await guest.mouse.move(...at(0.2, 0.8));
    await guest.mouse.down();
    for (let n = 1; n <= 24; n += 1) await guest.mouse.move(...at(0.2 + n * 0.012, 0.8 - Math.sin(n / 4) * 0.04));
    await guest.mouse.up();
    const strokes = async () => (await inboxOf(fakeHost)).filter((m) => m.topic === "lv.ink" && m.from.identity?.startsWith("g_") === true).map((m) => m.body as { op: string; tool?: string; color?: string; pts?: number[] });
    await expect.poll(async () => (await strokes()).map((op) => op.op).at(-1)).toBe("end");
    const begin = (await strokes()).find((op) => op.op === "begin");
    expect(begin).toMatchObject({ tool: "pen", color: "#E54D2E" });
    expect(begin?.pts?.[0]).toBeCloseTo(0.2, 2);
    expect(begin?.pts?.[1]).toBeCloseTo(0.8, 2);

    await guest.getByRole("button", { name: "React" }).click();
    await guest.getByRole("button", { name: "React 🎉" }).click();
    await expect.poll(async () => (await inboxOf(fakeHost)).filter((m) => m.topic === "lv.react").map((m) => m.body)).toEqual([{ emoji: "🎉" }]);
    if (captureEnabled) {
      await guest.getByRole("button", { name: "React 👏" }).click();
      await guest.waitForTimeout(250);
      await guest.screenshot({ path: join(shotsDir, "03c-guest-ink-reaction.png") });
    }
    await guest.keyboard.press("Escape");
    await guest.keyboard.press("p");
    await expect(guest.getByRole("radio", { name: "Pointer" })).toBeChecked();
  });

  test("a click and typing on the window the host allows arrive at the right place; the other window gets nothing", async () => {
    const page = await boxOf(guest, '[data-window="t1"] [data-page]');
    await guest.mouse.click(page.x + page.width * 0.25, page.y + page.height * 0.5);
    await guest.keyboard.type("hi");
    await expect.poll(async () => (await inputs(fakeHost)).filter((input) => input.e.type === "keyUp").length).toBe(2);
    const received = await inputs(fakeHost);
    expect(received.every((input) => input.w === "t1")).toBe(true);
    const down = received.find((input) => input.e.type === "mouseDown");
    const up = received.find((input) => input.e.type === "mouseUp");
    expect(down?.e).toMatchObject({ button: "left", clickCount: 1 });
    expect(down?.e.x).toBeCloseTo(0.25, 2);
    expect(down?.e.y).toBeCloseTo(0.5, 2);
    expect(up?.e).toMatchObject({ button: "left" });
    expect(received.filter((input) => input.e.type === "char").map((input) => input.e.text)).toEqual(["h", "i"]);
    expect(received.filter((input) => input.e.type === "keyDown").map((input) => input.e.key)).toEqual(["h", "i"]);
    // The keyboard is the window's now, and says so.
    await expect(guest.locator('[data-window="t1"]')).toHaveAttribute("data-keyboard", "");

    // The repo window is not allowed: a click there goes nowhere. Input is reliable and ordered, so
    // once a later click on t1 has arrived, anything for t2 before it would have too.
    const other = await boxOf(guest, '[data-window="t2"] [data-page]');
    await guest.mouse.click(other.x + other.width * 0.5, other.y + other.height * 0.5);
    await guest.keyboard.type("x");
    await guest.mouse.click(page.x + page.width * 0.75, page.y + page.height * 0.25);
    await expect.poll(async () => (await inputs(fakeHost)).filter((input) => input.e.type === "mouseDown").length).toBe(2);
    const after = await inputs(fakeHost);
    expect(after.filter((input) => input.w === "t2")).toEqual([]);
    expect(after.filter((input) => input.e.type === "char").map((input) => input.e.text)).toEqual(["h", "i"]);
    const second = after.filter((input) => input.e.type === "mouseDown")[1];
    expect(second?.e.x).toBeCloseTo(0.75, 2);
    expect(second?.e.y).toBeCloseTo(0.25, 2);

    // Its tab offers to ask instead.
    await guest.locator('[data-window="t2"] .lvg-window-tab').hover();
    await guest.getByRole("button", { name: "Ask to use" }).click();
    await expect(guest.getByText("Asked Zach to use")).toBeVisible();
    await expect.poll(async () => (await inboxOf(fakeHost)).filter((m) => m.topic === "lv.ask").map((m) => m.body)).toEqual([{ w: "t2" }]);
    // The answer takes the ask's line away.
    await host(fakeHost, "desk", deskFrame({ t2: { controllable: true } }));
    await expect(guest.getByText("Zach let you use")).toBeVisible();
    await expect(guest.getByText("Asked Zach to use")).toHaveCount(0);
    await host(fakeHost, "desk", deskFrame());
    await expect(guest.locator('[data-window="t2"]')).not.toHaveAttribute("data-usable", "");

    // Asked again, and refused: the host says so to this guest alone, and the ask's line gives way to the answer.
    await guest.locator('[data-window="t2"] .lvg-window-tab').hover();
    await guest.getByRole("button", { name: "Ask to use" }).click();
    await expect(guest.getByText("Asked Zach to use")).toBeVisible();
    const me = (await host<string[]>(fakeHost, "participants")).find((id) => id.startsWith("g_"))!;
    await host(fakeHost, "send", "lv.refused", { w: "t2" }, [me]);
    await expect(guest.getByText("Zach said no to")).toBeVisible();
    await expect(guest.getByText("Asked Zach to use")).toHaveCount(0);
    await guest.locator('[data-window="t2"] .lvg-window-tab').hover();
    await expect(guest.getByRole("button", { name: "Ask to use" })).toBeVisible();
  });

  test("what the host changes shows as a line at the top, and input waits while the host is away", async () => {
    const downs = async (): Promise<number> => (await inputs(fakeHost)).filter((input) => input.e.type === "mouseDown").length;
    const before = await downs();
    const page = await boxOf(guest, '[data-window="t1"] [data-page]');

    // Away: the frame says no window may be used, and none is.
    await host(fakeHost, "desk", deskFrame({ hostPresent: false, t1: { controllable: false } }));
    await expect(guest.getByText("Zach is in another space")).toBeVisible();
    await guest.mouse.click(page.x + page.width * 0.5, page.y + page.height * 0.5);
    if (captureEnabled) await capture(guest, "03b-host-away");

    await host(fakeHost, "desk", deskFrame());
    await expect(guest.getByText("Zach is back")).toBeVisible();
    await expect(guest.getByText("Zach is in another space")).toHaveCount(0);
    // Back, and the window is usable again: only this click arrives.
    await guest.mouse.click(page.x + page.width * 0.5, page.y + page.height * 0.5);
    await expect.poll(downs).toBe(before + 1);

    // A window given over, right at the top of the stage, its label just under the top bar: the line never lies over it.
    const top = { x: 860, y: 0, w: 540, h: 660 };
    await host(fakeHost, "desk", deskFrame({ t2: { controllable: true, frame: top, page: top } }));
    await expect(guest.getByText("Zach let you use")).toBeVisible();
    expect(await bannersClearOfLabels(guest)).toBe(true);
    await expect(guest.locator('[data-window="t2"]')).toHaveAttribute("data-usable", "");
    // Narrower than the top bar can hold a line beside its own content: the line gets a row of its own, the stage starts below it.
    await guest.setViewportSize({ width: 1000, height: 760 });
    await host(fakeHost, "desk", deskFrame({ t2: { controllable: true, frame: top, page: top }, guestsCanDraw: false }));
    await expect(guest.getByText("Zach turned drawing off")).toBeVisible();
    await expect.poll(() => bannersClearOfLabels(guest)).toBe(true);
    await expect(guest.getByRole("radio", { name: "Pen" })).toBeDisabled();
    await guest.setViewportSize({ width: 1440, height: 900 });
    await host(fakeHost, "desk", deskFrame());
    await expect(guest.getByRole("radio", { name: "Pen" })).toBeEnabled();
  });

  test("chat goes both ways", async () => {
    await guest.keyboard.press("Escape");
    await guest.getByRole("button", { name: "Chat", exact: true }).click();
    await guest.getByLabel("Message").fill("Can you open the pricing doc?");
    await guest.keyboard.press("Enter");
    await expect.poll(async () => (await inboxOf(fakeHost)).filter((m) => m.topic === "lv.chat").map((m) => (m.body as { text: string }).text)).toEqual(["Can you open the pricing doc?"]);
    await host(fakeHost, "chat", "host:c1", "On it — one sec.");
    await expect(guest.locator(".lv-chat-message").filter({ hasText: "On it — one sec." })).toBeVisible();
    await expect(guest.locator(".lv-chat-name").filter({ hasText: "Zach" })).toBeVisible();
    await capture(guest, "04-chat-open");
    if (captureEnabled) {
      await guest.getByRole("button", { name: "Close chat" }).click();
      for (const [name, size] of [
        ["05-room-1280x720", { width: 1280, height: 720 }],
        ["06-room-900", { width: 900, height: 760 }],
      ] as const) {
        await guest.setViewportSize(size);
        await host(fakeHost, "cursor", 0.5, 0.42);
        await guest.waitForTimeout(500);
        await capture(guest, name);
      }
      await guest.setViewportSize({ width: 1440, height: 900 });
      await guest.emulateMedia({ colorScheme: "light" });
      await host(fakeHost, "cursor", 0.45, 0.5);
      await guest.waitForTimeout(500);
      await capture(guest, "07-room-light");
      await guest.emulateMedia({ colorScheme: "dark" });
    }
  });

  test("with anyone-with-the-link, a second guest joins at once — the first sees, hears and reads them once the host lists them — and leaves", async () => {
    // The camera's frames and the chat on both pages, while both run their rooms: slow on a loaded machine.
    test.setTimeout(90_000);
    expect((await control("PATCH", `/shares/${shareId}`, { admission: "open" })).status).toBe(200);
    // The host lets Bo in by hand, as main does once control lists him: until then he is in the room and nobody's guest.
    await host(fakeHost, "follow", false);
    const ana = (await host<string[]>(fakeHost, "participants")).find((id) => id.startsWith("g_"))!;
    const context = await browser!.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1280, height: 800 } });
    const second = await context.newPage();
    await second.goto(link);
    const root = second.getByTestId("live-guest");
    await expect(root).toHaveAttribute("data-screen", "lobby", { timeout: 60_000 });
    await second.getByLabel("Your name").fill("Bo");
    await second.getByRole("button", { name: "Join", exact: true }).click();
    await expect(root).toHaveAttribute("data-screen", "room", { timeout: 30_000 });
    await expect.poll(async () => (await host<string[]>(fakeHost, "participants")).length).toBe(3);
    const bo = (await host<string[]>(fakeHost, "participants")).find((id) => id.startsWith("g_") && id !== ana)!;

    // In the room, not let in: his camera reaches the host (who takes anyone's here), and neither guest shows the other.
    await host(fakeHost, "watchCamera", bo);
    await expect.poll(() => fakeHost.locator(`video[data-camera="${bo}"]`).evaluate((video: HTMLVideoElement) => video.videoWidth), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(guest.locator(".lvg-faces [data-face]")).toHaveCount(2);
    await expect(second.locator(".lvg-faces [data-face]")).toHaveCount(2);
    // What he says meanwhile waits for the host's word on whom to tell.
    await second.getByRole("button", { name: "Chat", exact: true }).click();
    await second.getByLabel("Message").fill("Hi, Bo here");
    await second.keyboard.press("Enter");
    await expect(second.locator(".lv-chat-message").filter({ hasText: "Hi, Bo here" })).toBeVisible();

    // When each page first shows the other guest's face, and their camera's picture in it.
    const watchFor = (page: Page, identity: string): Promise<void> =>
      page.evaluate((who) => {
        const seen: Record<string, number> = {};
        (window as unknown as { seen: Record<string, number> }).seen = seen;
        const look = (): void => {
          const face = document.querySelector(`.lvg-faces [data-face="${CSS.escape(who)}"]`);
          if (face !== null) seen["face"] ??= Date.now();
          const video = face?.querySelector("video");
          if (video !== null && video !== undefined && video.videoWidth > 0) seen["camera"] ??= Date.now();
          if (seen["camera"] === undefined) setTimeout(look, 5);
        };
        look();
      }, identity);
    const seenOn = (page: Page): Promise<Record<string, number>> => page.evaluate(() => (window as unknown as { seen: Record<string, number> }).seen);
    await watchFor(guest, bo);
    await watchFor(second, ana);

    const listedAt = await host<number>(fakeHost, "list", [ana, bo]);
    await expect(guest.locator(".lvg-faces [data-face]")).toHaveCount(3);
    await expect(second.locator(".lvg-faces [data-face]")).toHaveCount(3);
    await expect.poll(async () => (await seenOn(guest))["camera"] ?? null, { timeout: 20_000 }).not.toBeNull();
    await expect.poll(async () => (await seenOn(second))["camera"] ?? null, { timeout: 20_000 }).not.toBeNull();
    const [onAna, onBo] = [await seenOn(guest), await seenOn(second)];
    const after = (at: number | undefined): string => `${String((at ?? Number.NaN) - listedAt)} ms`;
    console.log(
      `[live-share-guest] once the host listed Bo: Ana showed his face ${after(onAna["face"])} and his camera ${after(onAna["camera"])} after; Bo showed Ana's face ${after(onBo["face"])} and her camera ${after(onBo["camera"])} after`,
    );
    // What Bo said before reached the host and Ana once he knew whom to tell; and they hear each other now.
    if ((await guest.locator(".lvg-chat-panel").getAttribute("data-open")) === null) await guest.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(guest.locator(".lv-chat-message").filter({ hasText: "Hi, Bo here" })).toBeVisible();
    await expect.poll(async () => (await inboxOf(fakeHost)).filter((m) => m.topic === "lv.chat").map((m) => (m.body as { text: string }).text)).toContain("Hi, Bo here");
    await guest.getByLabel("Message").fill("Welcome, Bo");
    await guest.keyboard.press("Enter");
    await expect(second.locator(".lv-chat-message").filter({ hasText: "Welcome, Bo" })).toBeVisible();

    await second.getByRole("button", { name: "Leave" }).click();
    await expect(root).toHaveAttribute("data-screen", "left");
    await expect(second.getByRole("heading", { name: "You left the share" })).toBeVisible();
    await expect.poll(async () => (await host<string[]>(fakeHost, "participants")).length).toBe(2);
    await host(fakeHost, "follow", true);
    await context.close();
  });

  // Near the end: the segmenter it starts again runs on the page's main thread (software WebGL), and would slow every later step.
  test("a reload while admitted brings the camera back behind the background chosen, from the first frame the host receives", async () => {
    // The segmenter loads again on the reloaded page before the camera goes out: tens of seconds on a loaded machine.
    test.setTimeout(150_000);
    const identity = (await host<string[]>(fakeHost, "participants")).find((id) => id.startsWith("g_"))!;
    const atHost = `video[data-camera="${identity}"]`;
    const blurred = async (selector: string): Promise<boolean> => {
      const look = await lookOf(fakeHost, selector);
      return look !== null && isBlurred(look, plain);
    };
    await guest.getByRole("button", { name: "Camera options" }).click();
    await guest.getByRole("menuitemradio", { name: "Blur" }).click();
    await expect.poll(() => blurred(atHost), { timeout: 60_000 }).toBe(true);
    await guest.keyboard.press("Escape");

    await host(fakeHost, "holdFirstFrame", identity);
    // The new page held a moment, as a slow network or server holds it: the page going away has long seen LiveKit
    // leave the room as it went (its page-leave disconnect) before the new one comes, and that is no leaving — the
    // request it keeps for the reload must still be there.
    await guest.route(
      link,
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.continue();
      },
      { times: 1 },
    );
    const loaded = loads.length;
    await guest.reload();
    // This load is the step's own; the check after each step is for loads nobody asked for.
    await expect.poll(() => loads.length).toBe(loaded + 1);
    loads.splice(loaded, 1);
    await expect(guest.getByTestId("live-guest")).toHaveAttribute("data-screen", "room", { timeout: 60_000 });
    const first = `canvas[data-first-frame="${identity}"]`;
    await expect.poll(() => fakeHost.locator(first).count(), { timeout: 120_000 }).toBe(1);
    const look = await lookOf(fakeHost, first);
    expect(look !== null && isBlurred(look, plain), `the first frame the host received: ${JSON.stringify(look)}`).toBe(true);
    if (captureEnabled) await savePicture(fakeHost, first, join(shotsDir, "09-host-first-frame-after-reload.png"));
    await expect.poll(() => blurred(atHost), { timeout: 20_000 }).toBe(true);
    // The menu names it again.
    await guest.getByRole("button", { name: "Camera options" }).click();
    await expect(guest.getByRole("menuitemradio", { name: "Blur" })).toHaveAttribute("aria-checked", "true");
    await guest.keyboard.press("Escape");
  });

  test("ending the share shows the guest that it ended", async () => {
    expect((await control("DELETE", `/shares/${shareId}`)).status).toBe(200);
    const root = guest.getByTestId("live-guest");
    await expect(root).toHaveAttribute("data-screen", "ended", { timeout: 20_000 });
    await expect(guest.getByRole("heading", { name: "This share has ended" })).toBeVisible();
    await capture(guest, "08-ended");
  });
});
