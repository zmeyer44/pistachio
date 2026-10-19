/**
 * Where a live share is offered and what each way in does
 * (docs/live-share.md §1, src/lib/live/entries.ts): a space's menu entries
 * by the share's state, `/share` and `/draw` (found in the Bar's catalog and
 * what they do), a page window's *Guests can use this window*, and what the
 * Live card shows while a start is on its way.
 */

import { describe, expect, it } from "vitest";
import { idleLiveShare, type LiveShareState } from "@pistachio/shell-contracts/live-share";
import { commandCandidates, parseCommand } from "../src/lib/desk/slash-commands";
import {
  drawActionFor,
  elapsedLabel,
  guestsCanBeLetUse,
  notStreamingReason,
  notUsableReason,
  guestUseEntry,
  hostNameFrom,
  linkLabel,
  liveCardStatus,
  shareActionFor,
  spaceLiveEntries,
} from "../src/lib/live/entries";

const live = (patch: Partial<LiveShareState> = {}): LiveShareState => ({
  ...idleLiveShare(),
  status: "live",
  groupId: "space-a",
  shareId: "share-1",
  link: "https://www.pistachio.run/live/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
  startedAt: 1_000,
  ...patch,
});

const PEN = { tool: "pen" as const, color: "#3E63DD" };

describe("a space's menu", () => {
  it("offers to share a space while nothing is shared", () => {
    expect(spaceLiveEntries(idleLiveShare(), "space-a")).toEqual(["share"]);
  });

  it("offers the card and Stop on the space shared, and sharing on any other", () => {
    expect(spaceLiveEntries(live(), "space-a")).toEqual(["card", "stop"]);
    expect(spaceLiveEntries(live(), "space-b")).toEqual(["share"]);
    // Being made counts as shared: its card says so.
    expect(spaceLiveEntries(live({ status: "starting" }), "space-a")).toEqual(["card", "stop"]);
  });

  it("offers sharing again once a share failed or ended", () => {
    expect(spaceLiveEntries({ ...idleLiveShare(), status: "error", groupId: "space-a", error: "no account" }, "space-a")).toEqual(["share"]);
    expect(spaceLiveEntries({ ...idleLiveShare(), ended: "stopped" }, "space-a")).toEqual(["share"]);
  });
});

describe("sharing a space", () => {
  it("starts a share when nothing is shared", () => {
    expect(shareActionFor(idleLiveShare(), "space-a")).toEqual({ kind: "start", replaces: null });
  });

  it("shows the card for the space already shared", () => {
    expect(shareActionFor(live(), "space-a")).toEqual({ kind: "open" });
  });

  it("names the other space's share, which stops first (one per Mac)", () => {
    expect(shareActionFor(live(), "space-b")).toEqual({ kind: "start", replaces: "space-a" });
    // One that is already ending is no one's to agree to.
    expect(shareActionFor(live({ status: "ending" }), "space-b")).toEqual({ kind: "start", replaces: null });
  });
});

describe("the Bar's commands", () => {
  it("finds /share and /draw by name and by the words they go by", () => {
    expect(parseCommand("/share")).toMatchObject({ command: { id: "share" }, args: "" });
    expect(parseCommand("/live")).toMatchObject({ command: { id: "share" } });
    expect(parseCommand("/draw")).toMatchObject({ command: { id: "draw" } });
    expect(parseCommand("/pen")).toMatchObject({ command: { id: "draw" } });
    expect(commandCandidates("sh").map((command) => command.id)).toContain("share");
    expect(commandCandidates("invite").map((command) => command.id)).toEqual(["share"]);
    expect(commandCandidates("annotate").map((command) => command.id)).toEqual(["draw"]);
  });

  it("/draw draws over the shared desk with the pen last used, and again gives the desk back", () => {
    expect(drawActionFor(live(), "space-a", PEN, "Launch")).toEqual({ kind: "draw", drawing: PEN });
    expect(drawActionFor(live({ drawing: PEN }), "space-a", PEN, "Launch")).toEqual({ kind: "draw", drawing: null });
  });

  it("/draw explains itself with nothing shared, or on another space", () => {
    expect(drawActionFor(idleLiveShare(), "space-a", PEN, "this space")).toMatchObject({ kind: "explain" });
    const away = drawActionFor(live(), "space-b", PEN, "Launch");
    expect(away).toMatchObject({ kind: "explain" });
    expect(away.kind === "explain" && away.message).toContain("Launch");
  });
});

