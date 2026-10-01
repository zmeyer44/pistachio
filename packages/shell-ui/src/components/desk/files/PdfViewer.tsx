import { memo, useEffect, useLayoutEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from "react";
import { Minus, MoveHorizontal, Plus } from "lucide-react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { ViewerProps } from "./FileWindow";
import { stepZoom } from "./ImageViewer";
import { ZoomBar } from "./ZoomBar";

/** pdf.js, loaded the first time a PDF is opened, with its worker (one for every PDF window). */
let pdfjs: Promise<typeof import("pdfjs-dist")> | null = null;
function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  pdfjs ??= import("pdfjs-dist").then((module) => {
    module.GlobalWorkerOptions.workerPort ??= new Worker(new URL("./pdf-worker.js", import.meta.url), { type: "module" });
    return module;
  });
  return pdfjs;
}

/** Between the pages, and around them. */
const PAGE_GAP = 12;
const SIDE = 20;

interface PageSize {
  w: number;
  h: number;
}

/**
 * A PDF: its pages one under another, fitted to the window's width or
 * zoomed (the bar, ⌘+ and ⌘−, pinching), each drawn as it comes into view,
 * sharp at the screen's resolution, with its text selectable and copyable.
 * The page in view is counted in the bar.
 */
export default function PdfViewer({ item, content, focusSignal, onDetail }: ViewerProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  /** null: fitted to the window's width. */
  const [zoom, setZoom] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(1);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const loading: { task: PDFDocumentLoadingTask | null } = { task: null };
    const task = loadPdfjs().then((module) => {
      // A copy: the worker takes the bytes it is given.
      loading.task = module.getDocument({ data: content.bytes.slice(), useSystemFonts: true, enableXfa: false });
      return loading.task.promise;
    });
    task
      .then(async (document) => {
        if (cancelled) return;
        // Every page's size first, so the scroll is the whole document's from the start.
        const first = (await document.getPage(1)).getViewport({ scale: 1 });
        const all: PageSize[] = Array.from({ length: document.numPages }, () => ({ w: first.width, h: first.height }));
        if (cancelled) return;
        setSizes(all);
        setPdf(document);
        for (let index = 2; index <= Math.min(document.numPages, 400) && !cancelled; index += 1) {
          const viewport = (await document.getPage(index)).getViewport({ scale: 1 });
          if (viewport.width !== first.width || viewport.height !== first.height) setSizes((before) => before.map((size, at) => (at === index - 1 ? { w: viewport.width, h: viewport.height } : size)));
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const name = error instanceof Error ? error.name : "";
        setFailure(name === "PasswordException" ? "This PDF is protected by a password." : "This PDF could not be opened. It may be damaged.");
      });
    return () => {
      cancelled = true;
      void task.catch(() => undefined).then(() => loading.task?.destroy());
    };
  }, [content.bytes]);

  useEffect(() => {
    onDetail(pdf === null ? null : `${String(pdf.numPages)} ${pdf.numPages === 1 ? "page" : "pages"}`);
  }, [onDetail, pdf]);
  useEffect(() => {
    if (focusSignal > 0) scrollerRef.current?.focus({ preventScroll: true });
  }, [focusSignal]);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    const measure = (): void => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const widest = sizes.reduce((max, size) => Math.max(max, size.w), 0) || 612;
  const fit = width === 0 ? 1 : Math.max(0.2, (width - SIDE * 2) / widest);
  const scale = zoom ?? fit;

  // The page in view: the one crossing the window's middle.
  const onScroll = (): void => {
    const el = scrollerRef.current;
    if (el === null || sizes.length === 0) return;
    const middle = el.scrollTop + el.clientHeight / 2;
    let top = PAGE_GAP;
    for (let index = 0; index < sizes.length; index += 1) {
      const bottom = top + sizes[index]!.h * scale;
      if (middle < bottom + PAGE_GAP) {
        setCurrent(index + 1);
        return;
      }
      top = bottom + PAGE_GAP;
    }
    setCurrent(sizes.length);
  };

  // A zoom keeps the part in view in view.
  const zoomTo = (next: number | null): void => {
    const el = scrollerRef.current;
    const before = scale;
    const after = next ?? fit;
    if (el !== null && before > 0) {
      const ratio = (el.scrollTop + el.clientHeight / 2) / Math.max(1, el.scrollHeight);
      requestAnimationFrame(() => {
        el.scrollTop = ratio * el.scrollHeight - el.clientHeight / 2;
      });
    }
    setZoom(next === null || Math.abs(after - fit) < 0.001 ? null : next);
  };
  const onWheel = (event: ReactWheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomTo(Math.min(6, Math.max(0.25, scale * Math.exp(-event.deltaY / 300))));
  };
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key === "=" || event.key === "+") {
      event.preventDefault();
      zoomTo(stepZoom(scale, 1));
    } else if (event.key === "-") {
      event.preventDefault();
      zoomTo(stepZoom(scale, -1));
    } else if (event.key === "0") {
      event.preventDefault();
      zoomTo(null);
    }
  };

  if (failure !== null) {
    return (
      <div className="grid size-full place-items-center bg-background-200 p-6 text-center text-[12px] text-gray-800" data-testid="desk-pdf-error">
        {failure}
      </div>
    );
  }
  return (
    <div className="desk-viewer-column">
      <div ref={scrollerRef} tabIndex={0} className="desk-pdf-stage scroll-thin" data-testid="desk-pdf-viewer" aria-label={item.name} onScroll={onScroll} onWheel={onWheel} onKeyDown={onKeyDown}>
        <div className="desk-pdf-pages" style={{ gap: PAGE_GAP, padding: `${String(PAGE_GAP)}px ${String(SIDE)}px` }}>
          {pdf === null
            ? null
            : sizes.map((size, index) => <PdfPage key={index} pdf={pdf} number={index + 1} size={size} scale={scale} root={scrollerRef} />)}
        </div>
      </div>
      {pdf === null ? null : (
        <ZoomBar
          extra={
            <span className="desk-zoom-pages" data-testid="desk-pdf-page">
              {current} / {pdf.numPages}
            </span>
          }
          label={`${String(Math.round(scale * 100))}%`}
          labelTitle={zoom === null ? "Actual size" : "Fit to the width"}
          onLabel={() => zoomTo(zoom === null ? 1 : null)}
          actions={[
            { label: "Zoom out", icon: <Minus />, onClick: () => zoomTo(stepZoom(scale, -1)) },
            { label: "Zoom in", icon: <Plus />, onClick: () => zoomTo(stepZoom(scale, 1)) },
            { label: "Fit to the width", icon: <MoveHorizontal />, pressed: zoom === null, onClick: () => zoomTo(null) },
          ]}
        />
      )}
    </div>
  );
}

