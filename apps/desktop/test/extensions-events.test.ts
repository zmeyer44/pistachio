/**
 * Stage 5b of docs/primitives.md (§3.6, §3.7): the browser's own signals and
 * the locked screen, read; events — what happened, told once, soon and
 * together, or never; a tab opened with nobody there, behind what is in
 * front and written down; and the space in front, which may go when main can
 * see that nobody is at the Mac.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtTriggerState } from "@pistachio/extension-api";
import type { TriggerDecl } from "@pistachio/extension-api/triggers";
import { awayRefused, type AwayHolder, type AwayOutcome, type AwayRefusal, type AwaySpaceInfo } from "@pistachio/shell-contracts/away";
import { AUTOMATION_FILE, AutomationStore } from "../src/main/extensions/automation";
import { dispatch } from "../src/main/extensions/methods";
import { UNATTENDED_TABS_PER_HOUR, journalTabTitle } from "../src/main/extensions/scope";
import { NO_READINGS, signalHolds, signalLookAt, signalNeeds, signalSaysNobody, type SignalReadings } from "../src/main/extensions/signals";
import { ANSWER_EVENT, EVENTS_MAX, TriggerEvents, newlyFinished } from "../src/main/extensions/trigger-events";
import { RUNAWAY_COUNT, RUNAWAY_WINDOW_MS, TriggerRunner, attendedInvocation, staysInHand, staysWoken, stopsWhenSettled, type TriggerSubject } from "../src/main/extensions/trigger-runner";
import { ANSWER_NONE, readTrigger, triggerLookAt, triggerNext, triggerState, triggerStatus } from "../src/main/extensions/triggers";
import { EXTENSION_ID, harness, manifestOf, recordOf, tabOf } from "./extensions-harness";

const NY = "America/New_York";
const NOW = Date.UTC(2026, 10, 16, 15, 0);
const readings = (patch: Partial<SignalReadings> = {}): SignalReadings => ({ ...NO_READINGS, ...patch });
const browser = (urls: string[], extra: { tabs?: number; frontHeld?: boolean } = {}): SignalReadings => readings({ browser: { urls, tabs: extra.tabs ?? urls.length, frontHeld: extra.frontHeld ?? false } });

describe("the browser's own signals, read", () => {
  it("holds a page signal while a tab the extension could see is on such a page", () => {
    const meet = { page: { host: "meet.google.com" } };
    expect(signalHolds(meet, browser(["https://espn.com/", "https://meet.google.com/abc-defg-hij"]), NOW)).toBe(true);
    expect(signalHolds(meet, browser(["https://espn.com/"]), NOW)).toBe(false);
    expect(signalHolds(meet, browser([]), NOW)).toBe(false);
    expect(signalHolds({ page: { host: "docs.google.com", path: "/spreadsheets" } }, browser(["https://docs.google.com/document/d/1"]), NOW)).toBe(false);
  });

  it("holds while a space the person gave it is in front, and while more tabs are open than it names", () => {
    expect(signalHolds({ space: "front" }, browser([], { frontHeld: true }), NOW)).toBe(true);
    expect(signalHolds({ space: "front" }, browser([], { frontHeld: false }), NOW)).toBe(false);
    expect(signalHolds({ tabs: { over: 3 } }, browser([], { tabs: 4 }), NOW)).toBe(true);
    expect(signalHolds({ tabs: { over: 3 } }, browser([], { tabs: 3 }), NOW)).toBe(false);
  });

  it("is not known while no window is up — never off", () => {
    for (const when of [{ page: { host: "meet.google.com" } }, { space: "front" as const }, { tabs: { over: 3 } }]) {
      expect(signalHolds(when, NO_READINGS, NOW), JSON.stringify(when)).toBeNull();
      expect(signalNeeds(when, NO_READINGS, NOW)).toBeNull();
      expect(signalLookAt(when, browser([]), NOW)).toBeNull();
    }
  });

  it("reads the screen: locked, not locked, or not known", () => {
    expect(signalHolds({ screen: "locked" }, readings({ locked: true }), NOW)).toBe(true);
    expect(signalHolds({ screen: "locked" }, readings({ locked: false }), NOW)).toBe(false);
    expect(signalHolds({ screen: "locked" }, NO_READINGS, NOW)).toBeNull();
  });

  it("knows the signals that say nobody is at the Mac: a locked screen and idle, while they hold", () => {
    expect(signalSaysNobody({ screen: "locked" }, readings({ locked: true }), NOW)).toBe(true);
    expect(signalSaysNobody({ screen: "locked" }, readings({ locked: false }), NOW)).toBe(false);
    expect(signalSaysNobody({ idle: { minutes: 10 } }, readings({ idleSeconds: 600 }), NOW)).toBe(true);
    expect(signalSaysNobody({ idle: { minutes: 10 } }, readings({ idleSeconds: 599 }), NOW)).toBe(false);
    expect(signalSaysNobody({ idle: { minutes: 10 } }, NO_READINGS, NOW)).toBe(false);
    // (On battery with the lid shut is not nobody: only what says so.)
    expect(signalSaysNobody({ power: "battery" }, readings({ battery: true }), NOW)).toBe(false);
    expect(signalSaysNobody({ page: { host: "meet.google.com" } }, browser(["https://meet.google.com/x"]), NOW)).toBe(false);
  });

  it("is a trigger like any signal: on, off or not known, looked at on every tick", () => {
    const meet: TriggerDecl = { id: "meet", when: { page: { host: "meet.google.com" } } };
    expect(triggerState(meet, NOW, NY, { readings: browser(["https://meet.google.com/x"]) })).toEqual({ id: "meet", kind: "when", holds: true, known: true });
    expect(triggerState(meet, NOW, NY, { readings: browser([]) })).toEqual({ id: "meet", kind: "when", holds: false, known: true });
    expect(triggerState(meet, NOW, NY)).toEqual({ id: "meet", kind: "when", holds: false, known: false });
    expect(triggerLookAt(meet, triggerState(meet, NOW, NY), NOW, 30_000)).toBe(NOW + 30_000);
    const scores: TriggerDecl = { id: "scores", every: { minutes: 5, while: "meet" } };
    expect(readTrigger(scores, NOW, NY, { triggers: [meet, scores], readings: browser(["https://meet.google.com/x"]) }).answer).toBe(`every:${String(NOW)}`);
    expect(readTrigger(scores, NOW, NY, { triggers: [meet, scores], readings: browser([]) }).answer).toBe(ANSWER_NONE);
  });
});

/* --------------------------------- events --------------------------------- */

