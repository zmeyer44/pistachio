/**
 * Where the host's stage lies in a layer's own pixels — the one coordinate
 * mapping every layer here draws through (docs/live-share.md §8). The guest
 * page sets it from its letterboxed fit (or a window filling the stage); the
 * host's overlay sets it from the stage's rect in its window. A point at
 * stage-normalized (x, y) is at `box.x + x * box.w, box.y + y * box.h`.
 *
 * Changed imperatively by its owner and read by the layers in their frame
 * loops: a resize never re-renders React.
 */

import type { Rect } from "../protocol.js";

export interface StageBoxSource {
  get(): Rect;
  /** Called after every change. */
  subscribe(listener: () => void): () => void;
}

export interface StageBox extends StageBoxSource {
  set(rect: Rect): void;
}

export function createStageBox(initial: Rect = { x: 0, y: 0, w: 0, h: 0 }): StageBox {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(rect) {
      if (rect.x === current.x && rect.y === current.y && rect.w === current.w && rect.h === current.h) return;
      current = rect;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A stage-normalized point in the box's pixels. */
export function boxPoint(box: Rect, x: number, y: number): { x: number; y: number } {
  return { x: box.x + x * box.w, y: box.y + y * box.h };
}
