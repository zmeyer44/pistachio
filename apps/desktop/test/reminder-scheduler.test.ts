import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ReminderScheduler, type ReminderExecutor, type ScheduledAgentOutcome } from "../src/main/reminder-scheduler";
import { ReminderStore } from "../src/main/reminder-store";
import type { ReminderOccurrence, ReminderSource } from "@pistachio/shell-contracts/reminders";

const USER: ReminderSource = { kind: "user", runId: null };
const DENVER = "America/Denver";

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

/** Timers the test fires by hand. */
function timers() {
  const pending: Array<{ callback: () => void; ms: number }> = [];
  return {
    pending,
    set: (callback: () => void, ms: number) => {
      // A fired timer leaves the pending list, as a real one would.
      const handle = {
        ms,
        callback: () => {
          const index = pending.indexOf(handle);
          if (index >= 0) pending.splice(index, 1);
          callback();
        },
      };
      pending.push(handle);
      return handle;
    },
    clear: (handle: unknown) => {
      const index = pending.indexOf(handle as { callback: () => void; ms: number });
      if (index >= 0) pending.splice(index, 1);
    },
  };
}

function harness(options: { agent?: ReminderExecutor["runAgent"]; catchUpMs?: number; queueLimitMs?: number; enabled?: () => boolean } = {}) {
  const time = clock();
  const store = new ReminderStore(mkdtempSync(join(tmpdir(), "pistachio-scheduler-")), { now: time.now, timezone: () => DENVER });
  const notified: ReminderOccurrence[] = [];
  const runAgent = vi.fn<ReminderExecutor["runAgent"]>(
    options.agent ?? (async (request) => {
      request.onStarted("run-1");
      return { status: "completed", output: "All done", runId: "run-1" };
    }),
  );
  const executor: ReminderExecutor = {
    runAgent,
    notify: async (occurrence) => {
      notified.push(occurrence);
    },
  };
  const clockTimers = timers();
  const scheduler = new ReminderScheduler(store, executor, {
    now: time.now,
    timers: clockTimers,
    tickMs: 30_000,
    ...(options.catchUpMs === undefined ? {} : { catchUpMs: options.catchUpMs }),
    ...(options.queueLimitMs === undefined ? {} : { queueLimitMs: options.queueLimitMs }),
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  });
  return { time, store, scheduler, notified, runAgent, timers: clockTimers };
}