const OPENED: TriggerDecl = { id: "opened", on: { tab: "opened" } };
const DONE: TriggerDecl = { id: "done", on: { download: "finished" } };

function eventsOf(options: { triggers?: TriggerDecl[]; gatherMs?: number; spacingMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-events-"));
  const store = new AutomationStore(dir);
  // (A record of the extension's already there, as an approved one has: forgetting it is then a write.)
  store.setPaused(EXTENSION_ID, true);
  store.setPaused(EXTENSION_ID, false);
  const state = { now: NOW, fail: null as string | null, subjects: [{ id: EXTENSION_ID, triggers: options.triggers ?? [OPENED, DONE] }] as TriggerSubject[], hold: null as Promise<void> | null };
  const delivered: ExtTriggerState[] = [];
  const logged: string[] = [];
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const events = new TriggerEvents({
    subjects: () => state.subjects,
    deliver: async (_id, trigger) => {
      delivered.push(trigger);
      if (state.hold !== null) await state.hold;
      if (state.fail !== null) throw new Error(state.fail);
    },
    store,
    now: () => state.now,
    timers: {
      setTimeout: (callback, ms) => {
        const timer = { callback, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    },
    ...(options.gatherMs === undefined ? {} : { gatherMs: options.gatherMs }),
    ...(options.spacingMs === undefined ? {} : { spacingMs: options.spacingMs }),
    log: (_id, _level, message) => logged.push(message),
  });
  /** Run the timers that are armed now (not the ones they arm), then let the handlers settle. */
  const fire = async (): Promise<void> => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback();
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  };
  return { events, store, state, delivered, logged, timers, fire, dir };
}

const eventsIn = (state: ExtTriggerState | undefined): { at: number; tabId?: string }[] => (state?.kind === "on" ? state.events : []);

describe("events: told once, soon and together — or never", () => {
  it("gathers what happens for a moment and hands it over in one run, oldest first", async () => {
    const t = eventsOf();
    t.events.note(EXTENSION_ID, "opened", { at: NOW, tabId: "t1" });
    t.events.note(EXTENSION_ID, "opened", { at: NOW + 5, tabId: "t2" });
    expect(t.delivered).toEqual([]);
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]?.ms).toBe(300);
    await t.fire();
    expect(t.delivered).toEqual([{ id: "opened", kind: "on", events: [{ at: NOW, tabId: "t1" }, { at: NOW + 5, tabId: "t2" }] }]);
    expect(t.store.delivered(EXTENSION_ID, "opened")).toEqual({ answer: ANSWER_EVENT, at: NOW });
  });

  it("keeps the newest twenty when more pile up", async () => {
    const t = eventsOf();
    for (let index = 0; index < EVENTS_MAX + 5; index += 1) t.events.note(EXTENSION_ID, "opened", { at: NOW + index, tabId: `t${String(index)}` });
    await t.fire();
    const handed = eventsIn(t.delivered[0]);
    expect(handed).toHaveLength(EVENTS_MAX);
    expect(handed[0]?.tabId).toBe("t5");
    expect(handed[EVENTS_MAX - 1]?.tabId).toBe(`t${String(EVENTS_MAX + 4)}`);
  });

  it("runs one trigger's handler a few seconds apart at most: what happens meanwhile waits for the next run", async () => {
    const t = eventsOf();
    t.events.note(EXTENSION_ID, "opened", { at: NOW, tabId: "t1" });
    await t.fire();
    t.state.now = NOW + 1_000;
    t.events.note(EXTENSION_ID, "opened", { at: NOW + 1_000, tabId: "t2" });
    expect(t.timers[0]?.ms).toBe(2_000);
    await t.fire();
    expect(t.delivered.map((state) => eventsIn(state).map((event) => event.tabId))).toEqual([["t1"], ["t2"]]);
  });

  it("hands what happened during a run to the next run, never to the one in flight", async () => {
    const t = eventsOf();
    let release = (): void => undefined;
    t.state.hold = new Promise((done) => {
      release = done;
    });
    t.events.note(EXTENSION_ID, "opened", { at: NOW, tabId: "t1" });
    await t.fire();
    t.events.note(EXTENSION_ID, "opened", { at: NOW + 1, tabId: "t2" });
    // (In flight: nothing is armed until it answers.)
    expect(t.timers).toHaveLength(0);
    t.state.hold = null;
    release();
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(t.timers).toHaveLength(1);
    await t.fire();
    expect(t.delivered.map((state) => eventsIn(state).map((event) => event.tabId))).toEqual([["t1"], ["t2"]]);
  });

  it("is not told twice: a handler that fails is logged, and what it was handed is gone", async () => {
    const t = eventsOf();
    t.state.fail = "boom";
    t.events.note(EXTENSION_ID, "opened", { at: NOW, tabId: "t1" });
    await t.fire();
    expect(t.logged[0]).toContain("an event is not told twice");
    expect(t.timers).toHaveLength(0);
    t.state.fail = null;
    t.state.now = NOW + 10_000;
    t.events.note(EXTENSION_ID, "opened", { at: NOW + 10_000, tabId: "t2" });
    await t.fire();
    expect(t.delivered.map((state) => eventsIn(state).map((event) => event.tabId))).toEqual([["t1"], ["t2"]]);
  });

  it("misses what happens while the extension may not run by itself: paused, every extension paused, off, no window", async () => {
    const t = eventsOf();
    t.store.setPaused(EXTENSION_ID, true);
    t.events.note(EXTENSION_ID, "opened", { at: NOW, tabId: "t1" });
    t.store.setPaused(EXTENSION_ID, false);
    t.store.setPausedAll(true);
    t.events.note(EXTENSION_ID, "opened", { at: NOW, tabId: "t2" });
    t.store.setPausedAll(false);
    t.state.subjects = [];
    t.events.note(EXTENSION_ID, "opened", { at: NOW, tabId: "t3" });
    expect(t.timers).toHaveLength(0);
    await t.fire();
    expect(t.delivered).toEqual([]);
  });

  it("misses what was gathered when a pause lands before the run, and what is forgotten", async () => {
    const t = eventsOf();
    t.events.note(EXTENSION_ID, "opened", { at: NOW, tabId: "t1" });
    t.store.setPaused(EXTENSION_ID, true);
    await t.fire();
    expect(t.delivered).toEqual([]);
    t.store.setPaused(EXTENSION_ID, false);
    t.events.note(EXTENSION_ID, "opened", { at: NOW, tabId: "t2" });
    t.events.forget(EXTENSION_ID);
    await t.fire();
    expect(t.delivered).toEqual([]);
    // (Nothing was missed for good: the next thing that happens is told.)
    t.events.note(EXTENSION_ID, "opened", { at: NOW, tabId: "t3" });
    await t.fire();
    expect(t.delivered.map((state) => eventsIn(state).map((event) => event.tabId))).toEqual([["t3"]]);
  });

  it("misses what waited when everything is paused, however soon it is let run again", async () => {
    const t = eventsOf();
    t.events.note(EXTENSION_ID, "opened", { at: NOW, tabId: "t1" });
    // Pause all, and — before the gathered events' moment has come — let them run again: what waited went with the pause.
    t.store.setPausedAll(true);
    t.events.forgetAll();
    t.store.setPausedAll(false);
    await t.fire();
    expect(t.delivered).toEqual([]);
    // One whose handler was running at the pause is told nothing more when it answers.
    let answer = (): void => undefined;
    t.state.hold = new Promise<void>((resolve) => (answer = resolve));
    t.events.note(EXTENSION_ID, "opened", { at: NOW, tabId: "t2" });
    await t.fire();
    t.events.note(EXTENSION_ID, "opened", { at: NOW, tabId: "t3" });
    t.store.setPausedAll(true);
    t.events.forgetAll();
    t.store.setPausedAll(false);
    t.state.hold = null;
    answer();
    await t.fire();
    await t.fire();
    expect(t.delivered.map((state) => eventsIn(state).map((event) => event.tabId))).toEqual([["t2"]]);
    // (Nothing was missed for good: the next thing that happens is told.)
    t.state.now += 10_000;
    t.events.note(EXTENSION_ID, "opened", { at: t.state.now, tabId: "t4" });
    await t.fire();
    expect(t.delivered.map((state) => eventsIn(state).map((event) => event.tabId))).toEqual([["t2"], ["t4"]]);
  });

  it("tells only a trigger that is declared, and that is an event", async () => {
    const t = eventsOf({ triggers: [OPENED, { id: "sunday", during: { from: "08:00", to: "23:00" } }] });
    t.events.note(EXTENSION_ID, "gone", { at: NOW });
    t.events.note(EXTENSION_ID, "sunday", { at: NOW });
    t.events.note("dev.other", "opened", { at: NOW });
    expect(t.timers).toHaveLength(0);
  });

  it("keeps each trigger's events apart", async () => {
    const t = eventsOf();
    t.events.note(EXTENSION_ID, "opened", { at: NOW, tabId: "t1" });
    t.events.note(EXTENSION_ID, "done", { at: NOW });
    await t.fire();
    expect(t.delivered.map((state) => state.id).sort()).toEqual(["done", "opened"]);
    expect(eventsIn(t.delivered.find((state) => state.id === "done"))).toEqual([{ at: NOW }]);
  });

  it("says an event was heard only when its handler answered, for a trigger still declared by an extension still here", async () => {
    const t = eventsOf();
    // A handler that failed was told, and nothing says it was heard.
    t.state.fail = "boom";
    t.events.note(EXTENSION_ID, "opened", { at: NOW, tabId: "t1" });
    await t.fire();
    expect(t.store.delivered(EXTENSION_ID, "opened")).toBeNull();
    // Removed while its handler ran: the file is left with nothing of it.
    t.state.fail = null;
    t.state.now = NOW + 10_000;
    let release = (): void => undefined;
    t.state.hold = new Promise((done) => {
      release = done;
    });
    t.events.note(EXTENSION_ID, "opened", { at: NOW + 10_000, tabId: "t2" });
    await t.fire();
    t.state.subjects = [];
    t.store.forget(EXTENSION_ID);
    t.state.hold = null;
    release();
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(t.store.delivered(EXTENSION_ID, "opened")).toBeNull();
    expect(JSON.parse(readFileSync(join(t.dir, AUTOMATION_FILE), "utf8")).extensions).toEqual({});
  });

  it("stops: nothing is told after", async () => {
    const t = eventsOf();
    t.events.note(EXTENSION_ID, "opened", { at: NOW, tabId: "t1" });
    t.events.stop();
    await t.fire();
    t.events.note(EXTENSION_ID, "opened", { at: NOW, tabId: "t2" });
    expect(t.delivered).toEqual([]);
  });
});

