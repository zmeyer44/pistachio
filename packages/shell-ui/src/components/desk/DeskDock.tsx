import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeftToLine,
  ChevronsUpDown,
  House,
  Layers2,
  LayoutGrid,
  Newspaper,
  NotebookPen,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import type { DockDrop, DockDrops } from "../../lib/desk/geometry";
import { nativeApi } from "../../api";
import { DESK_AXES, useDeskStore, type DeskVariants } from "../../lib/desk/store";
import { tabIcon } from "../../lib/desk/tab-icon";
import { cn } from "../../lib/cn";
import { displayHost } from "../../lib/url";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { DOCK_W, type DeskEngine, type DeskView } from "./desk-engine";
import { pageKind } from "./DeskWindow";

/** The preview beside a hovered icon, and the gap between it and the dock. */
const PREVIEW_W = 232;
const PREVIEW_H = 200;
const POPOVER_GAP = 12;
/** A drop rail's segment sits this far inside the rail. */
const SEGMENT_INSET = 4;
/**
 * The shelf and the rail slide away behind the desk's edge, clipped by a
 * box this much wider than the dock's column on the left (room for their
 * rings) and CLIP_ROOM on the right (for a hovered icon and the shadows).
 * An `overflow-x: clip` box, not a clip-path: a clip-path ancestor would
 * leave their frosted glass nothing behind it to blur.
 */
const CLIP_MARGIN = 12;
const CLIP_ROOM = 40;
/** A tool button is this wide, centred in the dock: its tooltip is set this far out, clear of the shelf by the popover gap. */
const TOOL_W = 34;
const TIP_OFFSET = (DOCK_W - TOOL_W) / 2 + POPOVER_GAP;
/** The band beside the tools a tooltip may take (the cover): this wide past the gap, this far above and below the tools. */
const TIP_BAND_W = 200;
const TIP_BAND_SLACK = 8;
/** The first tooltip waits this long; its neighbours then show at once (the provider groups them). */
const TIP_DELAY_MS = 350;
/** The band stays covered this long after a tooltip closes, so moving to the next tool the pages there stay stills. */
const TIP_LINGER_MS = 200;

/**
 * The dock: the group's tabs as icons down the desk's leading edge, the way
 * the macOS Dock sits on the left of the screen — each tab's app icon (or
 * its favicon on a tile), a dot beside those out on the desk, a longer one
 * in the group's colour beside the window in use.
 *
 * - Hover an icon: a preview of the tab beside it.
 * - Click: its window comes to the top — or, not out, it comes out where the
 *   desk's layout has room for it (placeNewWindow).
 * - Drag: the icon comes away in hand, and once it is pulled clear of the
 *   dock it becomes the tab's window, held by its title bar (the engine's
 *   #takeInHand). A window let go over the dock goes into it.
 *
 * Below a divider: the arrangements, the variants this experiment is for
 * (Feel), and the way out.
 *
 * While a window is carried, the dock slides away off the desk's edge, and a
 * rail of the same glass slides in in its place as the pointer nears the
 * edge (DropRail): back into the dock above, the tab closed below (the
 * engine's dockDropAt). The dock slides back on letting go.
 *
 * A window may lie behind the dock, which floats over it. The window in use
 * cannot (its live page would paint over the dock), so the dock steps aside
 * for it and comes back when the pointer comes to its place (the engine's
 * `dockAside`); it tells the engine where its shelf stands for that.
 *
 * The preview, the Feel menu and the tools' tooltips are drawn over the
 * desk, where live pages would paint over them: the engine is told where
 * they go (setCover), the pages there give way to their stills, and each
 * shows once that is done.
 */
