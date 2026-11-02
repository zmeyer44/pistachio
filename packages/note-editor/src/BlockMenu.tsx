/**
 * Block actions opened from the drag grip (docs/notes.md §5): turn into,
 * duplicate, delete. Its own popover on the note's panel, hung off the grip
 * with @floating-ui, keyboard-walkable, closed by Escape or a click away.
 */

import { autoUpdate, flip, offset, shift, useDismiss, useFloating, useInteractions } from "@floating-ui/react";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { ArrowLeft, Check, ChevronRight, Copy, Repeat2, Trash2 } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { cn } from "./cn";
import { BLOCK_TYPES } from "./block-types";
import { FOCUS, NOTE_PANEL_CLASS } from "./parts";

/** Blocks whose content can be re-typed; atoms (images, embeds, tables, widgets) cannot. */
const CONVERTIBLE = new Set(["paragraph", "heading", "bulletList", "orderedList", "taskList", "listItem", "taskItem", "blockquote", "callout", "codeBlock", "details"]);

const ROW = cn(
  "flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-[13px] text-gray-1000 outline-none transition-colors hover:bg-alpha-200 focus-visible:bg-alpha-200 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-gray-800",
);

interface BlockMenuProps {
  editor: Editor;
  node: PMNode;
  pos: number;
  reference: HTMLElement;
  /** `refocus`: hand focus back to the editor (Escape), as opposed to a click elsewhere. */
  onClose: (refocus?: boolean) => void;
}

/** The BLOCK_TYPES id describing a block node (list items take their list's type). */
function blockTypeId(node: PMNode, parent: PMNode): string {
  switch (node.type.name) {
    case "heading":
      return `heading${String(node.attrs["level"])}`;
    case "listItem":
    case "taskItem":
      return parent.type.name;
    default:
      return node.type.name;
  }
}

function focusSibling(container: HTMLElement, delta: number): void {
  const items = Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  const index = items.indexOf(document.activeElement as HTMLElement);
  items[(index + delta + items.length) % items.length]?.focus();
}

export function BlockMenu({ editor, node, pos, reference, onClose }: BlockMenuProps) {
  const [view, setView] = useState<"main" | "turnInto">("main");
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const { floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (open, _event, reason) => {
      if (!open) onClose(reason === "escape-key");
    },
    elements: { reference, floating: panel },
    placement: "bottom-start",
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const { getFloatingProps } = useInteractions([useDismiss(context)]);

  useEffect(() => {
    panel?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [panel, view]);

  const run = (action: () => void) => {
    action();
    onClose();
  };

  const selectBlockText = () => {
    const { doc } = editor.state;
    const selection = TextSelection.between(doc.resolve(pos), doc.resolve(pos + node.nodeSize));
    editor.view.dispatch(editor.state.tr.setSelection(selection));
  };

  const duplicate = () => editor.chain().focus().insertContentAt(pos + node.nodeSize, node.toJSON() as Record<string, unknown>).run();
  const remove = () => editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusSibling(event.currentTarget as HTMLElement, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "ArrowLeft" && view === "turnInto") {
      setView("main");
    }
  };

  const current = blockTypeId(node, editor.state.doc.resolve(pos).parent);

  return (
    <div
      ref={setPanel}
      style={floatingStyles}
      className={cn(NOTE_PANEL_CLASS, "w-[220px]")}
      role="menu"
      aria-label="Block actions"
      data-testid="note-block-menu"
      {...getFloatingProps({ onKeyDown })}
    >
      {view === "main" ? (
        <>
          {CONVERTIBLE.has(node.type.name) ? (
            <button type="button" role="menuitem" className={cn(ROW, FOCUS)} data-testid="note-block-turn-into" onClick={() => setView("turnInto")}>
              <Repeat2 aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">Turn into</span>
              <ChevronRight className="!size-3.5 text-gray-700" aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" role="menuitem" className={cn(ROW, FOCUS)} data-testid="note-block-duplicate" onClick={() => run(duplicate)}>
            <Copy aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Duplicate</span>
            <kbd className="font-mono text-[11px] text-gray-600">⌘D</kbd>
          </button>
          <hr className="my-1 border-0 border-t border-alpha-200" />
          <button
            type="button"
            role="menuitem"
            className={cn(ROW, FOCUS, "text-red-900 hover:bg-alpha-200 [&_svg]:text-red-900")}
            data-testid="note-block-delete"
            onClick={() => run(remove)}
          >
            <Trash2 aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Delete</span>
            <kbd className="font-mono text-[11px] text-gray-600">Del</kbd>
          </button>
        </>
      ) : (
        <>
          <button type="button" role="menuitem" className={cn(ROW, FOCUS, "text-gray-800")} onClick={() => setView("main")}>
            <ArrowLeft aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Turn into</span>
          </button>
          {BLOCK_TYPES.map((type) => {
            const Icon = type.icon;
            return (
              <button
                key={type.id}
                type="button"
                role="menuitem"
                className={cn(ROW, FOCUS)}
                data-testid={`note-block-turn-${type.id}`}
                onClick={() =>
                  run(() => {
                    selectBlockText();
                    type.apply(editor);
                  })
                }
              >
                <Icon aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{type.label}</span>
                {type.id === current ? <Check className="!size-3.5 !text-gray-1000" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}
