import { describe, expect, it } from "vitest";
import { activeIntervals, boxAt, bursts, chapterAt, chaptersOf, chordTrack, clicksOf, loadsOf, parseEvents, pointerAt, scrollRuns, secretSpans, streamOffset, typingBursts } from "../src/lib/events.js";
import type { RecordedEvent } from "../src/lib/types.js";
import { FIXTURE_TEXT, load } from "./fixtures.js";

describe("parseEvents", () => {
  it("puts every position in the first view's units: input after the window resized is scaled by the box it came in", () => {
    const meta = `{"t":0,"k":"meta","capture":{"w":3200,"h":1800,"dpr":2},"view":{"w":1600,"h":900},"fps":60,"startedAt":0}`;
    const lines = [
      meta,
      `{"t":10,"k":"box","view":{"x":0,"y":0,"w":1600,"h":900},"visible":true}`,
      `{"t":20,"k":"down","x":800,"y":450,"button":"left","target":{"x":700,"y":400,"w":200,"h":100,"role":"button"}}`,
      `{"t":30,"k":"box","view":{"x":0,"y":0,"w":800,"h":450},"visible":true}`,
      `{"t":40,"k":"move","x":400,"y":225}`,
      `{"t":50,"k":"down","x":400,"y":225,"button":"left","target":{"x":350,"y":200,"w":100,"h":50,"role":"button"}}`,
      `{"t":60,"k":"caret","rect":{"x":10,"y":20,"w":2,"h":16}}`,
      `{"t":70,"k":"focus","rect":{"x":100,"y":100,"w":200,"h":30},"secret":false}`,
      `{"t":80,"k":"scroll","x":0,"y":300}`,
    ];
    const { events } = parseEvents(`${lines.join("\n")}\n`);
    expect(events[1]).toMatchObject({ k: "down", x: 800, y: 450, target: { x: 700, y: 400, w: 200, h: 100 } });
    // The box is kept as reported — its size is how a resize is known — and what follows is in the first view's units.
    expect(events[2]).toMatchObject({ k: "box", view: { w: 800, h: 450 } });
    expect(events[3]).toMatchObject({ k: "move", x: 800, y: 450 });
    expect(events[4]).toMatchObject({ k: "down", x: 800, y: 450, target: { x: 700, y: 400, w: 200, h: 100, role: "button" } });
    expect(events[5]).toMatchObject({ k: "caret", rect: { x: 20, y: 40, w: 4, h: 32 } });
    expect(events[6]).toMatchObject({ k: "focus", rect: { x: 200, y: 200, w: 400, h: 60 } });
    // A scroll offset is the page's, not the view's.
    expect(events[7]).toMatchObject({ k: "scroll", x: 0, y: 300 });
  });

  it("drops a torn last line, a corrupt line and an unknown kind, never throwing", () => {
    const { meta, events } = parseEvents(FIXTURE_TEXT.torn);
    expect(meta.k).toBe("meta");
    expect(meta.source.title).toBe("Linear");
    expect(meta.view).toEqual({ w: 1600, h: 900 });
    expect(meta.capture.dpr).toBe(2);
    expect(events.map((e) => e.k)).toEqual(["move", "down", "up", "cursor", "focus", "key", "nav"]);
  });

  it("sorts events by t and repairs the old fields", () => {
    const { events } = parseEvents(FIXTURE_TEXT.torn);
    for (let i = 1; i < events.length; i++) expect(events[i]!.t).toBeGreaterThanOrEqual(events[i - 1]!.t);
    const down = events.find((e) => e.k === "down");
    expect(down).toMatchObject({ t: 980.1, button: "left", target: { x: 760, y: 300, w: 120, h: 36, role: "button" } });
    expect(events.find((e) => e.k === "focus")).toMatchObject({ secret: false });
  });

  it("fills a meta line's missing fields from what it has", () => {
    const { meta } = parseEvents(`{"t":0,"k":"meta","capture":{"w":3200,"h":1800,"dpr":2}}\n`);
    expect(meta.view).toEqual({ w: 1600, h: 900 });
    expect(meta.fps).toBe(60);
    expect(meta.source.url).toBe("");
    expect(meta.offsets).toBeUndefined();
    expect(meta.cursorBaked).toBeUndefined();
    expect(streamOffset(meta, "mic")).toBe(0);
  });

  it("keeps the engine's stream offsets and whether the cursor is in the pixels", () => {
    const { meta } = parseEvents(`{"t":0,"k":"meta","capture":{"w":3200,"h":1800,"dpr":2},"offsets":{"mic":42.5,"camera":"x"},"cursorBaked":true}\n`);
    expect(meta.offsets).toEqual({ mic: 42.5 });
    expect(meta.cursorBaked).toBe(true);
    expect(streamOffset(meta, "mic")).toBeCloseTo(0.0425, 9);
    expect(streamOffset(meta, "camera")).toBe(0);
  });

  it("throws only when there is no meta line at all", () => {
    expect(() => parseEvents(`{"t":1,"k":"move","x":1,"y":2}\n{"t":2,"k":"mo`)).toThrow(/meta/);
    expect(parseEvents(`{"t":0,"k":"meta","view":{"w":800,"h":600}}`).events).toEqual([]);
  });
});

