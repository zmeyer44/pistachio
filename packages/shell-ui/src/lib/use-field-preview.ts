/**
 * The address field saying where the active row goes. Once the person has
 * steered the list — an arrow key, or the pointer over a row — the field
 * shows that row's text instead of what they typed, in the address modal
 * (components/UrlBar.tsx) and the home page's search alike.
 *
 * What was typed is kept apart from what is shown: the list is ranked from
 * the typed text alone, so a preview can never re-rank the list it came from.
 *
 * Whichever way the row was reached, the keyboard edits what the field shows:
 * typing, ⌫ or a caret move on a row reached with ↑/↓ or under the pointer
 * works on its text ("github.com/…" + "/issues"), and an edit makes that the
 * typed text. Until a key lands, a pointer's row is only a look — leaving the
 * list puts the typed text back, caret and selection where they were.
 */

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { Entry } from "../components/address-palette";

/**
 * What the field shows for a row: where it goes, or what it does. A go-to, a
 * web search and an AI prompt are all the typed text itself.
 */
export function entryFieldText(entry: Entry, typed: string): string {
  if (entry.kind === "suggestion") return typed;
  if (entry.kind === "action") return entry.title;
  return entry.url === "" ? typed : entry.url;
}

export type SteeredBy = "keys" | "pointer";

const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

export interface FieldPreview {
  /** The input's value: the active row's text once steered to, else `typed`. */
  value: string;
  /** The person moved the selection to `index`. Call beside `setSelected`. */
  steer(by: SteeredBy, index: number): void;
  /** The typed text changed (an edit, a reset): whatever the field shows now IS the text. */
  settle(): void;
  /** A key that steers nothing went to the field: a pointer's look becomes the text it works on. */
  adopt(event: KeyboardEvent): void;
  /** The pointer left the list. True when it was showing a row — the caller puts the selection back. */
  leave(): boolean;
}

export function useFieldPreview({
  inputRef,
  typed,
  entries,
  selected,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  typed: string;
  entries: readonly Entry[];
  selected: number;
}): FieldPreview {
  // null ⇒ the selection is the list's own default, which is not a preview:
  // typing "gi" must not fill the field with whatever ranks first.
  const [by, setBy] = useState<SteeredBy | null>(null);
  /** The typed text's caret or selection, held while a row's text stands in for it. */
  const held = useRef<{ start: number; end: number } | null>(null);

  const entry = by === null ? undefined : entries[selected];
  const value = entry === undefined ? typed : entryFieldText(entry, typed);
  const previewing = value !== typed;

  useLayoutEffect(() => {
    if (previewing || held.current === null) return;
    const { start, end } = held.current;
    held.current = null;
    inputRef.current?.setSelectionRange(start, end);
  }, [previewing, inputRef]);

  return {
    value,
    steer: (source, index) => {
      // `onMouseMove` fires over the row that is already active too; the
      // pointer crossing a row reached by keyboard does not take it over.
      if (source === "pointer" && index === selected && by !== null) return;
      const input = inputRef.current;
      if (!previewing && input !== null) {
        held.current = { start: input.selectionStart ?? typed.length, end: input.selectionEnd ?? typed.length };
      }
      setBy(source);
    },
    settle: () => {
      held.current = null;
      setBy(null);
    },
    adopt: (event) => {
      if (by !== "pointer" || MODIFIER_KEYS.has(event.key)) return;
      // The field already shows the row, so an edit lands on its text by
      // itself (and settles); this is for a key that only moves the caret,
      // after which leaving the list must not take the text away again.
      setBy("keys");
    },
    leave: () => {
      if (by !== "pointer") return false;
      setBy(null);
      return true;
    },
  };
}
