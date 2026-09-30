/**
 * What the desk's engine (src/components/desk/desk-engine.ts) tells main:
 * the first layout goes out even when it is empty, and the desk never holds
 * more windows than main accepts (@pistachio/shell-contracts/desk). And what
 * a window in hand does: a window filling the desk lets go of it as it is
 * dragged, and Shift lands a released window in the tile it lights. And the
 * dock: a click opens a tab where the layout has room, and an icon dragged
 * clear of it becomes the tab's window, held by the title bar. And a window
 * may lie behind the dock, which floats over it — stepping aside for it
 * when it is the window in use. And the desk passing to another group in
 * place: the old group's windows go home, the new group's come out where
 * they were left, and main never hears of more windows than it accepts.
 *
 * The engine runs a frame at a time outside React; here the frames are
 * driven by hand, and the only DOM it needs is a stage box.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DragSample } from "@pistachio/shell-contracts/chrome";
import { isDeskState, MAX_DESK_WINDOWS, type DeskState } from "@pistachio/shell-contracts/desk";
import { NATIVE_SURFACE_MEMBERS, type BrowserLayout } from "@pistachio/shell-contracts/ipc";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { CHROME_INSETS, DeskEngine, DOCK_ICON, DOCK_W, type DeskHost } from "../src/components/desk/desk-engine";
import { carrySize, centeredRect, denormalizeRect, DESK_GAP, windowSize, zoneRect, type Point, type Rect } from "../src/lib/desk/geometry";
import { DEFAULT_DESK_VARIANTS, type SavedDeskWindow } from "../src/lib/desk/store";

let frames: Array<(now: number) => void> = [];
let clock = 0;

/** Run `count` animation frames (or fewer, if the engine stops asking). */
function step(count: number): void {
  for (let i = 0; i < count && frames.length > 0; i += 1) {
    const due = frames;
    frames = [];
    clock += 16;
    for (const frame of due) frame(clock);
  }
}

/** Run animation frames until the engine stops asking for them. */
function settle(): void {
  for (let i = 0; i < 2_000 && frames.length > 0; i += 1) {
    const due = frames;
    frames = [];
    clock += 16;
    for (const frame of due) frame(clock);
  }
}

