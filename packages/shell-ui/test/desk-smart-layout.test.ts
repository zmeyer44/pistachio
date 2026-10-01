/**
 * The desk's smart layout (docs/desk-layout.md): the geometry each move
 * makes (lib/desk/smart-layout.ts), and the arranger that hears windows come
 * and go, asks the layout model, and lays the desk out with an Undo
 * (components/desk/smart-arrange.ts) — over a fake engine and a scripted
 * model, so what is pinned is what the desk does with an opinion.
 */

import { describe, expect, it } from "vitest";
import type { DeskLayoutEvaluation, DeskLayoutMove, DeskLayoutRequest } from "@pistachio/shell-contracts/desk-layout";
import { DESK_GAP, splitRect, tileRects, zoneRect, type Rect } from "../src/lib/desk/geometry";
import { FOCUS_SHARE, changesLayout, fillGap, focusLayout, offeredMoves, pairedLayout, placeWords, tiledLayout } from "../src/lib/desk/smart-layout";
import { CLOSE_SETTLE_MS, SmartArranger, type SmartArrangeEngine, type WindowWords } from "../src/components/desk/smart-arrange";
import type { DeskLayoutMoment, DeskLayoutSnapshot, DeskLayoutView } from "../src/components/desk/desk-engine";

const desk: Rect = { x: 68, y: 0, w: 1372, h: 840 };
const zone = (name: Parameters<typeof zoneRect>[0]): Rect => zoneRect(name, desk);

function expectRect(actual: Rect | undefined, expected: Rect): void {
  expect(actual).toBeDefined();
  for (const key of ["x", "y", "w", "h"] as const) expect(Math.abs(actual![key] - expected[key]), `${key}: ${actual![key]} vs ${expected[key]}`).toBeLessThanOrEqual(0.5);
}

describe("closing up a gap", () => {
  it("lets the other side of a split take the whole desk", () => {
    const grown = fillGap(new Map([["left", zone("left")]]), zone("right"))!;
    expectRect(grown.get("left"), desk);
  });

  it("grows the one window that exactly borders the gap, rather than a row of them or one reaching past it", () => {
    const three = new Map([
      ["half", zone("left")],
      ["bottom", zone("bottom-right")],
    ]);
    // The top-right quarter closed: the quarter below takes the whole column (the half beside it reaches past the gap).
    const grown = fillGap(three, zone("top-right"))!;
    expect([...grown.keys()]).toEqual(["bottom"]);
    expectRect(grown.get("bottom"), zone("right"));
    // The half closed: both quarters beside it grow across.
    const quarters = new Map([
      ["top", zone("top-right")],
      ["bottom", zone("bottom-right")],
    ]);
    const across = fillGap(quarters, zone("left"))!;
    expectRect(across.get("top"), { ...zone("top-right"), x: desk.x, w: desk.w });
    expectRect(across.get("bottom"), { ...zone("bottom-right"), x: desk.x, w: desk.w });
  });

  it("leaves a gap among loose windows alone", () => {
    const loose = new Map([["a", { x: 200, y: 100, w: 500, h: 400 }]]);
    expect(fillGap(loose, { x: 760, y: 100, w: 500, h: 400 })).toBeNull();
  });
});

