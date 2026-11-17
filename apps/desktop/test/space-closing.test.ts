/**
 * Closing a space (main/space-closing.ts; docs/primitives.md §2.6): the one
 * verb behind the space's menu and an extension's `pistachio.spaces.close`.
 * These are Tidy's own tests of filing a space (tab-tidy.test: "archives an
 * auto group…", "files an archived space by its id…", "makes a space again
 * with a new id…"), asked of the verb an extension reaches — plus what code
 * is refused that the person's own press is not.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AwayRefusal } from "@pistachio/shell-contracts/away";
import type { ArchivedTab } from "@pistachio/shell-contracts/tab-archive";
import type { TabGroupColor, TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { CLOSE_REFUSALS, SpaceClosing, type CloseHost, type SpaceClosed } from "../src/main/space-closing";
import { TabArchiveStore } from "../src/main/tab-archive-store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const person = { kind: "person" } as const;
const extension = { kind: "extension", extensionId: "dev.me.idle-spaces", name: "Idle spaces" } as const;

const archived = (title: string): ArchivedTab => ({ title, url: `https://example.com/${title.toLowerCase().replace(/ /g, "-")}`, faviconUrl: null, lastActiveAt: 1 });

/** Main's side, as far as closing reaches it: a Profile's spaces, each with its tabs. */
function browser(initial: Array<{ id: string; title: string; color: TabGroupColor; origin: TabGroupInfo["origin"]; tabs: string[]; persons?: boolean }>) {
  const groups = new Map(initial.map((group) => [group.id, group]));
  const state = { block: null as AwayRefusal | null, unkept: null as string | null, selected: [] as string[], room: true, nextTab: 1 };
  const host = {
    awayBlock: vi.fn((id: string, _options?: { unattended?: boolean; absent?: boolean }) => (groups.has(id) ? state.block : ("unknown" as const))),
    /** The title of a tab of the space the archive would not keep (an address too long for it, a blank page), or null. */
    closeUnkept: vi.fn((id: string) => (groups.has(id) ? state.unkept : null)),
    closeTabGroup: vi.fn(async (id: string, _guard?: { ownTurn?: boolean; unattended?: boolean; absent?: boolean }) => {
      const group = groups.get(id);
      if (group === undefined) return null;
      groups.delete(id);
      const info: TabGroupInfo = { id, title: group.title, color: group.color, tabIds: [], origin: group.origin, open: false, createdAt: 0 };
      return { group: info, spaceId: "work", tabs: group.tabs.map(archived), persons: group.persons === true };
    }),
    activeSpaceId: () => "work",
    hasRoomForSpace: () => state.room,
    hasRoomForTabs: () => true,
    restoreArchivedTabs: vi.fn((_spaceId: string, tabs: readonly ArchivedTab[]) => tabs.map(() => `restored-${String(state.nextTab++)}`)),
    createTabGroup: vi.fn((options: { id?: string; title?: string; color?: TabGroupColor; tabIds: readonly string[]; origin: TabGroupInfo["origin"] }) => {
      // (An id taken since is refused: the caller asks again without one.)
      if (options.id !== undefined && groups.has(options.id)) return null;
      const id = options.id ?? `made-${String(groups.size + 1)}`;
      groups.set(id, { id, title: options.title ?? "", color: options.color ?? "gray", origin: options.origin, tabs: [...options.tabIds] });
      return { id, title: options.title ?? "", color: options.color ?? "gray", tabIds: [...options.tabIds], origin: options.origin, open: false, createdAt: 0 } satisfies TabGroupInfo;
    }),
    commitTidy: vi.fn(),
    selectTab: vi.fn(async (tabId: string) => {
      state.selected.push(tabId);
    }),
    selectGroup: vi.fn(async (groupId: string) => {
      state.selected.push(groupId);
    }),
  };
  return { groups, state, host, asHost: host as unknown as CloseHost };
}

function closingOver(side: ReturnType<typeof browser>) {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-closing-"));
  dirs.push(dir);
  const archive = new TabArchiveStore(dir, () => 30);
  const closing = new SpaceClosing({ host: side.asHost, archive, profileExists: (spaceId) => spaceId === "work" });
  const said: SpaceClosed[] = [];
  closing.onChange((closed) => said.push(closed));
  return { closing, archive, said };
}

