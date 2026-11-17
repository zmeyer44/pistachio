/**
 * Intervals and signals (docs/primitives.md §3.6): what main reads of the Mac and the person's day as something
 * that holds or does not (../src/main/extensions/signals.ts), an interval's marks and a signal against the clock
 * (./triggers.ts), and the runner delivering both (./trigger-runner.ts) — one mark however long the lid was shut,
 * nothing for a signal main cannot read.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtTriggerState } from "@pistachio/extension-api";
import { triggerKey, type TriggerDecl, type TriggerWhen } from "@pistachio/extension-api/triggers";
import { AutomationStore } from "../src/main/extensions/automation";
import {
  CALENDAR_AHEAD_MS,
  CALENDAR_CONNECT,
  CALENDAR_EVENTS_MAX,
  CALENDAR_RECONNECT,
  CALENDAR_REFRESH_MS,
  CALENDAR_RETRY_MS,
  CALENDAR_UNREACHABLE,
  CalendarKeeper,
  IDLE_RETURN_LOOK_MS,
  NO_READINGS,
  calendarAnswer,
  calendarEvent,
  signalHolds,
  signalLookAt,
  signalNeeds,
  type CalendarAnswer,
  type SignalReadings,
} from "../src/main/extensions/signals";
import { TriggerRunner, type TriggerSubject } from "../src/main/extensions/trigger-runner";
import { ANSWER_NONE, ANSWER_UNKNOWN, intervalMarks, projectTrigger, readTrigger, triggerAnswer, triggerLookAt, triggerState, triggerStatus } from "../src/main/extensions/triggers";
import { EXTENSION_ID } from "./extensions-harness";

const NY = "America/New_York";
/** The mark an interval's state names (null for any other kind, and for an interval that is not running). */
const markOf = (state: ExtTriggerState): number | null => (state.kind === "every" ? state.at : null);
/** An instant by New York's wall clock in November 2026 (EST, UTC−5): the 15th is a Sunday, the 16th a Monday. */
const ny = (day: number, hour: number, minute = 0): number => Date.UTC(2026, 10, day, hour + 5, minute);
const readings = (patch: Partial<SignalReadings> = {}): SignalReadings => ({ ...NO_READINGS, ...patch });
const SUNDAY: TriggerDecl = { id: "sunday", during: { days: ["sun"], from: "08:00", to: "23:00" } };
const SCORES: TriggerDecl = { id: "scores", every: { minutes: 5, while: "sunday" } };
const STANDUP: TriggerDecl = { id: "standup", when: { calendar: { title: "stand-up" } } };
/** Monday's stand-up, 9:30 to 9:45, read at 9:00. */
const monday = (events = [{ title: "Team Stand-Up", start: ny(16, 9, 30), end: ny(16, 9, 45) }]): SignalReadings => readings({ calendar: { from: ny(16, 9), to: ny(16, 9) + CALENDAR_AHEAD_MS, events } });

describe("a signal, read", () => {
  it("holds or does not for power, the network, a display and idle — by what was read", () => {
    expect(signalHolds({ power: "battery" }, readings({ battery: true }), 0)).toBe(true);
    expect(signalHolds({ power: "battery" }, readings({ battery: false }), 0)).toBe(false);
    expect(signalHolds({ power: "plugged" }, readings({ battery: false }), 0)).toBe(true);
    expect(signalHolds({ network: "offline" }, readings({ online: false }), 0)).toBe(true);
    expect(signalHolds({ network: "online" }, readings({ online: false }), 0)).toBe(false);
    expect(signalHolds({ display: "external" }, readings({ displays: 2 }), 0)).toBe(true);
    expect(signalHolds({ display: "external" }, readings({ displays: 1 }), 0)).toBe(false);
    expect(signalHolds({ idle: { minutes: 10 } }, readings({ idleSeconds: 600 }), 0)).toBe(true);
    expect(signalHolds({ idle: { minutes: 10 } }, readings({ idleSeconds: 599 }), 0)).toBe(false);
  });

  it("is not known — neither on nor off — when main could not read it", () => {
    const all: TriggerWhen[] = [{ power: "battery" }, { network: "offline" }, { display: "external" }, { idle: { minutes: 1 } }, { calendar: { title: "stand-up" } }];
    for (const when of all) expect(signalHolds(when, NO_READINGS, ny(16, 9)), JSON.stringify(when)).toBeNull();
  });

  it("holds while an event with the phrase in its name is on, in any case, and not for another", () => {
    const when: TriggerWhen = { calendar: { title: "stand-up" } };
    expect(signalHolds(when, monday(), ny(16, 9, 29))).toBe(false);
    expect(signalHolds(when, monday(), ny(16, 9, 30))).toBe(true);
    expect(signalHolds(when, monday(), ny(16, 9, 44))).toBe(true);
    expect(signalHolds(when, monday(), ny(16, 9, 45))).toBe(false);
    expect(signalHolds({ calendar: { title: "review" } }, monday(), ny(16, 9, 35))).toBe(false);
  });

  it("holds for the minutes before an event its `early` names", () => {
    const when: TriggerWhen = { calendar: { title: "stand-up", early: 5 } };
    expect(signalHolds(when, monday(), ny(16, 9, 24))).toBe(false);
    expect(signalHolds(when, monday(), ny(16, 9, 25))).toBe(true);
  });

  it("says nothing of the calendar outside the stretch it was read for, and what would let it be read", () => {
    const when: TriggerWhen = { calendar: { title: "stand-up" } };
    expect(signalHolds(when, monday(), ny(16, 8, 59))).toBeNull();
    expect(signalHolds(when, monday(), ny(17, 9))).toBeNull();
    expect(signalNeeds(when, readings({ calendarNeeds: CALENDAR_CONNECT }), ny(16, 9))).toBe(CALENDAR_CONNECT);
    expect(signalNeeds(when, monday(), ny(16, 9, 10))).toBeNull();
    expect(signalNeeds({ power: "battery" }, readings({ calendarNeeds: CALENDAR_CONNECT }), 0)).toBeNull();
  });

  it("knows when to look again: an event's next edge, the moment idle is long enough, and soon once it is", () => {
    expect(signalLookAt({ calendar: { title: "stand-up" } }, monday(), ny(16, 9, 10))).toBe(ny(16, 9, 30));
    expect(signalLookAt({ calendar: { title: "stand-up", early: 5 } }, monday(), ny(16, 9, 10))).toBe(ny(16, 9, 25));
    expect(signalLookAt({ calendar: { title: "stand-up" } }, monday(), ny(16, 9, 31))).toBe(ny(16, 9, 45));
    expect(signalLookAt({ calendar: { title: "stand-up" } }, monday(), ny(16, 10))).toBeNull();
    expect(signalLookAt({ idle: { minutes: 10 } }, readings({ idleSeconds: 540 }), 1_000)).toBe(61_000);
    expect(signalLookAt({ idle: { minutes: 10 } }, readings({ idleSeconds: 900 }), 1_000)).toBe(1_000 + IDLE_RETURN_LOOK_MS);
    expect(signalLookAt({ power: "battery" }, readings({ battery: true }), 1_000)).toBeNull();
  });
});

