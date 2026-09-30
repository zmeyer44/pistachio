import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  AppWindow,
  ArrowLeftToLine,
  ArrowUpToLine,
  ChevronsUpDown,
  Ellipsis,
  House,
  Layers2,
  LayoutGrid,
  Minus,
  Newspaper,
  NotebookPen,
  Plus,
  X,
} from "lucide-react";
import { shortcutLabel, type ShortcutPlatform } from "@pistachio/shell-contracts/shortcuts";
import type { BrowserTabInfo, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { agentRingDelayMs } from "@pistachio/shell-contracts/agent-glow";
import type { GroupContextView } from "@pistachio/shell-contracts/desk-agent";
import type { DockDrop, DockDrops } from "../../lib/desk/geometry";
import { nativeApi } from "../../api";
import { useNewGroupNaming, useTabGroupMenu } from "../../chrome/tab-group-menu";
import { useTabMenu } from "../../chrome/tab-menu";
import { chromeTabs } from "../../lib/chrome-tabs";
import { groupsInRowOrder, settledOrder } from "../../lib/desk/dock-order";
import { GLIDE_DECELERATION } from "../../lib/desk/motion";
import { DESK_AXES, passedEntry, useDeskStore, type DeskAxisKey, type DeskChrome, type DeskVariants, type SavedDeskWindow } from "../../lib/desk/store";
import { tabIcon } from "../../lib/desk/tab-icon";
import { cn } from "../../lib/cn";
import { displayHost } from "../../lib/url";
import { useAppStore } from "../../store";
import { useContextMenu, type MenuEntry } from "../ContextMenu";
import { FaviconCluster, GroupTitleInput } from "../TabGroupRow";
import { Kbd } from "../ui/kbd";
import { Slider } from "../ui/slider";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import {
  CHROME_CARD_TOP,
  CHROME_INSETS,
  DOCK_W,
  MASK_CARD_TOP,
  MASK_INSETS,
  type DeskEngine,
  type DeskSketchWindow,
  type DeskView,
  type DockDragView,
} from "./desk-engine";
import { cropStyle, pageKind } from "./DeskWindow";
import { StackCard, StackTile } from "./DeskStack";

/** The preview beside a hovered icon, and the gap between it and the dock. */
const PREVIEW_W = 232;
const PREVIEW_H = 200;
/**
 * Another group's card: its desk drawn small, this wide inside the card's
 * padding — as tall as the desk's shape makes it, within these bounds (a
 * desk of an odd shape is drawn smaller, in the middle).
 */
const SKETCH_W = 300;
const SKETCH_MIN_H = 120;
const SKETCH_MAX_H = 230;
/** The card's padding and its caption, around the sketch. */
const CARD_PAD = 6;
const CARD_CAPTION_H = 50;
const GROUP_CARD_W = SKETCH_W + CARD_PAD * 2;
const POPOVER_GAP = 12;
/** A group's name edited beside its icon (DockRename). */
const RENAME_W = 220;
const RENAME_H = 38;
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
/** The More card stays this long after the pointer leaves it or its button: long enough to cross the gap between. */
const MORE_LINGER_MS = 300;
const PLATFORM: ShortcutPlatform = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : "other";
const NO_GROUPS: readonly TabGroupInfo[] = [];
const NO_TABS: readonly BrowserTabInfo[] = [];
const NO_WINDOWS: readonly SavedDeskWindow[] = [];
const NO_IDS: readonly string[] = [];

/**
 * The dock: the group's tabs as icons down the desk's leading edge, the way
 * the macOS Dock sits on the left of the screen — each tab's app icon (or
 * its favicon on a tile), a dot beside those out on the desk, a longer one
 * in the group's colour beside the window in use.
 *
 * - Hover an icon: a preview of the tab beside it. ⇧⌫ then closes the tab,
 *   wherever the keyboard is (main takes the key: DeskState.dockHover).
 * - Click: its window comes to the top — or, not out, it comes out where the
 *   desk's layout has room for it (placeNewWindow).
 * - Right-click: the sidebar's menu for the tab (chrome/tab-menu.tsx), after
 *   what the desk does with its window (out onto the desk, to the front,
 *   put away) — without a split view, which a desk has no place for.
 * - Drag: the icon comes away in hand. Up and down the dock, the other
 *   icons make room for it, and let go it takes that place among the
 *   group's tabs; let go on another group's icon, as an app is dropped into
 *   a folder, the tab goes into that group (the engine's #dropInDock).
 *   Pulled clear of the dock it becomes the tab's window, held by its title
 *   bar (the engine's #takeInHand). A window let go over the dock goes into it.
 *
 * Below a divider: the Space's other tab groups, in the sidebar's order, each
 * a pile of its tabs' icons as the sidebar draws a group (DockGroups).
 * Hovered, one shows its desk beside it, drawn small, as it would come out
 * (DockGroupCard); a click passes the desk to that group in place — this
 * group's windows fly into its own icon there, and the other's come out of
 * the icon clicked (the engine's switchGroup); dragged up or down, it moves
 * among the groups; right-clicked, the sidebar's menu for the group
 * (chrome/tab-group-menu.tsx), its Rename a field beside the icon
 * (DockRename). Below another: a new tab in the group (it comes out onto
 * the desk as the window in use), and More, whose card (DockMoreCard),
 * open while the pointer is on it, holds the arrangements, the variants
 * this experiment is for (Feel), and the way out.
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
 * The previews, the More card and the tools' tooltips are drawn over the
 * desk, where live pages would paint over them: the engine is told where
 * they go (setCover), the pages there give way to their stills, and each
 * shows once that is done.
 */
export const DeskDock = memo(function DeskDock({
  group,
  tabs,
  view,
  engine,
  context,
  otherContexts,
  agentTabId,
}: {
  group: TabGroupInfo;
  tabs: readonly BrowserTabInfo[];
  view: DeskView;
  engine: DeskEngine;
  /** The group's context, which its Stack holds (docs/desk-agent.md §1). */
  context: GroupContextView | null;
  /** Contexts of groups not in this Space's list, which the Stack offers to bring in. */
  otherContexts: readonly GroupContextView[];
  /** The tab the agent is working in: its icon wears the agent's ring. */
  agentTabId: string | null;
}) {
  const dockRef = useRef<HTMLElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const shelfRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  /** The tool whose tooltip is open, as Base UI says. */
  const [tip, setTip] = useState<string | null>(null);
  /** The group the dock opened on: another's tabs, once passed to it, come in with a little pop. */
  const [firstGroup] = useState(group.id);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  /** The icon under the pointer — a tab's, or another group's — and its middle's height in the dock. */
  const [hovered, setHovered] = useState<{
    kind: "tab" | "group";
    id: string;
    center: number;
  } | null>(null);
  const [inside, setInside] = useState(false);
  /**
   * The More card: up while the pointer is on its button or on it (with a
   * moment's grace to cross the gap between), or, `pinned` by a click on the
   * button, until a press elsewhere or Escape.
   */
  const [more, setMore] = useState<{ pinned: boolean } | null>(null);
  /** The More button's foot, from the dock's top: the card's foot is level with it. */
  const [moreFoot, setMoreFoot] = useState(0);
  /** The card's height, once drawn: in a short window it may not reach above the dock's top. */
  const [moreHeight, setMoreHeight] = useState(0);
  const moreTimer = useRef(0);
  /** A press inside the card (a slider in hand): it stays up until the press ends, wherever the pointer goes. */
  const morePressed = useRef(false);
  /** The Stack's card, open beside it: the Stack's middle, from the dock's top. Until a press elsewhere or Escape. */
  const [stack, setStack] = useState<{ center: number } | null>(null);
  /** What a drop on the Stack could not take, said on its card. */
  const [stackRejection, setStackRejection] = useState<string | null>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const onDesk = new Set(view.windows.map((window) => window.tabId));
  const focused = view.windows.find((window) => window.focused)?.tabId ?? null;
  // In the order a drop in the dock made, until the browser's says the same.
  const shownTabs = settledOrder(tabs, view.dockSettle?.tabs ?? null, view.dockSettle?.gone ?? null);
  const tabIds = shownTabs.map((tab) => tab.id);
  const reordering = view.dockDrag?.kind === "tab";
  const busy = view.gesture !== null;
  // Right-click menus (the sidebar's, for a tab and for a group). The menu
  // is a shell overlay: the live pages give way to their stills while it is
  // up, as for the address palette.
  const menu = useContextMenu();
  const menuOpen = menu.isOpen;
  // The More card goes when something is taken in hand, or a right-click menu opens.
  if (more !== null && (busy || menuOpen)) setMore(null);
  const moreOpen = more !== null && !busy && !menuOpen;
  // So does the Stack's, and when the More card opens.
  if (stack !== null && (busy || menuOpen || moreOpen)) setStack(null);
  const stackOpen = stack !== null && !busy && !menuOpen && !moreOpen;
  /** Another group whose name is being edited beside its icon: its menu's Rename, or a group just made that the host could not name. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const tabMenu = useTabMenu({
    onNewGroup: useNewGroupNaming(setRenaming),
    desk: {
      onDesk: (tabId) => engine.windowTabIds().includes(tabId),
      moveToGroup: (tabId, groupId) => engine.moveTabToGroup(tabId, groupId),
    },
  });
  const { menu: groupMenu } = useTabGroupMenu({ onRename: setRenaming, desk: { open: (groupId) => engine.chooseGroup(groupId) } });
  /** The tooltip open now: none while the dock is busy or away, nor with the More card or a right-click menu up. */
  const openTip = tip === null || busy || menuOpen || moreOpen || view.dockAside ? null : tip;
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
  }, [engine, view.dockClear]);

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

  // The More card up beside it, or a right-click menu: the dock stands, whatever it would step aside for.
  useEffect(() => {
    engine.holdDock("more", moreOpen);
  }, [engine, moreOpen]);
  useEffect(() => {
    engine.holdDock("menu", menuOpen);
  }, [engine, menuOpen]);
  useEffect(() => {
    engine.holdDock("stack", stackOpen);
  }, [engine, stackOpen]);

  // The Stack's card, where it is drawn, and the gap between it and the dock.
  useLayoutEffect(() => {
    const card = stackRef.current;
    if (!stackOpen || card === null) {
      engine.setCover("stack", null);
      return;
    }
    const measure = (): void => engine.setCover("stack", { x: DOCK_W, y: card.offsetTop, w: card.offsetLeft + card.offsetWidth - DOCK_W, h: card.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, [engine, stackOpen, stack?.center]);
  useEffect(() => () => engine.setCover("stack", null), [engine]);

  // The Stack's card goes on a press anywhere else (a live page's too, which main relays), or Escape.
  useEffect(() => {
    if (!stackOpen) return;
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      if (input !== "dock") setStack(null);
    });
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      const onStack = target instanceof Element && target.closest("[data-testid='desk-stack']") !== null;
      if (!onStack && stackRef.current?.contains(target) !== true) setStack(null);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setStack(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      offPage?.();
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [stackOpen]);

  // An icon is hovered: the band beside the dock, where its preview (and the
  // next icon's) appears, is cleared of live pages for as long as the
  // pointer stays on the icons — moving between them, the preview never
  // waits. A group's card is wider than a tab's preview.
  const peeking = hovered !== null && inside && !busy && !moreOpen && !menuOpen && !stackOpen;
  const peekWidth = hovered?.kind === "group" ? GROUP_CARD_W : PREVIEW_W;
  useEffect(() => {
    const height = dockRef.current?.clientHeight ?? 0;
    engine.setCover("preview", peeking && height > 0 ? { x: DOCK_W, y: 0, w: POPOVER_GAP + peekWidth + 12, h: height } : null);
  }, [engine, peeking, peekWidth]);
  useEffect(() => () => engine.setCover("preview", null), [engine]);

  // The More card, where it is drawn, for as long as it is up — and the gap
  // between it and the dock, so the pointer crossing it is the shell's.
  useLayoutEffect(() => {
    const card = moreRef.current;
    if (!moreOpen || card === null) {
      engine.setCover("more", null);
      return;
    }
    if (card.offsetHeight !== moreHeight) setMoreHeight(card.offsetHeight);
    // Its laid-out box (not the transformed one it opens from): the dock is at the stage's corner.
    engine.setCover("more", {
      x: DOCK_W,
      y: card.offsetTop,
      w: card.offsetLeft + card.offsetWidth - DOCK_W,
      h: card.offsetHeight,
    });
  }, [engine, moreOpen, moreFoot, moreHeight]);
  useEffect(
    () => () => {
      engine.setCover("more", null);
      window.clearTimeout(moreTimer.current);
    },
    [engine],
  );

  // The More card goes on a press anywhere else, or Escape — on a live page
  // too, which the shell never hears itself (main relays it). A press held
  // in it (a slider in hand) keeps it up until it ends.
  useEffect(() => {
    if (!moreOpen) return;
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      if (input !== "dock") setMore(null);
    });
    const within = (target: EventTarget | null): boolean =>
      moreRef.current?.contains(target as Node | null) === true || moreButtonRef.current?.contains(target as Node | null) === true;
    const onDown = (event: PointerEvent): void => {
      if (!within(event.target)) setMore(null);
    };
    const onUp = (): void => {
      if (!morePressed.current) return;
      morePressed.current = false;
      if (moreRef.current?.matches(":hover") !== true) hideMoreSoon();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMore(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("keydown", onKey);
    return () => {
      offPage?.();
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const onHover = useCallback(
    (kind: "tab" | "group", id: string, el: HTMLElement) => {
      const dock = dockRef.current;
      if (dock === null) return;
      const box = el.getBoundingClientRect();
      setHovered({
        kind,
        id,
        center: box.top + box.height / 2 - dock.getBoundingClientRect().top,
      });
      if (kind === "tab") engine.peek(id);
    },
    [engine],
  );

  /** The More card up — `pinned`, it stays until a press elsewhere or Escape. */
  const showMore = (pinned: boolean): void => {
    window.clearTimeout(moreTimer.current);
    const button = moreButtonRef.current;
    const dock = dockRef.current;
    if (button !== null && dock !== null) setMoreFoot(button.getBoundingClientRect().bottom - dock.getBoundingClientRect().top);
    setHovered(null);
    setMore((current) => ({ pinned: pinned || current?.pinned === true }));
  };
  /** The pointer left the card or its button: unless it comes back (or the card is pinned, or a press is held in it), the card goes. */
  const hideMoreSoon = (): void => {
    window.clearTimeout(moreTimer.current);
    moreTimer.current = window.setTimeout(() => {
      if (morePressed.current || moreRef.current?.matches(":hover") === true || moreButtonRef.current?.matches(":hover") === true) return;
      setMore((current) => (current?.pinned === true ? current : null));
    }, MORE_LINGER_MS);
  };
  /** One of the card's actions was chosen: it goes at once. */
  const fromMore = (action: () => void): (() => void) => () => {
    window.clearTimeout(moreTimer.current);
    setMore(null);
    action();
  };

  const attachGhost = useCallback((el: HTMLDivElement | null) => engine.attachGhost(el), [engine]);
  const hoveredTab = hovered?.kind !== "tab" ? null : (tabs.find((tab) => tab.id === hovered.id) ?? null);

  // A tab's icon under the pointer: ⇧⌫ closes the tab. The keyboard is as
  // often a page's as the shell's, so main takes the key from whichever view
  // has it while the engine says an icon is hovered, and says when it is struck.
  // (Not while a group's name is typed, whose ⇧⌫ is the field's.)
  const closable = hoveredTab !== null && inside && !busy && !menuOpen && renaming === null && !view.dockAside ? hoveredTab.id : null;
  useEffect(() => {
    engine.setDockHover(closable !== null);
    if (closable === null) return;
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      if (input === "close") void useAppStore.getState().closeTab(closable);
    });
    return () => offPage?.();
  }, [engine, closable]);
  useEffect(() => () => engine.setDockHover(false), [engine]);
  // (Chosen, a group is the desk's own: no card for it.)
  const hoveredGroup = hovered?.kind === "group" && hovered.id !== group.id ? hovered.id : null;
  const dockHeight = dockRef.current?.clientHeight ?? 0;
  const previewShown = hovered !== null && peeking && view.clearCovers.has("preview");
  // (Looked for among all the tabs: let go into another group, it is that group's before it lands.)
  const draggedTab = useAppStore((state) => (view.iconDrag === null ? null : (state.snapshot?.tabs.find((tab) => tab.id === view.iconDrag) ?? null)));
  /**
   * A tab's icon right-clicked: what the desk does with its window, then
   * the sidebar's menu for the tab.
   */
  const openTabMenu = (tabId: string, event: React.MouseEvent): void => {
    event.preventDefault();
    const tab = chromeTabs(useAppStore.getState().snapshot).find((candidate) => candidate.id === tabId);
    if (tab === undefined || busy) return;
    setHovered(null);
    const out = view.windows.find((window) => window.tabId === tabId && window.flight !== "away");
    const deskEntries: MenuEntry[] =
      out === undefined
        ? [{ label: "Open on the desk", icon: <AppWindow aria-hidden="true" />, onSelect: () => engine.add(tabId, { focus: true }) }]
        : [
            ...(out.focused ? [] : [{ label: "Bring to front", icon: <ArrowUpToLine aria-hidden="true" />, onSelect: () => engine.add(tabId, { focus: true }) }]),
            { label: "Put away", icon: <Minus aria-hidden="true" />, onSelect: () => engine.putAway(tabId) },
          ];
    menu.open(event, [...deskEntries, { separator: true }, ...tabMenu(tab)]);
  };
  /** Another group's icon right-clicked: the sidebar's menu for the group. */
  const openGroupMenu = (groupId: string, event: React.MouseEvent): void => {
    event.preventDefault();
    const target = useAppStore.getState().snapshot?.tabGroups.find((candidate) => candidate.id === groupId);
    if (target === undefined || busy) return;
    setHovered(null);
    menu.open(event, groupMenu(target));
  };
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
            // Clear of the window's buttons over the column's top, and as far from its foot: centred still.
            top: view.dockClear,
            bottom: view.dockClear,
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
            <div
              key={group.id}
              className="desk-dock-icons"
              role="list"
              data-fresh={group.id === firstGroup ? undefined : ""}
              data-reordering={reordering ? "" : undefined}
            >
              {shownTabs.map((tab, index) => (
                <DockIcon
                  key={tab.id}
                  index={index}
                  tab={tab}
                  onDesk={onDesk.has(tab.id)}
                  focused={focused === tab.id}
                  inHand={view.iconDrag === tab.id}
                  leaving={view.dockDrag?.kind === "tab" && view.dockDrag.id === tab.id && view.dockDrag.into !== null}
                  shift={dockShift(view.dockDrag, "tab", tab.id)}
                  engine={engine}
                  working={agentTabId === tab.id}
                  onHover={onHover}
                  onMenu={openTabMenu}
                />
              ))}
            </div>
            {/* The group's context, between its tabs and the other groups (docs/desk-agent.md §1). */}
            <div className="desk-dock-stack" onPointerEnter={() => setHovered(null)}>
              <StackTile
                group={group}
                context={context}
                open={stackOpen}
                onRejected={(line) => {
                  setStackRejection(line);
                  // What could not be taken is said on the card: it opens to say so.
                  if (line !== null && dockRef.current !== null) {
                    const tile = dockRef.current.querySelector<HTMLElement>("[data-testid='desk-stack']");
                    if (tile !== null) setStack({ center: tile.getBoundingClientRect().top + tile.offsetHeight / 2 - dockRef.current.getBoundingClientRect().top });
                  }
                }}
                onToggle={(el) => {
                  const dock = dockRef.current;
                  if (stackOpen || dock === null) {
                    setStack(null);
                    return;
                  }
                  setHovered(null);
                  setMore(null);
                  const box = el.getBoundingClientRect();
                  setStack({ center: box.top + box.height / 2 - dock.getBoundingClientRect().top });
                }}
              />
            </div>
            <div className="desk-dock-lower">
              <DockGroups groupId={group.id} view={view} engine={engine} onHover={onHover} onChoose={() => setHovered(null)} onMenu={openGroupMenu} />
              <TooltipProvider delay={TIP_DELAY_MS}>
                {/* Off the icons, there is no preview to show. */}
                <div ref={toolsRef} className="desk-dock-tools" onPointerEnter={() => setHovered(null)}>
                  <span className="desk-dock-divider" aria-hidden="true" />
                  {/* Main makes it in the group and selects it: the desk brings the selected tab out (activeChanged). */}
                  <DockButton
                    label="New tab"
                    testId="desk-new-tab"
                    tip={toolTip("New tab")}
                    onClick={() => void useAppStore.getState().tabGroupCommand({ type: "newTab", groupId: group.id })}
                  >
                    <Plus aria-hidden="true" />
                  </DockButton>
                  {/* No tooltip: its card, beside it, is what it says. A click pins the card up (the keyboard's way in). */}
                  <button
                    ref={moreButtonRef}
                    type="button"
                    aria-label="More"
                    aria-expanded={moreOpen}
                    aria-pressed={moreOpen}
                    data-testid="desk-more"
                    className="desk-dock-button"
                    // A press leaves the keyboard where it was (a window's page).
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerEnter={() => {
                      if (!busy && !menuOpen) showMore(false);
                    }}
                    onPointerLeave={hideMoreSoon}
                    onClick={() => (more?.pinned === true ? setMore(null) : showMore(true))}
                  >
                    <Ellipsis aria-hidden="true" />
                  </button>
                </div>
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
        {hoveredGroup === null ? null : (
          <DockGroupCard
            key={hoveredGroup}
            groupId={hoveredGroup}
            engine={engine}
            center={hovered!.center}
            dockHeight={dockHeight}
            shown={previewShown}
          />
        )}
        {renaming === null ? null : (
          <DockRename
            key={renaming}
            groupId={renaming}
            engine={engine}
            dockRef={dockRef}
            shown={view.clearCovers.has("rename")}
            onDone={() => setRenaming(null)}
          />
        )}
        {stackOpen ? (
          <StackCard
            ref={stackRef}
            group={group}
            context={context}
            others={otherContexts}
            center={stack.center}
            dockHeight={dockHeight}
            shown={view.clearCovers.has("stack")}
            rejection={stackRejection}
            onRejected={setStackRejection}
          />
        ) : null}
        {moreOpen ? (
          <DockMoreCard
            ref={moreRef}
            shown={view.clearCovers.has("more")}
            // Its foot level with the More button's (or, too tall for that, its top 8px down the dock).
            foot={Math.max(8, Math.min(dockHeight - moreFoot, dockHeight - moreHeight - 8))}
            onPointerEnter={() => window.clearTimeout(moreTimer.current)}
            onPointerLeave={() => {
              if (!morePressed.current) hideMoreSoon();
            }}
            onPointerDown={() => {
              morePressed.current = true;
            }}
            onTile={fromMore(() => engine.arrange("tile", tabIds))}
            onCascade={fromMore(() => engine.arrange("cascade", tabIds))}
            onLeave={fromMore(() => useDeskStore.getState().leave())}
          />
        ) : null}
      </aside>
      <DropRail engine={engine} drops={view.drops} shown={carrying && view.dropsShown} drop={carrying ? view.dockDrop : null} />
      {menu.menu}
      {/* The icon in hand, above everything on the desk (the engine moves it). */}
      <div ref={attachGhost} className="desk-dock-ghost" aria-hidden="true">
        {draggedTab !== null ? <AppIcon tab={draggedTab} /> : view.groupDrag !== null ? <GroupGhost groupId={view.groupDrag} /> : null}
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
  index,
  tab,
  onDesk,
  focused,
  inHand,
  leaving,
  shift,
  engine,
  working,
  onHover,
  onMenu,
}: {
  /** Its place in the dock: a group's tabs come in one after another. */
  index: number;
  tab: BrowserTabInfo;
  onDesk: boolean;
  focused: boolean;
  inHand: boolean;
  /** In hand over another group's icon: let go, it leaves the dock for that group. */
  leaving: boolean;
  /** Making room for an icon in hand (dockShift). */
  shift: number;
  engine: DeskEngine;
  /** The agent is working in this tab: its icon wears the agent's ring, phased on the wall clock like every other. */
  working: boolean;
  onHover: DockHover;
  onMenu: DockMenu;
}) {
  const attach = useCallback((el: HTMLSpanElement | null) => engine.attachIcon(tab.id, el), [engine, tab.id]);
  const title = tab.title || displayHost(tab.url) || "Untitled";
  const ringDelay = useMemo(() => (working ? `${String(agentRingDelayMs(Date.now()))}ms` : undefined), [working]);
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
      data-leaving={leaving ? "" : undefined}
      data-agent={working ? "" : undefined}
      className="desk-dock-item"
      style={{ "--i": index, translate: shift === 0 ? undefined : `0 ${shift}px` } as CSSProperties}
      onPointerEnter={(event) => onHover("tab", tab.id, event.currentTarget)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        engine.pressIcon(tab.id, event);
      }}
      onContextMenu={(event) => onMenu(tab.id, event)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        engine.add(tab.id, { focus: true });
      }}
    >
      <span className="desk-dock-dot" aria-hidden="true" />
      <span ref={attach} className={cn("desk-dock-tile", working && "agent-ring agent-ring-mark desk-dock-tile-ring")} style={{ "--agent-ring-delay": ringDelay } as CSSProperties}>
        <AppIcon tab={tab} />
      </span>
    </div>
  );
}

