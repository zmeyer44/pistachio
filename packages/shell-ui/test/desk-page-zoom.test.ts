/**
 * Page zoom (the desk's Feel, Fit): a page in a window that takes less of
 * the desk is shown zoomed out, the further the less of it — 75% at half
 * the desk, 50% at a quarter, 100% filling it — and its page is never laid
 * out wider than the desk. Main hears each page's box and zoom
 * (DeskZoomedPage); a window growing into a larger box is held at that box
 * at the zoom it asks there, from the start; a window masked while zoomed
 * keeps what was chosen at the scale it was chosen at. Actual size: every
 * page at 100%. Since 2026-10-11 the Feel sets how strongly (Off, Slight,
 * Medium — Fit's id — Strong, Strongest), on a slider the desk follows.
 *
 * The engine runs a frame at a time outside React; here the frames are
 * driven by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESK_MINI_ZOOM, type DeskState, type DeskZoomedPage } from "@pistachio/shell-contracts/desk";
import { NATIVE_SURFACE_MEMBERS, type BrowserLayout } from "@pistachio/shell-contracts/ipc";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { DeskEngine, MASK_INSETS, WINDOW_INSETS, type DeskHost } from "../src/components/desk/desk-engine";
import { DESK_GAP, pageZoom, zoneRect, type Rect } from "../src/lib/desk/geometry";
import { DEFAULT_DESK_VARIANTS, DESK_AXES, PAGE_ZOOM_STRENGTH, sanitizeVariants, type DeskPageZoom } from "../src/lib/desk/store";

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

function run(count: number): void {
  for (let i = 0; i < count; i += 1) {
    const due = frames;
    frames = [];
    clock += 16;
    for (const frame of due) frame(clock);
  }
}

/** Whatever pictures were asked for, landed, and the frames they ask for run. */
async function flush(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    settle();
  }
}

const DESK: Rect = { x: 0, y: 0, w: 1600, h: 1000 };
/** Where a window's page sits in it: the whole of it. */
const insets = WINDOW_INSETS;
const pageOf = (rect: Rect) => ({ width: Math.round(rect.w - insets.left - insets.right), height: Math.round(rect.h - insets.top - insets.bottom) });

