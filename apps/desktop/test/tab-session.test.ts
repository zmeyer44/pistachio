import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TabSessionStore } from "../src/main/tab-session-store";
import {
  MAX_RESTORED_HISTORY_ENTRIES,
  normalizeRestorableTabUrl,
  sanitizeTabHistory,
  sanitizeTabSession,
  TAB_SESSION_VERSION,
  trimTabHistory,
  type DurableTabSession,
} from "@pistachio/shell-contracts/tab-session";

const SESSION: DurableTabSession = {
  version: TAB_SESSION_VERSION,
  spaces: {
    work: {
      tabs: [
        {
          id: "tab-a",
          spaceId: "work",
          title: "Invoices",
          url: "pistachio://demo/invoices",
          faviconUrl: null,
          anchorId: "pin-a",
          lastActiveAt: 20,
        },
        {
          id: "tab-b",
          spaceId: "work",
          title: "Vendor",
          url: "https://vendor.example/",
          faviconUrl: "https://vendor.example/icon.png",
          anchorId: null,
          lastActiveAt: 10,
        },
      ],
      activeTabId: "tab-a",
      recentTabIds: ["tab-a", "tab-b"],
      splitGroups: [
        {
          id: "split-a",
          tabIds: ["tab-a", "tab-b"],
          primaryTabId: "tab-a",
          secondaryTabId: "tab-b",
          mode: "vertical",
          gridLayout: "span-bottom",
        },
      ],
    },
  },
};

