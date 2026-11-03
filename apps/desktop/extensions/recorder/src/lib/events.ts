/**
 * Reading `events.jsonl` (docs/recorder.md §3): the meta line, the events, and
 * the views over them the solvers use.
 *
 * Units: an event's `t` stays in **milliseconds** from the start, as on disk.
 * Every function here that takes or returns a time (`tSrc`, `gap`, `pad`,
 * intervals, bursts) works in source **seconds**. Coordinates are view CSS px.
 * The events array is treated as immutable once parsed (some views are cached
 * per array).
 */
import type { Chapter, EventLine, MetaEvent, Point, Rect, RecordedEvent, Size } from "./types.js";
import { type Interval, isFiniteNumber, isRect, lastAtOrBefore, mergeIntervals } from "./util.js";

export interface Recording {
  meta: MetaEvent;
  events: RecordedEvent[];
}

const SECOND = 1000;

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse the file's text. Lines that do not parse — a torn last line after a
 * crash mid-write, or a corrupt one — are dropped, never thrown on; events of
 * a kind this build does not know are dropped too; missing fields are repaired
 * (`b` → `button`, `secret` false, …). The meta line is the first `meta` found;
 * the events come back sorted by `t` (stable). Throws only when the text holds
 * no meta line at all (nothing says how big the view was).
 */
export function parseEvents(text: string): Recording {
  let meta: MetaEvent | null = null;
  const events: RecordedEvent[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.k === "meta") {
      if (meta === null) meta = repairMeta(record);
      continue;
    }
    const event = repairEvent(record);
    if (event !== null) events.push(event);
  }
  if (meta === null) throw new Error("events.jsonl holds no meta line");
  events.sort((a, b) => a.t - b.t);
  return { meta, events: inViewUnits(events, meta.view) };
}

/**
 * Every position in the units of `view` (the meta line's, the view as the recording began): the window resized
 * mid-recording reports a `box` of another size, and the input after it is in that size's units — while the
 * capture's frames, whatever their size, are drawn stretched into the same frame, where a fraction of the view
 * is what lands right. A `box` itself is kept as reported (its size says when the window resized, `breakersOf`).
 */
