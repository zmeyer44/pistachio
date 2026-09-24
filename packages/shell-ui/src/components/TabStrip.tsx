import { Fragment, useId, useMemo, useRef, useState } from "react";
import { MAX_TAB_GROUP_TITLE, tabGroupOf, type TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { useAction } from "../chrome/actions";
import { useShell } from "../chrome/shell-host";
import { NEW_TAB_FLIP_ID, useTabDrag } from "../chrome/tab-drag";
import { useNewGroupNaming, useTabGroupMenu } from "../chrome/tab-group-menu";
import { useTabMenu } from "../chrome/tab-menu";
import { ActiveTabLabel, TabNavCluster, TabReaderMark, TabTitle, TabTrailing, type TabActionId } from "../chrome/tab-parts";
import { rowItems, useChromeTabs, type ChromeTab, type RowItem } from "../chrome/tabs";
import { cn } from "../lib/cn";
import { folderOutline, n } from "../lib/folder";
import { useMeasuredWidth } from "../lib/measure";
import { prettyUrl } from "../lib/url";
import { useAppStore } from "../store";
import { useContextMenu } from "./ContextMenu";
import { TabMark } from "./Favicon";
import { SiteInfoButton } from "./SiteInfoPopover";

/**
 * The horizontal tab row of the top layout — the `tabs` feature in its
 * horizontal orientation (chrome/manifest-renderers.tsx). Tabs hold their position —
 * selecting one never moves it — and any tab can be dragged to reorder, with
 * the tabs it passes sliding (FLIP-animated) into their new slots. A drag
 * never leaves the row: it is clamped to the tabs' own span. Dragging one
 * DOWN out of the strip instead live-previews the nearest page edge as a new
 * pane, and releasing puts the tab into that proposed split
 * (chrome/tab-drag.ts). The active tab doubles as the omnibox: it shows the
 * page title at rest and cross-fades to its address on hover. The active tab
 * is a manila-folder silhouette — rounded top corners, sides tapering ~4°
 * outward, and concave bottom flares — drawn as an SVG path so it merges
 * seamlessly into the chrome panel below.
 *
 * The strip's own chrome — the 40px drag region, its bottom hairline, the
 * traffic-light pad — is the layout's (layouts/TopLayout.tsx); this is the
 * FLIP container and what lives in it. The parts a tab shares with the
 * vertical list are in chrome/tab-parts.tsx; only the row-shaped pieces
 * (the folder, the hover fills, the separator) stay here.
 *
 * The tab is 34px on a 40px strip — Chrome's own tab metrics. Every other
 * dimension is derived from those two: the folder's radii follow
 *   top radius ≈ 0.35·H, flare radius ≈ 0.26·H, side taper ≈ 0.07·H.
 */
const TAB_H = 34;
const FLARE = 9;
const RADIUS = 12;
const TAPER = 2.5;
const FOLDER = { h: TAB_H, flare: FLARE, radius: RADIUS, taper: TAPER };

/** The folder-shaped backdrop behind the active tab; flares overflow FLARE per side. */
function FolderShell() {
  const [ref, width] = useMeasuredWidth();
  const gradientId = useId();

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute bottom-0"
      style={{ left: -FLARE, right: -FLARE, height: TAB_H }}
    >
      {width > 0 ? (
        <svg width={width} height={TAB_H} className="folder-drop absolute inset-0 overflow-visible">
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              {/* style, not stopColor: var() only resolves through CSS. */}
              <stop offset="0" style={{ stopColor: "var(--color-background-100)" }} />
              <stop offset="0.6" style={{ stopColor: "var(--color-background-100)" }} />
            </linearGradient>
          </defs>
          <path d={`${folderOutline(width, FOLDER)} Z`} fill={`url(#${gradientId})`} />
          {/* The same hairline that edges the strip and the pane cards (alpha-400,
              --shadow-border): the silhouette should continue that line, not
              outweigh it. */}
          <path d={folderOutline(width, FOLDER)} fill="none" stroke="var(--color-alpha-400)" strokeWidth="1" />
        </svg>
      ) : null}
    </div>
  );
}

