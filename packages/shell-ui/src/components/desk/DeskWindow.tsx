import {
  memo,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Crop, Expand, Maximize2, Minimize2, Minus } from "lucide-react";
import { MIN_DESK_MASK, type DeskMask } from "@pistachio/shell-contracts/desk";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import { isHomeUrl } from "@pistachio/shell-contracts/home";
import { notesUrlId } from "@pistachio/shell-contracts/notes";
import { briefUrlDate } from "@pistachio/shell-contracts/reports";
import { nativeApi } from "../../api";
import { cn } from "../../lib/cn";
import { editedMaskRegion, type Edges, type Rect } from "../../lib/desk/geometry";
import type { DeskChrome, DeskGrab } from "../../lib/desk/store";
import { displayHost } from "../../lib/url";
import { Favicon } from "../Favicon";
import { PanePlaceholder } from "../PanePlaceholder";
import { HomePage } from "../home/HomePage";
import { BriefPage } from "../reports/BriefPage";
import { CHROME_CARD_TOP, CHROME_INSETS, MASK_CARD_TOP, MASK_INSETS, type DeskEngine, type DeskWindowView } from "./desk-engine";

const NotesPage = lazy(() => import("../notes/NotesPage").then((m) => ({ default: m.NotesPage })));

/** Whether a pointer event holds the desk's grab key. */
export function holdsGrab(event: { shiftKey: boolean; altKey: boolean; metaKey: boolean }, grab: DeskGrab): boolean {
  return grab === "shift" ? event.shiftKey : grab === "alt" ? event.altKey : grab === "meta" ? event.metaKey : false;
}

/**
 * One desk window: the frame the shell draws, and the hole in it where the
 * tab's page goes (desk-engine.ts). The engine positions the element
 * itself, a frame at a time; this component only ever re-renders when the
 * window's state changes — raised, drawn or live, carried, flying.
 *
 * Its page is the tab's live view when the engine says so; otherwise the
 * shell paints it here — the page's still, a placeholder while it wakes,
 * or the shell's own drawing for a shell page (home, the brief, a note).
 *
 * Masked (DeskMask), the window is a region of its page, shown alone and
 * scaled like a picture — still the live page, used as it always is: the
 * bare frame's handle above the region and nothing else, its controls
 * Unmask and Put away, and, in use, Edit mask. Choosing the region, its
 * page is frozen under a MaskSelector; editing it, the whole page is shown
 * around it under a MaskEditor.
 */
