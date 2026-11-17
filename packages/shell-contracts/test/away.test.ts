/**
 * Away spaces as the file and the snapshot hold them (../src/away.ts;
 * docs/primitives.md §2): what is read back is exactly one drawn space with
 * its own tabs, and what a row says of it is the shell's words.
 */

import { describe, expect, it } from "vitest";
import {
  AWAY_FILE_VERSION,
  AWAY_REFUSALS,
  MAX_AWAY_SPACES_PER_PROFILE,
  awayLine,
  awayRefused,
  awaySpaceInfo,
  formatReturn,
  heldSpace,
  sanitizeAwayFile,
  type AwaySpace,
} from "../src/away.js";
import { isShellCommand } from "../src/chrome.js";
import { isTabGroupCommand, type TabGroupInfo } from "../src/tab-groups.js";
import type { DurableSpaceSession, DurableTab } from "../src/tab-session.js";

const tab = (id: string, extra: Partial<DurableTab> = {}): DurableTab => ({
  id,
  spaceId: "work",
  title: id,
  url: `https://example.com/${id}`,
  faviconUrl: `https://example.com/${id}.png`,
  anchorId: null,
  lastActiveAt: 5,
  ...extra,
});

const group = (id: string, tabIds: string[], extra: Partial<TabGroupInfo> = {}): TabGroupInfo => ({ id, title: "Football", color: "green", tabIds, origin: "manual", open: false, createdAt: 1, ...extra });

const held = (id: string, tabs: DurableTab[], extra: Partial<TabGroupInfo> = {}): DurableSpaceSession => ({
  tabs,
  activeTabId: tabs[0]?.id ?? null,
  recentTabIds: tabs.map((entry) => entry.id),
  splitGroups: [],
  tabGroups: [group(id, tabs.map((entry) => entry.id), extra)],
});

const away = (id: string, extra: Partial<AwaySpace> = {}): AwaySpace => ({ id, spaceId: "work", by: { kind: "person" }, since: 100, held: held(id, [tab(`${id}-a`), tab(`${id}-b`)]), ...extra });

const file = (spaces: unknown[]): unknown => ({ version: AWAY_FILE_VERSION, spaces });

describe("the away file read back", () => {
  it("keeps a space as it was sent: its id, its tabs under their ids, who sent it and when it is due", () => {
    const sent = away("football", { by: { kind: "extension", extensionId: "dev.me.game-day", name: "Game day" }, until: 9_000 });
    const [read] = sanitizeAwayFile(file([sent])).spaces;
    expect(read).toEqual(sent);
  });

  it("keeps what the session keeps of a tab: its stack, its link to a favorite, a local file", () => {
    const history = { entries: [{ url: "https://example.com/one", title: "One" }, { url: "https://example.com/two", title: "Two" }], index: 1 };
    const sent = away("research", {
      held: held("research", [tab("paper", { url: "https://example.com/two", history, linkedAnchorId: "fav-1" }), tab("notes", { url: "file:///Users/me/notes.txt" })]),
    });
    const [read] = sanitizeAwayFile(file([sent])).spaces;
    expect(read?.held.tabs.map((entry) => entry.url)).toEqual(["https://example.com/two", "file:///Users/me/notes.txt"]);
    expect(read?.held.tabs[0]?.history).toEqual(history);
    expect(read?.held.tabs[0]?.linkedAnchorId).toBe("fav-1");
  });

  it("keeps an empty space: it may hold a Stack and a conversation under its id", () => {
    const [read] = sanitizeAwayFile(file([away("lisbon", { held: held("lisbon", []) })])).spaces;
    expect(read?.held.tabGroups?.[0]?.tabIds).toEqual([]);
  });

  it("drops what is not one drawn space under the entry's id", () => {
    const loose = away("home-tab", { held: held("home-tab", [tab("one")], { loose: true }) });
    const other = away("football", { held: held("someone-else", [tab("x")]) });
    const none = { ...away("nothing"), held: { tabs: [], activeTabId: null, recentTabIds: [], splitGroups: [] } };
    const nobody = { ...away("unsigned"), by: { kind: "extension" } };
    expect(sanitizeAwayFile(file([loose, other, none, nobody, "junk", null])).spaces).toEqual([]);
    expect(sanitizeAwayFile({ version: 2, spaces: [away("football")] }).spaces).toEqual([]);
    expect(sanitizeAwayFile(null).spaces).toEqual([]);
  });

  it("keeps a space's own tabs alone, and one entry per space", () => {
    const stray = { ...away("football"), held: { ...held("football", [tab("football-a")]), tabs: [tab("football-a"), tab("stray")] } };
    const again = away("football", { since: 50 });
    const read = sanitizeAwayFile(file([again, stray])).spaces;
    expect(read).toHaveLength(1);
    // (The newer of two under one id.)
    expect(read[0]?.since).toBe(100);
    expect(read[0]?.held.tabs.map((entry) => entry.id)).toEqual(["football-a"]);
  });

  it("drops a time that is no instant, and keeps the space", () => {
    const [read] = sanitizeAwayFile(file([{ ...away("football"), until: "sunday" }])).spaces;
    expect(read?.id).toBe("football");
    expect(read?.until).toBeUndefined();
  });

  it("lists oldest first, and bounds a Profile's, the newest kept", () => {
    const many = Array.from({ length: MAX_AWAY_SPACES_PER_PROFILE + 3 }, (_, index) => away(`space-${String(index)}`, { since: 1_000 + index }));
    const read = sanitizeAwayFile(file(many)).spaces;
    expect(read).toHaveLength(MAX_AWAY_SPACES_PER_PROFILE);
    expect(read[0]?.id).toBe("space-3");
    expect(read.at(-1)?.id).toBe(`space-${String(MAX_AWAY_SPACES_PER_PROFILE + 2)}`);
    // Two sent in the same millisecond stay in the order they were filed in.
    expect(sanitizeAwayFile(file([away("first", { since: 7 }), away("second", { since: 7 }), away("third", { since: 7 })])).spaces.map((space) => space.id)).toEqual(["first", "second", "third"]);
    // Another Profile's are counted apart.
    expect(sanitizeAwayFile(file([...many, away("theirs", { spaceId: "home", held: held("theirs", [tab("t", { spaceId: "home" })]) })])).spaces.some((space) => space.id === "theirs")).toBe(true);
  });

  it("reads a Profile's alone when told which Profiles exist", () => {
    expect(sanitizeAwayFile(file([away("football")]), new Set(["home"])).spaces).toEqual([]);
  });

  it("holds a space only as itself", () => {
    expect(heldSpace(held("football", [tab("a")]), "work", "football")?.tabGroups?.[0]?.id).toBe("football");
    expect(heldSpace(held("football", [tab("a")]), "work", "other")).toBeNull();
    expect(heldSpace(held("page", [tab("a", { anchorId: "fav" })], { anchorId: "fav" }), "work", "page")).toBeNull();
  });
});

