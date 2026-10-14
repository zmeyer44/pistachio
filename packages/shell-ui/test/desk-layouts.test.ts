/**
 * The desk's named layouts (docs/double-sidebar.md §1 "Layouts"): which a
 * number of windows allows, where every window goes for each
 * (lib/desk/layouts.ts), recognising the layout the windows are in — both
 * ways: laid out, it is recognised; a window nudged, it is not — and the
 * engine's half: layOut, the view's `layout` and `layoutCount`, and the
 * preview drawn under its cover.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DragSample } from "@pistachio/shell-contracts/chrome";
import type { DeskState } from "@pistachio/shell-contracts/desk";
import { NATIVE_SURFACE_MEMBERS } from "@pistachio/shell-contracts/ipc";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { DeskEngine, LAYOUT_PREVIEW_COVER } from "../src/components/desk/desk-engine";
import { cascadeRects, columnRects, DESK_GAP, denormalizeRect, MIN_WINDOW_H, MIN_WINDOW_W, normalizeRect, rescaleRect, stackRects, tileRects, type Rect } from "../src/lib/desk/geometry";
import {
  columnsFit,
  cycledLayout,
  focusRects,
  holdsLayout,
  isLaidOutAs,
  layoutNow,
  layoutOf,
  layoutRects,
  layoutsFor,
  layoutsOn,
  LAYOUT_WORDS,
  rowsFit,
  slotRects,
  type DeskLayoutKind,
  type LaidOutAs,
} from "../src/lib/desk/layouts";
import { FOCUS_SHARE, focusLayout, focusRoom } from "../src/lib/desk/smart-layout";
import { DEFAULT_DESK_VARIANTS } from "../src/lib/desk/store";

const desk: Rect = { x: 0, y: 0, w: 1600, h: 1000 };

function expectRect(actual: Rect | undefined, expected: Rect): void {
  expect(actual).toBeDefined();
  for (const key of ["x", "y", "w", "h"] as const) expect(Math.abs(actual![key] - expected[key]), `${key}: ${actual![key]} vs ${expected[key]}`).toBeLessThanOrEqual(0.5);
}

/** `count` windows lying loose: overlapping, none in a layout's place. */
/** The same box, within a pixel. */
function sameBox(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1;
}

function loose(count: number): Map<string, Rect> {
  return new Map(Array.from({ length: count }, (_, index) => [`w${String(index)}`, { x: 40 + index * 97, y: 30 + index * 61, w: 700, h: 520 }]));
}

describe("which layouts a number of windows allows", () => {
  it("offers the spec's layouts for each count, Main and side only while its column holds the rest", () => {
    expect(layoutsFor(0)).toEqual([]);
    expect(layoutsFor(1)).toEqual(["fill"]);
    expect(layoutsFor(2)).toEqual(["halves", "stack", "focus", "cascade"]);
    expect(layoutsFor(3)).toEqual(["tile", "focus", "columns", "cascade"]);
    expect(layoutsFor(4)).toEqual(["tile", "focus", "columns", "cascade"]);
    expect(layoutsFor(5)).toEqual(["tile", "focus", "cascade"]);
    expect(layoutsFor(6)).toEqual(["tile", "cascade"]);
    expect(layoutsFor(12)).toEqual(["tile", "cascade"]);
    // A short desk's column holds two: four windows have no Main and side, five neither.
    expect(layoutsFor(4, 2)).toEqual(["tile", "columns", "cascade"]);
    expect(layoutsFor(5, 2)).toEqual(["tile", "cascade"]);
  });

  it("offers Columns only while each column is a window's least width, and Stacked while each row is its least height", () => {
    // Four columns a gutter apart need 4 × 300 + 3 × 8 px; two rows 2 × 200 + 8.
    const narrow = { x: 0, y: 0, w: 4 * MIN_WINDOW_W + 3 * DESK_GAP - 1, h: 1000 };
    expect(columnsFit(4, narrow)).toBe(false);
    expect(columnsFit(3, narrow)).toBe(true);
    expect(columnsFit(4, { ...narrow, w: narrow.w + 1 })).toBe(true);
    expect(layoutsOn(4, narrow)).toEqual(["tile", "focus", "cascade"]);
    expect(layoutsOn(3, narrow)).toEqual(["tile", "focus", "columns", "cascade"]);
    const short = { x: 0, y: 0, w: 1600, h: 2 * MIN_WINDOW_H + DESK_GAP - 1 };
    expect(rowsFit(2, short)).toBe(false);
    expect(layoutsOn(2, short)).toEqual(["halves", "focus", "cascade"]);
    expect(layoutsOn(2, { ...short, h: short.h + 1 })).toEqual(["halves", "stack", "focus", "cascade"]);
    // Without the desk, as LayoutControl asked before: not gated.
    expect(layoutsFor(4, Number.POSITIVE_INFINITY)).toContain("columns");
    // Nor laid out so, nor recognised.
    expect(layoutRects("columns", loose(4), narrow, null)).toBeNull();
    expect(layoutRects("stack", loose(2), short, null)).toBeNull();
    expect(layoutOf(columnRects(4, narrow), narrow)).toBeNull();
  });

  it("names each layout in the space view's words", () => {
    expect(LAYOUT_WORDS.focus.label).toBe("Main and side");
    expect(LAYOUT_WORDS.focus.caption(3)).toBe("the window in use takes 62%, the rest stack beside it");
    expect(LAYOUT_WORDS.halves.label).toBe("Side by side");
    expect(LAYOUT_WORDS.tile.caption(3)).toBe("one on the left, two stacked on the right");
    expect(LAYOUT_WORDS.tile.caption(5)).toBe("an equal share for every window");
  });
});

