/**
 * The daily brief's clock (docs/reports.md "The morning brief"): at the time
 * Settings → General names, make today's brief for the Space in front and say
 * it is ready.
 *
 * A brief wants the home page's to-dos, and only the shell has those. So a
 * due brief is first *asked of the shell* (`prepareBrief`), which generates
 * through the usual bridge with fresh materials; if no generation has started
 * a few seconds later — no window, a shell still loading — main makes it
 * itself from the materials the shell last sent. Either way the scheduler
 * hears about the finished brief through `generated` and announces it.
 *
 * A Mac asleep at the hour catches up on waking: the rule is "the time has
 * passed today and there is no brief yet", not "it is exactly 7:00". One
 * attempt a day, remembered on disk, so a failure is not retried in a loop.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReportRecord } from "@pistachio/reports/contract";

export const BRIEF_TICK_MS = 30_000;
/** How long the shell has to start the generation it was asked for before main does it alone. */
export const BRIEF_SHELL_GRACE_MS = 20_000;

export interface BriefSchedule {
  enabled: boolean;
  /** Local wall-clock time, `HH:MM`. */
  time: string;
}

export interface BriefSchedulerDeps {
  userDataDir: string;
  schedule: () => BriefSchedule;
  /** The Space in front, or null before a window exists. */
  spaceId: () => string | null;
  hasBrief: (spaceId: string, date: string) => boolean;
  generating: (spaceId: string) => boolean;
  /** Ask a shell to make the brief with its own fresh materials. False when there is no shell to ask. */
  askShell: (spaceId: string) => boolean;
  /** Make it here, from the materials a shell last sent. */
  generate: (spaceId: string) => Promise<unknown>;
  announce: (record: ReportRecord) => void;
  now?: () => Date;
  graceMs?: number;
  onError?: (error: unknown) => void;
}

/** `HH:MM` as minutes past midnight, or null when it is not a time. */
export function minutesOfDay(time: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(time);
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

export function localDate(now: Date): string {
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Whether today's brief should be made now. Pure, so the rule is testable without a clock. */
export function briefDue(input: { schedule: BriefSchedule; now: Date; attemptedDay: string | null; hasBrief: boolean }): boolean {
  if (!input.schedule.enabled || input.hasBrief) return false;
  const at = minutesOfDay(input.schedule.time);
  if (at === null) return false;
  if (input.attemptedDay === localDate(input.now)) return false;
  return input.now.getHours() * 60 + input.now.getMinutes() >= at;
}

export class BriefScheduler {
  readonly #deps: BriefSchedulerDeps;
  readonly #path: string;
  /** Spaces whose next finished brief is this scheduler's doing, and so gets announced. */
  readonly #awaiting = new Set<string>();
  #attemptedDay: string | null;
  #timer: NodeJS.Timeout | null = null;
  #grace: NodeJS.Timeout | null = null;

  constructor(deps: BriefSchedulerDeps) {
    this.#deps = deps;
    this.#path = join(deps.userDataDir, "briefs", "schedule.json");
    this.#attemptedDay = this.#read();
  }

  /** The first look waits for the window: a shell that has just launched is the better maker. */
  start(initialDelayMs = 8_000): void {
    this.stop();
    const first = setTimeout(() => this.tick(), initialDelayMs);
    first.unref();
    this.#timer = setInterval(() => this.tick(), BRIEF_TICK_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    if (this.#grace !== null) clearTimeout(this.#grace);
    this.#timer = null;
    this.#grace = null;
  }

  /** Called on every tick, on wake and unlock, and when the setting changes. */
  tick(): void {
    const spaceId = this.#deps.spaceId();
    if (spaceId === null) return;
    const now = this.#deps.now?.() ?? new Date();
    const today = localDate(now);
    if (!briefDue({ schedule: this.#deps.schedule(), now, attemptedDay: this.#attemptedDay, hasBrief: this.#deps.hasBrief(spaceId, today) })) return;

    this.#attemptedDay = today;
    this.#write(today);
    this.#awaiting.add(spaceId);
    const alone = () => {
      this.#grace = null;
      if (!this.#awaiting.has(spaceId) || this.#deps.generating(spaceId)) return;
      void this.#deps.generate(spaceId).catch((error: unknown) => {
        this.#awaiting.delete(spaceId);
        this.#deps.onError?.(error);
      });
    };
    if (!this.#deps.askShell(spaceId)) {
      alone();
      return;
    }
    this.#grace = setTimeout(alone, this.#deps.graceMs ?? BRIEF_SHELL_GRACE_MS);
    this.#grace.unref();
  }

  /** Every finished brief passes through here; only one this scheduler asked for is announced. */
  generated(record: ReportRecord): void {
    if (!this.#awaiting.delete(record.spaceId)) return;
    this.#deps.announce(record);
  }

  #read(): string | null {
    try {
      const value = (JSON.parse(readFileSync(this.#path, "utf8")) as { attemptedDay?: unknown }).attemptedDay;
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }

  #write(day: string): void {
    try {
      mkdirSync(join(this.#deps.userDataDir, "briefs"), { recursive: true, mode: 0o700 });
      writeFileSync(`${this.#path}.tmp`, JSON.stringify({ attemptedDay: day }), { mode: 0o600 });
      renameSync(`${this.#path}.tmp`, this.#path);
    } catch (error) {
      this.#deps.onError?.(error);
    }
  }
}
