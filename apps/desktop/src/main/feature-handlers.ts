/**
 * The seam between the IPC surface of docs/cloud-sync-design.md §10.5 and
 * the services that implement it.
 *
 * `main/index.ts` registers every `sync:*`, `workspaceSync:*`, `cloud:*`
 * (status, run, live view) and `channels:*` handler against THIS object and
 * nothing else. The defaults answer honestly that the feature is off: every
 * getter resolves an "off" status and every action rejects with a readable
 * error, so the renderer works before the services exist and under
 * PISTACHIO_E2E, where nothing dials control, the hub, or a gateway (D22).
 *
 * The sync, workspace-sync, and cloud services (src/main/sync, src/main/cloud)
 * replace the defaults with `installFeatureHandlers({...})` once they are
 * constructed in `app.whenReady`, and publish their own state on
 * `IPC.syncChanged` / `IPC.workspaceSyncChanged` / `IPC.cloudChanged` /
 * `IPC.cloudFrame` through the `publish*` callbacks index.ts hands them.
 * `lifecycle` is what index.ts calls on the account transitions the services
 * must follow (enrolled → start; sign-out or revocation → stop and forget).
 *
 * `cloud:status` is composed: index.ts computes the account-derived fields
 * (`available`, `cloudBrowserUrl`, `device`, `spaces`) from AuthService and
 * SpaceStore, and lays `cloud.status()` — the live-view fields — over them.
 * `cloud:enable` / `cloud:disable` are AuthService's (they wrap keys, §10.1)
 * and are not routed through here.
 */

import type { Session } from "electron";
import type {
  ChannelCreateRequest,
  ChannelCreated,
  ChannelInfo,
  CloudLiveInput,
  CloudStartRunRequest,
  CloudStatus,
  SyncOriginInfo,
  SyncOriginOverride,
  SyncStatus,
  WorkspaceSyncAction,
  WorkspaceSyncStatus,
} from "@pistachio/shell-contracts/ipc";

export interface SyncFeature {
  status(): SyncStatus;
  originInfo(spaceId: string, host: string): Promise<SyncOriginInfo>;
  setOriginOverride(
    spaceId: string,
    host: string,
    override: SyncOriginOverride | null,
  ): Promise<SyncOriginInfo>;
  rollbackOrigin(spaceId: string, host: string): Promise<void>;
  retry(): Promise<SyncStatus>;
}

export interface WorkspaceSyncFeature {
  status(): WorkspaceSyncStatus;
  run(action: WorkspaceSyncAction): Promise<WorkspaceSyncStatus>;
}

/** The live-view half of the cloud status; the account half is index.ts's. */
export type CloudLiveStatus = Pick<
  CloudStatus,
  "liveRunId" | "liveState" | "liveError" | "liveControl" | "liveStatus" | "liveTabs" | "liveActiveTabId"
>;

export interface CloudFeature {
  status(): CloudLiveStatus;
  startRun(request: CloudStartRunRequest): Promise<{ runId: string }>;
  liveOpen(runId: string): Promise<CloudLiveStatus>;
  liveClose(): Promise<void>;
  liveInput(input: CloudLiveInput): void;
}

export interface ChannelsFeature {
  list(): Promise<ChannelInfo[]>;
  create(request: ChannelCreateRequest): Promise<ChannelCreated>;
  delete(linkId: string): Promise<ChannelInfo[]>;
}

/** Account and session transitions the feature services follow. */
export interface FeatureLifecycle {
  /** The device is enrolled and holds a device token: dial the hub, start observing runs. */
  onEnrolled(): void;
  /**
   * Sign-out or revocation: stop everything and never dial again until
   * onEnrolled. A sign-out also forgets the account's queues and registers;
   * a revocation keeps them (the jars are kept too, §10.1).
   */
  /** May be awaited: the sync host drains in-flight cookie applies here. */
  onSignedOut(reason?: "sign-out" | "revoked"): void | Promise<void>;
  /** The device token was silently refreshed: reconnect the hub socket with it. */
  onTokenChanged(): void;
  /**
   * BrowserController configured a session for the first time (a Space's
   * `persist:pistachio-space-*` partition, or an agent run's
   * `pistachio-agent-*` one): cookie capture attaches here.
   */
  onSessionCreated(target: Session, spaceId: string, partition: string, kind: "human" | "agent"): void;
  /**
   * A bulk cookie writer (a fork's cookie copy, a browser import) is about to
   * fill a Space's jar: capture pauses so the writes are not republished as
   * mutations (§10.2). `end` seeds what landed like any pre-existing cookie.
   */
  beginBulkCookieWrite(spaceId: string): void;
  endBulkCookieWrite(spaceId: string): void;
  /** Flush what must reach disk before the process ends; synchronous. */
  flush(): void;
}

