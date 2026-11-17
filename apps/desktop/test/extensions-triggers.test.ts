/**
 * Triggers (docs/primitives.md §3): a declared window or instant read against a clock
 * (../src/main/extensions/triggers.ts), the runner that hands a worker the answer when it is not the one it last
 * heard (trigger-runner.ts), what main keeps of it (automation.ts), and what a worker may do with nobody there
 * (scope.ts unattended, methods.ts's gate).
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { awayRefused, type AwayHolder, type AwayOutcome, type AwayRefusal, type AwaySpaceInfo } from "@pistachio/shell-contracts/away";
import type { ExtTriggerState } from "@pistachio/extension-api";
import { EXT_METHOD_NAMES, EXT_UNATTENDED_METHODS } from "@pistachio/extension-api/wire";
import type { TriggerDecl } from "@pistachio/extension-api/triggers";
import type { ExtensionAwayHost } from "../src/main/extensions/away";
import { AUTOMATION_FILE, AutomationStore, JOURNAL_MAX, undoOfBringBack, undoOfOpenTab } from "../src/main/extensions/automation";
import { dispatch } from "../src/main/extensions/methods";
import { TRIGGER_RETRY_MS, TriggerRunner, type TriggerSubject } from "../src/main/extensions/trigger-runner";
import { projectTrigger, triggerAnswer, triggerState, triggerStatus } from "../src/main/extensions/triggers";
import { EXTENSION_ID, harness, manifestOf, recordOf, tabOf } from "./extensions-harness";

const NY = "America/New_York";
/** An instant by New York's wall clock in November 2026 (EST, UTC−5): the 15th and the 22nd are Sundays. */
const ny = (day: number, hour: number, minute = 0): number => Date.UTC(2026, 10, day, hour + 5, minute);
const SUNDAY: TriggerDecl = { id: "sunday", during: { days: ["sun"], from: "08:00", to: "23:00" } };
/** Whether a window is on at an instant, by New York's clock unless a zone is named. */
const on = (trigger: TriggerDecl, at: number, zone = NY): boolean | null => {
  const state = triggerState(trigger, at, zone);
  return state.kind === "during" ? state.holds : null;
};

describe("a window of the week against the clock", () => {
  it("holds from its start to its end on its days, and says when that next changes", () => {
    expect(triggerState(SUNDAY, ny(15, 7, 59), NY)).toEqual({ id: "sunday", kind: "during", holds: false, changesAt: ny(15, 8) });
    expect(triggerState(SUNDAY, ny(15, 8), NY)).toEqual({ id: "sunday", kind: "during", holds: true, changesAt: ny(15, 23) });
    expect(on(SUNDAY, ny(15, 22, 59))).toBe(true);
    // The end is not in it; the next start is a week on.
    expect(triggerState(SUNDAY, ny(15, 23), NY)).toEqual({ id: "sunday", kind: "during", holds: false, changesAt: ny(22, 8) });
    expect(triggerState(SUNDAY, ny(18, 12), NY)).toEqual({ id: "sunday", kind: "during", holds: false, changesAt: ny(22, 8) });
  });

  it("runs past midnight when it ends at or before its start, on the day it started", () => {
    const late: TriggerDecl = { id: "late", during: { days: ["fri"], from: "22:00", to: "06:00" } };
    // Friday the 20th 22:00 to Saturday the 21st 06:00.
    expect(triggerState(late, ny(20, 21), NY)).toMatchObject({ holds: false, changesAt: ny(20, 22) });
    expect(triggerState(late, ny(21, 3), NY)).toMatchObject({ holds: true, changesAt: ny(21, 6) });
    // Saturday night is not Friday's.
    expect(on(late, ny(21, 23))).toBe(false);
  });

  it("does not blink at midnight between a day that ends at 24:00 and the next that starts at 00:00", () => {
    const weekend: TriggerDecl = { id: "weekend", during: { days: ["sat", "sun"], from: "00:00", to: "24:00" } };
    expect(triggerState(weekend, ny(21, 23, 59), NY)).toMatchObject({ holds: true, changesAt: ny(23, 0) });
    expect(triggerState(weekend, ny(22, 0), NY)).toMatchObject({ holds: true, changesAt: ny(23, 0) });
    expect(triggerState(weekend, ny(23, 0), NY)).toMatchObject({ holds: false, changesAt: ny(28, 0) });
    // Every day, all day: on, and never anything else.
    expect(triggerState({ id: "always", during: { from: "00:00", to: "24:00" } }, ny(18, 12), NY)).toEqual({ id: "always", kind: "during", holds: true, changesAt: null });
  });

  it("is said in its own zone when it names one, else the Mac's", () => {
    const tokyo: TriggerDecl = { id: "tokyo", during: { days: ["mon"], from: "09:00", to: "10:00", zone: "Asia/Tokyo" } };
    // Monday 09:00 in Tokyo is Sunday 19:00 in New York.
    expect(on(tokyo, ny(15, 19, 30))).toBe(true);
    expect(on({ id: "local", during: { days: ["mon"], from: "09:00", to: "10:00" } }, ny(15, 19, 30))).toBe(false);
  });

  it("keeps its wall-clock hours across the day the clocks change", () => {
    // 1 November 2026: New York falls back at 2:00 EDT. 08:00 that Sunday is 13:00 UTC; the Sunday before, 12:00 UTC.
    expect(on(SUNDAY, Date.UTC(2026, 9, 25, 12, 0))).toBe(true);
    expect(on(SUNDAY, Date.UTC(2026, 10, 1, 12, 30))).toBe(false);
    expect(on(SUNDAY, Date.UTC(2026, 10, 1, 13, 0))).toBe(true);
  });
});

