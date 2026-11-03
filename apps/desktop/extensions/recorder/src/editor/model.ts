/**
 * The editor's edits as pure functions over the project (docs/recorder.md §2 "Edit", §5):
 * the selection, splitting and cutting the clip, adding and moving zoom and speed
 * segments, re-solving the auto zooms around the touched ones. Source seconds
 * throughout; the timeline maps them to output time on its own. No DOM.
 */
import { writeProject } from "../lib/project.js";
import type { Cut, Project, Rect, SpeedSegment, ZoomSegment } from "../lib/types.js";

/** What the timeline (and ⌫, X) act on. A range is in source seconds. */
export type Selection =
  | { kind: "none" }
  | { kind: "zoom"; id: string }
  | { kind: "speed"; id: string }
  | { kind: "clip"; index: number }
  | { kind: "gap"; index: number }
  | { kind: "range"; start: number; end: number };

export const NONE: Selection = { kind: "none" };

/** The shortest pieces an edit leaves (seconds). */
export const MIN_ZOOM = 0.4;
export const MIN_SPEED = 0.3;
export const MIN_PIECE = 0.1;
/** A new zoom's length (Z) and a new speed segment's when nothing is selected (X). */
export const NEW_ZOOM_SECONDS = 2.5;
export const NEW_SPEED_SECONDS = 2;

export interface Span {
  start: number;
  end: number;
}

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

export function uniqueId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let n = 1;
  while (used.has(`${prefix}${String(n)}`)) n += 1;
  return `${prefix}${String(n)}`;
}

export function cloneProject(project: Project): Project {
  return structuredClone(project);
}

/** `project.json`'s text: the lib's one dialect (`writeProject`: a rate of Infinity is written "Infinity", which `readProject` reads back). */
export function stringifyProject(project: Project): string {
  return writeProject(project);
}

function jsonKey(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => (inner === Infinity ? "Infinity" : inner));
}

export function sameJson(a: unknown, b: unknown): boolean {
  return jsonKey(a) === jsonKey(b);
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

// ── The clip: kept ranges ───────────────────────────────────────────────────

/** The kept piece holding a source time, or -1 (in a cut-away range). */
export function pieceAt(cuts: Cut[], tSrc: number): number {
  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i]!;
    const last = i === cuts.length - 1;
    if (tSrc >= cut.in && (tSrc < cut.out || (last && tSrc <= cut.out))) return i;
  }
  return -1;
}

/** S: split the piece under the playhead in two (no time removed: a scissors marker appears). Null when there is nothing to split there. */
export function splitAt(cuts: Cut[], tSrc: number): Cut[] | null {
  const index = pieceAt(cuts, tSrc);
  if (index < 0) return null;
  const piece = cuts[index]!;
  if (tSrc - piece.in < MIN_PIECE || piece.out - tSrc < MIN_PIECE) return null;
  return [...cuts.slice(0, index), { in: piece.in, out: tSrc }, { in: tSrc, out: piece.out }, ...cuts.slice(index + 1)];
}

/** Cut a source range out of the kept pieces. Null when nothing changes or nothing would be left. */
export function removeRange(cuts: Cut[], start: number, end: number): Cut[] | null {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  if (b - a <= 0) return null;
  const next: Cut[] = [];
  let changed = false;
  for (const cut of cuts) {
    if (cut.out <= a || cut.in >= b) {
      next.push(cut);
      continue;
    }
    changed = true;
    if (cut.in < a && a - cut.in >= MIN_PIECE) next.push({ in: cut.in, out: a });
    if (cut.out > b && cut.out - b >= MIN_PIECE) next.push({ in: b, out: cut.out });
  }
  if (!changed || next.length === 0) return null;
  return next;
}

/** ⌫ on a piece: remove it. Never the last one. */
export function removePiece(cuts: Cut[], index: number): Cut[] | null {
  if (cuts.length <= 1 || index < 0 || index >= cuts.length) return null;
  return cuts.filter((_cut, i) => i !== index);
}

/** ⌫ on a scissors marker: join the pieces either side of it, restoring what was cut between them. */
export function joinGap(cuts: Cut[], index: number): Cut[] | null {
  const left = cuts[index];
  const right = cuts[index + 1];
  if (left === undefined || right === undefined) return null;
  return [...cuts.slice(0, index), { in: left.in, out: right.out }, ...cuts.slice(index + 2)];
}

// ── Zoom segments ───────────────────────────────────────────────────────────

/** The viewport centre clamped so the viewport stays inside the content. */
export function clampCenter(center: readonly [number, number], level: number): [number, number] {
  const half = 0.5 / Math.max(1, level);
  return [clamp(center[0], half, 1 - half), clamp(center[1], half, 1 - half)];
}

