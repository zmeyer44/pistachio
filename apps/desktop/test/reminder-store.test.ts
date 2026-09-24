import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReminderStore } from "../src/main/reminder-store";
import type { ReminderSource } from "@pistachio/shell-contracts/reminders";

const USER: ReminderSource = { kind: "user", runId: null };
const AGENT: ReminderSource = { kind: "agent", runId: "run-1" };
const DENVER = "America/Denver";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "pistachio-reminders-"));
}

/** A clock the test moves by hand. Starts Thursday 2026-08-27 15:40 Denver. */
function clock(start = "2026-08-27T21:40:00.000Z") {
  let at = new Date(start);
  return {
    now: () => at,
    advance(ms: number) {
      at = new Date(at.getTime() + ms);
    },
    set(iso: string) {
      at = new Date(iso);
    },
  };
}

function open(directory = scratch(), time = clock()) {
  return { store: new ReminderStore(directory, { now: time.now, timezone: () => DENVER }), directory, time };
}

describe("ReminderStore", () => {
  it("persists what it is told and reads it back", () => {
    const { store, directory } = open();
    const cookies = store.add(
      { title: "Cookies", schedule: { kind: "once", at: "2026-08-27T22:00:00.000Z" }, action: { kind: "message", text: "Take them out" } },
      USER,
    );
    expect(cookies).toMatchObject({ status: "active", nextFireAt: "2026-08-27T22:00:00.000Z", timezone: DENVER, fireCount: 0, source: USER });
    const reopened = new ReminderStore(directory, { now: () => new Date("2026-08-27T21:41:00.000Z") });
    expect(reopened.get(cookies.id)).toEqual(cookies);
    expect(JSON.parse(readFileSync(join(directory, "reminders.json"), "utf8"))).toMatchObject({ version: 1 });
  });

  it("computes the next fire from the schedule in the reminder's zone", () => {
    const { store } = open();
    const teeth = store.add({ title: "Teeth", schedule: { kind: "daily", time: "07:00" }, action: { kind: "message", text: "Brush" } }, AGENT);
    expect(teeth.nextFireAt).toBe("2026-08-28T13:00:00.000Z");
    const tokyo = store.add(
      { title: "Tokyo", schedule: { kind: "daily", time: "07:00" }, action: { kind: "message", text: "Brush" }, timezone: "Asia/Tokyo" },
      AGENT,
    );
    expect(tokyo.nextFireAt).toBe("2026-08-27T22:00:00.000Z");
    expect(store.nextFireAt()?.toISOString()).toBe("2026-08-27T22:00:00.000Z");
  });

  it("refuses what can never fire", () => {
    const { store } = open();
    expect(() =>
      store.add({ title: "Past", schedule: { kind: "once", at: "2026-08-27T10:00:00.000Z" }, action: { kind: "message", text: "x" } }, USER),
    ).toThrow(/already passed/);
    expect(() =>
      store.add(
        { title: "Over", schedule: { kind: "daily", time: "07:00" }, action: { kind: "message", text: "x" }, until: "2026-08-27T23:00:00.000Z" },
        USER,
      ),
    ).toThrow(/ends before/);
    expect(store.all()).toHaveLength(0);
  });

  it("advances past a fire, and a one-off is done after it", () => {
    const { store, time } = open();
    const cookies = store.add(
      { title: "Cookies", schedule: { kind: "once", at: "2026-08-27T22:00:00.000Z" }, action: { kind: "message", text: "Take them out" } },
      USER,
    );
    expect(store.due()).toEqual([]);
    expect(store.advance(cookies.id)).toBeNull();
    time.set("2026-08-27T22:00:30.000Z");
    expect(store.due().map((r) => r.id)).toEqual([cookies.id]);
    expect(store.advance(cookies.id)).toBe("2026-08-27T22:00:00.000Z");
    expect(store.get(cookies.id)).toMatchObject({ status: "done", nextFireAt: null, fireCount: 1, lastFiredAt: "2026-08-27T22:00:30.000Z" });
    // Claimed once: a second claim finds nothing due.
    expect(store.advance(cookies.id)).toBeNull();
  });

  it("continues a recurring reminder from now, not from the fire it missed", () => {
    const { store, time } = open();
    const teeth = store.add({ title: "Teeth", schedule: { kind: "daily", time: "07:00" }, action: { kind: "message", text: "Brush" } }, USER);
    // The Mac was shut for three days.
    time.set("2026-08-31T20:00:00.000Z");
    expect(store.advance(teeth.id)).toBe("2026-08-28T13:00:00.000Z");
    expect(store.get(teeth.id)?.nextFireAt).toBe("2026-09-01T13:00:00.000Z");
    expect(store.due()).toEqual([]);
  });

  it("stops at maxFires and at until", () => {
    const { store, time } = open();
    const twice = store.add(
      { title: "Twice", schedule: { kind: "interval", everyMinutes: 10, startAt: "2026-08-27T21:40:00.000Z" }, action: { kind: "message", text: "x" }, maxFires: 2 },
      USER,
    );
    time.advance(10 * 60_000);
    store.advance(twice.id);
    expect(store.get(twice.id)).toMatchObject({ status: "active", fireCount: 1 });
    time.advance(10 * 60_000);
    store.advance(twice.id);
    expect(store.get(twice.id)).toMatchObject({ status: "done", fireCount: 2, nextFireAt: null });

    const ending = store.add(
      { title: "Ending", schedule: { kind: "daily", time: "16:00" }, action: { kind: "message", text: "x" }, until: "2026-08-29T00:00:00.000Z" },
      USER,
    );
    expect(ending.nextFireAt).toBe("2026-08-28T22:00:00.000Z");
    time.set("2026-08-28T22:00:01.000Z");
    store.advance(ending.id);
    // The next daily fire would be past `until`: finished.
    expect(store.get(ending.id)).toMatchObject({ status: "done", fireCount: 1, nextFireAt: null });
  });

  it("updates: a new schedule recomputes, pausing clears the clock, resuming restores it", () => {
    const { store } = open();
    const teeth = store.add({ title: "Teeth", schedule: { kind: "daily", time: "07:00" }, action: { kind: "message", text: "Brush" } }, USER);
    const eight = store.update(teeth.id, { schedule: { kind: "daily", time: "08:00" } }, AGENT);
    expect(eight).toMatchObject({ nextFireAt: "2026-08-28T14:00:00.000Z", source: AGENT });
    expect(store.update(teeth.id, { status: "paused" }, USER)).toMatchObject({ status: "paused", nextFireAt: null });
    expect(store.due(new Date("2026-09-01T00:00:00.000Z"))).toEqual([]);
    expect(store.update(teeth.id, { status: "active" }, USER)).toMatchObject({ status: "active", nextFireAt: "2026-08-28T14:00:00.000Z" });
    expect(store.update(teeth.id, { title: "Brush teeth" }, USER).title).toBe("Brush teeth");
    expect(() => store.update("nope", { title: "x" }, USER)).toThrow("reminder not found");
  });

  it("leaves the reminder exactly as it was when an update is refused", () => {
    const { store } = open();
    const teeth = store.add({ title: "Teeth", schedule: { kind: "daily", time: "07:00" }, action: { kind: "message", text: "Brush" } }, USER);
    expect(() => store.update(teeth.id, { title: "Changed", schedule: { kind: "once", at: "2026-08-27T10:00:00.000Z" } }, AGENT)).toThrow(/already passed/);
    expect(store.get(teeth.id)).toEqual(teeth);
    // Nothing half-changed survives a later commit either.
    store.update(teeth.id, { title: "Brush teeth" }, USER);
    expect(store.get(teeth.id)).toMatchObject({ title: "Brush teeth", schedule: { kind: "daily", time: "07:00" }, nextFireAt: teeth.nextFireAt });
  });

  it("brings a finished reminder back with a new schedule, and refuses to edit a cancelled one otherwise", () => {
    const { store, time } = open();
    const cookies = store.add(
      { title: "Cookies", schedule: { kind: "once", at: "2026-08-27T22:00:00.000Z" }, action: { kind: "message", text: "x" } },
      USER,
    );
    time.set("2026-08-27T22:00:30.000Z");
    store.advance(cookies.id);
    expect(store.get(cookies.id)?.status).toBe("done");
    const again = store.update(cookies.id, { schedule: { kind: "once", at: "2026-08-27T23:00:00.000Z" } }, USER);
    expect(again).toMatchObject({ status: "active", nextFireAt: "2026-08-27T23:00:00.000Z", fireCount: 0 });
    store.cancel(cookies.id, USER);
    expect(() => store.update(cookies.id, { title: "x" }, USER)).toThrow(/cancelled/);
  });

  it("cancels, removes with its history, and fires now on request", () => {
    const { store, time } = open();
    const teeth = store.add({ title: "Teeth", schedule: { kind: "daily", time: "07:00" }, action: { kind: "message", text: "Brush" } }, USER);
    store.openOccurrence({ reminder: teeth, scheduledFor: teeth.nextFireAt!, status: "delivered" });
    expect(store.cancel(teeth.id, AGENT)).toMatchObject({ status: "cancelled", nextFireAt: null, source: AGENT });
    expect(() => store.fireNow(teeth.id)).toThrow(/cancelled/);
    expect(store.remove(teeth.id)).toBe(true);
    expect(store.remove(teeth.id)).toBe(false);
    expect(store.occurrences()).toEqual([]);

    const later = store.add({ title: "Later", schedule: { kind: "daily", time: "07:00" }, action: { kind: "message", text: "x" } }, USER);
    expect(store.fireNow(later.id).nextFireAt).toBe(time.now().toISOString());
    expect(store.due().map((r) => r.id)).toEqual([later.id]);
  });

  it("logs occurrences, acknowledges them, and snoozes one into a fresh one-off", () => {
    const { store, time } = open();
    const teeth = store.add({ title: "Teeth", schedule: { kind: "daily", time: "07:00" }, action: { kind: "message", text: "Brush" } }, USER);
    const fired = store.openOccurrence({ reminder: teeth, scheduledFor: teeth.nextFireAt!, status: "delivered", startedAt: time.now().toISOString() });
    expect(fired).toMatchObject({ reminderId: teeth.id, title: "Teeth", actionKind: "message", status: "delivered", acknowledgedAt: null });
    const done = store.updateOccurrence(fired.id, { output: "Brush", finishedAt: time.now().toISOString() });
    expect(done.output).toBe("Brush");
    expect(store.acknowledge([fired.id])).toBe(1);
    expect(store.acknowledge([fired.id])).toBe(0);
    expect(store.occurrence(fired.id)?.acknowledgedAt).toBe(time.now().toISOString());

    const again = store.openOccurrence({ reminder: teeth, scheduledFor: teeth.nextFireAt!, status: "delivered" });
    const snoozed = store.snooze(again.id, 10, USER);
    expect(snoozed).toMatchObject({ title: "Teeth", schedule: { kind: "once", at: "2026-08-27T21:50:00.000Z" }, action: teeth.action, timezone: DENVER });
    expect(store.occurrence(again.id)?.acknowledgedAt).not.toBeNull();
    // A running occurrence is not something to dismiss.
    const running = store.openOccurrence({ reminder: teeth, scheduledFor: teeth.nextFireAt!, status: "running" });
    expect(store.acknowledge("all")).toBe(0);
    store.updateOccurrence(running.id, { status: "completed" });
    expect(store.acknowledge("all")).toBe(1);
  });

  it("tells listeners after every change", () => {
    const { store } = open();
    let calls = 0;
    const off = store.onChange(() => {
      calls += 1;
    });
    const teeth = store.add({ title: "Teeth", schedule: { kind: "daily", time: "07:00" }, action: { kind: "message", text: "Brush" } }, USER);
    store.update(teeth.id, { title: "T" }, USER);
    off();
    store.cancel(teeth.id, USER);
    expect(calls).toBe(2);
  });

  it("repairs a stored recurring reminder that lost its next fire", () => {
    const { store, directory, time } = open();
    const teeth = store.add({ title: "Teeth", schedule: { kind: "daily", time: "07:00" }, action: { kind: "message", text: "Brush" } }, USER);
    const path = join(directory, "reminders.json");
    const file = JSON.parse(readFileSync(path, "utf8")) as { reminders: Array<{ id: string; nextFireAt: string | null }> };
    file.reminders[0]!.nextFireAt = null;
    writeFileSync(path, JSON.stringify(file));
    const reopened = new ReminderStore(directory, { now: time.now });
    expect(reopened.get(teeth.id)?.nextFireAt).toBe("2026-08-28T13:00:00.000Z");
  });
});
