/**
 * The shell's report of a shared space's desk (docs/live-share.md §6.4,
 * src/lib/live/desk-report.ts and the engine's liveGeometry/savedGeometry):
 * the windows in the stage's own coordinates — each page exactly the view
 * main is told to place, less the stage's corner in the window — their kinds,
 * the space not in front laid out from its saved fractions on the stage as
 * it is, and the pacing: at most every 33 ms while the desk moves, the
 * latest always — from the render that drew it once it is due — once more
 * settled, a saved arrangement at once, each numbered, and the last
 * report's mark painted stale in the very render that draws a window
 * elsewhere while its own report waits (a window the last report called
 * steady sends one at once instead) — and what of the shell's lies over
 * which window (§6.6): the covers whose box is known over the windows they
 * lie over (and over where the report sent last put them), any other over
 * all of them, a tooltip in its band or off the stage over none, a window
 * drawn grown or turned over itself; known in the render that put it there,
 * and sent at once. The page a report gives is the whole pixels inside it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeskState } from "@pistachio/shell-contracts/desk";
import { NATIVE_SURFACE_MEMBERS, type BrowserLayout } from "@pistachio/shell-contracts/ipc";
import { MAX_LIVE_DESK_COVERS, type LiveDeskReport } from "@pistachio/shell-contracts/live-share";
import { setShellApi, type ShellApiBridge } from "../src/api";
import type { DragSample } from "@pistachio/shell-contracts/chrome";
import { DeskEngine, FLOAT_COVER, MASK_INSETS, windowTipCover, type DeskLiveWindow } from "../src/components/desk/desk-engine";
import { denormalizeRect, normalizeRect, type Rect } from "../src/lib/desk/geometry";
import { DEFAULT_DESK_VARIANTS, type DeskMotion } from "../src/lib/desk/store";
import {
  coverBox,
  coverReach,
  coversMore,
  deskReport,
  layersCover,
  layersOverStage,
  LIVE_COVER_PAD,
  LIVE_DESK_DUE_SLACK_MS,
  LIVE_DESK_DUE_STAGGER_MS,
  LIVE_DESK_FLUSH_GRACE_MS,
  LIVE_DESK_REPORT_MS,
  LIVE_DESK_SETTLE_MS,
  LiveDeskPacer,
  movesSteady,
  pagesMoved,
  reportKey,
  steadyPages,
  tooltipBands,
  urgent,
  type DeskReportInputs,
  type LiveDeskDraft,
  type PacerClock,
  type ShellLayers,
} from "../src/lib/live/desk-report";

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

/** A few frames (a gesture keeps asking for them, so settle() would run its course). */
function run(count: number): void {
  for (let i = 0; i < count; i += 1) {
    const due = frames;
    frames = [];
    clock += 16;
    for (const frame of due) frame(clock);
  }
}

function native() {
  const layouts: BrowserLayout[] = [];
  // The drag layer's channel, which a gesture listens on for the pointer.
  const drag: { sample: ((sample: DragSample) => void) | null } = { sample: null };
  const members = Object.fromEntries(Object.keys(NATIVE_SURFACE_MEMBERS).map((member) => [member, vi.fn()]));
  setShellApi({
    ...members,
    getCursorPoint: () => {
      throw new Error("no pointer");
    },
    setLayout: (layout: BrowserLayout) => layouts.push(layout),
    setDesk: (_state: DeskState | null) => undefined,
    captureTabStills: () => Promise.resolve([]),
    focusTab: () => Promise.resolve(),
    onDragSample: (listener: (sample: DragSample) => void) => {
      drag.sample = listener;
      return () => {
        if (drag.sample === listener) drag.sample = null;
      };
    },
  } as unknown as ShellApiBridge);
  return { layouts, drag };
}

/** The stage where it lies in the window: past a 300px sidebar, under a 40px strip. */
const STAGE = { left: 300, top: 40, width: 1200, height: 800 };
const DESK: Rect = { x: 0, y: 0, w: STAGE.width, h: STAGE.height };

/** A desk whose windows are all live pages (main places a view for each) — or, `drawn`, all drawn by the shell — over STAGE. */
function engine(options: { drawn?: boolean; motion?: DeskMotion } = {}): DeskEngine {
  const created = new DeskEngine({
    variants: () => ({ ...DEFAULT_DESK_VARIANTS, zoom: "actual", ...(options.motion === undefined ? {} : { motion: options.motion }) }),
    spaceSwitch: () => ({ exit: "tile", arrival: "tile" }),
    hasLivePage: (tabId) => options.drawn !== true && tabId.startsWith("tab-"),
    select: () => undefined,
    close: () => undefined,
    editAddress: () => undefined,
    save: () => undefined,
    moveTabToGroup: () => undefined,
    sidebar: () => ({ x: 0, y: 40, w: 300, h: 800 }),
    sidebarAway: () => false,
    homeOf: () => null,
  });
  created.attachStage({ getBoundingClientRect: () => STAGE } as unknown as HTMLElement);
  return created;
}

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