const HOVER_H = 28;
/** Same 0.35·H the folder's top corners use, at the raised fill's height. */
const HOVER_R = 10;
/** Visual gap between the active tab's silhouette and an adjacent raised fill. */
const GAP = 5;

/**
 * Raised-fill outline for a tab that sits right beside the active tab. The
 * near edge runs parallel to the active tab's taper at a constant GAP, and
 * both of its ends are tangent fillets, so every transition is smoothly
 * rounded. The far side keeps the plain rounded-rect corners.
 */
function hoverAdjacentPath(w: number, side: "left" | "right"): string {
  const R = HOVER_R;
  const RT = RADIUS;
  const RB = HOVER_R;
  const DY = TAB_H - RADIUS - FLARE;
  const len = Math.hypot(TAPER, DY);
  const nx = DY / len;
  const ny = -TAPER / len;
  const xAt = (y: number) => GAP - (TAPER * (HOVER_H - 1 - y)) / DY;
  const tpY = RT * (1 - ny);
  const tpX = xAt(tpY);
  const tcX = tpX + nx * RT;
  const bpY = HOVER_H - RB * (1 + ny);
  const bpX = xAt(bpY);
  const bcX = bpX + nx * RB;
  if (side === "left") {
    return [
      `M${n(bcX)} ${HOVER_H}`,
      `A${RB} ${RB} 0 0 1 ${n(bpX)} ${n(bpY)}`,
      `L${n(tpX)} ${n(tpY)}`,
      `A${RT} ${RT} 0 0 1 ${n(tcX)} 0`,
      `L${n(w - R)} 0`,
      `A${R} ${R} 0 0 1 ${w} ${R}`,
      `L${w} ${HOVER_H - R}`,
      `A${R} ${R} 0 0 1 ${n(w - R)} ${HOVER_H}`,
      "Z",
    ].join(" ");
  }
  return [
    `M${n(w - bcX)} ${HOVER_H}`,
    `A${RB} ${RB} 0 0 0 ${n(w - bpX)} ${n(bpY)}`,
    `L${n(w - tpX)} ${n(tpY)}`,
    `A${RT} ${RT} 0 0 0 ${n(w - tcX)} 0`,
    `L${R} 0`,
    `A${R} ${R} 0 0 0 0 ${R}`,
    `L0 ${HOVER_H - R}`,
    `A${R} ${R} 0 0 0 ${R} ${HOVER_H}`,
    "Z",
  ].join(" ");
}

/** Hover backdrop for tabs bordering the active tab; the svg toggles on group-hover. */
function HoverShell({ side }: { side: "left" | "right" }) {
  const [ref, width] = useMeasuredWidth();
  const gradientId = useId();

  return (
    <div ref={ref} aria-hidden="true" className="pointer-events-none absolute inset-0">
      {width > 0 ? (
        <svg width={width} height={HOVER_H} className="absolute inset-0 hidden overflow-visible group-hover:block">
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style={{ stopColor: "var(--color-black)" }} stopOpacity="0.05" />
              <stop offset="1" style={{ stopColor: "var(--color-black)" }} stopOpacity="0.10" />
            </linearGradient>
          </defs>
          <path d={hoverAdjacentPath(width, side)} fill={`url(#${gradientId})`} />
        </svg>
      ) : null}
    </div>
  );
}

/**
 * Hairline between two adjacent inactive tabs, drawn on the RIGHT edge of the
 * left tab of the pair; it vanishes while either neighbour is hovered.
 */
function TabSeparator() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 right-0 h-4 w-px -translate-y-1/2 bg-alpha-300 transition-opacity duration-150 group-hover:opacity-0 [:has(+*:hover)>&]:opacity-0"
    />
  );
}