describe("a download that has just finished", () => {
  const was = new Map([["a", "progress"], ["b", "completed"], ["c", "progress"]]);

  it("is one complete now that was not when last told — one first seen complete among them", () => {
    expect(newlyFinished(was, [{ id: "a", state: "completed" }, { id: "b", state: "completed" }, { id: "c", state: "progress" }, { id: "d", state: "completed" }])).toEqual(["a", "d"]);
  });

  it("is never one that was cancelled, interrupted or blocked", () => {
    expect(newlyFinished(was, [{ id: "a", state: "cancelled" }, { id: "c", state: "interrupted" }, { id: "e", state: "blocked" }])).toEqual([]);
  });

  it("is none at the first telling: what had finished by then happened before anyone listened", () => {
    expect(newlyFinished(null, [{ id: "a", state: "completed" }])).toEqual([]);
  });
});

describe("an event against the clock", () => {
  it("has no state the clock can read: nothing to ask, nothing next, nothing in the week ahead", () => {
    expect(triggerState(OPENED, NOW, NY)).toEqual({ id: "opened", kind: "on", events: [] });
    expect(triggerNext(triggerState(OPENED, NOW, NY))).toBeNull();
    expect(triggerStatus(OPENED, NOW, NY)).toMatchObject({ id: "opened", says: "When a tab opens", event: true, next: [] });
    expect(triggerStatus(OPENED, NOW, NY).holds).toBeUndefined();
  });

  it("is never delivered by the clock, however often it looks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pistachio-events-"));
    const store = new AutomationStore(dir);
    const deliver = vi.fn(async () => undefined);
    const timers: number[] = [];
    const runner = new TriggerRunner({
      subjects: () => [{ id: EXTENSION_ID, triggers: [OPENED] }],
      deliver,
      store,
      zone: () => NY,
      now: () => NOW,
      timers: { setTimeout: (_callback, ms) => timers.push(ms), clearTimeout: () => undefined },
    });
    await runner.start();
    await runner.tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(store.delivered(EXTENSION_ID, "opened")).toBeNull();
    // (With nothing but an event declared, the clock does not even sleep toward anything.)
    expect(timers).toEqual([]);
  });
});

