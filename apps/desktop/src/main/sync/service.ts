/**
 * SyncService — one SpaceSyncEngine per Space wired to the shared hub
 * transport, the Electron cookie applier, and cookie capture
 * (docs/cloud-sync-design.md §10.2). Also owns the per-origin last-known-good
 * snapshots behind `sync:rollbackOrigin`, the per-origin overrides, the
 * enrolled-device registry the engines verify against, the workspace sync
 * lane (workspace-sync.ts), and the SyncStatus the chrome shows.
 *
 * Gating (D22): nothing here dials until `start()` is called from the
 * enrolled transition, and `start()` refuses unless the device holds a device
 * token. The hub is dialed with that token, never the bootstrap one; when
 * neither PISTACHIO_HUB_URL nor `/me` names a hub, a development build runs
 * the in-process loopback transport and a packaged one waits.
 *
 * The hydration gate (§10.2): a Space's page loads are held from the moment
 * its session is configured until its stored cookie records have all been
 * applied, so a page never starts against a jar that is about to change under
 * it. The window itself never waits; a hub that cannot be reached releases
 * the gate and the person browses their local session.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "electron";
import {
  compareHlc,
  computeOriginIdHex,
  computeRecordIdHex,
  deriveSpaceKeys,
  matchOriginPolicy,
  normalizedHost,
  SEED_CORPUS,
  WORKSPACE_PSEUDO_SPACE_ID,
  attributesForCookie,
  identityForCookie,
  portableCookieFromElectron,
  type CookieRecordWire,
  type DurableTabSession,
  type OriginPolicy,
  type SpaceKeys,
} from "@pistachio/sync-protocol";
import {
  LoopbackTransport,
  SpaceSyncEngine,
  WsTransport,
  type HubTransport,
  type OriginSnapshot,
  type TransportEvents,
} from "@pistachio/sync-engine";
import type {
  SyncOriginInfo,
  SyncOriginOverride,
  SyncStatus,
  WorkspaceSyncAction,
  WorkspaceSyncStatus,
} from "@pistachio/shell-contracts/ipc";
import type { ControlClient } from "../account/control-client";
import type { DeviceStore } from "../account/device-store";
import { OFF_SYNC_STATUS, OFF_WORKSPACE_SYNC_STATUS } from "../feature-handlers";
import type { SpaceStore } from "../space-store";
import { attachCookieCapture, type CookieCapture } from "./capture";
import { ElectronCookieApplier } from "./cookie-applier";
import { DeviceRegistry, type DeviceRegistryRow } from "./device-registry";
import { partitionLiveRecords } from "./live-partition";
import { SyncOverrideStore } from "./override-store";
import { FileQueueStorage, queueFilePath, syncDir } from "./queue-file";
import { WorkspaceSyncService, type WorkspaceRecordStore } from "./workspace-sync";

const SNAPSHOT_REFRESH_MS = 15 * 60 * 1000;
const STATUS_DEBOUNCE_MS = 100;
const SESSION_HYDRATION_RETRY_MS = 1_000;
/** Re-dials for a clean snapshot this many times before opening the Space anyway. */
const MAX_HYDRATION_RETRIES = 3;
/** The deferred lane is re-tried on this cadence (§3, §10.2). */
export const RETRY_DEFERRED_INTERVAL_MS = 30_000;
/** How long `start()` waits for `/me` to name the hub before deciding without it. */
const DISCOVERY_WAIT_MS = 5_000;
const DISCOVERY_POLL_MS = 250;
/** A packaged build with no hub yet re-checks discovery on this cadence. */
const HUB_RECHECK_MS = 30_000;
const BROWSER_POLL_MS = 100;
/** A Space created a moment ago gets its root secret asynchronously (AuthService.ensureSpaceSecrets). */
const SECRET_WAIT_ATTEMPTS = 20;
const SECRET_WAIT_MS = 500;
const REGISTRY_REFRESH_MS = 10 * 60 * 1000;

/** The BrowserController surface the service drives; a fake in tests. */
export interface SyncBrowser {
  sessionFor(spaceId: string): Session;
  markSessionHydrating(spaceId: string): void;
  markSessionReady(spaceId: string): void;
  applyDurableSession(durable: DurableTabSession, spaceId: string, mode: "replace" | "merge"): Promise<void>;
  reloadSpace(spaceId: string): void;
}

export type SyncDevice = Pick<
  DeviceStore,
  "deviceId" | "deviceName" | "identity" | "spaceSecret" | "workspaceSecret" | "enrollment"
>;

export interface SyncServiceDeps {
  device: SyncDevice;
  spaces: SpaceStore;
  /** Bookmarks, reminders, and memory as one seam (sync/records.ts). */
  records: WorkspaceRecordStore;
  /** Created after the services (createWindow); polled until it exists. */
  browser(): SyncBrowser | null;
  restorePoint(): DurableTabSession;
  /** Hear about every tab-session persist; the restore point follows 40 ms later. */
  onSessionPersisted(listener: () => void): () => void;
  /** The control client while enrolled; null otherwise. */
  control(): ControlClient | null;
  enrolled(): boolean;
  /** The device token for the hub dial; null unless enrolled. */
  getToken(): Promise<string | null>;
  /** PISTACHIO_HUB_URL when set, else `/me`'s hubUrl once discovered. */
  hubUrl(): string | null;
  /** True when PISTACHIO_HUB_URL pins the hub (no discovery wait). */
  hubUrlPinned: boolean;
  packaged: boolean;
  /** `GET /devices` rows for the verifier registry (the raw client call, not the publishing AuthService one). */
  listDevices(): Promise<DeviceRegistryRow[]>;
  userDataDir: string;
  publishStatus(status: SyncStatus): void;
  publishWorkspaceStatus(status: WorkspaceSyncStatus): void;
  /** Tests inject a transport; main builds WsTransport / LoopbackTransport. */
  transportFactory?(url: string | null, events: TransportEvents): HubTransport;
  now?(): number;
  retryDeferredIntervalMs?: number;
  discoveryWaitMs?: number;
  /** Tests shorten the hydration re-dial backoff and the root-secret wait. */
  hydrationRetryMs?: number;
  secretWaitMs?: number;
}

