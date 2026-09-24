import { describe, expect, it } from "vitest";
import {
  FRAME_BUDGET_BYTES,
  MAX_FRAME_BYTES,
  MAX_RESTORE_POINT_BYTES,
  TAB_SESSION_VERSION,
  boundRestorePoint,
  chunkFrames,
  workspaceRecordBytes,
  type DurableTab,
  type DurableTabSession,
  type WorkspaceRecordWire,
} from "../src/index.js";

function doc(key: string, sealedBytes: number): WorkspaceRecordWire {
  return {
    key,
    sealedValue: "a".repeat(sealedBytes),
    hlc: { physicalMs: 1, logical: 0, deviceId: "dev-a" },
    deviceSig: "c2ln",
  };
}

describe("chunkFrames", () => {
  it("keeps a frame under the byte budget even when the count cap is far away", () => {
    // A sealed 1.5 MB artifact is ~2 MB of base64; ten of them chunked by
    // count alone would be one ~20 MB frame.
    const docs = Array.from({ length: 10 }, (_, i) =>
      doc(`artifact:${String(i)}`, 2_000_000),
    );
    const frames = chunkFrames(docs, workspaceRecordBytes, 256);

    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      const bytes = frame.reduce((sum, d) => sum + workspaceRecordBytes(d), 0);
      expect(bytes).toBeLessThanOrEqual(FRAME_BUDGET_BYTES);
    }
    expect(frames.flat().map((d) => d.key)).toEqual(docs.map((d) => d.key));
  });

  it("still caps by count when records are small", () => {
    const docs = Array.from({ length: 300 }, (_, i) =>
      doc(`space:${String(i)}`, 8),
    );
    const frames = chunkFrames(docs, workspaceRecordBytes, 256);
    expect(frames.map((f) => f.length)).toEqual([256, 44]);
  });

  it("gives an over-budget record its own frame rather than dropping it", () => {
    const docs = [
      doc("space:1", 8),
      doc("artifact:huge", FRAME_BUDGET_BYTES + 1),
      doc("space:2", 8),
    ];
    const frames = chunkFrames(docs, workspaceRecordBytes, 256);
    expect(frames.map((f) => f.map((d) => d.key))).toEqual([
      ["space:1"],
      ["artifact:huge"],
      ["space:2"],
    ]);
    // The socket still carries it: the hard cap leaves headroom over the budget.
    expect(workspaceRecordBytes(docs[1] as WorkspaceRecordWire)).toBeLessThan(
      MAX_FRAME_BYTES,
    );
  });

  it("returns no frames for no records", () => {
    expect(chunkFrames([], workspaceRecordBytes, 256)).toEqual([]);
  });
});

describe("chunkFrames oversized records", () => {
  it("withholds and reports a record that cannot fit a frame at all", () => {
    const huge = doc("device-workspace:dev-a", MAX_FRAME_BYTES + 1);
    const docs = [doc("space:1", 8), huge, doc("space:2", 8)];
    const withheld: string[] = [];
    const frames = chunkFrames(docs, workspaceRecordBytes, 256, (d) =>
      withheld.push(d.key),
    );

    // The lane keeps working: everything deliverable is still delivered.
    expect(frames.flat().map((d) => d.key)).toEqual(["space:1", "space:2"]);
    expect(withheld).toEqual(["device-workspace:dev-a"]);
  });
});