describe("the desk in front", () => {
  it("reports each page as exactly the view main places, in the stage's coordinates", () => {
    const { layouts } = native();
    const desk = engine();
    const boxes: Rect[] = [
      { x: 20, y: 30, w: 500, h: 400 },
      { x: 560, y: 60, w: 600, h: 500 },
    ];
    desk.start(
      boxes.map((rect, index) => ({ tabId: `tab-${String(index)}`, rect: normalizeRect(rect, DESK) })),
      "tab-1",
      ["tab-0", "tab-1"],
      null,
      "space-a",
    );
    settle();
    const geometry = desk.liveGeometry();
    expect(geometry.groupId).toBe("space-a");
    expect(geometry.stage).toEqual({ x: 300, y: 40, w: 1200, h: 800 });
    expect(geometry.windows.map((window) => window.id)).toEqual(["tab-0", "tab-1"]);
    // The window in use is the one on top.
    expect(geometry.windows.map((window) => window.focused)).toEqual([false, true]);
    const views = layouts.at(-1)!.views;
    for (const window of geometry.windows) {
      const view = views.find((candidate) => candidate.tabId === window.id)!;
      expect({ x: window.page.x + geometry.stage.x, y: window.page.y + geometry.stage.y, w: window.page.w, h: window.page.h }).toEqual({
        x: view.bounds.x,
        y: view.bounds.y,
        w: view.bounds.width,
        h: view.bounds.height,
      });
    }
    // A window is its page (the Drawer frame): its frame is the same box, and where it was left.
    expect(geometry.windows[0]!.frame).toEqual({ x: 20, y: 30, w: 500, h: 400 });
    desk.destroy();
  });

  it("is heard after every render, and no more once the desk is gone", () => {
    native();
    const desk = engine();
    desk.start([{ tabId: "tab-0", rect: normalizeRect({ x: 20, y: 30, w: 500, h: 400 }, DESK) }], "tab-0", ["tab-0"], null, "space-a");
    settle();
    let heard = 0;
    desk.onRendered(() => {
      heard += 1;
    });
    desk.refresh();
    settle();
    expect(heard).toBeGreaterThan(0);
    desk.destroy();
    const before = heard;
    desk.refresh();
    expect(heard).toBe(before);
  });

  it("says what the shell draws over the stage, where its owner says, in the very render that put it there", () => {
    native();
    const desk = engine();
    desk.start([{ tabId: "tab-0", rect: normalizeRect({ x: 20, y: 30, w: 500, h: 400 }, DESK) }], "tab-0", ["tab-0"], null, "space-a");
    settle();
    expect(desk.liveGeometry().covers).toEqual([]);
    expect(desk.liveGeometry().passing).toBe(false);
    const heard: Array<Array<{ key: string; rect: Rect }>> = [];
    desk.onRendered(() => heard.push(desk.liveGeometry().covers));
    // A card beside the sidebar: heard as it is declared, before any frame paints it.
    desk.setCover("card", { x: 0, y: 100, w: 320, h: 400 });
    expect(heard.at(-1)).toEqual([{ key: "card", rect: { x: 0, y: 100, w: 320, h: 400 } }]);
    settle();
    desk.setCover("card", null);
    expect(heard.at(-1)).toEqual([]);
    desk.destroy();
  });

  it("counts the rail's floating player among them, where it floats", () => {
    native();
    const desk = engine();
    desk.start(
      [
        { tabId: "tab-0", rect: normalizeRect({ x: 20, y: 30, w: 500, h: 400 }, DESK) },
        { tabId: "tab-1", rect: normalizeRect({ x: 600, y: 300, w: 500, h: 400 }, DESK) },
      ],
      "tab-1",
      ["tab-0", "tab-1"],
      null,
      "space-a",
    );
    settle();
    desk.setFloat({ x: 900, y: 600, w: 240, h: 150 }, true);
    const geometry = desk.liveGeometry();
    expect(geometry.covers).toEqual([{ key: FLOAT_COVER, rect: { x: 900, y: 600, w: 240, h: 150 } }]);
    // Over the window it floats over alone.
    const report = deskReport({ groupId: "space-a", stage: geometry.stage, viewport: { w: 1600, h: 900 }, windows: geometry.windows, kindOf: () => "shell", covers: geometry.covers, covered: geometry.passing, sent: null }, false);
    expect(report.windows.map((window) => [window.id, window.covered])).toEqual([
      ["tab-0", false],
      ["tab-1", true],
    ]);
    expect(report.shellCovered).toBe(false);
    desk.destroy();
  });

  it("gives each page as the whole pixels inside it: a picture cut there takes in nothing beside the window", () => {
    native();
    const desk = engine();
    desk.start([{ tabId: "tab-0", rect: normalizeRect({ x: 100.4, y: 50.6, w: 300.3, h: 200.2 }, DESK) }], "tab-0", ["tab-0"], null, "space-a");
    settle();
    const [window] = desk.liveGeometry().windows;
    expect(window!.page).toEqual({ x: 101, y: 51, w: 299, h: 199 });
    expect(window!.frame).toEqual({ x: 100, y: 51, w: 300, h: 200 });
    desk.destroy();
  });

  it("says a window drawn grown or turned — carried, lifted — is transformed, as it is drawn; one carried as it is, or let go, is not", () => {
    for (const motion of ["lifted", "live"] as const) {
      const { drag } = native();
      const desk = engine({ drawn: true, motion });
      desk.start([{ tabId: "tab-0", rect: normalizeRect({ x: 100, y: 100, w: 400, h: 300 }, DESK) }], "tab-0", ["tab-0"], null, "space-a");
      settle();
      expect(desk.liveGeometry().windows[0]!.transformed).toBe(false);
      const heard: boolean[] = [];
      desk.onRendered(() => heard.push(desk.liveGeometry().windows[0]!.transformed));
      const at = { x: STAGE.left + 300, y: STAGE.top + 110 };
      desk.grab("tab-0", at);
      for (let step = 1; step <= 8; step += 1) {
        drag.sample?.({ x: at.x + step * 12, y: at.y + step * 4, phase: "move" });
        run(1);
      }
      expect(heard.includes(true)).toBe(motion === "lifted");
      drag.sample?.({ x: 0, y: 0, phase: "cancel" });
      settle();
      expect(desk.liveGeometry().windows[0]!.transformed).toBe(false);
      desk.destroy();
    }
  });
});