function Tab({
  tab,
  activeSide,
  separator = false,
  dragging = false,
  onActivate,
  onEditAddress,
  onPointerDown,
  onContextMenu,
}: {
  tab: ChromeTab;
  /** Which side of this tab the active tab sits on, if directly adjacent. */
  activeSide: "left" | "right" | null;
  /** Draw the divider on this tab's right edge — the next tab is inactive too. */
  separator?: boolean;
  /** This tab is the one being dragged: it rides above the row, not with it. */
  dragging?: boolean;
  onActivate: () => void;
  onEditAddress: () => void;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  /** Right-click (or the keyboard's menu key): the tab's menu (chrome/tab-menu.tsx). */
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const closeTab = useAppStore((s) => s.closeTab);

  const inactiveShape =
    activeSide !== null
      ? "text-gray-900 hover:text-gray-1000"
      : "rounded-sm text-gray-900 hover:bg-alpha-200 hover:text-gray-1000";
  const shape = tab.active ? "z-10 h-[34px] pb-[4px] text-gray-1000" : `mb-1.5 h-7 ${inactiveShape}`;

  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={tab.active}
      data-testid={tab.kind === "agent" ? "agent-tab" : "human-tab"}
      data-tab-id={tab.id}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter") onActivate();
      }}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onAuxClick={(e) => {
        if (e.button === 1) void closeTab(tab.id);
      }}
      title={`${tab.title || tab.url}\n${prettyUrl(tab.url)}`}
      data-flip-id={tab.id}
      className={cn(
        "no-drag group relative flex items-center",
        dragging ? "z-30 cursor-grabbing touch-none" : "cursor-pointer touch-none",
        tab.active ? "min-w-[176px] max-w-[240px] flex-1 pr-2 pl-2.5" : "min-w-[88px] max-w-[240px] flex-1 pr-2 pl-3",
        tab.kind === "agent" && !tab.active && "text-green-900",
        shape,
      )}
    >
      {tab.active ? <FolderShell /> : null}
      {!tab.active && activeSide !== null ? <HoverShell side={activeSide} /> : null}
      {separator ? <TabSeparator /> : null}
      <span className="relative flex min-w-0 flex-1 items-center gap-2 self-stretch">
        {/* The active tab is the omnibox, so Chrome's site-info button leads it (the `siteInfo` feature). */}
        {tab.active ? <SiteInfoButton variant="tab" /> : null}
        {tab.active ? <TabNavCluster tab={tab} /> : <TabMark tab={tab} />}
        <TabReaderMark tab={tab} />
        {tab.active ? (
          <ActiveTabLabel tab={tab} onEdit={onEditAddress} />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[12.5px]">
            <TabTitle tab={tab} />
          </span>
        )}
        <TabTrailing tab={tab} />
      </span>
    </div>
  );
}

/** One pane inside the fused split tab — its own hover group. */
function SplitPane({
  tab,
  focused,
  omit = [],
  onActivate,
  onEditAddress,
  onContextMenu,
}: {
  tab: ChromeTab;
  /** This half is the active tab (the window-level keys go to it). */
  focused: boolean;
  /** Per-tab actions this half does not carry. */
  omit?: readonly TabActionId[];
  onActivate: () => void;
  onEditAddress: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const closeTab = useAppStore((s) => s.closeTab);

  return (
    <span
      role="tab"
      tabIndex={0}
      aria-selected={focused}
      data-testid={tab.kind === "agent" ? "agent-tab" : "human-tab"}
      data-tab-id={tab.id}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter") onActivate();
      }}
      onContextMenu={onContextMenu}
      onAuxClick={(e) => {
        if (e.button === 1) void closeTab(tab.id);
      }}
      title={`${tab.title || tab.url}\n${prettyUrl(tab.url)}`}
      className={cn(
        "group relative flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-[7px] px-1.5",
        focused ? "text-gray-1000" : "text-gray-900 hover:text-gray-1000",
      )}
    >
      {/* Site controls describe the active tab, so only the focused half carries the button. */}
      {focused ? <SiteInfoButton variant="tab" /> : null}
      <TabNavCluster tab={tab} />
      <TabReaderMark tab={tab} />
      <ActiveTabLabel tab={tab} onEdit={onEditAddress} />
      <TabTrailing tab={tab} omit={omit} />
    </span>
  );
}