const TRIP = { id: "trip", title: "Trip", color: "green" as const, origin: "auto" as const, tabs: ["Trip A", "Trip B"] };
const MINE = { id: "mine", title: "Mine", color: "red" as const, origin: "manual" as const, tabs: ["Mine A", "Mine B"] };

describe("closing a space into the archive", () => {
  it("files it whole, as one entry under its title and colour, and says so once", async () => {
    const side = browser([TRIP, MINE]);
    const { closing, archive, said } = closingOver(side);
    const outcome = await closing.close("trip", { by: extension });
    expect(outcome).toMatchObject({ ok: true, groupId: "trip", profileId: "work", title: "Trip", tabCount: 2, by: extension });
    expect([...side.groups.keys()]).toEqual(["mine"]);
    expect(archive.list("work")).toHaveLength(1);
    expect(archive.list("work")[0]).toMatchObject({ kind: "group", reason: "closed", group: { title: "Trip", color: "green", origin: "auto" } });
    expect(said).toEqual([{ groupId: "trip", profileId: "work", title: "Trip", tabCount: 2, entryId: archive.list("work")[0]!.id, by: extension }]);
  });

  it("files it by its id, and reopening makes it again with that id — its Stack and conversation are kept by it", async () => {
    const side = browser([TRIP]);
    const { closing, archive } = closingOver(side);
    const outcome = await closing.close("trip", { by: extension });
    expect(archive.list("work")[0]).toMatchObject({ kind: "group", groupId: "trip" });
    if (!outcome.ok || outcome.entryId === null) throw new Error("not filed");
    expect(await closing.reopen(outcome.entryId)).toEqual({ ok: true });
    expect([...side.groups.keys()]).toEqual(["trip"]);
    expect(side.groups.get("trip")).toMatchObject({ title: "Trip", color: "green" });
    expect(side.groups.get("trip")!.tabs).toHaveLength(2);
    // The entry is spent: restored once, never twice.
    expect(archive.list("work")).toEqual([]);
  });

  it("makes a space again with a new id when its own was taken since", async () => {
    const side = browser([TRIP]);
    const { closing } = closingOver(side);
    const outcome = await closing.close("trip", { by: extension });
    side.groups.set("trip", { id: "trip", title: "Someone else", color: "blue", origin: "manual", tabs: ["other"] });
    if (!outcome.ok || outcome.entryId === null) throw new Error("not filed");
    await closing.reopen(outcome.entryId);
    expect([...side.groups.values()].map((group) => group.title).sort()).toEqual(["Someone else", "Trip"]);
    expect([...side.groups.values()].find((group) => group.title === "Trip")?.id).not.toBe("trip");
  });

  it("reopens it where it was, not in front: a close nobody pressed is taken back without moving anyone", async () => {
    const side = browser([TRIP]);
    const { closing } = closingOver(side);
    const outcome = await closing.close("trip", { by: extension });
    if (!outcome.ok || outcome.entryId === null) throw new Error("not filed");
    await closing.reopen(outcome.entryId);
    expect(side.state.selected).toEqual([]);
  });

  it("has nothing to undo once the entry is gone: restored by the person, removed, lapsed", async () => {
    const side = browser([TRIP]);
    const { closing, archive } = closingOver(side);
    const outcome = await closing.close("trip", { by: extension });
    if (!outcome.ok || outcome.entryId === null) throw new Error("not filed");
    archive.remove(outcome.entryId);
    expect(await closing.reopen(outcome.entryId)).toEqual({ ok: true });
    expect(side.groups.size).toBe(0);
  });

  it("keeps the entry when the Profile has no room for the space, and says why", async () => {
    const side = browser([TRIP]);
    const { closing, archive } = closingOver(side);
    const outcome = await closing.close("trip", { by: extension });
    if (!outcome.ok || outcome.entryId === null) throw new Error("not filed");
    side.state.room = false;
    const back = await closing.reopen(outcome.entryId);
    expect(back.ok).toBe(false);
    expect(back.reason).toContain("no room");
    expect(archive.list("work")).toHaveLength(1);
  });

  it("files nothing for a space with nothing to bring back, and an empty space the person keeps as the space alone", async () => {
    const side = browser([
      { id: "fresh", title: "New space", color: "gray", origin: "auto", tabs: [] },
      { id: "kept", title: "Notes", color: "blue", origin: "manual", tabs: [], persons: true },
    ]);
    const { closing, archive } = closingOver(side);
    expect(await closing.close("fresh", { by: person })).toMatchObject({ ok: true, entryId: null, tabCount: 0 });
    expect(archive.list("work")).toEqual([]);
    const kept = await closing.close("kept", { by: person });
    expect(kept).toMatchObject({ ok: true, tabCount: 0 });
    expect(archive.list("work")).toHaveLength(1);
    expect(archive.list("work")[0]).toMatchObject({ kind: "group", groupId: "kept", tabs: [] });
  });
});