describe("laying the desk out", () => {
  it("tiles with each window going to the tile nearest it, the main window first", () => {
    const windows = new Map([
      ["right", { x: 900, y: 100, w: 400, h: 300 }],
      ["left", { x: 100, y: 100, w: 400, h: 300 }],
    ]);
    const nearest = tiledLayout(windows, desk, null);
    expectRect(nearest.get("left"), zone("left"));
    expectRect(nearest.get("right"), zone("right"));
    const three = new Map([...windows, ["below", { x: 900, y: 600, w: 300, h: 200 }]]);
    const mainFirst = tiledLayout(three, desk, "right");
    // Three windows: the first tile is the left half, the main window's.
    expectRect(mainFirst.get("right"), tileRects(3, desk)[0]!);
  });

  it("gives the main window most of the desk and stacks the rest beside it, top to bottom as they stand", () => {
    const windows = new Map([
      ["doc", zone("right")],
      ["lower", zone("bottom-left")],
      ["upper", zone("top-left")],
    ]);
    const layout = focusLayout(windows, desk, "doc")!;
    const mainW = Math.round((desk.w - DESK_GAP) * FOCUS_SHARE);
    expectRect(layout.get("doc"), { x: desk.x, y: 0, w: mainW, h: desk.h });
    const cellH = (desk.h - DESK_GAP) / 2;
    expectRect(layout.get("upper"), { x: desk.x + mainW + DESK_GAP, y: 0, w: desk.w - mainW - DESK_GAP, h: cellH });
    expectRect(layout.get("lower"), { x: desk.x + mainW + DESK_GAP, y: cellH + DESK_GAP, w: desk.w - mainW - DESK_GAP, h: cellH });
    // More beside it than its column holds: no such layout.
    const crowd = new Map(Array.from({ length: 7 }, (_, index) => [`w${String(index)}`, { x: 100 + index, y: 100, w: 300, h: 200 }] as const));
    expect(focusLayout(crowd, desk, "w0")).toBeNull();
  });

  it("sets a new window beside the one it goes with, putting back the one it split", () => {
    const before = new Map([
      ["inbox", zone("left")],
      ["invoice", zone("right")],
    ]);
    const layout = pairedLayout(before, "vendor", "invoice")!;
    const halves = splitRect(zone("right"))!;
    expectRect(layout.get("inbox"), zone("left"));
    expectRect(layout.get("invoice"), halves[0]);
    expectRect(layout.get("vendor"), halves[1]);
  });

  it("offers only the moves the desk can make", () => {
    const halves = new Map([
      ["a", zone("left")],
      ["b", zone("right")],
    ]);
    expect(offeredMoves("asked", halves, desk)).toEqual(["tile", "focus"]);
    expect(offeredMoves("closed", new Map([["a", zone("left")]]), desk, { gaps: [zone("right")] })).toEqual(["keep", "fill", "tile"]);
    expect(offeredMoves("opened", halves, desk, { before: new Map([["a", desk]]), opened: "b", how: "split" })).toEqual(["keep", "pair", "tile", "focus"]);
    // Come out into a tiled desk's hole: where it belongs already.
    expect(offeredMoves("opened", halves, desk, { before: new Map([["a", zone("left")]]), opened: "b", how: "hole" })).toEqual(["keep", "tile", "focus"]);
  });

  it("says where a window is in words", () => {
    expect(placeWords(desk, desk)).toBe("the whole desk");
    expect(placeWords(zone("top-right"), desk)).toBe("the top-right quarter of the desk");
    expect(placeWords({ x: 1200, y: 600, w: 200, h: 200 }, desk, [{ x: 1100, y: 500, w: 300, h: 300 }])).toBe("a small window at the bottom right, overlapping others");
  });
});

/* -------------------------------- the arranger -------------------------------- */

