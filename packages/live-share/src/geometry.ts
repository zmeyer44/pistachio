/**
 * The desk's geometry on both ends (docs/live-share.md §4, §7): fitting the
 * host's stage into a viewport, moving points between stage px, stage-
 * normalized and viewport px, and finding the window under a point.
 *
 * Everything on the wire is stage-normalized (0..1 of the host's stage), so a
 * host resize, which rescales the windows, keeps pointers and ink on what
 * they were over; these are the only conversions in and out of it.
 */

import type { LiveDeskFrame, LiveWindow, Rect } from "./protocol.js";

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Where the stage lies in a viewport: its scale from stage px and its box in viewport px. */
export interface StageFit extends Rect {
  scale: number;
}

/** A DOM-rect-like box (`getBoundingClientRect()` fits). */
export interface ClientBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The stage scaled to fit inside `viewport` less `padding` on every side,
 * centred, keeping its aspect (letterboxed). The whole desk is always in view.
 */
export function fitStage(stage: Size, viewport: Size, padding = 0): StageFit {
  const room = { w: Math.max(0, viewport.w - padding * 2), h: Math.max(0, viewport.h - padding * 2) };
  if (stage.w <= 0 || stage.h <= 0) return { scale: 0, x: viewport.w / 2, y: viewport.h / 2, w: 0, h: 0 };
  const scale = Math.min(room.w / stage.w, room.h / stage.h);
  const w = stage.w * scale;
  const h = stage.h * scale;
  return { scale, x: (viewport.w - w) / 2, y: (viewport.h - h) / 2, w, h };
}

/** Stage px → stage-normalized. */
export function stageToNormalized(stage: Size, point: Point): Point {
  return { x: point.x / stage.w, y: point.y / stage.h };
}

/** Stage-normalized → stage px. */
export function normalizedToStage(stage: Size, point: Point): Point {
  return { x: point.x * stage.w, y: point.y * stage.h };
}

/** Stage-normalized → viewport px, through a fit. */
export function normalizedToViewport(fit: Rect, point: Point): Point {
  return { x: fit.x + point.x * fit.w, y: fit.y + point.y * fit.h };
}

/** Viewport px → stage-normalized, through a fit. Not clamped: outside the stage is outside 0..1. */
export function viewportToNormalized(fit: Rect, point: Point): Point {
  if (fit.w <= 0 || fit.h <= 0) return { x: 0, y: 0 };
  return { x: (point.x - fit.x) / fit.w, y: (point.y - fit.y) / fit.h };
}

/** A rect in stage px → viewport px, through a fit (a window's frame or page box onto the guest's stage). */
export function stageRectToViewport(fit: StageFit, rect: Rect): Rect {
  return { x: fit.x + rect.x * fit.scale, y: fit.y + rect.y * fit.scale, w: rect.w * fit.scale, h: rect.h * fit.scale };
}

const clampUnit = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * A client point over the stage's element as stage-normalized, clamped to
 * 0..1, and whether it was inside — the host hides its pointer outside, a
 * stroke dragged past the edge stays on it.
 */
export function stagePoint(stageBox: ClientBox, clientX: number, clientY: number): Point & { inside: boolean } {
  if (stageBox.width <= 0 || stageBox.height <= 0) return { x: 0, y: 0, inside: false };
  const x = (clientX - stageBox.left) / stageBox.width;
  const y = (clientY - stageBox.top) / stageBox.height;
  return { x: clampUnit(x), y: clampUnit(y), inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

/** The top-most window not minimized whose frame holds the stage-normalized point, or null. */
export function windowAt(frame: LiveDeskFrame, nx: number, ny: number): LiveWindow | null {
  const x = nx * frame.stage.w;
  const y = ny * frame.stage.h;
  for (let index = frame.windows.length - 1; index >= 0; index -= 1) {
    const win = frame.windows[index];
    if (win !== undefined && !win.minimized && contains(win.frame, x, y)) return win;
  }
  return null;
}

/** A stage-normalized point as 0..1 of a window's page box, or null when it falls outside the page. */
export function pageLocal(stage: Size, win: LiveWindow, nx: number, ny: number): Point | null {
  const x = nx * stage.w;
  const y = ny * stage.h;
  if (win.page.w <= 0 || win.page.h <= 0 || !contains(win.page, x, y)) return null;
  return { x: (x - win.page.x) / win.page.w, y: (y - win.page.y) / win.page.h };
}
