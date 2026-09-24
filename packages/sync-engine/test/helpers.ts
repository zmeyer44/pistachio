/**
 * Deterministic test harness for the fidelity properties. No timers drive
 * behavior and no Math.random appears anywhere — schedules come exclusively
 * from fast-check, time from ManualClock, and delivery from explicit queues.
 */

import {
  computeRecordIdHex,
  deriveSpaceKeys,
  encodeHlc,
  generateDeviceKeypair,
  SPACE_ROOT_SECRET_BYTES,
  type Cause,
  type CookieAttributes,
  type CookieIdentity,
  type CookiePlain,
  type CookieRecordWire,
  type DeviceKeypair,
  type DeviceKind,
  type PublishRejection,
  type SpaceKeys,
} from "@pistachio/sync-protocol";
import {
  SpaceSyncEngine,
  type CookieApplier,
  type LeaseAcquireOptions,
  type LeaseDenial,
  type LeaseOutcome,
  type SyncEngineOptions,
  type SyncTransport,
} from "../src/index.js";

/* ------------------------------------------------------------------ *
 * Time
 * ------------------------------------------------------------------ */

export class ManualClock {
  private ms: number;

  constructor(startMs = 1_700_000_000_000) {
    this.ms = startMs;
  }

  readonly now = (): number => this.ms;

  tick(deltaMs = 1): number {
    this.ms += deltaMs;
    return this.ms;
  }
}

/**
 * Bounded event-loop yields until a condition holds. Node's WebCrypto resolves
 * off the microtask queue, so async engine work (queue drain) needs event-loop
 * turns; this is not a wall-clock wait and cannot flake on timing.
 */
export async function settle(predicate: () => boolean, maxTurns = 200): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (!predicate()) throw new Error("condition did not settle within the turn budget");
}

export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

/* ------------------------------------------------------------------ *
 * Identities and attributes
 * ------------------------------------------------------------------ */

export function makeIdentity(spaceId: string, hostKey: string, name: string): CookieIdentity {
  return { spaceId, hostKey, name, path: "/", partitionKey: "", sourceScheme: "secure" };
}

export const IDENTITY_POOL_SIZE = 8;

/** Small fixed identity pool varying hostKey dot-scope, partitionKey, sourceScheme. */
export function identityAt(spaceId: string, index: number): CookieIdentity {
  const combos: Array<Pick<CookieIdentity, "hostKey" | "name" | "partitionKey" | "sourceScheme">> = [
    { hostKey: "github.com", name: "sid", partitionKey: "", sourceScheme: "secure" },
    { hostKey: ".github.com", name: "sid", partitionKey: "", sourceScheme: "secure" },
    { hostKey: "github.com", name: "sid", partitionKey: "https://app.example", sourceScheme: "secure" },
    { hostKey: "github.com", name: "sid", partitionKey: "", sourceScheme: "nonsecure" },
    { hostKey: "gitlab.com", name: "token", partitionKey: "", sourceScheme: "secure" },
    { hostKey: ".gitlab.com", name: "token", partitionKey: "", sourceScheme: "unset" },
    { hostKey: "github.com", name: "csrf", partitionKey: "", sourceScheme: "secure" },
    { hostKey: "gitlab.com", name: "sid", partitionKey: "https://other.example", sourceScheme: "secure" },
  ];
  const combo = combos[index % combos.length];
  if (!combo) throw new Error("identity pool exhausted");
  return { spaceId, path: "/", ...combo };
}

export function attrsFor(value: string): CookieAttributes {
  return {
    value,
    expiresMs: null,
    persistent: false,
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    priority: "medium",
  };
}

/* ------------------------------------------------------------------ *
 * Keys and signers (cached; contents never depend on run order)
 * ------------------------------------------------------------------ */

const spaceKeysCache = new Map<string, Promise<SpaceKeys>>();

export function testSpaceKeys(spaceId: string): Promise<SpaceKeys> {
  let cached = spaceKeysCache.get(spaceId);
  if (!cached) {
    const secret = new Uint8Array(SPACE_ROOT_SECRET_BYTES).fill(0x42);
    cached = deriveSpaceKeys(spaceId, secret);
    spaceKeysCache.set(spaceId, cached);
  }
  return cached;
}

