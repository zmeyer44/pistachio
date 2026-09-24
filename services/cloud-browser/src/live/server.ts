/**
 * The live view (docs/cloud-sync-design.md §8.5): `GET /v1/live/:runId`
 * WebSocket upgrades authenticated by control introspection of the desktop's
 * device token, re-checked every 60 s; CDP `Page.startScreencast` frames
 * from the active tab's guard session; input forwarded to
 * `Input.dispatch*` only while the person holds control.
 *
 * The parts it shares with the shell socket (docs/web-browser-design.md §6.1)
 * — the ticket, the origin pin, the in-fleet hop, the screencast, the
 * keepalive, the input dispatch — live in ./common.ts and are imported here
 * rather than copied there.
 */

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import type { AgentTabInfo } from "@pistachio/agent-runtime";
import type { TaskStatus } from "@pistachio/protocol";
import {
  decodeClientFrame,
  encodeServerFrame,
  type LiveServerFrame,
} from "@pistachio/live-view";
import type { CDPSession } from "playwright-core";
import { WebSocketServer, type WebSocket } from "ws";
import type { ControlClient } from "../control-client.js";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import {
  CLOSE_REVOKED,
  CLOSE_UNPROVEN,
  DEFAULT_PING_INTERVAL_MS,
  DEFAULT_PROOF_TIMEOUT_MS,
  DEFAULT_RECHECK_INTERVAL_MS,
  dispatchInput,
  LIVE_PATHS,
  originSet,
  ownedByShell,
  shellAttachedTo,
  rawText,
  reject,
  relaySocket,
  Screencast,
  send,
  sendFrame,
  timingSafeEquals,
  upgradeToken,
  VIEWER_PLATFORMS,
  type CapturedFrame,
} from "./common.js";

export {
  CLOSE_REVOKED,
  CLOSE_UNPROVEN,
  DEFAULT_PING_INTERVAL_MS,
  DEFAULT_PROOF_TIMEOUT_MS,
  DEFAULT_RECHECK_INTERVAL_MS,
  jpegSize,
} from "./common.js";

export const LIVE_PATH_PREFIX = LIVE_PATHS.public;
/**
 * The in-fleet hop. A worker that does not hold the run proxies here, to the
 * worker that does, over the private network — so the fleet keeps ONE public
 * address and autoscales without anyone minting per-worker DNS (§8.5). It is
 * authenticated by the service bearer and never proxies onward, so there is
 * no ring to go round.
 */
export const LIVE_INTERNAL_PATH_PREFIX = LIVE_PATHS.internal;

