import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReportRecord } from "@pistachio/reports/contract";
import { BriefScheduler, briefDue, minutesOfDay, type BriefSchedulerDeps } from "../src/main/brief-scheduler";

const at = (hours: number, minutes = 0, day = 21): Date => new Date(2026, 8, day, hours, minutes);
const ON = { enabled: true, time: "07:00" };
const record = (spaceId: string): ReportRecord => ({ id: `brief:${spaceId}`, spaceId, title: "The Monday Brief" }) as ReportRecord;

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scheduler(overrides: Partial<BriefSchedulerDeps> = {}, dir?: string) {
  const userDataDir = dir ?? mkdtempSync(join(tmpdir(), "pistachio-brief-clock-"));
  if (dir === undefined) dirs.push(userDataDir);
  const calls: string[] = [];
  const clock = { now: at(8) };
  let generating = false;
  const made: string[] = [];
  const instance = new BriefScheduler({
    userDataDir,
    schedule: () => ON,
    spaceId: () => "work",
    hasBrief: () => false,
    generating: () => generating,
    askShell: (spaceId) => {
      calls.push(`ask ${spaceId}`);
      return true;
    },
    generate: (spaceId) => {
      calls.push(`generate ${spaceId}`);
      return Promise.resolve();
    },
    announce: (made_) => made.push(made_.title),
    now: () => clock.now,
    graceMs: 1000,
    ...overrides,
  });
  return { instance, calls, clock, made, userDataDir, setGenerating: (value: boolean) => (generating = value) };
}

describe("when a brief is due", () => {
  it("is due once the time has passed today, however late — a Mac asleep at seven catches up", () => {
    const base = { schedule: ON, attemptedDay: null, hasBrief: false };
    expect(briefDue({ ...base, now: at(6, 59) })).toBe(false);
    expect(briefDue({ ...base, now: at(7, 0) })).toBe(true);
    expect(briefDue({ ...base, now: at(15, 30) })).toBe(true);
  });

  it("is not due when off, already made, already tried today, or given a time that is not one", () => {
    const base = { schedule: ON, now: at(9), attemptedDay: null, hasBrief: false };
    expect(briefDue({ ...base, schedule: { ...ON, enabled: false } })).toBe(false);
    expect(briefDue({ ...base, hasBrief: true })).toBe(false);
    expect(briefDue({ ...base, attemptedDay: "2026-09-21" })).toBe(false);
    expect(briefDue({ ...base, attemptedDay: "2026-09-20" })).toBe(true);
    expect(briefDue({ ...base, schedule: { enabled: true, time: "7am" } })).toBe(false);
    expect(minutesOfDay("23:59")).toBe(1439);
    expect(minutesOfDay("24:00")).toBeNull();
  });
});

describe("BriefScheduler", () => {
  it("asks the shell first, and announces the brief the shell then makes", () => {
    vi.useFakeTimers();
    const { instance, calls, made, setGenerating } = scheduler();
    instance.tick();
    expect(calls).toEqual(["ask work"]);
    // The shell started generating inside the grace period, so main stays out of it.
    setGenerating(true);
    vi.advanceTimersByTime(1500);
    expect(calls).toEqual(["ask work"]);
    instance.generated(record("work"));
    expect(made).toEqual(["The Monday Brief"]);
  });

  it("makes the brief itself when the shell never starts, or there is no shell to ask", () => {
    vi.useFakeTimers();
    const silent = scheduler();
    silent.instance.tick();
    vi.advanceTimersByTime(1500);
    expect(silent.calls).toEqual(["ask work", "generate work"]);

    const windowless = scheduler({ askShell: () => false });
    windowless.instance.tick();
    expect(windowless.calls).toEqual(["generate work"]);
  });

  it("tries once a day and remembers that across a restart", () => {
    const first = scheduler({ askShell: () => false });
    first.instance.tick();
    first.instance.tick();
    expect(first.calls).toEqual(["generate work"]);

    const restarted = scheduler({ askShell: () => false }, first.userDataDir);
    restarted.instance.tick();
    expect(restarted.calls).toEqual([]);
    // Tomorrow is a new day.
    restarted.clock.now = at(7, 5, 22);
    restarted.instance.tick();
    expect(restarted.calls).toEqual(["generate work"]);
  });

  it("stays quiet about briefs it did not ask for, and does nothing before the hour or without a Space", () => {
    const { instance, made, calls, clock } = scheduler();
    instance.generated(record("work"));
    expect(made).toEqual([]);
    clock.now = at(6);
    instance.tick();
    expect(calls).toEqual([]);
    const nowhere = scheduler({ spaceId: () => null });
    nowhere.instance.tick();
    expect(nowhere.calls).toEqual([]);
  });

  it("does not announce a brief whose generation failed", async () => {
    const errors: unknown[] = [];
    const { instance, made } = scheduler({ askShell: () => false, generate: () => Promise.reject(new Error("offline")), onError: (error) => errors.push(error) });
    instance.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    instance.generated(record("work"));
    expect(made).toEqual([]);
  });
});
