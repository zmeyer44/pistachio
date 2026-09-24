/**
 * The pure workspace-sync logic (docs/cloud-sync-design.md §10.2, D9,
 * workspace-map.ts): Space store state ⇄ workspace docs, the LWW+HLC merge
 * decision for incoming docs, and the readers that turn opened values back
 * into typed restore points and liveness cards.
 */

import { describe, expect, it } from "vitest";
import { workspaceKeyFor, type Hlc, type WorkspaceDoc } from "@pistachio/sync-protocol";
import {
  decideMerge,
  deviceIdOfKey,
  docsForState,
  DEVICE_ACTIVITY_KEY_PREFIX,
  DEVICE_WORKSPACE_KEY_PREFIX,
  readDeviceActivityDoc,
  readDeviceWorkspaceDoc,
  restorePointInfo,
  spaceDocFor,
  spaceIdOfKey,
  type WorkspaceRegister,
} from "../src/main/sync/workspace-map";
import { DEFAULT_SPACE, type SpaceInfo } from "@pistachio/shell-contracts/spaces";

function hlc(physicalMs: number, deviceId = "device-a", logical = 0): Hlc {
  return { physicalMs, logical, deviceId };
}

const personal: SpaceInfo = {
  ...DEFAULT_SPACE,
  id: "s1",
  name: "Personal",
  color: "#5b8cff",
  createdAt: 1000,
};

const spaceDoc: WorkspaceDoc = spaceDocFor(personal);

describe("docsForState", () => {
  it("maps Spaces and the per-field settings to docs with the protocol's keys (D9)", () => {
    const docs = docsForState({ spaces: [personal, DEFAULT_SPACE], settings: { keyMode: "e2ee" } });
    expect(docs.map(workspaceKeyFor).sort()).toEqual(["settings:keyMode", "space:s1", "space:work"]);
    // A Space doc is flat and carries the sync fields (§2 SpaceDoc).
    expect(docs[0]).toEqual({
      kind: "space",
      id: "s1",
      name: "Personal",
      color: "#5b8cff",
      parentSpaceId: null,
      purpose: "",
      createdAt: 1000,
      carriedOrigins: [],
      egressPolicy: "direct",
      cloudEnabled: false,
    });
  });

  it("copies carriedOrigins so the doc never aliases the store's array", () => {
    const space: SpaceInfo = { ...personal, carriedOrigins: ["https://a.example"] };
    const doc = spaceDocFor(space);
    space.carriedOrigins.push("https://b.example");
    expect(doc.carriedOrigins).toEqual(["https://a.example"]);
  });
});

describe("key readers", () => {
  it("reads Space ids only from well-formed space: keys", () => {
    expect(spaceIdOfKey("space:work")).toBe("work");
    expect(spaceIdOfKey("space:8f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f")).toBe("8f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f");
    expect(spaceIdOfKey("space:")).toBeNull();
    expect(spaceIdOfKey("space:Bad Id")).toBeNull();
    expect(spaceIdOfKey("settings:keyMode")).toBeNull();
  });

  it("reads raw device ids from device-workspace: and device-activity: keys (D24: no URL encoding)", () => {
    expect(deviceIdOfKey(`${DEVICE_WORKSPACE_KEY_PREFIX}dev-1`, DEVICE_WORKSPACE_KEY_PREFIX)).toBe("dev-1");
    expect(deviceIdOfKey(`${DEVICE_ACTIVITY_KEY_PREFIX}dev%201`, DEVICE_ACTIVITY_KEY_PREFIX)).toBe("dev%201");
    expect(deviceIdOfKey(DEVICE_WORKSPACE_KEY_PREFIX, DEVICE_WORKSPACE_KEY_PREFIX)).toBeNull();
    expect(deviceIdOfKey("space:work", DEVICE_WORKSPACE_KEY_PREFIX)).toBeNull();
  });
});

