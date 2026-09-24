import type { SplitGridLayout, SplitOrientation, SplitSide } from "@pistachio/shell-contracts/ipc";

export type SplitAxis = "vertical" | "horizontal";

export type SplitLayoutNode =
  | { kind: "pane"; tabId: string }
  | { kind: "split"; axis: SplitAxis; children: SplitLayoutNode[] };

const pane = (tabId: string): SplitLayoutNode => ({ kind: "pane", tabId });
const split = (axis: SplitAxis, children: SplitLayoutNode[]): SplitLayoutNode => ({ kind: "split", axis, children });

/** Reserved renderer-only pane id for the highlighted destination during a tab drag. */
export const SPLIT_DROP_PREVIEW_ID = "__pistachio_split_drop_preview__";

/**
 * Translate an ordered split group into a small layout tree. Grid follows
 * a directional spanning three-pane mosaic, then becomes a balanced 2×2 at
 * four panes. Linear modes remain rows/columns at every pane count.
 */
export function splitLayout(
  tabIds: readonly string[],
  mode: SplitOrientation,
  gridLayout: SplitGridLayout = "span-bottom",
): SplitLayoutNode | null {
  if (tabIds.length === 0) return null;
  if (tabIds.length === 1) return pane(tabIds[0]!);
  if (mode === "vertical" || mode === "horizontal") return split(mode, tabIds.map(pane));
  if (tabIds.length === 2) return split("vertical", tabIds.map(pane));
  if (tabIds.length === 3) {
    if (gridLayout === "span-top") {
      return split("horizontal", [pane(tabIds[0]!), split("vertical", [pane(tabIds[1]!), pane(tabIds[2]!)])]);
    }
    if (gridLayout === "span-left") {
      return split("vertical", [pane(tabIds[0]!), split("horizontal", [pane(tabIds[1]!), pane(tabIds[2]!)])]);
    }
    if (gridLayout === "span-right") {
      return split("vertical", [split("horizontal", [pane(tabIds[0]!), pane(tabIds[1]!)]), pane(tabIds[2]!)]);
    }
    return split("horizontal", [split("vertical", [pane(tabIds[0]!), pane(tabIds[1]!)]), pane(tabIds[2]!)]);
  }
  return split("vertical", [
    split("horizontal", [pane(tabIds[0]!), pane(tabIds[1]!)]),
    split("horizontal", [pane(tabIds[2]!), pane(tabIds[3]!)]),
  ]);
}

/**
 * Build the layout that `BrowserController.splitWith` will commit, replacing
 * the dragged tab with a renderer-only landing pane. Existing native pages
 * are laid out against this tree during the drag, so they reflow to their
 * proposed sizes before the pointer is released.
 */
export function splitDropPreviewLayout(
  tabIds: readonly string[],
  currentMode: SplitOrientation,
  currentGridLayout: SplitGridLayout,
  side: SplitSide,
): SplitLayoutNode | null {
  if (tabIds.length === 0 || tabIds.length >= 4) return null;
  const atStart = side === "left" || side === "top";
  const previewTabIds = atStart
    ? [SPLIT_DROP_PREVIEW_ID, ...tabIds]
    : [...tabIds, SPLIT_DROP_PREVIEW_ID];
  const linearMode: SplitOrientation = side === "top" || side === "bottom" ? "horizontal" : "vertical";
  const mode: SplitOrientation = previewTabIds.length === 3 || currentMode === "grid" ? "grid" : linearMode;
  const gridLayout: SplitGridLayout = previewTabIds.length === 3 ? `span-${side}` : currentGridLayout;
  return splitLayout(previewTabIds, mode, gridLayout);
}