function native() {
  const layouts: BrowserLayout[] = [];
  const desks: Array<DeskState | null> = [];
  const members = Object.fromEntries(Object.keys(NATIVE_SURFACE_MEMBERS).map((member) => [member, vi.fn()]));
  setShellApi({
    ...members,
    // Main cannot say where the pointer is (as under Playwright), and says so at once: a drawer that pushed its window
    // down (no room above it) goes back in as soon as nothing holds it out, within these synchronous frames.
    getCursorPoint: () => {
      throw new Error("no pointer");
    },
    setLayout: (layout: BrowserLayout) => layouts.push(layout),
    setDesk: (state: DeskState | null) => desks.push(state),
    captureTabStills: (ids: readonly string[]) => Promise.resolve(ids.map((tabId) => ({ tabId, dataUrl: `data:image/jpeg;base64,${tabId}` }))),
    focusTab: () => Promise.resolve(),
    onDragSample: () => () => undefined,
  } as unknown as ShellApiBridge);
  return { layouts, desks };
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

/** Three windows out over a 1600×1000 stage (tab-0 in use), their pages live, at the Page zoom given. */
function open(zoom: DeskPageZoom = "fit", host: Partial<DeskHost> = {}) {
  const api = native();
  const desk = new DeskEngine({
    variants: () => ({ ...DEFAULT_DESK_VARIANTS, zoom }),
    hasLivePage: () => true,
    select: () => undefined,
    close: () => undefined,
    editAddress: () => undefined,
    save: () => undefined,
    moveTabToGroup: () => undefined,
    sidebar: () => ({ x: -48, y: 0, w: 48, h: 1000 }),
    sidebarAway: () => false,
    homeOf: () => null,
    ...host,
  });
  desk.attachStage({ getBoundingClientRect: () => ({ left: 0, top: 0, width: DESK.w, height: DESK.h }) } as unknown as HTMLElement);
  const els = new Map<string, ReturnType<typeof element>>();
  desk.start([], "tab-0", ["tab-0", "tab-1", "tab-2"]);
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
  /** What main was last told of a tab's page (null: nothing, it lays out at its view's size). */
  const told = (tabId: string): DeskZoomedPage | null => api.desks.at(-1)?.zoomed?.find((page) => page.tabId === tabId) ?? null;
  const rect = (tabId: string): Rect => rectOf(els.get(tabId)!);
  const view = (tabId: string) => desk.getView().windows.find((window) => window.tabId === tabId)!;
  return { ...api, desk, told, rect, view };
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
  vi.stubGlobal("requestAnimationFrame", (frame: (now: number) => void) => {
    frames.push(frame);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setShellApi({} as unknown as ShellApiBridge);
});

describe("the zoom a window's share of the desk asks (pageZoom)", () => {
  it("is 100% filling the desk, 75% at half of it, 50% at a quarter — a quarter tile or a column a quarter wide — and no further out", () => {
    expect(pageZoom(DESK, DESK)).toBe(1);
    expect(pageZoom(zoneRect("left", DESK), DESK)).toBe(0.75);
    expect(pageZoom(zoneRect("top-left", DESK), DESK)).toBe(0.5);
    expect(pageZoom({ w: (DESK.w - 3 * DESK_GAP) / 4, h: DESK.h }, DESK)).toBe(0.5);
    // Thirds: a third at 60%, two at 85%.
    const third = (DESK.w - 2 * DESK_GAP) / 3;
    expect(pageZoom({ w: third, h: DESK.h }, DESK)).toBe(0.6);
    expect(pageZoom({ w: third * 2 + DESK_GAP, h: DESK.h }, DESK)).toBe(0.85);
    expect(pageZoom({ w: 300, h: 200 }, DESK)).toBe(0.5);
  });

  it("never lays a page out wider than the desk: a window its whole width stays at 100%, a wide short one only as far out as that", () => {
    // A top half.
    expect(pageZoom({ w: DESK.w, h: (DESK.h - DESK_GAP) / 2 }, DESK)).toBe(1);
    // 1200 wide (with its gap, 3/4 of the desk) and 300 tall: its share of the area asks for 47%, its width allows no less than 75%.
    expect(pageZoom({ w: 1200, h: 300 }, DESK)).toBe(0.75);
  });

  it("at each of the Feel's strengths: Off always 100%, Slight 88% at half the desk and 75% at a quarter, Strong 63%, Strongest 50% — the floors kept", () => {
    const half = zoneRect("left", DESK);
    const quarter = zoneRect("top-left", DESK);
    const at = (zoom: DeskPageZoom, size: { w: number; h: number }) => pageZoom(size, DESK, PAGE_ZOOM_STRENGTH[zoom]);
    expect([at("actual", half), at("actual", quarter), at("actual", { w: 300, h: 200 })]).toEqual([1, 1, 1]);
    expect([at("slight", half), at("slight", quarter)]).toEqual([0.88, 0.75]);
    expect([at("fit", half), at("fit", quarter)]).toEqual([0.75, 0.5]);
    expect([at("strong", half), at("strong", quarter)]).toEqual([0.63, 0.5]);
    expect([at("strongest", half), at("strongest", quarter)]).toEqual([0.5, 0.5]);
    for (const zoom of ["slight", "strong", "strongest"] as const) {
      // Filling the desk, or its whole width: 100%, whatever the strength; and never past the least.
      expect(at(zoom, DESK)).toBe(1);
      expect(at(zoom, { w: DESK.w, h: (DESK.h - DESK_GAP) / 2 })).toBe(1);
      expect(at(zoom, { w: 300, h: 200 })).toBe(0.5);
    }
  });

  it("is never further in at a stronger strength", () => {
    const strengths = DESK_AXES.find((axis) => axis.key === "zoom")!.options.map((option) => PAGE_ZOOM_STRENGTH[option.id]);
    expect(strengths).toEqual([...strengths].sort((a, b) => a - b));
    for (const size of [zoneRect("left", DESK), { w: 900, h: 800 }, { w: 1300, h: 600 }, { w: 500, h: 1000 }]) {
      const zooms = strengths.map((strength) => pageZoom(size, DESK, strength));
      expect(zooms).toEqual([...zooms].sort((a, b) => b - a));
    }
  });

  it("goes smoothly: a wider or taller window is never further out", () => {
    let last = 0;
    for (let w = 300; w <= DESK.w; w += 25) {
      const zoom = pageZoom({ w, h: 700 }, DESK);
      expect(zoom).toBeGreaterThanOrEqual(last);
      last = zoom;
    }
    last = 0;
    for (let h = 200; h <= DESK.h; h += 25) {
      const zoom = pageZoom({ w: 700, h }, DESK);
      expect(zoom).toBeGreaterThanOrEqual(last);
      last = zoom;
    }
  });
});

describe("Page zoom, Fit", () => {
  it("tells main each page's box and the zoom its window's share of the desk asks; a window filling the desk, nothing", () => {
    const { desk, told } = open();
    const left = zoneRect("left", DESK);
    const topRight = zoneRect("top-right", DESK);
    const bottomRight = zoneRect("bottom-right", DESK);
    desk.applyLayout(
      new Map([
        ["tab-0", left],
        ["tab-1", topRight],
        ["tab-2", bottomRight],
      ]),
    );
    settle();
    expect(told("tab-0")).toEqual({ tabId: "tab-0", ...pageOf(left), zoom: 0.75 });
    expect(told("tab-1")).toEqual({ tabId: "tab-1", ...pageOf(topRight), zoom: 0.5 });
    expect(told("tab-2")).toEqual({ tabId: "tab-2", ...pageOf(bottomRight), zoom: 0.5 });
    expect(desk.pageZoom("tab-0")).toBe(0.75);
    expect(desk.pageZoom("tab-1")).toBe(0.5);
    // Filling the desk: back at 100%, laid out at its view's own size.
    desk.toggleMaximize("tab-0");
    settle();
    expect(told("tab-0")).toBeNull();
    expect(desk.pageZoom("tab-0")).toBe(1);
    desk.destroy();
  });

  it("grown into a larger box, is held at that box at the zoom it asks there from the first frame, and stays so once there", () => {
    const { desk, desks, told, rect } = open();
    const quarter = zoneRect("top-left", DESK);
    const left = zoneRect("left", DESK);
    desk.applyLayout(new Map([["tab-0", quarter]]));
    settle();
    expect(told("tab-0")).toMatchObject({ zoom: 0.5 });
    desk.applyLayout(new Map([["tab-0", left]]));
    run(1);
    const held = { tabId: "tab-0", ...pageOf(left), zoom: 0.75 };
    expect(told("tab-0")).toEqual(held);
    // On its way, never told of a box or a zoom between.
    const sent = desks.length;
    settle();
    expectRect(rect("tab-0"), left, 0.5);
    expect(told("tab-0")).toEqual(held);
    expect(desks.slice(sent).every((state) => state?.zoomed?.find((page) => page.tabId === "tab-0")?.zoom === 0.75)).toBe(true);
    desk.destroy();
  });

  it("minimized, is at the minimized zoom whatever its size; expanded, at its box's again", () => {
    const { desk, told } = open();
    const left = zoneRect("left", DESK);
    desk.applyLayout(new Map([["tab-0", left]]));
    settle();
    desk.minimize("tab-0");
    settle();
    expect(told("tab-0")).toMatchObject({ zoom: DESK_MINI_ZOOM });
    expect(desk.pageZoom("tab-0")).toBe(DESK_MINI_ZOOM);
    desk.expand("tab-0");
    settle();
    expect(told("tab-0")).toEqual({ tabId: "tab-0", ...pageOf(left), zoom: 0.75 });
    desk.destroy();
  });

  it("masked, keeps what was chosen at the scale it was chosen at: the mask in the page's own px, its region shown at that zoom, no zoom of main's", async () => {
    const { desk, desks, told, rect, view } = open();
    const left = zoneRect("left", DESK);
    desk.applyLayout(new Map([["tab-0", left]]));
    settle();
    await flush();
    desk.startMask("tab-0");
    await flush();
    const region = { x: 75, y: 30, w: 300, h: 150 };
    desk.applyMask("tab-0", region);
    await flush();
    const page = pageOf(left);
    expect(view("tab-0").mask).toEqual({ x: 100, y: 40, width: 400, height: 200, pageWidth: Math.round(page.width / 0.75), pageHeight: Math.round(page.height / 0.75) });
    // Where the region was, at the size it was seen at.
    expectRect(rect("tab-0"), {
      x: left.x + insets.left + region.x - MASK_INSETS.left,
      y: left.y + insets.top + region.y - MASK_INSETS.top,
      w: region.w + MASK_INSETS.left + MASK_INSETS.right,
      h: region.h + MASK_INSETS.top + MASK_INSETS.bottom,
    });
    expect(desks.at(-1)?.masks).toEqual([{ tabId: "tab-0", mask: view("tab-0").mask, width: 300, height: 150 }]);
    expect(told("tab-0")).toBeNull();
    expect(desk.pageZoom("tab-0")).toBeNull();
    desk.destroy();
  });
});

describe("Page zoom's strength, changed on the Feel's slider", () => {
  it("tells main each page's zoom at the new strength as the desk refreshes, and nothing once it is Off", () => {
    let zoom: DeskPageZoom = "fit";
    const { desk, told } = open("fit", { variants: () => ({ ...DEFAULT_DESK_VARIANTS, zoom }) });
    const left = zoneRect("left", DESK);
    desk.applyLayout(
      new Map([
        ["tab-0", left],
        ["tab-1", zoneRect("top-right", DESK)],
      ]),
    );
    settle();
    expect(told("tab-0")).toEqual({ tabId: "tab-0", ...pageOf(left), zoom: 0.75 });
    for (const [strength, expected] of [
      ["slight", 0.88],
      ["strong", 0.63],
      ["strongest", 0.5],
    ] as const) {
      zoom = strength;
      desk.refresh();
      settle();
      expect(told("tab-0")).toEqual({ tabId: "tab-0", ...pageOf(left), zoom: expected });
      expect(desk.pageZoom("tab-0")).toBe(expected);
    }
    zoom = "actual";
    desk.refresh();
    settle();
    expect(told("tab-0")).toBeNull();
    expect(told("tab-1")).toBeNull();
    expect(desk.pageZoom("tab-0")).toBe(1);
    desk.destroy();
  });
});

describe("Page zoom, Actual size", () => {
  it("leaves every page at its own size, whatever its window's share of the desk", () => {
    const { desk, told } = open("actual");
    desk.applyLayout(
      new Map([
        ["tab-0", zoneRect("left", DESK)],
        ["tab-1", zoneRect("top-right", DESK)],
      ]),
    );
    settle();
    expect(told("tab-0")).toBeNull();
    expect(told("tab-1")).toBeNull();
    expect(desk.pageZoom("tab-0")).toBe(1);
    desk.destroy();
  });

  it("is what was stored as Actual size, as Fit is Medium: a choice from before the strengths still reads, and each strength is kept", () => {
    expect(sanitizeVariants({ zoom: "actual" }).zoom).toBe("actual");
    expect(sanitizeVariants({ zoom: "fit" }).zoom).toBe("fit");
    for (const zoom of ["slight", "strong", "strongest"]) expect(sanitizeVariants({ zoom }).zoom).toBe(zoom);
    expect(sanitizeVariants({ zoom: "heavy" }).zoom).toBe(DEFAULT_DESK_VARIANTS.zoom);
  });
});