/** One page: its box from the start, drawn (and its text laid over it) once it comes near the window's view. */
const PdfPage = memo(function PdfPage({ pdf, number, size, scale, root }: { pdf: PDFDocumentProxy; number: number; size: PageSize; scale: number; root: React.RefObject<HTMLDivElement | null> }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [drawnAt, setDrawnAt] = useState<number | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (el === null) return;
    const observer = new IntersectionObserver((entries) => setNear(entries.some((entry) => entry.isIntersecting)), { root: root.current, rootMargin: "600px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    let page: PDFPageProxy | null = null;
    // A zoom redraws the page a moment after it settles; meanwhile its last drawing stretches.
    const timer = window.setTimeout(() => {
      void (async () => {
        const pdfjs = await loadPdfjs();
        page = await pdf.getPage(number);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const ratio = Math.min(3, window.devicePixelRatio || 1);
        const canvas = canvasRef.current;
        if (canvas === null) return;
        const drawn = document.createElement("canvas");
        drawn.width = Math.floor(viewport.width * ratio);
        drawn.height = Math.floor(viewport.height * ratio);
        task = page.render({ canvas: drawn, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
        await task.promise;
        if (cancelled) return;
        // Swapped in whole, so a redraw never shows a blank page.
        canvas.width = drawn.width;
        canvas.height = drawn.height;
        canvas.getContext("2d")?.drawImage(drawn, 0, 0);
        const text = textRef.current;
        if (text !== null) {
          text.replaceChildren();
          text.style.setProperty("--total-scale-factor", String(scale));
          await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport }).render();
        }
        if (!cancelled) setDrawnAt(scale);
      })().catch(() => undefined);
    }, drawnAt === null ? 0 : 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      task?.cancel();
    };
    // (drawnAt is read, not watched: a redraw is for a new scale or a page come into view.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, pdf, number, scale]);

  return (
    <div ref={boxRef} className="desk-pdf-page" data-testid="desk-pdf-page-box" data-drawn={drawnAt !== null ? "" : undefined} style={{ width: size.w * scale, height: size.h * scale }}>
      <canvas ref={canvasRef} className="desk-pdf-canvas" aria-hidden="true" />
      <div ref={textRef} className="textLayer" />
    </div>
  );
});