export const DeskDock = memo(function DeskDock({
  group,
  tabs,
  view,
  engine,
}: {
  group: TabGroupInfo;
  tabs: readonly BrowserTabInfo[];
  view: DeskView;
  engine: DeskEngine;
}) {
  const dockRef = useRef<HTMLElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const shelfRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  /** The tool whose tooltip is open, as Base UI says. */
  const [tip, setTip] = useState<string | null>(null);
  const feelButtonRef = useRef<HTMLButtonElement>(null);
  const feelRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<{
    tabId: string;
    center: number;
  } | null>(null);
  const [inside, setInside] = useState(false);
  const [feelOpen, setFeelOpen] = useState(false);
  /** The Feel button's foot, from the dock's top: the menu's foot is level with it. */
  const [feelTop, setFeelTop] = useState(0);
  const onDesk = new Set(view.windows.map((window) => window.tabId));
  const focused = view.windows.find((window) => window.focused)?.tabId ?? null;
  const tabIds = tabs.map((tab) => tab.id);
  const busy = view.gesture !== null;
  /** The tooltip open now: none while the dock is busy or away, nor the Feel button's under its own menu. */
  const openTip = tip === null || busy || view.dockAside || (tip === "Feel" && feelOpen) ? null : tip;
  /** A window in hand: the dock is out of the way, its pads in its place. */
  const carrying = view.gesture === "move" || view.gesture === "spawn";

  // Where the shelf stands, in the stage: laid-out boxes, which its slides
  // (transforms) never move. It grows with the group, and is centred on the
  // desk's height.
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const clip = clipRef.current;
    const shelf = shelfRef.current;
    if (dock === null || clip === null || shelf === null) return;
    const measure = (): void =>
      engine.setDockShelf({
        x: dock.offsetLeft + clip.offsetLeft + shelf.offsetLeft,
        y: dock.offsetTop + clip.offsetTop + shelf.offsetTop,
        w: shelf.offsetWidth,
        h: shelf.offsetHeight,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    observer.observe(shelf);
    return () => {
      observer.disconnect();
      engine.setDockShelf(null);
    };
  }, [engine]);

  // A tool's tooltip is open: the band beside the tools is a cover, and
  // stays one a moment after it closes — moving from one tool to the next,
  // the pages there stay stills, and the next tooltip does not wait.
  useEffect(() => {
    if (openTip === null) {
      const timer = window.setTimeout(() => engine.setCover("tip", null), TIP_LINGER_MS);
      return () => window.clearTimeout(timer);
    }
    const tools = toolsRef.current;
    const dock = dockRef.current;
    if (tools === null || dock === null) return;
    // (The dock's box is the stage's corner.)
    const box = tools.getBoundingClientRect();
    const top = box.top - dock.getBoundingClientRect().top;
    engine.setCover("tip", { x: DOCK_W, y: top - TIP_BAND_SLACK, w: POPOVER_GAP + TIP_BAND_W, h: box.height + TIP_BAND_SLACK * 2 });
  }, [engine, openTip]);
  useEffect(() => () => engine.setCover("tip", null), [engine]);

  // The Feel menu open beside it: the dock stands, whatever it would step aside for.
  useEffect(() => {
    engine.holdDock("feel", feelOpen);
  }, [engine, feelOpen]);

  // An icon is hovered: the band beside the dock, where its preview (and the
  // next icon's) appears, is cleared of live pages for as long as the
  // pointer stays on the icons — moving between them, the preview never waits.
  const peeking = hovered !== null && inside && !busy && !feelOpen;
  useEffect(() => {
    const height = dockRef.current?.clientHeight ?? 0;
    engine.setCover("preview", peeking && height > 0 ? { x: DOCK_W, y: 0, w: POPOVER_GAP + PREVIEW_W + 12, h: height } : null);
  }, [engine, peeking]);
  useEffect(() => () => engine.setCover("preview", null), [engine]);

  // The Feel menu, where it is drawn, for as long as it is open.
  useLayoutEffect(() => {
    const menu = feelRef.current;
    const dock = dockRef.current;
    if (!feelOpen || menu === null || dock === null) {
      engine.setCover("feel", null);
      return;
    }
    // Its laid-out box (not the transformed one it opens from): the dock is at the stage's corner.
    engine.setCover("feel", {
      x: menu.offsetLeft,
      y: menu.offsetTop,
      w: menu.offsetWidth,
      h: menu.offsetHeight,
    });
  }, [engine, feelOpen, feelTop]);
  useEffect(() => () => engine.setCover("feel", null), [engine]);

  // The Feel menu closes on a press anywhere else, or Escape — on a live
  // page too, which the shell never hears itself (main relays it).
  useEffect(() => {
    if (!feelOpen) return;
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      if (input !== "dock") setFeelOpen(false);
    });
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (feelRef.current?.contains(target) === true || feelButtonRef.current?.contains(target) === true) return;
      setFeelOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setFeelOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      offPage?.();
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [feelOpen]);

  const onHover = useCallback(
    (tabId: string, el: HTMLElement) => {
      const dock = dockRef.current;
      if (dock === null) return;
      const box = el.getBoundingClientRect();
      setHovered({
        tabId,
        center: box.top + box.height / 2 - dock.getBoundingClientRect().top,
      });
      engine.peek(tabId);
    },
    [engine],
  );

  const openFeel = (): void => {
    const button = feelButtonRef.current;
    const dock = dockRef.current;
    if (button !== null && dock !== null) {
      const box = button.getBoundingClientRect();
      setFeelTop(box.bottom - dock.getBoundingClientRect().top);
    }
    setFeelOpen(!feelOpen);
  };

  const attachGhost = useCallback((el: HTMLDivElement | null) => engine.attachGhost(el), [engine]);
  const hoveredTab = hovered === null ? null : (tabs.find((tab) => tab.id === hovered.tabId) ?? null);
  const dockHeight = dockRef.current?.clientHeight ?? 0;
  const previewShown = hoveredTab !== null && peeking && view.clearCovers.has("preview");
  const draggedTab = view.iconDrag === null ? null : (tabs.find((tab) => tab.id === view.iconDrag) ?? null);
  /** A tool's tooltip: open as Base UI says, seen once no live page is left under it, none while the dock is busy or away. */
  const toolTip = (label: string, off = false): DockTip => ({
    open: openTip === label,
    shown: view.clearCovers.has("tip"),
    disabled: off || busy || view.dockAside,
    onOpenChange: (open) => setTip((current) => (open ? label : current === label ? null : current)),
  });

  return (
    <>
      <aside
        ref={dockRef}
        aria-label={`${group.title}: the group's tabs`}
        data-testid="desk-dock"
        data-hidden={carrying || view.dockAside ? "" : undefined}
        data-group-color={group.color}
        className="desk-dock tab-group-tone"
        style={{ width: DOCK_W }}
      >
        <div
          ref={clipRef}
          className="desk-dock-clip"
          style={{
            left: -CLIP_MARGIN,
            width: DOCK_W + CLIP_MARGIN + CLIP_ROOM,
            paddingLeft: CLIP_MARGIN,
          }}
        >
          <div
            ref={shelfRef}
            className="desk-dock-shelf"
            style={{ width: DOCK_W }}
            onPointerEnter={() => setInside(true)}
            onPointerLeave={() => {
              setInside(false);
              setHovered(null);
            }}
          >
            <span
              className="desk-dock-group"
              title={`${group.title} · ${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}`}
              aria-hidden="true"
            />
            <div className="desk-dock-icons" role="list">
              {tabs.map((tab) => (
                <DockIcon
                  key={tab.id}
                  tab={tab}
                  onDesk={onDesk.has(tab.id)}
                  focused={focused === tab.id}
                  inHand={view.iconDrag === tab.id}
                  engine={engine}
                  onHover={onHover}
                />
              ))}
            </div>
            {/* Off the icons, there is no preview to show. */}
            <div ref={toolsRef} className="desk-dock-tools" onPointerEnter={() => setHovered(null)}>
              <span className="desk-dock-divider" aria-hidden="true" />
              <TooltipProvider delay={TIP_DELAY_MS}>
                <DockButton label="Tile the windows" tip={toolTip("Tile the windows")} onClick={() => engine.arrange("tile", tabIds)}>
                  <LayoutGrid aria-hidden="true" />
                </DockButton>
                <DockButton label="Cascade the windows" tip={toolTip("Cascade the windows")} onClick={() => engine.arrange("cascade", tabIds)}>
                  <Layers2 aria-hidden="true" />
                </DockButton>
                <DockButton label="Every tab out, tiled" tip={toolTip("Every tab out, tiled")} onClick={() => engine.gather(tabIds)}>
                  <Sparkles aria-hidden="true" />
                </DockButton>
                {/* Its menu open beside it, where the tooltip would be: no tooltip. */}
                <DockButton
                  ref={feelButtonRef}
                  label="Feel"
                  testId="desk-feel"
                  pressed={feelOpen}
                  tip={toolTip("Feel", feelOpen)}
                  onClick={openFeel}
                >
                  <SlidersHorizontal aria-hidden="true" />
                </DockButton>
                <DockButton label="Leave the desk" testId="desk-leave" tip={toolTip("Leave the desk")} onClick={() => useDeskStore.getState().leave()}>
                  <X aria-hidden="true" />
                </DockButton>
              </TooltipProvider>
            </div>
          </div>
        </div>
        {hoveredTab === null ? null : (
          <DockPreview
            tab={hoveredTab}
            src={view.thumbs.get(hoveredTab.id) ?? null}
            center={hovered!.center}
            dockHeight={dockHeight}
            onDesk={onDesk.has(hoveredTab.id)}
            shown={previewShown}
          />
        )}
        {feelOpen ? (
          <div
            ref={feelRef}
            role="dialog"
            aria-label="Feel"
            data-testid="desk-variants"
            data-shown={view.clearCovers.has("feel") ? "" : undefined}
            className="desk-dock-menu"
            // Its foot level with the Feel button's.
            style={{
              left: DOCK_W + POPOVER_GAP,
              bottom: Math.max(8, dockHeight - feelTop),
            }}
          >
            <div className="px-1.5 pt-0.5 pb-1 text-[10.5px] font-semibold tracking-wide text-gray-700 uppercase">Feel</div>
            {DESK_AXES.map((axis) => (
              <VariantRow key={axis.key} axisKey={axis.key} label={axis.label} />
            ))}
          </div>
        ) : null}
      </aside>
      <DropRail engine={engine} drops={view.drops} shown={carrying && view.dropsShown} drop={carrying ? view.dockDrop : null} />
      {/* The icon in hand, above everything on the desk (the engine moves it). */}
      <div ref={attachGhost} className="desk-dock-ghost" aria-hidden="true">
        {draggedTab === null ? null : <AppIcon tab={draggedTab} />}
      </div>
    </>
  );
});

