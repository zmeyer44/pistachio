/**
 * Per-user throttle signal (docs/cloud-sync-design.md §9): poll
 * `GET /v1/egress/limits?userId=<id>` every 60 s; a throttled user's
 * CONNECTs are answered 429 until control clears the flag. Users polled are
 * the pinned owner, every user with a live tunnel, every user that
 * authenticated since the last poll, and every user currently throttled (so
 * un-throttling is observed). Control has no batch route, so a poll is one
 * request per candidate, run {@link LIMITS_POLL_CONCURRENCY} at a time rather
 * than strictly one after another. When control is unreachable the last known
 * state is kept.
 */

import { LIMITS_POLL_INTERVAL_MS, silentLogger, type Logger } from "./config.js";
import { isRecord, type ControlClient } from "./control.js";
import type { TunnelRegistry } from "./tunnels.js";

/** Concurrent `GET /v1/egress/limits` requests per poll. */
export const LIMITS_POLL_CONCURRENCY = 8;

/** What the server consults before opening a tunnel. */
export interface ThrottleSource {
  isThrottled(userId: string): boolean;
  /** Called on every successful authentication. */
  noteUser(userId: string): void;
}

export interface UserLimits {
  readonly throttled: boolean;
}

/** Validate `{userId?, throttled: boolean}`. */
export function parseLimits(json: unknown): UserLimits | null {
  if (!isRecord(json) || typeof json.throttled !== "boolean") return null;
  return { throttled: json.throttled };
}

export interface LimitsPollerOptions {
  readonly control: ControlClient;
  readonly ownerUserId?: string | null;
  readonly tunnels?: TunnelRegistry;
  readonly intervalMs?: number;
  readonly log?: Logger;
}

export class LimitsPoller implements ThrottleSource {
  readonly #control: ControlClient;
  readonly #ownerUserId: string | null;
  readonly #tunnels: TunnelRegistry | null;
  readonly #intervalMs: number;
  readonly #log: Logger;
  readonly #throttled = new Set<string>();
  readonly #seen = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> | null = null;

  constructor(options: LimitsPollerOptions) {
    this.#control = options.control;
    this.#ownerUserId = options.ownerUserId ?? null;
    this.#tunnels = options.tunnels ?? null;
    this.#intervalMs = options.intervalMs ?? LIMITS_POLL_INTERVAL_MS;
    this.#log = options.log ?? silentLogger;
  }

  noteUser(userId: string): void {
    this.#seen.add(userId);
  }

  isThrottled(userId: string): boolean {
    return this.#throttled.has(userId);
  }

  /** Users that will be asked about on the next poll. */
  candidates(): string[] {
    const users = new Set<string>(this.#seen);
    for (const userId of this.#throttled) users.add(userId);
    if (this.#ownerUserId !== null) users.add(this.#ownerUserId);
    if (this.#tunnels !== null) for (const userId of this.#tunnels.activeUsers()) users.add(userId);
    return [...users];
  }

  start(): void {
    if (this.#timer !== null) return;
    void this.pollNow();
    this.#timer = setInterval(() => void this.pollNow(), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Refresh the throttle state of every candidate user. Never throws. */
  pollNow(): Promise<void> {
    if (this.#inFlight !== null) return this.#inFlight;
    this.#inFlight = this.#poll().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #poll(): Promise<void> {
    const users = this.candidates();
    this.#seen.clear();
    await forEachConcurrent(users, LIMITS_POLL_CONCURRENCY, async (userId) => {
      let json: unknown;
      try {
        json = await this.#control.get("/v1/egress/limits", { userId });
      } catch (error) {
        this.#log.warn(`limits poll failed: ${describe(error)}`);
        return;
      }
      const limits = parseLimits(json);
      if (limits === null) {
        this.#log.warn("limits poll returned an unexpected body");
        return;
      }
      // Each user is asked about once per poll, so concurrent workers never
      // touch the same key and last-write-wins is not in play.
      if (limits.throttled) this.#throttled.add(userId);
      else this.#throttled.delete(userId);
    });
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight. Control has no
 * batch limits route, so one poll is one request per candidate user — strictly
 * sequential that is a fleet-sized stall behind a slow control plane, and
 * unbounded it is a burst of connections at every tick.
 */
export async function forEachConcurrent<T>(
  items: ReadonlyArray<T>,
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index] as T);
    }
  });
  await Promise.all(workers);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
