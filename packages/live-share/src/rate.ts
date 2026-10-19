/**
 * A keyed token bucket (docs/live-share.md §6.1, §10): the host meters each
 * guest's input (240 events a second) and messages with one, and every end
 * the pings, reactions and chat it hears, so a participant who floods the
 * room loses their own excess and nobody else's.
 */

export interface RateLimiterOptions {
  /** Tokens added per second. */
  rate: number;
  /** The bucket's size: how many may go at once after a quiet spell. */
  burst: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

/**
 * How many of any one participant's pings, and of their reactions, are drawn
 * (§4): each is a node and a timer of its own in its layer, so wherever they
 * land — the host's window, or a guest's page, since guests hear each other
 * directly — 4 a second, 8 at once; the rest are dropped.
 */
export const MARK_RATE: Readonly<RateLimiterOptions> = { rate: 4, burst: 8 };

export class RateLimiter {
  readonly #rate: number;
  readonly #burst: number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(options: RateLimiterOptions) {
    if (!(options.rate > 0) || !(options.burst >= 1)) throw new RangeError("RateLimiter needs rate > 0 and burst >= 1");
    this.#rate = options.rate;
    this.#burst = options.burst;
  }

  /** Spend `cost` tokens of `key`'s bucket at `now` (ms); false (nothing spent) when there are not enough. */
  take(key: string, now: number, cost = 1): boolean {
    const bucket = this.#buckets.get(key) ?? { tokens: this.#burst, at: now };
    const elapsed = Math.max(0, now - bucket.at);
    bucket.tokens = Math.min(this.#burst, bucket.tokens + (elapsed / 1000) * this.#rate);
    bucket.at = Math.max(bucket.at, now);
    this.#buckets.set(key, bucket);
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  /** Drop a key's bucket (its participant left). */
  forget(key: string): void {
    this.#buckets.delete(key);
  }
}
