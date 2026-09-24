/**
 * Transports for the space sync engine (PRD §8.3, cloud-sync-design §3).
 *
 * LoopbackTransport — in-process stub hub over an in-memory record store, so
 * the engine pipeline (seal → sign → publish → lease → hydrate) runs
 * end-to-end with no network.
 *
 * WsTransport — hub client (`@pistachio/sync-hub` over the control-plane
 * `ws` server): connect/backoff, frame parsing, workspace-doc frames, and
 * device-token auth on the upgrade request. No Node types: timers go through
 * `globalThis` so the same file serves the desktop main process and the cloud
 * browser.
 */

import {
  chunkFrames,
  compareHlc,
  cookieRecordBytes,
  MAX_DECLARED_SPACES,
  MAX_FRAME_BYTES,
  parseServerMessage,
  workspaceRecordBytes,
  type ClientMessage,
  type CookieRecordWire,
  type DeviceKind,
  type DevicePresence,
  type PublishRejection,
  type WorkspaceRecordWire,
} from "@pistachio/sync-protocol";
import type {
  LeaseAcquireOptions,
  LeaseOutcome,
  SyncTransport,
} from "./types.js";

/** Records per outbound publish frame. Frames are also capped by
 * `FRAME_BUDGET_BYTES` inside `chunkFrames`, which is what keeps a reconcile
 * that republishes a library of artifacts under the hub's `maxPayload`. */
const PUBLISH_CHUNK_SIZE = 256;

/** `off` is terminal: the hub closed the socket with 4003 (device revoked). */
export type TransportState = "connecting" | "connected" | "offline" | "off";

export interface TransportEvents {
  onStateChanged?: (state: TransportState) => void;
  onRecords?: (spaceId: string, records: CookieRecordWire[]) => void;
  /** Hydration finished for a space (empty hydration included). */
  onHydrated?: (spaceId: string) => void;
  /** The hub acknowledged our state (publish ack / hydrate done). */
  onConverged?: () => void;
  /** Records the hub STORED (`publish.ack.accepted`), in the order they were
   * published. The engine drops them from its in-flight window and confirms
   * their published mark, so a later rejection cannot retract a version the
   * hub actually kept. */
  onPublishAccepted?: (recordIds: readonly string[]) => void;
  /** Records the hub refused after an optimistic fire-and-forget publish. */
  onPublishRejected?: (rejections: readonly PublishRejection[]) => void;
  /** The socket disappeared before these records were acknowledged. The
   * engine must put their current winners back in its offline queue. */
  onPublishInterrupted?: (recordIds: readonly string[]) => void;
  onPresence?: (devices: DevicePresence[]) => void;
  /** A forced rotating-auth handoff moved the writer lease to another device. */
  onLeaseRevoked?: (spaceId: string, originId: string) => void;
  /** The holder released this origin (explicitly, by disconnecting, or by
   * being revoked); deferred writes for it may drain. */
  onLeaseReleased?: (spaceId: string, originId: string) => void;
  /** The hub closed the socket with 4003: this device was revoked. The
   * transport is `off` and will not reconnect until `start()` is called. */
  onRevoked?: () => void;
  /** A record this device cannot publish because one frame will not hold
   * it. It stays in the local store; nothing retries it as-is. */
  onPublishWithheld?: (what: string, bytes: number) => void;
  /** Workspace metadata docs from the hub (fan-out or hydration, §8.3). */
  onWorkspaceRecords?: (docs: WorkspaceRecordWire[]) => void;
  /** Workspace hydration finished — safe to reconcile-publish local docs. */
  onWorkspaceHydrated?: () => void;
  /**
   * Control-plane device token for the hub edge (§8.2); resolve null while
   * unenrolled. Fetched fresh on every dial so refreshed tokens are picked up.
   */
  getToken?: () => Promise<string | null>;
  /**
   * True once this device is ENROLLED (§8.2). Enrolled + null token means the
   * token was revoked/expired, not that we are in local/dev mode — the
   * transport must NOT dial the prod hub tokenless (and loop) in that case.
   */
  authRequired?: () => boolean;
}