/* ---------------------------- with nobody there ---------------------------- */

const SPACE = "space-profile-a";
const IDLE: TriggerDecl = { id: "gone", when: { idle: { minutes: 10 } } };

function fakeAway() {
  const fake = {
    sent: [] as { groupId: string; by: AwayHolder; until?: number; unattended?: boolean; absent?: boolean }[],
    refuse: null as AwayRefusal | null,
    send: async (groupId: string, options: { by: AwayHolder; until?: number; unattended?: boolean; absent?: boolean }): Promise<AwayOutcome> => {
      if (fake.refuse !== null) return awayRefused(fake.refuse);
      fake.sent.push({ groupId, ...options });
      const space: AwaySpaceInfo = { id: groupId, spaceId: "profile-a", title: "Work", color: "blue", tabCount: 1, favicons: [null], by: options.by, since: NOW };
      return { ok: true, space };
    },
    bringBack: async (): Promise<AwayOutcome> => awayRefused("notAway"),
    all: (): AwaySpaceInfo[] => [],
    get: (): AwaySpaceInfo | null => null,
    onChange: () => () => undefined,
  };
  return fake;
}

function setup(options: { absent?: (triggers: readonly string[]) => boolean } = {}) {
  const away = fakeAway();
  const capabilities = ["spaces:write", "tabs:read", "tabs:write"];
  const h = harness({
    manifest: manifestOf({ permissions: capabilities, worker: { type: "web", main: "worker.js" }, triggers: [IDLE, { id: "nine", at: { time: "09:00" } }] }),
    record: recordOf({ capabilities }, { spaces: [SPACE] }),
    tabs: [tabOf("t1", "https://espn.com/"), tabOf("new-tab", "https://docs.google.com/document/d/1")],
    away,
    ...(options.absent === undefined ? {} : { absent: options.absent }),
  });
  const call = (method: string, args: unknown = {}) => dispatch(method, args, h.scope, h.ctx("worker"), h.runtime);
  return { h, away, call };
}