export const DeskWindow = memo(function DeskWindow({
  view,
  tab,
  chrome,
  grab,
  still,
  waking,
  engine,
}: {
  view: DeskWindowView;
  tab: BrowserTabInfo | null;
  chrome: DeskChrome;
  grab: DeskGrab;
  /** What to paint where the page goes when it is not live. */
  still: string | null;
  waking: boolean;
  engine: DeskEngine;
}) {
  const tabId = view.tabId;
  const attach = useCallback((el: HTMLDivElement | null) => engine.attachWindow(tabId, el), [engine, tabId]);
  const masked = view.mask !== null;
  // A masked window is framed by the bare frame's handle, whatever the frame variant.
  const frame: DeskChrome = masked ? "bare" : chrome;
  const insets = masked ? MASK_INSETS : CHROME_INSETS[chrome];
  const cardTop = masked ? MASK_CARD_TOP : CHROME_CARD_TOP[chrome];
  const title = tab?.title || displayHost(tab?.url ?? "") || "Untitled";
  const host = displayHost(tab?.url ?? "");
  const shellPage = tab !== null && pageKind(tab.url) !== null;
  /** Only a web page can be masked: the shell draws its own pages. */
  const canMask = tab !== null && !shellPage && !masked;

  /** A press on the frame: a grab, a move once it travels, a click, a double click — or on the title, a click edits the address. */
  const onFrameDown = (event: ReactPointerEvent) => {
    const target = event.target as HTMLElement;
    if (event.button !== 0 || target.closest("button") !== null) return;
    event.preventDefault();
    if (holdsGrab(event, grab)) engine.grab(tabId, { x: event.clientX, y: event.clientY }, event.shiftKey);
    else engine.press(tabId, event, target.closest(".desk-window-address") !== null ? "title" : "frame");
  };
  /** A press on the page area — which the shell only hears while the page is drawn. */
  const onPageDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    if (holdsGrab(event, grab)) {
      event.preventDefault();
      engine.grab(tabId, { x: event.clientX, y: event.clientY }, event.shiftKey);
      return;
    }
    // A shell page is a working page: it keeps its pointer, and only comes to the top.
    if (shellPage) {
      engine.bringForward(tabId);
      return;
    }
    event.preventDefault();
    engine.press(tabId, event, "content");
  };

  const controls = masked ? (
    <span className="desk-window-controls flex items-center">
      {view.focused && tab !== null && !shellPage ? (
        <FrameButton label="Edit mask" testId="desk-edit-mask" onClick={() => engine.editMask(tabId)}>
          <Crop aria-hidden="true" />
        </FrameButton>
      ) : null}
      <FrameButton label="Unmask" testId="desk-unmask" onClick={() => engine.unmask(tabId)}>
        <Expand aria-hidden="true" />
      </FrameButton>
      <FrameButton label="Put away" onClick={() => engine.putAway(tabId)}>
        <Minus aria-hidden="true" />
      </FrameButton>
    </span>
  ) : (
    <span className="desk-window-controls flex items-center">
      {canMask ? (
        <FrameButton
          label={view.selecting ? "Cancel mask" : "Mask: keep part of the page"}
          testId="desk-mask"
          pressed={view.selecting}
          onClick={() => (view.selecting ? engine.cancelMask() : engine.startMask(tabId))}
        >
          <Crop aria-hidden="true" />
        </FrameButton>
      ) : null}
      <FrameButton label={view.maximized ? "Restore" : "Fill the desk"} onClick={() => engine.toggleMaximize(tabId)}>
        {view.maximized ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
      </FrameButton>
      <FrameButton label="Put away" onClick={() => engine.putAway(tabId)}>
        <Minus aria-hidden="true" />
      </FrameButton>
    </span>
  );

  return (
    <div
      ref={attach}
      role="group"
      aria-label={title}
      data-testid="desk-window"
      data-tab-id={tabId}
      data-chrome={frame}
      data-masked={masked ? "" : undefined}
      data-selecting={view.selecting ? "" : undefined}
      data-editing={view.editing === null ? undefined : view.editing.shown ? "shown" : "waiting"}
      data-focused={view.focused ? "" : undefined}
      data-drawn={view.drawn ? "" : undefined}
      data-carried={view.carried ? "" : undefined}
      data-lifted={view.lifted ? "" : undefined}
      data-aiming={view.aiming ? "" : undefined}
      data-into-dock={view.intoDock ? "" : undefined}
      data-flight={view.flight ?? undefined}
      data-framed={view.framed ? undefined : "off"}
      className="desk-window"
      style={{ zIndex: view.carried || view.flight !== null ? 60 + view.z : 10 + view.z }}
    >
      {view.maskFade !== null && view.stillShows === "page" && still !== null ? (
        <MaskFade from={view.maskFade} insets={view.maskFade.framed ? CHROME_INSETS[chrome] : NO_INSETS} still={still} />
      ) : null}
      {view.editing !== null && view.mask !== null ? (
        <MaskEditor
          tabId={tabId}
          engine={engine}
          mask={view.mask}
          page={view.editing.page}
          bar={view.editing.bar}
          shown={view.editing.shown}
          still={still}
          stillShows={view.stillShows}
        />
      ) : null}
      {frame === "tab" ? (
        <div className="desk-window-chrome desk-window-tab" onPointerDown={onFrameDown}>
          <span className="desk-window-address flex-1" data-testid="desk-window-address" title={tab?.url}>
            <Favicon src={tab?.faviconUrl ?? null} seed={host || title} className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{title}</span>
          </span>
          {controls}
        </div>
      ) : frame === "bare" ? (
        <div className="desk-window-chrome desk-window-handle" onPointerDown={onFrameDown} title={title}>
          <span className="desk-window-pill" />
          {controls}
        </div>
      ) : null}
      <div className="desk-window-card" style={{ top: cardTop }}>
        {frame === "bar" ? (
          <div className="desk-window-chrome desk-window-bar" style={{ height: insets.top }} onPointerDown={onFrameDown}>
            {/* Clicked, the address palette opens on this tab; dragged, it is the bar. */}
            <span className="desk-window-address" data-testid="desk-window-address" title={tab?.url}>
              <Favicon src={tab?.faviconUrl ?? null} seed={host || title} className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate font-medium text-gray-1000">{title}</span>
              {host !== "" && host !== title ? <span className="desk-window-host min-w-0 shrink-[2] truncate">{host}</span> : null}
            </span>
            <span className="flex-1" />
            {controls}
          </div>
        ) : null}
        <div
          className="desk-window-page"
          data-testid="desk-window-page"
          onPointerDown={onPageDown}
          style={{ top: insets.top - cardTop, left: insets.left, right: insets.right, bottom: insets.bottom }}
        >
          {tab === null ? null : (
            <WindowPage
              tab={tab}
              still={still}
              stillShows={view.stillShows}
              mask={view.mask}
              unmasking={view.unmasking}
              waking={waking}
              focused={view.focused}
            />
          )}
          {/* Its page frozen (drawn), a region can be drawn over it. */}
          {view.selecting && view.drawn ? <MaskSelector tabId={tabId} engine={engine} /> : null}
        </div>
        <ResizeEdges tabId={tabId} engine={engine} top={frame === "bar"} />
      </div>
    </div>
  );
});

