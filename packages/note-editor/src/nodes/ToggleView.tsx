/**
 * A toggle (details) in the editor. The open state comes only from the
 * node's `open` attribute; CSS hides the content of closed toggles, so the
 * chevron and the content can never disagree. Read only (a preview), the
 * state is local and not saved.
 */

import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useIsEditable } from "./use-is-editable";

export function ToggleView({ node, editor, updateAttributes }: ReactNodeViewProps) {
  const editable = useIsEditable(editor);
  const [readerOpen, setReaderOpen] = useState<boolean | null>(null);
  const open = editable ? node.attrs["open"] === true : (readerOpen ?? node.attrs["open"] === true);

  const toggle = () => {
    if (editable) updateAttributes({ open: !open });
    else setReaderOpen(!open);
  };

  return (
    <NodeViewWrapper className="note-toggle" data-type="details" data-open={open ? "" : undefined} data-testid="note-toggle">
      <button
        type="button"
        className="note-toggle__button"
        contentEditable={false}
        aria-expanded={open}
        aria-label={open ? "Collapse toggle" : "Expand toggle"}
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggle}
      >
        <ChevronRight aria-hidden="true" />
      </button>
      <NodeViewContent className="note-toggle__body" />
    </NodeViewWrapper>
  );
}
