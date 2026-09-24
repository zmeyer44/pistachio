/**
 * LiveViewClient — the desktop end of a cloud run's live view
 * (docs/cloud-sync-design.md §8.5, §10.4).
 *
 * One WebSocket from main to the cloud browser, `wss://<runner>/v1/live/:runId`,
 * authenticated with this Mac's device token. Electron main's WebSocket
 * cannot set an Authorization header, so the token rides as
 * `?access_token=` (§8.5's fallback; the runner deletes it before logging).
 * Screencast frames are relayed to the shell on `cloud:frame`; the person's
 * pointer and keyboard input comes back on `cloud:liveInput` and is forwarded
 * only while the run is under human control — the runner drops it otherwise,
 * and so does this client. A close with code 4003 means the device was
 * revoked: the client does not reconnect and says so.
 */

import type { TaskStatus } from "@pistachio/protocol";
import { decodeServerFrame, encodeClientFrame, liveViewUrl } from "@pistachio/live-view";
import type { CloudFrame, CloudLiveInput, CloudTabInfo } from "@pistachio/shell-contracts/ipc";
import type { CloudLiveStatus } from "../feature-handlers";

/** The hub and the runner both close a revoked device's socket with this (§4, §8.5). */
export const CLOSE_REVOKED = 4003;
export const LIVE_RECONNECT_DELAY_MS = 1_000;
export const LIVE_MAX_RECONNECTS = 5;

export interface LiveSocketEvent {
  data?: unknown;
  code?: number;
  reason?: string;
}

export type LiveSocketEventType = "open" | "message" | "close" | "error";

/** The slice of a WebSocket the client uses; a fake in tests. */
export interface LiveSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: LiveSocketEventType, listener: (event: LiveSocketEvent) => void): void;
}

export type LiveSocketFactory = (url: string) => LiveSocketLike;

const SOCKET_OPEN = 1;

