/**
 * An extension that runs by itself, as the shell says it
 * (src/lib/extensions/triggers.ts; docs/primitives.md §3): where the clock
 * has a trigger, and main's journal of what the extension did with nobody
 * there — in the shell's words, from main's record alone — and the notice
 * for a space an extension brought back (src/lib/away-spaces.ts).
 */

import { describe, expect, it } from "vitest";
import type { ExtensionJournalEntry } from "@pistachio/shell-contracts/extensions";
import { closedNoticeText } from "../src/lib/away-actions";
import { awayNoticeText } from "../src/lib/away-spaces";
import { anyTriggers, formatWhen, hasRunsBlock, hasTriggers, journalLine, journalNewestFirst, journalVerbLine, triggerStateLine } from "../src/lib/extensions/triggers";

const ZONE = { timeZone: "America/New_York", locale: "en-US" };
/** New York is five hours behind UTC in November. */
const at = (day: number, hour: number, minute = 0): number => Date.UTC(2026, 10, day, hour + 5, minute);
/** Wednesday 2026-11-18, 10:00 in New York. */
const NOW = at(18, 10);

const entry = (over: Partial<ExtensionJournalEntry> = {}): ExtensionJournalEntry => ({
  id: "j1",
  at: at(15, 23),
  extensionId: "dev.me.game-day",
  trigger: "sunday",
  verb: "sendAway",
  spaceId: "football",
  title: "Football",
  ...over,
});

describe("a time, to come or gone by", () => {
  it("says a time ahead as an away space's row does", () => {
    expect(formatWhen(at(18, 20), NOW, ZONE)).toBe("today 8:00 PM");
    expect(formatWhen(at(19, 8), NOW, ZONE)).toBe("tomorrow 8:00 AM");
    expect(formatWhen(at(22, 8), NOW, ZONE)).toBe("Sun 8:00 AM");
    expect(formatWhen(at(29, 8), NOW, ZONE)).toBe("Nov 29, 8:00 AM");
  });

  it("says a time behind: today, yesterday, the day's name, then the date", () => {
    expect(formatWhen(at(18, 8), NOW, ZONE)).toBe("today 8:00 AM");
    expect(formatWhen(at(17, 23), NOW, ZONE)).toBe("yesterday 11:00 PM");
    expect(formatWhen(at(15, 23), NOW, ZONE)).toBe("Sun 11:00 PM");
    // (Never last week's same day by its name alone.)
    expect(formatWhen(at(11, 21), NOW, ZONE)).toBe("Nov 11, 9:00 PM");
    expect(formatWhen(at(1, 8), NOW, ZONE)).toBe("Nov 1, 8:00 AM");
  });
});

describe("where the clock has a trigger", () => {
  it("says a window that is on, and until when", () => {
    expect(triggerStateLine({ holds: true, next: at(18, 23) }, NOW, ZONE)).toBe("On now · until today 11:00 PM");
    expect(triggerStateLine({ holds: true, next: null }, NOW, ZONE)).toBe("On now");
  });

  it("says when a window that is off is next on, and when an instant next comes", () => {
    expect(triggerStateLine({ holds: false, next: at(22, 8) }, NOW, ZONE)).toBe("Next Sun 8:00 AM");
    expect(triggerStateLine({ next: at(19, 9) }, NOW, ZONE)).toBe("Next tomorrow 9:00 AM");
  });

  it("says nothing of an instant that never comes, or an interval that is not running", () => {
    expect(triggerStateLine({ next: null }, NOW, ZONE)).toBeNull();
  });

  it("says a signal is on or off, with no time: when it changes is not the clock's to say", () => {
    expect(triggerStateLine({ holds: true, next: null }, NOW, ZONE)).toBe("On now");
    expect(triggerStateLine({ holds: false, next: null }, NOW, ZONE)).toBe("Off now");
  });

  it("says a signal main cannot read is not known, and what would let it", () => {
    expect(triggerStateLine({ unknown: true, needs: "Connect Google Calendar in Settings", next: null }, NOW, ZONE)).toBe("Not known · Connect Google Calendar in Settings");
    expect(triggerStateLine({ unknown: true, next: null }, NOW, ZONE)).toBe("Not known");
  });

  it("says an interval's next mark", () => {
    expect(triggerStateLine({ next: NOW + 5 * 60_000 }, NOW, ZONE)).toMatch(/^Next today /);
  });
});

describe("where the clock has an event", () => {
  it("says when its handler last ran, or that it has not yet — never on, off or next", () => {
    expect(triggerStateLine({ next: null, event: true, last: at(18, 9, 14) }, NOW, ZONE)).toBe("Last heard today 9:14 AM");
    expect(triggerStateLine({ next: null, event: true, last: at(17, 16) }, NOW, ZONE)).toBe("Last heard yesterday 4:00 PM");
    expect(triggerStateLine({ next: null, event: true, last: null }, NOW, ZONE)).toBe("Not heard yet");
    expect(triggerStateLine({ next: null, event: true }, NOW, ZONE)).toBe("Not heard yet");
  });
});

