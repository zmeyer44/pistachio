/**
 * Hub decision logic (docs/cloud-sync-design.md §4), pure and host-free.
 *
 * HubCore only ever handles sealed records and pseudonymous ids: it reads
 * spaceId/recordId/originId/hlc for routing and ordering, and never opens
 * `sealedRecord`/`sealedValue` or verifies their contents — devices verify
 * signatures on receipt; the server echoes `deviceSig` through untouched.
 *
 * Identity is bound by the host: every `HubConnection` carries the
 * `deviceId` and `kind` taken from the verified device token before the
 * first frame is dispatched. The `hello` frame only confirms that binding
 * (`device_mismatch` otherwise); nothing in a frame can rebind a socket.
 */

import {
  EXCLUSIVE_LEASE_TTL_MS,
  MAX_CLOCK_DRIFT_MS,
  MAX_DECLARED_SPACES,
  MAX_LEASE_TTL_MS,
  MAX_FRAME_BYTES,
  MAX_MUTATIONS_PER_ORIGIN_PER_MINUTE,
  ORIGIN_LEASE_TTL_MS,
  TOMBSTONE_RETENTION_MS,
  chunkFrames,
  compareHlc,
  cookieRecordBytes,
  encodeHlc,
  parseClientMessage,
  sortByHlc,
  workspaceRecordBytes,
  type ClientMessage,
  type CookieRecordWire,
  type DeviceKind,
  type DevicePresence,
  type Hlc,
  type PublishRejection,
  type ServerMessage,
  type WorkspaceRecordWire,
} from "@pistachio/sync-protocol";

/** Records per hydration frame. Frames are also capped by
 * `FRAME_BUDGET_BYTES` — a lane carrying sealed artifact HTML reaches the
 * byte budget long before 256 docs. */
export const HYDRATE_CHUNK_SIZE = 256;
export const RATE_WINDOW_MS = 60_000;
/** Versions retained per (spaceId, recordId) so fresh devices can walk causal
 * chains (e.g. tombstone → rewrite → rewrite) during hydration. */
export const MAX_RECORD_HISTORY = 8;
/** Extra versions one `appendHistory` will list and prune in a single pass.
 * The steady state is one excess version per append; the slack lets a record
 * that fell behind (a lowered MAX_RECORD_HISTORY, an interrupted trim) catch
 * up without a round trip per version. */
export const HISTORY_PRUNE_BATCH = 16;
/** `rl:` windows whose newest timestamp is older than this are garbage. */
export const RATE_WINDOW_RETENTION_MS = 2 * 60_000;
/** `presence:` entries for devices unseen this long are garbage. */
export const PRESENCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** WS close code for a socket whose identity was never bound by the host. */
export const CLOSE_UNAUTHENTICATED = 4001;
/** WS close code for a revoked device (control-plane revocation). */
export const CLOSE_REVOKED = 4003;
/** WS close code for a protocol violation the hub will not tolerate on an
 * open socket (a `hello` that contradicts the bound identity). */
export const CLOSE_MALFORMED = 4400;

/** Minimal key-value surface HubCore needs. `list` returns keys in ascending
 * code-unit / byte order — `hist:` keys embed `encodeHlc`, so a prefix list
 * yields versions oldest-first. `limit` caps the rows a backend materialises:
 * history trimming runs once per accepted record and must never pull a
 * record's whole version set to discover it has one version too many. */
export interface HubStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options: {
    prefix: string;
    /** At most this many keys, taken from the ascending front. */
    limit?: number;
  }): Promise<Map<string, T>>;
}

/** One connected socket. `deviceId` and `kind` are bound by the host from
 * the verified token before any frame and never rebound; both are `null`
 * only on a connection no host has authenticated. */