describe("the calendar, as a signal reads it", () => {
  it("reads an event's instants, and an all-day event as midnight to midnight on the Mac's clock", () => {
    expect(calendarEvent({ title: "Stand-up", start: "2026-11-16T14:30:00Z", end: "2026-11-16T14:45:00Z", allDay: false })).toEqual({ title: "Stand-up", start: Date.UTC(2026, 10, 16, 14, 30), end: Date.UTC(2026, 10, 16, 14, 45) });
    expect(calendarEvent({ title: "Offsite", start: "2026-11-16", end: "2026-11-18", allDay: true })).toEqual({ title: "Offsite", start: new Date(2026, 10, 16).getTime(), end: new Date(2026, 10, 18).getTime() });
    expect(calendarEvent({ title: "Broken", start: "soon", end: "later", allDay: false })).toBeNull();
    expect(calendarEvent({ title: "Backwards", start: "2026-11-16T15:00:00Z", end: "2026-11-16T14:00:00Z", allDay: false })).toBeNull();
  });

  it("reads a Profile's agenda as an answer: its events, off with what would connect one, blocked, or unreachable", () => {
    const event = { title: "Stand-up", start: "2026-11-16T14:30:00Z", end: "2026-11-16T14:45:00Z", allDay: false };
    expect(calendarAnswer({ status: "ok", events: [event, { ...event, start: "never" }] })).toEqual({ status: "ok", events: [{ title: "Stand-up", start: Date.UTC(2026, 10, 16, 14, 30), end: Date.UTC(2026, 10, 16, 14, 45) }] });
    expect(calendarAnswer({ status: "not_connected", events: [] })).toEqual({ status: "off", needs: CALENDAR_CONNECT });
    // A grant that died is a calendar that is there and cannot be read: never "no calendar here".
    expect(calendarAnswer({ status: "reconnect_required", events: [] })).toEqual({ status: "blocked", needs: CALENDAR_RECONNECT });
    expect(calendarAnswer({ status: "unreachable", events: [] })).toEqual({ status: "unreachable" });
    expect(calendarAnswer(null)).toEqual({ status: "unreachable" });
  });

  it("does not take a day read only in part for the day: one calendar's events missing is as unreachable as all of them", () => {
    const event = { title: "Lunch", start: "2026-11-16T17:00:00Z", end: "2026-11-16T18:00:00Z", allDay: false };
    // (The stand-up is on the shared calendar whose read failed: "no stand-up" is not something this says.)
    expect(calendarAnswer({ status: "ok", partial: true, events: [event] })).toEqual({ status: "unreachable" });
  });

  const WORK = "profile-work";
  const HOME = "profile-home";
  function keeperOf(first: CalendarAnswer, wanted: string[] = [WORK]) {
    const state = { now: ny(16, 9), answers: { [WORK]: first } as Record<string, CalendarAnswer | Error>, wanted, reads: [] as [string, number, number][], changed: 0 };
    const keeper = new CalendarKeeper({
      read: async (profileId, from, to) => {
        state.reads.push([profileId, from, to]);
        const answer = state.answers[profileId] ?? { status: "off", needs: CALENDAR_CONNECT };
        if (answer instanceof Error) throw answer;
        return answer;
      },
      wanted: () => state.wanted,
      changed: () => {
        state.changed += 1;
      },
      now: () => state.now,
      pace: () => state.now,
    });
    /** One look, and whatever reads it started answered. */
    const look = async (profiles: string[] = [WORK]) => {
      keeper.current(profiles);
      await new Promise((resolve) => setImmediate(resolve));
      return keeper.current(profiles);
    };
    return { keeper, state, look };
  }
  const STANDUP_EVENT = { title: "Stand-up", start: ny(16, 9, 30), end: ny(16, 9, 45) };
  const LUNCH = { title: "Lunch", start: ny(16, 12), end: ny(16, 13) };

  it("is not known — never off — while a Profile's grant has died, whatever another Profile's calendar says", async () => {
    const { state, look } = keeperOf({ status: "ok", events: [STANDUP_EVENT] }, [WORK, HOME]);
    state.answers[HOME] = { status: "ok", events: [LUNCH] };
    expect((await look([WORK, HOME])).calendar?.events).toEqual([STANDUP_EVENT, LUNCH]);
    // Mid-meeting, Work's grant dies: what was read of it is let go, and the whole is not known, with what to do.
    state.answers[WORK] = { status: "blocked", needs: CALENDAR_RECONNECT };
    state.now += CALENDAR_REFRESH_MS;
    expect(await look([WORK, HOME])).toEqual({ calendar: null, calendarNeeds: CALENDAR_RECONNECT });
    // (Home alone is still Home's own to read: an extension on only there hears of it.)
    expect((await look([HOME])).calendar?.events).toEqual([LUNCH]);
    // Reconnected, it is read again.
    state.answers[WORK] = { status: "ok", events: [STANDUP_EVENT] };
    state.now += CALENDAR_REFRESH_MS;
    expect((await look([WORK, HOME])).calendar?.events).toEqual([STANDUP_EVENT, LUNCH]);
  });

  it("keeps a whole reading whole: a meeting far down a long day's list is still on", async () => {
    // Eight calendars of fifty events each is the most one read gives (integration-service): none of it may be dropped.
    const filler = Array.from({ length: 399 }, (_, index) => ({ title: `Block ${String(index)}`, start: ny(16, 9) + index * 60_000, end: ny(16, 9) + (index + 1) * 60_000 }));
    const { state, look } = keeperOf({ status: "ok", events: [...filler, STANDUP_EVENT] });
    state.answers[HOME] = { status: "ok", events: [...filler, LUNCH] };
    state.wanted = [WORK, HOME];
    const one = (await look()).calendar;
    expect(one?.events).toHaveLength(400);
    expect(one?.events.at(-1)).toEqual(STANDUP_EVENT);
    // Two Profiles' days as one: both whole.
    const both = (await look([WORK, HOME])).calendar;
    expect(both?.events).toHaveLength(800);
    expect(both?.events.filter((event) => event.title === "Stand-up" || event.title === "Lunch")).toEqual([STANDUP_EVENT, LUNCH]);
  });

  it("keeps an event's name whole: a phrase far along a long name is still in it", async () => {
    // (Cut at any length, the name would not hold the phrase past the cut: the meeting would read as not on.)
    const long = { title: `${"Quarterly planning, budgets and hiring — ".repeat(8)}then the stand-up`, start: ny(16, 9, 30), end: ny(16, 9, 45) };
    expect(long.title.length).toBeGreaterThan(300);
    const { look } = keeperOf({ status: "ok", events: [long] });
    const calendar = (await look()).calendar;
    expect(calendar?.events[0]?.title).toBe(long.title);
    expect(signalHolds({ calendar: { title: "stand-up" } }, readings({ calendar: calendar! }), ny(16, 9, 31))).toBe(true);
  });

  it("does not take a reading too long to keep for the day: it is not known, never the first part of it", async () => {
    const many = Array.from({ length: CALENDAR_EVENTS_MAX + 1 }, (_, index) => ({ title: `Block ${String(index)}`, start: ny(16, 9), end: ny(16, 10) }));
    const { state, look } = keeperOf({ status: "ok", events: many });
    expect(await look()).toEqual({ calendar: null, calendarNeeds: CALENDAR_UNREACHABLE });
    // (What was read whole before stands until it runs out, as it does when a read cannot be made.)
    state.answers[WORK] = { status: "ok", events: [STANDUP_EVENT] };
    state.now += CALENDAR_REFRESH_MS;
    expect((await look()).calendar?.events).toEqual([STANDUP_EVENT]);
    state.answers[WORK] = { status: "ok", events: many };
    state.now += CALENDAR_REFRESH_MS;
    expect((await look()).calendar?.events).toEqual([STANDUP_EVENT]);
  });

  it("tries a read that could not be made again soon, not a whole refresh later", async () => {
    const { state, look } = keeperOf({ status: "unreachable" });
    expect(await look()).toEqual({ calendar: null, calendarNeeds: CALENDAR_UNREACHABLE });
    expect(state.reads).toHaveLength(1);
    // (A Mac wakes without its network, and has it back in seconds.)
    state.answers[WORK] = { status: "ok", events: [STANDUP_EVENT] };
    state.now += CALENDAR_RETRY_MS - 1;
    await look();
    expect(state.reads).toHaveLength(1);
    state.now += 1;
    expect((await look()).calendar?.events).toEqual([STANDUP_EVENT]);
    expect(state.reads).toHaveLength(2);
    // Read, it is paced as any reading is.
    state.now += CALENDAR_RETRY_MS;
    await look();
    expect(state.reads).toHaveLength(2);
  });

  it("asks a calendar that keeps failing less and less often, up to a refresh — and at the usual pace once it answers", async () => {
    const { state, look } = keeperOf({ status: "unreachable" });
    await look();
    // Half a minute, then a minute, then two, then four — never more often than that, never rarer than a refresh.
    const waits: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const before = state.reads.length;
      let waited = 0;
      while (state.reads.length === before) {
        state.now += CALENDAR_RETRY_MS / 2;
        waited += CALENDAR_RETRY_MS / 2;
        await look();
      }
      waits.push(waited);
    }
    expect(waits).toEqual([CALENDAR_RETRY_MS, 2 * CALENDAR_RETRY_MS, 4 * CALENDAR_RETRY_MS, 8 * CALENDAR_RETRY_MS, CALENDAR_REFRESH_MS, CALENDAR_REFRESH_MS]);
    state.answers[WORK] = { status: "ok", events: [STANDUP_EVENT] };
    state.now += CALENDAR_REFRESH_MS;
    expect((await look()).calendar?.events).toEqual([STANDUP_EVENT]);
    // One failure after that is the first again.
    state.answers[WORK] = { status: "unreachable" };
    state.now += CALENDAR_REFRESH_MS;
    await look();
    const reads = state.reads.length;
    state.now += CALENDAR_RETRY_MS;
    await look();
    expect(state.reads).toHaveLength(reads + 1);
  });

  it("answers at once with what it knows, reads behind the look, and says when that is news", async () => {
    const { keeper, state, look } = keeperOf({ status: "ok", events: [STANDUP_EVENT] });
    expect(keeper.current([WORK])).toEqual({ calendar: null, calendarNeeds: null });
    expect(await look()).toEqual({ calendar: { from: ny(16, 9), to: ny(16, 9) + CALENDAR_AHEAD_MS, events: [STANDUP_EVENT] }, calendarNeeds: null });
    expect(state.reads).toEqual([[WORK, ny(16, 9), ny(16, 9) + CALENDAR_AHEAD_MS]]);
    expect(state.changed).toBe(1);
  });

  it("reads again only when the last reading is old, and tells the clock only of a change", async () => {
    const { state, look } = keeperOf({ status: "ok", events: [STANDUP_EVENT] });
    await look();
    state.now += CALENDAR_REFRESH_MS - 1;
    await look();
    expect(state.reads).toHaveLength(1);
    state.now += 1;
    await look();
    expect(state.reads).toHaveLength(2);
    expect(state.changed).toBe(1);
    state.now += CALENDAR_REFRESH_MS;
    state.answers[WORK] = { status: "ok", events: [] };
    expect((await look()).calendar?.events).toEqual([]);
    expect(state.changed).toBe(2);
  });

  it("reads only the Profiles something that may run asks of, and none while nothing does", async () => {
    const idle = keeperOf({ status: "ok", events: [] }, []);
    expect(await idle.look()).toEqual({ calendar: null, calendarNeeds: null });
    expect(idle.state.reads).toEqual([]);
    const work = keeperOf({ status: "ok", events: [STANDUP_EVENT] }, [WORK, WORK]);
    work.state.answers[HOME] = { status: "ok", events: [LUNCH] };
    await work.look();
    expect(work.state.reads.map(([profileId]) => profileId)).toEqual([WORK]);
  });

  it("answers an extension by its own Profiles: another Profile's events are not its to hear of", async () => {
    const { state, look } = keeperOf({ status: "ok", events: [STANDUP_EVENT] }, [WORK, HOME]);
    state.answers[HOME] = { status: "ok", events: [LUNCH] };
    expect((await look([HOME])).calendar?.events).toEqual([LUNCH]);
    expect((await look([WORK])).calendar?.events).toEqual([STANDUP_EVENT]);
    expect((await look([WORK, HOME])).calendar?.events).toEqual([STANDUP_EVENT, LUNCH]);
  });

  it("leaves out a Profile with no calendar, is not known while one of them could not be read, and is off when none is connected", async () => {
    const { state, look } = keeperOf({ status: "ok", events: [STANDUP_EVENT] }, [WORK, HOME]);
    // Home has no calendar connected: Work's is the whole of it.
    expect((await look([WORK, HOME])).calendar?.events).toEqual([STANDUP_EVENT]);
    expect(await look([HOME])).toEqual({ calendar: null, calendarNeeds: CALENDAR_CONNECT });
    expect(await look([])).toEqual({ calendar: null, calendarNeeds: CALENDAR_CONNECT });
    // A Profile never read, or one that cannot be reached with nothing kept, makes the whole not known.
    expect(await look([WORK, "profile-new"])).toEqual({ calendar: null, calendarNeeds: null });
    const down = keeperOf(new Error("offline") as never, [WORK, HOME]);
    down.state.answers[HOME] = { status: "ok", events: [LUNCH] };
    expect(await down.look([WORK, HOME])).toEqual({ calendar: null, calendarNeeds: CALENDAR_UNREACHABLE });
    state.answers[HOME] = { status: "off", needs: CALENDAR_RECONNECT };
    state.answers[WORK] = { status: "off", needs: CALENDAR_CONNECT };
    state.now += CALENDAR_REFRESH_MS;
    expect(await look([WORK, HOME])).toEqual({ calendar: null, calendarNeeds: CALENDAR_RECONNECT });
  });

  it("keeps what it knew through a read that could not be made, until that runs out", async () => {
    const { state, look } = keeperOf({ status: "ok", events: [STANDUP_EVENT] });
    await look();
    state.answers[WORK] = new Error("offline");
    state.now += CALENDAR_REFRESH_MS;
    expect((await look()).calendar?.events).toEqual([STANDUP_EVENT]);
    state.now = ny(16, 9) + CALENDAR_AHEAD_MS;
    expect(await look()).toEqual({ calendar: null, calendarNeeds: CALENDAR_UNREACHABLE });
  });

  it("drops what it knew the moment nothing is connected, and says what would connect one", async () => {
    const { state, look } = keeperOf({ status: "ok", events: [STANDUP_EVENT] });
    await look();
    state.answers[WORK] = { status: "off", needs: CALENDAR_CONNECT };
    state.now += CALENDAR_REFRESH_MS;
    expect(await look()).toEqual({ calendar: null, calendarNeeds: CALENDAR_CONNECT });
    expect(state.changed).toBe(2);
  });

  it("forgets on demand, and reads afresh at the next look", async () => {
    const { keeper, state, look } = keeperOf({ status: "ok", events: [STANDUP_EVENT] });
    await look();
    keeper.forget();
    state.answers[WORK] = { status: "ok", events: [] };
    expect((await look()).calendar?.events).toEqual([]);
    expect(state.reads).toHaveLength(2);
  });
});

