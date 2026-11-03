/** `project.json` (docs/recorder.md §4): defaults, reading with repair, writing, and the solved defaults for a fresh recording. */
import type { BackgroundSpec, Cut, Project, Recording, SpeedSegment, ZoomSegment } from "./index.js";
import { eventsDuration, streamOffset } from "./events.js";
import { cursorSpecAllowed } from "./cursor-modes.js";
import { zoomSegments } from "./zoom.js";
import { speechIntervals, speedPlan } from "./speed.js";
import { GRADIENTS, WALLPAPERS } from "./wallpapers.js";
import { type Interval, clamp, isFiniteNumber, mergeOverlappingIntervals } from "./util.js";

/** The spec's defaults: no cuts, zooms or speed yet (`solveDefaults` adds them). */
export function defaultProject(): Project {
  return {
    v: 1,
    cuts: [],
    zooms: [],
    speed: [],
    zoom: { auto: true, feel: "mellow", maxLevel: 2.5 },
    look: { background: { type: "wallpaper", id: "dawn" }, padding: 0.08, radius: 14, shadow: 0.6, frame: "browser", aspect: "16:9" },
    cursor: { mode: "natural", size: 1.6, smoothing: 0.6, hideIdle: true, click: "ripple" },
    camera: { shape: "circle", size: 0.18, corner: "br", shrinkOnZoom: true },
    audio: { mic: 1, page: 0.6, muteSpedUp: true },
    export: { format: "mp4-h264", height: 1080, fps: 60, quality: "high" },
  };
}

type Loose = Record<string, unknown>;

function obj(value: unknown): Loose {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Loose) : {};
}

