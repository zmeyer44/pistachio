import { describe, expect, it } from "vitest";
import { catmullRom, cursorPath, douglasPeucker } from "../src/lib/cursor.js";
import { clicksOf, pointerAt } from "../src/lib/events.js";
import type { CursorSpec, RecordedEvent } from "../src/lib/types.js";
import { FIXTURES, load } from "./fixtures.js";

const spec = (over: Partial<CursorSpec> = {}): CursorSpec => ({ mode: "natural", size: 1.6, smoothing: 0.6, hideIdle: true, click: "ripple", ...over });
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe("cursorPath", () => {
  it("natural is the raw pointer", () => {
    const { events } = load("click");
    const path = cursorPath(events, spec());
    for (const t of [0.5, 1.234, 2.0, 2.9, 6.0, 7.5]) {
      const c = path.at(t)!;
      expect(distance(c, pointerAt(events, t)!)).toBeLessThan(1e-9);
    }
  });

  it("is null before the first sample, and always in hidden mode", () => {
    const { events } = load("click");
    expect(cursorPath(events, spec()).at(0.1)).toBeNull();
    expect(cursorPath(events, spec({ mode: "hidden" })).at(2)).toBeNull();
    expect(cursorPath([], spec()).at(2)).toBeNull();
  });

  it("smooth lags the raw pointer mid-move and is pinned to it at every click", () => {
    for (const name of FIXTURES) {
      const { events } = load(name);
      const path = cursorPath(events, spec({ mode: "smooth", smoothing: 1 }));
      for (const click of clicksOf(events)) expect(distance(path.at(click.t)!, pointerAt(events, click.t)!)).toBeLessThan(1e-6);
    }
    const { events } = load("click");
    const path = cursorPath(events, spec({ mode: "smooth", smoothing: 1 }));
    expect(distance(path.at(1.2)!, pointerAt(events, 1.2)!)).toBeGreaterThan(3);
    const tight = cursorPath(events, spec({ mode: "smooth", smoothing: 0 }));
    expect(distance(tight.at(1.2)!, pointerAt(events, 1.2)!)).toBeLessThan(distance(path.at(1.2)!, pointerAt(events, 1.2)!));
  });

  it("glide is pinned at clicks and stays close to the stroke", () => {
    for (const name of FIXTURES) {
      const { events } = load(name);
      const path = cursorPath(events, spec({ mode: "glide" }));
      for (const click of clicksOf(events)) expect(distance(path.at(click.t)!, pointerAt(events, click.t)!)).toBeLessThan(1e-6);
    }
    // Off the raw stroke's path by no more than the simplification's tolerance (plus the spline's bow).
    const { events } = load("click");
    const path = cursorPath(events, spec({ mode: "glide" }));
    const raw: { x: number; y: number }[] = [];
    for (let t = 0.4; t <= 3.2; t += 0.002) raw.push(pointerAt(events, t)!);
    for (let t = 0.4; t < 3.2; t += 0.01) {
      const p = path.at(t)!;
      expect(Math.min(...raw.map((q) => distance(p, q)))).toBeLessThan(7);
    }
  });

  it("hides after 2 s still, fading over 0.3 s, and shows again on a move", () => {
    const { events } = load("idle");
    const path = cursorPath(events, spec());
    expect(path.at(3.9)).toMatchObject({ visible: true, fade: 1 });
    const fading = path.at(4.15)!;
    expect(fading.fade).toBeGreaterThan(0);
    expect(fading.fade).toBeLessThan(1);
    expect(path.at(4.4)).toMatchObject({ visible: false, fade: 0 });
    expect(path.at(5.7)).toMatchObject({ visible: true, fade: 1 });
    expect(cursorPath(events, spec({ hideIdle: false })).at(4.4)).toMatchObject({ visible: true, fade: 1 });
  });

  it("a wiggle under 3 px does not wake it; a bigger move does", () => {
    const events: RecordedEvent[] = [
      { t: 0, k: "move", x: 100, y: 100 },
      { t: 500, k: "move", x: 140, y: 100 },
      { t: 4000, k: "move", x: 142, y: 101 },
      { t: 5000, k: "move", x: 150, y: 104 },
    ];
    const path = cursorPath(events, spec());
    expect(path.at(4.05)!.visible).toBe(false);
    expect(path.at(5.0)!.fade).toBe(0);
    expect(path.at(5.15)).toMatchObject({ visible: true, fade: 1 });
  });

  it("a click presses for 90 ms and rings for 400 ms; `none` turns both off", () => {
    const { events } = load("click");
    const path = cursorPath(events, spec());
    expect(path.at(2.0)).toMatchObject({ press: 0, ripple: 0 });
    expect(path.at(2.045)!.press).toBeCloseTo(1, 6);
    expect(path.at(2.2)!.press).toBe(0);
    expect(path.at(2.2)!.ripple).toBeCloseTo(0.5, 6);
    expect(path.at(2.45)!.ripple).toBe(0);
    expect(cursorPath(events, spec({ click: "none" })).at(2.045)).toMatchObject({ press: 0, ripple: 0 });
  });

  it("takes its shape from the latest cursor event", () => {
    const { events } = load("click");
    const path = cursorPath(events, spec());
    expect(path.at(1.0)!.type).toBe("default");
    expect(path.at(1.8)!.type).toBe("pointer");
    expect(path.at(3.0)!.type).toBe("default");
    const none = cursorPath([...events, { t: 7000, k: "cursor", type: "none" }], spec());
    expect(none.at(7.1)!.visible).toBe(false);
  });

  it("is not visible while another window covers the view", () => {
    const events: RecordedEvent[] = [
      { t: 0, k: "move", x: 100, y: 100 },
      { t: 100, k: "move", x: 120, y: 100 },
      { t: 200, k: "box", view: { x: 0, y: 0, w: 1600, h: 900 }, visible: false },
      { t: 300, k: "move", x: 140, y: 100 },
      { t: 600, k: "box", view: { x: 0, y: 0, w: 1600, h: 900 }, visible: true },
    ];
    const path = cursorPath(events, spec());
    expect(path.at(0.35)!.visible).toBe(false);
    expect(path.at(0.65)!.visible).toBe(true);
  });
});

describe("the glide's pieces", () => {
  it("Douglas–Peucker keeps the ends and the corners within tolerance", () => {
    const xs = [0, 1, 2, 3, 10, 10, 10.5, 10];
    const ys = [0, 0.2, -0.1, 0, 0, 5, 10, 20];
    expect(douglasPeucker(xs, ys, 0, xs.length - 1, 1)).toEqual([0, 4, 7]);
  });

  it("centripetal Catmull–Rom passes through its control points", () => {
    const p = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }, { x: 30, y: 10 }] as const;
    expect(catmullRom(p[0], p[1], p[2], p[3], 0)).toEqual({ x: 10, y: 0 });
    const end = catmullRom(p[0], p[1], p[2], p[3], 1);
    expect(end.x).toBeCloseTo(20, 9);
    expect(end.y).toBeCloseTo(10, 9);
  });
});
