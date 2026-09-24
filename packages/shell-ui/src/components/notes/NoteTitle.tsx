/**
 * A note's title (docs/notes.md §5): one line at 40px, growing to two when it
 * needs to. A textarea rather than an input because a long title should wrap
 * rather than scroll sideways, and because the body is right underneath —
 * Enter and ↓ walk into it, so the title never swallows a new paragraph.
 */

import { useLayoutEffect, useRef } from "react";
import { MAX_NOTE_TITLE } from "@pistachio/shell-contracts/notes";
import { cn } from "../../lib/cn";

export function NoteTitle({
  value,
  onChange,
  onEnterBody,
  autoFocus,
}: {
  value: string;
  onChange(value: string): void;
  /** Enter, ↓ at the end, or Tab: the keyboard belongs to the body now. */
  onEnterBody(): void;
  autoFocus: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow to the text. Measured after layout, so the first paint is already
  // the right height and the body below it never jumps.
  useLayoutEffect(() => {
    const field = ref.current;
    if (field === null) return;
    field.style.height = "0px";
    field.style.height = `${String(field.scrollHeight)}px`;
  }, [value]);

  useLayoutEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  return (
    <textarea
      ref={ref}
      rows={1}
      data-testid="note-title"
      aria-label="Note title"
      placeholder="Untitled"
      spellCheck={false}
      maxLength={MAX_NOTE_TITLE}
      value={value}
      onChange={(event) => onChange(event.target.value.replace(/[\r\n]+/gu, " "))}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === "Tab" || (event.key === "ArrowDown" && event.currentTarget.selectionStart === value.length)) {
          event.preventDefault();
          onEnterBody();
        }
      }}
      className={cn(
        "w-full resize-none overflow-hidden bg-transparent text-[40px] leading-[1.15] font-semibold tracking-[-0.03em] text-gray-1000 placeholder:text-gray-600 focus:outline-none",
        "@max-[561px]:text-[32px]",
      )}
      style={{ userSelect: "text" }}
    />
  );
}