describe("a tab an extension opened with nobody there", () => {
  it("is said by its address, as main cut it — or as a tab, when main kept none", () => {
    expect(journalVerbLine(entry({ verb: "openTab", title: "docs.google.com/document/d/1" }))).toBe("Opened docs.google.com/document/d/1");
    expect(journalVerbLine(entry({ verb: "openTab", title: "" }))).toBe("Opened a tab");
    expect(journalLine(entry({ verb: "openTab", title: "espn.com", at: at(18, 9) }), NOW, ZONE)).toBe("Opened espn.com · today 9:00 AM");
  });
});

describe("a space an extension closed", () => {
  it("is said in the journal by its name, and in the notice with its tabs and who closed it", () => {
    expect(journalVerbLine(entry({ verb: "closeSpace", title: "Trip" }))).toBe("Closed “Trip”");
    expect(journalVerbLine(entry({ verb: "closeSpace", title: "" }))).toBe("Closed a space");
    expect(closedNoticeText("Trip", 2, "Idle spaces")).toBe("Closed “Trip” · 2 tabs · Idle spaces");
    expect(closedNoticeText("Trip", 1, "Pistachio")).toBe("Closed “Trip” · 1 tab · Pistachio");
    // (An empty space the person kept things in is filed too: no count to say.)
    expect(closedNoticeText("Notes", 0, "Idle spaces")).toBe("Closed “Notes” · Idle spaces");
  });
});

describe("what an extension did with nobody there", () => {
  it("says the verb and the space in the shell's words", () => {
    expect(journalVerbLine(entry())).toBe("Sent “Football” away");
    expect(journalVerbLine(entry({ verb: "bringBack" }))).toBe("Brought “Football” back");
    expect(journalVerbLine(entry({ title: "  " }))).toBe("Sent a space away");
    // A theme set with nobody there (docs/primitives.md §4): on a space, or — `*` — on every one.
    expect(journalVerbLine(entry({ verb: "setTheme" }))).toBe("Set a backdrop on “Football”");
    expect(journalVerbLine(entry({ verb: "setTheme", spaceId: "*", title: "" }))).toBe("Set a backdrop on every space");
    expect(journalVerbLine(entry({ verb: "setTheme", title: "" }))).toBe("Set a backdrop on a space");
  });

  it("says when", () => {
    expect(journalLine(entry(), NOW, ZONE)).toBe("Sent “Football” away · Sun 11:00 PM");
    expect(journalLine(entry({ verb: "bringBack", at: at(18, 8) }), NOW, ZONE)).toBe("Brought “Football” back · today 8:00 AM");
  });

  it("lists the newest first, whatever order main sent", () => {
    const journal = [entry({ id: "old", at: at(8, 23) }), entry({ id: "new", at: at(15, 23) }), entry({ id: "mid", at: at(15, 8) })];
    expect(journalNewestFirst(journal).map((line) => line.id)).toEqual(["new", "mid", "old"]);
    expect(journalNewestFirst(undefined)).toEqual([]);
  });
});

describe("which extensions run by themselves", () => {
  it("is the ones that declare a trigger", () => {
    const runs = { triggers: [{ id: "sunday", text: "Sundays 8:00 AM–11:00 PM", holds: false, next: null }] };
    expect(hasTriggers(runs)).toBe(true);
    expect(hasTriggers({})).toBe(false);
    expect(hasTriggers({ triggers: [] })).toBe(false);
    expect(anyTriggers([{}, runs])).toBe(true);
    expect(anyTriggers([{}, { triggers: [] }])).toBe(false);
    // What it did stays on the page after an update took its triggers out: the journal is the way back (Undo), and
    // is listed for as long as it has lines — with no Pause to offer, there being nothing left to pause.
    const did = { triggers: [], journal: [{ id: "j1", at: 1, extensionId: "dev.me.x", trigger: "sunday", verb: "sendAway" as const, spaceId: "football", title: "Football" }] };
    expect(hasTriggers(did)).toBe(false);
    expect(hasRunsBlock(did)).toBe(true);
    expect(hasRunsBlock(runs)).toBe(true);
    expect(hasRunsBlock({})).toBe(false);
    expect(hasRunsBlock({ triggers: [], journal: [] })).toBe(false);
  });
});

describe("the notice for a space an extension brought back", () => {
  const space = { title: "Football", by: { kind: "extension" as const, extensionId: "dev.me.game-day", name: "Game day" } };

  it("names the extension, as the notice of one sent names its sender", () => {
    expect(awayNoticeText("returned", space, NOW, { ...ZONE, broughtBy: "Game day" })).toBe("“Football” is back · Game day");
  });

  it("says only that it is back when the clock brought it", () => {
    expect(awayNoticeText("returned", space, NOW, ZONE)).toBe("“Football” is back");
    expect(awayNoticeText("returned", space, NOW, { ...ZONE, broughtBy: " " })).toBe("“Football” is back");
  });
});