describe("the shared space while another is in front", () => {
  it("lays its saved arrangement out on the desk as it is: fractions of the stage, the window left on top in use", () => {
    native();
    const desk = engine();
    desk.start([], null, [], null, "space-b");
    settle();
    const saved = [
      { tabId: "tab-0", rect: { x: 0, y: 0, w: 0.5, h: 1 } },
      { tabId: "tab-1", rect: { x: 0.5, y: 0.25, w: 0.5, h: 0.5 } },
      // A tab no longer in the space is left out.
      { tabId: "tab-gone", rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
    ];
    const windows = desk.savedGeometry(saved, ["tab-0", "tab-1"], null);
    expect(windows.map((window) => window.id)).toEqual(["tab-0", "tab-1"]);
    expect(windows[0]!.frame).toEqual(denormalizeRect(saved[0]!.rect, DESK));
    expect(windows[1]!.page).toEqual({ x: 600, y: 200, w: 600, h: 400 });
    expect(windows.map((window) => window.focused)).toEqual([false, true]);
    desk.destroy();
  });

  it("keeps a masked window a picture of its region, under its handle, and a minimized one minimized", () => {
    native();
    const desk = engine();
    desk.start([], null, [], null, "space-b");
    settle();
    const mask = { x: 10, y: 10, width: 400, height: 200, pageWidth: 1000, pageHeight: 800 };
    const windows = desk.savedGeometry(
      [
        { tabId: "tab-0", rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 }, mask },
        { tabId: "tab-1", rect: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, mini: { restore: { x: 0.5, y: 0.1, w: 0.4, h: 0.5 }, parked: true } },
      ],
      ["tab-0", "tab-1"],
      null,
    );
    const masked = windows.find((window) => window.id === "tab-0")!;
    expect(masked.masked).toBe(true);
    expect(masked.page.y - masked.frame.y).toBe(MASK_INSETS.top);
    expect(masked.page.w / (masked.page.h || 1)).toBeCloseTo(400 / 200, 1);
    expect(windows.find((window) => window.id === "tab-1")!.minimized).toBe(true);
    desk.destroy();
  });
});

/** A window of a report's inputs, its page `w` wide at `x`. */
const win = (id: string, x: number, w = 100): DeskLiveWindow => ({
  id,
  frame: { x, y: 0, w, h: 100 },
  page: { x, y: 0, w, h: 100 },
  focused: false,
  minimized: false,
  masked: false,
  transformed: false,
});

/** A report's inputs on a 1000 × 800 stage past a 300px sidebar; covers and the rest as said. */
const inputs = (patch: Partial<DeskReportInputs> = {}): DeskReportInputs => ({
  groupId: "g",
  stage: { x: 300, y: 40, w: 1000, h: 800 },
  viewport: { w: 1300, h: 840 },
  windows: [],
  kindOf: () => "shell",
  covers: [],
  covered: false,
  sent: null,
  ...patch,
});

