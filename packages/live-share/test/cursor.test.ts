import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_GLIDE_TAU_MS, CURSOR_SEND_INTERVAL_MS, CursorSmoother, CursorThrottle, type LiveCursor } from "../src/index.js";

const at = (x: number, y: number, extra: Partial<{ down: boolean }> = {}): LiveCursor => ({ x, y, tool: "pointer", ...extra });

describe("CursorSmoother", () => {
  it("shows a new pointer where it is, then glides toward each sample", () => {
    const smoother = new CursorSmoother();
    smoother.push("a", at(0.1, 0.1), 0);
    expect(smoother.sample(0)).toEqual([{ id: "a", x: 0.1, y: 0.1, tool: "pointer", down: false, opacity: 1 }]);
    smoother.push("a", at(0.5, 0.1), 0);
    const x16 = smoother.sample(16)[0]!.x;
    expect(x16).toBeGreaterThan(0.1);
    expect(x16).toBeLessThan(0.5);
    // Within ~24 ms it has closed 95% of the way.
    expect(smoother.sample(24)[0]!.x).toBeGreaterThan(0.1 + 0.4 * 0.95 - 1e-9);
    expect(smoother.sample(400)[0]!.x).toBeCloseTo(0.5, 6);
  });

  it("lands in the same place at 30, 60 and 144 frames a second", () => {
    const positions = [30, 60, 144].map((fps) => {
      const smoother = new CursorSmoother();
      smoother.push("a", at(0, 0), 0);
      smoother.push("a", at(1, 1), 0);
      for (let t = 1000 / fps; t < 20; t += 1000 / fps) smoother.sample(t);
      return smoother.sample(20)[0]!.x;
    });
    // Mid-glide, so a frame-rate dependence would show.
    expect(positions[0]).toBeLessThan(0.95);
    expect(positions[1]).toBeCloseTo(positions[0]!, 6);
    expect(positions[2]).toBeCloseTo(positions[0]!, 6);
  });

  it("fades a pointer still for 5 s, and brings it back when it moves", () => {
    const smoother = new CursorSmoother();
    smoother.push("a", at(0.2, 0.2), 0);
    // A sample at the same place keeps it alive but does not count as moving.
    smoother.push("a", at(0.2, 0.2), 4000);
    expect(smoother.sample(4999)[0]!.opacity).toBe(1);
    expect(smoother.sample(5150)[0]!.opacity).toBeCloseTo(0.5);
    expect(smoother.sample(5400)).toEqual([]);
    expect(smoother.animating(5400)).toBe(false);
    smoother.push("a", at(0.3, 0.2), 6000);
    expect(smoother.sample(6000)[0]!.opacity).toBe(1);
  });

  it("is still the moment every pointer rests, and says when one will begin to fade", () => {
    const smoother = new CursorSmoother();
    smoother.push("a", at(0.2, 0.2), 0);
    smoother.push("a", at(0.6, 0.2), 1000);
    expect(smoother.animating(1000)).toBe(true);
    smoother.sample(1100);
    // Arrived: nothing to draw until the rest fade, 5 s after the move — not 5.3 s of frames.
    expect(smoother.animating(1100)).toBe(false);
    expect(smoother.nextChange(1100)).toBe(6000);
    expect(smoother.animating(6000)).toBe(true);
    expect(smoother.animating(6299)).toBe(true);
    expect(smoother.animating(6300)).toBe(false);
    expect(smoother.nextChange(6300)).toBeNull();
    // A hide fades for 150 ms, then nothing.
    smoother.push("b", at(0.5, 0.5), 7000);
    smoother.push("b", { hidden: true }, 7000);
    expect(smoother.animating(7100)).toBe(true);
    expect(smoother.animating(7150)).toBe(false);
  });

  it("fades out on hide and reappears at the new place, not gliding from the old", () => {
    const smoother = new CursorSmoother();
    smoother.push("a", at(0.2, 0.2), 0);
    smoother.push("a", { hidden: true }, 100);
    expect(smoother.sample(175)[0]!.opacity).toBeCloseTo(0.5);
    expect(smoother.sample(300)).toEqual([]);
    smoother.push("a", at(0.9, 0.9, { down: true }), 400);
    expect(smoother.sample(400)).toEqual([{ id: "a", x: 0.9, y: 0.9, tool: "pointer", down: true, opacity: 1 }]);
  });

  it("forgets a pointer after 30 s without a sample, or at once when removed", () => {
    const smoother = new CursorSmoother();
    smoother.push("a", at(0.2, 0.2), 0);
    smoother.push("b", at(0.4, 0.4), 0);
    smoother.remove("b");
    expect(smoother.sample(10).map((c) => c.id)).toEqual(["a"]);
    smoother.sample(30_001);
    // Forgotten: a new sample shows at once, as a new pointer would.
    smoother.push("a", at(0.6, 0.6), 30_002);
    expect(smoother.sample(30_002)[0]).toMatchObject({ x: 0.6, y: 0.6, opacity: 1 });
  });
});

