/**
 * Split groups, as arithmetic rather than as views.
 *
 * A split group is a persistent tab-group whose two to four members reopen
 * together (`SplitGroupInfo` in ./ipc.ts). Building one is the same work
 * wherever the panes are painted — over `WebContentsView`s in Electron main
 * or into a streamed pane in the web app — so it lives here and both hosts
 * call it, rather than each keeping a copy that can disagree about what a
 * three-pane grid means.
 */

import type { SplitGridLayout, SplitGroupInfo, SplitMode, SplitOrientation, SplitSide } from "./ipc.js";

/** Two to four panes: past four nothing on a laptop screen is readable. */
export const MAX_SPLIT_PANES = 4;

/**
 * A group from its ordered members. The deprecated `primaryTabId` /
 * `secondaryTabId` aliases are filled here, in one place, so no caller has to
 * remember they exist.
 */
export function splitGroupInfo(
  id: string,
  tabIds: readonly string[],
  mode: SplitOrientation,
  gridLayout: SplitGridLayout = "span-bottom",
): SplitGroupInfo {
  if (tabIds.length < 2 || tabIds.length > MAX_SPLIT_PANES) {
    throw new Error("split groups require two to four tabs");
  }
  return {
    id,
    tabIds: [...tabIds],
    // Keep these aliases until older renderer and session clients age out.
    primaryTabId: tabIds[0]!,
    secondaryTabId: tabIds[1]!,
    mode,
    gridLayout,
  };
}

/** The grid layout a drop on one edge produces: the dropped pane spans that edge. */
export function gridLayoutForSide(side: SplitSide): SplitGridLayout {
  return `span-${side}`;
}

/** The orientation a drop on one edge implies. */
export function orientationForSide(side: SplitSide): SplitOrientation {
  return side === "left" || side === "right" ? "vertical" : "horizontal";
}

/** What `ShellSnapshot.splitMode` reads as for a group of `panes` members. */
export function splitModeFor(group: SplitGroupInfo | undefined): SplitMode {
  return group === undefined ? "single" : group.mode;
}