describe("decideMerge (LWW+HLC)", () => {
  const local: Record<string, WorkspaceRegister> = {
    "space:s1": { doc: spaceDoc, hlc: hlc(100, "device-a") },
  };

  it("applies a newer remote doc with a different value", () => {
    const renamed: WorkspaceDoc = { ...spaceDocFor(personal), name: "Work" };
    const decision = decideMerge(local, [{ key: "space:s1", value: renamed, hlc: hlc(200, "device-b") }]);
    expect(decision.apply).toHaveLength(1);
    expect(decision.adoptHlc).toHaveLength(0);
  });

  it("drops an older remote doc", () => {
    const decision = decideMerge(local, [{ key: "space:s1", value: null, hlc: hlc(50, "device-b") }]);
    expect(decision.apply).toHaveLength(0);
    expect(decision.adoptHlc).toHaveLength(0);
  });

  it("drops an equal-HLC doc (idempotent redelivery)", () => {
    const decision = decideMerge(local, [{ key: "space:s1", value: spaceDoc, hlc: hlc(100, "device-a") }]);
    expect(decision.apply).toHaveLength(0);
    expect(decision.adoptHlc).toHaveLength(0);
  });

  it("suppresses echoes: a newer doc equal to local state applies nothing", () => {
    const decision = decideMerge(local, [{ key: "space:s1", value: spaceDoc, hlc: hlc(300, "device-b") }]);
    // Adopt the HLC, apply nothing — no state change, no republish loop.
    expect(decision.apply).toHaveLength(0);
    expect(decision.adoptHlc).toHaveLength(1);
  });

  it("applies docs for unknown keys, including tombstones", () => {
    const decision = decideMerge(local, [
      { key: "space:s2", value: spaceDocFor({ ...personal, id: "s2" }), hlc: hlc(150, "device-b") },
      { key: "space:gone", value: null, hlc: hlc(151, "device-b") },
    ]);
    expect(decision.apply.map((d) => d.key)).toEqual(["space:s2", "space:gone"]);
  });

  it("applies a newer tombstone over a live local doc", () => {
    const decision = decideMerge(local, [{ key: "space:s1", value: null, hlc: hlc(400, "device-b") }]);
    expect(decision.apply).toHaveLength(1);
    expect(decision.apply[0]?.value).toBeNull();
  });
});

describe("restore point readers", () => {
  const session = {
    version: 1,
    spaces: {
      work: {
        tabs: [
          { id: "t1", spaceId: "work", title: "A", url: "https://a.example/", faviconUrl: null, anchorId: null, lastActiveAt: 1 },
          { id: "t2", spaceId: "work", title: "B", url: "https://b.example/", faviconUrl: null, anchorId: null, lastActiveAt: 2 },
        ],
        activeTabId: "t2",
        recentTabIds: ["t2", "t1"],
        splitGroups: [],
      },
    },
  };

  it("reads another device's restore point, sanitizing the session and refusing a mismatched device id", () => {
    const doc = readDeviceWorkspaceDoc("device-b", {
      kind: "deviceWorkspace",
      deviceId: "device-b",
      deviceKind: "desktop",
      name: "  Mac B  ",
      session: { ...session, spaces: { ...session.spaces, "Bad Id": session.spaces.work } },
      savedAtMs: 5000,
    });
    expect(doc).not.toBeNull();
    expect(doc?.name).toBe("Mac B");
    expect(Object.keys(doc?.session.spaces ?? {})).toEqual(["work"]);
    expect(doc?.session.spaces["work"]?.activeTabId).toBe("t2");
    expect(readDeviceWorkspaceDoc("device-b", { kind: "deviceWorkspace", deviceId: "device-c", session, savedAtMs: 1 })).toBeNull();
    expect(readDeviceWorkspaceDoc("device-b", { kind: "space", id: "x" })).toBeNull();
    expect(readDeviceWorkspaceDoc("device-b", "nonsense")).toBeNull();
  });

  it("summarizes a restore point for the settings page, naming it from the activity card when the point has no name", () => {
    const doc = readDeviceWorkspaceDoc("device-b", { kind: "deviceWorkspace", deviceId: "device-b", deviceKind: "cloud", name: "", session, savedAtMs: 5000 });
    const activity = readDeviceActivityDoc("device-b", {
      kind: "deviceActivity",
      deviceId: "device-b",
      name: "Cloud browser",
      platform: "cloud",
      lastActiveMs: 4000,
      activeSpaceId: "work",
    });
    expect(activity).toEqual({ kind: "deviceActivity", deviceId: "device-b", name: "Cloud browser", platform: "cloud", lastActiveMs: 4000, activeSpaceId: "work" });
    expect(restorePointInfo(doc!, activity)).toEqual({
      deviceId: "device-b",
      name: "Cloud browser",
      deviceKind: "cloud",
      savedAtMs: 5000,
      tabCount: 2,
      spaceIds: ["work"],
    });
    expect(restorePointInfo(doc!, null).name).toBe("Cloud browser device-b");
    expect(readDeviceActivityDoc("device-b", { kind: "deviceActivity", deviceId: "device-z" })).toBeNull();
  });
});
