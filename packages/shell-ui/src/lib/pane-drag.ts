/**
 * Runs a pane-resize drag from the shell page.
 *
 * The gesture starts on a handle in the shell but the pointer immediately
 * leaves it: the tab WebContentsViews sit above the shell and swallow every
 * move that lands on them. So on pointerdown the shell hands the pointer to
 * the drag layer — a transparent view over the whole window — which relays
 * each sample back (@pistachio/shell-contracts/chrome, "drag capture").
 *
 * Both sources are read: the layer's relayed stream and the shell's own
 * pointer events. They overlap harmlessly, because every sample is an
 * ABSOLUTE window position rather than a delta, and the shell's own listeners
 * are what carries the first frames of the gesture — the ones before the
 * layer is up — and the whole gesture in the E2E build, where the synthetic
 * pointer belongs to the shell page and never reaches the layer.
 *
 * Positions are coalesced onto one animation frame: a pointer emits moves
 * faster than the panes can be laid out, and every layout costs main a
 * setBounds on each tab view.
 */

import type { DragCursor } from "@pistachio/shell-contracts/chrome";
import { nativeApi } from "../api";

export interface PaneDrag {
  cursor: DragCursor;
  /** The latest pointer position, in the window's content box. */
  onMove(point: { x: number; y: number }): void;
  /** The pointer was released or lost. Always runs exactly once. */
  onEnd?(): void;
}

/** Begin a drag. Returns a function that ends it early (an unmounting handle). */
export function startPaneDrag(start: { x: number; y: number }, drag: PaneDrag): () => void {
  let point = start;
  let frame = 0;
  let done = false;

  const apply = (): void => {
    frame = 0;
    drag.onMove(point);
  };
  const schedule = (next: { x: number; y: number }): void => {
    point = next;
    if (frame === 0) frame = requestAnimationFrame(apply);
  };

  const end = (): void => {
    if (done) return;
    done = true;
    window.removeEventListener("pointermove", onLocalMove);
    window.removeEventListener("pointerup", onLocalUp);
    window.removeEventListener("pointercancel", onLocalUp);
    offSample?.();
    if (frame !== 0) cancelAnimationFrame(frame);
    nativeApi()?.setDragCapture(null);
    drag.onEnd?.();
  };

  const onLocalMove = (event: PointerEvent): void => schedule({ x: event.clientX, y: event.clientY });
  const onLocalUp = (event: PointerEvent): void => {
    schedule({ x: event.clientX, y: event.clientY });
    end();
  };

  const offSample = nativeApi()?.onDragSample((sample) => {
    // A cancel carries no position — the window lost focus, and the last
    // known point is the one the person meant.
    if (sample.phase !== "cancel") schedule({ x: sample.x, y: sample.y });
    if (sample.phase !== "move") end();
  });
  window.addEventListener("pointermove", onLocalMove);
  window.addEventListener("pointerup", onLocalUp);
  window.addEventListener("pointercancel", onLocalUp);
  nativeApi()?.setDragCapture(drag.cursor);

  return end;
}
