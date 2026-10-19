/**
 * Pointers in the room (docs/live-share.md §9 Cursors).
 *
 * Senders throttle (`CursorThrottle`): at most one `lv.cursor` every 16 ms,
 * only when the pointer moved more than half a stage pixel or its tool or
 * press changed, and always the last position once the pointer rests.
 * Receivers smooth (`CursorSmoother`): each pointer glides toward its latest
 * sample by exponential smoothing on elapsed time, so it settles in ~24 ms
 * whatever the display's frame rate — enough to hide the gaps between
 * samples, little enough to add almost nothing to the pointer's lag (the
 * glide and the throttle were ~47 ms of it at 33 ms and an 80 ms glide); it
 * fades after 5 s still and is forgotten after 30 s without a sample.
 */

import type { Size } from "./geometry.js";
import type { LiveCursor, LiveTool } from "./protocol.js";

/** One pointer position as it goes on the wire: stage-normalized, with its tool and whether it is pressed. */
export interface CursorSample {
  x: number;
  y: number;
  tool: LiveTool;
  down?: boolean;
}

/** A pointer to draw this frame. */
export interface SmoothedCursor {
  id: string;
  x: number;
  y: number;
  tool: LiveTool;
  down: boolean;
  /** 0..1: fades out when the pointer rests or hides. */
  opacity: number;
}

/** The time constant of the glide: after 24 ms a pointer has closed 95% of the distance (three of these). */
export const CURSOR_GLIDE_TAU_MS = 8;
/** How often a sender may send its pointer: about once a display frame. */
export const CURSOR_SEND_INTERVAL_MS = 16;
const REST_HIDE_MS = 5_000;
const REST_FADE_MS = 300;
const HIDE_FADE_MS = 150;
const FORGET_MS = 30_000;

interface Track {
  x: number;
  y: number;
  target: CursorSample;
  /** When the last sample arrived. */
  seenAt: number;
  /** When the pointer last moved (or changed tool or press). */
  movedAt: number;
  /** When it was hidden, or null while shown. */
  hiddenAt: number | null;
  /** The last time `sample` advanced it. */
  steppedAt: number;
}

export class CursorSmoother {
  readonly #tracks = new Map<string, Track>();
  readonly #tauMs: number;

  constructor(options: { glideTauMs?: number } = {}) {
    this.#tauMs = options.glideTauMs ?? CURSOR_GLIDE_TAU_MS;
  }

  /** A sample (or a hide) from `id`, received at `at` (ms, the same clock `sample` is given). */
  push(id: string, cursor: LiveCursor, at: number): void {
    const track = this.#tracks.get(id);
    if ("hidden" in cursor) {
      if (track !== undefined && track.hiddenAt === null) {
        track.hiddenAt = at;
        track.seenAt = at;
      }
      return;
    }
    const sample: CursorSample = { x: cursor.x, y: cursor.y, tool: cursor.tool, down: cursor.down === true };
    if (track === undefined || track.hiddenAt !== null) {
      // A pointer that appears does so where it is, not gliding in from where it left.
      this.#tracks.set(id, { x: sample.x, y: sample.y, target: sample, seenAt: at, movedAt: at, hiddenAt: null, steppedAt: at });
      return;
    }
    const moved =
      sample.x !== track.target.x ||
      sample.y !== track.target.y ||
      sample.tool !== track.target.tool ||
      sample.down !== track.target.down;
    track.target = sample;
    track.seenAt = at;
    if (moved) track.movedAt = at;
  }

  /** Forget a pointer at once (its participant left). */
  remove(id: string): void {
    this.#tracks.delete(id);
  }

