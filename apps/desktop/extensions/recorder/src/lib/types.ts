/**
 * The Recorder's shared shapes (docs/recorder.md §3–4): the recording on disk,
 * the project the editor writes, and what the solvers hand the renderer.
 * Every module in `src/` codes against these; change them here first.
 */

// ── The recording on disk (`events.jsonl`, R7) ────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The first line of `events.jsonl`. */
export interface MetaEvent {
  t: 0;
  k: "meta";
  source: { kind: "tab"; tabId: string; title: string; url: string };
  /** The capture's pixels and the ratio to the view (2 for Crisp). */
  capture: { w: number; h: number; dpr: number };
  /** The view's CSS size at the start; every coordinate below is in view CSS px. */
  view: Size;
  /** The source's frame rate asked for. */
  fps: number;
  /** Epoch ms of t = 0 (the first video frame). */
  startedAt: number;
  /**
   * Where the mic's and the camera's files start on this clock, in ms from
   * t = 0 (each is its own file with its own zero): source second `s` is the
   * mic file's `s - offsets.mic / 1000`. Absent (or a stream absent) means 0.
   */
  offsets?: { mic?: number; camera?: number };
  /**
   * Whether the system cursor is drawn into the screen's pixels (Chromium's
   * tab capture does, R5): then only the Natural cursor can cover it, and
   * Smooth and Glide wait for a capture without it. Absent reads as true.
   */
  cursorBaked?: boolean;
}

/** One line of `events.jsonl` after the meta line; `t` in ms from the start. */
export type RecordedEvent =
  | { t: number; k: "move"; x: number; y: number }
  | { t: number; k: "down" | "up"; x: number; y: number; button: "left" | "right" | "middle"; target?: Rect & { role: string } }
  | { t: number; k: "key"; kind: "char" | "chord" | "nav"; chord?: string }
  | { t: number; k: "wheel"; x: number; y: number; dx: number; dy: number }
  | { t: number; k: "scroll"; x: number; y: number }
  | { t: number; k: "caret"; rect: Rect }
  | { t: number; k: "focus"; rect: Rect | null; secret: boolean }
  | { t: number; k: "cursor"; type: string }
  | { t: number; k: "nav"; url: string; title: string }
  | { t: number; k: "load"; loading: boolean }
  | { t: number; k: "box"; view: Rect; visible: boolean }
  | { t: number; k: "pause" }
  | { t: number; k: "resume" }
  /** The engine's own: a captured video frame arrived (its presentation time), so the speed plan knows when the page painted. */
  | { t: number; k: "frame" };

export type EventLine = MetaEvent | RecordedEvent;

/** A recording's folder, `recordings/<id>/` under the extension's data root. */
export interface RecordingFiles {
  id: string;
  dir: string;
  screen: string; // screen.mp4
  mic: string | null; // mic.m4a
  camera: string | null; // camera.mp4
  events: string; // events.jsonl
  micLevels: string | null; // mic.levels: Float32 RMS at 50 Hz
  thumb: string | null; // thumb.jpg
  project: string; // project.json
}

export interface RecordingSummary {
  id: string;
  title: string;
  startedAt: number;
  durationMs: number;
  thumbUrl: string | null;
}

// ── The project (`project.json`, §4) ─────────────────────────────────────────

export interface Cut {
  /** Source seconds kept. */
  in: number;
  out: number;
}

export type ZoomEase = "spring" | "smooth" | "cut";

export interface ZoomSegment {
  id: string;
  /** Source seconds. */
  start: number;
  end: number;
  /** 1 = no zoom. */
  level: number;
  /** The viewport's centre, normalized to the content (0..1). */
  center: [number, number];
  /** Made by the solver, drawn dashed until touched. */
  auto: boolean;
  ease: ZoomEase;
  /** Keep the cursor inside the middle of the viewport, looking ahead. */
  follow: boolean;
  /** Pan targets inside the segment (centre, source seconds), from merged interests. Re-aiming a segment by hand should drop them (they pull the camera toward the old aim). */
  anchors?: [number, number, number][];
}