/** A group's tabs, in its order (the store shares structure: the same objects while they are unchanged). */
function tabsOf(snapshot: ShellSnapshot | null, tabIds: readonly string[]): readonly BrowserTabInfo[] {
  if (snapshot === null) return NO_TABS;
  const byId = new Map(snapshot.tabs.map((tab) => [tab.id, tab]));
  return tabIds.map((tabId) => byId.get(tabId)).filter((tab): tab is BrowserTabInfo => tab !== undefined);
}

/** An icon came under the pointer: its preview (a tab's) or card (a group's) shows beside it. */
type DockHover = (kind: "tab" | "group", id: string, el: HTMLElement) => void;
/** An icon right-clicked (a tab's, or another group's): its menu, where the pointer is. */
type DockMenu = (id: string, event: React.MouseEvent) => void;

/**
 * How far an icon moves to make room for the one in hand in its section
 * (DeskView.dockDrag), in px: a place up or down for those between where
 * the icon in hand was and where it would go (it goes there too, unseen:
 * its place is the gap). A tab's icon over another group leaves its
 * section, which closes up behind it.
 */
function dockShift(drag: DockDragView | null, kind: "tab" | "group", id: string): number {
  if (drag === null || drag.kind !== kind) return 0;
  const at = drag.order.indexOf(id);
  const from = drag.order.indexOf(drag.id);
  if (at < 0 || from < 0) return 0;
  if (drag.to === null) return drag.into !== null && at > from ? -drag.pitch : 0;
  if (at === from) return (drag.to - from) * drag.pitch;
  if (drag.to > from && at > from && at <= drag.to) return -drag.pitch;
  if (drag.to < from && at >= drag.to && at < from) return drag.pitch;
  return 0;
}

