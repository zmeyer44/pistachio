/**
 * Away spaces (main/away-spaces.ts, main/away-store.ts; docs/primitives.md
 * §2): a space sent away is kept whole in a file of its own and comes back
 * as itself — when asked, or by main's clock, which asks what is due rather
 * than waiting to be told (so a Mac asleep across the time still brings the
 * space back). A space is never in neither the session nor the file.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AWAY_REFUSALS, MAX_AWAY_SPACES_PER_PROFILE, MAX_TABS_KEPT_OF_A_SPACE, type AwayRefusal } from "@pistachio/shell-contracts/away";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import type { DurableSpaceSession, DurableTab } from "@pistachio/shell-contracts/tab-session";
import { AWAY_TICK_MS, AwaySpaces, type AwayChange, type AwayHost } from "../src/main/away-spaces";
import { AwayStore } from "../src/main/away-store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-away-"));
  dirs.push(dir);
  return dir;
}

const tab = (id: string, spaceId = "work"): DurableTab => ({ id, spaceId, title: id, url: `https://example.com/${id}`, faviconUrl: null, anchorId: null, lastActiveAt: 1 });

function held(id: string, tabIds: string[], spaceId = "work"): DurableSpaceSession {
  const group: TabGroupInfo = { id, title: id, color: "green", tabIds, origin: "manual", open: false, createdAt: 1 };
  return { tabs: tabIds.map((tabId) => tab(tabId, spaceId)), activeTabId: tabIds[0] ?? null, recentTabIds: [...tabIds], splitGroups: [], tabGroups: [group] };
}

/** Main's side, as far as away reaches it: Profiles holding spaces, each a slice of the session. */
function browser(spaces: Record<string, string[]> = { football: ["espn", "league"] }) {
  const here = new Map<string, { profile: string; held: DurableSpaceSession }>(Object.entries(spaces).map(([id, tabIds]) => [id, { profile: "work", held: held(id, tabIds) }]));
  const state: { room: boolean; tabRoom: boolean; block: AwayRefusal | null; unkept: string | null; active: string; written: boolean } = { room: true, tabRoom: true, block: null, unkept: null, active: "work", written: true };
  const host = {
    activeSpaceId: () => state.active,
    hasTabGroup: (id: string) => here.has(id),
    profileOfTabGroup: (id: string) => here.get(id)?.profile ?? null,
    awayBlock: vi.fn((id: string, _options?: { ownTurn?: boolean }) => (here.has(id) ? state.block : ("unknown" as const))),
    /** The title of a tab of the space that would not be kept away (a page no relaunch reopens), or null. */
    awayUnkept: vi.fn((id: string) => (here.has(id) ? state.unkept : null)),
    takeGroupAway: vi.fn(async (id: string, _options?: { ownTurn?: boolean }) => {
      const space = here.get(id);
      if (space === undefined) return null;
      here.delete(id);
      return { spaceId: space.profile, held: space.held };
    }),
    putGroupBack: vi.fn((spaceId: string, session: DurableSpaceSession) => {
      const group = session.tabGroups?.[0];
      if (group === undefined || here.has(group.id) || !state.room) return null;
      here.set(group.id, { profile: spaceId, held: session });
      return group;
    }),
    hasRoomForSpace: () => state.room,
    /** Whether the Profile's session would keep the space's tabs beside its own (two hundred of a Profile are read back). */
    hasRoomForTabs: vi.fn((_spaceId: string, _coming: number) => state.tabRoom),
    /** The session written now — or not: a disk that is full takes no write. */
    sessionWritten: vi.fn(() => state.written),
    selectGroup: vi.fn(async () => undefined),
    refreshSpaces: vi.fn(),
  };
  return { here, state, host, asHost: host as unknown as AwayHost };
}

/** A clock and its one timer, both the test's. */
function clock(start = 1_000_000) {
  const state = { now: start };
  const pending: Array<{ callback: () => void; ms: number }> = [];
  return {
    state,
    pending,
    now: () => state.now,
    timers: {
      setTimeout: (callback: () => void, ms: number) => {
        const entry = { callback, ms };
        pending.push(entry);
        return entry;
      },
      clearTimeout: (handle: unknown) => {
        const index = pending.indexOf(handle as { callback: () => void; ms: number });
        if (index >= 0) pending.splice(index, 1);
      },
    },
  };
}