function native(options: { stills?: boolean } = {}) {
  const layouts: BrowserLayout[] = [];
  const desks: Array<DeskState | null> = [];
  // The drag layer's channel, which a gesture listens on for the pointer.
  const drag: { sample: ((sample: DragSample) => void) | null } = { sample: null };
  const members = Object.fromEntries(Object.keys(NATIVE_SURFACE_MEMBERS).map((member) => [member, vi.fn()]));
  setShellApi({
    ...members,
    setLayout: (layout: BrowserLayout) => layouts.push(layout),
    setDesk: (state: DeskState | null) => desks.push(state),
    // A picture of every page asked for, when the pages are live ones.
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

/** A desk whose pages are all shell-drawn (no live views), over a 1600×1000 stage. */
function engine(host: Partial<DeskHost> = {}): DeskEngine {
  const created = new DeskEngine({
    variants: () => DEFAULT_DESK_VARIANTS,
    hasLivePage: () => false,
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
  created.attachStage({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 1000 }) } as unknown as HTMLElement);
  return created;
}

const tabIds = (count: number): string[] => Array.from({ length: count }, (_, index) => `tab-${index}`);

beforeEach(() => {
  frames = [];
  clock = performance.now();
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
  vi.unstubAllGlobals();
  setShellApi({} as unknown as ShellApiBridge);
});

describe("the desk's first layout", () => {
  it("goes out even with no live page in it, taking down the panes main had up", () => {
    const { layouts } = native();
    const desk = engine();
    desk.start([], "tab-0", tabIds(2));
    expect(layouts[0]).toEqual({ views: [], stacked: true });
    desk.destroy();
  });
});

describe("the desk's window limit", () => {
  it("has only as many windows out as main accepts", () => {
    const { desks } = native();
    const desk = engine();
    const ids = tabIds(MAX_DESK_WINDOWS + 6);
    desk.start([], "tab-0", ids);
    settle();
    for (const tabId of ids) desk.add(tabId, { focus: false });
    settle();
    expect(desk.windowTabIds()).toHaveLength(MAX_DESK_WINDOWS);
    expect(desks.length).toBeGreaterThan(0);
    for (const state of desks) expect(isDeskState(state)).toBe(true);
    desk.destroy();
  });

  it("sends the bottom window home when another comes out onto a full desk", () => {
    const { desks } = native();
    const desk = engine();
    const ids = tabIds(MAX_DESK_WINDOWS + 1);
    desk.start([], "tab-0", ids);
    settle();
    for (const tabId of ids.slice(0, MAX_DESK_WINDOWS)) desk.add(tabId, { focus: false });
    settle();
    const bottom = desk.windowTabIds()[0]!;
    const extra = ids.find((tabId) => !desk.windowTabIds().includes(tabId))!;
    desk.activeChanged(extra);
    settle();
    expect(desk.windowTabIds()).toHaveLength(MAX_DESK_WINDOWS);
    expect(desk.windowTabIds()).toContain(extra);
    expect(desk.windowTabIds()).not.toContain(bottom);
    for (const state of desks) expect(isDeskState(state)).toBe(true);
    desk.destroy();
  });

  it("restores at most the limit, keeping the window in view", () => {
    const { desks } = native();
    const desk = engine();
    const ids = tabIds(MAX_DESK_WINDOWS + 6);
    const saved: SavedDeskWindow[] = ids.map((tabId) => ({ tabId, rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }));
    desk.start(saved, "tab-0", ids);
    settle();
    expect(desk.windowTabIds()).toHaveLength(MAX_DESK_WINDOWS);
    expect(desk.windowTabIds().at(-1)).toBe("tab-0");
    for (const state of desks) expect(isDeskState(state)).toBe(true);
    desk.destroy();
  });
});

/* ------------------------------ in hand ------------------------------ */

/** The desk windows may use on the 1600×1000 stage: all of it but the inventory. */
const usable: Rect = { x: DOCK_W + DESK_GAP, y: 0, w: 1600 - DOCK_W - DESK_GAP, h: 1000 };

/** A stand-in for an element the engine writes to: a window's box is its translate and size. */
function element() {
  const style: Record<string, string> = {};
  // The custom properties the engine writes (a window's `--reveal-*`), kept with the rest.
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

/** A few frames, the clock moving as they go (a gesture keeps asking for them, so settle() would not stop). */
function run(count: number): void {
  for (let i = 0; i < count; i += 1) {
    const due = frames;
    frames = [];
    clock += 16;
    for (const frame of due) frame(clock);
  }
}

function expectRect(actual: Rect, expected: Rect, within = 1): void {
  for (const key of ["x", "y", "w", "h"] as const) expect(Math.abs(actual[key] - expected[key]), `${key}: ${actual[key]} vs ${expected[key]}`).toBeLessThanOrEqual(within);
}

describe("a window in hand", () => {
  let restoreNow: () => void = () => undefined;
  beforeEach(() => {
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    restoreNow = () => spy.mockRestore();
  });
  afterEach(() => restoreNow());

  /** One window out, centred, with its element and the zone's attached. */
  function open(host: Partial<DeskHost> = {}) {
    const { drag } = native();
    const desk = engine(host);
    const zone = element();
    const win = element();
    desk.attachZone(zone as unknown as HTMLElement);
    desk.start([], "tab-0", tabIds(2));
    desk.attachWindow("tab-0", win as unknown as HTMLElement);
    settle();
    /** The pointer moves (in the stage, which is the window's content box here), a frame at a time. */
    const move = (x: number, y: number, shift?: boolean): void => {
      drag.sample?.({ x, y, phase: "move", ...(shift === undefined ? {} : { shift }) });
      run(1);
    };
    const release = (): void => {
      drag.sample?.({ x: 0, y: 0, phase: "cancel" });
      settle();
    };
    /** Let go, and only a frame or two pass: whatever it was let go into is still under way. */
    const letGo = (): void => {
      drag.sample?.({ x: 0, y: 0, phase: "cancel" });
      run(2);
    };
    return { desk, zone, win, move, release, letGo };
  }

  it("lets go of the whole desk once dragged: back to its own size, still held by its title bar", () => {
    const { desk, win, move, release } = open();
    expectRect(rectOf(win), centeredRect(usable));
    desk.toggleMaximize("tab-0");
    settle();
    expectRect(rectOf(win), usable);
    // Grab the title bar three quarters along it, and pull.
    const at = { x: usable.x + usable.w * 0.75, y: 17 };
    desk.grab("tab-0", at);
    // Not on the move yet: nothing changes.
    run(3);
    expectRect(rectOf(win), usable);
    for (let step = 1; step <= 40; step += 1) move(at.x - step * 4, at.y + step * 3);
    const own = centeredRect(usable);
    const carried = rectOf(win);
    expect(Math.abs(carried.w - own.w)).toBeLessThan(2);
    expect(Math.abs(carried.h - own.h)).toBeLessThan(2);
    // Held where it was: three quarters along the bar, 17px below the top.
    const pointer = { x: at.x - 160, y: at.y + 120 };
    expect(Math.abs(pointer.x - (carried.x + carried.w * 0.75))).toBeLessThan(3);
    expect(Math.abs(pointer.y - (carried.y + 17))).toBeLessThan(3);
    release();
    const rested = rectOf(win);
    expect(Math.abs(rested.w - own.w)).toBeLessThan(2);
    expect(desk.getView().windows[0]!.maximized).toBe(false);
    desk.destroy();
  });

  it("coasts a shorter way, thrown alike, the more Glide decelerates", () => {
    const thrownWith = (deceleration: number): number => {
      const { desk, win, move, release } = open({ variants: () => ({ ...DEFAULT_DESK_VARIANTS, deceleration }) });
      const start = rectOf(win);
      const at = { x: start.x + 200, y: start.y + 17 };
      desk.grab("tab-0", at);
      // 8px a frame, let go on the move: 500px/s.
      for (let step = 1; step <= 10; step += 1) move(at.x + step * 8, at.y);
      release();
      const travelled = rectOf(win).x - start.x;
      desk.destroy();
      return travelled;
    };
    const usual = thrownWith(DEFAULT_DESK_VARIANTS.deceleration);
    const quick = thrownWith(60);
    const gentle = thrownWith(12);
    // Past where the pointer let go, by the coast.
    expect(quick).toBeGreaterThan(80);
    expect(quick).toBeLessThan(usual - 40);
    expect(gentle).toBeGreaterThan(usual + 40);
  });

  it("with no size of its own to go back to, takes the size windows come out at", () => {
    const { drag } = native();
    const desk = engine();
    const win = element();
    desk.start([{ tabId: "tab-0", rect: { x: 0, y: 0, w: 1, h: 1 } }], "tab-0", tabIds(1));
    desk.attachWindow("tab-0", win as unknown as HTMLElement);
    settle();
    expectRect(rectOf(win), usable);
    desk.grab("tab-0", { x: usable.x + 400, y: 17 });
    for (let step = 1; step <= 40; step += 1) {
      drag.sample?.({ x: usable.x + 400 + step * 5, y: 17 + step * 5, phase: "move" });
      run(1);
    }
    const size = windowSize(usable);
    expect(Math.abs(rectOf(win).w - size.w)).toBeLessThan(2);
    expect(Math.abs(rectOf(win).h - size.h)).toBeLessThan(2);
    drag.sample?.({ x: 0, y: 0, phase: "cancel" });
    settle();
    desk.destroy();
  });

  /** One window out where it was saved (fractions of the desk beside the dock), dragged by its title bar `by` a step at a time. */
  function dragSaved(saved: Rect, by: { x: number; y: number }) {
    const { drag } = native();
    const desk = engine();
    const win = element();
    desk.start([{ tabId: "tab-0", rect: saved }], "tab-0", tabIds(1));
    desk.attachWindow("tab-0", win as unknown as HTMLElement);
    settle();
    const before = rectOf(win);
    const at = { x: before.x + 200, y: before.y + 17 };
    desk.grab("tab-0", at);
    for (let step = 1; step <= 40; step += 1) {
      drag.sample?.({ x: at.x + (by.x * step) / 40, y: at.y + (by.y * step) / 40, phase: "move" });
      run(1);
    }
    const carried = rectOf(win);
    drag.sample?.({ x: 0, y: 0, phase: "cancel" });
    settle();
    desk.destroy();
    return { before, carried, at: { x: at.x + by.x, y: at.y + by.y } };
  }

  it("lets go of the desk's height once dragged, a tall half keeping its width, still held by its title bar", () => {
    const { before, carried, at } = dragSaved({ x: 0, y: 0, w: 0.5, h: 1 }, { x: 160, y: 80 });
    expect(before.h).toBeGreaterThan(usable.h * 0.95);
    expect(Math.abs(carried.w - before.w)).toBeLessThan(2);
    expect(Math.abs(carried.h - windowSize(usable).h)).toBeLessThan(2);
    expect(Math.abs(at.y - (carried.y + 17))).toBeLessThan(3);
  });

  it("lets go of the desk's width once dragged, a wide half keeping its height", () => {
    const { before, carried } = dragSaved({ x: 0, y: 0, w: 1, h: 0.5 }, { x: 60, y: 160 });
    expect(before.w).toBeGreaterThan(usable.w * 0.95);
    expect(Math.abs(carried.h - before.h)).toBeLessThan(2);
    expect(Math.abs(carried.w - windowSize(usable).w)).toBeLessThan(2);
  });

  it("keeps its size, dragged, when it spans the desk neither way", () => {
    const { before, carried } = dragSaved({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 160, y: 80 });
    expect(Math.abs(carried.w - before.w)).toBeLessThan(2);
    expect(Math.abs(carried.h - before.h)).toBeLessThan(2);
  });

  it("with Shift held, lights the tile under the pointer and lands in it", () => {
    const { desk, zone, win, move, release } = open();
    const start = rectOf(win);
    const at = { x: start.x + 200, y: start.y + 17 };
    desk.grab("tab-0", at);
    move(at.x + 10, at.y + 10);
    expect(zone.dataset["on"]).toBeUndefined();
    // Shift goes down with the pointer standing still: the tile lights at once.
    desk.setShift(true);
    expect(zone.dataset["on"]).toBe("");
    expect(zone.dataset["snap"]).toBe("");
    expect(desk.getView().snapping).toBe(true);
    expect(desk.getView().windows[0]!.aiming).toBe(true);
    // Over the desk's left third, halfway down: the left half.
    for (let step = 1; step <= 10; step += 1) move(at.x + 10 + (usable.x + 60 - at.x - 10) * (step / 10), 500);
    const left = zoneRect("left", usable);
    expect(Number.parseFloat(zone.style["width"]!)).toBeCloseTo(left.w, 0);
    release();
    expectRect(rectOf(win), left);
    expect(desk.getView().snapping).toBe(false);
    desk.destroy();
  });

  it("reads Shift from the pointer too, and goes free when it is let go", () => {
    const { desk, zone, win, move, release } = open();
    const start = rectOf(win);
    const at = { x: start.x + 200, y: start.y + 17 };
    desk.grab("tab-0", at);
    // The top right third, Shift held (as a pointer event says): a quarter.
    for (let step = 1; step <= 8; step += 1) move(at.x + step * 40, at.y + 30, true);
    move(usable.x + usable.w - 80, 120, true);
    expect(Number.parseFloat(zone.style["width"]!)).toBeCloseTo(zoneRect("top-right", usable).w, 0);
    // Shift up, the pointer away from the edges: nothing is lit, and it stays where it is put.
    move(usable.x + 400, 150, false);
    expect(zone.dataset["on"]).toBeUndefined();
    for (let step = 0; step < 12; step += 1) move(usable.x + 400, 150);
    const before = rectOf(win);
    release();
    const after = rectOf(win);
    expect(Math.abs(after.x - before.x)).toBeLessThan(2);
    expect(Math.abs(after.y - before.y)).toBeLessThan(2);
    expect(Math.abs(after.w - start.w)).toBeLessThan(2);
    desk.destroy();
  });

  it("shows the dock's pads only near the desk's leading edge, and lights the one a release would go to", () => {
    const { desk, win, move, release } = open();
    const start = rectOf(win);
    desk.grab("tab-0", { x: start.x + 200, y: start.y + 17 });
    move(start.x + 260, start.y + 60);
    expect(desk.getView().dropsShown).toBe(false);
    move(usable.x + 100, 300);
    expect(desk.getView().dropsShown).toBe(true);
    expect(desk.getView().dockDrop).toBeNull();
    move(30, 300);
    expect(desk.getView().dockDrop).toBe("away");
    move(30, 940);
    expect(desk.getView().dockDrop).toBe("close");
    // Back across the desk's edge band: the left half again, not a pad.
    move(usable.x + 10, 500);
    expect(desk.getView().dockDrop).toBeNull();
    release();
    expectRect(rectOf(win), zoneRect("left", usable));
    expect(desk.getView().dropsShown).toBe(false);
    desk.destroy();
  });

  it("puts a window let go on the upper pad back into the dock, its tab kept", () => {
    const close = vi.fn();
    const { desk, win, move, release } = open({ close });
    const start = rectOf(win);
    desk.grab("tab-0", { x: start.x + 200, y: start.y + 17 });
    for (let step = 1; step <= 8; step += 1) move(start.x + 200 - step * ((start.x + 170) / 8), 300);
    expect(desk.getView().dockDrop).toBe("away");
    release();
    expect(desk.windowTabIds()).toEqual([]);
    expect(close).not.toHaveBeenCalled();
    desk.destroy();
  });

  it("closes the tab of a window let go on the lower pad, once it has gone into it", () => {
    const close = vi.fn();
    const { desk, win, move, release } = open({ close });
    const start = rectOf(win);
    desk.grab("tab-0", { x: start.x + 200, y: start.y + 17 });
    for (let step = 1; step <= 8; step += 1) move(start.x + 200 - step * ((start.x + 170) / 8), 300 + step * 80);
    expect(desk.getView().dockDrop).toBe("close");
    release();
    expect(desk.windowTabIds()).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith("tab-0");
    desk.destroy();
  });

  it("closes a window let go on the lower pad even when the agent, or Undo layout, asks for it on its way there", () => {
    const close = vi.fn();
    const { desk, win, move, letGo } = open({ close });
    const before = desk.layoutSnapshot();
    const start = rectOf(win);
    desk.grab("tab-0", { x: start.x + 200, y: start.y + 17 });
    for (let step = 1; step <= 8; step += 1) move(start.x + 200 - step * ((start.x + 170) / 8), 300 + step * 80);
    expect(desk.getView().dockDrop).toBe("close");
    letGo();
    // Going into the Close pad is the person's: a placement or an Undo does not bring it back.
    desk.arrangeFor({ place: [{ tabId: "tab-0", zone: "left" }] });
    desk.restoreLayout(before);
    settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith("tab-0");
    expect(desk.windowTabIds()).toEqual([]);
    desk.destroy();
  });

  it("aims the middle of the desk at a comfortable window in the centre", () => {
    const { desk, win, move, release } = open();
    desk.toggleMaximize("tab-0");
    settle();
    desk.grab("tab-0", { x: usable.x + 300, y: 17 }, true);
    for (let step = 1; step <= 20; step += 1) move(usable.x + 300 + step * 20, 17 + step * 24, true);
    release();
    expectRect(rectOf(win), centeredRect(usable));
    desk.destroy();
  });
});

/* --------------------------- a window's title --------------------------- */

describe("a window's title", () => {
  let restoreNow: () => void = () => undefined;
  let listeners: Map<string, Set<(event: unknown) => void>>;
  beforeEach(() => {
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    restoreNow = () => spy.mockRestore();
    listeners = new Map();
    vi.stubGlobal("window", {
      setInterval: () => 0,
      clearInterval: () => undefined,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: (event: unknown) => void) => listeners.get(type)?.delete(listener),
      matchMedia: () => ({ matches: false }),
      devicePixelRatio: 1,
    });
  });
  afterEach(() => restoreNow());

  const dispatch = (type: string, x: number, y: number): void => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener({ clientX: x, clientY: y, shiftKey: false });
  };

  function titled() {
    native();
    const edited: string[] = [];
    const desk = engine({ editAddress: (tabId) => edited.push(tabId) });
    const win = element();
    desk.start([], "tab-0", tabIds(1));
    desk.attachWindow("tab-0", win as unknown as HTMLElement);
    settle();
    const title = { x: rectOf(win).x + 60, y: rectOf(win).y + 17 };
    return { desk, win, edited, title };
  }

  it("clicked, opens the tab's address to edit; twice, never fills the desk", () => {
    const { desk, edited, title } = titled();
    desk.press("tab-0", { clientX: title.x, clientY: title.y, button: 0 }, "title");
    dispatch("pointerup", title.x, title.y);
    expect(edited).toEqual(["tab-0"]);
    desk.press("tab-0", { clientX: title.x, clientY: title.y, button: 0 }, "title");
    dispatch("pointerup", title.x, title.y);
    settle();
    expect(edited).toEqual(["tab-0", "tab-0"]);
    expect(desk.getView().windows[0]!.maximized).toBe(false);
    desk.destroy();
  });

  it("dragged, moves the window, as the rest of the bar does, and opens nothing", () => {
    const { desk, edited, title } = titled();
    desk.press("tab-0", { clientX: title.x, clientY: title.y, button: 0 }, "title");
    dispatch("pointermove", title.x + 40, title.y + 30);
    expect(desk.getView().windows[0]!.carried).toBe(true);
    dispatch("pointerup", title.x + 40, title.y + 30);
    expect(edited).toEqual([]);
    desk.destroy();
  });
});

/* ------------------------------ the dock ------------------------------ */

describe("the dock", () => {
  let restoreNow: () => void = () => undefined;
  /** The shell page's own pointer listeners (a press on an icon is tracked there until it travels). */
  let listeners: Map<string, Set<(event: unknown) => void>>;
  beforeEach(() => {
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    restoreNow = () => spy.mockRestore();
    listeners = new Map();
    vi.stubGlobal("window", {
      setInterval: () => 0,
      clearInterval: () => undefined,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: (event: unknown) => void) => listeners.get(type)?.delete(listener),
      matchMedia: () => ({ matches: false }),
      devicePixelRatio: 1,
    });
  });
  afterEach(() => restoreNow());

  const dispatch = (type: string, x: number, y: number): void => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener({ clientX: x, clientY: y, shiftKey: false });
  };

  /**
   * Tab 0 out as a window; the rest in the dock (two tabs, unless said).
   * Icons sit in the dock's column, 40px square, 46px apart — and under
   * them, the other groups' icons, 50px apart.
   */
  function dock(options: { tabs?: number; groups?: readonly string[]; host?: Partial<DeskHost> } = {}) {
    const { drag } = native();
    const desk = engine(options.host);
    const ghost = element();
    const windows = new Map<string, ReturnType<typeof element>>();
    const count = options.tabs ?? 2;
    desk.attachGhost(ghost as unknown as HTMLElement);
    desk.start([], "tab-0", tabIds(count));
    const icon = (top: number): HTMLElement =>
      ({ isConnected: true, getBoundingClientRect: () => ({ left: 10, top, width: DOCK_ICON, height: DOCK_ICON }) }) as unknown as HTMLElement;
    for (const [index, tabId] of tabIds(count).entries()) desk.attachIcon(tabId, icon(400 + index * 46));
    const groupTop = (index: number): number => 400 + count * 46 + 20 + index * 50;
    for (const [index, groupId] of (options.groups ?? []).entries()) desk.attachGroupIcon(groupId, icon(groupTop(index)));
    const attach = (tabId: string): ReturnType<typeof element> => {
      const win = element();
      windows.set(tabId, win);
      desk.attachWindow(tabId, win as unknown as HTMLElement);
      return win;
    };
    attach("tab-0");
    settle();
    const move = (x: number, y: number): void => {
      drag.sample?.({ x, y, phase: "move" });
      run(1);
    };
    const release = (): void => {
      drag.sample?.({ x: 0, y: 0, phase: "cancel" });
      settle();
    };
    /** Press tab `index`'s icon and pull it past the slop, as a person starts a drag. */
    const pull = (index: number): void => {
      const at = { x: 30, y: 420 + index * 46 };
      desk.pressIcon(`tab-${index}`, { clientX: at.x, clientY: at.y, button: 0 });
      dispatch("pointermove", at.x + 8, at.y);
    };
    /** The same for another group's icon; a click there calls `onClick`. */
    const pullGroup = (index: number, onClick: () => void = () => undefined): void => {
      const at = { x: 30, y: groupTop(index) + 20 };
      desk.pressGroup(options.groups![index]!, { clientX: at.x, clientY: at.y, button: 0 }, onClick);
      dispatch("pointermove", at.x, at.y + 8);
    };
    return { desk, ghost, attach, move, release, pull, pullGroup, groupTop };
  }

  it("brings a tab out where the layout has room: filling the desk, the window in use gives up half", () => {
    const { desk, attach } = dock();
    desk.toggleMaximize("tab-0");
    settle();
    desk.add("tab-1", { focus: true });
    const added = attach("tab-1");
    settle();
    expectRect(rectOf(added), zoneRect("right", usable));
    desk.destroy();
  });

  it("raises a window that is out rather than opening another", () => {
    const { desk } = dock();
    desk.add("tab-1", { focus: true });
    settle();
    expect(desk.windowTabIds()).toEqual(["tab-0", "tab-1"]);
    desk.add("tab-0", { focus: true });
    settle();
    expect(desk.windowTabIds()).toEqual(["tab-1", "tab-0"]);
    desk.destroy();
  });

  it("leaves a window alone while only its icon is in hand, Shift or no Shift", () => {
    const { desk, attach, move, release, pull } = dock();
    const win = attach("tab-0");
    const before = rectOf(win);
    pull(0);
    move(DOCK_W + 10, 460);
    expect(desk.getView().iconDrag).toBe("tab-0");
    desk.setShift(true);
    move(DOCK_W + 12, 470);
    desk.setShift(false);
    expectRect(rectOf(win), before);
    release();
    expectRect(rectOf(win), before);
    desk.destroy();
  });

  it("lets go of an icon still in the dock with nothing changed", () => {
    const { desk, ghost, move, release, pull } = dock();
    pull(1);
    expect(desk.getView().iconDrag).toBe("tab-1");
    expect(ghost.dataset["on"]).toBe("");
    move(DOCK_W + 10, 440);
    expect(desk.getView().iconDrag).toBe("tab-1");
    release();
    expect(ghost.dataset["on"]).toBeUndefined();
    expect(desk.getView().iconDrag).toBeNull();
    expect(desk.windowTabIds()).toEqual(["tab-0"]);
    desk.destroy();
  });

  it("makes room among the group's tabs for an icon moved down the dock, and let go, the tab takes that place", () => {
    const reordered: Array<[string, number]> = [];
    const { desk, ghost, move, release, pull } = dock({ tabs: 3, host: { reorderTab: (tabId, index) => reordered.push([tabId, index]) } });
    pull(0);
    // Past tab 1's middle (466), not tab 2's (512): the place after tab 1.
    move(30, 480);
    expect(desk.getView().dockDrag).toEqual({ kind: "tab", id: "tab-0", order: ["tab-0", "tab-1", "tab-2"], to: 1, into: null, pitch: 46 });
    move(34, 530);
    expect(desk.getView().dockDrag?.to).toBe(2);
    release();
    expect(reordered).toEqual([["tab-0", 2]]);
    // Shown in its place at once, before the browser has said so, and the icon has flown there (the last place, 492).
    expect(desk.getView().dockSettle).toEqual({ tabs: ["tab-1", "tab-2", "tab-0"], groups: null, gone: null });
    expect(ghost.style["transform"]).toContain("translate3d(10.0px, 492.0px, 0)");
    expect(ghost.dataset["on"]).toBeUndefined();
    expect(desk.getView().iconDrag).toBeNull();
    expect(desk.getView().dockDrag).toBeNull();
    // The browser's order catches up: the dock shows its own again. Nothing on the desk moved.
    desk.syncTabs(["tab-1", "tab-2", "tab-0"]);
    expect(desk.getView().dockSettle).toBeNull();
    expect(desk.windowTabIds()).toEqual(["tab-0"]);
    desk.destroy();
  });

  it("moves an icon up the dock too, and let go where it started, changes nothing", () => {
    const reordered: Array<[string, number]> = [];
    const { desk, move, release, pull } = dock({ tabs: 3, host: { reorderTab: (tabId, index) => reordered.push([tabId, index]) } });
    pull(2);
    move(30, 440);
    expect(desk.getView().dockDrag?.to).toBe(1);
    move(30, 400);
    expect(desk.getView().dockDrag?.to).toBe(0);
    move(30, 520);
    expect(desk.getView().dockDrag?.to).toBe(2);
    release();
    expect(reordered).toEqual([]);
    expect(desk.getView().dockSettle).toBeNull();
    desk.destroy();
  });

  it("lets a tab's icon go into another group, as an app into a folder: its window flies into that group's icon, the one under it taking over", () => {
    const moved: Array<[string, string, string | null]> = [];
    const selected: string[] = [];
    const { desk, attach, move, release, pull, groupTop } = dock({
      tabs: 3,
      groups: ["group-1", "group-2"],
      host: { moveTabToGroup: (tabId, groupId, next) => moved.push([tabId, groupId, next]), select: (tabId) => selected.push(tabId) },
    });
    desk.add("tab-1", { focus: true });
    attach("tab-1");
    settle();
    expect(desk.focusedTabId()).toBe("tab-1");
    pull(1);
    move(30, groupTop(1) + 22);
    // Over a group: it is not among the tabs any more, and the tabs close up behind it.
    expect(desk.getView().dockDrag).toMatchObject({ id: "tab-1", to: null, into: "group-2" });
    move(30, groupTop(0) + 18);
    expect(desk.getView().dockDrag?.into).toBe("group-1");
    release();
    expect(moved).toEqual([["tab-1", "group-1", "tab-0"]]);
    expect(selected.at(-1)).toBe("tab-0");
    expect(desk.getView().dockSettle).toEqual({ tabs: ["tab-0", "tab-2"], groups: null, gone: "tab-1" });
    // The tab has left the group, and its window has gone into the other's icon.
    desk.syncTabs(["tab-0", "tab-2"]);
    settle();
    expect(desk.windowTabIds()).toEqual(["tab-0"]);
    expect(desk.focusedTabId()).toBe("tab-0");
    desk.destroy();
  });

  it("pulled clear of the dock, a tab's icon is its window again, and its section closes up as it was", () => {
    const { desk, move, pull } = dock({ tabs: 3 });
    pull(0);
    move(30, 480);
    expect(desk.getView().dockDrag?.to).toBe(1);
    move(DOCK_W + 60, 480);
    expect(desk.getView().dockDrag).toBeNull();
    expect(desk.getView().gesture).toBe("move");
    desk.destroy();
  });

  it("moves another group's icon among the groups, never out of the dock; a click passes the desk to it", () => {
    const reordered: Array<[string, readonly string[]]> = [];
    const { desk, ghost, move, release, pullGroup, groupTop } = dock({
      groups: ["group-1", "group-2", "group-3"],
      host: { reorderGroup: (groupId, order) => reordered.push([groupId, order]) },
    });
    pullGroup(0);
    expect(desk.getView().groupDrag).toBe("group-1");
    expect(desk.getView().iconDrag).toBeNull();
    // Far out over the desk: still its icon, in the dock, and it follows the pointer only a little way out.
    move(DOCK_W + 300, groupTop(1) + 30);
    expect(desk.getView().gesture).toBe("icon");
    expect(desk.getView().dockDrag).toMatchObject({ kind: "group", id: "group-1", to: 1, into: null, pitch: 50 });
    expect(desk.windowTabIds()).toEqual(["tab-0"]);
    const x = Number(/translate3d\((-?[\d.]+)px/.exec(ghost.style["transform"]!)![1]);
    expect(x).toBeLessThan(DOCK_W + 40);
    release();
    expect(reordered).toEqual([["group-1", ["group-2", "group-1", "group-3"]]]);
    expect(desk.getView().dockSettle).toEqual({ tabs: null, groups: ["group-2", "group-1", "group-3"], gone: null });
    expect(desk.getView().groupDrag).toBeNull();
    let clicked = 0;
    desk.pressGroup("group-3", { clientX: 30, clientY: groupTop(2) + 20, button: 0 }, () => (clicked += 1));
    dispatch("pointerup", 30, groupTop(2) + 20);
    expect(clicked).toBe(1);
    expect(reordered).toHaveLength(1);
    desk.destroy();
  });

  it("turns an icon pulled clear of the dock into its window, held by the title bar", () => {
    const { desk, ghost, attach, move, release, pull } = dock();
    pull(1);
    move(DOCK_W + 60, 460);
    expect(ghost.dataset["on"]).toBeUndefined();
    expect(desk.getView().iconDrag).toBeNull();
    expect(desk.windowTabIds()).toEqual(["tab-0", "tab-1"]);
    const win = attach("tab-1");
    for (let step = 1; step <= 10; step += 1) move(DOCK_W + 60 + step * 20, 460 + step * 10);
    const pointer = { x: DOCK_W + 260, y: 560 };
    const carried = rectOf(win);
    const size = windowSize(usable);
    expect(carried.w).toBeCloseTo(size.w, 0);
    // The title bar is under the pointer, near its leading end.
    expect(pointer.y - carried.y).toBeCloseTo(CHROME_INSETS.bar.top / 2, 0);
    expect(pointer.x - carried.x).toBeGreaterThanOrEqual(28);
    expect(pointer.x - carried.x).toBeLessThan(size.w / 2);
    for (let step = 0; step < 12; step += 1) move(pointer.x, pointer.y);
    release();
    const rested = rectOf(win);
    expect(Math.abs(rested.x - carried.x)).toBeLessThan(2);
    expect(desk.getView().windows.at(-1)!.tabId).toBe("tab-1");
    desk.destroy();
  });

  it("brings a window that is out to the hand, its shape kept, its title bar under the pointer", () => {
    const { desk, attach, move, release, pull } = dock();
    const win = attach("tab-0");
    const before = rectOf(win);
    pull(0);
    const pointer = { x: DOCK_W + 200, y: 300 };
    for (let step = 1; step <= 6; step += 1) move(DOCK_W + 20 + step * 30, 420 - step * 20);
    // It flies there: give the catch a moment with the pointer still.
    for (let step = 0; step < 40; step += 1) move(pointer.x, pointer.y);
    const held = rectOf(win);
    // Most of the desk's height is too tall to carry: it comes scaled down, the same shape.
    const carried = carrySize(before, usable);
    expect(carried.h).toBeLessThan(before.h);
    expect(held.w).toBeCloseTo(carried.w, 0);
    expect(held.h).toBeCloseTo(carried.h, 0);
    expect(pointer.y - held.y).toBeCloseTo(CHROME_INSETS.bar.top / 2, 0);
    expect(pointer.x - held.x).toBeGreaterThanOrEqual(28);
    release();
    expect(desk.windowTabIds()).toEqual(["tab-0"]);
    desk.destroy();
  });
});


/* ------------------------- behind the dock ------------------------- */

describe("a window behind the dock", () => {
  let restoreNow: () => void = () => undefined;
  let listeners: Map<string, Set<(event: unknown) => void>>;
  beforeEach(() => {
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    restoreNow = () => spy.mockRestore();
    listeners = new Map();
    vi.stubGlobal("window", {
      setInterval: () => 0,
      clearInterval: () => undefined,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: (event: unknown) => void) => listeners.get(type)?.delete(listener),
      matchMedia: () => ({ matches: false }),
      devicePixelRatio: 1,
    });
    // A still is decoded before it is shown.
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        decode(): Promise<void> {
          return Promise.resolve();
        }
      },
    );
  });
  afterEach(() => restoreNow());

  /** The dock's shelf, centred on the 1000px stage's leading edge. */
  const shelf: Rect = { x: 0, y: 300, w: DOCK_W, h: 400 };

  /** Stills on their way in, and the frames that put them on screen. */
  async function flush(): Promise<void> {
    for (let round = 0; round < 4; round += 1) {
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
      settle();
    }
  }

  function open(live: boolean) {
    const { drag, layouts, desks } = native({ stills: live });
    const desk = engine({ hasLivePage: () => live });
    const win = element();
    desk.setDockShelf(shelf);
    desk.start([], "tab-0", tabIds(2));
    desk.attachWindow("tab-0", win as unknown as HTMLElement);
    settle();
    const move = (x: number, y: number): void => {
      drag.sample?.({ x, y, phase: "move" });
      run(1);
    };
    /** Carry the window by its title bar, well along it, until its leading edge is at `x`; hold still, and let go. */
    const tuck = (x: number): void => {
      const start = rectOf(win);
      const hold = { x: 320, y: 17 };
      desk.grab("tab-0", { x: start.x + hold.x, y: start.y + hold.y });
      for (let step = 1; step <= 10; step += 1) move(start.x + hold.x + (x - start.x) * (step / 10), start.y + hold.y);
      for (let step = 0; step < 12; step += 1) move(x + hold.x, start.y + hold.y);
      drag.sample?.({ x: 0, y: 0, phase: "cancel" });
      settle();
    };
    const click = (x: number, y: number): void => {
      desk.press("tab-0", { clientX: x, clientY: y, button: 0 }, "content");
      for (const listener of [...(listeners.get("pointerup") ?? [])]) listener({ clientX: x, clientY: y });
    };
    const livePages = (): string[] => layouts.at(-1)!.views.map((view) => view.tabId);
    return { desk, win, move, tuck, click, layouts, desks, livePages };
  }

  it("rests where it is let go in the dock's column, as far as the desk's leading edge", () => {
    const { desk, win, tuck } = open(false);
    tuck(24);
    expect(Math.abs(rectOf(win).x - 24)).toBeLessThan(1.5);
    // Pushed further, it stops at the desk's edge.
    tuck(-200);
    expect(Math.abs(rectOf(win).x)).toBeLessThan(1.5);
    // Near the dock's edge, it sticks to it.
    tuck(usable.x - 9);
    expect(Math.abs(rectOf(win).x - usable.x)).toBeLessThan(1.5);
    desk.destroy();
  });

  it("keeps filling the desk clear of the dock, and comes back to where it lay", () => {
    const { desk, win, tuck } = open(false);
    tuck(20);
    const tucked = rectOf(win);
    desk.toggleMaximize("tab-0");
    settle();
    expectRect(rectOf(win), usable);
    desk.toggleMaximize("tab-0");
    settle();
    expectRect(rectOf(win), tucked);
    desk.destroy();
  });

  it("resizes out to the desk's leading edge, sticking at the dock's on the way", () => {
    const { desk, win, move } = open(false);
    const start = rectOf(win);
    const y = start.y + 100;
    desk.resize("tab-0", { left: true, right: false, top: false, bottom: false }, { clientX: start.x, clientY: y, button: 0 });
    move(usable.x - 6, y);
    expect(Math.abs(rectOf(win).x - usable.x)).toBeLessThan(1);
    move(12, y);
    expect(Math.abs(rectOf(win).x - 12)).toBeLessThan(1);
    move(-80, y);
    expect(Math.abs(rectOf(win).x)).toBeLessThan(1);
    // The opposite edge holds still.
    expect(Math.abs(rectOf(win).x + rectOf(win).w - (start.x + start.w))).toBeLessThan(1);
    desk.destroy();
  });

  it("is drawn under the dock; used, the dock steps aside for it, and comes back when the pointer comes to it", async () => {
    const { desk, win, tuck, click, desks, livePages } = open(true);
    await flush();
    expect(livePages()).toEqual(["tab-0"]);
    tuck(20);
    await flush();
    // Under the dock: its still, and the dock over it.
    let view = desk.getView();
    expect(rectOf(win).x).toBeLessThan(shelf.w);
    expect(view.windows[0]!.drawn).toBe(true);
    expect(view.dockAside).toBe(false);
    expect(livePages()).toEqual([]);
    // Clicked into, it is the window in use: the dock slides away, and once it has gone the page is live.
    click(rectOf(win).x + 400, 500);
    expect(desk.getView().dockAside).toBe(true);
    expect(livePages()).toEqual([]);
    await flush();
    expect(desk.getView().windows[0]!.drawn).toBe(false);
    expect(livePages()).toEqual(["tab-0"]);
    // Main watches the dock's place for the pointer, over that page.
    expect(desks.at(-1)!.dock).toEqual({ x: 0, y: shelf.y - 8, width: DOCK_W + DESK_GAP, height: shelf.h + 16 });
    // The pointer comes there: the page gives way to its still, and the dock comes back over it.
    desk.pointerAtDock();
    await flush();
    view = desk.getView();
    expect(view.dockAside).toBe(false);
    expect(view.windows[0]!.drawn).toBe(true);
    expect(desks.at(-1)!.dock ?? null).toBeNull();
    // Off it again, over the window: aside once more.
    desk.notePointer({ x: 700, y: 500 });
    await flush();
    expect(desk.getView().dockAside).toBe(true);
    expect(livePages()).toEqual(["tab-0"]);
    // The Feel menu open beside the dock holds it there.
    desk.holdDock("feel", true);
    await flush();
    expect(desk.getView().dockAside).toBe(false);
    desk.holdDock("feel", false);
    await flush();
    expect(desk.getView().dockAside).toBe(true);
    desk.destroy();
  });

  it("stays drawn under the dock when it is only let go there", async () => {
    const { desk, win, tuck, livePages } = open(true);
    await flush();
    tuck(20);
    await flush();
    // Let go, it is the window in use too — but the dock stays until it is chosen.
    expect(desk.focusedTabId()).toBe("tab-0");
    expect(desk.getView().dockAside).toBe(false);
    expect(livePages()).toEqual([]);
    // Another window in use: the dock stays over this one. Chosen from outside the desk (the sidebar), the dock steps aside for it.
    desk.add("tab-1", { focus: true });
    desk.attachWindow("tab-1", element() as unknown as HTMLElement);
    await flush();
    expect(desk.focusedTabId()).toBe("tab-1");
    expect(desk.getView().dockAside).toBe(false);
    desk.activeChanged("tab-0");
    await flush();
    expect(desk.getView().dockAside).toBe(true);
    expect(livePages()).toContain("tab-0");
    // Out from behind the dock, it is live again.
    tuck(usable.x + 40);
    await flush();
    expect(rectOf(win).x).toBeGreaterThan(usable.x);
    expect(livePages()).toEqual(["tab-0"]);
    desk.destroy();
  });
});