/**
 * The Space's other tab groups, under the group's tabs, in the order the
 * sidebar lists them: each as the sidebar draws a group — a small pile of
 * its tabs' icons (FaviconCluster) — made large, on a tile in the group's
 * colour. Under the pointer, its card shows beside it (DockGroupCard), and
 * its tabs' pictures are fetched, so the card shows them and its windows
 * come out as themselves; a click passes the desk to it (the engine's
 * chooseGroup). Dragged up or down, it moves among the groups, the others
 * making room for it; a tab's icon let go on it goes into the group.
 */
function DockGroups({
  groupId,
  view,
  engine,
  onHover,
  onChoose,
  onMenu,
}: {
  groupId: string;
  view: DeskView;
  engine: DeskEngine;
  onHover: DockHover;
  onChoose: () => void;
  onMenu: DockMenu;
}) {
  const groups = useAppStore(
    useShallow((state) =>
      state.snapshot === null ? NO_GROUPS : groupsInRowOrder(state.snapshot.tabGroups.filter((candidate) => candidate.id !== groupId), state.snapshot.tabs),
    ),
  );
  // In the order a drop in the dock made, until the browser's says the same.
  const shown = settledOrder(groups, view.dockSettle?.groups ?? null, null);
  const drag = view.dockDrag;
  if (shown.length === 0) return null;
  return (
    <>
      <span className="desk-dock-divider" aria-hidden="true" />
      <div
        className="desk-dock-groups"
        role="list"
        aria-label="Other tab groups"
        data-testid="desk-dock-groups"
        data-reordering={drag?.kind === "group" ? "" : undefined}
      >
        {shown.map((group) => (
          <DockGroup
            key={group.id}
            group={group}
            inHand={view.groupDrag === group.id}
            target={drag?.into === group.id}
            shift={dockShift(drag, "group", group.id)}
            engine={engine}
            onHover={onHover}
            onChoose={onChoose}
            onMenu={onMenu}
          />
        ))}
      </div>
    </>
  );
}

