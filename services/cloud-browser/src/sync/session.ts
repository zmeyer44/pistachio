/**
 * Sync sessions (docs/cloud-sync-design.md §8.1, §8.3). A `UserSession`
 * owns one hub transport per user (per cloud device) declaring its active
 * Spaces through `updateSpaces`; a `SpaceSession` owns one `BrowserContext`
 * and one `SpaceSyncEngine` (`leaseKind: 'cloud'`), renews its exclusive
 * leases on `LEASE_RENEW_INTERVAL_MS` while a run is active, and releases
 * every held origin when the last run ends or the transport goes offline.
 */

import { LEASE_RENEW_INTERVAL_MS, WORKSPACE_PSEUDO_SPACE_ID, type ArtifactRecord, type CookieRecordWire, type PublishRejectionReason, type SpaceKeys } from "@pistachio/sync-protocol";
import {
  SpaceSyncEngine,
  type CookieApplier,
  type DeviceRegistryVerifier,
  type HubTransport,
  type SyncTransport,
  type TransportEvents,
  type TransportState,
} from "@pistachio/sync-engine";
import type { BrowserBackend } from "@pistachio/agent-runtime";
import type { Page } from "playwright-core";
import type { PageNetworkGuard } from "../browser/guard.js";
import type { EgressCredential, EgressGateway } from "../control-client.js";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import type { CaptureEngine } from "./capture.js";
import { WorkspaceToolStore } from "./workspace-tools.js";

/**
 * Who is holding a Space's browser open (docs/web-browser-design.md §6.2). A
 * run holds it for the length of one conversation; a browser session holds it
 * for as long as the person keeps it, across runs and across viewers. The
 * context closes when the last holder of EITHER kind is gone.
 */
export type SpaceHolder = { kind: "run"; runId: string } | { kind: "session"; sessionId: string };

/** One holder's key in the maps that count them. */
export function spaceHolderKey(holder: SpaceHolder): string {
  return holder.kind === "run" ? `run:${holder.runId}` : `session:${holder.sessionId}`;
}

/** How long a space session waits for its first hydration before a run fails. */
export const DEFAULT_HYDRATION_TIMEOUT_MS = 30_000;

export type CredentialFieldInjectionFailureReason =
  | "origin_changed"
  | "focus_failed"
  | "write_failed"
  | "value_mismatch";

export type CredentialFieldInjectionResult =
  | {
      status: "complete";
      /** Fields for which input was attempted. Never includes values. */
      attemptedCount: number;
      clearedCount: 0;
    }
  | {
      status: "partial";
      /** Fields for which input was attempted. Never includes values. */
      attemptedCount: number;
      /** Attempted fields that were confirmed empty during failure cleanup. */
      clearedCount: number;
      /** Non-secret failure category for evidence and diagnosis. */
      failureReason: CredentialFieldInjectionFailureReason;
    };

/** The browser the cloud drives, as the session and the live view see it. */
export interface CloudBrowser extends BrowserBackend {
  /** Observe guarded pages before their first navigation. */
  onPage?(listener: (page: Page) => void | Promise<void>): () => void;
  readonly activeTabId: string | null;
  guardFor(tabId: string): PageNetworkGuard | null;
  /** The page behind a tab id, where a host needs to evaluate in it directly. */
  pageFor?(tabId: string): Page | null;
  /** Whose tab a new one is (§6.2): a session opens `human` tabs, a run `agent` ones. */
  openTab(url?: string, options?: { kind?: "human" | "agent" }): Promise<string>;
  /** Close a page. The desktop's tab lifecycle needs it; the agent loop does not. */
  closeTab(tabId: string): Promise<void>;
  /** Tab order, which Playwright has no notion of and the shell needs (§6.2). */
  reorder?(tabId: string, index: number): void;
  /** Size a page to its pane, so it reflows where the person actually sees it. */
  setViewport?(tabId: string, size: { width: number; height: number }): Promise<void>;
  /** The tab's icon, fetched through the Space's cookies and egress as a data URL. */
  favicon?(tabId: string): Promise<string | null>;
  pageHtml?(tabId: string): Promise<string>;
  /**
   * Take responsibility for this context's downloads (§11). Answers a release.
   * A context with no claimant cancels every download that starts in it: the
   * Space's context is shared by runs and the session, and only a session
   * host has a place to put the bytes and a policy to apply to them.
   */
  claimDownloads?(): () => void;
  /** Fill one-time secret values without reading them back into an agent result. */
  fillCredentialFields?(
    tabId: string,
    expectedOrigin: string,
    fields: Array<{ target: string; value: string }>,
  ): Promise<CredentialFieldInjectionResult>;
}