describe("the report", () => {
  it("names each window's kind, the stage's size, its place in the window, and the window's size", () => {
    const report = deskReport(inputs({ windows: [win("tab-1", 0), win("file:doc", 200)], kindOf: (id) => (id.startsWith("tab-") ? "page" : "shell") }), false);
    expect(report.stage).toEqual({ w: 1000, h: 800 });
    expect(report.stageInWindow).toEqual({ x: 300, y: 40, w: 1000, h: 800 });
    expect(report.viewport).toEqual({ w: 1300, h: 840 });
    expect(report.windows.map((entry) => entry.kind)).toEqual(["page", "shell"]);
  });

  it("holds a window drawn grown or turned as a covered one, and that is news at once", () => {
    const still = deskReport(inputs({ windows: [win("t", 0), win("h", 200)] }), false);
    const lifted = deskReport(inputs({ windows: [{ ...win("t", 0), transformed: true }, win("h", 200)] }), false);
    expect(lifted.windows.map((window) => window.covered)).toEqual([true, false]);
    expect(lifted.shellCovered).toBe(false);
    expect(coversMore(still, lifted)).toBe(true);
  });

  it("keeps the top windows when there are more than a report holds", () => {
    const many = Array.from({ length: 70 }, (_, index) => win(`tab-${String(index)}`, index));
    const report = deskReport(inputs({ windows: many, kindOf: () => "page" }), false);
    expect(report.windows).toHaveLength(64);
    expect(report.windows.at(-1)!.id).toBe("tab-69");
  });

  it("says what covers the stage and what lies over a window, and either is news", () => {
    const windows = [win("t", 0)];
    const clear = deskReport(inputs({ windows }), false);
    const covered = deskReport(inputs({ windows, covered: true }), false);
    const floated = deskReport(inputs({ windows, covers: [{ key: FLOAT_COVER, rect: { x: 40, y: 40, w: 50, h: 50 } }] }), false);
    expect([clear.shellCovered, covered.shellCovered, floated.windows[0]!.covered, floated.shellCovered]).toEqual([false, true, true, false]);
    expect(new Set([reportKey(clear), reportKey(covered), reportKey(floated)]).size).toBe(3);
    expect(coversMore(clear, covered)).toBe(true);
    expect(coversMore(clear, floated)).toBe(true);
    expect(coversMore(covered, clear)).toBe(false);
    expect(coversMore(null, clear)).toBe(false);
  });
});

