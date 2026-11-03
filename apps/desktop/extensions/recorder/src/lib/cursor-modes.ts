/**
 * The cursor settings that need a capture without Chromium's cursor in its pixels (the meta line's
 * `cursorBaked: false`, R5). While it is baked in, Smooth and Glide would draw a second cursor beside the recorded
 * one, and Hidden or Hide when idle would hide the drawn cursor while the recorded one stays: all four are locked,
 * and the inspector says why.
 */

import type { CursorSpec } from "./types.js";

export const BAKED_CURSOR_LOCKED_MODES: readonly CursorSpec["mode"][] = ["smooth", "glide", "hidden"];

/** Whether a cursor mode may be chosen for a recording (`locked`: its cursor is baked in). */
export function cursorModeAvailable(mode: CursorSpec["mode"], locked: boolean): boolean {
  return !locked || !BAKED_CURSOR_LOCKED_MODES.includes(mode);
}

/** Whether Hide when idle may be turned on for a recording. */
export function hideIdleAvailable(locked: boolean): boolean {
  return !locked;
}

/**
 * `cursor` as a recording allows it: with the cursor baked in, a locked mode falls back to Natural and Hide when
 * idle is off — the drawn cursor would fade while the recorded one stayed, and no control could turn it back.
 * (A solved project and a restored one alike.)
 */
export function cursorSpecAllowed(cursor: CursorSpec, locked: boolean): CursorSpec {
  if (!locked) return cursor;
  return { ...cursor, mode: cursorModeAvailable(cursor.mode, locked) ? cursor.mode : "natural", hideIdle: false };
}

/** What the lock note says. */
export const CURSOR_LOCK_NOTE = "Smooth, Glide, Hidden and Hide when idle need a newer Pistachio: this recording has the system cursor drawn into it.";
