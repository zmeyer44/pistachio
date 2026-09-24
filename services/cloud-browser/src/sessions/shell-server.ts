import { withActionFence } from "../runs/control-fence.js";
import { LinkedSession } from "./linked-session.js";
/**
 * The shell socket server (docs/web-browser-design.md §5, §6.1).
 *
 * `GET /v1/shell/:sessionId` is one WebSocket carrying everything the web
 * chrome needs: an RPC envelope over `ShellApi`, the snapshot channels the
 * desktop preload carries today, per-pane screencast frames, and input. Its
 * authentication is the live view's, unchanged — the origin is pinned to the
 * web app, the ticket is a one-redemption `pst_` secret spent at control, the
 * viewer's device is re-checked every minute, and NOTHING but the challenge
 * crosses the socket until the viewer has proved it holds the Space key.
 *
 * The pieces it shares with the live view live in ../live/common.ts; what is
 * here is the protocol, the RPC dispatch, and the per-pane screencasts.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { randomBytes, randomUUID } from "node:crypto";
import type { CDPSession } from "playwright-core";
import { SHELL_EVENT_CHANNELS, type ShellApi } from "@pistachio/shell-contracts/ipc";
import {
  decodeShellClientFrame,
  DOWNLOAD_KEY_HEADER,
  encodeShellServerFrame,
  SOCKET_METHOD_NAMES,
  STREAM_EVENT_CHANNELS,
  type ShellReplyErrorCode,
  type ShellServerFrame,
} from "@pistachio/shell-contracts/socket";
import {
  ASSET_CHUNK_BYTES,
  encodeAssetChunk,
  type MirrorClientMessage,
  type MirrorServerMessage,
} from "@pistachio/dom-mirror";
import type { TabMirror } from "./mirror/tab-mirror.js";
import { WebSocketServer, type WebSocket } from "ws";
import type { ControlClient } from "../control-client.js";
import {
  CLOSE_LEASE_LOST,
  CLOSE_REVOKED,
  CLOSE_UNPROVEN,
  DEFAULT_PING_INTERVAL_MS,
  DEFAULT_PROOF_TIMEOUT_MS,
  DEFAULT_RECHECK_INTERVAL_MS,
  dispatchInput,
  FIRST_FRAME_BUDGET_MS,
  FIRST_FRAME_MAX_RETRY_MS,
  FIRST_FRAME_RETRY_MS,
  markShellAttached,
  originOf,
  rawText,
  SHELL_PATHS,
  reject,
  relaySocket,
  Screencast,
  send,
  sendFrame,
  timingSafeEquals,
  unmarkShellAttached,
  upgradeToken,
  VIEWER_PLATFORMS,
  type CapturedFrame,
} from "../live/common.js";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import type { BrowserSession } from "./browser-session.js";
import { isUnsupportedShellMethod, type ShellHost } from "./shell-host.js";
import { withViewer, type ViewerIdentity } from "./viewer-context.js";
import type { ClaimOutcome, SessionClosing, SessionRegistry } from "./session-registry.js";
import type { SessionTicketRedemption } from "../control-client.js";

/** `/v1/shell/<sessionId>/downloads/<downloadId>` and nothing else. */
const DOWNLOAD_PATH = /^\/v1\/shell\/([^/]+)\/downloads\/([^/]+)$/u;
/** The same route on the in-fleet hop, for a worker that is not the holder. */
const INTERNAL_DOWNLOAD_PATH = /^\/v1\/internal\/shell\/([^/]+)\/downloads\/([^/]+)$/u;

export const SHELL_PATH_PREFIX = SHELL_PATHS.public;
/** The in-fleet hop, exactly as the live view's (§5): one public address, any worker. */
export const SHELL_INTERNAL_PATH_PREFIX = SHELL_PATHS.internal;

/**
 * The session this socket speaks for. `BrowserSession` satisfies it; the
 * interface is what the transport is written against, so a test can drive the
 * protocol without a Chromium context behind it — exactly as `LiveRun` does
 * for the live view.
 */
export interface ShellSession {
  readonly id: string;
  readonly userId: string;
  readonly spaceId: string;
  readonly control: { holder: "human" | "agent"; generation: number };
  readonly closed: boolean;
  readonly viewers: Set<WebSocket>;
  readonly host: ShellHost;
  verifySpaceProof(nonce: string, proof: string): Promise<boolean>;
  subscribe(listener: () => void): () => void;
  attachViewer(ws: WebSocket): void;
  detachViewer(ws: WebSocket): void;
  /** Whether input issued under `generation` may act; counts the drops (W7). */
  mayAct(generation: number): boolean;
  /** A viewer proved the Space key: who the console acts as from here on (§8). */
  setViewerDevice?(deviceId: string): void;
  resumeFromDesktop?(): Promise<void>;
}

/** What the socket asks of the registry when a ticket lands (§6.4). */
export interface ShellSessionRegistry {
  get(sessionId: string): ShellSession | null;
  claim(sessionId: string, redemption: SessionTicketRedemption): Promise<ClaimOutcome<ShellSession>>;
  viewerAttached(sessionId: string): void;
  viewerDetached(sessionId: string): void;
  onClosing(listener: (sessionId: string, reason: SessionClosing) => void): () => void;
}

const _browserSessionIsAShellSession = (session: BrowserSession): ShellSession => session;
const _registryIsAShellRegistry = (registry: SessionRegistry): ShellSessionRegistry => registry;

export interface ShellSocketServerOptions {
  control: ControlClient;
  registry: ShellSessionRegistry;
  /**
   * The browser app's origin, and nothing else: what a browser upgrade's
   * `Origin` may be, and the one origin the download route answers CORS for
   * (docs/web-browser-design.md §15). `www` is a DIFFERENT site — it never
   * drives a session, so a page there is refused here exactly as a stranger
   * is.
   */
  browserUrl?: string | null;
  /** Bearer for the in-fleet hop, in both directions. */
  serviceToken?: string;
  recheckIntervalMs?: number;
  pingIntervalMs?: number;
  proofTimeoutMs?: number;
  log?: Logger;
}

interface Viewer {
  ws: WebSocket;
  /** Who this socket is, for the members that must act as one viewer (§8, §11). */
  identity: ViewerIdentity;
  userId: string;
  deviceId: string;
  sessionId: string;
  session: ShellSession;
  nonce: string;
  proved: boolean;
  proofDeadline: NodeJS.Timeout;
  recheck: NodeJS.Timeout;
  ping: NodeJS.Timeout;
  awaitingPong: boolean;
  unsubscribe: Array<() => void>;
  /** One screencast per visible pane this viewer is painting (§6.3). */
  panes: Map<string, Screencast>;
  /** Tabs a first-frame retry is already running for; one loop each, not one per message. */
  painting: Set<string>;
  /** Tabs waiting for a guard session to exist before they can be streamed. */
  paneWaits: Map<string, NodeJS.Timeout>;
  /** One DOM mirror per pane this viewer is painting as a document (§16). */
  mirrors: Map<string, { mirror: TabMirror; view: MirrorViewer }>;
  /** Assets this viewer has asked for, waiting for room on the wire. */
  assetQueue: Array<{ tabId: string; id: string }>;
  assetPumping: boolean;
}

/** One tab's mirror as a viewer sees it: where its server messages are sent. */
interface MirrorViewer {
  send(message: MirrorServerMessage): void;
  hybridMedia?: boolean;
  mediaOnly?: boolean;
  canSendMedia?(): boolean;
}
interface MediaLease { tabId: string; id: number; epoch: number; source: string; mirror: TabMirror; requests: Set<AbortController>; }

/** Close codes §5 names. */
const CLOSE_ENDED = 1000;

/** See `#wss`: 32 MiB of files, base64'd, plus the envelope around them. */
export const MAX_SOCKET_FRAME_BYTES = 48 * 1024 * 1024;

/**
 * Bytes a viewer may have undrained on the EVENT side before the next event
 * is dropped. Frames already have this (`sendFrame`); events did not, and a
 * page can drive them — a clipboard mirror is up to a megabyte and the page
 * decides when to copy.
 */
export const MAX_BUFFERED_EVENT_BYTES = 8 * 1024 * 1024;

/**
 * Whether an event may be queued for a viewer that has this much undrained.
 * A dropped event is a missed copy; an unbounded queue is a dead process,
 * shared with other people's runs.
 */
