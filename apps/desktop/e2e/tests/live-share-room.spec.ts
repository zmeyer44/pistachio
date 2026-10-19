import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { build } from "vite";
import { startLiveKit, type LiveKitGrants, type LiveKitServer } from "./livekit-harness";

/**
 * `@pistachio/live-share/room` over a real SFU (docs/live-share.md §3, §4,
 * §12): a spawned `livekit-server`, and Chromium pages — the host, a guest,
 * and two impostors — each running `LiveRoom` from a page bundled here with
 * vite. No Electron and no control: tokens are minted with the server's key,
 * the knock is sent through LiveKit's server API as control sends it.
 *
 * What only a real room proves: roles and colours come from the token's
 * metadata; every topic arrives where §4 says and from nobody else — the
 * receiver checks the sender, so an impostor whose own client would send
 * (it claims the other role locally) is still dropped; what a guest says to
 * the host never reaches another guest's client at all (read off its data
 * channels, before LiveKit or the room sees a byte); a sync over 12 KB
 * crosses as a text stream intact; a window track published from a canvas
 * plays on the guest with frames at its aspect, and goes when unpublished;
 * a window captured afresh again and again (`replaceWindowTrack`) never
 * leaves the guest's video, its bitrate following each new size in place.
 */

const PAGE_ENTRY = "\0live-room-page";

