/**
 * Minimized desk windows (docs/desk.md, "Minimize"): a window made small,
 * its page zoomed out, parked in the shelf at the desk's foot — half of it
 * below the desk's edge, the next one along overlapping it by half — over
 * the windows there, whose pages are cut short of them. The pointer on one raises it (and
 * only it) into view; dragged away it is a minimized window out on the
 * desk, and let go at the foot it parks again; Expand gives it back its
 * box. Main hears each minimized page's box and zoom, and a page growing
 * back is held at the box it grows to until it lands.
 *
 * The engine runs a frame at a time outside React; here the frames (and
 * the timer that puts a raised window back down) are driven by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DragSample } from "@pistachio/shell-contracts/chrome";
import { DESK_MINI_ZOOM, isDeskState, type DeskState } from "@pistachio/shell-contracts/desk";
import { NATIVE_SURFACE_MEMBERS, type BrowserLayout } from "@pistachio/shell-contracts/ipc";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { CHROME_INSETS, DeskEngine, MINI_SIZE, SHELF_INSET, type DeskHost } from "../src/components/desk/desk-engine";
import { DESK_GAP, type Rect } from "../src/lib/desk/geometry";
import { DEFAULT_DESK_VARIANTS, type SavedDeskWindow } from "../src/lib/desk/store";

let frames: Array<(now: number) => void> = [];
let timers: Array<{ id: number; run: () => void; at: number }> = [];
let clock = 0;

function settle(): void {
  for (let i = 0; i < 2_000 && frames.length > 0; i += 1) {
    const due = frames;
    frames = [];
    clock += 16;
    for (const frame of due) frame(clock);
  }
}

function run(count: number): void {
  for (let i = 0; i < count; i += 1) {
    const due = frames;
    frames = [];
    clock += 16;
    for (const frame of due) frame(clock);
  }
}

/** Let `ms` pass on the timers, then settle. */
function wait(ms: number): void {
  clock += ms;
  const due = timers.filter((timer) => timer.at <= clock);
  timers = timers.filter((timer) => timer.at > clock);
  for (const timer of due) timer.run();
  settle();
}

function native(options: { stills?: boolean } = {}) {
  const layouts: BrowserLayout[] = [];
  const desks: Array<DeskState | null> = [];
  const drag: { sample: ((sample: DragSample) => void) | null } = { sample: null };
  const members = Object.fromEntries(Object.keys(NATIVE_SURFACE_MEMBERS).map((member) => [member, vi.fn()]));
  setShellApi({
    ...members,
    setLayout: (layout: BrowserLayout) => layouts.push(layout),
    setDesk: (state: DeskState | null) => desks.push(state),
    // No pictures, unless asked for (a test that is then awaited): none comes back after a test is over to ask for a frame.
    captureTabStills: (ids: readonly string[]) =>
      Promise.resolve(options.stills === true ? ids.map((tabId) => ({ tabId, dataUrl: `data:image/jpeg;base64,${tabId}` })) : []),
    focusTab: () => Promise.resolve(),
    onDragSample: (listener: (sample: DragSample) => void) => {
      drag.sample = listener;
      return () => {
        if (drag.sample === listener) drag.sample = null;
      };
    },
  } as unknown as ShellApiBridge);
  return { layouts, desks, drag };
}

/** A desk over a 1600×1000 stage whose tabs' pages are live. */
function engine(host: Partial<DeskHost> = {}): DeskEngine {
  const created = new DeskEngine({
    variants: () => DEFAULT_DESK_VARIANTS,
    hasLivePage: () => true,
    select: () => undefined,
    close: () => undefined,
    editAddress: () => undefined,
    save: () => undefined,
    moveTabToGroup: () => undefined,
    sidebar: () => ({ x: -48, y: 0, w: 48, h: 1000 }),
    homeOf: () => null,
    leaveDone: () => undefined,
    ...host,
  });
  created.attachStage({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 1000 }) } as unknown as HTMLElement);
  return created;
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

function expectRect(actual: Rect, expected: Rect, within = 1): void {
  for (const key of ["x", "y", "w", "h"] as const) expect(Math.abs(actual[key] - expected[key]), `${key}: ${actual[key]} vs ${expected[key]}`).toBeLessThanOrEqual(within);
}

