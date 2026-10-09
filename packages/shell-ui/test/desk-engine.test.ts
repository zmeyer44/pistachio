/**
 * What the desk's engine (src/components/desk/desk-engine.ts) tells main:
 * the first layout goes out even when it is empty, and the desk never holds
 * more windows than main accepts (@pistachio/shell-contracts/desk). And what
 * a window in hand does: a window filling the desk lets go of it as it is
 * dragged, and Shift lands a released window in the tile it lights. And the
 * dock — the sidebar's column beside the desk: a tab chosen there comes out
 * where the layout has room, a row pulled out over the desk becomes the
 * tab's window, held by the title bar, and windows go back into their rows;
 * its leading edge is the desk's like the others. And the desk passing to
 * another group in place: the old
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
import { CHROME_INSETS, DeskEngine, takesOnInPlace, type DeskHost } from "../src/components/desk/desk-engine";
import { carrySize, centeredRect, denormalizeRect, DESK_GAP, normalizeRect, rescaleRect, windowSize, zoneRect, type Point, type Rect } from "../src/lib/desk/geometry";
import { DEFAULT_DESK_VARIANTS, type SavedDeskWindow } from "../src/lib/desk/store";

/** The frame these were written for: the Title bar (its insets; a window held by its title bar). */
const BAR_VARIANTS = { ...DEFAULT_DESK_VARIANTS, chrome: "bar" as const };

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
    variants: () => BAR_VARIANTS,
    hasLivePage: () => false,
    select: () => undefined,
    close: () => undefined,
    editAddress: () => undefined,
    save: () => undefined,
    moveTabToGroup: () => undefined,
    sidebar: () => SIDEBAR,
    sidebarAway: () => false,
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
      const { desk, win, move, release } = open({ variants: () => ({ ...BAR_VARIANTS, deceleration }) });
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
    const usual = thrownWith(BAR_VARIANTS.deceleration);
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

  it("treats the leading edge as the right one: carried to it, or on out over the sidebar, a window lands in the left half, its tab kept", () => {
    const close = vi.fn();
    const { desk, win, move, release } = open({ close });
    for (const [x, zone] of [
      [usable.x + 10, "left"],
      [-24, "left"],
      [usable.x + usable.w + 24, "right"],
    ] as const) {
      const start = rectOf(win);
      desk.grab("tab-0", { x: start.x + 200, y: start.y + 17 });
      move(start.x + 260, start.y + 60);
      move(x, 500);
      release();
      settle();
      expectRect(rectOf(win), zoneRect(zone, usable));
      expect(desk.windowTabIds()).toEqual(["tab-0"]);
    }
    expect(close).not.toHaveBeenCalled();
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

  it("keeps a window flung at the sidebar on the desk, as one flung off its right side", () => {
    const { desk, move, release } = dock();
    desk.grab("tab-0", { x: 600, y: 300 });
    for (let step = 1; step <= 6; step += 1) move(600 - step * 60, 300);
    release();
    expect(desk.windowTabIds()).toEqual(["tab-0"]);
    desk.destroy();
  });
});

/* --------------------- the sidebar away (hidden) --------------------- */