/** The page: a thin handle on `LiveRoom` for the spec to drive through `page.evaluate`. */
const PAGE_SOURCE = `
import { LiveRoom, windowBitrate } from "@pistachio/live-share/room";
import { LIVE_TOPICS } from "@pistachio/live-share";

// Every peer connection the room makes, to read its senders and their stats,
// and everything its data channels receive, as text, before LiveKit reads it.
const connections = [];
const rawData = [];
const utf8 = new TextDecoder();
function tap(channel) {
  channel.addEventListener("message", (event) => {
    const data = event.data;
    if (typeof data === "string") rawData.push(data);
    else if (data instanceof Blob) void data.arrayBuffer().then((buffer) => rawData.push(utf8.decode(buffer)));
    else rawData.push(utf8.decode(data));
  });
}
const NativePeerConnection = window.RTCPeerConnection;
window.RTCPeerConnection = class extends NativePeerConnection {
  constructor(...args) {
    super(...args);
    connections.push(this);
    this.addEventListener("datachannel", (event) => tap(event.channel));
  }
  createDataChannel(...args) {
    const channel = super.createDataChannel(...args);
    tap(channel);
    return channel;
  }
};

const rooms = new Map();
const inbox = [];
const windowEvents = [];
const watched = new Map();
/** Someone's camera as one room shows it: frames drawn, and when the first was. */
const cameras = new Map();
/** The host's canvas tracks by window, with their painters, so a recapture can let the old one go. */
const canvases = new Map();
let capturing = null;

function canvasTrack(width, height, hint) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    context.fillStyle = "hsl(" + ((n * 7) % 360) + " 70% 50%)";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#fff";
    context.font = "96px sans-serif";
    context.fillText(String(n), 40, 120);
  }, 33);
  const track = canvas.captureStream(30).getVideoTracks()[0];
  if (hint) track.contentHint = hint;
  return { track, stop: () => { clearInterval(timer); track.stop(); } };
}

function senderOf(track) {
  for (const connection of connections) {
    for (const sender of connection.getSenders()) if (sender.track === track) return sender;
  }
  return null;
}

const room = (name) => {
  const found = rooms.get(name);
  if (!found) throw new Error("no room " + name);
  return found;
};

window.lv = {
  async connect(name, url, token, role, receivers) {
    const live = await LiveRoom.connect({ url, token, role, ...(receivers ? { receivers } : {}) });
    rooms.set(name, live);
    for (const topic of Object.keys(LIVE_TOPICS)) {
      live.onMessage(topic, (body, from) => inbox.push({ at: name, topic, body, from, receivedAt: Date.now() }));
    }
    live.on("windows", (ids) => windowEvents.push({ at: name, ids }));
    return live.identity;
  },
  participants: (name) => room(name).participants().map(({ camera, ...rest }) => ({ ...rest, camera: camera !== null })),
  inbox: (name) => inbox.filter((message) => message.at === name),
  rawData: () => rawData,
  stats: (name) => room(name).stats(),
  windowEvents: (name) => windowEvents.filter((event) => event.at === name).map((event) => event.ids),
  async send(name, topic, body, to) {
    await room(name).send(topic, body, to ? { to } : {});
  },
  async refusal(name, topic, body) {
    try {
      await room(name).send(topic, body);
      return null;
    } catch (error) {
      return error.name;
    }
  },
  async publishCanvas(name, windowId, width, height, hint) {
    const painted = canvasTrack(width, height, hint);
    canvases.set(windowId, painted);
    await room(name).publishWindow(windowId, painted.track);
    return RTCRtpSender.getCapabilities("video").codecs.some((codec) => /h264/i.test(codec.mimeType));
  },
  /** The window captured afresh at a new size: the new track takes the old one's place. */
  async recapture(name, windowId, width, height) {
    const before = canvases.get(windowId);
    const painted = canvasTrack(width, height);
    canvases.set(windowId, painted);
    await room(name).replaceWindowTrack(windowId, painted.track);
    before?.stop();
  },
  /** The window's sender now: its layers' bitrates and what encodes them. */
  async sending(windowId, width, height) {
    const sender = senderOf(canvases.get(windowId)?.track);
    if (sender === null) return null;
    // Chromium names the encoder in its stats only to a page that is capturing (webrtc-stats' exposure rule).
    capturing ??= navigator.mediaDevices.getUserMedia({ audio: true });
    await capturing;
    const encoders = [];
    for (const stat of (await sender.getStats()).values()) {
      if (stat.type === "outbound-rtp") encoders.push({ rid: stat.rid ?? null, encoder: stat.encoderImplementation ?? null, width: stat.frameWidth ?? null, fps: stat.framesPerSecond ?? null });
    }
    const layers = sender.getParameters().encodings.map((encoding) => ({ active: encoding.active !== false, scale: encoding.scaleResolutionDownBy ?? 1, maxBitrate: encoding.maxBitrate ?? null }));
    return { layers, expected: windowBitrate(width, height), encoders };
  },
  /** From now on, on the guest: every frame's time, and whether the video ever lost its stream. */
  monitor(windowId) {
    const state = watched.get(windowId);
    state.frameTimes = [];
    state.lostStream = false;
    state.firstTrack = room("guest").windowTrack(windowId);
    const look = () => {
      if (state.video.srcObject === null) state.lostStream = true;
      if (state.frameTimes !== null) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  },
  /** What the monitor saw: the longest gap between frames, lost streams, and whether the track stayed the one it was. */
  monitored(windowId) {
    const state = watched.get(windowId);
    const times = state.frameTimes;
    state.frameTimes = null;
    let gap = 0;
    for (let index = 1; index < times.length; index += 1) gap = Math.max(gap, times[index] - times[index - 1]);
    return { frames: times.length, maxGapMs: Math.round(gap), lostStream: state.lostStream, sameTrack: room("guest").windowTrack(windowId) === state.firstTrack, width: state.video.videoWidth, height: state.video.videoHeight };
  },
  unpublish: (name, windowId) => room(name).unpublishWindow(windowId),
  published: (name) => room(name).publishedWindows(),
  watchWindow(name, windowId) {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = "display:block;width:640px;height:360px";
    document.body.append(video);
    const state = { frames: 0, video, detach: null, frameTimes: null, lostStream: false, firstTrack: null };
    const count = (now) => {
      state.frames += 1;
      state.frameTimes?.push(now);
      video.requestVideoFrameCallback(count);
    };
    video.requestVideoFrameCallback(count);
    state.detach = room(name).attachWindow(windowId, video);
    watched.set(windowId, state);
  },
  async windowPicture(name, windowId) {
    const state = watched.get(windowId);
    const track = room(name).windowTrack(windowId);
    let codec = null;
    if (track) {
      const report = await track.getRTCStatsReport();
      for (const stat of report?.values() ?? []) if (stat.type === "codec") codec = stat.mimeType;
    }
    return { frames: state.frames, width: state.video.videoWidth, height: state.video.videoHeight, hasTrack: track !== null, codec };
  },
  async media(name, mic, camera) {
    await room(name).setMicrophone(mic);
    await room(name).setCamera(camera);
  },
  /** Show someone's camera as this room has it (none while it shows them no camera, or not them at all), counting frames. */
  watchCamera(name, identity) {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = "display:block;width:320px;height:180px";
    document.body.append(video);
    const state = { frames: 0, first: null };
    const count = () => {
      state.frames += 1;
      state.first ??= Date.now();
      video.requestVideoFrameCallback(count);
    };
    video.requestVideoFrameCallback(count);
    let shown = null;
    const show = () => {
      const camera = room(name).participants().find((person) => person.identity === identity)?.camera ?? null;
      if (camera === shown) return;
      shown?.detach(video);
      shown = camera;
      camera?.attach(video);
    };
    room(name).on("participants", show);
    show();
    cameras.set(name + "/" + identity, state);
  },
  cameraFrames: (name, identity) => cameras.get(name + "/" + identity) ?? null,
  /** Every media stream this page's peer connections receive, read off WebRTC itself: its kind and bytes. */
  async inbound() {
    const streams = [];
    for (const connection of connections) {
      for (const stat of (await connection.getStats()).values()) if (stat.type === "inbound-rtp") streams.push({ kind: stat.kind, bytes: stat.bytesReceived ?? 0 });
    }
    return streams;
  },
  /** The room plays remote sound through audio elements it adds: how many there are. */
  audioElements: () => document.querySelectorAll("audio").length,
  disconnect: (name) => room(name).disconnect(),
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
  ".css": "text/css; charset=utf-8",
};

/** Bundle the page with vite and serve it on loopback. */
async function servePage(): Promise<Site> {
  const outDir = await mkdtemp(join(tmpdir(), "live-room-page-"));
  await build({
    configFile: false,
    root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "warn",
    publicDir: false,
    plugins: [
      {
        name: "live-room-page",
        resolveId: (id) => (id === PAGE_ENTRY ? PAGE_ENTRY : null),
        load: (id) => (id === PAGE_ENTRY ? PAGE_SOURCE : null),
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
      response.end('<!doctype html><meta charset="utf-8"><title>live room</title><body><script type="module" src="/page.js"></script></body>');
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

const ROOM = "live_room_spec";
const HOST_COLOR = "#3E63DD";
const GUEST_COLOR = "#E54D2E";

const hostGrants: LiveKitGrants = { room: ROOM, roomJoin: true, canPublish: true, canPublishData: true, canSubscribe: true };
const guestGrants: LiveKitGrants = {
  room: ROOM,
  roomJoin: true,
  canPublish: true,
  canPublishSources: ["camera", "microphone"],
  canPublishData: true,
  canSubscribe: true,
  canUpdateOwnMetadata: false,
};

const meta = (role: "host" | "guest", color: string): string => JSON.stringify({ role, color });

interface Received {
  topic: string;
  body: unknown;
  from: { identity: string | null; role: string };
  receivedAt: number;
}

interface RoomStats {
  received: number;
  dropped: number;
  droppedByTopic: Record<string, number>;
}

/** Call the page's `window.lv[method](...args)`. */
function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ([name, rest]) => {
      const lv = (window as unknown as { lv: Record<string, (...values: unknown[]) => unknown> }).lv;
      const fn = lv[name];
      if (fn === undefined) throw new Error(`no lv.${name}`);
      return (await fn(...rest)) as T;
    },
    [method, args] as const,
  );
}

const inbox = (page: Page, name: string): Promise<Received[]> => call(page, "inbox", name);
const stats = (page: Page, name: string): Promise<RoomStats> => call(page, "stats", name);

/**
 * The host tells the guests it lets in who they are (§4 `lv.guests`), as
 * the app's host does on every change; resolves once each named room
 * (page, name) shows exactly the host, itself and the others listed.
 */
async function listGuests(host: Page, guests: string[], ...rooms: Array<[Page, string]>): Promise<void> {
  await call(host, "send", "host", "lv.guests", { guests }, guests);
  for (const [page, name] of rooms) {
    await expect.poll(async () => (await call<Array<{ identity: string }>>(page, "participants", name)).map((p) => p.identity).sort()).toEqual(["host", ...guests].sort());
  }
}

test.describe.serial("live share room over a real SFU", { tag: ["@share"] }, () => {
  let livekit: LiveKitServer | undefined;
  let site: Site | undefined;
  let browser: Browser | undefined;
  let host: Page;
  let guest: Page;
  let impostors: Page;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    livekit = await startLiveKit();
    site = await servePage();
    browser = await chromium.launch({
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    });
    const open = async (): Promise<Page> => {
      const context = await browser!.newContext({ permissions: ["camera", "microphone"] });
      const page = await context.newPage();
      page.on("pageerror", (error) => console.log(`[page error] ${error.message}`));
      await page.goto(site!.url);
      await page.waitForFunction(() => "lv" in window);
      return page;
    };
    [host, guest, impostors] = [await open(), await open(), await open()];
    const lk = livekit;
    // The host lets Ana in as it joins, as the app's host does whom main admits: nobody else, until it says.
    expect(await call(host, "connect", "host", lk.url, lk.mintToken("host", "Zach", meta("host", HOST_COLOR), hostGrants), "host", ["g_ana"])).toBe("host");
    expect(await call(guest, "connect", "guest", lk.url, lk.mintToken("g_ana", "Ana", meta("guest", GUEST_COLOR), guestGrants), "guest")).toBe("g_ana");
  });

  test.afterAll(async () => {
    await browser?.close();
    await site?.close();
    await livekit?.stop();
  });

  test("both see each other, with role and colour from the token's metadata", async () => {
    const expected = [
      { identity: "host", name: "Zach", role: "host", color: HOST_COLOR },
      { identity: "g_ana", name: "Ana", role: "guest", color: GUEST_COLOR },
    ];
    await expect.poll(async () => (await call<Array<{ identity: string; name: string; role: string; color: string; isLocal: boolean }>>(host, "participants", "host")).map(({ identity, name, role, color }) => ({ identity, name, role, color }))).toEqual(expected);
    const seenByGuest = await call<Array<{ identity: string; role: string; color: string; isLocal: boolean }>>(guest, "participants", "guest");
    expect(seenByGuest.map(({ identity, role, color, isLocal }) => ({ identity, role, color, isLocal }))).toEqual([
      { identity: "host", role: "host", color: HOST_COLOR, isLocal: false },
      { identity: "g_ana", role: "guest", color: GUEST_COLOR, isLocal: true },
    ]);
  });

  test("every topic arrives where §4 says, from the sender it names", async () => {
    const lk = livekit!;
    const fromGuest: Array<[string, unknown]> = [
      ["lv.cursor", { x: 0.25, y: 0.5, tool: "pen", down: true }],
      ["lv.ink", { op: "begin", id: "g_ana:1", tool: "pen", color: GUEST_COLOR, size: 0.003, pts: [0.1, 0.2] }],
      ["lv.ping", { x: 0.3, y: 0.3 }],
      ["lv.react", { emoji: "👏" }],
      ["lv.chat", { id: "c1", text: "hi from Ana" }],
      ["lv.hello", {}],
      ["lv.input", { w: "tab-1", e: { type: "keyDown", key: "a", code: "KeyA", modifiers: [] } }],
      ["lv.ask", { w: "tab-1" }],
    ];
    const desk = {
      v: 1,
      seq: 1,
      stage: { w: 1280, h: 720 },
      hostPresent: true,
      space: { title: "Launch plan", color: "#46A758" },
      windows: [],
    };
    const fromHost: Array<[string, unknown]> = [
      ["lv.desk", desk],
      ["lv.cursor", { x: 0.75, y: 0.5, tool: "pointer" }],
      ["lv.ink", { op: "clear", scope: "all" }],
      ["lv.ping", { x: 0.6, y: 0.6 }],
      ["lv.react", { emoji: "🎉" }],
      ["lv.chat", { id: "c2", text: "hi from Zach" }],
      ["lv.sync", { desk, strokes: [], chat: [], grants: [] }],
      ["lv.grant", { w: "tab-1", user: "g_ana" }],
    ];
    // Who Ana is with: the host, and the guests it lists (none but her yet). Until a list comes, her strokes and chat
    // wait for one.
    await call(host, "send", "host", "lv.guests", { guests: ["g_ana"] }, ["g_ana"]);
    await expect.poll(async () => (await inbox(guest, "guest")).map((m) => m.topic)).toEqual(["lv.guests"]);
    for (const [topic, body] of fromGuest) await call(guest, "send", "guest", topic, body);
    for (const [topic, body] of fromHost) await call(host, "send", "host", topic, body);
    await lk.sendData(ROOM, "lv.knock", new TextEncoder().encode(JSON.stringify({ requestId: "Rq1", name: "Bo" })), ["host"]);

    const shape = (messages: Received[]) => messages.map(({ topic, body, from }) => ({ topic, body, from }));
    await expect.poll(async () => (await inbox(host, "host")).length).toBe(fromGuest.length + 1);
    expect(shape(await inbox(host, "host"))).toEqual(
      expect.arrayContaining([
        ...fromGuest.map(([topic, body]) => ({ topic, body, from: { identity: "g_ana", role: "guest" } })),
        { topic: "lv.knock", body: { requestId: "Rq1", name: "Bo" }, from: { identity: null, role: "server" } },
      ]),
    );
    await expect.poll(async () => (await inbox(guest, "guest")).length).toBe(fromHost.length + 1);
    // Lossy cursors ride another channel than the reliable topics, so arrival order is not asserted.
    expect(shape(await inbox(guest, "guest"))).toEqual(
      expect.arrayContaining([...fromHost, ["lv.guests", { guests: ["g_ana"] }] as const].map(([topic, body]) => ({ topic, body, from: { identity: "host", role: "host" } }))),
    );

    // A client refuses to send what its role may not.
    expect(await call(guest, "refusal", "guest", "lv.desk", desk)).toBe("LiveProtocolError");
    expect(await call(host, "refusal", "host", "lv.input", { w: "tab-1", e: { type: "char", text: "x" } })).toBe("LiveProtocolError");
    expect(await call(guest, "refusal", "guest", "lv.knock", { requestId: "Rq2", name: "Eve" })).toBe("LiveProtocolError");
  });

  test("a receiver drops what the sender's role may not send, whatever its client claims", async () => {
    const lk = livekit!;
    // Mallory is a guest whose page claims to be the host; Hal holds host
    // metadata and claims to be a guest. Their clients send what the claim
    // allows; the receivers go by the token's metadata.
    await call(impostors, "connect", "mallory", lk.url, lk.mintToken("g_mallory", "Mallory", meta("guest", "#46A758"), guestGrants), "host");
    await call(impostors, "connect", "hal", lk.url, lk.mintToken("hal", "Hal", meta("host", "#8E4EC6"), hostGrants), "guest");
    await expect.poll(async () => (await call<unknown[]>(host, "participants", "host")).length).toBe(4);
    const hostBefore = await stats(host, "host");
    const guestBefore = await stats(guest, "guest");

    const desk = { v: 1, seq: 99, stage: { w: 10, h: 10 }, hostPresent: false, space: { title: "Fake", color: "#000000" }, windows: [] };
    await call(impostors, "send", "mallory", "lv.desk", desk);
    await call(impostors, "send", "mallory", "lv.grant", { w: "tab-1", user: "g_mallory" });
    // Over 12 KB: crosses as a text stream, and is dropped on that path too.
    const big = Array.from({ length: 12 }, (_, n) => ({ id: `m${String(n)}`, from: "host", name: "Zach", color: HOST_COLOR, text: "x".repeat(1900), at: n }));
    await call(impostors, "send", "mallory", "lv.sync", { desk, strokes: [], chat: big, grants: [] });
    await call(impostors, "send", "hal", "lv.input", { w: "tab-1", e: { type: "insertText", text: "rm -rf" } });
    await call(impostors, "send", "hal", "lv.ask", { w: "tab-1" });
    await call(impostors, "send", "hal", "lv.hello", {});
    // The server may send only knocks.
    await lk.sendData(ROOM, "lv.desk", new TextEncoder().encode(JSON.stringify(desk)), ["host"]);
    // And a guest's message still goes through, after all of that.
    await call(guest, "send", "guest", "lv.chat", { id: "c3", text: "still here" });

    await expect.poll(async () => (await inbox(host, "host")).some((m) => m.body !== null && (m.body as { id?: string }).id === "c3")).toBe(true);
    await expect
      .poll(async () => {
        const after = await stats(host, "host");
        const delta = (topic: string) => (after.droppedByTopic[topic] ?? 0) - (hostBefore.droppedByTopic[topic] ?? 0);
        return { desk: delta("lv.desk"), grant: delta("lv.grant"), sync: delta("lv.sync"), input: delta("lv.input"), ask: delta("lv.ask"), hello: delta("lv.hello") };
      })
      .toEqual({ desk: 2, grant: 1, sync: 1, input: 1, ask: 1, hello: 1 });
    await expect
      .poll(async () => {
        const after = await stats(guest, "guest");
        return ["lv.desk", "lv.grant", "lv.sync"].map((topic) => (after.droppedByTopic[topic] ?? 0) - (guestBefore.droppedByTopic[topic] ?? 0));
      })
      .toEqual([1, 1, 1]);
    const names = (messages: Received[]) => messages.filter((m) => m.from.identity === "g_mallory" || m.from.identity === "hal").map((m) => m.topic);
    expect(names(await inbox(host, "host"))).toEqual([]);
    expect(names(await inbox(guest, "guest"))).toEqual([]);

    await call(impostors, "disconnect", "mallory");
    await call(impostors, "disconnect", "hal");
    await expect.poll(async () => (await call<unknown[]>(host, "participants", "host")).length).toBe(2);
  });

  test("a sync over 12 KB reaches only the guest it names, whole", async () => {
    const lk = livekit!;
    await call(impostors, "connect", "bo", lk.url, lk.mintToken("g_bo", "Bo", meta("guest", "#46A758"), guestGrants), "guest");
    await expect.poll(async () => (await call<unknown[]>(host, "participants", "host")).length).toBe(3);
    await listGuests(host, ["g_ana", "g_bo"], [guest, "guest"], [impostors, "bo"]);
    const chat = Array.from({ length: 40 }, (_, n) => ({ id: `h${String(n)}`, from: "g_ana", name: "Ana", color: GUEST_COLOR, text: `${String(n)} ${"ü".repeat(1500)}`, at: 1_700_000_000_000 + n }));
    const strokes = Array.from({ length: 50 }, (_, n) => ({ id: `host:${String(n)}`, tool: "pen", color: HOST_COLOR, size: 0.0025, pts: Array.from({ length: 400 }, (_, k) => ((k * 37 + n) % 1000) / 1000), done: true }));
    const sync = { desk: null, strokes, chat, grants: [{ w: "tab-1", user: "g_ana" }] };
    const size = new TextEncoder().encode(JSON.stringify(sync)).byteLength;
    expect(size).toBeGreaterThan(100 * 1024);
    await call(host, "send", "host", "lv.sync", sync, ["g_ana"]);
    await expect.poll(async () => (await inbox(guest, "guest")).filter((m) => m.topic === "lv.sync").length).toBe(2);
    const received = (await inbox(guest, "guest")).filter((m) => m.topic === "lv.sync").at(-1);
    expect(received?.body).toEqual(sync);
    expect(received?.from).toEqual({ identity: "host", role: "host" });
    // Bo was not named: nothing arrives for him.
    await call(guest, "send", "guest", "lv.chat", { id: "c4", text: "after the sync" });
    await expect.poll(async () => (await inbox(impostors, "bo")).some((m) => m.topic === "lv.chat")).toBe(true);
    expect((await inbox(impostors, "bo")).filter((m) => m.topic === "lv.sync")).toEqual([]);
    await call(impostors, "disconnect", "bo");
    await listGuests(host, ["g_ana"], [guest, "guest"]);
  });

  test("what a guest says to the host reaches the host alone: another guest's client never receives a byte of it", async () => {
    const lk = livekit!;
    // Cy, a second guest, on a page of her own: everything its data channels receive is hers.
    const context = await browser!.newContext();
    const cy = await context.newPage();
    await cy.goto(site!.url);
    await cy.waitForFunction(() => "lv" in window);
    await call(cy, "connect", "cy", lk.url, lk.mintToken("g_cy", "Cy", meta("guest", "#46A758"), guestGrants), "guest");
    await expect.poll(async () => (await call<unknown[]>(host, "participants", "host")).length).toBe(3);
    await listGuests(host, ["g_ana", "g_cy"], [guest, "guest"], [cy, "cy"]);
    const reachedCy = async (id: string) => (await inbox(cy, "cy")).some((m) => m.topic === "lv.chat" && (m.body as { id: string }).id === id);
    // Ana's word for everyone reaches Cy: from here on, anything of Ana's sent to all would too.
    await call(guest, "send", "guest", "lv.chat", { id: "before", text: "before the private ones" });
    await expect.poll(() => reachedCy("before")).toBe(true);

    const hostBefore = (await inbox(host, "host")).length;
    const toHost: Array<[string, unknown, string[] | undefined]> = [
      ["lv.hello", {}, undefined],
      ["lv.input", { w: "tab-1", e: { type: "insertText", text: "hunter2" } }, undefined],
      // Naming Cy, or nobody in a list LiveKit would read as everyone, changes nothing.
      ["lv.input", { w: "tab-1", e: { type: "keyDown", key: "p", code: "KeyP", modifiers: [] } }, ["g_cy"]],
      ["lv.ask", { w: "tab-1" }, []],
    ];
    for (const [topic, body, to] of toHost) await call(guest, "send", "guest", topic, body, to);
    // Sent after them on the same reliable channel: once Cy has it, she would have had them.
    await call(guest, "send", "guest", "lv.chat", { id: "after", text: "after the private ones" });
    await expect.poll(() => reachedCy("after")).toBe(true);

    const raw = await call<string[]>(cy, "rawData");
    expect(raw.some((text) => text.includes("after the private ones"))).toBe(true);
    expect(raw.filter((text) => ["lv.hello", "lv.input", "lv.ask", "hunter2"].some((word) => text.includes(word)))).toEqual([]);
    expect((await inbox(cy, "cy")).map((m) => m.topic)).toEqual(["lv.guests", "lv.chat", "lv.chat"]);
    // And the host has every one of them.
    await expect
      .poll(async () => (await inbox(host, "host")).slice(hostBefore).filter((m) => m.topic !== "lv.chat").map(({ topic, body, from }) => ({ topic, body, from: from.identity })))
      .toEqual(toHost.map(([topic, body]) => ({ topic, body, from: "g_ana" })));

    await call(cy, "disconnect", "cy");
    await context.close();
    await expect.poll(async () => (await call<unknown[]>(host, "participants", "host")).length).toBe(2);
    await listGuests(host, ["g_ana"], [guest, "guest"]);
  });

  test("pointers cross the room well under 100 ms", async () => {
    const samples: number[] = [];
    for (let n = 0; n < 20; n += 1) {
      const sentAt = Date.now();
      await call(guest, "send", "guest", "lv.cursor", { x: n / 20, y: 0.5, tool: "pointer" });
      await expect.poll(async () => (await inbox(host, "host")).some((m) => m.topic === "lv.cursor" && (m.body as { x: number }).x === n / 20), { intervals: [5] }).toBe(true);
      const arrived = (await inbox(host, "host")).find((m) => m.topic === "lv.cursor" && (m.body as { x: number }).x === n / 20);
      samples.push(arrived!.receivedAt - sentAt);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;
    console.log(`lv.cursor guest → host through the SFU: median ${String(median)} ms, max ${String(samples.at(-1))} ms`);
    expect(median).toBeLessThan(100);
  });

  test("a window track plays on the guest at its aspect, and goes when unpublished", async () => {
    const canH264 = await call<boolean>(host, "publishCanvas", "host", "tab-1", 1280, 720);
    expect(await call(host, "published", "host")).toEqual(["tab-1"]);
    await call(guest, "watchWindow", "guest", "tab-1");
    await expect.poll(async () => (await call<{ frames: number }>(guest, "windowPicture", "guest", "tab-1")).frames, { timeout: 20_000 }).toBeGreaterThan(30);
    const picture = await call<{ frames: number; width: number; height: number; hasTrack: boolean; codec: string | null }>(guest, "windowPicture", "guest", "tab-1");
    console.log(`window picture on the guest: ${String(picture.width)}×${String(picture.height)}, ${String(picture.codec)}, ${String(picture.frames)} frames`);
    expect(picture.width / picture.height).toBeCloseTo(16 / 9, 1);
    if (canH264) expect(picture.codec).toMatch(/h264/i);
    expect(await call<string[][]>(guest, "windowEvents", "guest")).toContainEqual(["tab-1"]);

    await call(host, "unpublish", "host", "tab-1");
    expect(await call(host, "published", "host")).toEqual([]);
    await expect.poll(async () => (await call<{ hasTrack: boolean }>(guest, "windowPicture", "guest", "tab-1")).hasTrack).toBe(false);
    await expect.poll(async () => (await call<string[][]>(guest, "windowEvents", "guest")).at(-1)).toEqual([]);
    const stopped = (await call<{ frames: number }>(guest, "windowPicture", "guest", "tab-1")).frames;
    await host.waitForTimeout(500); // the time itself is what is tested: no frame comes after the unpublish
    expect((await call<{ frames: number }>(guest, "windowPicture", "guest", "tab-1")).frames).toBe(stopped);
  });

  test("a window captured afresh keeps its picture on the guest: ten recaptures, never blank, no 200 ms gap", async () => {
    await call(host, "publishCanvas", "host", "tab-2", 1280, 720);
    await call(guest, "watchWindow", "guest", "tab-2");
    await expect.poll(async () => (await call<{ frames: number }>(guest, "windowPicture", "guest", "tab-2")).frames, { timeout: 20_000 }).toBeGreaterThan(30);
    await expect.poll(async () => (await call<{ encoders: Array<{ encoder: string | null }> }>(host, "sending", "tab-2", 1280, 720)).encoders.some((each) => each.encoder !== null)).toBe(true);
    const before = await call<{ encoders: unknown[] }>(host, "sending", "tab-2", 1280, 720);
    console.log(`window track encoders (unhinted): ${JSON.stringify(before.encoders)}`);
    const eventsBefore = (await call<string[][]>(guest, "windowEvents", "guest")).length;
    await call(guest, "monitor", "tab-2");
    const sizes = [
      [960, 540],
      [1280, 720],
    ] as const;
    for (let n = 0; n < 10; n += 1) {
      const [width, height] = sizes[n % 2]!;
      await call(host, "recapture", "host", "tab-2", width, height);
      // The bitrate follows the new size on the same sender, in place: the full layer at the size's, the half at a third.
      await expect
        .poll(async () => {
          const sending = await call<{ layers: Array<{ active: boolean; scale: number; maxBitrate: number | null }>; expected: number }>(host, "sending", "tab-2", width, height);
          const active = sending.layers.filter((layer) => layer.active);
          return active.length > 0 && active.every((layer) => layer.maxBitrate === (layer.scale > 1 ? Math.round(sending.expected / 3) : sending.expected));
        })
        .toBe(true);
      await host.waitForTimeout(300); // the time itself is what is tested: frames keep coming across each swap
    }
    const seen = await call<{ frames: number; maxGapMs: number; lostStream: boolean; sameTrack: boolean; width: number; height: number }>(guest, "monitored", "tab-2");
    console.log(`ten recaptures on the guest: ${String(seen.frames)} frames, longest gap ${String(seen.maxGapMs)} ms, now ${String(seen.width)}×${String(seen.height)}`);
    expect(seen.lostStream).toBe(false);
    expect(seen.sameTrack).toBe(true);
    expect(seen.maxGapMs).toBeLessThan(200);
    // The window never left the guest's pictures, not for a moment.
    expect((await call<string[][]>(guest, "windowEvents", "guest")).slice(eventsBefore).filter((ids) => !ids.includes("tab-2"))).toEqual([]);
    expect(seen.width / seen.height).toBeCloseTo(16 / 9, 1);
    await call(host, "unpublish", "host", "tab-2");
  });

  test("what encodes a window track in this Chromium with the old \"detail\" hint (logged for the record)", async () => {
    // Playwright's Chromium is not Electron (it has no hardware H.264 encoder at all): the decisive
    // measurement is the desktop's. This records what the hint does here, beside the unhinted run above.
    await call(host, "publishCanvas", "host", "tab-3", 1280, 720, "detail");
    await call(guest, "watchWindow", "guest", "tab-3");
    await expect.poll(async () => (await call<{ encoders: Array<{ encoder: string | null }> }>(host, "sending", "tab-3", 1280, 720)).encoders.some((each) => each.encoder !== null), { timeout: 20_000 }).toBe(true);
    const start = (await call<{ frames: number }>(guest, "windowPicture", "guest", "tab-3")).frames;
    await host.waitForTimeout(5_000); // the time itself is what is measured: frames in five seconds
    const frames = (await call<{ frames: number }>(guest, "windowPicture", "guest", "tab-3")).frames - start;
    const detail = await call<{ encoders: unknown[] }>(host, "sending", "tab-3", 1280, 720);
    console.log(`window track encoders ("detail"): ${JSON.stringify(detail.encoders)}; the guest drew ${String(frames)} frames in 5 s`);
    await call(host, "unpublish", "host", "tab-3");
  });

  test("a guest's camera and microphone show on the host", async () => {
    await call(guest, "media", "guest", true, true);
    await expect
      .poll(async () => (await call<Array<{ identity: string; micOn: boolean; cameraOn: boolean; camera: boolean }>>(host, "participants", "host")).find((p) => p.identity === "g_ana"))
      .toMatchObject({ micOn: true, cameraOn: true, camera: true });
    await call(guest, "media", "guest", true, false);
    await expect
      .poll(async () => (await call<Array<{ identity: string; cameraOn: boolean }>>(host, "participants", "host")).find((p) => p.identity === "g_ana"))
      .toMatchObject({ micOn: true, cameraOn: false, camera: false });
  });

  test("a guest's camera, mic and word reach the host and the guests it lists, and nobody else in the room", async () => {
    const lk = livekit!;
    /** A page of its own: everything its peer connections receive is that participant's. */
    const open = async (): Promise<Page> => {
      const context = await browser!.newContext({ permissions: ["camera", "microphone"] });
      const page = await context.newPage();
      await page.goto(site!.url);
      await page.waitForFunction(() => "lv" in window);
      return page;
    };
    // Dee, a second guest the host lets in. Eve, in the room with a guest's token the host never lists — a removed
    // guest before LiveKit drops her, or a token minted outside control — whose client says what it likes to
    // everyone (it claims the host's role locally).
    const [dee, eve] = [await open(), await open()];
    await call(dee, "connect", "dee", lk.url, lk.mintToken("g_dee", "Dee", meta("guest", "#12A594"), guestGrants), "guest");
    // (Her client takes whatever it is let have, and lets anyone have hers.)
    await call(eve, "connect", "eve", lk.url, lk.mintToken("g_eve", "Eve", meta("guest", "#D6409F"), guestGrants), "host", ["host", "g_ana", "g_dee"]);
    await expect.poll(async () => (await call<unknown[]>(host, "participants", "host")).length).toBe(4);
    await call(dee, "watchCamera", "dee", "g_ana");
    await call(eve, "watchCamera", "eve", "g_ana");

    // Ana's camera comes on while the host has listed nobody but her: the host gets it, Dee does not, yet.
    await call(guest, "media", "guest", true, true);
    await call(host, "watchCamera", "host", "g_ana");
    await expect.poll(async () => (await call<{ frames: number } | null>(host, "cameraFrames", "host", "g_ana"))?.frames ?? 0, { timeout: 20_000 }).toBeGreaterThan(10);
    const received = async (page: Page) => (await call<Array<{ kind: string; bytes: number }>>(page, "inbound")).filter((stream) => stream.bytes > 0);
    expect(await received(dee)).toEqual([]);

    // Let in beside her: one hop of the host's list later, Dee and Ana are with each other.
    const listedAt = Date.now();
    await call(host, "send", "host", "lv.guests", { guests: ["g_ana", "g_dee"] }, ["g_ana", "g_dee"]);
    await expect.poll(async () => (await call<{ frames: number } | null>(dee, "cameraFrames", "dee", "g_ana"))?.frames ?? 0, { timeout: 20_000 }).toBeGreaterThan(10);
    const listHeard = async (page: Page, name: string) => (await inbox(page, name)).find((m) => m.topic === "lv.guests" && (m.body as { guests: string[] }).guests.includes("g_dee"))!.receivedAt;
    const firstFrame = (await call<{ first: number }>(dee, "cameraFrames", "dee", "g_ana")).first;
    console.log(
      `a guest let in beside another: the list reached Ana ${String((await listHeard(guest, "guest")) - listedAt)} ms and Dee ${String((await listHeard(dee, "dee")) - listedAt)} ms after the host sent it; Dee drew Ana's camera ${String(firstFrame - listedAt)} ms after`,
    );

    // Ana says something of every kind; Eve says hello to everyone and turns her camera and mic on.
    const anaBefore = await stats(guest, "guest");
    const fromAna: Array<[string, unknown]> = [
      ["lv.cursor", { x: 0.4, y: 0.4, tool: "pointer" }],
      ["lv.ink", { op: "begin", id: "g_ana:77", tool: "pen", color: GUEST_COLOR, size: 0.003, pts: [0.4, 0.4] }],
      ["lv.ping", { x: 0.41, y: 0.41 }],
      ["lv.react", { emoji: "🙌" }],
      ["lv.chat", { id: "ana-room", text: "for the room alone" }],
    ];
    for (const [topic, body] of fromAna) await call(guest, "send", "guest", topic, body);
    await call(eve, "media", "eve", true, true);
    await call(eve, "send", "eve", "lv.chat", { id: "eve-1", text: "let me in" });
    const has = async (page: Page, name: string, id: string) => (await inbox(page, name)).some((m) => m.topic === "lv.chat" && (m.body as { id: string }).id === id);
    await expect.poll(() => has(host, "host", "ana-room")).toBe(true);
    await expect.poll(() => has(dee, "dee", "ana-room")).toBe(true);
    await expect.poll(() => has(host, "host", "eve-1")).toBe(true);
    // Eve's word reached Ana's client and was dropped there, unread.
    await expect.poll(async () => ((await stats(guest, "guest")).droppedByTopic["lv.chat"] ?? 0) - (anaBefore.droppedByTopic["lv.chat"] ?? 0)).toBe(1);
    // Sent Eve after Ana's last word had reached the host and Dee: had any of Ana's been on its way to Eve, it would be in.
    await call(host, "send", "host", "lv.grant", { w: "fence", user: null }, ["g_eve"]);
    await expect.poll(async () => (await inbox(eve, "eve")).some((m) => m.topic === "lv.grant")).toBe(true);

    // The host and Dee have Ana's camera and word; Eve has none of it, read off her data channels and her peer
    // connections before LiveKit or the room sees a byte.
    // (A pointer is lossy: it may not cross; everything reliable does, in order, before the chat waited on above.)
    expect((await inbox(dee, "dee")).filter((m) => m.from.identity === "g_ana").map((m) => m.topic)).toEqual(expect.arrayContaining(["lv.ink", "lv.ping", "lv.react", "lv.chat"]));
    expect((await call<Array<{ identity: string; camera: boolean }>>(host, "participants", "host")).find((p) => p.identity === "g_ana")).toMatchObject({ camera: true });
    expect((await inbox(eve, "eve")).filter((m) => m.from.identity === "g_ana")).toEqual([]);
    const raw = await call<string[]>(eve, "rawData");
    expect(raw.filter((text) => ["for the room alone", "g_ana:77", "🙌", "lv.ping", "lv.cursor", "lv.ink", "lv.react", "lv.chat"].some((word) => text.includes(word)))).toEqual([]);
    expect(await received(eve)).toEqual([]);
    expect(await call<{ frames: number }>(eve, "cameraFrames", "eve", "g_ana")).toMatchObject({ frames: 0 });
    // Ana neither shows nor plays Eve, nor hears her: the host's and Dee's are the only faces, and nothing plays (Dee's mic is off).
    expect((await call<Array<{ identity: string }>>(guest, "participants", "guest")).map((p) => p.identity)).toEqual(["host", "g_ana", "g_dee"]);
    expect((await inbox(guest, "guest")).filter((m) => m.from.identity === "g_eve")).toEqual([]);
    expect(await call<number>(guest, "audioElements")).toBe(0);

    await call(dee, "disconnect", "dee");
    await call(eve, "disconnect", "eve");
    await call(guest, "media", "guest", false, false);
    await listGuests(host, ["g_ana"], [guest, "guest"]);
    await dee.context().close();
    await eve.context().close();
  });
});