describe("what a row says of an away space", () => {
  const zone = { timeZone: "America/New_York", locale: "en-US" };
  // Sunday 15 November 2026, 10:00 in New York.
  const now = Date.UTC(2026, 10, 15, 15, 0);
  const at = (day: number, hour: number): number => Date.UTC(2026, 10, day, hour + 5, 0);

  it("lists its name, colour, tab count and first favicons — nothing of its pages", () => {
    const info = awaySpaceInfo(away("football", { until: at(22, 8) }));
    expect(info).toEqual({
      id: "football",
      spaceId: "work",
      title: "Football",
      color: "green",
      tabCount: 2,
      favicons: ["https://example.com/football-a.png", "https://example.com/football-b.png"],
      by: { kind: "person" },
      since: 100,
      until: at(22, 8),
    });
    expect(awaySpaceInfo(away("football"), "room").waiting).toBe("room");
  });

  it("says when it is back the way a person would", () => {
    expect(formatReturn(at(15, 20), now, zone)).toBe("today 8:00 PM");
    expect(formatReturn(at(16, 8), now, zone)).toBe("tomorrow 8:00 AM");
    expect(formatReturn(at(21, 8), now, zone)).toBe("Sat 8:00 AM");
    expect(formatReturn(at(29, 8), now, zone)).toBe("Nov 29, 8:00 AM");
  });

  it("names who sent it in the shell's words, never the sender's", () => {
    expect(awayLine({ by: { kind: "person" } }, now, zone)).toBe("Away");
    expect(awayLine({ by: { kind: "agent" }, until: at(16, 8) }, now, zone)).toBe("Back tomorrow 8:00 AM · Pistachio");
    expect(awayLine({ by: { kind: "extension", extensionId: "dev.me.game-day", name: "Game day" }, until: at(21, 8) }, now, zone)).toBe("Back Sat 8:00 AM · Game day");
    expect(awayLine({ by: { kind: "person" }, until: at(15, 9), waiting: "room" }, now, zone)).toBe("Due back · no room for it");
  });

  it("refuses in a sentence", () => {
    expect(awayRefused("live")).toEqual({ ok: false, refusal: "live", reason: AWAY_REFUSALS.live });
  });
});

describe("the two commands at the IPC boundary", () => {
  it("takes a space to send away, with or without a time, and one to bring back", () => {
    expect(isTabGroupCommand({ type: "sendAway", groupId: "football" })).toBe(true);
    expect(isTabGroupCommand({ type: "sendAway", groupId: "football", until: 1_800_000_000_000 })).toBe(true);
    expect(isTabGroupCommand({ type: "bringBack", groupId: "football" })).toBe(true);
    expect(isTabGroupCommand({ type: "sendAway", groupId: "football", until: "sunday" })).toBe(false);
    expect(isTabGroupCommand({ type: "sendAway", groupId: "football", until: Number.NaN })).toBe(false);
    expect(isTabGroupCommand({ type: "sendAway" })).toBe(false);
    expect(isTabGroupCommand({ type: "bringBack", groupId: "" })).toBe(false);
  });

  it("lets main tell the shell a space went or came back", () => {
    const space = awaySpaceInfo(away("football"));
    expect(isShellCommand({ type: "spaceAway", event: "sent", space })).toBe(true);
    expect(isShellCommand({ type: "spaceAway", event: "returned", space })).toBe(true);
    // Brought back by an extension: its name on the sheet, for the notice.
    expect(isShellCommand({ type: "spaceAway", event: "returned", space, broughtBy: "Game day" })).toBe(true);
    expect(isShellCommand({ type: "spaceAway", event: "returned", space, broughtBy: "" })).toBe(false);
    expect(isShellCommand({ type: "spaceAway", event: "returned", space, broughtBy: 7 })).toBe(false);
    expect(isShellCommand({ type: "spaceAway", event: "gone", space })).toBe(false);
    expect(isShellCommand({ type: "spaceAway", event: "sent", space: { id: "football" } })).toBe(false);
  });
});