export function mayQueueEvent(bufferedAmount: number): boolean {
  return bufferedAmount <= MAX_BUFFERED_EVENT_BYTES;
}

/**
 * Reading is not driving (§11, §13 revision 6).
 *
 * The host keeps one "driving viewer": the person a page's file picker, its
 * clipboard mirror and its context menu are addressed to. It used to be set
 * by EVERY call, `getSnapshot` included, and by no input at all — so two
 * attached viewers were enough to send a picker to the one who had merely
 * refreshed, and the one who actually clicked could not answer it. A member
 * that only reads leaves the wheel where it is.
 */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set<string>([
  ...SOCKET_METHOD_NAMES.filter((name) => /^(?:get|list)[A-Z]/u.test(name)),
  "vaultList",
  "vaultReveal",
  "integrationProviders",
  "integrationList",
  "integrationCalendarEvents",
  // Refused here (the desktop builds the brief); a refusal must not take the wheel.
  "reports",
]);

/**
 * `notes` requests a viewer may send without the wheel (docs/notes.md §7).
 * Reading the library, one note, a picture or an export is reading; creating,
 * editing, deleting or publishing is not.
 */
const READ_ONLY_NOTE_REQUESTS: ReadonlySet<string> = new Set([
  "list",
  "search",
  "get",
  "getBlob",
  "exportHtml",
  "sharing",
]);

/**
 * The members whose VERB is in the request rather than in the name.
 *
 * `READ_ONLY_METHODS` is a set of names because most members are one or the
 * other; `notes` carries `{type}` and is both, so it needs the arguments to
 * answer. The narrowest hook that allows that: one predicate per member, and
 * a member with none falls back to the name set.
 */
const READ_ONLY_PREDICATES: Partial<Record<string, (args: unknown[]) => boolean>> = {
  notes: (args) => {
    const request = args[0];
    const type = typeof request === "object" && request !== null ? (request as { type?: unknown }).type : undefined;
    return typeof type === "string" && READ_ONLY_NOTE_REQUESTS.has(type);
  },
};

/** Whether this call only reads, and so leaves the wheel where it is. */
function isReadOnlyCall(method: string, args: unknown[]): boolean {
  const predicate = READ_ONLY_PREDICATES[method];
  return predicate === undefined ? READ_ONLY_METHODS.has(method) : predicate(args);
}

/** All an unproven viewer may ever send is `{t:'auth', proof}`. */
export const MAX_UNPROVEN_FRAME_BYTES = 8 * 1024;

/** How long a browser may cache the download route's preflight. */
export const DOWNLOAD_PREFLIGHT_MAX_AGE_SECONDS = 600;

