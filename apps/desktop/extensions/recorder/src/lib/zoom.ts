/**
 * Events → zoom segments (docs/recorder.md §4 `zoom.ts`). Pure.
 *
 * 1. Interests: a left `down` (its `target` rect when under 40% of the view,
 *    else a box around the point that frames at `defZoom`), a `focus` rect
 *    (weight 0.8), a typing burst (≥ 2 `char` keys closer than `typingGap`:
 *    the union of the caret rects, else the focused field, else around the
 *    pointer). Nothing inside a secret (password) span types.
 * 2. Merge an interest into the open segment when it starts within `mergeGap`
 *    of the segment's last interest, no breaker lies between (a `nav`, a scroll
 *    run longer than `scrollBreak`, a `box` resize, a `pause`), and the union
 *    still fits at ≥ `minZoom`; merged interests become the segment's anchors.
 * 3. `start = t0 − lead` (never before 0 or the last breaker), `end = max(t1 +
 *    hold, start + minLen)` cut at the next breaker; a segment a breaker cut
 *    shorter than `minKeep` is dropped (a link click that navigates at once).
 *    `level = clamp(fitZoom(rect padded by pad on every side), minZoom, cap)`,
 *    at most `defZoom` when the rect is under 2% of the view, where
 *    `cap = min(maxZoom, settings.maxLevel, dpr × 1.25)` so content never goes
 *    soft.
 * 4. Overlaps: levels within e^0.3 with no breaker between merge into one
 *    segment that pans; otherwise the earlier segment ends where the later
 *    starts.
 *
 * Times are source seconds; centres and anchors are normalized to the content
 * (0..1 of the view). Ids are `z1…` in time order.
 */
import type { RecordedEvent, Rect, Size, ZoomSegment, ZoomSettings } from "./types.js";
import { pointerAt, scrollRuns, secretSpans, typingBursts } from "./events.js";
import { area, clamp, lastAtOrBefore, padRect, rectCenter, unionRect } from "./util.js";

export interface ZoomTuning {
  lead: number; hold: number; mergeGap: number; minLen: number; minZoom: number; maxZoom: number; defZoom: number; pad: number; typingGap: number; scrollBreak: number;
  /** A segment a breaker cut shorter than this (seconds) is dropped. */
  minKeep: number;
  /** A target under this fraction of the view's area caps the level at `defZoom`. */
  tinyArea: number;
  /** A click target under this fraction of the view's area is framed as is; a bigger one frames the point. */
  targetArea: number;
  /** Overlapping segments whose levels differ by less than this in ln merge into a pan. */
  similarLevel: number;
}

export const ZOOM_DEFAULTS: ZoomTuning = { lead: 0.35, hold: 1.4, mergeGap: 1.0, minLen: 1.4, minZoom: 1.25, maxZoom: 2.5, defZoom: 2.0, pad: 0.18, typingGap: 0.45, scrollBreak: 0.6, minKeep: 0.8, tinyArea: 0.02, targetArea: 0.4, similarLevel: 0.3 };

/** Something worth zooming to: when (source seconds), where (view CSS px), how much it counts. */
export interface Interest {
  t0: number;
  t1: number;
  rect: Rect;
  weight: number;
  kind: "click" | "focus" | "typing";
}

/** The zoom that fits a rect in the view: `min(view.w / rect.w, view.h / rect.h)`. */
export function fitZoom(rect: Size, view: Size): number {
  const w = Math.max(rect.w, 1e-6);
  const h = Math.max(rect.h, 1e-6);
  return Math.min(view.w / w, view.h / h);
}

/** A rect centred on a point that, once padded by `pad`, frames at `level`. */
function around(point: { x: number; y: number }, view: Size, level: number, pad: number): Rect {
  const w = view.w / level / (1 + 2 * pad);
  const h = view.h / level / (1 + 2 * pad);
  return { x: point.x - w / 2, y: point.y - h / 2, w, h };
}

