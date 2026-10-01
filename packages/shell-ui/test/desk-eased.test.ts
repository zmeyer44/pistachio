/**
 * The Feel's Eased spring (docs/desk.md, Variants): the windows' motions
 * are timed eases on transitions.dev's motion tokens, by what each does —
 * a resize 300ms, a position change 250ms, out of the dock 250ms, into it
 * 150ms (a close is quicker than an open), an arrangement staggered 40ms a
 * window — all on the smooth ease-out, never past their place: a throw that
 * meets an edge comes to rest against it, without rebounding.
 *
 * The engine runs a frame at a time outside React; here the frames are
 * driven by hand, 16ms each.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DragSample } from "@pistachio/shell-contracts/chrome";
import { NATIVE_SURFACE_MEMBERS } from "@pistachio/shell-contracts/ipc";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { DeskEngine, DOCK_W, type DeskHost } from "../src/components/desk/desk-engine";
import { DESK_GAP, type Rect } from "../src/lib/desk/geometry";
import { EASE_SMOOTH_OUT } from "../src/lib/desk/motion";
import { DEFAULT_DESK_VARIANTS, sanitizeVariants, type DeskVariants } from "../src/lib/desk/store";

let frames: Array<(now: number) => void> = [];
let clock = 0;

function run(count: number): void {
  for (let i = 0; i < count; i += 1) {
    const due = frames;
    frames = [];
    clock += 16;
    for (const frame of due) frame(clock);
  }
}

function settle(): void {
  for (let i = 0; i < 2_000 && frames.length > 0; i += 1) run(1);
}

function element() {
  const style: Record<string, string> = {};
  Object.defineProperties(style, {
    setProperty: { value: (name: string, value: string) => (style[name] = value) },
    removeProperty: { value: (name: string) => delete style[name] },
  });
  return { style, dataset: {} as Record<string, string> };
}

function rectOf(el: ReturnType<typeof element>): Rect {
  const [x, y] = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(el.style["transform"] ?? "")!.slice(1).map(Number);
  return { x: x!, y: y!, w: Number.parseFloat(el.style["width"]!), h: Number.parseFloat(el.style["height"]!) };
}

const EASED: DeskVariants = { ...DEFAULT_DESK_VARIANTS, spring: "eased" };
const STAGE = { w: 1600, h: 1000 };
const LEFT = DOCK_W + DESK_GAP;

beforeEach(() => {
  frames = [];
  clock = performance.now();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("window", {
    setInterval: () => 0,
    clearInterval: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => ({ matches: false }),
    devicePixelRatio: 1,
  });
  vi.stubGlobal("requestAnimationFrame", (frame: (now: number) => void) => {
    frames.push(frame);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setShellApi({} as unknown as ShellApiBridge);
});

/** Three windows out (tab-0 in use, on top) on a 1600×1000 stage, Eased unless told otherwise. */
function open(variants: DeskVariants = EASED, host: Partial<DeskHost> = {}) {
  const drag: { sample: ((sample: DragSample) => void) | null } = { sample: null };
  const members = Object.fromEntries(Object.keys(NATIVE_SURFACE_MEMBERS).map((member) => [member, vi.fn()]));
  setShellApi({
    ...members,
    setLayout: () => undefined,
    setDesk: () => undefined,
    captureTabStills: () => Promise.resolve([]),
    focusTab: () => Promise.resolve(),
    onDragSample: (listener: (sample: DragSample) => void) => {
      drag.sample = listener;
      return () => {
        if (drag.sample === listener) drag.sample = null;
      };
    },
  } as unknown as ShellApiBridge);
  const desk = new DeskEngine({
    variants: () => variants,
    hasLivePage: () => true,
    select: () => undefined,
    close: () => undefined,
    editAddress: () => undefined,
    save: () => undefined,
    switchGroup: () => undefined,
    reorderTab: () => undefined,
    moveTabToGroup: () => undefined,
    reorderGroup: () => undefined,
    leaveDone: () => undefined,
    ...host,
  });
  desk.attachStage({ getBoundingClientRect: () => ({ left: 0, top: 0, width: STAGE.w, height: STAGE.h }) } as unknown as HTMLElement);
  desk.start([], "tab-0", ["tab-0", "tab-1", "tab-2", "tab-3"]);
  settle();
  desk.add("tab-1", { focus: false });
  desk.add("tab-2", { focus: false });
  settle();
  desk.activeChanged("tab-0");
  settle();
  const els = new Map<string, ReturnType<typeof element>>();
  for (const tabId of desk.windowTabIds()) {
    const el = element();
    els.set(tabId, el);
    desk.attachWindow(tabId, el as unknown as HTMLElement);
  }
  settle();
  const rect = (tabId: string): Rect => rectOf(els.get(tabId)!);
  return { desk, drag, rect, els };
}