/**
 * What stands in the dock's column while a window is carried: a rail of the
 * dock's own glass, sliding in from where the dock went as the pointer
 * nears the desk's edge, cut in two by a hairline — Minimize above, Close
 * below (the smaller, where the Dock keeps its Trash). Nothing on it is
 * coloured until a release would go somewhere: then that segment fills
 * with its colour, and its mark — filled, a little larger — follows the
 * pointer up and down the segment (`--pointer-y`, written by the engine),
 * so the target is always beside the hand. The segment chosen stays lit as
 * the rail slides away, so the choice is seen to be taken.
 */
function DropRail({ engine, drops, shown, drop }: { engine: DeskEngine; drops: DockDrops; shown: boolean; drop: DockDrop | null }) {
  const attach = useCallback((el: HTMLDivElement | null) => engine.attachDrops(el), [engine]);
  const [chosen, setChosen] = useState<DockDrop | null>(null);
  // Held over a segment, it is the chosen one; let go (the rail leaving), it stays chosen until the next carry.
  if (shown && drop !== chosen) setChosen(drop);
  const top = drops.away.y;
  const height = drops.close.y + drops.close.h - top;
  const split = (drops.away.y + drops.away.h + drops.close.y) / 2 - top;
  const lit = shown ? drop : chosen;
  return (
    <div
      ref={attach}
      className="desk-drops"
      data-shown={shown ? "" : undefined}
      aria-hidden="true"
      style={{
        top,
        height,
        left: -CLIP_MARGIN,
        width: DOCK_W + CLIP_MARGIN + CLIP_ROOM,
      }}
    >
      <div className="desk-drop-rail" style={{ left: CLIP_MARGIN, width: DOCK_W }}>
        <DropSegment kind="away" top={SEGMENT_INSET} height={split - SEGMENT_INSET * 2} lit={lit === "away"} label="Minimize" railTop={top}>
          <ArrowLeftToLine />
        </DropSegment>
        <span className="desk-drop-divider" style={{ top: split }} />
        <DropSegment
          kind="close"
          top={split + SEGMENT_INSET}
          height={height - split - SEGMENT_INSET * 2}
          lit={lit === "close"}
          label="Close"
          railTop={top}
        >
          <X />
        </DropSegment>
      </div>
    </div>
  );
}