let keypairPromise: Promise<DeviceKeypair> | null = null;

export function testKeypair(): Promise<DeviceKeypair> {
  keypairPromise ??= generateDeviceKeypair();
  return keypairPromise;
}

/* ------------------------------------------------------------------ *
 * Applier and transports
 * ------------------------------------------------------------------ */

export class MemoryApplier implements CookieApplier {
  readonly applied: Array<{ plain: CookiePlain; cause: Cause }> = [];
  enabled = true;

  canApply(): boolean {
    return this.enabled;
  }

  apply(plain: CookiePlain, cause: Cause): Promise<void> {
    this.applied.push({ plain, cause });
    return Promise.resolve();
  }
}

export interface LeaseCall {
  spaceId: string;
  originId: string;
  force: boolean | undefined;
  exclusive?: boolean | undefined;
  ttlMs?: number | undefined;
}

export const DESKTOP_HOLDER: LeaseDenial = {
  holderDeviceId: "other-mac",
  holderKind: "desktop",
  exclusive: false,
};

export const CLOUD_HOLDER: LeaseDenial = {
  holderDeviceId: "cloud-device",
  holderKind: "cloud",
  exclusive: true,
};

export class CollectingTransport implements SyncTransport {
  readonly published: CookieRecordWire[] = [];
  readonly leaseCalls: LeaseCall[] = [];
  readonly released: string[] = [];
  /** Default answer: granted, or denied by `denial`. */
  leaseGranted = true;
  /** Who denies when a call is not granted. */
  denial: LeaseDenial = DESKTOP_HOLDER;
  /** Per-call answers consumed in order: a boolean (granted / denied by
   * `denial`) or a full outcome (e.g. a timeout). */
  readonly leaseResults: Array<boolean | LeaseOutcome> = [];

  publish(records: CookieRecordWire[]): void {
    this.published.push(...records);
  }

  acquireLease(
    spaceId: string,
    originId: string,
    opts?: LeaseAcquireOptions,
  ): Promise<LeaseOutcome> {
    this.leaseCalls.push({
      spaceId,
      originId,
      force: opts?.force,
      exclusive: opts?.exclusive,
      ttlMs: opts?.ttlMs,
    });
    const next = this.leaseResults.shift() ?? this.leaseGranted;
    if (typeof next !== "boolean") return Promise.resolve(next);
    if (next) {
      return Promise.resolve({ granted: true, exclusive: opts?.exclusive === true });
    }
    return Promise.resolve({ granted: false, denied: { ...this.denial } });
  }

  releaseLease(spaceId: string, originId: string): void {
    this.released.push(originId);
  }
}

/* ------------------------------------------------------------------ *
 * LoopbackHub — deterministic in-memory hub connecting engines
 * ------------------------------------------------------------------ */

interface HubMember {
  deviceId: string;
  kind: DeviceKind;
  engine: SpaceSyncEngine | null;
  cursor: number;
  partitioned: boolean;
}

interface HubLease {
  holderDeviceId: string;
  exclusive: boolean;
}

export interface PendingRejection {
  deviceId: string;
  recordId: string;
  reason: PublishRejection["reason"];
}

export interface LoopbackHubOptions {
  /**
   * Reject publishes under a foreign live lease (`lease_required`, or
   * `exclusive_lease` when the holder is a cloud device), as the real hub
   * does. Rejections are delivered by `ackPublishes()`, never inline.
   */
  enforceLeases?: boolean;
}

/**
 * Publishes append to one global log (the hub total order); each member holds
 * a cursor into it. Schedules control per-link partition/delay (withheld
 * deliveries) and cross-link interleaving (deliver command order). Publishers
 * are never re-delivered their own records. Leases follow §4: a cloud member's
 * exclusive lease cannot be force-taken while it is connected; releasing a
 * lease broadcasts `leaseReleased` to every member (holder included).
 */
export class LoopbackHub {
  private readonly log: Array<{ from: string; record: CookieRecordWire }> = [];
  private readonly members = new Map<string, HubMember>();
  private readonly leases = new Map<string, HubLease>();
  private readonly pendingRejections: PendingRejection[] = [];

