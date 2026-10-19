/**
 * The guest's view of the stage (docs/live-share.md §1, §7): the host's
 * stage fitted into what the page leaves free — letterboxed, the whole desk
 * always in view — or, while the guest has brought one window up, scaled so
 * that window's frame fills that space instead. Pure, so the layout the page
 * applies by ref and the box the overlays draw through come from one place.
 */

import { fitStage, type Size } from "../geometry.js";
import type { Rect } from "../protocol.js";

/** Room kept clear on each side of the viewport: the strips above windows, the toolbar, the faces, a panel. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface StageLayout {
  /** Stage px → page px. */
  scale: number;
  /** The whole stage's box in page px; past `visible` while a window fills the view. */
  view: Rect;
  /** What is on screen: the fitted stage, or the window that fills it. Overlays clip to this. */
  visible: Rect;
}

/** The viewport less its insets, never negative. */
export function stageArea(viewport: Size, insets: Insets): Rect {
  return {
    x: insets.left,
    y: insets.top,
    w: Math.max(0, viewport.w - insets.left - insets.right),
    h: Math.max(0, viewport.h - insets.top - insets.bottom),
  };
}

/**
 * The stage fitted into `area`, centred and keeping its aspect; with `fill`
 * (a window's frame, stage px), scaled and moved so that rect fills `area`
 * the same way, the rest of the stage running off past it.
 */
export function stageLayout(stage: Size, area: Rect, fill: Rect | null = null): StageLayout {
  if (fill === null || fill.w <= 0 || fill.h <= 0) {
    const fit = fitStage(stage, { w: area.w, h: area.h });
    const view = { x: area.x + fit.x, y: area.y + fit.y, w: fit.w, h: fit.h };
    return { scale: fit.scale, view, visible: view };
  }
  const fit = fitStage({ w: fill.w, h: fill.h }, { w: area.w, h: area.h });
  const visible = { x: area.x + fit.x, y: area.y + fit.y, w: fit.w, h: fit.h };
  return {
    scale: fit.scale,
    view: { x: visible.x - fill.x * fit.scale, y: visible.y - fill.y * fit.scale, w: stage.w * fit.scale, h: stage.h * fit.scale },
    visible,
  };
}

/** A rect in stage px as page px under a layout. */
export function placeRect(layout: StageLayout, rect: Rect): Rect {
  return {
    x: layout.view.x + rect.x * layout.scale,
    y: layout.view.y + rect.y * layout.scale,
    w: rect.w * layout.scale,
    h: rect.h * layout.scale,
  };
}

/** `rect` relative to `origin` (a window's page box inside its frame, both page px). */
export function relativeRect(rect: Rect, origin: Rect): Rect {
  return { x: rect.x - origin.x, y: rect.y - origin.y, w: rect.w, h: rect.h };
}
