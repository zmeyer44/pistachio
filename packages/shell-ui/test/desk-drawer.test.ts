/**
 * The Drawer frame (docs/desk.md): a window is its page alone, its title
 * and controls on a strip behind its top edge. With room for the strip
 * above the window, it slides up out of the window whenever the pointer is
 * on the window or the window is in use; with less, it comes out only for
 * the pointer at the window's top, and pushes the window down for the rest
 * — its page cut short at the desk's foot and held at its own size, so it
 * never lays out anew. A window below another in a split one above the
 * other has no room either, whichever is in use: its drawer pushes it down
 * the same way, the gap kept, and never lies over the window above. Before
 * such a drawer goes back in, main is asked where the pointer really is:
 * the window slid its page out from under it.
 *
 * The engine runs a frame at a time outside React; here the frames are
 * driven by hand, main's answers coming between them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DragSample } from "@pistachio/shell-contracts/chrome";
import type { DeskState } from "@pistachio/shell-contracts/desk";
import { NATIVE_SURFACE_MEMBERS, type BrowserLayout, type CursorPoint } from "@pistachio/shell-contracts/ipc";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { DeskEngine, DRAWER_H } from "../src/components/desk/desk-engine";
import { DESK_GAP, type Rect } from "../src/lib/desk/geometry";
import { DEFAULT_DESK_VARIANTS } from "../src/lib/desk/store";

let frames: Array<(now: number) => void> = [];
let clock = 0;

/** One frame, then main's answers. */
async function frame(): Promise<void> {
  const due = frames;
  frames = [];
  clock += 16;
  for (const run of due) run(clock);
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

/** Frames until none is asked for. */
async function settle(): Promise<void> {
  for (let i = 0; i < 2_000 && frames.length > 0; i += 1) await frame();
}

/** Let `ms` pass a frame at a time (the frames asked for meanwhile run; none after). */
async function pass(ms: number): Promise<void> {
  const until = clock + ms;
  while (clock < until) await frame();
}

const STAGE = { w: 1600, h: 1000 };
const ROOMY: Rect = { x: 100, y: 200, w: 600, h: 500 };
const OTHER: Rect = { x: 800, y: 200, w: 600, h: 500 };
const FILLED: Rect = { x: 0, y: 0, w: STAGE.w, h: STAGE.h };

function element() {
  const style: Record<string, string> = {};
  Object.defineProperties(style, {
    setProperty: { value: (name: string, value: string) => (style[name] = value) },
    removeProperty: { value: (name: string) => delete style[name] },
  });
  return { style, dataset: {} as Record<string, string> };
}

function shownTop(el: ReturnType<typeof element>): number {
  return Number(/translate3d\(-?[\d.]+px, (-?[\d.]+)px/.exec(el.style["transform"] ?? "")![1]);
}

/** Where a window is shown: its element's box (pushed down by its drawer, its top is below its own box's). */
function shownBox(el: ReturnType<typeof element>): Rect {
  const [x, y] = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(el.style["transform"] ?? "")!.slice(1).map(Number);
  return { x: x!, y: y!, w: Number.parseFloat(el.style["width"]!), h: Number.parseFloat(el.style["height"]!) };
}

const TOP: { left: boolean; right: boolean; top: boolean; bottom: boolean } = { left: false, right: false, top: true, bottom: false };

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
  vi.stubGlobal("requestAnimationFrame", (run: (now: number) => void) => {
    frames.push(run);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setShellApi({} as unknown as ShellApiBridge);
});

/**
 * Two windows out side by side with room above them (tab-0 in use), their elements attached; the OS pointer where
 * `cursor` says (null: main cannot say). With `stills`, every picture asked for comes back.
 */
async function open(options: { stills?: boolean } = {}) {
  const layouts: BrowserLayout[] = [];
  const desks: Array<DeskState | null> = [];
  const cursor: { point: CursorPoint | null } = { point: null };
  const drag: { sample: ((sample: DragSample) => void) | null } = { sample: null };
  const members = Object.fromEntries(Object.keys(NATIVE_SURFACE_MEMBERS).map((member) => [member, vi.fn()]));
  setShellApi({
    ...members,
    setLayout: (layout: BrowserLayout) => layouts.push(layout),
    setDesk: (state: DeskState | null) => desks.push(state),
    captureTabStills: (ids: readonly string[]) =>
      Promise.resolve(options.stills === true ? ids.map((tabId) => ({ tabId, dataUrl: `data:image/jpeg;base64,${tabId}` })) : []),
    focusTab: () => Promise.resolve(),
    getCursorPoint: () => Promise.resolve(cursor.point),
    onDragSample: (listener: (sample: DragSample) => void) => {
      drag.sample = listener;
      return () => {
        if (drag.sample === listener) drag.sample = null;
      };
    },
  } as unknown as ShellApiBridge);
  const desk = new DeskEngine({
    // (Every page at its own size, as these were written for: Page zoom's Fit is desk-page-zoom.test.ts's.)
    variants: () => ({ ...DEFAULT_DESK_VARIANTS, zoom: "actual" as const }),
    spaceSwitch: () => ({ exit: "tile", arrival: "tile" }),
    hasLivePage: () => true,
    select: () => undefined,
    close: () => undefined,
    editAddress: () => undefined,
    save: () => undefined,
    moveTabToGroup: () => undefined,
    sidebar: () => ({ x: -48, y: 0, w: 48, h: STAGE.h }),
    sidebarAway: () => false,
    homeOf: () => null,
  });
  desk.attachStage({ getBoundingClientRect: () => ({ left: 0, top: 0, width: STAGE.w, height: STAGE.h }) } as unknown as HTMLElement);
  desk.start([], "tab-0", ["tab-0", "tab-1"]);
  await settle();
  desk.add("tab-1", { focus: false });
  await settle();
  desk.activeChanged("tab-0");
  await settle();
  const els = new Map<string, ReturnType<typeof element>>();
  for (const tabId of desk.windowTabIds()) {
    const el = element();
    els.set(tabId, el);
    desk.attachWindow(tabId, el as unknown as HTMLElement);
  }
  desk.applyLayout(
    new Map([
      ["tab-1", OTHER],
      ["tab-0", ROOMY],
    ]),
  );
  await settle();
  const out = (tabId: string): number => Number(els.get(tabId)!.style["--drawer-t"]);
  const page = (tabId: string) => layouts.at(-1)?.views.find((view) => view.tabId === tabId)?.bounds;
  const held = (tabId: string) => desks.at(-1)?.zoomed?.find((zoomed) => zoomed.tabId === tabId);
  return { desk, els, cursor, drag, out, page, held };
}

describe("the Drawer frame", () => {
  it("brings a window's drawer out of it while it is in use, or the pointer is on it, without moving it", async () => {
    const { desk, els, out, page } = await open();
    // In use, with room above it: out, the window where it was.
    expect(out("tab-0")).toBe(1);
    expect(els.get("tab-0")!.dataset["drawerOut"]).toBe("");
    expect(els.get("tab-0")!.dataset["drawerRoom"]).toBe("roomy");
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(ROOMY.y, 0);
    expect(page("tab-0")).toEqual({ x: ROOMY.x, y: ROOMY.y, width: ROOMY.w, height: ROOMY.h });
    // Not in use: in, until the pointer comes onto it — the shell's word on its frame, or main's on its page.
    expect(out("tab-1")).toBe(0);
    expect(els.get("tab-1")!.dataset["drawerOut"]).toBeUndefined();
    desk.hoverWindow("tab-1", "window", true);
    await settle();
    expect(out("tab-1")).toBe(1);
    // Crossing from the frame onto the page is not leaving.
    desk.hoverWindow("tab-1", "window", false);
    desk.hoverPage("tab-1", true, false);
    await pass(300);
    expect(out("tab-1")).toBe(1);
    // Gone from it: back in, a moment after.
    desk.hoverPage("tab-1", false, false);
    await pass(60);
    expect(out("tab-1")).toBe(1);
    await pass(400);
    expect(out("tab-1")).toBe(0);
    expect(shownTop(els.get("tab-1")!)).toBeCloseTo(OTHER.y, 0);
    desk.destroy();
  });

  it("goes back in when the window in use is left for the desk's own surface, and comes out once the person is on it again", async () => {
    const { desk, els, out } = await open();
    const focused = (tabId: string): boolean | undefined => desk.getView().windows.find((window) => window.tabId === tabId)?.focused;
    const leave = async (): Promise<void> => {
      desk.pressDesk();
      await pass(400);
      expect(out("tab-0")).toBe(0);
      expect(focused("tab-0")).toBe(false);
    };
    expect(out("tab-0")).toBe(1);
    expect(focused("tab-0")).toBe(true);
    // A press between the windows: still the browser's tab in use, but left — its drawer in, and it looks out of use.
    await leave();
    expect(desk.focusedTabId()).toBe("tab-0");
    expect(els.get("tab-0")!.dataset["drawerOut"]).toBeUndefined();
    // A press on its live page (main's word): out again.
    desk.pagePressed();
    await settle();
    expect(out("tab-0")).toBe(1);
    expect(focused("tab-0")).toBe(true);
    // A press on its frame.
    await leave();
    desk.press("tab-0", { button: 0, clientX: ROOMY.x + 40, clientY: ROOMY.y - 10 }, "frame");
    await settle();
    expect(out("tab-0")).toBe(1);
    // Another window chosen, then this one again (its row in the sidebar).
    await leave();
    desk.activeChanged("tab-1");
    await settle();
    desk.activeChanged("tab-0");
    await settle();
    expect(out("tab-0")).toBe(1);
    expect(focused("tab-0")).toBe(true);
    // Left, the pointer on it still brings its drawer out, as any window's.
    await leave();
    desk.hoverWindow("tab-0", "window", true);
    await settle();
    expect(out("tab-0")).toBe(1);
    expect(focused("tab-0")).toBe(false);
    desk.destroy();
  });

  it("with no room above a window, comes out only for the pointer at its top, and pushes the window down, its page held at its own size", async () => {
    const { desk, els, out, page, held } = await open();
    desk.toggleMaximize("tab-0");
    await settle();
    // In use, but with no room: in, and the page is the whole desk.
    expect(out("tab-0")).toBe(0);
    expect(els.get("tab-0")!.dataset["drawerRoom"]).toBe("tight");
    expect(page("tab-0")).toEqual({ x: 0, y: 0, width: FILLED.w, height: FILLED.h });
    expect(held("tab-0")).toBeUndefined();
    // The pointer on its page, not at the top: nothing.
    desk.hoverPage("tab-0", true, false);
    await pass(300);
    expect(out("tab-0")).toBe(0);
    // At the top: out, the window pushed down by the whole drawer, its view cut at the desk's foot and its page held.
    desk.hoverPage("tab-0", true, true);
    await settle();
    expect(out("tab-0")).toBe(1);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(DRAWER_H, 0);
    expect(page("tab-0")).toEqual({ x: 0, y: DRAWER_H, width: FILLED.w, height: FILLED.h - DRAWER_H });
    expect(held("tab-0")).toEqual({ tabId: "tab-0", width: FILLED.w, height: FILLED.h, zoom: 1 });
    // The pointer now on the drawer (the page slid away under it): still out.
    desk.hoverPage("tab-0", false, false);
    desk.hoverWindow("tab-0", "strip", true);
    await pass(300);
    expect(out("tab-0")).toBe(1);
    // Down into the page: back in, the window back up, the page whole and let go a moment later.
    desk.hoverWindow("tab-0", "strip", false);
    desk.hoverPage("tab-0", true, false);
    await pass(500);
    expect(out("tab-0")).toBe(0);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(0, 0);
    expect(page("tab-0")).toEqual({ x: 0, y: 0, width: FILLED.w, height: FILLED.h });
    expect(held("tab-0")).toBeUndefined();
    desk.destroy();
  });

  it("taken by its top edge, the drawer's top, a window its drawer pushed down follows the pointer from there", async () => {
    const { desk, els, drag, out } = await open();
    const el = els.get("tab-0")!;
    desk.toggleMaximize("tab-0");
    await settle();
    desk.hoverPage("tab-0", true, true);
    await settle();
    expect(out("tab-0")).toBe(1);
    expect(shownTop(el)).toBeCloseTo(DRAWER_H, 0);
    // Its top edge is the drawer's, at the desk's top: pressed there and drawn 60px down, the drawer comes down with
    // the pointer from the first step, the page under it — not held still for the drawer's height as the push gave way.
    desk.resize("tab-0", TOP, { clientX: 400, clientY: 0, button: 0 });
    drag.sample?.({ x: 400, y: 10, phase: "move" });
    await frame();
    expect(shownTop(el)).toBeCloseTo(10 + DRAWER_H, 0);
    for (let step = 1; step <= 10; step += 1) {
      drag.sample?.({ x: 400, y: 6 * step, phase: "move" });
      await frame();
    }
    expect(shownTop(el)).toBeCloseTo(60 + DRAWER_H, 0);
    drag.sample?.({ x: 0, y: 0, phase: "cancel" });
    await settle();
    // Let go: the room above it is the drawer's now, nothing pushes it, and its foot is where it was.
    expect(shownBox(el)).toMatchObject({ y: 60 + DRAWER_H, h: FILLED.h - 60 - DRAWER_H });
    expect(out("tab-0")).toBe(1);
    desk.destroy();
  });

  it("pressed by its top edge and let go without moving, a window its drawer pushed down keeps its box", async () => {
    const { desk, els, drag } = await open();
    const el = els.get("tab-0")!;
    desk.toggleMaximize("tab-0");
    await settle();
    desk.hoverPage("tab-0", true, true);
    await settle();
    desk.resize("tab-0", TOP, { clientX: 400, clientY: 0, button: 0 });
    drag.sample?.({ x: 400, y: 0, phase: "move" });
    await frame();
    drag.sample?.({ x: 0, y: 0, phase: "cancel" });
    desk.hoverPage("tab-0", false, false);
    await pass(1_000);
    // Its drawer back in, it fills the desk again.
    expect(shownBox(el)).toMatchObject({ y: 0, h: FILLED.h });
    desk.destroy();
  });

  it("takes a top corner riding the drawer on the gutter it is beside, and moves the window across it with it", async () => {
    const { desk, els, drag, out } = await open();
    const left: Rect = { x: 100, y: 200, w: 600, h: 500 };
    const right: Rect = { x: left.x + left.w + DESK_GAP, y: 200, w: 600, h: 500 };
    desk.applyLayout(
      new Map([
        ["tab-1", right],
        ["tab-0", left],
      ]),
    );
    await settle();
    expect(out("tab-0")).toBe(1);
    // Its top-right corner is a drawer's height above the window, where its drawer's corner is: still on the gutter.
    const corner = { x: left.x + left.w + 2, y: left.y - DRAWER_H + 3 };
    desk.resize("tab-0", { left: false, right: true, top: true, bottom: false }, { clientX: corner.x, clientY: corner.y, button: 0 });
    for (let step = 1; step <= 10; step += 1) {
      drag.sample?.({ x: corner.x + 6 * step, y: corner.y, phase: "move" });
      await frame();
    }
    drag.sample?.({ x: 0, y: 0, phase: "cancel" });
    await settle();
    expect(shownBox(els.get("tab-0")!)).toMatchObject({ x: left.x, w: left.w + 60 });
    expect(shownBox(els.get("tab-1")!)).toMatchObject({ x: right.x + 60, w: right.w - 60 });
    desk.destroy();
  });

  it("asks main where the pointer is before a drawer that pushed its window down goes back in", async () => {
    const { desk, cursor, out } = await open();
    desk.toggleMaximize("tab-0");
    await settle();
    desk.hoverPage("tab-0", true, true);
    await settle();
    expect(out("tab-0")).toBe(1);
    // Main heard the pointer leave the page as it slid away; the shell has heard nothing on the drawer yet.
    desk.hoverPage("tab-0", false, false);
    // The OS pointer is on the drawer: it stays out, however long the pointer rests there.
    cursor.point = { x: 400, y: DRAWER_H / 2 };
    await pass(1_000);
    expect(out("tab-0")).toBe(1);
    // Off it, down the page: in.
    cursor.point = { x: 400, y: 400 };
    await pass(500);
    expect(out("tab-0")).toBe(0);
    desk.destroy();
  });

  it("keeps a window it pushes down live as it comes out and goes back in: the drawer covers the pages under it, never its own", async () => {
    // Pictures come back: a window its drawer covered would be drawn with one.
    vi.stubGlobal("Image", class {
      src = "";
      decode(): Promise<void> {
        return Promise.resolve();
      }
    });
    const { desk, page } = await open({ stills: true });
    desk.toggleMaximize("tab-0");
    await settle();
    const view = () => desk.getView().windows.find((window) => window.tabId === "tab-0")!;
    /** Frames until none is asked for, the pictures asked for landing between them: the page live at each. */
    const live = async (): Promise<void> => {
      for (let i = 0; i < 200 && frames.length > 0; i += 1) {
        await frame();
        await new Promise((done) => setImmediate(done));
        expect(view().drawn).toBe(false);
        expect(page("tab-0")).toBeDefined();
      }
    };
    desk.hoverPage("tab-0", true, true);
    await live();
    expect(page("tab-0")).toEqual({ x: 0, y: DRAWER_H, width: FILLED.w, height: FILLED.h - DRAWER_H });
    desk.hoverPage("tab-0", true, false);
    await live();
    expect(page("tab-0")).toEqual({ x: 0, y: 0, width: FILLED.w, height: FILLED.h });
    desk.destroy();
  });

  it("below another in a split, the window in use has no room: its drawer stays in, and comes out for the pointer at its top pushing it down, the window above live throughout", async () => {
    vi.stubGlobal("Image", class {
      src = "";
      decode(): Promise<void> {
        return Promise.resolve();
      }
    });
    const { desk, els, out, page, held } = await open({ stills: true });
    // One above the other, the gutter apart: the one in use below.
    const top: Rect = { x: 100, y: 0, w: 600, h: ROOMY.y - 8 };
    desk.applyLayout(
      new Map([
        ["tab-1", top],
        ["tab-0", ROOMY],
      ]),
    );
    const above = (): boolean => desk.getView().windows.find((window) => window.tabId === "tab-1")!.drawn;
    const flush = async (live = true): Promise<void> => {
      for (let i = 0; i < 200 && frames.length > 0; i += 1) {
        await frame();
        await new Promise((done) => setImmediate(done));
        // (The window above is never under the drawer of the one below.)
        if (live) expect(above()).toBe(false);
      }
      await pass(600);
    };
    // (Laid out from side by side, the one in use had its drawer out: it goes in as the other slides up above it.)
    await flush(false);
    expect(desk.focusedTabId()).toBe("tab-0");
    // In use: in — the window above is in the way of its drawer — and the window above live.
    expect(out("tab-0")).toBe(0);
    expect(els.get("tab-0")!.dataset["drawerRoom"]).toBe("tight");
    expect(above()).toBe(false);
    // The pointer on it, away from its top: nothing.
    desk.hoverWindow("tab-0", "window", true);
    await flush();
    expect(out("tab-0")).toBe(0);
    // At its top: out where the window's top was, the gap to the window above kept, and the window pushed down under it,
    // its page cut at its own foot and held at its own size; the window above where it was, live.
    desk.hoverWindow("tab-0", "window", false);
    desk.hoverPage("tab-0", true, true);
    await flush();
    expect(out("tab-0")).toBe(1);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(ROOMY.y + DRAWER_H, 0);
    expect(page("tab-0")).toEqual({ x: ROOMY.x, y: ROOMY.y + DRAWER_H, width: ROOMY.w, height: ROOMY.h - DRAWER_H });
    expect(held("tab-0")).toMatchObject({ width: ROOMY.w, height: ROOMY.h, zoom: 1 });
    expect(page("tab-1")).toEqual({ x: top.x, y: top.y, width: top.w, height: top.h });
    expect(above()).toBe(false);
    // Gone from it: in again, the window back up.
    desk.hoverPage("tab-0", false, false);
    await flush();
    expect(out("tab-0")).toBe(0);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(ROOMY.y, 0);
    expect(page("tab-0")).toEqual({ x: ROOMY.x, y: ROOMY.y, width: ROOMY.w, height: ROOMY.h });
    expect(above()).toBe(false);
    desk.destroy();
  });

  it("the window in use above another in a split: the pointer at the top of the one below pushes it down under its drawer, which lies nowhere over the one in use", async () => {
    vi.stubGlobal("Image", class {
      src = "";
      decode(): Promise<void> {
        return Promise.resolve();
      }
    });
    const { desk, els, out, page, held } = await open({ stills: true });
    // One above the other, the gutter apart: the one in use above, on top of the stack.
    const top: Rect = { x: 100, y: 0, w: 600, h: ROOMY.y - 8 };
    desk.applyLayout(
      new Map([
        ["tab-1", ROOMY],
        ["tab-0", top],
      ]),
    );
    const drawn = (tabId: string): boolean => desk.getView().windows.find((window) => window.tabId === tabId)!.drawn;
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 200 && frames.length > 0; i += 1) {
        await frame();
        await new Promise((done) => setImmediate(done));
        // (The one in use stays live: nothing of the other's drawer reaches it.)
        expect(drawn("tab-0")).toBe(false);
      }
      await pass(600);
    };
    await flush();
    expect(desk.focusedTabId()).toBe("tab-0");
    // The one in use, at the desk's top: no room, its drawer in. The one below, under the one in use: no room either.
    expect(out("tab-0")).toBe(0);
    expect(els.get("tab-0")!.dataset["drawerRoom"]).toBe("tight");
    expect(els.get("tab-1")!.dataset["drawerRoom"]).toBe("tight");
    expect(out("tab-1")).toBe(0);
    // The pointer on the one below, away from its top: nothing.
    desk.hoverWindow("tab-1", "window", true);
    await flush();
    expect(out("tab-1")).toBe(0);
    // At its top: its drawer out where its top was, the gap to the one in use kept, and the window pushed down under it
    // — never under the one in use, which stays where it was, live, its own drawer in.
    desk.hoverWindow("tab-1", "window", false);
    desk.hoverPage("tab-1", true, true);
    await flush();
    expect(out("tab-1")).toBe(1);
    expect(shownTop(els.get("tab-1")!)).toBeCloseTo(ROOMY.y + DRAWER_H, 0);
    expect(page("tab-1")).toEqual({ x: ROOMY.x, y: ROOMY.y + DRAWER_H, width: ROOMY.w, height: ROOMY.h - DRAWER_H });
    expect(held("tab-1")).toMatchObject({ width: ROOMY.w, height: ROOMY.h, zoom: 1 });
    expect(drawn("tab-0")).toBe(false);
    expect(page("tab-0")).toEqual({ x: top.x, y: top.y, width: top.w, height: top.h });
    expect(out("tab-0")).toBe(0);
    // Gone from it: in again, the window back up.
    desk.hoverPage("tab-1", false, false);
    await flush();
    expect(out("tab-1")).toBe(0);
    expect(shownTop(els.get("tab-1")!)).toBeCloseTo(ROOMY.y, 0);
    expect(page("tab-1")).toEqual({ x: ROOMY.x, y: ROOMY.y, width: ROOMY.w, height: ROOMY.h });
    desk.destroy();
  });

  it("pushing the window above in a split down, keeps it within its own box: the window below stays live", async () => {
    vi.stubGlobal("Image", class {
      src = "";
      decode(): Promise<void> {
        return Promise.resolve();
      }
    });
    const { desk, out, page } = await open({ stills: true });
    const top: Rect = { x: 100, y: 0, w: 600, h: 400 };
    const below: Rect = { x: 100, y: 408, w: 600, h: 400 };
    desk.applyLayout(
      new Map([
        ["tab-1", below],
        ["tab-0", top],
      ]),
    );
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 200 && frames.length > 0; i += 1) {
        await frame();
        await new Promise((done) => setImmediate(done));
      }
      await pass(600);
    };
    await flush();
    // The pointer at the top of the window above (no room over it): its drawer out, its page pushed down and cut at its foot.
    desk.hoverPage("tab-0", true, true);
    await flush();
    expect(out("tab-0")).toBe(1);
    expect(page("tab-0")).toEqual({ x: top.x, y: DRAWER_H, width: top.w, height: top.h - DRAWER_H });
    // A live share is told the same: its page only as far down as it is shown, so its picture takes in nothing below it.
    expect(desk.liveGeometry().windows.find((window) => window.id === "tab-0")!.page).toEqual({ x: top.x, y: DRAWER_H, w: top.w, h: top.h - DRAWER_H });
    // The window below it: live, never under the one above.
    expect(desk.getView().windows.find((window) => window.tabId === "tab-1")!.drawn).toBe(false);
    expect(page("tab-1")).toEqual({ x: below.x, y: below.y, width: below.w, height: below.h });
    desk.destroy();
  });

  it("held by its drawer, a window it pushed down keeps the drawer under the pointer as it is carried down the desk", async () => {
    const { desk, els, drag, out } = await open();
    desk.toggleMaximize("tab-0");
    await settle();
    desk.hoverPage("tab-0", true, true);
    await settle();
    expect(out("tab-0")).toBe(1);
    // Grabbed 17px down its drawer (at the desk's top, the window pushed down under it), and carried down the desk.
    desk.grab("tab-0", { x: 800, y: 17 });
    for (let step = 1; step <= 20; step += 1) {
      drag.sample?.({ x: 800, y: 17 + step * 20, phase: "move" });
      await frame();
    }
    await pass(400);
    expect(out("tab-0")).toBe(1);
    // The pointer is where it took hold: 17px down the drawer, which is a drawer's height above the window.
    expect(shownTop(els.get("tab-0")!) - DRAWER_H + 17).toBeCloseTo(417, 0);
    drag.sample?.({ x: 0, y: 0, phase: "cancel" });
    desk.destroy();
  });

  it("carried up by its drawer from under another window, keeps the drawer under the pointer over that window; let go there, nothing jumps, and the window above bounds it again once it is in", async () => {
    vi.stubGlobal("Image", class {
      src = "";
      decode(): Promise<void> {
        return Promise.resolve();
      }
    });
    const { desk, els, drag, out, page } = await open({ stills: true });
    const top: Rect = { x: 100, y: 0, w: 600, h: ROOMY.y - 8 };
    desk.applyLayout(
      new Map([
        ["tab-1", top],
        ["tab-0", ROOMY],
      ]),
    );
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 200 && frames.length > 0; i += 1) {
        await frame();
        await new Promise((done) => setImmediate(done));
      }
      await pass(600);
    };
    await flush();
    // The pointer at its top: out, the window pushed down under it.
    desk.hoverPage("tab-0", true, true);
    await flush();
    expect(out("tab-0")).toBe(1);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(ROOMY.y + DRAWER_H, 0);
    // Taken 17px down its drawer and carried up: the drawer stays under the pointer, over the foot of the window above.
    const grabbed = ROOMY.y + 17;
    desk.grab("tab-0", { x: 400, y: grabbed });
    for (let y = grabbed; y >= 202; y -= 3) {
      drag.sample?.({ x: 400, y, phase: "move" });
      await frame();
      expect(shownTop(els.get("tab-0")!) - DRAWER_H + 17).toBeCloseTo(y, 0);
    }
    // On up to the magnet's reach of its place under the window above (the gap apart): the window sticks there, shown
    // where its box is, its drawer out over the other's foot; held still a moment, then let go.
    for (let i = 0; i < 6; i += 1) {
      drag.sample?.({ x: 400, y: 190, phase: "move" });
      await frame();
    }
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(ROOMY.y, 0);
    drag.sample?.({ x: 400, y: 190, phase: "up" });
    await pass(100);
    expect(out("tab-0")).toBe(1);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(ROOMY.y, 0);
    // The pointer resting on the drawer (the shell hears it as it moves): still out, the window where it was let go.
    desk.hoverWindow("tab-0", "strip", true);
    await flush();
    expect(out("tab-0")).toBe(1);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(ROOMY.y, 0);
    // Off it: in, the window where it is.
    desk.hoverWindow("tab-0", "strip", false);
    desk.hoverPage("tab-0", false, false);
    await flush();
    expect(out("tab-0")).toBe(0);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(ROOMY.y, 0);
    // From here the window above bounds its drawer as before: the pointer at its top pushes the window down under it.
    desk.hoverPage("tab-0", true, true);
    await flush();
    expect(out("tab-0")).toBe(1);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(ROOMY.y + DRAWER_H, 0);
    expect(page("tab-0")).toEqual({ x: ROOMY.x, y: ROOMY.y + DRAWER_H, width: ROOMY.w, height: ROOMY.h - DRAWER_H });
    desk.destroy();
  });

  it("taken by its drawer and let go without moving, a window stays where it was, at the desk's top or under another window", async () => {
    vi.stubGlobal("Image", class {
      src = "";
      decode(): Promise<void> {
        return Promise.resolve();
      }
    });
    const { desk, els, drag, out, page } = await open({ stills: true });
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 200 && frames.length > 0; i += 1) {
        await frame();
        await new Promise((done) => setImmediate(done));
      }
      await pass(600);
    };
    // Under the window above, the gap apart.
    const top: Rect = { x: 100, y: 0, w: 600, h: ROOMY.y - 8 };
    desk.applyLayout(
      new Map([
        ["tab-1", top],
        ["tab-0", ROOMY],
      ]),
    );
    await flush();
    desk.hoverPage("tab-0", true, true);
    await flush();
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(ROOMY.y + DRAWER_H, 0);
    desk.grab("tab-0", { x: 400, y: ROOMY.y + 17 });
    await pass(100);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(ROOMY.y + DRAWER_H, 0);
    drag.sample?.({ x: 400, y: ROOMY.y + 17, phase: "up" });
    await pass(100);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(ROOMY.y + DRAWER_H, 0);
    // Off it: in, and the window back up where it was, its page whole.
    desk.hoverPage("tab-0", false, false);
    await flush();
    expect(out("tab-0")).toBe(0);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(ROOMY.y, 0);
    expect(page("tab-0")).toEqual({ x: ROOMY.x, y: ROOMY.y, width: ROOMY.w, height: ROOMY.h });
    // Filling the desk, at its top.
    desk.toggleMaximize("tab-0");
    await flush();
    desk.hoverPage("tab-0", true, true);
    await flush();
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(DRAWER_H, 0);
    desk.grab("tab-0", { x: 800, y: 17 });
    await pass(100);
    drag.sample?.({ x: 800, y: 17, phase: "up" });
    await pass(100);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(DRAWER_H, 0);
    desk.hoverPage("tab-0", false, false);
    await flush();
    expect(out("tab-0")).toBe(0);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(0, 0);
    expect(page("tab-0")).toEqual({ x: 0, y: 0, width: FILLED.w, height: FILLED.h });
    desk.destroy();
  });

  it("a window lying over this one's top bounds its drawer the same way over it in the stack or under: a press on the drawer, which brings the window to the top, moves nothing", async () => {
    vi.stubGlobal("Image", class {
      src = "";
      decode(): Promise<void> {
        return Promise.resolve();
      }
    });
    const { desk, els, out } = await open({ stills: true });
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 200 && frames.length > 0; i += 1) {
        await frame();
        await new Promise((done) => setImmediate(done));
      }
      await pass(600);
    };
    // The window in use lies over the top of the other, which is under it in the stack.
    const over: Rect = { x: 100, y: 0, w: 600, h: ROOMY.y + 50 };
    desk.applyLayout(
      new Map([
        ["tab-0", ROOMY],
        ["tab-1", over],
      ]),
    );
    desk.activeChanged("tab-1");
    await flush();
    expect(desk.focusedTabId()).toBe("tab-1");
    // The pointer on the other's strip: its drawer out above it, where it lies — under the window over it, as the window does.
    desk.hoverWindow("tab-0", "strip", true);
    await flush();
    expect(out("tab-0")).toBe(1);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(ROOMY.y, 0);
    // A press on its drawer: the window comes to the top, and nothing moves.
    desk.press("tab-0", { button: 0, clientX: 400, clientY: ROOMY.y - 10 }, "frame");
    await pass(100);
    expect(out("tab-0")).toBe(1);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(ROOMY.y, 0);
    desk.destroy();
  });

  it("let go with room above it, the window in use keeps its drawer out, as any window in use with room does", async () => {
    vi.stubGlobal("Image", class {
      src = "";
      decode(): Promise<void> {
        return Promise.resolve();
      }
    });
    const { desk, els, drag, out } = await open({ stills: true });
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 200 && frames.length > 0; i += 1) {
        await frame();
        await new Promise((done) => setImmediate(done));
      }
      await pass(600);
    };
    const top: Rect = { x: 100, y: 0, w: 600, h: ROOMY.y - 8 };
    desk.applyLayout(
      new Map([
        ["tab-1", top],
        ["tab-0", ROOMY],
      ]),
    );
    await flush();
    desk.hoverPage("tab-0", true, true);
    await flush();
    expect(out("tab-0")).toBe(1);
    // Carried down the desk by its drawer, well clear of the window above (and short of the desk's foot), and let go.
    desk.grab("tab-0", { x: 400, y: ROOMY.y + 17 });
    for (let y = ROOMY.y + 17; y <= 450; y += 20) {
      drag.sample?.({ x: 400, y, phase: "move" });
      await frame();
    }
    for (let i = 0; i < 6; i += 1) {
      drag.sample?.({ x: 400, y: 450, phase: "move" });
      await frame();
    }
    drag.sample?.({ x: 400, y: 450, phase: "up" });
    await pass(100);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(467, 0);
    // The pointer off it: in use, with room above it, its drawer stays out — never in, nor in and out again.
    desk.hoverPage("tab-0", false, false);
    for (let i = 0; i < 100; i += 1) {
      await frame();
      await new Promise((done) => setImmediate(done));
      expect(out("tab-0")).toBe(1);
    }
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(467, 0);
    desk.destroy();
  });

  it("clips a window to the desk's rounded corners where it reaches them, so one filling the desk fills it to the curve", async () => {
    // The desk's corner radius, as the stage is laid out (`.desk-stage`'s --desk-window-radius).
    vi.stubGlobal("getComputedStyle", () => ({ borderTopLeftRadius: "8px" }));
    const { desk, els } = await open();
    // Away from the corners, only where its shadow's reach meets one: down to the desk's foot, out to its leading edge.
    expect(els.get("tab-0")!.style["clipPath"]).toBe("inset(-120.0px -120.0px -300.0px -100.0px round 0.0px 0.0px 0.0px 8.0px)");
    desk.toggleMaximize("tab-0");
    await settle();
    expect(els.get("tab-0")!.style["clipPath"]).toBe("inset(0.0px 0.0px 0.0px 0.0px round 8.0px 8.0px 8.0px 8.0px)");
    desk.destroy();
  });

  it("with some room above a window, comes out as far as it can and pushes the window's page down the rest, within the window's own box", async () => {
    const { desk, els, out, page, held } = await open();
    const near: Rect = { ...ROOMY, y: 10 };
    desk.applyLayout(
      new Map([
        ["tab-1", OTHER],
        ["tab-0", near],
      ]),
    );
    await settle();
    expect(out("tab-0")).toBe(0);
    desk.hoverWindow("tab-0", "strip", true);
    await settle();
    expect(out("tab-0")).toBe(1);
    expect(shownTop(els.get("tab-0")!)).toBeCloseTo(DRAWER_H, 0);
    // Its page moved down the rest, cut at the window's own foot (it reaches over nothing below it), and held at its own size.
    const push = DRAWER_H - near.y;
    expect(page("tab-0")).toEqual({ x: near.x, y: DRAWER_H, width: near.w, height: near.h - push });
    expect(held("tab-0")).toMatchObject({ width: near.w, height: near.h, zoom: 1 });
    desk.destroy();
  });
});