describe("the sidebar away: hidden, not out over the desk (docs/spaces.md §3)", () => {
  let restoreNow: () => void = () => undefined;
  beforeEach(() => {
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    restoreNow = () => spy.mockRestore();
  });
  afterEach(() => restoreNow());

  /** The hidden sidebar's slot: the 10px strip at the window's left edge, the stage beside it. */
  const STRIP: Rect = { x: -10, y: 0, w: 10, h: 1000 };
  /** Where the edge's icon stands: the strip's middle, an icon 24px wide (ROW_ICON × 1.5). */
  const EDGE_X = STRIP.x + STRIP.w / 2 - 12;
  /** A row of the hidden pane: its layout kept, translated off the window's edge (x ≈ −238 past a 248px column). */
  const hiddenRow = (top: number) => ({
    isConnected: true,
    dataset: {} as Record<string, string>,
    offsetWidth: 232,
    getBoundingClientRect: () => ({ left: -238 - 10 + 8, top, width: 232, height: 32 }),
  });

  function awayDesk(host: Partial<DeskHost> = {}) {
    native();
    const rows = new Map(tabIds(3).map((tabId, index) => [tabId, hiddenRow(400 + index * 34)]));
    const desk = engine({
      sidebar: () => STRIP,
      sidebarAway: () => true,
      homeOf: (kind, id) => (kind === "tab" ? ((rows.get(id) as unknown as HTMLElement | undefined) ?? null) : null),
      ...host,
    });
    desk.measure();
    return { desk, rows };
  }

  it("puts a window away into the window's left edge at its row's height, never off the window", () => {
    const { desk } = awayDesk();
    desk.start([], "tab-0", tabIds(2));
    const win = element();
    desk.attachWindow("tab-0", win as unknown as HTMLElement);
    settle();
    desk.add("tab-1", { focus: true });
    const other = element();
    desk.attachWindow("tab-1", other as unknown as HTMLElement);
    settle();
    desk.putAway("tab-1");
    let last = rectOf(other);
    for (let i = 0; i < 400 && desk.windowTabIds().includes("tab-1"); i += 1) {
      last = rectOf(other);
      expect(last.x).toBeGreaterThan(-40);
      run(1);
    }
    expect(desk.windowTabIds()).toEqual(["tab-0"]);
    // Its last frame: at the edge, level with its row (the row's top 434, its icon 4px in).
    expect(Math.abs(last.x - EDGE_X)).toBeLessThan(6);
    expect(Math.abs(last.y - 438)).toBeLessThan(6);
    desk.destroy();
  });

  it("brings a tab out of the window's edge at its row's height", () => {
    const { desk } = awayDesk();
    desk.start([], "tab-0", tabIds(3));
    desk.attachWindow("tab-0", element() as unknown as HTMLElement);
    settle();
    desk.add("tab-2", { focus: true });
    const added = element();
    desk.attachWindow("tab-2", added as unknown as HTMLElement);
    run(1);
    // Its first frame, a frame on its way: from the edge, near its row (the row's top 468, its icon 4px in).
    const first = rectOf(added);
    expect(Math.abs(first.x - EDGE_X)).toBeLessThan(6);
    expect(Math.abs(first.y - 472)).toBeLessThan(40);
    settle();
    desk.destroy();
  });

  it("passes the desk to another space out of the edge, at that space's row", () => {
    const groupRow = hiddenRow(600);
    const { desk } = awayDesk({ homeOf: (kind) => (kind === "group" ? (groupRow as unknown as HTMLElement) : null) });
    desk.start([], "tab-0", tabIds(1));
    desk.attachWindow("tab-0", element() as unknown as HTMLElement);
    settle();
    desk.switchGroup({ from: "A", groupId: "B", tabIds: ["b-0"], saved: [], entry: "b-0" });
    const incoming = element();
    desk.attachWindow("b-0", incoming as unknown as HTMLElement);
    run(1);
    const first = rectOf(incoming);
    expect(first.x).toBeGreaterThan(-40);
    expect(Math.abs(first.x - EDGE_X)).toBeLessThan(40);
    expect(first.y).toBeGreaterThan(500);
    settle();
    expect(desk.windowTabIds()).toEqual(["b-0"]);
    desk.destroy();
  });

  it("takes its rows' places as they are while the column is out", () => {
    // (Out over the desk, the column's rows are where they are drawn: the window grows from under the column.)
    const { desk } = awayDesk({ sidebarAway: () => false });
    desk.start([], "tab-0", tabIds(3));
    desk.attachWindow("tab-0", element() as unknown as HTMLElement);
    settle();
    desk.add("tab-2", { focus: true });
    const added = element();
    desk.attachWindow("tab-2", added as unknown as HTMLElement);
    run(1);
    expect(rectOf(added).x).toBeLessThan(-200);
    settle();
    desk.destroy();
  });
});