export interface FeatureHandlers {
  sync: SyncFeature;
  workspaceSync: WorkspaceSyncFeature;
  cloud: CloudFeature;
  channels: ChannelsFeature;
  lifecycle: FeatureLifecycle;
}

export const OFF_SYNC_STATUS: SyncStatus = {
  state: "off",
  queueDepth: 0,
  lastConvergedMs: null,
  remoteChanged: false,
  keyMode: "e2ee",
  revoked: false,
};

export const OFF_WORKSPACE_SYNC_STATUS: WorkspaceSyncStatus = {
  state: "off",
  lastRunMs: null,
  lastPushMs: null,
  remoteRestorePoints: [],
  error: null,
};

export const OFF_CLOUD_LIVE_STATUS: CloudLiveStatus = {
  liveRunId: null,
  liveState: "closed",
  liveError: null,
  liveControl: null,
  liveStatus: null,
  liveTabs: [],
  liveActiveTabId: null,
};

function off(feature: string): Error {
  return new Error(`${feature} is not available until this Mac is signed in and enrolled.`);
}

/** What an origin looks like before the sync engine can say more: synced by policy, untouched. */
export function offOriginInfo(spaceId: string, host: string): SyncOriginInfo {
  return {
    spaceId,
    host,
    tier: 1,
    rotatingAuth: false,
    sensitive: false,
    override: null,
    synced: false,
    staged: false,
    deferred: false,
  };
}

function defaultHandlers(): FeatureHandlers {
  return {
    sync: {
      status: () => ({ ...OFF_SYNC_STATUS }),
      originInfo: (spaceId, host) => Promise.resolve(offOriginInfo(spaceId, host)),
      setOriginOverride: () => Promise.reject(off("Session sync")),
      rollbackOrigin: () => Promise.reject(off("Session sync")),
      retry: () => Promise.resolve({ ...OFF_SYNC_STATUS }),
    },
    workspaceSync: {
      status: () => structuredClone(OFF_WORKSPACE_SYNC_STATUS),
      run: () => Promise.reject(off("Workspace sync")),
    },
    cloud: {
      status: () => structuredClone(OFF_CLOUD_LIVE_STATUS),
      startRun: () => Promise.reject(off("The cloud browser")),
      liveOpen: () => Promise.reject(off("The cloud browser")),
      liveClose: () => Promise.resolve(),
      liveInput: () => undefined,
    },
    channels: {
      list: () => Promise.resolve([]),
      create: () => Promise.reject(off("Channels")),
      delete: () => Promise.reject(off("Channels")),
    },
    lifecycle: {
      onEnrolled: () => undefined,
      onSignedOut: () => undefined,
      onTokenChanged: () => undefined,
      onSessionCreated: () => undefined,
      beginBulkCookieWrite: () => undefined,
      endBulkCookieWrite: () => undefined,
      flush: () => undefined,
    },
  };
}

/**
 * The live registry. Mutated in place by `installFeatureHandlers` so that
 * index.ts's handlers, which read `featureHandlers.<feature>` on every call,
 * see the replacement without re-registering anything.
 */
export const featureHandlers: FeatureHandlers = defaultHandlers();

/** Replace one or more features; the rest keep their current implementation. */
export function installFeatureHandlers(patch: Partial<FeatureHandlers>): void {
  Object.assign(featureHandlers, patch);
}

/** Back to the off defaults (sign-out, tests). */
export function resetFeatureHandlers(): void {
  Object.assign(featureHandlers, defaultHandlers());
}