/**
 * A split view as ONE extended tab, with 2–4 segments in pane order. Every
 * segment remains independently focusable while the final one carries the
 * control that dissolves the whole group.
 */
function SplitTab({
  flipId,
  tabs,
  dragging = false,
  onActivate,
  onEditAddress,
  onPointerDown,
  onContextMenu,
}: {
  flipId: string;
  tabs: ChromeTab[];
  dragging?: boolean;
  onActivate: (tabId: string) => void;
  onEditAddress: (tabId: string) => void;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onContextMenu: (tabId: string, e: React.MouseEvent) => void;
}) {
  return (
    <div
      role="group"
      aria-label={`Split view: ${tabs.map((tab) => tab.title || "tab").join(", ")}`}
      onPointerDown={onPointerDown}
      data-flip-id={flipId}
      data-split-group-id={flipId}
      style={{ minWidth: Math.min(640, Math.max(264, tabs.length * 132)), flexGrow: tabs.length }}
      className={cn(
        "no-drag relative flex h-[34px] max-w-[720px] items-center px-1 pb-[4px] text-gray-1000",
        dragging ? "z-30 cursor-grabbing touch-none" : "z-10 cursor-pointer touch-none",
      )}
    >
      <FolderShell />
      {tabs.map((tab, index) => (
        <Fragment key={tab.id}>
          {index > 0 ? <span aria-hidden="true" className="relative mx-0.5 h-5 w-px shrink-0 self-center bg-alpha-300" /> : null}
          <SplitPane
            tab={tab}
            focused={tab.active}
            omit={index === tabs.length - 1 ? [] : ["split"]}
            onActivate={() => onActivate(tab.id)}
            onEditAddress={() => onEditAddress(tab.id)}
            onContextMenu={(e) => onContextMenu(tab.id, e)}
          />
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The row's tail: the + button, and — revealed when the pointer reaches it —
 * a second button that opens the agent chat instead of a new page. The second
 * slot is ALWAYS in layout, invisible and inert at rest: the strip FLIP-animates
 * tabs from their layout offset, so a cluster that changed width on hover would
 * leave every tab's recorded position stale. Both are registry actions: the +
 * is ⌘T, the sparkle opens Pistachio.
 */
function NewTabCluster() {
  const newTab = useAction("newTab");
  const delegate = useAction("delegate");

  return (
    <div data-flip-id={NEW_TAB_FLIP_ID} className="no-drag group/new mb-1.5 ml-1 flex shrink-0 items-center [&_svg]:size-3.5">
      <button
        type="button"
        title={newTab.hint === null ? newTab.label : `${newTab.label} (${newTab.hint})`}
        aria-label={newTab.label}
        data-testid="new-tab-button"
        onClick={newTab.run}
        className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-sm text-gray-700 hover:bg-alpha-200 hover:text-gray-1000"
      >
        {newTab.icon}
      </button>
      {/* Slides out from behind the + rather than fading in place. The
          transition lists `translate` and `scale`, NOT `transform`: those
          utilities compile to the separate CSS properties of the same name. */}
      <button
        type="button"
        title={`${delegate.label} — work in this browser session`}
        aria-label={delegate.label}
        onClick={delegate.run}
        className="pointer-events-none grid size-7 shrink-0 -translate-x-2 scale-90 cursor-pointer place-items-center rounded-sm text-gray-700 opacity-0 transition-[opacity,translate,scale] duration-200 ease-out group-hover/new:pointer-events-auto group-hover/new:translate-x-0 group-hover/new:scale-100 group-hover/new:opacity-100 hover:bg-alpha-200 hover:text-green-900 focus-visible:pointer-events-auto focus-visible:translate-x-0 focus-visible:scale-100 focus-visible:opacity-100"
      >
        {delegate.icon}
      </button>
    </div>
  );
}

/**
 * The page's box, read as a drag begins. The surface reports it on every
 * layout pass; subscribing would redraw the whole strip each time for a value
 * only the press needs.
 */
const readContentBounds = () => useAppStore.getState().contentBounds;

/**
 * A tab group in the strip (docs/tab-tidy.md §3.3): a chip in the group's
 * colour ahead of its tabs, which stay in the row — the strip has the width
 * for them, where the sidebar folds them away. Its menu is the sidebar
 * group's (chrome/tab-group-menu.tsx). Not a drag slot and not a FLIP
 * element: its tabs are, and they carry it along.
 */
function GroupChip({
  group,
  renaming,
  onRename,
  onContextMenu,
}: {
  group: TabGroupInfo;
  renaming: boolean;
  onRename: (title: string | null) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const [value, setValue] = useState(group.title);
  return (
    <div
      role="group"
      aria-label={`Tab group: ${group.title}`}
      data-testid="tab-group-chip"
      data-group-id={group.id}
      data-group-color={group.color}
      title={`${group.title}\n${String(group.tabIds.length)} ${group.tabIds.length === 1 ? "tab" : "tabs"}`}
      onDoubleClick={() => {
        setValue(group.title);
        onRename(null);
      }}
      onContextMenu={onContextMenu}
      className={cn(
        "tab-group-tone no-drag mr-1 mb-1.5 ml-1.5 flex h-7 max-w-[160px] shrink-0 items-center gap-1.5 rounded-[10px] bg-(--tg-tint) px-2.5 text-[12px] font-medium text-(--tg-text) transition-colors duration-150 hover:bg-(--tg-tint-strong) motion-reduce:transition-none",
        renaming && "bg-(--tg-tint-strong) ring-1 ring-(--tg-solid)/55 ring-inset",
      )}
    >
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-(--tg-solid)" />
      {renaming ? (
        <input
          autoFocus
          aria-label="Group name"
          data-testid="tab-group-name-input"
          value={value}
          maxLength={MAX_TAB_GROUP_TITLE}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => onRename(value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") onRename(value);
            if (e.key === "Escape") onRename(null);
          }}
          spellCheck={false}
          autoComplete="off"
          placeholder="Group name"
          // In place, as the sidebar's is (TabGroupRow's GroupTitleInput): the chip is the field.
          className="h-5 w-24 min-w-0 bg-transparent p-0 text-[12px] font-medium text-(--tg-text) caret-(--tg-solid) outline-none selection:bg-(--tg-solid)/30 selection:text-(--tg-text) placeholder:text-(--tg-text)/45"
        />
      ) : (
        <span className="min-w-0 truncate">{group.naming === true ? <span className="animate-pulse font-normal opacity-70 motion-reduce:animate-none">Naming…</span> : group.title}</span>
      )}
    </div>
  );
}

const NO_TAB_GROUPS: readonly TabGroupInfo[] = [];

/**
 * The tab row: the FLIP container with every slot (a split group is one) and
 * the new-tab tail, plus the split drop zones while a tab is dragged out.
 */
export function TabStrip() {
  const tabs = useChromeTabs();
  const order = useMemo(() => rowItems(tabs), [tabs]);
  const selectTab = useAppStore((s) => s.selectTab);
  const { run } = useShell();

  const tabsRef = useRef<HTMLDivElement>(null);
  const { drag, view, beginPress, justDragged } = useTabDrag({ axis: "x", containerRef: tabsRef, items: order, contentBounds: readContentBounds });
  // The slot under the pointer — grabbed only while the gesture is live, not
  // while a committed drop waits for main to publish the new order.
  const grabbedId = drag !== null && !drag.settling ? drag.id : null;
  // Right-click on a tab: the same menu the sidebar's rows open
  // (chrome/tab-menu.tsx), so no tab operation needs the other layout.
  const menu = useContextMenu();
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const tabMenu = useTabMenu({ onNewGroup: useNewGroupNaming(setRenamingGroup) });
  const tabGroups = useAppStore((s) => s.snapshot?.tabGroups ?? NO_TAB_GROUPS);
  const tabGroupCommand = useAppStore((s) => s.tabGroupCommand);
  const { menu: groupMenu } = useTabGroupMenu({ onRename: setRenamingGroup });
  /** The group each slot's first tab opens, when that tab is the group's first in the row: where its chip goes. */
  const chipBefore = useMemo(() => {
    const chips = new Map<string, TabGroupInfo>();
    const placed = new Set<string>();
    for (const item of view) {
      const first = item.tabs[0];
      const group = first === undefined ? null : tabGroupOf(tabGroups, first.id);
      if (group === null || placed.has(group.id)) continue;
      placed.add(group.id);
      chips.set(item.id, group);
    }
    return chips;
  }, [view, tabGroups]);

  const activate = (tabId: string): void => {
    if (justDragged()) return;
    void selectTab(tabId);
  };
  const editAddress = (tabId: string): void => {
    if (justDragged()) return;
    run({ type: "openUrlBar", tabId });
  };
  const openMenu = (tabId: string, event: React.MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (tab === undefined) return;
    menu.open(event, tabMenu(tab));
  };

  const activeIndex = view.findIndex((i) => i.active);
  const sideOf = (i: number): "left" | "right" | null => {
    if (activeIndex < 0 || i === activeIndex) return null;
    if (i === activeIndex + 1) return "left";
    if (i === activeIndex - 1) return "right";
    return null;
  };
  const separatorAfter = (i: number): boolean => {
    const here = view[i];
    const next = view[i + 1];
    if (grabbedId !== null || here === undefined || next === undefined) return false;
    return !here.active && !next.active;
  };

  return (
    <>
      <div ref={tabsRef} role="tablist" aria-label="Open tabs" className="flex min-w-0 flex-1 items-end">
        {view.map((item: RowItem, i) => {
          const [first] = item.tabs;
          if (first === undefined) return null;
          const group = chipBefore.get(item.id);
          const chip =
            group === undefined ? null : (
              <GroupChip
                key={`chip:${group.id}`}
                group={group}
                renaming={renamingGroup === group.id}
                onRename={(title) => {
                  if (renamingGroup !== group.id) {
                    setRenamingGroup(group.id);
                    return;
                  }
                  setRenamingGroup(null);
                  if (title !== null && title.trim() !== "") void tabGroupCommand({ type: "rename", groupId: group.id, title });
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  menu.open(e, groupMenu(group));
                }}
              />
            );
          const slot = item.tabs.length === 1 ? (
            <Tab
              key={item.id}
              tab={first}
              activeSide={sideOf(i)}
              separator={separatorAfter(i)}
              dragging={grabbedId === item.id}
              onActivate={() => activate(first.id)}
              onEditAddress={() => editAddress(first.id)}
              onPointerDown={(e) => beginPress(item, e)}
              onContextMenu={(e) => openMenu(first.id, e)}
            />
          ) : (
            <SplitTab
              key={item.id}
              flipId={item.id}
              tabs={item.tabs}
              dragging={grabbedId === item.id}
              onActivate={activate}
              onEditAddress={editAddress}
              onPointerDown={(e) => beginPress(item, e)}
              onContextMenu={openMenu}
            />
          );
          return chip === null ? slot : <Fragment key={`group:${item.id}`}>{chip}{slot}</Fragment>;
        })}
        <NewTabCluster />
      </div>
      {menu.menu}
    </>
  );
}
