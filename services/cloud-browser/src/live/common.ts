/**
 * What the live view (docs/cloud-sync-design.md §8.5) and the shell socket
 * (docs/web-browser-design.md §5, §6.1) both need, in one place.
 *
 * The two servers answer different protocols over different paths, but the
 * machinery underneath is the same machinery: an upgrade authenticated by a
 * one-redemption ticket with the origin pinned, a hop to whichever worker in
 * the fleet actually holds the thing, a screencast per guard session, input
 * dispatched to CDP, a 25-second ping, and a device re-check every minute.
 * That machinery is security-shaped — an origin check skipped in one server
 * and not the other is a hole — so it is written once and imported twice,
 * rather than copied and left to drift.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import type { CDPSession } from "playwright-core";
import { withDeadline } from "@pistachio/agent-runtime";
import type { liveKeyEventSchema, liveMouseEventSchema } from "@pistachio/live-view";
import type { z } from "zod";
import { WebSocket as WebSocketClient, type WebSocket, type WebSocketServer } from "ws";
import { errorMessage, type Logger } from "../logger.js";

/**
 * The two socket families this worker serves, in one place because both
 * servers attach to the SAME Node server and each must leave the other's
 * paths alone: an `upgrade` listener that rejected everything it did not
 * recognise would destroy the socket before its sibling ever saw it.
 */
export const LIVE_PATHS = { public: "/v1/live/", internal: "/v1/internal/live/" } as const;
export const SHELL_PATHS = { public: "/v1/shell/", internal: "/v1/internal/shell/" } as const;

/**
 * Which HTTP servers have a `ShellSocketServer` attached. The live view and
 * the shell socket share one Node server and each leaves the other's paths
 * alone (below) — but "left alone" and "nobody is listening" look the same to
 * a client, which then hangs until something times out. So the shell server
 * says it is here, and the live server refuses a shell path with `404` when
 * nothing does.
 */
const SHELL_ATTACHED = new WeakSet<object>();

export function markShellAttached(server: object): void {
  SHELL_ATTACHED.add(server);
}

export function unmarkShellAttached(server: object): void {
  SHELL_ATTACHED.delete(server);
}

export function shellAttachedTo(server: object | null): boolean {
  return server !== null && SHELL_ATTACHED.has(server);
}

/** Whether a path belongs to the other server, and must be left untouched. */
export function ownedByShell(pathname: string): boolean {
  return pathname.startsWith(SHELL_PATHS.public) || pathname.startsWith(SHELL_PATHS.internal);
}

export function ownedByLive(pathname: string): boolean {
  return pathname.startsWith(LIVE_PATHS.public) || pathname.startsWith(LIVE_PATHS.internal);
}

/** The viewer could not show it holds the Space key (§8.5, §5). */
export const CLOSE_REVOKED = 4003;
export const CLOSE_UNPROVEN = 4004;
/** The worker lost the session's lease under the viewers (§6.4). */
export const CLOSE_LEASE_LOST = 4005;
/** How long a viewer has to answer its challenge before the socket closes. */
export const DEFAULT_PROOF_TIMEOUT_MS = 10_000;
export const DEFAULT_RECHECK_INTERVAL_MS = 60_000;

/**
 * How often each socket is pinged.
 *
 * A screencast is silent whenever the page is: an agent reading a static page
 * sends nothing for minutes. Direct from the Mac that was fine, but a browser
 * reaches the runner through a load balancer, and every one of those culls
 * idle connections (ALB and nginx default to 60 s). So the server pings on a
 * cadence comfortably under that, which browsers answer at the protocol level
 * without the page knowing, and a socket that misses two in a row is treated
 * as gone rather than left to rot.
 */
export const DEFAULT_PING_INTERVAL_MS = 25_000;

/**
 * Devices allowed to watch. The Mac and the account web app; never a `cloud`
 * device, which is the runner itself and has no person behind it.
 */
export const VIEWER_PLATFORMS = new Set(["macos", "web"]);