/** The shell's own pages, drawn by the shell in a window rather than by a live view. */
export function pageKind(url: string): "home" | "brief" | "notes" | null {
  if (isHomeUrl(url)) return "home";
  if (briefUrlDate(url.trim()) !== undefined) return "brief";
  if (notesUrlId(url.trim()) !== undefined) return "notes";
  return null;
}

function WindowPage({
  tab,
  still,
  stillShows,
  mask,
  unmasking,
  waking,
  focused,
}: {
  tab: BrowserTabInfo;
  still: string | null;
  stillShows: DeskWindowView["stillShows"];
  mask: DeskMask | null;
  unmasking: DeskMask | null;
  waking: boolean;
  focused: boolean;
}) {
  const kind = pageKind(tab.url);
  if (kind === "home") return <HomePage tabId={tab.id} active={focused} />;
  if (kind === "brief") return <BriefPage tabId={tab.id} date={briefUrlDate(tab.url.trim()) ?? null} active={focused} />;
  if (kind === "notes")
    return (
      <Suspense fallback={null}>
        <NotesPage tabId={tab.id} noteId={notesUrlId(tab.url.trim()) ?? null} active={focused} />
      </Suspense>
    );
  if (still !== null && unmasking !== null) {
    // Growing back from a mask: the whole page where it stands now (the
    // engine moves the box each frame), or the region, where it is in it.
    if (stillShows === "page") return <img className="desk-still-crop" src={still} alt="" draggable={false} style={REVEAL_STYLE} />;
    if (stillShows === "region") return <img className="desk-still-crop" src={still} alt="" draggable={false} style={revealRegionStyle(unmasking)} />;
    return null;
  }
  if (still !== null && mask !== null) {
    // A picture of the region, stretched to the window as it is resized; or,
    // taken before the mask, the whole page, cropped to the region.
    if (stillShows === "region") return <img className="desk-still" data-fill="" src={still} alt="" draggable={false} />;
    if (stillShows === "page") return <img className="desk-still-crop" src={still} alt="" draggable={false} style={cropStyle(mask)} />;
    return null;
  }
  if (still !== null && stillShows !== "none") return <img className="desk-still" src={still} alt="" draggable={false} />;
  if (still !== null) return null;
  return (
    <div className="grid size-full place-items-center">
      <PanePlaceholder tab={tab}>
        <span className="max-w-60 truncate text-[12px] font-medium text-gray-1000">{tab.title || displayHost(tab.url)}</span>
        {waking || tab.lifecycle === "suspended" ? <span className="text-[11px] text-gray-700">{waking ? "Waking…" : "Asleep — click to wake"}</span> : null}
      </PanePlaceholder>
    </div>
  );
}

/** The whole page, where a window growing back from its mask shows it (its `--reveal-*` properties, the engine's #revealBox). */
const REVEAL_STYLE: CSSProperties = { left: "var(--reveal-x)", top: "var(--reveal-y)", width: "var(--reveal-w)", height: "var(--reveal-h)" };

/** The region a window is growing back from, where it lies in the page the engine reveals around it. */
function revealRegionStyle(mask: DeskMask): CSSProperties {
  return {
    left: `calc(var(--reveal-x) + var(--reveal-w) * ${mask.x / mask.pageWidth})`,
    top: `calc(var(--reveal-y) + var(--reveal-h) * ${mask.y / mask.pageHeight})`,
    width: `calc(var(--reveal-w) * ${mask.width / mask.pageWidth})`,
    height: `calc(var(--reveal-h) * ${mask.height / mask.pageHeight})`,
  };
}