describe("what covers which window", () => {
  it("knows the box of the side cards, the tooltip bands, the Bar's answer and the floating player; any other cover is over every window", () => {
    expect(coverReach("card")).toBe("column");
    expect(coverReach("sidebar")).toBe("column");
    for (const key of ["answer", "bar-tip", "nub-tip", FLOAT_COVER, windowTipCover("tab-7")]) expect(coverReach(key)).toBe("box");
    // The Bar's own (goo, drawn past its boxes), the answer's ghost and zones (they fade after their covers go), a drop,
    // the layout preview, the mask editor, the media card — and anything new.
    for (const key of ["bar", "pill", "pill-close", "pill-side", "conversations", "field-menu", "answer-slot", "answer-zone", "file-drop", "layout-preview", "maskedit", "rail-media:tab-3", "rail-media:tab-3:popup", "someday"]) {
      expect(coverReach(key)).toBe("global");
    }
  });

  it("pads a box all round, and takes a card's column from the stage's leading edge to its trailing one, the stage's whole height", () => {
    const stage = { w: 1000, h: 800 };
    expect(coverBox({ key: "answer", rect: { x: 600, y: 300, w: 300, h: 400 } }, stage)).toEqual({ x: 600 - LIVE_COVER_PAD, y: 300 - LIVE_COVER_PAD, w: 300 + 2 * LIVE_COVER_PAD, h: 400 + 2 * LIVE_COVER_PAD });
    expect(coverBox({ key: "card", rect: { x: 0, y: 200, w: 330, h: 300 } }, stage)).toEqual({ x: -LIVE_COVER_PAD, y: -LIVE_COVER_PAD, w: 330 + 2 * LIVE_COVER_PAD, h: 800 + 2 * LIVE_COVER_PAD });
    // The hidden sidebar's column comes from past the stage's edge.
    expect(coverBox({ key: "sidebar", rect: { x: -300, y: 0, w: 316, h: 800 } }, stage)).toEqual({ x: -300 - LIVE_COVER_PAD, y: -LIVE_COVER_PAD, w: 316 + 2 * LIVE_COVER_PAD, h: 800 + 2 * LIVE_COVER_PAD });
    expect(coverBox({ key: "pill", rect: { x: 600, y: 700, w: 300, h: 60 } }, stage)).toBeNull();
  });

  it("is the Live card over the window beside it, not the one across the desk", () => {
    const report = deskReport(inputs({ windows: [win("left", 20, 400), win("right", 560, 420)], covers: [{ key: "card", rect: { x: 0, y: 120, w: 340, h: 500 } }] }), false);
    expect(report.windows.map((window) => [window.id, window.covered])).toEqual([
      ["left", true],
      ["right", false],
    ]);
    expect(report.shellCovered).toBe(false);
  });

  it("is a frame button's tooltip band over its own window's page, and the Bar's answer over the window it rests on", () => {
    const windows = [win("a", 20, 400), win("b", 560, 420)];
    const tip = deskReport(inputs({ windows, covers: [{ key: windowTipCover("b"), rect: { x: 800, y: 30, w: 180, h: 40 } }] }), false);
    expect(tip.windows.map((window) => window.covered)).toEqual([false, true]);
    const answer = deskReport(inputs({ windows, covers: [{ key: "answer", rect: { x: 150, y: 50, w: 200, h: 300 } }] }), false);
    expect(answer.windows.map((window) => window.covered)).toEqual([true, false]);
  });

  it("reaches a window a pad's width away, and no further", () => {
    const near = deskReport(inputs({ windows: [win("w", 500)], covers: [{ key: "answer", rect: { x: 300, y: 0, w: 200 - LIVE_COVER_PAD + 1, h: 100 } }] }), false);
    const far = deskReport(inputs({ windows: [win("w", 500)], covers: [{ key: "answer", rect: { x: 300, y: 0, w: 200 - LIVE_COVER_PAD, h: 100 } }] }), false);
    expect([near.windows[0]!.covered, far.windows[0]!.covered]).toEqual([true, false]);
  });

  it("is a cover over where the report sent last put a window, too: a frame painted now is cut there until the next", () => {
    const card = [{ key: "card", rect: { x: 0, y: 120, w: 340, h: 500 } }];
    const before = deskReport(inputs({ windows: [win("t", 20, 300)] }), false);
    const sent = { ...before, mark: 1 };
    // Dragged from under where the card now is: clear of it, but the report main has puts it there.
    const moved = deskReport(inputs({ windows: [win("t", 500, 300)], covers: card, sent }), false);
    expect(moved.windows[0]!.covered).toBe(true);
    const settledThere = deskReport(inputs({ windows: [win("t", 500, 300)], covers: card, sent: { ...moved, mark: 2 } }), false);
    expect(settledThere.windows[0]!.covered).toBe(false);
  });

  it("is anything whose box is not known over every window", () => {
    const report = deskReport(inputs({ windows: [win("a", 20), win("b", 700)], covers: [{ key: "pill", rect: { x: 900, y: 700, w: 80, h: 60 } }] }), false);
    expect(report.shellCovered).toBe(true);
  });
});

describe("what the outlines go under", () => {
  it("is each box the report knows, as far as a window's `covered` reads it; a cover with none is the stage covered", () => {
    const card = { key: "card", rect: { x: 0, y: 120, w: 340, h: 500 } };
    const answer = { key: "answer", rect: { x: 600, y: 300, w: 300, h: 400 } };
    const report = deskReport(inputs({ windows: [win("a", 20, 400)], covers: [card, answer] }), false);
    expect(report.covers).toEqual([coverBox(card, report.stage), coverBox(answer, report.stage)]);
    const goo = deskReport(inputs({ covers: [answer, { key: "pill", rect: { x: 900, y: 700, w: 80, h: 60 } }] }), false);
    expect([goo.covers, goo.shellCovered]).toEqual([[coverBox(answer, goo.stage)], true]);
    expect(deskReport(inputs(), false).covers).toEqual([]);
  });

  it("is news as a box moves, at the desk's pace: what covers no more window than it did waits its turn", () => {
    const windows = [win("a", 20, 300)];
    const at = (x: number, y = 300) => deskReport(inputs({ windows, covers: [{ key: "answer", rect: { x, y, w: 200, h: 200 } }] }), false);
    expect(reportKey(at(500))).not.toBe(reportKey(at(540)));
    expect(urgent(at(500), at(540))).toBe(false);
    // Over the window now: at once, as ever.
    expect(urgent(at(500), at(200, 50))).toBe(true);
  });

  it("is the whole stage past the boxes a report holds", () => {
    const covers = Array.from({ length: MAX_LIVE_DESK_COVERS + 1 }, (_, index) => ({ key: windowTipCover(`tab-${String(index)}`), rect: { x: index * 20, y: 0, w: 10, h: 10 } }));
    const report = deskReport(inputs({ covers }), false);
    expect([report.covers.length, report.shellCovered]).toEqual([MAX_LIVE_DESK_COVERS, true]);
  });
});