function DropSegment({
  kind,
  top,
  height,
  lit,
  label,
  railTop,
  children,
}: {
  kind: DockDrop;
  top: number;
  height: number;
  lit: boolean;
  label: string;
  /** The rail's top in the stage: the pointer's height is the stage's. */
  railTop: number;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={`desk-drop-${kind}`}
      data-kind={kind}
      data-armed={lit ? "" : undefined}
      className="desk-drop"
      style={
        {
          top,
          height,
          "--segment-top": `${railTop + top}px`,
        } as React.CSSProperties
      }
    >
      <span className="desk-drop-mark">
        <span className="desk-drop-badge">{children}</span>
        <span className="desk-drop-label">{label}</span>
      </span>
    </div>
  );
}

function DockIcon({
  tab,
  onDesk,
  focused,
  inHand,
  engine,
  onHover,
}: {
  tab: BrowserTabInfo;
  onDesk: boolean;
  focused: boolean;
  inHand: boolean;
  engine: DeskEngine;
  onHover: (tabId: string, el: HTMLElement) => void;
}) {
  const attach = useCallback((el: HTMLSpanElement | null) => engine.attachIcon(tab.id, el), [engine, tab.id]);
  const title = tab.title || displayHost(tab.url) || "Untitled";
  return (
    <div
      role="listitem"
      tabIndex={0}
      aria-label={onDesk ? `${title}, on the desk` : title}
      data-testid="desk-dock-icon"
      data-tab-id={tab.id}
      data-on-desk={onDesk ? "" : undefined}
      data-focused={focused ? "" : undefined}
      data-in-hand={inHand ? "" : undefined}
      className="desk-dock-item"
      onPointerEnter={(event) => onHover(tab.id, event.currentTarget)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        engine.pressIcon(tab.id, event);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        engine.add(tab.id, { focus: true });
      }}
    >
      <span className="desk-dock-dot" aria-hidden="true" />
      <span ref={attach} className="desk-dock-tile">
        <AppIcon tab={tab} />
      </span>
    </div>
  );
}

