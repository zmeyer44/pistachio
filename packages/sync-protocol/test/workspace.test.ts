import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  RECORD_KEY_PREFIXES,
  boundRestorePoint,
  applySettingsDoc,
  mergeLww,
  recordKeyId,
  settingsDocs,
  workspaceKeyFor,
  type DurableTabSession,
  type NoteBlobRecord,
  type NoteRecord,
  type SpaceDoc,
  type WorkspaceDoc,
} from "../src/index.js";

const space: SpaceDoc = {
  kind: "space",
  id: "work",
  name: "Work",
  color: "#4f46e5",
  parentSpaceId: null,
  purpose: "",
  createdAt: 1_700_000_000_000,
  carriedOrigins: [],
  egressPolicy: "identity",
  cloudEnabled: true,
};

const session: DurableTabSession = {
  version: 1,
  spaces: {
    work: {
      tabs: [
        {
          id: "tab-1",
          spaceId: "work",
          title: "GitHub",
          url: "https://github.com/",
          faviconUrl: null,
          anchorId: null,
          lastActiveAt: 1,
        },
      ],
      activeTabId: "tab-1",
      recentTabIds: ["tab-1"],
      splitGroups: [],
    },
  },
};

const note: NoteRecord = {
  id: "0a1b2c3d4e5f",
  title: "Pie",
  markdown: "# Pie\n",
  icon: null,
  blobIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: 1,
  source: { kind: "user", runId: null },
};