function DockGroup({
  group,
  inHand,
  target,
  shift,
  engine,
  onHover,
  onChoose,
  onMenu,
}: {
  group: TabGroupInfo;
  /** Its icon is in hand, moved among the groups (its place is the gap). */
  inHand: boolean;
  /** A tab's icon is over it: let go, the tab goes into this group. */
  target: boolean;
  /** Making room for a group's icon in hand (dockShift). */
  shift: number;
  engine: DeskEngine;
  onHover: DockHover;
  onChoose: () => void;
  onMenu: DockMenu;
}) {
  const tabs = useAppStore(useShallow((state) => tabsOf(state.snapshot, group.tabIds)));
  const attach = useCallback((el: HTMLSpanElement | null) => engine.attachGroupIcon(group.id, el), [engine, group.id]);
  const choose = (): void => {
    onChoose();
    engine.chooseGroup(group.id);
  };
  return (
    <div role="listitem" className="desk-dock-group-slot" style={shift === 0 ? undefined : { translate: `0 ${shift}px` }}>
      <button
        type="button"
        aria-label={`${group.title}, ${tabCount(tabs.length)}: open its desk`}
        data-testid="desk-dock-group"
        data-group-id={group.id}
        data-group-color={group.color}
        data-in-hand={inHand ? "" : undefined}
        data-drop-target={target ? "" : undefined}
        className="desk-dock-item desk-dock-group-icon tab-group-tone"
        // A press leaves the keyboard where it was, as the tools' do.
        onMouseDown={(event) => event.preventDefault()}
        // A click passes the desk to it; a drag moves it among the groups.
        onPointerDown={(event) => engine.pressGroup(group.id, event, choose)}
        onContextMenu={(event) => onMenu(group.id, event)}
        onPointerEnter={(event) => {
          engine.peekGroup(group.id, group.tabIds);
          onHover("group", group.id, event.currentTarget);
        }}
        // (A pointer's click is the press's; this is the keyboard's.)
        onClick={(event) => {
          if (event.detail === 0) choose();
        }}
      >
        <GroupTile tabs={tabs} attach={attach} />
      </button>
    </div>
  );
}