describe("the window closed", () => {
  it("does nothing more once stopped: a close and an Undo queued behind one under way leave the space and the entry where they are", async () => {
    const side = browser([TRIP, MINE]);
    const { closing, archive } = closingOver(side);
    const filed = await closing.close("mine", { by: extension });
    if (!filed.ok || filed.entryId === null) throw new Error("not filed");
    // Trip's close is under way — its pages closing — when the window closes.
    const close = side.host.closeTabGroup.getMockImplementation()!;
    let closed = (): void => undefined;
    side.host.closeTabGroup.mockImplementationOnce(async (id) => {
      await new Promise<void>((resolve) => (closed = resolve));
      return close(id);
    });
    const first = closing.close("trip", { by: extension });
    const undo = closing.reopen(filed.entryId);
    const again = closing.close("trip", { by: extension });
    await Promise.resolve();
    closing.stop();
    closed();
    // What was under way finishes — its space is filed; nothing behind it touches the controller the window took with it.
    expect((await first).ok).toBe(true);
    expect(await undo).toMatchObject({ ok: false });
    expect(await again).toMatchObject({ ok: false, refusal: "failed" });
    expect(side.host.restoreArchivedTabs).not.toHaveBeenCalled();
    expect(side.host.closeTabGroup).toHaveBeenCalledTimes(2);
    // Mine's entry, the only copy of it, is still in the archive.
    expect(archive.get(filed.entryId)).not.toBeNull();
    expect(archive.list("work")).toHaveLength(2);
  });
});

