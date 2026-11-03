import { describe, expect, it } from "vitest";
import type { Project, ZoomSegment } from "../src/lib/types.js";
import { History } from "../src/editor/history.js";
import {
  NONE,
  addSpeedOver,
  addZoomAt,
  aimZoom,
  deleteSelection,
  dragSpan,
  joinGap,
  mergeAutoZooms,
  removeRange,
  resizeZoom,
  roomFor,
  splitAt,
  stringifyProject,
  validSelection,
  viewportOf,
} from "../src/editor/model.js";
import { eventMarks, exportName, exportSizeAllowed, formatClock, levelText } from "../src/editor/derive.js";
import { readProject, writeProject } from "../src/lib/project.js";

function zoom(id: string, start: number, end: number, auto = true, level = 2): ZoomSegment {
  return { id, start, end, level, center: [0.5, 0.5], auto, ease: "spring", follow: true };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    v: 1,
    cuts: [{ in: 0, out: 30 }],
    zooms: [],
    speed: [],
    zoom: { auto: true, feel: "mellow", maxLevel: 2.5 },
    look: { background: { type: "wallpaper", id: "dawn" }, padding: 0.08, radius: 14, shadow: 0.6, frame: "browser", aspect: "16:9" },
    cursor: { mode: "natural", size: 1.6, smoothing: 0.6, hideIdle: true, click: "ripple" },
    camera: { shape: "circle", size: 0.18, corner: "br", shrinkOnZoom: true },
    audio: { mic: 1, page: 0.6, muteSpedUp: true },
    export: { format: "mp4-h264", height: 1080, fps: 60, quality: "high" },
    ...overrides,
  };
}

describe("the clip", () => {
  it("splits the piece under the playhead without removing time", () => {
    expect(splitAt([{ in: 0, out: 30 }], 12)).toEqual([
      { in: 0, out: 12 },
      { in: 12, out: 30 },
    ]);
    expect(splitAt([{ in: 0, out: 30 }], 0.05)).toBeNull();
    expect(splitAt([{ in: 0, out: 10 }, { in: 20, out: 30 }], 15)).toBeNull();
  });

  it("cuts a range out, across pieces, never everything", () => {
    expect(removeRange([{ in: 0, out: 30 }], 10, 14)).toEqual([
      { in: 0, out: 10 },
      { in: 14, out: 30 },
    ]);
    expect(removeRange([{ in: 0, out: 10 }, { in: 12, out: 30 }], 8, 20)).toEqual([
      { in: 0, out: 8 },
      { in: 20, out: 30 },
    ]);
    expect(removeRange([{ in: 0, out: 30 }], 0, 30)).toBeNull();
    expect(removeRange([{ in: 0, out: 10 }, { in: 20, out: 30 }], 12, 18)).toBeNull();
  });

  it("joins a scissors marker back, restoring the cut-away time", () => {
    expect(joinGap([{ in: 0, out: 10 }, { in: 14, out: 30 }], 0)).toEqual([{ in: 0, out: 30 }]);
    expect(joinGap([{ in: 0, out: 30 }], 0)).toBeNull();
  });
});

describe("⌫ on the selection", () => {
  it("deletes a zoom, a speed segment, a range, a piece, a gap", () => {
    const p = project({ zooms: [zoom("z1", 1, 3)], speed: [{ id: "s1", start: 5, end: 8, rate: 4, auto: "idle" }], cuts: [{ in: 0, out: 10 }, { in: 12, out: 30 }] });
    expect(deleteSelection(p, { kind: "zoom", id: "z1" })?.project.zooms).toEqual([]);
    expect(deleteSelection(p, { kind: "speed", id: "s1" })?.project.speed).toEqual([]);
    expect(deleteSelection(p, { kind: "range", start: 20, end: 25 })?.project.cuts).toEqual([
      { in: 0, out: 10 },
      { in: 12, out: 20 },
      { in: 25, out: 30 },
    ]);
    expect(deleteSelection(p, { kind: "clip", index: 0 })?.project.cuts).toEqual([{ in: 12, out: 30 }]);
    expect(deleteSelection(p, { kind: "gap", index: 0 })?.project.cuts).toEqual([{ in: 0, out: 30 }]);
    expect(deleteSelection(p, NONE)).toBeNull();
    expect(deleteSelection(p, { kind: "zoom", id: "missing" })).toBeNull();
  });

  it("forgets a selection that no longer names anything", () => {
    const p = project({ zooms: [zoom("z1", 1, 3)] });
    expect(validSelection(p, { kind: "zoom", id: "z1" })).toEqual({ kind: "zoom", id: "z1" });
    expect(validSelection(p, { kind: "zoom", id: "z9" })).toEqual(NONE);
    expect(validSelection(p, { kind: "gap", index: 0 })).toEqual(NONE);
  });
});