/** A group as an icon: its tabs' icons in a small pile, as the sidebar draws a group, made large on a tile in its colour. */
function GroupTile({ tabs, attach }: { tabs: readonly BrowserTabInfo[]; attach?: (el: HTMLSpanElement | null) => void }) {
  return (
    <span ref={attach} className="desk-dock-tile desk-group-tile">
      <span className="desk-group-pile">
        <FaviconCluster tabs={tabs} />
      </span>
    </span>
  );
}

/** Another group's icon in hand: drawn as the dock draws it. */
function GroupGhost({ groupId }: { groupId: string }) {
  const group = useAppStore((state) => state.snapshot?.tabGroups.find((candidate) => candidate.id === groupId) ?? null);
  const tabs = useAppStore(useShallow((state) => tabsOf(state.snapshot, group?.tabIds ?? NO_IDS)));
  if (group === null) return null;
  return (
    <span className="desk-dock-ghost-group tab-group-tone" data-group-color={group.color}>
      <GroupTile tabs={tabs} />
    </span>
  );
}

function tabCount(count: number): string {
  return `${count} ${count === 1 ? "tab" : "tabs"}`;
}

/**
 * Another group's name, edited beside its icon (its menu's Rename, or a
 * group just made that the host could not name): the sidebar's own field,
 * on a card as a preview is. It is drawn over the desk, so it is a cover,
 * seen once no live page is left under it, and the dock stands meanwhile.
 */
