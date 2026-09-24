import { describe, expect, it } from "vitest";
import type {
  BrowserTabInfo,
  RemoteRestorePoint,
  SyncOriginInfo,
  SyncStatus,
  WorkspaceSyncStatus,
} from "@pistachio/shell-contracts/ipc";
import {
  cloudRunInProgress,
  DEFAULT_CLOUD_STATUS,
  DEFAULT_EGRESS_STATUS,
  DEFAULT_SYNC_STATUS,
  DEFAULT_WORKSPACE_SYNC,
  normalizeHostInput,
  originStateLabel,
  originTierLabel,
  overrideChoice,
  overrideFromChoice,
  queueLabel,
  relativeMs,
  restorePointKindLabel,
  restorePointSummary,
  seededHosts,
  SEEDED_HOSTS,
  sortRestorePoints,
  syncStateView,
  workspaceStateLabel,
} from "../src/lib/sync";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function status(patch: Partial<SyncStatus> = {}): SyncStatus {
  return { ...DEFAULT_SYNC_STATUS, ...patch };
}

function workspace(patch: Partial<WorkspaceSyncStatus> = {}): WorkspaceSyncStatus {
  return { ...DEFAULT_WORKSPACE_SYNC, ...patch };
}

function point(patch: Partial<RemoteRestorePoint> = {}): RemoteRestorePoint {
  return {
    deviceId: "d-1",
    name: "Studio",
    deviceKind: "desktop",
    savedAtMs: NOW - 60_000,
    tabCount: 12,
    spaceIds: ["work", "research"],
    ...patch,
  };
}

function origin(patch: Partial<SyncOriginInfo> = {}): SyncOriginInfo {
  return {
    spaceId: "work",
    host: "mail.example.com",
    tier: 1,
    rotatingAuth: false,
    sensitive: false,
    override: null,
    synced: true,
    staged: false,
    deferred: false,
    ...patch,
  };
}

function tab(patch: Partial<BrowserTabInfo> = {}): BrowserTabInfo {
  return {
    id: "t-1",
    spaceId: "work",
    title: "Mail",
    url: "https://mail.example.com/inbox",
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    kind: "human",
    runId: null,
    lifecycle: "live",
    lastActiveAt: NOW,
    unlisted: false,
    anchorId: null,
    ...patch,
  };
}