/**
 * The origins of several URLs, for a server that accepts more than one (the
 * live view: the run page on `www` and the browser app, §15). Unset and
 * unparseable entries drop out, so a deployment that has configured only one
 * of the two ends up pinning that one rather than pinning nothing.
 */
export function originSet(urls: readonly (string | null | undefined)[] | null | undefined): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const url of urls ?? []) {
    const origin = originOf(url);
    if (origin !== null) origins.add(origin);
  }
  return origins;
}

/** `https://pistachio.run/anything` → `https://pistachio.run`, or null. */
export function originOf(url: string | null | undefined): string | null {
  if (url === undefined || url === null || url.trim() === "") return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/* -------------------------------- sockets -------------------------------- */

export function reject(socket: Duplex, status: number, text: string): void {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * Frames a viewer has not drained yet, in bytes, before the next one is
 * dropped. A screencast frame is disposable — the following one supersedes
 * it — so a viewer on a slow link must never make the runner buffer without
 * bound: it shares a process with the runs themselves.
 */
export const MAX_BUFFERED_FRAME_BYTES = 4 * 1024 * 1024;

export function sendFrame(ws: WebSocket, encoded: string): void {
  if (ws.bufferedAmount > MAX_BUFFERED_FRAME_BYTES) return;
  send(ws, encoded);
}

export function send(ws: WebSocket, encoded: string): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(encoded);
  } catch {
    // The socket is closing; the close handler cleans up.
  }
}

/** Constant-time compare for the in-fleet bearer. */
export function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function rawText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return "";
}

/**
 * The bearer on an upgrade, from the header or the query. A ticket in the URL
 * reaches `performance.getEntries()`, extensions, and every proxy in between,
 * so it is scrubbed off `request.url` here — before anything can log the
 * request line — and authorises nothing but this one socket.
 */
export function upgradeToken(request: IncomingMessage, url: URL): string | null {
  let token: string | null = null;
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) token = header.slice(7).trim();
  const queryToken = url.searchParams.get("access_token");
  if (queryToken !== null) {
    url.searchParams.delete("access_token");
    request.url = `${url.pathname}${url.search}`;
    token ??= queryToken;
  }
  return token === null || token === "" ? null : token;
}

/* ------------------------------- screencast ------------------------------- */

export interface ScreencastFrameEvent {
  data: string;
  metadata: {
    deviceWidth: number;
    deviceHeight: number;
    pageScaleFactor: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
  };
  sessionId: number;
}

interface LayoutMetrics {
  cssLayoutViewport: { clientWidth: number; clientHeight: number };
  cssVisualViewport: { pageX: number; pageY: number; scale: number };
}

/** A screencast frame, before either protocol wraps it in its own envelope. */
export interface CapturedFrame {
  data: string;
  width: number;
  height: number;
  metadata: ScreencastFrameEvent["metadata"];
}

export interface ScreencastOptions {
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
}

export const DEFAULT_SCREENCAST: Required<ScreencastOptions> = {
  quality: 60,
  maxWidth: 1280,
  maxHeight: 800,
  everyNthFrame: 2,
};

/**
 * How long the first snapshot is retried for, and how the waits grow.
 *
 * A screencast is silent whenever the page is (see `DEFAULT_PING_INTERVAL_MS`),
 * and a page that is silent FOR EVER — a welcome document, a reader page, an
 * article an agent stopped reading — gives a joining viewer exactly one
 * chance to be painted: the snapshot taken when its pane arrives. When that
 * one chance misses, the pane shows "Opening…" until the person gives up. So
 * it is not one chance any more.
 */
export const FIRST_FRAME_RETRY_MS = 250;
export const FIRST_FRAME_MAX_RETRY_MS = 2_000;
export const FIRST_FRAME_BUDGET_MS = 15_000;
/** How many times a refused `Page.startScreencast` is asked for again. */
const START_ATTEMPTS = 8;

