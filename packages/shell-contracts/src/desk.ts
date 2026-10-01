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
 * - which pages are MASKED (DeskMask): cut down to a region the person
 *   chose, which main shows alone and scaled like a picture while the page
 *   goes on laying out at its old size.
 * - which pages are ZOOMED (DeskZoomedPage): a MINIMIZED window's, shown as
 *   if the page were zoomed out, so a small window still shows the page as
 *   it lays out on a desk-sized one — and a window growing back from
 *   minimized, held at its new size until it lands there.
 *
 * Pure on purpose — no Electron, no DOM — so vitest pins it under node.
 */

/** The key that turns a press on a desk page into a window move. */
export type DeskGrabModifier = "shift" | "alt" | "meta";

export const DESK_GRAB_MODIFIERS: readonly DeskGrabModifier[] = ["shift", "alt", "meta"];

export function isDeskGrabModifier(value: unknown): value is DeskGrabModifier {
  return value === "shift" || value === "alt" || value === "meta";
}

/** A box in the window's content coordinates. */
export interface DeskBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A desk window's mask: the region of its page the person chose to keep,
 * in the page's own box as it stood when masked (the window's content px),
 * and that box's size. Main keeps the page laying out at that size — no
 * responsive reflow — and shows only the region, scaled to the window
 * (Chromium's viewport override, re-aimed as the page scrolls so the region
 * stays the same part of the page's box). The override does not map input,
 * so main does: a mouse event on a masked view is re-sent at the page's own
 * point under the pointer, and the page is used as it always is.
 */
export interface DeskMask {
  x: number;
  y: number;
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
}

/** The smallest region worth keeping, each way. */
export const MIN_DESK_MASK = 16;
/** A page box larger than this is not one a window has. */
const MAX_DESK_PAGE = 16_384;

export function isDeskMask(value: unknown): value is DeskMask {
  if (typeof value !== "object" || value === null) return false;
  const mask = value as Record<string, unknown>;
  if (!(["x", "y", "width", "height", "pageWidth", "pageHeight"] as const).every((key) => typeof mask[key] === "number" && Number.isFinite(mask[key])))
    return false;
  const { x, y, width, height, pageWidth, pageHeight } = mask as unknown as DeskMask;
  return (
    pageWidth >= MIN_DESK_MASK &&
    pageHeight >= MIN_DESK_MASK &&
    pageWidth <= MAX_DESK_PAGE &&
    pageHeight <= MAX_DESK_PAGE &&
    width >= MIN_DESK_MASK &&
    height >= MIN_DESK_MASK &&
    x >= 0 &&
    y >= 0 &&
    x + width <= pageWidth + 0.5 &&
    y + height <= pageHeight + 0.5
  );
}

/** Names a mask, so a still can say which one it shows (PaneStill.mask). */
export function deskMaskKey(mask: DeskMask): string {
  return [mask.x, mask.y, mask.width, mask.height, mask.pageWidth, mask.pageHeight].map((value) => Math.round(value)).join(",");
}

/** A masked desk page, and the size its window shows the region at (the view's box, when it is live). */
export interface DeskMaskedPage {
  tabId: string;
  mask: DeskMask;
  width: number;
  height: number;
}

function isDeskMaskedPage(value: unknown): value is DeskMaskedPage {
  if (typeof value !== "object" || value === null) return false;
  const page = value as Record<string, unknown>;
  return (
    typeof page["tabId"] === "string" &&
    page["tabId"].length > 0 &&
    page["tabId"].length <= 128 &&
    isDeskMask(page["mask"]) &&
    (["width", "height"] as const).every((key) => typeof page[key] === "number" && Number.isFinite(page[key]) && page[key] >= 1 && page[key] <= MAX_DESK_PAGE)
  );
}

/**
 * A MINIMIZED desk window shows its page as if the page were zoomed to
 * this: laid out at its page box over this, and drawn scaled down into
 * it. A small window would otherwise show a responsive page's narrowest
 * layout (its navbar, and little else).
 */
export const DESK_MINI_ZOOM = 0.5;

/**
 * A desk page shown at a zoom: its window's page box (`width` × `height`,
 * the view's size at rest — all of it, though the view may be cut short
 * where a minimized window peeks from the desk's foot), and the zoom it is
 * shown at. Main lays the page out at the box over the zoom and draws it
 * scaled into the view (Chromium's device emulation, which maps input
 * itself), whatever the view's own size: a view cut short shows the top of
 * the page, and the page never learns of it. A zoom of 1 holds a page
 * growing back from minimized at the size it is growing to, so it lays
 * out once, there, not at every size between; its emulation comes off
 * once the page is no longer listed.
 */
export interface DeskZoomedPage {
  tabId: string;
  width: number;
  height: number;
  zoom: number;
}

function isDeskZoomedPage(value: unknown): value is DeskZoomedPage {
  if (typeof value !== "object" || value === null) return false;
  const page = value as Record<string, unknown>;
  return (
    typeof page["tabId"] === "string" &&
    page["tabId"].length > 0 &&
    page["tabId"].length <= 128 &&
    (["width", "height"] as const).every((key) => typeof page[key] === "number" && Number.isFinite(page[key]) && page[key] >= 1 && page[key] <= MAX_DESK_PAGE) &&
    typeof page["zoom"] === "number" &&
    Number.isFinite(page["zoom"]) &&
    page["zoom"] >= 0.25 &&
    page["zoom"] <= 1
  );
}

/**
 * Main → shell: the pointer came onto a zoomed desk page (`over`), or went
 * off it. A minimized window peeking from the desk's foot rises into view
 * while the pointer is on it, and over its live page the shell hears no
 * pointer of its own.
 */
export interface DeskHover {
  tabId: string;
  over: boolean;
}

export function isDeskHover(value: unknown): value is DeskHover {
  if (typeof value !== "object" || value === null) return false;
  const hover = value as Record<string, unknown>;
  return typeof hover["tabId"] === "string" && hover["tabId"].length > 0 && typeof hover["over"] === "boolean";
}

/** Shell → main: the desk that is up, or null when none is. */
export interface DeskState {
  /** The tabs shown as desk windows right now. */
  tabIds: string[];
  /** The modifier that grabs a window from inside its page, or null for none. */
  grab: DeskGrabModifier | null;
  /**
   * Where the dock stands, while it has stepped aside for the window in use
   * (a window may lie behind the dock, and a live page would paint over
   * it); null or absent while it stands. The window in use is live there,
   * so a pointer coming to the dock's place is over its page, which the
   * shell never hears: main tells it (DeskPageInput "dock").
   */
  dock?: DeskBox | null;
  /**
   * A tab's icon in the dock is under the pointer: ⇧⌫ closes that tab,
   * wherever the keyboard is (isDockCloseKey). Main takes the key from the
   * view it was struck in and tells the shell (DeskPageInput "close"),
   * which knows the tab. Absent or false while no tab's icon is.
   */
  dockHover?: boolean;
  /** The desk's masked pages (DeskMask); absent or empty when none is. */
  masks?: DeskMaskedPage[];
  /** The desk's zoomed pages (DeskZoomedPage): its minimized windows', and any growing back from minimized; absent or empty when none is. */
  zoomed?: DeskZoomedPage[];
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
    (state["grab"] === null || isDeskGrabModifier(state["grab"])) &&
    (state["dock"] === undefined || state["dock"] === null || isDeskBox(state["dock"])) &&
    (state["dockHover"] === undefined || typeof state["dockHover"] === "boolean") &&
    (state["masks"] === undefined ||
      (Array.isArray(state["masks"]) && state["masks"].length <= MAX_DESK_WINDOWS && state["masks"].every(isDeskMaskedPage))) &&
    (state["zoomed"] === undefined ||
      (Array.isArray(state["zoomed"]) && state["zoomed"].length <= MAX_DESK_WINDOWS && state["zoomed"].every(isDeskZoomedPage)))
  );
}