/** A still of the whole page box, placed so only the mask's region falls in the window's page: as fractions, whatever the window's size. */
export function cropStyle(mask: DeskMask): CSSProperties {
  return {
    left: `${(-mask.x / mask.width) * 100}%`,
    top: `${(-mask.y / mask.height) * 100}%`,
    width: `${(mask.pageWidth / mask.width) * 100}%`,
    height: `${(mask.pageHeight / mask.height) * 100}%`,
  };
}

/**
 * Choosing a mask: over the window's frozen page, a drag draws the region
 * to keep, as a screenshot's selection is drawn, and the rest dims. Let go,
 * and the window becomes that region (engine.applyMask); a drag too small,
 * Escape (in the shell, or relayed from a page), or the Mask button again,
 * and nothing changes.
 */
function MaskSelector({ tabId, engine }: { tabId: string; engine: DeskEngine }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") engine.cancelMask();
    };
    window.addEventListener("keydown", onKey);
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      if (input === "escape") engine.cancelMask();
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      offPage?.();
    };
  }, [engine]);
  const at = (event: ReactPointerEvent): { x: number; y: number } => {
    const box = ref.current!.getBoundingClientRect();
    return { x: Math.min(box.width, Math.max(0, event.clientX - box.left)), y: Math.min(box.height, Math.max(0, event.clientY - box.top)) };
  };
  const region = drag === null ? null : regionOf(drag);
  return (
    <div
      ref={ref}
      className="desk-mask-selector"
      data-testid="desk-mask-selector"
      data-dragging={drag !== null ? "" : undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = at(event);
        setDrag({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
      }}
      onPointerMove={(event) => {
        if (drag === null) return;
        const point = at(event);
        setDrag({ ...drag, x1: point.x, y1: point.y });
      }}
      onPointerUp={(event) => {
        if (drag === null) return;
        const point = at(event);
        const chosen = regionOf({ ...drag, x1: point.x, y1: point.y });
        setDrag(null);
        if (chosen.w >= MIN_DESK_MASK && chosen.h >= MIN_DESK_MASK) engine.applyMask(tabId, chosen);
        else engine.cancelMask();
      }}
      onPointerCancel={() => setDrag(null)}
    >
      {region === null ? (
        <span className="desk-mask-hint">Drag over the part to keep · esc to cancel</span>
      ) : (
        <div className="desk-mask-region" style={{ left: region.x, top: region.y, width: region.w, height: region.h }}>
          <span className="desk-mask-size">
            {Math.round(region.w)} × {Math.round(region.h)}
          </span>
        </div>
      )}
    </div>
  );
}

/** The mask editor's handles: a knob at each corner, and each edge's length, on the region's border. */
const MASK_HANDLES: ReadonlyArray<{ id: string; edges: Edges; style: CSSProperties; cursor: string }> = [
  { id: "n", edges: { left: false, right: false, top: true, bottom: false }, style: { top: -5, left: 10, right: 10, height: 10 }, cursor: "ns-resize" },
  { id: "s", edges: { left: false, right: false, top: false, bottom: true }, style: { bottom: -5, left: 10, right: 10, height: 10 }, cursor: "ns-resize" },
  { id: "w", edges: { left: true, right: false, top: false, bottom: false }, style: { left: -5, top: 10, bottom: 10, width: 10 }, cursor: "ew-resize" },
  { id: "e", edges: { left: false, right: true, top: false, bottom: false }, style: { right: -5, top: 10, bottom: 10, width: 10 }, cursor: "ew-resize" },
  { id: "nw", edges: { left: true, right: false, top: true, bottom: false }, style: { left: -8, top: -8, width: 16, height: 16 }, cursor: "nwse-resize" },
  { id: "ne", edges: { left: false, right: true, top: true, bottom: false }, style: { right: -8, top: -8, width: 16, height: 16 }, cursor: "nesw-resize" },
  { id: "sw", edges: { left: true, right: false, top: false, bottom: true }, style: { left: -8, bottom: -8, width: 16, height: 16 }, cursor: "nesw-resize" },
  { id: "se", edges: { left: false, right: true, top: false, bottom: true }, style: { right: -8, bottom: -8, width: 16, height: 16 }, cursor: "nwse-resize" },
];

