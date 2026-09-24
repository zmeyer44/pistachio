/**
 * What Settings → Sync says about the cookie engine, the origin corpus, and
 * the restore points other devices published (docs/cloud-sync-design.md
 * §10.2), plus the defaults the store shows before main's first answer.
 *
 * Pure, and deliberately so: the page is a rendering of `sync:changed` and
 * `workspaceSync:changed`, and every sentence it can say is testable here
 * without a store, a window, or an IPC bridge.
 */

import type {
  BrowserTabInfo,
  CloudStatus,
  EgressStatus,
  RemoteRestorePoint,
  SyncOriginInfo,
  SyncOriginOverride,
  SyncStatus,
  WorkspaceSyncStatus,
} from "@pistachio/shell-contracts/ipc";
import { relativeTime } from "./run";
import { hostOf } from "./url";

/** Nothing syncs until this Mac is enrolled; that is the resting state. */
export const DEFAULT_SYNC_STATUS: SyncStatus = {
  state: "off",
  queueDepth: 0,
  lastConvergedMs: null,
  remoteChanged: false,
  keyMode: "e2ee",
  revoked: false,
};

export const DEFAULT_WORKSPACE_SYNC: WorkspaceSyncStatus = {
  state: "off",
  lastRunMs: null,
  lastPushMs: null,
  remoteRestorePoints: [],
  error: null,
};

export const DEFAULT_EGRESS_STATUS: EgressStatus = {
  enabled: false,
  gateway: null,
  health: "unknown",
  credentialExpiresAt: null,
  quicDisabledAtStartup: false,
  spaces: [],
};

export const DEFAULT_CLOUD_STATUS: CloudStatus = {
  available: false,
  cloudBrowserUrl: null,
  device: null,
  spaces: [],
  liveRunId: null,
  liveState: "closed",
  liveError: null,
  liveControl: null,
  liveStatus: null,
  liveTabs: [],
  liveActiveTabId: null,
};

/** `relativeTime` for the millisecond stamps the sync statuses carry. */
export function relativeMs(value: number | null, now: number = Date.now()): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return "";
  return relativeTime(new Date(value).toISOString(), now);
}

export interface SyncStateView {
  label: string;
  note: string;
  tone: "green" | "amber" | "gray" | "red";
}

/** The connection row: what the engine is doing, and what that means. */
export function syncStateView(status: SyncStatus, now: number = Date.now()): SyncStateView {
  if (status.revoked) {
    return {
      label: "Revoked",
      note: "Control stopped accepting this device's key. Sign in again to sync.",
      tone: "red",
    };
  }
  switch (status.state) {
    case "connected": {
      const converged = relativeMs(status.lastConvergedMs, now);
      return {
        label: "Connected",
        note:
          status.queueDepth > 0
            ? `${queueLabel(status.queueDepth)} to publish.`
            : converged === ""
              ? "Sessions are converging with your other devices."
              : `Everything converged ${converged}.`,
        tone: "green",
      };
    }
    case "connecting":
      return { label: "Connecting", note: "Dialling the hub with this device's token.", tone: "amber" };
    case "paused":
      return {
        label: "Paused",
        note:
          status.queueDepth > 0
            ? `The hub is unreachable. ${capitalize(queueLabel(status.queueDepth))} until it answers.`
            : "The hub is unreachable. Nothing is lost — changes wait on this Mac.",
        tone: "amber",
      };
    default:
      return { label: "Off", note: "Sign in and enroll this Mac to sync sessions between devices.", tone: "gray" };
  }
}

/** "Nothing waiting" / "1 change waiting" / "12 changes waiting". */
export function queueLabel(queueDepth: number): string {
  if (!Number.isFinite(queueDepth) || queueDepth <= 0) return "nothing waiting";
  return queueDepth === 1 ? "1 change waiting" : `${String(Math.floor(queueDepth))} changes waiting`;
}

function capitalize(value: string): string {
  return value === "" ? value : value[0]!.toUpperCase() + value.slice(1);
}

/** What the workspace lane (Spaces and restore points) is doing. */
export function workspaceStateLabel(status: WorkspaceSyncStatus): string {
  switch (status.state) {
    case "syncing":
      return "Syncing";
    case "error":
      return "Needs attention";
    case "idle":
      return "Up to date";
    default:
      return "Off";
  }
}

/**
 * The refusal main answers a Push with while the cloud browser holds a lease
 * on an origin of this account (§10.2, D10). It is the one workspace error
 * the page can act on, so the page reads it rather than only showing it.
 */
