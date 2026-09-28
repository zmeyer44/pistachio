/**
 * What the desk's engine (src/components/desk/desk-engine.ts) tells main:
 * the first layout goes out even when it is empty, and the desk never holds
 * more windows than main accepts (@pistachio/shell-contracts/desk).
 *
 * The engine runs a frame at a time outside React; here the frames are
 * driven by hand, and the only DOM it needs is a stage box.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDeskState, MAX_DESK_WINDOWS, type DeskState } from "@pistachio/shell-contracts/desk";
import { NATIVE_SURFACE_MEMBERS, type BrowserLayout } from "@pistachio/shell-contracts/ipc";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { DeskEngine } from "../src/components/desk/desk-engine";
import { DEFAULT_DESK_VARIANTS, type SavedDeskWindow } from "../src/lib/desk/store";

let frames: Array<(now: number) => void> = [];
let clock = 0;

/** Run animation frames until the engine stops asking for them. */
function settle(): void {
  for (let i = 0; i < 2_000 && frames.length > 0; i += 1) {
    const due = frames;
    frames = [];
    clock += 16;
    for (const frame of due) frame(clock);
  }
}

function native() {
  const layouts: BrowserLayout[] = [];
  const desks: Array<DeskState | null> = [];
  const members = Object.fromEntries(Object.keys(NATIVE_SURFACE_MEMBERS).map((member) => [member, vi.fn()]));
  setShellApi({
    ...members,
    setLayout: (layout: BrowserLayout) => layouts.push(layout),
    setDesk: (state: DeskState | null) => desks.push(state),
    captureTabStills: () => Promise.resolve([]),
    focusTab: () => Promise.resolve(),
  } as unknown as ShellApiBridge);
  return { layouts, desks };
}

/** A desk whose pages are all shell-drawn (no live views), over a 1600×1000 stage. */
function engine(): DeskEngine {
  const created = new DeskEngine({
    variants: () => DEFAULT_DESK_VARIANTS,
    hasLivePage: () => false,
    select: () => undefined,
    save: () => undefined,
    leaveDone: () => undefined,
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
  it("gathers only as many windows as main accepts", () => {
    const { desks } = native();
    const desk = engine();
    const ids = tabIds(MAX_DESK_WINDOWS + 6);
    desk.start([], "tab-0", ids);
    settle();
    desk.gather(ids);
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
    desk.gather(ids);
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