  constructor(private readonly opts: LoopbackHubOptions = {}) {}

  register(deviceId: string, kind: DeviceKind = "desktop"): SyncTransport {
    const member: HubMember = { deviceId, kind, engine: null, cursor: 0, partitioned: false };
    this.members.set(deviceId, member);
    return {
      publish: (records: CookieRecordWire[]): void => {
        for (const record of records) {
          const lease = this.leases.get(`${record.spaceId}/${record.originId}`);
          if (
            this.opts.enforceLeases === true &&
            lease !== undefined &&
            lease.holderDeviceId !== deviceId
          ) {
            this.pendingRejections.push({
              deviceId,
              recordId: record.recordId,
              reason: lease.exclusive ? "exclusive_lease" : "lease_required",
            });
            continue;
          }
          this.log.push({ from: deviceId, record });
        }
      },
      acquireLease: (
        spaceId: string,
        originId: string,
        acquire?: LeaseAcquireOptions,
      ): Promise<LeaseOutcome> => {
        const key = `${spaceId}/${originId}`;
        const lease = this.leases.get(key);
        const exclusive = acquire?.exclusive === true && kind === "cloud";
        if (lease === undefined || lease.holderDeviceId === deviceId) {
          this.leases.set(key, { holderDeviceId: deviceId, exclusive });
          return Promise.resolve({ granted: true, exclusive });
        }
        if (acquire?.force === true && !lease.exclusive) {
          this.leases.set(key, { holderDeviceId: deviceId, exclusive });
          return Promise.resolve({ granted: true, exclusive });
        }
        return Promise.resolve({
          granted: false,
          denied: {
            holderDeviceId: lease.holderDeviceId,
            holderKind: this.members.get(lease.holderDeviceId)?.kind ?? "desktop",
            exclusive: lease.exclusive,
          },
        });
      },
      releaseLease: (spaceId: string, originId: string): void => {
        const key = `${spaceId}/${originId}`;
        if (this.leases.get(key)?.holderDeviceId !== deviceId) return;
        this.leases.delete(key);
        for (const peer of this.members.values()) peer.engine?.leaseReleased(originId);
      },
    };
  }

  attach(deviceId: string, engine: SpaceSyncEngine): void {
    this.member(deviceId).engine = engine;
  }

  partition(deviceId: string, partitioned: boolean): void {
    this.member(deviceId).partitioned = partitioned;
  }

  leaseHolder(spaceId: string, originId: string): HubLease | undefined {
    return this.leases.get(`${spaceId}/${originId}`);
  }

  get logLength(): number {
    return this.log.length;
  }

  pendingFor(deviceId: string): number {
    const member = this.member(deviceId);
    let pending = 0;
    for (let i = member.cursor; i < this.log.length; i += 1) {
      const entry = this.log[i];
      if (entry && entry.from !== deviceId) pending += 1;
    }
    return pending;
  }

  /** Deliver queued publish rejections (the hub's `publish.ack`) to their publishers. */
  async ackPublishes(): Promise<PendingRejection[]> {
    const batch = this.pendingRejections.splice(0);
    for (const rejection of batch) {
      await this.member(rejection.deviceId).engine?.publishRejected(
        rejection.recordId,
        rejection.reason,
      );
    }
    return batch;
  }

  async deliver(deviceId: string, max: number = Number.POSITIVE_INFINITY): Promise<number> {
    const member = this.member(deviceId);
    if (member.partitioned || member.engine === null) return 0;
    let delivered = 0;
    while (member.cursor < this.log.length && delivered < max) {
      const entry = this.log[member.cursor];
      member.cursor += 1;
      if (entry === undefined || entry.from === deviceId) continue;
      await member.engine.applyRemote([entry.record]);
      delivered += 1;
    }
    return delivered;
  }

  /** Full eventual delivery: heals partitions and drains every link. */
  async deliverAll(): Promise<void> {
    for (const member of this.members.values()) member.partitioned = false;
    let pending = true;
    while (pending) {
      pending = false;
      for (const member of this.members.values()) {
        await this.deliver(member.deviceId);
        if (member.cursor < this.log.length) pending = true;
      }
    }
  }