describe("an instant that recurs", () => {
  const morning: TriggerDecl = { id: "morning", at: { days: ["mon", "wed"], time: "09:00" } };

  it("names the one that came due last and the one to come", () => {
    // Tuesday the 17th: Monday's came due, Wednesday's is next.
    expect(triggerState(morning, ny(17, 12), NY)).toEqual({ id: "morning", kind: "at", at: ny(16, 9), next: ny(18, 9) });
    expect(triggerState(morning, ny(18, 9), NY)).toEqual({ id: "morning", kind: "at", at: ny(18, 9), next: ny(23, 9) });
  });

  it("answers by the instant, so two that passed while asleep are heard as the later one", () => {
    expect(triggerAnswer(triggerState(morning, ny(17, 12), NY))).toBe(`at:${String(ny(16, 9))}`);
    expect(triggerAnswer(triggerState(morning, ny(19, 12), NY))).toBe(`at:${String(ny(18, 9))}`);
    expect(triggerAnswer(triggerState(SUNDAY, ny(15, 9), NY))).toBe("on");
    expect(triggerAnswer(triggerState(SUNDAY, ny(16, 9), NY))).toBe("off");
  });
});

describe("the days ahead, for the status file", () => {
  it("lists a window's changes in order, each with what it changes to", () => {
    expect(projectTrigger(SUNDAY, ny(18, 12), ny(18, 12) + 7 * 24 * 3_600_000, NY)).toEqual([
      { at: ny(22, 8), holds: true },
      { at: ny(22, 23), holds: false },
    ]);
  });

  it("says a trigger in the shell's words, its zone, and the week as that zone's clock reads", () => {
    expect(triggerStatus(SUNDAY, ny(18, 12), NY)).toEqual({
      id: "sunday",
      says: "Sundays 8:00 AM–11:00 PM",
      zone: NY,
      holds: false,
      next: [
        { at: "Sun, Nov 22, 8:00 AM", iso: "2026-11-22T13:00:00.000Z", holds: true },
        { at: "Sun, Nov 22, 11:00 PM", iso: "2026-11-23T04:00:00.000Z", holds: false },
      ],
    });
  });
});

/* -------------------------------- the runner -------------------------------- */

function runnerOf(options: { triggers?: TriggerDecl[]; at?: number; dir?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "pistachio-triggers-"));
  const store = new AutomationStore(dir);
  const state = { now: options.at ?? ny(14, 12), fail: null as string | null, subjects: [{ id: EXTENSION_ID, triggers: options.triggers ?? [SUNDAY] }] as TriggerSubject[] };
  const delivered: ExtTriggerState[] = [];
  const logs: string[] = [];
  let changed = 0;
  const timers: { ms: number }[] = [];
  const runner = new TriggerRunner({
    subjects: () => state.subjects,
    deliver: async (_id, trigger) => {
      if (state.fail !== null) throw new Error(state.fail);
      delivered.push(trigger);
    },
    store,
    zone: () => NY,
    now: () => state.now,
    timers: { setTimeout: (_callback, ms) => timers.push({ ms }), clearTimeout: () => undefined },
    changed: () => {
      changed += 1;
    },
    log: (_id, _level, message) => logs.push(message),
  });
  return { runner, store, state, delivered, logs, timers, dir, changes: () => changed };
}