describe("an interval and a signal against the clock", () => {
  it("names an interval's latest mark and the next, on the clock's own marks", () => {
    const hourly: TriggerDecl = { id: "hourly", every: { minutes: 60 } };
    expect(triggerState(hourly, ny(16, 9, 42), NY)).toEqual({ id: "hourly", kind: "every", at: ny(16, 9), next: ny(16, 10) });
    const five: TriggerDecl = { id: "five", every: { minutes: 5 } };
    expect(triggerState(five, ny(16, 9, 42) + 30_000, NY)).toEqual({ id: "five", kind: "every", at: ny(16, 9, 40), next: ny(16, 9, 45) });
    expect(triggerAnswer(triggerState(five, ny(16, 9, 42), NY))).toBe(`every:${String(ny(16, 9, 40))}`);
  });

  it("runs an interval only while the window its `while` names is on, and says the first mark it will hear", () => {
    const world = { triggers: [SUNDAY, SCORES] };
    expect(triggerState(SCORES, ny(14, 12), NY, world)).toEqual({ id: "scores", kind: "every", at: null, next: ny(15, 8, 5) });
    expect(triggerState(SCORES, ny(15, 8, 7), NY, world)).toEqual({ id: "scores", kind: "every", at: ny(15, 8, 5), next: ny(15, 8, 10) });
    // (No mark at or past the window's end.)
    expect(triggerState(SCORES, ny(15, 22, 56), NY, world)).toEqual({ id: "scores", kind: "every", at: ny(15, 22, 55), next: null });
    expect(markOf(triggerState(SCORES, ny(15, 23), NY, world))).toBeNull();
    expect(triggerAnswer(triggerState(SCORES, ny(14, 12), NY, world))).toBe(ANSWER_NONE);
    // (Without the manifest beside it, what it runs while cannot be found: it does not run.)
    expect(markOf(triggerState(SCORES, ny(15, 9), NY))).toBeNull();
  });

  it("runs an interval while a signal holds, and not while it does not or is not known", () => {
    const save: TriggerDecl = { id: "save", every: { minutes: 10, while: "unplugged" } };
    const triggers: TriggerDecl[] = [{ id: "unplugged", when: { power: "battery" } }, save];
    expect(triggerState(save, ny(16, 9, 42), NY, { triggers, readings: readings({ battery: true }) })).toEqual({ id: "save", kind: "every", at: ny(16, 9, 40), next: ny(16, 9, 50) });
    expect(markOf(triggerState(save, ny(16, 9, 42), NY, { triggers, readings: readings({ battery: false }) }))).toBeNull();
    expect(markOf(triggerState(save, ny(16, 9, 42), NY, { triggers }))).toBeNull();
  });

  it("says whether a signal holds, and that it is not known when main cannot tell", () => {
    expect(triggerState(STANDUP, ny(16, 9, 31), NY, { readings: monday() })).toEqual({ id: "standup", kind: "when", holds: true, known: true });
    expect(triggerState(STANDUP, ny(16, 9, 10), NY, { readings: monday() })).toEqual({ id: "standup", kind: "when", holds: false, known: true });
    expect(triggerState(STANDUP, ny(16, 9, 31), NY)).toEqual({ id: "standup", kind: "when", holds: false, known: false });
    expect(triggerAnswer(triggerState(STANDUP, ny(16, 9, 31), NY, { readings: monday() }))).toBe("on");
    expect(triggerAnswer(triggerState(STANDUP, ny(16, 9, 31), NY))).toBe(ANSWER_UNKNOWN);
  });

  it("looks at a signal again at the tick, or sooner when main can see the change coming", () => {
    const world = { readings: monday() };
    expect(triggerLookAt(STANDUP, triggerState(STANDUP, ny(16, 9, 29), NY, world), ny(16, 9, 29) + 50_000, 30_000, world)).toBe(ny(16, 9, 30));
    expect(triggerLookAt(STANDUP, triggerState(STANDUP, ny(16, 9), NY, world), ny(16, 9), 30_000, world)).toBe(ny(16, 9) + 30_000);
    const battery: TriggerDecl = { id: "unplugged", when: { power: "battery" } };
    expect(triggerLookAt(battery, triggerState(battery, 0, NY), 1_000, 30_000)).toBe(31_000);
  });

  it("tells the status file an interval's next marks, a signal's state, and what a signal main cannot read needs", () => {
    const scores = triggerStatus(SCORES, ny(15, 8, 7), NY, { triggers: [SUNDAY, SCORES] });
    expect(scores.says).toBe("Every 5 minutes, Sundays 8:00 AM–11:00 PM");
    expect(scores.next.map((change) => change.at)).toEqual(["Sun, Nov 15, 8:10 AM", "Sun, Nov 15, 8:15 AM", "Sun, Nov 15, 8:20 AM"]);
    const before = triggerStatus(SCORES, ny(14, 12), NY, { triggers: [SUNDAY, SCORES] });
    expect(before.next[0]?.at).toBe("Sun, Nov 15, 8:05 AM");
    expect(triggerStatus(STANDUP, ny(16, 9, 31), NY, { readings: monday() })).toEqual({ id: "standup", says: "While a calendar event with “stand-up” in its name is on", zone: NY, holds: true, next: [] });
    expect(triggerStatus(STANDUP, ny(16, 9, 31), NY, { readings: readings({ calendarNeeds: CALENDAR_CONNECT }) })).toEqual({ id: "standup", says: "While a calendar event with “stand-up” in its name is on", zone: NY, needs: CALENDAR_CONNECT, next: [] });
  });
});