function isDeskBox(value: unknown): value is DeskBox {
  if (typeof value !== "object" || value === null) return false;
  const box = value as Record<string, unknown>;
  return (["x", "y", "width", "height"] as const).every((key) => typeof box[key] === "number" && Number.isFinite(box[key])) && (box["width"] as number) >= 0 && (box["height"] as number) >= 0;
}

/** A point in the window's content coordinates is in the box. */
export function inDeskBox(box: DeskBox, x: number, y: number): boolean {
  return x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
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

/**
 * Main → shell: a desk page took a press, or Escape was struck in any of
 * the window's views, while a desk is up. A page is a native view and the
 * shell never hears its input, so what the shell draws over the desk (the
 * Feel menu) is told here to close, as it closes on a press anywhere else.
 * "dock": the pointer, over a desk page, came to where the dock stands
 * aside (DeskState.dock) — told once as it comes, and it brings the dock back.
 * "close": ⇧⌫ was struck in any of the window's views with a tab's icon in
 * the dock under the pointer (DeskState.dockHover): the shell closes that tab.
 * "fileDrag": files from outside the app were dragged over a desk page
 * (docs/desk-documents.md §1): the shell puts up the desk's drop targets,
 * and the page gives way to its still, so the drag comes to the shell.
 */
export type DeskPageInput = "press" | "escape" | "dock" | "close" | "fileDrag";

export function isDeskPageInput(value: unknown): value is DeskPageInput {
  return value === "press" || value === "escape" || value === "dock" || value === "close" || value === "fileDrag";
}

/** A key event, as Electron's `before-input-event` has it. */
export interface DeskKeyInput {
  type: string;
  key: string;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
}

/** ⇧⌫ going down, no other modifier with it: with a tab's icon in the dock under the pointer, it closes that tab (DeskState.dockHover). */
export function isDockCloseKey(input: DeskKeyInput): boolean {
  return input.type === "keyDown" && input.key === "Backspace" && input.shift && !input.control && !input.alt && !input.meta;
}

/** Whether an input event's modifier list holds the desk's grab key. */
export function holdsDeskModifier(modifiers: readonly string[] | undefined, grab: DeskGrabModifier | null): boolean {
  if (grab === null || modifiers === undefined) return false;
  const names = grab === "meta" ? ["meta", "command", "cmd"] : [grab];
  return modifiers.some((modifier) => names.includes(modifier.toLowerCase()));
}

/** A still request: at most this many device px wide, whatever the page's box. */
export const MAX_DESK_STILL_WIDTH = 2_400;
