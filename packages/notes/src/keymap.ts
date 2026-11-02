/**
 * Notion-style block keys that TipTap's defaults get wrong (docs/notes.md §5).
 */

import { Extension, type Editor } from "@tiptap/core";
import { ListKeymap, listHelpers, type ListKeymapOptions } from "@tiptap/extension-list";
import type { ResolvedPos } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

/**
 * The stock list keymap runs Backspace for every list type even after one has
 * handled it: at the start of a bullet that follows a to-do list, the bullet
 * is lifted to a paragraph and then immediately merged into the to-do above.
 * This one stops at the first list type that handles the key.
 */
export const NoteListKeymap = ListKeymap.extend<ListKeymapOptions>({
  // Ahead of the core keymap, whose joinBackward would otherwise get the key
  // first and pour a list item's text into the block above.
  priority: 101,

  addKeyboardShortcuts() {
    const inherited = this.parent?.() ?? {};
    const backspace = ({ editor }: { editor: Editor }) =>
      this.options.listTypes.some(
        ({ itemName, wrapperNames }) => editor.schema.nodes[itemName] !== undefined && listHelpers.handleBackspace(editor, itemName, wrapperNames),
      );
    return { ...inherited, Backspace: backspace, "Mod-Backspace": backspace };
  },
});

/** Backspace at the very start of a heading turns it into text instead of merging it upward. */
export const HeadingBackspace = Extension.create({
  name: "headingBackspace",
  // Ahead of the core keymap's joinBackward.
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { empty, $from } = editor.state.selection;
        if (!empty || $from.parentOffset !== 0 || $from.parent.type.name !== "heading") return false;
        // A heading just made by "# " goes back to the typed text first.
        return editor.commands.undoInputRule() || editor.commands.setNode("paragraph");
      },
    };
  },
});

/**
 * Tab and Shift-Tab that nothing else handled (lists nest, tables move between
 * cells, code indents) do nothing instead of moving focus out of the page,
 * as in Notion.
 */
export const KeepTabInEditor = Extension.create({
  name: "keepTabInEditor",
  // Last of all (TipTap reads a priority of 0 as the default 100).
  priority: 1,

  addKeyboardShortcuts() {
    return {
      Tab: () => true,
      "Shift-Tab": () => true,
    };
  },
});

const ITEM_TYPES = new Set(["listItem", "taskItem"]);
const LEAD_CONTAINERS = new Set(["callout", "blockquote"]);

/**
 * Depth of the block a keyboard move or duplicate acts on: the caret's
 * textblock, or the item / toggle / callout / quote / table it heads (the same
 * block the drag handle grabs).
 */
export function movableDepth($from: ResolvedPos): number {
  if (!$from.parent.isTextblock || $from.depth < 1) return 0;
  if ($from.parent.type.name === "detailsSummary") return $from.depth - 1;
  let depth = $from.depth;
  for (let d = $from.depth - 1; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") depth = d - 2; // the table
  }
  if (depth !== $from.depth) return depth;
  const parent = $from.node(depth - 1);
  const first = $from.index(depth - 1) === 0;
  if (ITEM_TYPES.has(parent.type.name) && first) return depth - 1;
  if (LEAD_CONTAINERS.has(parent.type.name) && first) return depth - 1;
  return depth;
}

export function moveBlock(editor: Editor, dir: -1 | 1): boolean {
  const { state, view } = editor;
  if (!(state.selection instanceof TextSelection)) return false;
  const { $from, from, to } = state.selection;
  const depth = movableDepth($from);
  if (depth < 1) return false;
  const node = $from.node(depth);
  const start = $from.before(depth);
  if (to > start + node.nodeSize) return false; // a selection across blocks: leave the key to the browser
  const index = $from.index(depth - 1);
  const parent = $from.node(depth - 1);
  const sibling = dir < 0 ? (index > 0 ? parent.child(index - 1) : null) : index < parent.childCount - 1 ? parent.child(index + 1) : null;
  // At the edge of its container the block stays put (the key is still ours).
  if (!sibling) return true;
  const tr = state.tr.delete(start, start + node.nodeSize);
  const target = dir < 0 ? start - sibling.nodeSize : start + sibling.nodeSize;
  tr.insert(target, node);
  const shift = target - start;
  tr.setSelection(TextSelection.create(tr.doc, from + shift, to + shift)).scrollIntoView();
  view.dispatch(tr);
  return true;
}

export function duplicateBlock(editor: Editor): boolean {
  const { state, view } = editor;
  if (!(state.selection instanceof TextSelection)) return false;
  const { $from, from, to } = state.selection;
  const depth = movableDepth($from);
  if (depth < 1) return false;
  const node = $from.node(depth);
  const end = $from.after(depth);
  if (to > end) return false;
  const tr = state.tr.insert(end, node.copy(node.content));
  const shift = end - $from.before(depth);
  tr.setSelection(TextSelection.create(tr.doc, from + shift, to + shift)).scrollIntoView();
  view.dispatch(tr);
  return true;
}

/** Notion's block shortcuts: ⌘⇧↑ / ⌘⇧↓ move the current block, ⌘D duplicates it. */
export const BlockShortcuts = Extension.create({
  name: "blockShortcuts",

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-ArrowUp": ({ editor }) => moveBlock(editor, -1),
      "Mod-Shift-ArrowDown": ({ editor }) => moveBlock(editor, 1),
      "Mod-d": ({ editor }) => duplicateBlock(editor),
    };
  },
});
