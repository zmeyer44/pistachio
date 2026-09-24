/**
 * The agent console's width, per machine. The store clamps every width it
 * stores, so the panel itself needs no min/max — a CSS min would pin the
 * collapsed end of the open/close slide.
 */

import { writeStorageLater } from "./deferred-storage";

const WIDTH_KEY = "pistachio:consoleWidth";

export const PANEL_DEFAULT_WIDTH = 420;
/** Below this the console's cards and composer stop being usable; above it
 *  the panel starts crowding the page it is meant to be watching. */
export const PANEL_MIN_WIDTH = 340;
export const PANEL_MAX_WIDTH = 720;

export function clampPanelWidth(px: number): number {
  if (!Number.isFinite(px)) return PANEL_DEFAULT_WIDTH;
  return Math.min(Math.max(Math.round(px), PANEL_MIN_WIDTH), PANEL_MAX_WIDTH);
}

export function getStoredPanelWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    return raw === null ? PANEL_DEFAULT_WIDTH : clampPanelWidth(Number.parseInt(raw, 10));
  } catch {
    return PANEL_DEFAULT_WIDTH;
  }
}

/** Deferred: a resize drag sets the width every frame (lib/deferred-storage.ts). */
export function storePanelWidth(px: number): void {
  writeStorageLater(WIDTH_KEY, String(clampPanelWidth(px)));
}