/** Electron main's global WebSocket (Node's), behind the slice above. */
export function defaultLiveSocketFactory(url: string): LiveSocketLike {
  const Impl = (globalThis as { WebSocket?: new (url: string) => WebSocket }).WebSocket;
  if (Impl === undefined) throw new Error("WebSocket is not available in this process");
  const socket = new Impl(url);
  return {
    get readyState() {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    addEventListener: (type, listener) => {
      switch (type) {
        case "message":
          socket.addEventListener("message", (event) => listener({ data: (event as { data: unknown }).data }));
          break;
        case "close":
          socket.addEventListener("close", (event) => {
            const closed = event as { code?: number; reason?: string };
            listener({ code: closed.code ?? 1006, reason: closed.reason ?? "" });
          });
          break;
        default:
          socket.addEventListener(type, () => listener({}));
      }
    },
  };
}

/** Where to dial, and what to dial it with, for one run (§8.5). */
export interface LiveTicket {
  url: string;
  ticket: string;
}

export interface LiveViewClientDeps {
  /**
   * Control's `POST /v1/runs/:id/live-ticket`: the address of the worker that
   * actually holds this run — not `/me`'s single runner address, which names
   * no particular worker — and a one-minute credential for it. Fetched again
   * on every dial, so a reconnect after a re-claim follows the run to its new
   * worker. Null when this Mac is not enrolled, or the run is not watchable.
   */
  ticket(runId: string): Promise<LiveTicket | null>;
  /**
   * Seal `nonce` under the Space's key for the runner's challenge (§8.5),
   * base64. Null when this Mac cannot open that Space — in which case it
   * cannot watch, by the same rule that stops it reading the thread.
   */
  proveSpaceKey(spaceId: string, runId: string, nonce: string): Promise<string | null>;
  publishFrame(frame: CloudFrame): void;
  /** Any status field changed: the composed cloud status is re-published. */
  onStatusChanged(): void;
  socketFactory?: LiveSocketFactory;
  reconnectDelayMs?: number;
  maxReconnects?: number;
}

/** Dialling the runner is the same arithmetic in both clients (§8.5). */
export { liveViewUrl };

export class LiveViewClient {
  readonly #deps: LiveViewClientDeps;
  readonly #factory: LiveSocketFactory;
  #socket: LiveSocketLike | null = null;
  #runId: string | null = null;
  #state: CloudLiveStatus["liveState"] = "closed";
  #error: string | null = null;
  #control: "agent" | "human" | null = null;
  #runStatus: TaskStatus | null = null;
  #tabs: CloudTabInfo[] = [];
  #activeTabId: string | null = null;
  #closedByUser = false;
  #attempts = 0;
  #reconnectTimer: NodeJS.Timeout | null = null;
  /** Bumped per open()/close(); a stale socket's events are ignored. */
  #generation = 0;
  /**
   * Resolves the dial that is currently waiting on its socket. A superseding
   * open()/close() tears that socket down and bumps the generation before its
   * close event arrives, so the dial's own listeners never settle it — and
   * `ipcMain.handle(IPC.cloudLiveOpen)` would await it forever.
   */
  #settleDial: (() => void) | null = null;

  constructor(deps: LiveViewClientDeps) {
    this.#deps = deps;
    this.#factory = deps.socketFactory ?? defaultLiveSocketFactory;
  }

  status(): CloudLiveStatus {
    return {
      liveRunId: this.#runId,
      liveState: this.#state,
      liveError: this.#error,
      liveControl: this.#control,
      liveStatus: this.#runStatus,
      liveTabs: this.#tabs.map((tab) => ({ ...tab })),
      liveActiveTabId: this.#activeTabId,
    };
  }

  /** The run's status as the runner last reported it over the live view. */
  runStatus(): TaskStatus | null {
    return this.#runStatus;
  }

  /** Open the live view of `runId`; resolves once the socket is open or has failed. */
  async open(runId: string): Promise<CloudLiveStatus> {
    this.#teardown();
    const generation = ++this.#generation;
    this.#runId = runId;
    this.#closedByUser = false;
    this.#attempts = 0;
    this.#error = null;
    this.#control = null;
    this.#runStatus = null;
    this.#tabs = [];
    this.#activeTabId = null;
    this.#setState("connecting");
    await this.#dial(generation);
    return this.status();
  }

  /** Close the live view; the run keeps going in the cloud. */
  async close(): Promise<void> {
    this.#closedByUser = true;
    this.#generation += 1;
    this.#teardown();
    this.#runId = null;
    this.#control = null;
    this.#runStatus = null;
    this.#tabs = [];
    this.#activeTabId = null;
    this.#error = null;
    this.#setState("closed");
  }

  /** Forward the person's input — only while the socket is open and the person holds control. */
  input(input: CloudLiveInput): void {
    const socket = this.#socket;
    if (socket === null || this.#state !== "open" || socket.readyState !== SOCKET_OPEN) return;
    if (input.t === "input" && this.#control !== "human") return;
    try {
      socket.send(encodeClientFrame(input));
    } catch (error) {
      console.error("[cloud] live input could not be sent", error);
    }
  }

  /* -------------------------------- internals -------------------------------- */

  async #dial(generation: number): Promise<void> {
    const runId = this.#runId;
    if (runId === null) return;
    let ticket: LiveTicket | null;
    try {
      ticket = await this.#deps.ticket(runId);
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : String(error));
      return;
    }
    if (generation !== this.#generation) return;
    if (ticket === null) {
      this.#fail("This run cannot be watched right now — it may not have started, or may have ended.");
      return;
    }
    let socket: LiveSocketLike;
    try {
      socket = this.#factory(liveViewUrl(ticket.url, runId, ticket.ticket));
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : String(error));
      return;
    }
    this.#socket = socket;
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        if (this.#settleDial === settle) this.#settleDial = null;
        resolve();
      };
      this.#settleDial = settle;
      socket.addEventListener("open", () => {
        // Superseded: the dial that replaced this one owns the state now, but
        // this one still has a caller waiting on it.
        if (generation !== this.#generation) {
          settle();
          return;
        }
        this.#attempts = 0;
        this.#setState("open");
        settle();
      });
      socket.addEventListener("message", (event) => {
        if (generation !== this.#generation) return;
        this.#message(runId, event.data);
      });
      socket.addEventListener("error", () => {
        // The close that follows carries the code; nothing to decide here.
      });
      socket.addEventListener("close", (event) => {
        if (generation !== this.#generation) {
          settle();
          return;
        }
        this.#socket = null;
        this.#closed(generation, event.code ?? 1006);
        settle();
      });
    });
  }

  #message(runId: string, data: unknown): void {
    const frame = decodeServerFrame(data);
    if (frame === null) return;
    switch (frame.t) {
      case "challenge":
        void this.#prove(runId, frame.spaceId, frame.nonce);
        return;
      case "frame":
        this.#deps.publishFrame({
          runId,
          data: frame.data,
          width: frame.width,
          height: frame.height,
          metadata: frame.metadata,
        });
        return;
      case "tabs":
        this.#tabs = frame.tabs;
        this.#activeTabId = frame.activeTabId;
        this.#deps.onStatusChanged();
        return;
      case "status":
        this.#control = frame.control;
        this.#runStatus = frame.status as TaskStatus;
        this.#deps.onStatusChanged();
        return;
      case "error":
        // The runner will close the socket next; remember why so the close
        // does not read as a drop. Every code it sends is terminal — ended,
        // gone, refused, unproven — so none of them is worth re-dialling.
        this.#error = frame.message;
        this.#closedByUser = true;
        this.#deps.onStatusChanged();
        return;
    }
  }

  /**
   * Answer the runner's challenge (§8.5): the nonce sealed under the run's
   * Space key. The runner holds the same key and opens it, so a Mac that is
   * signed in but cannot open this Space sees nothing — which is the same
   * rule the thread itself follows.
   */
  async #prove(runId: string, spaceId: string, nonce: string): Promise<void> {
    let proof: string | null = null;
    try {
      proof = await this.#deps.proveSpaceKey(spaceId, runId, nonce);
    } catch {
      proof = null;
    }
    if (proof === null) {
      this.#fail("This Mac cannot open that run's Space, so it cannot watch it.");
      return;
    }
    const socket = this.#socket;
    if (socket === null || socket.readyState !== SOCKET_OPEN) return;
    try {
      socket.send(encodeClientFrame({ t: "auth", proof }));
    } catch {
      // The close handler picks it up.
    }
  }

  #closed(generation: number, code: number): void {
    if (code === CLOSE_REVOKED) {
      // The runner will not have this device back; only re-enrolling changes that.
      this.#error = "device revoked";
      this.#setState("revoked");
      return;
    }
    if (this.#closedByUser) {
      if (this.#error !== null) this.#setState("error");
      else this.#setState("closed");
      return;
    }
    const max = this.#deps.maxReconnects ?? LIVE_MAX_RECONNECTS;
    if (this.#attempts >= max) {
      this.#error = this.#error ?? "the live view connection was lost";
      this.#setState("error");
      return;
    }
    this.#attempts += 1;
    this.#setState("connecting");
    const delay = (this.#deps.reconnectDelayMs ?? LIVE_RECONNECT_DELAY_MS) * this.#attempts;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (generation !== this.#generation) return;
      void this.#dial(generation);
    }, delay);
    this.#reconnectTimer.unref();
  }

  #fail(message: string): void {
    this.#error = message;
    this.#setState("error");
  }

  #setState(state: CloudLiveStatus["liveState"]): void {
    this.#state = state;
    this.#deps.onStatusChanged();
  }

  #teardown(): void {
    // Whoever is awaiting the superseded dial gets the superseding outcome,
    // read from `status()` once the caller that tore this down has finished.
    this.#settleDial?.();
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      try {
        socket.close(1000, "closed");
      } catch {
        // Already closed.
      }
    }
  }
}