/** Outcome of the pre-dial auth check (pure — unit-tested directly). */
export type DialDecision = "dial" | "dial-tokenless" | "await-auth";

/**
 * Decide how to dial given the freshly fetched token and whether auth is
 * required (device enrolled). A present token always dials authenticated;
 * a null token dials tokenless ONLY when auth is not required (local/dev hub).
 * Enrolled + null token yields "await-auth": stay offline, no reconnect storm.
 */
export function decideDial(
  token: string | null,
  authRequired: boolean,
): DialDecision {
  if (token !== null && token.length > 0) return "dial";
  return authRequired ? "await-auth" : "dial-tokenless";
}

export interface HubTransport extends SyncTransport {
  readonly state: TransportState;
  start(spaceIds: string[]): void;
  /** Declare one more space (delegates to `updateSpaces`; no reconnect). */
  addSpace(spaceId: string): void;
  /**
   * Replace the declared space set. Sends `spaces.update`, waits for the ack,
   * then hydrates every newly declared space. Resolves immediately while not
   * connected: the next hello declares the new set.
   */
  updateSpaces(spaceIds: string[]): Promise<void>;
  stop(): void;
  /** Cleanly tear down and re-dial — token changes. */
  reconnect(): void;
  presence(): DevicePresence[];
  /** Resolve only after the hub has acknowledged every cookie publish sent so
   * far. False means the socket disappeared, an ack timed out, or a record was
   * rejected and has not yet been successfully retried. */
  flushCookiePublishes(): Promise<boolean>;
  publishWorkspace(docs: WorkspaceRecordWire[]): void;
}

/** Hub close code for a revoked device (§4). */
export const CLOSE_REVOKED = 4003;

/* ---------------------------------------------------------------------- *
 * Loopback
 * ---------------------------------------------------------------------- */

interface LoopbackLease {
  holderDeviceId: string;
  exclusive: boolean;
}

export class LoopbackTransport implements HubTransport {
  state: TransportState = "connecting";
  private readonly records = new Map<string, CookieRecordWire>();
  private readonly workspaceDocs = new Map<string, WorkspaceRecordWire>();
  private readonly leases = new Map<string, LoopbackLease>();
  private readonly spaceIds: string[] = [];

  constructor(
    private readonly deviceId: string,
    private readonly kind: DeviceKind = "desktop",
    private readonly events: TransportEvents = {},
  ) {}

  start(spaceIds: string[]): void {
    for (const spaceId of spaceIds) {
      if (!this.spaceIds.includes(spaceId)) this.spaceIds.push(spaceId);
    }
    this.setState("connected");
    for (const spaceId of this.spaceIds) this.events.onHydrated?.(spaceId);
    this.events.onWorkspaceHydrated?.();
    this.events.onConverged?.();
  }

  addSpace(spaceId: string): void {
    void this.updateSpaces([...this.spaceIds, spaceId]);
  }

  updateSpaces(spaceIds: string[]): Promise<void> {
    const added: string[] = [];
    for (const spaceId of spaceIds) {
      if (this.spaceIds.includes(spaceId)) continue;
      this.spaceIds.push(spaceId);
      added.push(spaceId);
    }
    if (this.state === "connected") {
      for (const spaceId of added) this.events.onHydrated?.(spaceId);
    }
    return Promise.resolve();
  }

  stop(): void {
    this.setState("offline");
  }

  reconnect(): void {
    // In-process — there is no connection to re-establish.
  }

  publish(records: CookieRecordWire[]): void {
    for (const record of records) {
      const current = this.records.get(record.recordId);
      if (current === undefined || compareHlc(record.hlc, current.hlc) > 0) {
        this.records.set(record.recordId, record);
      }
    }
    this.events.onConverged?.();
  }