/** An engine with windows and nothing else: moments are emitted by hand. */
function fakeEngine(initial: Array<[string, Rect]>) {
  const windows = new Map(initial);
  const listeners = new Set<(moment: DeskLayoutMoment) => void>();
  let inUse: string | null = initial.at(-1)?.[0] ?? null;
  const stampOf = (): string => [...windows].map(([id, rect]) => `${id}:${rect.x},${rect.y},${rect.w},${rect.h}`).join("|");
  const engine: SmartArrangeEngine & { windows: Map<string, Rect>; emit(moment: DeskLayoutMoment): void; use(id: string): void } = {
    windows,
    emit: (moment) => listeners.forEach((listener) => listener(moment)),
    use: (id) => (inUse = id),
    onLayoutMoment(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    layoutView: (): DeskLayoutView => ({ bounds: desk, windows: new Map(windows), others: [], inUse, stamp: stampOf() }),
    applyLayout(layout) {
      const undo: DeskLayoutSnapshot = { windows: [...windows].map(([tabId, rect]) => ({ tabId, rect, mini: null })) };
      for (const [id, rect] of layout) windows.set(id, rect);
      return undo;
    },
    restoreLayout(snapshot) {
      windows.clear();
      for (const entry of snapshot.windows) windows.set(entry.tabId, entry.rect);
    },
  };
  return engine;
}

const WORDS: Record<string, WindowWords> = {
  inbox: { title: "Inbox (12) - Gmail", site: "mail.google.com", kind: "page" },
  invoice: { title: "Invoice #2048 - QuickBooks", site: "qbo.intuit.com", kind: "page" },
  vendor: { title: "Atlas Medical Supply - Vendor record", site: "northstar.demo", kind: "page" },
  ci: { title: "CI run #8812 - GitHub Actions", site: "github.com", kind: "page" },
  pr: { title: "Pull request #412 - GitHub", site: "github.com", kind: "page" },
};

/** The model's opinion, as scripted: one move, sure of it, and the windows it names. */
function opinion(move: DeskLayoutMove, names: { main?: string; partner?: string } = {}): (request: DeskLayoutRequest) => DeskLayoutEvaluation {
  return (request) => ({
    moves: { keep: 0, fill: 0, pair: 0, tile: 0, focus: 0, [move]: 0.9 },
    main: Object.fromEntries(request.windows.map((window) => [window.id, window.id === names.main ? 0.9 : 0.05])),
    partner: request.trigger === "opened" ? Object.fromEntries(request.windows.filter((window) => !window.opened).map((window) => [window.id, window.id === names.partner ? 0.9 : 0.05])) : null,
    confidence: 0.9,
    latencyMs: 1,
  });
}

function arranger(engine: ReturnType<typeof fakeEngine>, answer: ((request: DeskLayoutRequest) => DeskLayoutEvaluation | null) | null, options: { auto?: boolean; busy?: boolean } = {}) {
  /** The Feel's Layout, the agent, and the group whose desk this is — each may change while a question waits. */
  const state = { auto: options.auto ?? true, busy: options.busy ?? false, group: "a" };
  const asked: DeskLayoutRequest[] = [];
  const notices: Array<{ message: string; undo: (() => void) | null }> = [];
  const timers: Array<{ run: () => void; at: number; cancelled: boolean }> = [];
  /** Answers held until released, so a test can change the desk while the model thinks. */
  const held: Array<() => void> = [];
  let holding = false;
  const arranged = new SmartArranger(engine, {
    auto: () => state.auto,
    busy: () => state.busy,
    group: () => state.group,
    judge:
      answer === null
        ? null
        : (request) => {
            asked.push(request);
            const result = answer(request);
            return holding ? new Promise((resolve) => held.push(() => resolve(result))) : Promise.resolve(result);
          },
    describe: (id) => WORDS[id] ?? null,
    notify: (message, undo) => notices.push({ message, undo }),
    later: (run, ms) => {
      const timer = { run, at: ms, cancelled: false };
      timers.push(timer);
      return () => (timer.cancelled = true);
    },
  });
  const flush = async (): Promise<void> => {
    for (let round = 0; round < 5; round += 1) await Promise.resolve();
  };
  const tick = async (): Promise<void> => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run();
    await flush();
  };
  return { arranged, asked, notices, timers, tick, flush, state, hold: () => (holding = true), release: () => held.splice(0).forEach((go) => go()) };
}

