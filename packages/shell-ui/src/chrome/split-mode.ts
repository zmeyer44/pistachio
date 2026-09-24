/**
 * What the split controls do to the split mode. Pure on purpose — no React,
 * no store — so vitest pins the two behaviours under node: the button
 * cycles, the key toggles.
 */

import type { SplitMode } from "@pistachio/shell-contracts/ipc";

/** The ONE split cycle every control shares: single → vertical → horizontal → grid → single. */
export function nextSplitMode(mode: SplitMode): SplitMode {
  return mode === "single" ? "vertical" : mode === "vertical" ? "horizontal" : mode === "horizontal" ? "grid" : "single";
}

/**
 * What the ⌘\ key does: split or unsplit. A key press is a toggle — one
 * press in, the next press out — where a button one can see cycles through
 * the orientations; either split mode counts as "in".
 */
export function toggledSplitMode(mode: SplitMode): SplitMode {
  return mode === "single" ? "vertical" : "single";
}