  /** Every pointer to draw at `now`, advanced toward its target; drops the ones forgotten. */
  sample(now: number): SmoothedCursor[] {
    const out: SmoothedCursor[] = [];
    for (const [id, track] of this.#tracks) {
      if (now - track.seenAt > FORGET_MS) {
        this.#tracks.delete(id);
        continue;
      }
      const dt = Math.max(0, now - track.steppedAt);
      track.steppedAt = Math.max(track.steppedAt, now);
      const k = 1 - Math.exp(-dt / this.#tauMs);
      track.x += (track.target.x - track.x) * k;
      track.y += (track.target.y - track.y) * k;
      const opacity = opacityAt(track, now);
      if (opacity <= 0) continue;
      out.push({ id, x: track.x, y: track.y, tool: track.target.tool, down: track.target.down === true, opacity });
    }
    return out;
  }

  /**
   * Whether any pointer glides or fades at `now` — a renderer stops its frame
   * loop when not, and wakes at `nextChange` (a pointer at rest only begins
   * to fade 5 s later: nothing needs drawing until then).
   */
  animating(now: number): boolean {
    for (const track of this.#tracks.values()) {
      if (Math.abs(track.target.x - track.x) > 1e-4 || Math.abs(track.target.y - track.y) > 1e-4) return true;
      if (track.hiddenAt !== null) {
        if (now - track.hiddenAt < HIDE_FADE_MS) return true;
        continue;
      }
      const still = now - track.movedAt - REST_HIDE_MS;
      if (still >= 0 && still < REST_FADE_MS) return true;
    }
    return false;
  }

  /** When a pointer resting now begins to fade (ms, the clock `sample` is given), or null when none will. */
  nextChange(now: number): number | null {
    let next: number | null = null;
    for (const track of this.#tracks.values()) {
      if (track.hiddenAt !== null) continue;
      const fadesAt = track.movedAt + REST_HIDE_MS;
      if (fadesAt > now && (next === null || fadesAt < next)) next = fadesAt;
    }
    return next;
  }
}

function opacityAt(track: Track, now: number): number {
  if (track.hiddenAt !== null) return Math.max(0, 1 - (now - track.hiddenAt) / HIDE_FADE_MS);
  const still = now - track.movedAt - REST_HIDE_MS;
  return still <= 0 ? 1 : Math.max(0, 1 - still / REST_FADE_MS);
}

export interface CursorThrottleOptions {
  /** Called with each `lv.cursor` body to send. */
  send: (cursor: LiveCursor) => void;
  /** The stage in px, to judge "moved half a pixel". */
  stageSize: () => Size;
  intervalMs?: number;
  /** In stage px. */
  minMovePx?: number;
}

/**
 * The sending side: `update` on every local pointer event, `null` when the
 * pointer leaves the stage. A move inside the interval is held and the
 * latest one sent when it ends, so the last position always goes out.
 */
export class CursorThrottle {
  readonly #send: (cursor: LiveCursor) => void;
  readonly #stageSize: () => Size;
  readonly #intervalMs: number;
  readonly #minMovePx: number;
  #sent: LiveCursor | null = null;
  #pending: LiveCursor | null = null;
  #lastSentAt = -Infinity;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: CursorThrottleOptions) {
    this.#send = options.send;
    this.#stageSize = options.stageSize;
    this.#intervalMs = options.intervalMs ?? CURSOR_SEND_INTERVAL_MS;
    this.#minMovePx = options.minMovePx ?? 0.5;
  }

  /** The local pointer now (`null`: hidden), at `now` ms. */
  update(sample: CursorSample | null, now: number): void {
    const cursor: LiveCursor =
      sample === null ? { hidden: true } : { x: sample.x, y: sample.y, tool: sample.tool, ...(sample.down ? { down: true } : {}) };
    if (!this.#differs(cursor, this.#sent)) {
      this.#pending = null;
      return;
    }
    if (now - this.#lastSentAt >= this.#intervalMs && this.#timer === null) {
      this.#emit(cursor, now);
      return;
    }
    this.#pending = cursor;
    if (this.#timer === null) {
      const wait = Math.max(0, this.#intervalMs - (now - this.#lastSentAt));
      this.#timer = setTimeout(() => {
        this.#timer = null;
        const pending = this.#pending;
        this.#pending = null;
        if (pending !== null) this.#emit(pending, now + wait);
      }, wait);
    }
  }

  /** Stop: drops a held position (the caller sends a hide itself if it should). */
  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending = null;
  }

  #emit(cursor: LiveCursor, at: number): void {
    this.#sent = cursor;
    this.#lastSentAt = at;
    this.#send(cursor);
  }

  #differs(next: LiveCursor, sent: LiveCursor | null): boolean {
    if (sent === null) return true;
    if ("hidden" in next || "hidden" in sent) return "hidden" in next !== "hidden" in sent;
    if (next.tool !== sent.tool || (next.down === true) !== (sent.down === true)) return true;
    const stage = this.#stageSize();
    const dx = (next.x - sent.x) * stage.w;
    const dy = (next.y - sent.y) * stage.h;
    return Math.hypot(dx, dy) > this.#minMovePx;
  }
}