function service(options: { dir?: string; spaces?: Record<string, string[]>; profiles?: string[] } = {}) {
  const dir = options.dir ?? folder();
  const side = browser(options.spaces);
  const time = clock();
  const store = new AwayStore(dir);
  const profiles = new Set(options.profiles ?? ["work", "home"]);
  const away = new AwaySpaces({ store, host: side.asHost, profileExists: (spaceId) => profiles.has(spaceId), now: time.now, timers: time.timers });
  const changes: AwayChange[] = [];
  away.onChange((change) => changes.push(change));
  return { dir, store, away, changes, time, profiles, ...side };
}

const person = { kind: "person" } as const;

describe("sending a space away", () => {
  it("takes it out of the window and keeps it whole in the file, said once", async () => {
    const { away, here, dir, changes, host } = service();
    const outcome = await away.send("football", { by: person });
    expect(outcome.ok).toBe(true);
    expect(here.has("football")).toBe(false);
    expect(away.list("work").map((space) => [space.id, space.title, space.tabCount])).toEqual([["football", "football", 2]]);
    expect(away.list("home")).toEqual([]);
    // On disk at once: for as long as it is away the file is the only copy of its tabs.
    const written = JSON.parse(readFileSync(join(dir, "away-spaces.json"), "utf8")) as { spaces: Array<{ id: string; held: DurableSpaceSession }> };
    expect(written.spaces[0]?.held.tabs.map((entry) => entry.id)).toEqual(["espn", "league"]);
    expect(changes).toEqual([{ event: "sent", space: away.get("football") }]);
    expect(host.refreshSpaces).toHaveBeenCalled();
  });

  it("says who sent it, and when it is due", async () => {
    const { away, time } = service();
    const until = time.state.now + 60_000;
    await away.send("football", { by: { kind: "extension", extensionId: "dev.me.game-day", name: "Game day" }, until });
    expect(away.get("football")).toMatchObject({ by: { kind: "extension", extensionId: "dev.me.game-day", name: "Game day" }, since: time.state.now, until });
  });

  it("refuses in a sentence, and touches nothing", async () => {
    const { away, state, here, time, host } = service();
    expect(await away.send("nowhere", { by: person })).toEqual({ ok: false, refusal: "unknown", reason: AWAY_REFUSALS.unknown });
    expect(await away.send("football", { by: person, until: time.state.now })).toMatchObject({ ok: false, refusal: "past" });
    expect(await away.send("football", { by: person, until: Number.NaN })).toMatchObject({ ok: false, refusal: "past" });
    for (const block of ["notASpace", "live", "sharing", "recording", "working"] as const) {
      state.block = block;
      expect(await away.send("football", { by: person })).toEqual({ ok: false, refusal: block, reason: AWAY_REFUSALS[block] });
    }
    expect(host.takeGroupAway).not.toHaveBeenCalled();
    expect(here.has("football")).toBe(true);
    expect(away.all()).toEqual([]);
  });

  it("tells main the agent asks from the very space it works in, and only then", async () => {
    const { away, host } = service({ spaces: { football: ["espn"], work: ["mail"] } });
    await away.send("football", { by: { kind: "agent" }, ownTurn: true });
    expect(host.awayBlock).toHaveBeenLastCalledWith("football", { ownTurn: true });
    expect(host.takeGroupAway).toHaveBeenLastCalledWith("football", { ownTurn: true });
    await away.send("work", { by: { kind: "agent" } });
    expect(host.takeGroupAway).toHaveBeenLastCalledWith("work", {});
  });

  it("holds as many as a Profile may, and no more", async () => {
    const spaces = Object.fromEntries(Array.from({ length: MAX_AWAY_SPACES_PER_PROFILE + 1 }, (_, index) => [`space-${String(index)}`, [`tab-${String(index)}`]]));
    const { away, here } = service({ spaces });
    for (let index = 0; index < MAX_AWAY_SPACES_PER_PROFILE; index += 1) expect((await away.send(`space-${String(index)}`, { by: person })).ok).toBe(true);
    const last = `space-${String(MAX_AWAY_SPACES_PER_PROFILE)}`;
    expect(await away.send(last, { by: person })).toMatchObject({ ok: false, refusal: "full" });
    expect(here.has(last)).toBe(true);
  });

  it("does not take a space with more tabs than the file reads back: refused, and still here whole", async () => {
    // (A space's slice of the session is read back two hundred tabs at most: the two hundred and first would be in neither.)
    const many = Array.from({ length: MAX_TABS_KEPT_OF_A_SPACE + 1 }, (_, index) => `tab-${String(index)}`);
    const { away, here, dir, changes } = service({ spaces: { large: many } });
    expect(await away.send("large", { by: person })).toEqual({ ok: false, refusal: "tooMany", reason: AWAY_REFUSALS.tooMany });
    expect(here.get("large")?.held.tabs.map((entry) => entry.id)).toEqual(many);
    expect(away.all()).toEqual([]);
    expect(new AwayStore(dir).all()).toEqual([]);
    expect(changes).toEqual([]);
    // At the bound it goes, every tab of it kept.
    const { away: other, dir: otherDir } = service({ spaces: { large: many.slice(1) } });
    expect((await other.send("large", { by: person })).ok).toBe(true);
    expect(new AwayStore(otherDir).get("large")?.held.tabs).toHaveLength(MAX_TABS_KEPT_OF_A_SPACE);
  });

  it("does not take a space a page of which would not be kept, and says which: nothing moves", async () => {
    // (A page no relaunch reopens — an address past what the session keeps, a blank page — is dropped as the file is read.)
    const { away, here, state, host, changes } = service();
    state.unkept = "Flights to Lisbon";
    const outcome = await away.send("football", { by: person });
    expect(outcome).toMatchObject({ ok: false, refusal: "unkept" });
    if (!outcome.ok) expect(outcome.reason).toBe("“Flights to Lisbon” cannot be kept while its space is away. Close that tab, then send the space away.");
    expect(host.takeGroupAway).not.toHaveBeenCalled();
    expect(here.get("football")?.held.tabs).toHaveLength(2);
    expect(away.all()).toEqual([]);
    expect(changes).toEqual([]);
    // A tab with no name to say is still said.
    state.unkept = "";
    expect(await away.send("football", { by: person })).toEqual({ ok: false, refusal: "unkept", reason: AWAY_REFUSALS.unkept });
  });

  it("never files less of a space than it took: a tab the file would drop puts the whole space straight back", async () => {
    // (The host was not asked, or the page changed on the way out: what is taken is checked against what the file reads back.)
    const { away, here, dir, changes } = service({ spaces: { football: ["espn", "long"], solo: ["only"] } });
    here.get("football")!.held.tabs[1]!.url = `https://example.com/${"a".repeat(3_000)}`;
    here.get("football")!.held.tabs[1]!.title = "A very long address";
    const outcome = await away.send("football", { by: person });
    expect(outcome).toMatchObject({ ok: false, refusal: "unkept" });
    if (!outcome.ok) expect(outcome.reason).toContain("“A very long address”");
    expect(here.get("football")?.held.tabs.map((entry) => entry.id)).toEqual(["espn", "long"]);
    expect(new AwayStore(dir).all()).toEqual([]);
    // A space of that one tab is not filed empty either.
    here.get("solo")!.held.tabs[0]!.url = `https://example.com/${"b".repeat(3_000)}`;
    expect(await away.send("solo", { by: person })).toMatchObject({ ok: false, refusal: "unkept" });
    expect(here.get("solo")?.held.tabs).toHaveLength(1);
    expect(away.all()).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("puts a space straight back when the file cannot be written: never in neither", async () => {
    const { away, here, store } = service();
    vi.spyOn(store, "add").mockReturnValue(false);
    expect(await away.send("football", { by: person })).toMatchObject({ ok: false, refusal: "failed" });
    expect(here.get("football")?.held.tabs.map((entry) => entry.id)).toEqual(["espn", "league"]);
    expect(away.all()).toEqual([]);
  });
});

describe("bringing a space back", () => {
  it("brings back the same space: its id, its tabs under their ids", async () => {
    const { away, here, changes, host } = service();
    await away.send("football", { by: person });
    const outcome = await away.bringBack("football");
    expect(outcome.ok).toBe(true);
    expect(here.get("football")?.held.tabGroups?.[0]?.id).toBe("football");
    expect(here.get("football")?.held.tabs.map((entry) => entry.id)).toEqual(["espn", "league"]);
    expect(away.all()).toEqual([]);
    expect(changes.at(-1)).toMatchObject({ event: "returned", cause: "asked", space: { id: "football" } });
    // Nobody is moved unless the person asked for it by name.
    expect(host.selectGroup).not.toHaveBeenCalled();
    await away.send("football", { by: person });
    await away.bringBack("football", { select: true });
    expect(host.selectGroup).toHaveBeenCalledWith("football");
  });

  it("keeps a space the Profile has no room for, and brings it back once there is", async () => {
    const { away, state, here } = service();
    await away.send("football", { by: person });
    state.room = false;
    expect(await away.bringBack("football")).toEqual({ ok: false, refusal: "room", reason: AWAY_REFUSALS.room });
    expect(away.get("football")).not.toBeNull();
    state.room = true;
    expect((await away.bringBack("football")).ok).toBe(true);
    expect(here.has("football")).toBe(true);
  });

  it("keeps a space away while the Profile's session has no room for its tabs: what the session would drop is not let go of", async () => {
    // (A Profile's session is read back two hundred tabs at most: tabs returned past that would be gone at the next launch.)
    const { away, here, dir, state, host } = service();
    await away.start();
    await away.send("football", { by: person });
    state.tabRoom = false;
    expect(await away.bringBack("football", { select: true })).toEqual({ ok: false, refusal: "tabsFull", reason: AWAY_REFUSALS.tabsFull });
    expect(host.hasRoomForTabs).toHaveBeenLastCalledWith("work", 2);
    expect(host.putGroupBack).not.toHaveBeenCalled();
    expect(here.has("football")).toBe(false);
    expect(new AwayStore(dir).get("football")).not.toBeNull();
    // Tabs closed, it comes back.
    state.tabRoom = true;
    expect((await away.bringBack("football")).ok).toBe(true);
    expect(here.has("football")).toBe(true);
  });

  it("keeps a due space waiting for room for its tabs, says so on its row, and brings it back once there is", async () => {
    const { away, here, state, time } = service();
    await away.start();
    await away.send("football", { by: person, until: time.state.now + 5_000 });
    state.tabRoom = false;
    time.state.now += 6_000;
    await away.tick();
    expect(here.has("football")).toBe(false);
    expect(away.get("football")?.waiting).toBe("room");
    state.tabRoom = true;
    time.state.now += AWAY_TICK_MS;
    await away.tick();
    expect(here.has("football")).toBe(true);
    expect(away.all()).toEqual([]);
  });

  it("brings a space of a Profile that is gone back in the Profile in front", async () => {
    const { away, profiles, state, here } = service();
    await away.send("football", { by: person });
    profiles.delete("work");
    state.active = "home";
    await away.bringBack("football");
    expect(here.get("football")?.profile).toBe("home");
  });

  it("lists a space whose Profile is gone in the Profile in front — untimed too, across a restart — until it is brought back there", async () => {
    const first = service({ spaces: { football: ["espn"], recipes: ["soup"] } });
    await first.away.send("football", { by: person });
    await first.away.send("recipes", { by: person, until: first.time.state.now + 60_000 });
    expect(first.away.list("home")).toEqual([]);
    // Work is removed (on another device, say). Nothing lists a Profile that is gone: its away spaces are the Profile in front's.
    first.profiles.delete("work");
    first.state.active = "home";
    expect(first.away.list("work")).toEqual([]);
    expect(first.away.list("home").map((space) => [space.id, space.spaceId])).toEqual([
      ["football", "home"],
      ["recipes", "home"],
    ]);
    expect(first.away.get("football")?.spaceId).toBe("home");
    expect(first.away.all().map((space) => space.spaceId)).toEqual(["home", "home"]);
    // A restart reads them back, and they are still to be seen.
    const second = service({ dir: first.dir, spaces: {}, profiles: ["home"] });
    second.state.active = "home";
    await second.away.start();
    expect(second.away.list("home").map((space) => space.id)).toEqual(["football", "recipes"]);
    // The one with no time is a press from back, where the person is.
    expect((await second.away.bringBack("football", { select: true })).ok).toBe(true);
    expect(second.here.get("football")?.profile).toBe("home");
    expect(second.away.list("home").map((space) => space.id)).toEqual(["recipes"]);
  });

  it("says whether a tab is away, whichever space it went with — and not once that space is back", async () => {
    const { away } = service({ spaces: { football: ["espn", "league"], recipes: ["soup"] } });
    expect(away.holdsTab("espn")).toBe(false);
    await away.send("football", { by: person });
    expect(away.holdsTab("espn")).toBe(true);
    expect(away.holdsTab("league")).toBe(true);
    expect(away.holdsTab("soup")).toBe(false);
    await away.bringBack("football");
    expect(away.holdsTab("espn")).toBe(false);
  });

  it("says a space that is not away is not", async () => {
    const { away } = service();
    expect(await away.bringBack("football")).toMatchObject({ ok: false, refusal: "notAway" });
  });

  it("survives a restart: the file is read back, and the space comes back as itself", async () => {
    const first = service();
    await first.away.send("football", { by: { kind: "agent" }, until: first.time.state.now + 3_600_000 });
    const second = service({ dir: first.dir, spaces: {} });
    expect(second.away.list("work")).toMatchObject([{ id: "football", by: { kind: "agent" }, tabCount: 2 }]);
    await second.away.bringBack("football");
    expect(second.here.get("football")?.held.tabs.map((entry) => entry.id)).toEqual(["espn", "league"]);
  });
});

describe("the clock", () => {
  it("brings back what is due, and nothing before its time", async () => {
    const { away, time, here, changes } = service({ spaces: { football: ["espn"], taxes: ["irs"], someday: ["x"] } });
    await away.send("football", { by: person, until: time.state.now + 60_000 });
    await away.send("taxes", { by: person, until: time.state.now + 600_000 });
    await away.send("someday", { by: person });
    await away.start();
    await away.tick();
    expect(here.size).toBe(0);
    time.state.now += 60_000;
    await away.tick();
    expect([...here.keys()]).toEqual(["football"]);
    expect(changes.at(-1)).toMatchObject({ event: "returned", cause: "clock", space: { id: "football" } });
    expect(away.all().map((space) => space.id)).toEqual(["taxes", "someday"]);
  });

  it("asks what is due rather than waiting to be told: a time slept through is honoured at the next look", async () => {
    const first = service();
    await first.away.send("football", { by: person, until: first.time.state.now + 60_000 });
    // The app closed, the time came and went, and it opens days later.
    const second = service({ dir: first.dir, spaces: {} });
    second.time.state.now = first.time.state.now + 3 * 86_400_000;
    await second.away.start();
    expect(second.here.has("football")).toBe(true);
    expect(second.away.all()).toEqual([]);
  });

  it("sleeps until the next space is due, never longer than a tick, and not at all with none timed", async () => {
    const { away, time } = service({ spaces: { football: ["espn"], taxes: ["irs"] } });
    await away.start();
    await away.send("football", { by: person });
    expect(time.pending).toEqual([]);
    await away.send("taxes", { by: person, until: time.state.now + 5_000 });
    expect(time.pending.map((timer) => timer.ms)).toEqual([5_000]);
    await away.bringBack("taxes");
    expect(time.pending).toEqual([]);
    await away.send("taxes", { by: person, until: time.state.now + 86_400_000 });
    expect(time.pending.map((timer) => timer.ms)).toEqual([AWAY_TICK_MS]);
    // The timer's own look brings it back when the time has come.
    time.state.now += 86_400_000;
    time.pending.splice(0, 1)[0]?.callback();
    await away.tick();
    expect(away.get("taxes")).toBeNull();
    away.stop();
    expect(time.pending).toEqual([]);
  });

  it("keeps a due space waiting while there is no room, says so, and tries again each tick", async () => {
    const { away, time, state, here, host } = service();
    await away.start();
    await away.send("football", { by: person, until: time.state.now + 1_000 });
    state.room = false;
    time.state.now += 1_000;
    host.refreshSpaces.mockClear();
    await away.tick();
    expect(away.get("football")?.waiting).toBe("room");
    expect(host.refreshSpaces).toHaveBeenCalledTimes(1);
    // Looked at again a whole tick on, not at once.
    expect(time.pending.map((timer) => timer.ms)).toEqual([AWAY_TICK_MS]);
    state.room = true;
    await away.tick();
    expect(here.has("football")).toBe(true);
    expect(away.all()).toEqual([]);
  });

  it("lets the session's copy win when a crash left a space in both", async () => {
    const first = service();
    await first.away.send("football", { by: person });
    // The session was never written without it: at the next launch the space is in the window and in the file.
    const second = service({ dir: first.dir });
    expect(second.away.list("work")).toHaveLength(1);
    await second.away.start();
    expect(second.away.all()).toEqual([]);
    expect(second.here.has("football")).toBe(true);
    expect(second.host.putGroupBack).not.toHaveBeenCalled();
  });

  it("does one thing at a time", async () => {
    const { away, here } = service({ spaces: { football: ["espn"] } });
    const outcomes = await Promise.all([away.send("football", { by: person }), away.bringBack("football"), away.send("football", { by: person }), away.bringBack("football")]);
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true, true, true]);
    expect(here.has("football")).toBe(true);
  });
});

