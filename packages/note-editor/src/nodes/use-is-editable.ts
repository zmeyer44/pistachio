import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";

/** Editable flag that re-renders node views when the editor toggles read-only (a desk hover card's preview). */
export function useIsEditable(editor: Editor): boolean {
  return useEditorState({ editor, selector: ({ editor: e }) => e.isEditable });
}