describe("chapters", () => {
  it("come from nav events, a repeated title skipped", () => {
    const { events } = load("nav");
    const chapters = chaptersOf(events);
    expect(chapters.map((c) => c.title)).toEqual(["Issue LIN-42", "Inbox", "Settings"]);
    expect(chapters[0]).toEqual({ tSrc: 2.55, url: "https://linear.app/issue/LIN-42", title: "Issue LIN-42" });
    expect(chapterAt(chapters, 1)).toBeNull();
    expect(chapterAt(chapters, 5.5)?.title).toBe("Issue LIN-42");
    expect(chapterAt(chapters, 6.5)?.title).toBe("Inbox");
  });
});

describe("pointerAt", () => {
  const events: RecordedEvent[] = [
    { t: 1000, k: "move", x: 100, y: 100 },
    { t: 1010, k: "move", x: 110, y: 120 },
    { t: 2010, k: "move", x: 300, y: 300 },
  ];

  it("is null before the first sample and holds the last", () => {
    expect(pointerAt(events, 0.5)).toBeNull();
    expect(pointerAt(events, 9)).toEqual({ x: 300, y: 300 });
  });

  it("interpolates linearly between samples", () => {
    const p = pointerAt(events, 1.005)!;
    expect(p.x).toBeCloseTo(105, 6);
    expect(p.y).toBeCloseTo(110, 6);
  });

  it("holds through a still gap, moving only in its last moment", () => {
    expect(pointerAt(events, 1.5)).toEqual({ x: 110, y: 120 });
    expect(pointerAt(events, 2.0)!.x).toBeGreaterThan(110);
  });
});

describe("the views the solvers use", () => {
  it("bursts group like events by a gap", () => {
    const { events } = load("typing");
    const typed = bursts(events, "char", 0.45);
    expect(typed).toHaveLength(1);
    expect(typed[0]).toMatchObject({ t0: 1.8, count: 16 });
    expect(typed[0]!.t1).toBeCloseTo(4.8, 6);
    expect(bursts(events, "chord", 0.45)).toEqual([{ t0: 5.5, t1: 5.8, count: 2 }]);
    expect(bursts(events, "chord", 0.2)).toHaveLength(2);
    expect(bursts(events, "down", 0.45)).toHaveLength(1);
  });

  it("clicks, scroll runs, loads and the box", () => {
    expect(clicksOf(load("click").events).map((c) => c.t)).toEqual([2, 6]);
    const runs = scrollRuns(load("scroll").events);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.t1 - runs[0]!.t0).toBeGreaterThan(0.6);
    expect(loadsOf(load("nav").events)).toEqual([[2.1, 2.5]]);
    const click = load("click").events;
    expect(boxAt(click, 0)).toBeNull();
    expect(boxAt(click, 1)).toEqual({ view: { x: 312, y: 88, w: 1600, h: 900 }, visible: true });
  });

  it("a password field's focus opens a secret span; keys inside it type nothing and show no chip", () => {
    const { events } = load("password");
    expect(secretSpans(events)).toEqual([[4.52, 6]]);
    const typed = typingBursts(events);
    expect(typed).toHaveLength(1);
    expect(typed[0]!.t0).toBeCloseTo(1.4, 6);
    const chip = chordTrack(events);
    expect(chip(5.1)).toBeNull();
    expect(chip(6.6)).toBe("⌘K");
    expect(chip(8)).toBeNull();
  });

  it("activity: input and moves within ±0.3 s, a page painting — but not a caret blinking", () => {
    const active = activeIntervals(load("idle").events);
    const covers = (t: number) => active.some(([a, b]) => t >= a && t <= b);
    expect(covers(1.0)).toBe(true);
    expect(covers(4.0)).toBe(false);
    expect(covers(12.0)).toBe(false); // 2 Hz caret frames
    expect(covers(28.5)).toBe(true); // 60 Hz animation frames
  });
});
