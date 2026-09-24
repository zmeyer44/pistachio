/**
 * WorkspaceSyncService — account-global workspace metadata and per-device
 * restore points (docs/cloud-sync-design.md §10.2, D9).
 *
 * Four lanes share the workspace stream:
 *
 *  - `space:<id>` and `settings:<field>` are global LWW docs. A local change
 *    (SpaceStore.onChange) stamps the register with a fresh HLC and publishes
 *    it (debounced); a remote doc is merged LWW+HLC (workspace-map.ts) and a
 *    winner applied through SpaceStore.upsertRemote / removeRemote, which
 *    report the change as remote so it is never echoed back out.
 *  - `device-workspace:<deviceId>` is this device's sealed restore point,
 *    published 40 ms after the tab session persists and on demand ("Push").
 *    Other devices' restore points are offered for Pull/Merge and applied
 *    through BrowserController.applyDurableSession; nothing here ever
 *    rewrites another device's tabs.
 *  - `device-activity:<deviceId>` is a liveness card, refreshed every minute
 *    and on a Space change, used to name restore points in the settings page.
 *  - `bookmark:<id>`, `reminder:<id>`, `memory:<id>`, `artifact:<id>`,
 *    `note:<id>` and `note-blob:<id>` are the account's
 *    personal records: one global LWW doc each, travelling the same way as
 *    `space:` — a local write (WorkspaceRecordStore.onChange) stamps and
 *    publishes; a remote winner goes back through applyRemote/removeRemote,
 *    which do not report a local change and so are never echoed. Memory is
 *    versioned, and EVERY VERSION IS ITS OWN REGISTER keyed by its own id, so
 *    a correction never races the fact it corrects; `isLatest` is derived by
 *    the receiving store, not taken from the wire. Artifact records carry
 *    their HTML inside the same encrypted document, and a note its markdown;
 *    a note's images travel as their own `note-blob:` registers, so a
 *    keystroke re-seals the text alone (docs/notes.md N3).
 *
 * Every doc is sealed under the account workspace key (deriveSpaceKeys over
 * `__workspace__` and the workspace secret), stamped with the workspace HLC
 * clock, and signed with the device key. The registers' HLCs and the clock
 * persist in `<userData>/sync/workspace.json`, so a restart never re-stamps a
 * stale local doc over a newer remote one. A register with no persisted HLC
 * is "unstamped": the account's copy wins on the first hydration (a joining
 * Mac inherits the account's Spaces), and what remains local-only is stamped
 * and published then.
 */

import {
  boundRestorePoint,
  compareHlc,
  fromBase64,
  fromUtf8,
  HlcClock,
  open,
  seal,
  toBase64,
  utf8,
  workspaceKeyFor,
  workspaceSealAad,
  workspaceSigningBytes,
  DEFAULT_WORKSPACE_SETTINGS,
  type DeviceActivityDoc,
  type DeviceWorkspaceDoc,
  type DurableTabSession,
  type Hlc,
  type SpaceKeys,
  type WorkspaceDoc,
  type WorkspaceRecordWire,
} from "@pistachio/sync-protocol";
import type { RemoteRestorePoint, WorkspaceSyncAction, WorkspaceSyncStatus } from "@pistachio/shell-contracts/ipc";
import { sanitizeSpaceInfo, type SpaceInfo } from "@pistachio/shell-contracts/spaces";
import type { SpaceChange } from "../space-store";
import { atomicWriteJsonSync, readJsonFile } from "./queue-file";
import {
  DEVICE_ACTIVITY_KEY_PREFIX,
  DEVICE_WORKSPACE_KEY_PREFIX,
  decideMerge,
  deviceIdOfKey,
  docsForState,
  readDeviceActivityDoc,
  readDeviceWorkspaceDoc,
  readRecordDoc,
  recordDocFor,
  recordKeyOf,
  recordKeyParts,
  recordOfDoc,
  restorePointInfo,
  SETTINGS_KEY_PREFIX,
  spaceDocFor,
  spaceIdOfKey,
  WORKSPACE_RECORD_KINDS,
  type IncomingWorkspaceDoc,
  type WorkspaceRecordKind,
  type WorkspaceRegister,
} from "./workspace-map";

export { WORKSPACE_RECORD_KINDS, type WorkspaceRecordKind } from "./workspace-map";

