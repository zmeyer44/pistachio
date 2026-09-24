/**
 * The drag handle on a side panel's edge — the agent console's left edge,
 * the pinned sidebar's right edge. `side` names the edge of the panel the
 * handle sits on; the panel is anchored on its OTHER side, so its width is
 * whatever lies between the pointer and that far edge.
 *
 * The load-bearing part is `startPaneDrag`: a drag leaving the panel crosses
 * over the tab WebContentsViews, which sit ABOVE the chrome and would swallow
 * every pointermove, so the drag layer takes the pointer for the gesture and
 * relays it back (lib/pane-drag.ts). The tab views stay VISIBLE throughout:
 * width streams out per frame, BrowserSurface re-measures the narrowed hole
 * and main tracks the views to it, so the page resizes under the handle
 * rather than after it. `paneResizing` is now only what tints the handle.
 */

import { cn } from "../lib/cn";
import { startPaneDrag } from "../lib/pane-drag";
import { useAppStore } from "../store";

/** Keyboard resize step (←/→ on the focused handle), in px. */
const KEY_STEP = 24;
/** Hit area straddling the panel's edge. */
const HANDLE_W = 7;

export function ResizeHandle({
  side,
  width,
  min,
  max,
  defaultWidth,
  label,
  setWidth,
}: {
  /** The edge of the panel this handle sits on. */
  side: "left" | "right";
  width: number;
  min: number;
  max: number;
  /** Where a double-click puts the width. */
  defaultWidth: number;
  label: string;
  /** The store's setter — it clamps and persists, so the handle does neither. */
  setWidth(px: number): void;
}) {
  const setPaneResizing = useAppStore((s) => s.setPaneResizing);
  const resizing = useAppStore((s) => s.paneResizing);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const panel = e.currentTarget.parentElement?.getBoundingClientRect();
    // The panel is anchored on its far side: the console to the window's
    // right edge, the sidebar to its left. Its width is whatever lies between
    // the pointer and that edge.
    const anchor = side === "left" ? (panel?.right ?? window.innerWidth) : (panel?.left ?? 0);
    setPaneResizing(true);
    startPaneDrag(
      { x: e.clientX, y: e.clientY },
      {
        cursor: "col-resize",
        onMove: ({ x }) => setWidth(side === "left" ? anchor - x : x - anchor),
        onEnd: () => setPaneResizing(false),
      },
    );
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    // The arrow moves the SEPARATOR: pushing it away from the panel's
    // anchored side widens the panel behind it.
    const widens = side === "left" ? e.key === "ArrowLeft" : e.key === "ArrowRight";
    setWidth(width + (widens ? KEY_STEP : -KEY_STEP));
  };

  // The console's handle straddles its border rule. The sidebar's stays
  // inside its column: the page gutter beside it is a window drag region
  // declared LATER in the document, and Electron folds regions in document
  // order — the part of a no-drag handle that overlapped the gutter would be
  // added back as draggable and grab the window instead of the edge.
  const offset = side === "left" ? -Math.round(HANDLE_W / 2) : 0;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize — double-click to reset"
      style={{ width: HANDLE_W, [side]: offset }}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setWidth(defaultWidth)}
      onKeyDown={onKeyDown}
      className="no-drag group absolute inset-y-0 z-10 cursor-col-resize outline-none"
    >
      <div
        className={cn(
          "mx-auto h-full w-0.5 rounded-full transition-colors",
          resizing ? "bg-green-700" : "bg-transparent group-hover:bg-alpha-600 group-focus-visible:bg-green-700",
        )}
      />
    </div>
  );
}
