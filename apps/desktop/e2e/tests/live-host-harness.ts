import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { getRequestListener } from "../../../../services/control/node_modules/@hono/node-server/dist/index.js";
import { createApp, createDbFromUrl, ensureSchema, generateSigningKeys } from "../../../../services/control/src/index.js";
import type { LiveKitServer } from "./livekit-harness";

/**
 * What a live share's end to end needs besides the app and the SFU
 * (docs/live-share.md §12): control itself, in process on PGlite and pointed
 * at the spec's `livekit-server` — so the Mac's share, the lobby, knocks
 * (sent through LiveKit as control sends them) and tokens are the real ones —
 * a guest's side of control's routes, and a fake guest: a page that joins
 * the room with `@pistachio/live-share/room` alone (bundled here with vite,
 * as live-share-room.spec does), to hear and say what a guest would.
 */

export interface LiveControl {
  url: string;
  close(): Promise<void>;
}

/** Control on a loopback port, its live routes on `livekit`. */
export async function startLiveControl(livekit: LiveKitServer): Promise<LiveControl> {
  const db = await createDbFromUrl("pglite:memory://");
  await ensureSchema(db);
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const control = createApp(db, {
    signing: await generateSigningKeys(),
    log: () => undefined,
    env: {
      CONTROL_PUBLIC_URL: url,
      HUB_PUBLIC_URL: `${url.replace(/^http/u, "ws")}/v1/hub/ws`,
      LIVEKIT_URL: livekit.url,
      LIVEKIT_API_KEY: livekit.apiKey,
      LIVEKIT_API_SECRET: livekit.apiSecret,
    },
  });
  server.on("request", getRequestListener(control.app.fetch));
  const hub = control.hub.attach(server);
  return {
    url,
    close: async () => {
      await control.idle();
      await hub.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A guest at the door, as the guest page is (§5 guest routes). */
export interface LiveGuestRequest {
  requestId: string;
  secret: string;
  status: string;
  livekit?: { url: string; token: string; identity: string; color: string };
}

/** The link's token: the last part of `…/live/<token>`. */
export function linkToken(link: string): string {
  const token = new URL(link).pathname.split("/").pop() ?? "";
  if (token === "") throw new Error(`no token in ${link}`);
  return token;
}

/** Knock on a share (or, when it is open, come straight in). */
export async function knock(controlUrl: string, token: string, name: string): Promise<LiveGuestRequest> {
  const response = await fetch(`${controlUrl}/v1/live/join/${token}/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error(`knocking answered ${String(response.status)}: ${await response.text()}`);
  return (await response.json()) as LiveGuestRequest;
}

/** The request as control has it now (a token comes with it while admitted). */
export async function poll(controlUrl: string, token: string, request: LiveGuestRequest): Promise<{ status: string; livekit?: LiveGuestRequest["livekit"] }> {
  const response = await fetch(`${controlUrl}/v1/live/join/${token}/requests/${request.requestId}`, { headers: { authorization: `Bearer ${request.secret}` } });
  if (!response.ok) throw new Error(`the request answered ${String(response.status)}: ${await response.text()}`);
  return (await response.json()) as { status: string; livekit?: LiveGuestRequest["livekit"] };
}

const GUEST_ENTRY = "\0live-fake-guest";

/**
 * The fake guest, driven through `page.evaluate` as `window.guest`: join with
 * a token, read what came (`inbox`), send anything a guest may, show a
 * window's video and count its frames — and the tracks it was shown from,
 * and how often it was left with none (a window resized or captured afresh
 * keeps its one) — say when it joined and when the first window's picture
 * came, show someone's camera, and say how the room ended.
 */
const GUEST_SOURCE = `
import { LiveRoom } from "@pistachio/live-share/room";
import { LIVE_TOPICS } from "@pistachio/live-share";

let room = null;
let ended = null;
const inbox = [];
const watched = { frames: 0, video: null, tracks: 0, blanks: 0 };
const times = { joined: null, window: null };

window.guest = {
  async join(url, token) {
    room = await LiveRoom.connect({ url, token, role: "guest" });
    times.joined = Date.now();
    room.on("windows", (ids) => {
      if (ids.length > 0) times.window ??= Date.now();
    });
    for (const topic of Object.keys(LIVE_TOPICS)) {
      room.onMessage(topic, (body, from) => inbox.push({ topic, body, from, at: Date.now() }));
    }
    room.on("disconnected", (reason) => (ended = reason));
    return room.identity;
  },
  inbox: (topic) => inbox.filter((message) => topic === undefined || message.topic === topic),
  send: (topic, body) => room.send(topic, body),
  participants: () => room.participants().map(({ camera, ...rest }) => rest),
  watch(windowId, width, height) {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = "position:fixed;left:0;top:0;width:" + width + "px;height:" + height + "px;object-fit:fill;background:#111";
    document.body.append(video);
    const count = () => {
      watched.frames += 1;
      video.requestVideoFrameCallback(count);
    };
    video.requestVideoFrameCallback(count);
    watched.video = video;
    room.attachWindow(windowId, video);
    let shown = null;
    const look = () => {
      const track = room.windowTrack(windowId);
      if (track === shown) return;
      if (track !== null) watched.tracks += 1;
      else if (shown !== null) watched.blanks += 1;
      shown = track;
    };
    room.on("windows", look);
    look();
  },
  picture: () => ({ frames: watched.frames, width: watched.video?.videoWidth ?? 0, height: watched.video?.videoHeight ?? 0, tracks: watched.tracks, blanks: watched.blanks }),
  // Someone's camera (the host's is "host"), shown as it comes and goes in video[data-camera="<identity>"].
  watchCamera(identity) {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.dataset.camera = identity;
    video.style.cssText = "position:fixed;right:0;bottom:0;width:640px;height:360px;object-fit:cover;background:#111";
    document.body.append(video);
    let shown = null;
    const show = () => {
      const camera = room.participants().find((person) => person.identity === identity)?.camera ?? null;
      if (camera === shown) return;
      shown?.detach(video);
      shown = camera;
      camera?.attach(video);
    };
    room.on("participants", show);
    show();
  },
  times: () => times,
  ended: () => ended,
  leave: () => room.disconnect(),
};
`;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
};

export interface GuestSite {
  url: string;
  close(): Promise<void>;
}

/** The fake guest's page, bundled and served on loopback. */
export async function serveFakeGuest(): Promise<GuestSite> {
  const outDir = await mkdtemp(join(tmpdir(), "live-fake-guest-"));
  // Vite's build sets NODE_ENV to "production" for the whole process when it
  // is unset; a web stack started later in this worker would hand it to
  // `next dev`, whose CSS then fails to compile. It is put back after.
  const nodeEnv = process.env["NODE_ENV"];
  await build({
    configFile: false,
    root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "warn",
    publicDir: false,
    plugins: [
      {
        name: "live-fake-guest",
        resolveId: (id) => (id === GUEST_ENTRY ? GUEST_ENTRY : null),
        load: (id) => (id === GUEST_ENTRY ? GUEST_SOURCE : null),
      },
    ],
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      modulePreload: false,
      target: "es2022",
      rollupOptions: { input: { guest: GUEST_ENTRY }, output: { format: "es", entryFileNames: "guest.js" } },
    },
  }).finally(() => {
    if (nodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = nodeEnv;
  });
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/") {
      response.writeHead(200, { "content-type": TYPES[".html"] });
      response.end('<!doctype html><meta charset="utf-8"><title>fake guest</title><body style="margin:0;background:#222"><script type="module" src="/guest.js"></script></body>');
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
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(outDir, { recursive: true, force: true });
    },
  };
}