export interface SpaceCapture {
  /** Bind the engine (built after the applier, which needs the capture) and the hydration gate. */
  attach(engine: CaptureEngine, isHydrating: () => boolean): void;
  seedBaseline(): Promise<void>;
  drain(): Promise<void>;
  detach(): void;
}

/** What a space session drives: the backend, its capture, and a way to close the context. */
export interface SpaceSessionBrowser {
  backend: CloudBrowser;
  capture: SpaceCapture;
  /** The tab list or the active tab changed (the live view re-sends `tabs`). */
  onTabsChanged(listener: () => void): () => void;
  close(): Promise<void>;
}

export interface SpaceSessionOptions {
  userId: string;
  spaceId: string;
  keys: SpaceKeys;
  signer: { deviceId: string; privateKey: CryptoKey };
  transport: SyncTransport;
  verifier?: DeviceRegistryVerifier;
  /** Re-reads the device registry into `verifier` (first unknown-device rejection, §8.2). */
  refreshVerifier?: () => Promise<void>;
  browser: SpaceSessionBrowser;
  applier: CookieApplier;
  workspace?: WorkspaceToolStore;
  now?: () => number;
  renewIntervalMs?: number;
  hydrationTimeoutMs?: number;
  log?: Logger;
}

export class SpaceSession {
  readonly userId: string;
  readonly spaceId: string;
  readonly engine: SpaceSyncEngine;
  readonly browser: SpaceSessionBrowser;
  readonly workspace: WorkspaceToolStore | null;
  /** Resolves once the first hydration has completed; rejects when closed before that. */
  readonly ready: Promise<void>;
  #resolveReady: () => void = () => undefined;
  #rejectReady: (error: Error) => void = () => undefined;
  readonly #verifier: DeviceRegistryVerifier | null;
  readonly #refreshVerifier: (() => Promise<void>) | null;
  readonly #renewIntervalMs: number;
  readonly #hydrationTimeoutMs: number;
  readonly #log: Logger;
  #recordQueue: Promise<void> = Promise.resolve();
  #hydrating = false;
  #hasHydratedOnce = false;
  #online = false;
  readonly #holders = new Map<string, SpaceHolder>();
  #verifierRefreshed = false;
  #renewTimer: NodeJS.Timeout | null = null;
  #readyTimer: NodeJS.Timeout | null = null;
  #closed = false;
  #keys: SpaceKeys | null;