describe("ReminderScheduler", () => {
  it("delivers a message reminder when it comes due, once", async () => {
    const { time, store, scheduler, notified } = harness();
    const cookies = store.add(
      { title: "Cookies", schedule: { kind: "once", at: "2026-08-27T22:00:00.000Z" }, action: { kind: "message", text: "Take them out" } },
      USER,
    );
    await scheduler.tick();
    expect(notified).toEqual([]);
    time.set("2026-08-27T22:00:05.000Z");
    await scheduler.tick();
    await scheduler.tick();
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      reminderId: cookies.id,
      status: "delivered",
      output: "Take them out",
      scheduledFor: "2026-08-27T22:00:00.000Z",
      acknowledgedAt: null,
    });
    expect(store.get(cookies.id)?.status).toBe("done");
    expect(store.occurrences()).toHaveLength(1);
  });

  it("runs an agent task as a console run and records its answer", async () => {
    const { time, store, scheduler, notified, runAgent } = harness();
    const summary = store.add(
      { title: "Weekly summary", schedule: { kind: "weekly", days: [0], time: "08:00" }, action: { kind: "agent", prompt: "Summarize my week" } },
      USER,
    );
    time.set("2026-08-30T14:00:10.000Z");
    await scheduler.tick();
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0]?.[0]).toMatchObject({ reminderId: summary.id, title: "Weekly summary", prompt: "Summarize my week", scheduledFor: "2026-08-30T14:00:00.000Z" });
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ status: "completed", output: "All done", runId: "run-1", actionKind: "agent" });
    // The reminder rolled to next Sunday on its own.
    expect(store.get(summary.id)?.nextFireAt).toBe("2026-09-06T14:00:00.000Z");
  });

  it("queues an agent task while the console is busy and runs it once it frees up", async () => {
    let busy = true;
    const { time, store, scheduler, notified, runAgent } = harness({
      agent: async (request) => {
        if (busy) return { status: "busy" };
        request.onStarted("run-2");
        return { status: "completed", output: "Later, then", runId: "run-2" };
      },
    });
    store.add({ title: "Task", schedule: { kind: "once", at: "2026-08-27T22:00:00.000Z" }, action: { kind: "agent", prompt: "Do it" } }, USER);
    time.set("2026-08-27T22:00:01.000Z");
    await scheduler.tick();
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(scheduler.queued()).toBe(1);
    expect(store.occurrences()[0]?.status).toBe("queued");
    expect(notified).toEqual([]);
    busy = false;
    time.advance(60_000);
    await scheduler.tick();
    expect(scheduler.queued()).toBe(0);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ status: "completed", output: "Later, then", runId: "run-2" });
  });

  it("gives up on a task that waited too long, and one whose reminder was cancelled", async () => {
    const { time, store, scheduler, notified } = harness({ agent: async () => ({ status: "busy" }), queueLimitMs: 60 * 60_000 });
    const a = store.add({ title: "A", schedule: { kind: "once", at: "2026-08-27T22:00:00.000Z" }, action: { kind: "agent", prompt: "a" } }, USER);
    const b = store.add({ title: "B", schedule: { kind: "once", at: "2026-08-27T22:00:00.000Z" }, action: { kind: "agent", prompt: "b" } }, USER);
    time.set("2026-08-27T22:00:01.000Z");
    await scheduler.tick();
    expect(scheduler.queued()).toBe(2);
    store.cancel(b.id, USER);
    await scheduler.tick();
    expect(scheduler.queued()).toBe(1);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ reminderId: b.id, status: "missed", error: expect.stringMatching(/cancelled/) });
    time.advance(2 * 60 * 60_000);
    await scheduler.tick();
    expect(scheduler.queued()).toBe(0);
    expect(notified[1]).toMatchObject({ reminderId: a.id, status: "missed", error: expect.stringMatching(/busy/) });
  });

  it("keeps delivering while an agent task runs for as long as it likes", async () => {
    let finish: ((outcome: ScheduledAgentOutcome) => void) | null = null;
    const { time, store, scheduler, notified } = harness({
      agent: (request) =>
        new Promise<ScheduledAgentOutcome>((resolve) => {
          request.onStarted("run-long");
          finish = resolve;
        }),
    });
    store.add({ title: "Long task", schedule: { kind: "once", at: "2026-08-27T22:00:00.000Z" }, action: { kind: "agent", prompt: "Take your time" } }, USER);
    store.add({ title: "Cookies", schedule: { kind: "once", at: "2026-08-27T22:05:00.000Z" }, action: { kind: "message", text: "Take them out" } }, USER);
    time.set("2026-08-27T22:00:01.000Z");
    await scheduler.tick();
    expect(store.occurrences().find((o) => o.title === "Long task")?.status).toBe("running");
    // Five minutes into the task the cookies come due — and are delivered.
    time.set("2026-08-27T22:05:01.000Z");
    await scheduler.tick();
    expect(notified.map((o) => [o.title, o.status])).toEqual([["Cookies", "delivered"]]);
    finish!({ status: "completed", output: "Took a while", runId: "run-long" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await scheduler.tick();
    expect(notified.map((o) => [o.title, o.status])).toEqual([
      ["Cookies", "delivered"],
      ["Long task", "completed"],
    ]);
  });

  it("picks up what the last session left: queued tasks run, an interrupted one is settled", async () => {
    const { time, store, scheduler, notified, runAgent } = harness();
    const queued = store.add({ title: "Queued", schedule: { kind: "daily", time: "07:00" }, action: { kind: "agent", prompt: "q" } }, USER);
    const interrupted = store.add({ title: "Interrupted", schedule: { kind: "daily", time: "07:00" }, action: { kind: "agent", prompt: "i" } }, USER);
    const gone = store.add({ title: "Gone", schedule: { kind: "daily", time: "07:00" }, action: { kind: "agent", prompt: "g" } }, USER);
    // What a crashed session's file looks like: the reminders already advanced, the occurrences in flight.
    for (const reminder of [queued, interrupted, gone]) store.advance(reminder.id, new Date("2026-08-28T13:00:01.000Z"));
    store.openOccurrence({ reminder: queued, scheduledFor: "2026-08-28T13:00:00.000Z", status: "queued" });
    store.openOccurrence({ reminder: interrupted, scheduledFor: "2026-08-28T13:00:00.000Z", status: "running", startedAt: "2026-08-28T13:00:02.000Z" });
    store.openOccurrence({ reminder: gone, scheduledFor: "2026-08-28T13:00:00.000Z", status: "queued" });
    store.cancel(gone.id, USER);
    time.set("2026-08-28T13:05:00.000Z");
    await scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0]?.[0]).toMatchObject({ reminderId: queued.id });
    expect(notified.map((o) => [o.title, o.status])).toEqual([
      ["Interrupted", "failed"],
      ["Gone", "missed"],
      ["Queued", "completed"],
    ]);
    expect(notified[0]?.error).toMatch(/quit while/);
    scheduler.stop();
  });

  it("marks a fire it slept through as missed instead of firing late", async () => {
    const { time, store, scheduler, notified, runAgent } = harness({ catchUpMs: 15 * 60_000 });
    const teeth = store.add({ title: "Teeth", schedule: { kind: "daily", time: "07:00" }, action: { kind: "message", text: "Brush" } }, USER);
    const task = store.add({ title: "Task", schedule: { kind: "daily", time: "07:00" }, action: { kind: "agent", prompt: "Go" } }, USER);
    // Wakes at 09:00 the next morning: two hours late.
    time.set("2026-08-28T15:00:00.000Z");
    await scheduler.tick();
    expect(runAgent).not.toHaveBeenCalled();
    expect(notified.map((o) => [o.reminderId, o.status])).toEqual([
      [teeth.id, "missed"],
      [task.id, "missed"],
    ]);
    expect(notified[0]?.error).toMatch(/2 hours ago/);
    expect(store.get(teeth.id)?.nextFireAt).toBe("2026-08-29T13:00:00.000Z");
  });

  it("fires a little late within the catch-up window", async () => {
    const { time, store, scheduler, notified } = harness({ catchUpMs: 15 * 60_000 });
    store.add({ title: "Teeth", schedule: { kind: "daily", time: "07:00" }, action: { kind: "message", text: "Brush" } }, USER);
    time.set("2026-08-28T13:10:00.000Z");
    await scheduler.tick();
    expect(notified[0]?.status).toBe("delivered");
  });

  it("records a failed agent task with its error", async () => {
    const { time, store, scheduler, notified } = harness({
      agent: async (request) => {
        request.onStarted("run-3");
        return { status: "failed", error: "The page never loaded", runId: "run-3" } satisfies ScheduledAgentOutcome;
      },
    });
    store.add({ title: "Task", schedule: { kind: "once", at: "2026-08-27T22:00:00.000Z" }, action: { kind: "agent", prompt: "Go" } }, USER);
    time.set("2026-08-27T22:00:01.000Z");
    await scheduler.tick();
    expect(notified[0]).toMatchObject({ status: "failed", error: "The page never loaded", runId: "run-3" });
  });

  it("marks the occurrence running as soon as the run exists", async () => {
    let seen: ReminderOccurrence | null = null;
    const { time, store, scheduler } = harness({
      agent: async (request) => {
        request.onStarted("run-4");
        seen = store.occurrence(request.occurrenceId);
        return { status: "completed", output: "ok", runId: "run-4" };
      },
    });
    store.add({ title: "Task", schedule: { kind: "once", at: "2026-08-27T22:00:00.000Z" }, action: { kind: "agent", prompt: "Go" } }, USER);
    time.set("2026-08-27T22:00:01.000Z");
    await scheduler.tick();
    expect(seen).toMatchObject({ status: "running", runId: "run-4" });
    expect(store.occurrences()[0]).toMatchObject({ status: "completed", startedAt: expect.any(String), finishedAt: expect.any(String) });
  });

  it("does nothing while reminders are off, and nothing is marked missed either", async () => {
    let enabled = false;
    const { time, store, scheduler, notified, timers: pending } = harness({ enabled: () => enabled });
    store.add({ title: "Teeth", schedule: { kind: "daily", time: "07:00" }, action: { kind: "message", text: "Brush" } }, USER);
    time.set("2026-08-28T13:00:01.000Z");
    await scheduler.start();
    expect(notified).toEqual([]);
    expect(store.occurrences()).toEqual([]);
    // An overdue fire while off must not arm a zero-delay timer and spin.
    expect(pending.pending.at(-1)?.ms).toBe(30_000);
    enabled = true;
    await scheduler.tick();
    expect(notified).toHaveLength(1);
    scheduler.stop();
  });

  it("arms a timer for the next fire, never longer than a tick", async () => {
    const { time, store, scheduler, timers: pending } = harness();
    await scheduler.start();
    expect(pending.pending.at(-1)?.ms).toBe(30_000);
    store.add({ title: "Soon", schedule: { kind: "once", at: "2026-08-27T21:40:10.000Z" }, action: { kind: "message", text: "x" } }, USER);
    expect(pending.pending.at(-1)?.ms).toBe(10_000);
    time.advance(10_000);
    pending.pending.at(-1)!.callback();
    await scheduler.tick();
    expect(store.occurrences()[0]?.status).toBe("delivered");
    scheduler.stop();
    expect(pending.pending).toHaveLength(0);
  });
});
