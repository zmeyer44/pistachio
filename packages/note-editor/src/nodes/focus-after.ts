import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";

/** Returns focus to the document, with the caret in the block after an atom node view. */
export function focusAfterNode(editor: Editor, getPos: () => number | undefined, node: PMNode): void {
  const pos = getPos();
  if (typeof pos !== "number" || editor.isDestroyed) return;
  const { state } = editor;
  const $after = state.doc.resolve(Math.min(pos + node.nodeSize, state.doc.content.size));
  editor.view.dispatch(state.tr.setSelection(Selection.near($after, 1)).scrollIntoView());
  editor.view.focus();
}
