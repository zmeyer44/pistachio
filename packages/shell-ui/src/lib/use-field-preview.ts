/**
 * The address field saying where the active row goes. Once the person has
 * steered the list — an arrow key, or the pointer over a row — the field
 * shows that row's text instead of what they typed, in the address modal
 * (components/UrlBar.tsx) and the home page's search alike.
 *
 * What was typed is kept apart from what is shown: the list is ranked from
 * the typed text alone, so a preview can never re-rank the list it came from.
 * The two ways of steering differ in what the keyboard does next:
 *
 * - **Arrow keys commit to the text.** Editing a row reached with ↑/↓ edits
 *   what the field shows ("github.com/…" + "/issues"), and that becomes what
 *   was typed.
 * - **The pointer only looks.** A pointer resting over the list would
 *   otherwise turn every nudge into an edit of some row's address, so the
 *   next key that is not steering puts the typed text back first — caret and
 *   selection where they were, so ⌘L, a nudge, then typing still replaces the
 *   selected address — and leaving the list ends the look.
 */

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
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
  /** A key that steers nothing went to the field: a pointer's look ends before it lands. */
  release(event: KeyboardEvent): void;
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
    release: (event) => {
      if (by !== "pointer" || MODIFIER_KEYS.has(event.key)) return;
      // Synchronously: the key's own edit has to land on the typed text.
      flushSync(() => setBy(null));
    },
    leave: () => {
      if (by !== "pointer") return false;
      setBy(null);
      return true;
    },
  };
}