export interface HubConnection {
  deviceId: string | null;
  kind: DeviceKind | null;
  /** Stable for one physical socket. */
  connectionId: string;
  spaceIds: string[];
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

/** Selects which of a device's leases `releaseLeases` drops. */
export interface LeaseFilter {
  spaceId?: string;
  originIds?: readonly string[];
}

interface PresenceEntry {
  deviceId: string;
  kind: DeviceKind;
  lastSeenMs: number;
}

interface LeaseEntry {
  spaceId: string;
  originId: string;
  holderDeviceId: string;
  holderKind: DeviceKind;
  exclusive: boolean;
  expiresAtMs: number;
}

const recKey = (spaceId: string, recordId: string): string =>
  `rec:${spaceId}:${recordId}`;
/** encodeHlc sorts lexicographically in HLC order, so a prefix list over
 * `hist:<spaceId>:<recordId>:` yields versions oldest-first. */
const histKey = (spaceId: string, recordId: string, hlc: Hlc): string =>
  `hist:${spaceId}:${recordId}:${encodeHlc(hlc)}`;
const histPrefix = (spaceId: string, recordId: string): string =>
  `hist:${spaceId}:${recordId}:`;
const wmKey = (spaceId: string): string => `wm:${spaceId}`;
const LEASE_PREFIX = "lease:";
const leasePrefix = (spaceId: string): string => `${LEASE_PREFIX}${spaceId}:`;
const leaseKey = (spaceId: string, originId: string): string =>
  `${leasePrefix(spaceId)}${originId}`;
const workspaceKey = (key: string): string => `ws:${key}`;
const PRESENCE_PREFIX = "presence:";
const presenceKey = (deviceId: string): string =>
  `${PRESENCE_PREFIX}${deviceId}`;
const RATE_PREFIX = "rl:";
const rateKey = (deviceId: string, originId: string): string =>
  `${RATE_PREFIX}${deviceId}:${originId}`;
/** Declared spaces are owned by a physical socket, not merely a device. A
 * reconnect briefly has two sockets with the same device id; per-connection
 * keys prevent the stale socket's close handler from deleting its
 * replacement. The key doubles as the "hello has happened" marker. */
const CONN_PREFIX = "conn:";
const connPrefix = (deviceId: string): string => `${CONN_PREFIX}${deviceId}:`;
export const connectionStorageKey = (
  deviceId: string,
  connectionId: string,
): string => `${connPrefix(deviceId)}${connectionId}`;
/** Durable revocation set — a revoked device stays out even though its
 * short-lived token may still verify (tokens cannot be un-signed). */
const revokedKey = (deviceId: string): string => `revoked:${deviceId}`;

/** Workspace keys a device may only write for itself (§4 ownership). */
const DEVICE_OWNED_WORKSPACE_PREFIXES = [
  "device-workspace:",
  "device-activity:",
] as const;

/** The raw device id a device-scoped workspace key names, or null for a
 * global key. Compared by string equality on the raw id (D24). */
function workspaceKeyOwner(key: string): string | null {
  for (const prefix of DEVICE_OWNED_WORKSPACE_PREFIXES) {
    if (key.startsWith(prefix)) return key.slice(prefix.length);
  }
  return null;
}

interface BoundIdentity {
  deviceId: string;
  kind: DeviceKind;
}

function boundIdentity(conn: HubConnection): BoundIdentity | null {
  if (conn.deviceId === null || conn.kind === null) return null;
  return { deviceId: conn.deviceId, kind: conn.kind };
}

type Msg<T extends ClientMessage["t"]> = Extract<ClientMessage, { t: T }>;

/**
 * The ceiling the hub will store. A client clamps a peer's timestamp to
 * exactly `wall + MAX_CLOCK_DRIFT_MS` (`HlcClock.receive`), so a device that
 * has merged from a fast peer legitimately sits AT that ceiling. Rejecting at
 * the same bound would refuse its every write the moment the hub's own clock
 * ran a millisecond behind. Doubling it still bounds how far a runaway clock
 * can poison LWW ordering, while leaving a full drift window of slack between
 * the two clocks.
 */
const MAX_ACCEPTED_DRIFT_MS = 2 * MAX_CLOCK_DRIFT_MS;

export class HubCore {
  constructor(
    private readonly storage: HubStorage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async handleMessage(
    sender: HubConnection,
    raw: string,
    others: readonly HubConnection[],
  ): Promise<void> {
    const identity = boundIdentity(sender);
    if (identity === null) {
      // No host bound a verified identity to this socket: nothing it says
      // can be trusted, hello included.
      sender.close(CLOSE_UNAUTHENTICATED, "unauthenticated");
      return;
    }
    const { deviceId, kind } = identity;
    let msg: ClientMessage;
    try {
      msg = parseClientMessage(raw);
    } catch {
      sender.send({
        t: "error",
        code: "malformed",
        message: "frame failed validation",
      });
      return;
    }
    if (msg.t === "hello") {
      await this.handleHello(sender, identity, msg, others);
      return;
    }
    // Re-check revocation on every frame, not just at hello: if the admin
    // close raced an already-open socket (or was missed), the device's next
    // frame still terminates the session — bounding a revoked device's sync
    // to its next message rather than the socket's lifetime.
    if (await this.isRevoked(deviceId)) {
      sender.close(CLOSE_REVOKED, "revoked");
      return;
    }
    // The declared space set lives in storage under a per-connection key
    // written by hello; its absence means hello has not happened yet.
    const declared = await this.declaredSpaces(deviceId, sender.connectionId);
    if (declared === undefined) {
      sender.send({
        t: "error",
        code: "hello_required",
        message: "send hello before other frames",
      });
      return;
    }
    sender.spaceIds = declared;
    switch (msg.t) {
      case "publish":
        return this.handlePublish(sender, deviceId, msg, others);
      case "hydrate":
        return this.handleHydrate(sender, msg);
      case "lease.acquire":
        return this.handleLeaseAcquire(sender, deviceId, kind, msg, others);
      case "lease.release":
        return this.handleLeaseRelease(sender, deviceId, msg, others);
      case "rollback":
        return this.handleRollback(sender, msg, others);
      case "workspace.publish":
        return this.handleWorkspacePublish(sender, deviceId, msg, others);
      case "workspace.hydrate":
        return this.handleWorkspaceHydrate(sender, msg);
      case "spaces.update":
        return this.handleSpacesUpdate(sender, deviceId, msg);
      case "ping":
        sender.send({ t: "pong" });
        return;
    }
  }

  async handleClose(
    conn: HubConnection,
    others: readonly HubConnection[],
  ): Promise<void> {
    const identity = boundIdentity(conn);
    if (identity === null) return;
    const { deviceId, kind } = identity;
    await this.storage.delete(
      connectionStorageKey(deviceId, conn.connectionId),
    );
    // A reconnect opens the replacement socket before the stale one closes:
    // while any other connection for this device is open, closing this one
    // must neither release leases, broadcast offline, nor drop the stored
    // space set.
    if (others.some((peer) => peer.deviceId === deviceId)) return;
    // The close callback's peer snapshot can predate a replacement hello.
    // Check durable per-connection bindings too; this is the race that
    // previously let an old close mark a live replacement offline.
    if ((await this.connectionBindings(deviceId)).size > 0) return;
    // A closed device cannot remain the rotating-auth writer. Releasing its
    // leases immediately avoids making another device wait for the TTL
    // merely because the process or network disappeared before sending
    // release. This precedes the revocation early return (§4): a revoked
    // socket's leases must not outlive it either.
    await this.releaseLeases(deviceId, {}, others);
    // revokeDevice already cleared this device's state and broadcast offline;
    // the close of the socket it revoked must not resurrect presence.
    if (await this.isRevoked(deviceId)) return;
    const nowMs = this.now();
    await this.storage.put<PresenceEntry>(presenceKey(deviceId), {
      deviceId,
      kind,
      lastSeenMs: nowMs,
    });
    const update: DevicePresence = {
      deviceId,
      kind,
      online: false,
      lastSeenMs: nowMs,
    };
    for (const peer of others) peer.send({ t: "presence", devices: [update] });
  }

  /** Full-space snapshot streaming every retained version (up to
   * MAX_RECORD_HISTORY per record) in HLC-ascending order. */
  async hydrateSpace(
    spaceId: string,
    sinceHlc: Hlc | null,
  ): Promise<{ records: CookieRecordWire[]; watermark: Hlc | null }> {
    const versions = new Map<string, CookieRecordWire>();
    const consider = (record: CookieRecordWire): void => {
      if (record.spaceId !== spaceId) return;
      if (sinceHlc !== null && compareHlc(record.hlc, sinceHlc) <= 0) return;
      versions.set(`${record.recordId}@${encodeHlc(record.hlc)}`, record);
    };
    const history = await this.storage.list<CookieRecordWire>({
      prefix: `hist:${spaceId}:`,
    });
    for (const record of history.values()) consider(record);
    // The latest version is also in history; the map dedupes it. Records
    // stored before history existed still hydrate via this pass.
    const latest = await this.storage.list<CookieRecordWire>({
      prefix: `rec:${spaceId}:`,
    });
    for (const record of latest.values()) consider(record);
    const watermark = (await this.storage.get<Hlc>(wmKey(spaceId))) ?? null;
    return { records: sortByHlc([...versions.values()]), watermark };
  }

  private async connectionBindings(
    deviceId: string,
  ): Promise<Map<string, string[]>> {
    return this.storage.list<string[]>({ prefix: connPrefix(deviceId) });
  }

  private async declaredSpaces(
    deviceId: string,
    connectionId: string,
  ): Promise<string[] | undefined> {
    return this.storage.get<string[]>(
      connectionStorageKey(deviceId, connectionId),
    );
  }

  /**
   * Drop every per-connection binding of this user. A host calls this when it
   * knows no socket of the user is open in any process (single replica, D1)
   * — at process start the bindings written by a crashed predecessor would
   * otherwise keep `handleClose` from ever releasing leases or broadcasting
   * offline for those devices.
   */
  async resetConnections(): Promise<void> {
    const bindings = await this.storage.list({ prefix: CONN_PREFIX });
    for (const key of bindings.keys()) await this.storage.delete(key);
  }

  async isRevoked(deviceId: string): Promise<boolean> {
    return (await this.storage.get(revokedKey(deviceId))) !== undefined;
  }

  /**
   * Revoke a device (control-side): persist the revocation, clear the
   * device's presence/connection state, broadcast offline to everyone else,
   * release its leases (with `lease.released` fan-out), and return the
   * device's open connections for the host to close with CLOSE_REVOKED.
   * Touches no session data — sealed records stay untouched.
   */
  async revokeDevice<C extends HubConnection>(
    deviceId: string,
    connections: readonly C[],
  ): Promise<C[]> {
    await this.storage.put(revokedKey(deviceId), true);
    for (const key of (await this.connectionBindings(deviceId)).keys()) {
      await this.storage.delete(key);
    }
    const presence = await this.storage.get<PresenceEntry>(
      presenceKey(deviceId),
    );
    await this.storage.delete(presenceKey(deviceId));
    const kind: DeviceKind =
      presence?.kind ??
      connections.find((conn) => conn.deviceId === deviceId)?.kind ??
      "desktop";
    const update: DevicePresence = {
      deviceId,
      kind,
      online: false,
      lastSeenMs: this.now(),
    };
    for (const peer of connections) {
      if (peer.deviceId !== deviceId)
        peer.send({ t: "presence", devices: [update] });
    }
    await this.releaseLeases(deviceId, {}, connections);
    return connections.filter((conn) => conn.deviceId === deviceId);
  }

  /**
   * Delete every matching `lease:` entry held by `deviceId` and tell every
   * connection of the user (holder included) with `lease.released`, so
   * engines parked behind that lease retry without waiting for the TTL.
   */
  async releaseLeases(
    deviceId: string,
    filter: LeaseFilter,
    connections: readonly HubConnection[],
  ): Promise<void> {
    const prefix =
      filter.spaceId === undefined ? LEASE_PREFIX : leasePrefix(filter.spaceId);
    const leases = await this.storage.list<LeaseEntry>({ prefix });
    const wanted =
      filter.originIds === undefined ? null : new Set(filter.originIds);
    for (const [key, lease] of leases) {
      if (lease.holderDeviceId !== deviceId) continue;
      if (filter.spaceId !== undefined && lease.spaceId !== filter.spaceId)
        continue;
      if (wanted !== null && !wanted.has(lease.originId)) continue;
      await this.storage.delete(key);
      const released: ServerMessage = {
        t: "lease.released",
        spaceId: lease.spaceId,
        originId: lease.originId,
      };
      for (const peer of connections) peer.send(released);
    }
  }

  /**
   * Periodic storage hygiene (§4): prune `hist:` beyond the newest version
   * older than TOMBSTONE_RETENTION_MS (the tip and one retention-old floor
   * always survive), drop `rl:` windows idle for 2 min, and forget
   * `presence:` of devices unseen for 30 days. Devices with an open socket
   * in `connections` keep their presence regardless of lastSeen.
   */
  async gc(
    nowMs: number,
    connections: readonly HubConnection[] = [],
  ): Promise<void> {
    const historyCutoff = nowMs - TOMBSTONE_RETENTION_MS;
    const history = await this.storage.list<CookieRecordWire>({
      prefix: "hist:",
    });
    // Keys ascend in HLC order within a record, so each group's entries are
    // oldest-first and its retention-old versions form a leading run.
    const groups = new Map<string, { key: string; record: CookieRecordWire }[]>();
    for (const [key, record] of history) {
      const groupKey = histPrefix(record.spaceId, record.recordId);
      const group = groups.get(groupKey);
      if (group === undefined) groups.set(groupKey, [{ key, record }]);
      else group.push({ key, record });
    }
    for (const group of groups.values()) {
      const old = group.filter(
        ({ record }) => record.hlc.physicalMs < historyCutoff,
      );
      for (const { key } of old.slice(0, -1)) await this.storage.delete(key);
    }

    const rateCutoff = nowMs - RATE_WINDOW_RETENTION_MS;
    const windows = await this.storage.list<number[]>({ prefix: RATE_PREFIX });
    for (const [key, window] of windows) {
      const newest = window.reduce((max, at) => (at > max ? at : max), -Infinity);
      if (newest < rateCutoff) await this.storage.delete(key);
    }

    const online = new Set<string>();
    for (const conn of connections) {
      if (conn.deviceId !== null) online.add(conn.deviceId);
    }
    const presenceCutoff = nowMs - PRESENCE_RETENTION_MS;
    const entries = await this.storage.list<PresenceEntry>({
      prefix: PRESENCE_PREFIX,
    });
    for (const [key, entry] of entries) {
      if (online.has(entry.deviceId)) continue;
      if (entry.lastSeenMs < presenceCutoff) await this.storage.delete(key);
    }
  }

  private async handleHello(
    sender: HubConnection,
    identity: BoundIdentity,
    msg: Msg<"hello">,
    others: readonly HubConnection[],
  ): Promise<void> {
    const { deviceId, kind } = identity;
    if (await this.isRevoked(deviceId)) {
      sender.close(CLOSE_REVOKED, "revoked");
      return;
    }
    // The host bound identity from the token; the frame only confirms it. A
    // contradiction is a broken or hostile client, not a recoverable error.
    if (msg.deviceId !== deviceId || msg.kind !== kind) {
      sender.send({
        t: "error",
        code: "device_mismatch",
        message: "hello identity does not match the authenticated device",
      });
      sender.close(CLOSE_MALFORMED, "device_mismatch");
      return;
    }
    if (msg.spaceIds.length > MAX_DECLARED_SPACES) {
      sender.send({
        t: "error",
        code: "too_many_spaces",
        message: `declare at most ${MAX_DECLARED_SPACES} spaces`,
      });
      return;
    }
    sender.spaceIds = [...msg.spaceIds];
    await this.storage.put<string[]>(
      connectionStorageKey(deviceId, sender.connectionId),
      [...msg.spaceIds],
    );
    const nowMs = this.now();
    await this.storage.put<PresenceEntry>(presenceKey(deviceId), {
      deviceId,
      kind,
      lastSeenMs: nowMs,
    });
    const presence = await this.presenceSnapshot([sender, ...others]);
    sender.send({ t: "hello.ack", serverTimeMs: nowMs, presence });
    const self: DevicePresence = {
      deviceId,
      kind,
      online: true,
      lastSeenMs: nowMs,
    };
    for (const peer of others) peer.send({ t: "presence", devices: [self] });
  }

  private async presenceSnapshot(
    connected: readonly HubConnection[],
  ): Promise<DevicePresence[]> {
    const online = new Set<string>();
    for (const conn of connected) {
      if (conn.deviceId !== null) online.add(conn.deviceId);
    }
    const entries = await this.storage.list<PresenceEntry>({
      prefix: PRESENCE_PREFIX,
    });
    return [...entries.values()].map((entry) => ({
      deviceId: entry.deviceId,
      kind: entry.kind,
      online: online.has(entry.deviceId),
      lastSeenMs: entry.lastSeenMs,
    }));
  }

  private async handleSpacesUpdate(
    sender: HubConnection,
    deviceId: string,
    msg: Msg<"spaces.update">,
  ): Promise<void> {
    if (msg.spaceIds.length > MAX_DECLARED_SPACES) {
      // The previous declaration stays in force.
      sender.send({
        t: "error",
        code: "too_many_spaces",
        message: `declare at most ${MAX_DECLARED_SPACES} spaces`,
      });
      return;
    }
    const spaceIds = [...msg.spaceIds];
    sender.spaceIds = spaceIds;
    await this.storage.put<string[]>(
      connectionStorageKey(deviceId, sender.connectionId),
      [...spaceIds],
    );
    // The hub never auto-streams hydration; the client sends `hydrate` for
    // each newly declared space after this ack.
    sender.send({ t: "spaces.update.ack", spaceIds: [...spaceIds] });
  }

  private async handlePublish(
    sender: HubConnection,
    deviceId: string,
    msg: Msg<"publish">,
    others: readonly HubConnection[],
  ): Promise<void> {
    const nowMs = this.now();
    const declared = new Set(sender.spaceIds);
    const accepted: string[] = [];
    const rejected: PublishRejection[] = [];
    const acceptedBySpace = new Map<string, CookieRecordWire[]>();
    const rateWindows = new Map<string, number[]>();
    // One publish is one serialized turn on this user's storage (the host
    // chains them), so a lease or a stored record read once cannot change
    // underneath the rest of the batch. Caching them turns a 2,000-record
    // publish from two reads per record into one read per distinct origin
    // and record.
    const leases = new Map<string, LeaseEntry | undefined>();
    const storedRecords = new Map<string, CookieRecordWire | undefined>();
    let rateLimited = false;

    for (const record of msg.records) {
      if (!declared.has(record.spaceId) || record.hlc.deviceId !== deviceId) {
        rejected.push({ recordId: record.recordId, reason: "malformed" });
        continue;
      }
      if (record.hlc.physicalMs > nowMs + MAX_ACCEPTED_DRIFT_MS) {
        rejected.push({ recordId: record.recordId, reason: "clock_drift" });
        continue;
      }
      const lkey = leaseKey(record.spaceId, record.originId);
      let lease = leases.get(lkey);
      if (!leases.has(lkey)) {
        lease = await this.storage.get<LeaseEntry>(lkey);
        leases.set(lkey, lease);
      }
      if (
        lease !== undefined &&
        lease.holderDeviceId !== deviceId &&
        lease.expiresAtMs > nowMs
      ) {
        // An exclusive holder (a cloud run) is never force-taken by the
        // engine's recovery path; the distinct reason lets it defer instead.
        rejected.push({
          recordId: record.recordId,
          reason: lease.exclusive ? "exclusive_lease" : "lease_required",
        });
        continue;
      }
      const rkey = recKey(record.spaceId, record.recordId);
      let stored = storedRecords.get(rkey);
      if (!storedRecords.has(rkey)) {
        stored = await this.storage.get<CookieRecordWire>(rkey);
        storedRecords.set(rkey, stored);
      }
      if (stored !== undefined && compareHlc(stored.hlc, record.hlc) >= 0) {
        rejected.push({ recordId: record.recordId, reason: "stale" });
        continue;
      }
      const rk = rateKey(deviceId, record.originId);
      let window = rateWindows.get(rk);
      if (window === undefined) {
        window = (await this.storage.get<number[]>(rk)) ?? [];
        rateWindows.set(rk, window);
      }
      const cutoff = nowMs - RATE_WINDOW_MS;
      while (window.length > 0) {
        const head = window[0];
        if (head === undefined || head > cutoff) break;
        window.shift();
      }
      if (window.length >= MAX_MUTATIONS_PER_ORIGIN_PER_MINUTE) {
        // Nothing was stored, so this must NOT look like `stale` (the one
        // durable rejection): the client has to re-queue and retry once the
        // window slides. The `error` frame below carries the human-readable
        // cause alongside.
        rateLimited = true;
        rejected.push({ recordId: record.recordId, reason: "rate_limited" });
        continue;
      }
      window.push(nowMs);
      await this.storage.put(rkey, record);
      storedRecords.set(rkey, record);
      await this.appendHistory(record);
      accepted.push(record.recordId);
      const group = acceptedBySpace.get(record.spaceId);
      if (group === undefined) acceptedBySpace.set(record.spaceId, [record]);
      else group.push(record);
    }

    for (const [key, window] of rateWindows)
      await this.storage.put(key, window);
    for (const [spaceId, records] of acceptedBySpace) {
      const current = await this.storage.get<Hlc>(wmKey(spaceId));
      let max = current ?? null;
      for (const record of records) {
        if (max === null || compareHlc(record.hlc, max) > 0) max = record.hlc;
      }
      if (
        max !== null &&
        (current === undefined || compareHlc(max, current) > 0)
      ) {
        await this.storage.put(wmKey(spaceId), max);
      }
    }

    sender.send({ t: "publish.ack", accepted, rejected });
    if (rateLimited) {
      sender.send({
        t: "error",
        code: "rate_limited",
        message: `over ${MAX_MUTATIONS_PER_ORIGIN_PER_MINUTE} mutations/origin/minute`,
      });
    }
    if (acceptedBySpace.size > 0) {
      // Peer space sets come from storage too, so a peer whose declaration
      // changed through `spaces.update` on another handler receives fan-out
      // for exactly what it declares now.
      for (const peer of others) {
        if (peer.deviceId !== null) {
          peer.spaceIds =
            (await this.declaredSpaces(peer.deviceId, peer.connectionId)) ??
            [];
        }
      }
    }
    for (const [spaceId, records] of acceptedBySpace) {
      const frames = chunkFrames(records, cookieRecordBytes, HYDRATE_CHUNK_SIZE, (record) =>
        sender.send({
          t: "error",
          code: "record_too_large",
          message: `record ${record.recordId} was stored but is too large to relay`,
        }),
      );
      for (const peer of others) {
        if (!peer.spaceIds.includes(spaceId)) continue;
        for (const frame of frames) peer.send({ t: "records", spaceId, records: frame });
      }
    }
  }

  /**
   * Retain the newest MAX_RECORD_HISTORY versions of a record, oldest pruned
   * first. History keys embed encodeHlc(hlc), so list order is HLC order, and
   * the keys to drop are the leading run — which is why the listing is capped
   * rather than reading every version of the record on every append.
   */
  private async appendHistory(record: CookieRecordWire): Promise<void> {
    const prefix = histPrefix(record.spaceId, record.recordId);
    await this.storage.put(histKey(record.spaceId, record.recordId, record.hlc), record);
    const window = MAX_RECORD_HISTORY + HISTORY_PRUNE_BATCH;
    for (;;) {
      const versions = await this.storage.list<CookieRecordWire>({ prefix, limit: window });
      let excess = versions.size - MAX_RECORD_HISTORY;
      if (excess <= 0) return;
      for (const key of versions.keys()) {
        if (excess <= 0) break;
        await this.storage.delete(key);
        excess -= 1;
      }
      // A short page proves nothing older was hidden behind the cap.
      if (versions.size < window) return;
    }
  }

  private async handleHydrate(
    sender: HubConnection,
    msg: Msg<"hydrate">,
  ): Promise<void> {
    // Same scoping as publish and rollback: a device reads only the Spaces
    // it declared in hello, even though every record here is ciphertext.
    if (!sender.spaceIds.includes(msg.spaceId)) {
      sender.send({
        t: "error",
        code: "malformed",
        message: "space not declared in hello",
      });
      return;
    }
    const { records, watermark } = await this.hydrateSpace(
      msg.spaceId,
      msg.sinceHlc,
    );
    for (const frame of chunkFrames(records, cookieRecordBytes, HYDRATE_CHUNK_SIZE, (record) => {
      sender.send({
        t: "error",
        code: "record_too_large",
        message: `record ${record.recordId} is over ${String(MAX_FRAME_BYTES)} bytes and cannot be streamed`,
      });
    })) {
      sender.send({ t: "records", spaceId: msg.spaceId, records: frame });
    }
    sender.send({
      t: "hydrate.done",
      spaceId: msg.spaceId,
      count: records.length,
      watermark,
    });
  }

  private async handleLeaseAcquire(
    sender: HubConnection,
    deviceId: string,
    kind: DeviceKind,
    msg: Msg<"lease.acquire">,
    others: readonly HubConnection[],
  ): Promise<void> {
    const nowMs = this.now();
    const key = leaseKey(msg.spaceId, msg.originId);
    const existing = await this.storage.get<LeaseEntry>(key);
    const live =
      existing !== undefined && existing.expiresAtMs > nowMs
        ? existing
        : undefined;
    const foreign = live !== undefined && live.holderDeviceId !== deviceId;
    // Only a cloud device drives exclusively (D10); a desktop asking for
    // `exclusive` gets an ordinary lease and is told so in the grant.
    const exclusive = kind === "cloud" && msg.exclusive === true;
    const denied = (holder: LeaseEntry): void => {
      sender.send({
        t: "lease.denied",
        spaceId: msg.spaceId,
        originId: msg.originId,
        holderDeviceId: holder.holderDeviceId,
        holderKind: holder.holderKind,
        exclusive: holder.exclusive,
        expiresAtMs: holder.expiresAtMs,
      });
    };
    if (foreign && msg.force !== true) {
      denied(live);
      return;
    }
    if (foreign && msg.force === true) {
      // A live exclusive lease whose holder is still connected is a cloud
      // run in progress: nobody takes it over, whatever the candidate says.
      if (
        live.exclusive &&
        others.some((peer) => peer.deviceId === live.holderDeviceId)
      ) {
        denied(live);
        return;
      }
      const stored =
        msg.recordId === undefined
          ? undefined
          : await this.storage.get<CookieRecordWire>(
              recKey(msg.spaceId, msg.recordId),
            );
      // A bare force flag cannot steal rotating-auth ownership. The requester
      // must name the still-newer local candidate that triggered recovery.
      if (
        msg.recordId === undefined ||
        msg.candidateHlc === undefined ||
        (stored !== undefined &&
          (stored.originId !== msg.originId ||
            compareHlc(msg.candidateHlc, stored.hlc) <= 0))
      ) {
        denied(live);
        return;
      }
    }
    // An acquire from the current holder is a renewal and lands here too.
    const ttlCap = exclusive ? EXCLUSIVE_LEASE_TTL_MS : MAX_LEASE_TTL_MS;
    const ttlDefault = exclusive ? EXCLUSIVE_LEASE_TTL_MS : ORIGIN_LEASE_TTL_MS;
    const ttlMs = Math.min(msg.ttlMs ?? ttlDefault, ttlCap);
    const lease: LeaseEntry = {
      spaceId: msg.spaceId,
      originId: msg.originId,
      holderDeviceId: deviceId,
      holderKind: kind,
      exclusive,
      expiresAtMs: nowMs + ttlMs,
    };
    await this.storage.put(key, lease);
    sender.send({
      t: "lease.granted",
      spaceId: msg.spaceId,
      originId: msg.originId,
      holderDeviceId: deviceId,
      expiresAtMs: lease.expiresAtMs,
      exclusive,
    });
    if (foreign) {
      for (const peer of others) {
        if (peer.deviceId === live.holderDeviceId) {
          peer.send({
            t: "lease.revoked",
            spaceId: msg.spaceId,
            originId: msg.originId,
            newHolderDeviceId: deviceId,
          });
        }
      }
    }
  }

  private async handleLeaseRelease(
    sender: HubConnection,
    deviceId: string,
    msg: Msg<"lease.release">,
    others: readonly HubConnection[],
  ): Promise<void> {
    // Only the holder's own entry matches; a release from anyone else is
    // a no-op and broadcasts nothing.
    await this.releaseLeases(
      deviceId,
      { spaceId: msg.spaceId, originIds: [msg.originId] },
      [sender, ...others],
    );
  }

  /** Rollback deletes the rolled-back versions outright — no persistent
   * marker, so records published after the rollback hydrate normally. Clients
   * converge by republishing restored state. */
  private async handleRollback(
    sender: HubConnection,
    msg: Msg<"rollback">,
    others: readonly HubConnection[],
  ): Promise<void> {
    if (!sender.spaceIds.includes(msg.spaceId)) {
      sender.send({
        t: "error",
        code: "malformed",
        message: "space not declared in hello",
      });
      return;
    }
    const stored = await this.storage.list<CookieRecordWire>({
      prefix: `rec:${msg.spaceId}:`,
    });
    for (const [key, record] of stored) {
      if (record.spaceId !== msg.spaceId || record.originId !== msg.originId)
        continue;
      if (compareHlc(record.hlc, msg.toHlc) <= 0) continue;
      const versions = await this.storage.list<CookieRecordWire>({
        prefix: histPrefix(msg.spaceId, record.recordId),
      });
      let survivor: CookieRecordWire | undefined;
      for (const [versionKey, version] of versions) {
        if (compareHlc(version.hlc, msg.toHlc) > 0)
          await this.storage.delete(versionKey);
        else survivor = version; // keys ascend in HLC order: ends as the newest kept
      }
      if (survivor === undefined) await this.storage.delete(key);
      else await this.storage.put(key, survivor);
    }
    const applied: ServerMessage = {
      t: "rollback.applied",
      spaceId: msg.spaceId,
      originId: msg.originId,
      toHlc: msg.toHlc,
    };
    sender.send(applied);
    for (const peer of others) peer.send(applied);
  }

  private async handleWorkspacePublish(
    sender: HubConnection,
    deviceId: string,
    msg: Msg<"workspace.publish">,
    others: readonly HubConnection[],
  ): Promise<void> {
    const nowMs = this.now();
    // Device-scoped docs are writable only by the device they name. The
    // whole batch is refused so a client bug cannot half-apply.
    for (const doc of msg.docs) {
      const owner = workspaceKeyOwner(doc.key);
      // The hub stores workspace winners by HLC and never verifies `deviceSig`
      // (devices do, on receipt). Attributing a doc to another device would
      // therefore park a winner that every peer rejects on signature while it
      // suppresses that key's legitimate updates until something surpasses it.
      // A device only ever publishes registers it authored — merging adopts
      // the winner's HLC, and `workspace-sync.ts` skips those rather than
      // re-signing them — so its own id is the only one it can present.
      if (
        (owner !== null && owner !== deviceId) ||
        doc.hlc.deviceId !== deviceId ||
        doc.hlc.physicalMs > nowMs + MAX_ACCEPTED_DRIFT_MS
      ) {
        sender.send({
          t: "error",
          code: "malformed",
          message: `workspace doc ${doc.key} is not publishable by this device`,
        });
        return;
      }
    }
    const winners: WorkspaceRecordWire[] = [];
    for (const doc of msg.docs) {
      const existing = await this.storage.get<WorkspaceRecordWire>(
        workspaceKey(doc.key),
      );
      if (existing !== undefined && compareHlc(existing.hlc, doc.hlc) >= 0)
        continue;
      await this.storage.put(workspaceKey(doc.key), doc);
      winners.push(doc);
    }
    if (winners.length === 0) return;
    const frames = chunkFrames(winners, workspaceRecordBytes, HYDRATE_CHUNK_SIZE, (doc) =>
      sender.send({
        t: "error",
        code: "record_too_large",
        message: `workspace doc ${doc.key} was stored but is too large to relay`,
      }),
    );
    for (const peer of others)
      for (const frame of frames) peer.send({ t: "workspace.records", docs: frame });
  }

  private async handleWorkspaceHydrate(
    sender: HubConnection,
    msg: Msg<"workspace.hydrate">,
  ): Promise<void> {
    const stored = await this.storage.list<WorkspaceRecordWire>({
      prefix: "ws:",
    });
    const docs = sortByHlc(
      [...stored.values()].filter(
        (doc) => msg.sinceHlc === null || compareHlc(doc.hlc, msg.sinceHlc) > 0,
      ),
    );
    let withheld = 0;
    const frames = chunkFrames(docs, workspaceRecordBytes, HYDRATE_CHUNK_SIZE, (doc) => {
      // Undeliverable: streaming it would close this socket with 1009 and
      // strand every other doc, on this dial and on every reconnect.
      withheld += 1;
      sender.send({
        t: "error",
        code: "record_too_large",
        message: `workspace doc ${doc.key} is over ${String(MAX_FRAME_BYTES)} bytes and cannot be streamed`,
      });
    });
    for (const frame of frames) sender.send({ t: "workspace.records", docs: frame });
    sender.send({ t: "workspace.hydrate.done", count: docs.length - withheld });
  }
}