/** Restore points stay current while coalescing redirect bursts. */
export const RESTORE_POINT_DEBOUNCE_MS = 40;
const PUBLISH_RETRY_MS = 1_000;
export const ACTIVITY_INTERVAL_MS = 60_000;

/** The Space store surface workspace sync uses; the real SpaceStore or a test double. */
export interface WorkspaceSpaceStore {
  all(): SpaceInfo[];
  get(spaceId: string): SpaceInfo | null;
  activeId(): string;
  onChange(listener: (change: SpaceChange) => void): () => void;
  upsertRemote(value: unknown): SpaceInfo | null;
  removeRemote(spaceId: string): boolean;
}

/**
 * The personal-record surface workspace sync uses — the real stores through
 * the sync/records.ts adapter, or a test double. One seam for all three
 * kinds: they differ only in what a record IS, which is the store's business
 * and not this lane's.
 *
 * A record is opaque here: it is whatever `all`/`get` hand back and whatever
 * `applyRemote` accepts, sealed as-is. Validation belongs to the store, next
 * to the type it validates.
 */
export interface WorkspaceRecordStore {
  /** Every record of `kind` this Mac holds. */
  all(kind: WorkspaceRecordKind): unknown[];
  /** One record, or null when it is gone. */
  get(kind: WorkspaceRecordKind, id: string): unknown;
  /** Write a record another device published. Must NOT report a local change. */
  applyRemote(kind: WorkspaceRecordKind, record: unknown): void;
  /** Drop a record another device deleted. Must NOT report a local change. */
  removeRemote(kind: WorkspaceRecordKind, id: string): void;
  /** Hear which record a LOCAL write touched. */
  onChange(listener: (kind: WorkspaceRecordKind, id: string) => void): () => void;
}

export interface WorkspaceSyncDeps {
  deviceId: string;
  deviceName(): string;
  /** Device Ed25519 signing key — every published doc is device-signed. */
  privateKey: CryptoKey;
  /**
   * Verifies a remote doc's device signature against the enrolled-device
   * registry (D15). A doc that fails is dropped whole: the hub keeps the
   * ciphertext of every doc it ever saw, so without this it could re-serve an
   * old `space:` value under a fabricated newer HLC.
   */
  verifyDoc(wire: WorkspaceRecordWire): Promise<boolean>;
  /** Account workspace keys (WORKSPACE_PSEUDO_SPACE_ID derivation). */
  keys: SpaceKeys;
  spaces: WorkspaceSpaceStore;
  /** Bookmarks, reminders, and memory (sync/records.ts). */
  records: WorkspaceRecordStore;
  /** This device's current restore point (TabSessionStore.get). */
  restorePoint(): DurableTabSession;
  /** Rebuild one Space's tabs from another device's restore point (BrowserController.applyDurableSession). */
  applyRestorePoint(session: DurableTabSession, spaceId: string, mode: "replace" | "merge"): Promise<void>;
  publish(docs: WorkspaceRecordWire[]): void;
  onStatusChanged?(status: WorkspaceSyncStatus): void;
  /** Where the registers' HLCs and the clock persist; null keeps them in memory (tests). */
  registersPath: string | null;
  now?(): number;
  activityIntervalMs?: number;
}

interface Register extends WorkspaceRegister {
  /** False until the doc has an HLC of its own (persisted or minted after hydration). */
  stamped: boolean;
}

interface PersistedRegisters {
  version: 1;
  clock: Hlc | null;
  registers: Record<string, Hlc>;
}

function isHlc(value: unknown): value is Hlc {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["physicalMs"] === "number" && typeof v["logical"] === "number" && typeof v["deviceId"] === "string";
}

function readPersisted(value: unknown): PersistedRegisters {
  const empty: PersistedRegisters = { version: 1, clock: null, registers: {} };
  if (typeof value !== "object" || value === null) return empty;
  const raw = value as Record<string, unknown>;
  if (raw["version"] !== 1 || typeof raw["registers"] !== "object" || raw["registers"] === null) return empty;
  const registers: Record<string, Hlc> = {};
  for (const [key, hlc] of Object.entries(raw["registers"] as Record<string, unknown>)) {
    if (isHlc(hlc)) registers[key] = { ...hlc };
  }
  return { version: 1, clock: isHlc(raw["clock"]) ? { ...raw["clock"] } : null, registers };
}

