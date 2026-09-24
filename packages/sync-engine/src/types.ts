/**
 * Public contract of the session sync engine (PRD §8.3, cloud-sync-design §3).
 * The desktop main process and the cloud browser are coded against these
 * exact shapes — do not rename or reshape.
 */

import type {
  Cause,
  CookiePlain,
  CookieRecordWire,
  DeviceKind,
  Hlc,
  HlcClock,
  OriginPolicy,
} from "@pistachio/sync-protocol";
import type { QueueStorage } from "./queue.js";

export interface StoredRecord {
  recordId: string; // hex
  originId: string; // hex
  plain: CookiePlain; // decrypted (client side always has keys)
  wire: CookieRecordWire; // last accepted sealed+signed form
  cause: Cause;
  hlc: Hlc;
  causalParent: string | null; // VersionToken
  /** local wall-time when a deletion was accepted — for tombstone GC */
  tombstonedAtMs: number | null;
}

/** Who holds the lease that denied an acquire (hub `lease.denied`, D10). */
export interface LeaseDenial {
  holderDeviceId: string;
  holderKind: DeviceKind;
  exclusive: boolean;
}

/**
 * Result of `SyncTransport.acquireLease`. `timeout` and `offline` are not
 * denials: the holder is unknown, so the engine never forces a takeover on
 * them and parks the write in its deferred lane instead.
 */
export type LeaseOutcome =
  | { granted: true; exclusive: boolean }
  | { granted: false; denied: LeaseDenial }
  | { granted: false; reason: "timeout" | "offline" };

export interface LeaseAcquireOptions {
  /** Forced handoff; the hub verifies `candidate` beats the stored winner. */
  force?: boolean;
  candidate?: Pick<CookieRecordWire, "recordId" | "hlc">;
  /** Honored by the hub only for cloud devices (D10). */
  exclusive?: boolean;
  ttlMs?: number;
}

export interface SyncTransport {
  publish(records: CookieRecordWire[]): void; // fire-and-forget; transport acks async
  acquireLease(
    spaceId: string,
    originId: string,
    opts?: LeaseAcquireOptions,
  ): Promise<LeaseOutcome>;
  releaseLease(spaceId: string, originId: string): void;
}

export interface CookieApplier {
  /** Fast policy gate checked before the engine registers an expected echo. */
  canApply?(plain: CookiePlain): boolean;
  /** Apply an accepted remote record to the local cookie store (Electron session).
   *  Engine calls this ONLY for records that won conflict resolution. */
  apply(plain: CookiePlain, cause: Cause): Promise<void>;
}

/**
 * Verifies a remote record's device signature against the enrolled-device
 * registry. When configured, records failing verification are rejected before
 * any state is touched.
 */
export interface RecordVerifier {
  verify(record: CookieRecordWire): Promise<boolean>;
}

export interface SyncEngineOptions {
  deviceId: string;
  /**
   * Lease arbitration role (D10). A `cloud` engine takes an exclusive lease
   * for every write and renews it through `renewLeases()`; a `desktop` engine
   * leases only rotating-auth origins and may defer to a cloud holder.
   */
  leaseKind: DeviceKind;
  clock?: HlcClock; // default new HlcClock(deviceId)
  now?: () => number; // default Date.now
  policies?: ReadonlyArray<OriginPolicy>; // default SEED_CORPUS
  tombstoneRetentionMs?: number; // default TOMBSTONE_RETENTION_MS
  /** Server-side origin-lease TTL; cached grants are trusted for half of it.
   *  Default EXCLUSIVE_LEASE_TTL_MS for `cloud`, ORIGIN_LEASE_TTL_MS otherwise. */
  leaseTtlMs?: number;
  /**
   * Whether this engine takes EXCLUSIVE origin leases for every write.
   * Defaults to today's rule — true for `cloud`, false otherwise — and is
   * separated from `leaseKind` for the persistent browser session
   * (docs/web-browser-design.md W8): a session is a `cloud` engine for
   * identity, but while no run is acting in it the person's Mac and their web
   * tab are two hands on the same account and must defer to each other under
   * the desktop rules rather than one fencing the other out.
   */
  exclusiveLeases?: boolean;
  /** How long an expected cookie-store echo may take to arrive before the
   *  expectation lapses (covers applies that emit no change event at all). */
  echoTtlMs?: number; // default 10_000
  verifier?: RecordVerifier;
  /** Backing store for both queue lanes and the persisted HLC clock (D16).
   *  Default: `MemoryQueueStorage`. */
  queueStorage?: QueueStorage;
  /**
   * Called when a non-forced acquire is denied. Returning true parks the write
   * in the deferred lane instead of forcing a takeover (the desktop returns
   * true when `holderKind === 'cloud'`). Default: never defer.
   */
  deferToForeignLease?: (denial: LeaseDenial) => boolean;
}

export type RemoteDisposition =
  | "applied"
  | "stale"
  | "resurrection-blocked"
  | "duplicate"
  /** Failed signature verification, unsealing, or sealed-identity binding. */
  | "rejected"
  /**
   * The applier refused this record — Chromium rejects some cookies outright
   * (`__Host-`/`__Secure-` prefix rules, SameSite=None without Secure) and the
   * cloud applier throws for a write the browser refused. Nothing was stored,
   * the rest of the batch still applied, and re-sending the same record will
   * be refused again: callers skip it rather than re-pull it for ever.
   */
  | "unappliable";

export type OriginOverride = "sync" | "never";

export interface OriginPolicyView {
  policy: OriginPolicy;
  override: OriginOverride | null;
  synced: boolean;
}

/** Per-origin last-known-good restore point (PRD §8.3 rollback/kill switch). */
export interface OriginSnapshot {
  spaceId: string;
  originId: string;
  capturedAtMs: number;
  records: ReadonlyArray<StoredRecord>;
}