describe("boundRestorePoint", () => {
  function tab(
    id: string,
    lastActiveAt: number,
    favicon: string | null,
  ): DurableTab {
    return {
      id,
      spaceId: "s1",
      title: "A tab",
      url: `https://example.com/${id}`,
      faviconUrl: favicon,
      anchorId: null,
      lastActiveAt,
    };
  }

  function session(
    tabs: DurableTab[],
    activeTabId: string | null = null,
  ): DurableTabSession {
    return {
      version: TAB_SESSION_VERSION,
      spaces: {
        s1: {
          tabs,
          activeTabId,
          recentTabIds: tabs.map((t) => t.id),
          splitGroups: [],
        },
      },
    };
  }

  it("returns a session that already fits untouched", () => {
    const fits = session([tab("a", 1, null), tab("b", 2, null)]);
    expect(boundRestorePoint(fits)).toBe(fits);
  });

  it("drops data: favicons before it drops any tab", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(16_000)}`;
    const tabs = Array.from({ length: 100 }, (_, i) =>
      tab(`t${String(i)}`, i, dataUrl),
    );
    const bounded = boundRestorePoint(session(tabs), 200_000);

    expect(bounded.spaces["s1"]?.tabs).toHaveLength(100);
    expect(bounded.spaces["s1"]?.tabs.every((t) => t.faviconUrl === null)).toBe(
      true,
    );
  });

  it("keeps http favicons, which are small", () => {
    const tabs = Array.from({ length: 3 }, (_, i) =>
      tab(`t${String(i)}`, i, "https://example.com/f.ico"),
    );
    const bounded = boundRestorePoint(session(tabs), 100);
    expect(bounded.spaces["s1"]?.tabs.every((t) => t.faviconUrl !== null)).toBe(
      true,
    );
  });

  it("drops least-recently-active tabs, keeping the active one, and repairs ids", () => {
    const tabs = [
      tab("old", 1, null),
      tab("mid", 2, null),
      tab("new", 3, null),
      tab("active", 0, null),
    ];
    const bounded = boundRestorePoint(session(tabs, "active"), 700);
    const kept = bounded.spaces["s1"]?.tabs.map((t) => t.id) ?? [];

    expect(kept.length).toBeLessThan(tabs.length);
    // Oldest goes first, but the active tab outlives every older sibling.
    expect(kept).toContain("active");
    expect(kept).not.toContain("old");
    expect(bounded.spaces["s1"]?.activeTabId).toBe("active");
    expect(
      bounded.spaces["s1"]?.recentTabIds.every((id) => kept.includes(id)),
    ).toBe(true);
  });

  it("drops a split group that lost a member rather than leaving a dangling id", () => {
    const tabs = [tab("old", 1, null), tab("new", 9, null)];
    const base = session(tabs, "new");
    const space = base.spaces["s1"];
    if (space !== undefined) {
      space.splitGroups = [
        {
          id: "g1",
          tabIds: ["old", "new"],
          primaryTabId: "old",
          secondaryTabId: "new",
          mode: "vertical",
          gridLayout: "span-top",
        },
      ];
    }
    const bounded = boundRestorePoint(base, 420);
    const kept = bounded.spaces["s1"];

    expect(kept?.tabs.map((t) => t.id)).toEqual(["new"]);
    expect(kept?.splitGroups).toEqual([]);
  });

  it("thins a Space but never deletes one, however small the budget", () => {
    const spaces: DurableTabSession["spaces"] = {};
    for (let i = 0; i < 5; i += 1) {
      const tabs = Array.from({ length: 20 }, (_, t) => ({
        ...tab(`t${String(t)}`, t, null),
        spaceId: `s${String(i)}`,
      }));
      spaces[`s${String(i)}`] = {
        tabs,
        activeTabId: "t7",
        recentTabIds: [],
        splitGroups: [],
      };
    }
    const bounded = boundRestorePoint(
      { version: TAB_SESSION_VERSION, spaces },
      1,
    );

    expect(Object.keys(bounded.spaces)).toHaveLength(5);
    for (const space of Object.values(bounded.spaces)) {
      // Thinned to the floor, and the floor is the tab the person was on.
      expect(space.tabs.map((t) => t.id)).toEqual(["t7"]);
      expect(space.activeTabId).toBe("t7");
    }
  });

  it("bounds a pathological session under the frame budget", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(16_000)}`;
    const spaces: DurableTabSession["spaces"] = {};
    for (let s = 0; s < 40; s += 1) {
      const tabs = Array.from({ length: 200 }, (_, i) => ({
        ...tab(`t${String(i)}`, i, dataUrl),
        spaceId: `s${String(s)}`,
      }));
      spaces[`s${String(s)}`] = {
        tabs,
        activeTabId: tabs[0]?.id ?? null,
        recentTabIds: [],
        splitGroups: [],
      };
    }
    const bounded = boundRestorePoint({ version: TAB_SESSION_VERSION, spaces });

    // Sealed base64 is ~4/3 of the plaintext and still has to fit a frame.
    const bytes = new TextEncoder().encode(JSON.stringify(bounded)).byteLength;
    expect(bytes).toBeLessThanOrEqual(MAX_RESTORE_POINT_BYTES);
    expect((bytes * 4) / 3).toBeLessThan(FRAME_BUDGET_BYTES);
  });
});