/**
 * Editing a mask: the window's whole page, where it lies around the region
 * and at the region's scale, the rest of it faded so the desk shows
 * through, and the region at full strength inside a frame whose edges and
 * corners can be dragged (and whose inside moves it). The page is its
 * still — the whole page, taken as the edit began (until it comes, only
 * the region's own still, where the region was). Done — Enter, or a press
 * anywhere else — and the window becomes the new region (commitMaskEdit);
 * Cancel or Escape, and it stays as it was.
 */
function MaskEditor({
  tabId,
  engine,
  mask,
  page,
  bar,
  shown,
  still,
  stillShows,
}: {
  tabId: string;
  engine: DeskEngine;
  mask: DeskMask;
  page: Rect;
  bar: Rect;
  shown: boolean;
  still: string | null;
  stillShows: DeskWindowView["stillShows"];
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [region, setRegion] = useState<Rect>(() => ({ x: mask.x, y: mask.y, w: mask.width, h: mask.height }));
  const regionRef = useRef(region);
  regionRef.current = region;
  const drag = useRef<{ edges: Edges | null; x: number; y: number; from: Rect } | null>(null);
  const [dragging, setDragging] = useState(false);
  const scale = page.w / mask.pageWidth;
  const whole = still !== null && stillShows === "page";

  useEffect(() => {
    const done = (): void => engine.commitMaskEdit(tabId, regionRef.current);
    // Capture: before anything else in the shell hears the key (Escape closes other things too).
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" && event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") engine.cancelMaskEdit();
      else done();
    };
    // A press anywhere else is done with it — before that press raises another window.
    const onDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) !== true) done();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    // A key or press on a live page, which the shell never hears itself (main relays it).
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      if (input === "escape") engine.cancelMaskEdit();
      else if (input === "press") done();
    });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
      offPage?.();
    };
  }, [engine, tabId]);

  const begin = (edges: Edges | null) => (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { edges, x: event.clientX, y: event.clientY, from: regionRef.current };
    setDragging(true);
  };
  const onMove = (event: ReactPointerEvent): void => {
    const held = drag.current;
    if (held === null) return;
    const dx = (event.clientX - held.x) / scale;
    const dy = (event.clientY - held.y) / scale;
    setRegion(editedMaskRegion(held.from, held.edges, dx, dy, { w: mask.pageWidth, h: mask.pageHeight }, MIN_DESK_MASK));
  };
  const end = (): void => {
    drag.current = null;
    setDragging(false);
  };

  // The region's picture: the whole page placed under it, or, until that comes, the old region's where it was.
  const shot: CSSProperties = whole
    ? { left: -region.x * scale, top: -region.y * scale, width: page.w, height: page.h }
    : { left: (mask.x - region.x) * scale, top: (mask.y - region.y) * scale, width: mask.width * scale, height: mask.height * scale };
  return (
    <div
      ref={rootRef}
      className="desk-mask-editor"
      data-testid="desk-mask-editor"
      data-shown={shown ? "" : undefined}
      data-whole={whole ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <div className="desk-mask-editor-page" style={{ left: page.x, top: page.y, width: page.w, height: page.h }}>
        {whole ? <img className="desk-mask-editor-rest" src={still} alt="" draggable={false} /> : null}
        <div
          className="desk-mask-editor-region"
          data-testid="desk-mask-editor-region"
          style={{ left: region.x * scale, top: region.y * scale, width: region.w * scale, height: region.h * scale }}
          onPointerDown={begin(null)}
        >
          <div className="desk-mask-editor-shot">{still !== null ? <img src={still} alt="" draggable={false} style={shot} /> : null}</div>
          {MASK_HANDLES.map((handle) => (
            <span
              key={handle.id}
              aria-hidden="true"
              className="desk-mask-handle"
              data-handle={handle.id}
              data-corner={handle.id.length === 2 ? "" : undefined}
              style={{ ...handle.style, cursor: handle.cursor }}
              onPointerDown={begin(handle.edges)}
            />
          ))}
          <span className="desk-mask-size">
            {Math.round(region.w)} × {Math.round(region.h)}
          </span>
        </div>
      </div>
      <div className="desk-mask-editor-bar" style={{ left: bar.x, top: bar.y, width: bar.w, height: bar.h }}>
        <span className="min-w-0 flex-1 truncate text-gray-800">Drag the edges</span>
        <button type="button" className="desk-mask-editor-button" data-testid="desk-mask-edit-cancel" onClick={() => engine.cancelMaskEdit()}>
          Cancel
        </button>
        <button
          type="button"
          className="desk-mask-editor-button"
          data-primary=""
          data-testid="desk-mask-edit-done"
          onClick={() => engine.commitMaskEdit(tabId, regionRef.current)}
        >
          Done
        </button>
      </div>
    </div>
  );
}

