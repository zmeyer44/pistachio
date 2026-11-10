import type { ContentBounds } from "@pistachio/shell-contracts/ipc";

import { SURFACE_INSET } from "../chrome/drag-geometry";
const PREVIEW_WIDTH_RATIO = 0.8;
/** The actions beside the card (GlanceOverlay): a 12px gap, a 36px button, 12px of padding each side — kept clear at both sides of a centered card. */
const ACTIONS_ROOM = 72;

export interface GlanceFrame {
  window: ContentBounds;
  local: ContentBounds;
  sourceLocal: ContentBounds;
}

/**
 * Compute the centered 80%-wide, full-content-height preview frame — within the surface short of `reserve` at its
 * trailing side (the room the desk keeps for the chat in its place, DeskEngine.setReserve): the card and the actions
 * beside it lie in what is left, never under the chat's column (2026-11-03: they were, and the actions were hidden).
 */
export function glanceFrame(surface: DOMRect, source: ContentBounds, reserve = 0): GlanceFrame {
  const innerWidth = Math.max(1, surface.width - SURFACE_INSET * 2 - Math.max(0, reserve));
  const innerHeight = Math.max(1, surface.height - SURFACE_INSET * 2);
  // (Narrower than 720px — the chat beside it — the card gives up its share for the actions' room at its side.)
  const width = Math.max(1, Math.min(Math.round(innerWidth * PREVIEW_WIDTH_RATIO), innerWidth - ACTIONS_ROOM * 2));
  const local: ContentBounds = {
    x: Math.round(SURFACE_INSET + (innerWidth - width) / 2),
    y: SURFACE_INSET,
    width,
    height: Math.round(innerHeight),
  };
  const sourceLocal = {
    x: Math.round(source.x - surface.left),
    y: Math.round(source.y - surface.top),
    width: Math.max(1, Math.round(source.width)),
    height: Math.max(1, Math.round(source.height)),
  };
  return {
    local,
    sourceLocal,
    window: {
      x: Math.round(surface.left + local.x),
      y: Math.round(surface.top + local.y),
      width: local.width,
      height: local.height,
    },
  };
}
