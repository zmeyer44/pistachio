import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { docxMedia, openDocx, saveDocx, type DocxDoc } from "@pistachio/documents";
import { DOC_MEDIA_TYPE } from "@pistachio/shell-contracts/desk-agent";
import type { ViewerProps } from "./FileWindow";
import { focusEditor } from "./focus-editor";
import { useObjectUrls } from "./object-urls";
import { docxExtensions } from "./docx-schema";

/** A CSS declaration list ("a:b;c:d") as React's style object. */
function styleOf(css: string): CSSProperties {
  const style: Record<string, string> = {};
  for (const declaration of css.split(";")) {
    const at = declaration.indexOf(":");
    if (at <= 0) continue;
    const name = declaration.slice(0, at).trim().replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    style[name] = declaration.slice(at + 1).trim();
  }
  return style as CSSProperties;
}

/** The page is shown no smaller than this, nor larger than the next, of its size: fit to the window between. */
const MIN_ZOOM = 0.45;
const MAX_ZOOM = 1.25;

/**
 * A Word document (.docx, and a .doc as the .docx macOS turns it into): its
 * page, laid out as the file's own styles say, with its text edited in
 * place. What the editor keeps as it was — pictures, fields, a table of
 * contents, paragraphs with tracked changes — is shown and not edited, and
 * an edit is written back into the file around it (saveDocx).
 */
export default function DocumentViewer({ item, content, focusSignal, onEdit, onDetail }: ViewerProps) {
  const bytes = content.shown?.bytes ?? content.bytes;
  const opened = useMemo(() => {
    try {
      return { ok: true as const, ...openDocx(bytes) };
    } catch (error) {
      return { ok: false as const, message: error instanceof Error ? error.message : "the file could not be read" };
    }
  }, [bytes]);
  const [docId] = useState(() => crypto.randomUUID());
  const blobs = useMemo(() => {
    const parts: Record<string, Blob> = {};
    if (!opened.ok) return parts;
    for (const part of docxMedia(opened.source, opened.view)) parts[part.path] = new Blob([part.bytes as BlobPart], { type: part.mediaType });
    return parts;
  }, [opened]);
  const media = useObjectUrls(blobs);

  const extensions = useMemo(
    () => docxExtensions({ docId, media, lists: opened.ok ? opened.view.lists : {}, markerCss: opened.ok ? opened.view.markerCss : {} }),
    [docId, media, opened],
  );
  const editor = useEditor(
    {
      extensions,
      content: opened.ok ? (opened.view.doc as unknown as Record<string, unknown>) : { type: "doc", content: [{ type: "docxParagraph" }] },
      editable: opened.ok,
      autofocus: false,
      editorProps: {
        attributes: { class: "docx-body", "data-testid": "desk-document-viewer", spellcheck: "true", "aria-label": item.name, "data-docx-doc": docId },
      },
      onUpdate: ({ editor: current, transaction }) => {
        if (!opened.ok || !transaction.docChanged) return;
        const source = opened.source;
        onEdit(() => saveDocx(source, current.getJSON() as unknown as DocxDoc));
      },
    },
    [extensions],
  );

  useEffect(() => {
    if (!opened.ok) return;
    onDetail(item.mediaType === DOC_MEDIA_TYPE ? "Saved as a Word 97–2004 document" : opened.view.locked > 0 ? "Some parts kept as they are" : null);
  }, [item.mediaType, onDetail, opened]);
  useEffect(() => (focusSignal > 0 ? focusEditor(editor) : undefined), [focusSignal, editor]);

  // The page fits the window's width, between a least and a most.
  const deskRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const pageWidth = opened.ok ? opened.view.page.width : 816;
  useLayoutEffect(() => {
    const el = deskRef.current;
    if (el === null) return;
    const measure = (): void => setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (el.clientWidth - 40) / pageWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [pageWidth]);

  if (!opened.ok) {
    return (
      <div className="grid size-full place-items-center bg-background-100 p-6 text-center text-[12px] text-gray-800" data-testid="desk-document-error">
        This document could not be opened: {opened.message}. It may be damaged, or protected by a password.
      </div>
    );
  }
  const { page, baseCss } = opened.view;
  return (
    <div ref={deskRef} className="docx-desk scroll-thin">
      <div
        className="docx-page"
        style={{
          ...styleOf(baseCss),
          width: page.width,
          paddingTop: page.margin.top,
          paddingRight: page.margin.right,
          paddingBottom: page.margin.bottom,
          paddingLeft: page.margin.left,
          zoom,
        }}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
