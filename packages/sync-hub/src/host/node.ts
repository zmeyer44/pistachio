/**
 * Node host for HubCore (docs/cloud-sync-design.md §4, D1): a `ws` server
 * attached to an existing `http.Server` in the control-plane process.
 *
 * Upgrade rules, in order:
 *   - token from `Authorization: Bearer` or `?access_token=` (scrubbed from
 *     the request URL before anything can log it);
 *   - `verifyToken` → `null` ⇒ HTTP 401; `deviceId === null` (a bootstrap
 *     token) ⇒ HTTP 403 before the handshake; `revoked` ⇒ complete the
 *     handshake, then close `4003 revoked` so the client learns why;
 *   - otherwise the socket is bound to `{deviceId, kind}` from the verified
 *     token before any frame is read; nothing rebinds it.
 *
 * One HubCore per connected user, evicted five minutes after its last socket
 * closes. A per-user promise chain serializes every socket handler and every
 * `HubHost` method; `verifyToken` runs before entering the chain.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { MAX_FRAME_BYTES, type DeviceKind, type ServerMessage } from "@pistachio/sync-protocol";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { bearerToken } from "../auth.js";
import {
  CLOSE_REVOKED,
  HubCore,
  type HubConnection,
  type HubStorage,
  type LeaseFilter,
} from "../hub-core.js";

/** Result of verifying a bearer for the hub (control's `authenticateToken`). */
export interface VerifiedHubToken {
  userId: string;
  /** `null` for a bootstrap token (no enrolled device). */
  deviceId: string | null;
  /** From `devices.platform`, never the token; `null` when unknown. */
  platform: "macos" | "cloud" | null;
  revoked: boolean;
}

export interface AttachSyncHubOptions {
  /** Upgrade path, `/v1/hub/ws` in the control plane. */
  path: string;
  verifyToken(token: string): Promise<VerifiedHubToken | null>;
  /** Storage for one user. Called at most once per cache lifetime; every
   * call for the same user must address the same durable data. */
  storageFor(userId: string): HubStorage;
  now?: () => number;
  /** Server-side liveness: a socket that misses one ping round is terminated. */
  livenessIntervalMs?: number;
}

export interface HubHost {
  /** Persist the revocation, release the device's leases, and close its
   * sockets with `4003 revoked`. */
  revokeDevice(userId: string, deviceId: string): Promise<void>;
  /** Send one frame to every open socket of the user. */
  broadcast(userId: string, frame: ServerMessage): Promise<void>;
  /** Drop leases held by `deviceId` (optionally narrowed) with
   * `lease.released` fan-out — e.g. when a cloud run ends. */
  releaseLeases(
    userId: string,
    filter: { deviceId: string } & LeaseFilter,
  ): Promise<void>;
  /** Run `HubCore.gc` for each user, sequentially. Defaults to the users
   * currently cached; pass `userIds` to sweep others (e.g. from `hub_kv`). */
  gc(now?: number, userIds?: Iterable<string>): Promise<void>;
  /** Detach from the server, close every socket, and settle all chains. */
  close(): Promise<void>;
}

/** Idle time after a user's last socket closes before its HubCore is dropped. */
export const HUB_CORE_IDLE_EVICTION_MS = 5 * 60_000;
/**
 * Ping cadence. A half-open socket (peer vanished without a FIN) otherwise
 * stays in the user's socket set forever, keeping its leases and presence
 * alive and blocking the replacement's close from settling them.
 */
export const HUB_LIVENESS_INTERVAL_MS = 30_000;
/**
 * Frames a single socket may have queued behind the per-user chain before
 * its reads are paused. Bounds heap when a client outpaces storage; TCP
 * backpressure holds the rest on the wire.
 */
export const MAX_INFLIGHT_FRAMES_PER_SOCKET = 64;

/** Close code for an unexpected failure inside a handler. */
const CLOSE_INTERNAL_ERROR = 1011;
/** Close code for a host shutting down. */
const CLOSE_GOING_AWAY = 1001;

const STATUS_TEXT: Record<number, string> = {
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

class SocketConnection implements HubConnection {
  readonly connectionId = randomUUID();
  spaceIds: string[] = [];
  /** Cleared before each ping, set again by the pong; two misses = dead. */
  alive = true;

  constructor(
    private readonly ws: WebSocket,
    readonly deviceId: string,
    readonly kind: DeviceKind,
  ) {
    ws.on("pong", () => {
      this.alive = true;
    });
  }

  /** One liveness round: terminate a socket that never answered the last ping. */
  probe(): void {
    if (!this.alive) {
      this.ws.terminate();
      return;
    }
    this.alive = false;
    try {
      this.ws.ping();
    } catch {
      this.ws.terminate();
    }
  }

  send(msg: ServerMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // Socket already gone; presence catches up via the close handler.
    }
  }

  close(code: number, reason: string): void {
    try {
      this.ws.close(code, reason);
    } catch {
      // Socket already gone.
    }
  }
}

