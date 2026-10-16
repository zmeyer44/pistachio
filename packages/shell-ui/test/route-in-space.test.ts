/**
 * Where a result of the address modal or the home page's search that names a page goes
 * (components/address-palette.tsx `routeInSpace`): to the page's own tab only when it is in the space in use — Home's
 * tabs are one space — and else to its address, as the address typed would go. Neither ever takes the person to
 * another space (2026-10-15: "Hackernews" typed on a new space's home page chose Home's open Hacker News tab, and the
 * desk passed to Home; the person's rule, "never be sent to a different space", holds for ⌘L too).
 */

import { describe, expect, it } from "vitest";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import { routeInSpace, tabsInSpace, wayThere, type Entry, type PageRouteSnapshot } from "../src/components/address-palette";
import { collapseDestinations, destinationKey } from "../src/lib/destination";

const group = (id: string, tabIds: string[], fields: Partial<TabGroupInfo> = {}): TabGroupInfo => ({
  id,
  title: id.toUpperCase(),
  color: "blue",
  tabIds,
  origin: "manual",
  open: false,
  createdAt: 1,
  ...fields,
});

const HN = "https://news.ycombinator.com/";

/**
 * Home: `hn` (loose, at Hacker News), `home-a` (loose, a home page), the favorite `fav`'s page alone (`fav-page`).
 * A new space "fresh" holding a home page (`home-b`) and `docs`; a space "trip" holding `maps`; a pin `pin`'s page
 * linked into "fresh" (`pinned-here`); a pin `far`'s page linked into "trip" (`pinned-there`).
 */
function snapshotWith(currentGroupId: string | null | undefined): PageRouteSnapshot {
  return {
    tabs: [
      { id: "hn", anchorId: null },
      { id: "home-a", anchorId: null },
      { id: "fav-page", anchorId: "fav" },
      { id: "home-b", anchorId: null },
      { id: "docs", anchorId: null },
      { id: "pinned-here", anchorId: null, linkedAnchorId: "pin" },
      { id: "maps", anchorId: null },
      { id: "pinned-there", anchorId: null, linkedAnchorId: "far" },
    ],
    tabGroups: [group("fresh", ["home-b", "docs", "pinned-here"]), group("trip", ["maps", "pinned-there"])],
    looseGroups: [group("loose-hn", ["hn"], { loose: true, origin: "auto" }), group("loose-home", ["home-a"], { loose: true, origin: "auto" })],
    anchorGroups: [group("fav-group", ["fav-page"], { anchorId: "fav" })],
    splitGroups: [],
    ...(currentGroupId === undefined ? {} : { currentGroupId }),
  };
}

const tabRow = (tabId: string, url = HN) => ({ kind: "tab" as const, tabId, url });
const shelfRow = (anchorId: string, url = "https://example.com/kept") => ({ kind: "shelf" as const, anchorId, url });

describe("a result that names an open tab", () => {
  it("on a new space's home page, Home's tab is not gone to: the page's own tab goes to its address", () => {
    expect(routeInSpace(tabRow("hn"), "home-b", snapshotWith("fresh"))).toEqual({ go: "address", url: HN });
  });

  it("over any page of a space (⌘L on a page), Home's tab is not gone to either", () => {
    expect(routeInSpace(tabRow("hn"), "docs", snapshotWith("fresh"))).toEqual({ go: "address", url: HN });
  });

  it("another space's tab is not gone to", () => {
    expect(routeInSpace(tabRow("maps", "https://maps.example/"), "home-b", snapshotWith("fresh"))).toEqual({ go: "address", url: "https://maps.example/" });
  });

  it("a tab of the same space is switched to, as before", () => {
    expect(routeInSpace(tabRow("docs"), "home-b", snapshotWith("fresh"))).toEqual({ go: "tab", tabId: "docs" });
  });

  it("in Home, another Home tab is switched to — a loose tab or a page alone: Home's tabs are one space, a browser's", () => {
    expect(routeInSpace(tabRow("hn"), "home-a", snapshotWith("loose-home"))).toEqual({ go: "tab", tabId: "hn" });
    expect(routeInSpace(tabRow("fav-page"), "home-a", snapshotWith("loose-home"))).toEqual({ go: "tab", tabId: "fav-page" });
  });

  it("from Home, a space's tab is not gone to", () => {
    expect(routeInSpace(tabRow("docs", "https://docs.example/"), "home-a", snapshotWith("loose-home"))).toEqual({ go: "address", url: "https://docs.example/" });
  });

  it("another Profile's tab (not among this Profile's tabs) is still gone to: choosing it changes Profile, as before", () => {
    expect(routeInSpace(tabRow("elsewhere"), "home-a", snapshotWith("loose-home"))).toEqual({ go: "tab", tabId: "elsewhere" });
    expect(routeInSpace(tabRow("elsewhere"), "home-b", snapshotWith("fresh"))).toEqual({ go: "tab", tabId: "elsewhere" });
  });

  it("with no tab to compare (a window with none), the space in front is the one compared", () => {
    expect(routeInSpace(tabRow("hn"), null, snapshotWith("fresh"))).toEqual({ go: "address", url: HN });
    expect(routeInSpace(tabRow("docs"), null, snapshotWith("fresh"))).toEqual({ go: "tab", tabId: "docs" });
  });

  it("where the host has no spaces (no current space: the web), any tab is gone to, as before", () => {
    expect(routeInSpace(tabRow("hn"), "home-b", snapshotWith(undefined))).toEqual({ go: "tab", tabId: "hn" });
  });
});