describe("a worker once no trigger's handler is in hand", () => {
  const settled = { busy: false, keptUp: false };

  it("is stopped when a trigger started it and nothing of the person's has run since", () => {
    expect(stopsWhenSettled({ ...settled, wokenAt: 9_999_000, attendedAt: 0 })).toBe(true);
    // (However many deliveries overlapped: it is asked once, when the last has answered.)
    expect(stopsWhenSettled({ ...settled, wokenAt: 9_999_000, attendedAt: 9_000_000 })).toBe(true);
  });

  it("stays when the person ran something of it since it woke: it is theirs now", () => {
    expect(stopsWhenSettled({ ...settled, wokenAt: 9_999_000, attendedAt: 9_999_500 })).toBe(false);
  });

  it("is never stopped here when the person started it, however long ago: a trigger neither lengthens its life nor cuts it short", () => {
    expect(stopsWhenSettled({ ...settled, wokenAt: null, attendedAt: 9_999_000 })).toBe(false);
    // (A long job of theirs that holds nothing is theirs to finish; the worker idles out by its own clock, which a
    // trigger does not wind.)
    expect(stopsWhenSettled({ ...settled, wokenAt: null, attendedAt: 0 })).toBe(false);
  });

  it("stays while something of the person's keeps it: a page or the panel open, a hold, a handler of theirs still running", () => {
    expect(stopsWhenSettled({ ...settled, wokenAt: 9_999_000, attendedAt: 0, keptUp: true })).toBe(false);
    expect(stopsWhenSettled({ ...settled, wokenAt: 9_999_000, attendedAt: 0, busy: true })).toBe(false);
  });

  it("is the person's once they run something of it — a command, a click, a message that follows their press in its own view — and by nothing else", () => {
    for (const kind of ["tool", "bar", "menu", "key", "action", "statusAction", "press"] as const) expect(attendedInvocation(kind, false), kind).toBe(true);
    // A message is the extension talking to itself: its open page writing to its worker is nobody's hand…
    expect(attendedInvocation("message", false)).toBe(false);
    // …unless the person has just pressed something in that page or its panel.
    expect(attendedInvocation("message", true)).toBe(true);
    // A trigger never is, nor the run that follows its being turned on — whatever was pressed lately.
    expect(attendedInvocation("trigger", true)).toBe(false);
    expect(attendedInvocation("installed", false)).toBe(false);
  });

  it("keeps a trigger's handler in hand past the time main waits for it: it has not answered, and what it goes on to call is still a trigger's", async () => {
    // (Until 2026-11-16 the handler was let go of at its timeout: in a worker the person had started, what it called
    // once it went on was asked as if they were there.)
    expect(staysInHand("trigger", "TIMEOUT")).toBe(true);
    // Answered, failed, or the worker gone: over. And nobody else's handler is kept — a command timed out is a command done with.
    expect(staysInHand("trigger", null)).toBe(false);
    expect(staysInHand("trigger", "CANCELLED")).toBe(false);
    expect(staysInHand("bar", "TIMEOUT")).toBe(false);
    expect(staysInHand("message", "TIMEOUT")).toBe(false);
    // What that means for the calls: a worker the person started (nothing woke it), a trigger's handler still in hand.
    const capabilities = ["tabs:read", "tabs:write"];
    const h = harness({ manifest: manifestOf({ permissions: capabilities, worker: { type: "web", main: "worker.js" }, triggers: [IDLE] }), record: recordOf({ capabilities }), tabs: [tabOf("t1", "https://espn.com/")] });
    const call = (method: string, args: unknown = {}) => dispatch(method, args, h.scope, h.ctx("worker"), h.runtime);
    h.scope.beginInvocation(1, "profile-a", "trigger", "gone");
    h.setNow(1_000_000 + 11_000);
    expect(await call("tabs.close", { id: "t1" })).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    // Its answer comes at last (or the worker stops): the worker is the person's again.
    h.scope.endInvocation(1);
    expect(await call("tabs.close", { id: "t1" })).toMatchObject({ ok: true });
  });

  it("kept up by a page, is still the trigger's: what it calls later — a timer its handler set — is asked as with nobody there", () => {
    // (Until 2026-11-16 the origin was let go as the handler answered: a page open was enough for a timer to close tabs.)
    expect(staysWoken({ ...settled, wokenAt: 9_999_000, attendedAt: 0, keptUp: true })).toBe(true);
    expect(staysWoken({ ...settled, wokenAt: 9_999_000, attendedAt: 0, busy: true })).toBe(true);
    // The person ran something of it since: it is theirs, kept up or not.
    expect(staysWoken({ ...settled, wokenAt: 9_999_000, attendedAt: 9_999_500, keptUp: true })).toBe(false);
    // One they started was never the trigger's; and one that is stopped has nothing to stay.
    expect(staysWoken({ ...settled, wokenAt: null, attendedAt: 0, keptUp: true })).toBe(false);
    expect(staysWoken({ ...settled, wokenAt: 9_999_000, attendedAt: 0 })).toBe(false);
  });
});

describe("the microphone and the camera", () => {
  const capabilities = ["media:microphone", "tabs:read"];
  const granted = (woken: boolean) =>
    harness({
      manifest: manifestOf({ permissions: capabilities, worker: { type: "web", main: "worker.js" }, triggers: [IDLE] }),
      record: recordOf({ capabilities }),
      woken: () => woken,
    });

  it("are the extension's own contexts' as its grants say: the microphone granted, the camera not", () => {
    const h = granted(false);
    expect(h.scope.mediaAllowed("worker", ["audio"])).toBe(true);
    expect(h.scope.mediaAllowed("panel", ["audio"])).toBe(true);
    expect(h.scope.mediaAllowed("worker", ["video"])).toBe(false);
    expect(h.scope.mediaAllowed("worker", ["audio", "video"])).toBe(false);
    expect(h.scope.mediaAllowed("worker", [])).toBe(false);
    expect(h.scope.mediaAllowed("worker", ["screen"])).toBe(false);
  });

  it("are not a worker's with nobody there: a trigger's handler in hand, or a worker a trigger woke, is refused what the grant allows", () => {
    // (getUserMedia is the page's own call, not one of Pistachio's: the list of what may be called alone never sees it.)
    const h = granted(false);
    h.scope.beginInvocation(1, "profile-a", "trigger", "gone");
    expect(h.scope.mediaAllowed("worker", ["audio"])).toBe(false);
    // The extension's own page or panel is the person's view of it, and theirs to speak into.
    expect(h.scope.mediaAllowed("page", ["audio"])).toBe(true);
    expect(h.scope.mediaAllowed("panel", ["audio"])).toBe(true);
    // The person's own command in hand, the worker has it.
    h.scope.beginInvocation(2, "profile-a", "bar", "record");
    expect(h.scope.mediaAllowed("worker", ["audio"])).toBe(true);
    h.scope.endInvocation(2);
    h.scope.endInvocation(1);
    expect(h.scope.mediaAllowed("worker", ["audio"])).toBe(true);
    // Woken by a trigger, with no handler in hand at all.
    expect(granted(true).scope.mediaAllowed("worker", ["audio"])).toBe(false);
  });
});

