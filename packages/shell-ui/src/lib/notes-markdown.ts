/**
 * A note's document, and markdown in and out of it (docs/notes.md §5).
 *
 * Markdown is the canonical format (N1): the record holds text, and the
 * ProseMirror document is only a view of it. What lives here is the SHAPE of
 * that view — the extension list that says what a note may contain — and the
 * two conversions, so the editor, a preview and a test all agree on what
 * `# Title` becomes.
 *
 * Deliberately DOM-free. `resolveExtensions` and `MarkdownManager` only read
 * the extensions' configuration, so the round trip can be tested in Node
 * without a window; the parts that need one (the image's node view, the
 * placeholder, the slash menu) are passed in by the editor or added beside
 * this list.
 */

import type { AnyExtension, JSONContent, NodeViewRenderer } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { Image } from "@tiptap/extension-image";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { TableKit } from "@tiptap/extension-table";

export interface NoteExtensionOptions {
  /**
   * How an image draws itself. A note's `src` is `note-blob:<id>` (N3), which
   * no browser can load, so the editor hands in a node view that resolves the
   * id to an object URL. Without one the node still parses and serialises —
   * which is all the markdown conversion needs.
   */
  imageNodeView?: NodeViewRenderer;
}

/**
 * What a note may contain. Headings stop at three (a note is not a website),
 * and the link mark comes from StarterKit rather than beside it — adding
 * `@tiptap/extension-link` as well registers the name twice.
 */
export function noteExtensions(options: NoteExtensionOptions = {}): AnyExtension[] {
  const view = options.imageNodeView;
  const image = view === undefined ? Image : Image.extend({ addNodeView: () => view });
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // The href is followed through the store (Mod-click), never by the
      // editor: a note is a document being written, not a page.
      link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer" } },
      // Where a dragged block will land: drawn by `.note-drop-cursor` in the
      // shell's tokens rather than the plugin's own black hairline.
      dropcursor: { color: false, width: 3, class: "note-drop-cursor" },
    }),
    image.configure({ inline: false, allowBase64: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
  ];
}

/**
 * The same conversion the editor's own `@tiptap/markdown` storage does, over
 * the same extensions (it flattens and sorts the list itself, so this is
 * handed the unflattened one exactly as an editor hands it its base
 * extensions). Built once: the conversions run on every remote revision and
 * every "Copy as markdown".
 */
let manager: MarkdownManager | null = null;

export function noteMarkdownManager(): MarkdownManager {
  manager ??= new MarkdownManager({ extensions: noteExtensions() });
  return manager;
}

/** `# Hi` → the document a note's body is edited as. */
export function markdownToDoc(markdown: string): JSONContent {
  return noteMarkdownManager().parse(markdown);
}

/** The document back to the canonical text the record keeps. */
export function docToMarkdown(doc: JSONContent): string {
  return noteMarkdownManager().serialize(doc);
}

/**
 * Markdown as the editor would keep it: parsed and serialised once. Two
 * spellings of the same document (`*a*` and `_a_`) settle on one here, so a
 * note that was never touched is not reported dirty the moment it opens.
 */
export function normalizeNoteMarkdown(markdown: string): string {
  return docToMarkdown(markdownToDoc(markdown));
}

/** Text that is markdown rather than prose: pasting it should parse, not quote. */
export function looksLikeMarkdown(text: string): boolean {
  return /^ {0,3}(#{1,6} |[-*+] |\d+[.)] |> |```|\|.*\|)/mu.test(text) || /\[[^\]]*\]\([^)]*\)/u.test(text);
}
