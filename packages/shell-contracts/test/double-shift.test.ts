import { describe, expect, it } from "vitest";
import { DoubleTap, DOUBLE_TAP_WINDOW_MS, MAX_TAP_HOLD_MS, type TapInput } from "../src/double-shift.js";

const down = (key = "Shift", extra: Partial<TapInput> = {}): TapInput => ({ type: "keyDown", key, ...extra });
const up = (key = "Shift", extra: Partial<TapInput> = {}): TapInput => ({ type: "keyUp", key, ...extra });

/** Feed a sequence of [event, at] and report which ones fired. */
function fires(sequence: Array<[TapInput, number]>): number[] {
  const detector = new DoubleTap("Shift");
  const out: number[] = [];
  for (const [input, at] of sequence) if (detector.press(input, at)) out.push(at);
  return out;
}

describe("DoubleTap", () => {
  it("fires only after the second tap is released, within the window", () => {
    expect(fires([[down(), 0], [up(), 80], [down(), 200], [up(), 260]])).toEqual([260]);
  });

  it("does not fire twice for one gesture, and a third tap starts over", () => {
    expect(fires([[down(), 0], [up(), 80], [down(), 200], [up(), 260], [down(), 400], [up(), 450]])).toEqual([260]);
    expect(fires([[down(), 0], [up(), 80], [down(), 200], [up(), 260], [down(), 400], [up(), 450], [down(), 600], [up(), 650]])).toEqual([260, 650]);
  });

  it("waits no longer than the window", () => {
    expect(fires([[down(), 0], [up(), 80], [down(), 80 + DOUBLE_TAP_WINDOW_MS + 1], [up(), 100 + DOUBLE_TAP_WINDOW_MS]])).toEqual([]);
    expect(fires([[down(), 0], [up(), 80], [down(), 80 + DOUBLE_TAP_WINDOW_MS], [up(), 100 + DOUBLE_TAP_WINDOW_MS]])).toEqual([100 + DOUBLE_TAP_WINDOW_MS]);
    // An expired pair still leaves a valid first tap for the next gesture.
    expect(fires([[down(), 0], [up(), 80], [down(), 500], [up(), 550], [down(), 600], [up(), 650]])).toEqual([650]);
  });

  it("counts a hold as no tap", () => {
    expect(fires([[down(), 0], [up(), MAX_TAP_HOLD_MS + 50], [down(), MAX_TAP_HOLD_MS + 100], [up(), MAX_TAP_HOLD_MS + 150]])).toEqual([]);
    // Auto-repeat while held is a hold too.
    expect(fires([[down(), 0], [{ ...down(), isAutoRepeat: true }, 500], [up(), 600], [down(), 700], [up(), 750]])).toEqual([]);
    // The second press must also be a tap, rather than a hold or repeat.
    expect(fires([[down(), 0], [up(), 80], [down(), 200], [up(), 200 + MAX_TAP_HOLD_MS + 1]])).toEqual([]);
    expect(fires([[down(), 0], [up(), 80], [down(), 200], [down("Shift", { isAutoRepeat: true }), 220], [up(), 260]])).toEqual([]);
  });

  it("is not typing a capital letter or a shifted shortcut", () => {
    // ⇧A ⇧B: shift down, a, shift up, shift down, b — two shifts, never a double tap.
    expect(fires([[down(), 0], [down("a"), 40], [up("a"), 90], [up(), 120], [down(), 200], [down("b"), 240], [up("b"), 280], [up(), 300]])).toEqual([]);
    // ⌘⇧R then ⇧: the modifier makes the first press a chord.
    expect(fires([[down("Shift", { meta: true }), 0], [up("Shift", { meta: true }), 60], [down(), 200], [up(), 250]])).toEqual([]);
  });

  it("does not mistake a tap followed by a capital or shortcut for two taps", () => {
    expect(fires([[down(), 0], [up(), 80], [down(), 200], [down("A"), 220], [up("A"), 240], [up(), 260]])).toEqual([]);
    // Shift can go down before Command, so checking modifiers on press is too early.
    expect(fires([[down(), 0], [up(), 80], [down(), 200], [down("Meta", { meta: true }), 220], [up("Meta"), 240], [up(), 260]])).toEqual([]);
  });

  it("cancels for any other keystroke between taps, including a release", () => {
    for (const input of [down("a"), up("a"), down("Meta"), up("Meta")]) {
      expect(fires([[down(), 0], [up(), 80], [input, 100], [down(), 200], [up(), 260]])).toEqual([]);
    }
  });

  it("does not count taps while another key is already held", () => {
    expect(fires([[down("a"), 0], [down(), 20], [up(), 80], [down(), 200], [up(), 260], [up("a"), 300]])).toEqual([]);
  });

  it("rejects overlapping Shift presses and duplicate key-down events", () => {
    expect(fires([[down(), 0], [up(), 80], [down(), 200], [down(), 220], [up(), 260]])).toEqual([]);
    const left = { code: "ShiftLeft" };
    const right = { code: "ShiftRight" };
    expect(fires([[down("Shift", left), 0], [down("Shift", right), 20], [up("Shift", left), 40], [up("Shift", right), 60], [down("Shift", left), 100], [up("Shift", left), 150]])).toEqual([]);
    // Alternating sides is fine when both presses are standalone taps.
    expect(fires([[down("Shift", left), 0], [up("Shift", left), 80], [down("Shift", right), 200], [up("Shift", right), 260]])).toEqual([260]);
  });

  it("allows a clean gesture after another modifier's release", () => {
    // Releasing ⌘ after a shortcut, then tapping shift twice.
    expect(fires([[up("Meta"), 0], [down(), 100], [up(), 150], [down(), 300], [up(), 350]])).toEqual([350]);
  });

  it("reads DOM-style modifier names too", () => {
    expect(fires([[{ type: "keyDown", key: "Shift", ctrlKey: true }, 0], [up(), 50], [down(), 150], [up(), 200]])).toEqual([]);
  });

  it("forgets everything on reset", () => {
    const detector = new DoubleTap("Shift");
    detector.press(down(), 0);
    detector.press(up(), 50);
    detector.reset();
    expect(detector.press(down(), 100)).toBe(false);
    expect(detector.press(up(), 150)).toBe(false);
    expect(detector.press(down(), 200)).toBe(false);
    expect(detector.press(up(), 250)).toBe(true);
    // Losing focus may also lose the release of a held key.
    detector.press(down("a"), 300);
    detector.reset();
    detector.press(down(), 400);
    detector.press(up(), 450);
    detector.press(down(), 500);
    expect(detector.press(up(), 550)).toBe(true);
  });
});