describe("the shell's own layers over the stage", () => {
  const rest: ShellLayers = { overlay: "none", overlayActive: false, error: null, onboardingOpen: false, screenshotSelecting: false, glance: null, tabSwitcher: null };
  const STAGE_IN_WINDOW = { x: 300, y: 40, w: 1000, h: 800 };

  it("are the overlays the store raises over the page area, any of them", () => {
    expect(layersCover(rest)).toBe(false);
    for (const up of [{ overlay: "url" }, { overlay: "context-menu" }, { overlayActive: true }, { error: "Oops" }, { onboardingOpen: true }, { screenshotSelecting: true }, { glance: {} }, { tabSwitcher: {} }]) {
      expect(layersCover({ ...rest, ...up })).toBe(true);
    }
  });

  it("are any layer in <body> that is not a tooltip, wherever it is", () => {
    expect(layersOverStage([], STAGE_IN_WINDOW, [])).toBe(false);
    expect(layersOverStage([{ tooltip: null }], STAGE_IN_WINDOW, [])).toBe(true);
  });

  it("are a tooltip neither in its band nor off the stage; one in its band, or over the sidebar, lies over nothing cut", () => {
    // A frame's band under its buttons (stage px), and the tooltip in it (window px).
    const bands = tooltipBands([{ key: windowTipCover("t"), rect: { x: 500, y: 30, w: 240, h: 40 } }]);
    expect(layersOverStage([{ tooltip: { x: 300 + 560, y: 40 + 40, w: 80, h: 24 } }], STAGE_IN_WINDOW, bands)).toBe(false);
    // Out of its band, over the desk: over every window.
    expect(layersOverStage([{ tooltip: { x: 300 + 560, y: 40 + 300, w: 80, h: 24 } }], STAGE_IN_WINDOW, bands)).toBe(true);
    // Over the sidebar, wholly off the stage: in no window's picture.
    expect(layersOverStage([{ tooltip: { x: 120, y: 200, w: 80, h: 24 } }], STAGE_IN_WINDOW, [])).toBe(false);
    // Its arrow or ring a pad's width from the stage: on it.
    expect(layersOverStage([{ tooltip: { x: 300 - 80 - LIVE_COVER_PAD + 1, y: 200, w: 80, h: 24 } }], STAGE_IN_WINDOW, [])).toBe(true);
    // Not yet placed (where a portal is put before it is positioned): wherever that is.
    expect(layersOverStage([{ tooltip: { x: 0, y: 0, w: 80, h: 24 } }], STAGE_IN_WINDOW, bands)).toBe(false);
    expect(layersOverStage([{ tooltip: { x: 0, y: 0, w: 80, h: 24 } }], { x: 0, y: 0, w: 1300, h: 840 }, bands)).toBe(true);
  });
});

