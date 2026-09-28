/**
 * The desk: an experimental view of ONE tab group in which every tab is a
 * free window — dragged, thrown, resized and stacked inside the page area —
 * instead of a pane that fills it. The layout, the motion and the variants
 * all live in the shell (@pistachio/shell-ui components/desk); what main
 * needs to know is only what it must do on the NATIVE side:
 *
 * - which tab views are desk windows, so a modifier + press on one of their
 *   PAGES is taken from the page and handed to the shell as the start of a
 *   window move (a page is its own WebContentsView; the shell never sees a
 *   pointer that lands on it),
 * - that the panes it is given are STACKED (BrowserLayout.stacked): the
 *   views are listed bottom to top, and overlapping live pages must paint
 *   in that order,
 * - stills of those pages, for the moments a window is drawn by the shell
 *   (in flight, behind another window, in the inventory).
 *
 * Pure on purpose — no Electron, no DOM — so vitest pins it under node.
 */

/** The key that turns a press on a desk page into a window move. */
export type DeskGrabModifier = "shift" | "alt" | "meta";

export const DESK_GRAB_MODIFIERS: readonly DeskGrabModifier[] = ["shift", "alt", "meta"];

export function isDeskGrabModifier(value: unknown): value is DeskGrabModifier {
  return value === "shift" || value === "alt" || value === "meta";
}

/** Shell → main: the desk that is up, or null when none is. */
export interface DeskState {
  /** The tabs shown as desk windows right now. */
  tabIds: string[];
  /** The modifier that grabs a window from inside its page, or null for none. */
  grab: DeskGrabModifier | null;
}

export const MAX_DESK_WINDOWS = 24;

export function isDeskState(value: unknown): value is DeskState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  const tabIds = state["tabIds"];
  return (
    Array.isArray(tabIds) &&
    tabIds.length <= MAX_DESK_WINDOWS &&
    tabIds.every((tabId) => typeof tabId === "string" && tabId.length > 0 && tabId.length <= 128) &&
    (state["grab"] === null || isDeskGrabModifier(state["grab"]))
  );
}

/**
 * Main → shell: the modifier was held as a desk page was pressed. The page
 * never saw the press; the shell now runs the move, and every later pointer
 * sample of the same press arrives on the drag-sample channel
 * (@pistachio/shell-contracts/chrome, "drag capture") until an "up".
 * Coordinates are the window's content box, as every drag sample's are.
 */
export interface DeskGrab {
  tabId: string;
  x: number;
  y: number;
}

export function isDeskGrab(value: unknown): value is DeskGrab {
  if (typeof value !== "object" || value === null) return false;
  const grab = value as Record<string, unknown>;
  return (
    typeof grab["tabId"] === "string" &&
    typeof grab["x"] === "number" &&
    Number.isFinite(grab["x"]) &&
    typeof grab["y"] === "number" &&
    Number.isFinite(grab["y"])
  );
}

/** Whether an input event's modifier list holds the desk's grab key. */
export function holdsDeskModifier(modifiers: readonly string[] | undefined, grab: DeskGrabModifier | null): boolean {
  if (grab === null || modifiers === undefined) return false;
  const names = grab === "meta" ? ["meta", "command", "cmd"] : [grab];
  return modifiers.some((modifier) => names.includes(modifier.toLowerCase()));
}

/** A still request: at most this many device px wide, whatever the page's box. */
export const MAX_DESK_STILL_WIDTH = 2_400;