describe("the triggers' clock", () => {
  it("hands a window's answer over when it is not the one last heard — once", async () => {
    const { runner, state, delivered } = runnerOf();
    // First seen on a Saturday: off, said once so the worker can make it so.
    await runner.start();
    expect(delivered).toEqual([{ id: "sunday", kind: "during", holds: false, changesAt: ny(15, 8) }]);
    await runner.tick();
    expect(delivered).toHaveLength(1);
    state.now = ny(15, 8, 0);
    await runner.tick();
    expect(delivered.at(-1)).toMatchObject({ holds: true });
    state.now = ny(15, 15);
    await runner.tick();
    await runner.tick();
    expect(delivered).toHaveLength(2);
    state.now = ny(15, 23);
    await runner.tick();
    expect(delivered.map((trigger) => (trigger.kind === "during" ? trigger.holds : null))).toEqual([false, true, false]);
  });

  it("changes nothing for a lid closed across a whole window, and delivers one answer for one closed across its start", async () => {
    const { runner, state, delivered } = runnerOf();
    await runner.start();
    // Asleep from Saturday noon to Monday: Sunday came and went. It was off, it is off.
    state.now = ny(16, 9);
    await runner.tick();
    expect(delivered).toHaveLength(1);
    // Asleep from Monday to the next Sunday afternoon: on, heard once, hours late.
    state.now = ny(22, 16);
    await runner.tick();
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toEqual({ id: "sunday", kind: "during", holds: true, changesAt: ny(22, 23) });
  });

  it("remembers what was heard across a restart", async () => {
    const first = runnerOf({ at: ny(15, 9) });
    await first.runner.start();
    expect(first.delivered).toHaveLength(1);
    const second = runnerOf({ at: ny(15, 10), dir: first.dir });
    await second.runner.start();
    expect(second.delivered).toEqual([]);
  });

  it("never delivers an instant from before the extension was first seen, and delivers the latest of those missed after", async () => {
    const morning: TriggerDecl = { id: "morning", at: { time: "09:00" } };
    const { runner, state, delivered } = runnerOf({ triggers: [morning], at: ny(16, 12) });
    await runner.start();
    expect(delivered).toEqual([]);
    // Three mornings pass with the lid closed: one delivery, of the last.
    state.now = ny(19, 10);
    await runner.tick();
    expect(delivered).toEqual([{ id: "morning", kind: "at", at: ny(19, 9), next: ny(20, 9) }]);
  });

  it("tries a failed delivery again later, less often each time, until it is heard", async () => {
    const { runner, state, delivered, logs } = runnerOf({ at: ny(15, 23) });
    state.fail = "spaces.sendAway: That space is in front. It can go once another is.";
    await runner.start();
    expect(delivered).toEqual([]);
    expect(logs[0]).toContain("in front");
    // Not before a minute is up.
    state.now += TRIGGER_RETRY_MS[0] - 1;
    await runner.tick();
    expect(logs).toHaveLength(1);
    state.now += 1;
    await runner.tick();
    expect(logs).toHaveLength(2);
    // The second wait is the longer one.
    state.now += TRIGGER_RETRY_MS[0];
    await runner.tick();
    expect(logs).toHaveLength(2);
    state.fail = null;
    state.now += TRIGGER_RETRY_MS[1];
    await runner.tick();
    expect(delivered).toEqual([{ id: "sunday", kind: "during", holds: false, changesAt: ny(22, 8) }]);
  });

  it("delivers nothing while paused — one extension's, or everyone's — and catches up when let run again", async () => {
    const { runner, store, state, delivered, changes } = runnerOf();
    await runner.start();
    store.setPaused(EXTENSION_ID, true);
    state.now = ny(15, 9);
    await runner.tick();
    expect(delivered).toHaveLength(1);
    // (The page still hears that the window came on.)
    expect(changes()).toBeGreaterThan(1);
    store.setPaused(EXTENSION_ID, false);
    store.setPausedAll(true);
    await runner.tick();
    expect(delivered).toHaveLength(1);
    store.setPausedAll(false);
    await runner.tick();
    expect(delivered.at(-1)).toMatchObject({ holds: true });
  });

  it("sleeps until the next change, never longer than a tick, and not at all with nothing declared", async () => {
    const soon = runnerOf({ at: ny(15, 8) - 5_000 });
    await soon.runner.start();
    expect(soon.timers.at(-1)?.ms).toBe(5_000);
    const far = runnerOf({ at: ny(16, 12) });
    await far.runner.start();
    expect(far.timers.at(-1)?.ms).toBe(30_000);
    const none = runnerOf();
    none.state.subjects = [];
    await none.runner.start();
    expect(none.timers).toEqual([]);
  });
});