describe("zoom segments", () => {
  it("adds a touched zoom at the playhead, centred on the cursor, pushing auto ones aside", () => {
    const p = project({ zooms: [zoom("z1", 4, 7), zoom("z2", 20, 22, false)] });
    const added = addZoomAt(p, 5, [0.1, 0.9], 30);
    expect(added).not.toBeNull();
    const segment = added!.project.zooms.find((z) => z.id === added!.id)!;
    expect(segment).toMatchObject({ start: 5, end: 7.5, auto: false, level: 2 });
    // Clamped so the viewport stays inside the content.
    expect(segment.center).toEqual([0.25, 0.75]);
    expect(added!.project.zooms.some((z) => z.id === "z1")).toBe(false);
  });

  it("fits a new zoom before a touched one, and selects a touched one it lands in", () => {
    const p = project({ zooms: [zoom("z2", 6, 9, false)] });
    const before = addZoomAt(p, 5, [0.5, 0.5], 30)!;
    expect(before.project.zooms.find((z) => z.id === before.id)).toMatchObject({ start: 5, end: 6 });
    expect(addZoomAt(p, 7, [0.5, 0.5], 30)).toEqual({ project: p, id: "z2" });
  });

  it("re-solves the auto zooms around the touched ones", () => {
    const touched = zoom("z1", 2, 5, false);
    const current = [touched, zoom("z2", 8, 10)];
    const solved = [zoom("z1", 1, 3), zoom("z5", 12, 14)];
    const merged = mergeAutoZooms(current, solved, true);
    expect(merged.map((z) => [z.id, z.start, z.auto])).toEqual([
      ["z1", 2, false],
      ["z5", 12, true],
    ]);
    expect(mergeAutoZooms(current, solved, false)).toEqual([touched]);
  });

  it("aims and resizes the rectangle, marking the segment touched", () => {
    const segment = zoom("z1", 0, 2, true, 2);
    expect(viewportOf(segment)).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(aimZoom(segment, [0.9, 0.1])).toMatchObject({ center: [0.75, 0.25], auto: false });
    // Dragging the bottom-right corner out from the top-left anchor halves the level.
    const bigger = resizeZoom(segment, { x: 0, y: 0 }, { x: 0.8, y: 0.6 }, 2.5);
    expect(bigger.level).toBeCloseTo(1.25);
    expect(bigger.center[0]).toBeCloseTo(0.4);
    expect(bigger.auto).toBe(false);
    // Never past the max level.
    expect(resizeZoom(segment, { x: 0, y: 0 }, { x: 0.01, y: 0.01 }, 2.5).level).toBeCloseTo(2.5);
    // Re-aimed by hand, the solver's pan anchors go (they would pull back toward the old aim).
    const anchored: ZoomSegment = { ...segment, anchors: [[0.3, 0.3, 0.5], [0.6, 0.6, 1.5]] };
    expect(aimZoom(anchored, [0.5, 0.5])).not.toHaveProperty("anchors");
    expect(resizeZoom(anchored, { x: 0, y: 0 }, { x: 0.8, y: 0.6 }, 2.5)).not.toHaveProperty("anchors");
  });
});

describe("speed segments", () => {
  it("adds 2× over a span, splitting what was under it", () => {
    const p = project({ speed: [{ id: "s1", start: 0, end: 10, rate: 4, auto: "idle" }] });
    const added = addSpeedOver(p, 4, 6, 2, 30)!;
    expect(added.project.speed.map((s) => [s.id, s.start, s.end, s.rate])).toEqual([
      ["s1", 0, 4, 4],
      [added.id, 4, 6, 2],
      ["s2", 6, 10, 4],
    ]);
    expect(addSpeedOver(p, 4, 4.1, 2, 30)).toBeNull();
  });
});