interface SpaceSyncState {
  spaceId: string;
  engine: SpaceSyncEngine;
  keys: SpaceKeys;
  storage: FileQueueStorage;
  hydrating: boolean;
  /** Record frames contain async crypto and cookie-store writes. Preserve
   * transport order and make hydrate.done wait for every queued apply. */
  recordQueue: Promise<void>;
  recordError: unknown | null;
  /** Records Chromium refused; skipped so one bad cookie cannot loop hydration. */
  unappliable: Set<string>;
  /** Re-dials spent on a torn/refused hydration (bounded by MAX_HYDRATION_RETRIES). */
  hydrationRetries: number;
  capture: CookieCapture;
  /** Only the newest live-record queue tail may reopen tab navigation. */
  recordEpoch: number;
  /** First-link hydration is automatic; later live records wait for Pull. */
  hasHydratedOnce: boolean;
  pendingRemoteRecords: Map<string, CookieRecordWire>;
  /** Per-origin last-known-good restore points (rollback). */
  snapshots: Map<string, OriginSnapshot>;
}

export class SyncService {
  readonly #deps: SyncServiceDeps;
  readonly #now: () => number;
  readonly #overrides: SyncOverrideStore;
  readonly #registry: DeviceRegistry;
  readonly #spaces = new Map<string, SpaceSyncState>();
  readonly #pending = new Map<string, Promise<void>>();
  readonly #declaredSpaceIds = new Set<string>();
  /** Bulk cookie writers in progress per Space (fork copy, browser import). */
  readonly #bulkWrites = new Map<string, number>();
  readonly #transportEvents: TransportEvents;
  #transport: HubTransport | null = null;
  #hubUrl: string | null = null;
  #policies: ReadonlyArray<OriginPolicy> = SEED_CORPUS;
  #started = false;
  #revoked = false;
  /** Invalidates async setup continuations after a transport/account swap. */
  #syncGeneration = 0;
  #workspace: WorkspaceSyncService | null = null;
  #workspaceQueue: Promise<void> = Promise.resolve();
  #rejectionQueue: Promise<void> = Promise.resolve();
  #lastConvergedMs: number | null = null;
  #statusTimer: NodeJS.Timeout | null = null;
  #snapshotTimer: NodeJS.Timeout | null = null;
  #retryTimer: NodeJS.Timeout | null = null;
  #hubCheckTimer: NodeJS.Timeout | null = null;
  #registryTimer: NodeJS.Timeout | null = null;
  #unsubscribeSpaces: (() => void) | null = null;
  #unsubscribeSession: (() => void) | null = null;