export const CLOUD_RUN_REFUSAL = "cloud run in progress";

export function cloudRunInProgress(status: WorkspaceSyncStatus): boolean {
  return status.error !== null && status.error.toLowerCase().includes(CLOUD_RUN_REFUSAL);
}

/**
 * Newest first. A restore point is offered as "the state of that device at
 * that moment", so the ordering people expect is the one a photo roll has.
 */
export function sortRestorePoints(points: readonly RemoteRestorePoint[]): RemoteRestorePoint[] {
  return [...points].sort((a, b) => {
    if (b.savedAtMs !== a.savedAtMs) return b.savedAtMs - a.savedAtMs;
    return a.name.localeCompare(b.name) || a.deviceId.localeCompare(b.deviceId);
  });
}

/** "12 tabs · 2 Spaces · 5m ago" under a restore point's device name. */
export function restorePointSummary(point: RemoteRestorePoint, now: number = Date.now()): string {
  const tabs = point.tabCount === 1 ? "1 tab" : `${String(point.tabCount)} tabs`;
  const spaces = point.spaceIds.length === 1 ? "1 Space" : `${String(point.spaceIds.length)} Spaces`;
  const when = relativeMs(point.savedAtMs, now);
  return when === "" ? `${tabs} · ${spaces}` : `${tabs} · ${spaces} · saved ${when}`;
}

export function restorePointKindLabel(point: RemoteRestorePoint): string {
  return point.deviceKind === "cloud" ? "Cloud browser" : "Desktop";
}

/* ------------------------------ origins -------------------------------- */

/** What the corpus says about an origin, before the person's own choice. */
export function originTierLabel(info: SyncOriginInfo): string {
  if (info.sensitive) return "Sensitive · never synced";
  if (info.tier === 0) return "Tier 0 · never synced";
  if (info.tier === 2) return "Tier 2 · synced, rotating auth";
  return "Tier 1 · synced";
}

/** The effective answer after the override, in words. */
export function originStateLabel(info: SyncOriginInfo): string {
  if (!info.synced) return info.override === "never" ? "Never (your choice)" : "Not synced";
  return info.override === "sync" ? "Synced (your choice)" : "Synced";
}

/** The `default` choice is the absence of an override, not a third mode. */
export type OriginOverrideChoice = "default" | SyncOriginOverride;

export const ORIGIN_OVERRIDE_ITEMS: ReadonlyArray<{ value: OriginOverrideChoice; label: string }> = [
  { value: "default", label: "Follow the corpus" },
  { value: "sync", label: "Always sync" },
  { value: "never", label: "Never sync" },
];

export function overrideChoice(info: SyncOriginInfo): OriginOverrideChoice {
  return info.override ?? "default";
}

export function overrideFromChoice(choice: OriginOverrideChoice): SyncOriginOverride | null {
  return choice === "default" ? null : choice;
}

/**
 * A host as the sync engine keys it: lower case, no scheme, no port, no path.
 * The address bar's chips and the tabs are full URLs, and a person typing a
 * host will paste one of those, so the page normalizes before it asks main.
 */
export function normalizeHostInput(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const host = new URL(withScheme).hostname;
    return host.startsWith("[") ? "" : host.replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** How many of a Space's open sites the origins table looks up on its own. */
export const SEEDED_HOSTS = 6;

/**
 * The hosts the origins table seeds itself from: the web pages open in the
 * Space it is showing, deduped, at most `SEEDED_HOSTS` of them.
 *
 * Every row the table asks main for is asked under one Space's id, so the
 * seeds have to come from that Space's own tabs. The snapshot carries the
 * active Space's tabs alone, which is exactly right: pick another Space in
 * the Select and it seeds from nothing rather than looking up the sites in
 * front of the person under a Space that never opened them.
 *
 * Only web pages count. The app's own pages have no cookies to sync, and
 * `pistachio://demo/…` would ask main about the host "demo".
 */
export function seededHosts(tabs: readonly BrowserTabInfo[], spaceId: string): string[] {
  if (spaceId === "") return [];
  const hosts = new Set<string>();
  for (const tab of tabs) {
    if (tab.spaceId !== spaceId || tab.kind !== "human") continue;
    if (!/^https?:$/.test(schemeOf(tab.url))) continue;
    const host = hostOf(tab.url);
    if (host !== "") hosts.add(host);
    if (hosts.size === SEEDED_HOSTS) break;
  }
  return [...hosts];
}

function schemeOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}