export function inViewUnits(events: readonly RecordedEvent[], view: Size): RecordedEvent[] {
  let sx = 1;
  let sy = 1;
  const rect = (r: Rect): Rect => ({ x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy });
  return events.map((event) => {
    if (event.k === "box") {
      sx = view.w / Math.max(1, event.view.w);
      sy = view.h / Math.max(1, event.view.h);
      return event;
    }
    if (sx === 1 && sy === 1) return event;
    switch (event.k) {
      case "move":
      case "wheel":
        return { ...event, x: event.x * sx, y: event.y * sy };
      case "down":
      case "up":
        return { ...event, x: event.x * sx, y: event.y * sy, ...(event.target === undefined ? {} : { target: { ...rect(event.target), role: event.target.role } }) };
      case "caret":
        return { ...event, rect: rect(event.rect) };
      case "focus":
        return event.rect === null ? event : { ...event, rect: rect(event.rect) };
      default:
        return event;
    }
  });
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function positive(value: unknown): number | null {
  return isFiniteNumber(value) && value > 0 ? value : null;
}

function repairMeta(record: Record<string, unknown>): MetaEvent {
  const source = (typeof record.source === "object" && record.source !== null ? record.source : {}) as Record<string, unknown>;
  const capture = (typeof record.capture === "object" && record.capture !== null ? record.capture : {}) as Record<string, unknown>;
  const view = (typeof record.view === "object" && record.view !== null ? record.view : {}) as Record<string, unknown>;
  let viewW = positive(view.w);
  let viewH = positive(view.h);
  let capW = positive(capture.w);
  let capH = positive(capture.h);
  let dpr = positive(capture.dpr);
  if (dpr === null) dpr = capW !== null && viewW !== null ? capW / viewW : 1;
  if (viewW === null) viewW = capW !== null ? capW / dpr : 1600;
  if (viewH === null) viewH = capH !== null ? capH / dpr : 900;
  if (capW === null) capW = Math.round(viewW * dpr);
  if (capH === null) capH = Math.round(viewH * dpr);
  return {
    t: 0,
    k: "meta",
    source: { kind: "tab", tabId: str(source.tabId, ""), title: str(source.title, ""), url: str(source.url, "") },
    capture: { w: capW, h: capH, dpr },
    view: { w: viewW, h: viewH },
    fps: positive(record.fps) ?? 60,
    startedAt: isFiniteNumber(record.startedAt) ? record.startedAt : 0,
    ...offsetsOf(record.offsets),
    ...(typeof record.cursorBaked === "boolean" ? { cursorBaked: record.cursorBaked } : {}),
  };
}

/** The meta line's `offsets` (ms), keeping only finite numbers; nothing when none is. */
function offsetsOf(value: unknown): { offsets?: { mic?: number; camera?: number } } {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const offsets: { mic?: number; camera?: number } = {};
  if (isFiniteNumber(raw.mic)) offsets.mic = raw.mic;
  if (isFiniteNumber(raw.camera)) offsets.camera = raw.camera;
  return Object.keys(offsets).length > 0 ? { offsets } : {};
}

/** Where a stream's file starts on the source clock (seconds; 0 when the meta line does not say). */
export function streamOffset(meta: MetaEvent, stream: "mic" | "camera"): number {
  const ms = meta.offsets?.[stream];
  return isFiniteNumber(ms) ? ms / SECOND : 0;
}

const BUTTONS = new Set(["left", "right", "middle"]);
const KEY_KINDS = new Set(["char", "chord", "nav"]);

function repairEvent(r: Record<string, unknown>): RecordedEvent | null {
  const t = r.t;
  if (!isFiniteNumber(t)) return null;
  switch (r.k) {
    case "move":
      return isFiniteNumber(r.x) && isFiniteNumber(r.y) ? { t, k: "move", x: r.x, y: r.y } : null;
    case "down":
    case "up": {
      if (!isFiniteNumber(r.x) || !isFiniteNumber(r.y)) return null;
      const named = typeof r.button === "string" ? r.button : typeof r.b === "string" ? r.b : "left";
      const button = (BUTTONS.has(named) ? named : "left") as "left" | "right" | "middle";
      const k: "down" | "up" = r.k === "up" ? "up" : "down";
      if (!isRect(r.target)) return { t, k, x: r.x, y: r.y, button };
      const target = r.target as Rect & { role?: unknown };
      return { t, k, x: r.x, y: r.y, button, target: { x: target.x, y: target.y, w: target.w, h: target.h, role: str(target.role, "") } };
    }
    case "key": {
      const kind = (typeof r.kind === "string" && KEY_KINDS.has(r.kind) ? r.kind : "char") as "char" | "chord" | "nav";
      return typeof r.chord === "string" ? { t, k: "key", kind, chord: r.chord } : { t, k: "key", kind };
    }
    case "wheel":
      return isFiniteNumber(r.x) && isFiniteNumber(r.y) ? { t, k: "wheel", x: r.x, y: r.y, dx: isFiniteNumber(r.dx) ? r.dx : 0, dy: isFiniteNumber(r.dy) ? r.dy : 0 } : null;
    case "scroll":
      return isFiniteNumber(r.x) && isFiniteNumber(r.y) ? { t, k: "scroll", x: r.x, y: r.y } : null;
    case "caret":
      return isRect(r.rect) ? { t, k: "caret", rect: pickRect(r.rect) } : null;
    case "focus":
      return { t, k: "focus", rect: isRect(r.rect) ? pickRect(r.rect) : null, secret: r.secret === true };
    case "cursor":
      return { t, k: "cursor", type: str(r.type, "default") };
    case "nav":
      return { t, k: "nav", url: str(r.url, ""), title: str(r.title, "") };
    case "load":
      return { t, k: "load", loading: r.loading === true };
    case "box":
      return isRect(r.view) ? { t, k: "box", view: pickRect(r.view), visible: r.visible !== false } : null;
    case "pause":
    case "resume":
    case "frame":
      return { t, k: r.k };
    default:
      return null;
  }
}

function pickRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

// ── Chapters ─────────────────────────────────────────────────────────────────

/** One chapter per `nav` event, skipping a nav whose title repeats the previous chapter's. */
export function chaptersOf(events: readonly RecordedEvent[]): Chapter[] {
  const out: Chapter[] = [];
  for (const event of events) {
    if (event.k !== "nav") continue;
    const last = out[out.length - 1];
    if (last && last.title === event.title) continue;
    out.push({ tSrc: event.t / SECOND, url: event.url, title: event.title });
  }
  return out;
}

/** The chapter in force at a source time (the last one at or before it), or null before the first. */
export function chapterAt(chapters: readonly Chapter[], tSrc: number): Chapter | null {
  let found: Chapter | null = null;
  for (const chapter of chapters) {
    if (chapter.tSrc <= tSrc) found = chapter;
    else break;
  }
  return found;
}

// ── The pointer ──────────────────────────────────────────────────────────────

/** The pointer's samples: every event that carries its position (`move`, `down`, `up`, `wheel`), seconds and view CSS px. */
export interface PointerTrack {
  t: Float64Array;
  x: Float64Array;
  y: Float64Array;
}

const pointerTracks = new WeakMap<readonly RecordedEvent[], PointerTrack>();

/** The pointer's samples in time order (cached per events array). */
export function pointerTrack(events: readonly RecordedEvent[]): PointerTrack {
  const cached = pointerTracks.get(events);
  if (cached) return cached;
  const picked: { t: number; x: number; y: number }[] = [];
  for (const event of events) {
    if (event.k === "move" || event.k === "down" || event.k === "up" || event.k === "wheel") picked.push({ t: event.t / SECOND, x: event.x, y: event.y });
  }
  const track: PointerTrack = { t: new Float64Array(picked.length), x: new Float64Array(picked.length), y: new Float64Array(picked.length) };
  picked.forEach((sample, i) => {
    track.t[i] = sample.t;
    track.x[i] = sample.x;
    track.y[i] = sample.y;
  });
  pointerTracks.set(events, track);
  return track;
}

/** The pointer at a source time in view CSS px, linearly interpolated between its samples (held across a still gap, `POINTER_HOLD_GAP`); null before the first; the last one held after. */
export function pointerAt(events: readonly RecordedEvent[], tSrc: number): Point | null {
  return trackAt(pointerTrack(events), tSrc);
}

/**
 * A gap between pointer samples longer than this (seconds) means the pointer
 * sat still (a moving pointer reports at 60–120 Hz): it holds, then moves to
 * the next sample over the last `POINTER_MOVE_LEAD` only.
 */
export const POINTER_HOLD_GAP = 0.1;
export const POINTER_MOVE_LEAD = 1 / 60;

/** `pointerAt` over a track already built. */
export function trackAt(track: PointerTrack, tSrc: number): Point | null {
  const n = track.t.length;
  if (n === 0 || tSrc < (track.t[0] as number)) return null;
  const i = lastAtOrBefore(track.t, tSrc);
  if (i >= n - 1) return { x: track.x[n - 1] as number, y: track.y[n - 1] as number };
  let t0 = track.t[i] as number;
  const t1 = track.t[i + 1] as number;
  if (t1 - t0 > POINTER_HOLD_GAP) t0 = t1 - POINTER_MOVE_LEAD;
  const u = tSrc <= t0 ? 0 : t1 > t0 ? (tSrc - t0) / (t1 - t0) : 1;
  return { x: (track.x[i] as number) + ((track.x[i + 1] as number) - (track.x[i] as number)) * u, y: (track.y[i] as number) + ((track.y[i + 1] as number) - (track.y[i] as number)) * u };
}

// ── Views for the solvers ────────────────────────────────────────────────────

/** A run of like events closer than a gap: first and last time (seconds) and how many. */
export interface Burst {
  t0: number;
  t1: number;
  count: number;
}

/** Which events a burst is made of: an event kind, `"char"` / `"chord"` for key events of that kind, or a predicate. */
export type BurstKind = RecordedEvent["k"] | "char" | "chord" | ((event: RecordedEvent) => boolean);

function matcher(kind: BurstKind): (event: RecordedEvent) => boolean {
  if (typeof kind === "function") return kind;
  if (kind === "char" || kind === "chord") return (event) => event.k === "key" && event.kind === kind;
  return (event) => event.k === kind;
}

/** Runs of matching events whose consecutive gaps are under `gap` seconds. */
export function bursts(events: readonly RecordedEvent[], kind: BurstKind, gap: number): Burst[] {
  const match = matcher(kind);
  const out: Burst[] = [];
  let current: Burst | null = null;
  for (const event of events) {
    if (!match(event)) continue;
    const t = event.t / SECOND;
    if (current && t - current.t1 < gap) {
      current.t1 = t;
      current.count += 1;
    } else {
      current = { t0: t, t1: t, count: 1 };
      out.push(current);
    }
  }
  return out;
}

/**
 * Where a secret (password) field had focus: from a `focus` with `secret: true`
 * to the next `focus` event (a blur is `rect: null`), seconds. Nothing typed in
 * these spans is shown or solved on (the engine records no keys there anyway).
 */
export function secretSpans(events: readonly RecordedEvent[]): Interval[] {
  const out: Interval[] = [];
  let open: number | null = null;
  for (const event of events) {
    if (event.k !== "focus") continue;
    const t = event.t / SECOND;
    if (open !== null) {
      out.push([open, t]);
      open = null;
    }
    if (event.secret) open = t;
  }
  if (open !== null) out.push([open, Infinity]);
  return out;
}

function inSpans(spans: readonly Interval[], t: number): boolean {
  for (const [a, b] of spans) if (t >= a && t < b) return true;
  return false;
}

/** Typing bursts: `char` keys closer than `gap` seconds, ignoring any inside a secret span. */
export function typingBursts(events: readonly RecordedEvent[], gap = 0.45): Burst[] {
  const secrets = secretSpans(events);
  return bursts(events, (event) => event.k === "key" && event.kind === "char" && !inSpans(secrets, event.t / SECOND), gap);
}

/** A mouse button press, seconds and view CSS px. */
export interface Click {
  t: number;
  x: number;
  y: number;
  button: "left" | "right" | "middle";
  target?: Rect & { role: string };
}

/** Every `down` event (pass `button` to keep one button's). */
export function clicksOf(events: readonly RecordedEvent[], button?: "left" | "right" | "middle"): Click[] {
  const out: Click[] = [];
  for (const event of events) {
    if (event.k !== "down" || (button !== undefined && event.button !== button)) continue;
    const click: Click = { t: event.t / SECOND, x: event.x, y: event.y, button: event.button };
    if (event.target) click.target = event.target;
    out.push(click);
  }
  return out;
}

/** Runs of `wheel` / `scroll` events closer than `gap` seconds. */
export function scrollRuns(events: readonly RecordedEvent[], gap = 0.25): Burst[] {
  return bursts(events, (event) => event.k === "wheel" || event.k === "scroll", gap);
}

/** Loading spans, `load {loading: true}` to the next `{loading: false}`, seconds; one left open ends at `end` (default: the last event). */
export function loadsOf(events: readonly RecordedEvent[], end?: number): Interval[] {
  const out: Interval[] = [];
  let open: number | null = null;
  for (const event of events) {
    if (event.k !== "load") continue;
    const t = event.t / SECOND;
    if (event.loading) {
      if (open === null) open = t;
    } else if (open !== null) {
      out.push([open, t]);
      open = null;
    }
  }
  if (open !== null) {
    const last = events.length > 0 ? (events[events.length - 1] as RecordedEvent).t / SECOND : open;
    out.push([open, Math.max(open, end ?? last)]);
  }
  return out;
}

/** The view's box in force at a source time (the last `box` at or before it), or null before the first. */
export function boxAt(events: readonly RecordedEvent[], tSrc: number): { view: Rect; visible: boolean } | null {
  let found: { view: Rect; visible: boolean } | null = null;
  for (const event of events) {
    if (event.t / SECOND > tSrc) break;
    if (event.k === "box") found = { view: event.view, visible: event.visible };
  }
  return found;
}

/**
 * Times (seconds) the pointer really moved: a sample farther than `threshold`
 * px from where it last rested (which then becomes the new rest point), plus
 * every `down`. The first sample counts as a move.
 */
export function pointerMoves(events: readonly RecordedEvent[], threshold = 3): number[] {
  const out: number[] = [];
  let restX = NaN;
  let restY = NaN;
  for (const event of events) {
    if (event.k === "down") {
      out.push(event.t / SECOND);
      restX = event.x;
      restY = event.y;
      continue;
    }
    if (event.k !== "move" && event.k !== "up" && event.k !== "wheel") continue;
    if (Number.isNaN(restX) || Math.hypot(event.x - restX, event.y - restY) > threshold) {
      out.push(event.t / SECOND);
      restX = event.x;
      restY = event.y;
    }
  }
  return out;
}

/** Event kinds that count as the person (or the page) doing something, for `activeIntervals`. */
const ACTIVE_KINDS = new Set<RecordedEvent["k"]>(["down", "up", "key", "wheel", "scroll", "caret", "focus", "nav", "load", "pause", "resume"]);

/**
 * When the recording is active (docs/recorder.md §4 `speed.ts`), merged
 * intervals in seconds: any input within ±`pad`, a pointer move over
 * `moveThreshold` px within ±`pad`, and the page painting — captured `frame`
 * events at least 4 within 0.5 s (an animation, a video, a scroll), so a lone
 * caret blink (2 frames a second) does not keep a still page "active".
 */
export function activeIntervals(events: readonly RecordedEvent[], pad = 0.3, moveThreshold = 3): Interval[] {
  const spans: Interval[] = [];
  const frames: number[] = [];
  for (const event of events) {
    const t = event.t / SECOND;
    if (ACTIVE_KINDS.has(event.k)) spans.push([t - pad, t + pad]);
    else if (event.k === "frame") frames.push(t);
  }
  for (const t of pointerMoves(events, moveThreshold)) spans.push([t - pad, t + pad]);
  const DENSE = 4;
  const WINDOW = 0.5;
  for (let i = 0; i + DENSE - 1 < frames.length; i++) {
    const a = frames[i] as number;
    const b = frames[i + DENSE - 1] as number;
    if (b - a <= WINDOW) spans.push([a - pad, b + pad]);
  }
  return mergeIntervals(spans);
}

/** The recording's length as the events know it (the last event's time, seconds). */
export function eventsDuration(events: readonly RecordedEvent[]): number {
  return events.length > 0 ? Math.max(0, (events[events.length - 1] as RecordedEvent).t / SECOND) : 0;
}

/**
 * The keystroke chip at a source time: the latest `key` event of kind `chord`
 * (with its `chord` text) shows for `hold` seconds, or until the next one;
 * never inside a secret span. Returns a lookup for `RenderState.chord`.
 */
export function chordTrack(events: readonly RecordedEvent[], hold = 1.2): (tSrc: number) => string | null {
  const secrets = secretSpans(events);
  const times: number[] = [];
  const texts: string[] = [];
  for (const event of events) {
    if (event.k !== "key" || event.kind !== "chord" || !event.chord) continue;
    const t = event.t / SECOND;
    if (inSpans(secrets, t)) continue;
    times.push(t);
    texts.push(event.chord);
  }
  return (tSrc) => {
    const i = lastAtOrBefore(times, tSrc);
    if (i < 0) return null;
    return tSrc - (times[i] as number) < hold ? (texts[i] as string) : null;
  };
}

export type { EventLine };