function regionOf(drag: { x0: number; y0: number; x1: number; y1: number }): Rect {
  return { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) };
}

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Just masked: the page the region was cut from, where the window stood,
 * dimmed as it was while the region was chosen — fading out from around the
 * region, which the window's own page now covers. Its mask just edited: the
 * page shown around the region, as the editor showed it (`insets` none: the
 * page box alone, no frame).
 */
function MaskFade({ from, insets, still }: { from: Rect & { framed: boolean }; insets: typeof NO_INSETS; still: string }) {
  return (
    <div
      className="desk-mask-fade"
      data-edited={from.framed ? undefined : ""}
      aria-hidden="true"
      style={{ left: from.x, top: from.y, width: from.w, height: from.h }}
    >
      <img
        src={still}
        alt=""
        draggable={false}
        style={{ left: insets.left, top: insets.top, width: from.w - insets.left - insets.right, height: from.h - insets.top - insets.bottom }}
      />
    </div>
  );
}

function FrameButton({
  label,
  testId,
  pressed,
  onClick,
  children,
}: {
  label: string;
  testId?: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      data-testid={testId}
      onPointerDown={(event) => event.stopPropagation()}
      // A press leaves the keyboard where it was (the window's page): a
      // focused frame button would light its ring at the next key — Shift,
      // say, held to snap the window it just filled.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="grid size-6 cursor-pointer place-items-center rounded-md text-gray-800 outline-none transition-[background-color,color,transform] duration-150 hover:bg-alpha-200 hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.94] aria-pressed:bg-alpha-300 aria-pressed:text-gray-1000 motion-reduce:transition-none [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}

const EDGES: ReadonlyArray<{ id: string; edges: Edges; style: CSSProperties; cursor: string }> = [
  { id: "n", edges: { left: false, right: false, top: true, bottom: false }, style: { top: -5, left: 14, right: 14, height: 9 }, cursor: "ns-resize" },
  { id: "s", edges: { left: false, right: false, top: false, bottom: true }, style: { bottom: -5, left: 14, right: 14, height: 9 }, cursor: "ns-resize" },
  { id: "w", edges: { left: true, right: false, top: false, bottom: false }, style: { left: -5, top: 14, bottom: 14, width: 9 }, cursor: "ew-resize" },
  { id: "e", edges: { left: false, right: true, top: false, bottom: false }, style: { right: -5, top: 14, bottom: 14, width: 9 }, cursor: "ew-resize" },
  { id: "nw", edges: { left: true, right: false, top: true, bottom: false }, style: { left: -6, top: -6, width: 18, height: 18 }, cursor: "nwse-resize" },
  { id: "ne", edges: { left: false, right: true, top: true, bottom: false }, style: { right: -6, top: -6, width: 18, height: 18 }, cursor: "nesw-resize" },
  { id: "sw", edges: { left: true, right: false, top: false, bottom: true }, style: { left: -6, bottom: -6, width: 18, height: 18 }, cursor: "nesw-resize" },
  { id: "se", edges: { left: false, right: true, top: false, bottom: true }, style: { right: -6, bottom: -6, width: 18, height: 18 }, cursor: "nwse-resize" },
];

/**
 * The edges and corners that resize the window. They straddle the card's
 * border, mostly outside it: inside, the live page covers everything but
 * the frame's thin bezel, and no shell element can take a pointer there.
 */
function ResizeEdges({ tabId, engine, top }: { tabId: string; engine: DeskEngine; top: boolean }) {
  return (
    <>
      {EDGES.filter((edge) => top || edge.id !== "n").map((edge) => (
        <div
          key={edge.id}
          aria-hidden="true"
          data-desk-edge={edge.id}
          className={cn("desk-window-edge absolute")}
          style={{ ...edge.style, cursor: edge.cursor }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            engine.resize(tabId, edge.edges, event);
          }}
        />
      ))}
    </>
  );
}
