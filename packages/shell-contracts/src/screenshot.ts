/**
 * Screenshots of the window (the `screenshotView` and `screenshotArea`
 * shortcuts). The shell knows which box of the window is wanted — the panes,
 * the desk, an area dragged out — and main knows what is on screen there: the
 * shell page with every native view over it, which only main can capture. So
 * the shell names the box, and main composites the window's layers into it,
 * copies the picture to the clipboard and saves it as a PNG.
 *
 * `ground` is the window's own material under the shell page, as one opaque
 * colour (`#rrggbb`): with the desktop glass on, the shell page is partly
 * transparent there, and the glass itself cannot be captured.
 */

/** A box of the window, in its content's coordinates (CSS px of the shell page). */
export interface ScreenshotBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ScreenshotRequest =
  /**
   * Capture the pages as they are now: `box` is where the shell lays them
   * out. A page in HTML fullscreen fills the window over that layout, which
   * only main knows: then the window's whole box is the page's.
   */
  | { type: "page"; box: ScreenshotBox; ground: string }
  /**
   * Capture the whole window as it is now and hold it: an area of it is
   * chosen next, drawn over this picture of it (what is chosen over is what
   * is kept, whatever the window does meanwhile).
   */
  | { type: "hold"; ground: string }
  /** Keep this box of the held capture, or (null) drop it. */
  | { type: "finish"; box: ScreenshotBox | null }
  /** Show a screenshot saved this session in Finder. */
  | { type: "reveal"; path: string };

export interface ScreenshotResult {
  /** Where the PNG was saved, or null when it could not be written. */
  path: string | null;
  /** The saved file's name, or null. */
  name: string | null;
  /** The picture is on the clipboard. */
  copied: boolean;
}

/** The held window, for the shell to draw under the area being chosen. */
export interface ScreenshotHold {
  /** The whole window as captured, a data URL at the display's pixels. */
  picture: string;
}

/** What each request answers. */
export interface ScreenshotReplies {
  page: ScreenshotResult | null;
  hold: ScreenshotHold | null;
  finish: ScreenshotResult | null;
  reveal: null;
}

/** Nothing smaller is a screenshot: a click that never became a drag. */
export const MIN_SCREENSHOT_SIZE = 4;

export function isScreenshotBox(value: unknown): value is ScreenshotBox {
  if (typeof value !== "object" || value === null) return false;
  const box = value as Record<string, unknown>;
  return (
    (["x", "y", "width", "height"] as const).every((key) => typeof box[key] === "number" && Number.isFinite(box[key])) &&
    (box["width"] as number) > 0 &&
    (box["height"] as number) > 0
  );
}

export function isGroundColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function isScreenshotRequest(value: unknown): value is ScreenshotRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  switch (request["type"]) {
    case "page":
      return isScreenshotBox(request["box"]) && isGroundColor(request["ground"]);
    case "hold":
      return isGroundColor(request["ground"]);
    case "finish":
      return request["box"] === null || isScreenshotBox(request["box"]);
    case "reveal":
      return typeof request["path"] === "string";
    default:
      return false;
  }
}
