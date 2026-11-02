/**
 * Clipboard policy for the mounted editor: plain text that looks like
 * markdown (and HTML copied from code editors, which is really plain text) is
 * parsed into rich content rather than quoted as one paragraph.
 */

import { Extension } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { looksLikeMarkdown, markdownToDoc } from "./markdown.js";

function isPlainTextSource(data: DataTransfer): boolean {
  const html = data.getData("text/html");
  return html === "" || data.types.includes("vscode-editor-data");
}

function pasteMarkdown(view: EditorView, text: string): boolean {
  const { $from } = view.state.selection;
  if ($from.parent.type.spec.code === true) return false;
  let slice: Slice;
  try {
    slice = Slice.maxOpen(markdownToDoc(text, view.state.schema).content);
  } catch {
    return false;
  }
  view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste"));
  return true;
}

export const PastePolicy = Extension.create({
  name: "pastePolicy",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("pastePolicy"),
        props: {
          handlePaste(view, event) {
            const data = event.clipboardData;
            if (data === null || !isPlainTextSource(data)) return false;
            const text = data.getData("text/plain");
            if (text === "" || !looksLikeMarkdown(text)) return false;
            return pasteMarkdown(view, text);
          },
        },
      }),
    ];
  },
});
