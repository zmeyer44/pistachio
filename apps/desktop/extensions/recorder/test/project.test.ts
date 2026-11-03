import { describe, expect, it } from "vitest";
import { defaultProject, readProject, recordingDuration, solveDefaults, writeProject } from "../src/lib/project.js";
import { load, micLevels } from "./fixtures.js";

describe("project.json", () => {
  it("has the spec's defaults", () => {
    const p = defaultProject();
    expect(p.look).toEqual({ background: { type: "wallpaper", id: "dawn" }, padding: 0.08, radius: 14, shadow: 0.6, frame: "browser", aspect: "16:9" });
    expect(p.cursor).toEqual({ mode: "natural", size: 1.6, smoothing: 0.6, hideIdle: true, click: "ripple" });
    expect(p.camera).toEqual({ shape: "circle", size: 0.18, corner: "br", shrinkOnZoom: true });
    expect(p.audio).toEqual({ mic: 1, page: 0.6, muteSpedUp: true });
    expect(p.export).toEqual({ format: "mp4-h264", height: 1080, fps: 60, quality: "high" });
    expect(p.zoom).toEqual({ auto: true, feel: "mellow", maxLevel: 2.5 });
  });

  it("reads what is not a project as the defaults", () => {
    expect(readProject("")).toEqual(defaultProject());
    expect(readProject("[1,2]")).toEqual(defaultProject());
    expect(readProject(`{"v":1,"look":`)).toEqual(defaultProject());
  });

  it("repairs: fills what is missing, clamps, drops what is malformed, renames duplicate ids", () => {
    const p = readProject(JSON.stringify({
      v: 1,
      cuts: [{ in: 5, out: 9 }, { in: 0, out: 6 }, { in: "x", out: 2 }],
      zooms: [
        { id: "z1", start: 1, end: 3, level: 9.5, center: [1.4, -2], auto: true, ease: "wobble", follow: false, anchors: [[0.2, 0.2, 1], ["no"]] },
        { id: "z1", start: 4, end: 5 },
        { id: "z3", start: 6, end: 6 },
      ],
      speed: [{ id: "s1", start: 1, end: 2, rate: "Infinity", auto: "idle" }, { start: 3, end: 4, rate: null }, { start: 5, end: 6, rate: -2 }],
      look: { background: { type: "wallpaper", id: "nope" }, padding: 3, frame: "tv" },
      cursor: { size: 0.2 },
      export: { height: 999, fps: 60 },
    }));
    expect(p.cuts).toEqual([{ in: 0, out: 9 }]);
    expect(p.zooms).toHaveLength(2);
    expect(p.zooms[0]).toMatchObject({ id: "z1", level: 9.5, center: [1, 0], ease: "spring", follow: false, anchors: [[0.2, 0.2, 1]] });
    expect(p.zooms[1]).toMatchObject({ id: "z2", level: 2, center: [0.5, 0.5], auto: false, ease: "spring", follow: true });
    expect(p.speed.map((s) => [s.id, s.rate, s.auto])).toEqual([["s1", Infinity, "idle"], ["s2", Infinity, null]]);
    expect(p.look.background).toEqual({ type: "wallpaper", id: "dawn" });
    expect(p.look.padding).toBe(0.4);
    expect(p.look.frame).toBe("browser");
    expect(p.cursor.size).toBe(1);
    expect(p.cursor.mode).toBe("natural");
    expect(p.export).toEqual({ format: "mp4-h264", height: 1080, fps: 60, quality: "high" });
  });

  it("keeps a split — two cuts that touch — as two clips, and joins cuts that overlap", () => {
    expect(readProject(JSON.stringify({ cuts: [{ in: 0, out: 12 }, { in: 12, out: 30 }] })).cuts).toEqual([
      { in: 0, out: 12 },
      { in: 12, out: 30 },
    ]);
    expect(readProject(JSON.stringify({ cuts: [{ in: 12, out: 30 }, { in: 0, out: 15 }] })).cuts).toEqual([{ in: 0, out: 30 }]);
  });

  it("round-trips through writeProject, cuts (rate Infinity) included", () => {
    const recording = load("idle");
    const p = solveDefaults(recording, micLevels(30, [[20, 23]]), 30);
    expect(p.speed.some((s) => s.rate === Infinity)).toBe(true);
    const text = writeProject(p);
    expect(text).toContain('"Infinity"');
    expect(readProject(text)).toEqual(p);
    expect(readProject(JSON.stringify(p))).toEqual(p);
  });

  it("solveDefaults reads the mic's levels on the source clock: a mic that started later spares the speech where it plays", () => {
    const recording = load("idle");
    const later = { ...recording, meta: { ...recording.meta, offsets: { mic: 1000 } } };
    // Speech at mic seconds 20–23 is heard at source seconds 21–24: the plan is the one for levels saying so.
    expect(solveDefaults(later, micLevels(30, [[20, 23]]), 30).speed).toEqual(solveDefaults(recording, micLevels(30, [[21, 24]]), 30).speed);
    expect(solveDefaults(later, micLevels(30, [[20, 23]]), 30).speed).not.toEqual(solveDefaults(recording, micLevels(30, [[20, 23]]), 30).speed);
    // And the mic's last sample lies a second later on that clock (the typing recording's events end at 9 s, 12 s of levels at 13).
    const typing = load("typing");
    expect(recordingDuration({ ...typing, meta: { ...typing.meta, offsets: { mic: 1000 } } }, new Float32Array(600))).toBe(13);
  });

  it("solveDefaults keeps the drawn cursor from fading or hiding while the system cursor is in the pixels", () => {
    const recording = load("typing");
    expect(defaultProject().cursor.hideIdle).toBe(true);
    // The fixtures' meta says nothing of cursorBaked: a v1 capture, the cursor in the pixels.
    expect(solveDefaults(recording, null).cursor).toMatchObject({ mode: "natural", hideIdle: false });
    expect(solveDefaults({ ...recording, meta: { ...recording.meta, cursorBaked: false } }, null).cursor).toEqual(defaultProject().cursor);
  });

  it("solveDefaults: one clip over the source, the auto zooms and the speed plan", () => {
    const recording = load("typing");
    const p = solveDefaults(recording, null);
    expect(p.cuts).toEqual([{ in: 0, out: 9 }]);
    expect(p.zooms).toHaveLength(1);
    expect(p.zooms[0]!.auto).toBe(true);
    expect(p.speed.find((s) => s.auto === "typing")).toMatchObject({ rate: 2 });
    expect(p.look).toEqual(defaultProject().look);
    expect(recordingDuration(recording, new Float32Array(600))).toBe(12);
  });
});
