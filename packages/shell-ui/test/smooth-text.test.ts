/**
 * The pacing of a streamed reply (lib/smooth-text.ts): the reveal follows
 * the backlog, never stalls, and lands on word boundaries.
 */

import { describe, expect, it } from "vitest";
import { advanceReveal, MIN_CHARS_PER_SECOND, revealCut, SETTLE_CHARS_PER_SECOND } from "../src/lib/smooth-text";

describe("advanceReveal", () => {
  it("always moves forward while there is a backlog, and never past it", () => {
    expect(advanceReveal(0, 100, 0.1, true)).toBe(1);
    expect(advanceReveal(99, 100, 1000, true)).toBe(100);
    expect(advanceReveal(100, 100, 16, true)).toBe(100);
  });

  it("snaps back when the text was replaced", () => {
    expect(advanceReveal(50, 10, 16, true)).toBe(10);
  });

  it("closes a large backlog faster than a small one, and never below a reading pace", () => {
    const large = advanceReveal(0, 1000, 16, true);
    const small = advanceReveal(0, 20, 16, true);
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThanOrEqual(Math.round((MIN_CHARS_PER_SECOND * 16) / 1000));
  });

  it("settles quickly once the stream is over", () => {
    expect(advanceReveal(0, 500, 100, false)).toBeGreaterThanOrEqual(Math.round((SETTLE_CHARS_PER_SECOND * 100) / 1000));
  });
});

describe("revealCut", () => {
  it("cuts on a word boundary, unless the rest is one word", () => {
    expect(revealCut("hello there world", 8)).toBe(6);
    expect(revealCut("hello there world", 11)).toBe(11);
    expect(revealCut("hello there world", 40)).toBe(17);
    expect(revealCut("hello", 3)).toBe(3);
  });

  it("never splits a surrogate pair", () => {
    const text = "a 😀 b";
    expect(revealCut(text, 3)).toBe(2);
  });
});
