/**
 * Ink over the desk (docs/live-share.md §4 Ink).
 *
 * `InkBoard` is the board every client keeps and the host's is the one a
 * sync carries: it applies `lv.ink` ops under the ownership rules — a stroke's
 * owner is in its id (`<identity>:<n>`), only the owner adds to, ends or
 * erases it, `clear: "mine"` takes the sender's own, `clear: "all"` is the
 * host's alone — holds at most 400 strokes (the oldest go), and lets a laser
 * stroke fade 1.2 s after its last point. A stroke still open with no point
 * for 3 s is drawn as finished (`strokeSettled`): its `end` may never come
 * to this board — a late joiner's sync can carry a stroke whose end reached
 * the guest first and was refused — and an open stroke would otherwise keep
 * a renderer drawing it as live. Its owner's next points still land. Every
 * point it keeps lies on a 1/10000 grid of the stage, whoever sent it (the
 * recorder sends them so): a coordinate is then at most 7 characters of a
 * sync, and a full board well within what a guest reads of one.
 *
 * `InkRecorder` turns a local gesture into those ops: `begin` at once, then
 * the points in `add`s of at most 64 pairs every ~24 ms, points closer than
 * half a stage pixel to the last one dropped. `strokeOutline` draws a stroke
 * with perfect-freehand as SVG path data at whatever size the stage is shown.
 */

import { getStroke, type StrokeOptions } from "perfect-freehand";
import type { Point, Size } from "./geometry.js";
import {
  MAX_INK_PAIRS_PER_MESSAGE,
  MAX_STROKE_PAIRS,
  MAX_STROKES,
  strokeOwner,
  type InkTool,
  type LiveInkOp,
  type LiveRole,
  type LiveStroke,
} from "./protocol.js";

/** How long a laser stroke takes to fade from its last point. */
export const LASER_FADE_MS = 1200;

/** How long an open stroke may go without a point before it is drawn as finished. */
export const STROKE_IDLE_MS = 3000;

/**
 * A stage-normalized coordinate on the ink's grid, 1/10000 of the stage: half
 * a pixel of a 5K stage, as fine as the recorder keeps points (half a stage
 * pixel apart) and finer than the outline draws (`n2`, 1/100 px of whatever
 * size it is shown at). The recorder sends points on it and a board keeps
 * nothing finer, so a coordinate is at most 7 characters of a sync ("0.1234,").
 */
const quantize = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;

/** Default stroke widths, as a fraction of the stage's width (≈ 3.5 px, 17 px and 4.5 px on a 1440 px stage). */
export const INK_SIZES: Readonly<Record<InkTool, number>> = {
  pen: 0.0025,
  highlighter: 0.012,
  laser: 0.003,
};

/** How each tool reads: a highlighter is translucent, a laser glows (the renderer adds the glow). */
export const INK_STYLE: Readonly<Record<InkTool, { opacity: number; glow: boolean }>> = {
  pen: { opacity: 1, glow: false },
  highlighter: { opacity: 0.38, glow: false },
  laser: { opacity: 1, glow: true },
};

/** A stroke as a board holds it. */
export interface BoardStroke extends LiveStroke {
  owner: string;
  /** When its `begin` arrived, ms; -Infinity for one a sync brought (the host had it before this board asked). */
  beganAt: number;
  /** When its last point (or its end) arrived, ms — a laser fades from here. */
  lastAt: number;
}

/** Who sent an op: the identity the room says sent it, and its role. */
export interface InkSender {
  identity: string;
  role: LiveRole;
}

export class InkBoard {
  readonly #maxStrokes: number;
  /** In begin order: the first is the oldest. */
  readonly #strokes = new Map<string, BoardStroke>();
  /**
   * What was deleted here, for a sync whose snapshot is older (`load`), held
   * whether or not this board had the strokes (one just come has none of a
   * sync's): when the host last cleared everything, when each owner last
   * cleared their own, and the strokes erased — the latest, as many as a
   * board holds; an id is never drawn again, so an erasure holds for good.
   */
  #clearedAll = -Infinity;
  readonly #clearedMine = new Map<string, number>();
  readonly #erased = new Set<string>();
  #version = 0;