/** The interests in a recording, sorted by start. */
export function interestsOf(events: readonly RecordedEvent[], view: Size, tuning: Partial<ZoomTuning> = {}): Interest[] {
  const T = { ...ZOOM_DEFAULTS, ...tuning };
  const viewArea = area(view);
  const out: Interest[] = [];
  for (const event of events) {
    const t = event.t / 1000;
    if (event.k === "down" && event.button === "left") {
      const rect = event.target && area(event.target) < T.targetArea * viewArea && event.target.w > 0 && event.target.h > 0 ? { x: event.target.x, y: event.target.y, w: event.target.w, h: event.target.h } : around(event, view, T.defZoom, T.pad);
      out.push({ t0: t, t1: t, rect, weight: 1, kind: "click" });
    } else if (event.k === "focus" && event.rect !== null && event.rect.w > 0 && event.rect.h > 0) {
      out.push({ t0: t, t1: t, rect: event.rect, weight: 0.8, kind: "focus" });
    }
  }
  const secrets = secretSpans(events);
  const focusTimes: number[] = [];
  const focusRects: (Rect | null)[] = [];
  const caretTimes: number[] = [];
  const caretRects: Rect[] = [];
  for (const event of events) {
    if (event.k === "focus") {
      focusTimes.push(event.t / 1000);
      focusRects.push(event.rect);
    } else if (event.k === "caret") {
      const t = event.t / 1000;
      if (secrets.some(([a, b]) => t >= a && t < b)) continue;
      caretTimes.push(t);
      caretRects.push(event.rect);
    }
  }
  for (const burst of typingBursts(events, T.typingGap)) {
    if (burst.count < 2) continue;
    let carets: Rect | null = null;
    for (let i = Math.max(0, lastAtOrBefore(caretTimes, burst.t0 - 0.1)); i < caretTimes.length; i++) {
      const t = caretTimes[i] as number;
      if (t > burst.t1 + 0.2) break;
      if (t < burst.t0 - 0.1) continue;
      const rect = caretRects[i] as Rect;
      carets = carets ? unionRect(carets, rect) : rect;
    }
    const f = lastAtOrBefore(focusTimes, burst.t0);
    const field = f >= 0 ? (focusRects[f] ?? null) : null;
    const pointer = pointerAt(events, burst.t0);
    const rect = carets ?? field ?? (pointer ? around(pointer, view, T.defZoom, T.pad) : null);
    if (rect) out.push({ t0: burst.t0, t1: burst.t1, rect, weight: 1, kind: "typing" });
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

/** Breaker times (source seconds, sorted): `nav`, the start of a scroll run longer than `scrollBreak`, a `box` resize, a `pause`. */
export function breakersOf(events: readonly RecordedEvent[], view: Size, tuning: Partial<ZoomTuning> = {}): number[] {
  const T = { ...ZOOM_DEFAULTS, ...tuning };
  const out: number[] = [];
  let boxW = view.w;
  let boxH = view.h;
  let sawBox = false;
  for (const event of events) {
    const t = event.t / 1000;
    if (event.k === "nav" || event.k === "pause") out.push(t);
    else if (event.k === "box") {
      if (sawBox && (Math.abs(event.view.w - boxW) > 1 || Math.abs(event.view.h - boxH) > 1)) out.push(t);
      sawBox = true;
      boxW = event.view.w;
      boxH = event.view.h;
    }
  }
  for (const run of scrollRuns(events)) if (run.t1 - run.t0 > T.scrollBreak) out.push(run.t0);
  return out.sort((a, b) => a - b);
}

interface Building {
  t0: number;
  t1: number;
  rect: Rect;
  interests: Interest[];
  start: number;
  end: number;
  level: number;
}

/**
 * The auto zoom segments for a recording (see the module comment). Returns
 * `[]` when `settings.auto` is off or the cap leaves no room to zoom.
 */
export function zoomSegments(events: RecordedEvent[], view: Size, dpr: number, settings: ZoomSettings, tuning?: Partial<ZoomTuning>): ZoomSegment[] {
  if (!settings.auto) return [];
  const T = { ...ZOOM_DEFAULTS, ...tuning };
  const cap = Math.min(T.maxZoom, settings.maxLevel, (dpr > 0 ? dpr : 1) * 1.25);
  if (!(cap > 1.01)) return [];
  const lo = Math.min(T.minZoom, cap);
  const breaks = breakersOf(events, view, T);
  const between = (a: number, b: number) => breaks.some((x) => x > a && x <= b);
  const nextBreak = (t: number) => breaks.find((x) => x > t) ?? Infinity;
  const lastBreak = (t: number) => {
    let found = -Infinity;
    for (const x of breaks) if (x <= t) found = x;
    return found;
  };

  // 1–2. Interests merged into groups.
  const groups: Building[] = [];
  let current: Building | null = null;
  for (const p of interestsOf(events, view, T)) {
    if (current && p.t0 - current.t1 < T.mergeGap && !between(current.t1, p.t0) && fitZoom(unionRect(current.rect, p.rect), view) >= T.minZoom) {
      current.t1 = Math.max(current.t1, p.t1);
      current.rect = unionRect(current.rect, p.rect);
      current.interests.push(p);
    } else {
      current = { t0: p.t0, t1: p.t1, rect: p.rect, interests: [p], start: 0, end: 0, level: 1 };
      groups.push(current);
    }
  }

  // 3. Timing and level.
  const viewArea = area(view);
  const levelOf = (rect: Rect) => {
    let level = clamp(fitZoom(padRect(rect, T.pad), view), lo, cap);
    if (area(rect) < T.tinyArea * viewArea) level = Math.max(lo, Math.min(level, T.defZoom));
    return level;
  };
  const timed: Building[] = [];
  for (const g of groups) {
    g.start = Math.max(0, g.t0 - T.lead, lastBreak(g.t0));
    const natural = Math.max(g.t1 + T.hold, g.start + T.minLen);
    g.end = Math.min(natural, nextBreak(g.t1));
    g.level = levelOf(g.rect);
    if (g.end < natural && g.end - g.start < T.minKeep) continue;
    if (g.end - g.start <= 1e-6) continue;
    timed.push(g);
  }

  // 4. Overlaps.
  const resolved: Building[] = [];
  for (const g of timed) {
    const last = resolved[resolved.length - 1];
    if (!last || g.start >= last.end) {
      resolved.push(g);
      continue;
    }
    if (Math.abs(Math.log(last.level / g.level)) < T.similarLevel && !between(last.t1, g.t0)) {
      last.t1 = Math.max(last.t1, g.t1);
      last.rect = unionRect(last.rect, g.rect);
      last.interests.push(...g.interests);
      last.level = Math.min(last.level, g.level);
      last.end = Math.min(Math.max(last.end, g.end), nextBreak(last.t1));
    } else {
      last.end = g.start;
      if (last.end - last.start <= 1e-6) resolved.pop();
      resolved.push(g);
    }
  }

  return resolved.map((g, i): ZoomSegment => {
    const segment: ZoomSegment = {
      id: `z${i + 1}`,
      start: round(g.start),
      end: round(g.end),
      level: round(g.level),
      center: centerFor(g, view),
      auto: true,
      ease: "spring",
      follow: true,
    };
    if (g.interests.length > 1) {
      segment.anchors = g.interests.map((p): [number, number, number] => {
        const c = rectCenter(p.rect);
        return [round(clamp(c.x / view.w, 0, 1)), round(clamp(c.y / view.h, 0, 1)), round(p.t0)];
      });
    }
    return segment;
  });
}

/** The weighted mean of the interests' centres, moved so the union fits when it can, kept so the viewport stays inside the content. */
function centerFor(g: Building, view: Size): [number, number] {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (const p of g.interests) {
    const c = rectCenter(p.rect);
    sw += p.weight;
    sx += p.weight * c.x;
    sy += p.weight * c.y;
  }
  const half = 0.5 / g.level;
  const axis = (mean: number, u0: number, u1: number) => {
    let c = mean;
    if (u1 - u0 <= 2 * half) c = clamp(c, u1 - half, u0 + half);
    else c = (u0 + u1) / 2;
    return round(clamp(c, half, 1 - half));
  };
  return [axis(sx / sw / view.w, g.rect.x / view.w, (g.rect.x + g.rect.w) / view.w), axis(sy / sw / view.h, g.rect.y / view.h, (g.rect.y + g.rect.h) / view.h)];
}

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/**
 * Re-solving after edits: every segment the person touched (`auto: false`)
 * stays as it is; a solved segment joins only where it overlaps none of them,
 * with a fresh id after the highest `z<n>` in use. Sorted by start.
 */
export function replaceAutoZooms(current: readonly ZoomSegment[], solved: readonly ZoomSegment[]): ZoomSegment[] {
  const kept = current.filter((segment) => !segment.auto);
  let next = 1;
  for (const segment of kept) {
    const n = /^z(\d+)$/.exec(segment.id);
    if (n) next = Math.max(next, Number(n[1]) + 1);
  }
  const added = solved.filter((s) => !kept.some((k) => s.start < k.end && k.start < s.end)).map((s) => ({ ...s, id: `z${next++}` }));
  return [...kept, ...added].sort((a, b) => a.start - b.start);
}