describe("durable tab sessions", () => {
  it("does not refresh checkpoint time when an unchanged session is republished", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-checkpoint-"));
    const store = new TabSessionStore(directory, () => new Set(["work"]));
    store.save(SESSION);
    const first = store.get().spaces.work!.updatedAt;
    store.save(SESSION);
    expect(store.get().spaces.work!.updatedAt).toBe(first);
    store.flush();
    const reopened = new TabSessionStore(directory, () => new Set(["work"]));
    reopened.save(SESSION);
    expect(reopened.get().spaces.work!.updatedAt).toBe(first);
    reopened.flush();
  });

  it("keeps a tab of a local file on this device alone: in its own file, never in the restore point other devices see", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-files-"));
    const history = {
      entries: [
        { url: "file:///Users/someone/site/index.html", title: "Index" },
        { url: "file:///Users/someone/site/report.html", title: "Report" },
      ],
      index: 1,
    };
    const fileTab = { id: "tab-f", spaceId: "work", title: "Report", url: "file:///Users/someone/site/report.html", faviconUrl: null, anchorId: null, lastActiveAt: 30, history };
    const work = SESSION.spaces.work!;
    const session: DurableTabSession = { ...SESSION, spaces: { work: { ...work, tabs: [...work.tabs, fileTab] } } };
    const store = new TabSessionStore(directory, () => new Set(["work"]));
    store.save(session);
    expect(store.get().spaces.work!.tabs.find((tab) => tab.id === "tab-f")).toMatchObject({ url: fileTab.url, history });
    expect(store.restorePoint().spaces.work!.tabs.map((tab) => tab.id)).toEqual(["tab-a", "tab-b"]);
    store.flush();
    const reopened = new TabSessionStore(directory, () => new Set(["work"]));
    expect(reopened.get().spaces.work!.tabs.find((tab) => tab.id === "tab-f")).toMatchObject({ url: fileTab.url, history });
    // Another device's session — read as sanitizeTabSession reads by default — never opens a file here.
    expect(sanitizeTabSession(session, new Set(["work"])).spaces.work!.tabs.map((tab) => tab.id)).toEqual(["tab-a", "tab-b"]);
    expect(sanitizeTabHistory(history)).toBeNull();
    expect(sanitizeTabHistory(history, { files: true })).toEqual(history);
  });

  it("keeps recoverable tab order, anchors, MRU state, and valid split groups", () => {
    expect(sanitizeTabSession(SESSION, new Set(["work"]))).toEqual(SESSION);
  });

  it("keeps an entry's page linked in a space (2026-10-14): one tab per entry, never beside an anchor; a file without links reads as before", () => {
    const tab = (id: string, anchorId: string | null, linkedAnchorId?: unknown) => ({
      id,
      spaceId: "work",
      title: id,
      url: `https://${id}.example/`,
      faviconUrl: null,
      anchorId,
      lastActiveAt: 1,
      ...(linkedAnchorId === undefined ? {} : { linkedAnchorId }),
    });
    const read = sanitizeTabSession(
      {
        version: TAB_SESSION_VERSION,
        spaces: {
          work: {
            tabs: [
              tab("a", null, "fav-1"),
              // A second page of one entry: the first holds it.
              tab("b", null, "fav-1"),
              // An anchored tab is its entry's own page, and is linked to none.
              tab("c", "pin-1", "fav-2"),
              // An entry with a page of its own anchored, later in the file too: the link to it goes.
              tab("d", null, "fav-3"),
              tab("e", "fav-3"),
              tab("f", null, ""),
              tab("g", null, 42),
            ],
            activeTabId: "a",
            recentTabIds: [],
            splitGroups: [],
          },
        },
      },
      new Set(["work"]),
    );
    const tabs = read.spaces.work!.tabs;
    expect(tabs.map((kept) => [kept.id, kept.anchorId, kept.linkedAnchorId ?? null])).toEqual([
      ["a", null, "fav-1"],
      ["b", null, null],
      ["c", "pin-1", null],
      ["d", null, null],
      ["e", "fav-3", null],
      ["f", null, null],
      ["g", null, null],
    ]);
    // Absent, not undefined: the file a save writes back has no key for it.
    expect(Object.keys(tabs[1]!)).not.toContain("linkedAnchorId");
    expect(sanitizeTabSession(SESSION, new Set(["work"])).spaces.work!.tabs.every((kept) => !("linkedAnchorId" in kept))).toBe(true);
  });

  it("restores four-pane grids and migrates legacy two-pane groups", () => {
    const extraTabs = ["tab-c", "tab-d"].map((id, index) => ({
      ...SESSION.spaces.work!.tabs[0]!,
      id,
      title: id,
      lastActiveAt: 5 - index,
    }));
    const fourPane = sanitizeTabSession({
      version: TAB_SESSION_VERSION,
      spaces: {
        work: {
          ...SESSION.spaces.work,
          tabs: [...SESSION.spaces.work!.tabs, ...extraTabs],
          splitGroups: [{
            id: "split-grid",
            tabIds: ["tab-a", "tab-b", "tab-c", "tab-d"],
            mode: "grid",
            gridLayout: "span-bottom",
          }],
        },
      },
    });
    expect(fourPane.spaces.work?.splitGroups[0]).toMatchObject({
      tabIds: ["tab-a", "tab-b", "tab-c", "tab-d"],
      primaryTabId: "tab-a",
      secondaryTabId: "tab-b",
      mode: "grid",
    });

    const legacy = structuredClone(SESSION) as unknown as { spaces: { work: { splitGroups: Array<Record<string, unknown>> } } };
    delete legacy.spaces.work.splitGroups[0]?.["tabIds"];
    delete legacy.spaces.work.splitGroups[0]?.["gridLayout"];
    expect(sanitizeTabSession(legacy).spaces.work?.splitGroups[0]).toMatchObject({
      tabIds: ["tab-a", "tab-b"],
      gridLayout: "span-bottom",
    });
  });

  it("drops unknown Spaces, unsafe URLs, duplicate ids, and broken split membership", () => {
    const result = sanitizeTabSession(
      {
        version: TAB_SESSION_VERSION,
        spaces: {
          work: {
            tabs: [...SESSION.spaces.work!.tabs, { ...SESSION.spaces.work!.tabs[0], url: "file:///etc/passwd" }],
            activeTabId: "missing",
            recentTabIds: ["missing", "tab-b", "tab-b"],
            splitGroups: [
              {
                id: "broken",
                primaryTabId: "tab-a",
                secondaryTabId: "missing",
                mode: "vertical",
              },
            ],
          },
          removed: SESSION.spaces.work,
        },
      },
      new Set(["work"]),
    );
    expect(Object.keys(result.spaces)).toEqual(["work"]);
    expect(result.spaces.work?.tabs.map((tab) => tab.id)).toEqual(["tab-a", "tab-b"]);
    expect(result.spaces.work?.activeTabId).toBe("tab-a");
    expect(result.spaces.work?.recentTabIds).toEqual(["tab-b"]);
    expect(result.spaces.work?.splitGroups).toEqual([]);
  });

  it("rejects unknown schema versions instead of guessing how to restore them", () => {
    expect(sanitizeTabSession({ ...SESSION, version: 2 }, new Set(["work"])).spaces).toEqual({});
  });

  it("does not durably restore one-shot sign-out routes or query markers", () => {
    expect(
      normalizeRestorableTabUrl("https://x.com/?logout=1787769267708"),
    ).toBe("https://x.com/");
    expect(
      normalizeRestorableTabUrl(
        "https://example.com/i/flow/sign_out?redirect=%2Fhome",
      ),
    ).toBe("https://example.com/");
    expect(
      normalizeRestorableTabUrl(
        "https://example.com/home?topic=logout&logged-out=true",
      ),
    ).toBe("https://example.com/home?topic=logout");
  });

  it("keeps a tab's back/forward stack, addresses and titles only, and reads files written without one", () => {
    const history = {
      entries: [
        { url: "https://travel.example/", title: "Travel planning" },
        { url: "https://travel.example/museums", title: "Museums" },
        { url: "https://travel.example/hotels", title: "Hotels" },
      ],
      index: 2,
    };
    const withHistory: DurableTabSession = {
      ...SESSION,
      spaces: {
        work: {
          ...SESSION.spaces.work!,
          tabs: [SESSION.spaces.work!.tabs[0]!, { ...SESSION.spaces.work!.tabs[1]!, history }],
        },
      },
    };
    expect(sanitizeTabSession(withHistory, new Set(["work"]))).toEqual(withHistory);
    // Page state (scroll, form values) is never part of the durable record.
    const leaked = {
      ...history,
      entries: history.entries.map((entry) => ({ ...entry, pageState: "base64…" })),
    };
    expect(sanitizeTabHistory(leaked)).toEqual(history);
    // A file from before stacks were recorded restores as it always did.
    const tab = sanitizeTabSession(SESSION, new Set(["work"])).spaces.work!.tabs[1]!;
    expect(tab).not.toHaveProperty("history");
  });

  it("drops stack entries a page cannot be given again and abandons a stack whose shown entry is one", () => {
    const entries = [
      { url: "about:blank", title: "" },
      { url: "https://travel.example/", title: "Travel planning" },
      { url: "blob:https://travel.example/3f2b", title: "Attachment" },
      { url: "https://travel.example/hotels?logout=1", title: "Hotels" },
    ];
    expect(sanitizeTabHistory({ entries, index: 3 })).toEqual({
      entries: [
        { url: "https://travel.example/", title: "Travel planning" },
        { url: "https://travel.example/hotels", title: "Hotels" },
      ],
      index: 1,
    });
    expect(sanitizeTabHistory({ entries, index: 2 })).toBeNull();
    // One entry is what a plain load of the tab's address gives anyway.
    expect(sanitizeTabHistory({ entries: [entries[1]], index: 0 })).toBeNull();
    expect(sanitizeTabHistory({ entries, index: 9 })).toBeNull();
    expect(sanitizeTabHistory({ entries: "nope", index: 0 })).toBeNull();
    expect(sanitizeTabHistory(undefined)).toBeNull();
  });

  it("trims a long stack to its newest entries without dropping the one being shown", () => {
    const entries = Array.from({ length: MAX_RESTORED_HISTORY_ENTRIES + 10 }, (_, i) => ({
      url: `https://travel.example/page/${String(i)}`,
      title: `Page ${String(i)}`,
    }));
    const newest = sanitizeTabHistory({ entries, index: entries.length - 1 });
    expect(newest?.entries).toHaveLength(MAX_RESTORED_HISTORY_ENTRIES);
    expect(newest?.entries[0]?.url).toBe("https://travel.example/page/10");
    expect(newest?.index).toBe(MAX_RESTORED_HISTORY_ENTRIES - 1);
    // Shown near the oldest end: the window slides back to keep it.
    const oldest = sanitizeTabHistory({ entries, index: 3 });
    expect(oldest?.entries).toHaveLength(MAX_RESTORED_HISTORY_ENTRIES);
    expect(oldest?.entries[0]?.url).toBe("https://travel.example/page/3");
    expect(oldest?.index).toBe(0);
  });

  it("trims an in-memory stack the same way, keeping the entries' page state", () => {
    const entries = [
      { url: "about:blank", title: "", pageState: "a" },
      { url: "https://travel.example/", title: "Travel planning", pageState: "b" },
      { url: "https://travel.example/hotels", title: "Hotels", pageState: "c" },
    ];
    expect(trimTabHistory(entries, 2, (entry) => entry.url.startsWith("https:"))).toEqual({
      entries: [entries[1], entries[2]],
      index: 1,
    });
    expect(trimTabHistory(entries, 0, (entry) => entry.url.startsWith("https:"))).toBeNull();
    expect(trimTabHistory(entries, 3, () => true)).toBeNull();
  });

  it("writes atomically and flushes pending state for the next launch", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-tab-session-"));
    const spaces = () => new Set(["work"]);
    const store = new TabSessionStore(directory, spaces);
    store.save(SESSION);
    store.flush();
    expect(new TabSessionStore(directory, spaces).get()).toEqual(store.get());
    expect(store.get().spaces.work?.updatedAt).toBeGreaterThan(0);
  });

  it("recovers from a truncated crash file as an empty session", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-tab-session-crash-"));
    writeFileSync(join(directory, "tab-session.json"), '{"version":1,"spaces":');
    expect(new TabSessionStore(directory, () => new Set(["work"])).get().spaces).toEqual({});
  });
});
