import { describe, expect, it } from "vitest";
import type { ThreadListItem } from "@pistachio/protocol";
import type { AccountState, ChannelInfo, CloudStatus, EgressStatus, SyncStatus, WorkspaceSyncStatus } from "@pistachio/shell-contracts/ipc";
import { DEFAULT_ACCOUNT } from "../src/lib/account";
import {
  channelNameError,
  channelSeenLabel,
  cloudEnabledSpaceIds,
  cloudReadiness,
  cloudAgentIsDriving,
  cloudSpaceEnabled,
  isCloudRun,
  liveCloudThreads,
  liveStateView,
  outboundUrlError,
  outboundUrlValue,
  sortChannels,
} from "../src/lib/cloud";
import { browserPlanes, MANAGED_ELSEWHERE, planesFor, syncPillView } from "../src/lib/chrome-status";
import {
  DEFAULT_CLOUD_STATUS,
  DEFAULT_EGRESS_STATUS,
  DEFAULT_SYNC_STATUS,
  DEFAULT_WORKSPACE_SYNC,
} from "../src/lib/sync";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function cloud(patch: Partial<CloudStatus> = {}): CloudStatus {
  return { ...DEFAULT_CLOUD_STATUS, ...patch };
}

function thread(patch: Partial<ThreadListItem> = {}): ThreadListItem {
  return {
    runId: "run-1",
    title: "Renew the domain",
    status: "running",
    startedAt: new Date(NOW - 120_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    turns: 1,
    messageCount: 2,
    ...patch,
  };
}

function channel(patch: Partial<ChannelInfo> = {}): ChannelInfo {
  return {
    linkId: "ch-1",
    name: "Support inbox",
    spaceId: "work",
    outboundUrl: null,
    createdAt: new Date(NOW - 3 * 86_400_000).toISOString(),
    revokedAt: null,
    ...patch,
  };
}

describe("cloud runs", () => {
  it("knows a run this desktop did not execute", () => {
    expect(isCloudRun(thread({ executor: { kind: "cloud", deviceId: "d", workerId: "w" } }))).toBe(true);
    expect(isCloudRun(thread({ executor: { kind: "desktop" } }))).toBe(false);
    // Absent means this desktop runs it (packages/protocol).
    expect(isCloudRun(thread())).toBe(false);
    expect(isCloudRun(null)).toBe(false);
  });

  it("lists the cloud runs still going, newest first", () => {
    const executor = { kind: "cloud", deviceId: null, workerId: null } as const;
    const rows = liveCloudThreads([
      thread({ runId: "old", executor, updatedAt: new Date(NOW - 600_000).toISOString() }),
      thread({ runId: "done", executor, status: "completed" }),
      thread({ runId: "local" }),
      thread({ runId: "new", executor, updatedAt: new Date(NOW - 5_000).toISOString() }),
    ]);
    expect(rows.map((row) => row.runId)).toEqual(["new", "old"]);
  });
});

describe("cloudReadiness", () => {
  const enabled = cloud({ available: true, device: { deviceId: "cloud-1", agreementPublicKey: "k", fingerprint: "a".repeat(32) }, spaces: [{ spaceId: "work", enabled: true }] });

  it("is ready only for a Space whose key the cloud browser holds", () => {
    expect(cloudReadiness(enabled, "work")).toEqual({ ready: true, reason: null });
    expect(cloudReadiness(enabled, "personal").ready).toBe(false);
    expect(cloudReadiness(enabled, "personal").reason).toContain("not enabled");
  });

  it("says what is missing, one reason at a time", () => {
    expect(cloudReadiness(DEFAULT_CLOUD_STATUS, "work").reason).toContain("enroll");
    expect(cloudReadiness(cloud({ available: true }), "work").reason).toContain("key");
    expect(cloudReadiness(enabled, null).reason).toContain("Space");
  });

  it("reads a Space's enablement from the status, falling back to the Space's own flag", () => {
    expect(cloudSpaceEnabled(enabled, "work")).toBe(true);
    expect(cloudSpaceEnabled(enabled, "other")).toBe(false);
    expect(cloudSpaceEnabled(enabled, "other", true)).toBe(true);
    expect(cloudSpaceEnabled(enabled, null, true)).toBe(false);
    expect(cloudEnabledSpaceIds(enabled)).toEqual(["work"]);
  });
});

describe("cloudAgentIsDriving", () => {
  it("lights the live view's frame only while the cloud browser says the agent is on the page", () => {
    expect(cloudAgentIsDriving(cloud({ liveState: "open", liveControl: "agent", liveStatus: "running" }))).toBe(true);
    // The person took the page, or the run is waiting on them: no light.
    expect(cloudAgentIsDriving(cloud({ liveState: "open", liveControl: "human", liveStatus: "human_control" }))).toBe(false);
    expect(cloudAgentIsDriving(cloud({ liveState: "open", liveControl: "agent", liveStatus: "waiting_for_judgment" }))).toBe(false);
    // Nothing on screen to light: not open, or no status heard yet.
    expect(cloudAgentIsDriving(cloud({ liveState: "connecting", liveControl: "agent", liveStatus: "running" }))).toBe(false);
    expect(cloudAgentIsDriving(cloud({ liveState: "open", liveControl: "agent", liveStatus: null }))).toBe(false);
    expect(cloudAgentIsDriving(DEFAULT_CLOUD_STATUS)).toBe(false);
  });
});

describe("liveStateView", () => {
  it("distinguishes watching from driving", () => {
    expect(liveStateView(cloud({ liveState: "open", liveControl: "agent" })).label).toBe("Watching");
    expect(liveStateView(cloud({ liveState: "open", liveControl: "human" })).label).toBe("You have control");
    expect(liveStateView(cloud({ liveState: "connecting" })).tone).toBe("amber");
    expect(liveStateView(cloud({ liveState: "revoked", liveError: "device revoked" })).note).toBe("device revoked");
    expect(liveStateView(DEFAULT_CLOUD_STATUS).label).toBe("Closed");
  });
});

describe("channels", () => {
  it("puts live channels first, newest first, and names when each happened", () => {
    const rows = sortChannels([
      channel({ linkId: "revoked", revokedAt: new Date(NOW - 60_000).toISOString() }),
      channel({ linkId: "older", createdAt: new Date(NOW - 10 * 86_400_000).toISOString() }),
      channel({ linkId: "newer", createdAt: new Date(NOW - 60_000).toISOString() }),
    ]);
    expect(rows.map((row) => row.linkId)).toEqual(["newer", "older", "revoked"]);
    expect(channelSeenLabel(channel({ createdAt: new Date(NOW - 60_000).toISOString() }), NOW)).toBe("Created 1m ago");
    expect(channelSeenLabel(channel({ revokedAt: new Date(NOW - 60_000).toISOString() }), NOW)).toBe("Revoked 1m ago");
    expect(channelSeenLabel(channel({ createdAt: null }), NOW)).toBe("Created");
  });

  it("refuses a nameless channel and an address that is not one", () => {
    expect(channelNameError("  ")).toContain("name");
    expect(channelNameError("x".repeat(200))).toContain("64");
    expect(channelNameError("Support")).toBeNull();
    expect(outboundUrlError("")).toBeNull();
    expect(outboundUrlError("   ")).toBeNull();
    expect(outboundUrlError("example.com/hook")).toContain("web address");
    expect(outboundUrlError("ftp://example.com/hook")).toContain("http");
    expect(outboundUrlError("https://example.com/hook")).toBeNull();
  });

  it("sends the address only when one was typed", () => {
    expect(outboundUrlValue("  ")).toBeUndefined();
    expect(outboundUrlValue(" https://example.com/hook ")).toBe("https://example.com/hook");
  });
});

/* ------------------------------ the chrome ------------------------------- */

function sync(patch: Partial<SyncStatus> = {}): SyncStatus {
  return { ...DEFAULT_SYNC_STATUS, ...patch };
}

function workspace(patch: Partial<WorkspaceSyncStatus> = {}): WorkspaceSyncStatus {
  return { ...DEFAULT_WORKSPACE_SYNC, ...patch };
}

function pill(patch: { sync?: SyncStatus; workspace?: WorkspaceSyncStatus; cloud?: CloudStatus; threads?: ThreadListItem[] } = {}) {
  return syncPillView({
    sync: patch.sync ?? sync({ state: "connected" }),
    workspace: patch.workspace ?? DEFAULT_WORKSPACE_SYNC,
    cloud: patch.cloud ?? DEFAULT_CLOUD_STATUS,
    threads: patch.threads ?? [],
  });
}

describe("the sync pill", () => {
  it("says nothing while sync is doing its job", () => {
    expect(pill()).toBeNull();
    // Off is not news either: a Mac with no account is not a Mac with a problem.
    expect(pill({ sync: sync({ state: "off" }) })).toBeNull();
    expect(pill({ sync: sync({ state: "connecting" }) })).toBeNull();
  });

  it("speaks for the four states worth interrupting for", () => {
    expect(pill({ sync: sync({ revoked: true }) })).toMatchObject({ state: "revoked", tone: "red", action: { kind: "settings", section: "account" } });
    expect(pill({ sync: sync({ state: "paused" }) })).toMatchObject({ state: "paused", tone: "amber" });
    expect(pill({ sync: sync({ state: "connected", queueDepth: 3 }) })).toMatchObject({ state: "queued", label: "3 changes waiting" });
    const executor = { kind: "cloud", deviceId: null, workerId: null } as const;
    expect(pill({ threads: [thread({ runId: "r-9", executor })] })).toMatchObject({
      state: "cloud-run",
      label: "Cloud run",
      action: { kind: "live", runId: "r-9" },
    });
  });

  it("prefers the stuck state to the busy one — a paused engine is the more urgent fact", () => {
    const executor = { kind: "cloud", deviceId: null, workerId: null } as const;
    expect(pill({ sync: sync({ state: "paused" }), threads: [thread({ executor })] })?.state).toBe("paused");
  });

  it("still speaks for a cloud lease this Mac has no thread for", () => {
    const view = pill({
      workspace: workspace({ state: "error", error: "refused: cloud run in progress" }),
      cloud: cloud({ available: true }),
    });
    expect(view).toMatchObject({ state: "cloud-run", action: { kind: "settings", section: "cloud" } });
  });
});

describe("the browser-status rows", () => {
  function planes(patch: {
    account?: Partial<AccountState>;
    sync?: Partial<SyncStatus>;
    cloud?: Partial<CloudStatus>;
    egress?: Partial<EgressStatus>;
    activeSpaceId?: string | null;
    threads?: ThreadListItem[];
  }) {
    return browserPlanes({
      account: { ...DEFAULT_ACCOUNT, ...patch.account },
      sync: sync(patch.sync),
      cloud: cloud(patch.cloud),
      egress: { ...DEFAULT_EGRESS_STATUS, ...patch.egress },
      activeSpaceId: patch.activeSpaceId === undefined ? "work" : patch.activeSpaceId,
      threads: patch.threads ?? [],
    });
  }

  it("is always three rows, in one order, each with a page to open", () => {
    const rows = planes({});
    expect(rows.map((row) => row.id)).toEqual(["identity", "cloud", "egress"]);
    for (const row of rows) {
      expect(row.value.length).toBeGreaterThan(0);
      expect(row.note.length).toBeGreaterThan(0);
      expect(row.section.length).toBeGreaterThan(0);
    }
  });

  it("states the account plainly instead of claiming a connection", () => {
    expect(planes({})[0]).toMatchObject({ value: "Signed out", tone: "gray", section: "account" });
    expect(planes({ account: { state: "signed-up" } })[0]?.value).toBe("Not enrolled");
    expect(planes({ account: { state: "enrolled", email: "ada@example.com" }, sync: { state: "connected" } })[0]).toMatchObject({
      value: "Connected",
      section: "sync",
    });
    expect(planes({ account: { revoked: true } })[0]).toMatchObject({ value: "Revoked", tone: "red" });
  });

  it("says whether the cloud browser can open the Space in front of you", () => {
    expect(planes({})[1]?.value).toBe("Off");
    expect(planes({ cloud: { available: true } })[1]?.value).toBe("No Spaces");
    const enabled = { available: true, spaces: [{ spaceId: "work", enabled: true }] };
    expect(planes({ cloud: enabled })[1]?.value).toBe("This Space");
    expect(planes({ cloud: enabled, activeSpaceId: "personal" })[1]?.value).toBe("1 Spaces");
    const executor = { kind: "cloud", deviceId: null, workerId: null } as const;
    expect(planes({ cloud: enabled, threads: [thread({ executor })] })[1]).toMatchObject({ value: "Running", tone: "blue" });
  });

  it("reads egress for the active Space, not for the account", () => {
    expect(planes({})[2]?.value).toBe("Direct");
    const blocked = {
      enabled: true,
      health: "down" as const,
      spaces: [{ spaceId: "work", policy: "identity" as const, failClosed: true, temporaryDirectOverride: false, restartRequired: false }],
    };
    expect(planes({ egress: blocked })[2]).toMatchObject({ value: "Blocked", tone: "red", section: "egress" });
    // Another Space's trouble is still worth a word on a direct Space's row.
    expect(planes({ egress: blocked, activeSpaceId: "personal" })[2]?.note).toContain("Another Space");
  });
});

/**
 * The same card, in a browser tab.
 *
 * All four subjects the rows report on — the account, sync, the cloud browser
 * and egress — are refused by the session host as "managed from the web app's
 * settings pages" (docs/web-browser-design.md §11), so this shell is never
 * sent an account, a sync status, a cloud status or an egress status. The
 * three rows would therefore each report their RESTING DEFAULT: "Signed out",
 * "Off", "Direct". None of those is true of the person looking at them — they
 * signed in on the way to this page, their sessions are syncing, and the tabs
 * they are watching ARE the cloud browser — and a card whose job is to be
 * trusted must not state a default that was never answered as a fact.
 */
describe("the browser-status rows in a browser tab", () => {
  function stream(accountUrl?: string) {
    return planesFor(
      {
        account: DEFAULT_ACCOUNT,
        sync: sync(),
        cloud: cloud(),
        egress: DEFAULT_EGRESS_STATUS,
        activeSpaceId: "work",
        threads: [],
        accountUrl,
      },
      "stream",
    );
  }

  it("folds the four subjects into one row that says where they live", () => {
    const rows = stream("https://pistachio.test/app");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "managed",
      label: "Account & sync",
      value: "Web app",
      note: MANAGED_ELSEWHERE,
      tone: "gray",
      section: "account",
    });
    expect(MANAGED_ELSEWHERE).toBe("Account, sync, cloud and egress are managed from the web app");
  });

  it("never renders a status nothing published — the whole point", () => {
    const line = stream().map((row) => `${row.label} ${row.value} ${row.note}`).join(" ");
    for (const claim of ["Signed out", "Not enrolled", "Direct", "Off", "No Spaces", "Revoked"]) {
      expect(line, `a browser tab must not report "${claim}" from a status nobody sent`).not.toContain(claim);
    }
    // And nothing about a Mac, which is what those rows say when they do speak.
    expect(line).not.toMatch(/Mac/u);
  });

  it("carries the dashboard's account page, by the same route Settings → Account offers", () => {
    expect(stream("https://pistachio.test/app")[0]?.href).toBe("https://pistachio.test/app/settings/account");
    // A trailing slash is the same address, and a surface with no dashboard
    // to point at gets a row with somewhere to go inside the app instead.
    expect(stream("https://pistachio.test/app/")[0]?.href).toBe("https://pistachio.test/app/settings/account");
    expect(stream()[0]?.href).toBeNull();
    expect(stream()[0]?.section).toBe("account");
  });

  it("leaves the desktop's three rows exactly as they were", () => {
    const input = {
      account: DEFAULT_ACCOUNT,
      sync: sync(),
      cloud: cloud(),
      egress: DEFAULT_EGRESS_STATUS,
      activeSpaceId: "work",
      threads: [],
    };
    expect(planesFor(input, "native")).toEqual(browserPlanes(input));
    expect(planesFor(input).map((row) => row.id)).toEqual(["identity", "cloud", "egress"]);
    for (const row of planesFor(input)) expect(row.href).toBeNull();
  });
});

