/**
 * SpaceSyncEngine — client-side session sync engine (PRD §8.3,
 * cloud-sync-design §3).
 *
 * Conflict semantics:
 *   - LWW+HLC for ordinary cookies.
 *   - Causal resurrection guard: an EXPLICIT deletion beats a later write
 *     whose causal history predates it. Descent is decided by walking the
 *     ancestry edge map (every version token names its parent via the
 *     record's own causalParent, so edges are learned from every record seen
 *     — applied, stale, or blocked — making the verdict a function of the
 *     record SET, not delivery order). Token-embedded HLCs bound the walk: a
 *     chain that drops below the deletion's HLC can never reach it.
 *   - Unpublished versions never appear as `causalParent` on the wire. Every
 *     ancestry edge carries an `unpublished` bit (true for versions stored
 *     localOnly or parked in a queue lane; false once the exact wire reached
 *     `transport.publish` or arrived from the hub). `publish.ack` decides the
 *     bit: `publishAccepted` retires the versions the hub stored from the
 *     in-flight window, and a publish the hub refuses retracts the bit for
 *     what is left of it (`publishRejected`). The single publish choke point relinks
 *     a wire past unpublished ancestors and re-signs it, so a peer can always
 *     resolve the chain against its own fences.
 *   - Blocked writes are parked (max-HLC per record) and retried as ancestry
 *     knowledge grows, so a legitimate post-logout chain delivered out of
 *     order converges instead of being dropped.
 *   - Tombstone normalization: when a deletion is accepted, the stored
 *     tombstone is the max-HLC deletion seen for that record, so replicas that
 *     saw concurrent deletions in different orders agree on final (hlc, cause).
 *   - Echo suppression: EVERY applier.apply registers an expected echo keyed
 *     by (recordId, state fingerprint) with a TTL, so cookie-store change
 *     events caused by remote applies are never republished as local
 *     mutations — in steady state as well as during hydration — while
 *     applies that emit no event at all cannot poison future genuine writes.
 *   - Origin leases (client-side conservative expiry at half the server TTL),
 *     policy gating, offline queue with HLC-ordered drain, tombstone GC with
 *     retention, per-origin snapshot/rollback, and optional device-signature
 *     verification of remote records.
 *   - Lease arbitration (D10): a `desktop` engine leases rotating-auth origins
 *     and, when denied by a holder `deferToForeignLease` recognises (a cloud
 *     run), parks the write in the deferred lane instead of forcing a
 *     takeover. A `cloud` engine takes an exclusive lease for every write and
 *     renews it through the host-driven `renewLeases()`.
 *   - Rotating-auth deletions are writer-scoped: only the device holding the
 *     origin lease may propagate them. On a passive device, cookie deletions
 *     for a rotating-auth origin are overwhelmingly the server killing a
 *     STALE generation (the active device rotated; this copy died), so they
 *     stay local and EXPLICIT_DELETE demotes to EXPIRED — no resurrection
 *     fence — letting the peer's live session win back by plain LWW instead
 *     of being blocked for the tombstone retention window. An explicit-intent
 *     flag (manual "push this Mac's state") bypasses the guard.
 */

import {
  compareHlc,
  computeOriginIdHex,
  computeRecordIdHex,
  decodeCookiePlain,
  DELETION_CAUSES,
  encodeCookiePlain,
  EXCLUSIVE_LEASE_TTL_MS,
  fromBase64,
  HlcClock,
  makeVersionToken,
  matchOriginPolicy,
  normalizedHost,
  open,
  ORIGIN_LEASE_TTL_MS,
  parseVersionToken,
  recordSealAad,
  seal,
  SEED_CORPUS,
  signRecord,
  toBase64,
  TOMBSTONE_RETENTION_MS,
  type Cause,
  type CookieAttributes,
  type CookieIdentity,
  type CookiePlain,
  type CookieRecordWire,
  type DeviceKind,
  type Hlc,
  type OriginPolicy,
  type PublishRejection,
  type SignableRecordFields,
  type SpaceKeys,
  type VersionToken,
} from "@pistachio/sync-protocol";
import { MemoryQueueStorage, OfflineQueue, type QueueLane, type QueueStorage } from "./queue.js";
import type {
  CookieApplier,
  LeaseAcquireOptions,
  LeaseDenial,
  LeaseOutcome,
  OriginOverride,
  OriginPolicyView,
  OriginSnapshot,
  RecordVerifier,
  RemoteDisposition,
  StoredRecord,
  SyncEngineOptions,
  SyncTransport,
} from "./types.js";

/**
 * Map a Chromium cookies-'changed' cause to a sync Cause. Returns null for the
 * removal half of an overwrite pair — the non-removal half carries the
 * mutation, so the removal must not produce a record of its own.
 */
export function causeForChange(
  chromiumCause: string,
  removed: boolean,
): Cause | null {
  if (!removed) return chromiumCause === "overwrite" ? "OVERWRITE" : "WRITE";
  switch (chromiumCause) {
    case "explicit":
      return "EXPLICIT_DELETE";
    case "expired":
    case "expired-overwrite":
      return "EXPIRED";
    case "evicted":
      return "EVICTED";
    case "overwrite":
      return null;
    default:
      return "EXPLICIT_DELETE";
  }
}

export interface RecordSigner {
  deviceId: string;
  privateKey: CryptoKey;
}

/** Seal + sign one cookie mutation into its wire form. */
export async function buildCookieRecordWire(
  keys: SpaceKeys,
  signer: RecordSigner,
  plain: CookiePlain,
  hlc: Hlc,
  causalParent: VersionToken | null,
  cause: Cause,
): Promise<CookieRecordWire> {
  const spaceId = plain.identity.spaceId;
  const recordId = await computeRecordIdHex(keys.idKey, plain.identity);
  const originId = await computeOriginIdHex(
    keys.idKey,
    spaceId,
    plain.identity.hostKey,
  );
  const sealed = await seal(
    keys.sealKey,
    encodeCookiePlain(plain),
    recordSealAad(spaceId, recordId),
  );
  const fields: SignableRecordFields = {
    spaceId,
    recordId,
    originId,
    sealedRecord: toBase64(sealed),
    hlc,
    causalParent,
    cause,
  };
  const deviceSig = toBase64(await signRecord(signer.privateKey, fields));
  return { ...fields, deviceSig };
}

interface DeleteFence {
  hlc: Hlc;
  token: VersionToken;
}

interface TombstoneNote {
  wire: CookieRecordWire;
  plain: CookiePlain;
}

interface EchoEntry {
  count: number;
  expiresAtMs: number;
}

/** One ancestry edge: the parent a version supersedes and whether that
 * version ever reached the hub (see the header). */
interface AncestryEdge {
  parent: VersionToken | null;
  unpublished: boolean;
}

interface LeaseGrant {
  expiresAtMs: number;
  exclusive: boolean;
}