export class WorkspaceSyncService {
  readonly #deps: WorkspaceSyncDeps;
  readonly #now: () => number;
  readonly #clock: HlcClock;
  readonly #registers = new Map<string, Register>();
  readonly #dirty = new Set<string>();
  readonly #remoteRestorePoints = new Map<string, { doc: DeviceWorkspaceDoc; hlc: Hlc }>();
  readonly #remoteActivity = new Map<string, { doc: DeviceActivityDoc; hlc: Hlc }>();
  #restorePointDirty = false;
  #activityDirty = false;
  #publishTimer: NodeJS.Timeout | null = null;
  #activityTimer: NodeJS.Timeout | null = null;
  #unsubscribe: (() => void) | null = null;
  #unsubscribeRecords: (() => void) | null = null;
  #started = false;
  #remoteReady = false;
  #applyingRemote = false;
  #running = false;
  #lastRunMs: number | null = null;
  #lastPushMs: number | null = null;
  #error: string | null = null;
  /** Remote docs dropped for a bad or unknown device signature. */
  #dropped = 0;
  /** Serializes flushes so two publishes never interleave their seals. */
  #flushing: Promise<void> = Promise.resolve();

  constructor(deps: WorkspaceSyncDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#clock = new HlcClock(deps.deviceId, this.#now);
    const persisted = deps.registersPath === null ? readPersisted(null) : readPersisted(readJsonFile(deps.registersPath));
    if (persisted.clock !== null) this.#clock.restore(persisted.clock);
    // Every persisted key starts as a tombstone register; the seed below
    // fills in the docs that still exist locally.
    for (const [key, hlc] of Object.entries(persisted.registers)) {
      this.#registers.set(key, { doc: null, hlc, stamped: true });
    }
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#seedRegisters();
    this.#unsubscribe = this.#deps.spaces.onChange((change) => this.#onSpaceChange(change));
    this.#unsubscribeRecords = this.#deps.records.onChange((kind, id) => this.#onRecordChange(kind, id));
    const interval = this.#deps.activityIntervalMs ?? ACTIVITY_INTERVAL_MS;
    this.#activityTimer = setInterval(() => this.noteActivity(), interval);
    this.#activityTimer.unref();
    this.#pushStatus();
  }