describe("who may close what", () => {
  it("refuses the person's own press nothing: it is theirs to make", async () => {
    const side = browser([TRIP]);
    side.state.block = "live";
    const { closing } = closingOver(side);
    expect(await closing.close("trip", { by: person })).toMatchObject({ ok: true });
    expect(side.host.awayBlock).not.toHaveBeenCalled();
  });

  it("refuses code a space that is busy, in the verb's own sentence, and changes nothing", async () => {
    // (`tooMany`: more tabs than the archive keeps of one space — code may not close what would not all be filed.)
    for (const block of ["live", "sharing", "recording", "working", "tooMany"] as const) {
      const side = browser([TRIP]);
      side.state.block = block;
      const { closing, archive, said } = closingOver(side);
      expect(await closing.close("trip", { by: extension }), block).toEqual({ ok: false, refusal: block, reason: CLOSE_REFUSALS[block] });
      expect(side.host.closeTabGroup).not.toHaveBeenCalled();
      expect(archive.list("work")).toEqual([]);
      expect(said).toEqual([]);
    }
  });

  it("refuses code a space a tab of which the archive would not keep, naming it — the person's own close is theirs", async () => {
    // (Closed, the tab's page is gone; read back from the archive's file, the tab is not there: Undo could not return it.)
    const side = browser([TRIP]);
    side.state.unkept = "Flights to Lisbon";
    const { closing, archive, said } = closingOver(side);
    expect(await closing.close("trip", { by: extension })).toEqual({ ok: false, refusal: "unkept", reason: "“Flights to Lisbon” cannot be kept in the archive. Close that tab, then close the space." });
    expect(await closing.close("trip", { by: { kind: "agent" } })).toMatchObject({ ok: false, refusal: "unkept" });
    expect(side.host.closeTabGroup).not.toHaveBeenCalled();
    expect(archive.list("work")).toEqual([]);
    expect(said).toEqual([]);
    // A tab with no name to say is still said.
    side.state.unkept = "";
    expect(await closing.close("trip", { by: extension })).toEqual({ ok: false, refusal: "unkept", reason: CLOSE_REFUSALS.unkept });
    // The person's press is refused nothing, as it was.
    side.state.unkept = "Flights to Lisbon";
    expect(await closing.close("trip", { by: person })).toMatchObject({ ok: true });
    expect(side.host.closeUnkept).toHaveBeenCalledTimes(3);
  });

  it("has the host ask again as it closes — the desk passing on takes a moment — and says what refuses it by then; the person's close is asked nothing", async () => {
    // (The space in front passes the desk on before its pages are closed: a page can turn into one the archive does
    // not keep, or begin to be recorded, meanwhile. The host is given what to ask, and asks it last thing.)
    const side = browser([TRIP, MINE]);
    const { closing, archive, said } = closingOver(side);
    await closing.close("trip", { by: extension, unattended: true, absent: true });
    expect(side.host.closeTabGroup).toHaveBeenLastCalledWith("trip", { unattended: true, absent: true });
    await closing.close("mine", { by: person });
    expect(side.host.closeTabGroup).toHaveBeenLastCalledWith("mine");
    // Refused at that last moment, the host closes nothing: the outcome is whatever refuses it now.
    const late = browser([TRIP]);
    const over = closingOver(late);
    late.host.closeTabGroup.mockImplementationOnce(async () => {
      late.state.unkept = "Flights to Lisbon";
      return null;
    });
    expect(await over.closing.close("trip", { by: extension })).toMatchObject({ ok: false, refusal: "unkept", reason: expect.stringContaining("“Flights to Lisbon”") });
    late.state.unkept = null;
    late.host.closeTabGroup.mockImplementationOnce(async () => {
      late.state.block = "recording";
      return null;
    });
    expect(await over.closing.close("trip", { by: extension })).toEqual({ ok: false, refusal: "recording", reason: CLOSE_REFUSALS.recording });
    expect([...late.groups.keys()]).toEqual(["trip"]);
    expect(over.archive.list("work")).toEqual([]);
    expect(over.said).toEqual([]);
    expect(archive.list("work")).toHaveLength(2);
    expect(said).toHaveLength(2);
  });

  it("asks with nobody there what sending away is asked: the space in front, one playing, one with a terminal", async () => {
    const side = browser([TRIP]);
    const { closing } = closingOver(side);
    side.state.block = "inFront";
    expect(await closing.close("trip", { by: extension, unattended: true })).toMatchObject({ ok: false, refusal: "inFront", reason: CLOSE_REFUSALS.inFront });
    expect(side.host.awayBlock).toHaveBeenLastCalledWith("trip", { unattended: true });
    side.state.block = "terminal";
    expect(await closing.close("trip", { by: extension, unattended: true })).toMatchObject({ ok: false, refusal: "terminal" });
    expect(CLOSE_REFUSALS.terminal).toContain("closing the space would end it");
    side.state.block = null;
    expect(await closing.close("trip", { by: extension, unattended: true, absent: true })).toMatchObject({ ok: true });
    expect(side.host.awayBlock).toHaveBeenLastCalledWith("trip", { unattended: true, absent: true });
  });

  it("says a space that is not here is not here", async () => {
    const side = browser([]);
    const { closing } = closingOver(side);
    expect(await closing.close("gone", { by: extension })).toMatchObject({ ok: false, refusal: "unknown" });
    expect(await closing.close("gone", { by: person })).toMatchObject({ ok: false, refusal: "unknown" });
  });

  it("closes one at a time: two asked together do not interleave", async () => {
    const side = browser([TRIP, MINE]);
    const { closing, archive } = closingOver(side);
    const order: string[] = [];
    const close = side.host.closeTabGroup.getMockImplementation()!;
    side.host.closeTabGroup.mockImplementation(async (id: string) => {
      order.push(`start ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const closed = await close(id);
      order.push(`end ${id}`);
      return closed;
    });
    await Promise.all([closing.close("trip", { by: extension }), closing.close("mine", { by: extension })]);
    expect(order).toEqual(["start trip", "end trip", "start mine", "end mine"]);
    expect(archive.list("work")).toHaveLength(2);
  });
});