/* -------------------------------- the runner -------------------------------- */

function runnerOf(options: { triggers: TriggerDecl[]; at?: number; readings?: SignalReadings }) {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-signals-"));
  const store = new AutomationStore(dir);
  const state = { now: options.at ?? ny(14, 12), fail: null as string | null, readings: options.readings ?? NO_READINGS, subjects: [{ id: EXTENSION_ID, triggers: options.triggers }] as TriggerSubject[] };
  const delivered: ExtTriggerState[] = [];
  const timers: { ms: number }[] = [];
  const make = (): TriggerRunner =>
    new TriggerRunner({
      subjects: () => state.subjects,
      deliver: async (_id, trigger) => {
        if (state.fail !== null) throw new Error(state.fail);
        delivered.push(trigger);
      },
      store,
      zone: () => NY,
      readings: () => state.readings,
      now: () => state.now,
      timers: { setTimeout: (_callback, ms) => timers.push({ ms }), clearTimeout: () => undefined },
    });
  const runner = make();
  const at = async (now: number): Promise<void> => {
    state.now = now;
    await runner.tick();
  };
  return { runner, make, store, state, delivered, timers, at, heard: (id: string) => delivered.filter((entry) => entry.id === id) };
}

describe("a look under way while the extension changes", () => {
  const MORNING: TriggerDecl = { id: "morning", during: { from: "08:00", to: "12:00" } };
  const LATER: TriggerDecl = { id: "later", during: { from: "08:30", to: "13:00" } };

  /** A runner whose first delivery ("morning") is the moment the extension is changed. */
  function changing(change: (state: { subjects: TriggerSubject[] }) => void) {
    const store = new AutomationStore(mkdtempSync(join(tmpdir(), "pistachio-signals-")));
    const state = { subjects: [{ id: EXTENSION_ID, triggers: [MORNING, LATER] }] as TriggerSubject[] };
    const delivered: string[] = [];
    const runner = new TriggerRunner({
      subjects: () => state.subjects,
      deliver: async (_id, trigger) => {
        delivered.push(trigger.id);
        // (Its handler runs for a while; meanwhile the folder is saved, the extension reloaded.)
        if (trigger.id === "morning") change(state);
        await Promise.resolve();
      },
      store,
      zone: () => NY,
      now: () => ny(15, 9),
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    return { runner, state, delivered, store };
  }

  it("does not run a trigger taken out of the manifest while an earlier handler ran", async () => {
    const { runner, delivered, store } = changing((state) => {
      state.subjects = [{ id: EXTENSION_ID, triggers: [MORNING] }];
    });
    await runner.start();
    expect(delivered).toEqual(["morning"]);
    expect(store.delivered(EXTENSION_ID, "later")).toBeNull();
  });

  it("does not run one at times since changed, nor anything of an extension since turned off — the next look reads what is there", async () => {
    const changed = changing((state) => {
      state.subjects = [{ id: EXTENSION_ID, triggers: [MORNING, { id: "later", during: { from: "10:00", to: "13:00" } }] }];
    });
    await changed.runner.start();
    expect(changed.delivered).toEqual(["morning"]);
    // The next look hears the trigger as it is now declared.
    await changed.runner.tick();
    expect(changed.delivered).toEqual(["morning", "later"]);

    const off = changing((state) => {
      state.subjects = [];
    });
    await off.runner.start();
    expect(off.delivered).toEqual(["morning"]);
  });
});

describe("a trigger that failed, let run again", () => {
  it("is tried at once when its extension is let run again, or everything is: a pause lifted does not wait out the retry", async () => {
    const { runner, state, delivered, at } = runnerOf({ triggers: [SUNDAY], at: ny(15, 9) });
    // Its handler fails (the space it would send was in front): not heard, and due again a minute on.
    state.fail = "That space is in front.";
    await runner.start();
    expect(delivered).toEqual([]);
    // What stopped it has passed — and the same moment is not yet the retry's.
    state.fail = null;
    await at(ny(15, 9));
    expect(delivered).toEqual([]);
    // Pause all, then Resume: everything is tried afresh, as one extension is when its own pause is lifted.
    runner.forgiveAll();
    await at(ny(15, 9));
    expect(delivered.map((entry) => entry.id)).toEqual(["sunday"]);

    const one = runnerOf({ triggers: [SUNDAY], at: ny(15, 9) });
    one.state.fail = "That space is in front.";
    await one.runner.start();
    one.state.fail = null;
    one.runner.forgive(EXTENSION_ID);
    await one.at(ny(15, 9));
    expect(one.delivered.map((entry) => entry.id)).toEqual(["sunday"]);
  });
});

describe("the clock, for an interval", () => {
  const HOURLY: TriggerDecl = { id: "hourly", every: { minutes: 60 } };

  it("starts from the mark it is first seen at, and hears each mark after once", async () => {
    const { runner, delivered, at } = runnerOf({ triggers: [HOURLY], at: ny(16, 9, 42) });
    await runner.start();
    expect(delivered).toEqual([]);
    await at(ny(16, 9, 59));
    expect(delivered).toEqual([]);
    await at(ny(16, 10));
    await at(ny(16, 10, 30));
    expect(delivered).toEqual([{ id: "hourly", kind: "every", at: ny(16, 10), next: ny(16, 11) }]);
  });

  it("hears one mark, the latest, for a lid closed across many", async () => {
    const { runner, delivered, at } = runnerOf({ triggers: [HOURLY], at: ny(16, 9, 42) });
    await runner.start();
    await at(ny(16, 15, 20));
    expect(delivered).toEqual([{ id: "hourly", kind: "every", at: ny(16, 15), next: ny(16, 16) }]);
  });

  it("hears the mark that passed while Pistachio was closed, once, after a restart", async () => {
    const first = runnerOf({ triggers: [HOURLY], at: ny(16, 9, 42) });
    await first.runner.start();
    first.runner.stop();
    first.state.now = ny(16, 11, 5);
    const again = first.make();
    await again.start();
    await again.tick();
    expect(first.delivered).toHaveLength(1);
  });

  it("sleeps until its next mark", async () => {
    const { runner, timers } = runnerOf({ triggers: [{ id: "five", every: { minutes: 5 } }], at: ny(16, 9, 44) + 50_000 });
    await runner.start();
    expect(timers.at(-1)?.ms).toBe(10_000);
  });

  it("runs while its window is on: quiet as the window opens, then each mark, and nothing once it has closed", async () => {
    const { runner, heard, at } = runnerOf({ triggers: [SUNDAY, SCORES], at: ny(14, 12) });
    await runner.start();
    await at(ny(15, 8));
    // (The window's own handler says the scores at eight; the interval's first is the mark after.)
    expect(heard("sunday")).toHaveLength(2);
    expect(heard("scores")).toEqual([]);
    await at(ny(15, 8, 5));
    await at(ny(15, 8, 7));
    await at(ny(15, 8, 10));
    expect(heard("scores").map(markOf)).toEqual([ny(15, 8, 5), ny(15, 8, 10)]);
    await at(ny(15, 23));
    await at(ny(15, 23, 5));
    await at(ny(16, 9));
    expect(heard("scores")).toHaveLength(2);
    // Next Sunday it starts quiet again: last week's mark is not this week's news.
    await at(ny(22, 8, 1));
    expect(heard("scores")).toHaveLength(2);
    await at(ny(22, 8, 5));
    expect(heard("scores")).toHaveLength(3);
  });

  it("tries a mark that failed again, and moves on when the next has come", async () => {
    const { runner, state, delivered, at } = runnerOf({ triggers: [HOURLY], at: ny(16, 9, 42) });
    await runner.start();
    state.fail = "the network is down";
    await at(ny(16, 10));
    expect(delivered).toEqual([]);
    state.fail = null;
    await at(ny(16, 10, 0) + 30_000);
    expect(delivered).toEqual([]);
    await at(ny(16, 10, 1));
    expect(delivered.map(markOf)).toEqual([ny(16, 10)]);
  });
});

describe("the clock, for an interval that runs while a signal holds", () => {
  const MINUTE: TriggerDecl = { id: "minute", every: { minutes: 1, while: "standup" } };

  it("is not known while its signal is not — neither stopped nor delivered — and hears one mark for the gap once it is", async () => {
    const { runner, state, heard, store, at } = runnerOf({ triggers: [STANDUP, MINUTE], at: ny(16, 9, 30), readings: monday() });
    await runner.start();
    await at(ny(16, 9, 31));
    expect(heard("minute").map(markOf)).toEqual([ny(16, 9, 31)]);
    // The calendar is unread for a while (a restart, the network): the interval is not stopped by that.
    state.readings = NO_READINGS;
    await at(ny(16, 9, 35));
    expect(heard("minute")).toHaveLength(1);
    expect(store.delivered(EXTENSION_ID, "minute")?.answer).toBe(`every:${String(ny(16, 9, 31))}`);
    expect(readTrigger(MINUTE, ny(16, 9, 35), NY, { triggers: [STANDUP, MINUTE] }).answer).toBe(ANSWER_UNKNOWN);
    state.readings = monday();
    await at(ny(16, 9, 36));
    expect(heard("minute").map(markOf)).toEqual([ny(16, 9, 31), ny(16, 9, 36)]);
    // Known and over, it is stopped: the next meeting starts quiet.
    await at(ny(16, 9, 45));
    await at(ny(16, 9, 46));
    expect(heard("minute")).toHaveLength(2);
    expect(store.delivered(EXTENSION_ID, "minute")?.answer).toBe(ANSWER_NONE);
  });
});

describe("the clock, for a signal", () => {
  const BATTERY: TriggerDecl = { id: "unplugged", when: { power: "battery" } };

  it("says a signal once at first sight, and again each time it changes", async () => {
    const { runner, state, delivered, at } = runnerOf({ triggers: [BATTERY], readings: readings({ battery: false }) });
    await runner.start();
    await runner.tick();
    expect(delivered).toEqual([{ id: "unplugged", kind: "when", holds: false, known: true }]);
    state.readings = readings({ battery: true });
    await at(state.now + 1_000);
    await at(state.now + 1_000);
    state.readings = readings({ battery: false });
    await at(state.now + 1_000);
    expect(delivered.map((entry) => (entry.kind === "when" ? entry.holds : null))).toEqual([false, true, false]);
  });

  it("delivers nothing for a signal main cannot read, and lets what was heard stand until it can", async () => {
    const { runner, state, delivered, store, at } = runnerOf({ triggers: [STANDUP], at: ny(16, 9, 31), readings: monday() });
    await runner.start();
    expect(delivered).toEqual([{ id: "standup", kind: "when", holds: true, known: true }]);
    // The calendar goes away mid-meeting: that is not the meeting ending.
    state.readings = readings({ calendarNeeds: CALENDAR_CONNECT });
    await at(ny(16, 9, 40));
    await at(ny(16, 10));
    expect(delivered).toHaveLength(1);
    expect(store.delivered(EXTENSION_ID, "standup")?.answer).toBe("on");
    // Read again, the meeting is over: now it is said.
    state.readings = monday();
    await at(ny(16, 10, 1));
    expect(delivered.at(-1)).toEqual({ id: "standup", kind: "when", holds: false, known: true });
  });

  it("delivers nothing for a signal never yet read", async () => {
    const { runner, delivered } = runnerOf({ triggers: [STANDUP] });
    await runner.start();
    await runner.tick();
    expect(delivered).toEqual([]);
  });

  it("is looked at again at the tick, and at an event's start when main can see it coming", async () => {
    const battery = runnerOf({ triggers: [BATTERY], readings: readings({ battery: true }) });
    await battery.runner.start();
    expect(battery.timers.at(-1)?.ms).toBe(30_000);
    const standup = runnerOf({ triggers: [STANDUP], at: ny(16, 9, 30) - 4_000, readings: monday() });
    await standup.runner.start();
    expect(standup.timers.at(-1)?.ms).toBe(4_000);
  });

  it("runs an interval while a signal holds, quiet as it begins", async () => {
    const save: TriggerDecl = { id: "save", every: { minutes: 10, while: "unplugged" } };
    const { runner, state, heard, at } = runnerOf({ triggers: [BATTERY, save], at: ny(16, 9, 42), readings: readings({ battery: false }) });
    await runner.start();
    await at(ny(16, 9, 50));
    expect(heard("save")).toEqual([]);
    state.readings = readings({ battery: true });
    await at(ny(16, 9, 51));
    expect(heard("save")).toEqual([]);
    await at(ny(16, 10));
    expect(heard("save")).toHaveLength(1);
    state.readings = readings({ battery: false });
    await at(ny(16, 10, 10));
    expect(heard("save")).toHaveLength(1);
  });
});

describe("an interval's marks, on the wall clock", () => {
  it("are on the hour where the zone is half an hour off, as anywhere", () => {
    // 12:17 PM in Kolkata (UTC+5:30).
    const now = Date.UTC(2026, 10, 16, 6, 47);
    expect(intervalMarks(60, now, "Asia/Kolkata")).toEqual({ at: Date.UTC(2026, 10, 16, 6, 30), next: Date.UTC(2026, 10, 16, 7, 30) });
    expect(intervalMarks(30, now, "Asia/Kolkata")).toEqual({ at: Date.UTC(2026, 10, 16, 6, 30), next: Date.UTC(2026, 10, 16, 7, 0) });
    expect(intervalMarks(5, now, "Asia/Kolkata")).toEqual({ at: Date.UTC(2026, 10, 16, 6, 45), next: Date.UTC(2026, 10, 16, 6, 50) });
    // And in a zone three quarters off (Kathmandu, UTC+5:45): 12:32 PM there.
    expect(intervalMarks(60, now, "Asia/Kathmandu").at).toBe(Date.UTC(2026, 10, 16, 6, 15));
  });

  it("are on the even hours before and after a change of the clocks, and every day is midnight", () => {
    // New York falls back on 1 November 2026: 3:10 PM the day before is EDT (UTC−4), the day after EST (UTC−5).
    // (On the day itself, a rhythm longer than an hour is an hour off its usual hours from the change until midnight:
    // marks are counted in time passed since midnight, so none is skipped and none comes twice.)
    expect(intervalMarks(120, Date.UTC(2026, 10, 1, 15, 0), NY).at).toBe(Date.UTC(2026, 10, 1, 14, 0));
    expect(intervalMarks(120, Date.UTC(2026, 9, 31, 19, 10), NY).at).toBe(Date.UTC(2026, 9, 31, 18, 0));
    expect(intervalMarks(120, Date.UTC(2026, 10, 2, 20, 10), NY).at).toBe(Date.UTC(2026, 10, 2, 19, 0));
    expect(intervalMarks(1440, ny(16, 15, 10), NY)).toEqual({ at: ny(16, 0), next: ny(17, 0) });
    // The day the clocks go back is twenty-five hours long: its midnights are still its only marks, even in its last hour —
    expect(intervalMarks(1440, Date.UTC(2026, 10, 1, 15, 0), NY)).toEqual({ at: Date.UTC(2026, 10, 1, 4, 0), next: Date.UTC(2026, 10, 2, 5, 0) });
    expect(intervalMarks(1440, Date.UTC(2026, 10, 2, 4, 30), NY)).toEqual({ at: Date.UTC(2026, 10, 1, 4, 0), next: Date.UTC(2026, 10, 2, 5, 0) });
    // — while every hour hears its twenty-fifth.
    expect(intervalMarks(60, Date.UTC(2026, 10, 2, 4, 30), NY)).toEqual({ at: Date.UTC(2026, 10, 2, 4, 0), next: Date.UTC(2026, 10, 2, 5, 0) });
  });

  it("starts over at midnight for a rhythm that does not divide the day: the last stretch is the short one", () => {
    expect(intervalMarks(90, ny(16, 23, 50), NY)).toEqual({ at: ny(16, 22, 30), next: ny(17, 0) });
    expect(intervalMarks(90, ny(17, 0, 10), NY)).toEqual({ at: ny(17, 0), next: ny(17, 1, 30) });
  });

  it("promises no mark a window shorter than the rhythm cannot hold", () => {
    const brief: TriggerDecl = { id: "brief", during: { from: "08:10", to: "08:20" } };
    const hourly: TriggerDecl = { id: "hourly", every: { minutes: 60, while: "brief" } };
    const world = { triggers: [brief, hourly] };
    // Off, and the window to come holds no mark of the hour: nothing is next, today or any day.
    expect(triggerState(hourly, ny(16, 7), NY, world)).toEqual({ id: "hourly", kind: "every", at: null, next: null });
    expect(projectTrigger(hourly, ny(16, 7), ny(23, 7), NY, 10, world)).toEqual([]);
    // A window that does hold one says it.
    const morning: TriggerDecl = { id: "brief", during: { from: "08:10", to: "09:20" } };
    expect(triggerState(hourly, ny(16, 7), NY, { triggers: [morning, hourly] })).toEqual({ id: "hourly", kind: "every", at: null, next: ny(16, 9) });
  });
});

describe("the clock, when a retry is due and cannot be made", () => {
  it("looks again at the tick, never at once: a signal not known, or everything paused, is not a quarter-second loop", async () => {
    const t = runnerOf({ triggers: [STANDUP], at: ny(16, 9, 31), readings: monday() });
    t.state.fail = "the space is in front";
    await t.runner.start();
    expect(t.delivered).toEqual([]);
    // The retry comes due while the calendar cannot be read.
    t.state.readings = NO_READINGS;
    await t.at(ny(16, 9, 40));
    expect(t.timers[t.timers.length - 1]?.ms).toBe(30_000);
    // And while every extension is paused.
    t.state.readings = monday();
    t.store.setPausedAll(true);
    await t.at(ny(16, 9, 41));
    expect(t.timers[t.timers.length - 1]?.ms).toBe(30_000);
    // Let run again and known again, the retry is made.
    t.store.setPausedAll(false);
    t.state.fail = null;
    await t.at(ny(16, 9, 42));
    expect(t.heard("standup")).toHaveLength(1);
  });

  it("starts an interval quiet again when it is another interval under the same id", async () => {
    const five: TriggerDecl = { id: "scores", every: { minutes: 5 } };
    const t = runnerOf({ triggers: [five], at: ny(16, 10, 1) });
    await t.runner.start();
    await t.at(ny(16, 10, 6));
    expect(t.heard("scores").map(markOf)).toEqual([ny(16, 10, 5)]);
    // Re-approved as every ten minutes at 10:07: what the five-minute one heard is not this one's (the service's
    // #triggersChanged → keepTriggers), so it does not fire at once for the 10:00 mark it never ran at.
    const ten: TriggerDecl = { id: "scores", every: { minutes: 10 } };
    t.state.subjects = [{ id: EXTENSION_ID, triggers: [ten] }];
    t.store.keepTriggers(EXTENSION_ID, [{ id: "scores", key: triggerKey(ten) }]);
    await t.at(ny(16, 10, 7));
    expect(t.heard("scores")).toHaveLength(1);
    await t.at(ny(16, 10, 11));
    expect(t.heard("scores").map(markOf)).toEqual([ny(16, 10, 5), ny(16, 10, 10)]);
  });
});