describe("where the windows go", () => {
  it("lays rows and columns a gutter apart, edge to edge", () => {
    const rows = stackRects(3, desk);
    expect(rows.map((rect) => rect.w)).toEqual([1600, 1600, 1600]);
    expect(rows[1]!.y - (rows[0]!.y + rows[0]!.h)).toBeCloseTo(DESK_GAP);
    expect(rows[2]!.y + rows[2]!.h).toBeCloseTo(desk.h);
    const columns = columnRects(4, desk);
    expect(columns.map((rect) => rect.h)).toEqual([1000, 1000, 1000, 1000]);
    expect(columns[1]!.x - (columns[0]!.x + columns[0]!.w)).toBeCloseTo(DESK_GAP);
    expect(columns[3]!.x + columns[3]!.w).toBeCloseTo(desk.w);
    // Side by side is two columns, and Tile's two.
    expect(slotRects("halves", 2, desk)).toEqual(columnRects(2, desk));
    expect(tileRects(2, desk)).toEqual(columnRects(2, desk));
  });

  it("puts Main and side's places where the smart layout's main place is", () => {
    const windows = loose(4);
    const smart = [...focusLayout(windows, desk, "w0")!.values()];
    const slots = focusRects(4, desk);
    expect(slots).toHaveLength(4);
    for (const slot of slots) expect(smart.some((rect) => Math.abs(rect.x - slot.x) < 0.5 && Math.abs(rect.y - slot.y) < 0.5 && Math.abs(rect.w - slot.w) < 0.5 && Math.abs(rect.h - slot.h) < 0.5)).toBe(true);
    expect(slots[0]!.w).toBe(Math.round((desk.w - DESK_GAP) * FOCUS_SHARE));
  });

  it("gives the window in use the main place: the first tile, Main and side's main place, the front of a cascade", () => {
    const windows = loose(3);
    const tiled = layoutRects("tile", windows, desk, "w2")!;
    expectRect(tiled.get("w2"), tileRects(3, desk)[0]!);
    const focused = layoutRects("focus", windows, desk, "w1")!;
    expectRect(focused.get("w1"), focusRects(3, desk)[0]!);
    // None of them in use (a document's window, masked): the largest takes it.
    const sized = new Map(windows).set("w0", { x: 10, y: 10, w: 1200, h: 900 });
    expectRect(layoutRects("focus", sized, desk, "elsewhere")!.get("w0"), focusRects(3, desk)[0]!);
    // A cascade keeps the windows' stacking, the one in use brought to the front (the map's order is back to front).
    const cascade = layoutRects("cascade", windows, desk, "w0")!;
    expect([...cascade.keys()]).toEqual(["w1", "w2", "w0"]);
    expect([...cascade.values()]).toEqual(cascadeRects(3, desk));
  });

  it("keeps the windows' order across for columns and down for rows, so none crosses another", () => {
    const windows = new Map<string, Rect>([
      ["right", { x: 1100, y: 500, w: 400, h: 300 }],
      ["left", { x: 20, y: 20, w: 400, h: 300 }],
      ["middle", { x: 600, y: 600, w: 400, h: 300 }],
    ]);
    const columns = layoutRects("columns", windows, desk, "right")!;
    expect([...columns.keys()]).toEqual(["left", "middle", "right"]);
    expect(columns.get("left")!.x).toBe(0);
    const rows = layoutRects("stack", windows, desk, null)!;
    expect([...rows.keys()]).toEqual(["left", "right", "middle"]);
  });

  it("lays out nothing a layout is not for", () => {
    expect(layoutRects("fill", loose(2), desk, null)).toBeNull();
    expect(layoutRects("halves", loose(3), desk, null)).toBeNull();
    expect(layoutRects("focus", loose(1), desk, null)).toBeNull();
    // A column too short for the rest.
    const short = { x: 0, y: 0, w: 1600, h: 500 };
    expect(focusRoom(short)).toBe(2);
    expect(layoutRects("focus", loose(4), short, "w0")).toBeNull();
  });
});