/* --------------------------------- the file --------------------------------- */

describe("what main keeps of extensions that run by themselves", () => {
  it("writes the pauses, what each trigger heard and the journal, and reads them back", () => {
    const dir = mkdtempSync(join(tmpdir(), "pistachio-automation-"));
    const store = new AutomationStore(dir);
    store.setPausedAll(true);
    store.setPaused("dev.me.game-day", true);
    store.setDelivered("dev.me.game-day", "sunday", "on", 5);
    const line = store.record({ at: 9, extensionId: "dev.me.game-day", trigger: "sunday", verb: "sendAway", spaceId: "football", title: "Football" });
    store.markUndone(line.id, 12);
    // (Every verb the journal has is read back: a theme set for every space among them.)
    const themed = store.record({ at: 10, extensionId: "dev.me.game-day", trigger: "sunday", verb: "setTheme", spaceId: "*", title: "" });
    // (And when a space brought back early was due: what its Undo sends it away until.)
    const early = store.record({ at: 11, extensionId: "dev.other.early", trigger: "sunday", verb: "bringBack", spaceId: "football", title: "Football", until: 99_000 });
    expect(new AutomationStore(dir).journalOf("dev.other.early", 8)).toEqual([early]);
    const read = new AutomationStore(dir);
    expect(read.pausedAll).toBe(true);
    expect(read.paused("dev.me.game-day")).toBe(true);
    expect(read.delivered("dev.me.game-day", "sunday")).toEqual({ answer: "on", at: 5 });
    expect(read.journalOf("dev.me.game-day", 8)).toEqual([themed, { ...line, undone: 12 }]);
  });

  it("lists an extension's journal newest first, bounded, and forgets all of it with the extension", () => {
    const store = new AutomationStore(mkdtempSync(join(tmpdir(), "pistachio-automation-")));
    for (let index = 0; index < JOURNAL_MAX + 5; index += 1) store.record({ at: index, extensionId: index % 2 === 0 ? "dev.a.one" : "dev.b.two", trigger: null, verb: "bringBack", spaceId: "s", title: "S" });
    expect(store.journalOf("dev.a.one", 3).map((line) => line.at)).toEqual([JOURNAL_MAX + 4, JOURNAL_MAX + 2, JOURNAL_MAX]);
    store.setDelivered("dev.a.one", "gone", "on", 1);
    store.setDelivered("dev.a.one", "kept", "off", 1);
    store.keepTriggers("dev.a.one", [{ id: "kept", key: "k1" }]);
    expect(store.delivered("dev.a.one", "gone")).toBeNull();
    expect(store.delivered("dev.a.one", "kept")).not.toBeNull();
    store.forget("dev.a.one");
    expect(store.journalOf("dev.a.one", 3)).toEqual([]);
    expect(store.delivered("dev.a.one", "kept")).toBeNull();
    expect(store.journalOf("dev.b.two", 1)).toHaveLength(1);
  });

  it("starts a trigger afresh when it is another trigger under the same id: other days, another rhythm, another signal", () => {
    const dir = mkdtempSync(join(tmpdir(), "pistachio-automation-"));
    const store = new AutomationStore(dir);
    store.setDelivered("dev.a.one", "scores", "every:100", 1, "five-minutes");
    store.setDelivered("dev.a.one", "sunday", "on", 1, "sundays");
    // Declared as it was heard: what it heard stands, across a restart too.
    store.keepTriggers("dev.a.one", [{ id: "scores", key: "five-minutes" }, { id: "sunday", key: "sundays" }]);
    expect(new AutomationStore(dir).delivered("dev.a.one", "scores")).toEqual({ answer: "every:100", at: 1 });
    // The same id, another rhythm: nothing it heard is this trigger's.
    store.keepTriggers("dev.a.one", [{ id: "scores", key: "ten-minutes" }, { id: "sunday", key: "sundays" }]);
    expect(store.delivered("dev.a.one", "scores")).toBeNull();
    expect(store.delivered("dev.a.one", "sunday")).toEqual({ answer: "on", at: 1 });
    // Heard again under the new one, it is kept under the new one.
    store.setDelivered("dev.a.one", "scores", "every:200", 2, "ten-minutes");
    store.keepTriggers("dev.a.one", [{ id: "scores", key: "ten-minutes" }, { id: "sunday", key: "sundays" }]);
    expect(new AutomationStore(dir).delivered("dev.a.one", "scores")).toEqual({ answer: "every:200", at: 2 });
  });

  it("takes what a trigger heard before keys were kept as that trigger's, once", () => {
    const store = new AutomationStore(mkdtempSync(join(tmpdir(), "pistachio-automation-")));
    store.setDelivered("dev.a.one", "sunday", "on", 1);
    store.keepTriggers("dev.a.one", [{ id: "sunday", key: "sundays" }]);
    expect(store.delivered("dev.a.one", "sunday")).toEqual({ answer: "on", at: 1 });
    store.keepTriggers("dev.a.one", [{ id: "sunday", key: "saturdays" }]);
    expect(store.delivered("dev.a.one", "sunday")).toBeNull();
  });

  it("keeps a trigger named like something every object has as a trigger like any other", () => {
    const dir = mkdtempSync(join(tmpdir(), "pistachio-automation-"));
    const store = new AutomationStore(dir);
    // (An extension with one entry already: its record exists, and `constructor` must still be nothing heard.)
    store.setDelivered("dev.a.one", "sunday", "on", 1, "sundays");
    expect(store.delivered("dev.a.one", "constructor")).toBeNull();
    expect(store.delivered("constructor", "sunday")).toBeNull();
    expect(store.paused("constructor")).toBe(false);
    store.setDelivered("dev.a.one", "constructor", "every:100", 2, "k");
    expect(new AutomationStore(dir).delivered("dev.a.one", "constructor")).toEqual({ answer: "every:100", at: 2 });
    expect(new AutomationStore(dir).delivered("dev.a.one", "toString")).toBeNull();
  });

  it("reads a file it cannot make sense of as nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pistachio-automation-"));
    writeFileSync(join(dir, AUTOMATION_FILE), JSON.stringify({ version: 1, pausedAll: "yes", extensions: { a: { delivered: { t: { answer: 3 } } } }, journal: [{ id: "x" }, "junk"] }));
    const store = new AutomationStore(dir);
    expect(store.pausedAll).toBe(false);
    expect(store.delivered("a", "t")).toBeNull();
    expect(store.journalOf("a", 5)).toEqual([]);
    store.setPausedAll(true);
    expect(JSON.parse(readFileSync(join(dir, AUTOMATION_FILE), "utf8"))).toMatchObject({ version: 1, pausedAll: true, journal: [] });
  });
});