describe("pacing", () => {
  function harness() {
    let now = 0;
    const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
    const clock: PacerClock = {
      now: () => now,
      later: (run, ms) => {
        const timer = { at: now + ms, run, live: true };
        timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
    };
    const sent: LiveDeskReport[] = [];
    /** Each paint of the mark, as it went: fresh as a report was sent, stale as a render was kept back; and whether a render was in hand. */
    const marks: Array<{ mark: number; stale: boolean; inRender: boolean }> = [];
    let inRender = false;
    const pacer = new LiveDeskPacer(
      {
        send: (report) => {
          sent.push(report);
          marks.push({ mark: report.mark, stale: false, inRender });
        },
        stale: (mark) => marks.push({ mark, stale: true, inRender }),
      },
      clock,
    );
    /** A render of the desk: what the engine hands the report as it draws it. */
    const render = (report: LiveDeskDraft): void => {
      inRender = true;
      try {
        pacer.moving(report);
      } finally {
        inRender = false;
      }
    };
    const advance = (ms: number): void => {
      const until = now + ms;
      for (;;) {
        const next = timers.filter((timer) => timer.live && timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (next === undefined) break;
        next.live = false;
        now = next.at;
        next.run();
      }
      now = until;
    };
    return { pacer, sent, marks, render, advance };
  }
  const at = (x: number, covered = false, stage = { x: 0, y: 0, w: 1000, h: 800 }): LiveDeskDraft => deskReport({ ...inputs({ stage, covered }), windows: [{ ...win("tab-1", x), focused: true }] }, false);
  /** Two windows: the terminal at `t`, home at `h`. */
  const two = (t: number, h = 500, focused = "t"): LiveDeskDraft =>
    deskReport({ ...inputs({}), windows: [{ ...win("t", t), focused: focused === "t" }, { ...win("h", h), focused: focused === "h" }] }, false);

  it("sends at most every 33 ms while the desk moves, the latest always, then once settled", () => {
    const { pacer, sent, advance } = harness();
    // A window dragged for 200 ms, a frame every 16 ms.
    for (let frame = 0; frame <= 12; frame += 1) {
      pacer.moving(at(frame * 10));
      advance(16);
    }
    const moving = sent.filter((report) => !report.settled);
    expect(moving.length).toBeGreaterThan(3);
    expect(moving.length).toBeLessThanOrEqual(Math.ceil(200 / LIVE_DESK_REPORT_MS) + 1);
    advance(LIVE_DESK_SETTLE_MS + 10);
    const last = sent.at(-1)!;
    expect(last.settled).toBe(true);
    expect(last.windows[0]!.frame.x).toBe(120);
    // Settled once: nothing more goes while nothing changes.
    const count = sent.length;
    pacer.moving(at(120));
    advance(500);
    expect(sent.length).toBe(count);
  });

  it("says a single change at once, and settles it", () => {
    const { pacer, sent, advance } = harness();
    pacer.moving(at(5));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.settled).toBe(false);
    advance(LIVE_DESK_SETTLE_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.settled).toBe(true);
    expect(reportKey(sent[1]!)).toBe(reportKey(sent[0]!));
  });

  it("sends a saved arrangement at once, settled, and again only when it says something new", () => {
    const { pacer, sent, advance } = harness();
    pacer.still(at(40));
    pacer.still(at(40));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.settled).toBe(true);
    pacer.still(at(80));
    expect(sent).toHaveLength(2);
    advance(1000);
    expect(sent).toHaveLength(2);
  });

  it("sends a report that covers more at once, whatever the interval; one that covers less waits its turn", () => {
    const { pacer, sent, advance } = harness();
    pacer.moving(at(5));
    expect(sent).toHaveLength(1);
    advance(5);
    // A menu up 5 ms after the last report: main hears it before the menu is painted.
    pacer.moving(at(5, true));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.shellCovered).toBe(true);
    advance(5);
    // Down again: an ordinary change, paced.
    pacer.moving(at(5, false));
    expect(sent).toHaveLength(2);
    // (No render came to take it: it goes on its own a moment after it is due.)
    advance(LIVE_DESK_REPORT_MS + LIVE_DESK_DUE_STAGGER_MS + LIVE_DESK_FLUSH_GRACE_MS);
    expect(sent).toHaveLength(3);
    expect(sent.at(-1)!.shellCovered).toBe(false);
  });

  it("sends at once a report whose stage moved in the window, or whose window changed size: frames of the old layout are not cut by it", () => {
    const { pacer, sent, advance } = harness();
    pacer.moving(at(5));
    advance(5);
    pacer.moving(at(5, false, { x: 48, y: 0, w: 1252, h: 800 }));
    expect(sent).toHaveLength(2);
    expect(urgent(sent[0]!, { ...sent[0]!, viewport: { w: 1200, h: 840 } })).toBe(true);
    expect(urgent(sent[0]!, at(6))).toBe(false);
  });

  it("sends from the render that drew it once it is due, while renders come: never between them, where the next would draw past it", () => {
    const { sent, marks, render, advance } = harness();
    // A window carried for 300 ms, a render every 16.7 ms (60 Hz), a few ms late or early.
    for (let frame = 0; frame <= 18; frame += 1) {
      render(at(frame * 6));
      advance(frame % 3 === 0 ? 18 : 16);
    }
    const moving = sent.filter((report) => !report.settled);
    expect(moving.length).toBeGreaterThanOrEqual(7);
    expect(marks.filter((mark) => !mark.stale).every((mark) => mark.inRender)).toBe(true);
    // Two renders apart and three by turns: never faster than main passes words on.
    const renders = moving.map((report) => report.windows[0]!.frame.x / 6);
    const apart = renders.slice(1).map((frame, index) => frame - renders[index]!);
    expect(new Set(apart)).toEqual(new Set([2, 3]));
  });

  it("staggers its reports, so a capture taking every other frame — or every fourth, at 120 Hz — has frames painted as they went, whichever frames it takes", () => {
    for (const hz of [60, 120]) {
      const { sent, render, advance } = harness();
      const interval = 1_000 / hz;
      const frames = hz;
      for (let frame = 0; frame < frames; frame += 1) {
        render(at(frame));
        advance(interval);
      }
      const fresh = sent.filter((report) => !report.settled).map((report) => report.windows[0]!.frame.x);
      // The capture's share: ≤ 30 frames a second.
      const every = hz / 30;
      for (let phase = 0; phase < every; phase += 1) {
        const caught = fresh.filter((frame) => frame % every === phase).length;
        expect(caught, `${String(hz)} Hz, the capture taking frames ${String(phase)} mod ${String(every)}`).toBeGreaterThanOrEqual(hz === 60 ? 10 : 5);
      }
      expect(fresh.length).toBeLessThanOrEqual(30);
    }
  });

  it("paints the last report's mark stale in the very render that draws a window elsewhere while its own report waits, and the next report's fresh", () => {
    const { sent, marks, render, advance } = harness();
    render(at(0));
    expect(marks).toEqual([{ mark: 0, stale: false, inRender: true }]);
    advance(16);
    // Moved, its report not due: that render's frame is not report 0's to cut where it put the window.
    render(at(6));
    expect(sent).toHaveLength(1);
    expect(marks.at(-1)).toEqual({ mark: 0, stale: true, inRender: true });
    advance(8);
    render(at(9));
    // (Stale once: it stays so till the next report.)
    expect(marks).toHaveLength(2);
    // Due (within a render's slack of the interval): from this render, fresh.
    advance(LIVE_DESK_REPORT_MS - LIVE_DESK_DUE_SLACK_MS - 24);
    render(at(12));
    expect(sent).toHaveLength(2);
    expect(marks.at(-1)).toEqual({ mark: 1, stale: false, inRender: true });
  });

  it("keeps the mark fresh through a render kept back that moves no window", () => {
    const { sent, marks, render, advance } = harness();
    render(two(0));
    advance(LIVE_DESK_REPORT_MS);
    render(two(0, 500, "h"));
    advance(5);
    // The window in use changed, nothing moved: its report waits, and a frame painted meanwhile is still report 1's.
    render(two(0, 500, "t"));
    expect(sent).toHaveLength(2);
    expect(marks.every((mark) => !mark.stale)).toBe(true);
  });

  it("sends at once a report that moves a window the last report called steady; one already moving waits its turn, the steady one cut meanwhile", () => {
    const { sent, marks, render, advance } = harness();
    render(two(0));
    advance(LIVE_DESK_SETTLE_MS + 10);
    // Settled: the same again, every window where the report before put it.
    expect(sent).toHaveLength(2);
    expect([...steadyPages(sent[0]!, sent[1]!).keys()].sort()).toEqual(["h", "t"]);
    advance(5);
    // The terminal starts to move: at once, however soon after the last.
    render(two(10));
    expect(sent).toHaveLength(3);
    expect([...steadyPages(sent[1]!, sent[2]!).keys()]).toEqual(["h"]);
    advance(5);
    // On the move: it waits its turn, the mark stale meanwhile — home stands where report 2 and 1 put it.
    render(two(20));
    expect(sent).toHaveLength(3);
    expect(marks.at(-1)).toEqual({ mark: 2, stale: true, inRender: true });
    advance(5);
    // Home moves too: steady in report 2, it goes at once.
    render(two(20, 520));
    expect(sent).toHaveLength(4);
    expect(sent.at(-1)!.windows.map((window) => window.frame.x)).toEqual([20, 520]);
  });

  it("knows a window moved, come or gone, and a steady one moved or gone", () => {
    const one = deskReport({ ...inputs({}), windows: [win("t", 0)] }, false);
    expect(pagesMoved(two(0), two(0, 500, "h"))).toBe(false);
    expect(pagesMoved(two(0), two(1))).toBe(true);
    expect(pagesMoved(two(0), one)).toBe(true);
    expect(pagesMoved(one, two(0))).toBe(true);
    const steady = steadyPages(two(0), two(0, 600));
    expect([...steady.keys()]).toEqual(["t"]);
    expect(movesSteady(steady, two(0, 700))).toBe(false);
    expect(movesSteady(steady, two(3, 600))).toBe(true);
    expect(movesSteady(steady, deskReport({ ...inputs({}), windows: [win("h", 600)] }, false))).toBe(true);
    expect(steadyPages(null, two(0)).size).toBe(0);
  });

  it("numbers every report it sends, counting on from where it was told to, round the wrap; the last sent is known", () => {
    let now = 0;
    const sent: LiveDeskReport[] = [];
    const pacer = new LiveDeskPacer({ send: (report) => sent.push(report), stale: () => undefined }, { now: () => now, later: () => () => undefined }, 65_535);
    expect(pacer.sent).toBeNull();
    pacer.moving(at(1));
    now += 100;
    pacer.moving(at(2));
    pacer.still(at(3));
    expect(sent.map((report) => report.mark)).toEqual([65_535, 0, 1]);
    expect(pacer.sent).toBe(sent.at(-1));
  });

  it("sends nothing once disposed", () => {
    const { pacer, sent, advance } = harness();
    pacer.moving(at(1));
    pacer.moving(at(2));
    pacer.dispose();
    advance(1000);
    expect(sent).toHaveLength(1);
  });
});
