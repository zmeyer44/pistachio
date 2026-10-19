/**
 * The size a shared window's page is captured at (docs/live-share.md §3,
 * §6.3), and whether a change of its page box changes it.
 *
 * Chromium's tab capture (the legacy `chromeMediaSource: "tab"` source)
 * hands out frames of exactly the size asked for and letterboxes the page
 * into them, and with nothing asked it captures at the display's size — so a
 * window is always asked for at its page box's own shape, in device pixels,
 * no longer than the protocol's longest side. Probed in Electron 43 (a tab
 * capture of a 984×804 page): the track's `applyConstraints({ width,
 * height })` changes the frame size in place, smaller or larger, as often as
 * asked, up to the page's own size — past which a fresh capture gives no
 * more (asked 1200×900 or 1800×1300, either gives 984×804). So every change
 * of the box resizes the capture the window has, and the room sets the
 * bitrate for the new size on the same publication.
 */

export interface PixelSize {
  width: number;
  height: number;
}

/** Sides within this many pixels are the same size: rounding, not a resize. */
const SAME_PX = 2;

/** H.264's 4:2:0 wants even sides; a side is never under two pixels. */
function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * The capture size for a page box (CSS px) on a display of `pixelRatio`:
 * its device pixels, scaled down to `maxSide` on the longer side, its shape
 * kept. Null for a box with no area (a window not laid out yet).
 */
export function captureSize(page: { w: number; h: number }, pixelRatio: number, maxSide: number): PixelSize | null {
  if (!(page.w > 0) || !(page.h > 0) || !Number.isFinite(page.w) || !Number.isFinite(page.h)) return null;
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const width = page.w * ratio;
  const height = page.h * ratio;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: even(width * scale), height: even(height * scale) };
}

/** Whether a capture at `current` already gives what its page wants (`next`): a rounding apart, not a resize. */
export function sameCaptureSize(current: PixelSize, next: PixelSize): boolean {
  return Math.abs(next.width - current.width) <= SAME_PX && Math.abs(next.height - current.height) <= SAME_PX;
}
