/**
 * The recipes the library and the editor share (docs/notes.md §5), and the
 * two small floating pieces both need: a `…` menu on a row, and the panel
 * every floating menu in a note wears.
 *
 * The pills and quiet words are the brief's (components/reports/BriefPage.tsx)
 * — a note's chrome is the same chrome, one measure narrower.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { autoUpdate, flip, offset, shift, useFloating, type ReferenceType } from "@floating-ui/react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "../../lib/cn";

export const FOCUS = "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";
/** A quiet word in the bar: it darkens under the pointer and has no box. */
export const LINK = cn(
  "flex cursor-pointer items-center gap-1 rounded-full text-[14px] leading-[21px] font-medium text-gray-800 transition-colors hover:text-gray-1000 disabled:cursor-default disabled:opacity-60",
  FOCUS,
);
/** The 30px pill the brief's bar uses for its one button. */
export const PILL = cn(
  "flex h-[30px] cursor-pointer items-center gap-1.5 rounded-full bg-alpha-100 px-2.5 text-[14px] leading-[21px] font-medium text-gray-900 transition-colors hover:bg-alpha-200 hover:text-gray-1000 disabled:cursor-default disabled:opacity-60",
  FOCUS,
);
/** A note's measure: 760px, and never touching the pane's edge. */
export const NOTE_COLUMN = "mx-auto w-full max-w-[760px] px-6 @max-[481px]:px-4";
/** The bar above a note and above the library. */
export const NOTE_BAR_HEIGHT = 52;
/** Every floating panel in a note: the slash menu, the bubble menu, a row's `…`. */
export const NOTE_PANEL_CLASS = "z-50 flex flex-col rounded-xl bg-background-100 p-1 text-gray-1000 shadow-menu";

export interface RowMenuItem {
  id: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  /** A destructive row: it reads as one before it is chosen. */
  tone?: "default" | "danger";
  /** Stay open after running — the two-step delete asks again in place. */
  keepOpen?: boolean;
  /** A muted second line (the disabled Share says when it arrives). */
  note?: string;
  run(): void;
}

/**
 * The `…` on a row or in the bar. It is its own popover rather than
 * `components/ui/menu.tsx`, which always opens upward: these hang off a list
 * that scrolls, so the panel has to flip for itself (@floating-ui/react).
 */
export function RowMenu({
  label,
  items,
  testId,
  onClose,
  className,
}: {
  label: string;
  items: readonly RowMenuItem[];
  testId?: string;
  onClose?(): void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: "bottom-end",
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const close = () => {
    setOpen(false);
    onClose?.();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (refs.domReference.current?.contains(target) === true || refs.floating.current?.contains(target) === true) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
    // `close` is stable enough for this: it only calls two setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, refs.domReference, refs.floating]);

  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        onClick={() => (open ? close() : setOpen(true))}
        className={cn(
          "grid size-7 shrink-0 cursor-pointer place-items-center rounded-lg text-gray-700 transition-colors hover:bg-alpha-200 hover:text-gray-1000",
          open ? "bg-alpha-200 text-gray-1000 opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          FOCUS,
          className,
        )}
      >
        <MoreHorizontal className="size-4" strokeWidth={2} aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={refs.setFloating}
          role="menu"
          aria-label={label}
          data-testid={testId === undefined ? undefined : `${testId}-panel`}
          style={floatingStyles}
          className={cn(NOTE_PANEL_CLASS, "w-[200px]")}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              aria-disabled={item.disabled === true ? true : undefined}
              data-testid={`note-menu-${item.id}`}
              onClick={() => {
                if (item.disabled === true) return;
                item.run();
                if (item.keepOpen !== true) close();
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none [&_svg]:size-3.5 [&_svg]:shrink-0",
                item.disabled === true
                  ? "cursor-default text-gray-600"
                  : item.tone === "danger"
                    ? "cursor-pointer text-red-900 hover:bg-alpha-200 focus:bg-alpha-200"
                    : "cursor-pointer hover:bg-alpha-200 focus:bg-alpha-200",
              )}
            >
              <span aria-hidden="true" className={cn("grid size-3.5 shrink-0 place-items-center", item.disabled === true ? "text-gray-600" : item.tone === "danger" ? "text-red-900" : "text-gray-900")}>
                {item.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px]">{item.label}</span>
                {item.note === undefined ? null : <span className="block truncate text-[10.5px] text-gray-700">{item.note}</span>}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * A rectangle in the page as something @floating-ui can hang a panel off:
 * how both the slash menu (the caret) and the bubble menu (the selection)
 * are positioned, since neither has an element of its own.
 */
export function rectReference(rect: DOMRect | null): ReferenceType | null {
  if (rect === null) return null;
  return { getBoundingClientRect: () => rect };
}

/** A transient line in the bar — a refusal, or "Edited on another device". */
export function useTransient(ms: number): [string | null, (message: string) => void] {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return [
    message,
    (next: string) => {
      setMessage(next);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setMessage(null), ms);
    },
  ];
}