const DEFAULT_ECHO_TTL_MS = 10_000;
/** Ancestry edges retained per record; evicted oldest-HLC-first. */
const MAX_ANCESTRY_EDGES = 64;
/** Hard cap on a descent walk (cycle/adversarial-chain protection). */
const MAX_ANCESTRY_WALK = 128;
/** Lazy-prune threshold for the echo ledger. */
const ECHO_SWEEP_THRESHOLD = 256;

type Descent = "descends" | "predates" | "unknown";

/**
 * Rejections meaning "the hub stored nothing and no lease is in the way":
 * the record has to be re-queued or it is lost silently. `stale` is the only
 * durable rejection, so an unrecognised reason from a newer hub is retried
 * rather than mistaken for a durability confirmation.
 */
function isRetryableRejection(reason: PublishRejection["reason"]): boolean {
  return reason === "rate_limited" || reason === "clock_drift" || reason === "unknown";
}

export class SpaceSyncEngine {
  private readonly records = new Map<string, StoredRecord>();
  private readonly fences = new Map<string, DeleteFence>();
  private readonly latestTombstones = new Map<string, TombstoneNote>();
  /** Per recordId: version token → its ancestry edge (parent null = first write). */
  private readonly ancestry = new Map<string, Map<VersionToken, AncestryEdge>>();
  /** Max-HLC resurrection-blocked write per record, retried as edges grow. */
  private readonly parked = new Map<string, CookieRecordWire>();
  private readonly overrides = new Map<string, OriginOverride>();
  private readonly pendingEchoes = new Map<string, EchoEntry>();
  private readonly grantedLeases = new Map<string, LeaseGrant>();
  private readonly retryingLeaseRejections = new Set<string>();
  /** Records last dispatched from the deferred lane and not yet re-parked:
   * another `exclusive_lease` rejection re-parks them without re-acquiring. */
  private readonly inFlightDeferred = new Set<string>();
  /** Per recordId: wires handed to `transport.publish` whose `publish.ack`
   * has not been seen. A rejection un-publishes them — the hub stored
   * nothing, so they are not legal wire parents (see the header invariant).
   * Every ack consumes exactly one entry (`publishAccepted` /
   * `publishRejected`), so the window is bounded by the publishes in flight,
   * not by a cap: dropping an unacknowledged wire would leave a version the
   * hub refused marked published for ever. */
  private readonly sentWires = new Map<string, CookieRecordWire[]>();
  private readonly storage: QueueStorage;
  private readonly queue: OfflineQueue;
  private readonly deferred: OfflineQueue;
  private readonly clock: HlcClock;
  private readonly nowFn: () => number;
  private readonly policies: ReadonlyArray<OriginPolicy>;
  private readonly tombstoneRetentionMs: number;
  private readonly leaseKind: DeviceKind;
  private exclusiveLeasesEnabled: boolean;
  private readonly leaseTtlMs: number;
  private readonly echoTtlMs: number;
  private readonly verifier: RecordVerifier | null;
  private readonly deferToForeignLease: (denial: LeaseDenial) => boolean;
  private hydrating = false;
  private online = true;
  private drainPromise: Promise<void> | null = null;
  /** Serializes deferred-lane drains so a release and a retry never race. */
  private deferredChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly spaceId: string,
    private readonly keys: SpaceKeys,
    private readonly signer: { deviceId: string; privateKey: CryptoKey },
    private readonly transport: SyncTransport,
    private readonly applier: CookieApplier,
    opts: SyncEngineOptions,
  ) {
    this.nowFn = opts.now ?? ((): number => Date.now());
    this.clock = opts.clock ?? new HlcClock(opts.deviceId, this.nowFn);
    this.policies = opts.policies ?? SEED_CORPUS;
    this.tombstoneRetentionMs =
      opts.tombstoneRetentionMs ?? TOMBSTONE_RETENTION_MS;
    this.leaseKind = opts.leaseKind;
    this.exclusiveLeasesEnabled = opts.exclusiveLeases ?? opts.leaseKind === "cloud";
    this.leaseTtlMs =
      opts.leaseTtlMs ??
      (opts.leaseKind === "cloud" ? EXCLUSIVE_LEASE_TTL_MS : ORIGIN_LEASE_TTL_MS);
    this.echoTtlMs = opts.echoTtlMs ?? DEFAULT_ECHO_TTL_MS;
    this.verifier = opts.verifier ?? null;
    this.deferToForeignLease = opts.deferToForeignLease ?? ((): boolean => false);
    this.storage = opts.queueStorage ?? new MemoryQueueStorage();
    this.queue = new OfflineQueue(this.storage, "offline");
    this.deferred = new OfflineQueue(this.storage, "deferred");
    // Restore the persisted clock before any send so a restart can never
    // re-issue an HLC that a queued (or already published) wire carries.
    const persistedClock = this.storage.clock ?? null;
    if (persistedClock !== null) this.clock.restore(persistedClock);
  }

  /**
   * Whether this engine already holds a record for a cookie identity (applied
   * from a peer or written locally). Used to seed pre-existing local cookies
   * once after hydration WITHOUT re-publishing — and, crucially, without
   * clobbering: a cookie the peer already sent has a record here, so seeding
   * skips it and can never overwrite the peer's value with a stale local copy.
   */
  async hasRecord(identity: CookieIdentity): Promise<boolean> {
    if (identity.spaceId !== this.spaceId) return false;
    const recordId = await computeRecordIdHex(this.keys.idKey, identity);
    return this.records.has(recordId);
  }

  /**
   * A local cookie mutation observed from the browser (cookies 'changed').
   * Resolves the wire as published (relinked past unpublished ancestry when
   * it went out immediately) or as stored when it was queued.
   */
  async localChange(
    identity: CookieIdentity,
    attrs: CookieAttributes | null,
    removed: boolean,
    chromiumCause: string,
    opts: { explicitIntent?: boolean } = {},
  ): Promise<CookieRecordWire | null> {
    if (identity.spaceId !== this.spaceId) {
      throw new Error("cookie identity belongs to another space");
    }
    let cause = causeForChange(chromiumCause, removed);
    if (cause === null) return null;
    if (!removed && attrs === null) {
      throw new Error(
        "cookie attributes are required for a non-removal change",
      );
    }
    const plain: CookiePlain = {
      identity: { ...identity },
      attributes: !removed && attrs ? { ...attrs } : null,
      deleted: removed,
    };
    const recordId = await computeRecordIdHex(this.keys.idKey, identity);
    if (this.consumeEcho(recordId, plain)) return null;
    if (!this.isSynced(identity.hostKey)) return null;
    const policy = matchOriginPolicy(
      this.policies,
      normalizedHost(identity.hostKey),
    );
    // Writer-scoped deletions (see header): on a rotating-auth origin, a
    // deletion observed while this device is NOT the active writer is almost
    // always the server retiring a stale generation, not user intent. It must
    // neither propagate (it would sign the healthy device out) nor leave an
    // EXPLICIT fence (it would resurrection-block the peer's live session for
    // the whole tombstone retention window). Record it locally as EXPIRED so
    // the peer's next rotation wins back by plain LWW.
    let localOnly = false;
    if (
      policy.rotatingAuth &&
      DELETION_CAUSES.has(cause) &&
      opts.explicitIntent !== true
    ) {
      const originId = await computeOriginIdHex(
        this.keys.idKey,
        this.spaceId,
        identity.hostKey,
      );
      if (!this.holdsLease(originId)) {
        localOnly = true;
        if (cause === "EXPLICIT_DELETE") cause = "EXPIRED";
      }
    }
    const hlc = this.issueHlc();
    const current = this.records.get(recordId);
    const causalParent = current
      ? makeVersionToken(recordId, current.hlc)
      : null;
    const wire = await buildCookieRecordWire(
      this.keys,
      this.signer,
      plain,
      hlc,
      causalParent,
      cause,
    );
    this.noteAncestry(wire, true);
    this.noteFence(wire);
    if (DELETION_CAUSES.has(cause)) this.noteTombstone(wire, plain);
    this.store(wire, plain);
    this.inFlightDeferred.delete(recordId);
    let result = wire;
    if (!localOnly) {
      // Cloud engines lease every write (D10); desktops lease live writes on
      // rotating-auth origins only (deletions there are already writer-scoped).
      const needsLease =
        this.exclusiveLeasesEnabled ||
        (policy.rotatingAuth && !DELETION_CAUSES.has(cause));
      result = await this.dispatch(wire, needsLease, "offline");
    }
    await this.retryParked(recordId);
    return result;
  }

  /**
   * Remote records from the transport (broadcast or hydration stream).
   *
   * One record the cookie store refuses (Chromium rejects `__Host-`/`__Secure-`
   * prefixed or SameSite=None-without-Secure cookies outright, and the cloud
   * applier throws for a rejected write) must not abort the rest of the frame:
   * every later record of the batch would be lost, and a caller that re-pulls
   * the same batch would abort at the same record for ever. The refusal is
   * reported as `unappliable` for that one record and the batch continues.
   *
   * A batch in which NOTHING could be applied still rejects: there is no tail
   * to save, and callers that hand records over ONE at a time (the desktop's
   * first-hydration path) build their permanent skip list from the rejection.
   */
  async applyRemote(records: CookieRecordWire[]): Promise<RemoteDisposition[]> {
    const dispositions: RemoteDisposition[] = [];
    let firstRefusal: unknown = null;
    let refused = 0;
    for (const record of records) {
      try {
        dispositions.push(await this.applyOne(record));
      } catch (err) {
        if (refused === 0) firstRefusal = err;
        refused += 1;
        console.warn(
          `sync: could not apply record ${record.recordId} in space ${this.spaceId}`,
          err,
        );
        dispositions.push("unappliable");
      }
    }
    if (refused > 0 && refused === records.length) throw firstRefusal;
    return dispositions;
  }

  /** Decrypt and identity-check a staged record without mutating engine/browser state. */
  async inspectRemoteIdentity(
    record: CookieRecordWire,
  ): Promise<CookieIdentity | null> {
    if (record.spaceId !== this.spaceId) return null;
    if (this.verifier && !(await this.verifier.verify(record))) return null;
    try {
      const plain = await this.openRecord(record);
      return (await this.identityBound(record, plain))
        ? structuredClone(plain.identity)
        : null;
    } catch {
      return null;
    }
  }

  async beginHydration(): Promise<void> {
    this.hydrating = true;
  }

  async endHydration(): Promise<void> {
    this.hydrating = false;
  }

  snapshotOrigin(originId: string): OriginSnapshot {
    const records: StoredRecord[] = [];
    for (const record of this.records.values()) {
      if (record.originId === originId) records.push(structuredClone(record));
    }
    return {
      spaceId: this.spaceId,
      originId,
      capturedAtMs: this.nowFn(),
      records,
    };
  }

  /** Restore per-origin last-known-good state and republish it (PRD §8.3). */
  async rollbackOrigin(
    originId: string,
    snapshot: OriginSnapshot,
  ): Promise<CookieRecordWire[]> {
    const republished: CookieRecordWire[] = [];
    const snapshotIds = new Set(
      snapshot.records.map((record) => record.recordId),
    );
    for (const record of [...this.records.values()]) {
      if (
        record.originId !== originId ||
        snapshotIds.has(record.recordId) ||
        record.plain.deleted
      ) {
        continue;
      }
      const plain: CookiePlain = {
        identity: structuredClone(record.plain.identity),
        attributes: null,
        deleted: true,
      };
      republished.push(await this.reissue(plain, "EXPLICIT_DELETE"));
    }
    for (const record of snapshot.records) {
      const cause: Cause = record.plain.deleted ? "EXPLICIT_DELETE" : "WRITE";
      republished.push(
        await this.reissue(structuredClone(record.plain), cause),
      );
    }
    return republished;
  }

  /** Offline queue: engine enqueues when transport reports disconnected. */
  setOnline(online: boolean): void {
    this.online = online;
    if (online) {
      this.inBackground(this.flushPending(), "offline drain");
      this.inBackground(this.retryDeferred(), "deferred drain");
      return;
    }
    for (const originId of this.grantedLeases.keys()) {
      this.transport.releaseLease(this.spaceId, originId);
    }
    this.grantedLeases.clear();
  }

  /** Depth of the default (offline) lane. */
  get queueDepth(): number {
    return this.queue.depth;
  }

  /** Writes parked behind a foreign lease this device will not force. */
  get deferredDepth(): number {
    return this.deferred.depth;
  }

  /**
   * Flush mutations accumulated while offline (default lane only). Workspace
   * navigation sync uses this as part of its causal fence: a redirect URL must
   * never overtake the cookies that make that URL authenticated.
   */
  flushPending(): Promise<void> {
    if (!this.online) return Promise.resolve();
    if (this.drainPromise !== null) return this.drainPromise;
    const pending = this.runDrainQueue().finally(() => {
      if (this.drainPromise === pending) this.drainPromise = null;
    });
    this.drainPromise = pending;
    return pending;
  }

  /**
   * Re-dispatch the deferred lane (all origins, or one). The desktop calls it
   * every 30 s; `leaseReleased` / `leaseRevoked` / `setOnline(true)` call it
   * for their trigger. Drains are serialized; the promise resolves once this
   * drain (and every earlier one) has finished.
   */
  retryDeferred(originId?: string): Promise<void> {
    const run = this.deferredChain.then(() => this.drainDeferred(originId));
    this.deferredChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Fire-and-forget a drain started from a synchronous entry point. A drain
   * can reject (a wire that will not open, a transport that throws); leaving
   * it bare would surface as an unhandled rejection in the host process
   * instead of a diagnosable line.
   */
  private inBackground(work: Promise<void>, what: string): void {
    void work.catch((err: unknown) => {
      console.warn(`sync: ${what} for space ${this.spaceId} failed`, err);
    });
  }

  /**
   * Re-acquire every cached lease so a long-running cloud driver keeps its
   * exclusive grants alive (§8.3). No-op while offline; the engine owns no
   * timers — the host calls this on LEASE_RENEW_INTERVAL_MS.
   */
  /**
   * Whether every write takes an exclusive lease (W8). A browser session
   * turns this on when a run attaches and off again when it ends, so an
   * agent still fences the origins it is acting on while a person browsing
   * their own account from two places does not fence themselves.
   */
  get exclusiveLeases(): boolean {
    return this.exclusiveLeasesEnabled;
  }

  /**
   * Switch the rule. Grants already cached keep whatever they were taken
   * under until they lapse or the hub hands the origin on; the next acquire
   * follows the new rule.
   */
  setExclusiveLeases(exclusive: boolean): void {
    this.exclusiveLeasesEnabled = exclusive;
  }

  async renewLeases(): Promise<void> {
    if (!this.online) return;
    for (const originId of [...this.grantedLeases.keys()]) {
      await this.acquireLease(originId, false);
    }
  }

  /** The hub transferred this exact origin to another active device. */
  leaseRevoked(originId: string): void {
    this.grantedLeases.delete(originId);
    this.inBackground(this.retryDeferred(originId), "deferred drain");
  }

  /**
   * The hub broadcast `lease.released` for this origin (holder released it,
   * disconnected, or was revoked). A cached grant of our own is dropped — the
   * next write re-acquires — and writes deferred behind the holder drain.
   */
  leaseReleased(originId: string): void {
    this.grantedLeases.delete(originId);
    this.inBackground(this.retryDeferred(originId), "deferred drain");
  }

  /**
   * `publish.ack.accepted` (§3): the hub stored these records durably.
   *
   * The ack names a cookie, not a version, but the mapping is exact all the
   * same: one wire per record crosses `publishWire` per frame, and the hub
   * answers every record of a frame with exactly one `accepted` or `rejected`
   * entry, in frame order over one ordered socket. So the oldest wire still
   * in the record's in-flight window is precisely the version this ack
   * confirms. It leaves the window with its published mark confirmed; a later
   * rejection then un-publishes only versions the hub really refused.
   */
  publishAccepted(recordIds: readonly string[]): void {
    for (const recordId of recordIds) {
      const sent = this.sentWires.get(recordId);
      if (sent === undefined) continue;
      const acked = sent.shift();
      if (sent.length === 0) this.sentWires.delete(recordId);
      // Normally already published; re-assert it in case the wire was
      // shelved (marking it unpublished) while its ack was in flight.
      if (acked !== undefined) this.markUnpublished(acked, false);
    }
  }

  /**
   * Recover an optimistic publish that raced a lease handoff. The ack
   * identifies a cookie, not an exact version, so retry the newest local
   * winner: replaying the rejected older generation could roll the site back.
   *
   * Every rejection, whatever the reason, first un-publishes the versions
   * that were in flight for this record: the hub stored none of them, so a
   * later wire must not name one as its `causalParent`.
   *
   * First acquire without force: a denial names the holder, and a holder
   * `deferToForeignLease` recognises (a cloud run) parks the winner in the
   * deferred lane. An unknown holder (timeout / offline) is never forced.
   * Otherwise the validated forced-takeover path runs.
   */
  async publishRejected(
    recordId: string,
    reason: PublishRejection["reason"],
  ): Promise<void> {
    // The hub stored none of the versions it just refused, so none of them
    // may appear as a `causalParent` on a later wire. Re-mark the in-flight
    // window unpublished before every early return; `relink` then routes the
    // next wire past them to an ancestor the hub does hold (or to null).
    // `publishAccepted` has already taken every acknowledged version out of
    // this window, so what remains is unacknowledged — but not necessarily
    // unstored: a lost socket reports one recordId for every wire it lost
    // (`onPublishInterrupted`), and a `stale` ack means the hub holds this
    // very record. Un-marking therefore still stops at the record's newest
    // deletion fence: relinking past a fence can only turn a peer's
    // `descends` verdict into `predates` (a fence holder blocks anything that
    // does not descend from it), so walking further back never helps, while
    // keeping the fence and its ancestors marked preserves the one chain a
    // peer holding that fence resolves.
    const sent = this.sentWires.get(recordId);
    if (sent !== undefined) {
      this.sentWires.delete(recordId);
      const fence = this.fences.get(recordId);
      for (const wire of sent) {
        if (fence !== undefined && compareHlc(wire.hlc, fence.hlc) <= 0) continue;
        this.markUnpublished(wire, true);
      }
    }
    if (isRetryableRejection(reason)) {
      // Nothing was stored and no lease is in the way (rate limiting, or a
      // reason only a newer hub knows). Re-queue the newest local winner in
      // the DEFAULT lane — not the deferred one, whose depth means "a cloud
      // run holds this origin" and blocks the desktop's manual push. Unlike
      // the lease path this must also retry deletions: a dropped deletion is
      // exactly the case that has to reach the hub. `shelve` re-marks the
      // wire unpublished, restoring the ancestry invariant.
      const current = this.records.get(recordId);
      if (current === undefined || current.hlc.deviceId !== this.signer.deviceId)
        return;
      this.inFlightDeferred.delete(recordId);
      await this.shelve(current.wire, "offline");
      return;
    }
    if (
      (reason !== "lease_required" && reason !== "exclusive_lease") ||
      this.retryingLeaseRejections.has(recordId)
    )
      return;
    const current = this.records.get(recordId);
    if (current === undefined || current.hlc.deviceId !== this.signer.deviceId) {
      this.inFlightDeferred.delete(recordId);
      return;
    }
    // The socket died with this wire in flight (`onPublishInterrupted` reports
    // it as `lease_required`). Re-queue it, deletions included: dropping one
    // loses a sign-out and leaves every peer holding the dead session cookie.
    // The writer-scoped rule below is about not forcing a lease takeover FOR a
    // deletion, which is a different thing from discarding it.
    if (!this.online) {
      const interrupted = this.inFlightDeferred.delete(recordId);
      await this.shelve(current.wire, interrupted ? "deferred" : "offline");
      return;
    }
    if (DELETION_CAUSES.has(current.cause)) {
      this.inFlightDeferred.delete(recordId);
      return;
    }

    this.retryingLeaseRejections.add(recordId);
    try {
      this.grantedLeases.delete(current.originId);
      const fromDeferred = this.inFlightDeferred.delete(recordId);
      if (!this.online) {
        await this.shelve(current.wire, fromDeferred ? "deferred" : "offline");
        return;
      }
      if (fromDeferred && reason === "exclusive_lease") {
        // The holder is still driving; re-park without another round trip.
        await this.shelve(current.wire, "deferred");
        return;
      }
      const first = await this.acquireLease(current.originId, false);
      if (first.granted) {
        await this.publishWire(current.wire);
        return;
      }
      if (!("denied" in first)) {
        // timeout / offline: the holder is unknown — never force blindly.
        await this.shelve(current.wire, "deferred");
        return;
      }
      if (this.deferToForeignLease(first.denied)) {
        await this.shelve(current.wire, "deferred");
        return;
      }
      // Force is reserved for this validated recovery path: the hub rejected
      // a publish and `current` is still the newest local winner. Ordinary
      // capture/drain must respect the existing rotating-auth writer.
      const forced = await this.acquireLease(current.originId, true, {
        recordId: current.recordId,
        hlc: current.hlc,
      });
      if (!forced.granted) {
        await this.shelve(current.wire, "offline");
        return;
      }
      await this.publishWire(current.wire);
    } finally {
      this.retryingLeaseRejections.delete(recordId);
    }
  }

  /** Tombstone GC — never collects tombstones younger than retention. */
  gcTombstones(): number {
    const cutoff = this.nowFn() - this.tombstoneRetentionMs;
    let collected = 0;
    for (const [recordId, record] of [...this.records]) {
      if (record.tombstonedAtMs === null || record.tombstonedAtMs >= cutoff)
        continue;
      this.records.delete(recordId);
      this.fences.delete(recordId);
      this.latestTombstones.delete(recordId);
      this.ancestry.delete(recordId);
      this.parked.delete(recordId);
      this.sentWires.delete(recordId);
      collected += 1;
    }
    return collected;
  }

  getRecord(recordIdHex: string): StoredRecord | undefined {
    return this.records.get(recordIdHex);
  }

  listLiveCookies(): CookiePlain[] {
    const live: CookiePlain[] = [];
    for (const record of this.records.values()) {
      if (!record.plain.deleted) live.push(record.plain);
    }
    return live;
  }

  /** Re-apply stored winners when an origin moves from structured to native networking. */
  async reapplyOrigin(host: string): Promise<number> {
    const target = normalizedHost(host);
    let applied = 0;
    for (const record of this.records.values()) {
      const cookieHost = normalizedHost(record.plain.identity.hostKey);
      if (cookieHost !== target && !cookieHost.endsWith(`.${target}`)) continue;
      if (
        !this.isSynced(cookieHost) ||
        this.applier.canApply?.(record.plain) === false
      )
        continue;
      this.expectEcho(record.recordId, record.plain);
      await this.applier.apply(record.plain, record.cause);
      applied += 1;
    }
    return applied;
  }

  /** Per-origin user override: explicit opt-in to sync, or never sync. */
  setOriginOverride(host: string, override: OriginOverride | null): void {
    const key = normalizedHost(host);
    if (override === null) this.overrides.delete(key);
    else this.overrides.set(key, override);
  }

  getOriginPolicyFor(host: string): OriginPolicyView {
    const normalized = normalizedHost(host);
    return {
      policy: matchOriginPolicy(this.policies, normalized),
      override: this.lookupOverride(normalized),
      synced: this.isSynced(normalized),
    };
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private async applyOne(record: CookieRecordWire): Promise<RemoteDisposition> {
    const disposition = await this.ingest(record, true);
    await this.retryParked(record.recordId);
    return disposition;
  }

  private async ingest(
    record: CookieRecordWire,
    allowPark: boolean,
  ): Promise<RemoteDisposition> {
    // Echoes must never cross the wire — drop defensively whatever our state.
    if (record.cause === "HYDRATION_ECHO") return "duplicate";
    if (record.spaceId !== this.spaceId) return "rejected";
    if (this.verifier && !(await this.verifier.verify(record)))
      return "rejected";
    let plain: CookiePlain;
    try {
      plain = await this.openRecord(record);
    } catch {
      // Almost always a key mismatch: this device holds the wrong space secret
      // (a second device that never received the account's keys). Silently
      // dropping made a mis-keyed device look perfectly converged; a warning
      // makes it diagnosable (§8.2). Not fatal — other records may still open.
      console.warn(
        `sync: dropped a record for space ${this.spaceId} it could not unseal — likely a key mismatch on this device`,
      );
      return "rejected";
    }
    if (!(await this.identityBound(record, plain))) return "rejected";
    // D16: the persisted clock has to cover RECEIVED time too. `receive`
    // merges the remote timestamp into this device's clock, but only
    // `issueHlc` used to write it back, so a restart restored the last SENT
    // HLC and could re-issue one BELOW a record this device already accepted
    // — the local overwrite would then resolve as `stale` on every peer.
    const merged = this.clock.receive(record.hlc);
    const persisted = this.storage.clock ?? null;
    if (persisted === null || compareHlc(merged, persisted) > 0) {
      this.storage.clock = merged;
    }
    // Anything the hub delivered is by definition published.
    this.noteAncestry(record, false);
    this.noteFence(record);
    if (DELETION_CAUSES.has(record.cause)) this.noteTombstone(record, plain);
    const disposition = this.resolve(this.records.get(record.recordId), record);
    if (disposition === "resurrection-blocked" && allowPark) this.park(record);
    if (disposition !== "applied") return disposition;
    let winner: TombstoneNote;
    if (DELETION_CAUSES.has(record.cause)) {
      winner = this.latestTombstones.get(record.recordId) ?? {
        wire: record,
        plain,
      };
    } else {
      winner = { wire: record, plain };
    }
    if (this.applier.canApply?.(winner.plain) !== false) {
      this.expectEcho(winner.wire.recordId, winner.plain);
      try {
        await this.applier.apply(winner.plain, winner.wire.cause);
      } catch (err) {
        this.cancelExpectedEcho(winner.wire.recordId, winner.plain);
        throw err;
      }
    }
    // Commit only after Chromium accepted the mutation. If cookie-store I/O
    // fails, a repeated hydration record must remain eligible for retry.
    this.store(winner.wire, winner.plain);
    return "applied";
  }

  private resolve(
    current: StoredRecord | undefined,
    record: CookieRecordWire,
  ): RemoteDisposition {
    const thisToken = makeVersionToken(record.recordId, record.hlc);
    if (record.cause === "WRITE" || record.cause === "OVERWRITE") {
      const fence = this.fences.get(record.recordId);
      if (fence && compareHlc(record.hlc, fence.hlc) > 0) {
        // Newer than the newest explicit deletion: allowed only if its causal
        // history provably includes that deletion (PRD §8.3).
        if (
          this.descent(record.recordId, record.causalParent, fence) !==
          "descends"
        ) {
          return "resurrection-blocked";
        }
      }
      if (!current) return "applied";
      const cmp = compareHlc(record.hlc, current.hlc);
      if (cmp === 0) return "duplicate";
      return cmp > 0 ? "applied" : "stale";
    }
    if (record.cause === "EXPLICIT_DELETE") {
      if (!current) return "applied";
      const cmp = compareHlc(record.hlc, current.hlc);
      if (cmp === 0) return "duplicate";
      if (cmp > 0) return "applied";
      if (DELETION_CAUSES.has(current.cause)) return "stale";
      // Current is a live write with a newer HLC. If an even newer explicit
      // deletion is known, current has already been resolved against it and
      // this older deletion is superseded.
      const fence = this.fences.get(record.recordId);
      if (fence && fence.token !== thisToken) return "stale";
      // The deletion wins unless current provably descends from it — an
      // EXPLICIT deletion beats a later write whose history predates it, and
      // unproven history is treated as predating (conservative: a killed
      // session must not survive on ambiguity).
      const currentToken = makeVersionToken(current.recordId, current.hlc);
      const verdict = this.descent(record.recordId, currentToken, {
        hlc: record.hlc,
        token: thisToken,
      });
      return verdict === "descends" ? "stale" : "applied";
    }
    // EXPIRED / EVICTED deletes follow plain LWW.
    if (!current) return "applied";
    const cmp = compareHlc(record.hlc, current.hlc);
    if (cmp === 0) return "duplicate";
    return cmp > 0 ? "applied" : "stale";
  }

  /**
   * Walk ancestry edges from `startToken` toward roots, deciding whether the
   * chain passes through `fence.token`. Token-embedded HLCs give a sound
   * early exit: causal descent implies HLC descent, so a chain whose HLC
   * drops below the fence's can never reach it.
   */
  private descent(
    recordId: string,
    startToken: VersionToken | null,
    fence: DeleteFence,
  ): Descent {
    if (startToken === null) return "predates";
    const edges = this.ancestry.get(recordId);
    let token: VersionToken | null = startToken;
    for (let step = 0; step < MAX_ANCESTRY_WALK && token !== null; step += 1) {
      if (token === fence.token) return "descends";
      let hlc: Hlc;
      try {
        hlc = parseVersionToken(token).hlc;
      } catch {
        return "unknown";
      }
      if (compareHlc(hlc, fence.hlc) < 0) return "predates";
      const edge: AncestryEdge | undefined = edges?.get(token);
      if (edge === undefined) return "unknown";
      token = edge.parent;
    }
    return token === null ? "predates" : "unknown";
  }

  private edgesFor(recordId: string): Map<VersionToken, AncestryEdge> {
    let edges = this.ancestry.get(recordId);
    if (!edges) {
      edges = new Map();
      this.ancestry.set(recordId, edges);
    }
    return edges;
  }

  /**
   * Learn a version's parent. A token already known keeps its parent (only
   * `relink` rewrites one) but a published sighting clears `unpublished`.
   */
  private noteAncestry(
    record: Pick<CookieRecordWire, "recordId" | "hlc" | "causalParent">,
    unpublished: boolean,
  ): void {
    const edges = this.edgesFor(record.recordId);
    const token = makeVersionToken(record.recordId, record.hlc);
    const existing = edges.get(token);
    if (existing !== undefined) {
      if (!unpublished) existing.unpublished = false;
      return;
    }
    edges.set(token, { parent: record.causalParent, unpublished });
    if (edges.size <= MAX_ANCESTRY_EDGES) return;
    let oldest: VersionToken | null = null;
    let oldestHlc: Hlc | null = null;
    for (const t of edges.keys()) {
      try {
        const h = parseVersionToken(t).hlc;
        if (oldestHlc === null || compareHlc(h, oldestHlc) < 0) {
          oldestHlc = h;
          oldest = t;
        }
      } catch {
        oldest = t;
        break;
      }
    }
    if (oldest !== null) edges.delete(oldest);
  }

  private markUnpublished(wire: CookieRecordWire, unpublished: boolean): void {
    const edges = this.edgesFor(wire.recordId);
    const token = makeVersionToken(wire.recordId, wire.hlc);
    const edge = edges.get(token);
    if (edge !== undefined) edge.unpublished = unpublished;
    else edges.set(token, { parent: wire.causalParent, unpublished });
  }

  private noteFence(
    record: Pick<CookieRecordWire, "recordId" | "hlc" | "cause">,
  ): void {
    if (record.cause !== "EXPLICIT_DELETE") return;
    const fence = this.fences.get(record.recordId);
    if (!fence || compareHlc(record.hlc, fence.hlc) > 0) {
      this.fences.set(record.recordId, {
        hlc: record.hlc,
        token: makeVersionToken(record.recordId, record.hlc),
      });
    }
  }

  private park(record: CookieRecordWire): void {
    const existing = this.parked.get(record.recordId);
    if (!existing || compareHlc(record.hlc, existing.hlc) > 0) {
      this.parked.set(record.recordId, record);
    }
  }

  /**
   * Re-judge the parked write for a record after new knowledge arrived. A
   * still-blocked record stays parked; a superseded one is dropped; an
   * unblocked one is ingested through the normal path.
   */
  private async retryParked(recordId: string): Promise<void> {
    const parkedRecord = this.parked.get(recordId);
    if (!parkedRecord) return;
    const verdict = this.resolve(this.records.get(recordId), parkedRecord);
    if (verdict === "resurrection-blocked") return;
    this.parked.delete(recordId);
    if (verdict !== "applied") return;
    await this.ingest(parkedRecord, false);
  }

  private noteTombstone(wire: CookieRecordWire, plain: CookiePlain): void {
    const existing = this.latestTombstones.get(wire.recordId);
    if (!existing || compareHlc(wire.hlc, existing.wire.hlc) > 0) {
      this.latestTombstones.set(wire.recordId, { wire, plain });
    }
  }

  private store(wire: CookieRecordWire, plain: CookiePlain): void {
    this.records.set(wire.recordId, {
      recordId: wire.recordId,
      originId: wire.originId,
      plain,
      wire,
      cause: wire.cause,
      hlc: wire.hlc,
      causalParent: wire.causalParent,
      tombstonedAtMs: DELETION_CAUSES.has(wire.cause) ? this.nowFn() : null,
    });
  }

  private async openRecord(record: CookieRecordWire): Promise<CookiePlain> {
    const plainBytes = await open(
      this.keys.sealKey,
      fromBase64(record.sealedRecord),
      recordSealAad(record.spaceId, record.recordId),
    );
    return decodeCookiePlain(plainBytes);
  }

  /**
   * The sealed plaintext must re-derive the wire ids: a writer cannot claim a
   * record/origin id its identity does not hash to, so lease scoping and
   * per-record state can't be confused by a mismatched envelope.
   */
  private async identityBound(
    record: CookieRecordWire,
    plain: CookiePlain,
  ): Promise<boolean> {
    if (plain.identity.spaceId !== record.spaceId) return false;
    const expectedRecordId = await computeRecordIdHex(
      this.keys.idKey,
      plain.identity,
    );
    if (expectedRecordId !== record.recordId) return false;
    const expectedOriginId = await computeOriginIdHex(
      this.keys.idKey,
      record.spaceId,
      plain.identity.hostKey,
    );
    return expectedOriginId === record.originId;
  }

  private async reissue(
    plain: CookiePlain,
    cause: Cause,
  ): Promise<CookieRecordWire> {
    const recordId = await computeRecordIdHex(this.keys.idKey, plain.identity);
    const hlc = this.issueHlc();
    const current = this.records.get(recordId);
    const causalParent = current
      ? makeVersionToken(recordId, current.hlc)
      : null;
    const wire = await buildCookieRecordWire(
      this.keys,
      this.signer,
      plain,
      hlc,
      causalParent,
      cause,
    );
    this.noteAncestry(wire, true);
    this.noteFence(wire);
    if (DELETION_CAUSES.has(cause)) this.noteTombstone(wire, plain);
    this.store(wire, plain);
    this.inFlightDeferred.delete(recordId);
    if (this.applier.canApply?.(plain) !== false) {
      this.expectEcho(recordId, plain);
      await this.applier.apply(plain, cause);
    }
    return this.dispatch(wire, this.exclusiveLeasesEnabled, "offline");
  }

  /** Issue a local HLC and persist the clock (D16) so a restart never repeats it. */
  private issueHlc(): Hlc {
    const hlc = this.clock.send();
    this.storage.clock = hlc;
    return hlc;
  }

  /**
   * Fingerprint of the state an applier.apply will leave in the cookie store.
   * Excludes priority (not surfaced by Electron's cookies API) and rounds
   * expiry to seconds (Electron round-trips expirationDate in seconds), so
   * the echo event matches the expectation byte-for-byte.
   */
  private echoKey(recordId: string, plain: CookiePlain): string {
    if (plain.deleted || plain.attributes === null) return `${recordId}|D`;
    const a = plain.attributes;
    return [
      recordId,
      "W",
      a.value,
      a.expiresMs === null ? "session" : String(Math.floor(a.expiresMs / 1000)),
      a.persistent ? "1" : "0",
      a.secure ? "1" : "0",
      a.httpOnly ? "1" : "0",
      a.sameSite,
    ].join("");
  }

  private expectEcho(recordId: string, plain: CookiePlain): void {
    const key = this.echoKey(recordId, plain);
    const now = this.nowFn();
    if (this.pendingEchoes.size > ECHO_SWEEP_THRESHOLD) {
      for (const [k, entry] of [...this.pendingEchoes]) {
        if (entry.expiresAtMs <= now) this.pendingEchoes.delete(k);
      }
    }
    const existing = this.pendingEchoes.get(key);
    if (existing && existing.expiresAtMs > now) {
      existing.count += 1;
      existing.expiresAtMs = now + this.echoTtlMs;
    } else {
      this.pendingEchoes.set(key, {
        count: 1,
        expiresAtMs: now + this.echoTtlMs,
      });
    }
  }

  private cancelExpectedEcho(recordId: string, plain: CookiePlain): void {
    const key = this.echoKey(recordId, plain);
    const entry = this.pendingEchoes.get(key);
    if (entry === undefined) return;
    if (entry.count <= 1) this.pendingEchoes.delete(key);
    else entry.count -= 1;
  }

  private consumeEcho(recordId: string, plain: CookiePlain): boolean {
    const key = this.echoKey(recordId, plain);
    const entry = this.pendingEchoes.get(key);
    if (entry) {
      if (entry.expiresAtMs <= this.nowFn()) {
        this.pendingEchoes.delete(key);
      } else {
        if (entry.count <= 1) this.pendingEchoes.delete(key);
        else entry.count -= 1;
        return true;
      }
    }
    // During hydration every store event is a bulk-insert echo by definition.
    return this.hydrating;
  }

  private lookupOverride(host: string): OriginOverride | null {
    let bestDomain: string | null = null;
    let bestOverride: OriginOverride | null = null;
    for (const [domain, override] of this.overrides) {
      const matches = host === domain || host.endsWith(`.${domain}`);
      if (
        matches &&
        (bestDomain === null || domain.length > bestDomain.length)
      ) {
        bestDomain = domain;
        bestOverride = override;
      }
    }
    return bestOverride;
  }

  private isSynced(hostKey: string): boolean {
    const host = normalizedHost(hostKey);
    const override = this.lookupOverride(host);
    if (override === "never") return false;
    if (override === "sync") return true;
    const policy = matchOriginPolicy(this.policies, host);
    return policy.syncTier !== 0 && !policy.sensitive;
  }

  /* ---------------------------------------------------------------- *
   * Publishing, lanes, leases
   * ---------------------------------------------------------------- */

  /**
   * Route a local wire: queue it while offline, park it behind a foreign
   * lease this device defers to, otherwise publish — optimistically when the
   * lease was denied by a takeable holder, so the hub can reject this exact
   * version and `publishRejected` can validate it is still our newest local
   * winner before requesting a forced handoff.
   */
  private async dispatch(
    wire: CookieRecordWire,
    needsLease: boolean,
    lane: QueueLane,
  ): Promise<CookieRecordWire> {
    if (!this.online) return this.shelve(wire, lane);
    if (needsLease) {
      const outcome = await this.ensureLease(wire.originId);
      if (
        !outcome.granted &&
        "denied" in outcome &&
        this.deferToForeignLease(outcome.denied)
      ) {
        return this.shelve(wire, "deferred");
      }
      // The lease round trip can take seconds. If the socket went away in it,
      // publishing now hands the wire to a transport that drops the frame,
      // and because the record never reached `pendingCookiePublishes` no
      // `onPublishInterrupted` will name it: the write would be lost with the
      // version already marked published.
      if (!outcome.granted && "reason" in outcome && outcome.reason === "offline") {
        return this.shelve(wire, lane);
      }
    }
    if (!this.online) return this.shelve(wire, lane);
    return this.publishWire(wire);
  }

  /**
   * Park a wire in a queue lane; its version is (again) unpublished. The
   * wire is relinked first so a persisted lane never names an ancestor that
   * only this process knew to be unpublished (queue files outlive the
   * in-memory ancestry map across a restart).
   */
  private async shelve(
    wire: CookieRecordWire,
    lane: QueueLane,
  ): Promise<CookieRecordWire> {
    const relinked = await this.relink(wire);
    this.markUnpublished(relinked, true);
    this.inFlightDeferred.delete(relinked.recordId);
    (lane === "deferred" ? this.deferred : this.queue).enqueue(relinked);
    return relinked;
  }

  /**
   * The single choke point every wire crosses on its way to the transport:
   * relink past unpublished ancestry, flip this version to published, send.
   */
  private async publishWire(wire: CookieRecordWire): Promise<CookieRecordWire> {
    const relinked = await this.relink(wire);
    this.markUnpublished(relinked, false);
    const inFlight = this.sentWires.get(relinked.recordId) ?? [];
    inFlight.push(relinked);
    this.sentWires.set(relinked.recordId, inFlight);
    this.transport.publish([relinked]);
    return relinked;
  }

  /**
   * Follow ancestry from `wire.causalParent` while the parent token is
   * unpublished. If the parent changes, rebuild the wire with the new parent
   * and re-sign (`sealedRecord`, `hlc`, `cause`, ids unchanged), overwrite the
   * local edge, and replace the stored wire when the HLC matches. Invariant:
   * every published `causalParent` is `null` or a token this device published
   * or received from the hub.
   */
  private async relink(wire: CookieRecordWire): Promise<CookieRecordWire> {
    const edges = this.ancestry.get(wire.recordId);
    if (edges === undefined || wire.causalParent === null) return wire;
    let parent: VersionToken | null = wire.causalParent;
    for (let step = 0; step < MAX_ANCESTRY_WALK && parent !== null; step += 1) {
      const edge: AncestryEdge | undefined = edges.get(parent);
      if (edge === undefined || !edge.unpublished) break;
      parent = edge.parent;
    }
    if (parent === wire.causalParent) return wire;
    const fields: SignableRecordFields = {
      spaceId: wire.spaceId,
      recordId: wire.recordId,
      originId: wire.originId,
      sealedRecord: wire.sealedRecord,
      hlc: wire.hlc,
      causalParent: parent,
      cause: wire.cause,
    };
    const deviceSig = toBase64(
      await signRecord(this.signer.privateKey, fields),
    );
    const rebuilt: CookieRecordWire = { ...fields, deviceSig };
    const token = makeVersionToken(wire.recordId, wire.hlc);
    const own = edges.get(token);
    edges.set(token, { parent, unpublished: own?.unpublished ?? true });
    const current = this.records.get(wire.recordId);
    if (current !== undefined && compareHlc(current.hlc, wire.hlc) === 0) {
      current.wire = rebuilt;
      current.causalParent = parent;
    }
    const tombstone = this.latestTombstones.get(wire.recordId);
    if (
      tombstone !== undefined &&
      compareHlc(tombstone.wire.hlc, wire.hlc) === 0
    ) {
      tombstone.wire = rebuilt;
    }
    return rebuilt;
  }

  private holdsLease(originId: string): boolean {
    const grant = this.grantedLeases.get(originId);
    return grant !== undefined && grant.expiresAtMs > this.nowFn();
  }

  private async ensureLease(originId: string): Promise<LeaseOutcome> {
    const grant = this.grantedLeases.get(originId);
    if (grant !== undefined && grant.expiresAtMs > this.nowFn()) {
      return { granted: true, exclusive: grant.exclusive };
    }
    return this.acquireLease(originId, false);
  }

  private async acquireLease(
    originId: string,
    force: boolean,
    candidate?: Pick<CookieRecordWire, "recordId" | "hlc">,
  ): Promise<LeaseOutcome> {
    let opts: LeaseAcquireOptions | undefined;
    if (force) {
      opts = candidate ? { force: true, candidate } : { force: true };
    }
    if (this.exclusiveLeasesEnabled) {
      opts = { ...opts, exclusive: true, ttlMs: this.leaseTtlMs };
    }
    const outcome = await this.transport.acquireLease(
      this.spaceId,
      originId,
      opts,
    );
    if (outcome.granted) {
      // Trust a grant for half the server TTL so a cached grant can never
      // outlive the server-side lease (§8.3 single-writer handoff).
      this.grantedLeases.set(originId, {
        expiresAtMs: this.nowFn() + Math.floor(this.leaseTtlMs / 2),
        exclusive: outcome.exclusive,
      });
    } else if ("denied" in outcome) {
      // Only a hub denial proves another device holds the origin. A
      // `timeout` / `offline` outcome leaves the holder unknown (cf.
      // `publishRejected`: never force blindly), and the hub may well have
      // granted the renewal whose reply was dropped — an acquire from the
      // current holder is a renewal and is never denied. Keeping the entry
      // leaves the origin in `renewLeases()`'s set so the next tick retries
      // it; the cached `expiresAtMs` (half the server TTL) still bounds how
      // long the grant may be trusted, `setOnline(false)` still clears the
      // whole map, and a real handoff arrives as `lease.revoked` /
      // `lease.released`, which both delete it.
      this.grantedLeases.delete(originId);
    }
    return outcome;
  }

  /**
   * Drain the default lane WITHOUT emptying it first. Each wire leaves
   * persisted storage only once its dispatch settled: a dispatch blocks on a
   * lease round trip (seconds), and clearing the lane up front meant a crash
   * inside the loop lost every wire not yet dispatched — nothing else
   * persists them (`records` is memory-only and the in-flight window lives in
   * the transport). A wire shelved back mid-drain is the entry that survives.
   */
  private async runDrainQueue(): Promise<void> {
    for (const entry of this.queue.checkout()) {
      // Offline again: what is left stays in the lane, already persisted.
      if (!this.online) return;
      let needsLease: boolean;
      try {
        needsLease = await this.wireNeedsLease(entry.record);
      } catch {
        // Same expected cause as in `ingest`: this device holds the wrong
        // space secret. Dropping the one wire keeps the lane draining; the
        // alternative threw the whole drain (and every later wire) away.
        console.warn(
          `sync: dropped a queued record for space ${this.spaceId} it could not unseal — likely a key mismatch on this device`,
        );
        entry.settle();
        continue;
      }
      try {
        await this.dispatch(entry.record, needsLease, "offline");
      } catch (err) {
        // Not settled: the wire stays queued and a later drain retries it.
        console.warn(
          `sync: could not dispatch queued record ${entry.record.recordId} in space ${this.spaceId}`,
          err,
        );
        continue;
      }
      entry.settle();
    }
  }

  /**
   * Re-dispatch the deferred lane. A record whose current winner is no
   * longer authored by this device, or is a deletion, is dropped: the parked
   * write lost locally and must not be resurrected on the hub. Otherwise the
   * current winner goes through the ordinary lease + publish path (a fresh
   * denial re-parks it; a later `exclusive_lease` ack re-parks it without
   * re-acquiring). A lane restored from disk has no in-memory record for its
   * wires (the hub never accepted them); the parked wire is then the newest
   * local knowledge and is published as is — the hub's HLC order arbitrates.
   */
  private async drainDeferred(originId?: string): Promise<void> {
    if (!this.online) return;
    // Non-destructive for the same reason as `runDrainQueue`: a parked wire
    // leaves the persisted lane only once its dispatch settled.
    for (const entry of this.deferred.checkout()) {
      const wire = entry.record;
      // Another origin: it stays parked, untouched.
      if (originId !== undefined && wire.originId !== originId) continue;
      const current = this.records.get(wire.recordId);
      if (
        current !== undefined &&
        (current.hlc.deviceId !== this.signer.deviceId ||
          DELETION_CAUSES.has(current.cause))
      ) {
        // The parked write lost locally; it must not be resurrected.
        entry.settle();
        continue;
      }
      if (!this.online) return;
      const winner = current?.wire ?? wire;
      let needsLease: boolean;
      try {
        needsLease = await this.wireNeedsLease(winner);
      } catch {
        console.warn(
          `sync: dropped a deferred record for space ${this.spaceId} it could not unseal — likely a key mismatch on this device`,
        );
        entry.settle();
        continue;
      }
      this.inFlightDeferred.add(winner.recordId);
      try {
        await this.dispatch(winner, needsLease, "deferred");
      } catch (err) {
        console.warn(
          `sync: could not dispatch deferred record ${winner.recordId} in space ${this.spaceId}`,
          err,
        );
        continue;
      }
      entry.settle();
    }
  }

  private async wireNeedsLease(wire: CookieRecordWire): Promise<boolean> {
    if (this.exclusiveLeasesEnabled) return true;
    if (DELETION_CAUSES.has(wire.cause)) return false;
    const plain = await this.openRecord(wire);
    return matchOriginPolicy(
      this.policies,
      normalizedHost(plain.identity.hostKey),
    ).rotatingAuth;
  }
}
