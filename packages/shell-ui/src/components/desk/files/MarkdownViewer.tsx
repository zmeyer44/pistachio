import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Markdown } from "@tiptap/markdown";
import { docToMarkdown, noteExtensions } from "../../../lib/notes-markdown";
import { useAppStore } from "../../../store";
import type { ViewerProps } from "./FileWindow";
import { focusEditor } from "./focus-editor";
import { readTextFile, writeTextFile } from "./text-encoding";

/** A document's front matter (`---` … `---` at its very top): kept aside, as it was, and written back ahead of the body. */
export function splitFrontMatter(text: string): { frontMatter: string; body: string } {
  const match = /^---\r?\n[\s\S]*?\r?\n(---|\.\.\.)\r?\n?/.exec(text);
  return match === null ? { frontMatter: "", body: text } : { frontMatter: match[0], body: text.slice(match[0].length) };
}

/**
 * A markdown file: shown as the document it describes, edited in place as
 * a note is (the notes' editor and its shape of a document), or, in
 * Markdown, as its source. A file never edited is never written back — the
 * editor's way of spelling a document is not forced on it just by opening.
 */
export default function MarkdownViewer({ item, content, focusSignal, onEdit }: ViewerProps) {
  const file = useMemo(() => readTextFile(content.bytes), [content]);
  const { frontMatter, body } = useMemo(() => splitFrontMatter(file.text), [file]);
  const [mode, setMode] = useState<"rich" | "source">("rich");
  const [source, setSource] = useState(body);
  /** The rich document was edited since the source was last read from it. */
  const richEdited = useRef(false);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const openLink = useAppStore((state) => state.openLink);
  const extensions = useMemo(() => [...noteExtensions(), Markdown], []);
  const editor = useEditor({
    extensions,
    content: body,
    contentType: "markdown",
    editable: !file.foreign,
    autofocus: false,
    editorProps: {
      attributes: { class: "note-prose desk-md-prose", "data-testid": "desk-markdown-viewer", spellcheck: "true", "aria-label": item.name },
      handleDOMEvents: {
        // A link is text being edited; with ⌘ it opens, as a note's does.
        click: (_view, event) => {
          const anchor = event.target instanceof Element ? event.target.closest("a") : null;
          if (anchor === null || !(event.metaKey || event.ctrlKey)) return false;
          const href = anchor.getAttribute("href");
          if (href === null || href === "") return false;
          event.preventDefault();
          const box = anchor.getBoundingClientRect();
          void openLink(href, { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) }, true);
          return true;
        },
      },
    },
    onUpdate: ({ editor: current, transaction }) => {
      if (!transaction.docChanged) return;
      richEdited.current = true;
      onEdit(() => writeTextFile(file, frontMatter + docToMarkdown(current.getJSON())));
    },
  });

  useEffect(() => {
    if (focusSignal === 0) return;
    if (mode !== "source") return focusEditor(editor);
    sourceRef.current?.focus({ preventScroll: true });
  }, [focusSignal, editor, mode]);

  const toSource = (): void => {
    if (mode === "source") return;
    if (richEdited.current && editor !== null) setSource(docToMarkdown(editor.getJSON()));
    richEdited.current = false;
    setMode("source");
  };
  const toRich = (): void => {
    if (mode === "rich") return;
    editor?.commands.setContent(source, { contentType: "markdown", emitUpdate: false });
    richEdited.current = false;
    setMode("rich");
  };

  return (
    <div className="desk-viewer-column" data-mode={mode}>
      <div className="desk-viewer-toolbar">
        <span className="min-w-0 flex-1" />
        <div className="desk-segmented" role="radiogroup" aria-label="Show as">
          <button type="button" role="radio" aria-checked={mode === "rich"} data-testid="desk-markdown-rich" onMouseDown={(event) => event.preventDefault()} onClick={toRich}>
            Document
          </button>
          <button type="button" role="radio" aria-checked={mode === "source"} data-testid="desk-markdown-source" onMouseDown={(event) => event.preventDefault()} onClick={toSource}>
            Markdown
          </button>
        </div>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-background-100">
        {mode === "rich" ? (
          <div className="mx-auto max-w-[720px] px-8 pt-5 pb-10">
            <EditorContent editor={editor} />
          </div>
        ) : (
          <textarea
            ref={sourceRef}
            data-testid="desk-markdown-source-text"
            aria-label={`${item.name}, as Markdown`}
            value={source}
            readOnly={file.foreign}
            spellCheck
            onChange={(event) => {
              const next = event.target.value;
              setSource(next);
              onEdit(() => writeTextFile(file, frontMatter + next));
            }}
            className="block size-full min-h-full resize-none bg-background-100 px-8 py-5 font-mono text-[12.5px] leading-[20px] text-gray-1000 outline-none"
          />
        )}
      </div>
    </div>
  );
}
