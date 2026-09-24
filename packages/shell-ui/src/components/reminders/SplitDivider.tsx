/**
 * The divider between the calendar and the detail on the reminders page,
 * in either orientation: a horizontal rule under the week strip that sets
 * its height, or a vertical one on the month rail's edge that sets its
 * width. A flex sibling of the two panes that takes no layout room — it
 * straddles the border rule between them with negative margins, so the
 * line the person sees is the line they grab.
 *
 * The gesture is the console handle's (lib/pane-drag.ts): the drag layer
 * holds the pointer, so a fast drag that leaves the page keeps tracking.
 * Arrow keys move the separator by a step; a double-click resets it.
 */

import { cn } from "../../lib/cn";
import { startPaneDrag } from "../../lib/pane-drag";
import { useAppStore } from "../../store";

const KEY_STEP = 24;
const HANDLE = 7;

export function SplitDivider({
  orientation,
  value,
  min,
  max,
  defaultValue,
  label,
  paneRef,
  onChange,
  className,
}: {
  /** "vertical": a rule beside a rail, setting its width. "horizontal": a rule under a strip, setting its height. */
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  label: string;
  /** The pane being sized; it is anchored on its far edge (left or top). */
  paneRef: React.RefObject<HTMLElement | null>;
  /** Clamps and persists; the divider does neither. */
  onChange(px: number): void;
  className?: string;
}) {
  const setPaneResizing = useAppStore((s) => s.setPaneResizing);
  const resizing = useAppStore((s) => s.paneResizing);
  const vertical = orientation === "vertical";

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const pane = paneRef.current?.getBoundingClientRect();
    const anchor = vertical ? (pane?.left ?? 0) : (pane?.top ?? 0);
    setPaneResizing(true);
    startPaneDrag(
      { x: event.clientX, y: event.clientY },
      {
        cursor: vertical ? "col-resize" : "row-resize",
        onMove: ({ x, y }) => onChange((vertical ? x : y) - anchor),
        onEnd: () => setPaneResizing(false),
      },
    );
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const grow = vertical ? event.key === "ArrowRight" : event.key === "ArrowDown";
    const shrink = vertical ? event.key === "ArrowLeft" : event.key === "ArrowUp";
    if (!grow && !shrink) return;
    event.preventDefault();
    onChange(value + (grow ? KEY_STEP : -KEY_STEP));
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize — double-click to reset"
      data-testid={`calendar-divider-${orientation}`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onChange(defaultValue)}
      onKeyDown={onKeyDown}
      style={
        vertical
          ? { width: HANDLE, marginLeft: -Math.ceil(HANDLE / 2), marginRight: -Math.floor(HANDLE / 2) }
          : { height: HANDLE, marginTop: -Math.ceil(HANDLE / 2), marginBottom: -Math.floor(HANDLE / 2) }
      }
      className={cn(
        "no-drag group relative z-10 shrink-0 outline-none",
        vertical ? "cursor-col-resize self-stretch" : "cursor-row-resize",
        className,
      )}
    >
      <div
        className={cn(
          "rounded-full transition-colors",
          vertical ? "mx-auto h-full w-0.5" : "my-auto h-0.5 w-full",
          resizing ? "bg-green-700" : "bg-transparent group-hover:bg-alpha-600 group-focus-visible:bg-green-700",
        )}
      />
    </div>
  );
}