describe("a signal whose handler keeps acting", () => {
  const MEET: TriggerDecl = { id: "meet", when: { page: { host: "meet.google.com" } } };
  const OTHER: TriggerDecl = { id: "docked", when: { space: "front" } };

  function flapping(options: { acts?: boolean; fails?: boolean; triggers?: TriggerDecl[] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "pistachio-runaway-"));
    const store = new AutomationStore(dir);
    const state = { now: NOW, pace: 1_000_000, on: false, acted: 0, acts: options.acts ?? true, fails: options.fails ?? false };
    const delivered: ExtTriggerState[] = [];
    const runaway: string[] = [];
    const runner = new TriggerRunner({
      subjects: () => [{ id: EXTENSION_ID, triggers: options.triggers ?? [MEET] }],
      deliver: async (_id, trigger) => {
        delivered.push(trigger);
        // (What the scope's journal does for a space sent away or brought back with nobody there.)
        if (state.acts) state.acted += 1;
        if (state.fails) throw new Error("a later call was refused");
      },
      store,
      zone: () => NY,
      readings: () => browser(state.on ? ["https://meet.google.com/x"] : [], { frontHeld: state.on }),
      now: () => state.now,
      pace: () => state.pace,
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
      acted: () => state.acted,
      runaway: (extensionId, triggerId) => {
        runaway.push(`${extensionId} ${triggerId}`);
        // (As the service does: paused, as the person's own Pause would.)
        store.setPaused(extensionId, true);
      },
    });
    /** The signal changes, and the clock looks: one more run of the handler. */
    const flip = async (afterMs: number): Promise<void> => {
      state.on = !state.on;
      state.pace += afterMs;
      await runner.tick();
    };
    return { runner, store, state, delivered, runaway, flip };
  }

  it("is taken for a loop after eight runs in two minutes that each changed a space or a tab, and said once", async () => {
    const t = flapping();
    await t.runner.start();
    expect(t.delivered).toHaveLength(1);
    for (let run = 1; run < RUNAWAY_COUNT - 1; run += 1) await t.flip(3_000);
    expect(t.runaway).toEqual([]);
    await t.flip(3_000);
    expect(t.delivered).toHaveLength(RUNAWAY_COUNT);
    expect(t.runaway).toEqual([`${EXTENSION_ID} meet`]);
  });

  it("is never a loop when the handler only looks or tells: the person's own comings and goings change a signal too", async () => {
    // (A person going from a list to a page and back four times in two minutes: the handler shows a row each time.)
    const t = flapping({ acts: false });
    await t.runner.start();
    for (let run = 0; run < RUNAWAY_COUNT * 3; run += 1) await t.flip(2_000);
    expect(t.delivered).toHaveLength(RUNAWAY_COUNT * 3 + 1);
    expect(t.runaway).toEqual([]);
  });

  it("is not a loop when it acts that often over a longer while: a signal may be lively", async () => {
    const t = flapping();
    await t.runner.start();
    for (let run = 0; run < RUNAWAY_COUNT * 3; run += 1) await t.flip(RUNAWAY_WINDOW_MS / (RUNAWAY_COUNT - 2));
    expect(t.delivered).toHaveLength(RUNAWAY_COUNT * 3 + 1);
    expect(t.runaway).toEqual([]);
  });

  it("is caught when the handler acts and then fails every time, heard or not", async () => {
    const t = flapping({ fails: true });
    await t.runner.start();
    for (let run = 1; run < RUNAWAY_COUNT; run += 1) await t.flip(3_000);
    expect(t.delivered).toHaveLength(RUNAWAY_COUNT);
    expect(t.runaway).toEqual([`${EXTENSION_ID} meet`]);
  });

  it("leaves the extension's other triggers alone in the look it is paused in", async () => {
    const t = flapping({ triggers: [MEET, OTHER] });
    await t.runner.start();
    // Both said once at first sight; from here only `meet` is watched, and it runs away on its eighth acting run.
    const before = t.delivered.filter((state) => state.id === "docked").length;
    // (Each flip changes both signals: `meet` is considered first, and on the look it runs away `docked` is not run.)
    for (let run = 0; t.runaway.length === 0 && run < RUNAWAY_COUNT * 2; run += 1) await t.flip(1_000);
    expect(t.runaway).toHaveLength(1);
    const meetRuns = t.delivered.filter((state) => state.id === "meet").length;
    const dockedRuns = t.delivered.filter((state) => state.id === "docked").length - before;
    // One fewer than `meet` made since the start: the look that paused it did not go on to `docked`.
    expect(dockedRuns).toBeLessThan(meetRuns);
    expect(t.store.paused(EXTENSION_ID)).toBe(true);
  });
});