describe("dragging a segment", () => {
  it("moves the body inside its room and keeps edges a minimum apart", () => {
    const items = [zoom("a", 0, 2), zoom("b", 5, 8), zoom("c", 10, 12)];
    const room = roomFor(items, "b", 30);
    expect(room).toEqual({ min: 2, max: 10 });
    expect(dragSpan({ start: 5, end: 8 }, "body", 9, 1, room, 0.4)).toEqual({ start: 7, end: 10 });
    expect(dragSpan({ start: 5, end: 8 }, "body", 1, 1, room, 0.4)).toEqual({ start: 2, end: 5 });
    expect(dragSpan({ start: 5, end: 8 }, "start", 7.9, 0, room, 0.4)).toEqual({ start: 7.6, end: 8 });
    expect(dragSpan({ start: 5, end: 8 }, "end", 20, 0, room, 0.4)).toEqual({ start: 5, end: 10 });
  });
});

describe("history", () => {
  it("undoes and redoes, coalescing a run under one key", () => {
    const history = new History<number>();
    history.record(0, "slider", 0);
    history.record(1, "slider", 100);
    history.record(2, "slider", 200);
    history.record(3, null, 300);
    expect(history.undo(4)).toBe(3);
    expect(history.undo(3)).toBe(0);
    expect(history.canUndo).toBe(false);
    expect(history.redo(0)).toBe(3);
    expect(history.redo(3)).toBe(4);
    expect(history.canRedo).toBe(false);
  });

  it("starts a new step after a pause, a seal, or another key, and drops the future on an edit", () => {
    const history = new History<number>();
    history.record(0, "a", 0);
    history.record(1, "a", 5000);
    history.seal();
    history.record(2, "a", 5100);
    history.record(3, "b", 5200);
    expect([history.undo(4), history.undo(3), history.undo(2), history.undo(1)]).toEqual([3, 2, 1, 0]);
    history.redo(0);
    history.record(9, null);
    expect(history.canRedo).toBe(false);
  });
});

describe("what the editor reads off the recording", () => {
  it("writes project.json in the lib's dialect: Infinity rates read back by readProject", () => {
    const p = project({ speed: [{ id: "s1", start: 1, end: 9, rate: Infinity, auto: "idle" }] });
    const text = stringifyProject(p);
    expect(text).toBe(writeProject(p));
    expect((JSON.parse(text) as { speed: { rate: unknown }[] }).speed[0]!.rate).toBe("Infinity");
    expect(readProject(text).speed[0]!.rate).toBe(Infinity);
    // What the editor wrote before (`1e999`) still reads back.
    expect(readProject(text.replace('"Infinity"', "1e999")).speed[0]!.rate).toBe(Infinity);
  });

  it("marks clicks, typing bursts, scroll runs, navigations", () => {
    const marks = eventMarks([
      { t: 100, k: "down", x: 1, y: 1, button: "left" },
      { t: 1000, k: "key", kind: "char" },
      { t: 1200, k: "key", kind: "char" },
      { t: 2000, k: "key", kind: "char" },
      { t: 3000, k: "wheel", x: 0, y: 0, dx: 0, dy: 4 },
      { t: 3100, k: "scroll", x: 0, y: 10 },
      { t: 4000, k: "nav", url: "https://a", title: "A" },
      { t: 4500, k: "key", kind: "chord", chord: "⌘K" },
    ]);
    expect(marks.map((m) => m.kind)).toEqual(["click", "typing", "typing", "scroll", "nav", "chord"]);
    expect(marks[1]).toMatchObject({ t: 1, end: 1.2, keys: 2 });
  });

  it("formats clocks, levels, sizes and names", () => {
    expect(formatClock(12.4)).toBe("0:12.40");
    expect(formatClock(108.02)).toBe("1:48.02");
    expect(formatClock(3723.5, false)).toBe("1:02:03");
    expect(levelText(2)).toBe("2.0×");
    expect(levelText(1.35)).toBe("1.35×");
    expect(exportSizeAllowed(2160, { w: 3200, h: 1800 })).toBe(true);
    expect(exportSizeAllowed(1440, { w: 1600, h: 900 })).toBe(false);
    expect(exportName(new Date(2026, 9, 30, 15, 4, 12).getTime(), "mp4")).toBe("Screen Recording 2026-10-30 at 3.04.12 PM.mp4");
  });
});