describe("the sync pill in a browser tab", () => {
  function streamPill(patch: { sync?: SyncStatus; workspace?: WorkspaceSyncStatus; cloud?: CloudStatus; threads?: ThreadListItem[] } = {}) {
    return syncPillView({
      sync: patch.sync ?? sync({ state: "connected" }),
      workspace: patch.workspace ?? DEFAULT_WORKSPACE_SYNC,
      cloud: patch.cloud ?? DEFAULT_CLOUD_STATUS,
      threads: patch.threads ?? [],
      surface: "stream",
    });
  }

  it("says nothing about a hub this session does not dial", () => {
    // Each of these speaks on a Mac; here they could only be the default.
    expect(streamPill({ sync: sync({ revoked: true }) })).toBeNull();
    expect(streamPill({ sync: sync({ state: "paused" }) })).toBeNull();
    expect(streamPill({ sync: sync({ state: "paused", queueDepth: 4 }) })).toBeNull();
    expect(streamPill({ sync: sync({ state: "connected", queueDepth: 3 }) })).toBeNull();
  });

  it("still speaks for a run working in this very session", () => {
    const executor = { kind: "cloud", deviceId: null, workerId: null } as const;
    expect(streamPill({ threads: [thread({ runId: "r-9", executor })] })).toMatchObject({
      state: "cloud-run",
      action: { kind: "live", runId: "r-9" },
    });
  });

  it("leaves the Mac's pill untouched", () => {
    expect(pill({ sync: sync({ state: "paused" }) })).toMatchObject({ state: "paused", tone: "amber" });
    expect(pill({ sync: sync({ revoked: true }) })).toMatchObject({ state: "revoked" });
  });
});