  constructor(options: { maxStrokes?: number } = {}) {
    this.#maxStrokes = options.maxStrokes ?? MAX_STROKES;
  }

  /** Bumped on every change, so a renderer redraws only when it moved. */
  get version(): number {
    return this.#version;
  }

  get size(): number {
    return this.#strokes.size;
  }

  /** Apply one op from `from` at `now` (ms); false when the rules refuse it or it changes nothing. */
  apply(op: LiveInkOp, from: InkSender, now: number): boolean {
    switch (op.op) {
      case "begin": {
        if (strokeOwner(op.id) !== from.identity || this.#strokes.has(op.id)) return false;
        const pts = op.pts.slice(0, MAX_STROKE_PAIRS * 2).map(quantize);
        this.#strokes.set(op.id, { id: op.id, tool: op.tool, color: op.color, size: op.size, pts, done: false, owner: from.identity, beganAt: now, lastAt: now });
        this.#trim();
        return this.#changed();
      }
      case "add": {
        const stroke = this.#own(op.id, from);
        if (stroke === null || stroke.done) return false;
        const room = MAX_STROKE_PAIRS * 2 - stroke.pts.length;
        if (room <= 0) return false;
        stroke.pts.push(...op.pts.slice(0, room).map(quantize));
        stroke.lastAt = now;
        return this.#changed();
      }
      case "end": {
        const stroke = this.#own(op.id, from);
        if (stroke === null || stroke.done) return false;
        stroke.done = true;
        stroke.lastAt = now;
        return this.#changed();
      }
      case "erase": {
        if (strokeOwner(op.id) !== from.identity) return false;
        this.#erase(op.id);
        if (this.#own(op.id, from) === null) return false;
        this.#strokes.delete(op.id);
        return this.#changed();
      }
      case "clear": {
        if (op.scope === "all") {
          if (from.role !== "host") return false;
          this.#clearedAll = now;
          if (this.#strokes.size === 0) return false;
          this.#strokes.clear();
          return this.#changed();
        }
        this.#clearedMine.set(from.identity, now);
        let removed = false;
        for (const [id, stroke] of this.#strokes) {
          if (stroke.owner === from.identity) {
            this.#strokes.delete(id);
            removed = true;
          }
        }
        return removed ? this.#changed() : false;
      }
    }
  }

  /** The strokes to draw at `now`, oldest first, without the lasers that have faded (`expire` drops them). */
  visible(now: number): BoardStroke[] {
    return [...this.#strokes.values()].filter((stroke) => !faded(stroke, now));
  }

  /** Drop the lasers that have faded by `now`; true when the board changed. */
  expire(now: number): boolean {
    let dropped = false;
    for (const [id, stroke] of this.#strokes) {
      if (faded(stroke, now)) {
        this.#strokes.delete(id);
        dropped = true;
      }
    }
    return dropped ? this.#changed() : false;
  }

  /**
   * When the board next changes by itself, after `now`: a laser fading out,
   * or an open stroke going idle (`strokeSettled`). Null when nothing will.
   */
  nextChange(now: number): number | null {
    let next: number | null = null;
    for (const stroke of this.#strokes.values()) {
      const at = stroke.tool === "laser" ? stroke.lastAt + LASER_FADE_MS : stroke.done ? null : stroke.lastAt + STROKE_IDLE_MS;
      if (at !== null && at > now && (next === null || at < next)) next = at;
    }
    return next;
  }

  /** The board for a sync: pens and highlighters (a laser is gone before a guest could see it). */
  snapshot(): LiveStroke[] {
    const out: LiveStroke[] = [];
    for (const stroke of this.#strokes.values()) {
      if (stroke.tool === "laser") continue;
      out.push({ id: stroke.id, tool: stroke.tool, color: stroke.color, size: stroke.size, pts: [...stroke.pts], done: stroke.done });
    }
    return out;
  }

  /**
   * Take a sync's board, received at `now`. The host took its snapshot once
   * the sync was asked for (`since`, on this board's clock) — perhaps long
   * before it arrives — so what this board heard from then on is newer: a
   * stroke that began reaching it since and is not in the sync came after
   * the snapshot and stays, and one erased or cleared here since (by its
   * owner, or the host's clear) stays gone though the snapshot still holds
   * it. A stroke older than `since` and not in the sync is gone on the host
   * (a clear this board missed while away) and goes; so does one an earlier
   * sync brought, which counts as older than any ask. For a stroke in both,
   * the copy with more points wins (points are only ever added). Without
   * `since`, nothing here outlasts the sync but what it holds too.
   */
  load(strokes: readonly LiveStroke[], now: number, since = Infinity): void {
    const held = new Map(this.#strokes);
    this.#strokes.clear();
    for (const stroke of strokes) {
      const owner = strokeOwner(stroke.id);
      if (owner === null) continue;
      const pts = stroke.pts.slice(0, MAX_STROKE_PAIRS * 2).map(quantize);
      const mine = held.get(stroke.id);
      if (mine !== undefined && mine.pts.length >= pts.length) this.#strokes.set(stroke.id, mine);
      else if (mine !== undefined || !this.#deletedSince(stroke.id, owner, since)) this.#strokes.set(stroke.id, { ...stroke, pts, owner, beganAt: -Infinity, lastAt: now });
    }
    for (const stroke of held.values()) {
      if (stroke.beganAt >= since && !this.#strokes.has(stroke.id)) this.#strokes.set(stroke.id, stroke);
    }
    this.#trim();
    this.#changed();
  }

  /** Finish whatever `identity` was drawing (they left mid-stroke); their ink stays. */
  release(identity: string, now: number): void {
    let changed = false;
    for (const stroke of this.#strokes.values()) {
      if (stroke.owner === identity && !stroke.done) {
        stroke.done = true;
        stroke.lastAt = now;
        changed = true;
      }
    }
    if (changed) this.#changed();
  }

  #own(id: string, from: InkSender): BoardStroke | null {
    const stroke = this.#strokes.get(id);
    return stroke !== undefined && stroke.owner === from.identity ? stroke : null;
  }

  #erase(id: string): void {
    this.#erased.add(id);
    if (this.#erased.size <= this.#maxStrokes) return;
    const [oldest] = this.#erased;
    if (oldest !== undefined) this.#erased.delete(oldest);
  }

  /** Whether `id`, `owner`'s, was erased here, or cleared at `since` or after. */
  #deletedSince(id: string, owner: string, since: number): boolean {
    return this.#erased.has(id) || this.#clearedAll >= since || (this.#clearedMine.get(owner) ?? -Infinity) >= since;
  }

  #trim(): void {
    for (const id of this.#strokes.keys()) {
      if (this.#strokes.size <= this.#maxStrokes) break;
      this.#strokes.delete(id);
    }
  }

  #changed(): true {
    this.#version += 1;
    return true;
  }
}

function faded(stroke: BoardStroke, now: number): boolean {
  return stroke.tool === "laser" && now - stroke.lastAt >= LASER_FADE_MS;
}

/**
 * Whether a stroke is drawn as finished at `now`: a pen or highlighter its
 * owner ended, or one still open with no point for `STROKE_IDLE_MS`. A
 * laser never is — it fades.
 */
export function strokeSettled(stroke: Pick<BoardStroke, "tool" | "done" | "lastAt">, now: number): boolean {
  return stroke.tool !== "laser" && (stroke.done || now - stroke.lastAt >= STROKE_IDLE_MS);
}

/**
 * Whether a board takes `op` from a guest while the host's *Guests can draw*
 * is `guestsCanDraw`: with drawing off nothing new of theirs lands (`begin`,
 * `add`), while ending, erasing and clearing their own still do. The host's
 * own ops always land.
 */
export function inkAllowed(op: LiveInkOp, role: LiveRole, guestsCanDraw: boolean): boolean {
  return role === "host" || guestsCanDraw || (op.op !== "begin" && op.op !== "add");
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const FREEHAND: Readonly<Record<InkTool, StrokeOptions>> = {
  // Crisp, a little pressure from speed, like a felt pen.
  pen: { thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: true },
  // Even width, flat ends, smoothed hard: a marker, not a pen.
  highlighter: { thinning: 0, smoothing: 0.7, streamline: 0.6, simulatePressure: false, start: { cap: true }, end: { cap: true } },
  // Thin and slightly tapered at the tail.
  laser: { thinning: 0.3, smoothing: 0.5, streamline: 0.4, simulatePressure: false, start: { taper: 24 } },
};

/** A stroke to draw: one off a board, or the one `InkRecorder` is drawing (no `lastAt`: it is live now). */
export type DrawableStroke = Pick<LiveStroke, "tool" | "size" | "pts" | "done"> & { lastAt?: number };

/** The opacity a stroke draws with at `now`: its tool's, times a laser's fade. */
export function strokeOpacity(stroke: Pick<DrawableStroke, "tool" | "lastAt">, now: number): number {
  const base = INK_STYLE[stroke.tool].opacity;
  if (stroke.tool !== "laser" || stroke.lastAt === undefined) return base;
  return base * Math.max(0, Math.min(1, 1 - (now - stroke.lastAt) / LASER_FADE_MS));
}

const n2 = (value: number): string => (Math.round(value * 100) / 100).toString();

/** perfect-freehand's outline as closed SVG path data (quadratic curves through the midpoints). */
function outlinePath(outline: number[][]): string {
  if (outline.length === 0) return "";
  const point = (index: number): [number, number] => {
    const p = outline[index % outline.length] ?? [0, 0];
    return [p[0] ?? 0, p[1] ?? 0];
  };
  if (outline.length < 4) {
    return `M${outline.map((_, index) => point(index).map(n2).join(",")).join(" L")} Z`;
  }
  const [x0, y0] = point(0);
  const [x1, y1] = point(1);
  const [x2, y2] = point(2);
  let d = `M${n2(x0)},${n2(y0)} Q${n2(x1)},${n2(y1)} ${n2((x1 + x2) / 2)},${n2((y1 + y2) / 2)} T`;
  for (let index = 2; index < outline.length - 1; index += 1) {
    const [ax, ay] = point(index);
    const [bx, by] = point(index + 1);
    d += `${n2((ax + bx) / 2)},${n2((ay + by) / 2)} `;
  }
  return `${d}Z`;
}

/**
 * A stroke as SVG path data (to fill, in the stroke's colour) on a stage
 * shown at `stageSize` px, and the opacity to draw it with at `now`.
 */
export function strokeOutline(stroke: DrawableStroke, stageSize: Size, now: number): { path: string; opacity: number } {
  const points: number[][] = [];
  for (let index = 0; index + 1 < stroke.pts.length; index += 2) {
    points.push([(stroke.pts[index] ?? 0) * stageSize.w, (stroke.pts[index + 1] ?? 0) * stageSize.h]);
  }
  const size = Math.max(1, stroke.size * stageSize.w);
  const outline = getStroke(points, { ...FREEHAND[stroke.tool], size, last: stroke.done });
  return { path: outlinePath(outline), opacity: strokeOpacity(stroke, now) };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface InkRecorderOptions {
  /** The local participant: stroke ids are `<identity>:<n>`. */
  identity: string;
  /** Each op, for the caller to apply to its board and send to the room. */
  emit: (op: LiveInkOp) => void;
  /** The stage in px, to judge "half a pixel". */
  stageSize: () => Size;
  /** How long points wait to be batched (16–33 ms). */
  flushMs?: number;
  /** In stage px. */
  minDistancePx?: number;
  /**
   * The first stroke number. Defaults to the clock in ms, so numbers keep
   * rising across a reload that keeps the identity — a reused id would be
   * refused by every board still holding the old stroke.
   */
  firstNumber?: number;
}

interface Recording {
  id: string;
  tool: InkTool;
  color: string;
  size: number;
  pts: number[];
  /** Pairs already sent. */
  sent: number;
}

export class InkRecorder {
  readonly #identity: string;
  readonly #emit: (op: LiveInkOp) => void;
  readonly #stageSize: () => Size;
  readonly #flushMs: number;
  readonly #minDistancePx: number;
  #next: number;
  #stroke: Recording | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: InkRecorderOptions) {
    this.#identity = options.identity;
    this.#emit = options.emit;
    this.#stageSize = options.stageSize;
    this.#flushMs = Math.min(33, Math.max(16, options.flushMs ?? 24));
    this.#minDistancePx = options.minDistancePx ?? 0.5;
    this.#next = (options.firstNumber ?? Date.now()) % 1_000_000_000;
  }

  /** Start a stroke at a stage-normalized point; returns its id. Ends one still open. */
  begin(tool: InkTool, color: string, size: number, point: Point): string {
    if (this.#stroke !== null) this.end();
    const id = `${this.#identity}:${String(this.#next)}`;
    this.#next = (this.#next + 1) % 1_000_000_000;
    const pts = [quantize(point.x), quantize(point.y)];
    this.#stroke = { id, tool, color, size, pts, sent: 1 };
    this.#emit({ op: "begin", id, tool, color, size, pts: [...pts] });
    return id;
  }

  /** The pointer moved to a stage-normalized point while drawing. */
  move(point: Point): void {
    const stroke = this.#stroke;
    if (stroke === null) return;
    const x = quantize(point.x);
    const y = quantize(point.y);
    const lastX = stroke.pts[stroke.pts.length - 2] ?? x;
    const lastY = stroke.pts[stroke.pts.length - 1] ?? y;
    const stage = this.#stageSize();
    if (Math.hypot((x - lastX) * stage.w, (y - lastY) * stage.h) < this.#minDistancePx) return;
    if (stroke.pts.length >= MAX_STROKE_PAIRS * 2) {
      // A stroke is full: finish it and carry on in a new one from the same point, seamlessly.
      this.begin(stroke.tool, stroke.color, stroke.size, { x: lastX, y: lastY });
      this.move(point);
      return;
    }
    stroke.pts.push(x, y);
    if (stroke.pts.length / 2 - stroke.sent >= MAX_INK_PAIRS_PER_MESSAGE) this.flush();
    else this.#schedule();
  }

  /** The pen lifted. */
  end(): void {
    const stroke = this.#stroke;
    if (stroke === null) return;
    this.flush();
    this.#stroke = null;
    this.#emit({ op: "end", id: stroke.id });
  }

  /** Send the points waiting now. */
  flush(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const stroke = this.#stroke;
    if (stroke === null) return;
    while (stroke.sent * 2 < stroke.pts.length) {
      const pts = stroke.pts.slice(stroke.sent * 2, (stroke.sent + MAX_INK_PAIRS_PER_MESSAGE) * 2);
      stroke.sent += pts.length / 2;
      this.#emit({ op: "add", id: stroke.id, pts });
    }
  }

  /** The stroke being drawn with every local point (sent or not), for drawing it without waiting on the batch. */
  current(): LiveStroke | null {
    const stroke = this.#stroke;
    if (stroke === null) return null;
    return { id: stroke.id, tool: stroke.tool, color: stroke.color, size: stroke.size, pts: stroke.pts, done: false };
  }

  /** Stop without sending what waits (the room is gone). */
  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#stroke = null;
  }

  #schedule(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, this.#flushMs);
  }
}