describe("a space back while the session cannot be written", () => {
  it("keeps the file's copy until the session holding the space is on disk: never in neither", async () => {
    const { away, here, dir, state, changes } = service();
    await away.start();
    await away.send("football", { by: person });
    state.written = false;
    expect((await away.bringBack("football")).ok).toBe(true);
    // Back as far as anyone can tell: in the window, on no list of away spaces, said once…
    expect(here.has("football")).toBe(true);
    expect(away.all()).toEqual([]);
    expect(away.list("work")).toEqual([]);
    expect(away.get("football")).toBeNull();
    expect(changes.map((change) => change.event)).toEqual(["sent", "returned"]);
    expect(await away.bringBack("football")).toMatchObject({ ok: false, refusal: "notAway" });
    // …and still in the file: the session holding it again is in memory alone, and a restart would read the one without it.
    expect(new AwayStore(dir).all().map((space) => space.id)).toEqual(["football"]);
    // A look at the clock that still cannot write changes nothing.
    await away.tick();
    expect(new AwayStore(dir).all().map((space) => space.id)).toEqual(["football"]);
    expect(changes).toHaveLength(2);
    // Written at last, the file lets go.
    state.written = true;
    await away.tick();
    expect(new AwayStore(dir).all()).toEqual([]);
    expect(here.has("football")).toBe(true);
  });

  it("looks again by itself, a tick on, for as long as the file is holding a copy for the session", async () => {
    const { away, dir, state, time } = service();
    await away.start();
    await away.send("football", { by: person });
    expect(time.pending).toEqual([]);
    state.written = false;
    await away.bringBack("football");
    expect(time.pending.map((timer) => timer.ms)).toEqual([AWAY_TICK_MS]);
    state.written = true;
    time.pending.splice(0, 1)[0]?.callback();
    await away.tick();
    expect(new AwayStore(dir).all()).toEqual([]);
    expect(time.pending).toEqual([]);
  });

  it("is away again at the next launch when the session never was written — and back in the session's stead when it was", async () => {
    const first = service();
    await first.away.send("football", { by: person, until: first.time.state.now + 60_000 });
    first.state.written = false;
    await first.away.bringBack("football");
    // The app quits with the session still unwritten: the next launch reads the old session, without the space.
    const second = service({ dir: first.dir, spaces: {} });
    expect(second.away.list("work").map((space) => space.id)).toEqual(["football"]);
    // (And one whose session did reach the disk before the file let go is the session's: start's own rule.)
    const third = service({ dir: first.dir });
    await third.away.start();
    expect(third.away.all()).toEqual([]);
    expect(third.host.putGroupBack).not.toHaveBeenCalled();
  });

  it("keeps the kept copy through another space's going, and lets a space sent again replace its own", async () => {
    const { away, here, dir, state } = service({ spaces: { football: ["espn"], recipes: ["soup"] } });
    await away.send("football", { by: person });
    state.written = false;
    await away.bringBack("football");
    // Another space goes: the file is written again, and still holds the copy the session has not confirmed.
    await away.send("recipes", { by: person });
    expect(new AwayStore(dir).all().map((space) => space.id).sort()).toEqual(["football", "recipes"]);
    expect(away.all().map((space) => space.id)).toEqual(["recipes"]);
    // Football, given a tab since, is sent again: the file holds it as it is now, once.
    here.get("football")!.held = held("football", ["espn", "scores"]);
    expect((await away.send("football", { by: person })).ok).toBe(true);
    const filed = new AwayStore(dir).all().filter((space) => space.id === "football");
    expect(filed.map((space) => space.held.tabs.map((entry) => entry.id))).toEqual([["espn", "scores"]]);
    expect(away.all().map((space) => space.id).sort()).toEqual(["football", "recipes"]);
    // Written, nothing kept is left to let go of: both are still away.
    state.written = true;
    await away.tick();
    expect(new AwayStore(dir).all().map((space) => space.id).sort()).toEqual(["football", "recipes"]);
  });

  it("never gives the file more of a Profile's spaces than a restart reads back: a kept copy counts, but for its own space sent again", async () => {
    const spaces = Object.fromEntries(Array.from({ length: MAX_AWAY_SPACES_PER_PROFILE + 1 }, (_, index) => [`space-${String(index)}`, [`tab-${String(index)}`]]));
    const { away, here, dir, state, time } = service({ spaces });
    for (let index = 0; index < MAX_AWAY_SPACES_PER_PROFILE; index += 1) {
      time.state.now += 1;
      await away.send(`space-${String(index)}`, { by: person });
    }
    state.written = false;
    await away.bringBack("space-0");
    // Forty-nine listed and one kept: the file is full, and one more would push the oldest — the kept copy, the only one
    // a restart would find of that space — out of what is read back.
    const last = `space-${String(MAX_AWAY_SPACES_PER_PROFILE)}`;
    expect(away.list("work")).toHaveLength(MAX_AWAY_SPACES_PER_PROFILE - 1);
    expect(await away.send(last, { by: person })).toMatchObject({ ok: false, refusal: "full" });
    expect(here.has(last)).toBe(true);
    expect(new AwayStore(dir).all()).toHaveLength(MAX_AWAY_SPACES_PER_PROFILE);
    expect(new AwayStore(dir).get("space-0")).not.toBeNull();
    // The kept space itself may go again: its new copy takes the place of the kept one.
    expect((await away.send("space-0", { by: person })).ok).toBe(true);
    expect(new AwayStore(dir).all()).toHaveLength(MAX_AWAY_SPACES_PER_PROFILE);
    // And once the session is written and the file has let go, there is room again.
    await away.bringBack("space-1");
    expect(await away.send(last, { by: person })).toMatchObject({ ok: false, refusal: "full" });
    state.written = true;
    await away.tick();
    expect((await away.send(last, { by: person })).ok).toBe(true);
  });
});

