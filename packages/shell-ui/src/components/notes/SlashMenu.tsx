/**
 * `/` in a note (docs/notes.md §5): the block catalog, filtered as the person
 * keeps typing, on the address palette's own row metrics so a list of things
 * to pick reads the same everywhere in the app.
 *
 * The extension below is the ProseMirror half — `@tiptap/suggestion` watching
 * for a `/` at the start of a line or after a space — and it reports what it
 * sees to React through a ref rather than rendering anything itself. That
 * keeps the menu an ordinary component inside the pane, positioned off the
 * caret with @floating-ui, instead of a second React root over the window.
 */

import { useEffect, useMemo, useState } from "react";
import { autoUpdate, flip, offset, shift, useFloating } from "@floating-ui/react";
import { Extension, type Editor, type Range } from "@tiptap/core";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import { Code, Heading1, Heading2, Heading3, Image, List, ListOrdered, ListTodo, Minus, Table, TextQuote, Type } from "lucide-react";
import { filterSlashCommands, slashOpensMenu, type SlashCommand, type SlashIcon } from "../../lib/notes-slash";
import { cn } from "../../lib/cn";
import { PALETTE_GLYPH_CLASS, PALETTE_ROW_CLASS, PALETTE_TITLE_CLASS } from "../address-palette";
import { NOTE_PANEL_CLASS, rectReference } from "./parts";

const ICONS: Record<SlashIcon, React.ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean }>> = {
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  TextQuote,
  Code,
  Minus,
  Table,
  Image,
};

/** What the extension tells React, and what React answers keys with. */
export interface SlashState {
  query: string;
  range: Range;
  rect: DOMRect | null;
}

export interface SlashBridge {
  /** Set by the menu; the extension's key handler calls it. */
  onKey(event: KeyboardEvent): boolean;
  set(state: SlashState | null): void;
}

/**
 * The suggestion plugin. `char` is `/`, and `allow` is what keeps a slash
 * inside a word — a path, a date, a fraction — from opening a menu.
 */
export function slashExtension(bridge: { current: SlashBridge }): Extension {
  return Extension.create({
    name: "noteSlashMenu",
    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          char: "/",
          startOfLine: false,
          allowSpaces: false,
          allow: ({ state, range }) => {
            const before = state.doc.textBetween(Math.max(0, range.from - 1), range.from, "\n", "\n");
            return slashOpensMenu(before);
          },
          command: () => undefined,
          render: () => ({
            onStart: (props: SuggestionProps) => {
              bridge.current.set({ query: props.query, range: props.range, rect: props.clientRect?.() ?? null });
            },
            onUpdate: (props: SuggestionProps) => {
              bridge.current.set({ query: props.query, range: props.range, rect: props.clientRect?.() ?? null });
            },
            onKeyDown: ({ event }: { event: KeyboardEvent }) => bridge.current.onKey(event),
            onExit: () => {
              bridge.current.set(null);
            },
          }),
        }),
      ];
    },
  });
}

export function SlashMenu({
  editor,
  state,
  onRun,
  onDismiss,
  registerKeyHandler,
}: {
  editor: Editor;
  state: SlashState | null;
  onRun(command: SlashCommand, range: Range): void;
  onDismiss(): void;
  /** Hand the extension a key handler that reads this menu's selection. */
  registerKeyHandler(handler: (event: KeyboardEvent) => boolean): void;
}) {
  const [selected, setSelected] = useState(0);
  const rows = useMemo(() => filterSlashCommands(state?.query ?? ""), [state?.query]);
  const { refs, floatingStyles } = useFloating({
    placement: "bottom-start",
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    refs.setReference(rectReference(state?.rect ?? null));
  }, [state?.rect, refs]);

  useEffect(() => {
    setSelected(0);
  }, [state?.query]);

  useEffect(() => {
    registerKeyHandler((event) => {
      if (state === null || rows.length === 0) return false;
      if (event.key === "ArrowDown") {
        setSelected((current) => (current + 1) % rows.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        setSelected((current) => (current - 1 + rows.length) % rows.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const row = rows[selected];
        if (row === undefined) return false;
        onRun(row, state.range);
        return true;
      }
      if (event.key === "Escape") {
        onDismiss();
        return true;
      }
      return false;
    });
  }, [registerKeyHandler, rows, selected, state, onRun, onDismiss]);

  if (state === null || rows.length === 0 || !editor.isEditable) return null;
  return (
    <div
      ref={refs.setFloating}
      role="listbox"
      aria-label="Insert a block"
      data-testid="note-slash-menu"
      style={floatingStyles}
      className={cn(NOTE_PANEL_CLASS, "w-[280px]")}
    >
      {rows.map((row, index) => {
        const Icon = ICONS[row.icon];
        return (
          <button
            key={row.id}
            type="button"
            role="option"
            aria-selected={index === selected}
            data-testid="note-slash-row"
            data-slash-id={row.id}
            // Pointer down, not click: a click would take the selection out
            // of the editor first and the command would have nothing to act on.
            onMouseMove={() => setSelected(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              onRun(row, state.range);
            }}
            className={cn(PALETTE_ROW_CLASS, index === selected && "bg-alpha-200")}
          >
            <span className={PALETTE_GLYPH_CLASS}>
              <Icon aria-hidden />
            </span>
            <span className={cn(PALETTE_TITLE_CLASS, "max-w-none")}>{row.title}</span>
            <span className="ml-auto shrink-0 text-[12px] text-gray-700">{row.group}</span>
          </button>
        );
      })}
    </div>
  );
}
