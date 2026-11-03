import { describe, expect, it } from "vitest";
import { createRenderer, outputSize, renderStateFor, sceneLayout, type ScratchCanvas } from "../src/lib/render.js";
import { CURSOR_SHAPES, cursorShapeFor } from "../src/lib/cursors.js";
import { GRADIENTS, WALLPAPERS } from "../src/lib/wallpapers.js";
import { defaultProject, solveDefaults } from "../src/lib/project.js";
import { timeMap } from "../src/lib/timemap.js";
import type { BackgroundSpec, CursorSpec, LookSpec, Project, RenderSources } from "../src/lib/types.js";
import { load } from "./fixtures.js";

/** A 2D context that records every call and throws on a non-finite number passed to one. */
function fakeContext(calls: string[]): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => undefined };
  const state: Record<string, unknown> = { canvas: { width: 1920, height: 1080 } };
  return new Proxy(state, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop in target) return target[prop];
      if (prop === "measureText") return (text: string) => ({ width: text.length * 7 });
      return (...args: unknown[]) => {
        calls.push(prop);
        for (const arg of args) if (typeof arg === "number" && !Number.isFinite(arg)) throw new Error(`${prop} was passed ${arg}`);
        return prop.startsWith("create") ? gradient : undefined;
      };
    },
    set(target, prop, value) {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${String(prop)} set to ${value}`);
      target[prop as string] = value;
      calls.push(`${String(prop)}=`);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

const scratch = (calls: string[]) => (w: number, h: number) => ({ width: w, height: h, getContext: () => fakeContext(calls) }) as unknown as ScratchCanvas;
const screen = { width: 3200, height: 1800 } as unknown as CanvasImageSource;
const camera = { videoWidth: 1280, videoHeight: 720 } as unknown as CanvasImageSource;

function project(over: { look?: Partial<LookSpec>; cursor?: Partial<CursorSpec> } = {}): Project {
  const { meta, events } = load("click");
  const p = solveDefaults({ meta, events }, null, 8);
  p.look = { ...p.look, ...over.look };
  p.cursor = { ...p.cursor, ...over.cursor };
  return p;
}

function draw(p: Project, sources: RenderSources, times = [0, 1.9, 2.05, 2.3, 4, 7.9], output = { w: 1920, h: 1080 }, canvases: "fake" | "none" = "fake"): string[] {
  const recording = load("click");
  const calls: string[] = [];
  const state = renderStateFor(p, recording, output);
  const renderer = createRenderer(state, timeMap(p.cuts, p.speed, 8), { createCanvas: canvases === "fake" ? scratch(calls) : () => null });
  const ctx = fakeContext(calls);
  for (const t of times) renderer.render(ctx, t, sources);
  return calls;
}

describe("render", () => {
  const backgrounds: BackgroundSpec[] = [
    ...WALLPAPERS.map((w): BackgroundSpec => ({ type: "wallpaper", id: w.id })),
    { type: "wallpaper", id: "no-such-wallpaper" },
    ...GRADIENTS.map((g): BackgroundSpec => ({ type: "gradient", id: g.id })),
    { type: "solid", color: "#123456" },
    { type: "blur" },
  ];

  it("draws every background, with and without scratch canvases, with and without a screen frame", () => {
    for (const background of backgrounds) {
      for (const canvases of ["fake", "none"] as const) {
        for (const source of [screen, null]) {
          expect(() => draw(project({ look: { background } }), { screen: source, camera: null }, undefined, undefined, canvases)).not.toThrow();
        }
      }
    }
  });

  it("draws every frame and aspect, on a null screen too", () => {
    for (const frame of ["browser", "mac", "none"] as const) {
      for (const aspect of ["16:9", "9:16", "1:1", "4:3", "fit"] as const) {
        const p = project({ look: { frame, aspect } });
        const output = outputSize(p.look, { w: 1600, h: 900 }, 1080);
        expect(() => draw(p, { screen, camera }, undefined, output)).not.toThrow();
        expect(() => draw(p, { screen: null, camera: null }, undefined, output)).not.toThrow();
      }
    }
  });

  it("draws every cursor mode, every cursor shape and both click effects", () => {
    for (const mode of ["natural", "smooth", "glide", "hidden"] as const) {
      for (const click of ["ripple", "none"] as const) expect(() => draw(project({ cursor: { mode, click } }), { screen, camera: null })).not.toThrow();
    }
    const types = ["default", "pointer", "text", "grab", "grabbing", "crosshair", "not-allowed", "wait", "move", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "col-resize", "row-resize", "m-panning", "custom", "none"];
    expect(new Set(types.map(cursorShapeFor).filter((s) => s !== null))).toEqual(new Set(CURSOR_SHAPES));
    const base = load("click");
    for (const type of types) {
      const events = [...base.events, { t: 2010, k: "cursor" as const, type }].sort((a, b) => a.t - b.t);
      const p = project();
      const calls: string[] = [];
      const renderer = createRenderer(renderStateFor(p, { meta: base.meta, events }, { w: 1280, h: 720 }), timeMap(p.cuts, [], 8), { createCanvas: scratch(calls) });
      expect(() => renderer.render(fakeContext(calls), 2.05, { screen, camera: null })).not.toThrow();
    }
  });

  it("draws the screen frame, the ripple at a click, the camera bubble and a chord chip", () => {
    const calls = draw(project(), { screen, camera }, [2.1]);
    expect(calls.filter((c) => c === "drawImage").length).toBeGreaterThanOrEqual(3);
    expect(calls).toContain("arc");
    expect(calls).toContain("clip");

    const typing = load("typing");
    const p = solveDefaults(typing, null, 9);
    const chip: string[] = [];
    const renderer = createRenderer(renderStateFor(p, typing, { w: 1920, h: 1080 }), timeMap(p.cuts, [], 9), { createCanvas: scratch(chip) });
    renderer.render(fakeContext(chip), 5.6, { screen: null, camera: null });
    expect(chip).toContain("fillText");
  });

  it("puts the content quad inside the padded output at the view's shape", () => {
    const p = project();
    const renderer = createRenderer(renderStateFor(p, load("click"), { w: 1920, h: 1080 }), timeMap(p.cuts, [], 8));
    const box = renderer.contentBox();
    expect(box.w / box.h).toBeCloseTo(16 / 9, 6);
    expect(box.x).toBeGreaterThanOrEqual(0.08 * 1080 - 1e-6);
    expect(box.y).toBeGreaterThanOrEqual(0.08 * 1080 - 1e-6);
    expect(box.x + box.w).toBeLessThanOrEqual(1920 - 0.08 * 1080 + 1e-6);
    expect(box.y + box.h).toBeLessThanOrEqual(1080 - 0.08 * 1080 + 1e-6);
    const layout = sceneLayout(p.look, { w: 1600, h: 900 }, { w: 1920, h: 1080 });
    expect(layout.content.y - layout.window.y).toBeCloseTo(layout.bar, 9);
  });

  it("solves one render state: zooms in force, chapters, chord chips", () => {
    const recording = load("click");
    const p = project();
    expect(p.zooms.length).toBeGreaterThan(0);
    const zoom = p.zooms[0]!;
    const mid = (zoom.start + zoom.end) / 2;
    const on = renderStateFor(p, recording, { w: 1920, h: 1080 }, { duration: 8 });
    expect(on.camera(mid).z).toBeGreaterThan(1.1);
    // Automatic zoom off: the solver's untouched segments leave the camera alone; a touched one stays.
    const off = renderStateFor({ ...p, zoom: { ...p.zoom, auto: false } }, recording, { w: 1920, h: 1080 }, { duration: 8 });
    expect(off.camera(mid).z).toBeCloseTo(1, 6);
    const touched = { ...p, zoom: { ...p.zoom, auto: false }, zooms: p.zooms.map((z) => ({ ...z, auto: false })) };
    expect(renderStateFor(touched, recording, { w: 1920, h: 1080 }, { duration: 8 }).camera(mid).z).toBeGreaterThan(1.1);
    // Before the first navigation the address is the page recorded.
    expect(on.chapter(0)?.url).toBe(recording.meta.source.url);
    const chords = { meta: recording.meta, events: [{ t: 1000, k: "key" as const, kind: "chord" as const, chord: "⌘K" }] };
    const chip = renderStateFor(p, chords, { w: 1920, h: 1080 }, { duration: 8 });
    expect(chip.chord(0.5)).toBeNull();
    expect(chip.chord(1.1)).toBe("⌘K");
    expect(chip.chord(2.3)).toBeNull();
  });

  it("sizes outputs by the shorter side, always even", () => {
    const look = defaultProject().look;
    const view = { w: 1600, h: 900 };
    expect(outputSize(look, view, 1080)).toEqual({ w: 1920, h: 1080 });
    expect(outputSize({ ...look, aspect: "9:16" }, view, 1080)).toEqual({ w: 1080, h: 1920 });
    expect(outputSize({ ...look, aspect: "1:1" }, view, 720)).toEqual({ w: 720, h: 720 });
    expect(outputSize({ ...look, aspect: "4:3" }, view, 1080)).toEqual({ w: 1440, h: 1080 });
    const fit = outputSize({ ...look, aspect: "fit" }, view, 1080);
    expect(fit.h).toBe(1080);
    expect(fit.w % 2).toBe(0);
    const layout = sceneLayout({ ...look, aspect: "fit" }, view, fit);
    expect(layout.window.x).toBeCloseTo(0.08 * 1080, 0);
  });
});
