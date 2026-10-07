import { useEffect, useState } from "react";
import { cn } from "../lib/cn";
import { areaBox, finishAreaScreenshot, heldPicture, heldPictureStale, useAreaDrag } from "../lib/screenshot";
import { useAppStore } from "../store";

/**
 * An area of the window dragged out for a screenshot (⌘⇧2, lib/screenshot.ts),
 * as the Mac's own ⌘⇧4 does it: a crosshair; while dragging, the area clear
 * and the rest dimmed, its size beside it. It is drawn over main's picture of
 * the window as it was when the key was pressed — the area is cut from that
 * picture, and the window under this (its pages down, as under any shell
 * overlay) may no longer look like it. It only draws: every key and press is
 * lib/screenshot's while it is up (guardInput), so nothing under it — a
 * dialog, a menu — hears of them. Escape, a press of another button, or a
 * click that never became a drag puts it away.
 */
export function ScreenshotOverlay() {
  const ready = useAppStore((state) => state.overlayReady);
  const drag = useAreaDrag((state) => state.drag);
  const [picture] = useState(heldPicture);

  // The window resized under the held picture: it no longer lines up with the window, so the area is let go.
  useEffect(() => {
    const onResize = () => {
      if (heldPictureStale()) finishAreaScreenshot(null);
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const box = drag === null ? null : areaBox(drag);
  return (
    <div
      role="application"
      aria-label="Drag over the area to screenshot. Escape cancels."
      data-testid="screenshot-overlay"
      data-ready={ready ? "" : undefined}
      className={cn("no-drag fixed inset-0 z-100 cursor-crosshair touch-none select-none", !ready && "opacity-0")}
    >
      {picture === null ? null : (
        <img
          alt=""
          aria-hidden="true"
          data-testid="screenshot-held"
          src={picture}
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full max-w-none select-none"
        />
      )}
      {box === null ? (
        <>
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[oklch(0_0_0/0.12)]" />
          <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-[oklch(0_0_0/0.72)] px-3 py-1.5 text-label-12 whitespace-nowrap text-white shadow-menu">
            Drag over the area to screenshot · Esc to cancel
          </div>
        </>
      ) : (
        <>
          <div
            aria-hidden="true"
            data-testid="screenshot-selection"
            className="pointer-events-none absolute outline outline-1 outline-white"
            style={{
              left: box.x,
              top: box.y,
              width: box.width,
              height: box.height,
              // The rest of the window, dimmed around the area.
              boxShadow: "0 0 0 1px oklch(0 0 0 / 0.35), 0 0 0 100vmax oklch(0 0 0 / 0.32)",
            }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute rounded-xs bg-[oklch(0_0_0/0.72)] px-1.5 py-0.5 font-mono text-[11px] leading-4 text-white tabular-nums"
            style={{
              left: Math.min(box.x + box.width + 6, window.innerWidth - 84),
              top: Math.min(box.y + box.height + 6, window.innerHeight - 24),
            }}
          >
            {Math.round(box.width)} × {Math.round(box.height)}
          </div>
        </>
      )}
    </div>
  );
}