/* ------------------------------ masks ------------------------------ */

describe("a masked window", () => {
  let restoreNow: () => void = () => undefined;
  let listeners: Map<string, Set<(event: unknown) => void>>;
  beforeEach(() => {
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    restoreNow = () => spy.mockRestore();
    listeners = new Map();
    vi.stubGlobal("window", {
      setInterval: () => 0,
      clearInterval: () => undefined,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: (event: unknown) => void) => listeners.get(type)?.delete(listener),
      matchMedia: () => ({ matches: false }),
      devicePixelRatio: 1,
    });
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        decode(): Promise<void> {
          return Promise.resolve();
        }
      },
    );
  });
  afterEach(() => restoreNow());

  async function flush(): Promise<void> {
    for (let round = 0; round < 4; round += 1) {
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
      settle();
    }
  }

  /** Tab 0 out, centred, its page live; masked (by the bar variant's insets) at a region of its page. */
  async function masked(region: Rect = { x: 100, y: 50, w: 300, h: 200 }, host: Partial<DeskHost> = {}) {
    const { drag, layouts, desks } = native({ stills: true });
    const desk = engine({ hasLivePage: () => true, ...host });
    const win = element();
    desk.start([], "tab-0", tabIds(2));
    desk.attachWindow("tab-0", win as unknown as HTMLElement);
    await flush();
    const before = rectOf(win);
    desk.startMask("tab-0");
    await flush();
    expect(desk.getView().windows[0]!.selecting).toBe(true);
    expect(desk.getView().windows[0]!.drawn).toBe(true);
    desk.applyMask("tab-0", region);
    await flush();
    const move = (x: number, y: number): void => {
      drag.sample?.({ x, y, phase: "move" });
      run(1);
    };
    const release = async (): Promise<void> => {
      drag.sample?.({ x: 0, y: 0, phase: "cancel" });
      await flush();
    };
    const lastMasks = () => desks.at(-1)!.masks ?? [];
    const livePages = (): string[] => layouts.at(-1)!.views.map((view) => view.tabId);
    return { desk, win, before, region, move, release, layouts, lastMasks, livePages };
  }

  const bar = CHROME_INSETS.bar;

  it("is its region, where it was on the page, at its own size, and main shows only that region", async () => {
    const { desk, win, before, region, lastMasks, livePages, layouts } = await masked();
    const page = { x: before.x + bar.left, y: before.y + bar.top, w: before.w - bar.left - bar.right, h: before.h - bar.top - bar.bottom };
    // The handle rides above the region; the region lies where it lay on the page.
    expectRect(rectOf(win), { x: page.x + region.x, y: page.y + region.y - 18, w: region.w, h: region.h + 18 });
    const view = desk.getView().windows[0]!;
    expect(view.selecting).toBe(false);
    expect(view.mask).toEqual({ x: 100, y: 50, width: 300, height: 200, pageWidth: Math.round(page.w), pageHeight: Math.round(page.h) });
    expect(lastMasks()).toEqual([{ tabId: "tab-0", mask: view.mask, width: 300, height: 200 }]);
    // Once the page it was cut from has faded, the region is live, its view the region's box.
    expect(livePages()).toEqual(["tab-0"]);
    const bounds = layouts.at(-1)!.views[0]!.bounds;
    expect(bounds.width).toBe(300);
    expect(bounds.height).toBe(200);
    desk.destroy();
  });

  it("keeps its shape as it is resized, drawn meanwhile, and main hears the new size once it is let go", async () => {
    const { desk, win, move, release, lastMasks, livePages } = await masked();
    const start = rectOf(win);
    const corner = { x: start.x + start.w, y: start.y + start.h };
    desk.resize("tab-0", { left: false, right: true, top: false, bottom: true }, { clientX: corner.x, clientY: corner.y, button: 0 });
    for (let step = 1; step <= 10; step += 1) move(corner.x + step * 30, corner.y + step * 5);
    await flush();
    const sized = rectOf(win);
    expect(sized.w).toBeCloseTo(600, 0);
    expect((sized.h - 18) / sized.w).toBeCloseTo(200 / 300, 3);
    // Its still, stretched: not live, and main still has the size it started at.
    expect(desk.getView().windows[0]!.drawn).toBe(true);
    expect(lastMasks()[0]).toMatchObject({ width: 300, height: 200 });
    await release();
    expect(lastMasks()[0]).toMatchObject({ width: 600, height: 400 });
    expect(livePages()).toEqual(["tab-0"]);
    desk.destroy();
  });

  it("unmasked, grows back into the whole window around its region, the region staying where it is", async () => {
    const { desk, win, before, lastMasks } = await masked();
    desk.unmask("tab-0");
    await flush();
    expectRect(rectOf(win), before);
    expect(desk.getView().windows[0]!.mask).toBeNull();
    expect(lastMasks()).toEqual([]);
    desk.destroy();
  });

  it("unmasked, is drawn all the way back: its page is never live at a size between, and its region never moves", async () => {
    const { desk, win, before, region, layouts } = await masked();
    const regionAt = { x: rectOf(win).x, y: rectOf(win).y + 18 };
    const page = { x: before.x + bar.left, y: before.y + bar.top, w: before.w - bar.left - bar.right, h: before.h - bar.top - bar.bottom };
    const sent = layouts.length;
    desk.unmask("tab-0");
    run(1);
    // At once: drawn, its whole page stood where it will land, its region where it was.
    expect(desk.getView().windows[0]!.drawn).toBe(true);
    expect(desk.getView().windows[0]!.unmasking).toMatchObject({ x: region.x, y: region.y, width: region.w, height: region.h });
    const reveal = (): Rect => ({
      x: Number.parseFloat(win.style["--reveal-x"]!),
      y: Number.parseFloat(win.style["--reveal-y"]!),
      w: Number.parseFloat(win.style["--reveal-w"]!),
      h: Number.parseFloat(win.style["--reveal-h"]!),
    });
    const pageArea = (): Point => ({ x: rectOf(win).x + bar.left, y: rectOf(win).y + bar.top });
    // Frame by frame: the region stays put (the page moving, if at all, only as far as the window has grown).
    const first = reveal();
    expect(Math.abs(pageArea().x + first.x + region.x - regionAt.x)).toBeLessThan(1.5);
    expect(Math.abs(pageArea().y + first.y + region.y - regionAt.y)).toBeLessThan(1.5);
    for (let frame = 0; frame < 6; frame += 1) {
      run(1);
      const box = reveal();
      expect(Math.abs(pageArea().x + box.x - page.x)).toBeLessThan(1.5);
      expect(Math.abs(box.w - page.w)).toBeLessThan(1.5);
    }
    await flush();
    // Landed: live again, at its page's own box — the first box main is given for it since it came off.
    expectRect(rectOf(win), before);
    expect(desk.getView().windows[0]!.drawn).toBe(false);
    expect(desk.getView().windows[0]!.unmasking).toBeNull();
    expect(win.style["--reveal-x"]).toBeUndefined();
    const boxes = layouts.slice(sent).flatMap((layout) => layout.views.filter((view) => view.tabId === "tab-0").map((view) => view.bounds));
    expect(boxes.length).toBeGreaterThan(0);
    for (const bounds of boxes) {
      expect(bounds.width).toBe(Math.round(page.w));
      expect(bounds.height).toBe(Math.round(page.h));
    }
    desk.destroy();
  });

  it("is left where it is by tiling and filling the desk, and never cut in two for a new window", async () => {
    const { desk, win } = await masked();
    const at = rectOf(win);
    desk.toggleMaximize("tab-0");
    desk.arrange("tile", tabIds(2));
    await flush();
    expectRect(rectOf(win), at);
    desk.add("tab-1", { focus: true });
    await flush();
    expectRect(rectOf(win), at);
    desk.destroy();
  });

  it("can only be made from a live web page", () => {
    native();
    const desk = engine({ hasLivePage: () => false });
    desk.start([], "tab-0", tabIds(1));
    settle();
    desk.startMask("tab-0");
    expect(desk.getView().windows[0]!.selecting).toBe(false);
    desk.destroy();
  });

  /** Masked (tab 0), moved and scaled, the desk saved and put away: what it saved. */
  async function maskedAndSaved(): Promise<{ saved: SavedDeskWindow[]; at: Rect }> {
    let saved: SavedDeskWindow[] = [];
    const { desk, win, move, release } = await masked(undefined, { save: (windows) => (saved = windows) });
    const start = rectOf(win);
    const corner = { x: start.x + start.w, y: start.y + start.h };
    desk.resize("tab-0", { left: false, right: true, top: false, bottom: true }, { clientX: corner.x, clientY: corner.y, button: 0 });
    for (let step = 1; step <= 10; step += 1) move(corner.x + step * 15, corner.y + step * 10);
    await release();
    const at = rectOf(win);
    desk.destroy();
    return { saved, at };
  }

  it("is saved masked, where it is and at its size", async () => {
    const { saved, at } = await maskedAndSaved();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.mask).toMatchObject({ x: 100, y: 50, width: 300, height: 200 });
    expectRect(denormalizeRect(saved[0]!.rect, usable), at, 1);
  });

  it("comes back masked when the desk is reopened, flying in from the dock with its region", async () => {
    const { saved, at } = await maskedAndSaved();
    const { desks, layouts } = native({ stills: true });
    const desk = engine({ hasLivePage: () => true });
    const win = element();
    // Reopened on the other tab: the masked window comes out of the dock.
    const before = desks.length;
    desk.start(saved, "tab-1", tabIds(2));
    desk.attachWindow("tab-0", win as unknown as HTMLElement);
    // Main hears of the mask in the first report — before any still is asked for.
    expect(desks[before]!.masks?.map((page) => page.tabId)).toEqual(["tab-0"]);
    await flush();
    const view = desk.getView().windows.find((window) => window.tabId === "tab-0")!;
    expect(view.mask).toEqual(saved[0]!.mask);
    expectRect(rectOf(win), at, 1.5);
    // Under the window in view it is drawn; brought forward, its region is live.
    desk.bringForward("tab-0");
    await flush();
    expect(layouts.at(-1)!.views.map((page) => page.tabId)).toContain("tab-0");
    desk.destroy();
  });

  it("reopened on it, lands whole, then is masked again once its still is painted, and goes where it was left", async () => {
    const { saved, at } = await maskedAndSaved();
    const { desks } = native({ stills: true });
    const desk = engine({ hasLivePage: () => true });
    const win = element();
    const before = desks.length;
    desk.start(saved, "tab-0", tabIds(2));
    desk.attachWindow("tab-0", win as unknown as HTMLElement);
    // It lifts off whole: nothing masked for main yet.
    expect(desks[before]!.masks ?? []).toEqual([]);
    await flush();
    await flush();
    const view = desk.getView().windows.find((window) => window.tabId === "tab-0")!;
    expect(view.mask).toEqual(saved[0]!.mask);
    expectRect(rectOf(win), at, 1.5);
    expect(desks.at(-1)!.masks?.map((page) => page.tabId)).toEqual(["tab-0"]);
    desk.destroy();
  });
});