function DockRename({
  groupId,
  engine,
  dockRef,
  shown,
  onDone,
}: {
  groupId: string;
  engine: DeskEngine;
  dockRef: React.RefObject<HTMLElement | null>;
  shown: boolean;
  onDone: () => void;
}) {
  const group = useAppStore((state) => state.snapshot?.tabGroups.find((candidate) => candidate.id === groupId) ?? null);
  const tabGroupCommand = useAppStore((state) => state.tabGroupCommand);
  const [top, setTop] = useState<number | null>(null);
  const finished = useRef(false);
  // Level with the group's icon, in the dock.
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const icon = dock?.querySelector<HTMLElement>(`[data-testid="desk-dock-group"][data-group-id="${CSS.escape(groupId)}"]`) ?? null;
    if (dock == null || icon === null) return;
    const box = icon.getBoundingClientRect();
    const middle = box.top + box.height / 2 - dock.getBoundingClientRect().top;
    setTop(Math.max(8, Math.min(dock.clientHeight - RENAME_H - 8, middle - RENAME_H / 2)));
  }, [dockRef, groupId, group]);
  useEffect(() => {
    if (top === null) return;
    engine.setCover("rename", { x: DOCK_W, y: top - 6, w: POPOVER_GAP + RENAME_W + 12, h: RENAME_H + 12 });
    return () => engine.setCover("rename", null);
  }, [engine, top]);
  useEffect(() => {
    engine.holdDock("rename", true);
    return () => engine.holdDock("rename", false);
  }, [engine]);
  // Gone meanwhile (closed, ungrouped): there is nothing to name.
  useEffect(() => {
    if (group === null) onDone();
  }, [group, onDone]);
  if (group === null || top === null) return null;
  const done = (title: string | null): void => {
    if (finished.current) return;
    finished.current = true;
    onDone();
    if (title !== null && title.trim() !== "" && title !== group.title) void tabGroupCommand({ type: "rename", groupId, title });
  };
  return (
    <div
      data-testid="desk-dock-rename"
      data-group-id={groupId}
      data-group-color={group.color}
      data-shown={shown ? "" : undefined}
      className="desk-dock-rename tab-group-tone"
      style={{ left: DOCK_W + POPOVER_GAP, top, width: RENAME_W, height: RENAME_H }}
    >
      <span className="desk-sketch-swatch" aria-hidden="true" />
      <GroupTitleInput title={group.title} onDone={done} />
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

/**
 * Another group's card, beside its icon: its desk drawn small, as it would
 * come out were the desk passed to it now (the engine's sketchGroup) — each
 * window where it was left, framed, with the latest picture of its page,
 * the one it would come up on on top in the group's colour; and under it,
 * the group's name and how many of its tabs are out.
 */
function DockGroupCard({
  groupId,
  engine,
  center,
  dockHeight,
  shown,
}: {
  groupId: string;
  engine: DeskEngine;
  center: number;
  dockHeight: number;
  shown: boolean;
}) {
  const group = useAppStore((state) => state.snapshot?.tabGroups.find((candidate) => candidate.id === groupId) ?? null);
  const tabs = useAppStore(useShallow((state) => tabsOf(state.snapshot, group?.tabIds ?? NO_IDS)));
  const saved = useDeskStore((state) => state.saved[groupId]?.windows ?? NO_WINDOWS);
  const chrome = useDeskStore((state) => state.variants.chrome);
  if (group === null) return null;
  // Drawn again with the dock, whenever the desk's view changes — its pictures coming in among it.
  const sketch = engine.sketchGroup(
    tabs.map((tab) => tab.id),
    saved,
    passedEntry(saved, tabs),
  );
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  // The desk's shape, SKETCH_W wide — or, too tall or too flat for that, as near as the bounds allow, centred.
  const boxH = sketch.width > 0 ? Math.round(Math.min(SKETCH_MAX_H, Math.max(SKETCH_MIN_H, (SKETCH_W * sketch.height) / sketch.width))) : SKETCH_MIN_H;
  const scale = sketch.width > 0 && sketch.height > 0 ? Math.min(SKETCH_W / sketch.width, boxH / sketch.height) : 0;
  const height = CARD_PAD + boxH + CARD_CAPTION_H;
  const top = Math.max(8, Math.min(Math.max(8, dockHeight - height - 8), center - height / 2));
  return (
    <div
      aria-hidden="true"
      data-testid="desk-dock-group-card"
      data-group-id={group.id}
      data-group-color={group.color}
      data-shown={shown ? "" : undefined}
      className="desk-dock-preview tab-group-tone"
      style={{
        left: DOCK_W + POPOVER_GAP,
        top,
        width: GROUP_CARD_W,
        height,
      }}
    >
      <span className="desk-dock-preview-tail" style={{ top: center - top }} />
      <div className="desk-sketch-box" style={{ height: boxH }}>
        {scale === 0 ? null : (
          <div className="desk-sketch" data-testid="desk-sketch" style={{ width: sketch.width * scale, height: sketch.height * scale }}>
            {sketch.windows.map((window) => (
              <SketchWindow key={window.tabId} window={window} tab={byId.get(window.tabId) ?? null} chrome={chrome} scale={scale} />
            ))}
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 px-2.5 pt-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 font-medium text-gray-1000">
          <span className="desk-sketch-swatch" aria-hidden="true" />
          <span className="truncate">{group.title}</span>
        </span>
        <span className="truncate text-[11px] leading-4 text-gray-700">
          {tabCount(tabs.length)} · {sketch.windows.length} on its desk
        </span>
      </div>
    </div>
  );
}

/** One window of a group's sketch: its frame as the desk draws it (the frame style's insets, scaled), its page's picture inside. */
function SketchWindow({ window, tab, chrome, scale }: { window: DeskSketchWindow; tab: BrowserTabInfo | null; chrome: DeskChrome; scale: number }) {
  const masked = window.mask !== null;
  const insets = masked ? MASK_INSETS : CHROME_INSETS[chrome];
  const cardTop = masked ? MASK_CARD_TOP : CHROME_CARD_TOP[chrome];
  const { rect } = window;
  return (
    <div
      className="desk-sketch-window"
      data-testid="desk-sketch-window"
      data-tab-id={window.tabId}
      data-focused={window.focused ? "" : undefined}
      data-masked={masked ? "" : undefined}
      style={{ left: rect.x * scale, top: rect.y * scale, width: rect.w * scale, height: rect.h * scale }}
    >
      <div className="desk-sketch-card" style={{ top: cardTop * scale }}>
        <div
          className="desk-sketch-page"
          style={{
            top: (insets.top - cardTop) * scale,
            left: insets.left * scale,
            right: insets.right * scale,
            bottom: insets.bottom * scale,
          }}
        >
          {tab === null ? null : <SketchPage tab={tab} window={window} />}
        </div>
      </div>
    </div>
  );
}

/** What a sketched window's page shows: its picture (a masked one's region), or — a shell page, asleep, never pictured — its app icon. */
function SketchPage({ tab, window }: { tab: BrowserTabInfo; window: DeskSketchWindow }) {
  const { still, mask, stillShows } = window;
  if (pageKind(tab.url) === null && still !== null) {
    if (mask === null && stillShows !== "none") return <img className="desk-still" src={still} alt="" draggable={false} />;
    if (mask !== null && stillShows === "region") return <img className="desk-still" data-fill="" src={still} alt="" draggable={false} />;
    if (mask !== null && stillShows === "page") return <img className="desk-still-crop" src={still} alt="" draggable={false} style={cropStyle(mask)} />;
  }
  return (
    <span className="desk-sketch-empty">
      <AppIcon tab={tab} />
    </span>
  );
}

/**
 * The More card, beside the dock's More button: the arrangements (each with
 * its keyboard shortcut, from Settings), the variants this experiment is
 * for (Feel), and the way out. Drawn over the desk, so it is a cover, seen
 * once no live page is under it.
 */
function DockMoreCard({
  ref,
  shown,
  foot,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onTile,
  onCascade,
  onLeave,
}: {
  ref: React.Ref<HTMLDivElement>;
  shown: boolean;
  /** From the dock's foot to the card's. */
  foot: number;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  onTile: () => void;
  onCascade: () => void;
  onLeave: () => void;
}) {
  const tile = useAppStore((state) => shortcutLabel(state.settings.shortcuts.tileDesk, PLATFORM));
  const cascade = useAppStore((state) => shortcutLabel(state.settings.shortcuts.cascadeDesk, PLATFORM));
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="More"
      data-testid="desk-more-card"
      data-shown={shown ? "" : undefined}
      className="desk-dock-menu desk-dock-more"
      style={{ left: DOCK_W + POPOVER_GAP, bottom: foot }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
    >
      <MoreItem label="Tile the windows" hint={tile} testId="desk-tile" onClick={onTile}>
        <LayoutGrid aria-hidden="true" />
      </MoreItem>
      <MoreItem label="Cascade the windows" hint={cascade} testId="desk-cascade" onClick={onCascade}>
        <Layers2 aria-hidden="true" />
      </MoreItem>
      <span className="desk-more-divider" aria-hidden="true" />
      <div role="group" aria-label="Feel" data-testid="desk-variants" className="flex flex-col gap-px">
        <div className="px-1.5 pt-0.5 pb-1 text-[10.5px] font-semibold tracking-wide text-gray-700 uppercase">Feel</div>
        {DESK_AXES.map((axis) => (
          <Fragment key={axis.key}>
            <VariantRow axisKey={axis.key} label={axis.label} />
            {/* Glide's own setting, under the throw it belongs to. */}
            {axis.key === "physics" ? <DecelerationRow /> : null}
          </Fragment>
        ))}
      </div>
      <span className="desk-more-divider" aria-hidden="true" />
      <MoreItem label="Leave the desk" testId="desk-leave" onClick={onLeave}>
        <X aria-hidden="true" />
      </MoreItem>
    </div>
  );
}

/** One of the More card's actions: its icon, its words, and its shortcut if it has one. */
function MoreItem({ label, hint, testId, onClick, children }: { label: string; hint?: string | null; testId: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-[12px] text-gray-1000 outline-none transition-colors duration-150 hover:bg-alpha-100 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-gray-900"
    >
      {children}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint === undefined || hint === null ? null : <Kbd small>{hint}</Kbd>}
    </button>
  );
}

/**
 * Glide's deceleration: how quickly a thrown window slows, as the share of
 * its speed it loses every 100 ms. Only a Glide throw coasts, so it waits,
 * dimmed, under any other.
 */
function DecelerationRow() {
  const deceleration = useDeskStore((state) => state.variants.deceleration);
  const glide = useDeskStore((state) => state.variants.physics === "glide");
  return (
    <div
      data-testid="desk-variant-deceleration"
      data-value={deceleration}
      title={glide ? "How quickly a thrown window slows down: the share of its speed it loses every 100 ms" : "Only a Glide throw coasts: choose Glide above"}
    >
      <Slider
        label="Deceleration"
        value={deceleration}
        min={GLIDE_DECELERATION.min}
        max={GLIDE_DECELERATION.max}
        disabled={!glide}
        onChange={(value) => useDeskStore.getState().setVariant("deceleration", value)}
        className={cn("grid-cols-[76px_minmax(60px,1fr)_30px] gap-2 px-1.5 py-1", !glide && "opacity-60")}
        labelClassName="text-[12px] text-gray-700"
      />
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
function VariantRow({ axisKey, label }: { axisKey: DeskAxisKey; label: string }) {
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
      <span className="w-[76px] shrink-0 text-left text-gray-700">{label}</span>
      <span key={option.id} className="desk-variant-value min-w-0 flex-1 truncate text-left font-medium text-gray-1000">
        {option.label}
      </span>
      <ChevronsUpDown aria-hidden="true" className="size-3 shrink-0 text-gray-600 group-hover/variant:text-gray-900" />
    </button>
  );
}
