import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/index.js";

describe("RateLimiter", () => {
  it("lets a burst through, then the refill rate, per key", () => {
    const limiter = new RateLimiter({ rate: 10, burst: 3 });
    expect([1, 2, 3, 4].map(() => limiter.take("a", 0))).toEqual([true, true, true, false]);
    expect(limiter.take("b", 0)).toBe(true);
    expect(limiter.take("a", 50)).toBe(false);
    expect(limiter.take("a", 100)).toBe(true);
    expect(limiter.take("a", 100)).toBe(false);
    // Never more than the burst, however long the quiet.
    expect([1, 2, 3, 4].map(() => limiter.take("a", 60_000))).toEqual([true, true, true, false]);
  });

  it("charges a cost and forgets a key", () => {
    const limiter = new RateLimiter({ rate: 1, burst: 5 });
    expect(limiter.take("a", 0, 5)).toBe(true);
    expect(limiter.take("a", 0)).toBe(false);
    limiter.forget("a");
    expect(limiter.take("a", 0, 5)).toBe(true);
  });

  it("refuses a nonsense configuration", () => {
    expect(() => new RateLimiter({ rate: 0, burst: 1 })).toThrow(RangeError);
  });
});
