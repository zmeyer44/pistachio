import { describe, expect, it } from "vitest";
import { collapseDestinations, destinationKey } from "../src/lib/destination";

describe("the place an address goes", () => {
  it("is the same for addresses that differ only in how they are written", () => {
    const key = destinationKey("https://github.com/");
    for (const url of ["http://github.com", "https://www.github.com/", "HTTPS://GitHub.com", "github.com", "https://github.com:443/", "https://github.com/#start-of-content"])
      expect(destinationKey(url), url).toBe(key);
  });

  it("ignores how someone arrived, and keeps where they were going", () => {
    expect(destinationKey("https://get.manychat.com/?utm_source=google&utm_medium=search&gclid=abc")).toBe(destinationKey("https://get.manychat.com"));
    expect(destinationKey("https://shop.test/item?id=4&utm_campaign=x")).toBe(destinationKey("https://shop.test/item?id=4"));
    expect(destinationKey("https://www.google.com/search?q=a")).not.toBe(destinationKey("https://www.google.com/search?q=b"));
    expect(destinationKey("https://x.com/brycent/status/1")).not.toBe(destinationKey("https://x.com/brycent/status/2"));
  });

  it("keeps a fragment that is a route, and the app's own pages apart", () => {
    expect(destinationKey("https://mail.test/#/inbox")).not.toBe(destinationKey("https://mail.test/#/sent"));
    expect(destinationKey("pistachio://reminders")).not.toBe(destinationKey("pistachio://bookmarks"));
  });

  it("has nothing to say about a blank tab", () => {
    expect(destinationKey("")).toBeNull();
    expect(destinationKey("about:blank")).toBeNull();
  });
});

describe("one row per place", () => {
  interface Row {
    id: string;
    url: string | null;
    rank: number;
  }
  const row = (id: string, url: string | null, rank = 0): Row => ({ id, url, rank });
  const keyOf = (item: Row) => (item.url === null ? null : destinationKey(item.url));
  const prefer = (item: Row) => item.rank;
  const ids = (rows: readonly Row[]) => rows.map((item) => item.id);

  const tab = row("tab", "https://github.com/", 3);
  const favorite = row("favorite", "https://github.com", 2);
  const recent = row("recent", "http://www.github.com/", 1);
  const other = row("other", "https://linear.app", 1);
  const action = row("action", null);

  it("shows a page once, as the best way to get there, where its best member ranked", () => {
    const { ranked } = collapseDestinations([recent, other, favorite, tab, action], [tab, favorite, recent, other, action], keyOf, prefer);
    expect(ids(ranked)).toEqual(["tab", "other", "action"]);
  });

  it("prefers a member that matched over a better one that did not", () => {
    // They typed the favorite's nickname; the tab's title never matched.
    const { ranked, kept } = collapseDestinations([favorite, recent], [tab, favorite, recent], keyOf, prefer);
    expect(ids(ranked)).toEqual(["favorite"]);
    expect(kept(favorite)).toBe(true);
    expect(kept(tab)).toBe(false);
  });

  it("keeps one representative of a place nothing matched, and every row that is not a place", () => {
    const { ranked, kept } = collapseDestinations([action], [tab, favorite, recent, action], keyOf, prefer);
    expect(ids(ranked)).toEqual(["action"]);
    expect([tab, favorite, recent, action].filter(kept).map((item) => item.id)).toEqual(["tab", "action"]);
  });

  it("never merges blank tabs, and breaks ties by order", () => {
    const blankA = row("blank-a", "about:blank");
    const blankB = row("blank-b", "about:blank");
    const twin = row("twin", "https://github.com", 3);
    const { ranked } = collapseDestinations([blankA, blankB, tab, twin], [blankA, blankB, tab, twin], (item) => (item.url === null ? null : destinationKey(item.url)), prefer);
    expect(ids(ranked)).toEqual(["blank-a", "blank-b", "tab"]);
  });
});