describe("a tab opened with nobody there", () => {
  it("opens behind what is in front, whatever was asked, and is written down with the tab it opened", async () => {
    const { h, call } = setup();
    h.scope.beginInvocation(1, "profile-a", "trigger", "nine");
    expect(await call("tabs.create", { url: "https://docs.google.com/document/d/1?usp=sharing", show: true })).toMatchObject({ ok: true });
    expect(h.browser.createTab).toHaveBeenCalledWith("https://docs.google.com/document/d/1?usp=sharing", { profileId: "profile-a", space: "current", activate: false });
    expect(h.journal).toEqual([{ trigger: "nine", verb: "openTab", spaceId: SPACE, title: "docs.google.com/document/d/1", tabId: "new-tab" }]);
  });

  it("is shown, and not written down, when the person's own command asks", async () => {
    const { h, call } = setup();
    h.scope.beginInvocation(1, "profile-a", "bar", "open");
    expect(await call("tabs.create", { url: "https://docs.google.com/document/d/1" })).toMatchObject({ ok: true });
    expect(h.browser.createTab).toHaveBeenCalledWith("https://docs.google.com/document/d/1", { profileId: "profile-a", space: "current", activate: true });
    expect(h.journal).toEqual([]);
  });

  it("is a dozen an hour at most, and the hour passes", async () => {
    const { h, call } = setup();
    h.scope.beginInvocation(1, "profile-a", "trigger", "nine");
    // (The method's own bucket is thirty a minute: the hour's dozen is the one that bites.)
    for (let index = 0; index < UNATTENDED_TABS_PER_HOUR; index += 1) expect(await call("tabs.create", { url: "https://docs.google.com/document/d/1" }), String(index)).toMatchObject({ ok: true });
    const refused = await call("tabs.create", { url: "https://docs.google.com/document/d/1" });
    expect(refused).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    if (!refused.ok) expect(refused.message).toContain("12 tabs an hour");
    expect(h.journal).toHaveLength(UNATTENDED_TABS_PER_HOUR);
    h.setNow(1_000_000 + 61 * 60_000);
    expect(await call("tabs.create", { url: "https://docs.google.com/document/d/1" })).toMatchObject({ ok: true });
  });

  it("is a page of the web, never one of its own: its own page is its code running where nothing holds it to the list", async () => {
    const { h, call } = setup();
    const own = `pistachio-ext://${EXTENSION_ID}/board.html`;
    h.scope.beginInvocation(1, "profile-a", "trigger", "nine");
    const refused = await call("tabs.create", { url: own });
    expect(refused).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    if (!refused.ok) expect(refused.message).toContain("not this extension's own");
    expect(h.browser.createTab).not.toHaveBeenCalled();
    expect(h.journal).toEqual([]);
    // The person's own command opens it as it always did.
    h.scope.endInvocation(1);
    h.scope.beginInvocation(2, "profile-a", "bar", "board");
    expect(await call("tabs.create", { url: own })).toMatchObject({ ok: true });
  });

  it("opens in a space that is there, never one made for it: a space nobody asked for would outlive its Undo", async () => {
    const { h, call } = setup();
    h.scope.beginInvocation(1, "profile-a", "trigger", "nine");
    const refused = await call("tabs.create", { url: "https://espn.com/", space: "new" });
    expect(refused).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    if (!refused.ok) expect(refused.message).toContain("a space that is there");
    expect(h.browser.createTab).not.toHaveBeenCalled();
    expect(await call("tabs.create", { url: "https://espn.com/", space: SPACE })).toMatchObject({ ok: true });
    h.scope.endInvocation(1);
    h.scope.beginInvocation(2, "profile-a", "bar", "open");
    expect(await call("tabs.create", { url: "https://espn.com/", space: "new" })).toMatchObject({ ok: true });
  });

  it("opens into a space on the rail or the one in front — never a Home tab's space or a favorite's page's, which would grow a space around it", async () => {
    const { h, call } = setup();
    const drawn = h.browser.spaces("profile-a")[0]!;
    h.browser.spaces = () => [{ ...drawn, id: "loose", loose: true }, { ...drawn, id: "page", anchorId: "favorite-1" }, drawn];
    h.scope.beginInvocation(1, "profile-a", "trigger", "nine");
    for (const space of ["loose", "page"]) {
      const refused = await call("tabs.create", { url: "https://espn.com/", space });
      expect(refused, space).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
      if (!refused.ok) expect(refused.message).toContain("a space on the rail");
    }
    expect(h.browser.createTab).not.toHaveBeenCalled();
    expect(await call("tabs.create", { url: "https://espn.com/", space: SPACE })).toMatchObject({ ok: true });
    expect(await call("tabs.create", { url: "https://espn.com/" })).toMatchObject({ ok: true });
    // The person's own command opens beside a Home tab as it always did.
    h.scope.endInvocation(1);
    h.scope.beginInvocation(2, "profile-a", "bar", "open");
    expect(await call("tabs.create", { url: "https://espn.com/", space: "loose" })).toMatchObject({ ok: true });
  });

  it("is with nobody there from a woken worker's first line to its last, a handler in hand or not", async () => {
    // A worker a trigger started: its module's own top level as it loads, a call between two handlers.
    const state = { woken: true };
    const away = fakeAway();
    const capabilities = ["spaces:write", "tabs:read", "tabs:write"];
    const h = harness({
      manifest: manifestOf({ permissions: capabilities, worker: { type: "web", main: "worker.js" }, triggers: [IDLE] }),
      record: recordOf({ capabilities }, { spaces: [SPACE] }),
      tabs: [tabOf("t1", "https://espn.com/"), tabOf("new-tab", "https://docs.google.com/document/d/1")],
      away,
      woken: () => state.woken,
    });
    const call = (method: string, args: unknown = {}) => dispatch(method, args, h.scope, h.ctx("worker"), h.runtime);
    expect(h.scope.unattended()).toBe(true);
    // No handler is in hand, and still: nothing off the list, a tab only behind, a send asked as unattended.
    expect(await call("tabs.close", { id: "t1" })).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(await call("runtime.keepAlive", { reason: "stay" })).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(await call("tabs.create", { url: "https://docs.google.com/document/d/1", show: true })).toMatchObject({ ok: true });
    expect(h.browser.createTab).toHaveBeenCalledWith("https://docs.google.com/document/d/1", { profileId: "profile-a", space: "current", activate: false });
    await call("spaces.sendAway", { spaceId: SPACE });
    expect(away.sent[0]?.unattended).toBe(true);
    // Written down, though no trigger is in hand to name.
    expect(h.journal.map((line) => [line.trigger, line.verb])).toEqual([[null, "openTab"], [null, "sendAway"]]);
    // The person's own command in hand, it is theirs — and once nothing of a trigger's is running, a worker is a worker.
    h.scope.beginInvocation(1, "profile-a", "bar", "close");
    expect(await call("tabs.close", { id: "t1" })).toMatchObject({ ok: true });
    h.scope.endInvocation(1);
    state.woken = false;
    expect(h.scope.unattended()).toBe(false);
  });

  it("has no behind to open into when nothing is in use in the space in front: refused, uncounted, for the trigger to be tried again", async () => {
    // (A space shows the tab it has: one that joined the space in front, empty, would be put in front whatever was asked.)
    const { h, call } = setup();
    h.scope.beginInvocation(1, "profile-a", "trigger", "nine");
    h.browser.activeTabId = () => null;
    const refused = await call("tabs.create", { url: "https://docs.google.com/document/d/1" });
    expect(refused).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    if (!refused.ok) expect(refused.message).toContain("nothing is in use in the space in front");
    // The space in front named outright is the same space.
    expect(await call("tabs.create", { url: "https://docs.google.com/document/d/1", space: SPACE })).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect(h.browser.createTab).not.toHaveBeenCalled();
    expect(h.journal).toEqual([]);
    // Another Profile is not in front of anyone; and the person's own command opens where it asks.
    h.browser.activeProfileId = () => "profile-b";
    expect(await call("tabs.create", { url: "https://docs.google.com/document/d/1" })).toMatchObject({ ok: true });
    h.browser.activeProfileId = () => "profile-a";
    h.scope.beginInvocation(2, "profile-a", "bar", "open");
    expect(await call("tabs.create", { url: "https://docs.google.com/document/d/2" })).toMatchObject({ ok: true });
    h.scope.endInvocation(2);
    // Something in use again, it opens behind it.
    h.browser.activeTabId = () => "t1";
    expect(await call("tabs.create", { url: "https://docs.google.com/document/d/3" })).toMatchObject({ ok: true });
    expect(h.journal.map((line) => line.verb)).toEqual(["openTab", "openTab"]);
  });

  it("still opens only the web, and still needs tabs:write", async () => {
    const { h, call } = setup();
    h.scope.beginInvocation(1, "profile-a", "trigger", "nine");
    expect(await call("tabs.create", { url: "file:///etc/passwd" })).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    expect(h.journal).toEqual([]);
    const bare = harness({ manifest: manifestOf({ permissions: ["tabs:read"], worker: { type: "web", main: "worker.js" }, triggers: [IDLE] }), record: recordOf({ capabilities: ["tabs:read"] }) });
    bare.scope.beginInvocation(1, "profile-a", "trigger", "gone");
    expect(await dispatch("tabs.create", { url: "https://espn.com/" }, bare.scope, bare.ctx("worker"), bare.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
  });

  it("names a tab in the journal by its address without the scheme, the query or what follows a #", () => {
    expect(journalTabTitle("https://docs.google.com/document/d/1?usp=sharing#heading")).toBe("docs.google.com/document/d/1");
    expect(journalTabTitle("https://espn.com/")).toBe("espn.com");
    expect(journalTabTitle(`https://example.com/${"a".repeat(200)}`)).toHaveLength(80);
  });

  it("keeps the tab in the file, and reads back only verbs it knows", () => {
    const dir = mkdtempSync(join(tmpdir(), "pistachio-automation-"));
    const store = new AutomationStore(dir);
    const line = store.record({ at: NOW, extensionId: EXTENSION_ID, trigger: "nine", verb: "openTab", spaceId: SPACE, title: "docs.google.com/document/d/1", tabId: "tab-7" });
    expect(new AutomationStore(dir).entry(line.id)).toMatchObject({ verb: "openTab", tabId: "tab-7" });
    const raw = JSON.parse(readFileSync(join(dir, AUTOMATION_FILE), "utf8")) as { journal: Record<string, unknown>[] };
    raw.journal.push({ ...raw.journal[0], id: "x", verb: "eraseDisk" });
    writeFileSync(join(dir, AUTOMATION_FILE), JSON.stringify(raw));
    expect(new AutomationStore(dir).journalOf(EXTENSION_ID, 10).map((entry) => entry.verb)).toEqual(["openTab"]);
  });
});

describe("the space in front, with nobody at the Mac", () => {
  it("is asked of main for the triggers in hand, and sent with `absent` when main can see nobody is there", async () => {
    const absent = vi.fn((triggers: readonly string[]) => triggers.includes("gone"));
    const { h, away, call } = setup({ absent });
    h.scope.beginInvocation(1, "profile-a", "trigger", "gone");
    expect(await call("spaces.sendAway", { spaceId: SPACE })).toMatchObject({ ok: true });
    expect(absent).toHaveBeenCalledWith(["gone"]);
    expect(away.sent[0]).toMatchObject({ groupId: SPACE, unattended: true, absent: true });
    expect(h.journal.map((line) => line.verb)).toEqual(["sendAway"]);
  });

  it("is not `absent` for a trigger that says nothing of who is there", async () => {
    const { h, away, call } = setup({ absent: (triggers) => triggers.includes("gone") });
    h.scope.beginInvocation(1, "profile-a", "trigger", "nine");
    expect(await call("spaces.sendAway", { spaceId: SPACE })).toMatchObject({ ok: true });
    expect(away.sent[0]?.unattended).toBe(true);
    expect(away.sent[0]?.absent).toBeUndefined();
  });

  it("never asks while the person's own command is in hand: their press needs no leave", async () => {
    const absent = vi.fn(() => true);
    const { h, away, call } = setup({ absent });
    h.scope.beginInvocation(1, "profile-a", "bar", "away");
    expect(await call("spaces.sendAway", { spaceId: SPACE })).toMatchObject({ ok: true });
    expect(absent).not.toHaveBeenCalled();
    expect(away.sent[0]?.absent).toBeUndefined();
    expect(away.sent[0]?.unattended).toBeUndefined();
  });
});