describe("a layout's windows turned round its places (Tab on a layout looked at)", () => {
  const left: Rect = { x: 0, y: 0, w: 796, h: 1000 };
  const right: Rect = { x: 804, y: 0, w: 796, h: 1000 };

  it("trades two windows' places at each turn, and back with a turn the other way", () => {
    const halves = new Map([
      ["a", right],
      ["b", left],
    ]);
    // In reading order the places are left then right: A, on the right, goes round to the left.
    expect([...cycledLayout(halves, 1)]).toEqual([
      ["a", left],
      ["b", right],
    ]);
    expect(cycledLayout(halves, 2)).toEqual(new Map([["b", left], ["a", right]]));
    expect(cycledLayout(halves, -1)).toEqual(cycledLayout(halves, 1));
  });

  it("moves each window to the next place in reading order, the last coming round to the first: each takes the main place in turn", () => {
    const focused = layoutRects("focus", loose(3), desk, "w0")!;
    const main = focusRects(3, desk)[0]!;
    const holder = (layout: ReadonlyMap<string, Rect>): string => [...layout].find(([, rect]) => sameBox(rect, main))![0];
    const holders = [0, 1, 2].map((turn) => holder(cycledLayout(focused, turn)));
    expect(new Set(holders).size).toBe(3);
    expect(holder(cycledLayout(focused, 3))).toBe(holders[0]);
    // The places are the layout's own: only who holds which changes.
    expect(isLaidOutAs("focus", [...cycledLayout(focused, 1).values()], desk)).toBe(true);
  });

  it("keeps a cascade's places back to front, so a turn restacks it", () => {
    const cascade = layoutRects("cascade", loose(3), desk, "w0")!;
    const turned = [...cycledLayout(cascade, 1)];
    const ys = turned.map(([, rect]) => rect.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(turned.map(([id]) => id)).not.toEqual([...cascade.keys()]);
  });
});

describe("the layout the windows are in", () => {
  it("is recognised once laid out, for every layout each number of windows allows", () => {
    for (let count = 1; count <= 8; count += 1) {
      for (const kind of layoutsFor(count, focusRoom(desk))) {
        const laid = layoutRects(kind, loose(count), desk, "w0")!;
        expect(laid, `${kind} × ${String(count)}`).not.toBeNull();
        expect(layoutOf([...laid.values()], desk), `${kind} × ${String(count)}`).toBe(kind);
      }
    }
  });

  it("is no layout once a window is nudged, or with the windows lying loose", () => {
    const kinds: DeskLayoutKind[] = ["fill", "halves", "stack", "focus", "tile", "columns", "cascade"];
    for (const kind of kinds) {
      const count = kind === "fill" ? 1 : kind === "halves" || kind === "stack" ? 2 : 4;
      const laid = [...layoutRects(kind, loose(count), desk, "w0")!.values()];
      laid[count - 1] = { ...laid[count - 1]!, x: laid[count - 1]!.x + 6 };
      expect(layoutOf(laid, desk), kind).toBeNull();
    }
    expect(layoutOf([...loose(3).values()], desk)).toBeNull();
    expect(layoutOf([], desk)).toBeNull();
  });

  it("matches as sets, whichever window is in which place, and within a couple of px", () => {
    const tiles = tileRects(4, desk);
    const shuffled = [tiles[2]!, tiles[0]!, tiles[3]!, { ...tiles[1]!, x: tiles[1]!.x + 1.5, h: tiles[1]!.h - 1 }];
    expect(isLaidOutAs("tile", shuffled, desk)).toBe(true);
    expect(layoutOf(shuffled, desk)).toBe("tile");
    // Main and side's main place, held by whichever window.
    const focus = focusRects(3, desk);
    expect(layoutOf([focus[2]!, focus[0]!, focus[1]!], desk)).toBe("focus");
  });

  it("calls one window filling the desk Fill, and two tiled Side by side", () => {
    expect(layoutOf([{ ...desk }], desk)).toBe("fill");
    expect(layoutOf([{ x: 100, y: 100, w: 900, h: 700 }], desk)).toBeNull();
    expect(layoutOf(tileRects(2, desk), desk)).toBe("halves");
    expect(layoutOf(stackRects(2, desk), desk)).toBe("stack");
  });
});

describe("the layout the windows were laid out in, on a desk resized since", () => {
  /** `kind` laid out over `count` loose windows on the 1600×1000 desk, as the engine remembers it. */
  function laidOut(kind: DeskLayoutKind, count: number): LaidOutAs {
    return { kind, desk, boxes: layoutRects(kind, loose(count), desk, "w0")! };
  }
  /** The windows carried to another desk as the desk carries them (rescaleRect), or in plain proportion (a saved desk). */
  function carried(laid: LaidOutAs, to: Rect, how: "rescale" | "proportion" = "rescale"): Map<string, Rect> {
    return new Map([...laid.boxes].map(([id, rect]) => [id, how === "rescale" ? rescaleRect(rect, desk, to) : denormalizeRect(normalizeRect(rect, desk), to)]));
  }
  // ⌘S frees the card's width; a window made shorter.
  const wider: Rect = { x: 0, y: 0, w: 1900, h: 1000 };
  const shorter: Rect = { x: 0, y: 0, w: 1300, h: 820 };

  it("loses a cascade, and Tile's grid, to geometry alone — and keeps them while the windows stand where they were put", () => {
    for (const [kind, count] of [["cascade", 4], ["cascade", 2], ["tile", 4], ["focus", 3], ["columns", 3], ["stack", 2]] as const) {
      const laid = laidOut(kind, count);
      for (const to of [wider, shorter]) {
        const now = carried(laid, to);
        expect(holdsLayout(laid, now, to), `${kind} × ${String(count)}`).toBe(true);
        expect(layoutNow(now, to, laid), `${kind} × ${String(count)}`).toBe(kind);
      }
    }
    // (Why: the step and the box of a cascade are not in proportion with the desk.)
    expect(layoutOf([...carried(laidOut("cascade", 4), wider).values()], wider)).toBeNull();
    // Carried in plain proportion (passing back to the space on a resized desk), within a gutter's share of the change.
    const cascade = laidOut("cascade", 4);
    expect(layoutNow(carried(cascade, wider, "proportion"), wider, cascade)).toBe("cascade");
  });

  it("is no layout once a window is nudged, one is added or gone, and not one the windows' number does not allow here", () => {
    const laid = laidOut("cascade", 4);
    const now = carried(laid, wider);
    const nudged = new Map(now).set("w2", { ...now.get("w2")!, x: now.get("w2")!.x + 12 });
    expect(holdsLayout(laid, nudged, wider)).toBe(false);
    expect(layoutNow(nudged, wider, laid)).toBeNull();
    const fewer = new Map(now);
    fewer.delete("w3");
    expect(layoutNow(fewer, wider, laid)).toBeNull();
    expect(layoutNow(new Map(now).set("w9", { x: 0, y: 0, w: 400, h: 300 }), wider, laid)).toBeNull();
    // Columns on a desk now too narrow for four of them: not on the track, so not the layout it is in.
    const columns = laidOut("columns", 4);
    const narrow: Rect = { x: 0, y: 0, w: 1200, h: 1000 };
    expect(layoutNow(carried(columns, narrow), narrow, columns)).toBeNull();
    // What the windows' boxes read as comes first when the remembered layout no longer holds.
    expect(layoutNow(new Map(tileRects(3, wider).map((rect, index) => [`w${String(index)}`, rect])), wider, laidOut("focus", 3))).toBe("tile");
  });
});

/* ── The engine's half ── */

let frames: Array<(now: number) => void> = [];
let clock = 0;

function settle(): void {
  for (let i = 0; i < 2_000 && frames.length > 0; i += 1) {
    const due = frames;
    frames = [];
    clock += 16;
    for (const frame of due) frame(clock);
  }
}

function native(): { drag: { sample: ((sample: DragSample) => void) | null }; desks: Array<DeskState | null> } {
  const drag: { sample: ((sample: DragSample) => void) | null } = { sample: null };
  const desks: Array<DeskState | null> = [];
  const members = Object.fromEntries(Object.keys(NATIVE_SURFACE_MEMBERS).map((member) => [member, vi.fn()]));
  setShellApi({
    ...members,
    getCursorPoint: () => {
      throw new Error("no pointer");
    },
    setLayout: () => undefined,
    setDesk: (state: DeskState | null) => desks.push(state),
    captureTabStills: () => Promise.resolve([]),
    focusTab: () => Promise.resolve(),
    onDragSample: (listener: (sample: DragSample) => void) => {
      drag.sample = listener;
      return () => {
        if (drag.sample === listener) drag.sample = null;
      };
    },
  } as unknown as ShellApiBridge);
  return { drag, desks };
}

/** Frames run, `count` of them (a gesture keeps asking for frames, so settle would run it out). */
function run(count: number): void {
  for (let i = 0; i < count && frames.length > 0; i += 1) {
    const due = frames;
    frames = [];
    clock += 16;
    for (const frame of due) frame(clock);
  }
}

/** A desk of `count` shell-drawn windows over a 1600×1000 stage (`stage`, which a test may resize), laid loose (none in a layout), the last in use. */
function open(count: number, stage = { width: 1600, height: 1000 }) {
  const { drag, desks } = native();
  const engine = new DeskEngine({
    variants: () => ({ ...DEFAULT_DESK_VARIANTS, zoom: "actual" as const }),
    spaceSwitch: () => ({ exit: "tile", arrival: "tile" }),
    hasLivePage: () => false,
    select: () => undefined,
    close: () => undefined,
    editAddress: () => undefined,
    save: () => undefined,
    moveTabToGroup: () => undefined,
    sidebar: () => ({ x: -48, y: 0, w: 48, h: 1000 }),
    sidebarAway: () => false,
    homeOf: () => null,
  });
  engine.attachStage({ getBoundingClientRect: () => ({ left: 0, top: 0, width: stage.width, height: stage.height }) } as unknown as HTMLElement);
  const ids = Array.from({ length: count }, (_, index) => `tab-${String(index)}`);
  engine.start([], ids[0]!, ids);
  for (const id of ids.slice(1)) engine.add(id, { focus: true });
  settle();
  engine.restoreLayout({ windows: ids.map((tabId, index) => ({ tabId, rect: { x: 40 + index * 97, y: 30 + index * 61, w: 700, h: 520 }, mini: null })) });
  settle();
  return { engine, drag, desks, ids, stage };
}

describe("the engine's named layouts", () => {
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

  it("lays the windows out, says which layout the desk is in from where they are going, and offers ⌃Z's snapshot", () => {
    const { engine, ids } = open(3);
    expect(engine.getView().layoutCount).toBe(3);
    expect(engine.getView().layout).toBeNull();
    const heard: number[] = [];
    engine.onLaidOut((undo) => heard.push(undo.windows.length));
    expect(engine.layOut("focus")).toBe(true);
    // At once — before the windows have moved — the desk is in it.
    expect(engine.getView().layout).toBe("focus");
    expect(heard).toEqual([3]);
    settle();
    // The window in use (the last out) took the main place.
    const main = engine.layoutView().windows.get(ids[2]!)!;
    expectRect(main, focusRects(3, desk)[0]!);
    // Laid out so already: nothing moves, nothing to put back.
    expect(engine.layOut("focus")).toBe(false);
    expect(heard).toEqual([3]);
    // Tile and Cascade are named layouts too.
    expect(engine.arrange("cascade")).toBe(true);
    expect(engine.getView().layout).toBe("cascade");
    expect(engine.windowTabIds().at(-1)).toBe(ids[2]);
    engine.destroy();
  });

  it("shows a layout's ghosts under a cover over the stage, and takes them away when asked, on a layout, or a window in hand", () => {
    const { engine, ids } = open(2);
    engine.previewLayout("halves");
    let view = engine.getView();
    expect(view.preview?.kind).toBe("halves");
    expect(view.preview?.ghosts.map((ghost) => ghost.id).sort()).toEqual([...ids].sort());
    // Nothing live under it (shell-drawn pages): the cover is clear at once.
    expect(view.clearCovers.has(LAYOUT_PREVIEW_COVER)).toBe(true);
    // The windows have not moved.
    expect(view.layout).toBeNull();
    engine.previewLayout(null);
    view = engine.getView();
    expect(view.preview).toBeNull();
    expect(view.clearCovers.has(LAYOUT_PREVIEW_COVER)).toBe(false);
    // A layout applied takes it away.
    engine.previewLayout("stack");
    expect(engine.getView().preview?.kind).toBe("stack");
    engine.layOut("stack");
    expect(engine.getView().preview).toBeNull();
    expect(engine.getView().layout).toBe("stack");
    settle();
    // A window taken in hand does too.
    engine.previewLayout("halves");
    expect(engine.getView().preview).not.toBeNull();
    engine.grab(ids[0]!, { x: 200, y: 200 });
    settle();
    expect(engine.getView().preview).toBeNull();
    expect(engine.getView().clearCovers.has(LAYOUT_PREVIEW_COVER)).toBe(false);
    engine.destroy();
  });
  it("turns a looked-at layout's windows round its places with Tab: the ghosts show it, a click lays them out so, and main takes Tab only while the pointer rests there", () => {
    const { engine, desks } = open(2);
    const ghostAt = (id: string): Rect => engine.getView().preview!.ghosts.find((ghost) => ghost.id === id)!.rect;
    engine.previewLayout("halves", { cycle: true });
    const first = { a: ghostAt("tab-0"), b: ghostAt("tab-1") };
    expect(desks.at(-1)?.cycleKey).toBe(true);
    expect(engine.cycleLayout(1)).toBe(true);
    // The two trade places.
    expectRect(ghostAt("tab-0"), first.b);
    expectRect(ghostAt("tab-1"), first.a);
    expect(engine.layOut("halves")).toBe(true);
    settle();
    expectRect(engine.layoutView().windows.get("tab-0"), first.b);
    expectRect(engine.layoutView().windows.get("tab-1"), first.a);
    // Laid out, the preview is gone, and Tab is the page's again.
    expect(engine.getView().preview).toBeNull();
    expect(desks.at(-1)?.cycleKey).toBe(false);
    // The keyboard's look (no pointer) never takes Tab.
    engine.previewLayout("stack");
    expect(desks.at(-1)?.cycleKey).toBe(false);
    engine.previewLayout(null);
    engine.destroy();
  });

  it("draws nothing for the layout the desk is in until Tab turns its windows, then turns them where they stand", () => {
    const { engine } = open(2);
    engine.layOut("halves");
    settle();
    const before = { a: engine.layoutView().windows.get("tab-0")!, b: engine.layoutView().windows.get("tab-1")! };
    engine.previewLayout("halves", { cycle: true });
    expect(engine.getView().preview).toBeNull();
    expect(engine.getView().clearCovers.has(LAYOUT_PREVIEW_COVER)).toBe(false);
    engine.cycleLayout(1);
    expect(engine.getView().preview?.kind).toBe("halves");
    // A turn the other way and back is where they stand: nothing to draw again.
    engine.cycleLayout(-1);
    expect(engine.getView().preview).toBeNull();
    engine.cycleLayout(-1);
    expect(engine.layOut("halves")).toBe(true);
    settle();
    expectRect(engine.layoutView().windows.get("tab-0"), before.b);
    expectRect(engine.layoutView().windows.get("tab-1"), before.a);
    expect(engine.getView().layout).toBe("halves");
    engine.destroy();
  });

  it("is still in the layout it was laid out in once the desk is resized, or gives room to the chat, and not once a window is moved", () => {
    for (const kind of ["cascade", "tile", "focus"] as const) {
      const { engine, drag, ids, stage } = open(4);
      expect(engine.layOut(kind)).toBe(true);
      settle();
      // ⌘S frees the card's width: every window carried over in proportion, a gutter kept a gutter.
      stage.width = 1900;
      engine.measure();
      settle();
      expect(engine.getView().layout, kind).toBe(kind);
      stage.width = 1300;
      stage.height = 840;
      engine.measure();
      settle();
      expect(engine.getView().layout, kind).toBe(kind);
      // Room kept for the chat's place, and given back.
      engine.setReserve(360);
      settle();
      expect(engine.getView().layout, kind).toBe(kind);
      engine.setReserve(0);
      settle();
      expect(engine.getView().layout, kind).toBe(kind);
      // In it already: nothing moves, nothing to put back.
      expect(engine.layOut(kind)).toBe(false);
      // A window taken in hand and set down elsewhere: set down by hand.
      const { bounds, windows } = engine.layoutView();
      const box = windows.get(ids[1]!)!;
      const at = { x: box.x + 120, y: box.y + 12 };
      // (Toward the desk's middle, so the desk's edge does not hold it where it was.)
      const toward = { x: Math.sign(bounds.w / 2 - (box.x + box.w / 2)) || 1, y: Math.sign(bounds.h / 2 - (box.y + box.h / 2)) || 1 };
      engine.grab(ids[1]!, at);
      for (let step = 1; step <= 20; step += 1) {
        drag.sample?.({ x: at.x + toward.x * step * 3, y: at.y + toward.y * step * 2, phase: "move" });
        run(1);
      }
      drag.sample?.({ x: 0, y: 0, phase: "cancel" });
      settle();
      expect(engine.layoutView().windows.get(ids[1]!), kind).not.toEqual(box);
      expect(engine.getView().layout, kind).toBeNull();
      engine.destroy();
    }
  });

  it("gives a filled window its box to let go of the desk to back with ⌃Z after a layout, and the layout the desk was in", () => {
    const { engine, ids, stage } = open(3);
    const loose = engine.layoutView().windows.get(ids[0]!)!;
    engine.toggleMaximize(ids[0]!);
    settle();
    const undos: Array<Parameters<Parameters<DeskEngine["onLaidOut"]>[0]>[0]> = [];
    engine.onLaidOut((undo) => undos.push(undo));
    expect(engine.layOut("columns")).toBe(true);
    settle();
    expect(engine.restoreLayout(undos[0]!)).toBe(true);
    settle();
    expectRect(engine.layoutView().windows.get(ids[0]!), { x: 0, y: 0, w: 1600, h: 1000 });
    // Filled again, it lets go of the desk to where it was before it filled it.
    engine.toggleMaximize(ids[0]!);
    settle();
    expectRect(engine.layoutView().windows.get(ids[0]!), loose);

    // A cascade, the desk resized, another layout, and ⌃Z: the desk is in its cascade again.
    expect(engine.layOut("cascade")).toBe(true);
    settle();
    stage.width = 1900;
    engine.measure();
    settle();
    expect(engine.getView().layout).toBe("cascade");
    expect(engine.layOut("tile")).toBe(true);
    settle();
    expect(engine.getView().layout).toBe("tile");
    expect(engine.restoreLayout(undos.at(-1)!)).toBe(true);
    settle();
    expect(engine.getView().layout).toBe("cascade");
    engine.destroy();
  });
});
