/**
 * The desk as its agent reads and arranges it (docs/desk-agent.md §2): the
 * zones and boxes are percents of the room windows have — beside the dock
 * and above the Bar — an arrangement moves the windows without taking the
 * person's keyboard, a tab the agent opens comes out under the window in
 * use, and Undo layout puts every window back. And what a drop on the
 * Stack carries besides files.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSummary } from "@pistachio/protocol";
import { isDeskReply, type DeskRequest } from "@pistachio/shell-contracts/desk-agent";
import { MAX_DESK_WINDOWS } from "@pistachio/shell-contracts/desk";
import { NATIVE_SURFACE_MEMBERS } from "@pistachio/shell-contracts/ipc";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { DeskEngine, type DeskHost } from "../src/components/desk/desk-engine";
import { answerDeskRequest, type DeskAnswerDeps } from "../src/components/desk/desk-requests";
import { agentActivity, agentVerb, boxRect, deskZoneRect, percentBox } from "../src/lib/desk/agent";
import { DESK_GAP, zoneRect, type Rect } from "../src/lib/desk/geometry";
import { droppedText } from "../src/lib/desk/group-context";
import { DEFAULT_DESK_VARIANTS } from "../src/lib/desk/store";

let frames: Array<(now: number) => void> = [];
let clock = 0;

/** A few frames: the springs mid-way. */
function step(count: number): void {
  for (let i = 0; i < count && frames.length > 0; i += 1) {
    const due = frames;
    frames = [];
    clock += 16;
    for (const frame of due) frame(clock);
  }
}

function settle(): void {
  for (let i = 0; i < 2_000 && frames.length > 0; i += 1) {
    const due = frames;
    frames = [];
    clock += 16;
    for (const frame of due) frame(clock);
  }
}

/** The room windows have on the 1600×1000 stage: the whole card, the Bar's notch over its foot. */
const desk: Rect = { x: 0, y: 0, w: 1600, h: 1000 };