describe("the window closed", () => {
  it("does nothing more once stopped: what was queued behind a return under way leaves its space in the file", async () => {
    const { away, here, dir, host, time, changes } = service({ spaces: { football: ["espn"], recipes: ["soup"], trip: ["map"] } });
    await away.start();
    await away.send("football", { by: person });
    await away.send("recipes", { by: person });
    await away.send("trip", { by: person, until: time.state.now + 1_000 });
    // Football's return is under way — brought in front, which waits on the window — when the window closes.
    let shown = (): void => undefined;
    host.selectGroup.mockImplementationOnce(() => new Promise<undefined>((resolve) => (shown = () => resolve(undefined))));
    const first = away.bringBack("football", { select: true });
    const second = away.bringBack("recipes");
    time.state.now += 2_000;
    const due = away.tick();
    const sent = away.send("football", { by: person });
    await Promise.resolve();
    away.stop();
    shown();
    // What was under way finishes; nothing queued behind it touches the controller the window took with it.
    expect((await first).ok).toBe(true);
    expect(await second).toMatchObject({ ok: false, refusal: "failed" });
    expect(await sent).toMatchObject({ ok: false, refusal: "failed" });
    await due;
    expect(host.putGroupBack).toHaveBeenCalledTimes(1);
    expect(host.takeGroupAway).toHaveBeenCalledTimes(3);
    expect(here.has("recipes")).toBe(false);
    expect(here.has("trip")).toBe(false);
    // The file still holds both: the next window's clock brings back what is due.
    expect(new AwayStore(dir).all().map((space) => space.id)).toEqual(["recipes", "trip"]);
    expect(changes.filter((change) => change.event === "returned").map((change) => change.space.id)).toEqual(["football"]);
    expect(time.pending).toEqual([]);
  });
});