/* ------------------------------ with nobody there ------------------------------ */

const SPACE = "space-profile-a";
const NOW = 1_000_000;

function fakeAway(initial: AwaySpaceInfo[] = []) {
  const spaces = [...initial];
  const fake = {
    spaces,
    sent: [] as { groupId: string; by: AwayHolder; until?: number; unattended?: boolean }[],
    back: [] as { id: string; by?: AwayHolder }[],
    refuse: null as AwayRefusal | null,
    send: async (groupId: string, options: { by: AwayHolder; until?: number; unattended?: boolean }): Promise<AwayOutcome> => {
      if (fake.refuse !== null) return awayRefused(fake.refuse);
      fake.sent.push({ groupId, ...options });
      const space: AwaySpaceInfo = { id: groupId, spaceId: "profile-a", title: "Football", color: "green", tabCount: 1, favicons: [null], by: options.by, since: NOW, ...(options.until === undefined ? {} : { until: options.until }) };
      spaces.push(space);
      return { ok: true, space };
    },
    bringBack: async (id: string, options: { select?: boolean; by?: AwayHolder } = {}): Promise<AwayOutcome> => {
      const at = spaces.findIndex((space) => space.id === id);
      if (at < 0) return awayRefused("notAway");
      const [space] = spaces.splice(at, 1);
      fake.back.push({ id, ...(options.by === undefined ? {} : { by: options.by }) });
      return { ok: true, space: space! };
    },
    all: () => spaces,
    get: (id: string) => spaces.find((space) => space.id === id) ?? null,
    onChange: () => () => undefined,
  };
  return fake satisfies ExtensionAwayHost;
}