describe("a Glance taken in", () => {
  let restoreNow: () => void = () => undefined;
  beforeEach(() => {
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    restoreNow = () => spy.mockRestore();
  });
  afterEach(() => restoreNow());

  /** Tab 0 out as a live window, the Glance's owner; the rest of the group's tabs in the dock. */
  function desk(count = 2) {
    const { layouts } = native();
    const created = engine({ hasLivePage: () => true });
    created.start([], "tab-0", tabIds(count));
    const attach = (tabId: string): ReturnType<typeof element> => {
      const win = element();
      created.attachWindow(tabId, win as unknown as HTMLElement);
      return win;
    };
    const owner = attach("tab-0");
    settle();
    /** Where main was last told a tab's page is. */
    const shown = (tabId: string) => layouts.at(-1)?.views.find((view) => view.tabId === tabId)?.bounds;
    return { desk: created, attach, owner, shown };
  }

  const pageOf = (rect: Rect): Rect => {
    const insets = CHROME_INSETS.bar;
    return { x: rect.x + insets.left, y: rect.y + insets.top, w: rect.w - insets.left - insets.right, h: rect.h - insets.top - insets.bottom };
  };

  it("filling the desk, its window is made where the page landed, live there at once — not flown out of its row", () => {
    const { desk: created, attach, owner, shown } = desk();
    const before = rectOf(owner);
    const landing = created.receiveGlance("tab-1", "fill", "tab-0");
    expect(landing).not.toBeNull();
    expectRect(landing!.stage, pageOf(usable));
    // Its tab joins the group, and the desk brings it out.
    created.add("tab-1", { focus: true });
    const added = attach("tab-1");
    run(1);
    expectRect(rectOf(added), usable);
    expect(created.getView().windows.find((window) => window.tabId === "tab-1")?.flight).toBeNull();
    const { x, y, w, h } = landing!.window;
    expect(shown("tab-1")).toEqual({ x, y, width: w, height: h });
    expect(created.windowTabIds()).toEqual(["tab-0", "tab-1"]);
    expect(created.focusedTabId()).toBe("tab-1");
    // The window it was opened from stays where it was, under it.
    settle();
    expectRect(rectOf(owner), before);
    created.destroy();
  });

  it("as a tile on a tiled desk, takes half of the window it was opened from", () => {
    const { desk: created, attach, owner } = desk();
    created.toggleMaximize("tab-0");
    settle();
    const landing = created.receiveGlance("tab-1", "tile", "tab-0");
    expectRect(landing!.stage, pageOf(zoneRect("right", usable)));
    created.add("tab-1", { focus: true });
    const added = attach("tab-1");
    settle();
    expectRect(rectOf(owner), zoneRect("left", usable));
    expectRect(rectOf(added), zoneRect("right", usable));
    created.destroy();
  });

  it("as a tile among windows set down freely, tiles them all, beside the window it was opened from", () => {
    const { desk: created, attach, owner } = desk(3);
    created.add("tab-1", { focus: true });
    const other = attach("tab-1");
    settle();
    const landing = created.receiveGlance("tab-2", "tile", "tab-0");
    expectRect(landing!.stage, pageOf(zoneRect("top-right", usable)));
    // The others are on their way to their tiles already, as the page flies to its own.
    settle();
    expectRect(rectOf(owner), zoneRect("left", usable));
    expectRect(rectOf(other), zoneRect("bottom-right", usable));
    created.add("tab-2", { focus: true });
    const added = attach("tab-2");
    run(1);
    expectRect(rectOf(added), zoneRect("top-right", usable));
    created.destroy();
  });

  it("comes out of its row as any tab does once the landing has gone stale", () => {
    const { desk: created, attach } = desk();
    created.receiveGlance("tab-1", "fill", "tab-0");
    clock += 5_000;
    created.add("tab-1", { focus: true });
    attach("tab-1");
    run(1);
    expect(created.getView().windows.find((window) => window.tabId === "tab-1")?.flight).toBe("in");
    created.destroy();
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

  it("comes back masked when the desk starts again, where it was left, with its region", async () => {
    const { saved, at } = await maskedAndSaved();
    const { desks, layouts } = native({ stills: true });
    const desk = engine({ hasLivePage: () => true });
    const win = element();
    // Started on the other tab: the masked window is placed where it was left.
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

  it("started cold on it, is masked at once where it was left: no whole page lifting off first", async () => {
    const { saved, at } = await maskedAndSaved();
    const { desks } = native({ stills: true });
    const desk = engine({ hasLivePage: () => true });
    const win = element();
    const before = desks.length;
    desk.start(saved, "tab-0", tabIds(2));
    desk.attachWindow("tab-0", win as unknown as HTMLElement);
    // Main hears of the mask in the very first report, and the window is where it was left from the first frame.
    expect(desks[before]!.masks?.map((page) => page.tabId)).toEqual(["tab-0"]);
    expectRect(rectOf(win), at, 1.5);
    expect(desk.getView().phase).toBe("open");
    await flush();
    const view = desk.getView().windows.find((window) => window.tabId === "tab-0")!;
    expect(view.mask).toEqual(saved[0]!.mask);
    expect(view.flight).toBeNull();
    expectRect(rectOf(win), at, 1.5);
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
    desk.switchGroup({ from: "A", groupId: "loose-g", tabIds: ["loose"], saved: [], entry: "loose" });
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

  it("passes to a space whose window on top was left minimized: it comes back parked, as it was left", () => {
    native();
    const desk = engine();
    desk.start([], "a-0", ["a-0"], null, "A");
    settle();
    const saved: SavedDeskWindow[] = [
      { tabId: "b-0", rect: rect(0.05) },
      { tabId: "b-1", rect: rect(0.5), mini: { restore: rect(0.4), parked: true } },
    ];
    // The space's row chosen: the shell names the window left on top (passedEntry), the parked one.
    desk.switchGroup({ from: "A", groupId: "B", tabIds: ["b-0", "b-1"], saved, entry: "b-1", reveal: false });
    settle();
    const views = new Map(desk.getView().windows.map((window) => [window.tabId, window]));
    expect(views.get("b-1")?.mini).toBe("parked");
    expect(views.get("b-0")?.mini).toBeNull();
    expect(desk.focusedTabId()).toBe("b-1");
    desk.destroy();
  });

  it("passes to a space for a tab chosen there (reveal): its minimized window grows back, on top and in use", () => {
    // A row of another space, the tab switcher, the palette: the person chose the tab, not the space (2026-10-09).
    native();
    const selected: string[] = [];
    const desk = engine({ select: (tabId) => selected.push(tabId) });
    desk.start([], "a-0", ["a-0"], null, "A");
    settle();
    const saved: SavedDeskWindow[] = [
      { tabId: "b-1", rect: rect(0.5), mini: { restore: { x: 0.4, y: 0.1, w: 0.4, h: 0.6 }, parked: true } },
      { tabId: "b-0", rect: rect(0.05) },
    ];
    desk.switchGroup({ from: "A", groupId: "B", tabIds: ["b-0", "b-1"], saved, entry: "b-1", reveal: true });
    const win = element();
    desk.attachWindow("b-1", win as unknown as HTMLElement);
    settle();
    const views = new Map(desk.getView().windows.map((window) => [window.tabId, window]));
    expect(views.get("b-1")?.mini).toBeNull();
    expect(views.get("b-0")?.mini).toBeNull();
    expect(desk.windowTabIds().at(-1)).toBe("b-1");
    expect(desk.focusedTabId()).toBe("b-1");
    expect(desk.inUse("b-1")).toBe(true);
    expect(selected.at(-1)).toBe("b-1");
    // At the box it grows back to.
    expectRect(rectOf(win), denormalizeRect({ x: 0.4, y: 0.1, w: 0.4, h: 0.6 }, usable));
    desk.destroy();
  });

  // DeskSurface's choice when main makes another space current (takesOnInPlace): regroup only for a window that is
  // out and staying; one on its way into a row is the passing's to turn round (2026-10-09).
  it("moves a space's only tab to a space never on the desk: its window turns round, in use, rather than flying on into the row", () => {
    native();
    const moved: Array<[string, string, string | null]> = [];
    const desk = engine({ moveTabToGroup: (tabId, groupId, next) => moved.push([tabId, groupId, next]) });
    desk.start([], "t", ["t"], null, "A");
    const win = element();
    desk.attachWindow("t", win as unknown as HTMLElement);
    settle();
    // "Add to G" from its menu: no other tab of A to go to, so main makes G current with t in use (the host's addTab).
    desk.moveTabToGroup("t", "G");
    expect(moved).toEqual([["t", "G", null]]);
    step(4);
    // Its window is still on the desk, on its way into G's row: counted among the windows, but not staying.
    expect(desk.windowTabIds()).toEqual(["t"]);
    expect(desk.isStaying("t")).toBe(false);
    expect(takesOnInPlace(desk, "t", false)).toBe(false);
    desk.switchGroup({ from: "A", groupId: "G", tabIds: ["t"], saved: [], entry: "t" });
    settle();
    expect(desk.windowTabIds()).toEqual(["t"]);
    expect(desk.isStaying("t")).toBe(true);
    expect(desk.focusedTabId()).toBe("t");
    expect(desk.getView().windows[0]!.flight).toBeNull();
    // G's one tab: it fills the desk, as a space of one comes up.
    expectRect(rectOf(win), usable);
    desk.destroy();
  });

  it("passes A → B → A → B before B was open: B's window on its way home turns round, never regrouped away", () => {
    native();
    const saves = new Map<string, SavedDeskWindow[]>();
    let shown = "A";
    const desk = engine({ save: (windows) => saves.set(shown, windows) });
    desk.start([], "a-0", ["a-0"], null, "A");
    settle();
    desk.switchGroup({ from: "A", groupId: "B", tabIds: ["b-0"], saved: [], entry: "b-0" });
    shown = "B";
    step(2);
    expect(desk.getView().phase).toBe("entering");
    desk.switchGroup({ from: "B", groupId: "A", tabIds: ["a-0"], saved: saves.get("A")!, entry: "a-0" });
    shown = "A";
    // Only an open desk is saved: B never was.
    expect(saves.has("B")).toBe(false);
    step(2);
    expect(desk.windowTabIds()).toContain("b-0");
    expect(takesOnInPlace(desk, "b-0", saves.has("B"))).toBe(false);
    desk.switchGroup({ from: "A", groupId: "B", tabIds: ["b-0"], saved: [], entry: "b-0" });
    shown = "B";
    settle();
    expect(desk.windowTabIds()).toEqual(["b-0"]);
    expect(desk.focusedTabId()).toBe("b-0");
    expect(desk.getView().phase).toBe("open");
    expect(saves.get("B")?.map((window) => window.tabId)).toEqual(["b-0"]);
    desk.destroy();
  });

  it("takes on a space in place with one of its windows flying into a row: it turns round to where it left, under the window in use", () => {
    native();
    const desk = engine();
    desk.start([], "tab-0", tabIds(2), null, "A");
    desk.attachWindow("tab-0", element() as unknown as HTMLElement);
    settle();
    desk.add("tab-1", { focus: false });
    const other = element();
    desk.attachWindow("tab-1", other as unknown as HTMLElement);
    settle();
    const left = rectOf(other);
    // tab-1 sent to G from its menu: tab-0 is in use, and tab-1's window sets off for G's row.
    desk.moveTabToGroup("tab-1", "G");
    step(3);
    expect(desk.isStaying("tab-1")).toBe(false);
    expect(desk.focusedTabId()).toBe("tab-0");
    // G is the desk's own space now (tab-0 put in it too, in use and staying): taken on in place.
    expect(takesOnInPlace(desk, "tab-0", false)).toBe(true);
    desk.regroup(["tab-0", "tab-1"], null, "G");
    settle();
    expect(desk.windowTabIds()).toEqual(["tab-1", "tab-0"]);
    expect(desk.isStaying("tab-1")).toBe(true);
    expectRect(rectOf(other), left);
    expect(desk.focusedTabId()).toBe("tab-0");
    desk.destroy();
  });

  it("takes on a space in place with one of its windows still waiting to go: it stays where it is", () => {
    // Live pages with no stills coming: a window waits for its still before it flies.
    native();
    const desk = engine({ hasLivePage: () => true });
    desk.start([], "tab-0", tabIds(2), null, "A");
    settle();
    desk.add("tab-1", { focus: false });
    const other = element();
    desk.attachWindow("tab-1", other as unknown as HTMLElement);
    settle();
    const left = rectOf(other);
    desk.moveTabToGroup("tab-1", "G");
    expect(desk.isStaying("tab-1")).toBe(false);
    desk.regroup(["tab-0", "tab-1"], null, "G");
    expect(desk.isStaying("tab-1")).toBe(true);
    settle();
    expect([...desk.windowTabIds()].sort()).toEqual(["tab-0", "tab-1"]);
    expectRect(rectOf(other), left);
    desk.destroy();
  });
});

describe("a window in flight as the stage changes size (⌘S, a window resize)", () => {
  it("lands inside the new stage: its target follows the desk, as the windows out do", () => {
    native();
    let width = 1600;
    const desk = engine();
    const stage = { getBoundingClientRect: () => ({ left: 0, top: 0, width, height: 1000 }) } as unknown as HTMLElement;
    desk.attachStage(stage);
    desk.start([], "a-0", ["a-0"], null, "A");
    settle();
    const right: Rect = { x: 0.6, y: 0.1, w: 0.38, h: 0.6 };
    desk.switchGroup({ from: "A", groupId: "B", tabIds: ["b-0", "b-1"], saved: [{ tabId: "b-0", rect: right }], entry: "b-0" });
    const win = element();
    desk.attachWindow("b-0", win as unknown as HTMLElement);
    step(2);
    expect(desk.getView().windows.find((window) => window.tabId === "b-0")!.flight).toBe("in");
    // The stage narrows mid-flight (the sidebar whole again): the window lands at its share of the new desk.
    width = 1200;
    desk.measure();
    settle();
    const landed = rectOf(win);
    expect(landed.x + landed.w).toBeLessThanOrEqual(1200 + 1);
    // (Rescaled with its gutter, as a window at rest is: rescaleRect.)
    expectRect(landed, rescaleRect(denormalizeRect(right, usable), usable, { x: 0, y: 0, w: 1200, h: 1000 }));
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

/* ------------------------------ a cold start ------------------------------ */

describe("a cold start (the shell's boot, a reload, a Profile switch: docs/spaces.md §2)", () => {
  const at = (x: number, y: number): Rect => ({ x, y, w: 0.4, h: 0.5 });
  const mask = { x: 40, y: 30, width: 320, height: 200, pageWidth: 900, pageHeight: 700 };

  it("places every saved window where it was left at once — masked masked, minimized parked, the tab in use on top — and nothing flies", () => {
    const { desks } = native();
    const desk = engine();
    const saved: SavedDeskWindow[] = [
      { tabId: "tab-0", rect: at(0.05, 0.05) },
      { tabId: "tab-1", rect: at(0.5, 0.1) },
      { tabId: "tab-2", rect: at(0.2, 0.3), mask },
      { tabId: "tab-3", rect: at(0.1, 0.1), mini: { restore: at(0.3, 0.2), parked: true } },
    ];
    const els = new Map(saved.map((window) => [window.tabId, element()]));
    desk.start(saved, "tab-1", tabIds(4), null, "g1");
    for (const [tabId, el] of els) desk.attachWindow(tabId, el as unknown as HTMLElement);
    // The first frame: open, every window where it was left, none in flight.
    const view = desk.getView();
    expect(view.phase).toBe("open");
    expect(view.windows.every((window) => window.flight === null && window.framed)).toBe(true);
    expectRect(rectOf(els.get("tab-0")!), denormalizeRect(at(0.05, 0.05), usable));
    // The tab in use is on top of the windows at their own size (the shelf stays over them).
    expect(desk.focusedTabId()).toBe("tab-1");
    expect(desk.windowTabIds().filter((tabId) => tabId !== "tab-3").at(-1)).toBe("tab-1");
    expect(view.windows.find((window) => window.tabId === "tab-2")?.mask).toEqual(mask);
    expect(view.windows.find((window) => window.tabId === "tab-3")?.mini).toBe("parked");
    // Main hears of the mask and the minimized page's zoom in the very first report, and of the space it is.
    expect(desks[0]?.masks?.map((page) => page.tabId)).toEqual(["tab-2"]);
    expect(desks[0]?.zoomed?.map((page) => page.tabId)).toEqual(["tab-3"]);
    expect(desks[0]?.groupId).toBe("g1");
    settle();
    expectRect(rectOf(els.get("tab-1")!), denormalizeRect(at(0.5, 0.1), usable));
    for (const state of desks) expect(isDeskState(state)).toBe(true);
    desk.destroy();
  });

  it("brings the window in use back as it was left, minimized: parked, still the one in use — only a choice grows it back", () => {
    // The one window minimized: main kept its tab in use, and the reload starts on it (2026-10-09; it came back expanded).
    native();
    const lone = engine();
    lone.start([{ tabId: "tab-0", rect: at(0.1, 0.1), mini: { restore: at(0.3, 0.2), parked: true } }], "tab-0", tabIds(1), null, "g1");
    const mini = (desk: DeskEngine, tabId: string) => desk.getView().windows.find((window) => window.tabId === tabId)?.mini;
    expect(mini(lone, "tab-0")).toBe("parked");
    expect(lone.focusedTabId()).toBe("tab-0");
    settle();
    expect(mini(lone, "tab-0")).toBe("parked");
    // Its row chosen: it grows back.
    lone.add("tab-0", { focus: true });
    settle();
    expect(mini(lone, "tab-0")).toBeNull();
    lone.destroy();
    // Beside a window out at its own size, a minimized one out on the desk (dragged from the shelf) stays so too.
    const two = engine();
    two.start(
      [
        { tabId: "tab-0", rect: at(0.05, 0.05) },
        { tabId: "tab-1", rect: at(0.5, 0.5), mini: { restore: at(0.3, 0.2), parked: false } },
      ],
      "tab-1",
      tabIds(2),
      null,
      "g1",
    );
    settle();
    expect(mini(two, "tab-0")).toBeNull();
    expect(mini(two, "tab-1")).toBe("free");
    expect(two.windowTabIds().at(-1)).toBe("tab-1");
    two.destroy();
  });

  it("comes up on a space never on a desk as its tab in use alone: filling the desk when it is its one tab, in the middle otherwise", () => {
    native();
    const one = engine();
    one.start([], "a", ["a"]);
    const filled = element();
    one.attachWindow("a", filled as unknown as HTMLElement);
    expect(one.getView().phase).toBe("open");
    expectRect(rectOf(filled), usable);
    one.destroy();
    const two = engine();
    two.start([], "b", ["a", "b"]);
    const middle = element();
    two.attachWindow("b", middle as unknown as HTMLElement);
    expect(two.windowTabIds()).toEqual(["b"]);
    expectRect(rectOf(middle), centeredRect(usable));
    two.destroy();
  });

  it("comes up on an empty space as nothing, open at once: the empty desk", () => {
    const { desks } = native();
    const desk = engine();
    desk.start([], null, [], [], "empty");
    expect(desk.getView()).toMatchObject({ phase: "open", windows: [] });
    expect(desks[0]).toMatchObject({ tabIds: [], live: [], groupId: "empty" });
    desk.destroy();
  });

  it("rescales its windows if the stage changes size as it starts (the sidebar settling at its width)", () => {
    native();
    const box = { left: 0, top: 0, width: 1600, height: 1000 };
    const desk = new DeskEngine({
      variants: () => BAR_VARIANTS,
      hasLivePage: () => false,
      select: () => undefined,
      close: () => undefined,
      editAddress: () => undefined,
      save: () => undefined,
      moveTabToGroup: () => undefined,
      sidebar: () => SIDEBAR,
      sidebarAway: () => false,
      homeOf: () => null,
    });
    desk.attachStage({ getBoundingClientRect: () => ({ ...box }) } as unknown as HTMLElement);
    const saved: SavedDeskWindow[] = [{ tabId: "tab-0", rect: { x: 0.5, y: 0, w: 0.5, h: 1 } }];
    desk.start(saved, "tab-0", tabIds(2));
    const win = element();
    desk.attachWindow("tab-0", win as unknown as HTMLElement);
    expectRect(rectOf(win), { x: 800, y: 0, w: 800, h: 1000 });
    // The whole sidebar gives way to the rail: the stage grows, before the desk has settled at all.
    box.left = -200;
    box.width = 1800;
    desk.measure();
    settle();
    expectRect(rectOf(win), { x: 900, y: 0, w: 900, h: 1000 }, 2);
    desk.destroy();
  });
});

/* ---------------------- which pages the desk wants awake ---------------------- */

describe("the pages the desk wants awake (DeskState.live)", () => {
  const liveOf = (desks: Array<DeskState | null>): string[] => [...(desks.at(-1)?.live ?? [])].sort();

  it("of a cascade, only the window nothing covers — the one in use; a window raised joins it; and the report holds up", () => {
    const { desks } = native();
    const desk = engine();
    const ids = tabIds(6);
    desk.start([], "tab-0", ids, null, "g1");
    settle();
    for (const tabId of ids.slice(1)) desk.add(tabId, { focus: false });
    settle();
    desk.arrange("cascade");
    settle();
    const top = desk.windowTabIds().at(-1)!;
    desk.activeChanged(top);
    settle();
    expect(liveOf(desks)).toEqual([top]);
    expect(desk.getView().windows.filter((window) => window.live).map((window) => window.tabId)).toEqual([top]);
    // Raised: in use and on top — and the window it was over, its own still uncovered-or-not, is no longer it.
    const bottom = desk.windowTabIds()[0]!;
    desk.activeChanged(bottom);
    settle();
    expect(liveOf(desks)).toContain(bottom);
    expect(desks.at(-1)?.groupId).toBe("g1");
    for (const state of desks) expect(isDeskState(state)).toBe(true);
    desk.destroy();
  });

  it("of a tiled desk, every window; but not a minimized one, nor another group's on its way home", () => {
    const { desks } = native();
    const desk = engine();
    const ids = tabIds(4);
    desk.start([], "tab-0", ids, null, "g1");
    settle();
    for (const tabId of ids.slice(1)) desk.add(tabId, { focus: false });
    settle();
    desk.arrange("tile");
    settle();
    expect(liveOf(desks)).toEqual([...ids].sort());
    desk.minimize("tab-3");
    settle();
    expect(liveOf(desks)).not.toContain("tab-3");
    desk.switchGroup({ from: "g1", groupId: "g2", tabIds: ["b-0"], saved: [], entry: "b-0" });
    // At once: the next group's window, coming out, is wanted; the old group's, going home, are not.
    expect(desks.at(-1)?.live).toEqual(["b-0"]);
    expect(desks.at(-1)?.groupId).toBe("g2");
    settle();
    desk.destroy();
  });
});
