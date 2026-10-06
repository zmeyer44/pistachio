/**
 * What the desk's engine (src/components/desk/desk-engine.ts) tells main:
 * the first layout goes out even when it is empty, and the desk never holds
 * more windows than main accepts (@pistachio/shell-contracts/desk). And what
 * a window in hand does: a window filling the desk lets go of it as it is
 * dragged, and Shift lands a released window in the tile it lights. And the
 * dock — the sidebar's column beside the desk: a tab chosen there comes out
 * where the layout has room, a row pulled out over the desk becomes the
 * tab's window, held by the title bar, and windows go back into their rows;
 * while a window is carried near the desk's edge, a drop rail stands over
 * the sidebar. And the desk passing to another group in place: the old
 * group's windows go home, the new group's come out where they were left,
 * and main never hears of more windows than it accepts; a loose tab's desk
 * comes up as its one window, and takes on a new group in place.
 * And the box a page the shell draws is laid out at, to be shown small.
 *
 * The engine runs a frame at a time outside React; here the frames are
 * driven by hand, and the only DOM it needs is a stage box.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DragSample } from "@pistachio/shell-contracts/chrome";
import { isDeskState, MAX_DESK_WINDOWS, type DeskState } from "@pistachio/shell-contracts/desk";
import { NATIVE_SURFACE_MEMBERS, type BrowserLayout } from "@pistachio/shell-contracts/ipc";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { CHROME_INSETS, DeskEngine, type DeskHost } from "../src/components/desk/desk-engine";
import { carrySize, centeredRect, denormalizeRect, DESK_GAP, normalizeRect, windowSize, zoneRect, type Point, type Rect } from "../src/lib/desk/geometry";
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

/** The sidebar's column — the desk's dock — beside the stage, which is the window's content box here: left of it. */
const SIDEBAR: Rect = { x: -48, y: 0, w: 48, h: 1000 };

