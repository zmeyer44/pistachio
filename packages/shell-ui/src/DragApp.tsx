/**
 * The page inside the drag layer's WebContentsView (main/chrome-view.ts, id
 * "drag"). It is the thing under the pointer for gestures that leave the
 * shell page and relays every sample back so the shell can run the drag it
 * started. During a tab drag it also paints the tab ghost — from the moment
 * the dragged element would leave the chrome holding it, since the column
 * clips at its edge and the tab views paint over everything below them —
 * while the proposed pane itself remains in the shell, visible in the space
 * the live pages vacate.
 *
 * A WebContentsView takes the pointer over its whole box whatever its pixels
 * say, so while this view is up nothing below it — no tab page, none of the
 * shell's own chrome — sees the drag. That is the point: the tab views stay
 * VISIBLE and keep resizing with the panes, instead of being hidden behind a
 * stretched still for the length of the gesture.
 *
 * Main shows and hides the view; `onDragCapture` carries the cursor to hold
 * (and `null` when the gesture is over), which is also the signal to start
 * and stop listening. See the drag capture section of @pistachio/shell-contracts/chrome.
 */

import { useEffect, useState } from "react";
import { clampTo, type DragCursor, type TabDragVisual } from "@pistachio/shell-contracts/chrome";
import { Favicon } from "./components/Favicon";
import { prettyUrl } from "./lib/url";
import { nativeApi } from "./api";

export function DragApp() {
  const [cursor, setCursor] = useState<DragCursor | null>(null);
  const [visual, setVisual] = useState<TabDragVisual | null>(null);

  useEffect(() => nativeApi()?.onDragCapture(setCursor), []);
  useEffect(() => nativeApi()?.onTabDragVisual(setVisual), []);

  useEffect(() => {
    if (cursor === null) return;
    const relay = (phase: "move" | "up" | "cancel") => (event: PointerEvent) => {
      if (phase !== "cancel") {
        setVisual((current) => current === null ? null : { ...current, x: event.clientX, y: event.clientY });
      }
      nativeApi()?.sendDragSample({ x: event.clientX, y: event.clientY, phase });
    };
    const onMove = relay("move");
    const onUp = relay("up");
    const onCancel = relay("cancel");
    // The window losing focus mid-drag (⌘-tab, a crash dialog) never produces
    // a pointerup: end the gesture rather than leave the layer holding the
    // pointer with no way out. No coordinates — the shell keeps its last.
    const onBlur = (): void => nativeApi()?.sendDragSample({ x: 0, y: 0, phase: "cancel" });
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onBlur);
    };
  }, [cursor]);

  // `select-none` so a drag that started on the shell cannot begin selecting
  // here, and the cursor for the whole window — the pointer roams all of it.
  return (
    <div
      data-testid="drag-layer"
      className="relative h-full w-full select-none"
      style={{ cursor: cursor ?? "default" }}
    >
      {cursor !== "grabbing" || visual === null ? null : (
        <div
          aria-hidden="true"
          data-testid="tab-drag-preview"
          data-split-zone={visual.zone ?? undefined}
          className="pointer-events-none fixed flex items-center gap-2 overflow-hidden rounded-md bg-background-100 px-2 text-[12.5px] text-gray-1000 shadow-menu"
          style={{
            left: clampTo(visual.x - visual.grabX, visual.clamp?.minLeft, visual.clamp?.maxLeft),
            top: clampTo(visual.y - visual.grabY, visual.clamp?.minTop, visual.clamp?.maxTop),
            width: visual.width,
            height: visual.height,
            opacity: visual.zone === null ? 1 : 0.92,
            transform: visual.zone === null ? undefined : "scale(0.94)",
            transformOrigin: `${visual.grabX}px ${visual.grabY}px`,
          }}
        >
          <Favicon src={visual.faviconUrl} seed={prettyUrl(visual.url) || visual.title} />
          <span className="min-w-0 flex-1 truncate">{visual.title || prettyUrl(visual.url) || "Untitled"}</span>
        </div>
      )}
    </div>
  );
}