function engine(host: Partial<DeskHost> = {}): DeskEngine {
  const members = Object.fromEntries(Object.keys(NATIVE_SURFACE_MEMBERS).map((member) => [member, vi.fn()]));
  setShellApi({ ...members, captureTabStills: () => Promise.resolve([]), focusTab: () => Promise.resolve() } as unknown as ShellApiBridge);
  const created = new DeskEngine({
    variants: () => DEFAULT_DESK_VARIANTS,
    hasLivePage: () => false,
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
  created.attachStage({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 1000 }) } as unknown as HTMLElement);
  created.setNotch({ w: 240, h: 32 });
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

describe("the agent's zones and boxes", () => {
  it("put windows in halves, quarters, the middle or the whole desk", () => {
    expect(deskZoneRect("left", desk)).toEqual(zoneRect("left", desk));
    expect(deskZoneRect("bottom-right", desk)).toEqual(zoneRect("bottom-right", desk));
    expect(deskZoneRect("full", desk)).toEqual(desk);
    const top = deskZoneRect("top", desk);
    const bottom = deskZoneRect("bottom", desk);
    expect(top).toEqual({ x: desk.x, y: 0, w: desk.w, h: (desk.h - DESK_GAP) / 2 });
    expect(bottom.y).toBeCloseTo(top.h + DESK_GAP);
    expect(bottom.y + bottom.h).toBeCloseTo(desk.h);
  });

  it("read and write boxes as percents of the desk, and keep a box the agent gave on it", () => {
    expect(percentBox(zoneRect("right", desk), desk)).toEqual({ x: 50.2, y: 0, w: 49.8, h: 100 });
    expect(boxRect({ x: 0, y: 0, w: 50, h: 100 }, desk)).toEqual({ x: desk.x, y: 0, w: desk.w / 2, h: desk.h });
    // Past the desk's edge, it is brought back onto it.
    const pushed = boxRect({ x: 80, y: 80, w: 50, h: 50 }, desk);
    expect(pushed.x + pushed.w).toBeCloseTo(desk.x + desk.w);
    expect(pushed.y + pushed.h).toBeCloseTo(desk.h);
  });

  it("say what the agent is doing in a word", () => {
    expect(agentVerb("page.inspect")).toBe("Reading");
    expect(agentVerb("page.type")).toBe("Typing");
    expect(agentVerb("desk.arrange")).toBe("Arranging");
    const run = { status: "running", control: "agent", toolCalls: [{ name: "page.click", status: "running" }] } as unknown as RunSummary;
    expect(agentActivity(run)).toBe("Clicking");
    expect(agentActivity({ ...run, toolCalls: [{ ...run.toolCalls[0]!, status: "completed" }] })).toBe("Thinking");
    expect(agentActivity({ ...run, status: "completed" })).toBeNull();
  });
});

describe("the agent at the desk", () => {
  const ids = ["tab-0", "tab-1", "tab-2", "tab-3"];

  it("keeps every window above the Bar's band", () => {
    const created = engine();
    created.start([{ tabId: "tab-0", rect: { x: 0, y: 0, w: 1, h: 1 } }], "tab-0", ids);
    settle();
    const [only] = created.agentLayout().windows;
    // The whole desk is the room above the band.
    expect(only?.box).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    created.arrangeFor({ place: [{ tabId: "tab-0", zone: "bottom" }] });
    settle();
    const placed = created.agentLayout().windows[0]!.box;
    expect(placed.y + placed.h).toBeCloseTo(100, 0);
    created.destroy();
  });

  it("places, brings out and puts away without taking the keyboard", () => {
    const select = vi.fn();
    const created = engine({ select });
    created.start([], "tab-0", ids);
    settle();
    created.add("tab-1", { focus: false });
    settle();
    select.mockClear();
    const focused = created.focusedTabId();
    expect(created.arrangeFor({ place: [{ tabId: "tab-0", zone: "left" }, { tabId: "tab-2", zone: "right" }], putAway: ["tab-1"].filter((tabId) => tabId !== focused) })).toBeNull();
    settle();
    const layout = created.agentLayout();
    expect(layout.windows.find((window) => window.tabId === "tab-0")?.box).toEqual(percentBox(zoneRect("left", desk), desk));
    expect(layout.windows.find((window) => window.tabId === "tab-2")?.box).toEqual(percentBox(zoneRect("right", desk), desk));
    expect(created.focusedTabId()).toBe(focused);
    expect(select).not.toHaveBeenCalled();
    // The window in use stays on top; the one brought out went under it.
    expect(created.windowTabIds().at(-1)).toBe(focused);
    created.destroy();
  });

  it("refuses what it cannot do, and then moves nothing", () => {
    const created = engine();
    created.start([], "tab-0", ids);
    settle();
    const before = created.agentLayout();
    expect(created.arrangeFor({ place: [{ tabId: "tab-9", zone: "left" }] })).toMatch(/not on this desk/);
    expect(created.arrangeFor({ putAway: [created.focusedTabId()!] })).toMatch(/window in use/);
    expect(created.arrangeFor({ place: [{ tabId: "tab-1" }] })).toMatch(/zone or a box/);
    settle();
    expect(created.agentLayout()).toEqual(before);
    created.destroy();
  });

  it("brings a tab it opened out under the window in use, quietly", () => {
    const select = vi.fn();
    const created = engine({ select });
    created.start([], "tab-0", ids);
    settle();
    select.mockClear();
    created.bringOutQuietly("tab-3");
    settle();
    expect(created.windowTabIds()).toEqual(["tab-3", "tab-0"]);
    expect(created.focusedTabId()).toBe("tab-0");
    expect(select).not.toHaveBeenCalled();
    // Not one of the group's (yet): nothing comes out.
    created.bringOutQuietly("tab-9");
    expect(created.windowTabIds()).toHaveLength(2);
    created.destroy();
  });

  it("puts every window back where it was on Undo layout", () => {
    const created = engine();
    created.start([], "tab-0", ids);
    settle();
    created.add("tab-1", { focus: false });
    settle();
    const before = created.layoutSnapshot();
    const layoutBefore = created.agentLayout();
    created.arrangeFor({ bringOut: ["tab-2", "tab-3"], layout: "tile" });
    settle();
    expect(created.windowTabIds()).toHaveLength(4);
    created.restoreLayout(before);
    settle();
    expect(created.agentLayout()).toEqual(layoutBefore);
    created.destroy();
  });
});

describe("Undo layout mid-flight", () => {
  it("brings back a window the agent put away that is still on its way into the dock", () => {
    const created = engine();
    created.start([], "tab-0", ["tab-0", "tab-1", "tab-2"]);
    settle();
    created.add("tab-1", { focus: false });
    created.add("tab-2", { focus: false });
    settle();
    const before = created.layoutSnapshot();
    const layoutBefore = created.agentLayout();
    const away = before.windows.find((window) => window.tabId !== created.focusedTabId())!.tabId;
    expect(created.arrangeFor({ putAway: [away] })).toBeNull();
    // Undone at once, before the window has reached its icon.
    step(3);
    expect(created.windowTabIds()).toContain(away);
    created.restoreLayout(before);
    settle();
    expect(created.windowTabIds()).toContain(away);
    expect(created.agentLayout()).toEqual(layoutBefore);
    created.destroy();
  });

  it("turns a window back that is on its way into the dock when the agent brings it out again", () => {
    const created = engine();
    created.start([], "tab-0", ["tab-0", "tab-1"]);
    settle();
    created.add("tab-1", { focus: false });
    created.add("tab-0", { focus: true });
    settle();
    expect(created.arrangeFor({ putAway: ["tab-1"] })).toBeNull();
    step(3);
    expect(created.arrangeFor({ place: [{ tabId: "tab-1", zone: "right" }] })).toBeNull();
    settle();
    expect(created.windowTabIds()).toContain("tab-1");
    expect(created.agentLayout().windows.find((window) => window.tabId === "tab-1")?.box).toEqual(percentBox(zoneRect("right", desk), desk));
    created.destroy();
  });
});

describe("the desk's window limit, when a window turns back", () => {
  it("never has more windows out than main accepts", () => {
    const ids = Array.from({ length: MAX_DESK_WINDOWS + 1 }, (_, index) => `tab-${String(index)}`);
    const created = engine();
    created.start([], "tab-0", ids);
    settle();
    for (const tabId of ids.slice(1, MAX_DESK_WINDOWS)) created.add(tabId, { focus: false });
    settle();
    expect(created.windowTabIds()).toHaveLength(MAX_DESK_WINDOWS);
    // One more: the bottom window goes home to make room…
    expect(created.arrangeFor({ bringOut: [ids.at(-1)!] })).toBeNull();
    step(2);
    const evicted = ids.find((tabId) => !created.agentLayout().windows.some((window) => window.tabId === tabId))!;
    // …and is asked back at once, while it is still on its way.
    expect(created.arrangeFor({ bringOut: [evicted] })).toBeNull();
    created.restoreLayout(created.layoutSnapshot());
    settle();
    expect(created.windowTabIds().length).toBeLessThanOrEqual(MAX_DESK_WINDOWS);
    expect(created.windowTabIds()).toContain(evicted);
    created.destroy();
  });
});

describe("the desk's answers to main", () => {
  function answerer(created: DeskEngine, overrides: Partial<DeskAnswerDeps> = {}): DeskAnswerDeps {
    return {
      engine: created,
      groupId: () => "desk-a",
      title: () => "Lisbon",
      tab: (tabId) => ({ title: `Tab ${tabId}`, url: `https://${tabId}.example/` }),
      file: (itemId) => ({ name: `${itemId}.pdf` }),
      turn: () => ({ runId: "run-1", turns: 1 }),
      remember: vi.fn(),
      note: vi.fn(),
      wait: () => Promise.resolve(),
      ...overrides,
    };
  }

  it("refuses a request meant for another group's desk, before it moves anything", async () => {
    const created = engine();
    created.start([], "tab-0", ["tab-0", "tab-1", "tab-2"]);
    settle();
    created.add("tab-1", { focus: false });
    settle();
    const before = created.agentLayout();
    const deps = answerer(created, { groupId: () => "desk-b" });
    const request = { type: "arrange", groupId: "desk-a", plan: { layout: "tile", bringOut: ["tab-2"] } } as DeskRequest;
    const reply = await answerDeskRequest(deps, request);
    expect(reply.ok).toBe(false);
    settle();
    expect(created.agentLayout()).toEqual(before);
    expect(deps.remember).not.toHaveBeenCalled();
    const note = await answerDeskRequest(deps, { type: "note", groupId: "desk-a", tabId: "tab-0", text: "Lands 11:05" } as DeskRequest);
    expect(note.ok).toBe(false);
    expect(deps.note).not.toHaveBeenCalled();
    created.destroy();
  });

  it("keeps a tab's title and address within what main accepts", async () => {
    const created = engine();
    created.start([], "tab-0", ["tab-0", "tab-1"]);
    settle();
    const long = { title: "T".repeat(400), url: `https://long.example/${"a".repeat(3_000)}` };
    const reply = await answerDeskRequest(answerer(created, { tab: () => long }), { type: "state", groupId: "desk-a" } as DeskRequest);
    expect(isDeskReply(reply)).toBe(true);
    expect(reply.ok && reply.state.windows[0]!.title.length).toBeLessThanOrEqual(300);
    expect(reply.ok && reply.state.docked[0]!.url.length).toBeLessThanOrEqual(2_048);
    created.destroy();
  });
});

describe("a drop on the Stack", () => {
  function data(entries: Record<string, string>): DataTransfer {
    return { getData: (type: string) => entries[type] ?? "" } as unknown as DataTransfer;
  }

  it("is a link when it carries an address, and a snippet when it carries text", () => {
    expect(droppedText(data({ "text/uri-list": "https://hotel.example/booking/42", "text/plain": "Your booking" }))).toEqual({
      kind: "link",
      text: "Your booking",
      url: "https://hotel.example/booking/42",
    });
    expect(droppedText(data({ "text/plain": "https://air.example/pass" }))).toEqual({ kind: "link", text: "https://air.example/pass", url: "https://air.example/pass" });
    expect(droppedText(data({ "text/plain": "  Check-in from 15:00  " }))).toEqual({ kind: "snippet", text: "Check-in from 15:00" });
    expect(droppedText(data({}))).toBeNull();
  });
});