  stop(): void {
    this.#started = false;
    this.#remoteReady = false;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#unsubscribeRecords?.();
    this.#unsubscribeRecords = null;
    if (this.#publishTimer !== null) clearTimeout(this.#publishTimer);
    this.#publishTimer = null;
    if (this.#activityTimer !== null) clearInterval(this.#activityTimer);
    this.#activityTimer = null;
    this.#persist();
  }

  /** The workspace stream finished hydrating (also on every reconnect): reconcile-publish. */
  async handleHydrated(): Promise<void> {
    if (!this.#started) return;
    this.#remoteReady = true;
    // What the account did not have is this Mac's to introduce.
    for (const [key, register] of this.#registers) {
      if (!register.stamped) {
        register.stamped = true;
        register.hlc = this.#clock.send();
      }
      // A register carrying a peer's HLC is already on the hub and is not ours
      // to re-sign; dirtying it would leave a key that `#flush` can never
      // retire.
      if (register.hlc.deviceId === this.#deps.deviceId) this.#dirty.add(key);
    }
    this.#restorePointDirty = true;
    this.#activityDirty = true;
    this.#persist();
    await this.#flush();
    this.#pushStatus();
  }

  /** The tab session persisted: this device's restore point follows shortly. */
  noteSessionPersisted(): void {
    if (!this.#started) return;
    this.#restorePointDirty = true;
    this.#schedulePublish(RESTORE_POINT_DEBOUNCE_MS);
  }

  /** Refresh this device's liveness card. */
  noteActivity(): void {
    if (!this.#started) return;
    this.#activityDirty = true;
    this.#schedulePublish(RESTORE_POINT_DEBOUNCE_MS);
  }

  status(): WorkspaceSyncStatus {
    return {
      state: !this.#started
        ? "off"
        : this.#error !== null
          ? "error"
          : this.#running || !this.#remoteReady
            ? "syncing"
            : "idle",
      lastRunMs: this.#lastRunMs,
      lastPushMs: this.#lastPushMs,
      remoteRestorePoints: this.remoteRestorePoints(),
      error: this.#error,
    };
  }

  /** Other devices' restore points, newest first. */
  remoteRestorePoints(): RemoteRestorePoint[] {
    const points: RemoteRestorePoint[] = [];
    for (const [deviceId, { doc }] of this.#remoteRestorePoints) {
      if (deviceId === this.#deps.deviceId) continue;
      points.push(restorePointInfo(doc, this.#remoteActivity.get(deviceId)?.doc ?? null));
    }
    return points.sort((a, b) => b.savedAtMs - a.savedAtMs || a.deviceId.localeCompare(b.deviceId));
  }

  /** The restore point another device published, for the caller that applies it. */
  remoteRestorePoint(deviceId: string): DeviceWorkspaceDoc | null {
    return this.#remoteRestorePoints.get(deviceId)?.doc ?? null;
  }

  /** Push, Pull/Merge, or Refresh (§10.5 `workspaceSync:run`). */
  async run(action: WorkspaceSyncAction): Promise<WorkspaceSyncStatus> {
    if (!this.#started) throw new Error("Workspace sync is not running.");
    if (!this.#remoteReady) throw new Error("The workspace is still loading from the account — try again shortly.");
    if (this.#running) throw new Error("A workspace sync is already running.");
    this.#running = true;
    this.#pushStatus();
    try {
      switch (action.kind) {
        case "push":
          this.#restorePointDirty = true;
          this.#activityDirty = true;
          await this.#flush();
          break;
        case "pull": {
          const point = this.#remoteRestorePoints.get(action.deviceId)?.doc;
          if (point === undefined || action.deviceId === this.#deps.deviceId)
            throw new Error("That device's restore point is no longer available.");
          const wanted = action.spaceIds ?? Object.keys(point.session.spaces);
          let applied = 0;
          for (const spaceId of new Set(wanted)) {
            if (point.session.spaces[spaceId] === undefined || this.#deps.spaces.get(spaceId) === null) continue;
            await this.#deps.applyRestorePoint(point.session, spaceId, action.mode);
            applied += 1;
          }
          if (applied === 0) throw new Error("None of that restore point's Spaces exist on this Mac.");
          break;
        }
        case "refresh":
          for (const [key, register] of this.#registers) {
            if (register.stamped && register.hlc.deviceId === this.#deps.deviceId) this.#dirty.add(key);
          }
          this.#restorePointDirty = true;
          this.#activityDirty = true;
          await this.#flush();
          break;
      }
      this.#error = null;
      this.#lastRunMs = this.#now();
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.#running = false;
      this.#pushStatus();
    }
    return this.status();
  }

  /** Workspace docs from the hub (fan-out or hydration). */
  async handleRemoteDocs(docs: WorkspaceRecordWire[]): Promise<void> {
    const incoming: IncomingWorkspaceDoc[] = [];
    let restorePointsChanged = false;
    for (const wire of docs) {
      // Before the clock, the seal, and the merge: a forged HLC must not even
      // pull this device's clock forward.
      if (!(await this.#deps.verifyDoc(wire))) {
        this.#dropped += 1;
        if (this.#dropped === 1 || this.#dropped % 100 === 0) {
          console.warn(
            `[workspace-sync] dropped ${this.#dropped} doc(s) whose device signature does not verify ` +
              `(latest: ${wire.key} from ${wire.hlc.deviceId})`,
          );
        }
        continue;
      }
      this.#clock.receive(wire.hlc);
      let value: unknown;
      try {
        value = await this.#openValue(wire);
      } catch {
        // Sealed under a different account workspace key (or tampered) —
        // unreadable by design; skip.
        continue;
      }
      const key = wire.key;
      const spaceId = spaceIdOfKey(key);
      if (spaceId !== null) {
        const doc = value === null ? null : readSpaceDoc(spaceId, value);
        if (doc === undefined) continue;
        incoming.push({ key, value: doc, hlc: wire.hlc });
        continue;
      }
      if (key.startsWith(SETTINGS_KEY_PREFIX)) {
        // Only the HLC matters: the one field, keyMode, is always e2ee.
        incoming.push({ key, value: readSettingsDoc(value), hlc: wire.hlc });
        continue;
      }
      const recordParts = recordKeyParts(key);
      if (recordParts !== null) {
        const doc = value === null ? null : readRecordDoc(recordParts.kind, recordParts.id, value);
        if (doc === undefined) continue;
        incoming.push({ key, value: doc, hlc: wire.hlc });
        continue;
      }
      const restoreDeviceId = deviceIdOfKey(key, DEVICE_WORKSPACE_KEY_PREFIX);
      if (restoreDeviceId !== null) {
        if (restoreDeviceId === this.#deps.deviceId) continue;
        const current = this.#remoteRestorePoints.get(restoreDeviceId);
        if (current !== undefined && compareHlc(wire.hlc, current.hlc) <= 0) continue;
        if (value === null) {
          if (this.#remoteRestorePoints.delete(restoreDeviceId)) restorePointsChanged = true;
          continue;
        }
        const doc = readDeviceWorkspaceDoc(restoreDeviceId, value);
        if (doc === null) continue;
        this.#remoteRestorePoints.set(restoreDeviceId, { doc, hlc: wire.hlc });
        restorePointsChanged = true;
        continue;
      }
      const activityDeviceId = deviceIdOfKey(key, DEVICE_ACTIVITY_KEY_PREFIX);
      if (activityDeviceId !== null) {
        if (activityDeviceId === this.#deps.deviceId || value === null) continue;
        const current = this.#remoteActivity.get(activityDeviceId);
        if (current !== undefined && compareHlc(wire.hlc, current.hlc) <= 0) continue;
        const doc = readDeviceActivityDoc(activityDeviceId, value);
        if (doc === null) continue;
        this.#remoteActivity.set(activityDeviceId, { doc, hlc: wire.hlc });
        restorePointsChanged = true;
      }
    }
    if (incoming.length > 0) this.#mergeIncoming(incoming);
    if (restorePointsChanged || incoming.length > 0) this.#pushStatus();
  }

  /** Write the registers now — the process is about to exit. */
  flush(): void {
    this.#persist();
  }

  /* ------------------------------ internals ------------------------------ */

  #seedRegisters(): void {
    const docs = docsForState({ spaces: this.#deps.spaces.all(), settings: DEFAULT_WORKSPACE_SETTINGS });
    for (const kind of WORKSPACE_RECORD_KINDS) {
      for (const record of this.#deps.records.all(kind)) docs.push(recordDocFor(kind, record));
    }
    const live = new Set<string>();
    for (const doc of docs) {
      const key = keyOf(doc);
      live.add(key);
      const register = this.#registers.get(key);
      if (register === undefined) {
        this.#registers.set(key, { doc, hlc: { physicalMs: 0, logical: 0, deviceId: this.#deps.deviceId }, stamped: false });
      } else {
        register.doc = doc;
      }
    }
    // A persisted register with no local doc is a tombstone: the Space was
    // removed here (possibly while sync was off) and the account must hear it.
    for (const [key, register] of this.#registers) {
      if (!live.has(key) && register.doc === null && register.stamped) this.#dirty.add(key);
    }
  }

  #onSpaceChange(change: SpaceChange): void {
    if (this.#applyingRemote || change.remote) {
      if (change.kind === "active") this.noteActivity();
      return;
    }
    if (change.kind === "active") {
      this.noteActivity();
      return;
    }
    const key = `space:${change.spaceId}`;
    const space = this.#deps.spaces.get(change.spaceId);
    if (change.kind !== "removed" && space === null) return;
    const doc = change.kind === "removed" || space === null ? null : spaceDocFor(space);
    const register = this.#registers.get(key);
    const hlc = this.#clock.send();
    if (register === undefined) this.#registers.set(key, { doc, hlc, stamped: true });
    else {
      register.doc = doc;
      register.hlc = hlc;
      register.stamped = true;
    }
    this.#dirty.add(key);
    this.#persist();
    this.#schedulePublish(RESTORE_POINT_DEBOUNCE_MS);
    this.noteActivity();
  }

  /**
   * A bookmark, reminder, or memory version changed on this Mac. Same lane as
   * `#onSpaceChange`: stamp the register, mark it dirty, and let the debounce
   * coalesce a burst (an agent writing five facts publishes once).
   */
  #onRecordChange(kind: WorkspaceRecordKind, id: string): void {
    if (this.#applyingRemote) return;
    const key = recordKeyOf(kind, id);
    const record = this.#deps.records.get(kind, id);
    // Gone means gone: a deleted record is a tombstone, not a missing doc.
    const doc = record === null || record === undefined ? null : recordDocFor(kind, record);
    const register = this.#registers.get(key);
    const hlc = this.#clock.send();
    if (register === undefined) this.#registers.set(key, { doc, hlc, stamped: true });
    else {
      register.doc = doc;
      register.hlc = hlc;
      register.stamped = true;
    }
    this.#dirty.add(key);
    this.#persist();
    this.#schedulePublish(RESTORE_POINT_DEBOUNCE_MS);
  }

  #mergeIncoming(incoming: IncomingWorkspaceDoc[]): void {
    const stamped: Record<string, WorkspaceRegister> = {};
    for (const [key, register] of this.#registers) {
      if (register.stamped) stamped[key] = { doc: register.doc, hlc: register.hlc };
    }
    const decision = decideMerge(stamped, incoming);
    this.#applyingRemote = true;
    try {
      for (const doc of decision.apply) {
        let value = doc.value;
        const parts = recordKeyParts(doc.key);
        if (parts !== null) {
          if (value === null) this.#deps.records.removeRemote(parts.kind, parts.id);
          else {
            this.#deps.records.applyRemote(parts.kind, recordOfDoc(value));
            // What the store made of it is what the register holds, so a
            // later doc is compared against what this Mac actually has.
            const applied = this.#deps.records.get(parts.kind, parts.id);
            if (applied === null || applied === undefined) continue; // the store refused it
            value = recordDocFor(parts.kind, applied);
          }
          this.#registers.set(doc.key, { doc: value, hlc: doc.hlc, stamped: true });
          continue;
        }
        const spaceId = spaceIdOfKey(doc.key);
        if (spaceId !== null) {
          if (doc.value === null) {
            if (!this.#deps.spaces.removeRemote(spaceId)) {
              // The default Space never goes: republish ours so the account converges back.
              const register = this.#registers.get(doc.key);
              if (register !== undefined) {
                register.hlc = this.#clock.send();
                register.stamped = true;
                this.#dirty.add(doc.key);
                this.#schedulePublish(RESTORE_POINT_DEBOUNCE_MS);
              }
              continue;
            }
          } else if (this.#deps.spaces.upsertRemote(doc.value) === null) {
            continue; // not a Space this Mac accepts
          }
        }
        this.#registers.set(doc.key, { doc: doc.value, hlc: doc.hlc, stamped: true });
      }
      for (const doc of decision.adoptHlc) {
        const register = this.#registers.get(doc.key);
        if (register !== undefined) {
          register.hlc = doc.hlc;
          register.stamped = true;
        }
      }
    } finally {
      this.#applyingRemote = false;
    }
    if (decision.apply.length > 0 || decision.adoptHlc.length > 0) this.#persist();
  }

  #schedulePublish(delayMs: number): void {
    if (this.#publishTimer !== null) return;
    this.#publishTimer = setTimeout(() => {
      this.#publishTimer = null;
      void this.#flush().catch((error: unknown) => console.error("[workspace-sync]", error));
    }, delayMs);
    this.#publishTimer.unref();
  }

  #flush(): Promise<void> {
    const run = this.#flushing.then(() => this.#flushOnce());
    this.#flushing = run.catch(() => undefined);
    return run;
  }

  async #flushOnce(): Promise<void> {
    if (!this.#started) return;
    const keys = [...this.#dirty];
    const publishRestorePoint = this.#remoteReady && this.#restorePointDirty;
    const publishActivity = this.#remoteReady && this.#activityDirty;
    if (keys.length === 0 && !publishRestorePoint && !publishActivity) return;
    this.#dirty.clear();
    this.#restorePointDirty = false;
    this.#activityDirty = false;
    try {
      const wires: WorkspaceRecordWire[] = [];
      for (const key of keys) {
        const register = this.#registers.get(key);
        if (register === undefined || !register.stamped) continue;
        // Only ever publish what this Mac authored. Merging adopts the
        // winner's HLC (`decision.adoptHlc`), so a register can hold a peer's
        // deviceId while `#sealDoc` signs with OUR key: peers look the
        // verifying key up by `hlc.deviceId` (device-registry.ts
        // `verifyWorkspace`), so such a wire fails verification everywhere and
        // is dropped. The peer that authored it already published it, so there
        // is nothing to re-introduce.
        if (register.hlc.deviceId !== this.#deps.deviceId) continue;
        wires.push(await this.#sealDoc(key, register.doc, register.hlc));
      }
      if (publishRestorePoint) {
        const doc: DeviceWorkspaceDoc = {
          kind: "deviceWorkspace",
          deviceId: this.#deps.deviceId,
          deviceKind: "desktop",
          name: this.#deps.deviceName(),
          // Bounded before sealing: a restore point grows with the tabs a
          // person keeps and is the one workspace doc with no natural
          // ceiling, so an untrimmed one eventually exceeds a hub frame and
          // would take the whole workspace lane down with it.
          session: boundRestorePoint(this.#deps.restorePoint()),
          savedAtMs: this.#now(),
        };
        wires.push(await this.#sealDoc(`${DEVICE_WORKSPACE_KEY_PREFIX}${this.#deps.deviceId}`, doc, this.#clock.send()));
        this.#lastPushMs = doc.savedAtMs;
      }
      if (publishActivity) {
        const doc: DeviceActivityDoc = {
          kind: "deviceActivity",
          deviceId: this.#deps.deviceId,
          name: this.#deps.deviceName(),
          platform: "macos",
          lastActiveMs: this.#now(),
          activeSpaceId: this.#deps.spaces.activeId(),
        };
        wires.push(await this.#sealDoc(`${DEVICE_ACTIVITY_KEY_PREFIX}${this.#deps.deviceId}`, doc, this.#clock.send()));
      }
      this.#persist();
      if (wires.length > 0) this.#deps.publish(wires);
      if (publishRestorePoint) this.#pushStatus();
    } catch (error) {
      // Dirty keys are only retired after sealing succeeds. A transient crypto
      // failure must never silently lose an update.
      for (const key of keys) this.#dirty.add(key);
      if (publishRestorePoint) this.#restorePointDirty = true;
      if (publishActivity) this.#activityDirty = true;
      this.#schedulePublish(PUBLISH_RETRY_MS);
      throw error;
    }
  }

  #persist(): void {
    const path = this.#deps.registersPath;
    if (path === null) return;
    const registers: Record<string, Hlc> = {};
    for (const [key, register] of this.#registers) {
      if (register.stamped) registers[key] = register.hlc;
    }
    const value: PersistedRegisters = { version: 1, clock: this.#clock.send(), registers };
    try {
      atomicWriteJsonSync(path, value);
    } catch (error) {
      console.error(`[workspace-sync] could not write ${path}`, error);
    }
  }

  #pushStatus(): void {
    this.#deps.onStatusChanged?.(this.status());
  }

  async #sealDoc(key: string, value: unknown, hlc: Hlc): Promise<WorkspaceRecordWire> {
    const sealedValue =
      value === null
        ? null
        : toBase64(await seal(this.#deps.keys.sealKey, utf8(JSON.stringify(value)), workspaceSealAad(key)));
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        this.#deps.privateKey,
        workspaceSigningBytes(key, sealedValue, hlc) as BufferSource,
      ),
    );
    return { key, sealedValue, hlc, deviceSig: toBase64(sig) };
  }

  async #openValue(wire: WorkspaceRecordWire): Promise<unknown> {
    if (wire.sealedValue === null) return null;
    const bytes = await open(this.#deps.keys.sealKey, fromBase64(wire.sealedValue), workspaceSealAad(wire.key));
    return JSON.parse(fromUtf8(bytes)) as unknown;
  }
}

/**
 * Every doc's key comes from the protocol's own mapping, so the key a record
 * is seeded under and the key a later change publishes under cannot drift
 * apart.
 */
function keyOf(doc: WorkspaceDoc): string {
  return workspaceKeyFor(doc);
}

/** A `space:` value as a canonical doc; undefined when the value is not a Space doc for `spaceId`. */
function readSpaceDoc(spaceId: string, value: unknown): WorkspaceDoc | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw["kind"] !== "space" || raw["id"] !== spaceId) return undefined;
  const space = sanitizeSpaceInfo(raw);
  return space === null ? undefined : spaceDocFor(space);
}

function readSettingsDoc(value: unknown): WorkspaceDoc | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  return raw["kind"] === "settings" && raw["field"] === "keyMode" ? { kind: "settings", field: "keyMode", value: "e2ee" } : null;
}
