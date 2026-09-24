/**
 * Connection-level metering — and nothing else (docs/cloud-sync-design.md §9).
 *
 * Numeric only, by construction: {@link ConnectionSample} and
 * {@link UserTotals} have no field a hostname *could* be written into. The
 * single string in this module is the user id a sample is keyed by. Totals
 * are flushed every 60 s to control's `POST /v1/usage/egress`.
 */

import { METRICS_FLUSH_INTERVAL_MS, silentLogger, type Logger } from "./config.js";
import type { ControlClient } from "./control.js";

/** One finished tunnel, reduced to the only facts the gateway may keep. */
export interface ConnectionSample {
  readonly bytesToTarget: number;
  readonly bytesToClient: number;
  readonly durationMs: number;
}

/** Running per-user totals. */
export interface UserTotals {
  readonly connections: number;
  readonly bytesToTarget: number;
  readonly bytesToClient: number;
  readonly activeMillis: number;
}

const ZERO: UserTotals = { connections: 0, bytesToTarget: 0, bytesToClient: 0, activeMillis: 0 };

function add(a: UserTotals, b: UserTotals): UserTotals {
  return {
    connections: a.connections + b.connections,
    bytesToTarget: a.bytesToTarget + b.bytesToTarget,
    bytesToClient: a.bytesToClient + b.bytesToClient,
    activeMillis: a.activeMillis + b.activeMillis,
  };
}

/** Per-user counters keyed by the authenticated user id. */
export class EgressMetrics {
  readonly #users = new Map<string, UserTotals>();

  record(userId: string, sample: ConnectionSample): void {
    this.merge(userId, {
      connections: 1,
      bytesToTarget: sample.bytesToTarget,
      bytesToClient: sample.bytesToClient,
      activeMillis: Math.max(0, Math.round(sample.durationMs)),
    });
  }

  /** Add already-aggregated totals (used to put back a failed flush). */
  merge(userId: string, totals: UserTotals): void {
    this.#users.set(userId, add(this.#users.get(userId) ?? ZERO, totals));
  }

  totals(userId: string): UserTotals | null {
    return this.#users.get(userId) ?? null;
  }

  /** Take every user's totals and reset the accumulator. */
  drain(): Map<string, UserTotals> {
    const drained = new Map(this.#users);
    this.#users.clear();
    return drained;
  }

  get size(): number {
    return this.#users.size;
  }
}

/** The body of one `POST /v1/usage/egress`: one user, one flush window. */
export interface UsageReport extends UserTotals {
  readonly userId: string;
  /** Epoch milliseconds bounding the window the totals were collected in. */
  readonly periodStart: number;
  readonly periodEnd: number;
  /** `bytesToTarget + bytesToClient`. */
  readonly proxiedBytes: number;
}

export interface MetricsFlusherOptions {
  readonly metrics: EgressMetrics;
  readonly control: ControlClient;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly log?: Logger;
}

/** Flushes {@link EgressMetrics} to control on an interval. */
export class MetricsFlusher {
  readonly #metrics: EgressMetrics;
  readonly #control: ControlClient;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #log: Logger;
  #periodStart: number;
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> | null = null;

  constructor(options: MetricsFlusherOptions) {
    this.#metrics = options.metrics;
    this.#control = options.control;
    this.#intervalMs = options.intervalMs ?? METRICS_FLUSH_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? silentLogger;
    this.#periodStart = this.#now();
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.flushNow(), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Flush every user's totals now. A failed report is merged back so the
   * bytes are retried with the next window rather than lost.
   */
  flushNow(): Promise<void> {
    if (this.#inFlight !== null) return this.#inFlight;
    this.#inFlight = this.#flush().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #flush(): Promise<void> {
    const periodEnd = this.#now();
    const periodStart = this.#periodStart;
    this.#periodStart = periodEnd;
    const drained = this.#metrics.drain();
    for (const [userId, totals] of drained) {
      if (totals.connections === 0 && totals.bytesToTarget === 0 && totals.bytesToClient === 0) {
        continue;
      }
      const report: UsageReport = {
        userId,
        periodStart,
        periodEnd,
        proxiedBytes: totals.bytesToTarget + totals.bytesToClient,
        ...totals,
      };
      try {
        await this.#control.post("/v1/usage/egress", report);
      } catch (error) {
        this.#metrics.merge(userId, totals);
        this.#log.warn(`usage flush failed: ${describe(error)}`);
      }
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
