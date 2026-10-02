/**
 * Documents on the desk (docs/desk-documents.md): a window need not be a
 * tab's. A document's window is the shell's own — never reported to main,
 * always drawn — whose home is the Stack; the desk's pane on leaving is
 * always a tab's; the agent reads and arranges documents as windows; and
 * the Bar's @mentions find and insert files.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_SURFACE_MEMBERS, type BrowserLayout } from "@pistachio/shell-contracts/ipc";
import type { DeskState } from "@pistachio/shell-contracts/desk";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { DeskEngine, type DeskHost } from "../src/components/desk/desk-engine";
import type { Rect } from "../src/lib/desk/geometry";
import { insertMention, mentionCandidates, mentionQuery, mentionsIn } from "../src/lib/desk/mentions";
import { DEFAULT_DESK_VARIANTS, type SavedDeskWindow } from "../src/lib/desk/store";
import { documentShare, fileItemOf, fileWindowId, isTabWindow, windowKind } from "../src/lib/desk/windows";

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

function native(options: { stills?: boolean } = {}) {
  const layouts: BrowserLayout[] = [];
  const desks: Array<DeskState | null> = [];
  const members = Object.fromEntries(Object.keys(NATIVE_SURFACE_MEMBERS).map((member) => [member, vi.fn()]));
  setShellApi({
    ...members,
    setLayout: (layout: BrowserLayout) => layouts.push(layout),
    setDesk: (state: DeskState | null) => desks.push(state),
    captureTabStills: (ids: readonly string[]) => Promise.resolve(options.stills === true ? ids.map((tabId) => ({ tabId, dataUrl: `data:image/jpeg;base64,${tabId}` })) : []),
    focusTab: () => Promise.resolve(),
    onDragSample: () => () => undefined,
  } as unknown as ShellApiBridge);
  return { layouts, desks };
}

const STAGE = { left: 0, top: 0, width: 1600, height: 1000 };

/** A desk over a 1600×1000 stage whose tabs' pages are live, as they are on the desktop. */
function engine(host: Partial<DeskHost> = {}): DeskEngine {
  const created = new DeskEngine({
    variants: () => DEFAULT_DESK_VARIANTS,
    hasLivePage: (id) => isTabWindow(id),
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
  created.attachStage({ getBoundingClientRect: () => STAGE } as unknown as HTMLElement);
  return created;
}

/** The Stack, somewhere in the dock: where a document's window goes home to. */
function stackAt(rect: Rect): HTMLElement {
  return {
    isConnected: true,
    getBoundingClientRect: () => ({ left: rect.x, top: rect.y, width: rect.w, height: rect.h }),
    closest: () => null,
    dataset: {},
    offsetWidth: rect.w,
  } as unknown as HTMLElement;
}

const PLAN = fileWindowId("aaaaaaaaaaaa");
const TRIP = fileWindowId("bbbbbbbbbbbb");

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

describe("a desk window's kind", () => {
  it("is told by its id: a tab's UUID, or file: and the context item", () => {
    expect(windowKind("5b0c2e8e-1f3c-4f53-9a55-3c3e2f1d9b10")).toBe("tab");
    expect(windowKind(PLAN)).toBe("file");
    expect(fileItemOf(PLAN)).toBe("aaaaaaaaaaaa");
    expect(fileItemOf("tab-1")).toBeNull();
    expect(documentShare("sheet").w).toBeGreaterThan(documentShare("pdf").w);
  });
});

describe("a document's window", () => {
  it("is never main's: always drawn, never in its layout or its desk", () => {
    const { layouts, desks } = native();
    const desk = engine();
    desk.start([], "tab-0", ["tab-0", "tab-1"], [PLAN]);
    settle();
    desk.add(PLAN, { focus: true });
    settle();
    const view = desk.getView();
    expect(view.windows.map((window) => window.tabId)).toEqual(["tab-0", PLAN]);
    expect(view.windows.find((window) => window.tabId === PLAN)?.drawn).toBe(true);
    expect(layouts.at(-1)?.views.map((placed) => placed.tabId)).toEqual(["tab-0"]);
    expect(desks.at(-1)?.tabIds).toEqual(["tab-0"]);
    expect(desk.focusedTabId()).toBe(PLAN);
    desk.destroy();
  });

  it("covers the page under it, which gives way to its still", async () => {
    native({ stills: true });
    vi.stubGlobal("Image", class {
      src = "";
      decode(): Promise<void> {
        return Promise.resolve();
      }
    });
    const desk = engine();
    desk.start([], "tab-0", ["tab-0"], [PLAN]);
    settle();
    // Over the tab's window, on top of it: the page under a document is covered.
    desk.add(PLAN, { focus: true, rect: { x: 0, y: 0, w: 1600, h: 900 } });
    for (let round = 0; round < 6; round += 1) {
      settle();
      await new Promise((done) => setTimeout(done, 0));
    }
    expect(desk.getView().windows.map((window) => window.tabId)).toEqual(["tab-0", PLAN]);
    expect(desk.getView().windows.find((window) => window.tabId === "tab-0")?.drawn).toBe(true);
    desk.destroy();
  });

  it("goes home into the Stack and comes out of it, the Stack bouncing as it takes it", () => {
    native();
    const stack = stackAt({ x: -40, y: 480, w: 32, h: 32 });
    // The Stack's row in the sidebar is the documents' home.
    const desk = engine({ homeOf: (kind) => (kind === "file" ? stack : null) });
    desk.start([], "tab-0", ["tab-0"], [PLAN]);
    settle();
    desk.add(PLAN, { focus: true });
    settle();
    desk.putAway(PLAN);
    settle();
    expect(desk.windowTabIds()).toEqual(["tab-0"]);
    expect((stack.dataset as Record<string, string>)["received"]).toBe("");
    desk.destroy();
  });

  it("comes out where it was let go, centred on the point, at its kind's share of the desk", () => {
    native();
    const desk = engine();
    desk.start([], "tab-0", ["tab-0"], [PLAN]);
    settle();
    desk.openAt(PLAN, { x: 900, y: 500 }, { w: 0.46, h: 0.86, maxW: 760 });
    settle();
    const placed = desk.layoutSnapshot().windows.find((window) => window.tabId === PLAN)!.rect;
    expect(placed.x + placed.w / 2).toBeCloseTo(900, 0);
    expect(placed.w).toBeLessThanOrEqual(760);
    expect(desk.focusedTabId()).toBe(PLAN);
    desk.destroy();
  });

  it("comes back with the desk where it was left, and goes once its file is gone from the context", () => {
    native();
    const saved: SavedDeskWindow[] = [
      { tabId: "tab-0", rect: { x: 0, y: 0, w: 0.5, h: 1 } },
      { tabId: PLAN, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } },
      { tabId: TRIP, rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } },
    ];
    const desk = engine();
    // Before the context is known, the saved documents come out.
    desk.start(saved, "tab-0", ["tab-0"], null);
    settle();
    // (The tab the desk came up on, on top.)
    expect(desk.windowTabIds()).toEqual([PLAN, TRIP, "tab-0"]);
    // TRIP's file was taken out of the context meanwhile: its window goes.
    desk.setShellWindows([PLAN]);
    expect(desk.windowTabIds()).toEqual([PLAN, "tab-0"]);
    desk.destroy();
  });

  it("is tiled and cascaded with the tabs, after them", () => {
    native();
    const desk = engine();
    desk.start([], "tab-0", ["tab-0", "tab-1"], [PLAN, TRIP]);
    settle();
    desk.add("tab-1", { focus: false });
    desk.add(PLAN, { focus: false });
    desk.add(TRIP, { focus: false });
    settle();
    desk.arrange("tile", ["tab-0", "tab-1"]);
    settle();
    const rects = desk.layoutSnapshot().windows.map((window) => window.rect);
    expect(rects).toHaveLength(4);
    for (const [index, a] of rects.entries())
      for (const b of rects.slice(index + 1)) expect(a.x + a.w <= b.x + 1 || b.x + b.w <= a.x + 1 || a.y + a.h <= b.y + 1 || b.y + b.h <= a.y + 1).toBe(true);
    desk.destroy();
  });

  it("leaves the desk as a tab's pane, even when a document is the window in use", () => {
    native();
    const done = vi.fn();
    const desk = engine({ leaveDone: done });
    desk.start([], "tab-0", ["tab-0"], [PLAN]);
    settle();
    desk.add(PLAN, { focus: true });
    settle();
    expect(desk.focusedTabId()).toBe(PLAN);
    desk.leave();
    settle();
    expect(done).toHaveBeenCalled();
    desk.destroy();
  });

  it("is read and arranged by the agent as a window, by its file: id", () => {
    native();
    const desk = engine();
    desk.start([], "tab-0", ["tab-0"], [PLAN]);
    settle();
    // In the Stack: brought out by name.
    expect(desk.arrangeFor({ place: [{ tabId: PLAN, zone: "left" }, { tabId: "tab-0", zone: "right" }] })).toBeNull();
    settle();
    const layout = desk.agentLayout();
    // (Brought out by the agent, under the window in use.)
    expect(layout.windows.map((window) => [window.tabId, window.kind])).toEqual([
      [PLAN, "file"],
      ["tab-0", "tab"],
    ]);
    expect(layout.windows.find((window) => window.tabId === PLAN)?.box.x).toBe(0);
    // Not one of this desk's documents: refused, nothing moves.
    expect(desk.arrangeFor({ bringOut: [TRIP] })).toBe(`${TRIP} is not one of this desk's documents`);
    const before = desk.layoutSnapshot();
    expect(desk.arrangeFor({ putAway: [PLAN] })).toBeNull();
    settle();
    expect(desk.windowTabIds()).toEqual(["tab-0"]);
    desk.restoreLayout(before);
    settle();
    expect(desk.windowTabIds()).toContain(PLAN);
    desk.destroy();
  });
});

