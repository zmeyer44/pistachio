/**
 * The Drawer frame (docs/desk.md): a window is its page alone, its title
 * and controls on a strip behind its top edge. With room for the strip
 * above the window, it slides up out of the window whenever the pointer is
 * on the window or the window is in use; with less, it comes out only for
 * the pointer at the window's top, and pushes the window down for the rest
 * — its page cut short at the desk's foot and held at its own size, so it
 * never lays out anew. Before such a drawer goes back in, main is asked
 * where the pointer really is: the window slid its page out from under it.
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
import type { Rect } from "../src/lib/desk/geometry";
import { DEFAULT_DESK_VARIANTS, type DeskChrome } from "../src/lib/desk/store";

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
 * Two windows out side by side with room above them (tab-0 in use), in the Drawer frame, their elements attached; the
 * OS pointer where `cursor` says (null: main cannot say). With `stills`, every picture asked for comes back; `chrome`
 * says the frame, the Drawer unless it says otherwise.
 */
async function open(options: { stills?: boolean; chrome?: () => DeskChrome } = {}) {
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
    variants: () => ({ ...DEFAULT_DESK_VARIANTS, chrome: options.chrome?.() ?? "drawer" }),
    hasLivePage: () => true,
    select: () => undefined,
    close: () => undefined,
    editAddress: () => undefined,
    save: () => undefined,
    moveTabToGroup: () => undefined,
    sidebar: () => ({ x: -48, y: 0, w: 48, h: STAGE.h }),
    homeOf: () => null,
    leaveDone: () => undefined,
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

  it("comes out over a window under it only as that window gives way to its still", async () => {
    vi.stubGlobal("Image", class {
      src = "";
      decode(): Promise<void> {
        return Promise.resolve();
      }
    });
    // The window not in use just above the one in use, laid out in another frame: no drawer yet, its page live.
    let chrome: DeskChrome = "bare";
    const { desk, out } = await open({ stills: true, chrome: () => chrome });
    desk.applyLayout(
      new Map([
        ["tab-1", { x: 100, y: 0, w: 600, h: 180 }],
        ["tab-0", ROOMY],
      ]),
    );
    await settle();
    expect(desk.getView().windows.find((window) => window.tabId === "tab-1")!.drawn).toBe(false);
    // The Drawer frame: the drawer of the one in use comes out, over the other's foot.
    chrome = "drawer";
    desk.hoverWindow("tab-0", "window", true);
    for (let i = 0; i < 200 && frames.length > 0; i += 1) {
      await frame();
      await new Promise((done) => setImmediate(done));
      // Never out over its live page.
      const under = desk.getView().windows.find((window) => window.tabId === "tab-1")!;
      if (out("tab-0") > 0) expect(under.drawn).toBe(true);
    }
    expect(out("tab-0")).toBe(1);
    desk.destroy();
  });

  it("stays in while the window is merely in use, where it would lie over the window above it: that window stays live", async () => {
    vi.stubGlobal("Image", class {
      src = "";
      decode(): Promise<void> {
        return Promise.resolve();
      }
    });
    const { desk, out } = await open({ stills: true });
    // One above the other, the gutter apart: the one in use below.
    desk.applyLayout(
      new Map([
        ["tab-1", { x: 100, y: 0, w: 600, h: ROOMY.y - 8 }],
        ["tab-0", ROOMY],
      ]),
    );
    const above = (): boolean => desk.getView().windows.find((window) => window.tabId === "tab-1")!.drawn;
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 200 && frames.length > 0; i += 1) {
        await frame();
        await new Promise((done) => setImmediate(done));
      }
      await pass(600);
    };
    await flush();
    expect(desk.focusedTabId()).toBe("tab-0");
    // In use: in, and the window above it live.
    expect(out("tab-0")).toBe(0);
    expect(above()).toBe(false);
    // The pointer on it: out, over the other's foot (which gives way to its still meanwhile).
    desk.hoverWindow("tab-0", "window", true);
    await flush();
    expect(out("tab-0")).toBe(1);
    expect(above()).toBe(true);
    // Gone from it: in again, and the window above live again.
    desk.hoverWindow("tab-0", "window", false);
    await flush();
    expect(out("tab-0")).toBe(0);
    expect(above()).toBe(false);
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
