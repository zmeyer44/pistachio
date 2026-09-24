/**
 * The sealed browser-session record (docs/web-browser-design.md §9), read
 * back.
 *
 * The record is the only thing a session survives on: it is what a worker
 * rebuilds forty tabs from, and it is a last-writer-wins register, so a
 * reader that quietly turns something it did not understand into an empty or
 * pruned session is a reader that DELETES tabs on every device the moment its
 * host publishes again. Each test below names the loss it prevents.
 */

import { describe, expect, it } from "vitest";
import {
  BROWSER_SESSION_VERSION,
  MAX_RESTORED_TABS_PER_SPACE,
  readBrowserSessionState,
  sanitizeBrowserSessionState,
  type BrowserSessionState,
} from "../src/tab-session.js";
import { DEFAULT_SIDEBAR_STATE } from "../src/sidebar.js";

const SPACE = "work";

function record(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    version: BROWSER_SESSION_VERSION,
    spaceId: SPACE,
    tabs: [{ id: "web:1", url: "https://example.com/", title: "Example", favicon: null, kind: "human" }],
    activeTabId: "web:1",
    splitGroups: [],
    shelf: DEFAULT_SIDEBAR_STATE,
    zoom: {},
    permissions: {},
    updatedAt: 5,
    ...overrides,
  };
}

describe("the sealed browser-session record", () => {
  it("an unrestorable address is refused rather than turned into a search", () => {
    // `normalizeNavigation` never fails: anything unparseable becomes a
    // search for it. So the check has to run on the RAW value, or a tab
    // recorded as `about:blank` comes back as a Google search for
    // "about:blank" and a `javascript:` URL comes back as a page.
    const read = readBrowserSessionState(
      record({
        tabs: [
          { id: "web:blank", url: "about:blank", title: "", favicon: null, kind: "human" },
          { id: "web:js", url: "javascript:alert(1)", title: "", favicon: null, kind: "human" },
          { id: "web:ok", url: "https://example.com/", title: "Example", favicon: null, kind: "human" },
        ],
      }),
      SPACE,
    );
    expect(read.kind).toBe("state");
    if (read.kind !== "state") return;
    expect(read.state.tabs.map((tab) => tab.id)).toEqual(["web:ok"]);
    expect(read.state.tabs.every((tab) => !tab.url.includes("about%3Ablank"))).toBe(true);
    expect(read.pruned).toBe(true);
  });

  it("a corrupted address longer than the cap never survives to grow again", () => {
    const long = `https://example.com/${"a".repeat(4_000)}`;
    const read = readBrowserSessionState(
      record({ tabs: [{ id: "web:1", url: long, title: "", favicon: null, kind: "human" }] }),
      SPACE,
    );
    expect(read.kind).toBe("state");
    if (read.kind !== "state") return;
    expect(read.state.tabs).toEqual([]);
    expect(read.pruned).toBe(true);
  });

  it("a tab's last-active time survives the record, so a rebuilt switcher is still most-recent-first", () => {
    const read = readBrowserSessionState(
      record({
        tabs: [
          { id: "web:1", url: "https://example.com/", title: "", favicon: null, kind: "human", lastActiveAt: 10 },
          { id: "web:2", url: "https://example.org/", title: "", favicon: null, kind: "human", lastActiveAt: 99 },
        ],
      }),
      SPACE,
    );
    expect(read.kind).toBe("state");
    if (read.kind !== "state") return;
    expect(read.state.tabs.map((tab) => tab.lastActiveAt)).toEqual([10, 99]);
  });

  it("a record from a newer build reads as unreadable, never as an empty session", () => {
    // The difference is the whole point: an empty session may be published
    // over, a record this build could not read may not.
    const newer = readBrowserSessionState(record({ version: BROWSER_SESSION_VERSION + 1 }), SPACE);
    expect(newer).toEqual({ kind: "unreadable", reason: "version" });
    const older = readBrowserSessionState(record({ version: 1 }), SPACE);
    expect(older).toEqual({ kind: "unreadable", reason: "version" });
    expect(readBrowserSessionState(null, SPACE)).toEqual({ kind: "none" });
    expect(readBrowserSessionState(record({ spaceId: "other" }), SPACE)).toEqual({
      kind: "unreadable",
      reason: "shape",
    });
  });

  it("a permission name this build does not know marks the read as pruned", () => {
    const read = readBrowserSessionState(
      record({ permissions: { "example.com": { geolocation: "allow", telepathy: "allow" } } }),
      SPACE,
    );
    expect(read.kind).toBe("state");
    if (read.kind !== "state") return;
    expect(read.state.permissions).toEqual({ "example.com": { geolocation: "allow" } });
    expect(read.pruned).toBe(true);
  });

  it("a session over the tab cap is pruned, and says so", () => {
    const tabs = Array.from({ length: MAX_RESTORED_TABS_PER_SPACE + 5 }, (_, index) => ({
      id: `web:${String(index)}`,
      url: `https://example.com/${String(index)}`,
      title: "",
      favicon: null,
      kind: "human",
    }));
    const read = readBrowserSessionState(record({ tabs }), SPACE);
    expect(read.kind).toBe("state");
    if (read.kind !== "state") return;
    expect(read.state.tabs).toHaveLength(MAX_RESTORED_TABS_PER_SPACE);
    expect(read.pruned).toBe(true);
  });

  it("a clean record reads clean", () => {
    const read = readBrowserSessionState(record(), SPACE);
    expect(read.kind).toBe("state");
    if (read.kind !== "state") return;
    expect(read.pruned).toBe(false);
    const state: BrowserSessionState = read.state;
    expect(state.version).toBe(BROWSER_SESSION_VERSION);
    expect(sanitizeBrowserSessionState(record(), SPACE)).toEqual(state);
  });
});