interface UserEntry {
  core: HubCore;
  sockets: Set<SocketConnection>;
  evictTimer: NodeJS.Timeout | null;
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function rejectUpgrade(socket: Duplex, status: number, error: string): void {
  const body = JSON.stringify({ error });
  const head =
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\n` +
    "Content-Type: application/json\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "Connection: close\r\n\r\n";
  try {
    socket.end(head + body);
  } catch {
    socket.destroy();
  }
}

function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export function attachSyncHub(
  server: HttpServer,
  opts: AttachSyncHubOptions,
): HubHost {
  const now = opts.now ?? ((): number => Date.now());
  // Bounded so a malformed or oversized frame is refused on its own rather
  // than after the process has buffered it; senders chunk below this.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const users = new Map<string, UserEntry>();
  const chains = new Map<string, Promise<void>>();
  let closed = false;

  /** Append `task` to the user's chain. Tasks run strictly in order, a
   * failed task never blocks the next, and the caller sees its own result. */
  const enqueue = <T>(userId: string, task: () => Promise<T>): Promise<T> => {
    const previous = chains.get(userId) ?? Promise.resolve();
    const run = previous.then(task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(userId, settled);
    void settled.then(() => {
      if (chains.get(userId) === settled) chains.delete(userId);
    });
    return run;
  };

  const touch = (userId: string, entry: UserEntry): void => {
    if (entry.evictTimer !== null) {
      clearTimeout(entry.evictTimer);
      entry.evictTimer = null;
    }
    if (entry.sockets.size > 0 || closed) return;
    entry.evictTimer = setTimeout(() => {
      entry.evictTimer = null;
      if (users.get(userId) === entry && entry.sockets.size === 0)
        users.delete(userId);
    }, HUB_CORE_IDLE_EVICTION_MS);
    entry.evictTimer.unref();
  };

  /** Cached HubCore for the user, created on demand. Creation is
   * synchronous so a socket registers before any handler runs; the first
   * chained task clears bindings a crashed predecessor process left behind
   * (no socket of this user can be open anywhere else — single replica). */
  const entryFor = (userId: string): UserEntry => {
    const existing = users.get(userId);
    if (existing !== undefined) return existing;
    const core = new HubCore(opts.storageFor(userId), now);
    const entry: UserEntry = { core, sockets: new Set(), evictTimer: null };
    users.set(userId, entry);
    void enqueue(userId, () => core.resetConnections()).catch(() => {
      // Storage unavailable; the handlers that follow report their own
      // failures by closing their sockets.
    });
    return entry;
  };

  const peersOf = (
    entry: UserEntry,
    self: SocketConnection,
  ): SocketConnection[] => {
    const peers: SocketConnection[] = [];
    for (const socket of entry.sockets) if (socket !== self) peers.push(socket);
    return peers;
  };

  const attach = (
    ws: WebSocket,
    userId: string,
    deviceId: string,
    kind: DeviceKind,
  ): void => {
    const entry = entryFor(userId);
    const conn = new SocketConnection(ws, deviceId, kind);
    entry.sockets.add(conn);
    touch(userId, entry);
    let inFlight = 0;
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        conn.send({
          t: "error",
          code: "malformed",
          message: "binary frames unsupported",
        });
        return;
      }
      const text = rawToString(data);
      inFlight += 1;
      if (inFlight >= MAX_INFLIGHT_FRAMES_PER_SOCKET && !ws.isPaused) ws.pause();
      void enqueue(userId, () =>
        entry.core.handleMessage(conn, text, peersOf(entry, conn)),
      )
        .catch(() => conn.close(CLOSE_INTERNAL_ERROR, "internal error"))
        .finally(() => {
          inFlight -= 1;
          if (ws.isPaused && inFlight < MAX_INFLIGHT_FRAMES_PER_SOCKET / 2) ws.resume();
        });
    });
    ws.on("error", () => {
      // 'close' follows every error; presence and leases settle there.
    });
    ws.on("close", () => {
      entry.sockets.delete(conn);
      void enqueue(userId, () =>
        entry.core.handleClose(conn, peersOf(entry, conn)),
      )
        .catch(() => undefined)
        .finally(() => touch(userId, entry));
    });
  };

  const handleUpgrade = async (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://hub.invalid");
    const queryToken = url.searchParams.get("access_token");
    if (queryToken !== null) {
      // Strip the credential before the request travels any further
      // (request logs, error reports, later upgrade listeners).
      url.searchParams.delete("access_token");
      req.url = `${url.pathname}${url.search}`;
    }
    if (url.pathname !== opts.path) {
      rejectUpgrade(socket, 404, "not_found");
      return;
    }
    if (closed) {
      rejectUpgrade(socket, 503, "shutting_down");
      return;
    }
    const token =
      bearerToken(headerValue(req.headers.authorization)) ?? queryToken;
    if (token === null) {
      rejectUpgrade(socket, 401, "unauthorized");
      return;
    }
    let verified: VerifiedHubToken | null;
    try {
      verified = await opts.verifyToken(token);
    } catch {
      rejectUpgrade(socket, 500, "verify_failed");
      return;
    }
    if (socket.destroyed) return;
    if (verified === null) {
      rejectUpgrade(socket, 401, "unauthorized");
      return;
    }
    if (verified.deviceId === null) {
      rejectUpgrade(socket, 403, "device_required");
      return;
    }
    const { userId, revoked } = verified;
    const deviceId = verified.deviceId;
    const kind: DeviceKind = verified.platform === "cloud" ? "cloud" : "desktop";
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (revoked) {
        // Accept-then-close so the client sees the 4003 close code and
        // stops reconnecting; the socket never touches HubCore.
        ws.close(CLOSE_REVOKED, "revoked");
        return;
      }
      if (closed) {
        ws.close(CLOSE_GOING_AWAY, "shutting down");
        return;
      }
      attach(ws, userId, deviceId, kind);
    });
  };

  const onUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    // Nothing else listens on the raw socket until `wss.handleUpgrade`, which
    // runs after token verification; an ECONNRESET (or an EPIPE after a
    // rejection's `end`) in that window would otherwise be an uncaught
    // 'error' event and take the whole control process down.
    socket.on("error", () => socket.destroy());
    handleUpgrade(req, socket, head).catch(() => {
      socket.destroy();
    });
  };
  server.on("upgrade", onUpgrade);
  const liveness = setInterval(() => {
    for (const entry of users.values()) for (const conn of entry.sockets) conn.probe();
  }, opts.livenessIntervalMs ?? HUB_LIVENESS_INTERVAL_MS);
  liveness.unref();

  return {
    revokeDevice(userId, deviceId) {
      const entry = entryFor(userId);
      return enqueue(userId, async () => {
        const toClose = await entry.core.revokeDevice(deviceId, [
          ...entry.sockets,
        ]);
        for (const conn of toClose) conn.close(CLOSE_REVOKED, "revoked");
      }).finally(() => touch(userId, entry));
    },

    broadcast(userId, frame) {
      return enqueue(userId, () => {
        const entry = users.get(userId);
        if (entry !== undefined) {
          for (const conn of entry.sockets) conn.send(frame);
        }
        return Promise.resolve();
      });
    },

    releaseLeases(userId, filter) {
      const entry = entryFor(userId);
      const { deviceId, ...leaseFilter } = filter;
      return enqueue(userId, () =>
        entry.core.releaseLeases(deviceId, leaseFilter, [...entry.sockets]),
      ).finally(() => touch(userId, entry));
    },

    async gc(nowMs = now(), userIds) {
      const ids =
        userIds === undefined ? [...users.keys()] : [...new Set(userIds)];
      for (const userId of ids) {
        const entry = entryFor(userId);
        await enqueue(userId, () =>
          entry.core.gc(nowMs, [...entry.sockets]),
        ).finally(() => touch(userId, entry));
      }
    },

    async close() {
      clearInterval(liveness);
      if (closed) return;
      closed = true;
      server.off("upgrade", onUpgrade);
      for (const entry of users.values()) {
        if (entry.evictTimer !== null) {
          clearTimeout(entry.evictTimer);
          entry.evictTimer = null;
        }
        for (const conn of entry.sockets)
          conn.close(CLOSE_GOING_AWAY, "shutting down");
      }
      // Close handlers enqueue as sockets finish closing; wait for every
      // chain to settle, including ones appended while we waited.
      let pending = [...chains.values()];
      while (pending.length > 0) {
        await Promise.all(pending);
        pending = [...chains.values()].filter((chain) => !pending.includes(chain));
      }
      users.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
