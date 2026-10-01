import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Minus, Plus, Scan } from "lucide-react";
import type { ViewerProps } from "./FileWindow";
import { useObjectUrls } from "./object-urls";
import { ZoomBar } from "./ZoomBar";

const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

/** The next zoom step up or down from `zoom`. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOMS.find((step) => step > zoom + 0.001) ?? ZOOMS[ZOOMS.length - 1]!;
  return [...ZOOMS].reverse().find((step) => step < zoom - 0.001) ?? ZOOMS[0]!;
}

/**
 * A picture: fitted to its window, or zoomed (the bar's − and +, ⌘+ and
 * ⌘−, pinching or ⌘ and the wheel, about the pointer) and moved by
 * dragging. Transparent pixels show a chequerboard. A picture the shell
 * cannot draw (HEIC, TIFF) is shown as the PNG macOS made of it.
 */
export default function ImageViewer({ item, content, focusSignal, onDetail }: ViewerProps) {
  const shown = content.shown ?? { mediaType: item.mediaType, bytes: content.bytes };
  const blobs = useMemo(() => ({ picture: new Blob([shown.bytes as BlobPart], { type: shown.mediaType }) }), [shown.bytes, shown.mediaType]);
  const src = useObjectUrls(blobs)["picture"]!;
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  /** null: fitted to the window. */
  const [zoom, setZoom] = useState<number | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const pendingScroll = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    const measure = (): void => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (focusSignal > 0) scrollerRef.current?.focus({ preventScroll: true });
  }, [focusSignal]);
  useEffect(() => {
    onDetail(natural === null ? null : `${String(natural.w)} × ${String(natural.h)}`);
  }, [natural, onDetail]);

  const fit = natural === null || box.w === 0 ? 1 : Math.min(1, (box.w - 32) / natural.w, (box.h - 32) / natural.h);
  const scale = zoom ?? fit;

  // After a zoom about a point, the point stays under the pointer.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const at = pendingScroll.current;
    if (el === null || at === null) return;
    pendingScroll.current = null;
    el.scrollLeft = at.x;
    el.scrollTop = at.y;
  }, [scale]);

  const zoomAbout = (next: number, client: { x: number; y: number } | null): void => {
    const el = scrollerRef.current;
    if (el === null || natural === null) return setZoom(next);
    const rect = el.getBoundingClientRect();
    const px = client === null ? el.clientWidth / 2 : client.x - rect.left;
    const py = client === null ? el.clientHeight / 2 : client.y - rect.top;
    // The picture's point under the pointer, in its own pixels.
    const offsetX = Math.max(0, (el.clientWidth - natural.w * scale) / 2);
    const offsetY = Math.max(0, (el.clientHeight - natural.h * scale) / 2);
    const imageX = (el.scrollLeft + px - offsetX) / scale;
    const imageY = (el.scrollTop + py - offsetY) / scale;
    const nextOffsetX = Math.max(0, (el.clientWidth - natural.w * next) / 2);
    const nextOffsetY = Math.max(0, (el.clientHeight - natural.h * next) / 2);
    pendingScroll.current = { x: imageX * next + nextOffsetX - px, y: imageY * next + nextOffsetY - py };
    setZoom(next);
  };

  const onWheel = (event: ReactWheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomAbout(Math.min(8, Math.max(0.05, scale * Math.exp(-event.deltaY / 240))), { x: event.clientX, y: event.clientY });
  };
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key === "=" || event.key === "+") {
      event.preventDefault();
      zoomAbout(stepZoom(scale, 1), null);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomAbout(stepZoom(scale, -1), null);
    } else if (event.key === "0") {
      event.preventDefault();
      setZoom(null);
    }
  };
  const onPointerDown = (event: ReactPointerEvent): void => {
    const el = scrollerRef.current;
    if (event.button !== 0 || el === null || (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
  };
  const onPointerMove = (event: ReactPointerEvent): void => {
    const el = scrollerRef.current;
    const held = drag.current;
    if (el === null || held === null) return;
    el.scrollLeft = held.left - (event.clientX - held.x);
    el.scrollTop = held.top - (event.clientY - held.y);
  };

  return (
    <div className="desk-viewer-column">
      <div
        ref={scrollerRef}
        tabIndex={0}
        className="desk-image-stage scroll-thin"
        data-testid="desk-image-viewer"
        data-draggable={natural !== null && natural.w * scale > box.w ? "" : undefined}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        {failed ? (
          <span className="m-auto text-[12px] text-gray-800">This picture could not be shown.</span>
        ) : (
          <img
            src={src}
            alt={item.name}
            draggable={false}
            className="desk-image"
            style={natural === null ? { opacity: 0 } : { width: natural.w * scale, height: natural.h * scale }}
            onLoad={(event) => setNatural({ w: event.currentTarget.naturalWidth || 1, h: event.currentTarget.naturalHeight || 1 })}
            onError={() => setFailed(true)}
          />
        )}
      </div>
      <ZoomBar
        label={`${String(Math.round(scale * 100))}%`}
        actions={[
          { label: "Zoom out", icon: <Minus />, onClick: () => zoomAbout(stepZoom(scale, -1), null) },
          { label: "Zoom in", icon: <Plus />, onClick: () => zoomAbout(stepZoom(scale, 1), null) },
          { label: "Fit to the window", icon: <Scan />, pressed: zoom === null, onClick: () => setZoom(null) },
        ]}
        onLabel={() => setZoom(zoom === 1 ? null : 1)}
        labelTitle={zoom === 1 ? "Fit to the window" : "Actual size"}
      />
    </div>
  );
}