/**
 * A tab as an app: the icon the site declares for itself when it has one,
 * full bleed; otherwise its favicon on a tile of its own; a shell page's
 * own mark; and failing all of those, its initial on a tile in a colour of
 * its own.
 */
export function AppIcon({ tab }: { tab: BrowserTabInfo }) {
  // Every address that failed to load (tabIcon passes over them all).
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const fail = (url: string): void => setFailed((before) => new Set(before).add(url));
  const kind = pageKind(tab.url);
  if (kind !== null) {
    const Mark = kind === "home" ? House : kind === "brief" ? Newspaper : NotebookPen;
    return (
      <span className="desk-app-icon desk-app-icon-shell">
        <Mark aria-hidden="true" />
      </span>
    );
  }
  const host = displayHost(tab.url);
  const icon = tabIcon(tab.appIconUrl, tab.faviconUrl, failed);
  if (icon.kind === "app") {
    return <img className="desk-app-icon desk-app-icon-full" src={icon.src} alt="" draggable={false} onError={() => fail(icon.src)} />;
  }
  if (icon.kind === "favicon") {
    return (
      <span className="desk-app-icon desk-app-icon-tile">
        <img src={icon.src} alt="" draggable={false} onError={() => fail(icon.src)} />
      </span>
    );
  }
  const seed = host || tab.title || "•";
  return (
    <span className="desk-app-icon desk-app-icon-letter" style={{ "--letter-h": hueOf(seed) } as React.CSSProperties}>
      {seed
        .replace(/^www\./, "")
        .charAt(0)
        .toUpperCase()}
    </span>
  );
}