describe("passing the desk to another group", () => {
  const rect = (x: number): Rect => ({ x, y: 0.1, w: 0.3, h: 0.5 });

  it("sends the old group's windows home, and brings the new group's out where they were left, its top one in use", () => {
    const { desks } = native();
    const saves: string[][] = [];
    const selected: string[] = [];
    const desk = engine({ save: (windows) => saves.push(windows.map((window) => window.tabId)), select: (tabId) => selected.push(tabId) });
    desk.start([], "tab-0", tabIds(3));
    settle();
    desk.add("tab-1", { focus: false });
    settle();
    saves.length = 0;
    const saved: SavedDeskWindow[] = [
      { tabId: "b-0", rect: rect(0.05) },
      { tabId: "b-1", rect: rect(0.5) },
    ];
    desk.switchGroup({ from: "A", groupId: "B", tabIds: ["b-0", "b-1", "b-2"], saved, entry: null });
    // The group left is saved as it was left, before anything moves.
    expect(saves[0]).toEqual(["tab-0", "tab-1"]);
    expect(desk.focusedTabId()).toBe("b-1");
    expect(selected.at(-1)).toBe("b-1");
    settle();
    expect(desk.windowTabIds()).toEqual(["b-0", "b-1"]);
    // Once it has all landed, the new group's arrangement is the one saved.
    expect(saves.at(-1)).toEqual(["b-0", "b-1"]);
    for (const state of desks) expect(isDeskState(state)).toBe(true);
    desk.destroy();
  });

  it("brings a group never on a desk out as its tab used last, alone", () => {
    native();
    const desk = engine();
    desk.start([], "tab-0", tabIds(2));
    settle();
    desk.switchGroup({ from: "A", groupId: "B", tabIds: ["b-0", "b-1"], saved: [], entry: "b-1" });
    settle();
    expect(desk.windowTabIds()).toEqual(["b-1"]);
    expect(desk.focusedTabId()).toBe("b-1");
    desk.destroy();
  });

  it("keeps the old group's windows through the new group's tabs arriving, until they are home", () => {
    native();
    const desk = engine();
    desk.start([], "tab-0", tabIds(2));
    settle();
    desk.switchGroup({ from: "A", groupId: "B", tabIds: ["b-0"], saved: [], entry: "b-0" });
    // The surface hears of the new group's tabs at once: the old windows are on their way, not gone.
    desk.syncTabs(["b-0"]);
    expect(desk.windowTabIds()).toContain("tab-0");
    settle();
    expect(desk.windowTabIds()).toEqual(["b-0"]);
    desk.destroy();
  });

  it("takes a group's windows back, where they were left, when the desk returns to it before they are home", () => {
    native();
    const saves: SavedDeskWindow[][] = [];
    const desk = engine({ save: (windows) => saves.push(windows) });
    desk.start([], "tab-0", tabIds(2));
    settle();
    desk.add("tab-1", { focus: false });
    settle();
    desk.switchGroup({ from: "A", groupId: "B", tabIds: ["b-0"], saved: [], entry: "b-0" });
    const leftA = saves.at(-1)!;
    expect(leftA.map((window) => window.tabId)).toEqual(["tab-0", "tab-1"]);
    // A's windows are on their way home when the desk comes back to A.
    step(4);
    desk.switchGroup({ from: "B", groupId: "A", tabIds: tabIds(2), saved: leftA, entry: null });
    settle();
    expect([...desk.windowTabIds()].sort()).toEqual(["tab-0", "tab-1"]);
    expect(desk.focusedTabId()).toBe("tab-1");
    expect((saves.at(-1) ?? []).map((window) => window.tabId).sort()).toEqual(["tab-0", "tab-1"]);
    desk.destroy();
  });

  it("gives main the incoming group's masks first, while the outgoing group's windows fly home", () => {
    const { desks } = native();
    const desk = engine();
    const mask = { x: 10, y: 10, width: 200, height: 120, pageWidth: 1000, pageHeight: 700 };
    const masked = (prefix: string): SavedDeskWindow[] =>
      Array.from({ length: MAX_DESK_WINDOWS }, (_, index) => ({ tabId: `${prefix}-${index}`, rect: rect((index % 10) / 20), mask }));
    const a = masked("a");
    desk.start(a, null, a.map((window) => window.tabId));
    settle();
    const b = masked("b");
    desk.switchGroup({ from: "A", groupId: "B", tabIds: b.map((window) => window.tabId), saved: b, entry: null });
    step(3);
    const state = desks.at(-1)!;
    expect(isDeskState(state)).toBe(true);
    expect(state!.masks!.map((page) => page.tabId).sort()).toEqual(b.map((window) => window.tabId).sort());
    desk.destroy();
  });

  it("sketches another group's desk as passing to it lays it out: each window where it lands, the one it comes up on on top", () => {
    native();
    const desk = engine();
    desk.start([], "tab-0", tabIds(2));
    settle();
    const ids = ["b-0", "b-1", "b-2"];
    // (A tab since gone from the group is not on its desk.)
    const saved: SavedDeskWindow[] = [
      { tabId: "b-1", rect: rect(0.5) },
      { tabId: "gone", rect: rect(0.3) },
      { tabId: "b-0", rect: rect(0.05) },
    ];
    const sketch = desk.sketchGroup(ids, saved, "b-1");
    expect(sketch).toMatchObject({ width: 1600, height: 1000 });
    expect(sketch.windows.map((window) => [window.tabId, window.focused])).toEqual([
      ["b-0", false],
      ["b-1", true],
    ]);
    desk.switchGroup({ from: "A", groupId: "B", tabIds: ids, saved, entry: "b-1" });
    const els = new Map(sketch.windows.map((window) => [window.tabId, element()]));
    for (const [tabId, el] of els) desk.attachWindow(tabId, el as unknown as HTMLElement);
    settle();
    expect(desk.windowTabIds()).toEqual(["b-0", "b-1"]);
    for (const window of sketch.windows) expectRect(rectOf(els.get(window.tabId)!), window.rect);
    desk.destroy();
  });

  it("sketches a group never on a desk as its tab used last, alone in the middle", () => {
    native();
    const desk = engine();
    desk.start([], "tab-0", tabIds(2));
    settle();
    const sketch = desk.sketchGroup(["b-0", "b-1"], [], "b-1");
    expect(sketch.windows).toHaveLength(1);
    expect(sketch.windows[0]).toMatchObject({ tabId: "b-1", focused: true, mask: null, still: null, stillShows: "none" });
    expectRect(sketch.windows[0]!.rect, centeredRect(usable));
    desk.destroy();
  });

  it("sketches each window with the latest picture of its page — a masked one's whole page, to be cropped to its region", async () => {
    native({ stills: true });
    const desk = engine({ hasLivePage: () => true });
    desk.start([], "tab-0", tabIds(2));
    settle();
    const mask = { x: 10, y: 10, width: 200, height: 120, pageWidth: 1000, pageHeight: 700 };
    const saved: SavedDeskWindow[] = [{ tabId: "b-0", rect: rect(0.05), mask }, { tabId: "b-1", rect: rect(0.5) }];
    desk.peekGroup("B", ["b-0", "b-1"]);
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    const sketch = desk.sketchGroup(["b-0", "b-1"], saved, null);
    expect(sketch.windows.map((window) => [window.tabId, window.still, window.stillShows])).toEqual([
      ["b-0", "data:image/jpeg;base64,b-0", "page"],
      ["b-1", "data:image/jpeg;base64,b-1", "page"],
    ]);
    // Masked, it keeps its region's shape.
    const masked = sketch.windows[0]!;
    expect(masked.mask).toEqual(mask);
    expect((masked.rect.h - 18) / masked.rect.w).toBeCloseTo(120 / 200, 2);
    desk.destroy();
  });

  it("never tells main of more windows than it accepts, with both groups' out at once", () => {
    const { desks } = native();
    const desk = engine();
    const ids = tabIds(MAX_DESK_WINDOWS);
    desk.start([], "tab-0", ids);
    settle();
    for (const tabId of ids) desk.add(tabId, { focus: false });
    settle();
    expect(desk.windowTabIds()).toHaveLength(MAX_DESK_WINDOWS);
    const next = Array.from({ length: MAX_DESK_WINDOWS }, (_, index) => `b-${index}`);
    desk.switchGroup({
      from: "A",
      groupId: "B",
      tabIds: next,
      saved: next.map((tabId, index) => ({ tabId, rect: rect((index % 10) / 20) })),
      entry: null,
    });
    settle();
    expect(desk.windowTabIds()).toHaveLength(MAX_DESK_WINDOWS);
    expect(desk.windowTabIds().every((tabId) => tabId.startsWith("b-"))).toBe(true);
    for (const state of desks) expect(isDeskState(state)).toBe(true);
    desk.destroy();
  });
});

describe("editing a mask", () => {
  it("asks main for a whole-page picture no larger than it accepts, however far the region is enlarged", () => {
    const { desks } = native();
    const desk = engine({ hasLivePage: () => true });
    // A 32px square of a 1200 × 800 page, shown most of the desk's height.
    const mask = { x: 40, y: 40, width: 32, height: 32, pageWidth: 1200, pageHeight: 800 };
    desk.start([{ tabId: "tab-1", rect: { x: 0.2, y: 0.05, w: 0.6, h: 0.9 }, mask }], "tab-0", tabIds(2));
    settle();
    desk.editMask("tab-1");
    step(2);
    const state = desks.at(-1)!;
    expect(isDeskState(state)).toBe(true);
    const page = state!.masks!.find((candidate) => candidate.tabId === "tab-1")!;
    // The whole page, its shape kept.
    expect(page.mask).toMatchObject({ x: 0, y: 0, width: 1200, height: 800 });
    expect(Math.abs(page.width / page.height - 1.5)).toBeLessThan(0.01);
    desk.destroy();
  });
});