describe("the file", () => {
  it("reads nothing from a file that is not one, and starts clean", () => {
    const dir = folder();
    writeFileSync(join(dir, "away-spaces.json"), "{ not json");
    expect(new AwayStore(dir).all()).toEqual([]);
  });
});

describe("a space on its way", () => {
  it("is `moving` from the moment its tabs leave the session until the file holds it — and again on its way back", async () => {
    const { away, host, store } = service();
    const seen: Array<{ step: string; moving: boolean; filed: boolean }> = [];
    const take = host.takeGroupAway.getMockImplementation()!;
    host.takeGroupAway.mockImplementation(async (id, options) => {
      const taken = await take(id, options);
      // (The tabs are gone from the session; the file does not have the space yet: this is the gap.)
      seen.push({ step: "taken", moving: away.moving("football"), filed: store.get("football") !== null });
      return taken;
    });
    const put = host.putGroupBack.getMockImplementation()!;
    host.putGroupBack.mockImplementation((spaceId, session) => {
      const group = put(spaceId, session);
      // (The tabs are in the session again; the file has not let go yet.)
      seen.push({ step: "put", moving: away.moving("football"), filed: store.get("football") !== null });
      return group;
    });
    expect(away.moving("football")).toBe(false);
    await away.send("football", { by: person });
    expect(away.moving("football")).toBe(false);
    await away.bringBack("football");
    expect(away.moving("football")).toBe(false);
    expect(seen).toEqual([
      { step: "taken", moving: true, filed: false },
      { step: "put", moving: true, filed: true },
    ]);
  });

  it("is not left `moving` by a send that was refused or failed", async () => {
    const { away, state, host } = service();
    state.block = "live";
    await away.send("football", { by: person });
    expect(away.moving("football")).toBe(false);
    state.block = null;
    host.takeGroupAway.mockImplementationOnce(async () => {
      throw new Error("the window closed");
    });
    await expect(away.send("football", { by: person })).rejects.toThrow("the window closed");
    expect(away.moving("football")).toBe(false);
  });

  it("counts its moves, so whoever looked before can ask whether a space moved since — at a launch too", async () => {
    const { away } = service({ spaces: { football: ["espn"], work: ["mail"] } });
    const before = away.moves();
    expect(away.movedSince("football", before)).toBe(false);
    await away.send("football", { by: person });
    expect(away.movedSince("football", before)).toBe(true);
    expect(away.movedSince("work", before)).toBe(false);
    const sent = away.moves();
    expect(away.movedSince("football", sent)).toBe(false);
    // Back by the clock with nobody having looked while it was away: still a move, never its tabs opening.
    await away.bringBack("football");
    expect(away.movedSince("football", sent)).toBe(true);
  });

  it("counts a send that was refused nothing, and one that failed after taking the space as a move", async () => {
    const { away, state, store } = service();
    const before = away.moves();
    state.block = "live";
    await away.send("football", { by: person });
    expect(away.movedSince("football", before)).toBe(false);
    // Taken, the file could not be written, put straight back: its tabs left and returned.
    state.block = null;
    vi.spyOn(store, "add").mockReturnValueOnce(false);
    const outcome = await away.send("football", { by: person });
    expect(outcome.ok).toBe(false);
    expect(away.movedSince("football", before)).toBe(true);
  });
});
