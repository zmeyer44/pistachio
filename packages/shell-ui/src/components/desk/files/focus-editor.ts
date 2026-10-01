import type { Editor } from "@tiptap/core";

/**
 * Give an editor the keyboard — once it is mounted: a window chosen as it
 * opens asks before its editor has a view, whose commands do not exist yet.
 */
export function focusEditor(editor: Editor | null): () => void {
  if (editor === null || editor.isDestroyed) return () => undefined;
  // What had the keyboard when it was asked: if that changes before the editor is ready (the person clicked
  // into the editor, or went elsewhere), the keyboard is where they put it.
  const asked = typeof document === "undefined" ? null : document.activeElement;
  const focus = (): void => {
    if (editor.isDestroyed || editor.isFocused) return;
    if (typeof document !== "undefined" && document.activeElement !== asked) return;
    try {
      editor.commands.focus(null, { scrollIntoView: false });
    } catch {
      // Not mounted after all: the next choosing of the window focuses it.
    }
  };
  if (editor.isInitialized) {
    if (!editor.isFocused) {
      try {
        editor.commands.focus(null, { scrollIntoView: false });
      } catch {
        // Not mounted after all: the next choosing of the window focuses it.
      }
    }
    return () => undefined;
  }
  const onCreate = (): void => {
    editor.off("create", onCreate);
    requestAnimationFrame(focus);
  };
  editor.on("create", onCreate);
  return () => editor.off("create", onCreate);
}