export interface SpeedSegment {
  id: string;
  start: number;
  end: number;
  /** A rate above 1 speeds up; Infinity cuts (a 120 ms crossfade). JSON has no Infinity: `writeProject` stores it as "Infinity" and `readProject` reads that (or null) back. */
  rate: number;
  auto: "idle" | "typing" | "loading" | null;
}

export type BackgroundSpec =
  | { type: "wallpaper"; id: string }
  | { type: "gradient"; id: string }
  | { type: "solid"; color: string }
  | { type: "blur" };

export interface LookSpec {
  background: BackgroundSpec;
  /** Fraction of the frame's shorter side. */
  padding: number;
  radius: number;
  /** 0..1 */
  shadow: number;
  frame: "browser" | "mac" | "none";
  aspect: "16:9" | "9:16" | "1:1" | "4:3" | "fit";
}

export interface CursorSpec {
  mode: "natural" | "smooth" | "glide" | "hidden";
  /** Multiplier on the native size. */
  size: number;
  /** 0..1, for smooth mode. */
  smoothing: number;
  hideIdle: boolean;
  click: "ripple" | "none";
}

export interface CameraBubbleSpec {
  shape: "circle" | "rounded";
  /** Fraction of the frame's shorter side. */
  size: number;
  corner: "tl" | "tr" | "bl" | "br";
  shrinkOnZoom: boolean;
}

export interface AudioSpec {
  mic: number;
  page: number;
  muteSpedUp: boolean;
}

export interface ExportSpec {
  format: "mp4-h264" | "mp4-hevc" | "webm" | "gif";
  height: 720 | 1080 | 1440 | 2160;
  fps: 30 | 60;
  quality: "standard" | "high" | "studio";
}

export interface ZoomSettings {
  auto: boolean;
  feel: "quick" | "mellow" | "slow";
  maxLevel: number;
}

export interface Project {
  v: 1;
  cuts: Cut[];
  zooms: ZoomSegment[];
  speed: SpeedSegment[];
  zoom: ZoomSettings;
  look: LookSpec;
  cursor: CursorSpec;
  camera: CameraBubbleSpec;
  audio: AudioSpec;
  export: ExportSpec;
}

// ── What the solvers hand the renderer ───────────────────────────────────────

/** The camera at one output frame: the viewport's centre (0..1) and its zoom. */
export interface CameraSample {
  cx: number;
  cy: number;
  z: number;
}

/** The cursor at one instant, in view CSS px; `visible` is false while hidden for idling. */
export interface CursorSample {
  x: number;
  y: number;
  type: string;
  visible: boolean;
  /** 0..1 press scale and ripple progress for the click effect. */
  press: number;
  ripple: number;
  /** 0..1 opacity of the idle fade (1 when absent); `visible` is false once it reaches 0. */
  fade?: number;
}

/** The time map between output seconds and source seconds. */
export interface TimeMap {
  /** Output seconds → source seconds. */
  toSource(tOut: number): number;
  /** Source seconds → output seconds (for drawing lanes under the playhead). */
  toOutput(tSrc: number): number;
  /** The output's length in seconds. */
  duration: number;
  /** The rate in force at an output time (1 = real time; Infinity inside a cut). */
  rateAt(tOut: number): number;
  /** Where the source jumps (a cut, or a speed segment of rate Infinity): the output time and the source seconds it leaves and lands on, in order. */
  joins?: { tOut: number; from: number; to: number }[];
}

/** Everything `render` needs besides the frame to draw. */
export interface RenderState {
  project: Project;
  meta: MetaEvent;
  /** Output pixels. */
  output: Size;
  camera: (tSrc: number) => CameraSample;
  cursor: (tSrc: number) => CursorSample | null;
  /** The chapter (page title) in force, for the browser frame's address line. */
  chapter: (tSrc: number) => { url: string; title: string } | null;
  /** The keystroke chip to show, if any (`chord` events only). */
  chord: (tSrc: number) => string | null;
}

/** What `render` draws from: the decoded screen frame and the camera's, if any. */
export interface RenderSources {
  screen: CanvasImageSource | null;
  camera: CanvasImageSource | null;
}

/** A chapter from `nav` events. */
export interface Chapter {
  tSrc: number;
  url: string;
  title: string;
}