describe("a result that names a kept page", () => {
  it("in Home, it is the entry's to open (main opens it in Home)", () => {
    expect(routeInSpace(shelfRow("fav"), "home-a", snapshotWith("loose-home"))).toEqual({ go: "entry", anchorId: "fav" });
    expect(routeInSpace(shelfRow("far"), "home-a", snapshotWith("loose-home"))).toEqual({ go: "entry", anchorId: "far" });
  });

  it("in a space, its page there is gone to", () => {
    expect(routeInSpace(shelfRow("pin"), "home-b", snapshotWith("fresh"))).toEqual({ go: "tab", tabId: "pinned-here" });
  });

  it("in a space, an entry open in Home, in another space or closed opens at its address here", () => {
    expect(routeInSpace(shelfRow("fav"), "home-b", snapshotWith("fresh"))).toEqual({ go: "address", url: "https://example.com/kept" });
    expect(routeInSpace(shelfRow("far"), "docs", snapshotWith("fresh"))).toEqual({ go: "address", url: "https://example.com/kept" });
    expect(routeInSpace(shelfRow("closed"), "home-b", snapshotWith("fresh"))).toEqual({ go: "address", url: "https://example.com/kept" });
  });

  it("where the host has no spaces, it is the entry's to open, as before", () => {
    expect(routeInSpace(shelfRow("fav"), "home-b", snapshotWith(undefined))).toEqual({ go: "entry", anchorId: "fav" });
  });
});

describe("one row per page: of the tabs open at it, the one in the space in use", () => {
  it("is the space's tabs as routeInSpace sees spaces: a space's own, Home's all one, none on the web", () => {
    expect(tabsInSpace("home-b", snapshotWith("fresh")).sort()).toEqual(["docs", "home-b", "pinned-here"]);
    expect(tabsInSpace("hn", snapshotWith(null)).sort()).toEqual(["fav-page", "hn", "home-a"]);
    expect(tabsInSpace(null, snapshotWith("trip")).sort()).toEqual(["maps", "pinned-there"]);
    expect(tabsInSpace("home-b", snapshotWith(undefined))).toEqual([]);
  });

  it("a page open here (asleep) and in another space (awake) is this space's row, so ↵ switches to it, nothing loads", () => {
    // (2026-10-15 review: the awake tab in Home won the row, and ↵ loaded the page again here.)
    const open = (tabId: string, lifecycle: BrowserTabInfo["lifecycle"]): Entry =>
      ({ kind: "tab", id: `typed-tab:${tabId}`, url: HN, tabId, title: "Hacker News", note: "", tab: { id: tabId, url: HN, spaceId: "profile", lifecycle } as BrowserTabInfo }) as Entry;
    const awayAwake = open("hn", "live");
    const hereAsleep = { ...open("docs", "suspended"), url: HN };
    const inSpace = new Set(tabsInSpace("home-b", snapshotWith("fresh")));
    const rows = [awayAwake, hereAsleep];
    const kept = collapseDestinations(rows, rows, (entry) => ("url" in entry ? destinationKey(entry.url) : null), (entry) => wayThere(entry, "profile", inSpace)).ranked;
    expect(kept.map((entry) => (entry.kind === "tab" ? entry.tabId : entry.id))).toEqual(["docs"]);
    expect(routeInSpace(tabRow("docs"), "home-b", snapshotWith("fresh"))).toEqual({ go: "tab", tabId: "docs" });
  });
});