describe("@mentions", () => {
  const files = [{ name: "notes.md" }, { name: "Boarding pass.pdf" }, { name: "budget.xlsx" }, { name: "trip-notes.docx" }];

  it("start at @ at the start or after a space, and run to the caret", () => {
    expect(mentionQuery("Look at @no", 11)).toEqual({ start: 8, query: "no" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("(@bud", 5)).toEqual({ start: 1, query: "bud" });
    expect(mentionQuery("mail me at a@b.co", 17)).toBeNull();
    expect(mentionQuery("@notes\nnext", 11)).toBeNull();
    expect(mentionQuery("@ notes", 7)).toBeNull();
  });

  it("offer names that start with the query first, then words that do, then names that hold it", () => {
    expect(mentionCandidates(files, "no").map((file) => file.name)).toEqual(["notes.md", "trip-notes.docx"]);
    expect(mentionCandidates(files, "pass").map((file) => file.name)).toEqual(["Boarding pass.pdf"]);
    expect(mentionCandidates(files, "").map((file) => file.name)).toEqual(files.map((file) => file.name));
    expect(mentionCandidates(files, "zzz")).toEqual([]);
  });

  it("insert the name, and a space after it", () => {
    expect(insertMention("Look at @no please", 8, 11, "notes.md")).toEqual({ text: "Look at @notes.md please", caret: 18 });
    expect(insertMention("@bo", 0, 3, "Boarding pass.pdf")).toEqual({ text: "@Boarding pass.pdf ", caret: 19 });
  });

  it("are found in a message by their names, the longest first, spaces and all", () => {
    const text = "Compare @Boarding pass.pdf with @budget.xlsx, and @notes.md. Not me@notes.md or @nothing.";
    expect(mentionsIn(text, files.map((file) => file.name)).map((span) => span.name)).toEqual(["Boarding pass.pdf", "budget.xlsx", "notes.md"]);
    expect(mentionsIn("@Plan B.pdf here", ["Plan", "Plan B.pdf"]).map((span) => span.name)).toEqual(["Plan B.pdf"]);
  });
});