  constructor(deps: SyncServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#overrides = new SyncOverrideStore(deps.userDataDir);
    this.#registry = new DeviceRegistry({
      local: { deviceId: deps.device.deviceId, publicKey: deps.device.identity().signingPublicKey },
      fetchDevices: () => deps.listDevices(),
      now: this.#now,
    });
    this.#transportEvents = {
      onStateChanged: (state) => {
        const online = state === "connected";
        const browser = this.#deps.browser();
        for (const space of this.#spaces.values()) {
          if (state === "connected") {
            // Only the first hydration gates browsing and applies
            // automatically. Reconnect/live snapshots are staged for the
            // explicit Pull control, avoiding races with a running site —
            // except rotating-auth and cloud-authored records, which
            // onRecords applies live (see live-partition).
            if (!space.hasHydratedOnce) {
              if (!space.hydrating) {
                space.hydrating = true;
                void space.engine.beginHydration();
              }
              // `unappliable` deliberately survives: the skip list is what
              // ends the re-dial loop, and the summary is logged once.
              space.recordError = null;
              browser?.markSessionHydrating(space.spaceId);
            }
          }
          space.engine.setOnline(online);
          if (state === "offline" || state === "off") {
            // A returning device can still browse its local Chromium session
            // while the hub is unavailable; a later hello closes the barrier
            // again before requesting hydration. A first-time Space browses
            // its local jar too — the window never waits on the hub.
            if (space.hydrating && space.hasHydratedOnce) {
              space.hydrating = false;
              void space.engine.endHydration();
            }
            browser?.markSessionReady(space.spaceId);
          }
        }
        this.pushStatus();
      },
      onRecords: (spaceId, records) => this.#onRecords(spaceId, records),
      onHydrated: (spaceId) => {
        void this.#finishHydration(spaceId).catch((err) => this.#logError(err));
      },
      onConverged: () => {
        this.#lastConvergedMs = this.#now();
        this.pushStatus();
      },
      onPublishAccepted: (recordIds) => {
        // Same chain as the rejections: the engine consumes its in-flight
        // window in ack order, so an accept must not overtake a rejection
        // that arrived first.
        this.#rejectionQueue = this.#rejectionQueue
          .then(() => {
            for (const space of this.#spaces.values()) space.engine.publishAccepted(recordIds);
          })
          .catch((err: unknown) => this.#logError(err));
      },
      onPublishRejected: (rejections) => {
        this.#rejectionQueue = this.#rejectionQueue
          .then(async () => {
            for (const rejection of rejections) {
              for (const space of this.#spaces.values()) {
                await space.engine.publishRejected(rejection.recordId, rejection.reason);
              }
            }
          })
          .catch((err: unknown) => this.#logError(err));
      },
      onPublishInterrupted: (recordIds) => {
        this.#rejectionQueue = this.#rejectionQueue
          .then(async () => {
            for (const recordId of recordIds) {
              for (const space of this.#spaces.values()) {
                // The transport is offline before this fires, so the record
                // lands in the engine's ordered offline queue and drains on hello.
                await space.engine.publishRejected(recordId, "lease_required");
              }
            }
          })
          .catch((err: unknown) => this.#logError(err));
      },
      onPresence: () => this.pushStatus(),
      onLeaseRevoked: (spaceId, originId) => {
        this.#spaces.get(spaceId)?.engine.leaseRevoked(originId);
      },
      onLeaseReleased: (spaceId, originId) => {
        this.#spaces.get(spaceId)?.engine.leaseReleased(originId);
        this.pushStatus();
      },
      onRevoked: () => {
        // 4003: the hub will not have this device back; only re-enrolling dials again.
        this.#revoked = true;
        for (const space of this.#spaces.values()) this.#deps.browser()?.markSessionReady(space.spaceId);
        this.pushStatus();
      },
      onWorkspaceRecords: (docs) => {
        const workspace = this.#workspace;
        if (workspace === null) return;
        const generation = this.#syncGeneration;
        this.#workspaceQueue = this.#workspaceQueue
          .then(async () => {
            if (generation !== this.#syncGeneration || this.#workspace !== workspace) return;
            await workspace.handleRemoteDocs(docs);
          })
          .catch((err: unknown) => this.#logError(err));
      },
      onWorkspaceHydrated: () => {
        const workspace = this.#workspace;
        if (workspace === null) return;
        const generation = this.#syncGeneration;
        this.#workspaceQueue = this.#workspaceQueue
          .then(async () => {
            if (generation === this.#syncGeneration && this.#workspace === workspace) {
              await workspace.handleHydrated();
            }
          })
          .catch((err: unknown) => this.#logError(err));
      },
      getToken: () => this.#deps.getToken(),
      // Enrolled ⇒ a null token is revoked/expired, not local/dev mode: the
      // transport must not dial the hub tokenless and loop (§8.2).
      authRequired: () => this.#deps.device.enrollment().state === "enrolled",
    };
  }

  /* ------------------------------- lifecycle ------------------------------- */

  get started(): boolean {
    return this.#started;
  }

  /** The hub address in use; null while on the loopback or waiting for discovery. */
  get hubUrl(): string | null {
    return this.#hubUrl;
  }

  /**
   * The device is enrolled and holds a device token. Discovers the hub,
   * fetches the origin corpus and overrides, builds the registry, waits for
   * the browser, sets up every Space, and dials. Idempotent.
   */
  start(): void {
    if (this.#started) return;
    if (!this.#deps.enrolled()) return;
    this.#started = true;
    this.#revoked = false;
    const generation = ++this.#syncGeneration;
    this.pushStatus();
    void this.#startAsync(generation).catch((err) => this.#logError(err));
  }

  /**
   * Sign-out or revocation: stop everything and, on sign-out, forget the
   * queues. Resolves once every in-flight `applyRemote` has settled: the
   * generation bump stops the NEXT record, but one already inside Electron's
   * cookie API would otherwise land after the caller wiped the partition.
   */
  stop(reason: "sign-out" | "revoked" | "shutdown" = "shutdown"): Promise<void> {
    this.#syncGeneration += 1;
    this.#started = false;
    this.#clearTimers();
    this.#unsubscribeSpaces?.();
    this.#unsubscribeSpaces = null;
    this.#unsubscribeSession?.();
    this.#unsubscribeSession = null;
    this.#workspace?.stop();
    this.#workspace = null;
    const browser = this.#deps.browser();
    // Snapshot what is already inside `applyRemote` BEFORE the map is cleared:
    // the caller wipes each Space's partition straight after sign-out, and an
    // apply that settles after that would recreate the signed-out account's
    // cookie.
    const draining = [...this.#spaces.values()].map((space) => space.recordQueue);
    for (const space of this.#spaces.values()) {
      space.capture.detach();
      browser?.markSessionReady(space.spaceId);
      if (reason === "sign-out") space.storage.remove();
      else space.storage.flush();
    }
    this.#spaces.clear();
    this.#pending.clear();
    this.#declaredSpaceIds.clear();
    this.#workspaceQueue = Promise.resolve();
    this.#transport?.stop();
    this.#transport = null;
    this.#hubUrl = null;
    if (reason === "sign-out") {
      // The account's queues, registers, and HLC clocks go with it (§10.1).
      try {
        rmSync(syncDir(this.#deps.userDataDir), { recursive: true, force: true });
      } catch {
        // Nothing to forget.
      }
      // The store read overrides.json once, in the constructor, and the same
      // SyncService instance serves the next account: drop the old account's
      // hosts too, or #loadPolicy would push them to the new account's control.
      this.#overrides.reset();
    }
    if (reason === "revoked") this.#revoked = true;
    this.#deps.publishStatus(this.status());
    this.#deps.publishWorkspaceStatus(this.workspaceStatus());
    return Promise.allSettled(draining).then(() => undefined);
  }

  /** The device token changed: re-dial the hub with it (§8.2). */
  refreshAuth(): void {
    if (!this.#started) return;
    this.#transport?.reconnect();
  }

  /** `devices:updated`: re-read the enrolled-device registry. */
  refreshRegistry(): void {
    if (!this.#started) return;
    void this.#registry.refresh();
  }

  /** Write everything that must reach disk before the process ends. */
  flush(): void {
    for (const space of this.#spaces.values()) space.storage.flush();
    this.#workspace?.flush();
  }

  /**
   * BrowserController configured a session for the first time. Human
   * sessions of a Space that has not hydrated yet hold their page loads until
   * hydration completes; agent partitions are never captured or gated.
   */
  onSessionCreated(_target: Session, spaceId: string, _partition: string, kind: "human" | "agent"): void {
    // Before the hub is resolved there is nothing to wait for: #setupSpace
    // closes the gate itself once the engine exists, so a slow control plane
    // never holds a page past the gate's safety timeout.
    if (kind !== "human" || !this.#started || this.#revoked || this.#transport === null) return;
    const space = this.#spaces.get(spaceId);
    if (space?.hasHydratedOnce === true) return;
    if (space === undefined && this.#deps.spaces.get(spaceId) === null) return;
    // A Space this Mac holds no root secret for never hydrates, so closing its
    // gate only strands page loads until the safety timeout. #setupSpace shuts
    // the gate itself once the secret is in hand.
    if (space !== undefined || this.#deps.device.spaceSecret(spaceId) !== null) {
      this.#deps.browser()?.markSessionHydrating(spaceId);
    }
    if (space === undefined) void this.addSpace(spaceId);
  }

  /** A bulk cookie writer (fork copy, browser import) is about to fill the jar: capture pauses. */
  beginBulkCookieWrite(spaceId: string): void {
    this.#bulkWrites.set(spaceId, (this.#bulkWrites.get(spaceId) ?? 0) + 1);
    void this.#spaces.get(spaceId)?.engine.beginHydration();
  }

  /** The bulk writer finished: what it wrote is seeded like any pre-existing cookie. */
  endBulkCookieWrite(spaceId: string): void {
    const depth = (this.#bulkWrites.get(spaceId) ?? 1) - 1;
    if (depth <= 0) this.#bulkWrites.delete(spaceId);
    else this.#bulkWrites.set(spaceId, depth);
    const space = this.#spaces.get(spaceId);
    if (space === undefined || depth > 0) return;
    if (!space.hydrating) void space.engine.endHydration();
    if (space.hasHydratedOnce && !space.hydrating) {
      void this.#seedExistingCookies(space).catch((err) => this.#logError(err));
    }
  }

  /** Idempotent — used for Spaces created after startup (a fork, or one from another device). */
  async addSpace(spaceId: string): Promise<void> {
    if (!this.#started || this.#transport === null) return;
    this.#declaredSpaceIds.add(spaceId);
    if (this.#spaces.has(spaceId)) return;
    const generation = this.#syncGeneration;
    await this.#ensureSpace(spaceId, generation);
    if (generation !== this.#syncGeneration || !this.#started || !this.#spaces.has(spaceId)) return;
    this.#transport?.addSpace(spaceId);
  }

  removeSpace(spaceId: string): void {
    this.#declaredSpaceIds.delete(spaceId);
    const space = this.#spaces.get(spaceId);
    if (space === undefined) return;
    space.capture.detach();
    space.storage.remove();
    this.#spaces.delete(spaceId);
    this.#deps.browser()?.markSessionReady(spaceId);
    void this.#transport?.updateSpaces([...this.#declaredSpaceIds]);
  }

  /* -------------------------------- status -------------------------------- */

  status(): SyncStatus {
    if (!this.#started && !this.#revoked) return { ...OFF_SYNC_STATUS };
    let queueDepth = 0;
    let remoteChanged = false;
    for (const space of this.#spaces.values()) {
      queueDepth += space.engine.queueDepth + space.engine.deferredDepth;
      if (space.pendingRemoteRecords.size > 0) remoteChanged = true;
    }
    return {
      state: this.#connectionState(),
      queueDepth,
      lastConvergedMs: this.#lastConvergedMs,
      remoteChanged,
      keyMode: "e2ee",
      revoked: this.#revoked,
    };
  }

  workspaceStatus(): WorkspaceSyncStatus {
    return this.#workspace?.status() ?? structuredClone(OFF_WORKSPACE_SYNC_STATUS);
  }

  pushStatus(): void {
    if (this.#statusTimer !== null) return;
    this.#statusTimer = setTimeout(() => {
      this.#statusTimer = null;
      this.#deps.publishStatus(this.status());
    }, STATUS_DEBOUNCE_MS);
    this.#statusTimer.unref();
  }

  /** Every device the hub currently sees (presence). */
  presence(): ReturnType<HubTransport["presence"]> {
    return this.#transport?.presence() ?? [];
  }

  /* --------------------------- per-origin controls --------------------------- */

  async originInfo(spaceId: string, host: string): Promise<SyncOriginInfo> {
    const normalized = normalizedHost(host);
    const space = this.#spaces.get(spaceId);
    const override = this.#overrides.overrideFor(normalized);
    const policy = matchOriginPolicy(this.#policies, normalized);
    const synced =
      space === undefined
        ? override === "sync" || (override !== "never" && policy.syncTier !== 0 && !policy.sensitive)
        : space.engine.getOriginPolicyFor(normalized).synced;
    let staged = false;
    let deferred = false;
    if (space !== undefined) {
      const matches = async (wire: CookieRecordWire): Promise<boolean> => {
        const identity = await space.engine.inspectRemoteIdentity(wire);
        if (identity === null) return false;
        const cookieHost = normalizedHost(identity.hostKey);
        return cookieHost === normalized || cookieHost.endsWith(`.${normalized}`);
      };
      for (const record of space.pendingRemoteRecords.values()) {
        if (await matches(record)) {
          staged = true;
          break;
        }
      }
      if (space.engine.deferredDepth > 0) {
        for (const wire of space.storage.all("deferred")) {
          if (await matches(wire)) {
            deferred = true;
            break;
          }
        }
      }
    }
    return {
      spaceId,
      host: normalized,
      tier: policy.syncTier,
      rotatingAuth: policy.rotatingAuth,
      sensitive: policy.sensitive,
      override,
      synced,
      staged,
      deferred,
    };
  }

  async setOriginOverride(
    spaceId: string,
    host: string,
    override: SyncOriginOverride | null,
  ): Promise<SyncOriginInfo> {
    const normalized = normalizedHost(host);
    if (normalized === "") throw new Error("a host is required");
    this.#overrides.set(normalized, override);
    for (const space of this.#spaces.values()) space.engine.setOriginOverride(normalized, override);
    // Opting an origin INTO sync must carry the session you already have, not
    // just future logins — re-seed existing cookies; the engine's isSynced
    // gate now lets this origin through while still dropping the rest.
    if (override === "sync") {
      for (const space of this.#spaces.values()) {
        if (space.hydrating) continue;
        void this.#seedExistingCookies(space, normalized).catch((err) => this.#logError(err));
      }
    }
    // Mirrored to control so every device of the account follows the choice.
    const control = this.#deps.control();
    if (control !== null) {
      const mirrored =
        override === null
          ? control.deleteSyncPolicyOverride(normalized)
          : control.setSyncPolicyOverride(normalized, override);
      mirrored.catch((err: unknown) => this.#logError(err));
    }
    return this.originInfo(spaceId, normalized);
  }

  /** Restore an origin's last-known-good state in one Space (kill switch). */
  async rollbackOrigin(spaceId: string, host: string): Promise<{ restored: number }> {
    const space = this.#spaces.get(spaceId);
    if (space === undefined) throw new Error(`sync is not running for Space ${spaceId}`);
    const originId = await computeOriginIdHex(space.keys.idKey, spaceId, normalizedHost(host));
    const snapshot: OriginSnapshot = space.snapshots.get(originId) ?? {
      spaceId,
      originId,
      capturedAtMs: 0,
      records: [],
    };
    await space.engine.rollbackOrigin(originId, snapshot);
    space.snapshots.set(originId, space.engine.snapshotOrigin(originId));
    this.pushStatus();
    return { restored: snapshot.records.filter((record) => !record.plain.deleted).length };
  }

  /** `sync:retry`: re-dial and drain both lanes. */
  async retry(): Promise<SyncStatus> {
    if (!this.#started) {
      this.start();
      return this.status();
    }
    if (this.#revoked) return this.status();
    this.#transport?.reconnect();
    for (const space of this.#spaces.values()) {
      await space.engine.flushPending();
      await space.engine.retryDeferred();
    }
    return this.status();
  }

  /* ------------------------------ workspace sync ------------------------------ */

  /**
   * Push, Pull/Merge, Refresh. Pull/Merge install the staged cookie records
   * first, then the tabs — the causal barrier that keeps a restored tab from
   * following a redirect before its session exists in Chromium. Push makes
   * this Mac's session state authoritative, which is refused while the cloud
   * browser drives an origin here (§10.2).
   */
  async runWorkspaceSync(action: WorkspaceSyncAction): Promise<WorkspaceSyncStatus> {
    const workspace = this.#workspace;
    if (workspace === null) throw new Error("Workspace sync is not running.");
    const generation = this.#syncGeneration;
    const operation = this.#workspaceQueue.then(async () => {
      if (generation !== this.#syncGeneration || this.#workspace !== workspace) {
        throw new Error("Sync connection changed — try again");
      }
      if (action.kind === "push") {
        if ([...this.#spaces.values()].some((space) => space.engine.deferredDepth > 0)) {
          throw new Error("cloud run in progress: this Mac's session state cannot be pushed while the cloud browser drives it");
        }
        for (const space of this.#spaces.values()) await this.#pushLocalSessionState(space);
      } else if (action.kind === "pull") {
        const reload = await this.#applyPendingSessions();
        await workspace.run(action);
        for (const spaceId of reload) this.#deps.browser()?.reloadSpace(spaceId);
        this.pushStatus();
        return;
      }
      await workspace.run(action);
      this.pushStatus();
    });
    this.#workspaceQueue = operation.catch(() => undefined);
    await operation;
    return this.workspaceStatus();
  }

  /* -------------------------------- internals -------------------------------- */

  async #startAsync(generation: number): Promise<void> {
    const live = (): boolean => generation === this.#syncGeneration && this.#started;
    // The origin corpus and overrides from control, with the bundled fallback (D17).
    await this.#loadPolicy();
    if (!live()) return;
    await this.#registry.refresh();
    if (!live()) return;
    const transport = await this.#resolveTransport(generation);
    if (!live() || transport === null) return;
    this.#transport = transport;
    const browser = await this.#awaitBrowser(generation);
    if (!live() || browser === null) return;
    await this.#startSync(generation);
  }

  /** Build the workspace lane and every Space's engine on the current transport, then dial. */
  async #startSync(generation: number): Promise<void> {
    const transport = this.#transport;
    if (transport === null) return;
    const workspaceSecret = this.#deps.device.workspaceSecret();
    if (workspaceSecret !== null) {
      const keys = await deriveSpaceKeys(WORKSPACE_PSEUDO_SPACE_ID, workspaceSecret);
      if (generation !== this.#syncGeneration || !this.#started) return;
      const workspace = new WorkspaceSyncService({
        deviceId: this.#deps.device.deviceId,
        deviceName: () => this.#deps.device.deviceName,
        privateKey: this.#deps.device.identity().signingKey,
        verifyDoc: (wire) => this.#registry.verifyWorkspace(wire),
        keys,
        spaces: this.#deps.spaces,
        records: this.#deps.records,
        restorePoint: () => this.#deps.restorePoint(),
        applyRestorePoint: async (session, spaceId, mode) => {
          const browser = this.#deps.browser();
          if (browser === null) throw new Error("the browser is not ready");
          await browser.applyDurableSession(session, spaceId, mode);
        },
        publish: (docs) => this.#transport?.publishWorkspace(docs),
        onStatusChanged: (status) => this.#deps.publishWorkspaceStatus(status),
        registersPath: join(syncDir(this.#deps.userDataDir), "workspace.json"),
        now: this.#now,
      });
      this.#workspace = workspace;
      workspace.start();
      this.#unsubscribeSession = this.#deps.onSessionPersisted(() => workspace.noteSessionPersisted());
    } else {
      console.warn("[sync] no workspace secret on this Mac; Spaces and restore points will not sync");
    }
    for (const space of this.#deps.spaces.all()) this.#declaredSpaceIds.add(space.id);
    for (const spaceId of [...this.#declaredSpaceIds]) {
      await this.#ensureSpace(spaceId, generation);
      if (generation !== this.#syncGeneration || !this.#started) return;
    }
    this.#unsubscribeSpaces = this.#deps.spaces.onChange((change) => {
      if (change.kind === "created") void this.addSpace(change.spaceId);
      else if (change.kind === "removed") this.removeSpace(change.spaceId);
    });
    transport.start([...this.#spaces.keys()]);
    this.#snapshotTimer = setInterval(() => {
      void this.#refreshAllSnapshots().catch((err) => this.#logError(err));
    }, SNAPSHOT_REFRESH_MS);
    this.#snapshotTimer.unref();
    this.#retryTimer = setInterval(() => {
      for (const space of this.#spaces.values()) {
        void space.engine.retryDeferred().catch((err) => this.#logError(err));
        // The default lane holds what a `rate_limited` (or unrecognised) ack
        // shelved; without this it waits for the next capture or reconnect.
        void space.engine.flushPending().catch((err) => this.#logError(err));
      }
    }, this.#deps.retryDeferredIntervalMs ?? RETRY_DEFERRED_INTERVAL_MS);
    this.#retryTimer.unref();
    this.#registryTimer = setInterval(() => void this.#registry.refresh(), REGISTRY_REFRESH_MS);
    this.#registryTimer.unref();
    this.pushStatus();
  }

  async #loadPolicy(): Promise<void> {
    const control = this.#deps.control();
    if (control === null) return;
    try {
      const policy = await control.syncPolicy();
      const origins = Array.isArray(policy.origins) ? policy.origins.filter(isOriginPolicy) : [];
      if (origins.length > 0) this.#policies = origins;
      if (typeof policy.overrides === "object" && policy.overrides !== null) {
        this.#overrides.adopt(policy.overrides);
        // What this Mac chose while control was away follows now.
        for (const [host, mode] of Object.entries(this.#overrides.all())) {
          if (policy.overrides[host] !== mode) {
            control.setSyncPolicyOverride(host, mode).catch(() => undefined);
          }
        }
      }
    } catch {
      // Bundled corpus and local overrides stand until control answers.
    }
  }

  /**
   * The hub, per §10.2: the env pin, else `/me`'s hubUrl (waiting briefly for
   * discovery), else the loopback in development. A packaged build with no
   * hub known keeps checking and dials once discovery names one.
   */
  async #resolveTransport(generation: number): Promise<HubTransport | null> {
    if (!this.#deps.hubUrlPinned) {
      const deadline = this.#now() + (this.#deps.discoveryWaitMs ?? DISCOVERY_WAIT_MS);
      while (this.#deps.hubUrl() === null && this.#now() < deadline) {
        await sleep(DISCOVERY_POLL_MS);
        if (generation !== this.#syncGeneration || !this.#started) return null;
      }
    }
    const url = this.#deps.hubUrl();
    if (url === null && this.#deps.packaged) {
      this.#hubCheckTimer = setInterval(() => {
        const discovered = this.#deps.hubUrl();
        if (discovered === null || !this.#started) return;
        if (this.#hubCheckTimer !== null) clearInterval(this.#hubCheckTimer);
        this.#hubCheckTimer = null;
        this.#swapHub(discovered);
      }, HUB_RECHECK_MS);
      this.#hubCheckTimer.unref();
      return null;
    }
    this.#hubUrl = url;
    if (url === null && !this.#deps.packaged) {
      // A dev build with no hub still re-checks: `pnpm dev` with control up
      // but /me answering late should move to the real hub.
      this.#hubCheckTimer = setInterval(() => {
        const discovered = this.#deps.hubUrl();
        if (discovered === null || !this.#started) return;
        if (this.#hubCheckTimer !== null) clearInterval(this.#hubCheckTimer);
        this.#hubCheckTimer = null;
        this.#swapHub(discovered);
      }, HUB_RECHECK_MS);
      this.#hubCheckTimer.unref();
    }
    return this.#buildTransport(url);
  }

  #buildTransport(url: string | null): HubTransport {
    if (this.#deps.transportFactory !== undefined) return this.#deps.transportFactory(url, this.#transportEvents);
    return url === null
      ? new LoopbackTransport(this.#deps.device.deviceId, "desktop", this.#transportEvents)
      : new WsTransport(url, this.#deps.device.deviceId, "desktop", this.#transportEvents);
  }

  /**
   * Discovery named a hub after we started on the loopback (or nothing):
   * rebuild every engine against a WsTransport. The engines captured the old
   * transport by value at construction, so a bare swap would leave cookie
   * sync publishing into the dead loopback.
   */
  #swapHub(url: string): void {
    if (url === this.#hubUrl) return;
    const previous = this.#transport;
    const generation = ++this.#syncGeneration;
    this.#clearTimers();
    this.#unsubscribeSpaces?.();
    this.#unsubscribeSpaces = null;
    this.#unsubscribeSession?.();
    this.#unsubscribeSession = null;
    this.#workspace?.stop();
    this.#workspace = null;
    for (const space of this.#spaces.values()) {
      space.capture.detach();
      space.storage.flush();
    }
    this.#spaces.clear();
    this.#pending.clear();
    this.#workspaceQueue = Promise.resolve();
    previous?.stop();
    this.#hubUrl = url;
    this.#transport = this.#buildTransport(url);
    void this.#startSync(generation).catch((err) => this.#logError(err));
  }

  async #awaitBrowser(generation: number): Promise<SyncBrowser | null> {
    for (;;) {
      const browser = this.#deps.browser();
      if (browser !== null) return browser;
      await sleep(BROWSER_POLL_MS);
      if (generation !== this.#syncGeneration || !this.#started) return null;
    }
  }

  #ensureSpace(spaceId: string, generation: number): Promise<void> {
    if (this.#spaces.has(spaceId)) return Promise.resolve();
    const pending = this.#pending.get(spaceId);
    if (pending !== undefined) return pending;
    const setup = this.#setupSpace(spaceId, generation)
      .catch((err: unknown) => this.#logError(err))
      .finally(() => {
        if (this.#pending.get(spaceId) === setup) this.#pending.delete(spaceId);
      });
    this.#pending.set(spaceId, setup);
    return setup;
  }

  async #setupSpace(spaceId: string, generation: number): Promise<void> {
    const transport = this.#transport;
    const browser = this.#deps.browser();
    if (transport === null || browser === null) return;
    if (this.#deps.spaces.get(spaceId) === null) {
      // The Space went away mid-flight; onSessionCreated may have shut the gate.
      browser.markSessionReady(spaceId);
      return;
    }
    // A fork made a moment ago gets its root secret asynchronously.
    let rootSecret = this.#deps.device.spaceSecret(spaceId);
    for (let attempt = 0; rootSecret === null && attempt < SECRET_WAIT_ATTEMPTS; attempt += 1) {
      await sleep(this.#deps.secretWaitMs ?? SECRET_WAIT_MS);
      if (generation !== this.#syncGeneration || !this.#started) {
        browser.markSessionReady(spaceId);
        return;
      }
      rootSecret = this.#deps.device.spaceSecret(spaceId);
    }
    if (rootSecret === null) {
      console.warn(`[sync] Space ${spaceId} has no root secret on this Mac; its cookies will not sync`);
      // Nothing will ever hydrate this Space: release its held page loads now
      // instead of stranding them until the gate's 15 s safety timeout.
      browser.markSessionReady(spaceId);
      return;
    }
    browser.markSessionHydrating(spaceId);
    const keys = await deriveSpaceKeys(spaceId, rootSecret);
    if (generation !== this.#syncGeneration || !this.#started) {
      browser.markSessionReady(spaceId);
      return;
    }
    const ses = browser.sessionFor(spaceId);
    const storage = new FileQueueStorage(queueFilePath(this.#deps.userDataDir, spaceId));
    const identity = this.#deps.device.identity();
    const engine = new SpaceSyncEngine(
      spaceId,
      keys,
      { deviceId: this.#deps.device.deviceId, privateKey: identity.signingKey },
      transport,
      new ElectronCookieApplier(ses),
      {
        deviceId: this.#deps.device.deviceId,
        leaseKind: "desktop",
        verifier: this.#registry,
        queueStorage: storage,
        policies: this.#policies,
        now: this.#now,
        // A cloud run holds its origins exclusively (D10): park behind it, never force.
        deferToForeignLease: (denial) => denial.holderKind === "cloud",
      },
    );
    for (const [host, override] of Object.entries(this.#overrides.all())) engine.setOriginOverride(host, override);
    engine.setOnline(transport.state === "connected");
    await engine.beginHydration();
    const state: SpaceSyncState = {
      spaceId,
      engine,
      keys,
      storage,
      hydrating: true,
      recordQueue: Promise.resolve(),
      recordError: null,
      unappliable: new Set(),
      hydrationRetries: 0,
      capture: { detach: () => undefined, drain: async () => undefined },
      recordEpoch: 0,
      hasHydratedOnce: false,
      pendingRemoteRecords: new Map(),
      snapshots: new Map(),
    };
    state.capture = attachCookieCapture(
      ses,
      spaceId,
      engine,
      () => state.hydrating || (this.#bulkWrites.get(spaceId) ?? 0) > 0,
      (err) => this.#logError(err),
    );
    if (generation !== this.#syncGeneration || !this.#started) {
      state.capture.detach();
      browser.markSessionReady(spaceId);
      return;
    }
    this.#spaces.set(spaceId, state);
  }

  #onRecords(spaceId: string, records: CookieRecordWire[]): void {
    const space = this.#spaces.get(spaceId);
    if (space === undefined || records.length === 0) return;
    if (space.hasHydratedOnce) {
      const candidates: CookieRecordWire[] = [];
      for (const record of records) {
        // Hub echoes of this device's own acknowledged publish are not
        // remote work and must not light the sync button.
        if (record.hlc.deviceId === this.#deps.device.deviceId) continue;
        const applied = space.engine.getRecord(record.recordId);
        if (applied !== undefined && compareHlc(record.hlc, applied.hlc) <= 0) continue;
        candidates.push(record);
      }
      if (candidates.length === 0) return;
      // Rotating-auth and cloud-authored records are applied live, not
      // staged (see live-partition). Cookie-jar writes are transparent to
      // open tabs and per-record echo suppression absorbs the capture
      // feedback, so no navigation gate or reload is needed. Queue behind
      // recordQueue to serialize with hydration applies.
      space.recordQueue = space.recordQueue
        .then(async () => {
          if (this.#spaces.get(spaceId) !== space) return;
          const { autoApply, stage } = await partitionLiveRecords(space.engine, candidates, (deviceId) =>
            this.#registry.isCloudDevice(deviceId),
          );
          let stagedChanged = false;
          for (const record of stage) {
            const current = space.pendingRemoteRecords.get(record.recordId);
            if (current === undefined || compareHlc(record.hlc, current.hlc) > 0) {
              space.pendingRemoteRecords.set(record.recordId, record);
              stagedChanged = true;
            }
          }
          if (autoApply.length > 0) {
            autoApply.sort((a, b) => compareHlc(a.hlc, b.hlc));
            await space.engine.applyRemote(autoApply);
            for (const record of autoApply) {
              // A superseded staged copy of the same cookie must not keep
              // the sync pill lit or roll back on a later pull.
              const pending = space.pendingRemoteRecords.get(record.recordId);
              if (pending !== undefined && compareHlc(pending.hlc, record.hlc) <= 0) {
                space.pendingRemoteRecords.delete(record.recordId);
                stagedChanged = true;
              }
            }
          }
          if (stagedChanged) this.pushStatus();
        })
        .catch((err: unknown) => this.#logError(err));
      return;
    }
    // Close the browser-load gate synchronously, before a following
    // workspace frame can be handled. Reopen it only after these records
    // have reached Electron's cookie store.
    const epoch = ++space.recordEpoch;
    // Sign-out and revocation bump the generation. Records already queued
    // must stop applying at that point: `index.ts` clears each Space's
    // partition right after `onSignedOut`, so a snapshot still draining here
    // would write the signed-out account's cookies back into a jar that was
    // just wiped.
    const generation = this.#syncGeneration;
    this.#deps.browser()?.markSessionHydrating(spaceId);
    space.recordQueue = space.recordQueue
      .then(async () => {
        for (const record of records) {
          if (this.#syncGeneration !== generation) return;
          try {
            await space.engine.applyRemote([record]);
          } catch (err) {
            // A record Chromium permanently refuses (`__Host-`/`__Secure-`
            // prefix rules, SameSite=None without Secure) must not abort the
            // rest of the snapshot — and must not be re-fetched forever.
            if (!space.unappliable.has(record.recordId)) {
              space.unappliable.add(record.recordId);
              this.#logError(err);
            }
            space.recordError = err;
          }
        }
      })
      .catch((err: unknown) => {
        space.recordError = err;
        this.#logError(err);
      });
    void space.recordQueue.then(() => {
      if (this.#spaces.get(spaceId) === space && !space.hydrating && space.recordEpoch === epoch) {
        this.#deps.browser()?.markSessionReady(spaceId);
      }
    });
  }

  async #finishHydration(spaceId: string): Promise<void> {
    const space = this.#spaces.get(spaceId);
    if (space === undefined || !space.hydrating) return;
    // hydrate.done is only the end of the wire stream. The corresponding
    // record frame handlers may still be decrypting and writing Chromium's
    // cookie store, so tabs are not safe to load until this queue drains.
    await space.recordQueue;
    if (this.#spaces.get(spaceId) !== space || !space.hydrating) return;
    if (space.recordError !== null && space.hydrationRetries < MAX_HYDRATION_RETRIES) {
      // A torn snapshot is worth re-fetching, but a record this Mac can never
      // apply is not: re-dial a bounded number of times, backing off, while
      // the navigation barrier stays closed.
      space.hydrationRetries += 1;
      const base = this.#deps.hydrationRetryMs ?? SESSION_HYDRATION_RETRY_MS;
      const delay = base * 2 ** (space.hydrationRetries - 1);
      const timer = setTimeout(() => {
        if (this.#spaces.get(spaceId) === space && !space.hasHydratedOnce && space.hydrating) {
          this.#transport?.reconnect();
        }
      }, delay);
      timer.unref();
      return;
    }
    if (space.recordError !== null) {
      // Open the Space with the offending cookies skipped rather than holding
      // its page loads — and re-dialing the hub — for the rest of the session.
      console.warn(
        `[sync] Space ${spaceId} hydrated with ${space.unappliable.size} record(s) this Mac could not apply; ` +
          `those sites stay logged out here`,
      );
      space.recordError = null;
    }
    await space.engine.endHydration();
    space.hydrating = false;
    // Publish cookies that already existed in this session before sync
    // started watching — continuity carries the logins you ALREADY have,
    // and the 'changed' listener only ever sees future mutations. Runs after
    // hydration so it can skip anything a peer already sent (hasRecord).
    await this.#seedExistingCookies(space);
    await this.#refreshSnapshots(space);
    space.hasHydratedOnce = true;
    this.#lastConvergedMs = this.#now();
    this.pushStatus();
    this.#deps.browser()?.markSessionReady(spaceId);
  }

  /** Install every staged remote record; answers the Spaces whose jars changed. */
  async #applyPendingSessions(): Promise<string[]> {
    const changed: string[] = [];
    const browser = this.#deps.browser();
    for (const space of this.#spaces.values()) {
      if (space.pendingRemoteRecords.size === 0) continue;
      const records = [...space.pendingRemoteRecords.values()].sort((a, b) => compareHlc(a.hlc, b.hlc));
      browser?.markSessionHydrating(space.spaceId);
      space.hydrating = true;
      await space.engine.beginHydration();
      try {
        await space.engine.applyRemote(records);
        space.pendingRemoteRecords.clear();
        changed.push(space.spaceId);
      } finally {
        await space.engine.endHydration();
        space.hydrating = false;
        browser?.markSessionReady(space.spaceId);
      }
    }
    return changed;
  }

  /** Make the local cookie set authoritative, including remote-only deletion. */
  async #pushLocalSessionState(space: SpaceSyncState): Promise<void> {
    const browser = this.#deps.browser();
    if (browser === null) throw new Error("the browser is not ready");
    const ses = browser.sessionFor(space.spaceId);
    const localRecordIds = new Set<string>();
    try {
      for (const cookie of await ses.cookies.get({})) {
        const identity = identityForCookie(space.spaceId, portableCookieFromElectron(cookie));
        if (identity === null) continue;
        localRecordIds.add(await computeRecordIdHex(space.keys.idKey, identity));
      }
    } catch (err) {
      this.#logError(err);
      throw new Error("Could not read this Mac's session state");
    }
    for (const record of space.pendingRemoteRecords.values()) {
      if (localRecordIds.has(record.recordId)) continue;
      const identity = await space.engine.inspectRemoteIdentity(record);
      if (identity === null) continue;
      // The person chose "push this Mac's state": these deletions are intent,
      // not server churn, so they bypass the rotating-auth writer guard.
      await space.engine.localChange(identity, null, true, "explicit", { explicitIntent: true });
    }
    space.pendingRemoteRecords.clear();
    await this.#seedExistingCookies(space, undefined, true);
  }

  /** One-time reconcile: feed pre-existing local cookies the engine hasn't
   *  already recorded into the publish path (policy-gated inside the engine). */
  async #seedExistingCookies(space: SpaceSyncState, onlyHost?: string, force = false): Promise<void> {
    const browser = this.#deps.browser();
    if (browser === null) return;
    const ses = browser.sessionFor(space.spaceId);
    let cookies: Awaited<ReturnType<typeof ses.cookies.get>>;
    try {
      cookies = await ses.cookies.get({});
    } catch (err) {
      this.#logError(err);
      return;
    }
    for (const cookie of cookies) {
      const host = normalizedHost(cookie.domain ?? "");
      if (onlyHost !== undefined && host !== onlyHost && !host.endsWith(`.${onlyHost}`)) continue;
      const portable = portableCookieFromElectron(cookie);
      const identity = identityForCookie(space.spaceId, portable);
      if (identity === null) continue;
      try {
        if (!force && (await space.engine.hasRecord(identity))) continue;
        await space.engine.localChange(identity, attributesForCookie(portable), false, "explicit");
      } catch (err) {
        this.#logError(err);
      }
    }
  }

  async #refreshAllSnapshots(): Promise<void> {
    for (const space of this.#spaces.values()) {
      if (!space.hydrating) await this.#refreshSnapshots(space);
    }
  }

  async #refreshSnapshots(space: SpaceSyncState): Promise<void> {
    const originIds = new Set<string>();
    for (const plain of space.engine.listLiveCookies()) {
      originIds.add(await computeOriginIdHex(space.keys.idKey, space.spaceId, plain.identity.hostKey));
    }
    for (const originId of originIds) space.snapshots.set(originId, space.engine.snapshotOrigin(originId));
  }

  #connectionState(): SyncStatus["state"] {
    if (this.#revoked) return "off";
    const transport = this.#transport;
    if (transport === null) return this.#started ? "connecting" : "off";
    switch (transport.state) {
      case "connected":
        return "connected";
      case "connecting":
        return "connecting";
      case "offline":
        // The session plane is unreachable: "Sync paused" and the queue depth; mutations keep queueing.
        return "paused";
      case "off":
        return "off";
    }
  }

  #clearTimers(): void {
    for (const timer of [this.#snapshotTimer, this.#retryTimer, this.#hubCheckTimer, this.#registryTimer]) {
      if (timer !== null) clearInterval(timer);
    }
    this.#snapshotTimer = null;
    this.#retryTimer = null;
    this.#hubCheckTimer = null;
    this.#registryTimer = null;
    if (this.#statusTimer !== null) clearTimeout(this.#statusTimer);
    this.#statusTimer = null;
  }

  #logError(err: unknown): void {
    console.error("[sync]", err);
  }
}

function isOriginPolicy(value: unknown): value is OriginPolicy {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw["domain"] === "string" &&
    typeof raw["label"] === "string" &&
    (raw["mode"] === "portable" || raw["mode"] === "assisted" || raw["mode"] === "device_bound") &&
    (raw["syncTier"] === 0 || raw["syncTier"] === 1 || raw["syncTier"] === 2) &&
    typeof raw["rotatingAuth"] === "boolean" &&
    typeof raw["sensitive"] === "boolean"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