/** What the live view needs from an active run. */
export interface LiveRun {
  readonly userId: string;
  readonly status: TaskStatus;
  readonly control: "agent" | "human";
  readonly ended: boolean;
  readonly spaceId: string;
  /** Whether a viewer's answer to `nonce` proves it holds this run's Space key (§8.5). */
  verifySpaceProof(nonce: string, proof: string): Promise<boolean>;
  tabs(): AgentTabInfo[];
  activeTabId(): string | null;
  guardSessionFor(tabId: string): CDPSession | null;
  focusTab(tabId: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export interface LiveRunRegistry {
  get(runId: string): LiveRun | null;
}

/**
 * The wire types and their validation live in `@pistachio/live-view`, which
 * both clients import too — one definition, so a frame cannot mean one thing
 * here and another there.
 */
export type { FrameMetadata, LiveClientFrame, LiveServerFrame } from "@pistachio/live-view";

export interface LiveViewServerOptions {
  control: ControlClient;
  runs: LiveRunRegistry;
  recheckIntervalMs?: number;
  pingIntervalMs?: number;
  proofTimeoutMs?: number;
  /**
   * The web apps a live view may be watched from (docs/web-browser-design.md
   * §15). A browser puts `Origin` on every WebSocket upgrade, so this is the
   * set one is allowed to be in; a native client (Electron main, Node `ws`)
   * sends none and is unaffected. Empty means no browser may connect at all.
   *
   * A list rather than a single URL because there are now two sites: the run
   * page lives on `www`, and the browser app is a second origin that will
   * want the same picture. Anything not in it is refused before the ticket
   * is looked at.
   */
  viewerOrigins?: readonly (string | null | undefined)[];
  /** Bearer for the in-fleet hop, in both directions. */
  serviceToken?: string;
  log?: Logger;
}

interface Viewer {
  ws: WebSocket;
  userId: string;
  deviceId: string;
  runId: string;
  run: LiveRun;
  /** The nonce this viewer must answer, and whether it has (§8.5). */
  nonce: string;
  proved: boolean;
  proofDeadline: NodeJS.Timeout;
  recheck: NodeJS.Timeout;
  ping: NodeJS.Timeout;
  /** Cleared by a pong; a second ping with it still set means the peer is gone. */
  awaitingPong: boolean;
  unsubscribe: () => void;
  screencast: Screencast | null;
  activeTabId: string | null;
}

export class LiveViewServer {
  readonly #control: ControlClient;
  readonly #runs: LiveRunRegistry;
  readonly #recheckIntervalMs: number;
  readonly #pingIntervalMs: number;
  readonly #proofTimeoutMs: number;
  readonly #viewerOrigins: ReadonlySet<string>;
  readonly #serviceToken: string | null;
  readonly #log: Logger;
  readonly #wss = new WebSocketServer({ noServer: true });
  readonly #viewers = new Set<Viewer>();
  /** Teardown for each socket this worker is relaying to another (§8.5). */
  readonly #relays = new Set<() => void>();
  readonly #screencasts = new Map<CDPSession, Screencast>();
  #server: Server | null = null;
  readonly #onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // The raw socket has no listener until `ws` takes it over; a reset in
    // the meantime must not become an uncaught 'error'. And a malformed
    // request-target (URIError from decodeURIComponent, before any auth)
    // must be answered, not left as an unhandled rejection that ends the
    // runner and every run on it.
    socket.on("error", () => socket.destroy());
    this.#handleUpgrade(request, socket, head).catch(() => reject(socket, 400, "Bad Request"));
  };

  constructor(options: LiveViewServerOptions) {
    this.#control = options.control;
    this.#runs = options.runs;
    this.#recheckIntervalMs = options.recheckIntervalMs ?? DEFAULT_RECHECK_INTERVAL_MS;
    this.#pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.#proofTimeoutMs = options.proofTimeoutMs ?? DEFAULT_PROOF_TIMEOUT_MS;
    this.#viewerOrigins = originSet(options.viewerOrigins);
    this.#serviceToken = options.serviceToken ?? null;
    this.#log = options.log ?? silentLogger;
  }

  get connections(): number {
    return this.#viewers.size;
  }

  attach(server: Server): void {
    if (this.#server !== null) throw new Error("live view server already attached");
    this.#server = server;
    server.on("upgrade", this.#onUpgrade);
  }

  /** `device.revoked`: close every socket of the user at once. */
  closeUser(userId: string, code = CLOSE_REVOKED, reason = "revoked"): void {
    for (const viewer of [...this.#viewers]) {
      if (viewer.userId === userId) this.#close(viewer, code, reason);
    }
  }

  closeRun(runId: string, code = 1000, reason = "ended"): void {
    for (const viewer of [...this.#viewers]) {
      if (viewer.runId === runId) {
        send(viewer.ws, encodeServerFrame({ t: "error", code: "ended", message: "the run has ended" }));
        this.#close(viewer, code, reason);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#server !== null) {
      this.#server.off("upgrade", this.#onUpgrade);
      this.#server = null;
    }
    for (const viewer of [...this.#viewers]) this.#close(viewer, 1001, "shutdown");
    for (const done of [...this.#relays]) done();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
  }

  /* ------------------------------ upgrade ------------------------------ */

  async #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    // The shell socket attaches to this same server (web-browser-design.md
    // §6.1). Its paths are not ours to refuse — unless nothing is there to
    // answer them, in which case a silent `return` leaves the client holding
    // a dangling upgrade until something times out, and a `404` is the truth.
    if (ownedByShell(url.pathname)) {
      if (!shellAttachedTo(this.#server)) reject(socket, 404, "Not Found");
      return;
    }
    const internal = url.pathname.startsWith(LIVE_INTERNAL_PATH_PREFIX);
    if (!internal && !url.pathname.startsWith(LIVE_PATH_PREFIX)) {
      reject(socket, 404, "Not Found");
      return;
    }
    const prefix = internal ? LIVE_INTERNAL_PATH_PREFIX : LIVE_PATH_PREFIX;
    const runId = decodeURIComponent(url.pathname.slice(prefix.length));
    const token = upgradeToken(request, url);
    if (token === null || runId === "") {
      reject(socket, 401, "Unauthorized");
      return;
    }
    if (internal) {
      this.#acceptInternal(request, socket, head, url, runId, token);
      return;
    }
    // A page on another origin must not be able to open someone's screen,
    // ticket or no ticket. Checked first: it costs nothing and it is the one
    // check that does not depend on the ticket being real.
    const origin = request.headers.origin;
    if (typeof origin === "string" && origin !== "" && !this.#viewerOrigins.has(origin)) {
      reject(socket, 403, "Forbidden");
      return;
    }
    // The ticket is opaque, single-use, and scoped to this run: redeeming it
    // both authenticates the viewer and says which worker holds the run.
    let redemption;
    try {
      redemption = await this.#control.redeemLiveTicket(token, runId);
    } catch (error) {
      this.#log.warn("live ticket redemption failed", { error: errorMessage(error) });
      reject(socket, 503, "Service Unavailable");
      return;
    }
    if (redemption === null) {
      reject(socket, 401, "Unauthorized");
      return;
    }
    if (!VIEWER_PLATFORMS.has(redemption.platform)) {
      reject(socket, 403, "Forbidden");
      return;
    }
    const run = this.#runs.get(runId);
    if (run !== null && !run.ended && run.userId === redemption.userId) {
      if (socket.destroyed) return;
      const { userId, deviceId } = redemption;
      this.#wss.handleUpgrade(request, socket, head, (ws) => {
        this.#accept(ws, { userId, deviceId, runId, run });
      });
      return;
    }
    // Not ours. Control named the worker whose memory the run lives in; hand
    // the socket to it over the private network.
    if (redemption.workerUrl === null || this.#serviceToken === null) {
      reject(socket, 404, "Not Found");
      return;
    }
    const done = await relaySocket(
      this.#wss,
      request,
      socket,
      head,
      {
        target: redemption.workerUrl,
        path: `${LIVE_INTERNAL_PATH_PREFIX}${encodeURIComponent(runId)}`,
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

  /** The other end of the in-fleet hop: this worker holds the run, or nobody does. */
  #acceptInternal(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
    runId: string,
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
    const run = this.#runs.get(runId);
    // No onward proxy from here: the gateway already chose this worker, and a
    // second hop would be a worker pointing at a worker pointing back.
    if (run === null || run.ended || run.userId !== userId) {
      reject(socket, 404, "Not Found");
      return;
    }
    if (socket.destroyed) return;
    this.#wss.handleUpgrade(request, socket, head, (ws) => {
      this.#accept(ws, { userId, deviceId, runId, run });
    });
  }

  #accept(ws: WebSocket, viewerInfo: { userId: string; deviceId: string; runId: string; run: LiveRun }): void {
    const viewer: Viewer = {
      ws,
      ...viewerInfo,
      nonce: randomBytes(32).toString("base64url"),
      proved: false,
      proofDeadline: setTimeout(() => {
        if (!viewer.proved) {
          send(
            viewer.ws,
            encodeServerFrame({
              t: "error",
              code: "space_key_required",
              message: "this viewer did not prove it holds the Space key",
            }),
          );
          this.#close(viewer, CLOSE_UNPROVEN, "space_key_required");
        }
      }, this.#proofTimeoutMs),
      recheck: setInterval(() => void this.#recheck(viewer), this.#recheckIntervalMs),
      ping: setInterval(() => this.#keepalive(viewer), this.#pingIntervalMs),
      awaitingPong: false,
      unsubscribe: () => undefined,
      screencast: null,
      activeTabId: null,
    };
    viewer.recheck.unref();
    viewer.ping.unref();
    viewer.proofDeadline.unref();
    this.#viewers.add(viewer);
    viewer.unsubscribe = viewer.run.subscribe(() => this.#refresh(viewer));
    ws.on("pong", () => {
      viewer.awaitingPong = false;
    });
    ws.on("message", (data) => this.#onMessage(viewer, data));
    ws.on("close", () => this.#cleanup(viewer));
    ws.on("error", () => this.#cleanup(viewer));
    // The challenge, and nothing else: a device token gets you a socket, the
    // Space key gets you the picture (§8.5).
    send(viewer.ws, encodeServerFrame({ t: "challenge", spaceId: viewer.run.spaceId, nonce: viewer.nonce }));
  }

  /**
   * The viewer's answer to its challenge. A wrong one is not a retry: the
   * nonce is spent, and a socket that may keep guessing is a socket that will.
   */
  async #answerChallenge(viewer: Viewer, proof: string): Promise<void> {
    if (viewer.proved || !this.#viewers.has(viewer)) return;
    let ok = false;
    try {
      ok = await viewer.run.verifySpaceProof(viewer.nonce, proof);
    } catch (error) {
      this.#log.warn("live view proof check failed", { error: errorMessage(error) });
    }
    if (!this.#viewers.has(viewer)) return;
    if (!ok) {
      send(
        viewer.ws,
        encodeServerFrame({
          t: "error",
          code: "space_key_required",
          message: "that did not prove possession of this run's Space key",
        }),
      );
      this.#close(viewer, CLOSE_UNPROVEN, "space_key_required");
      return;
    }
    viewer.proved = true;
    clearTimeout(viewer.proofDeadline);
    this.#refresh(viewer);
  }

  /**
   * Hold the connection open through whatever sits between, and drop it when
   * the peer has gone without saying so — a half-open socket otherwise keeps
   * a screencast running for nobody.
   */
  #keepalive(viewer: Viewer): void {
    if (!this.#viewers.has(viewer)) return;
    if (viewer.awaitingPong) {
      // `terminate`, not `close`: a peer that ignored the last ping will not
      // complete a closing handshake either.
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
      this.#log.warn("live view re-check failed", { error: errorMessage(error) });
      return;
    }
    if (device === null || device.revokedAt !== null || device.userId !== viewer.userId) {
      this.#close(viewer, CLOSE_REVOKED, "revoked");
    }
  }

  #refresh(viewer: Viewer): void {
    if (!this.#viewers.has(viewer) || !viewer.proved) return;
    const run = viewer.run;
    if (run.ended) {
      send(viewer.ws, encodeServerFrame({ t: "error", code: "ended", message: "the run has ended" }));
      this.#close(viewer, 1000, "ended");
      return;
    }
    send(viewer.ws, encodeServerFrame({ t: "status", status: run.status, control: run.control }));
    send(viewer.ws, encodeServerFrame({ t: "tabs", tabs: run.tabs(), activeTabId: run.activeTabId() }));
    this.#retarget(viewer);
  }

  /** Follow the active tab: move the viewer's screencast to its guard session. */
  #retarget(viewer: Viewer): void {
    const activeTabId = viewer.run.activeTabId();
    const session = activeTabId === null ? null : viewer.run.guardSessionFor(activeTabId);
    if (viewer.screencast !== null && viewer.screencast.session === session) return;
    this.#detachStream(viewer);
    viewer.activeTabId = activeTabId;
    if (session === null) return;
    let screencast = this.#screencasts.get(session);
    if (screencast === undefined) {
      screencast = new Screencast(session, this.#log);
      this.#screencasts.set(session, screencast);
    }
    viewer.screencast = screencast;
    screencast.pending += 1;
    void this.#attachStream(viewer, screencast);
  }

  /**
   * Join the live stream, then send the page as it is now — the stream FIRST,
   * for the reason `ShellSocketServer.#attachPane` gives: a screenshot of a
   * page that is not the front one in its context never settles, and awaiting
   * it before registering left the viewer with no stream at all. The still is
   * then only worth sending if the page has not painted in the meantime.
   */
  async #attachStream(viewer: Viewer, screencast: Screencast): Promise<void> {
    screencast.add(viewer.ws, (frame) => sendFrame(viewer.ws, encodeServerFrame(liveFrame(frame))));
    let snapshot: CapturedFrame | null = null;
    try {
      snapshot = await screencast.snapshot();
    } finally {
      screencast.pending -= 1;
    }
    if (viewer.screencast !== screencast || !this.#viewers.has(viewer)) {
      this.#evictIfIdle(screencast);
      return;
    }
    if (snapshot === null || screencast.hasPainted(viewer.ws)) {
      // Nothing to show yet: keep asking, because a page that never changes
      // again will never announce itself.
      await screencast.ensurePainted(viewer.ws, (frame) => {
        if (viewer.screencast !== screencast || !this.#viewers.has(viewer)) return;
        send(viewer.ws, encodeServerFrame(liveFrame(frame)));
      });
      return;
    }
    screencast.markPainted(viewer.ws);
    send(viewer.ws, encodeServerFrame(liveFrame(snapshot)));
  }

  #detachStream(viewer: Viewer): void {
    const screencast = viewer.screencast;
    if (screencast === null) return;
    viewer.screencast = null;
    screencast.remove(viewer.ws);
    this.#evictIfIdle(screencast);
  }

  #evictIfIdle(screencast: Screencast): void {
    if (screencast.idle && this.#screencasts.get(screencast.session) === screencast) {
      this.#screencasts.delete(screencast.session);
    }
  }

  #onMessage(viewer: Viewer, data: unknown): void {
    const parsed = decodeClientFrame(rawText(data));
    if (parsed === null) return;
    if (parsed.t === "auth") {
      void this.#answerChallenge(viewer, parsed.proof);
      return;
    }
    // Nothing but the proof is listened to until the proof is in.
    if (!viewer.proved) return;
    const run = viewer.run;
    if (run.control !== "human" || run.ended) return; // dropped: the agent holds the browser
    if (parsed.t === "focus") {
      void run.focusTab(parsed.tabId).catch(() => undefined);
      return;
    }
    const activeTabId = run.activeTabId();
    const session = activeTabId === null ? null : run.guardSessionFor(activeTabId);
    if (session === null) return;
    dispatchInput(session, parsed.event);
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
    clearInterval(viewer.recheck);
    clearInterval(viewer.ping);
    clearTimeout(viewer.proofDeadline);
    viewer.unsubscribe();
    this.#detachStream(viewer);
  }
}

/** A captured frame as the live view's own envelope carries it. */
function liveFrame(frame: CapturedFrame): LiveServerFrame {
  return { t: "frame", data: frame.data, width: frame.width, height: frame.height, metadata: frame.metadata };
}