/** A steady hue for a site, so its letter tile is always the same colour. */
function hueOf(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

function DockPreview({
  tab,
  src,
  center,
  dockHeight,
  onDesk,
  shown,
}: {
  tab: BrowserTabInfo;
  src: string | null;
  center: number;
  dockHeight: number;
  onDesk: boolean;
  shown: boolean;
}) {
  const host = displayHost(tab.url);
  const title = tab.title || host || "Untitled";
  const top = Math.max(8, Math.min(Math.max(8, dockHeight - PREVIEW_H - 8), center - PREVIEW_H / 2));
  return (
    <div
      aria-hidden="true"
      data-testid="desk-dock-preview"
      data-tab-id={tab.id}
      data-shown={shown ? "" : undefined}
      className="desk-dock-preview"
      style={{
        left: DOCK_W + POPOVER_GAP,
        top,
        width: PREVIEW_W,
        height: PREVIEW_H,
      }}
    >
      <span className="desk-dock-preview-tail" style={{ top: center - top }} />
      <div className="desk-dock-preview-shot">
        {src !== null ? (
          <img src={src} alt="" draggable={false} />
        ) : (
          <span className="desk-dock-preview-empty">
            <AppIcon tab={tab} />
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 px-2.5 pt-2">
        <span className="truncate text-[12px] leading-4 font-medium text-gray-1000">{title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-gray-700">
          <span className="min-w-0 truncate">{host || (tab.lifecycle === "suspended" ? "Asleep" : "")}</span>
          <span className="shrink-0">·</span>
          <span className="shrink-0">{onDesk ? "On the desk" : "In the dock"}</span>
        </span>
      </div>
    </div>
  );
}

/** A tool's tooltip, as the dock runs it (DeskDock's `toolTip`). */
interface DockTip {
  open: boolean;
  /** No live page is left under it: it can be seen. */
  shown: boolean;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
}

/** One of the dock's tools, its label in a tooltip beside the dock. */
function DockButton({
  ref,
  label,
  testId,
  pressed,
  tip,
  onClick,
  children,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  label: string;
  testId?: string;
  pressed?: boolean;
  tip: DockTip;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip open={tip.open} onOpenChange={tip.onOpenChange} disabled={tip.disabled}>
      <TooltipTrigger
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        data-testid={testId}
        // A press leaves the keyboard where it was (a window's page).
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        className="desk-dock-button"
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={TIP_OFFSET}
        data-testid="desk-dock-tip"
        data-shown={tip.shown ? "" : undefined}
        // Until the pages under it have given way, it is there but unseen.
        className={cn("whitespace-nowrap", !tip.shown && "opacity-0")}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * One variant axis. A click moves to the next choice (shift-click to the
 * previous); the hint says what it changes.
 */
function VariantRow({ axisKey, label }: { axisKey: keyof DeskVariants; label: string }) {
  const value = useDeskStore((state) => state.variants[axisKey]);
  const axis = DESK_AXES.find((candidate) => candidate.key === axisKey)!;
  const options = axis.options as ReadonlyArray<{
    id: string;
    label: string;
    hint: string;
  }>;
  const index = options.findIndex((option) => option.id === value);
  const option = options[index] ?? options[0]!;
  return (
    <button
      type="button"
      data-testid={`desk-variant-${axisKey}`}
      data-value={option.id}
      title={`${option.hint} — click for the next`}
      onClick={(event) => {
        const store = useDeskStore.getState();
        if (!event.shiftKey) {
          store.cycleVariant(axisKey);
          return;
        }
        const previous = options[(index - 1 + options.length) % options.length]!;
        store.setVariant(axisKey, previous.id as DeskVariants[typeof axisKey]);
      }}
      className="group/variant flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[12px] outline-none transition-colors duration-150 hover:bg-alpha-100 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="w-16 shrink-0 text-left text-gray-700">{label}</span>
      <span key={option.id} className="desk-variant-value min-w-0 flex-1 truncate text-left font-medium text-gray-1000">
        {option.label}
      </span>
      <ChevronsUpDown aria-hidden="true" className="size-3 shrink-0 text-gray-600 group-hover/variant:text-gray-900" />
    </button>
  );
}