describe("a page window's Guests can use this window", () => {
  it("is there while its space is shared live, checked while guests may use it", () => {
    expect(guestUseEntry(live({ streamed: ["tab-1"] }), "space-a", "tab-1", true)).toEqual({ checked: false });
    expect(guestUseEntry(live({ streamed: ["tab-1"], controllable: ["tab-1"] }), "space-a", "tab-1", true)).toEqual({ checked: true });
  });

  it("is offered for a window that does not stream only to take back, and the card says why guests cannot use it", () => {
    // Minimized, or under the eight that stream: guests see its frame alone, and no hands reach it.
    expect(guestUseEntry(live({ streamed: ["tab-2"] }), "space-a", "tab-1", true)).toBeNull();
    expect(guestUseEntry(live({ streamed: ["tab-2"], controllable: ["tab-1"] }), "space-a", "tab-1", true)).toEqual({ checked: true });
    expect(notStreamingReason(live({ streamed: ["tab-2"] }), "tab-1")).toBe("Not streamed now: guests see its frame alone");
    expect(notStreamingReason(live({ streamed: ["tab-1"] }), "tab-1")).toBeNull();
  });

  it("is offered for a tab's own page, not for Home or another page the shell draws, nor for a masked window", () => {
    const desk = { windows: [{ tabId: "tab-1", rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }, { tabId: "tab-2", rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 }, mask: { x: 10, y: 10, width: 200, height: 120, pageWidth: 1000, pageHeight: 800 } }] };
    expect(guestsCanBeLetUse({ id: "tab-1", url: "https://github.com/" }, desk)).toBe(true);
    expect(guestsCanBeLetUse({ id: "tab-1", url: "https://github.com/" }, undefined)).toBe(true);
    // Shell-drawn: guests watch it, cut from the shell's picture, but no hands reach it; masked: not streamed at all.
    expect(guestsCanBeLetUse({ id: "tab-3", url: "pistachio://home/" }, desk)).toBe(false);
    expect(guestsCanBeLetUse({ id: "tab-3", url: "pistachio://notes/" }, desk)).toBe(false);
    expect(guestsCanBeLetUse({ id: "tab-2", url: "https://mail.example.com/" }, desk)).toBe(false);
    // And the card says which.
    expect(notUsableReason({ url: "pistachio://terminal/0123456789ab" })).toBe("Guests watch it; only you can use it");
    expect(notUsableReason({ url: "https://mail.example.com/" })).toBe("Only on your screen for now");
  });

  it("is not there for another space's window, a page the shell draws, or with nothing live", () => {
    const streaming = { streamed: ["tab-1"] };
    expect(guestUseEntry(live(streaming), "space-b", "tab-1", true)).toBeNull();
    expect(guestUseEntry(live(streaming), null, "tab-1", true)).toBeNull();
    expect(guestUseEntry(live(streaming), "space-a", "tab-1", false)).toBeNull();
    expect(guestUseEntry(live({ ...streaming, status: "starting" }), "space-a", "tab-1", true)).toBeNull();
  });
});

describe("the Live card", () => {
  it("says Starting from the click, until main has the share of that space", () => {
    expect(liveCardStatus(idleLiveShare(), { groupId: "space-a" })).toBe("starting");
    // Main still ending the share of another space on the way: still starting this one.
    expect(liveCardStatus(live({ status: "ending", groupId: "space-b" }), { groupId: "space-a" })).toBe("starting");
    expect(liveCardStatus(live(), { groupId: "space-a" })).toBe("live");
    expect(liveCardStatus({ ...idleLiveShare(), status: "error", groupId: "space-a", error: "x" }, { groupId: "space-a" })).toBe("error");
    expect(liveCardStatus(live(), null)).toBe("live");
  });

  it("counts the time live", () => {
    expect(elapsedLabel(42_000)).toBe("0:42");
    expect(elapsedLabel(12 * 60_000 + 4_000)).toBe("12:04");
    expect(elapsedLabel(3_723_000)).toBe("1:02:03");
    expect(elapsedLabel(-5)).toBe("0:00");
  });

  it("shows the link short, the token cut", () => {
    expect(linkLabel("https://www.pistachio.run/live/abcdefghijklmnopqrstuvwxyz")).toBe("www.pistachio.run/live/abcdefghij…");
    expect(linkLabel("http://127.0.0.1:3000/live/token")).toBe("127.0.0.1:3000/live/token");
  });
});

describe("the host's name", () => {
  it("is read off the Mac's name where it names someone", () => {
    expect(hostNameFrom("Zach's MacBook Pro")).toBe("Zach");
    expect(hostNameFrom("Ana María’s iMac")).toBe("Ana María");
    expect(hostNameFrom("MacBook Pro")).toBeNull();
    expect(hostNameFrom("")).toBeNull();
  });
});