/**
 * How long one `Page.captureScreenshot` is given before it is treated as a
 * failure.
 *
 * It does not reject when it cannot answer — it HANGS. Chromium serves a
 * screenshot out of the page's compositor, and a page that is not the front
 * one in its context produces no frames to serve, so the call sits unsettled
 * for as long as the page stays in the background. That is the ordinary state
 * of every welcome tab but the last one the host opened, and of every tab
 * behind the active one. Unbounded, one such call parks the pane's whole
 * attach — the live stream is never started, and the pane says "Opening…" for
 * ever.
 */
export const SNAPSHOT_TIMEOUT_MS = 2_000;

/**
 * One screencast per guard session, shared by every viewer of that page.
 *
 * The live view runs one at the run's default size; the shell runs one per
 * VISIBLE pane at that pane's size and device pixel ratio (§6.3), which is
 * why the geometry is a parameter rather than a constant.
 */
export class Screencast {
  readonly #session: CDPSession;
  readonly #log: Logger;
  readonly #viewers = new Map<WebSocket, (frame: CapturedFrame) => void>();
  /** Viewers that have been given at least one frame of this page. */
  readonly #painted = new Set<WebSocket>();
  #options: Required<ScreencastOptions>;
  #started = false;
  /** A refused start, waiting to be asked again. */
  #startRetry: NodeJS.Timeout | null = null;
  #resizeTimer: NodeJS.Timeout | null = null;
  #frameVersion = 0;
  readonly #onResize = (): void => {
    if (this.#resizeTimer !== null) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = setTimeout(() => {
      this.#resizeTimer = null;
      const version = this.#frameVersion;
      // Static/background pages may never send a compositor frame after a
      // viewport change. Refresh their still without overwriting newer video.
      void this.snapshot().then(frame => {
        if (!frame || !this.#started || version !== this.#frameVersion) return;
        for (const [viewer, emit] of this.#viewers) { this.#painted.add(viewer); emit(frame); }
      });
    }, 100);
    this.#resizeTimer.unref();
  };
  /** Viewers whose first snapshot is still being captured (keeps the stream registered). */
  pending = 0;
  readonly #onFrame = (event: ScreencastFrameEvent): void => {
    this.#frameVersion += 1;
    const frame = frameOf(event);
    for (const [viewer, emit] of [...this.#viewers]) {
      this.#painted.add(viewer);
      emit(frame);
    }
    void this.#session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
  };

  constructor(session: CDPSession, log: Logger, options: ScreencastOptions = {}) {
    this.#session = session;
    this.#log = log;
    this.#options = { ...DEFAULT_SCREENCAST, ...options };
  }

  get session(): CDPSession {
    return this.#session;
  }

  get viewers(): number {
    return this.#viewers.size;
  }

  get geometry(): Required<ScreencastOptions> {
    return this.#options;
  }

  /** Whether anything still references this stream. */
  get idle(): boolean {
    return this.#viewers.size === 0 && this.pending === 0;
  }