/** A segment's viewport in content-normalized coordinates (what the preview's rectangle shows). */
export function viewportOf(segment: Pick<ZoomSegment, "center" | "level">): Rect {
  const size = 1 / Math.max(1, segment.level);
  const [cx, cy] = clampCenter(segment.center, segment.level);
  return { x: cx - size / 2, y: cy - size / 2, w: size, h: size };
}

/** A segment re-aimed by hand: touched, and without the solver's pan anchors (they would pull the camera back toward the old aim). */
function reaimed(segment: ZoomSegment, changes: Pick<ZoomSegment, "center"> & Partial<ZoomSegment>): ZoomSegment {
  const { anchors: _anchors, ...rest } = segment;
  return { ...rest, ...changes, auto: false };
}

/** Drag the rectangle: a new centre. Any edit marks an auto segment touched. */
export function aimZoom(segment: ZoomSegment, center: readonly [number, number]): ZoomSegment {
  return reaimed(segment, { center: clampCenter(center, segment.level) });
}

/**
 * Resize the rectangle by a corner: `anchor` is the opposite corner (held still),
 * `pointer` where the dragged corner is, both content-normalized. The viewport keeps
 * the content's aspect, so its normalized width and height are one size.
 */
export function resizeZoom(segment: ZoomSegment, anchor: { x: number; y: number }, pointer: { x: number; y: number }, maxLevel: number): ZoomSegment {
  const minSize = 1 / Math.max(1, maxLevel);
  const size = clamp(Math.max(Math.abs(pointer.x - anchor.x), Math.abs(pointer.y - anchor.y)), minSize, 1);
  const sx = pointer.x >= anchor.x ? 1 : -1;
  const sy = pointer.y >= anchor.y ? 1 : -1;
  const level = 1 / size;
  const center = clampCenter([anchor.x + (sx * size) / 2, anchor.y + (sy * size) / 2], level);
  return reaimed(segment, { level, center });
}

function sortByStart<T extends Span>(items: T[]): T[] {
  return [...items].sort((a, b) => a.start - b.start);
}

/** Z: a zoom at the playhead, centred on the cursor. Inside a touched zoom it selects that one instead. */
export function addZoomAt(project: Project, tSrc: number, center: readonly [number, number], duration: number): { project: Project; id: string } | null {
  const inside = project.zooms.find((z) => !z.auto && tSrc >= z.start && tSrc < z.end);
  if (inside !== undefined) return { project, id: inside.id };
  // The free room around the playhead between touched zooms; auto ones give way.
  let lo = 0;
  let hi = duration;
  for (const z of project.zooms) {
    if (z.auto) continue;
    if (z.end <= tSrc) lo = Math.max(lo, z.end);
    else if (z.start > tSrc) hi = Math.min(hi, z.start);
  }
  let start = Math.max(lo, tSrc);
  let end = Math.min(hi, start + NEW_ZOOM_SECONDS);
  if (end - start < MIN_ZOOM) {
    start = Math.max(lo, end - NEW_ZOOM_SECONDS);
    end = Math.min(hi, start + NEW_ZOOM_SECONDS);
  }
  if (end - start < MIN_ZOOM) return null;
  const level = clamp(2, 1.1, Math.max(1.1, project.zoom.maxLevel));
  const id = uniqueId("z", project.zooms.map((z) => z.id));
  const segment: ZoomSegment = { id, start, end, level, center: clampCenter(center, level), auto: false, ease: "spring", follow: false };
  const kept = project.zooms.filter((z) => !(z.auto && overlaps(z, segment)));
  return { project: { ...project, zooms: sortByStart([...kept, segment]) }, id };
}

/** After Auto or Max level changes: the solver's auto zooms again, around the touched ones (which stay as they are). */
export function mergeAutoZooms(current: ZoomSegment[], solved: ZoomSegment[], autoOn: boolean): ZoomSegment[] {
  const touched = current.filter((z) => !z.auto);
  if (!autoOn) return sortByStart(touched);
  const taken = new Set(touched.map((z) => z.id));
  const fresh = solved
    .filter((z) => !touched.some((t) => overlaps(t, z)))
    .map((z) => {
      const id = taken.has(z.id) ? uniqueId("z", taken) : z.id;
      taken.add(id);
      return { ...z, id, auto: true };
    });
  return sortByStart([...touched, ...fresh]);
}

// ── Speed segments ──────────────────────────────────────────────────────────