  constructor(options: SpaceSessionOptions) {
    this.userId = options.userId;
    this.spaceId = options.spaceId;
    this.browser = options.browser;
    this.workspace = options.workspace ?? null;
    this.#verifier = options.verifier ?? null;
    this.#refreshVerifier = options.refreshVerifier ?? null;
    this.#renewIntervalMs = options.renewIntervalMs ?? LEASE_RENEW_INTERVAL_MS;
    this.#hydrationTimeoutMs = options.hydrationTimeoutMs ?? DEFAULT_HYDRATION_TIMEOUT_MS;
    this.#log = options.log ?? silentLogger;
    this.#keys = options.keys;
    this.engine = new SpaceSyncEngine(options.spaceId, options.keys, options.signer, options.transport, options.applier, {
      deviceId: options.signer.deviceId,
      leaseKind: "cloud",
      ...(options.verifier === undefined ? {} : { verifier: options.verifier }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    options.browser.capture.attach(this.engine, () => this.#hydrating || !this.#hasHydratedOnce);
    this.ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.ready.catch(() => undefined);
    this.#readyTimer = setTimeout(() => {
      this.#readyTimer = null;
      if (!this.#hasHydratedOnce) this.#rejectReady(new Error("sync hydration timed out"));
    }, this.#hydrationTimeoutMs);
    this.#readyTimer.unref();
  }

  get hydrating(): boolean {
    return this.#hydrating;
  }

  get hasHydratedOnce(): boolean {
    return this.#hasHydratedOnce;
  }

  get activeRuns(): number {
    let count = 0;
    for (const holder of this.#holders.values()) if (holder.kind === "run") count += 1;
    return count;
  }

  /** The runs currently driving this Space; the egress credential is scoped to them. */
  get runIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const holder of this.#holders.values()) if (holder.kind === "run") ids.add(holder.runId);
    return ids;
  }

  /** Every holder of either kind. The idle clock starts when this empties. */
  get holders(): ReadonlyMap<string, SpaceHolder> {
    return this.#holders;
  }

  get holderCount(): number {
    return this.#holders.size;
  }

  get online(): boolean {
    return this.#online;
  }

  get renewing(): boolean {
    return this.#renewTimer !== null;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get keys(): SpaceKeys {
    if (this.#keys === null) throw new Error("space session closed");
    return this.#keys;
  }

  /* ------------------------------ transport inputs ------------------------------ */

  transportState(state: TransportState): void {
    if (this.#closed) return;
    const online = state === "connected";
    if (online && !this.#hasHydratedOnce && !this.#hydrating) {
      this.#hydrating = true;
      void this.engine.beginHydration();
    }
    const changed = online !== this.#online;
    this.#online = online;
    this.engine.setOnline(online);
    if (!changed) return;
    if (!online) {
      // Leases die with the socket; the next write re-acquires.
      this.#stopRenewing();
    } else if (this.#holders.size > 0) {
      this.#startRenewing();
    }
  }

  receiveRecords(records: CookieRecordWire[]): void {
    if (this.#closed || records.length === 0) return;
    this.#recordQueue = this.#recordQueue
      .then(async () => {
        const dispositions = await this.engine.applyRemote(records);
        const unknown = records.filter(
          (record, index) =>
            dispositions[index] === "rejected" &&
            this.#verifier !== null &&
            !this.#verifier.hasDevice(record.hlc.deviceId),
        );
        if (unknown.length === 0 || this.#verifierRefreshed || this.#refreshVerifier === null) return;
        this.#verifierRefreshed = true;
        await this.#refreshVerifier();
        await this.engine.applyRemote(unknown);
      })
      .catch((error: unknown) => {
        this.#log.warn("remote records failed to apply", { spaceId: this.spaceId, error: errorMessage(error) });
      });
  }

  /** `hydrate.done`: wait for the record stream to land, then open for capture. */
  hydrated(): void {
    void this.#finishHydration().catch((error: unknown) => {
      this.#log.error("hydration failed", { spaceId: this.spaceId, error: errorMessage(error) });
    });
  }

  publishAccepted(recordIds: readonly string[]): void {
    this.engine.publishAccepted(recordIds);
  }

  publishRejected(recordId: string, reason: PublishRejectionReason): Promise<void> {
    return this.engine.publishRejected(recordId, reason);
  }

  leaseRevoked(originId: string): void {
    this.engine.leaseRevoked(originId);
  }

  leaseReleased(originId: string): void {
    this.engine.leaseReleased(originId);
  }

  /* ------------------------------ run lifecycle ------------------------------ */

  runStarted(runId: string): void {
    this.holderStarted({ kind: "run", runId });
  }

  runEnded(runId: string): void {
    this.holderEnded({ kind: "run", runId });
  }

  /**
   * A run or a session takes hold of this Space. The renewal tick (which
   * doubles as the retry tick) runs while anything holds it; the lease MODE
   * follows W8 — exclusive while a run is acting, non-exclusive while only a
   * person's session is, so a Mac and a web tab on one account defer to each
   * other instead of fencing each other out.
   */
  holderStarted(holder: SpaceHolder): void {
    const key = spaceHolderKey(holder);
    if (this.#holders.has(key)) return;
    this.#holders.set(key, holder);
    this.#applyLeaseMode();
    if (this.#holders.size === 1 && this.#online) this.#startRenewing();
  }

  holderEnded(holder: SpaceHolder): void {
    const key = spaceHolderKey(holder);
    const previous = this.#holders.get(key);
    if (previous === undefined) return;
    this.#holders.delete(key);
    this.#applyLeaseMode();
    // A run gives its exclusive grants back the moment it ends, whether or
    // not the person's session keeps the browser open behind it (§4.3).
    if (previous.kind === "run" && this.activeRuns === 0) this.releaseLeases();
    if (this.#holders.size === 0) {
      this.#stopRenewing();
      this.releaseLeases();
    }
  }

  /** Release every held origin; the engine stays online for later observation. */
  releaseLeases(): void {
    this.engine.setOnline(false);
    if (this.#online) this.engine.setOnline(true);
  }

  /** Every queued remote apply and capture diff has finished. */
  async drain(): Promise<void> {
    await this.#recordQueue;
    await this.browser.capture.drain();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopRenewing();
    if (this.#readyTimer !== null) {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = null;
    }
    this.#rejectReady(new Error("space session closed"));
    this.browser.capture.detach();
    if (this.#online) this.engine.setOnline(false);
    this.#keys = null;
    await this.browser.close().catch((error: unknown) => {
      this.#log.warn("context close failed", { spaceId: this.spaceId, error: errorMessage(error) });
    });
  }

  /* ------------------------------ internals ------------------------------ */

  async #finishHydration(): Promise<void> {
    if (this.#closed || !this.#hydrating) return;
    await this.#recordQueue;
    if (this.#closed || !this.#hydrating) return;
    await this.engine.endHydration();
    this.#hydrating = false;
    await this.browser.capture.seedBaseline();
    this.#hasHydratedOnce = true;
    if (this.#readyTimer !== null) {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = null;
    }
    this.#resolveReady();
  }

  /**
   * W8: exclusive while a run is acting, or when nothing holds the Space at
   * all (today's behaviour for a bare `cloud` engine); non-exclusive while
   * the only holders are the person's own browser sessions.
   */
  #applyLeaseMode(): void {
    const sessions = this.#holders.size - this.activeRuns;
    this.engine.setExclusiveLeases(this.activeRuns > 0 || sessions === 0);
  }

  #startRenewing(): void {
    if (this.#renewTimer !== null) return;
    this.#renewTimer = setInterval(() => {
      void this.#renewTick().catch((error: unknown) => {
        this.#log.warn("lease renewal failed", { spaceId: this.spaceId, error: errorMessage(error) });
      });
    }, this.#renewIntervalMs);
    this.#renewTimer.unref();
  }

  /**
   * The renewal interval doubles as the runner's retry tick, as the desktop's
   * does: a record the hub rate-limited sits in the engine's DEFAULT lane
   * until a host flushes it, and a write parked behind another holder waits
   * for a release that a long or overlapping run may never see. Without this
   * a throttled cookie write stays unsent for the rest of the run.
   */
  async #renewTick(): Promise<void> {
    await this.engine.renewLeases();
    await this.engine.flushPending();
    await this.engine.retryDeferred();
  }

  #stopRenewing(): void {
    if (this.#renewTimer === null) return;
    clearInterval(this.#renewTimer);
    this.#renewTimer = null;
  }
}

/* ---------------------------------------------------------------------- *
 * UserSession
 * ---------------------------------------------------------------------- */

export interface SpaceBrowserParts {
  browser: SpaceSessionBrowser;
  applier: CookieApplier;
}

export interface UserSessionOptions {
  userId: string;
  deviceId: string;
  signer: { deviceId: string; privateKey: CryptoKey };
  gateway: EgressGateway | null;
  /** Builds the hub transport for this user's device with the session's event handlers. */
  transportFactory: (events: TransportEvents) => HubTransport;
  /** The device token for the hub upgrade; null when the device is gone. */
  getToken: () => Promise<string | null>;
  keysFor: (spaceId: string) => Promise<SpaceKeys>;
  verifierFor: (refresh: boolean) => Promise<DeviceRegistryVerifier>;
  artifactWebUrl?: string;
  onArtifactChanged?: (artifact: ArtifactRecord) => void;
  /** Builds the context, backend, capture, and applier for one Space. */
  createSpaceBrowser: (spaceId: string, session: UserSession, keys: SpaceKeys) => Promise<SpaceBrowserParts>;
  /** The hub closed the socket with 4003: this device was revoked. */
  onRevoked: () => void;
  now?: () => number;
  renewIntervalMs?: number;
  hydrationTimeoutMs?: number;
  log?: Logger;
}

export class UserSession {
  readonly userId: string;
  readonly deviceId: string;
  readonly gateway: EgressGateway | null;
  readonly transport: HubTransport;
  readonly workspace: WorkspaceToolStore;
  readonly spaces = new Map<string, SpaceSession>();
  readonly #options: UserSessionOptions;
  readonly #log: Logger;
  readonly #pending = new Map<string, Promise<SpaceSession>>();
  /** Keyed by `spaceHolderKey`: credentials are minted and revoked per holder. */
  readonly #credentials = new Map<string, EgressCredential>();
  #publishChain: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;

  constructor(options: UserSessionOptions) {
    this.userId = options.userId;
    this.deviceId = options.deviceId;
    this.gateway = options.gateway;
    this.#options = options;
    this.#log = options.log ?? silentLogger;
    this.transport = options.transportFactory(this.#events());
    this.workspace = new WorkspaceToolStore({
      deviceId: options.deviceId,
      privateKey: options.signer.privateKey,
      keys: options.keysFor(WORKSPACE_PSEUDO_SPACE_ID),
      transport: this.transport,
      verifier: options.verifierFor,
      ...(options.artifactWebUrl === undefined ? {} : { artifactWebUrl: options.artifactWebUrl }),
      ...(options.onArtifactChanged === undefined ? {} : { onArtifactChanged: options.onArtifactChanged }),
      ...(options.now === undefined ? {} : { now: () => new Date(options.now!()) }),
    });
  }

  /**
   * Credentials are minted and revoked per run (D13), so they are held per
   * run: a second concurrent run of the same user must not take over the
   * credential a live run is presenting, and its revocation must not cut it.
   */
  setCredential(holder: SpaceHolder, credential: EgressCredential): void {
    this.#credentials.set(spaceHolderKey(holder), credential);
  }

  dropCredential(holder: SpaceHolder): void {
    this.#credentials.delete(spaceHolderKey(holder));
  }

  /**
   * The holder whose credential a Space's pages present: the newest live
   * holder of that Space that has one. Null when the Space has no
   * credentialed holder. A run acting inside a person's session therefore
   * presents the session's credential rather than minting a second (§6.2).
   */
  credentialHolderFor(spaceId: string): SpaceHolder | null {
    const holders = this.spaces.get(spaceId)?.holders;
    if (holders === undefined) return null;
    let latest: SpaceHolder | null = null;
    // Insertion order is mint order, so the last match is the newest.
    for (const key of this.#credentials.keys()) {
      const holder = holders.get(key);
      if (holder !== undefined) latest = holder;
    }
    return latest;
  }

  /** The egress credential a Space's page guards present, re-read on every challenge. */
  credentialForSpace(spaceId: string): EgressCredential | null {
    const holder = this.credentialHolderFor(spaceId);
    return holder === null ? null : (this.#credentials.get(spaceHolderKey(holder)) ?? null);
  }

  /** Whether this Space already has a credential a new holder can browse under. */
  hasCredentialFor(spaceId: string): boolean {
    return this.credentialForSpace(spaceId) !== null;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The Space's session, created (context, engine, hydration) on first use. */
  space(spaceId: string): Promise<SpaceSession> {
    if (this.#closed) return Promise.reject(new Error("user session closed"));
    const existing = this.spaces.get(spaceId);
    if (existing !== undefined && !existing.closed) return Promise.resolve(existing);
    const pending = this.#pending.get(spaceId);
    if (pending !== undefined) return pending;
    const creation = this.#createSpace(spaceId).finally(() => {
      if (this.#pending.get(spaceId) === creation) this.#pending.delete(spaceId);
    });
    this.#pending.set(spaceId, creation);
    return creation;
  }

  async closeSpace(spaceId: string): Promise<void> {
    const session = this.spaces.get(spaceId);
    if (session === undefined) return;
    this.spaces.delete(spaceId);
    await session.close();
    if (!this.#closed && this.#started) {
      await this.transport.updateSpaces([...this.spaces.keys()]).catch(() => undefined);
    }
  }

  /** Release held leases while the socket is open, stop the transport, close every context. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const session of this.spaces.values()) session.releaseLeases();
    this.transport.stop();
    this.#credentials.clear();
    const sessions = [...this.spaces.values()];
    this.spaces.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }

  async #createSpace(spaceId: string): Promise<SpaceSession> {
    const keys = await this.#options.keysFor(spaceId);
    const verifier = await this.#options.verifierFor(false);
    const parts = await this.#options.createSpaceBrowser(spaceId, this, keys);
    if (this.#closed) {
      await parts.browser.close().catch(() => undefined);
      throw new Error("user session closed");
    }
    const session = new SpaceSession({
      userId: this.userId,
      spaceId,
      keys,
      signer: this.#options.signer,
      transport: this.transport,
      verifier,
      refreshVerifier: async () => {
        await this.#options.verifierFor(true);
      },
      browser: parts.browser,
      applier: parts.applier,
      workspace: this.workspace,
      ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
      ...(this.#options.renewIntervalMs === undefined ? {} : { renewIntervalMs: this.#options.renewIntervalMs }),
      ...(this.#options.hydrationTimeoutMs === undefined ? {} : { hydrationTimeoutMs: this.#options.hydrationTimeoutMs }),
      log: this.#log,
    });
    this.spaces.set(spaceId, session);
    if (!this.#started) {
      this.#started = true;
      this.transport.start([...this.spaces.keys()]);
    } else {
      session.transportState(this.transport.state);
      await this.transport.updateSpaces([...this.spaces.keys()]);
    }
    return session;
  }

  #events(): TransportEvents {
    // One chain for every publish acknowledgement: an engine consumes its
    // in-flight window in ack order, so an accept must not overtake a
    // rejection that arrived before it.
    const recover = (work: () => Promise<void>): void => {
      this.#publishChain = this.#publishChain
        .then(work)
        .catch((error: unknown) => this.#log.warn("publish recovery failed", { error: errorMessage(error) }));
    };
    return {
      getToken: () => this.#options.getToken(),
      authRequired: () => true,
      onStateChanged: (state) => {
        for (const session of this.spaces.values()) session.transportState(state);
      },
      onRecords: (spaceId, records) => {
        this.spaces.get(spaceId)?.receiveRecords(records);
      },
      onHydrated: (spaceId) => {
        this.spaces.get(spaceId)?.hydrated();
      },
      onWorkspaceRecords: (docs) => {
        this.workspace.receive(docs);
      },
      onWorkspaceHydrated: () => {
        this.workspace.hydrated();
      },
      onPublishAccepted: (recordIds) => {
        recover(async () => {
          for (const session of this.spaces.values()) session.publishAccepted(recordIds);
        });
      },
      onPublishRejected: (rejections) => {
        recover(async () => {
          for (const rejection of rejections) {
            for (const session of this.spaces.values()) {
              await session.publishRejected(rejection.recordId, rejection.reason);
            }
          }
        });
      },
      onPublishInterrupted: (recordIds) => {
        recover(async () => {
          for (const recordId of recordIds) {
            for (const session of this.spaces.values()) {
              await session.publishRejected(recordId, "lease_required");
            }
          }
        });
      },
      onLeaseRevoked: (spaceId, originId) => {
        this.spaces.get(spaceId)?.leaseRevoked(originId);
      },
      onLeaseReleased: (spaceId, originId) => {
        this.spaces.get(spaceId)?.leaseReleased(originId);
      },
      onRevoked: () => {
        this.#options.onRevoked();
      },
    };
  }
}