function setup() {
  const away = fakeAway();
  const capabilities = ["spaces:write", "tabs:read", "tabs:write", "notes:write", "pages:read", "clipboard:write"];
  const h = harness({
    manifest: manifestOf({ permissions: capabilities, hosts: ["https://espn.com/*"], worker: { type: "web", main: "worker.js" }, triggers: [SUNDAY] }),
    record: recordOf({ capabilities, hosts: ["https://espn.com/*"] }, { spaces: [SPACE] }),
    tabs: [tabOf("t1", "https://espn.com/")],
    away,
  });
  const call = (method: string, args: unknown = {}, context: "worker" | "panel" | "page" = "worker") => dispatch(method, args, h.scope, h.ctx(context), h.runtime);
  return { h, away, call };
}

describe("a worker with nobody there", () => {
  it("is unattended only while a trigger's handler is in hand and nothing of the person's is", () => {
    const { h } = setup();
    expect(h.scope.unattended()).toBe(false);
    h.scope.beginInvocation(1, "profile-a", "trigger", "sunday");
    expect(h.scope.unattended()).toBe(true);
    expect(h.scope.triggerInHand()).toBe("sunday");
    // The person runs its command meanwhile: all of it is attended for as long as that is in hand.
    h.scope.beginInvocation(2, "profile-a", "bar", "gameday");
    expect(h.scope.unattended()).toBe(false);
    h.scope.endInvocation(2);
    expect(h.scope.unattended()).toBe(true);
    // A command of theirs that has already answered lends the trigger nothing.
    h.scope.grantTab(null);
    expect(h.scope.recentGesture()).toBe(true);
    expect(h.scope.unattended()).toBe(true);
    // A press in its panel: attended for the moment a gesture lasts.
    h.scope.noteGesture(true);
    expect(h.scope.unattended()).toBe(false);
    h.setNow(NOW + 6_000);
    expect(h.scope.unattended()).toBe(true);
    h.scope.endInvocation(1);
    expect(h.scope.unattended()).toBe(false);
    expect(h.scope.triggerInHand()).toBeNull();
  });

  it("may read, keep its own state, tell the person and reach its hosts — and nothing else", async () => {
    const { h, call } = setup();
    h.scope.beginInvocation(1, "profile-a", "trigger", "sunday");
    for (const [method, args] of [
      ["tabs.query", {}],
      ["spaces.list", {}],
      ["storage.set", { items: { a: 1 } }],
      ["ui.toast", { title: "Game day" }],
      ["net.fetch", { url: "https://espn.com/schedule" }],
      ["triggers.get", { id: "sunday" }],
    ] as const) {
      expect(await call(method, args), method).toMatchObject({ ok: true });
    }
    for (const [method, args] of [
      ["tabs.close", { id: "t1" }],
      ["tabs.show", { id: "t1" }],
      ["tabs.navigate", { id: "t1", url: "https://espn.com/nfl" }],
      ["pages.read", { tabId: "t1", format: "text" }],
      ["notes.create", { title: "T", markdown: "x" }],
      ["runtime.keepAlive", { reason: "stay" }],
      ["clipboard.write", { text: "x" }],
    ] as const) {
      const reply = await call(method, args);
      expect(reply, method).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
      if (!reply.ok) expect(reply.message).toContain("trigger's handler");
    }
    expect(h.browser.closeTab).not.toHaveBeenCalled();
    // A page or the panel is the person's own view of it: never judged.
    expect(await call("tabs.close", { id: "t1" }, "panel")).toMatchObject({ ok: true });
    // And once the person's command is in hand, the worker may again.
    h.scope.beginInvocation(2, "profile-a", "bar", "gameday");
    expect(await call("tabs.navigate", { id: "t1", url: "https://espn.com/nfl" })).toMatchObject({ ok: true });
  });

  it("names only methods the API has", () => {
    for (const method of EXT_UNATTENDED_METHODS) expect(EXT_METHOD_NAMES).toContain(method);
  });

  it("sends a space away under the stricter rules, and writes it down with the trigger that asked", async () => {
    const { h, away, call } = setup();
    h.scope.beginInvocation(1, "profile-a", "trigger", "sunday");
    expect(await call("spaces.sendAway", { spaceId: SPACE })).toMatchObject({ ok: true });
    expect(away.sent).toEqual([{ groupId: SPACE, by: { kind: "extension", extensionId: EXTENSION_ID, name: "Harness" }, unattended: true }]);
    expect(h.journal).toEqual([{ trigger: "sunday", verb: "sendAway", spaceId: SPACE, title: "Football" }]);
    // Asked again: it is away, which is what was asked. Nothing is done, nothing more written.
    expect(await call("spaces.sendAway", { spaceId: SPACE })).toMatchObject({ ok: true, v: { id: SPACE } });
    expect(away.sent).toHaveLength(1);
    expect(await call("spaces.bringBack", { spaceId: SPACE })).toEqual({ ok: true, v: null });
    expect(away.back).toEqual([{ id: SPACE, by: { kind: "extension", extensionId: EXTENSION_ID, name: "Harness" } }]);
    expect(h.journal.map((line) => line.verb)).toEqual(["sendAway", "bringBack"]);
    // Here already: asked again, nothing.
    expect(await call("spaces.bringBack", { spaceId: SPACE })).toEqual({ ok: true, v: null });
    expect(h.journal).toHaveLength(2);
  });

  it("writes down when a space it brings back early was due, so that Undo can send it away until then", async () => {
    const { h, call } = setup();
    h.scope.beginInvocation(1, "profile-a", "trigger", "sunday");
    const due = Date.now() + 6 * 60 * 60_000;
    expect(await call("spaces.sendAway", { spaceId: SPACE, until: due })).toMatchObject({ ok: true });
    expect(await call("spaces.bringBack", { spaceId: SPACE })).toEqual({ ok: true, v: null });
    expect(h.journal).toEqual([
      { trigger: "sunday", verb: "sendAway", spaceId: SPACE, title: "Football" },
      { trigger: "sunday", verb: "bringBack", spaceId: SPACE, title: "Football", until: due },
    ]);
    // One away with no time set has none to keep.
    await call("spaces.sendAway", { spaceId: SPACE });
    await call("spaces.bringBack", { spaceId: SPACE });
    expect(h.journal[3]).toEqual({ trigger: "sunday", verb: "bringBack", spaceId: SPACE, title: "Football" });
  });

  it("undoes a bring-back by sending the space away until it was due — or not at all, once that time has passed", () => {
    // Brought back at noon, due at six: undone at two, it is away again until six.
    expect(undoOfBringBack({ until: 6_000 }, 2_000)).toEqual({ send: true, until: 6_000 });
    // Undone after six, it would have been back by now: there is nothing to send, and the line is undone all the same.
    expect(undoOfBringBack({ until: 6_000 }, 6_000)).toEqual({ send: false });
    expect(undoOfBringBack({ until: 6_000 }, 9_000)).toEqual({ send: false });
    // It had no time set: away until asked for, as it was.
    expect(undoOfBringBack({}, 2_000)).toEqual({ send: true });
  });

  it("undoes an opened tab where the tab is now: closed if it is here, said if it went away with a space — whichever space that is", () => {
    expect(undoOfOpenTab({ here: true, away: false })).toBe("close");
    // Moved to another space since, and that space sent away: it is in the away file, not gone. Undone it is not.
    expect(undoOfOpenTab({ here: false, away: true })).toBe("away");
    // Closed by the person since: nothing is left to undo.
    expect(undoOfOpenTab({ here: false, away: false })).toBe("gone");
  });

  it("is refused the space in front, and says to let the trigger be tried again", async () => {
    const { h, away, call } = setup();
    h.scope.beginInvocation(1, "profile-a", "trigger", "sunday");
    away.refuse = "inFront";
    const reply = await call("spaces.sendAway", { spaceId: SPACE });
    expect(reply).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    if (!reply.ok) {
      expect(reply.message).toContain("in front");
      expect(reply.message).toContain("runs the trigger again");
    }
    expect(h.journal).toEqual([]);
  });

  it("writes nothing down for what the person's own command did", async () => {
    const { h, away, call } = setup();
    h.scope.beginInvocation(1, "profile-a", "bar", "gameday");
    expect(await call("spaces.sendAway", { spaceId: SPACE })).toMatchObject({ ok: true });
    expect(away.sent[0]?.unattended).toBeUndefined();
    expect(h.journal).toEqual([]);
  });
});
