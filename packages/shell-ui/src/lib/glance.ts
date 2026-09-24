import type { ContentBounds } from "@pistachio/shell-contracts/ipc";

import { SURFACE_INSET } from "../chrome/drag-geometry";
const PREVIEW_WIDTH_RATIO = 0.8;

export interface GlanceFrame {
  window: ContentBounds;
  local: ContentBounds;
  sourceLocal: ContentBounds;
}

/** Compute the centered 80%-wide, full-content-height preview frame. */
export function glanceFrame(surface: DOMRect, source: ContentBounds): GlanceFrame {
  const innerWidth = Math.max(1, surface.width - SURFACE_INSET * 2);
  const innerHeight = Math.max(1, surface.height - SURFACE_INSET * 2);
  const width = Math.max(1, Math.round(innerWidth * PREVIEW_WIDTH_RATIO));
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