  publishWorkspace(docs: WorkspaceRecordWire[]): void {
    for (const doc of docs) {
      const current = this.workspaceDocs.get(doc.key);
      if (current === undefined || compareHlc(doc.hlc, current.hlc) > 0) {
        this.workspaceDocs.set(doc.key, doc);
      }
    }
    this.events.onConverged?.();
  }

  async flushCookiePublishes(): Promise<boolean> {
    return true;
  }

  async acquireLease(
    spaceId: string,
    originId: string,
    opts?: LeaseAcquireOptions,
  ): Promise<LeaseOutcome> {
    const key = `${spaceId}:${originId}`;
    const holder = this.leases.get(key);
    if (
      holder !== undefined &&
      holder.holderDeviceId !== this.deviceId &&
      opts?.force !== true
    ) {
      return {
        granted: false,
        denied: {
          holderDeviceId: holder.holderDeviceId,
          holderKind: this.kind,
          exclusive: holder.exclusive,
        },
      };
    }
    const exclusive = opts?.exclusive === true && this.kind === "cloud";
    this.leases.set(key, { holderDeviceId: this.deviceId, exclusive });
    return { granted: true, exclusive };
  }

  releaseLease(spaceId: string, originId: string): void {
    const key = `${spaceId}:${originId}`;
    if (this.leases.get(key)?.holderDeviceId === this.deviceId) {
      this.leases.delete(key);
      this.events.onLeaseReleased?.(spaceId, originId);
    }
  }

  presence(): DevicePresence[] {
    return [
      {
        deviceId: this.deviceId,
        kind: this.kind,
        online: this.state === "connected",
        lastSeenMs: Date.now(),
      },
    ];
  }

  private setState(state: TransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChanged?.(state);
  }
}

/* ---------------------------------------------------------------------- *
 * WebSocket client (hub)
 * ---------------------------------------------------------------------- */

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: string,
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void;
}

type WsCtor = new (url: string) => WsLike;

/** Whatever `globalThis.setTimeout` hands back on this runtime. */
type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

/** Never keep a process alive for a sync timer (Node); no-op elsewhere. */
function unref(timer: TimerHandle): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

const WS_OPEN = 1;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const LEASE_TIMEOUT_MS = 5_000;
const PUBLISH_ACK_TIMEOUT_MS = 10_000;
const SPACES_UPDATE_TIMEOUT_MS = 10_000;
/** Enrolled-but-tokenless: re-check for a token slowly, never a reconnect storm. */
const AUTH_WAIT_RETRY_MS = MAX_BACKOFF_MS;

const OFFLINE_OUTCOME: LeaseOutcome = { granted: false, reason: "offline" };
const TIMEOUT_OUTCOME: LeaseOutcome = { granted: false, reason: "timeout" };

interface PendingLease {
  promise: Promise<LeaseOutcome>;
  resolve: (outcome: LeaseOutcome) => void;
}

interface SpacesUpdateRequest {
  spaceIds: string[];
  resolve: () => void;
}

interface PendingSpacesUpdate extends SpacesUpdateRequest {
  added: string[];
  timer: TimerHandle;
}

export class WsTransport implements HubTransport {
  state: TransportState = "offline";
  private socket: WsLike | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private spaceIds: string[] = [];
  /** Spaces the current socket's hello declared (hub-side view). */
  private declaredSpaceIds: string[] = [];
  /** How many spaces one connection may declare. Starts at the protocol cap
   * and shrinks only if a hub refuses a `hello` anyway (older/stricter hub). */
  private declaredLimit = MAX_DECLARED_SPACES;
  private warnedTooManySpaces = false;
  private workspaceHydrateSent = false;
  private stopped = false;
  private connectSeq = 0;
  private reconnectTimer: TimerHandle | null = null;
  private readonly pendingLeases = new Map<string, PendingLease>();
  private pendingSpacesUpdate: PendingSpacesUpdate | null = null;
  private readonly spacesUpdateQueue: SpacesUpdateRequest[] = [];
  /** Per recordId: wires handed to the socket whose ack is still out. Two
   * rapid writes to one cookie put two wires in flight and the hub answers
   * each of them, so the navigation fence may only open once EVERY wire for
   * the record is acked — a Set's second `add` silently lost the second one. */
  private readonly pendingCookiePublishes = new Map<string, number>();
  private readonly rejectedCookiePublishes = new Set<string>();
  private readonly cookieFlushWaiters = new Set<{
    resolve: (confirmed: boolean) => void;
    timer: TimerHandle;
  }>();
  private readonly presenceCache = new Map<string, DevicePresence>();