const STAGE = { w: 1600, h: 1000 };
const insets = CHROME_INSETS[DEFAULT_DESK_VARIANTS.chrome];
/** How much of a parked window shows above the desk's foot: a quarter of it (the engine's MINI_PEEK). */
const PEEK = MINI_SIZE.h / 4;
/** The shelf's band at the desk's foot: where they peek up, and a gap above (a minimized window let go in it parks). */
const FOOT = PEEK + DESK_GAP;
/** Where the shelf begins: clear of the well's rounded corner. */
const LEFT = SHELF_INSET;
/** The desk a window fills, windows parked or not: the whole card. */
const FILLED = { x: 0, y: 0, w: STAGE.w, h: STAGE.h };
/** Where the shelf's first window peeks up, and where it is raised to. */
const PEEKING = { x: LEFT, y: STAGE.h - PEEK, w: MINI_SIZE.w, h: MINI_SIZE.h };
const RAISED = { ...PEEKING, y: STAGE.h - MINI_SIZE.h - DESK_GAP };
/** Past the time a raised window waits once the pointer has left it. */
const MINI_LOWER_WAIT = 400;

beforeEach(() => {
  frames = [];
  timers = [];
  clock = performance.now();
  let nextTimer = 1;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("window", {
    setInterval: () => 0,
    clearInterval: () => undefined,
    setTimeout: (run: () => void, ms: number) => {
      const id = nextTimer++;
      timers.push({ id, run, at: clock + ms });
      return id;
    },
    clearTimeout: (id: number) => {
      timers = timers.filter((timer) => timer.id !== id);
    },
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

/** Three windows out (tab-0 in use, on top), their elements attached. */
function open(host: Partial<DeskHost> = {}, options: { stills?: boolean } = {}) {
  const api = native(options);
  const desk = engine(host);
  const els = new Map<string, ReturnType<typeof element>>();
  desk.start([], "tab-0", ["tab-0", "tab-1", "tab-2", "tab-3"]);
  settle();
  desk.add("tab-1", { focus: false });
  desk.add("tab-2", { focus: false });
  settle();
  desk.activeChanged("tab-0");
  settle();
  for (const tabId of desk.windowTabIds()) {
    const el = element();
    els.set(tabId, el);
    desk.attachWindow(tabId, el as unknown as HTMLElement);
  }
  settle();
  const rect = (tabId: string): Rect => rectOf(els.get(tabId)!);
  const view = (tabId: string) => desk.getView().windows.find((window) => window.tabId === tabId)!;
  return { ...api, desk, els, rect, view };
}

describe("minimizing a window", () => {
  it("parks it at the desk's foot beside the dock, half of it below the edge, and hands the keyboard to the window under it", () => {
    const selected: string[] = [];
    const { desk, rect, view } = open({ select: (tabId) => selected.push(tabId) });
    const before = rect("tab-0");
    desk.minimize("tab-0");
    settle();
    expectRect(rect("tab-0"), PEEKING);
    expect(view("tab-0").mini).toBe("parked");
    expect(desk.focusedTabId()).toBe("tab-2");
    expect(selected.at(-1)).toBe("tab-2");
    // Expanded, it grows back to the box it had, in use again, and the shelf's band is the desk's again.
    desk.expand("tab-0");
    settle();
    expectRect(rect("tab-0"), before);
    expect(view("tab-0").mini).toBeNull();
    expect(desk.focusedTabId()).toBe("tab-0");
    desk.destroy();
  });

  it("lies over the windows at the desk's foot: a window filling the desk still fills it, its page cut short of the shelf, and whole again after", () => {
    const { desk, els, layouts, rect } = open();
    desk.toggleMaximize("tab-2");
    settle();
    expectRect(rect("tab-2"), FILLED);
    const page = (): { y: number; height: number } | undefined => layouts.at(-1)?.views.find((view) => view.tabId === "tab-2")?.bounds;
    expect(page()!.y + page()!.height).toBe(STAGE.h - insets.bottom);
    desk.minimize("tab-1");
    settle();
    expectRect(rect("tab-2"), FILLED);
    // Its live page stops where the parked window peeks up, and its frame's page box with it; the shelf stays live over the rest.
    expect(page()!.y + page()!.height).toBe(STAGE.h - PEEK);
    expect(els.get("tab-2")!.style["--desk-cut"]).toBe(`${(PEEK - insets.bottom).toFixed(1)}px`);
    expect(layouts.at(-1)?.views.map((view) => view.tabId)).toContain("tab-1");
    desk.expand("tab-1");
    settle();
    expectRect(rect("tab-2"), FILLED);
    expect(page()!.y + page()!.height).toBe(STAGE.h - insets.bottom);
    expect(els.get("tab-2")!.style["--desk-cut"]).toBe("0.0px");
    desk.destroy();
  });

  it("says a window is in use only while it is out at its own size and in use: its row pressed is then the address's", () => {
    const { desk } = open();
    expect(desk.inUse("tab-0")).toBe(true);
    expect(desk.inUse("tab-1")).toBe(false);
    desk.minimize("tab-0");
    settle();
    expect(desk.inUse("tab-0")).toBe(false);
    desk.expand("tab-0");
    settle();
    expect(desk.inUse("tab-0")).toBe(true);
    desk.putAway("tab-0");
    settle();
    expect(desk.inUse("tab-0")).toBe(false);
    expect(desk.inUse("tab-3")).toBe(false);
    desk.destroy();
  });

  it("cuts a window short of the Bar's notch only where it is under it", () => {
    const { desk, layouts, rect } = open();
    desk.setNotch({ w: 240, h: 32 });
    desk.toggleMaximize("tab-2");
    settle();
    const page = (tabId: string): { y: number; height: number } | undefined => layouts.at(-1)?.views.find((view) => view.tabId === tabId)?.bounds;
    expectRect(rect("tab-2"), FILLED);
    expect(page("tab-2")!.y + page("tab-2")!.height).toBe(STAGE.h - 32);
    // In the left half, clear of the notch: whole.
    desk.applyLayout(new Map([["tab-2", { x: 0, y: 0, w: STAGE.w / 2 - 200, h: STAGE.h }]]));
    settle();
    expect(page("tab-2")!.y + page("tab-2")!.height).toBe(STAGE.h - insets.bottom);
    desk.destroy();
  });

  it("stacks the next one to the right, overlapping it by half and over it; the shelf is over every other window", () => {
    const { desk, rect } = open();
    desk.minimize("tab-0");
    desk.minimize("tab-1");
    settle();
    expectRect(rect("tab-0"), PEEKING);
    expectRect(rect("tab-1"), { ...PEEKING, x: LEFT + MINI_SIZE.w / 2 });
    expect(desk.windowTabIds()).toEqual(["tab-2", "tab-0", "tab-1"]);
    // Raising a window never takes it over the shelf.
    desk.activeChanged("tab-2");
    settle();
    expect(desk.windowTabIds()).toEqual(["tab-2", "tab-0", "tab-1"]);
    // One leaves (collapsed into the dock): the shelf closes up.
    desk.putAway("tab-0");
    settle();
    expectRect(rect("tab-1"), PEEKING);
    desk.destroy();
  });

  it("raises the window the pointer is on into full view, over its neighbour, and only it; it goes back down a moment after the pointer leaves", () => {
    const { desk, rect, view } = open();
    desk.minimize("tab-0");
    desk.minimize("tab-1");
    settle();
    desk.hoverMini("tab-0", "frame", true);
    settle();
    expectRect(rect("tab-0"), RAISED);
    expectRect(rect("tab-1"), { ...PEEKING, x: LEFT + MINI_SIZE.w / 2 });
    expect(view("tab-0").raised).toBe(true);
    expect(desk.windowTabIds().at(-1)).toBe("tab-0");
    // From its frame onto its live page (main's word) is not leaving.
    desk.hoverMini("tab-0", "page", true);
    desk.hoverMini("tab-0", "frame", false);
    wait(400);
    expectRect(rect("tab-0"), RAISED);
    desk.hoverMini("tab-0", "page", false);
    wait(50);
    expectRect(rect("tab-0"), RAISED);
    wait(400);
    expectRect(rect("tab-0"), PEEKING);
    expect(desk.windowTabIds().slice(-2)).toEqual(["tab-0", "tab-1"]);
    // From one to the next: the next rises, the first goes down.
    desk.hoverMini("tab-0", "frame", true);
    settle();
    desk.hoverMini("tab-0", "frame", false);
    desk.hoverMini("tab-1", "frame", true);
    settle();
    expectRect(rect("tab-1"), { ...RAISED, x: LEFT + MINI_SIZE.w / 2 });
    expectRect(rect("tab-0"), PEEKING);
    desk.destroy();
  });

  it("rises and goes back down smoothly, never past its place, even with the Bouncy spring", () => {
    const { desk, rect } = open({ variants: () => ({ ...DEFAULT_DESK_VARIANTS, spring: "bouncy" }) });
    desk.minimize("tab-0");
    settle();
    const path = (): number[] => {
      const ys: number[] = [];
      for (let frame = 0; frame < 120 && frames.length > 0; frame += 1) {
        run(1);
        ys.push(rect("tab-0").y);
      }
      return ys;
    };
    desk.hoverMini("tab-0", "frame", true);
    const rising = path();
    expect(Math.min(...rising)).toBeGreaterThanOrEqual(RAISED.y - 0.5);
    // Every frame higher than the last, or where it was: no overshoot and back.
    for (let index = 1; index < rising.length; index += 1) expect(rising[index]!).toBeLessThanOrEqual(rising[index - 1]! + 0.01);
    expectRect(rect("tab-0"), RAISED);
    desk.hoverMini("tab-0", "frame", false);
    wait(MINI_LOWER_WAIT);
    desk.hoverMini("tab-0", "frame", true);
    desk.hoverMini("tab-0", "frame", false);
    clock += MINI_LOWER_WAIT;
    for (const timer of timers.splice(0)) timer.run();
    const lowering = path();
    expect(Math.max(...lowering)).toBeLessThanOrEqual(PEEKING.y + 0.5);
    for (let index = 1; index < lowering.length; index += 1) expect(lowering[index]!).toBeGreaterThanOrEqual(lowering[index - 1]! - 0.01);
    expectRect(rect("tab-0"), PEEKING);
    desk.destroy();
  });

  it("rises in 250ms and goes back down in 150ms, on the smooth ease-out, a moment after the pointer leaves", () => {
    const { desk, rect } = open();
    desk.minimize("tab-0");
    settle();
    const travel = PEEKING.y - RAISED.y;
    desk.hoverMini("tab-0", "frame", true);
    // Half its time in, most of the way: fast away, a soft settle.
    run(8);
    expect(PEEKING.y - rect("tab-0").y).toBeGreaterThan(travel * 0.85);
    expect(rect("tab-0").y).toBeGreaterThan(RAISED.y);
    run(8);
    expectRect(rect("tab-0"), RAISED, 0.01);
    desk.hoverMini("tab-0", "frame", false);
    // Not straight away: the pointer may only be crossing onto its page.
    clock += 60;
    for (const timer of timers.filter((timer) => timer.at <= clock)) timer.run();
    run(1);
    expectRect(rect("tab-0"), RAISED, 0.01);
    clock += 30;
    for (const timer of timers.splice(0).filter((timer) => timer.at <= clock)) timer.run();
    run(10);
    expectRect(rect("tab-0"), PEEKING, 0.01);
    desk.destroy();
  });

  it("goes live peeking and rising: its page's view cut short at the desk's edge, and never drawn for the motion", () => {
    const { desk, layouts, view } = open();
    desk.minimize("tab-0");
    // Shrinking into the shelf, it is drawn.
    run(2);
    expect(view("tab-0").drawn).toBe(true);
    settle();
    expect(view("tab-0").drawn).toBe(false);
    const peeking = layouts.at(-1)!.views.find((entry) => entry.tabId === "tab-0")!;
    expect(peeking.bounds).toEqual({ x: LEFT + insets.left, y: PEEKING.y + insets.top, width: MINI_SIZE.w - insets.left - insets.right, height: STAGE.h - (PEEKING.y + insets.top) });
    desk.hoverMini("tab-0", "frame", true);
    run(3);
    expect(view("tab-0").drawn).toBe(false);
    settle();
    const raised = layouts.at(-1)!.views.find((entry) => entry.tabId === "tab-0")!;
    expect(raised.bounds.height).toBe(MINI_SIZE.h - insets.top - insets.bottom);
    desk.destroy();
  });

  it("tells main its page's box and zoom; growing back, the box it grows to at its own zoom, until it lands", () => {
    const { desk, desks, rect } = open();
    const own = rect("tab-0");
    desk.minimize("tab-0");
    const page = { width: MINI_SIZE.w - insets.left - insets.right, height: MINI_SIZE.h - insets.top - insets.bottom };
    expect(desks.at(-1)?.zoomed).toEqual([{ tabId: "tab-0", ...page, zoom: DESK_MINI_ZOOM }]);
    settle();
    expect(desks.at(-1)?.zoomed).toEqual([{ tabId: "tab-0", ...page, zoom: DESK_MINI_ZOOM }]);
    desk.expand("tab-0");
    run(1);
    // (The windows growing back into the shelf's band, now empty, are laid out at their new boxes too.)
    expect(desks.at(-1)?.zoomed).toContainEqual({
      tabId: "tab-0",
      width: Math.round(own.w - insets.left - insets.right),
      height: Math.round(own.h - insets.top - insets.bottom),
      zoom: 1,
    });
    expect(desks.at(-1)?.zoomed?.every((page) => page.zoom === 1)).toBe(true);
    settle();
    expect(desks.at(-1)?.zoomed).toEqual([]);
    for (const state of desks) expect(state === null || isDeskState(state)).toBe(true);
    desk.destroy();
  });

  it("is taken from the shelf by a drag, still minimized, the shelf closing up; let go at the desk's foot, it parks again", () => {
    const { desk, drag, rect, view } = open();
    desk.minimize("tab-0");
    desk.minimize("tab-1");
    settle();
    const at = { x: PEEKING.x + 60, y: PEEKING.y + 12 };
    desk.grab("tab-0", at);
    for (let step = 1; step <= 30; step += 1) {
      drag.sample?.({ x: at.x + step * 20, y: at.y - step * 15, phase: "move" });
      run(1);
    }
    drag.sample?.({ x: 0, y: 0, phase: "cancel" });
    settle();
    expect(view("tab-0").mini).toBe("free");
    expect(rect("tab-0").w).toBe(MINI_SIZE.w);
    expect(rect("tab-0").h).toBe(MINI_SIZE.h);
    expect(rect("tab-0").y + rect("tab-0").h).toBeLessThanOrEqual(STAGE.h - FOOT + 0.5);
    expectRect(rect("tab-1"), PEEKING);
    // Back to the foot, to the right of the one there: it parks after it.
    const from = { x: rect("tab-0").x + 60, y: rect("tab-0").y + 12 };
    desk.grab("tab-0", from);
    const to = { x: LEFT + MINI_SIZE.w, y: STAGE.h - 30 };
    for (let step = 1; step <= 30; step += 1) {
      drag.sample?.({ x: from.x + ((to.x - from.x) * step) / 30, y: from.y + ((to.y - from.y) * step) / 30, phase: "move" });
      run(1);
    }
    drag.sample?.({ x: 0, y: 0, phase: "cancel" });
    settle();
    expect(view("tab-0").mini).toBe("parked");
    expectRect(rect("tab-1"), PEEKING);
    expectRect(rect("tab-0"), { ...PEEKING, x: LEFT + MINI_SIZE.w / 2 });
    desk.destroy();
  });

  it("out on the desk, is resized from its corner, and stays minimized", () => {
    const { desk, drag, rect, view } = open();
    desk.minimize("tab-1");
    settle();
    const at = { x: PEEKING.x + 60, y: PEEKING.y + 12 };
    desk.grab("tab-1", at);
    for (let step = 1; step <= 30; step += 1) {
      drag.sample?.({ x: at.x + step * 20, y: at.y - step * 15, phase: "move" });
      run(1);
    }
    drag.sample?.({ x: 0, y: 0, phase: "cancel" });
    settle();
    const start = rect("tab-1");
    const corner = { x: start.x + start.w, y: start.y + start.h };
    desk.resize("tab-1", { left: false, right: true, top: false, bottom: true }, { clientX: corner.x, clientY: corner.y, button: 0 });
    for (let step = 1; step <= 10; step += 1) {
      drag.sample?.({ x: corner.x + step * 12, y: corner.y + step * 8, phase: "move" });
      run(1);
    }
    drag.sample?.({ x: 0, y: 0, phase: "cancel" });
    settle();
    expectRect(rect("tab-1"), { ...start, w: start.w + 120, h: start.h + 80 });
    expect(view("tab-1").mini).toBe("free");
    desk.destroy();
  });

  it("is left alone by Tile and Cascade, and filling it expands it", () => {
    const { desk, rect, view } = open();
    desk.minimize("tab-0");
    settle();
    desk.arrange("tile");
    settle();
    expectRect(rect("tab-0"), PEEKING);
    desk.toggleMaximize("tab-0");
    settle();
    expect(view("tab-0").mini).toBeNull();
    desk.destroy();
  });

  it("grows back when its tab is chosen from the dock", () => {
    const { desk, view } = open();
    desk.minimize("tab-1");
    settle();
    desk.add("tab-1", { focus: true });
    settle();
    expect(view("tab-1").mini).toBeNull();
    expect(desk.focusedTabId()).toBe("tab-1");
    desk.destroy();
  });

  it("is never a masked window", () => {
    const { desk, rect, view } = open();
    const before = rect("tab-1");
    desk.startMask("tab-1");
    desk.applyMask("tab-1", { x: 10, y: 10, w: 120, h: 90 });
    settle();
    desk.minimize("tab-1");
    settle();
    expect(view("tab-1").mini).toBeNull();
    expect(rect("tab-1").w).toBeLessThan(before.w);
    desk.destroy();
  });
});

describe("a minimized window snapped", () => {
  /** Take a window by its title bar at `from`, carry it to `to` a step at a time, hold it there, and let go. */
  function carry(desk: DeskEngine, drag: { sample: ((sample: DragSample) => void) | null }, tabId: string, from: { x: number; y: number }, to: { x: number; y: number }, shift = false) {
    desk.grab(tabId, from, shift);
    for (let step = 1; step <= 20; step += 1) {
      drag.sample?.({ x: from.x + ((to.x - from.x) * step) / 20, y: from.y + ((to.y - from.y) * step) / 20, phase: "move", shift });
      run(1);
    }
    // Held still a moment: set down, not thrown.
    for (let frame = 0; frame < 12; frame += 1) {
      drag.sample?.({ ...to, phase: "move", shift });
      run(1);
    }
    const aiming = desk.getView().windows.find((window) => window.tabId === tabId)!.aiming;
    drag.sample?.({ x: 0, y: 0, phase: "cancel" });
    settle();
    return { aiming };
  }
  const titleOf = (rect: Rect) => ({ x: rect.x + 60, y: rect.y + 12 });
  /** The desk windows go in with nothing parked. */
  const usable = FILLED;

  it("into an edge zone lands in it as a window at its own size, its page no longer zoomed", () => {
    const { desk, drag, desks, rect, view } = open();
    desk.minimize("tab-0");
    settle();
    const { aiming } = carry(desk, drag, "tab-0", titleOf(PEEKING), { x: STAGE.w - 6, y: 500 });
    expect(aiming).toBe(true);
    expect(view("tab-0").mini).toBeNull();
    expectRect(rect("tab-0"), { x: usable.x + (usable.w - DESK_GAP) / 2 + DESK_GAP, y: usable.y, w: (usable.w - DESK_GAP) / 2, h: usable.h });
    expect(desks.at(-1)?.zoomed).toEqual([]);
    desk.destroy();
  });

  it("with Shift held lands in the tile it lights, out of the shelf too", () => {
    const { desk, drag, rect, view } = open();
    desk.minimize("tab-0");
    desk.minimize("tab-1");
    settle();
    // The top-right third of the desk is its top-right quarter.
    carry(desk, drag, "tab-1", titleOf({ ...PEEKING, x: LEFT + MINI_SIZE.w / 2 }), { x: STAGE.w - 200, y: 150 }, true);
    expect(view("tab-1").mini).toBeNull();
    const usableNow = FILLED;
    expectRect(rect("tab-1"), { x: usableNow.x + (usableNow.w - DESK_GAP) / 2 + DESK_GAP, y: usableNow.y, w: (usableNow.w - DESK_GAP) / 2, h: (usableNow.h - DESK_GAP) / 2 });
    // The one still parked stays parked.
    expect(view("tab-0").mini).toBe("parked");
    desk.destroy();
  });

  it("filling the desk, gives back the box it had before it was minimized when the desk is let go of", () => {
    const { desk, drag, rect, view } = open();
    const own = rect("tab-0");
    desk.minimize("tab-0");
    settle();
    carry(desk, drag, "tab-0", titleOf(PEEKING), { x: 800, y: 4 });
    expect(view("tab-0").mini).toBeNull();
    expect(view("tab-0").maximized).toBe(true);
    desk.toggleMaximize("tab-0");
    settle();
    expectRect(rect("tab-0"), own);
    desk.destroy();
  });

  it("with the Snap throw lands in a tile wherever it is let go, as any window does", () => {
    const { desk, drag, view } = open({ variants: () => ({ ...DEFAULT_DESK_VARIANTS, physics: "snap" }) });
    desk.minimize("tab-0");
    settle();
    carry(desk, drag, "tab-0", titleOf(PEEKING), { x: 800, y: 450 });
    expect(view("tab-0").mini).toBeNull();
    desk.destroy();
  });

  it("over the shelf at the desk's foot lights no tile, and parks again, even in the corner a quarter would light", () => {
    const { desk, drag, rect, view } = open();
    desk.minimize("tab-0");
    settle();
    carry(desk, drag, "tab-0", titleOf(PEEKING), { x: 800, y: 300 });
    expect(view("tab-0").mini).toBe("free");
    // Back down at the desk's bottom-left corner, where a window would light the bottom-left quarter.
    const { aiming } = carry(desk, drag, "tab-0", titleOf(rect("tab-0")), { x: LEFT + 20, y: STAGE.h - 20 });
    expect(aiming).toBe(false);
    expect(view("tab-0").mini).toBe("parked");
    expectRect(rect("tab-0"), PEEKING);
    desk.destroy();
  });
});

describe("the shelf at the foot of the desk's card", () => {
  it("peeks from the card's own edge, cut off there, its view too, and the desk keeps above where it peeks up", () => {
    const { layouts } = native();
    const desk = engine();
    desk.start([], "tab-0", ["tab-0", "tab-1"]);
    settle();
    desk.add("tab-1", { focus: false });
    settle();
    const el = element();
    desk.attachWindow("tab-0", el as unknown as HTMLElement);
    desk.minimize("tab-0");
    settle();
    expectRect(rectOf(el), PEEKING);
    // Cut off at the card's edge, its view too: the surface's gutter below it stays clear.
    expect(el.style["clipPath"]).toBe(`inset(-40px -40px ${(MINI_SIZE.h - PEEK).toFixed(1)}px -40px)`);
    const view = layouts.at(-1)!.views.find((entry) => entry.tabId === "tab-0")!;
    expect(view.bounds.y + view.bounds.height).toBe(STAGE.h);
    // The desk keeps above where it peeks up, and a gap.
    const other = desk.layoutSnapshot().windows.find((window) => window.tabId === "tab-1")!.rect;
    expect(other.y + other.h).toBeLessThanOrEqual(STAGE.h - PEEK - DESK_GAP + 0.5);
    desk.destroy();
  });
});

describe("a window growing into a larger box", () => {
  /** The desk a window fills (nothing parked). */
  const filled = FILLED;
  const pageOf = (rect: Rect) => ({ width: Math.round(rect.w - insets.left - insets.right), height: Math.round(rect.h - insets.top - insets.bottom) });

  it("fills the desk as its live page, laid out at the desk's size from the start, and never past it, even with the Bouncy spring", async () => {
    // Pictures come back (a window that wanted its still for the motion would be drawn with it).
    vi.stubGlobal("Image", class {
      src = "";
      decode(): Promise<void> {
        return Promise.resolve();
      }
    });
    const { desk, desks, layouts, rect, view } = open({ variants: () => ({ ...DEFAULT_DESK_VARIANTS, spring: "bouncy" }) }, { stills: true });
    const start = rect("tab-0");
    desk.toggleMaximize("tab-0");
    run(1);
    expect(desks.at(-1)?.zoomed).toEqual([{ tabId: "tab-0", ...pageOf(filled), zoom: 1 }]);
    for (let frame = 0; frame < 200 && frames.length > 0; frame += 1) {
      // Whatever pictures were asked for, landed.
      await Promise.resolve();
      await new Promise((done) => setImmediate(done));
      expect(view("tab-0").drawn).toBe(false);
      const now = rect("tab-0");
      // (Within the rounding of the box written to the element.)
      expect(now.x).toBeGreaterThanOrEqual(Math.min(start.x, filled.x) - 0.1);
      expect(now.y).toBeGreaterThanOrEqual(Math.min(start.y, filled.y) - 0.1);
      expect(now.x + now.w).toBeLessThanOrEqual(Math.max(start.x + start.w, filled.x + filled.w) + 0.1);
      expect(now.y + now.h).toBeLessThanOrEqual(Math.max(start.y + start.h, filled.y + filled.h) + 0.1);
      const shown = layouts.at(-1)!.views.find((entry) => entry.tabId === "tab-0")!;
      expect(shown.bounds.width).toBeLessThanOrEqual(pageOf(filled).width);
      expect(shown.bounds.height).toBeLessThanOrEqual(pageOf(filled).height);
      run(1);
    }
    expectRect(rect("tab-0"), filled, 0.01);
    expect(desks.at(-1)?.zoomed).toEqual([]);
    await new Promise((done) => setImmediate(done));
    run(3);
    desk.destroy();
  });

  it("shrinking back from filling the desk, is not laid out ahead: nothing is zoomed", () => {
    const { desk, desks } = open();
    desk.toggleMaximize("tab-0");
    settle();
    desk.toggleMaximize("tab-0");
    run(2);
    expect(desks.at(-1)?.zoomed).toEqual([]);
    settle();
    desk.destroy();
  });

  it("expanded from minimized, grows back as its live page, not its zoomed-out picture", () => {
    const { desk, view } = open();
    desk.minimize("tab-0");
    settle();
    desk.expand("tab-0");
    for (let frame = 0; frame < 60 && frames.length > 0; frame += 1) {
      run(1);
      expect(view("tab-0").drawn).toBe(false);
    }
    settle();
    desk.destroy();
  });
});

describe("leaving the desk", () => {
  /** The window in use's box once it is the pane again: its page exactly the stage. */
  const pane = { x: -insets.left, y: -insets.top, w: STAGE.w + insets.left + insets.right, h: STAGE.h + insets.top + insets.bottom };

  it("grows the window in use into the pane as its live page, laid out at the pane's box from the start, never past it", () => {
    let left = false;
    const { desk, desks, layouts, rect, view } = open({ variants: () => ({ ...DEFAULT_DESK_VARIANTS, spring: "bouncy" }), leaveDone: () => (left = true) });
    desk.leave();
    // Main lays the page out at the pane's box at once, before it has grown at all.
    expect(desks.at(-1)?.zoomed).toEqual([{ tabId: "tab-0", width: STAGE.w, height: STAGE.h, zoom: 1 }]);
    let frames = 0;
    while (!left && frames < 120) {
      run(1);
      frames += 1;
      if (!left) {
        // Live all the way, never a picture of its window stretched to the pane.
        expect(view("tab-0").drawn).toBe(false);
        const now = rect("tab-0");
        // (Within the rounding of the box written to the element.)
        expect(now.x).toBeGreaterThanOrEqual(pane.x - 0.1);
        expect(now.y).toBeGreaterThanOrEqual(pane.y - 0.1);
        expect(now.x + now.w).toBeLessThanOrEqual(pane.x + pane.w + 0.1);
        expect(now.y + now.h).toBeLessThanOrEqual(pane.y + pane.h + 0.1);
      }
    }
    expect(left).toBe(true);
    // A quick resize: there in 250ms, and handed back a couple of frames later.
    expect(frames).toBeLessThanOrEqual(Math.ceil(250 / 16) + 4);
    expectRect(rect("tab-0"), pane, 0.01);
    expect(layouts.at(-1)!.views).toEqual([{ tabId: "tab-0", bounds: { x: 0, y: 0, width: STAGE.w, height: STAGE.h } }]);
  });

  it("goes live at once, though something of the desk was over it a moment before (the More card it was left from)", async () => {
    vi.stubGlobal("Image", class {
      src = "";
      decode(): Promise<void> {
        return Promise.resolve();
      }
    });
    const { desk, view } = open({}, { stills: true });
    const flush = async (): Promise<void> => {
      for (let round = 0; round < 4; round += 1) {
        await Promise.resolve();
        await new Promise((done) => setImmediate(done));
        run(3);
      }
    };
    desk.setCover("more", { x: 0, y: 0, w: STAGE.w, h: STAGE.h });
    settle();
    await flush();
    expect(view("tab-0").drawn).toBe(true);
    desk.leave();
    run(1);
    expect(view("tab-0").drawn).toBe(false);
    settle();
    await flush();
  });

  it("from a minimized window in use, lays its page out at the pane's box, not zoomed out", () => {
    const { desk, desks } = open();
    desk.minimize("tab-0");
    settle();
    desk.activeChanged("tab-0");
    settle();
    desk.leave();
    expect(desks.at(-1)?.zoomed).toEqual([{ tabId: "tab-0", width: STAGE.w, height: STAGE.h, zoom: 1 }]);
    settle();
  });

  it("from a masked window in use, leaves its page to main's mask, unzoomed", () => {
    const { desk, desks } = open();
    desk.startMask("tab-0");
    desk.applyMask("tab-0", { x: 10, y: 10, w: 120, h: 90 });
    settle();
    desk.leave();
    expect(desks.at(-1)?.zoomed).toEqual([]);
    settle();
  });
});

describe("a desk with minimized windows, reopened", () => {
  it("brings them back minimized, parked or out, with the box each grows back to; the window it opens on at its own size", () => {
    const saved: SavedDeskWindow[] = [];
    const first = open({ save: (windows) => saved.splice(0, saved.length, ...windows) });
    first.desk.minimize("tab-1");
    first.desk.minimize("tab-2");
    first.desk.minimize("tab-0");
    settle();
    expect(saved.map((window) => [window.tabId, window.mini?.parked])).toEqual([
      ["tab-1", true],
      ["tab-2", true],
      ["tab-0", true],
    ]);
    first.desk.destroy();

    native();
    const desk = engine();
    desk.start(saved, "tab-0", ["tab-0", "tab-1", "tab-2", "tab-3"]);
    settle();
    const views = new Map(desk.getView().windows.map((window) => [window.tabId, window]));
    expect(views.get("tab-1")?.mini).toBe("parked");
    expect(views.get("tab-2")?.mini).toBe("parked");
    // The tab in view lifts off as the page it is: a window at its own size, on top.
    expect(views.get("tab-0")?.mini).toBeNull();
    expect(desk.windowTabIds().at(-1)).toBe("tab-2");
    desk.expand("tab-1");
    settle();
    const expanded = desk.getView().windows.find((window) => window.tabId === "tab-1");
    expect(expanded?.mini).toBeNull();
    expect(desk.agentLayout().windows.find((window) => window.tabId === "tab-2")?.minimized).toBe(true);
    // Its box is somewhere on the desk above the shelf, not a shelf's size.
    const snapshot = desk.layoutSnapshot().windows.find((window) => window.tabId === "tab-1")!;
    expect(snapshot.rect.w).toBeGreaterThan(MINI_SIZE.w);
    expect(snapshot.mini).toBeNull();
    desk.destroy();
  });
});