  /**
   * Re-capture at a new size. A pane resize must move the stream, not open a
   * second one on the same page: CDP allows exactly one screencast per
   * session, so the geometry is changed by restarting this one.
   */
  resize(options: ScreencastOptions): void {
    const next = { ...this.#options, ...options };
    if (
      next.quality === this.#options.quality &&
      next.maxWidth === this.#options.maxWidth &&
      next.maxHeight === this.#options.maxHeight &&
      next.everyNthFrame === this.#options.everyNthFrame
    ) {
      return;
    }
    this.#options = next;
    if (!this.#started) return;
    void this.#session
      .send("Page.startScreencast", { format: "jpeg", ...this.#options })
      .catch((error: unknown) => this.#log.warn("screencast resize failed", { error: errorMessage(error) }));
  }

  /**
   * One frame of the page as it is now. `everyNthFrame: 2` skips the single
   * compositor frame a static page produces on `Page.startScreencast`, so a
   * viewer attaching to an idle page would otherwise see nothing until the
   * agent acts. Null when the page cannot be captured (closing, backgrounded,
   * mid-navigation).
   *
   * BOUNDED, because `Page.captureScreenshot` does not fail when it cannot
   * answer — it never settles (see `SNAPSHOT_TIMEOUT_MS`). A caller that
   * awaited it without a deadline waited for the life of the page.
   */
  async snapshot(): Promise<CapturedFrame | null> {
    try {
      const shot = this.#session.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: this.#options.quality,
      }) as Promise<{ data: string }>;
      // A screenshot the deadline gave up on may still settle later; nothing
      // is waiting for it, and an unhandled rejection would take the process.
      shot.catch(() => undefined);
      const [{ data }, metrics] = await withDeadline(
        Promise.all([shot, this.#session.send("Page.getLayoutMetrics") as Promise<LayoutMetrics>]),
        SNAPSHOT_TIMEOUT_MS,
        "capturing the page",
      );
      const size = jpegSize(Buffer.from(data, "base64"));
      return {
        data,
        width: size?.width ?? metrics.cssLayoutViewport.clientWidth,
        height: size?.height ?? metrics.cssLayoutViewport.clientHeight,
        metadata: {
          deviceWidth: metrics.cssLayoutViewport.clientWidth,
          deviceHeight: metrics.cssLayoutViewport.clientHeight,
          pageScaleFactor: metrics.cssVisualViewport.scale,
          scrollOffsetX: metrics.cssVisualViewport.pageX,
          scrollOffsetY: metrics.cssVisualViewport.pageY,
        },
      };
    } catch (error) {
      this.#log.warn("live view snapshot failed", { error: errorMessage(error) });
      return null;
    }
  }

  add(viewer: WebSocket, emit: (frame: CapturedFrame) => void): void {
    this.#viewers.set(viewer, emit);
    this.#ensureStarted();
  }

  /** Whether this viewer has been given a frame of this page yet. */
  hasPainted(viewer: WebSocket): boolean {
    return this.#painted.has(viewer);
  }

  /** Say a viewer has its picture — the caller sent it a snapshot of its own. */
  markPainted(viewer: WebSocket): void {
    this.#painted.add(viewer);
  }

  /**
   * Keep taking the page's picture until this viewer has one.
   *
   * The live stream cannot be relied on for a first frame: a page that never
   * changes never emits one, and `everyNthFrame` above 1 drops the single
   * compositor frame `Page.startScreencast` produces. So a viewer that has
   * not been painted is retried on a growing backoff — and immediately when
   * the page says it has something new to show, which is the common case:
   * the snapshot was refused because the document was still being swapped in,
   * and `Page.loadEventFired` is the moment it stops being.
   *
   * Returns when the viewer has a frame, has gone, or the budget is spent.
   * `Page.enable` is asked for because those events need it and a guard
   * session has no reason to have enabled the domain; a session that refuses
   * it simply falls back to the backoff.
   */
  async ensurePainted(viewer: WebSocket, deliver: (frame: CapturedFrame) => void): Promise<void> {
    if (this.#painted.has(viewer) || !this.#viewers.has(viewer)) return;
    void this.#session.send("Page.enable").catch(() => undefined);
    const deadline = Date.now() + FIRST_FRAME_BUDGET_MS;
    let wake: (() => void) | null = null;
    const onProgress = (): void => wake?.();
    this.#session.on("Page.loadEventFired", onProgress);
    this.#session.on("Page.frameNavigated", onProgress);
    try {
      let wait = FIRST_FRAME_RETRY_MS;
      while (!this.#painted.has(viewer) && this.#viewers.has(viewer) && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve();
          }, wait);
          timer.unref();
          wake = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
          };
        });
        if (this.#painted.has(viewer) || !this.#viewers.has(viewer)) return;
        // A start that was refused leaves nothing streaming; ask again before
        // paying for another screenshot.
        this.#ensureStarted();
        const frame = await this.snapshot();
        if (frame === null) {
          wait = Math.min(wait * 2, FIRST_FRAME_MAX_RETRY_MS);
          continue;
        }
        if (this.#painted.has(viewer) || !this.#viewers.has(viewer)) return;
        this.#painted.add(viewer);
        deliver(frame);
        return;
      }
    } finally {
      this.#session.off("Page.loadEventFired", onProgress);
      this.#session.off("Page.frameNavigated", onProgress);
    }
  }

  remove(viewer: WebSocket): void {
    this.#viewers.delete(viewer);
    this.#painted.delete(viewer);
    if (this.#viewers.size > 0) return;
    if (this.#resizeTimer !== null) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = null;
    if (this.#startRetry !== null) {
      clearTimeout(this.#startRetry);
      this.#startRetry = null;
    }
    if (!this.#started) return;
    this.#started = false;
    this.#session.off("Page.screencastFrame", this.#onFrame);
    this.#session.off("Page.frameResized", this.#onResize);
    void this.#session.send("Page.stopScreencast").catch(() => undefined);
  }

  /**
   * Start the stream, and do not pretend it started when it did not.
   *
   * `Page.startScreencast` is refused while a target is being swapped or torn
   * down. Marking the stream started anyway — which is what the swallowed
   * rejection used to do — left the page with no live frames, no retry, and
   * every later viewer of it inheriting the silence.
   */
  #ensureStarted(attempt = 0): void {
    if (this.#started) return;
    this.#started = true;
    this.#session.on("Page.screencastFrame", this.#onFrame);
    this.#session.on("Page.frameResized", this.#onResize);
    void this.#session.send("Page.enable").catch(() => undefined);
    void this.#session.send("Page.startScreencast", { format: "jpeg", ...this.#options }).catch((error: unknown) => {
      this.#started = false;
      this.#session.off("Page.screencastFrame", this.#onFrame);
      this.#session.off("Page.frameResized", this.#onResize);
      this.#log.warn("screencast start failed", { error: errorMessage(error) });
      // A start refused during a target swap is refused for a MOMENT, not for
      // ever. Asking again is what keeps a viewer that already has its still
      // from watching a page that has since moved on — the snapshot retry
      // above stops as soon as one frame lands, so it cannot cover this.
      if (this.#viewers.size === 0 || attempt >= START_ATTEMPTS || this.#startRetry !== null) return;
      const wait = Math.min(FIRST_FRAME_RETRY_MS * 2 ** attempt, FIRST_FRAME_MAX_RETRY_MS);
      this.#startRetry = setTimeout(() => {
        this.#startRetry = null;
        if (this.#viewers.size > 0) this.#ensureStarted(attempt + 1);
      }, wait);
      this.#startRetry.unref();
    });
  }
}

function frameOf(event: ScreencastFrameEvent): CapturedFrame {
  const size = jpegSize(Buffer.from(event.data, "base64"));
  return {
    data: event.data,
    width: size?.width ?? event.metadata.deviceWidth,
    height: size?.height ?? event.metadata.deviceHeight,
    metadata: { ...event.metadata },
  };
}

/* --------------------------------- input --------------------------------- */

/**
 * Forward one pointer or key event to a page's guard session. The CALLER
 * decides whether it is allowed to: the live view forwards only while the
 * person holds control (§8.5), and the shell socket only under the current
 * control generation (W7). Nothing here is a permission check.
 */
export type LiveInputEvent = z.infer<typeof liveMouseEventSchema> | z.infer<typeof liveKeyEventSchema>;

export function dispatchInput(session: CDPSession, event: LiveInputEvent): void {
  if (event.kind === "mouse") {
    void session
      .send("Input.dispatchMouseEvent", {
        type: event.type,
        x: event.x,
        y: event.y,
        button: event.button,
        clickCount: event.clickCount,
        modifiers: event.modifiers,
        ...(event.deltaX === undefined ? {} : { deltaX: event.deltaX }),
        ...(event.deltaY === undefined ? {} : { deltaY: event.deltaY }),
      })
      .catch(() => undefined);
    return;
  }
  void session
    .send("Input.dispatchKeyEvent", {
      type: event.type,
      key: event.key,
      code: event.code,
      modifiers: event.modifiers,
      ...(event.text === undefined ? {} : { text: event.text, unmodifiedText: event.text }),
      ...(event.windowsVirtualKeyCode === undefined
        ? {}
        : { windowsVirtualKeyCode: event.windowsVirtualKeyCode, nativeVirtualKeyCode: event.windowsVirtualKeyCode }),
    })
    .catch(() => undefined);
}

/* --------------------------------- relay --------------------------------- */

export interface RelayRoute {
  /** The private address of the worker that holds the run or the session. */
  target: string;
  /** The in-fleet path, already including the id. */
  path: string;
  /** Identity the upstream is told, already authenticated by this hop. */
  query: Record<string, string>;
  serviceToken: string;
  pingIntervalMs: number;
}

/**
 * Pipe a viewer's socket to the worker that holds the thing.
 *
 * The upstream is dialled FIRST: a viewer whose target is gone should be
 * refused at the handshake, not accepted and dropped a moment later. Frames
 * pass through untouched, so the Space-key challenge stays end-to-end between
 * the viewer and the worker holding the key — this hop can neither answer it
 * nor read what it protects. Answers the teardown for the relay, or null when
 * it refused the socket itself.
 */
export async function relaySocket(
  wss: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  route: RelayRoute,
  log: Logger,
): Promise<(() => void) | null> {
  const base = route.target.trim().replace(/\/+$/, "");
  const scheme = base.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
  const query = new URLSearchParams(route.query);
  const url = `${scheme}${route.path}?${query.toString()}`;
  let upstream: WebSocketClient;
  try {
    upstream = new WebSocketClient(url, { headers: { authorization: `Bearer ${route.serviceToken}` } });
  } catch (error) {
    log.warn("relay could not dial", { error: errorMessage(error) });
    reject(socket, 502, "Bad Gateway");
    return null;
  }
  // The holder sends its challenge the instant it accepts — before this hop
  // has a downstream socket to forward it to. So the upstream is listened to
  // from the moment it is created, and anything that arrives before the
  // viewer's own handshake completes waits in a backlog.
  let pipe: ((text: string) => void) | null = null;
  const backlog: string[] = [];
  upstream.on("message", (data) => {
    const text = rawText(data);
    if (pipe === null) backlog.push(text);
    else pipe(text);
  });
  const opened = await new Promise<boolean>((resolve) => {
    upstream.once("open", () => resolve(true));
    upstream.once("error", () => resolve(false));
    upstream.once("unexpected-response", () => resolve(false));
  });
  if (!opened) {
    upstream.terminate();
    reject(socket, 502, "Bad Gateway");
    return null;
  }
  if (socket.destroyed) {
    upstream.close(1001, "gone");
    return null;
  }
  return new Promise<(() => void) | null>((resolve) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      const shut = (): void => {
        try {
          ws.close();
        } catch {
          ws.terminate();
        }
        try {
          upstream.close();
        } catch {
          upstream.terminate();
        }
      };
      // The protocol is JSON text in both directions; nothing here reads it.
      pipe = (text) => send(ws, text);
      for (const text of backlog) pipe(text);
      backlog.length = 0;
      ws.on("message", (data) => send(upstream as unknown as WebSocket, rawText(data)));
      // The relayed hop needs its own keepalive: ping and pong are per
      // connection, so the holding worker's pings stop at this process and
      // the leg through the load balancer would go silent (§8.5).
      const ping = setInterval(() => {
        try {
          ws.ping();
        } catch {
          shut();
        }
      }, route.pingIntervalMs);
      ping.unref();
      let done = (): void => undefined;
      done = (): void => {
        clearInterval(ping);
        shut();
      };
      ws.on("close", () => done());
      ws.on("error", () => done());
      upstream.on("close", () => done());
      upstream.on("error", () => done());
      resolve(() => done());
    });
  });
}

/* ------------------------------- jpeg sizes ------------------------------- */

/** Width and height from a JPEG's SOF marker; null when the bytes are not a JPEG. */
export function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}
