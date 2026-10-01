/**
 * What a desk window holds (docs/desk-documents.md §2). Most are a tab's
 * page — a native view main places over the window, or a page the shell
 * draws itself (home, a note). The others are the shell's own windows,
 * which no tab stands behind: today a document, one of the group's context
 * files open in its viewer. Each kind is named by its id's prefix, so the
 * engine, which knows windows only by id, can tell them apart:
 *
 * - `tab`: the tab's own id (a UUID). Its icon in the dock is its home.
 * - `file`: `file:<context item id>`. Its home is the dock's Stack.
 *
 * A new kind is a new prefix here, a home in the dock (DeskEngine.attachHome),
 * and a window component (components/desk/window-kinds.tsx).
 */

import { FILE_WINDOW_PREFIX, fileItemOf, fileWindowId } from "@pistachio/shell-contracts/desk-agent";

export type DeskWindowKind = "tab" | "file";

export { fileItemOf, fileWindowId };

export function windowKind(id: string): DeskWindowKind {
  return id.startsWith(FILE_WINDOW_PREFIX) ? "file" : "tab";
}

/** A tab's window: one main can show a native page for. */
export function isTabWindow(id: string): boolean {
  return windowKind(id) === "tab";
}

/**
 * How much of the desk a document's window takes when it comes out where
 * it was dropped (DeskEngine.openAt), by its viewer: a page is tall and a
 * sheet is wide.
 */
export function documentShare(viewer: string | null): { w: number; h: number; maxW: number } {
  switch (viewer) {
    case "sheet":
      return { w: 0.62, h: 0.72, maxW: 1_100 };
    case "image":
      return { w: 0.5, h: 0.66, maxW: 1_000 };
    case "pdf":
      return { w: 0.46, h: 0.9, maxW: 820 };
    default:
      return { w: 0.46, h: 0.86, maxW: 760 };
  }
}
