import { memo, Suspense, lazy, useCallback, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Maximize2, Minimize2, Minus } from "lucide-react";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import { isHomeUrl } from "@pistachio/shell-contracts/home";
import { notesUrlId } from "@pistachio/shell-contracts/notes";
import { briefUrlDate } from "@pistachio/shell-contracts/reports";
import { cn } from "../../lib/cn";
import type { Edges } from "../../lib/desk/geometry";
import type { DeskChrome, DeskGrab } from "../../lib/desk/store";
import { displayHost } from "../../lib/url";
import { Favicon } from "../Favicon";
import { PanePlaceholder } from "../PanePlaceholder";
import { HomePage } from "../home/HomePage";
import { BriefPage } from "../reports/BriefPage";
import { CHROME_CARD_TOP, CHROME_INSETS, type DeskEngine, type DeskWindowView } from "./desk-engine";

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
  const insets = CHROME_INSETS[chrome];
  const cardTop = CHROME_CARD_TOP[chrome];
  const title = tab?.title || displayHost(tab?.url ?? "") || "Untitled";
  const host = displayHost(tab?.url ?? "");
  const shellPage = tab !== null && pageKind(tab.url) !== null;

  /** A press on the frame: a grab, a move once it travels, a click, a double click. */
  const onFrameDown = (event: ReactPointerEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button") !== null) return;
    event.preventDefault();
    if (holdsGrab(event, grab)) engine.grab(tabId, { x: event.clientX, y: event.clientY });
    else engine.press(tabId, event, "frame");
  };
  /** A press on the page area — which the shell only hears while the page is drawn. */
  const onPageDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    if (holdsGrab(event, grab)) {
      event.preventDefault();
      engine.grab(tabId, { x: event.clientX, y: event.clientY });
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

  const controls = (
    <span className="desk-window-controls flex items-center">
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
      data-chrome={chrome}
      data-focused={view.focused ? "" : undefined}
      data-drawn={view.drawn ? "" : undefined}
      data-carried={view.carried ? "" : undefined}
      data-lifted={view.lifted ? "" : undefined}
      data-flight={view.flight ?? undefined}
      data-framed={view.framed ? undefined : "off"}
      className="desk-window"
      style={{ zIndex: view.carried || view.flight !== null ? 60 + view.z : 10 + view.z }}
    >
      {chrome === "tab" ? (
        <div className="desk-window-chrome desk-window-tab" onPointerDown={onFrameDown}>
          <Favicon src={tab?.faviconUrl ?? null} seed={host || title} className="size-3.5" />
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {controls}
        </div>
      ) : chrome === "bare" ? (
        <div className="desk-window-chrome desk-window-handle" onPointerDown={onFrameDown} title={title}>
          <span className="desk-window-pill" />
          {controls}
        </div>
      ) : null}
      <div className="desk-window-card" style={{ top: cardTop }}>
        {chrome === "bar" ? (
          <div className="desk-window-chrome desk-window-bar" style={{ height: insets.top }} onPointerDown={onFrameDown}>
            <Favicon src={tab?.faviconUrl ?? null} seed={host || title} className="size-3.5" />
            <span className="min-w-0 truncate font-medium text-gray-1000">{title}</span>
            {host !== "" && host !== title ? <span className="desk-window-host min-w-0 shrink-[2] truncate">{host}</span> : null}
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
          {tab === null ? null : <WindowPage tab={tab} still={still} waking={waking} focused={view.focused} />}
        </div>
        <ResizeEdges tabId={tabId} engine={engine} top={chrome === "bar"} />
      </div>
    </div>
  );
});

function pageKind(url: string): "home" | "brief" | "notes" | null {
  if (isHomeUrl(url)) return "home";
  if (briefUrlDate(url.trim()) !== undefined) return "brief";
  if (notesUrlId(url.trim()) !== undefined) return "notes";
  return null;
}

function WindowPage({ tab, still, waking, focused }: { tab: BrowserTabInfo; still: string | null; waking: boolean; focused: boolean }) {
  const kind = pageKind(tab.url);
  if (kind === "home") return <HomePage tabId={tab.id} active={focused} />;
  if (kind === "brief") return <BriefPage tabId={tab.id} date={briefUrlDate(tab.url.trim()) ?? null} active={focused} />;
  if (kind === "notes")
    return (
      <Suspense fallback={null}>
        <NotesPage tabId={tab.id} noteId={notesUrlId(tab.url.trim()) ?? null} active={focused} />
      </Suspense>
    );
  if (still !== null) return <img className="desk-still" src={still} alt="" draggable={false} />;
  return (
    <div className="grid size-full place-items-center">
      <PanePlaceholder tab={tab}>
        <span className="max-w-60 truncate text-[12px] font-medium text-gray-1000">{tab.title || displayHost(tab.url)}</span>
        {waking || tab.lifecycle === "suspended" ? <span className="text-[11px] text-gray-700">{waking ? "Waking…" : "Asleep — click to wake"}</span> : null}
      </PanePlaceholder>
    </div>
  );
}

function FrameButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="grid size-6 cursor-pointer place-items-center rounded-md text-gray-800 outline-none transition-[background-color,color,transform] duration-150 hover:bg-alpha-200 hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.94] motion-reduce:transition-none [&_svg]:size-3.5"
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