/** A desk whose pages are all shell-drawn (no live views), over a 1600×1000 stage. */
function engine(host: Partial<DeskHost> = {}): DeskEngine {
  const created = new DeskEngine({
    variants: () => DEFAULT_DESK_VARIANTS,
    hasLivePage: () => false,
    select: () => undefined,
    close: () => undefined,
    editAddress: () => undefined,
    save: () => undefined,
    moveTabToGroup: () => undefined,
    leaveDone: () => undefined,
    sidebar: () => SIDEBAR,
    homeOf: () => null,
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
const usable: Rect = { x: 0, y: 0, w: 1600, h: 1000 };

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
    const at = { x: usable.x + usable.w * 0.75, y: usable.y + 17 };
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

  it("shows the drop rail over the sidebar only near the desk's leading edge, and lights the segment a release would go to", () => {
    const { desk, win, move, release } = open();
    const start = rectOf(win);
    desk.grab("tab-0", { x: start.x + 200, y: start.y + 17 });
    move(start.x + 260, start.y + 60);
    expect(desk.getView().dropsShown).toBe(false);
    move(usable.x + 100, 300);
    expect(desk.getView().dropsShown).toBe(true);
    expect(desk.getView().dockDrop).toBeNull();
    move(-24, 300);
    expect(desk.getView().dockDrop).toBe("away");
    move(-24, 940);
    expect(desk.getView().dockDrop).toBe("close");
    // The rail stands over the sidebar's column.
    expect(desk.getView().drops.away.x).toBe(SIDEBAR.x + 6);
    // Back across the desk's edge band: the left half again, not the rail.
    move(usable.x + 10, 500);
    expect(desk.getView().dockDrop).toBeNull();
    release();
    expectRect(rectOf(win), zoneRect("left", usable));
    expect(desk.getView().dropsShown).toBe(false);
    desk.destroy();
  });

  it("puts a window let go on the rail's upper segment back into the dock, its tab kept", () => {
    const close = vi.fn();
    const { desk, win, move, release } = open({ close });
    const start = rectOf(win);
    desk.grab("tab-0", { x: start.x + 200, y: start.y + 17 });
    for (let step = 1; step <= 8; step += 1) move(start.x + 200 - step * ((start.x + 224) / 8), 300);
    expect(desk.getView().dockDrop).toBe("away");
    release();
    expect(desk.windowTabIds()).toEqual([]);
    expect(close).not.toHaveBeenCalled();
    desk.destroy();
  });

  it("closes the tab of a window let go on the rail's lower segment, once it has gone into it", () => {
    const close = vi.fn();
    const { desk, win, move, release } = open({ close });
    const start = rectOf(win);
    desk.grab("tab-0", { x: start.x + 200, y: start.y + 17 });
    for (let step = 1; step <= 8; step += 1) move(start.x + 200 - step * ((start.x + 224) / 8), 300 + step * 80);
    expect(desk.getView().dockDrop).toBe("close");
    release();
    expect(desk.windowTabIds()).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith("tab-0");
    desk.destroy();
  });

  it("closes a window let go on the rail's lower segment even when the agent, or Undo layout, asks for it on its way there", () => {
    const close = vi.fn();
    const { desk, win, move, letGo } = open({ close });
    const before = desk.layoutSnapshot();
    const start = rectOf(win);
    desk.grab("tab-0", { x: start.x + 200, y: start.y + 17 });
    for (let step = 1; step <= 8; step += 1) move(start.x + 200 - step * ((start.x + 224) / 8), 300 + step * 80);
    expect(desk.getView().dockDrop).toBe("close");
    letGo();
    // Going into the rail's Close is the person's: a placement or an Undo does not bring it back.
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
    // (A group of two: a desk of one tab fills the desk.)
    desk.start([], "tab-0", tabIds(2));
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

describe("the sidebar, the desk's dock", () => {
  let restoreNow: () => void = () => undefined;
  beforeEach(() => {
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    restoreNow = () => spy.mockRestore();
  });
  afterEach(() => restoreNow());

  /** A row in the sidebar, 32px tall, its icon 8px in. */
  const row = (top: number) => ({ isConnected: true, dataset: {} as Record<string, string>, offsetWidth: 32, getBoundingClientRect: () => ({ left: -40, top, width: 32, height: 32 }) });

  /** Tab 0 out as a window; the rest in the dock (two tabs, unless said), each with its row in the sidebar, 34px apart. */
  function dock(options: { tabs?: number; host?: Partial<DeskHost> } = {}) {
    const { drag } = native();
    const count = options.tabs ?? 2;
    const rows = new Map(tabIds(count).map((tabId, index) => [tabId, row(400 + index * 34)]));
    const desk = engine({ homeOf: (kind, id) => (kind === "tab" ? ((rows.get(id) as unknown as HTMLElement | undefined) ?? null) : null), ...options.host });
    desk.start([], "tab-0", tabIds(count));
    const attach = (tabId: string): ReturnType<typeof element> => {
      const win = element();
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
    return { desk, rows, attach, move, release };
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

  it("brings a tab out of its row, and puts its window back into it, the row bouncing as it takes it", () => {
    const { desk, rows, attach } = dock();
    desk.add("tab-1", { focus: true });
    const added = attach("tab-1");
    run(1);
    // It sets out from the row's icon, over the sidebar.
    const first = rectOf(added);
    expect(first.x).toBeLessThan(0);
    expect(first.y).toBeGreaterThan(400);
    settle();
    desk.putAway("tab-1");
    run(1);
    expect(desk.getView().windows.find((window) => window.tabId === "tab-1")!.flight).toBe("away");
    settle();
    expect(desk.windowTabIds()).toEqual(["tab-0"]);
    expect(rows.get("tab-1")!.dataset["received"]).toBe("");
    desk.destroy();
  });

  it("turns a row pulled out over the desk into its window, held by the title bar", () => {
    const { desk, attach, move, release } = dock();
    expect(desk.pullFromSidebar("tab-1", { x: 4, y: 452 })).toBe(true);
    expect(desk.windowTabIds()).toEqual(["tab-0", "tab-1"]);
    expect(desk.getView().gesture).toBe("spawn");
    const win = attach("tab-1");
    for (let step = 1; step <= 10; step += 1) move(4 + step * 25, 452 + step * 10);
    const pointer = { x: 254, y: 552 };
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
    const { desk, attach, move, release } = dock();
    const win = attach("tab-0");
    const before = rectOf(win);
    expect(desk.pullFromSidebar("tab-0", { x: 4, y: 410 })).toBe(true);
    const pointer = { x: 200, y: 300 };
    for (let step = 1; step <= 6; step += 1) move(20 + step * 30, 420 - step * 20);
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

  it("takes no row out that is not the group's, nor while a window is in hand", () => {
    const { desk } = dock();
    expect(desk.pullFromSidebar("stranger", { x: 4, y: 410 })).toBe(false);
    expect(desk.pullFromSidebar("tab-1", { x: 4, y: 452 })).toBe(true);
    expect(desk.pullFromSidebar("tab-0", { x: 4, y: 452 })).toBe(false);
    expect(desk.windowTabIds()).toEqual(["tab-0", "tab-1"]);
    desk.destroy();
  });

  it("puts a window flung past the desk's leading edge into the dock — and none, with no sidebar beside the desk", () => {
    for (const sidebar of [SIDEBAR, null]) {
      const { desk, move, release } = dock({ host: { sidebar: () => sidebar } });
      desk.grab("tab-0", { x: 600, y: 300 });
      for (let step = 1; step <= 6; step += 1) move(600 - step * 60, 300);
      release();
      expect(desk.windowTabIds()).toEqual(sidebar === null ? ["tab-0"] : []);
      desk.destroy();
    }
  });
});

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

  it("brings a loose tab's desk up as its one window, filling the desk — and, put away and brought back out, filling it again", () => {
    native();
    const desk = engine();
    desk.start([], "tab-0", tabIds(2));
    settle();
    desk.switchGroup({ from: "A", groupId: "tab:loose", tabIds: ["loose"], saved: [], entry: "loose" });
    const win = element();
    desk.attachWindow("loose", win as unknown as HTMLElement);
    settle();
    expect(desk.windowTabIds()).toEqual(["loose"]);
    expectRect(rectOf(win), usable);
    desk.putAway("loose");
    settle();
    expect(desk.windowTabIds()).toEqual([]);
    desk.add("loose", { focus: true });
    const back = element();
    desk.attachWindow("loose", back as unknown as HTMLElement);
    settle();
    expectRect(rectOf(back), usable);
    desk.destroy();
  });

  it("brings a desk of one tab back where it was left, its window filled or not, while a group's tab used last still comes out in the middle", () => {
    native();
    const saves = new Map<string, SavedDeskWindow[]>();
    let shown = "lone";
    const desk = engine({ save: (windows) => saves.set(shown, windows) });
    desk.start([], "a", ["a"]);
    const win = element();
    desk.attachWindow("a", win as unknown as HTMLElement);
    settle();
    expectRect(rectOf(win), usable);
    // Made a smaller window, then passed from: a group of two, never on a desk, comes up on its tab used last, in the middle.
    desk.toggleMaximize("a");
    settle();
    expectRect(rectOf(win), centeredRect(usable));
    desk.switchGroup({ from: "lone", groupId: "pair", tabIds: ["b-0", "b-1"], saved: [], entry: "b-1" });
    shown = "pair";
    const pair = element();
    desk.attachWindow("b-1", pair as unknown as HTMLElement);
    settle();
    expectRect(rectOf(pair), centeredRect(usable));
    // Back: where it was left, not filling the desk.
    desk.switchGroup({ from: "pair", groupId: "lone", tabIds: ["a"], saved: saves.get("lone")!, entry: "a" });
    shown = "lone";
    const back = element();
    desk.attachWindow("a", back as unknown as HTMLElement);
    settle();
    expectRect(rectOf(back), centeredRect(usable));
    // Filled, passed from and back: filled.
    desk.toggleMaximize("a");
    settle();
    desk.switchGroup({ from: "lone", groupId: "pair", tabIds: ["b-0", "b-1"], saved: saves.get("pair")!, entry: "b-1" });
    shown = "pair";
    settle();
    desk.switchGroup({ from: "pair", groupId: "lone", tabIds: ["a"], saved: saves.get("lone")!, entry: "a" });
    shown = "lone";
    const again = element();
    desk.attachWindow("a", again as unknown as HTMLElement);
    settle();
    expectRect(rectOf(again), usable);
    desk.destroy();
  });

  it("takes on a new group of its own in place: its tabs' windows stay where they are, any other goes home", () => {
    native();
    const saves: string[][] = [];
    const desk = engine({ save: (windows) => saves.push(windows.map((window) => window.tabId)) });
    desk.start([], "tab-0", tabIds(2));
    const kept = element();
    desk.attachWindow("tab-0", kept as unknown as HTMLElement);
    settle();
    desk.add("tab-1", { focus: false });
    settle();
    const before = rectOf(kept);
    // tab-0's loose desk became a new group's (⌘T there): tab-1 is not one of its tabs.
    desk.regroup(["tab-0", "fresh"], null);
    expect(desk.getView().windows.find((window) => window.tabId === "tab-1")!.flight).toBe("away");
    settle();
    expect(desk.windowTabIds()).toEqual(["tab-0"]);
    expectRect(rectOf(kept), before);
    expect(desk.hasGroupTab("fresh")).toBe(true);
    expect(saves.at(-1)).toEqual(["tab-0"]);
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

describe("a gutter between windows", () => {
  let restoreNow: () => void = () => undefined;
  beforeEach(() => {
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    restoreNow = () => spy.mockRestore();
  });
  afterEach(() => restoreNow());

  /** `count` live windows out, tiled (or where `saved` puts them), each with its element. */
  function open(count: number, saved: SavedDeskWindow[] | null = null) {
    const { drag, layouts } = native();
    let wrote: SavedDeskWindow[] = [];
    const desk = engine({ hasLivePage: () => true, save: (windows) => (wrote = windows) });
    const stage = { left: 0, top: 0, width: 1600, height: 1000 };
    desk.attachStage({ getBoundingClientRect: () => stage } as unknown as HTMLElement);
    const ids = tabIds(count);
    desk.start(saved ?? [], "tab-0", ids);
    if (saved === null) for (const tabId of ids.slice(1)) desk.add(tabId, { focus: false });
    const els = new Map(ids.map((tabId) => [tabId, element()]));
    for (const [tabId, el] of els) desk.attachWindow(tabId, el as unknown as HTMLElement);
    settle();
    if (saved === null) desk.arrange("tile", ids);
    settle();
    const at = (tabId: string): Rect => rectOf(els.get(tabId)!);
    /** Press an edge at (x, y), drag it `by` a step at a time, hold still, and let go. */
    const drag_ = (tabId: string, edges: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean }, x: number, y: number, by: Point): void => {
      desk.resize(tabId, { left: false, right: false, top: false, bottom: false, ...edges }, { clientX: x, clientY: y, button: 0 });
      for (let step = 1; step <= 10; step += 1) {
        drag.sample?.({ x: x + (by.x * step) / 10, y: y + (by.y * step) / 10, phase: "move" });
        run(1);
      }
      drag.sample?.({ x: 0, y: 0, phase: "cancel" });
      settle();
    };
    /** Main's box for a tab's live page, as last laid out. */
    const page = (tabId: string) => layouts.at(-1)!.views.find((view) => view.tabId === tabId)!.bounds;
    return { desk, at, drag: drag_, page, stage, saved: () => wrote };
  }

  it("resizes both halves of a split: one wider, the other narrower, the gutter kept, and main hears both", () => {
    const { desk, at, drag, page, saved } = open(2);
    const left = zoneRect("left", usable);
    const right = zoneRect("right", usable);
    expectRect(at("tab-0"), left);
    expectRect(at("tab-1"), right);
    // Pressed in the gutter, on the right-hand window's left edge.
    drag("tab-1", { left: true }, right.x - DESK_GAP / 2, 500, { x: 160, y: 0 });
    expectRect(at("tab-0"), { ...left, w: left.w + 160 });
    expectRect(at("tab-1"), { ...right, x: right.x + 160, w: right.w - 160 });
    expect(page("tab-0").width).toBe(Math.round(left.w + 160 - CHROME_INSETS.bar.left - CHROME_INSETS.bar.right));
    expect(page("tab-1").x).toBe(Math.round(right.x + 160 + CHROME_INSETS.bar.left));
    // And back the other way, by the left-hand window's right edge; both are saved as they were left.
    drag("tab-0", { right: true }, left.x + left.w + 160 + DESK_GAP / 2, 300, { x: -300, y: 0 });
    expectRect(at("tab-0"), { ...left, w: left.w - 140 });
    expectRect(at("tab-1"), { ...right, x: right.x - 140, w: right.w + 140 });
    expect(saved().map((window) => window.tabId).sort()).toEqual(["tab-0", "tab-1"]);
    expectRect(denormalizeRect(saved().find((window) => window.tabId === "tab-1")!.rect, usable), at("tab-1"));
    desk.destroy();
  });

  it("stops where a window on it would be smaller than a window may be", () => {
    const { desk, at, drag } = open(2);
    const right = zoneRect("right", usable);
    drag("tab-1", { left: true }, right.x - DESK_GAP / 2, 500, { x: 2_000, y: 0 });
    expect(Math.abs(at("tab-1").w - 300)).toBeLessThan(0.5);
    expect(Math.abs(at("tab-1").x - (at("tab-0").x + at("tab-0").w) - DESK_GAP)).toBeLessThan(0.5);
    expect(Math.abs(at("tab-1").x + at("tab-1").w - (right.x + right.w))).toBeLessThan(0.5);
    desk.destroy();
  });

  it("moves every window on the gutter: a half beside two stacked quarters, and the quarters' own gutter between them alone", () => {
    const { desk, at, drag } = open(3);
    const left = zoneRect("left", usable);
    const top = zoneRect("top-right", usable);
    const bottom = zoneRect("bottom-right", usable);
    expectRect(at("tab-1"), top);
    expectRect(at("tab-2"), bottom);
    drag("tab-0", { right: true }, left.x + left.w + DESK_GAP / 2, 800, { x: -120, y: 0 });
    expectRect(at("tab-0"), { ...left, w: left.w - 120 });
    expectRect(at("tab-1"), { ...top, x: top.x - 120, w: top.w + 120 });
    expectRect(at("tab-2"), { ...bottom, x: bottom.x - 120, w: bottom.w + 120 });
    drag("tab-2", { top: true }, 1200, bottom.y - DESK_GAP / 2, { x: 0, y: 150 });
    expectRect(at("tab-0"), { ...left, w: left.w - 120 });
    expectRect(at("tab-1"), { ...top, x: top.x - 120, w: top.w + 120, h: top.h + 150 });
    expectRect(at("tab-2"), { ...bottom, x: bottom.x - 120, y: bottom.y + 150, w: bottom.w + 120, h: bottom.h - 150 });
    desk.destroy();
  });

  it("leaves a window further off than the gutter alone: only the edge in hand moves", () => {
    const apart = (x: number, w: number): Rect => normalizeRect({ x, y: 100, w, h: 600 }, usable);
    const { desk, at, drag } = open(2, [
      { tabId: "tab-1", rect: apart(800, 500) },
      { tabId: "tab-0", rect: apart(200, 560) },
    ]);
    const other = at("tab-1");
    expect(other.x - (at("tab-0").x + at("tab-0").w)).toBeCloseTo(40, 3);
    drag("tab-0", { right: true }, 762, 400, { x: 80, y: 0 });
    expectRect(at("tab-0"), { x: 200, y: 100, w: 640, h: 600 });
    expectRect(at("tab-1"), other);
    desk.destroy();
  });

  it("keeps the gutter a gutter when the desk changes size, so the split still holds", () => {
    const { desk, at, drag, stage } = open(2);
    stage.width = 1900;
    stage.height = 1100;
    desk.measure();
    settle();
    const wider: Rect = { ...usable, w: 1900, h: 1100 };
    expectRect(at("tab-0"), zoneRect("left", wider));
    expectRect(at("tab-1"), zoneRect("right", wider));
    const right = zoneRect("right", wider);
    drag("tab-1", { left: true }, right.x - DESK_GAP / 2, 500, { x: -100, y: 0 });
    expect(at("tab-1").x - (at("tab-0").x + at("tab-0").w)).toBeCloseTo(DESK_GAP, 3);
    expectRect(at("tab-1"), { ...right, x: right.x - 100, w: right.w + 100 });
    desk.destroy();
  });
});