  private member(deviceId: string): HubMember {
    const member = this.members.get(deviceId);
    if (!member) throw new Error(`unknown hub member ${deviceId}`);
    return member;
  }
}

/* ------------------------------------------------------------------ *
 * Cluster / standalone-engine factories
 * ------------------------------------------------------------------ */

export interface Replica {
  deviceId: string;
  engine: SpaceSyncEngine;
  applier: MemoryApplier;
}

export interface Cluster {
  hub: LoopbackHub;
  clock: ManualClock;
  keys: SpaceKeys;
  replicas: Replica[];
}

/** Register one more engine on a hub (desktop unless `leaseKind` says otherwise). */
export async function addReplica(
  cluster: Cluster,
  spaceId: string,
  deviceId: string,
  overrides: Partial<SyncEngineOptions> = {},
): Promise<Replica> {
  const keypair = await testKeypair();
  const leaseKind = overrides.leaseKind ?? "desktop";
  const transport = cluster.hub.register(deviceId, leaseKind);
  const applier = new MemoryApplier();
  const engine = new SpaceSyncEngine(
    spaceId,
    cluster.keys,
    { deviceId, privateKey: keypair.privateKey },
    transport,
    applier,
    { deviceId, now: cluster.clock.now, ...overrides, leaseKind },
  );
  cluster.hub.attach(deviceId, engine);
  const replica: Replica = { deviceId, engine, applier };
  cluster.replicas.push(replica);
  return replica;
}

export async function createCluster(
  spaceId: string,
  size: number,
  overrides: Partial<SyncEngineOptions> = {},
  hubOptions: LoopbackHubOptions = {},
): Promise<Cluster> {
  const cluster: Cluster = {
    hub: new LoopbackHub(hubOptions),
    clock: new ManualClock(),
    keys: await testSpaceKeys(spaceId),
    replicas: [],
  };
  for (let i = 0; i < size; i += 1) {
    await addReplica(cluster, spaceId, `dev-${i}`, overrides);
  }
  return cluster;
}

export interface Standalone {
  engine: SpaceSyncEngine;
  transport: CollectingTransport;
  applier: MemoryApplier;
  clock: ManualClock;
}

export async function createEngine(
  spaceId: string,
  deviceId: string,
  clock: ManualClock,
  overrides: Partial<SyncEngineOptions> = {},
): Promise<Standalone> {
  const keys = await testSpaceKeys(spaceId);
  const keypair = await testKeypair();
  const transport = new CollectingTransport();
  const applier = new MemoryApplier();
  const engine = new SpaceSyncEngine(
    spaceId,
    keys,
    { deviceId, privateKey: keypair.privateKey },
    transport,
    applier,
    { deviceId, now: clock.now, leaseKind: "desktop", ...overrides },
  );
  return { engine, transport, applier, clock };
}

/* ------------------------------------------------------------------ *
 * State fingerprints for convergence assertions
 * ------------------------------------------------------------------ */

export async function poolRecordIds(keys: SpaceKeys, spaceId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < IDENTITY_POOL_SIZE; i += 1) {
    ids.push(await computeRecordIdHex(keys.idKey, identityAt(spaceId, i)));
  }
  return ids;
}

export function enginePrint(engine: SpaceSyncEngine, recordIds: ReadonlyArray<string>): string {
  const rows = recordIds.map((recordId) => {
    const record = engine.getRecord(recordId);
    if (!record) return { recordId, state: "absent" };
    return {
      recordId,
      hlc: encodeHlc(record.hlc),
      cause: record.cause,
      deleted: record.plain.deleted,
      value: record.plain.attributes?.value ?? null,
    };
  });
  return JSON.stringify(rows);
}

export function livePrint(engine: SpaceSyncEngine): string {
  const rows = engine.listLiveCookies().map((plain) => ({
    hostKey: plain.identity.hostKey,
    name: plain.identity.name,
    path: plain.identity.path,
    partitionKey: plain.identity.partitionKey,
    sourceScheme: plain.identity.sourceScheme,
    value: plain.attributes?.value ?? null,
  }));
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify(rows);
}
