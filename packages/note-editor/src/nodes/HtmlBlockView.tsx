/**
 * An HTML block in the editor (docs/notes.md §5): the live, sandboxed frame,
 * and a code field beneath it while it is being edited. The edit toggle
 * sits in the right gutter, beside the block: the pointer is invisible to
 * the page while it is inside the frame, so a hover control over it would
 * never show.
 */

import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Check, CodeXml } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { cn } from "../cn";
import { FOCUS } from "../parts";
import { focusAfterNode } from "./focus-after";
import { HtmlFrame } from "./HtmlFrame";
import { useIsEditable } from "./use-is-editable";

const PREVIEW_DELAY_MS = 350;

export function HtmlBlockView({ node, editor, getPos, selected, updateAttributes }: ReactNodeViewProps) {
  const html = (node.attrs["html"] as string | undefined) ?? "";
  const editable = useIsEditable(editor);

  const [editing, setEditing] = useState(html === "");
  const [code, setCode] = useState(html);
  const [syncedHtml, setSyncedHtml] = useState(html);
  const [previewHtml, setPreviewHtml] = useState(html);
  // Undo/redo and a remote revision change the attribute underneath: show them at once.
  if (html !== syncedHtml) {
    setSyncedHtml(html);
    setCode(html);
    setPreviewHtml(html);
  }
  // Typing in the code field previews after a pause.
  useEffect(() => {
    if (code === previewHtml) return;
    const timer = setTimeout(() => setPreviewHtml(code), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [code, previewHtml]);

  const hasLive = previewHtml.trim() !== "";

  const change = (value: string) => {
    setCode(value);
    setSyncedHtml(value);
    updateAttributes({ html: value });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Tab") {
      event.preventDefault();
      const field = event.currentTarget;
      const { selectionStart: start, selectionEnd: end } = field;
      change(`${code.slice(0, start)}  ${code.slice(end)}`);
      requestAnimationFrame(() => field.setSelectionRange(start + 2, start + 2));
    } else if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      setEditing(false);
      focusAfterNode(editor, getPos, node);
    }
  };

  return (
    <NodeViewWrapper
      className="note-html-block"
      data-type="html-block"
      data-selected={selected ? "" : undefined}
      data-editing={editing ? "" : undefined}
      data-testid="note-html-block"
    >
      {editable ? (
        <div className="note-html-block__gutter" contentEditable={false}>
          <button
            type="button"
            className={cn("note-html-block__toggle", FOCUS)}
            aria-pressed={editing}
            aria-label={editing ? "Done editing HTML" : "Edit HTML"}
            title={editing ? "Done (Esc)" : "Edit HTML"}
            data-testid="note-html-block-edit"
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? <Check aria-hidden="true" /> : <CodeXml aria-hidden="true" />}
          </button>
        </div>
      ) : null}
      <div className="note-html-block__preview" contentEditable={false}>
        {hasLive ? (
          <HtmlFrame html={previewHtml} data-testid="note-html-block-frame" />
        ) : (
          <div className="note-html-block__empty">
            <span>Empty HTML block</span>
            {editable && !editing ? (
              <button type="button" className={cn("note-html-block__write", FOCUS)} onClick={() => setEditing(true)}>
                Write HTML
              </button>
            ) : null}
          </div>
        )}
      </div>
      {editing && editable ? (
        <textarea
          className="note-html-block__code"
          contentEditable={false}
          value={code}
          spellCheck={false}
          autoFocus
          rows={Math.min(18, Math.max(4, code.split("\n").length + 1))}
          placeholder={'<div class="widget">Hello</div>\n<script>/* scripts run sandboxed */</script>'}
          aria-label="HTML source"
          data-testid="note-html-block-code"
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : null}
    </NodeViewWrapper>
  );
}