function num(value: unknown, fallback: number, lo: number, hi: number): number {
  return isFiniteNumber(value) ? clamp(value, lo, hi) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf<T>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

/** A rate as stored: a positive number, or Infinity written as "Infinity" (or null, what `JSON.stringify` makes of it). */
function readRate(value: unknown): number | null {
  if (value === null || value === "Infinity" || value === Infinity) return Infinity;
  if (isFiniteNumber(value) && value > 0) return value >= 1e9 ? Infinity : value;
  return null;
}

function readBackground(value: unknown, fallback: BackgroundSpec): BackgroundSpec {
  const b = obj(value);
  switch (b.type) {
    case "wallpaper":
      return { type: "wallpaper", id: typeof b.id === "string" && WALLPAPERS.some((w) => w.id === b.id) ? b.id : "dawn" };
    case "gradient":
      return { type: "gradient", id: typeof b.id === "string" && GRADIENTS.some((g) => g.id === b.id) ? b.id : (GRADIENTS[0] as { id: string }).id };
    case "solid":
      return { type: "solid", color: typeof b.color === "string" && b.color.trim() !== "" ? b.color : "#1E1F23" };
    case "blur":
      return { type: "blur" };
    default:
      return fallback;
  }
}

/** A fresh id `<prefix><n>` not yet in `used`. */
function freshId(prefix: string, used: Set<string>): string {
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/**
 * Read a project's JSON, filling what is missing and dropping what is
 * malformed: never throws (text that is not a project gives the defaults).
 * Numbers are clamped to their ranges, overlapping cuts merged, segments with no length
 * dropped, duplicate ids renamed, a speed `rate` of "Infinity" or null read as
 * Infinity.
 */
export function readProject(text: string): Project {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return defaultProject();
  }
  const p = obj(parsed);
  const d = defaultProject();

  // (Overlapping cuts are one; touching ones are a split — two clips with a scissors mark between — and stay two.)
  const cuts: Cut[] = mergeOverlappingIntervals((Array.isArray(p.cuts) ? p.cuts : []).map(obj).filter((c) => isFiniteNumber(c.in) && isFiniteNumber(c.out)).map((c): Interval => [Math.max(0, c.in as number), c.out as number])).map(([a, b]) => ({ in: a, out: b }));

  const zoomIds = new Set<string>();
  const zooms: ZoomSegment[] = [];
  for (const z of (Array.isArray(p.zooms) ? p.zooms : []).map(obj)) {
    if (!isFiniteNumber(z.start) || !isFiniteNumber(z.end) || z.end <= z.start) continue;
    const center = Array.isArray(z.center) && isFiniteNumber(z.center[0]) && isFiniteNumber(z.center[1]) ? ([clamp(z.center[0], 0, 1), clamp(z.center[1], 0, 1)] as [number, number]) : ([0.5, 0.5] as [number, number]);
    const id = typeof z.id === "string" && z.id !== "" && !zoomIds.has(z.id) ? z.id : freshId("z", zoomIds);
    zoomIds.add(id);
    const segment: ZoomSegment = { id, start: Math.max(0, z.start), end: z.end, level: num(z.level, 2, 1, 10), center, auto: bool(z.auto, false), ease: oneOf(z.ease, ["spring", "smooth", "cut"] as const, "spring"), follow: bool(z.follow, true) };
    if (Array.isArray(z.anchors)) {
      const anchors = z.anchors.filter((a): a is [number, number, number] => Array.isArray(a) && a.length === 3 && a.every(isFiniteNumber)).map((a): [number, number, number] => [clamp(a[0], 0, 1), clamp(a[1], 0, 1), a[2]]);
      if (anchors.length > 0) segment.anchors = anchors;
    }
    zooms.push(segment);
  }
  zooms.sort((a, b) => a.start - b.start);

  const speedIds = new Set<string>();
  const speed: SpeedSegment[] = [];
  for (const s of (Array.isArray(p.speed) ? p.speed : []).map(obj)) {
    const rate = readRate(s.rate);
    if (!isFiniteNumber(s.start) || !isFiniteNumber(s.end) || s.end <= s.start || rate === null) continue;
    const id = typeof s.id === "string" && s.id !== "" && !speedIds.has(s.id) ? s.id : freshId("s", speedIds);
    speedIds.add(id);
    speed.push({ id, start: Math.max(0, s.start), end: s.end, rate, auto: oneOf(s.auto, ["idle", "typing", "loading", null] as const, null) });
  }
  speed.sort((a, b) => a.start - b.start);

  const zoom = obj(p.zoom);
  const look = obj(p.look);
  const cursor = obj(p.cursor);
  const camera = obj(p.camera);
  const audio = obj(p.audio);
  const exp = obj(p.export);
  return {
    v: 1,
    cuts,
    zooms,
    speed,
    zoom: { auto: bool(zoom.auto, d.zoom.auto), feel: oneOf(zoom.feel, ["quick", "mellow", "slow"] as const, d.zoom.feel), maxLevel: num(zoom.maxLevel, d.zoom.maxLevel, 1, 4) },
    look: {
      background: readBackground(look.background, d.look.background),
      padding: num(look.padding, d.look.padding, 0, 0.4),
      radius: num(look.radius, d.look.radius, 0, 64),
      shadow: num(look.shadow, d.look.shadow, 0, 1),
      frame: oneOf(look.frame, ["browser", "mac", "none"] as const, d.look.frame),
      aspect: oneOf(look.aspect, ["16:9", "9:16", "1:1", "4:3", "fit"] as const, d.look.aspect),
    },
    cursor: {
      mode: oneOf(cursor.mode, ["natural", "smooth", "glide", "hidden"] as const, d.cursor.mode),
      size: num(cursor.size, d.cursor.size, 1, 4),
      smoothing: num(cursor.smoothing, d.cursor.smoothing, 0, 1),
      hideIdle: bool(cursor.hideIdle, d.cursor.hideIdle),
      click: oneOf(cursor.click, ["ripple", "none"] as const, d.cursor.click),
    },
    camera: {
      shape: oneOf(camera.shape, ["circle", "rounded"] as const, d.camera.shape),
      size: num(camera.size, d.camera.size, 0.05, 0.5),
      corner: oneOf(camera.corner, ["tl", "tr", "bl", "br"] as const, d.camera.corner),
      shrinkOnZoom: bool(camera.shrinkOnZoom, d.camera.shrinkOnZoom),
    },
    audio: { mic: num(audio.mic, d.audio.mic, 0, 2), page: num(audio.page, d.audio.page, 0, 2), muteSpedUp: bool(audio.muteSpedUp, d.audio.muteSpedUp) },
    export: {
      format: oneOf(exp.format, ["mp4-h264", "mp4-hevc", "webm", "gif"] as const, d.export.format),
      height: oneOf(exp.height, [720, 1080, 1440, 2160] as const, d.export.height),
      fps: oneOf(exp.fps, [30, 60] as const, d.export.fps),
      quality: oneOf(exp.quality, ["standard", "high", "studio"] as const, d.export.quality),
    },
  };
}

/** The project as `project.json` text: a speed `rate` of Infinity is written "Infinity" (JSON has no Infinity). */
export function writeProject(project: Project): string {
  return JSON.stringify(project, (_key, value: unknown) => (value === Infinity ? "Infinity" : value), 2);
}

/** A recording's length in source seconds: the latest of its events and its mic levels (50 Hz, from where the mic's file starts on the source clock). */
export function recordingDuration(recording: Recording, micLevels: Float32Array | null = null, levelsHz = 50): number {
  return Math.max(eventsDuration(recording.events), micLevels !== null ? streamOffset(recording.meta, "mic") + micLevels.length / levelsHz : 0);
}

/**
 * A fresh project for a recording: the default look, one clip over the whole
 * source, the solver's zooms and its speed plan (sparing speech from
 * `micLevels`). `durationSeconds` is the media's length when known (else the
 * events' and the levels').
 */
export function solveDefaults(recording: Recording, micLevels: Float32Array | null, durationSeconds?: number): Project {
  const project = defaultProject();
  const duration = durationSeconds !== undefined && durationSeconds > 0 ? durationSeconds : recordingDuration(recording, micLevels);
  project.cuts = duration > 0 ? [{ in: 0, out: Math.round(duration * 1000) / 1000 }] : [];
  const zooms = zoomSegments(recording.events, recording.meta.view, recording.meta.capture.dpr, project.zoom);
  // A zoom's hold may run past the last frame (a click just before stopping): it ends with the recording.
  project.zooms = duration > 0 ? zooms.filter((zoom) => zoom.start < duration).map((zoom) => (zoom.end > duration ? { ...zoom, end: Math.round(duration * 1000) / 1000 } : zoom)) : zooms;
  // The levels run on the mic file's own clock: its speech is spared where it plays, from where that file starts on the source's.
  const micOffset = streamOffset(recording.meta, "mic");
  // (With Chromium's cursor in the pixels — every v1 capture — the drawn cursor neither fades nor hides.)
  project.cursor = cursorSpecAllowed(project.cursor, recording.meta.cursorBaked !== false);
  project.speed = speedPlan(
    recording.events,
    duration,
    speechIntervals(micLevels).map(([start, end]) => [start + micOffset, end + micOffset]),
  );
  return project;
}
