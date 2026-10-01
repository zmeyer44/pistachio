import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../../lib/cn";
import type { ViewerProps } from "./FileWindow";
import { readTextFile, writeTextFile } from "./text-encoding";

/**
 * A text file (.txt, and JSON and calendars as text): the words, to read
 * and edit in place. Tab types a tab. A file that is not UTF-8 is shown and
 * not edited.
 */
export default function TextViewer({ item, content, focusSignal, onEdit, onDetail }: ViewerProps) {
  const file = useMemo(() => readTextFile(content.bytes), [content]);
  const [value, setValue] = useState(file.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const code = item.mediaType !== "text/plain";

  useEffect(() => {
    onDetail(file.foreign ? "Read only: not UTF-8" : null);
  }, [file, onDetail]);
  useEffect(() => {
    if (focusSignal > 0) ref.current?.focus({ preventScroll: true });
  }, [focusSignal]);

  return (
    <textarea
      ref={ref}
      data-testid="desk-text-viewer"
      aria-label={item.name}
      value={value}
      readOnly={file.foreign}
      spellCheck={!code}
      onChange={(event) => {
        const next = event.target.value;
        setValue(next);
        onEdit(() => writeTextFile(file, next));
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab" || event.shiftKey || event.metaKey || event.altKey || event.ctrlKey || file.foreign) return;
        event.preventDefault();
        // Through the editing commands, so ⌘Z takes it back.
        document.execCommand("insertText", false, "\t");
      }}
      className={cn(
        "scroll-thin block size-full resize-none bg-background-100 px-6 py-5 text-gray-1000 outline-none selection:bg-blue-300",
        code ? "font-mono text-[12.5px] leading-[20px]" : "text-[14px] leading-[22px]",
      )}
      style={{ tabSize: 4 }}
    />
  );
}