/** Frames until `done` holds (at most `max`). */
function framesUntil(done: () => boolean, max = 200): number {
  let count = 0;
  while (!done() && count < max) {
    run(1);
    count += 1;
  }
  return count;
}

describe("the Eased feel", () => {
  it("is one of the Spring's choices, kept as chosen", () => {
    expect(sanitizeVariants({ spring: "eased" }).spring).toBe("eased");
    expect(sanitizeVariants({ spring: "wobbly" }).spring).toBe(DEFAULT_DESK_VARIANTS.spring);
  });

  it("fills the desk in 300ms on the smooth ease-out (a resize), never past it", () => {
    const { desk, rect } = open();
    const from = rect("tab-0");
    const to = { x: LEFT, y: 0, w: STAGE.w - LEFT, h: STAGE.h };
    desk.toggleMaximize("tab-0");
    const widths: number[] = [];
    // Halfway through its time, most of the way: fast away, a soft settle.
    for (let frame = 0; frame < 9; frame += 1) {
      run(1);
      widths.push(rect("tab-0").w);
    }
    const along = (rect("tab-0").w - from.w) / (to.w - from.w);
    expect(along).toBeCloseTo(EASE_SMOOTH_OUT(144 / 300), 2);
    run(10);
    expect(rect("tab-0")).toEqual(to);
    for (let index = 1; index < widths.length; index += 1) expect(widths[index]!).toBeGreaterThanOrEqual(widths[index - 1]!);
    desk.destroy();
  });

  it("moves a window somewhere else at its size in 250ms (a position change)", () => {
    const { desk, rect } = open();
    const from = rect("tab-1");
    const to = { ...from, x: from.x + 200, y: from.y + 40 };
    const snapshot = desk.layoutSnapshot();
    desk.restoreLayout({ windows: snapshot.windows.map((window) => (window.tabId === "tab-1" ? { ...window, rect: to } : window)) });
    // Arrived on its 250ms (a frame's rounding either way), not a spring's tail.
    const count = framesUntil(() => {
      const now = rect("tab-1");
      return now.x === to.x && now.y === to.y;
    });
    expect(Math.abs(count * 16 - 250)).toBeLessThanOrEqual(16);
    expect(rect("tab-1")).toEqual(to);
    desk.destroy();
  });

  it("collapses a window into the dock in 150ms, quicker than it came out (250ms)", () => {
    const { desk } = open();
    desk.putAway("tab-1");
    expect(framesUntil(() => !desk.windowTabIds().includes("tab-1"))).toBe(Math.ceil(150 / 16));
    desk.add("tab-1", { focus: false });
    expect(framesUntil(() => desk.getView().windows.find((window) => window.tabId === "tab-1")!.flight === null)).toBe(Math.ceil(250 / 16));
    desk.destroy();
  });

  it("staggers an arrangement 40ms a window", () => {
    const { desk, rect } = open();
    const before = desk.windowTabIds().map((tabId) => rect(tabId));
    desk.arrange("tile");
    // The first sets off at once; the third, 80ms on.
    run(2);
    const order = ["tab-0", "tab-1", "tab-2"];
    const moved = (tabId: string): boolean => {
      const was = before[desk.windowTabIds().indexOf(tabId)]!;
      const now = rect(tabId);
      return Math.abs(now.x - was.x) > 0.5 || Math.abs(now.w - was.w) > 0.5;
    };
    expect(moved(order[0]!)).toBe(true);
    expect(moved(order[2]!)).toBe(false);
    run(5);
    expect(moved(order[2]!)).toBe(true);
    settle();
    desk.destroy();
  });

  it("brings a throw that meets the desk's edge to rest against it, without rebounding", () => {
    const thrown = (variants: DeskVariants): number[] => {
      const { desk, drag, rect } = open(variants);
      const start = rect("tab-0");
      const at = { x: start.x + 200, y: start.y + 17 };
      desk.grab("tab-0", at);
      // Fast to the right: it coasts into the desk's right edge.
      for (let step = 1; step <= 6; step += 1) {
        drag.sample?.({ x: at.x + step * 40, y: at.y, phase: "move" });
        run(1);
      }
      drag.sample?.({ x: 0, y: 0, phase: "cancel" });
      const xs: number[] = [];
      for (let frame = 0; frame < 120 && frames.length > 0; frame += 1) {
        run(1);
        xs.push(rect("tab-0").x);
      }
      desk.destroy();
      return xs;
    };
    const rebound = (xs: number[]): number => {
      const peak = xs.indexOf(Math.max(...xs));
      return Math.max(...xs) - Math.min(...xs.slice(peak));
    };
    // The springs rebound off the edge; Eased does not.
    expect(rebound(thrown({ ...DEFAULT_DESK_VARIANTS, spring: "bouncy" }))).toBeGreaterThan(2);
    expect(rebound(thrown(EASED))).toBeLessThan(0.5);
  });
});
