/**
 * The link editor (⌘K, or the bubble menu's link button): one field over
 * the selection, Enter to apply, and for a link that already exists, Open
 * and Remove.
 */

import type { Editor } from "@tiptap/core";
import { ArrowUpRight, CornerDownLeft, Link2, Unlink } from "lucide-react";
import { useState } from "react";
import { cn } from "./cn";
import { FOCUS } from "./parts";
import { RangePopover } from "./RangePopover";

/** Adds https:// to bare domains; leaves mailto:, tel:, anchors and paths alone. */
export function normalizeHref(input: string): string {
  const value = input.trim();
  if (value === "" || /^([a-z][a-z\d+.-]*:|#|\/)/iu.test(value)) return value;
  return `https://${value}`;
}

interface LinkPopoverProps {
  editor: Editor;
  from: number;
  to: number;
  initialHref: string;
  onApply: (href: string | null) => void;
  onOpen: (href: string, box: DOMRect) => void;
  onCancel: () => void;
}

const ACTION = cn("inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-[13px] text-gray-800 transition-colors hover:bg-alpha-200 hover:text-gray-1000 [&_svg]:size-3.5", FOCUS);

export function LinkPopover({ editor, from, to, initialHref, onApply, onOpen, onCancel }: LinkPopoverProps) {
  const [href, setHref] = useState(initialHref);
  return (
    <RangePopover editor={editor} from={from} to={to} label="Edit link" onDismiss={onCancel} testId="note-link-popover">
      <form
        className="flex items-center gap-2 rounded-lg px-2.5 py-0.5 shadow-border focus-within:shadow-[0_0_0_1px_var(--color-gray-800)]"
        onSubmit={(event) => {
          event.preventDefault();
          const next = normalizeHref(href);
          onApply(next === "" ? null : next);
        }}
      >
        <Link2 className="size-4 shrink-0 text-gray-800" aria-hidden="true" />
        <input
          className="min-w-0 flex-1 bg-transparent py-1.5 text-[14px] text-gray-1000 outline-none placeholder:text-gray-600"
          data-autofocus
          data-testid="note-link-input"
          value={href}
          onChange={(event) => setHref(event.target.value)}
          placeholder="Paste or type a link…"
          aria-label="Link URL"
        />
        <button
          type="submit"
          className={cn("grid size-7 shrink-0 cursor-pointer place-items-center rounded-md bg-gray-1000 text-background-100 disabled:cursor-default disabled:opacity-25 [&_svg]:size-3.5", FOCUS)}
          disabled={href.trim() === ""}
          aria-label="Apply link"
        >
          <CornerDownLeft aria-hidden="true" />
        </button>
      </form>
      {initialHref === "" ? null : (
        <div className="flex gap-1 pt-1.5">
          <button type="button" className={ACTION} onClick={(event) => onOpen(initialHref, event.currentTarget.getBoundingClientRect())}>
            <ArrowUpRight aria-hidden="true" /> Open
          </button>
          <button type="button" className={ACTION} data-testid="note-link-remove" onClick={() => onApply(null)}>
            <Unlink aria-hidden="true" /> Remove link
          </button>
        </div>
      )}
    </RangePopover>
  );
}