const noteBlob: NoteBlobRecord = {
  id: "0123456789abcdef01234567",
  mediaType: "image/png",
  byteLength: 3,
  data: "AAAA",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("workspaceKeyFor (D24: raw ids, no URL encoding)", () => {
  it("keys every doc kind exactly", () => {
    expect(workspaceKeyFor(space)).toBe("space:work");
    expect(workspaceKeyFor({ ...space, id: "8f1c7e2a-1234-4abc-9def-0123456789ab" })).toBe(
      "space:8f1c7e2a-1234-4abc-9def-0123456789ab",
    );
    expect(workspaceKeyFor({ kind: "settings", field: "keyMode", value: "e2ee" })).toBe("settings:keyMode");
    expect(
      workspaceKeyFor({
        kind: "deviceWorkspace",
        deviceId: "5d8a1c2e-3b4f-4a6c-8d9e-0f1a2b3c4d5e",
        deviceKind: "desktop",
        name: "MacBook",
        session,
        savedAtMs: 1,
      }),
    ).toBe("device-workspace:5d8a1c2e-3b4f-4a6c-8d9e-0f1a2b3c4d5e");
    expect(
      workspaceKeyFor({
        kind: "deviceActivity",
        deviceId: "5d8a1c2e-3b4f-4a6c-8d9e-0f1a2b3c4d5e",
        name: "MacBook",
        platform: "macos",
        lastActiveMs: 1,
        activeSpaceId: "work",
      }),
    ).toBe("device-activity:5d8a1c2e-3b4f-4a6c-8d9e-0f1a2b3c4d5e");
    expect(workspaceKeyFor({ kind: "note", note: note })).toBe("note:0a1b2c3d4e5f");
    expect(workspaceKeyFor({ kind: "noteBlob", blob: noteBlob })).toBe("note-blob:0123456789abcdef01234567");
  });

  it("keeps a note and its blobs on prefixes that cannot be mistaken for each other", () => {
    // `note-blob:` does not start with `note:`, so a reader listing notes by
    // prefix never picks up a megabyte of image (docs/notes.md N3).
    expect(RECORD_KEY_PREFIXES).toContain("note:");
    expect(RECORD_KEY_PREFIXES).toContain("note-blob:");
    expect(recordKeyId("note-blob:0123456789abcdef01234567", "note:")).toBeNull();
    expect(recordKeyId("note-blob:0123456789abcdef01234567", "note-blob:")).toBe("0123456789abcdef01234567");
    expect(recordKeyId("note:0a1b2c3d4e5f", "note:")).toBe("0a1b2c3d4e5f");
  });

  it("keeps a group's context and its files on prefixes of their own", () => {
    // `group-blob:` does not start with `group-context:`: listing contexts never picks up a file's bytes.
    expect(RECORD_KEY_PREFIXES).toContain("group-context:");
    expect(RECORD_KEY_PREFIXES).toContain("group-blob:");
    for (const prefix of RECORD_KEY_PREFIXES) {
      for (const other of RECORD_KEY_PREFIXES) if (prefix !== other) expect(other.startsWith(prefix)).toBe(false);
      // The hub fences `device-` keys to the device that wrote them.
      expect(prefix.startsWith("device-")).toBe(false);
    }
    const context = { groupId: "3f2a9c1e-7b4d-4e8a-9c1f-2d3e4f5a6b7c", title: "Lisbon", items: [], updatedAt: "2026-09-30T10:00:00.000Z" };
    expect(workspaceKeyFor({ kind: "groupContext", context })).toBe("group-context:3f2a9c1e-7b4d-4e8a-9c1f-2d3e4f5a6b7c");
    const blob = { id: "0123456789abcdef01234567", mediaType: "application/pdf" as const, byteLength: 3, data: "AAAA", createdAt: "2026-09-30T10:00:00.000Z" };
    expect(workspaceKeyFor({ kind: "groupBlob", blob })).toBe("group-blob:0123456789abcdef01234567");
  });

  it("never URL-encodes or otherwise rewrites the id segment", () => {
    const odd = "id with space/and:colon";
    const doc: WorkspaceDoc = {
      kind: "deviceActivity",
      deviceId: odd,
      name: "n",
      platform: "cloud",
      lastActiveMs: 0,
      activeSpaceId: null,
    };
    expect(workspaceKeyFor(doc)).toBe(`device-activity:${odd}`);
    expect(workspaceKeyFor(doc).slice("device-activity:".length)).toBe(odd);
  });
});

describe("settings registers", () => {
  it("fans out and folds back per field", () => {
    const docs = settingsDocs(DEFAULT_WORKSPACE_SETTINGS);
    expect(docs).toEqual([{ kind: "settings", field: "keyMode", value: "e2ee" }]);
    expect(applySettingsDoc({ keyMode: "e2ee" }, docs[0]!)).toEqual({ keyMode: "e2ee" });
    expect(docs.map(workspaceKeyFor)).toEqual(["settings:keyMode"]);
  });
});

describe("mergeLww", () => {
  it("adopts the incoming register when nothing is stored and keeps the newer HLC otherwise", () => {
    const a = { value: space, hlc: { physicalMs: 1, logical: 0, deviceId: "a" } };
    const tombstone = { value: null, hlc: { physicalMs: 1, logical: 1, deviceId: "a" } };
    expect(mergeLww(undefined, a)).toBe(a);
    expect(mergeLww(a, tombstone)).toBe(tombstone);
    expect(mergeLww(tombstone, a)).toBe(tombstone);
    // Equal HLCs keep the current register (idempotent re-delivery).
    expect(mergeLww(a, { ...a })).toBe(a);
  });
});

it("drops portable page details before tab identities when bounding a restore point", () => {
  const large = structuredClone(session);
  const space = large.spaces.work!;
  const tab = space.tabs[0]!;
  space.tabs = Array.from({ length: 100 }, (_, i) => ({ ...tab, id: `tab-${i}`, resume: { url: tab.url, scrollX: 0, scrollY: i, drafts: [{ id: "draft", name: "", value: "漢".repeat(8192) }] } }));
  const bounded = boundRestorePoint(large, 100_000);
  expect(bounded.spaces.work?.tabs.map(tab => tab.id)).toEqual(space.tabs.map(tab => tab.id));
  expect(bounded.spaces.work?.tabs.every(tab => tab.resume === undefined)).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThan(100_000);
  expect(large.spaces.work?.tabs[0]?.resume).toBeDefined();
});
