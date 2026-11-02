/**
 * The hover affordance beside every block, nested ones included
 * (docs/notes.md §5): "+" inserts a block below and opens the slash menu;
 * the grip drags the block, and a click on it opens the block menu.
 *
 * `@tiptap/extension-drag-handle-react` owns whether the handle is shown at
 * all — it sets `visibility` as the pointer moves from block to block and
 * hides it when the pointer leaves the editor's element — so the handle has
 * to live inside that element: `.note-prose` pads a gutter on its left wide
 * enough for both buttons, and the handle sits in the gutter at the block's
 * edge, vertically centred on its first line.
 */

import { offset, type ComputePositionConfig } from "@floating-ui/react";
import type { Editor } from "@tiptap/core";
import type { DragHandleRule, NestedOptions } from "@tiptap/extension-drag-handle";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { GripVertical, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { BlockMenu } from "./BlockMenu";
import { setPendingRange } from "./pending-range";

const HANDLE_HEIGHT = 24;
const GAP = 6;
const TEXTBLOCK_SELECTOR = "p, h1, h2, h3, pre, summary";

interface HoveredBlock {
  node: PMNode;
  pos: number;
}

// Which block the handle targets under the pointer (the deepest candidate that
// no rule excludes; a rule "excludes" by returning the full base score).
const EXCLUDE = 1000;
const CELL_TYPES = new Set(["tableCell", "tableHeader"]);
const LEAD_CONTAINERS = new Set(["callout", "blockquote"]);
const TARGET_RULES: DragHandleRule[] = [
  // Cells, and everything inside them, move with their table.
  {
    id: "insideTable",
    evaluate: ({ $pos, depth }) => {
      for (let d = depth - 1; d > 0; d--) if (CELL_TYPES.has($pos.node(d).type.name)) return EXCLUDE;
      return 0;
    },
  },
  // A callout's or quote's first line is the block itself (as a list item's
  // first paragraph is the item); later children get handles of their own.
  { id: "leadChild", evaluate: ({ parent, isFirst }) => (isFirst && parent !== null && LEAD_CONTAINERS.has(parent.type.name) ? EXCLUDE : 0) },
  // A toggle's summary line stands for the toggle; its body is only a wrapper.
  { id: "toggleParts", evaluate: ({ node }) => (node.type.name === "detailsSummary" || node.type.name === "detailsContent" ? EXCLUDE : 0) },
];
// Stock edge detection penalises depth near a block's top/left edge, which
// excludes every list item (its list wrapper is excluded too) whenever the
// pointer is in the top half of its first line: the handle would vanish or
// stay beside the previously hovered block. Rules alone pick the target.
const NESTED_OPTIONS: NestedOptions = { edgeDetection: "none", rules: TARGET_RULES };

/**
 * Where the handle sits relative to the block's top-left corner: vertically
 * centred on the first line of text, and clear of list markers horizontally.
 */
function measure(editor: Editor, { node, pos }: HoveredBlock): { mainAxis: number; crossAxis: number } {
  const dom = editor.view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return { mainAxis: GAP, crossAxis: 0 };
  const blockRect = dom.getBoundingClientRect();
  const mainAxis = node.type.name === "listItem" ? GAP + 22 : GAP;

  const textblock = dom.matches(TEXTBLOCK_SELECTOR) ? dom : dom.querySelector<HTMLElement>(TEXTBLOCK_SELECTOR);
  if (textblock === null) {
    const crossAxis = blockRect.height < HANDLE_HEIGHT * 2 ? (blockRect.height - HANDLE_HEIGHT) / 2 : 4;
    return { mainAxis, crossAxis };
  }
  const style = getComputedStyle(textblock);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
  const lineTop = textblock.getBoundingClientRect().top - blockRect.top + (parseFloat(style.paddingTop) || 0);
  return { mainAxis, crossAxis: lineTop + (lineHeight - HANDLE_HEIGHT) / 2 };
}

/** Inserts an empty block containing "/" below `block` and puts the caret after it. */
function insertSlashBelow(editor: Editor, { node, pos }: HoveredBlock): void {
  const { state } = editor;
  const { schema } = state;
  if (node.type.name === "paragraph" && node.content.size === 0) {
    editor.chain().focus().insertContentAt(pos + 1, "/").run();
    return;
  }
  const paragraphType = schema.nodes["paragraph"];
  if (paragraphType === undefined) return;
  const paragraph = paragraphType.create(null, schema.text("/"));
  // List items get a sibling item; everything else a paragraph.
  const block =
    node.type.name === "listItem" || node.type.name === "taskItem"
      ? node.type.create(node.type.name === "taskItem" ? { checked: false } : null, paragraph)
      : paragraph;
  const at = pos + node.nodeSize;
  const tr = state.tr.insert(at, block);
  const inserted = tr.doc.nodeAt(at);
  const caret = inserted?.eq(block) === true ? at + block.nodeSize - (block === paragraph ? 1 : 2) : tr.mapping.map(at);
  tr.setSelection(TextSelection.near(tr.doc.resolve(caret), -1)).scrollIntoView();
  editor.view.dispatch(tr);
  editor.view.focus();
}

interface BlockHandleProps {
  editor: Editor;
  onMenuOpenChange: (open: boolean) => void;
}

export function BlockHandle({ editor, onMenuOpenChange }: BlockHandleProps) {
  const [hovered, setHovered] = useState<HoveredBlock | null>(null);
  const [menu, setMenu] = useState<(HoveredBlock & { reference: HTMLElement }) | null>(null);
  // Stable identity: a new config object would re-register the drag plugin.
  const [{ positionConfig, setOffset }] = useState(() => {
    let current = { mainAxis: GAP, crossAxis: 0 };
    const config: ComputePositionConfig = {
      placement: "left-start",
      strategy: "absolute",
      middleware: [offset(() => current)],
    };
    return { positionConfig: config, setOffset: (next: typeof current) => void (current = next) };
  });

  const onNodeChange = useCallback(
    ({ node, pos }: { node: PMNode | null; pos: number }) => {
      const block = node !== null && pos >= 0 ? { node, pos } : null;
      // Runs right before the plugin positions the handle.
      if (block !== null) setOffset(measure(editor, block));
      setHovered(block);
    },
    [editor, setOffset],
  );

  // Whether the menu is open, as of the last call rather than the last
  // render: a close that lands twice in one tick (the menu's own action
  // changing the document, then its `onClose`) must act once.
  const menuOpen = useRef(false);

  const openMenu = (reference: HTMLElement) => {
    if (hovered === null) return;
    const { node, pos } = hovered;
    editor.view.dispatch(setPendingRange(editor.state.tr, { from: pos, to: pos + node.nodeSize, block: true }).setMeta("lockDragHandle", true));
    menuOpen.current = true;
    setMenu({ ...hovered, reference });
    onMenuOpenChange(true);
  };

  const closeMenu = (refocus = false) => {
    if (!menuOpen.current) return;
    menuOpen.current = false;
    setMenu(null);
    onMenuOpenChange(false);
    if (!editor.isDestroyed) {
      editor.view.dispatch(setPendingRange(editor.state.tr, null).setMeta("lockDragHandle", false).setMeta("hideDragHandle", true));
      if (refocus) editor.view.focus();
    }
  };
  const close = useRef(closeMenu);
  close.current = closeMenu;

  // The menu holds the block's position as of when it opened. A document
  // that changes underneath it — a remote revision, the agent's edit, the
  // menu's own action — makes that position a guess, so the menu goes.
  useEffect(() => {
    if (menu === null) return;
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged) close.current();
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor, menu]);

  const onGripKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu(event.currentTarget);
    }
  };

  return (
    <>
      <DragHandle editor={editor} nested={NESTED_OPTIONS} computePositionConfig={positionConfig} onNodeChange={onNodeChange} className="note-drag-handle">
        <div className="note-handle" data-testid="note-block-handle">
          <button
            type="button"
            className="note-handle__button"
            aria-label="Insert block below"
            title="Click to add below"
            data-testid="note-block-plus"
            onClick={() => {
              if (hovered !== null) insertSlashBelow(editor, hovered);
            }}
          >
            <Plus aria-hidden="true" />
          </button>
          <div
            role="button"
            tabIndex={0}
            className="note-handle__button note-handle__grip"
            aria-label="Drag to move, click for options"
            title="Drag to move · Click for options"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            data-testid="note-block-grip"
            onClick={(event) => openMenu(event.currentTarget)}
            onKeyDown={onGripKeyDown}
          >
            <GripVertical aria-hidden="true" />
          </div>
        </div>
      </DragHandle>
      {menu === null ? null : <BlockMenu editor={editor} node={menu.node} pos={menu.pos} reference={menu.reference} onClose={closeMenu} />}
    </>
  );
}
