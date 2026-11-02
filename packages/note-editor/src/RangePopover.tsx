/**
 * A floating card anchored to a document range (or a collapsed position),
 * on the note's panel. Outside clicks and Escape dismiss it. It is rendered
 * inside the pane like every other floating piece of a note, not portaled
 * over the window.
 */

import { autoUpdate, flip, offset, shift, useDismiss, useFloating, useInteractions, type Placement, type VirtualElement } from "@floating-ui/react";
import { posToDOMRect, type Editor } from "@tiptap/core";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { cn } from "./cn";
import { NOTE_PANEL_CLASS } from "./parts";

export function rangeReference(editor: Editor, from: number, to: number): VirtualElement {
  const clamp = (pos: number) => Math.max(0, Math.min(pos, editor.state.doc.content.size));
  return {
    getBoundingClientRect: () => (editor.isDestroyed ? new DOMRect() : posToDOMRect(editor.view, clamp(from), clamp(to))),
    contextElement: editor.view.dom,
  };
}

interface RangePopoverProps {
  editor: Editor;
  from: number;
  to: number;
  label: string;
  onDismiss: () => void;
  placement?: Placement;
  className?: string;
  testId?: string;
  children: ReactNode;
}

export function RangePopover({ editor, from, to, label, onDismiss, placement = "bottom-start", className, testId, children }: RangePopoverProps) {
  const [floating, setFloating] = useState<HTMLElement | null>(null);
  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: true,
    onOpenChange: (open) => {
      if (!open) onDismiss();
    },
    elements: { floating },
    placement,
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const { getFloatingProps } = useInteractions([useDismiss(context)]);

  // Focus once positioned: focusing earlier scrolls the page to the card's
  // initial (0, 0) placement.
  useEffect(() => {
    if (isPositioned) floating?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
  }, [isPositioned, floating]);

  // Virtual (range) references go through setPositionReference.
  useLayoutEffect(() => {
    refs.setPositionReference(rangeReference(editor, from, to));
  }, [refs, editor, from, to]);

  return (
    <div
      ref={setFloating}
      style={floatingStyles}
      className={cn(NOTE_PANEL_CLASS, "w-[min(400px,calc(100%-24px))] p-2", className)}
      role="dialog"
      aria-label={label}
      data-testid={testId}
      {...getFloatingProps()}
    >
      {children}
    </div>
  );
}
