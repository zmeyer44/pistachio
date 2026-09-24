/**
 * The pinned sidebar's width, per machine — the sibling of lib/panel.ts for
 * the agent console. The bounds are the chrome contract's (@pistachio/shell-contracts/chrome)
 * and the same stored number sizes both the pinned column and compact
 * column's expanded motion slot. The store clamps every width it stores, so
 * the column itself needs no min/max.
 */

import { SIDEBAR_DEFAULT_W, SIDEBAR_MAX_W, SIDEBAR_MIN_W } from "@pistachio/shell-contracts/chrome";
import { writeStorageLater } from "./deferred-storage";

const WIDTH_KEY = "pistachio:sidebarWidth";

export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT_W;
  return Math.min(Math.max(Math.round(px), SIDEBAR_MIN_W), SIDEBAR_MAX_W);
}

export function getStoredSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    return raw === null ? SIDEBAR_DEFAULT_W : clampSidebarWidth(Number.parseInt(raw, 10));
  } catch {
    return SIDEBAR_DEFAULT_W;
  }
}

/** Deferred: a resize drag sets the width every frame (lib/deferred-storage.ts). */
export function storeSidebarWidth(px: number): void {
  writeStorageLater(WIDTH_KEY, String(clampSidebarWidth(px)));
}
