/**
 * Pure abuse controls: fixed-window limiters the routes ask before doing
 * work. The clock is injected so every rule is unit-testable.
 */

export const PASSWORD_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const PASSWORD_ATTEMPT_LIMIT = 10;
/** Each allowed request is an outbound email — budget tighter than guesses. */
export const PASSWORD_RESET_REQUEST_LIMIT = 3;

/** Fixed-window guard on online password guessing, keyed per email. */
export class PasswordAttemptLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit = PASSWORD_ATTEMPT_LIMIT,
    private readonly windowMs = PASSWORD_ATTEMPT_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  allow(key: string): boolean {
    const now = this.now();
    const entry = this.hits.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

/** Channel ingress: 60 deliveries per minute per link (§7.3). */
export const CHANNEL_INBOUND_LIMIT = 60;
export const CHANNEL_INBOUND_WINDOW_MS = 60_000;

export function channelInboundLimiter(now?: () => number): PasswordAttemptLimiter {
  return new PasswordAttemptLimiter(CHANNEL_INBOUND_LIMIT, CHANNEL_INBOUND_WINDOW_MS, now);
}