describe("CursorThrottle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function throttle() {
    const sent: LiveCursor[] = [];
    const t = new CursorThrottle({ send: (c) => sent.push(c), stageSize: () => ({ w: 1000, h: 1000 }) });
    return { sent, t };
  }

  it("sends at most every 16 ms and always the last position", () => {
    const { sent, t } = throttle();
    t.update({ x: 0.1, y: 0.1, tool: "pointer" }, 0);
    t.update({ x: 0.2, y: 0.1, tool: "pointer" }, 5);
    t.update({ x: 0.3, y: 0.1, tool: "pointer" }, 10);
    expect(sent).toEqual([{ x: 0.1, y: 0.1, tool: "pointer" }]);
    vi.advanceTimersByTime(16);
    expect(sent).toEqual([
      { x: 0.1, y: 0.1, tool: "pointer" },
      { x: 0.3, y: 0.1, tool: "pointer" },
    ]);
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(2);
  });

  it("ignores moves under half a stage pixel, but not a press", () => {
    const { sent, t } = throttle();
    t.update({ x: 0.5, y: 0.5, tool: "pointer" }, 0);
    t.update({ x: 0.5003, y: 0.5, tool: "pointer" }, 100);
    expect(sent).toHaveLength(1);
    t.update({ x: 0.5003, y: 0.5, tool: "pointer", down: true }, 200);
    expect(sent.at(-1)).toEqual({ x: 0.5003, y: 0.5, tool: "pointer", down: true });
  });

  it("sends a hide once", () => {
    const { sent, t } = throttle();
    t.update({ x: 0.5, y: 0.5, tool: "pen" }, 0);
    t.update(null, 100);
    t.update(null, 200);
    expect(sent).toEqual([{ x: 0.5, y: 0.5, tool: "pen" }, { hidden: true }]);
  });

  it("drops a held move once the pointer is back where it was sent", () => {
    const { sent, t } = throttle();
    t.update({ x: 0.5, y: 0.5, tool: "pointer" }, 0);
    t.update({ x: 0.6, y: 0.5, tool: "pointer" }, 5);
    t.update({ x: 0.5, y: 0.5, tool: "pointer" }, 10);
    vi.advanceTimersByTime(50);
    expect(sent).toHaveLength(1);
  });
});

describe("pointer lag, sender to screen", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * The host's pointer as guests see it, on one machine (no network): main
   * reads it every 16 ms, the throttle sends it, the smoother glides it on a
   * 120 Hz display. The pointer crosses the stage at a steady 0.6 widths a
   * second; lag is how far behind the drawn pointer is, in ms of travel.
   */
  function lag(throttleMs: number, glideTauMs: number): { mean: number; p95: number } {
    vi.setSystemTime(0);
    const speed = 0.6 / 1000;
    const smoother = new CursorSmoother({ glideTauMs });
    const throttle = new CursorThrottle({
      send: (cursor) => smoother.push("host", cursor, Date.now()),
      stageSize: () => ({ w: 1440, h: 900 }),
      intervalMs: throttleMs,
    });
    const lags: number[] = [];
    const frameMs = 1000 / 120;
    let nextFrame = 0;
    for (let t = 0; t <= 1600; t += 1) {
      if (t > 0) vi.advanceTimersByTime(1);
      if (t % 16 === 3) throttle.update({ x: speed * t, y: 0.5, tool: "pointer" }, t);
      if (t >= nextFrame) {
        nextFrame += frameMs;
        const drawn = smoother.sample(t)[0];
        if (drawn !== undefined && t >= 400) lags.push((speed * t - drawn.x) / speed);
      }
    }
    throttle.dispose();
    lags.sort((a, b) => a - b);
    return { mean: lags.reduce((sum, each) => sum + each, 0) / lags.length, p95: lags[Math.floor(lags.length * 0.95)]! };
  }

  it("adds about 12 ms where a 33 ms throttle and an 80 ms glide added about 47", () => {
    const before = lag(33, 80 / 3);
    const after = lag(CURSOR_SEND_INTERVAL_MS, CURSOR_GLIDE_TAU_MS);
    const ms = (value: number) => value.toFixed(1);
    console.log(`pointer lag before: mean ${ms(before.mean)} ms, p95 ${ms(before.p95)} ms; after: mean ${ms(after.mean)} ms, p95 ${ms(after.p95)} ms`);
    expect(before.mean).toBeGreaterThan(40);
    expect(after.mean).toBeLessThan(18);
    expect(after.p95).toBeLessThan(25);
  });
});