  constructor(
    private readonly url: string,
    private readonly deviceId: string,
    private readonly kind: DeviceKind,
    private readonly events: TransportEvents = {},
  ) {}

  start(spaceIds: string[]): void {
    this.spaceIds = [...new Set(spaceIds)];
    this.stopped = false;
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.connect();
  }

  addSpace(spaceId: string): void {
    if (this.spaceIds.includes(spaceId)) return;
    void this.updateSpaces([...this.spaceIds, spaceId]);
  }

  updateSpaces(spaceIds: string[]): Promise<void> {
    const next = [...new Set(spaceIds)];
    this.spaceIds = next;
    if (this.state !== "connected") return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.spacesUpdateQueue.push({ spaceIds: next, resolve });
      this.pumpSpacesUpdates();
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      globalThis.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPending();
    this.socket?.close();
    this.socket = null;
    this.setState("offline");
  }

  /** Cleanly tear down and re-dial — the token or space set changed (§8.2). */
  reconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer !== null) {
      globalThis.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null; // the old socket's close event must not double-dial
    const interrupted = this.failPending();
    this.setState("offline");
    if (interrupted.length > 0) this.events.onPublishInterrupted?.(interrupted);
    socket?.close();
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.connect();
  }

  publish(records: CookieRecordWire[]): void {
    // When disconnected the engine is offline (setOnline(false)) and queues
    // locally; anything racing the transition is dropped here, not lost —
    // the record is already in the engine's store.
    if (this.state !== "connected") return;
    // Chunk FIRST: `chunkFrames` withholds a record too big for one frame,
    // and a withheld record is never acked. Counting it as pending would hold
    // the causal navigation fence closed for ever, and the interrupted list a
    // lost socket produces would push it back through the offline queue to be
    // withheld again on every reconnect. Only what reaches the socket counts.
    const frames = chunkFrames(
      records,
      cookieRecordBytes,
      PUBLISH_CHUNK_SIZE,
      (record, bytes) => this.dropOversized(`record ${record.recordId}`, bytes),
    );
    for (const frame of frames) {
      for (const record of frame) {
        const pending = this.pendingCookiePublishes.get(record.recordId) ?? 0;
        this.pendingCookiePublishes.set(record.recordId, pending + 1);
        // A retry supersedes the failure from the previous attempt. The next
        // ack decides whether the causal navigation fence may open.
        this.rejectedCookiePublishes.delete(record.recordId);
      }
      this.send({ t: "publish", records: frame });
    }
  }

  /** One wire for this record was acked (accepted or rejected). */
  private ackedOneWire(recordId: string): void {
    const pending = this.pendingCookiePublishes.get(recordId);
    if (pending === undefined) return;
    if (pending <= 1) this.pendingCookiePublishes.delete(recordId);
    else this.pendingCookiePublishes.set(recordId, pending - 1);
  }

  async flushCookiePublishes(): Promise<boolean> {
    if (this.state !== "connected") return false;
    if (this.pendingCookiePublishes.size === 0) {
      return this.rejectedCookiePublishes.size === 0;
    }
    return new Promise<boolean>((resolve) => {
      const waiter = {
        resolve,
        timer: globalThis.setTimeout(() => {
          this.cookieFlushWaiters.delete(waiter);
          resolve(false);
        }, PUBLISH_ACK_TIMEOUT_MS),
      };
      unref(waiter.timer);
      this.cookieFlushWaiters.add(waiter);
    });
  }

  publishWorkspace(docs: WorkspaceRecordWire[]): void {
    // Offline drops are safe: the local LWW registers are the durable state,
    // and every (re)connection reconciles by republishing after hydration.
    if (this.state !== "connected" || docs.length === 0) return;
    for (const frame of chunkFrames(
      docs,
      workspaceRecordBytes,
      PUBLISH_CHUNK_SIZE,
      (doc, bytes) => this.dropOversized(`workspace doc ${doc.key}`, bytes),
    ))
      this.send({ t: "workspace.publish", docs: frame });
  }

  /**
   * A record too big for one frame is withheld rather than sent: the hub's
   * `maxPayload` would close this socket with 1009 and the reconnect would
   * publish it again, so sending it costs the whole lane forever while
   * withholding it costs only this record. The local store keeps it, so a
   * later smaller version of the same register still syncs.
   */
  private dropOversized(what: string, bytes: number): void {
    console.warn(
      `[sync] ${what} is ${String(bytes)} bytes, over the ${String(MAX_FRAME_BYTES)}-byte frame cap; not published`,
    );
    this.events.onPublishWithheld?.(what, bytes);
  }

  async acquireLease(
    spaceId: string,
    originId: string,
    opts?: LeaseAcquireOptions,
  ): Promise<LeaseOutcome> {
    if (this.state !== "connected") return OFFLINE_OUTCOME;
    const key = `${spaceId}:${originId}`;
    const existing = this.pendingLeases.get(key);
    if (existing !== undefined) return existing.promise;
    let settle: (outcome: LeaseOutcome) => void = () => undefined;
    const promise = new Promise<LeaseOutcome>((resolve) => {
      const timer = globalThis.setTimeout(() => {
        settle(TIMEOUT_OUTCOME);
      }, LEASE_TIMEOUT_MS);
      unref(timer);
      settle = (outcome) => {
        globalThis.clearTimeout(timer);
        if (this.pendingLeases.get(key)?.promise === promise)
          this.pendingLeases.delete(key);
        resolve(outcome);
      };
    });
    this.pendingLeases.set(key, {
      promise,
      resolve: (outcome) => settle(outcome),
    });
    const frame: ClientMessage = { t: "lease.acquire", spaceId, originId };
    if (opts?.force === true) {
      frame.force = true;
      if (opts.candidate !== undefined) {
        frame.recordId = opts.candidate.recordId;
        frame.candidateHlc = opts.candidate.hlc;
      }
    }
    if (opts?.exclusive !== undefined) frame.exclusive = opts.exclusive;
    if (opts?.ttlMs !== undefined) frame.ttlMs = opts.ttlMs;
    this.send(frame);
    return promise;
  }

  releaseLease(spaceId: string, originId: string): void {
    if (this.state !== "connected") return;
    this.send({ t: "lease.release", spaceId, originId });
  }

  presence(): DevicePresence[] {
    const merged = new Map<string, DevicePresence>(this.presenceCache);
    merged.set(this.deviceId, {
      deviceId: this.deviceId,
      kind: this.kind,
      online: this.state === "connected",
      lastSeenMs: Date.now(),
    });
    return [...merged.values()];
  }

  /**
   * Cap what a connection declares. The hub answers a `hello` (or
   * `spaces.update`) over `MAX_DECLARED_SPACES` with an `error` frame — no
   * ack, no close — and then answers every later frame `hello_required`, so
   * an uncapped client with 65+ Spaces would sit in `connecting` for ever.
   * Declaring the first `declaredLimit` keeps sync working for those Spaces
   * instead of losing it for all of them.
   */
  private capSpaces(spaceIds: readonly string[]): string[] {
    if (spaceIds.length <= this.declaredLimit) return [...spaceIds];
    if (!this.warnedTooManySpaces) {
      this.warnedTooManySpaces = true;
      console.warn(
        `[sync] declaring only ${String(this.declaredLimit)} of ${String(spaceIds.length)} Spaces to the hub; the rest do not sync on this connection`,
      );
    }
    return spaceIds.slice(0, this.declaredLimit);
  }

  private connect(): void {
    const Ws = (globalThis as Record<string, unknown>)["WebSocket"] as
      | WsCtor
      | undefined;
    if (Ws === undefined) {
      console.warn("no WebSocket implementation available; sync stays offline");
      this.setState("offline");
      return;
    }
    this.setState("connecting");
    const seq = ++this.connectSeq;
    void this.dial(Ws, seq);
  }

  private async dial(Ws: WsCtor, seq: number): Promise<void> {
    // Auth (§8.2): the control-plane device token rides as an `access_token`
    // query parameter on the upgrade URL — WebSocket clients cannot portably
    // set an Authorization header on the upgrade request, so the hub edge
    // reads the query parameter (and still accepts Authorization from
    // clients that can send it). Null token = unenrolled: the hub falls back
    // to trusting the hello frame's deviceId (dev mode).
    let token: string | null = null;
    try {
      token = (await this.events.getToken?.()) ?? null;
    } catch {
      token = null;
    }
    if (this.stopped || seq !== this.connectSeq) return;
    const decision = decideDial(token, this.events.authRequired?.() ?? false);
    if (decision === "await-auth") {
      // Enrolled but the token is revoked/expired: dialing the prod hub
      // tokenless would just loop. Go offline and wait; refreshAuth()/
      // reconnect() re-dials the instant a token is available, and a slow
      // timer re-checks in case one is minted without an explicit refresh.
      this.setState("offline");
      this.scheduleAuthRetry();
      return;
    }
    const url =
      decision === "dial-tokenless"
        ? this.url
        : `${this.url}${this.url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token as string)}`;
    const socket = new Ws(url);
    this.socket = socket;
    this.workspaceHydrateSent = false;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.declaredSpaceIds = this.capSpaces(this.spaceIds);
      this.send({
        t: "hello",
        deviceId: this.deviceId,
        kind: this.kind,
        spaceIds: [...this.declaredSpaceIds],
      });
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.handleFrame(String(event.data));
    });
    socket.addEventListener("close", (event) =>
      this.handleClose(socket, event.code),
    );
    socket.addEventListener("error", () => undefined); // close always follows
  }

  /** Enrolled + no token: re-check on a slow cadence instead of hammering. */
  private scheduleAuthRetry(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, AUTH_WAIT_RETRY_MS);
    unref(this.reconnectTimer);
  }

  private handleClose(socket: WsLike, code: number | undefined): void {
    if (code === CLOSE_REVOKED) this.handleRevoked(socket);
    else this.scheduleReconnect(socket);
  }

  /** 4003: the device was revoked. Terminal until `start()` is called again. */
  private handleRevoked(socket: WsLike): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      globalThis.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const interrupted = this.failPending();
    this.setState("off");
    if (interrupted.length > 0) this.events.onPublishInterrupted?.(interrupted);
    this.events.onRevoked?.();
  }

  /** A hub that refused our `hello` for declaring too many spaces. */
  private helloRefused(): void {
    const socket = this.socket;
    if (socket === null) return;
    this.declaredLimit = Math.max(
      1,
      Math.floor(Math.max(this.declaredSpaceIds.length, 2) / 2),
    );
    this.warnedTooManySpaces = false;
    console.warn(
      `[sync] hub refused a hello declaring ${String(this.declaredSpaceIds.length)} Spaces; re-dialing with ${String(this.declaredLimit)}`,
    );
    this.scheduleReconnect(socket); // clears this.socket, then backs off
    socket.close();
  }

  private scheduleReconnect(socket: WsLike): void {
    if (this.socket !== socket) return;
    this.socket = null;
    const interrupted = this.failPending();
    this.setState("offline");
    if (interrupted.length > 0) this.events.onPublishInterrupted?.(interrupted);
    if (this.stopped) return;
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
    unref(this.reconnectTimer);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private handleFrame(raw: string): void {
    let msg: ReturnType<typeof parseServerMessage>;
    try {
      msg = parseServerMessage(raw);
    } catch {
      return; // both sides validate; drop malformed frames
    }
    switch (msg.t) {
      case "hello.ack": {
        this.setState("connected");
        for (const device of msg.presence)
          this.presenceCache.set(device.deviceId, device);
        this.events.onPresence?.(this.presence());
        for (const spaceId of this.declaredSpaceIds) {
          this.send({ t: "hydrate", spaceId, sinceHlc: null });
        }
        this.send({ t: "workspace.hydrate", sinceHlc: null });
        this.workspaceHydrateSent = true;
        // Spaces added between the hello and its ack were never declared.
        if (
          this.capSpaces(this.spaceIds).some(
            (id) => !this.declaredSpaceIds.includes(id),
          )
        ) {
          this.spacesUpdateQueue.push({
            spaceIds: [...this.spaceIds],
            resolve: () => undefined,
          });
        }
        this.pumpSpacesUpdates();
        break;
      }
      case "records":
        this.events.onRecords?.(msg.spaceId, msg.records);
        break;
      case "hydrate.done":
        this.events.onHydrated?.(msg.spaceId);
        this.events.onConverged?.();
        break;
      case "publish.ack":
        for (const recordId of msg.accepted) {
          this.ackedOneWire(recordId);
          this.rejectedCookiePublishes.delete(recordId);
        }
        // Before the rejections of the same ack: the engine consumes its
        // in-flight window in publish order, and the hub answers every record
        // of a frame with exactly one accepted or rejected entry.
        if (msg.accepted.length > 0)
          this.events.onPublishAccepted?.(msg.accepted);
        for (const rejection of msg.rejected) {
          this.ackedOneWire(rejection.recordId);
          // `stale` means the hub already has this exact record or a newer
          // winner: a valid durability fence (and the expected ack when a
          // lost-ack reconnect republishes an already-stored record).
          // `exclusive_lease` hands the record to the engine's deferred
          // lane; it must not hold the causal session fence closed either.
          // Every other reason (`rate_limited`, and `unknown` from a hub
          // newer than this build) means the hub stored nothing, so it holds
          // the fence closed until the engine re-publishes the record.
          if (
            rejection.reason === "stale" ||
            rejection.reason === "exclusive_lease"
          )
            this.rejectedCookiePublishes.delete(rejection.recordId);
          else this.rejectedCookiePublishes.add(rejection.recordId);
        }
        if (msg.rejected.length > 0)
          this.events.onPublishRejected?.(msg.rejected);
        this.settleCookieFlushes();
        this.events.onConverged?.();
        break;
      case "lease.granted":
        this.resolveLease(msg.spaceId, msg.originId, {
          granted: true,
          exclusive: msg.exclusive,
        });
        break;
      case "lease.denied":
        this.resolveLease(msg.spaceId, msg.originId, {
          granted: false,
          denied: {
            holderDeviceId: msg.holderDeviceId,
            holderKind: msg.holderKind,
            exclusive: msg.exclusive,
          },
        });
        break;
      case "lease.revoked":
        this.events.onLeaseRevoked?.(msg.spaceId, msg.originId);
        break;
      case "lease.released":
        this.events.onLeaseReleased?.(msg.spaceId, msg.originId);
        break;
      case "spaces.update.ack":
        this.settleSpacesUpdate(msg.spaceIds);
        break;
      case "workspace.records":
        this.events.onWorkspaceRecords?.(msg.docs);
        break;
      case "workspace.hydrate.done":
        this.events.onWorkspaceHydrated?.();
        this.events.onConverged?.();
        break;
      case "presence":
        for (const device of msg.devices)
          this.presenceCache.set(device.deviceId, device);
        this.events.onPresence?.(this.presence());
        break;
      case "error":
        if (msg.code !== "too_many_spaces") break;
        // The hub kept the previous space set; nothing new to hydrate.
        if (this.state === "connected") this.settleSpacesUpdate(null);
        // Refused our `hello`: there is no `hello.ack` and no close, and the
        // hub answers every later frame `hello_required`, so without this the
        // transport would stay in `connecting` for ever. This hub's cap is
        // lower than ours — halve what we declare and re-dial on the normal
        // backoff (never a tight loop, and it terminates at one space).
        else this.helloRefused();
        break;
      default:
        break;
    }
  }

  /** Send the next queued `spaces.update` once the previous one settled. */
  private pumpSpacesUpdates(): void {
    if (this.pendingSpacesUpdate !== null || this.state !== "connected") return;
    const request = this.spacesUpdateQueue.shift();
    if (request === undefined) return;
    // The hub refuses an over-cap `spaces.update` the same way it refuses an
    // over-cap `hello`, and answers it with no ack at all.
    const spaceIds = this.capSpaces(request.spaceIds);
    const pending: PendingSpacesUpdate = {
      ...request,
      spaceIds,
      added: spaceIds.filter((id) => !this.declaredSpaceIds.includes(id)),
      timer: globalThis.setTimeout(() => {
        if (this.pendingSpacesUpdate !== pending) return;
        this.pendingSpacesUpdate = null;
        pending.resolve();
        this.pumpSpacesUpdates();
      }, SPACES_UPDATE_TIMEOUT_MS),
    };
    unref(pending.timer);
    this.pendingSpacesUpdate = pending;
    this.send({ t: "spaces.update", spaceIds });
  }

  /** `spaces.update.ack` (or a rejection, `acked === null`). */
  private settleSpacesUpdate(acked: string[] | null): void {
    const pending = this.pendingSpacesUpdate;
    if (pending === null) return;
    this.pendingSpacesUpdate = null;
    globalThis.clearTimeout(pending.timer);
    if (acked !== null) {
      this.declaredSpaceIds = [...acked];
      for (const spaceId of pending.added) {
        if (!acked.includes(spaceId)) continue;
        this.send({ t: "hydrate", spaceId, sinceHlc: null });
      }
      if (!this.workspaceHydrateSent) {
        this.send({ t: "workspace.hydrate", sinceHlc: null });
        this.workspaceHydrateSent = true;
      }
    }
    pending.resolve();
    this.pumpSpacesUpdates();
  }

  private resolveLease(
    spaceId: string,
    originId: string,
    outcome: LeaseOutcome,
  ): void {
    const key = `${spaceId}:${originId}`;
    this.pendingLeases.get(key)?.resolve(outcome);
  }

  private settleCookieFlushes(): void {
    if (this.pendingCookiePublishes.size > 0) return;
    const confirmed = this.rejectedCookiePublishes.size === 0;
    for (const waiter of this.cookieFlushWaiters) {
      globalThis.clearTimeout(waiter.timer);
      waiter.resolve(confirmed);
    }
    this.cookieFlushWaiters.clear();
  }

  /** Socket gone: settle every in-flight request. Returns the unacked publishes. */
  private failPending(): string[] {
    for (const pending of this.pendingLeases.values())
      pending.resolve(OFFLINE_OUTCOME);
    this.pendingLeases.clear();
    if (this.pendingSpacesUpdate !== null) {
      globalThis.clearTimeout(this.pendingSpacesUpdate.timer);
      this.pendingSpacesUpdate.resolve();
      this.pendingSpacesUpdate = null;
    }
    // Queued updates are moot: the next hello declares the current set.
    for (const request of this.spacesUpdateQueue.splice(0)) request.resolve();
    return this.failCookieFlushes();
  }

  private failCookieFlushes(): string[] {
    // One entry per record with ANY unacked wire: the engine's recovery is
    // per record (it re-queues that record's whole in-flight window).
    const interrupted = [...this.pendingCookiePublishes.keys()];
    this.pendingCookiePublishes.clear();
    this.rejectedCookiePublishes.clear();
    for (const waiter of this.cookieFlushWaiters) {
      globalThis.clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    this.cookieFlushWaiters.clear();
    return interrupted;
  }

  private send(msg: ClientMessage): void {
    if (this.socket !== null && this.socket.readyState === WS_OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  private setState(state: TransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChanged?.(state);
  }
}