describe("the resting defaults", () => {
  it("are the off state of every plane, JSON-plain", () => {
    // One rejected getter in the store's initialize() would hang the shell,
    // so every one of these is a .catch() default that must render a page.
    expect(DEFAULT_SYNC_STATUS).toMatchObject({ state: "off", queueDepth: 0, keyMode: "e2ee", revoked: false });
    expect(DEFAULT_WORKSPACE_SYNC).toMatchObject({ state: "off", remoteRestorePoints: [] });
    expect(DEFAULT_EGRESS_STATUS).toMatchObject({ enabled: false, gateway: null, health: "unknown", spaces: [] });
    expect(DEFAULT_CLOUD_STATUS).toMatchObject({ available: false, liveState: "closed", liveTabs: [] });
    for (const value of [DEFAULT_SYNC_STATUS, DEFAULT_WORKSPACE_SYNC, DEFAULT_EGRESS_STATUS, DEFAULT_CLOUD_STATUS]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });
});

describe("the connection row", () => {
  it("words each engine state, and what it means for what is queued", () => {
    expect(syncStateView(status({ state: "connected", lastConvergedMs: NOW - 300_000 }), NOW)).toEqual({
      label: "Connected",
      note: "Everything converged 5m ago.",
      tone: "green",
    });
    expect(syncStateView(status({ state: "connected", queueDepth: 1 }), NOW).note).toBe("1 change waiting to publish.");
    expect(syncStateView(status({ state: "connecting" }), NOW)).toMatchObject({ label: "Connecting", tone: "amber" });
    expect(syncStateView(status({ state: "paused", queueDepth: 3 }), NOW).note).toBe(
      "The hub is unreachable. 3 changes waiting until it answers.",
    );
    expect(syncStateView(status({ state: "paused" }), NOW).note).toContain("Nothing is lost");
    expect(syncStateView(status(), NOW)).toMatchObject({ label: "Off", tone: "gray" });
  });

  it("says revoked whatever the engine state is, because only enrolling again dials", () => {
    const view = syncStateView(status({ state: "connected", revoked: true }), NOW);
    expect(view.label).toBe("Revoked");
    expect(view.tone).toBe("red");
  });

  it("counts the queue in words", () => {
    expect(queueLabel(0)).toBe("nothing waiting");
    expect(queueLabel(1)).toBe("1 change waiting");
    expect(queueLabel(9)).toBe("9 changes waiting");
    expect(queueLabel(Number.NaN)).toBe("nothing waiting");
  });

  it("reads a millisecond stamp the way the console reads an ISO one", () => {
    expect(relativeMs(null, NOW)).toBe("");
    expect(relativeMs(0, NOW)).toBe("");
    expect(relativeMs(NOW - 1000, NOW)).toBe("just now");
    expect(relativeMs(NOW - 7_200_000, NOW)).toBe("2h ago");
  });
});

describe("restore points", () => {
  it("offers the newest first, with a stable tie-break", () => {
    const ordered = sortRestorePoints([
      point({ deviceId: "b", name: "Beta", savedAtMs: 100 }),
      point({ deviceId: "c", name: "Gamma", savedAtMs: 300 }),
      point({ deviceId: "a", name: "Alpha", savedAtMs: 100 }),
    ]);
    expect(ordered.map((row) => row.deviceId)).toEqual(["c", "a", "b"]);
  });

  it("leaves the published list alone", () => {
    const points = [point({ deviceId: "a", savedAtMs: 1 }), point({ deviceId: "b", savedAtMs: 2 })];
    sortRestorePoints(points);
    expect(points.map((row) => row.deviceId)).toEqual(["a", "b"]);
  });

  it("summarizes one in the line under its device name", () => {
    expect(restorePointSummary(point(), NOW)).toBe("12 tabs · 2 Spaces · saved 1m ago");
    expect(restorePointSummary(point({ tabCount: 1, spaceIds: ["work"], savedAtMs: 0 }), NOW)).toBe("1 tab · 1 Space");
    expect(restorePointKindLabel(point())).toBe("Desktop");
    expect(restorePointKindLabel(point({ deviceKind: "cloud" }))).toBe("Cloud browser");
  });
});

describe("the workspace lane", () => {
  it("names its state", () => {
    expect(workspaceStateLabel(workspace())).toBe("Off");
    expect(workspaceStateLabel(workspace({ state: "idle" }))).toBe("Up to date");
    expect(workspaceStateLabel(workspace({ state: "syncing" }))).toBe("Syncing");
    expect(workspaceStateLabel(workspace({ state: "error" }))).toBe("Needs attention");
  });

  it("recognises the cloud-lease refusal, so Push is disabled with a reason rather than failing again", () => {
    const refusal = "cloud run in progress: this Mac's session state cannot be pushed while the cloud browser drives it";
    expect(cloudRunInProgress(workspace({ state: "error", error: refusal }))).toBe(true);
    expect(cloudRunInProgress(workspace({ state: "error", error: "Cloud Run In Progress" }))).toBe(true);
    expect(cloudRunInProgress(workspace({ state: "error", error: "the hub is unreachable" }))).toBe(false);
    expect(cloudRunInProgress(workspace({ state: "idle" }))).toBe(false);
  });
});

describe("the origins table", () => {
  it("says what the corpus decided and what the person's choice made of it", () => {
    expect(originTierLabel(origin())).toBe("Tier 1 · synced");
    expect(originTierLabel(origin({ tier: 2, rotatingAuth: true }))).toBe("Tier 2 · synced, rotating auth");
    expect(originTierLabel(origin({ tier: 0, synced: false }))).toBe("Tier 0 · never synced");
    // Sensitive beats the tier: it is why the tier is 0.
    expect(originTierLabel(origin({ tier: 0, sensitive: true, synced: false }))).toBe("Sensitive · never synced");
    expect(originStateLabel(origin())).toBe("Synced");
    expect(originStateLabel(origin({ override: "sync" }))).toBe("Synced (your choice)");
    expect(originStateLabel(origin({ synced: false }))).toBe("Not synced");
    expect(originStateLabel(origin({ override: "never", synced: false }))).toBe("Never (your choice)");
  });

  it("round-trips the select's third choice through the null the channel wants", () => {
    expect(overrideChoice(origin())).toBe("default");
    expect(overrideChoice(origin({ override: "never" }))).toBe("never");
    expect(overrideFromChoice("default")).toBeNull();
    expect(overrideFromChoice("sync")).toBe("sync");
    expect(overrideFromChoice(overrideChoice(origin({ override: "sync" })))).toBe("sync");
  });

  it("normalizes whatever is pasted into the host field", () => {
    expect(normalizeHostInput(" HTTPS://Mail.Example.com/inbox?x=1 ")).toBe("mail.example.com");
    expect(normalizeHostInput("mail.example.com")).toBe("mail.example.com");
    expect(normalizeHostInput("example.com.")).toBe("example.com");
    expect(normalizeHostInput("localhost:8787")).toBe("localhost");
    expect(normalizeHostInput("")).toBe("");
    expect(normalizeHostInput("not a host")).toBe("");
    // An address literal is not a cookie host key.
    expect(normalizeHostInput("http://[::1]:9/")).toBe("");
  });
});

describe("the hosts the origins table seeds itself from", () => {
  it("takes the open pages of the Space the table is showing", () => {
    const tabs = [
      tab({ id: "t-1", url: "https://mail.example.com/inbox" }),
      tab({ id: "t-2", url: "https://calendar.example.com/day" }),
    ];
    expect(seededHosts(tabs, "work")).toEqual(["mail.example.com", "calendar.example.com"]);
  });

  it("never looks the active Space's sites up under another Space", () => {
    // Every row is asked for under one Space's id, and the snapshot carries
    // the active Space's tabs — so choosing another Space in the Select seeds
    // from nothing rather than from the pages in front of the person.
    const tabs = [tab({ id: "t-1", spaceId: "work" }), tab({ id: "t-2", spaceId: "work" })];
    expect(seededHosts(tabs, "research")).toEqual([]);
    expect(seededHosts(tabs, "")).toEqual([]);
  });

  it("skips the agent's tabs, the app's own pages, and repeats", () => {
    const tabs = [
      tab({ id: "t-1", url: "https://mail.example.com/inbox" }),
      tab({ id: "t-2", url: "https://mail.example.com/settings" }),
      tab({ id: "t-3", url: "pistachio://demo/one" }),
      tab({ id: "t-4", url: "not a url" }),
      tab({ id: "t-5", url: "https://agent.example.com/", kind: "agent" }),
    ];
    expect(seededHosts(tabs, "work")).toEqual(["mail.example.com"]);
  });

  it("asks about no more hosts than it promised to", () => {
    const tabs = Array.from({ length: SEEDED_HOSTS + 4 }, (_value, index) =>
      tab({ id: `t-${String(index)}`, url: `https://site-${String(index)}.example.com/` }),
    );
    expect(seededHosts(tabs, "work")).toHaveLength(SEEDED_HOSTS);
    expect(seededHosts(tabs, "work")[0]).toBe("site-0.example.com");
  });
});
