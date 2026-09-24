/**
 * What appears over a selection in a note (docs/notes.md §5), laid out the way
 * Notion lays its own: one row naming the block and offering to turn it into
 * another, then bold / italic / underline / clear, then link / strike / code.
 * It is the only toolbar a note has, and it is only there while there is
 * something selected to apply it to.
 *
 * Positioned off the selection's own rectangle (`posToDOMRect`) with the same
 * @floating-ui panel the slash menu wears.
 */

import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { autoUpdate, flip, offset, shift, useFloating } from "@floating-ui/react";
import { posToDOMRect, type Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import {
  Bold,
  Check,
  ChevronRight,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  RemoveFormatting,
  SquareCode,
  Strikethrough,
  Type,
  Underline,
  type LucideProps,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { FOCUS, NOTE_PANEL_CLASS, rectReference } from "./parts";

const TURN_INTO = [
  { id: "paragraph", label: "Text", icon: Type },
  { id: "heading1", label: "Heading 1", icon: Heading1 },
  { id: "heading2", label: "Heading 2", icon: Heading2 },
  { id: "heading3", label: "Heading 3", icon: Heading3 },
  { id: "bulletList", label: "Bulleted list", icon: List },
  { id: "orderedList", label: "Numbered list", icon: ListOrdered },
  { id: "taskList", label: "To-do list", icon: ListTodo },
  { id: "blockquote", label: "Quote", icon: Quote },
  { id: "codeBlock", label: "Code block", icon: SquareCode },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: ComponentType<LucideProps> }>;

export type TurnIntoId = (typeof TURN_INTO)[number]["id"];

/** How long the pointer rests on the row before the list opens on its own. */
const TURN_INTO_HOVER_MS = 500;
/** How long the pointer may be off both row and list before the list closes. */
const TURN_INTO_LEAVE_MS = 300;

/** Which of the block kinds the selection sits in, read off the editor. */
export function currentBlock(editor: Editor): (typeof TURN_INTO)[number] {
  const found = TURN_INTO.find((option) => {
    switch (option.id) {
      case "heading1":
        return editor.isActive("heading", { level: 1 });
      case "heading2":
        return editor.isActive("heading", { level: 2 });
      case "heading3":
        return editor.isActive("heading", { level: 3 });
      case "paragraph":
        return false;
      default:
        return editor.isActive(option.id);
    }
  });
  return found ?? TURN_INTO[0];
}

const BUTTON = cn(
  "grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-gray-900 transition-colors hover:bg-alpha-200 hover:text-gray-1000 [&_svg]:size-4",
  FOCUS,
);

const ROW = cn(
  "flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-[13px] text-gray-1000 transition-colors hover:bg-alpha-200 [&_svg]:size-4 [&_svg]:text-gray-800",
  FOCUS,
);

export function BubbleMenu({
  editor,
  revision,
  onTurnInto,
  onLink,
}: {
  editor: Editor;
  /** Bumped on every transaction: what is active has to be re-read per keystroke. */
  revision: number;
  onTurnInto(id: TurnIntoId): void;
  onLink(): void;
}) {
  const [turnOpen, setTurnOpen] = useState(false);
  // Resting on the row opens the list without a click, the way Notion's
  // does; leaving the row and the list together closes it, after enough of
  // a grace that crossing the gap between them does not count as leaving.
  const hover = useRef<number | null>(null);
  const leave = useRef<number | null>(null);
  const clearTimers = useCallback(() => {
    if (hover.current !== null) window.clearTimeout(hover.current);
    if (leave.current !== null) window.clearTimeout(leave.current);
    hover.current = null;
    leave.current = null;
  }, []);
  useEffect(() => clearTimers, [clearTimers]);
  const { refs, floatingStyles } = useFloating({
    placement: "top-start",
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  // The list of kinds hangs off the row's right edge, and is taller than the
  // panel: it flips or slides rather than run off the pane.
  const submenu = useFloating({
    placement: "right-start",
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
    open: turnOpen,
  });

  const selection = editor.state.selection;
  // Text only: a selected picture or table cell is a node selection, and
  // bold has nothing to say to it.
  const showing =
    editor.isEditable &&
    selection instanceof TextSelection &&
    !selection.empty &&
    editor.isFocused &&
    selection.from !== selection.to &&
    !editor.isActive("codeBlock");

  useEffect(() => {
    if (!showing) {
      refs.setReference(null);
      setTurnOpen(false);
      clearTimers();
      return;
    }
    refs.setReference(rectReference(posToDOMRect(editor.view, selection.from, selection.to)));
    // `revision` is what makes this follow the selection as it is dragged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showing, revision, refs, editor]);

  if (!showing) return null;
  const mark = (name: string) => (editor.isActive(name) ? "bg-alpha-200 text-gray-1000" : "");
  const block = currentBlock(editor);
  const BlockIcon = block.icon;
  const marks: Array<{ id: string; label: string; icon: ComponentType<LucideProps>; testId?: string; run(): void }> = [
    { id: "bold", label: "Bold", icon: Bold, testId: "note-bold", run: () => editor.chain().focus().toggleBold().run() },
    { id: "italic", label: "Italic", icon: Italic, run: () => editor.chain().focus().toggleItalic().run() },
    { id: "underline", label: "Underline", icon: Underline, run: () => editor.chain().focus().toggleUnderline().run() },
    { id: "clear", label: "Clear formatting", icon: RemoveFormatting, run: () => editor.chain().focus().unsetAllMarks().run() },
  ];
  const more: typeof marks = [
    { id: "link", label: "Link", icon: Link2, testId: "note-link", run: onLink },
    { id: "strike", label: "Strikethrough", icon: Strikethrough, run: () => editor.chain().focus().toggleStrike().run() },
    { id: "code", label: "Code", icon: Code, run: () => editor.chain().focus().toggleCode().run() },
  ];
  const row = (items: typeof marks) => (
    <div className="flex items-center gap-1">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            aria-label={item.label}
            title={item.label}
            data-testid={item.testId}
            className={cn(BUTTON, item.id === "clear" ? "" : mark(item.id))}
            onClick={item.run}
          >
            <Icon strokeWidth={2.25} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
  return (
    <div
      ref={refs.setFloating}
      role="toolbar"
      aria-label="Format selection"
      data-testid="note-bubble-menu"
      style={floatingStyles}
      className={cn(NOTE_PANEL_CLASS, "w-[196px] flex-col gap-1 p-1.5")}
      // Keeping the pointer out of the document is what stops the selection
      // collapsing the instant a button is pressed.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div
        onMouseEnter={() => {
          if (leave.current !== null) window.clearTimeout(leave.current);
          leave.current = null;
        }}
        onMouseLeave={() => {
          if (hover.current !== null) window.clearTimeout(hover.current);
          hover.current = null;
          if (!turnOpen) return;
          leave.current = window.setTimeout(() => setTurnOpen(false), TURN_INTO_LEAVE_MS);
        }}
      >
        <button
          ref={submenu.refs.setReference}
          type="button"
          aria-haspopup="menu"
          aria-expanded={turnOpen}
          data-testid="note-turn-into"
          onMouseEnter={() => {
            if (turnOpen || hover.current !== null) return;
            hover.current = window.setTimeout(() => {
              hover.current = null;
              setTurnOpen(true);
            }, TURN_INTO_HOVER_MS);
          }}
          onMouseLeave={() => {
            if (hover.current !== null) window.clearTimeout(hover.current);
            hover.current = null;
          }}
          onClick={() => {
            clearTimers();
            setTurnOpen((open) => !open);
          }}
          className={cn(ROW, turnOpen && "bg-alpha-200")}
        >
          <BlockIcon strokeWidth={2} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium">{block.label}</span>
          <ChevronRight className="!size-3.5 text-gray-700" strokeWidth={2.25} aria-hidden="true" />
        </button>
        {turnOpen ? (
          <div
            ref={submenu.refs.setFloating}
            role="menu"
            aria-label="Turn into"
            style={submenu.floatingStyles}
            className={cn(NOTE_PANEL_CLASS, "w-[188px]")}
          >
            {TURN_INTO.map((option) => {
              const Icon = option.icon;
              const current = option.id === block.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={current}
                  data-testid={`note-turn-${option.id}`}
                  onClick={() => {
                    setTurnOpen(false);
                    onTurnInto(option.id);
                  }}
                  className={ROW}
                >
                  <Icon strokeWidth={2} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {current ? <Check className="!size-3.5 !text-gray-1000" strokeWidth={2.5} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <hr className="border-0 border-t border-alpha-200" />
      {row(marks)}
      {row(more)}
    </div>
  );
}
