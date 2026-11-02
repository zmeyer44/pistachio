/**
 * The live frame of an HTML block: scripts run in an opaque origin (never
 * same-origin), and an injected script reports the content height so the
 * frame is as tall as what it holds.
 *
 * The document is the frame's own (`srcdoc`) unless the host serves it from
 * an address of its own (`NoteEditorHost.frameSrc`): a `srcdoc` frame
 * inherits the policy of the page around it, and a page that allows no
 * inline script — the desktop shell — would run none of the widget.
 */

import { buildHtmlBlockDocument, HTML_BLOCK_HEIGHT_MESSAGE, HTML_BLOCK_SANDBOX } from "@pistachio/notes";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNoteHost } from "../host";

const MIN_HEIGHT = 24;
const MAX_HEIGHT = 4000;

let documentSeq = 0;

export interface HtmlFrameProps {
  html: string;
  title?: string;
  className?: string;
  style?: CSSProperties;
  /** Height before the frame has reported one. */
  fallbackHeight?: number;
  maxHeight?: number;
  "data-testid"?: string;
}

export function HtmlFrame({ html, title = "HTML block", className, style, fallbackHeight = 120, maxHeight = MAX_HEIGHT, ...rest }: HtmlFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const host = useNoteHost();
  // A token per document, echoed in its height reports: late reports from the
  // previous document (the same iframe, navigated) are ignored.
  const { document, token } = useMemo(() => {
    documentSeq += 1;
    const next = `d${String(documentSeq)}`;
    return { token: next, document: buildHtmlBlockDocument(html, { token: next }) };
  }, [html]);
  const src = useMemo(() => host.frameSrc?.(document), [host, document]);
  const [report, setReport] = useState<{ token: string; height: number } | null>(null);
  const current = useRef(token);
  useEffect(() => {
    current.current = token;
  });

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // The frame has an opaque origin, so match on the sending window instead.
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown; token?: unknown } | null;
      if (data?.type !== HTML_BLOCK_HEIGHT_MESSAGE || typeof data.height !== "number") return;
      if (data.token !== current.current) return;
      const height = Math.min(maxHeight, Math.max(MIN_HEIGHT, Math.ceil(data.height)));
      const expected = current.current;
      setReport((prev) => (prev?.token === expected && prev.height === height ? prev : { token: expected, height }));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [maxHeight]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox={HTML_BLOCK_SANDBOX}
      {...(src === undefined ? { srcDoc: document } : { src })}
      className={className}
      // Keep the last known height while a new document loads: no collapse, no jump.
      style={{ ...style, height: report?.height ?? fallbackHeight }}
      {...rest}
    />
  );
}