export class ShellSocketServer {
  readonly #control: ControlClient;
  readonly #registry: ShellSessionRegistry;
  readonly #browserOrigin: string | null;
  readonly #serviceToken: string | null;
  readonly #recheckIntervalMs: number;
  readonly #pingIntervalMs: number;
  readonly #proofTimeoutMs: number;
  readonly #log: Logger;
  /**
   * A frame bigger than this is refused by `ws` before a byte of it is
   * buffered. The default is 100 MiB, and sessions of DIFFERENT users share
   * this process: one socket must not be able to make the worker hold a
   * hundred megabytes, let alone parse it, before it has proved anything.
   * The cap is the upload ceiling (§11) plus base64 expansion and room for
   * the envelope.
   */
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SOCKET_FRAME_BYTES });
  readonly #viewers = new Set<Viewer>();
  readonly #relays = new Set<() => void>();
  /** One screencast per guard session, shared by every pane looking at it. */
  readonly #screencasts = new Map<CDPSession, Screencast>();
  readonly #mediaLeases = new WeakMap<Viewer, Map<string, MediaLease>>();
  #server: Server | null = null;
  #stopClosing: (() => void) | null = null;
  readonly #paneOwners = new Map<string, Viewer>();
  readonly #paneSizes = new Map<Viewer, Map<string, { width: number; height: number; dpr: number; visible: boolean }>>();
  readonly #linked = new Map<string, LinkedSession>();
  #link(viewer: Viewer): LinkedSession {
    let state = this.#linked.get(viewer.sessionId);
    if (!state) { state = new LinkedSession(); this.#linked.set(viewer.sessionId, state); }
    return state;
  }
  #publishLinked(viewer: Viewer): void {
    const state = this.#link(viewer).state;
    for (const peer of this.#viewers) {
      if (!peer.proved || peer.sessionId !== viewer.sessionId) continue;
      this.#send(peer, { t: "linked", state });
      this.#send(peer, { t: "cursor", cursor: null });
    }
    const driver = [...this.#viewers].find(peer => peer.identity.id === state.controller);
    if (driver && state.enabled) for (const tabId of this.#paneSizes.get(driver)?.keys() ?? []) this.#drivePane(driver, tabId);
  }
  #drivePane(viewer: Viewer, tabId: string): void {
    const link = this.#link(viewer);
    if (!link.mayDrive(viewer.identity.id, link.state.generation)) return;
    const pane = this.#paneSizes.get(viewer)?.get(tabId);
    if (!pane) return;
    this.#paneOwners.set(`${viewer.sessionId}:${tabId}`, viewer);
    const previous = viewer.session.host.paneFor(tabId);
    if (!previous || previous.width !== pane.width || previous.height !== pane.height || previous.dpr !== pane.dpr || !previous.visible) viewer.session.host.setPane(tabId, pane);
  }
  #releaseViewport(viewer: Viewer, tabId: string): void {
    this.#paneSizes.get(viewer)?.delete(tabId);
    const key = `${viewer.sessionId}:${tabId}`;
    if (this.#paneOwners.get(key) !== viewer) return;
    this.#paneOwners.delete(key);
    const next = [...this.#viewers].find(v => v !== viewer && v.sessionId === viewer.sessionId && this.#link(v).mayDrive(v.identity.id, this.#link(v).state.generation) && this.#paneSizes.get(v)?.has(tabId));
    if (next) this.#drivePane(next, tabId);
    else viewer.session.host.setPane(tabId, { width: 1, height: 1, dpr: 1, visible: false });
  }

  readonly #onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on("error", () => socket.destroy());
    this.#handleUpgrade(request, socket, head).catch(() => reject(socket, 400, "Bad Request"));
  };

  constructor(options: ShellSocketServerOptions) {
    this.#control = options.control;
    this.#registry = options.registry;
    this.#browserOrigin = originOf(options.browserUrl);
    this.#serviceToken = options.serviceToken ?? null;
    this.#recheckIntervalMs = options.recheckIntervalMs ?? DEFAULT_RECHECK_INTERVAL_MS;
    this.#pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.#proofTimeoutMs = options.proofTimeoutMs ?? DEFAULT_PROOF_TIMEOUT_MS;
    this.#log = options.log ?? silentLogger;
    this.#stopClosing = this.#registry.onClosing((sessionId, reason) => this.closeSession(sessionId, reason));
  }

  get connections(): number {
    return this.#viewers.size;
  }

  attach(server: Server): void {
    if (this.#server !== null) throw new Error("shell socket server already attached");
    this.#server = server;
    markShellAttached(server);
    server.on("upgrade", this.#onUpgrade);
  }

  /**
   * `GET /v1/shell/:sessionId/downloads/:id?access_token=…` — the one plain
   * HTTP route this server serves (docs/web-browser-design.md §11).
   *
   * A download's bytes do not travel the socket: a large file would stall
   * every pane on the session behind it, and a browser can fetch a URL
   * perfectly well by itself. What makes the URL safe is what mints it — a
   * token good for one download, for sixty seconds, for the viewer's own
   * device — plus the same Origin pin the socket upgrade uses, so a page
   * somewhere else cannot make this browser fetch somebody's file.
   *
   * The runner asks this BEFORE handing a request to the worker's Hono app
   * (`false` means "not mine, carry on"), rather than adding a second
   * `request` listener: Node runs every listener, so two of them answering
   * one request is a `headers already sent` crash waiting for its first
   * download.
   */
  handleRequest(request: IncomingMessage, response: ServerResponse): boolean {
    const url = new URL(request.url ?? "/", "http://localhost");
    const media = /^\/v1\/(internal\/)?shell\/([^/]+)\/media\/([A-Za-z0-9_-]+)$/u.exec(url.pathname);
    if (media) {
      void this.#serveMedia(request, response, decodeURIComponent(media[2]!), media[3]!, !!media[1])
        .catch(() => { if (!response.headersSent) response.writeHead(502); response.end(); });
      return true;
    }
    const asset = /^\/v1\/(internal\/)?shell\/([^/]+)\/assets\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
    if (asset) {
      void this.#serveAsset(request, response, decodeURIComponent(asset[2]!), decodeURIComponent(asset[3]!), decodeURIComponent(asset[4]!), !!asset[1])
        .catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
      return true;
    }
    const internal = INTERNAL_DOWNLOAD_PATH.exec(url.pathname);
    const match = internal ?? DOWNLOAD_PATH.exec(url.pathname);
    if (match === null) return false;
    void this.#serveDownload(
      request,
      response,
      url,
      decodeURIComponent(match[1] ?? ""),
      decodeURIComponent(match[2] ?? ""),
      internal !== null,
    ).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
    return true;
  }

  #leaseMedia(viewer: Viewer, tabId: string, mirror: TabMirror, message: Extract<MirrorServerMessage, { k: "media" }>): MirrorServerMessage {
    const leases = this.#mediaLeases.get(viewer) ?? new Map<string, MediaLease>();
    this.#mediaLeases.set(viewer, leases);
    const keep = new Set<string>();
    const items = message.items.map(item => {
      if (item.unsupported) return { ...item, source: "" };
      if (item.mse) return item;
      if (!/^https?:/u.test(item.source)) return { ...item, source: "", unsupported: true };
      let found = [...leases].find(([, lease]) => lease.tabId === tabId && lease.id === item.id && lease.epoch === message.epoch && lease.source === item.source && lease.mirror === mirror);
      if (!found) {
        const token = randomBytes(32).toString("base64url");
        const lease: MediaLease = { tabId, id: item.id, epoch: message.epoch, source: item.source, mirror, requests: new Set() };
        leases.set(token, lease); found = [token, lease];
      }
      keep.add(found[0]);
      return { ...item, source: `/v1/shell/${encodeURIComponent(viewer.sessionId)}/media/${found[0]}` };
    });
    for (const [token, lease] of leases) if (lease.tabId === tabId && !keep.has(token)) {
      leases.delete(token); for (const controller of lease.requests) controller.abort();
    }
    return { ...message, items };
  }

  async #serveMedia(request: IncomingMessage, response: ServerResponse, sessionId: string, token: string, internal: boolean): Promise<void> {
    // This is a narrow read capability for one media element, issued over a
    // proved socket. It is not the viewer key; it dies with the document or
    // socket. Native media requests cannot carry our asset authorization header.
    if (internal && (!this.#serviceToken || !timingSafeEquals(request.headers.authorization ?? "", `Bearer ${this.#serviceToken}`))) { response.writeHead(401); response.end(); return; }
    const origin = request.headers.origin;
    if (!internal && origin && origin !== "null" && origin !== "pistachio-app://shell" && origin !== this.#browserOrigin) { response.writeHead(403); response.end(); return; }
    response.setHeader("access-control-allow-origin", origin === "null" || origin === "pistachio-app://shell" ? origin : this.#browserOrigin ?? "null");
    response.setHeader("vary", "Origin");
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    if (request.method === "OPTIONS") { response.writeHead(204, { "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "Range" }); response.end(); return; }
    if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
    const range = request.headers.range ?? "bytes=0-";
    if (range.length > 100 || !/^bytes=(?:\d+-\d*|-\d+)$/u.test(range)) { response.writeHead(416); response.end(); return; }
    const viewer = [...this.#viewers].find(v => v.proved && v.sessionId === sessionId && this.#mediaLeases.get(v)?.has(token));
    const lease = viewer ? this.#mediaLeases.get(viewer)?.get(token) : undefined;
    if (!viewer || !lease) {
      if (!internal && !this.#registry.get(sessionId)) { await this.#relayDownload(response, sessionId, token, "", "", undefined, range); return; }
      response.writeHead(404); response.end(); return;
    }
    if (lease.requests.size >= 4) { response.writeHead(429); response.end(); return; }
    const device = await this.#control.getDevice(viewer.deviceId).catch(() => null);
    if (!device || device.revokedAt !== null || device.userId !== viewer.userId) { response.writeHead(404); response.end(); return; }
    const controller = new AbortController();
    lease.requests.add(controller);
    const close = (): void => { controller.abort(); lease.requests.delete(controller); };
    response.once("close", close);
    try {
      const upstream = await lease.mirror.openMedia(lease.id, lease.epoch, lease.source, range, controller.signal);
      if (!this.#viewers.has(viewer) || this.#mediaLeases.get(viewer)?.get(token) !== lease) { upstream.body.destroy(); response.writeHead(404); response.end(); return; }
      const type = String(upstream.headers["content-type"] ?? "application/octet-stream");
      if (![200, 206, 416].includes(upstream.statusCode) || (upstream.statusCode !== 416 && !/^(?:video\/|audio\/|application\/octet-stream)/u.test(type))) {
        upstream.body.destroy(); response.writeHead(415); response.end(); return;
      }
      const headers: Record<string, string> = { "content-type": type, "x-content-type-options": "nosniff" };
      for (const name of ["content-length", "content-range", "accept-ranges"]) {
        const value = upstream.headers[name]; if (typeof value === "string") headers[name] = value;
      }
      response.writeHead(upstream.statusCode, headers);
      upstream.body.on("error", () => response.destroy());
      upstream.body.pipe(response);
    } catch { if (!response.headersSent) response.writeHead(502); response.end(); }
  }

  /** A proved socket's private capability authorizes a separate HTTP transfer.
   * It expires with that socket; the site being mirrored never sees it. */
  async #serveAsset(request: IncomingMessage, response: ServerResponse, sessionId: string, tabId: string, id: string, internal: boolean): Promise<void> {
    const origin = request.headers.origin;
    if (!internal) {
      if (typeof origin === "string" && origin !== "null" && origin !== "pistachio-app://shell" && origin !== this.#browserOrigin) { response.writeHead(403); response.end(); return; }
      if (this.#browserOrigin) {
        response.setHeader("access-control-allow-origin", origin === "null" || origin === "pistachio-app://shell" ? origin : this.#browserOrigin);
        response.setHeader("vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        if (!origin || !this.#browserOrigin) { response.writeHead(403); response.end(); return; }
        response.writeHead(204, { "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": DOWNLOAD_KEY_HEADER });
        response.end(); return;
      }
    } else {
      const bearer = request.headers.authorization;
      if (!this.#serviceToken || typeof bearer !== "string" || !timingSafeEquals(bearer, `Bearer ${this.#serviceToken}`)) {
        response.writeHead(401); response.end(); return;
      }
    }
    if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
    const header = request.headers[DOWNLOAD_KEY_HEADER];
    const key = typeof header === "string" ? header : "";
    if (!key) { response.writeHead(404); response.end(); return; }
    const session = this.#registry.get(sessionId);
    if (!session || session.closed) {
      if (internal) { response.writeHead(404); response.end(); return; }
      await this.#relayDownload(response, sessionId, id, "", key, tabId); return;
    }
    const viewer = [...this.#viewers].find(v => v.proved && v.sessionId === sessionId && timingSafeEquals(v.identity.downloadKey, key));
    const mirror = viewer?.mirrors.get(tabId)?.mirror;
    if (!viewer || !mirror || !mirror.allowsAsset(id)) { response.writeHead(404); response.end(); return; }
    const device = await this.#control.getDevice(viewer.deviceId).catch(() => null);
    if (!device || device.revokedAt !== null || device.userId !== viewer.userId) { response.writeHead(404); response.end(); return; }
    const result = await mirror.asset(id);
    if (!result || !this.#viewers.has(viewer) || viewer.mirrors.get(tabId)?.mirror !== mirror || !mirror.allowsAsset(id) || session.closed) {
      response.writeHead(404); response.end(); return;
    }
    if (result === "missing" || result === "pending") {
      response.writeHead(result === "pending" ? 202 : 410, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(mirror.assetDiagnostic(id))); return;
    }
    // No bytes yet because the source browser has not needed this resource.
    // The mirror sends assetReady if it loads later; this is not a failure.
    if (result === "deferred") { response.writeHead(204, { "cache-control": "no-store" }); response.end(); return; }
    response.writeHead(200, { "content-type": result.type || "application/octet-stream", "content-length": String(result.bytes.byteLength),
      "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(result.bytes);
  }

  async #serveDownload(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    sessionId: string,
    downloadId: string,
    internal: boolean,
  ): Promise<void> {
    // The pane fetches this route rather than opening it, because the viewer
    // key is a header and a browser cannot put a header on `window.open`. A
    // header that is not on the CORS-safelist means a preflight, and a
    // preflight nobody answers is a fetch that never happens.
    //
    // The allowed origin is the browser app's and nothing else — never `*`,
    // which would let any page on the internet read this person's file with
    // a URL it had somehow got hold of, and not `www` either, which is a
    // different site that never fetches a download (§15).
    if (!internal) {
      const origin = request.headers.origin;
      const browserOrigin = this.#browserOrigin;
      if (request.method === "OPTIONS") {
        if (browserOrigin === null || typeof origin !== "string" || origin !== "null" && origin !== "pistachio-app://shell" && origin !== browserOrigin) {
          response.writeHead(403, { vary: "Origin" });
          response.end();
          return;
        }
        response.writeHead(204, {
          "access-control-allow-origin": origin === "null" || origin === "pistachio-app://shell" ? origin : browserOrigin,
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": DOWNLOAD_KEY_HEADER,
          "access-control-max-age": String(DOWNLOAD_PREFLIGHT_MAX_AGE_SECONDS),
          vary: "Origin",
        });
        response.end();
        return;
      }
    }
    if (internal) {
      // The in-fleet hop, authenticated the way the socket's is.
      const bearer = request.headers.authorization;
      const token = typeof bearer === "string" && bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : "";
      if (this.#serviceToken === null || !timingSafeEquals(token, this.#serviceToken)) {
        response.writeHead(401);
        response.end();
        return;
      }
    } else {
      const origin = request.headers.origin;
      if (typeof origin === "string" && origin !== "" && origin !== "null" && origin !== "pistachio-app://shell" && origin !== this.#browserOrigin) {
        response.writeHead(403, { vary: "Origin" });
        response.end();
        return;
      }
      // Set before anything else can answer, so a refusal reaches the pane as
      // a status it can read rather than as an opaque CORS failure.
      if (this.#browserOrigin !== null) {
        response.setHeader("access-control-allow-origin", origin === "null" || origin === "pistachio-app://shell" ? origin : this.#browserOrigin);
        response.setHeader("vary", "Origin");
      }
    }
    const token = url.searchParams.get("access_token") ?? "";
    // The token names the download; the viewer key proves WHO is fetching it.
    // A URL on its own — in a log, in a chat message, in somebody's history —
    // is not a credential (§11).
    const viewerKeyHeader = request.headers[DOWNLOAD_KEY_HEADER];
    const viewerKey = typeof viewerKeyHeader === "string" ? viewerKeyHeader : "";
    const session = this.#registry.get(sessionId);
    if (token === "" || viewerKey === "") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (session === null || session.closed) {
      // Not this worker's session. The fleet has one public address and the
      // socket already relays; the bytes have to travel the same way, or the
      // download is a coin flip on which worker the request landed.
      if (internal) {
        response.writeHead(404);
        response.end();
        return;
      }
      await this.#relayDownload(response, sessionId, downloadId, token, viewerKey);
      return;
    }
    const stream = await session.host.openDownload(downloadId, token, viewerKey);
    if (stream === null) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(stream.bytes),
      "content-disposition": `attachment; filename="${stream.fileName.replace(/["\\]/gu, "_")}"`,
      // The bytes are this person's; nothing may keep a copy on the way.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    stream.body.pipe(response);
  }

  /**
   * Hand one download request to the worker that holds the session, over the
   * private network, exactly as an upgrade is handed over.
   */
  async #relayDownload(
    response: ServerResponse,
    sessionId: string,
    downloadId: string,
    token: string,
    viewerKey: string,
    assetTabId?: string,
    mediaRange?: string,
  ): Promise<void> {
    const serviceToken = this.#serviceToken;
    const placement = await this.#control.readSession(sessionId).catch(() => null);
    const workerUrl = placement?.workerUrl ?? null;
    if (serviceToken === null || workerUrl === null) {
      response.writeHead(404);
      response.end();
      return;
    }
    let target: URL;
    try {
      target = new URL(
        `${workerUrl.trim().replace(/\/+$/u, "")}/v1/internal/shell/${encodeURIComponent(sessionId)}/${mediaRange !== undefined ? `media/${encodeURIComponent(downloadId)}` : assetTabId === undefined ? `downloads/${encodeURIComponent(downloadId)}?access_token=${encodeURIComponent(token)}` : `assets/${encodeURIComponent(assetTabId)}/${encodeURIComponent(downloadId)}`}`,
      );
    } catch {
      response.writeHead(404);
      response.end();
      return;
    }
    await new Promise<void>((resolve) => {
      const send = target.protocol === "https:" ? httpsRequest : httpRequest;
      const upstream = send(
        target,
        {
          method: "GET",
          headers: { authorization: `Bearer ${serviceToken}`, [DOWNLOAD_KEY_HEADER]: viewerKey, ...(mediaRange ? { range: mediaRange } : {}) },
        },
        (upstreamResponse) => {
          const headers: Record<string, string> = {};
          for (const name of ["content-type", "content-length", "content-disposition", "cache-control", "x-content-type-options", "content-range", "accept-ranges"]) {
            const value = upstreamResponse.headers[name];
            if (typeof value === "string") headers[name] = value;
          }
          response.writeHead(upstreamResponse.statusCode ?? 502, headers);
          upstreamResponse.pipe(response);
          upstreamResponse.on("end", () => resolve());
          upstreamResponse.on("error", () => {
            response.end();
            resolve();
          });
        },
      );
      upstream.on("error", (error: unknown) => {
        this.#log.warn("relaying a download failed", { sessionId, error: errorMessage(error) });
        if (!response.headersSent) response.writeHead(502);
        response.end();
        resolve();
      });
      response.once("close", () => { upstream.destroy(); resolve(); });
      upstream.setTimeout(15_000, () => upstream.destroy(new Error("Relay timed out")));
      upstream.end();
    });
  }

  /** The lease went, or the person ended the session: every viewer of it goes. */
  closeSession(sessionId: string, reason: SessionClosing): void {
    const code = reason === "lease_lost" ? CLOSE_LEASE_LOST : reason === "revoked" ? CLOSE_REVOKED : CLOSE_ENDED;
    for (const viewer of [...this.#viewers]) {
      if (viewer.sessionId !== sessionId) continue;
      if (reason === "lease_lost") {
        this.#send(viewer, { t: "error", code: "lease_lost", message: "this worker no longer holds the session" });
      } else if (reason === "ended") {
        this.#send(viewer, { t: "error", code: "ended", message: "the session has ended" });
      }
      this.#close(viewer, code, reason);
    }
  }

  /** `device.revoked`: close every socket of the user at once. */
  closeUser(userId: string): void {
    for (const viewer of [...this.#viewers]) {
      if (viewer.userId === userId) this.#close(viewer, CLOSE_REVOKED, "revoked");
    }
  }

  async close(): Promise<void> {
    this.#stopClosing?.();
    this.#stopClosing = null;
    if (this.#server !== null) {
      this.#server.off("upgrade", this.#onUpgrade);
      unmarkShellAttached(this.#server);
      this.#server = null;
    }
    for (const viewer of [...this.#viewers]) this.#close(viewer, 1001, "shutdown");
    for (const done of [...this.#relays]) done();
    this.#relays.clear();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
  }

  /* ------------------------------- upgrade ------------------------------- */

  async #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const internal = url.pathname.startsWith(SHELL_INTERNAL_PATH_PREFIX);
    if (!internal && !url.pathname.startsWith(SHELL_PATH_PREFIX)) return;
    const prefix = internal ? SHELL_INTERNAL_PATH_PREFIX : SHELL_PATH_PREFIX;
    const sessionId = decodeURIComponent(url.pathname.slice(prefix.length));
    const token = upgradeToken(request, url);
    if (token === null || sessionId === "") {
      reject(socket, 401, "Unauthorized");
      return;
    }
    if (internal) {
      this.#acceptInternal(request, socket, head, url, sessionId, token);
      return;
    }
    // A page on another origin must not be able to drive someone's browser,
    // ticket or no ticket. Checked first: it costs nothing and it is the one
    // check that does not depend on the ticket being real.
    const origin = request.headers.origin;
    // Packaged Electron uses file://; Vite serves development chrome on loopback.
    // These origins still require a macOS ticket and the Space-key proof below.
    const desktopOrigin = origin === "pistachio-app://shell" || origin === "null" || origin === "file://" || (typeof origin === "string" && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/u.test(origin));
    if (typeof origin === "string" && origin !== "" && !desktopOrigin && origin !== this.#browserOrigin) {
      this.#log.warn("shell origin refused", { origin });
      reject(socket, 403, "Forbidden");
      return;
    }
    let redemption;
    try {
      redemption = await this.#control.redeemSessionTicket(token, sessionId);
    } catch (error) {
      this.#log.warn("session ticket redemption failed", { error: errorMessage(error) });
      reject(socket, 503, "Service Unavailable");
      return;
    }
    if (redemption === null) {
      reject(socket, 401, "Unauthorized");
      return;
    }
    if (!VIEWER_PLATFORMS.has(redemption.platform) || (desktopOrigin && origin !== this.#browserOrigin && redemption.platform !== "macos")) {
      reject(socket, 403, "Forbidden");
      return;
    }
    const outcome = await this.#registry.claim(sessionId, redemption);
    if (outcome.kind === "session") {
      if (socket.destroyed) return;
      const { userId, deviceId } = redemption;
      this.#wss.handleUpgrade(request, socket, head, (ws) => {
        this.#accept(ws, { userId, deviceId, sessionId, session: outcome.session });
      });
      return;
    }
    if (outcome.kind === "refused") {
      reject(socket, outcome.reason === "ended" || outcome.reason === "not_found" ? 404 : 409, "Conflict");
      return;
    }
    if (this.#serviceToken === null) {
      reject(socket, 404, "Not Found");
      return;
    }
    const done = await relaySocket(
      this.#wss,
      request,
      socket,
      head,
      {
        target: outcome.workerUrl,
        path: `${SHELL_INTERNAL_PATH_PREFIX}${encodeURIComponent(sessionId)}`,
        query: { userId: redemption.userId, deviceId: redemption.deviceId, platform: redemption.platform },
        serviceToken: this.#serviceToken,
        pingIntervalMs: this.#pingIntervalMs,
      },
      this.#log,
    );
    if (done === null) return;
    const forget = (): void => {
      this.#relays.delete(forget);
      done();
    };
    this.#relays.add(forget);
  }

  /** The other end of the in-fleet hop: this worker holds the session, or nobody does. */
  #acceptInternal(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
    sessionId: string,
    token: string,
  ): void {
    if (this.#serviceToken === null || !timingSafeEquals(token, this.#serviceToken)) {
      reject(socket, 401, "Unauthorized");
      return;
    }
    const userId = url.searchParams.get("userId") ?? "";
    const deviceId = url.searchParams.get("deviceId") ?? "";
    const platform = url.searchParams.get("platform") ?? "";
    if (userId === "" || deviceId === "" || !VIEWER_PLATFORMS.has(platform)) {
      reject(socket, 400, "Bad Request");
      return;
    }
    const session = this.#registry.get(sessionId);
    // No onward proxy from here: a second hop would be a worker pointing at a
    // worker pointing back.
    if (session === null || session.closed || session.userId !== userId) {
      reject(socket, 404, "Not Found");
      return;
    }
    if (socket.destroyed) return;
    this.#wss.handleUpgrade(request, socket, head, (ws) => {
      this.#accept(ws, { userId, deviceId, sessionId, session });
    });
  }

  /* -------------------------------- viewers -------------------------------- */

  #accept(ws: WebSocket, info: { userId: string; deviceId: string; sessionId: string; session: ShellSession }): void {
    const viewer: Viewer = {
      ws,
      ...info,
      identity: {
        id: randomUUID(),
        deviceId: info.deviceId,
        // Handed to this socket alone, in `ready`, after it proves the Space
        // key — the second half of every download URL it mints (§11).
        downloadKey: randomBytes(32).toString("base64url"),
      },
      nonce: randomBytes(32).toString("base64url"),
      proved: false,
      proofDeadline: setTimeout(() => {
        if (!viewer.proved) {
          this.#send(viewer, {
            t: "error",
            code: "space_key_required",
            message: "this viewer did not prove it holds the Space key",
          });
          this.#close(viewer, CLOSE_UNPROVEN, "space_key_required");
        }
      }, this.#proofTimeoutMs),
      recheck: setInterval(() => void this.#recheck(viewer), this.#recheckIntervalMs),
      ping: setInterval(() => this.#keepalive(viewer), this.#pingIntervalMs),
      awaitingPong: false,
      unsubscribe: [],
      panes: new Map(),
      painting: new Set(),
      paneWaits: new Map(),
      mirrors: new Map(),
      assetQueue: [],
      assetPumping: false,
    };
    viewer.proofDeadline.unref();
    viewer.recheck.unref();
    viewer.ping.unref();
    this.#viewers.add(viewer);
    info.session.attachViewer(ws);
    this.#registry.viewerAttached(info.sessionId);
    ws.on("pong", () => {
      viewer.awaitingPong = false;
    });
    ws.on("message", (data) => this.#onMessage(viewer, data));
    ws.on("close", () => this.#cleanup(viewer));
    ws.on("error", () => this.#cleanup(viewer));
    // The challenge, and nothing else (§5).
    this.#send(viewer, { t: "challenge", spaceId: info.session.spaceId, nonce: viewer.nonce });
  }

  /**
   * The viewer's answer to its challenge. A wrong one is not a retry: the
   * nonce is spent, and a socket that may keep guessing is a socket that will.
   */
  async #answerChallenge(viewer: Viewer, proof: string): Promise<void> {
    if (viewer.proved || !this.#viewers.has(viewer)) return;
    let ok = false;
    try {
      ok = await viewer.session.verifySpaceProof(viewer.nonce, proof);
    } catch (error) {
      this.#log.warn("shell proof check failed", { error: errorMessage(error) });
    }
    if (!this.#viewers.has(viewer)) return;
    if (!ok) {
      this.#send(viewer, {
        t: "error",
        code: "space_key_required",
        message: "that did not prove possession of this Space's key",
      });
      this.#close(viewer, CLOSE_UNPROVEN, "space_key_required");
      return;
    }
    clearTimeout(viewer.proofDeadline);
    // A live web viewer keeps its pages. With no proved viewers, adopt the
    // latest desktop checkpoint before exposing shell state to this arrival.
    if (![...this.#viewers].some(peer => peer.sessionId === viewer.sessionId && peer.proved)) {
      await viewer.session.resumeFromDesktop?.();
      if (!this.#viewers.has(viewer)) return;
    }
    viewer.proved = true;
    this.#link(viewer).join(viewer.identity.id);
    clearTimeout(viewer.proofDeadline);
    // The console acts as this device from here on: control audits a run
    // command by the person's device, never by the worker (§8).
    viewer.session.setViewerDevice?.(viewer.deviceId);
    this.#subscribe(viewer);
    this.#send(viewer, {
      t: "ready",
      sessionId: viewer.sessionId,
      control: viewer.session.control,
      downloadKey: viewer.identity.downloadKey,
      viewerId: viewer.identity.id,
      linked: this.#link(viewer).state,
    });
    this.#publishLinked(viewer);
  }

  /**
   * Every `on*` member of both surfaces, mapped generically from
   * `SHELL_EVENT_CHANNELS` and `STREAM_EVENT_CHANNELS`: the transport is
   * built from the contract rather than a hand-kept list, so a new
   * subscription cannot be forgotten here.
   */
  #subscribe(viewer: Viewer): void {
    const host = viewer.session.host as unknown as Record<string, (listener: (payload: unknown) => void) => () => void>;
    for (const entry of [...SHELL_EVENT_CHANNELS, ...STREAM_EVENT_CHANNELS]) {
      const subscribe = host[entry.member];
      if (typeof subscribe !== "function") continue;
      try {
        // Subscribed AS this viewer: the host records which viewer each
        // listener belongs to, so an event addressed to one of them (a file
        // picker) reaches that one rather than every attached browser tab.
        const off = withViewer(viewer.identity, () =>
          subscribe.call(viewer.session.host, (payload: unknown) => {
            this.#sendEvent(viewer, { t: "event", channel: entry.channel, payload });
          }),
        );
        if (typeof off === "function") viewer.unsubscribe.push(off);
      } catch (error) {
        this.#log.warn("a shell channel could not be subscribed", { channel: entry.channel, error: errorMessage(error) });
      }
    }
    viewer.unsubscribe.push(
      viewer.session.subscribe(() => {
        const control = viewer.session.control;
        this.#send(viewer, { t: "control", holder: control.holder, generation: control.generation });
      }),
    );
  }

  #onMessage(viewer: Viewer, data: unknown): void {
    // Before the proof a viewer may send exactly one kind of thing, and it is
    // small. Bounding the bytes here means an unproven socket cannot make the
    // worker stringify and JSON-parse tens of megabytes — which it could,
    // because the parse used to happen before the `proved` check.
    const raw = rawText(data);
    if (!viewer.proved && raw.length > MAX_UNPROVEN_FRAME_BYTES) {
      this.#close(viewer, CLOSE_UNPROVEN, "space_key_required");
      return;
    }
    const frame = decodeShellClientFrame(raw);
    if (frame === null) return;
    if (frame.t === "auth") {
      void this.#answerChallenge(viewer, frame.proof);
      return;
    }
    // Nothing but the proof is listened to until the proof is in.
    if (!viewer.proved) return;
    if (frame.t === "link") {
      if (this.#link(viewer).change(viewer.identity.id, frame.action, frame.generation)) this.#publishLinked(viewer);
      return;
    }
    if (frame.t === "call") {
      if (!isReadOnlyCall(frame.method, frame.args) && !this.#link(viewer).mayDrive(viewer.identity.id, frame.viewGeneration)) {
        this.#send(viewer, { t: "reply", id: frame.id, ok: false, error: { code: "failed", message: "You are following another device. Take control to make changes." } });
        return;
      }
      void this.#call(viewer, frame.id, frame.method, frame.args);
      return;
    }
    if (frame.t === "pane") {
      this.#pane(viewer, frame);
      return;
    }
    if (frame.t === "mirror") {
      this.#mirror(viewer, frame.tabId, frame.generation, frame.msg, frame.viewGeneration);
      return;
    }
    if (this.#link(viewer).mayDrive(viewer.identity.id, frame.viewGeneration)) this.#input(viewer, frame.tabId, frame.generation, frame.event);
  }

  /**
   * One RPC call.
   *
   * What is checked HERE is the envelope: the method is one of the names in
   * the contract (the frame schema's `z.enum`), the argument list is an array
   * no longer than `MAX_CALL_ARGS`, and the member exists on this host. The
   * ARGUMENTS are each member's own business — `sidebarCommand` runs
   * `isSidebarCommand`, `updateSettings` runs `sanitizeSettings`,
   * `completeOnboarding` runs `sanitizeOnboardingCompletion`, and so on —
   * exactly as they do when the same call arrives over Electron IPC, which is
   * the point: one implementation, suspicious of both transports.
   *
   * An unknown or unimplemented member is answered `unsupported` rather than
   * by closing the socket (§5): a shell built against a newer host must
   * degrade to a disabled button, not to a dead connection.
   */
  async #call(viewer: Viewer, id: string, method: string, args: unknown[]): Promise<void> {
    const host = viewer.session.host as unknown as Record<string, unknown>;
    const member = host[method];
    if (typeof member !== "function") {
      this.#reply(viewer, id, "unsupported", `${method} is not a member of this host`);
      return;
    }
    if (viewer.session.closed) {
      this.#reply(viewer, id, "ended", "the session has ended");
      return;
    }
    // Whoever is ACTING is who is driving: a page's file picker raised while
    // this call runs belongs to them (§11). A call that only reads is not
    // acting, and must not take the wheel off the viewer that is.
    if (!isReadOnlyCall(method, args)) viewer.session.host.noteViewerActivity(viewer.identity.id);
    try {
      const generation = this.#link(viewer).state.generation;
      const check = (): void => {
        if (!isReadOnlyCall(method, args) && (!this.#viewers.has(viewer) || !this.#link(viewer).mayDrive(viewer.identity.id, generation))) {
          throw new Error("Control moved to another device before this action finished.");
        }
      };
      const result: unknown = await withActionFence(check, async () => withViewer(viewer.identity, () =>
        (member as (...values: unknown[]) => unknown).apply(viewer.session.host, args),
      ));
      this.#send(viewer, { t: "reply", id, ok: true, result: result === undefined ? null : result });
    } catch (error) {
      const code: ShellReplyErrorCode = isUnsupportedShellMethod(error) ? "unsupported" : "failed";
      this.#reply(viewer, id, code, errorMessage(error));
    }
  }

  #reply(viewer: Viewer, id: string, code: ShellReplyErrorCode, message: string): void {
    this.#send(viewer, { t: "reply", id, ok: false, error: { code, message } });
  }

  /* --------------------------------- panes --------------------------------- */

  /**
   * A pane reported its size. One screencast per VISIBLE pane, at that pane's
   * size and device pixel ratio; a pane that says it is hidden, or a tab that
   * leaves the visible set, stops its stream (§6.3, W10).
   */
  #pane(
    viewer: Viewer,
    pane: { tabId: string; width: number; height: number; dpr: number; visible: boolean; renderer?: "pixels" | "dom"; hybridMedia?: boolean },
  ): void {
    const host = viewer.session.host;
    // Stopping comes FIRST, and needs no tab. `releasePane` arrives after the
    // host has already forgotten a closed or suspended tab, so bailing on
    // "unknown tab" before handling `visible: false` leaked the screencast and
    // its entry in `viewer.panes` every single time a tab was closed.
    if (!pane.visible || !host.hasTab(pane.tabId)) {
      this.#stopPane(viewer, pane.tabId);
      this.#stopMirrorPane(viewer, pane.tabId);
      this.#releaseViewport(viewer, pane.tabId);
      if (!host.hasTab(pane.tabId)) return;
      return;
    }
    const sizes = this.#paneSizes.get(viewer) ?? new Map();
    sizes.set(pane.tabId, { width: pane.width, height: pane.height, dpr: pane.dpr, visible: true });
    this.#paneSizes.set(viewer, sizes);
    const owner = this.#paneOwners.get(`${viewer.sessionId}:${pane.tabId}`);
    if (!owner || owner === viewer) this.#drivePane(viewer, pane.tabId);
    // A pane painted as a document rather than as pixels (§16): the screencast
    // it might have had is stopped, and a live DOM mirror takes its place. The
    // viewport was still sized above, so the cloud page reflows to where the
    // person is actually looking.
    if (pane.renderer === "dom") {
      this.#stopPane(viewer, pane.tabId);
      const mirrorSession = host.guardSessionFor(pane.tabId);
      if (mirrorSession === null) {
        this.#waitForPage(viewer, pane);
        return;
      }
      this.#clearPaneWait(viewer, pane.tabId);
      this.#attachMirror(viewer, pane.tabId, pane.hybridMedia === true);
      return;
    }
    if (pane.hybridMedia) this.#attachMirror(viewer, pane.tabId, true, true);
    else this.#stopMirrorPane(viewer, pane.tabId);
    const session = host.guardSessionFor(pane.tabId);
    if (session === null) {
      // The tab has no page to screencast YET. A document tab the host renders
      // itself — a welcome page (§14), a reader page (§11) — is published to
      // the shell as soon as it exists, and a suspended tab is selected before
      // it is woken, so a pane can honestly report itself visible a moment
      // before there is anything behind it. Dropping the message here left the
      // pane on "Opening…" until the person resized something, because the
      // client only sends `pane` when its own geometry changes.
      this.#waitForPage(viewer, pane);
      return;
    }
    this.#clearPaneWait(viewer, pane.tabId);
    const current = viewer.panes.get(pane.tabId);
    if (current !== undefined && current.session !== session) this.#stopPane(viewer, pane.tabId);
    let screencast = this.#screencasts.get(session);
    if (screencast === undefined) {
      screencast = new Screencast(session, this.#log);
      this.#screencasts.set(session, screencast);
    }
    // A page painted at the pane's device pixels is a page that is sharp on a
    // retina display and cheap on a laptop's second monitor.
    const dimensions = host.paneFor(pane.tabId) ?? pane;
    const scale = Math.min(Math.max(dimensions.dpr, 1), 3);
    screencast.resize({
      maxWidth: Math.max(1, Math.round(dimensions.width * scale)),
      maxHeight: Math.max(1, Math.round(dimensions.height * scale)),
      // One pane on screen gets every frame; several share the budget.
      everyNthFrame: host.visibleTabIds().length > 1 ? 2 : 1,
    });
    if (viewer.panes.get(pane.tabId) === screencast) {
      // The same pane, said again — the shell re-reports on a re-render and
      // after a reconnect. A pane that is still blank is asking for a picture
      // it never got, so the repeat is worth a retry rather than an early
      // return.
      if (!screencast.hasPainted(viewer.ws)) void this.#paintPane(viewer, pane.tabId, screencast);
      return;
    }
    viewer.panes.set(pane.tabId, screencast);
    screencast.pending += 1;
    void this.#attachPane(viewer, pane.tabId, screencast);
  }

  /**
   * A pane whose tab has no page yet. Ask again on the same backoff the first
   * frame uses, until the tab is gone, the pane is hidden, or the budget is
   * spent — the page usually appears within a tick or two of the host opening
   * or waking it.
   */
  #waitForPage(
    viewer: Viewer,
    pane: { tabId: string; width: number; height: number; dpr: number; visible: boolean; renderer?: "pixels" | "dom"; hybridMedia?: boolean },
  ): void {
    if (viewer.paneWaits.has(pane.tabId)) return;
    const until = Date.now() + FIRST_FRAME_BUDGET_MS;
    let wait = FIRST_FRAME_RETRY_MS;
    const again = (): void => {
      viewer.paneWaits.delete(pane.tabId);
      if (!this.#viewers.has(viewer) || viewer.session.closed) return;
      if (!viewer.session.host.hasTab(pane.tabId)) return;
      if (viewer.session.host.guardSessionFor(pane.tabId) === null) {
        if (Date.now() >= until) return;
        wait = Math.min(wait * 2, FIRST_FRAME_MAX_RETRY_MS);
        schedule();
        return;
      }
      this.#pane(viewer, pane);
    };
    const schedule = (): void => {
      const timer = setTimeout(again, wait);
      timer.unref();
      viewer.paneWaits.set(pane.tabId, timer);
    };
    schedule();
  }

  #clearPaneWait(viewer: Viewer, tabId: string): void {
    const timer = viewer.paneWaits.get(tabId);
    if (timer === undefined) return;
    clearTimeout(timer);
    viewer.paneWaits.delete(tabId);
  }

  /**
   * Join the live stream, then send the page as it is now.
   *
   * THE STREAM COMES FIRST, which it did not use to. The snapshot was awaited
   * before the viewer was registered, and `Page.captureScreenshot` on a page
   * that is not the front one in its context does not fail — it never settles
   * (`SNAPSHOT_TIMEOUT_MS`). One backgrounded tab therefore parked the whole
   * attach: no live emitter, no `Page.startScreencast`, no retry, and a pane
   * that said "Opening…" for the life of the session. Registering first means
   * the page's own frames paint the pane whatever the screenshot does.
   */
  async #attachPane(viewer: Viewer, tabId: string, screencast: Screencast): Promise<void> {
    screencast.add(viewer.ws, (frame) => {
      sendFrame(viewer.ws, encodeShellServerFrame(shellFrame(tabId, frame)));
    });
    let snapshot: CapturedFrame | null = null;
    try {
      snapshot = await screencast.snapshot();
    } finally {
      screencast.pending -= 1;
    }
    if (viewer.panes.get(tabId) !== screencast || !this.#viewers.has(viewer)) {
      this.#evictIfIdle(screencast);
      return;
    }
    // A live frame may have arrived while the still was being taken; the
    // still is older, so it is only worth sending if nothing else painted.
    if (snapshot !== null && !screencast.hasPainted(viewer.ws)) {
      screencast.markPainted(viewer.ws);
      this.#send(viewer, shellFrame(tabId, snapshot));
    }
    // A page that never paints again — a welcome document, a reader page —
    // has given this viewer everything it is ever going to give it unless
    // that snapshot landed. Keep asking until one does.
    await this.#paintPane(viewer, tabId, screencast);
  }

  /** Keep trying for a first frame, one loop per pane however often it is asked. */
  async #paintPane(viewer: Viewer, tabId: string, screencast: Screencast): Promise<void> {
    if (viewer.painting.has(tabId) || screencast.hasPainted(viewer.ws)) return;
    viewer.painting.add(tabId);
    try {
      await screencast.ensurePainted(viewer.ws, (frame) => {
        if (viewer.panes.get(tabId) !== screencast || !this.#viewers.has(viewer)) return;
        this.#send(viewer, shellFrame(tabId, frame));
      });
    } finally {
      viewer.painting.delete(tabId);
    }
  }

  #stopPane(viewer: Viewer, tabId: string): void {
    this.#clearPaneWait(viewer, tabId);
    const screencast = viewer.panes.get(tabId);
    if (screencast === undefined) return;
    viewer.panes.delete(tabId);
    screencast.remove(viewer.ws);
    this.#evictIfIdle(screencast);
  }

  #evictIfIdle(screencast: Screencast): void {
    if (screencast.idle && this.#screencasts.get(screencast.session) === screencast) {
      this.#screencasts.delete(screencast.session);
    }
  }

  /* --------------------------------- mirror -------------------------------- */

  /**
   * Attach this viewer's `dom` pane to the tab's live DOM mirror (§16). The
   * mirror is created on demand and shared by every viewer of the tab; a
   * `MirrorViewer` wraps this socket so the mirror's messages reach it as
   * `{t:'mirror'}` frames and its assets are pulled on `need`.
   */
  #attachMirror(viewer: Viewer, tabId: string, hybridMedia: boolean, mediaOnly = false): void {
    const existing = viewer.mirrors.get(tabId);
    const mirror = viewer.session.host.mirrorFor(tabId);
    if (mirror === null) return;
    if (existing !== undefined && existing.mirror === mirror && existing.view.hybridMedia === hybridMedia && existing.view.mediaOnly === mediaOnly) return;
    if (existing !== undefined) existing.mirror.detach(existing.view);
    const view: MirrorViewer = {
      hybridMedia, mediaOnly,
      canSendMedia: () => viewer.ws.bufferedAmount < 256 * 1024,
      send: (message) => this.#sendEvent(viewer, { t: "mirror", tabId,
        msg: message.k === "media" ? this.#leaseMedia(viewer, tabId, mirror, message) : message }),
    };
    viewer.mirrors.set(tabId, { mirror, view });
    void mirror.attach(view);
  }

  #stopMirrorPane(viewer: Viewer, tabId: string): void {
    const existing = viewer.mirrors.get(tabId);
    if (existing === undefined) return;
    viewer.mirrors.delete(tabId);
    existing.mirror.detach(existing.view);
    const leases = this.#mediaLeases.get(viewer);
    for (const [token, lease] of leases ?? []) if (lease.tabId === tabId) {
      leases!.delete(token); for (const controller of lease.requests) controller.abort();
    }
    viewer.assetQueue = viewer.assetQueue.filter((entry) => entry.tabId !== tabId);
  }

  /**
   * One mirror message from a viewer (§16), under the same control fence as
   * raw input (W7): a stale generation, or the agent holding the wheel, and
   * it goes nowhere. `need` is answered here, because the socket owns the
   * byte transfer; everything else is the mirror's.
   */
  #mirror(viewer: Viewer, tabId: string, generation: number, message: MirrorClientMessage, viewGeneration?: number): void {
    if (viewer.session.closed) return;
    const entry = viewer.mirrors.get(tabId);
    if (!entry) return;
    if (entry.view.mediaOnly && !["ack", "resync"].includes(message.k)) return;
    if (message.k === "need") {
      const ids = message.ids.filter(id => entry.mirror.allowsAsset(id));
      if (message.transport === "http") {
        const broker = viewer.session.host.assetBroker();
        const priorities = { style: 0, font: 1, image: 2, media: 3, other: 4 };
        ids.sort((a, b) => priorities[broker.contextOf(a) ?? "other"] - priorities[broker.contextOf(b) ?? "other"]);
        for (const id of ids) this.#sendEvent(viewer, { t: "mirror", tabId, msg: { k: "assetReady", id } });
      } else this.#enqueueAssets(viewer, tabId, ids);
      return;
    }
    if (message.k === "attach" || message.k === "detach") return;
    if (message.k === "ack" || message.k === "resync") { void entry.mirror.handle(message, entry.view); return; }
    const valid = (): boolean => this.#viewers.has(viewer) && !viewer.session.closed && viewer.mirrors.get(tabId) === entry && viewer.session.mayAct(generation) && this.#link(viewer).mayDrive(viewer.identity.id, viewGeneration);
    if (!valid()) return;
    viewer.session.host.noteViewerActivity(viewer.identity.id);
    this.#drivePane(viewer, tabId);
    void entry.mirror.handle(message, entry.view, valid);
  }

  #enqueueAssets(viewer: Viewer, tabId: string, ids: string[]): void {
    const already = new Set(viewer.assetQueue.map((entry) => entry.id));
    for (const id of ids) {
      if (!already.has(id) && viewer.assetQueue.length < 512) { viewer.assetQueue.push({ tabId, id }); already.add(id); }
    }
    void this.#pumpAssets(viewer);
  }

  /**
   * Send brokered asset bytes to a viewer, one chunk per binary frame, never
   * faster than the socket drains. Assets ride BINARY frames beside the JSON
   * ones for older viewers. Current viewers use HTTP to avoid delaying patches; a missing asset is
   * reported so the renderer stops waiting for it.
   */
  async #pumpAssets(viewer: Viewer): Promise<void> {
    if (viewer.assetPumping) return;
    viewer.assetPumping = true;
    try {
      while (viewer.assetQueue.length > 0 && this.#viewers.has(viewer)) {
        if (viewer.ws.bufferedAmount > MAX_BUFFERED_EVENT_BYTES) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        const next = viewer.assetQueue.shift();
        if (next === undefined) break;
        const result = await viewer.mirrors.get(next.tabId)?.mirror.asset(next.id);
        if (!this.#viewers.has(viewer)) return;
        if (result == null || result === "deferred" || result === "pending") continue;
        if (result === "missing") {
          this.#sendEvent(viewer, { t: "mirror", tabId: next.tabId, msg: { k: "assetMissing", id: next.id, failure: viewer.mirrors.get(next.tabId)?.mirror.assetDiagnostic(next.id) } });
          continue;
        }
        const total = result.bytes.byteLength;
        for (let offset = 0; offset < total || total === 0; offset += ASSET_CHUNK_BYTES) {
          if (!this.#viewers.has(viewer)) return;
          const slice = result.bytes.subarray(offset, offset + ASSET_CHUNK_BYTES);
          const frame = encodeAssetChunk({ tabId: next.tabId, id: next.id, type: result.type, offset, total }, slice);
          try {
            viewer.ws.send(frame);
          } catch {
            return;
          }
          if (total === 0) break;
          while (viewer.ws.bufferedAmount > MAX_BUFFERED_EVENT_BYTES && this.#viewers.has(viewer)) await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    } finally {
      viewer.assetPumping = false;
    }
  }

  /* --------------------------------- input --------------------------------- */

  /**
   * Forwarded input, under the fence (W7). Human control AND the current
   * generation, or it is dropped and counted — the count is what a test reads
   * to prove a stale input went nowhere rather than somewhere invisible.
   */
  #input(
    viewer: Viewer,
    tabId: string,
    generation: number,
    event: Parameters<typeof dispatchInput>[1],
  ): void {
    if (viewer.session.closed) return;
    if (!viewer.session.mayAct(generation)) return;
    const session = viewer.session.host.guardSessionFor(tabId);
    if (session === null) return;
    // An ACCEPTED input is this viewer driving — the plainest form of it, and
    // the one that raises a page's file picker. Refused input (an old fence,
    // a tab that is not here) is not, so the wheel stays where it was.
    viewer.session.host.noteViewerActivity(viewer.identity.id);
    this.#drivePane(viewer, tabId);
    dispatchInput(session, event);
    const dimensions = viewer.session.host.paneFor(tabId);
    if (this.#link(viewer).state.enabled && event.kind === "mouse" && dimensions) {
      const cursor = { tabId, viewerId: viewer.identity.id, x: Math.max(0, Math.min(1, event.x / dimensions.width)), y: Math.max(0, Math.min(1, event.y / dimensions.height)) };
      for (const peer of this.#viewers) if (peer.proved && peer.sessionId === viewer.sessionId && peer !== viewer) this.#sendEvent(peer, { t: "cursor", cursor });
    }
  }

  /* ------------------------------- keepalive ------------------------------- */

  #keepalive(viewer: Viewer): void {
    if (!this.#viewers.has(viewer)) return;
    if (viewer.awaitingPong) {
      this.#cleanup(viewer);
      viewer.ws.terminate();
      return;
    }
    viewer.awaitingPong = true;
    try {
      viewer.ws.ping();
    } catch {
      this.#cleanup(viewer);
      viewer.ws.terminate();
    }
  }

  async #recheck(viewer: Viewer): Promise<void> {
    let device;
    try {
      device = await this.#control.getDevice(viewer.deviceId);
    } catch (error) {
      this.#log.warn("shell socket re-check failed", { error: errorMessage(error) });
      return;
    }
    if (device === null || device.revokedAt !== null || device.userId !== viewer.userId) {
      this.#close(viewer, CLOSE_REVOKED, "revoked");
    }
  }

  /* ------------------------------- teardown ------------------------------- */

  #send(viewer: Viewer, frame: ShellServerFrame): void {
    send(viewer.ws, encodeShellServerFrame(frame));
  }

  /**
   * An event, under a buffer bound. Clipboard mirrors and context-menu
   * reports are driven straight from page script at up to a megabyte each, so
   * a viewer on a slow link is a page's lever on the worker's memory — and
   * the worker is shared with other people's runs. A dropped event is a
   * missed copy; an unbounded queue is a dead process.
   */
  #sendEvent(viewer: Viewer, frame: ShellServerFrame): void {
    if (!mayQueueEvent(viewer.ws.bufferedAmount)) {
      this.#log.warn("dropping a shell event: the viewer is not draining", { sessionId: viewer.sessionId });
      return;
    }
    send(viewer.ws, encodeShellServerFrame(frame));
  }

  #close(viewer: Viewer, code: number, reason: string): void {
    this.#cleanup(viewer);
    try {
      viewer.ws.close(code, reason);
    } catch {
      viewer.ws.terminate();
    }
  }

  #cleanup(viewer: Viewer): void {
    if (!this.#viewers.delete(viewer)) return;
    if (viewer.proved) { this.#link(viewer).leave(viewer.identity.id); this.#publishLinked(viewer); }
    clearInterval(viewer.recheck);
    clearInterval(viewer.ping);
    clearTimeout(viewer.proofDeadline);
    for (const off of viewer.unsubscribe) {
      try {
        off();
      } catch {
        // A listener that already went; nothing to undo.
      }
    }
    viewer.unsubscribe = [];
    for (const tabId of [...viewer.panes.keys()]) this.#stopPane(viewer, tabId);
    for (const tabId of [...viewer.mirrors.keys()]) this.#stopMirrorPane(viewer, tabId);
    // A pane still waiting for its tab to have a page has no screencast for
    // `#stopPane` to find, so its timer is cleared here.
    for (const tabId of [...viewer.paneWaits.keys()]) this.#clearPaneWait(viewer, tabId);
    for (const tabId of this.#paneSizes.get(viewer)?.keys() ?? []) this.#releaseViewport(viewer, tabId);
    this.#paneSizes.delete(viewer);
    viewer.session.detachViewer(viewer.ws);
    this.#registry.viewerDetached(viewer.sessionId);
    if (![...this.#viewers].some(peer => peer.sessionId === viewer.sessionId)) this.#linked.delete(viewer.sessionId);
  }
}

/** A captured frame in the shell protocol's envelope: the same frame, plus the tab. */
function shellFrame(tabId: string, frame: CapturedFrame): ShellServerFrame {
  return {
    t: "frame",
    tabId,
    data: frame.data,
    width: frame.width,
    height: frame.height,
    metadata: frame.metadata,
  };
}

/** The `ShellApi` the host must satisfy, asserted where the transport uses it. */
export type ShellHostSurface = ShellApi;