/** Take `[a, b]` out of a lane of segments: trimmed, dropped or split around it. */
export function subtractSpan<T extends Span & { id: string }>(items: T[], a: number, b: number, minLength: number, taken: Set<string>, prefix: string): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (item.end <= a || item.start >= b) {
      out.push(item);
      continue;
    }
    const left = item.start < a && a - item.start >= minLength;
    if (left) out.push({ ...item, end: a });
    if (item.end > b && item.end - b >= minLength) {
      const id = left ? uniqueId(prefix, taken) : item.id;
      taken.add(id);
      out.push({ ...item, id, start: b });
    }
  }
  return out;
}

/** X: a speed segment (2× by default) over a source span, replacing what was there. */
export function addSpeedOver(project: Project, start: number, end: number, rate: number, duration: number): { project: Project; id: string } | null {
  const a = clamp(Math.min(start, end), 0, duration);
  const b = clamp(Math.max(start, end), 0, duration);
  if (b - a < MIN_SPEED) return null;
  const taken = new Set(project.speed.map((s) => s.id));
  const rest = subtractSpan(project.speed, a, b, MIN_SPEED, taken, "s");
  const id = uniqueId("s", taken);
  const segment: SpeedSegment = { id, start: a, end: b, rate, auto: null };
  return { project: { ...project, speed: sortByStart([...rest, segment]) }, id };
}

// ── Dragging a segment's body or edges ──────────────────────────────────────

export type SpanPart = "body" | "start" | "end";

/** The room a segment may move in: between its neighbours in its lane, inside the recording. */
export function roomFor(items: (Span & { id: string })[], id: string, duration: number): { min: number; max: number } {
  const self = items.find((item) => item.id === id);
  let min = 0;
  let max = duration;
  if (self === undefined) return { min, max };
  for (const item of items) {
    if (item.id === id) continue;
    if (item.end <= self.start + 1e-9) min = Math.max(min, item.end);
    else if (item.start >= self.end - 1e-9) max = Math.min(max, item.start);
  }
  return { min, max };
}

/**
 * Where a span goes while one of its parts is dragged: `pointer` is the source time
 * under the pointer, `grab` how far into the span the body was taken (source seconds).
 */
export function dragSpan(span: Span, part: SpanPart, pointer: number, grab: number, room: { min: number; max: number }, minLength: number): Span {
  if (part === "body") {
    const length = span.end - span.start;
    const start = clamp(pointer - grab, room.min, Math.max(room.min, room.max - length));
    return { start, end: start + length };
  }
  if (part === "start") return { start: clamp(pointer, room.min, span.end - minLength), end: span.end };
  return { start: span.start, end: clamp(pointer, span.start + minLength, room.max) };
}

// ── ⌫ ──────────────────────────────────────────────────────────────────────

/** Delete what is selected: a segment, a range (cut out), a piece of the clip, or a scissors marker (joined back). */
export function deleteSelection(project: Project, selection: Selection): { project: Project; selection: Selection } | null {
  switch (selection.kind) {
    case "zoom": {
      if (!project.zooms.some((z) => z.id === selection.id)) return null;
      return { project: { ...project, zooms: project.zooms.filter((z) => z.id !== selection.id) }, selection: NONE };
    }
    case "speed": {
      if (!project.speed.some((s) => s.id === selection.id)) return null;
      return { project: { ...project, speed: project.speed.filter((s) => s.id !== selection.id) }, selection: NONE };
    }
    case "range": {
      const cuts = removeRange(project.cuts, selection.start, selection.end);
      return cuts === null ? null : { project: { ...project, cuts }, selection: NONE };
    }
    case "clip": {
      const cuts = removePiece(project.cuts, selection.index);
      return cuts === null ? null : { project: { ...project, cuts }, selection: NONE };
    }
    case "gap": {
      const cuts = joinGap(project.cuts, selection.index);
      return cuts === null ? null : { project: { ...project, cuts }, selection: NONE };
    }
    case "none":
      return null;
  }
}

/** A selection that still names something in the project (after an undo, a re-solve). */
export function validSelection(project: Project, selection: Selection): Selection {
  switch (selection.kind) {
    case "zoom":
      return project.zooms.some((z) => z.id === selection.id) ? selection : NONE;
    case "speed":
      return project.speed.some((s) => s.id === selection.id) ? selection : NONE;
    case "clip":
      return selection.index < project.cuts.length ? selection : NONE;
    case "gap":
      return selection.index < project.cuts.length - 1 ? selection : NONE;
    default:
      return selection;
  }
}

/** The span X speeds up: the selected range, else a couple of seconds from the playhead. */
export function speedSpanFor(selection: Selection, tSrc: number, duration: number): Span {
  if (selection.kind === "range") return { start: selection.start, end: selection.end };
  return { start: tSrc, end: Math.min(duration, tSrc + NEW_SPEED_SECONDS) };
}
