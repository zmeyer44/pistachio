import {
  memo,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { AudioLines, Crop, Ellipsis, Expand, Maximize2, Minimize2, Minus, PictureInPicture2, X } from "lucide-react";
import { agentRingDelayMs } from "@pistachio/shell-contracts/agent-glow";
import { DESK_MINI_ZOOM, MIN_DESK_MASK, type DeskMask } from "@pistachio/shell-contracts/desk";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import { isHomeUrl } from "@pistachio/shell-contracts/home";
import { notesUrlId } from "@pistachio/shell-contracts/notes";
import { briefUrlDate } from "@pistachio/shell-contracts/reports";
import type { ShellPage } from "@pistachio/shell-contracts/shell-pages";
import { nativeApi } from "../../api";
import { useAppStore } from "../../store";
import { cn } from "../../lib/cn";
import { editedMaskRegion, type Edges, type Rect } from "../../lib/desk/geometry";

import { useNowPlaying } from "../../lib/desk/now-playing";
import type { DeskChrome, DeskGrab } from "../../lib/desk/store";
import { displayHost } from "../../lib/url";
import { CONTEXT_MENU_W, useContextMenu, type MenuEntry } from "../ContextMenu";
import { Favicon } from "../Favicon";
import { PanePlaceholder } from "../PanePlaceholder";
import { SiteInfoFrom } from "../SiteInfoPopover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { HomePage } from "../home/HomePage";
import { BriefPage } from "../reports/BriefPage";
import { CHROME_CARD_TOP, CHROME_INSETS, MASK_CARD_TOP, MASK_INSETS, windowTipCover, type DeskEngine, type DeskWindowView } from "./desk-engine";
import { DeskLivePicture } from "./DeskLivePicture";
import { usePageEntries } from "./page-entries";
import { shellWindowParts, type ShellWindowSubject } from "./window-kinds";

const NotesPage = lazy(() => import("../notes/NotesPage").then((m) => ({ default: m.NotesPage })));

/** A frame button's tooltip opens after this long, as the Bar's do. */
const TIP_DELAY_MS = 350;
/** The band under the frame's buttons stays a cover this long after a tooltip closes: moving from one button to the next, the next's does not wait. */
const TIP_LINGER_MS = 200;
/** The band under the frame's buttons where their tooltips appear, and how far past the row's ends they may reach. */
const TIP_BAND_H = 40;
const TIP_BAND_REACH = 100;

/** A tooltip under one of the frame's buttons (as the Bar's BarTip): open as Base UI says, seen once no live page is under it. */
interface FrameTip {
  open: boolean;
  shown: boolean;
  /** Not while the frame's menu or the site's card hangs from it, nor while the window is in hand or on its way. */
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
}

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
 * Its controls are fill, collapse (−, into its icon in the dock) and close
 * (×), each named in a tooltip under it; what is wanted less often — the page's back, forward and reload,
 * reader view, bookmark, pin and site information (the pane toolbar's, off
 * the desk: page-entries.tsx), masking, minimizing, a document's own
 * actions — is on the frame's menu (⋯, or a right-click on the frame).
 *
 * Masked (DeskMask), the window is a region of its page, shown alone and
 * scaled like a picture — still the live page, used as it always is: the
 * bare frame's handle above the region and nothing else, its controls
 * Unmask, Collapse and Close, and Edit mask on its menu. Choosing the region, its
 * page is frozen under a MaskSelector; editing it, the whole page is shown
 * around it under a MaskEditor.
 *
 * Minimized, the window is small and its page zoomed out (DESK_MINI_ZOOM):
 * a web page by main, a page the shell draws by a CSS scale here. Its
 * controls are Expand, Collapse and Close. Parked at the desk's foot, the pointer
 * on it raises it into view: its frame says so here, its live page by main.
 */
export const DeskWindow = memo(function DeskWindow({
  view,
  tab,
  chrome,
  grab,
  still,
  waking,
  engine,
  agent = null,
  note = null,
  onDismissNote,
  shell = null,
}: {
  view: DeskWindowView;
  tab: BrowserTabInfo | null;
  /** A window the shell draws itself (a document's, `file:<item id>`): what it shows (window-kinds.tsx). */
  shell?: ShellWindowSubject | null;
  chrome: DeskChrome;
  grab: DeskGrab;
  /** What to paint where the page goes when it is not live. */
  still: string | null;
  waking: boolean;
  engine: DeskEngine;
  /** The agent is working in this window: what it is doing, in a word (docs/desk-agent.md §1). */
  agent?: string | null;
  /** A short note the agent pinned to the window's frame. */
  note?: string | null;
  onDismissNote?: (tabId: string) => void;
}) {
  const tabId = view.tabId;
  const attach = useCallback((el: HTMLDivElement | null) => engine.attachWindow(tabId, el), [engine, tabId]);
  const masked = view.mask !== null;
  // A masked window is framed by the bare frame's handle, whatever the frame variant.
  const frame: DeskChrome = masked ? "bare" : chrome;
  const insets = masked ? MASK_INSETS : CHROME_INSETS[chrome];
  const cardTop = masked ? MASK_CARD_TOP : CHROME_CARD_TOP[chrome];
  const parts = shell === null ? null : shellWindowParts(shell, tabId, view.focused);
  const title = parts !== null ? parts.name : tab?.title || displayHost(tab?.url ?? "") || "Untitled";
  const host = parts !== null ? "" : displayHost(tab?.url ?? "");
  // A shell window's page is the shell's own working page, as home and a note are.
  const shellPage = parts !== null || (tab !== null && pageKind(tab.url) !== null);
  /** Only a web page can be masked: the shell draws its own pages. */
  const canMask = tab !== null && !shellPage && !masked && view.mini === null;
  /** What its page is playing, if anything a player could take (not a call, nor a page presenting itself whole). */
  const media = useAppStore((state) => (tab === null || shellPage ? null : (state.media.find((item) => item.tabId === tabId && !item.call && !item.presenting) ?? null)));
  const mini = view.mini !== null;
  // Drawn (something lies over it), a window whose page plays a video shows that page live over its still, rather
  // than stopped on it (DeskLivePicture): not while its still stands for a region, a peek or a flight.
  const livePicture =
    view.drawn && media !== null && media.hasVideo && media.playing && !masked && view.unmasking === null && !mini && view.flight === null && !view.closing && !view.selecting && !waking;
  const working = agent !== null;
  // Phased on the wall clock like every other ring, taken as this one goes on.
  const ringDelay = useMemo(() => (working ? `${String(agentRingDelayMs(Date.now()))}ms` : undefined), [working]);
  // The agent's word and its note ride the frame: in the bar's title row, or above a tab or handle.
  const marks =
    agent === null && note === null ? null : (
      <span className="desk-window-marks" data-testid="desk-window-marks">
        {agent === null ? null : (
          <span className="desk-window-agent" data-testid="desk-window-agent">
            <span className="agent-thinking-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {agent}
          </span>
        )}
        {note === null ? null : (
          <span className="desk-window-note" data-testid="desk-window-note" title={note}>
            <span className="truncate">{note}</span>
            {onDismissNote === undefined ? null : (
              <button type="button" aria-label="Dismiss note" className="desk-window-note-close" onMouseDown={(event) => event.preventDefault()} onClick={() => onDismissNote(tabId)}>
                <X aria-hidden="true" />
              </button>
            )}
          </span>
        )}
      </span>
    );

  /** A press on the frame: a grab, a move once it travels, a click, a double click — or on the title, a click edits the address. */
  const onFrameDown = (event: ReactPointerEvent) => {
    const target = event.target as HTMLElement;
    if (event.button !== 0 || target.closest("button") !== null) return;
    event.preventDefault();
    if (holdsGrab(event, grab)) engine.grab(tabId, { x: event.clientX, y: event.clientY }, event.shiftKey);
    // (A shell window's title is the frame's: it has no address to edit.)
    else engine.press(tabId, event, parts === null && target.closest(".desk-window-address") !== null ? "title" : "frame");
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

  const menu = useContextMenu();
  /** Whether the frame's menu was up as the ⋯ was pressed: the press put it away, and the click is not to bring it back. */
  const menuWasUp = useRef(false);
  const pageEntries = usePageEntries();
  /** The ⋯: the site's information, chosen from the menu, hangs from it. */
  const moreRef = useRef<HTMLButtonElement>(null);
  const siteInfoHere = useAppStore((state) => state.overlay === "site-info" && state.snapshot?.activeTabId === tabId);

  // A button's tooltip is open: the band under the frame's buttons, where it
  // appears over the window's own page, is a cover, and stays one a moment
  // after it closes (the Bar's rule).
  const controlsRef = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState<string | null>(null);
  const tipsOff = menu.isOpen || siteInfoHere || view.carried || view.flight !== null || view.closing || view.selecting || view.editing !== null;
  const openTip = tipsOff ? null : tip;
  useLayoutEffect(() => {
    const key = windowTipCover(tabId);
    const row = controlsRef.current;
    const stage = row?.closest(".desk-stage");
    if (openTip === null || row == null || stage == null) {
      const timer = window.setTimeout(() => engine.setCover(key, null), TIP_LINGER_MS);
      return () => window.clearTimeout(timer);
    }
    // (In the stage's coordinates, through the window's transform.)
    const box = row.getBoundingClientRect();
    const origin = stage.getBoundingClientRect();
    engine.setCover(key, { x: box.left - origin.left - TIP_BAND_REACH, y: box.bottom - origin.top, w: box.width + TIP_BAND_REACH * 2, h: TIP_BAND_H });
  }, [engine, tabId, openTip]);
  useEffect(() => () => engine.setCover(windowTipCover(tabId), null), [engine, tabId]);
  /** A frame button's tooltip, by its label. */
  const frameTip = (label: string): FrameTip => ({
    open: openTip === label,
    shown: view.tipShown,
    disabled: tipsOff,
    onOpenChange: (open) => setTip((current) => (open ? label : current === label ? null : current)),
  });
  // Where the window goes when collapsed: its icon in the dock, or a document's home, the Stack.
  const collapseLabel = parts !== null ? "Collapse into the Stack" : "Collapse into the sidebar";
  /** What the frame's menu offers: what is wanted less often than the buttons; on a right-click, the buttons' too. */
  const menuEntries = (all: boolean): MenuEntry[] => {
    const rare: MenuEntry[] = [];
    if (masked) {
      if (tab !== null && !shellPage) rare.push({ label: "Edit mask", icon: <Crop aria-hidden="true" />, testId: "desk-edit-mask", onSelect: () => engine.editMask(tabId) });
    } else if (!mini) {
      if (tab !== null && !shellPage) rare.push(...pageEntries(tab));
      for (const action of parts?.actions ?? []) rare.push({ label: action.label, icon: action.icon, testId: action.testId, onSelect: action.run });
      if (canMask)
        rare.push({
          label: view.selecting ? "Cancel mask" : "Mask: keep part of the page",
          icon: <Crop aria-hidden="true" />,
          testId: "desk-mask",
          onSelect: () => (view.selecting ? engine.cancelMask() : engine.startMask(tabId)),
        });
      rare.push({ label: "Minimize", icon: <PictureInPicture2 aria-hidden="true" />, testId: "desk-minimize", onSelect: () => engine.minimize(tabId) });
    }
    if (!all) return rare;
    const common: MenuEntry[] = masked
      ? [{ label: "Unmask", icon: <Expand aria-hidden="true" />, onSelect: () => engine.unmask(tabId) }]
      : mini
        ? [{ label: "Expand", icon: <Maximize2 aria-hidden="true" />, onSelect: () => engine.expand(tabId) }]
        : [{ label: view.maximized ? "Restore" : "Fill the desk", icon: view.maximized ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />, onSelect: () => engine.toggleMaximize(tabId) }];
    common.push({ label: collapseLabel, icon: <Minus aria-hidden="true" />, onSelect: () => engine.putAway(tabId) });
    return [...rare, ...(rare.length > 0 ? [{ separator: true } as const] : []), ...common, { separator: true }, { label: "Close", icon: <X aria-hidden="true" />, testId: "desk-close-item", onSelect: () => engine.closeWindow(tabId) }];
  };
  const onFrameMenu = (event: React.MouseEvent): void => {
    event.preventDefault();
    if (view.flight !== null) return;
    menu.open(event, menuEntries(true));
  };
  const rare = menuEntries(false);
  const more =
    rare.length === 0 ? null : (
      <FrameButton
        ref={moreRef}
        label="More"
        testId="desk-window-more"
        tip={frameTip}
        pressed={menu.isOpen || siteInfoHere}
        onPress={() => {
          menuWasUp.current = menu.isOpen;
        }}
        onClick={(event) => {
          if (menuWasUp.current) {
            menuWasUp.current = false;
            return;
          }
          // Hung from the button, its trailing edge under the button's; what is true now (a bookmark kept since, say).
          const box = event.currentTarget.getBoundingClientRect();
          menu.open({ clientX: box.right - CONTEXT_MENU_W, clientY: box.bottom + 4 }, menuEntries(false));
        }}
      >
        <Ellipsis aria-hidden="true" />
      </FrameButton>
    );
  // Its page playing something: sent from here to the now playing — the window goes into its row, and the
  // media plays on in the sidebar, or on the rail as a floating player or the rail's button (lib/desk/now-playing.ts).
  const popOut =
    media === null ? null : (
      <FrameButton
        label={media.hasVideo ? "Pop out the video" : "Pop out the audio"}
        testId="desk-pop-out"
        tip={frameTip}
        onClick={() => {
          useNowPlaying.getState().pop(tabId);
          engine.putAway(tabId);
        }}
      >
        {media.hasVideo ? <PictureInPicture2 aria-hidden="true" /> : <AudioLines aria-hidden="true" />}
      </FrameButton>
    );
  const collapse = (
    <FrameButton label={collapseLabel} testId="desk-collapse" tip={frameTip} onClick={() => engine.putAway(tabId)}>
      <Minus aria-hidden="true" />
    </FrameButton>
  );
  const close = (
    <FrameButton label="Close" testId="desk-close" tip={frameTip} onClick={() => engine.closeWindow(tabId)}>
      <X aria-hidden="true" />
    </FrameButton>
  );
  const buttons = masked ? (
    <>
      {popOut}
      {more}
      <FrameButton label="Unmask" testId="desk-unmask" tip={frameTip} onClick={() => engine.unmask(tabId)}>
        <Expand aria-hidden="true" />
      </FrameButton>
      {collapse}
      {close}
    </>
  ) : mini ? (
    <>
      {popOut}
      <FrameButton label="Expand" testId="desk-expand" tip={frameTip} onClick={() => engine.expand(tabId)}>
        <Maximize2 aria-hidden="true" />
      </FrameButton>
      {collapse}
      {close}
    </>
  ) : (
    <>
      {popOut}
      {more}
      <FrameButton label={view.maximized ? "Restore" : "Fill the desk"} tip={frameTip} onClick={() => engine.toggleMaximize(tabId)}>
        {view.maximized ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
      </FrameButton>
      {collapse}
      {close}
    </>
  );
  const controls = (
    <span ref={controlsRef} className="desk-window-controls flex items-center">
      <TooltipProvider delay={TIP_DELAY_MS}>{buttons}</TooltipProvider>
    </span>
  );

  return (
    <div
      ref={attach}
      role="group"
      aria-label={title}
      data-testid="desk-window"
      data-tab-id={tabId}
      data-window-kind={shell?.kind ?? "tab"}
      data-chrome={frame}
      data-masked={masked ? "" : undefined}
      data-mini={view.mini ?? undefined}
      data-raised={view.raised ? "" : undefined}
      data-selecting={view.selecting ? "" : undefined}
      data-editing={view.editing === null ? undefined : view.editing.shown ? "shown" : "waiting"}
      data-focused={view.focused ? "" : undefined}
      data-drawn={view.drawn ? "" : undefined}
      data-carried={view.carried ? "" : undefined}
      data-lifted={view.lifted ? "" : undefined}
      data-aiming={view.aiming ? "" : undefined}
      data-into-dock={view.intoDock ? "" : undefined}
      data-flight={view.flight ?? undefined}
      data-closing={view.closing ? "" : undefined}
      data-menu={menu.isOpen ? "" : undefined}
      data-framed={view.framed ? undefined : "off"}
      data-agent={working ? "" : undefined}
      className="desk-window"
      style={{ zIndex: view.carried || view.flight !== null ? 60 + view.z : 10 + view.z }}
      // Parked at the desk's foot, the pointer on it raises it into view (over its live page, main says so instead).
      onPointerEnter={mini ? () => engine.hoverMini(tabId, "frame", true) : undefined}
      onPointerLeave={mini ? () => engine.hoverMini(tabId, "frame", false) : undefined}
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
        <div className="desk-window-chrome desk-window-tab" onPointerDown={onFrameDown} onContextMenu={onFrameMenu}>
          {parts !== null ? (
            parts.title("flex-1")
          ) : (
            <span className="desk-window-address flex-1" data-testid="desk-window-address" title={tab?.url}>
              <Favicon src={tab?.faviconUrl ?? null} seed={host || title} className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">{title}</span>
            </span>
          )}
          {controls}
        </div>
      ) : frame === "bare" ? (
        <div className="desk-window-chrome desk-window-handle" onPointerDown={onFrameDown} onContextMenu={onFrameMenu} title={title}>
          <span className="desk-window-pill" />
          {controls}
        </div>
      ) : null}
      {frame === "bar" || marks === null ? null : <div className="desk-window-marks-float">{marks}</div>}
      <div
        className={cn("desk-window-card", working && "agent-ring")}
        style={{ top: cardTop, "--agent-ring-delay": ringDelay, "--agent-ring-radius": "calc(var(--radius-md) + 4px)" } as CSSProperties}
      >
        {frame === "bar" ? (
          <div className="desk-window-chrome desk-window-bar" style={{ height: insets.top }} onPointerDown={onFrameDown} onContextMenu={onFrameMenu}>
            {/* Clicked, the address palette opens on this tab; dragged, it is the bar. */}
            {parts !== null ? (
              parts.title()
            ) : (
              <span className="desk-window-address" data-testid="desk-window-address" title={tab?.url}>
                <Favicon src={tab?.faviconUrl ?? null} seed={host || title} className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate font-medium text-gray-1000">{title}</span>
                {host !== "" && host !== title ? <span className="desk-window-host min-w-0 shrink-[2] truncate">{host}</span> : null}
              </span>
            )}
            <span className="flex-1" />
            {marks}
            {controls}
          </div>
        ) : null}
        <div
          className="desk-window-page"
          data-testid="desk-window-page"
          onPointerDown={onPageDown}
          style={{ top: insets.top - cardTop, left: insets.left, right: insets.right, bottom: insets.bottom }}
        >
          {/* A page the shell draws is zoomed out here when minimized (a web page is main's to zoom); always this box, so nothing in it is made anew. */}
          <div className="desk-window-zoom" style={mini && shellPage ? ZOOMED_STYLE : undefined}>
            {parts !== null ? (
              parts.page
            ) : tab === null ? null : (
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
          </div>
          {livePicture ? <DeskLivePicture tabId={tabId} /> : null}
          {/* Its page frozen (drawn), a region can be drawn over it. */}
          {view.selecting && view.drawn ? <MaskSelector tabId={tabId} engine={engine} /> : null}
        </div>
        <ResizeEdges tabId={tabId} engine={engine} top={frame === "bar"} />
      </div>
      {menu.menu}
      {siteInfoHere ? <SiteInfoFrom triggerRef={moreRef} align="end" /> : null}
    </div>
  );
});

/** A minimized window's page the shell draws: laid out at its box over the zoom, and scaled down into it. */
const ZOOMED_STYLE: CSSProperties = {
  width: `${String(100 / DESK_MINI_ZOOM)}%`,
  height: `${String(100 / DESK_MINI_ZOOM)}%`,
  transform: `scale(${String(DESK_MINI_ZOOM)})`,
  transformOrigin: "0 0",
};

/** The shell's own pages, drawn by the shell in a window rather than by a live view. */
export function pageKind(url: string): ShellPage | null {
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
  if (kind !== null) return <ShellPageView tab={tab} kind={kind} active={focused} />;
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
        {/* A window's tab is never left asleep: main wakes every tab with a window out (BrowserController.setDesk). */}
        {waking || tab.lifecycle === "suspended" ? <span className="text-[11px] text-gray-700">Waking…</span> : null}
      </PanePlaceholder>
    </div>
  );
}

/** One of the shell's own pages (pageKind), drawn by the shell. */
function ShellPageView({ tab, kind, active }: { tab: BrowserTabInfo; kind: ShellPage; active: boolean }) {
  if (kind === "home") return <HomePage tabId={tab.id} active={active} />;
  if (kind === "brief") return <BriefPage tabId={tab.id} date={briefUrlDate(tab.url.trim()) ?? null} active={active} />;
  return (
    <Suspense fallback={null}>
      <NotesPage tabId={tab.id} noteId={notesUrlId(tab.url.trim()) ?? null} active={active} />
    </Suspense>
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

/** One of the frame's buttons, its label in a tooltip under it. */
function FrameButton({
  ref,
  label,
  testId,
  pressed,
  tip: tipFor,
  onPress,
  onClick,
  children,
}: {
  ref?: Ref<HTMLButtonElement>;
  label: string;
  testId?: string;
  pressed?: boolean;
  tip: (label: string) => FrameTip;
  /** The pointer went down on it (before the click). */
  onPress?: () => void;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  const tip = tipFor(label);
  return (
    <Tooltip open={tip.open} onOpenChange={tip.onOpenChange} disabled={tip.disabled}>
      <TooltipTrigger
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        data-testid={testId}
        onPointerDown={(event) => {
          event.stopPropagation();
          onPress?.();
        }}
        // A press leaves the keyboard where it was (the window's page): a
        // focused frame button would light its ring at the next key — Shift,
        // say, held to snap the window it just filled.
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          onClick(event);
        }}
        className="grid size-6 cursor-pointer place-items-center rounded-md text-gray-800 outline-none transition-[background-color,color,transform] duration-150 hover:bg-alpha-200 hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.94] aria-pressed:bg-alpha-300 aria-pressed:text-gray-1000 motion-reduce:transition-none [&_svg]:size-3.5"
      >
        {children}
      </TooltipTrigger>
      {/* Under the button, over the window's own page, whatever room there is (it never flips above, onto another window). */}
      <TooltipContent
        side="bottom"
        sideOffset={6}
        collisionAvoidance={{ side: "none", align: "shift" }}
        data-testid="desk-window-tip"
        data-shown={tip.shown ? "" : undefined}
        // Until the page under it has given way, it is there but unseen.
        className={tip.shown ? "whitespace-nowrap" : "whitespace-nowrap opacity-0"}
      >
        {label}
      </TooltipContent>
    </Tooltip>
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