describe("the arranger", () => {
  it("sets a window just out beside the window it goes with, says so, and Undo puts it back", async () => {
    const before = new Map([
      ["inbox", zone("left")],
      ["invoice", zone("right")],
    ]);
    const halves = splitRect(zone("left"))!;
    // The rule placed the vendor record in half of the inbox's place (the window in use).
    const engine = fakeEngine([
      ["inbox", halves[0]],
      ["invoice", zone("right")],
      ["vendor", halves[1]],
    ]);
    const { asked, notices, flush } = arranger(engine, opinion("pair", { partner: "invoice" }));
    engine.emit({ trigger: "opened", id: "vendor", how: "split", before });
    await flush();
    expect(asked).toHaveLength(1);
    const request = asked[0]!;
    expect(request.moves).toEqual(["keep", "pair", "tile", "focus"]);
    expect(request.windows.find((window) => window.opened)!.place).toContain('beside "Inbox (12) - Gmail"');
    expectRect(engine.windows.get("inbox"), zone("left"));
    expectRect(engine.windows.get("invoice"), splitRect(zone("right"))![0]);
    expectRect(engine.windows.get("vendor"), splitRect(zone("right"))![1]);
    expect(notices.map((notice) => notice.message)).toEqual(["Put “Atlas Medical Supply - Vendor r…” beside “Invoice #2048 - QuickBooks”"]);
    notices[0]!.undo!();
    expectRect(engine.windows.get("inbox"), halves[0]);
    expectRect(engine.windows.get("vendor"), halves[1]);
  });

  it("asks once about closes in a row, and closes the gaps up", async () => {
    const engine = fakeEngine([["pr", zone("top-left")]]);
    const { asked, notices, tick, timers } = arranger(engine, opinion("fill"));
    engine.emit({ trigger: "closed", gone: [{ id: "ci", rect: zone("bottom-left"), how: "closed" }] });
    engine.emit({ trigger: "closed", gone: [{ id: "inbox", rect: zone("right"), how: "collapsed" }] });
    expect(timers.filter((timer) => !timer.cancelled)).toHaveLength(1);
    expect(timers.at(-1)!.at).toBe(CLOSE_SETTLE_MS);
    await tick();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.gone.map((gone) => gone.title)).toEqual(["CI run #8812 - GitHub Actions", "Inbox (12) - Gmail"]);
    expect(asked[0]!.fillers).toEqual(["Pull request #412 - GitHub"]);
    expectRect(engine.windows.get("pr"), desk);
    expect(notices[0]!.message).toBe("“Pull request #412 - GitHub” took the space");
  });

  it("drops an answer about a desk that changed while the model thought, or that a newer question superseded", async () => {
    const engine = fakeEngine([["pr", zone("left")]]);
    const { asked, notices, tick, hold, release, flush } = arranger(engine, opinion("fill"));
    hold();
    engine.emit({ trigger: "closed", gone: [{ id: "ci", rect: zone("right"), how: "closed" }] });
    await tick();
    expect(asked).toHaveLength(1);
    // The person moved the window meanwhile.
    engine.windows.set("pr", { x: 300, y: 100, w: 600, h: 500 });
    release();
    await flush();
    expectRect(engine.windows.get("pr"), { x: 300, y: 100, w: 600, h: 500 });
    expect(notices).toHaveLength(0);
  });

  it("moves nothing on its own with Layout set to By hand, or while the agent is at work; asked, it still arranges", async () => {
    for (const options of [{ auto: false }, { busy: true }]) {
      const engine = fakeEngine([["pr", zone("left")]]);
      const { asked, tick, arranged, notices } = arranger(engine, opinion("fill"), options);
      engine.emit({ trigger: "closed", gone: [{ id: "ci", rect: zone("right"), how: "closed" }] });
      await tick();
      expect(asked).toHaveLength(0);
      expectRect(engine.windows.get("pr"), zone("left"));
      await arranged.ask();
      expect(asked).toHaveLength(1);
      expectRect(engine.windows.get("pr"), desk);
      expect(notices[0]!.message).toBe("Tiled the windows");
    }
  });

  it("asked with no model to ask, tiles; asked when the desk is laid out so already, says so", async () => {
    const engine = fakeEngine([
      ["inbox", { x: 100, y: 100, w: 500, h: 400 }],
      ["invoice", { x: 700, y: 200, w: 500, h: 400 }],
    ]);
    const { arranged, notices } = arranger(engine, null);
    await arranged.ask();
    expectRect(engine.windows.get("inbox"), zone("left"));
    expectRect(engine.windows.get("invoice"), zone("right"));
    await arranged.ask();
    expect(notices.map((notice) => notice.message)).toEqual(["Tiled the windows", "The windows are laid out that way already"]);
    expect(notices[1]!.undo).toBeNull();
  });

  it("gives the main window the main place when asked", async () => {
    const engine = fakeEngine([
      ["inbox", zone("left")],
      ["invoice", zone("right")],
    ]);
    const { arranged, notices, asked } = arranger(engine, opinion("focus", { main: "invoice" }));
    await arranged.ask();
    expect(asked[0]!.moves).toEqual(["tile", "focus"]);
    expect(changesLayout(new Map([["invoice", zone("right")]]), engine.windows)).toBe(true);
    expect(engine.windows.get("invoice")!.x).toBe(desk.x);
    expect(notices[0]!.message).toBe("Gave “Invoice #2048 - QuickBooks” the main place");
  });

  it("puts nothing back on another group's desk: Undo is for the desk it was offered on", async () => {
    const engine = fakeEngine([["pr", zone("left")]]);
    const { notices, tick, state } = arranger(engine, opinion("fill"));
    engine.emit({ trigger: "closed", gone: [{ id: "ci", rect: zone("right"), how: "closed" }] });
    await tick();
    expectRect(engine.windows.get("pr"), desk);
    // The desk passes to another group, whose windows come out; Undo is clicked there.
    state.group = "b";
    engine.windows.clear();
    engine.windows.set("inbox", zone("left"));
    engine.windows.set("invoice", zone("right"));
    notices[0]!.undo!();
    expect([...engine.windows.keys()]).toEqual(["inbox", "invoice"]);
    expectRect(engine.windows.get("inbox"), zone("left"));
    // Back on the group it was offered on, it still works.
    state.group = "a";
    engine.windows.clear();
    engine.windows.set("pr", desk);
    notices[0]!.undo!();
    expectRect(engine.windows.get("pr"), zone("left"));
  });

  it("forgets a close held when the desk passes to another group, rather than filling that desk's gaps", async () => {
    const engine = fakeEngine([["pr", zone("left")]]);
    const { asked, notices, tick, state } = arranger(engine, opinion("fill"));
    engine.emit({ trigger: "closed", gone: [{ id: "ci", rect: zone("right"), how: "closed" }] });
    // Within the moment a close waits, the desk passes to a group with a window where the gap was not.
    state.group = "b";
    engine.windows.clear();
    engine.windows.set("inbox", zone("top-left"));
    await tick();
    expect(asked).toHaveLength(0);
    expectRect(engine.windows.get("inbox"), zone("top-left"));
    // A close there is held; the desk passes back, and a close on it is asked about alone.
    engine.emit({ trigger: "closed", gone: [{ id: "ci", rect: zone("bottom-left"), how: "closed" }] });
    state.group = "a";
    engine.windows.clear();
    engine.windows.set("pr", zone("left"));
    engine.emit({ trigger: "closed", gone: [{ id: "invoice", rect: zone("right"), how: "closed" }] });
    await tick();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.gone.map((gone) => gone.title)).toEqual(["Invoice #2048 - QuickBooks"]);
    expect(notices).toHaveLength(1);
  });

  it("moves nothing on its own once Layout is By hand or the agent is at work, if that happens while it waits or the model thinks", async () => {
    // Set to By hand while a close waits.
    const waiting = fakeEngine([["pr", zone("left")]]);
    const first = arranger(waiting, opinion("fill"));
    waiting.emit({ trigger: "closed", gone: [{ id: "ci", rect: zone("right"), how: "closed" }] });
    first.state.auto = false;
    await first.tick();
    expect(first.asked).toHaveLength(0);
    expectRect(waiting.windows.get("pr"), zone("left"));
    // The agent starts a turn while the model thinks.
    const thinking = fakeEngine([["pr", zone("left")]]);
    const second = arranger(thinking, opinion("fill"));
    second.hold();
    thinking.emit({ trigger: "closed", gone: [{ id: "ci", rect: zone("right"), how: "closed" }] });
    await second.tick();
    expect(second.asked).toHaveLength(1);
    second.state.busy = true;
    second.release();
    await second.flush();
    expectRect(thinking.windows.get("pr"), zone("left"));
    expect(second.notices).toHaveLength(0);
    // Asked by the person, it arranges whatever the Layout.
    second.state.busy = false;
    second.state.auto = false;
    second.hold();
    const asking = second.arranged.ask();
    second.state.busy = true;
    second.release();
    await asking;
    expectRect(thinking.windows.get("pr"), desk);
  });
});
