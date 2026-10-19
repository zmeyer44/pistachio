/**
 * A small panel that opens from a control (a device menu, the backgrounds,
 * the reactions), above it by default since the controls sit at the foot.
 * It lives inside the control's wrapper (`.lv-popover-anchor`), so it moves
 * with it and needs no portal; a press outside or Escape closes it.
 */

import { useEffect, useRef, type ReactNode, type RefObject } from "react";

export interface PopoverProps {
  open: boolean;
  onClose(): void;
  /** The control it opens from: a press on it is not "outside" (it toggles instead). */
  anchor: RefObject<HTMLElement | null>;
  label: string;
  placement?: "top" | "bottom";
  align?: "start" | "center" | "end";
  className?: string;
  children: ReactNode;
}

export function Popover({ open, onClose, anchor, label, placement = "top", align = "center", className, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null || ref.current?.contains(target) === true || anchor.current?.contains(target) === true) return;
      onCloseRef.current();
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // Escape closes the menu and nothing else (not the tool, not a window's focus).
      event.stopPropagation();
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open, anchor]);

  if (!open) return null;
  return (
    <div ref={ref} role="dialog" aria-label={label} className={["lv-popover", className].filter(Boolean).join(" ")} data-placement={placement} data-align={align}>
      {children}
    </div>
  );
}
