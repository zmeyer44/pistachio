import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  ChevronRight,
  FolderInput,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  Folder as FolderIcon,
  Layers,
  Pencil,
  Pin,
  PinOff,
  Sparkles,
  Star,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useMediaStackInset } from "./MediaStack";
import {
  childrenOf,
  DEFAULT_SIDEBAR_STATE,
  folderEmoji,
  placeEntry,
  type SidebarEntry,
  type SidebarFolder,
  type SidebarFolderColor,
  type SidebarPin,
} from "@pistachio/shell-contracts/sidebar";
import { dayRowUnits, tabGroupUnitId, type TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { useAction } from "../chrome/actions";
import { useShell } from "../chrome/shell-host";
import {
  SHELF_DIVIDER_FLIP_ID,
  useShelfDrag,
  type ShelfItem,
} from "../chrome/shelf-drag";
import { TAB_GROUP_SWATCHES, useNewGroupNaming, useTabGroupMenu } from "../chrome/tab-group-menu";
import { moveToFolderEntries as folderMoveEntries, useTabMenu } from "../chrome/tab-menu";
import { TabReaderMark,
  TabTitle, TabTrailing, type TabActionId } from "../chrome/tab-parts";
import {
  rowItems,
  useChromeTabs,
  type ChromeTab,
  type RowItem,
} from "../chrome/tabs";
import { cn } from "../lib/cn";
import { pinnedRows } from "../lib/sidebar-tree";
import { updateTabSelection } from "../lib/tab-selection";
import { prettyUrl } from "../lib/url";
import { useAppStore } from "../store";
import { useContextMenu, type MenuEntry } from "./ContextMenu";
import { Favicon, TabMark } from "./Favicon";
import { TabGroupRow } from "./TabGroupRow";

/**
 * The sidebar's tab column — the `tabs` feature in its vertical orientation
 * (chrome/manifest-renderers.tsx), arranged as:
 *
 *   space header          the active space, with the new-folder control
 *   pinned section        folders (collapsible) and pins, kept across restarts
 *   "New tab" row         the divider
 *   today's tabs          the live pages that are not pinned
 *
 * A pin is a page KEPT: it has a live tab while open and stays as a dimmed
 * row when that tab is closed (⌘W, the ×), and clicking it opens the page
 * again bound to the same row. Folders hold pins, one level deep. The
 * shelf itself — pins, folders, favorites — is main's (@pistachio/shell-contracts/sidebar),
 * read off the snapshot and changed only through SidebarCommands.
 *
 * Every row can be dragged anywhere on the shelf (chrome/shelf-drag.tsx):
 * a day tab above the divider becomes a pin, a pin into a folder joins it,
 * a pin below the divider becomes a day tab again, anything onto the
 * favorites grid becomes a favorite; and a row with one live page dragged
 * RIGHT over the page reflows the live page into a proposed split and exposes
 * one highlighted landing pane. The transparent drag layer keeps the gesture
 * intact above the native page views while the column preserves its source slot.
 *
 * Right-click opens a context menu on any row (components/ContextMenu.tsx)
 * with the same operations, for the person who does not drag.
 *
 * Three boxes, as the strip's list had: the scroller, the positioned block
 * inside it that rows are laid out against (the drag reads offsets against
 * it, at any scroll offset), and the rows. The scroller opts out of the
 * column's window-drag region as a whole, so a press on its scrollbar
 * scrolls instead of moving the window.
 */

const ROW_H = 32;

function rowTitle(title: string, url: string): string {
  return `${title || url}\n${prettyUrl(url)}`;
}

/** The row's text tones: agent tabs keep their green until they are the active card. */
function rowTone(tab: ChromeTab, active: boolean): string {
  return cn(
    active ? "text-gray-1000" : "text-gray-900 hover:text-gray-1000",
    tab.kind === "agent" && !active && "text-green-900",
  );
}

interface TabSelectionEvent {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

type SelectableSidebarTab =
  | { key: string; kind: "pin"; pin: SidebarPin; tab: ChromeTab | null }
  | { key: string; kind: "tab"; tab: ChromeTab };

const pinSelectionKey = (pinId: string): string => `pin:${pinId}`;
const tabSelectionKey = (tabId: string): string => `tab:${tabId}`;

function SelectionMark() {
  return (
    <span
      aria-hidden="true"
      className="grid size-4 shrink-0 place-items-center rounded-sm bg-green-700 text-white"
    >
      <Check className="size-3" />
    </span>
  );
}

/** A stand-in ChromeTab for a closed pin drawn as a day row mid-drag. */
function phantomTab(
  id: string,
  title: string,
  url: string,
  faviconUrl: string | null,
): ChromeTab {
  return {
    id,
    spaceId: "work",
    title,
    url,
    faviconUrl,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    kind: "human",
    unlisted: false,
    runId: null,
    anchorId: null,
    lifecycle: "suspended",
    lastActiveAt: 0,
    active: false,
    split: false,
    splitGroup: null,
  };
}

/* --------------------------------- rows --------------------------------- */

function TabRow({
  flipId,
  tab,
  selected = false,
  dragging = false,
  memberOf = null,
  onActivate,
  onPointerDown,
  onContextMenu,
}: {
  flipId: string;
  tab: ChromeTab;
  selected?: boolean;
  /** This row is the one being dragged: it rides above the list, not with it. */
  dragging?: boolean;
  /** The tab group this row is drawn inside: to the drag it is a slot IN that group, not one of the day's. */
  memberOf?: string | null;
  onActivate: (event: TabSelectionEvent) => void;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const closeTab = useAppStore((s) => s.closeTab);

  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={tab.active}
      aria-label={selected ? `${tab.title || prettyUrl(tab.url)}, selected for bulk actions` : undefined}
      data-testid={tab.kind === "agent" ? "agent-tab" : "human-tab"}
      data-tab-id={tab.id}
      data-multi-selected={selected ? "" : undefined}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate(e);
        }
      }}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onAuxClick={(e) => {
        if (e.button === 1) void closeTab(tab.id);
      }}
      title={rowTitle(tab.title, tab.url)}
      data-flip-id={flipId}
      data-row-kind={memberOf === null ? "tab" : "member"}
      data-group-id={memberOf ?? undefined}
      data-entity-id={flipId}
      style={{ height: ROW_H }}
      className={cn(
        "no-drag group relative flex shrink-0 touch-none items-center gap-2 rounded-md px-2 text-[12.5px]",
        dragging ? "z-30 cursor-grabbing" : "cursor-pointer",
        tab.active ? "bg-background-100 shadow-small" : "hover:bg-alpha-200",
        rowTone(tab, tab.active),
        selected && "bg-green-100 text-green-1000 ring-1 ring-inset ring-green-400",
      )}
    >
      {selected ? <SelectionMark /> : <TabMark tab={tab} />}
      <TabReaderMark tab={tab} />
      <span className="min-w-0 flex-1 truncate">
        <TabTitle tab={tab} />
      </span>
      <TabTrailing tab={tab} />
    </div>
  );
}

/** One pane inside the fused split card — its own hover group. */
function SplitHalf({
  tab,
  focused,
  selected = false,
  omit = [],
  onActivate,
  onContextMenu,
}: {
  tab: ChromeTab;
  focused: boolean;
  selected?: boolean;
  omit?: readonly TabActionId[];
  onActivate: (event: TabSelectionEvent) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const closeTab = useAppStore((s) => s.closeTab);

  return (
    <span
      role="tab"
      tabIndex={0}
      aria-selected={focused}
      aria-label={selected ? `${tab.title || prettyUrl(tab.url)}, selected for bulk actions` : undefined}
      data-testid={tab.kind === "agent" ? "agent-tab" : "human-tab"}
      data-tab-id={tab.id}
      data-multi-selected={selected ? "" : undefined}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate(e);
        }
      }}
      onContextMenu={onContextMenu}
      onAuxClick={(e) => {
        if (e.button === 1) void closeTab(tab.id);
      }}
      title={rowTitle(tab.title, tab.url)}
      style={{ height: ROW_H }}
      className={cn(
        "group flex min-w-0 shrink-0 items-center gap-2 px-2 text-[12.5px] hover:bg-alpha-100",
        rowTone(tab, focused),
        selected && "bg-green-100 text-green-1000 ring-1 ring-inset ring-green-400",
      )}
    >
      {selected ? <SelectionMark /> : <TabMark tab={tab} />}
      <TabReaderMark tab={tab} />
      <span className="min-w-0 flex-1 truncate">
        <TabTitle tab={tab} />
      </span>
      <TabTrailing tab={tab} omit={omit} />
    </span>
  );
}

/**
 * A split view as ONE fused card: 2–4 rows stacked in stable pane order.
 */
function SplitRow({
  flipId,
  tabs,
  dragging = false,
  memberOf = null,
  selectedTabIds,
  onActivate,
  onPointerDown,
  onContextMenu,
}: {
  flipId: string;
  tabs: ChromeTab[];
  dragging?: boolean;
  memberOf?: string | null;
  selectedTabIds: ReadonlySet<string>;
  onActivate: (tabId: string, event: TabSelectionEvent) => void;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onContextMenu: (tab: ChromeTab, e: React.MouseEvent) => void;
}) {
  const active = tabs.some((tab) => tab.active);
  return (
    <div
      role="group"
      aria-label={`Split view: ${tabs.map((tab) => tab.title || "tab").join(", ")}`}
      onPointerDown={onPointerDown}
      data-flip-id={flipId}
      data-split-group-id={flipId}
      data-row-kind={memberOf === null ? "tab" : "member"}
      data-group-id={memberOf ?? undefined}
      data-entity-id={flipId}
      className={cn(
        "no-drag relative flex shrink-0 touch-none flex-col overflow-hidden rounded-md text-gray-1000",
        active ? "bg-background-100 shadow-small" : "hover:bg-alpha-200",
        dragging ? "z-30 cursor-grabbing" : "cursor-pointer",
      )}
    >
      {tabs.map((tab, index) => (
        <Fragment key={tab.id}>
          {index > 0 ? (
            <span
              aria-hidden="true"
              className="mx-2 h-px shrink-0 bg-alpha-300"
            />
          ) : null}
          <SplitHalf
            tab={tab}
            focused={tab.active}
            selected={selectedTabIds.has(tab.id)}
            omit={index === tabs.length - 1 ? [] : ["split"]}
            onActivate={(event) => onActivate(tab.id, event)}
            onContextMenu={(event) => onContextMenu(tab, event)}
          />
        </Fragment>
      ))}
    </div>
  );
}

/** A small control that shows on a row's hover. */
function RowButton({
  label,
  onClick,
  tone = "neutral",
  children,
}: {
  label: string;
  onClick: () => void;
  tone?: "neutral" | "accent";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        "grid size-6 cursor-pointer place-items-center rounded-md text-gray-700 outline-none transition-[background-color,color,transform] duration-150 hover:bg-alpha-300 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100",
        tone === "accent" ? "hover:text-green-900" : "hover:text-gray-1000",
      )}
    >
      {children}
    </button>
  );
}

/**
 * A pinned page. Open, it is the row of its live tab — title, spinner, the
 * active card when it is the active tab. Closed, it dims: the page is kept,
 * not loaded, and a click loads it again. A pin whose live tab has wandered
 * from the pinned address shows a "return" control on hover, saying the
 * pin is the ADDRESS, not the tab.
 */
function PinRow({
  pin,
  depth,
  live,
  selected = false,
  dragging = false,
  onOpen,
  onPointerDown,
  onContextMenu,
}: {
  pin: SidebarPin;
  depth: 0 | 1;
  live: ChromeTab | null;
  selected?: boolean;
  dragging?: boolean;
  onOpen: (event: TabSelectionEvent) => void;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const closeTab = useAppStore((s) => s.closeTab);
  const sidebarCommand = useAppStore((s) => s.sidebarCommand);
  const active = live?.active === true;
  const title = live?.title || pin.title || prettyUrl(pin.url);
  const wandered = live !== null && !live.loading && live.url !== pin.url;

  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      aria-label={selected ? `${title}, selected for bulk actions` : undefined}
      data-testid="pinned-tab"
      data-live={live === null ? undefined : ""}
      data-multi-selected={selected ? "" : undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(e);
        }
      }}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onAuxClick={(e) => {
        if (e.button === 1 && live !== null) void closeTab(live.id);
      }}
      title={rowTitle(title, live?.url ?? pin.url)}
      data-flip-id={pin.id}
      data-row-kind="pin"
      data-entity-id={pin.id}
      data-folder-id={pin.folderId ?? ""}
      style={{ height: ROW_H, marginLeft: depth * 18 }}
      className={cn(
        "no-drag group relative flex shrink-0 touch-none items-center gap-2 rounded-md px-2 text-[12.5px]",
        dragging ? "z-30 cursor-grabbing" : "cursor-pointer",
        active
          ? "bg-background-100 text-gray-1000 shadow-small"
          : "hover:bg-alpha-200",
        !active &&
          (live === null
            ? "text-gray-800 hover:text-gray-1000"
            : "text-gray-900 hover:text-gray-1000"),
        selected && "bg-green-100 text-green-1000 ring-1 ring-inset ring-green-400",
      )}
    >
      {selected ? (
        <SelectionMark />
      ) : live === null ? (
        <Favicon
          src={pin.faviconUrl}
          seed={prettyUrl(pin.url)}
          className="opacity-60"
        />
      ) : (
        <TabMark tab={live} fallbackFaviconUrl={pin.faviconUrl} />
      )}
      {live === null ? null : <TabReaderMark tab={live} />}
      <span className="min-w-0 flex-1 truncate">
        {live === null ? title : <TabTitle tab={live} />}
      </span>
      <span className="-my-1 -mr-1 flex shrink-0 items-center">
        <span className="grid grid-cols-[0fr] opacity-0 transition-[grid-template-columns,opacity] duration-200 ease-out group-hover:grid-cols-[1fr] group-hover:opacity-100 group-has-[:focus-visible]:grid-cols-[1fr] group-has-[:focus-visible]:opacity-100">
          <span className="flex min-w-0 items-center gap-0.5 overflow-hidden">
            {wandered ? (
              <RowButton
                label="Return to pinned page"
                onClick={() =>
                  void sidebarCommand({ type: "returnToPinned", pinId: pin.id })
                }
              >
                <Undo2 className="size-3" aria-hidden="true" />
              </RowButton>
            ) : null}
            <RowButton
              label={`Unpin ${title}`}
              onClick={() =>
                void sidebarCommand({ type: "unpin", pinId: pin.id })
              }
            >
              <PinOff className="size-3" aria-hidden="true" />
            </RowButton>
            {live === null ? null : (
              <RowButton
                label={`Close ${title}`}
                onClick={() => void closeTab(live.id)}
              >
                <X className="size-3" aria-hidden="true" />
              </RowButton>
            )}
          </span>
        </span>
      </span>
    </div>
  );
}

/** A folder's colours are a tab group's, after "none" — its default, the chrome's own ink. */
const NO_FOLDER_COLOR = "none";
const FOLDER_SWATCHES = [{ id: NO_FOLDER_COLOR, label: "No colour", clear: true }, ...TAB_GROUP_SWATCHES];

/** The emoji the folder menu offers outright; its field takes any other. */
const FOLDER_EMOJI = ["⭐", "❤️", "🔥", "💼", "🏠", "📚", "🛒", "✈️", "🎵", "🎮", "💡", "📰", "💬", "🛠️", "💰"] as const;

/**
 * A folder's header: the disclosure, its name (an input while renaming),
 * and its count while collapsed. Dropping a row on the header's middle
 * puts it inside (chrome/shelf-drag.tsx), which the header shows by tinting.
 */
function FolderRow({
  folder,
  count,
  receiving,
  renaming,
  dragging = false,
  onToggle,
  onRename,
  onPointerDown,
  onContextMenu,
}: {
  folder: SidebarFolder;
  count: number;
  /** The drag would drop into this folder. */
  receiving: boolean;
  renaming: boolean;
  dragging?: boolean;
  onToggle: () => void;
  onRename: (name: string | null) => void;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const open = !folder.collapsed;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label={`Folder: ${folder.name || "Untitled"}`}
      data-testid="pinned-folder"
      onClick={() => {
        if (!renaming) onToggle();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onRename(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !renaming) onToggle();
      }}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      data-flip-id={folder.id}
      data-row-kind="folder"
      data-entity-id={folder.id}
      data-collapsed={open ? undefined : ""}
      style={{ height: ROW_H }}
      className={cn(
        "no-drag group relative flex shrink-0 touch-none items-center gap-2 rounded-md px-2 text-[12.5px] font-medium text-gray-1000",
        dragging ? "z-30 cursor-grabbing" : "cursor-pointer",
        receiving
          ? "bg-green-100 text-green-1000 ring-1 ring-green-400"
          : renaming
            ? "cursor-text bg-alpha-200 ring-1 ring-alpha-400 ring-inset"
            : "hover:bg-alpha-200",
      )}
    >
      <FolderMark folder={folder} open={open} />
      {renaming ? (
        <FolderNameInput name={folder.name} onDone={onRename} />
      ) : (
        <span className="min-w-0 flex-1 truncate">
          {folder.name || "Untitled"}
        </span>
      )}
      {!renaming && !open && count > 0 ? (
        <span className="shrink-0 text-[10.5px] font-normal text-gray-700">
          {count}
        </span>
      ) : null}
      <ChevronRight
        aria-hidden="true"
        className={cn(
          "size-3 shrink-0 text-gray-700 transition-transform duration-150",
          open && "rotate-90",
        )}
      />
    </div>
  );
}

/**
 * A folder's 16px mark: the folder icon, open or shut, or the emoji chosen in
 * its place. A colour is one of a tab group's tones (shell.css): it fills the
 * icon, and sits behind an emoji as a tile, since an emoji has its own colours.
 */
function FolderMark({ folder, open }: { folder: SidebarFolder; open: boolean }) {
  const Icon = open ? FolderOpen : FolderIcon;
  const toned = folder.color !== null;
  return (
    <span
      data-testid="folder-mark"
      data-group-color={folder.color ?? undefined}
      className={cn(
        "grid size-4 shrink-0 place-items-center",
        toned ? "tab-group-tone text-(--tg-solid)" : "text-gray-900",
      )}
    >
      {folder.emoji !== null ? (
        <span
          aria-hidden="true"
          className={cn(
            "grid place-items-center text-[13px] leading-none",
            toned && "-m-0.5 size-5 rounded-[5px] bg-(--tg-tint-strong) text-[12px]",
          )}
        >
          {folder.emoji}
        </span>
      ) : (
        <Icon
          className="size-3.5"
          aria-hidden="true"
          {...(toned ? { fill: "currentColor", fillOpacity: 0.22 } : {})}
        />
      )}
    </span>
  );
}

/**
 * The folder name field: ↵ or blur commits, Escape keeps the old name. An
 * edit in place, as a tab group's is (TabGroupRow's GroupTitleInput): the
 * words stay where the name was, unboxed, and the ROW shows it is being named.
 */
function FolderNameInput({
  name,
  onDone,
}: {
  name: string;
  onDone: (name: string | null) => void;
}) {
  const [value, setValue] = useState(name);
  return (
    <input
      autoFocus
      aria-label="Folder name"
      data-testid="folder-name-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => onDone(value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onDone(value);
        if (e.key === "Escape") onDone(null);
      }}
      spellCheck={false}
      autoComplete="off"
      placeholder="Folder name"
      className="h-6 min-w-0 flex-1 bg-transparent p-0 text-[12.5px] font-medium text-gray-1000 caret-gray-1000 outline-none selection:bg-alpha-400 placeholder:text-gray-700"
    />
  );
}

/**
 * The active space's name, with the new-folder control on hover. Spaces
 * themselves are switched from the footer's chips (the `spaces` feature).
 */
type SectionId = "pinned" | "live";
const SECTION_KEY = "pistachio.sidebar.collapsed";

/** Which sections the user has folded away, kept per renderer in localStorage. */
function readCollapsedSections(): Set<SectionId> {
  try {
    const raw = localStorage.getItem(SECTION_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter(
            (id): id is SectionId => id === "pinned" || id === "live",
          )
        : [],
    );
  } catch {
    return new Set();
  }
}

function storeCollapsedSections(collapsed: Set<SectionId>): void {
  try {
    localStorage.setItem(SECTION_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Best effort; the fold still holds for this session.
  }
}

/**
 * A section's label — "Pinned", "Live tabs" — and, at its far end, the
 * chevron that folds the section's rows away. The whole row is the toggle.
 */
function SectionHeader({
  id,
  label,
  count,
  open,
  onToggle,
  onContextMenu,
  busyLabel,
}: {
  id: SectionId;
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  /** Work in progress on the section's rows, said in place of its label. */
  busyLabel?: string | null;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={`sidebar-section-${id}`}
      data-testid={`section-header-${id}`}
      onClick={onToggle}
      onContextMenu={onContextMenu}
      className="no-drag group/section flex h-6 w-full shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-[11px] font-medium text-gray-700 transition-colors hover:bg-alpha-200 hover:text-gray-900"
    >
      {busyLabel ? (
        <span data-testid={`section-busy-${id}`} className="agent-shimmer min-w-0 flex-1 truncate">
          {busyLabel}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{label}</span>
      )}
      {!open && count > 0 ? (
        <span className="shrink-0 text-[10.5px] font-normal">{count}</span>
      ) : null}
      <ChevronRight
        aria-hidden="true"
        className={cn(
          "size-3 shrink-0 transition-transform duration-150",
          open && "rotate-90",
        )}
      />
    </button>
  );
}

/**
 * The divider between the kept pages and the day's: the "New tab" row and —
 * revealed when the pointer reaches it — a second button that starts a new
 * pinned folder. The second slot is ALWAYS in layout, invisible and inert at
 * rest, so the row's height never changes under the FLIP.
 */
/**
 * A section's rows, sliding open and closed under their header. The rows stay
 * mounted — the grid-rows 0fr/1fr trick animates to whatever height they
 * take — and are inert while folded so nothing in them can take focus.
 */
function SectionBody({
  open,
  unclipped = false,
  children,
}: {
  open: boolean;
  /** Let rows paint past the section's edge — a dragged row over the header or "New tab" row. */
  unclipped?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-100 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
    >
      {/* min-w-0: an unclipped grid item's automatic minimum width is its
          min-content width — the longest title untruncated — which would widen
          every row past the column for the length of a drag. */}
      <div
        className={cn("min-h-0 min-w-0", open && unclipped ? "overflow-visible" : "overflow-hidden")}
        aria-hidden={!open}
        inert={!open}
      >
        {children}
      </div>
    </div>
  );
}

function NewTabRow({ onNewFolder }: { onNewFolder: () => void }) {
  const newTab = useAction("newTab");

  return (
    <div
      data-flip-id={SHELF_DIVIDER_FLIP_ID}
      data-row-kind="divider"
      data-entity-id={SHELF_DIVIDER_FLIP_ID}
      style={{ height: ROW_H }}
      className="no-drag group/new flex shrink-0 items-center rounded-md pr-1 text-gray-700 transition-colors hover:bg-alpha-200 hover:text-gray-1000 [&_svg]:size-3.5"
    >
      <button
        type="button"
        title={
          newTab.hint === null
            ? newTab.label
            : `${newTab.label} (${newTab.hint})`
        }
        aria-label={newTab.label}
        data-testid="new-tab-button"
        onClick={newTab.run}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[12.5px] outline-none"
      >
        <span className="grid size-4 shrink-0 place-items-center">
          {newTab.icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{newTab.label}</span>
      </button>
      <button
        type="button"
        title="New folder"
        aria-label="New folder"
        data-testid="new-folder-button"
        onClick={onNewFolder}
        className="pointer-events-none grid size-6 shrink-0 -translate-x-2 scale-90 cursor-pointer place-items-center rounded-sm opacity-0 transition-[opacity,translate,scale] duration-200 ease-out group-hover/new:pointer-events-auto group-hover/new:translate-x-0 group-hover/new:scale-100 group-hover/new:opacity-100 hover:bg-alpha-300 hover:text-gray-1000 focus-visible:pointer-events-auto focus-visible:translate-x-0 focus-visible:scale-100 focus-visible:opacity-100"
      >
        <FolderPlus aria-hidden="true" />
      </button>
    </div>
  );
}

/* --------------------------------- list --------------------------------- */

/**
 * One slot among the day's rows: a row (a lone tab or a split), or a tab
 * group holding rows of its own. The ids are @pistachio/shell-contracts/tab-groups
 * `dayRowUnits`' — the same units main and the drag's drop count in.
 */
type DayUnit =
  | { kind: "row"; id: string; row: RowItem }
  | { kind: "group"; id: string; group: TabGroupInfo; tabs: ChromeTab[]; rows: RowItem[] };

const NO_TAB_GROUPS: readonly TabGroupInfo[] = [];
/** The pointer must settle on a group this long before it opens, so crossing the list does not make it ripple. */
const GROUP_OPEN_MS = 140;
/** …less when another group is already open by hover: the person is browsing groups. */
const GROUP_SWAP_MS = 90;
const GROUP_CLOSE_MS = 240;
/** How long a group stays open after a row is dropped into it, unless the pointer is seen to still be on it. */
const GROUP_LANDED_MS = 700;

export function TabList() {
  const tabs = useChromeTabs();
  const shelf = useAppStore(
    (s) => s.snapshot?.sidebar ?? DEFAULT_SIDEBAR_STATE,
  );
  const mediaInset = useMediaStackInset();
  const selectTab = useAppStore((s) => s.selectTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const sidebarCommand = useAppStore((s) => s.sidebarCommand);
  const tabGroups = useAppStore((s) => s.snapshot?.tabGroups ?? NO_TAB_GROUPS);
  const splitGroups = useAppStore((s) => s.snapshot?.splitGroups);
  const tabGroupCommand = useAppStore((s) => s.tabGroupCommand);
  const tidyRunning = useAppStore((s) => s.tidyRunning);
  const newTabAction = useAction("newTab");
  const tidyAction = useAction("tidyTabs");
  const archiveAction = useAction("openArchive");
  const { run } = useShell();
  const { drag, beginPress, justDragged, scrollerRef, listRef } =
    useShelfDrag();
  // The row under the pointer — styled as grabbed only while the gesture is
  // live, not while a committed drop waits for main to publish it.
  const grabbedId = drag !== null && !drag.settling ? drag.item.entityId : null;
  const menu = useContextMenu();
  const menuOpen = menu.isOpen;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<SectionId>>(
    readCollapsedSections,
  );
  const toggleSection = (id: SectionId): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      storeCollapsedSections(next);
      return next;
    });
  };
  // A folded section unfolds for the length of a drag, so its rows are there to drop onto.
  const sectionOpen = (id: SectionId): boolean =>
    drag !== null || !collapsed.has(id);

  const liveByAnchor = useMemo(() => {
    const map = new Map<string, ChromeTab>();
    for (const tab of tabs)
      if (tab.anchorId !== null) map.set(tab.anchorId, tab);
    return map;
  }, [tabs]);
  const dayItems = useMemo(
    () => rowItems(tabs.filter((tab) => tab.anchorId === null)),
    [tabs],
  );
  const dayUnits = useMemo<DayUnit[]>(() => {
    const byId = new Map(tabs.map((tab) => [tab.id, tab]));
    const groupByUnit = new Map(tabGroups.map((group) => [tabGroupUnitId(group.id), group]));
    const day = tabs.filter((tab) => tab.anchorId === null).map((tab) => tab.id);
    return dayRowUnits(day, splitGroups ?? [], tabGroups).flatMap((unit): DayUnit[] => {
      const members = unit.tabIds.flatMap((tabId) => byId.get(tabId) ?? []);
      if (members.length === 0) return [];
      const group = groupByUnit.get(unit.id);
      if (unit.kind === "group" && group !== undefined) return [{ kind: "group", id: unit.id, group, tabs: members, rows: rowItems(members) }];
      return [{ kind: "row", id: unit.id, row: { id: unit.id, tabs: members, active: members.some((tab) => tab.active) } }];
    });
  }, [tabs, tabGroups, splitGroups]);

  // ── Which groups are open ────────────────────────────────────────────────
  // A group is open while it is held open (a click on its header), holds a
  // tab in view, is being renamed, has a menu up — or while the pointer has
  // SETTLED on it. Only one group is ever open by hover, and the swap from
  // one to the next happens in one render.
  const [hoverGroupId, setHoverGroupId] = useState<string | null>(null);
  // A click that folds a group must WIN over the reasons it opens without
  // one: the pointer is on it (so its hover peek waits until the pointer has
  // left) and it may hold the tab in view (so that reason waits until a
  // different tab of it comes into view — `folded` keeps which tabs were).
  const [hoverBlockedId, setHoverBlockedId] = useState<string | null>(null);
  const [folded, setFolded] = useState<ReadonlyMap<string, string>>(() => new Map());
  // A group closing ABOVE the pointer (see the layout effect below) shuts in
  // one render instead of folding away, so the scroll can hold the row under
  // the pointer still — where there is scroll to do it with.
  const [snapCloseId, setSnapCloseId] = useState<string | null>(null);
  // Only the render it closes in needs it (TabGroupRow's members decide during that render).
  useEffect(() => {
    if (snapCloseId !== null) setSnapCloseId(null);
  }, [snapCloseId]);
  const hoverGroupRef = useRef(hoverGroupId);
  useEffect(() => {
    hoverGroupRef.current = hoverGroupId;
  }, [hoverGroupId]);
  const [menuGroupId, setMenuGroupId] = useState<string | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  /** The row under the pointer as a group opens or closes, and where it was: it must not move (see the layout effect). */
  const hoverAnchor = useRef<{ el: HTMLElement; top: number } | null>(null);
  const settleHover = (groupId: string | null): void => {
    hoverTimer.current = null;
    const at = pointerAt.current;
    const under = at === null ? null : document.elementFromPoint(at.x, at.y);
    const el = under instanceof Element ? under.closest<HTMLElement>("[data-flip-id]") : null;
    hoverAnchor.current = el !== null && listRef.current?.contains(el) === true ? { el, top: el.getBoundingClientRect().top } : null;
    const prev = hoverGroupRef.current;
    if (prev !== null && prev !== groupId) {
      const closing = listRef.current?.querySelector<HTMLElement>(`[data-group-id="${CSS.escape(prev)}"]`);
      const anchorEl = hoverAnchor.current?.el;
      const above = closing != null && anchorEl != null && !closing.contains(anchorEl) && closing.getBoundingClientRect().top < anchorEl.getBoundingClientRect().top;
      setSnapCloseId(above && (scrollerRef.current?.scrollTop ?? 0) > 0 ? prev : null);
    }
    setHoverGroupId(groupId);
  };
  /** What the running timer will settle on, so a pointer MOVING over a group does not restart its clock every frame. */
  const hoverPending = useRef<string | null | undefined>(undefined);
  const onGroupHover = (groupId: string, inside: boolean): void => {
    // A group the person just folded does not peek again until the pointer has left it.
    if (hoverBlockedId === groupId) {
      if (inside) return;
      setHoverBlockedId(null);
    }
    const wanted = inside ? groupId : null;
    // A drag opens the group it would drop into (`receivingGroupId`), not the
    // ones it passes over. Its LEAVING is still heard: a drag that began on a
    // group must not leave it open behind it.
    if (inside && drag !== null) return;
    if (hoverTimer.current !== null && hoverPending.current === wanted) return;
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    hoverPending.current = undefined;
    if (wanted === hoverGroupId) return;
    // Leaving a group that is not the hovered one changes nothing.
    if (!inside && hoverGroupId !== groupId) return;
    hoverPending.current = wanted;
    hoverTimer.current = window.setTimeout(
      () => {
        hoverPending.current = undefined;
        settleHover(wanted);
      },
      inside ? (hoverGroupId === null ? GROUP_OPEN_MS : GROUP_SWAP_MS) : GROUP_CLOSE_MS,
    );
  };
  useEffect(
    () => () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    },
    [],
  );
  // A group closing ABOVE the pointer would pull every row below it up and
  // out from under the pointer — which would then be over some other group,
  // which would open, and so on down the list. So the row that was under the
  // pointer is put back under it by scrolling the list the same distance.
  useLayoutEffect(() => {
    const anchor = hoverAnchor.current;
    hoverAnchor.current = null;
    const scroller = scrollerRef.current;
    if (anchor === null || scroller === null || !anchor.el.isConnected) return;
    const moved = anchor.el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(moved) >= 1) scroller.scrollTop += moved;
  }, [hoverGroupId, scrollerRef]);

  // What the column draws: the shelf and the day's tabs, with the dragged
  // item lifted out of wherever it was and drawn at the slot it would land.
  // Only the drag's item and drop shape this; the rest of it (lifted, the
  // split zone) is the page's business, so it is not recomputed for them.
  const dragItem = drag?.item ?? null;
  const dragDrop = drag?.drop ?? null;
  const { entries, units, ghostTab, openFolderId, receivingFolderId, receivingGroupId } =
    useMemo(() => {
      let entries: readonly SidebarEntry[] = shelf.entries;
      let units = dayUnits;
      let receivingGroupId: string | null = null;
      let ghostTab: ChromeTab | null = null;
      let openFolderId: string | null = null;
      let receivingFolderId: string | null = null;
      if (dragItem === null)
        return { entries, units, ghostTab, openFolderId, receivingFolderId, receivingGroupId };
      const item = dragItem;
      const drop = dragDrop;
      if (item.kind === "folder") {
        entries = entries.filter(
          (e) =>
            e.id !== item.entityId &&
            !(e.kind === "pin" && e.folderId === item.entityId),
        );
      } else if (item.kind === "pin") {
        entries = entries.filter((e) => e.id !== item.entityId);
      } else if (item.kind === "tab" || item.kind === "split" || item.kind === "group") {
        // Lifted out of the day's rows — or out of the group it sat in, which
        // goes too if that was its last row (main's units drop it the same way).
        const into = drop !== null && drop.zone === "group" ? drop.groupId : null;
        units = units.flatMap((unit): DayUnit[] => {
          if (unit.id === item.entityId) return [];
          if (unit.kind === "row") return [unit];
          const rows = unit.rows.filter((row) => row.id !== item.entityId);
          // A group emptied by the lift is gone, as it will be — unless the row is being set back down in it.
          return rows.length === 0 && unit.group.id !== into ? [] : [{ ...unit, rows }];
        });
      }
      ghostTab = item.tabs[0] ?? null;
      if (drop === null)
        return { entries, units, ghostTab, openFolderId, receivingFolderId, receivingGroupId };
      if (drop.zone === "pinned") {
        openFolderId = drop.folderId;
        const target =
          drop.folderId === null
            ? null
            : (entries.find((e) => e.id === drop.folderId) ?? null);
        if (
          target !== null &&
          drop.index >= childrenOf(entries, target.id).length
        )
          receivingFolderId = target.id;
        if (item.kind === "folder") {
          const folder = shelf.entries.find(
            (e): e is SidebarFolder =>
              e.kind === "folder" && e.id === item.entityId,
          );
          if (folder !== undefined) {
            const children = childrenOf(shelf.entries, folder.id);
            let next = placeEntry(entries, folder, {
              folderId: null,
              index: drop.index,
            });
            children.forEach((pin, i) => {
              next = placeEntry(next, pin, { folderId: folder.id, index: i });
            });
            entries = next;
          }
        } else {
          const ghost: SidebarPin = {
            kind: "pin",
            id: item.entityId,
            url: item.url,
            title: item.title,
            faviconUrl: item.faviconUrl,
            folderId: drop.folderId,
          };
          entries = placeEntry(entries, ghost, {
            folderId: drop.folderId,
            index: drop.index,
          });
        }
      } else if (drop.zone === "today" && item.kind !== "folder") {
        const rowTabs =
          item.tabs.length > 0
            ? item.tabs
            : [
                phantomTab(
                  item.entityId,
                  item.title,
                  item.url,
                  item.faviconUrl,
                ),
              ];
        const carried = dayUnits.find((unit) => unit.id === item.entityId);
        const ghost: DayUnit =
          item.kind === "group" && carried !== undefined
            ? carried
            : { kind: "row", id: item.entityId, row: { id: item.entityId, tabs: rowTabs, active: rowTabs.some((t) => t.active) } };
        const next = [...units];
        next.splice(Math.min(drop.index, next.length), 0, ghost);
        units = next;
      } else if (drop.zone === "group" && (item.kind === "tab" || item.kind === "split") && item.tabs.length > 0) {
        // Into a tab group: the row is drawn where it would sit among the
        // group's tabs, and the group is open for as long as it is the target.
        receivingGroupId = drop.groupId;
        const ghost: RowItem = { id: item.entityId, tabs: item.tabs, active: item.tabs.some((t) => t.active) };
        units = units.map((unit): DayUnit => {
          if (unit.kind !== "group" || unit.group.id !== drop.groupId) return unit;
          const rows = [...unit.rows];
          rows.splice(Math.min(drop.index, rows.length), 0, ghost);
          return { ...unit, rows };
        });
      }
      return { entries, units, ghostTab, openFolderId, receivingFolderId, receivingGroupId };
    }, [shelf.entries, dayUnits, dragItem, dragDrop]);

  // While a drag is live the pointer belongs to the drag (on the desktop, to
  // the native layer above the page: the list hears nothing at all), so when
  // it ends the hover is wherever the drag left it — on the group the row was
  // dropped into, which the pointer is still over, or on none. The next real
  // move or leave takes it from there.
  const lastReceiving = useRef<string | null>(null);
  if (dragItem !== null) lastReceiving.current = receivingGroupId;
  const dragging = dragItem !== null;
  useEffect(() => {
    if (dragging) return;
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    hoverPending.current = undefined;
    hoverAnchor.current = null;
    const landed = lastReceiving.current;
    lastReceiving.current = null;
    setHoverGroupId(landed);
    if (landed === null) return;
    // Provisional: the drop settles only once main has published it, and the
    // pointer may have left by then with nobody listening — so no leave will
    // ever come. The hover lapses unless a move over the group (TabGroupRow's
    // onPointerMove) says the pointer really is still there.
    hoverPending.current = null;
    hoverTimer.current = window.setTimeout(() => {
      hoverPending.current = undefined;
      settleHover(null);
    }, GROUP_LANDED_MS);
    // settleHover reads refs and a stable setter only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  /** Which of a group's tabs are in view, as one key — what a fold over them remembers. */
  const inViewKey = (unit: Extract<DayUnit, { kind: "group" }>): string =>
    unit.tabs.filter((tab) => tab.active || tab.split).map((tab) => tab.id).join(" ");
  /** Open without a pointer on it: held open by a click, or holding the tab in view (unless folded over it). */
  const isHeld = (unit: Extract<DayUnit, { kind: "group" }>): boolean => {
    if (unit.group.open) return true;
    const key = inViewKey(unit);
    return key !== "" && folded.get(unit.group.id) !== key;
  };
  const toggleGroup = (unit: Extract<DayUnit, { kind: "group" }>): void => {
    const id = unit.group.id;
    setSnapCloseId(null);
    if (isHeld(unit)) {
      if (unit.group.open) void tabGroupCommand({ type: "setOpen", groupId: id, open: false });
      setFolded((prev) => new Map(prev).set(id, inViewKey(unit)));
      setHoverBlockedId(id);
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
      hoverPending.current = undefined;
      if (hoverGroupId === id) setHoverGroupId(null);
      return;
    }
    setFolded((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setHoverBlockedId(null);
    void tabGroupCommand({ type: "setOpen", groupId: id, open: true });
  };
  const isExpanded = (unit: Extract<DayUnit, { kind: "group" }>): boolean =>
    isHeld(unit) ||
    receivingGroupId === unit.group.id ||
    (hoverGroupId === unit.group.id && hoverBlockedId !== unit.group.id) ||
    renaming === unit.group.id ||
    (menuOpen && menuGroupId === unit.group.id);

  const rows = useMemo(
    () => pinnedRows(entries, { openFolderId }),
    [entries, openFolderId],
  );
  const folders = useMemo(
    () => shelf.entries.filter((e): e is SidebarFolder => e.kind === "folder"),
    [shelf.entries],
  );

  // Selection follows the visible tab order, skipping folder headers and
  // anything hidden by a collapsed folder or section.
  const selectableTabs = useMemo<SelectableSidebarTab[]>(() => {
    const selected: SelectableSidebarTab[] = [];
    if (!collapsed.has("pinned")) {
      for (const row of pinnedRows(shelf.entries)) {
        if (row.kind !== "pin") continue;
        selected.push({
          key: pinSelectionKey(row.pin.id),
          kind: "pin",
          pin: row.pin,
          tab: liveByAnchor.get(row.pin.id) ?? null,
        });
      }
    }
    if (!collapsed.has("live")) {
      for (const unit of dayUnits) {
        // A closed group's tabs are not on screen, so a range never sweeps them up unseen.
        if (unit.kind === "group" && !isExpanded(unit)) continue;
        for (const tab of unit.kind === "group" ? unit.tabs : unit.row.tabs) {
          selected.push({ key: tabSelectionKey(tab.id), kind: "tab", tab });
        }
      }
    }
    return selected;
    // isExpanded reads exactly the state listed after the units.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, dayUnits, liveByAnchor, shelf.entries, hoverGroupId, renaming, menuOpen, menuGroupId]);
  const selectedTabs = useMemo(
    () => selectableTabs.filter((item) => selectedKeys.has(item.key)),
    [selectableTabs, selectedKeys],
  );
  // The selected styling (check mark, green ring) marks a bulk selection, so
  // a single selected tab looks like any other (selectedDayTabIds too).
  const isShownSelected = (key: string): boolean =>
    selectedKeys.size > 1 && selectedKeys.has(key);
  const selectedDayTabIds = useMemo(
    () =>
      new Set(
        selectedTabs.length > 1
          ? selectedTabs.flatMap((item) =>
              item.kind === "tab" ? [item.tab.id] : [],
            )
          : [],
      ),
    [selectedTabs],
  );

  // Commands can turn pins into day tabs (and vice versa), close tabs, or
  // collapse a folder. Never leave invisible/stale entities selected.
  useEffect(() => {
    const valid = new Set(selectableTabs.map((item) => item.key));
    setSelectedKeys((current) => {
      if ([...current].every((key) => valid.has(key))) return current;
      return new Set([...current].filter((key) => valid.has(key)));
    });
    setSelectionAnchor((current) =>
      current === null || valid.has(current) ? current : null,
    );
  }, [selectableTabs]);

  const liveFor = (pin: SidebarPin): ChromeTab | null =>
    liveByAnchor.get(pin.id) ??
    (drag !== null && drag.item.entityId === pin.id ? ghostTab : null);

  const clearSelection = (): void => {
    setSelectedKeys(new Set());
    setSelectionAnchor(null);
  };
  const selectForBulk = (
    key: string,
    event: TabSelectionEvent,
    activateSelected: () => void,
  ): void => {
    if (justDragged()) return;
    const fallbackAnchor =
      selectableTabs.find((item) => item.tab?.active === true)?.key ?? key;
    const next = updateTabSelection(
      selectableTabs.map((item) => item.key),
      selectedKeys,
      selectionAnchor ?? fallbackAnchor,
      key,
      {
        range: event.shiftKey,
        additive: event.metaKey || event.ctrlKey,
      },
    );
    setSelectedKeys(next.selected);
    setSelectionAnchor(next.anchor);
    if (next.activate) activateSelected();
  };
  const activate = (tabId: string, event: TabSelectionEvent): void => {
    selectForBulk(tabSelectionKey(tabId), event, () => {
      // Pressing the tab you are already on is an address press, not a
      // re-selection that would do nothing: the sidebar's row stands in for
      // the omnibox the way the top layout's active tab does (ActiveTabLabel).
      // A modified click never reaches here — selectForBulk keeps range and
      // additive presses for bulk selection.
      if (tabs.find((candidate) => candidate.id === tabId)?.active === true) {
        run({ type: "openUrlBar", tabId });
        return;
      }
      void selectTab(tabId);
    });
  };
  const openPin = (pin: SidebarPin, event: TabSelectionEvent): void => {
    selectForBulk(pinSelectionKey(pin.id), event, () =>
      void sidebarCommand({ type: "open", anchorId: pin.id }),
    );
  };
  const newFolder = (index?: number): void => {
    const id = crypto.randomUUID();
    void sidebarCommand({
      type: "createFolder",
      id,
      name: "New folder",
      index,
    });
    setRenaming(id);
  };
  const finishRename = (folderId: string, name: string | null): void => {
    setRenaming(null);
    if (name !== null && name.trim() !== "")
      void sidebarCommand({ type: "renameFolder", folderId, name });
  };

  /** "Move to <folder>" entries, one per folder (chrome/tab-menu.tsx). */
  const moveToFolderEntries = (
    current: string | null,
    move: (folderId: string) => void,
  ): MenuEntry[] => folderMoveEntries(folders, current, move);

  const moveSelectionToFolder = async (
    selection: readonly SelectableSidebarTab[],
    folderId: string,
  ): Promise<void> => {
    for (const item of selection) {
      if (item.kind === "pin") {
        await sidebarCommand({
          type: "movePin",
          pinId: item.pin.id,
          folderId,
          index: 10_000,
        });
      } else if (item.tab.kind === "human") {
        await sidebarCommand({
          type: "pinTab",
          tabId: item.tab.id,
          folderId,
          index: 10_000,
        });
      }
    }
  };

  const selectedTabMenu = (
    selection: readonly SelectableSidebarTab[],
  ): MenuEntry[] => {
    const pins = selection.filter(
      (item): item is Extract<SelectableSidebarTab, { kind: "pin" }> =>
        item.kind === "pin",
    );
    const dayTabs = selection.filter(
      (item): item is Extract<SelectableSidebarTab, { kind: "tab" }> =>
        item.kind === "tab" && item.tab.kind === "human",
    );
    const liveTabs = selection.flatMap((item) =>
      item.tab === null ? [] : [item.tab],
    );
    const allCanBePinned = pins.length + dayTabs.length === selection.length;
    const entries: MenuEntry[] = [
      { note: `${selection.length} tabs selected` },
    ];

    if (dayTabs.length > 1) {
      entries.push(
        { separator: true },
        {
          label: dayTabs.length === selection.length ? "Group selected tabs" : `Group ${String(dayTabs.length)} selected tabs`,
          icon: <Layers aria-hidden="true" />,
          onSelect: () => {
            clearSelection();
            groupTabs(dayTabs.map((item) => item.tab.id));
          },
        },
      );
    }

    entries.push(
      { separator: true },
      {
        label: "New folder with selected tabs",
        icon: <FolderPlus aria-hidden="true" />,
        disabled: !allCanBePinned,
        onSelect: () => {
          const folderId = crypto.randomUUID();
          clearSelection();
          setRenaming(folderId);
          void (async () => {
            await sidebarCommand({
              type: "createFolder",
              id: folderId,
              name: "New folder",
            });
            await moveSelectionToFolder(selection, folderId);
          })();
        },
      },
      ...folders.map<MenuEntry>((folder) => ({
        label: `Move selected tabs to “${folder.name || "Untitled"}”`,
        icon: <FolderInput aria-hidden="true" />,
        disabled: !allCanBePinned,
        onSelect: () => {
          clearSelection();
          void moveSelectionToFolder(selection, folder.id);
        },
      })),
    );

    if (dayTabs.length > 0 || pins.length > 0) {
      entries.push({ separator: true });
      if (dayTabs.length > 0) {
        entries.push({
          label:
            dayTabs.length === selection.length
              ? "Pin selected tabs"
              : `Pin ${dayTabs.length} selected ${dayTabs.length === 1 ? "tab" : "tabs"}`,
          icon: <Pin aria-hidden="true" />,
          onSelect: () => {
            clearSelection();
            void (async () => {
              for (const item of dayTabs) {
                await sidebarCommand({
                  type: "pinTab",
                  tabId: item.tab.id,
                  folderId: null,
                  index: 10_000,
                });
              }
            })();
          },
        });
      }
      if (pins.length > 0) {
        entries.push({
          label:
            pins.length === selection.length
              ? "Unpin selected tabs"
              : `Unpin ${pins.length} selected ${pins.length === 1 ? "pin" : "pins"}`,
          icon: <PinOff aria-hidden="true" />,
          onSelect: () => {
            clearSelection();
            void (async () => {
              for (const item of pins) {
                await sidebarCommand({ type: "unpin", pinId: item.pin.id });
              }
            })();
          },
        });
      }
    }

    if (liveTabs.length > 0) {
      entries.push(
        { separator: true },
        {
          label:
            liveTabs.length === selection.length
              ? "Close selected tabs"
              : `Close ${liveTabs.length} open ${liveTabs.length === 1 ? "tab" : "tabs"}`,
          icon: <X aria-hidden="true" />,
          danger: true,
          onSelect: () => {
            clearSelection();
            void (async () => {
              for (const tab of liveTabs) await closeTab(tab.id);
            })();
          },
        },
      );
    }

    return entries;
  };

  const openTabContextMenu = (
    key: string,
    event: React.MouseEvent,
    singleItems: () => MenuEntry[],
  ): void => {
    event.preventDefault();
    // Right-clicking outside the selection targets just that tab, like
    // Finder, but a lone tab is not shown as "selected" — that styling is for
    // bulk selections only.
    const contextKeys = selectedKeys.has(key)
      ? selectedKeys
      : new Set([key]);
    if (!selectedKeys.has(key)) {
      setSelectedKeys(new Set());
      setSelectionAnchor(key);
    }
    const selection = selectableTabs.filter((item) => contextKeys.has(item.key));
    menu.open(
      event,
      selection.length > 1 ? selectedTabMenu(selection) : singleItems(),
    );
  };

  // One live tab's menu is the layouts' shared one (chrome/tab-menu.tsx), so
  // the strip's tabs offer exactly these entries too.
  // A group made here is named by the host from its tabs; the name field opens only when it is not.
  const trackNewGroup = useNewGroupNaming(setRenaming);
  const tabMenu = useTabMenu({ onNewGroup: trackNewGroup });

  /** "Group selected tabs": the day tabs of a selection become one group. */
  const groupTabs = (tabIds: string[]): void => {
    const id = crypto.randomUUID();
    void tabGroupCommand({ type: "create", id, tabIds }).then((result) => {
      if (result !== null) trackNewGroup(id);
    });
  };
  const finishGroupRename = (groupId: string, title: string | null): void => {
    setRenaming(null);
    if (title !== null && title.trim() !== "") void tabGroupCommand({ type: "rename", groupId, title });
  };
  const { menu: groupMenu, close: closeGroup } = useTabGroupMenu({ onRename: setRenaming });

  const pinMenu = (pin: SidebarPin): MenuEntry[] => {
    const live = liveByAnchor.get(pin.id) ?? null;
    return [
      {
        label: live === null ? "Open" : "Show",
        onSelect: () => void sidebarCommand({ type: "open", anchorId: pin.id }),
      },
      ...(live !== null && live.url !== pin.url
        ? [
            {
              label: "Return to pinned page",
              icon: <Undo2 aria-hidden="true" />,
              onSelect: () =>
                void sidebarCommand({ type: "returnToPinned", pinId: pin.id }),
            },
          ]
        : []),
      { separator: true },
      {
        label: "Add to favorites",
        icon: <Star aria-hidden="true" />,
        onSelect: () =>
          void sidebarCommand({
            type: "addFavorite",
            source: { pinId: pin.id },
          }),
      },
      ...moveToFolderEntries(
        pin.folderId,
        (folderId) =>
          void sidebarCommand({
            type: "movePin",
            pinId: pin.id,
            folderId,
            index: 10_000,
          }),
      ),
      ...(pin.folderId === null
        ? [
            {
              label: "New folder with this page",
              icon: <FolderPlus aria-hidden="true" />,
              onSelect: () => newFolderWith(pin),
            },
          ]
        : [
            {
              label: "Remove from folder",
              icon: <FolderMinus aria-hidden="true" />,
              onSelect: () =>
                void sidebarCommand({
                  type: "movePin",
                  pinId: pin.id,
                  folderId: null,
                  index: 10_000,
                }),
            },
          ]),
      { separator: true },
      {
        label: live === null ? "Remove pin" : "Unpin",
        icon: <PinOff aria-hidden="true" />,
        onSelect: () => void sidebarCommand({ type: "unpin", pinId: pin.id }),
      },
      ...(live !== null
        ? [
            {
              label: "Close tab",
              icon: <X aria-hidden="true" />,
              danger: true,
              onSelect: () => void closeTab(live.id),
            },
          ]
        : []),
    ];
  };
  /** Right-click on the "Pinned" header: drop every pin (and the folders they sat in). */
  const pinnedSectionMenu = (): MenuEntry[] => {
    const pins = shelf.entries.filter((e): e is SidebarPin => e.kind === "pin");
    return [
      {
        label: "New folder",
        icon: <FolderPlus aria-hidden="true" />,
        onSelect: () => newFolder(),
      },
      { separator: true },
      {
        label: "Clear all pinned tabs",
        icon: <PinOff aria-hidden="true" />,
        danger: true,
        disabled: pins.length === 0 && folders.length === 0,
        onSelect: () => {
          for (const pin of pins) void sidebarCommand({ type: "unpin", pinId: pin.id });
          for (const folder of folders)
            void sidebarCommand({ type: "deleteFolder", folderId: folder.id });
        },
      },
    ];
  };
  /** Right-click on the "Live tabs" header: close every tab in the section. */
  const liveSectionMenu = (): MenuEntry[] => {
    const tabs = dayItems.flatMap((item) => item.tabs);
    return [
      {
        label: newTabAction.label,
        icon: newTabAction.icon,
        onSelect: () => newTabAction.run(),
      },
      { separator: true },
      {
        label: tidyAction.label,
        icon: <Sparkles aria-hidden="true" />,
        disabled: !tidyAction.enabled,
        onSelect: () => tidyAction.run(),
      },
      {
        label: archiveAction.label,
        icon: <Archive aria-hidden="true" />,
        onSelect: () => archiveAction.run(),
      },
      { separator: true },
      {
        label: "Close all tabs",
        icon: <X aria-hidden="true" />,
        danger: true,
        disabled: tabs.length === 0,
        onSelect: () => {
          for (const tab of tabs) void closeTab(tab.id);
        },
      },
    ];
  };
  const newFolderWith = (pin: SidebarPin): void => {
    const id = crypto.randomUUID();
    void sidebarCommand({
      type: "createFolder",
      id,
      name: "New folder",
      pinIds: [pin.id],
    });
    setRenaming(id);
  };

  const folderMenu = (folder: SidebarFolder): MenuEntry[] => [
    {
      label: "Rename",
      icon: <Pencil aria-hidden="true" />,
      onSelect: () => setRenaming(folder.id),
    },
    {
      swatches: FOLDER_SWATCHES,
      selected: folder.color ?? NO_FOLDER_COLOR,
      onPick: (color) =>
        void sidebarCommand({
          type: "styleFolder",
          folderId: folder.id,
          color: color === NO_FOLDER_COLOR ? null : (color as SidebarFolderColor),
        }),
    },
    {
      emoji: {
        choices: FOLDER_EMOJI,
        selected: folder.emoji,
        reset: { label: "Folder icon", icon: <FolderIcon aria-hidden="true" /> },
        parse: folderEmoji,
        onPick: (emoji) =>
          void sidebarCommand({ type: "styleFolder", folderId: folder.id, emoji }),
      },
    },
    { separator: true },
    {
      label: folder.collapsed ? "Expand" : "Collapse",
      onSelect: () =>
        void sidebarCommand({ type: "toggleFolder", folderId: folder.id }),
    },
    {
      label: "New folder",
      icon: <FolderPlus aria-hidden="true" />,
      onSelect: () => newFolder(),
    },
    { separator: true },
    {
      label: "Delete folder",
      icon: <FolderMinus aria-hidden="true" />,
      danger: true,
      onSelect: () =>
        void sidebarCommand({ type: "deleteFolder", folderId: folder.id }),
    },
    {
      label: "Delete folder and pins",
      icon: <Trash2 aria-hidden="true" />,
      danger: true,
      disabled: childrenOf(shelf.entries, folder.id).length === 0,
      onSelect: () =>
        void sidebarCommand({
          type: "deleteFolder",
          folderId: folder.id,
          includePins: true,
        }),
    },
  ];

  const groupItem = (unit: Extract<DayUnit, { kind: "group" }>): ShelfItem => {
    const [first] = unit.tabs;
    return {
      flipId: unit.id,
      kind: "group",
      entityId: unit.id,
      groupId: unit.group.id,
      title: unit.group.title,
      url: first?.url ?? "",
      faviconUrl: first?.faviconUrl ?? null,
      tabs: unit.tabs,
    };
  };
  /** One of the day's rows — at the top level, or inside the tab group `groupId`. */
  const renderRow = (item: RowItem, groupId: string | null): React.ReactNode => {
    const [first] = item.tabs;
    if (first === undefined) return null;
    const openMenu = (tab: ChromeTab, e: React.MouseEvent): void => {
      setMenuGroupId(groupId);
      openTabContextMenu(tabSelectionKey(tab.id), e, () => tabMenu(tab));
    };
    return item.tabs.length === 1 ? (
      <TabRow
        key={item.id}
        flipId={item.id}
        tab={first}
        memberOf={groupId}
        selected={isShownSelected(tabSelectionKey(first.id))}
        dragging={grabbedId === item.id}
        onActivate={(event) => activate(first.id, event)}
        onPointerDown={(e) => beginPress(itemFor(item), e)}
        onContextMenu={(e) => openMenu(first, e)}
      />
    ) : (
      <SplitRow
        key={item.id}
        flipId={item.id}
        tabs={item.tabs}
        memberOf={groupId}
        selectedTabIds={selectedDayTabIds}
        dragging={grabbedId === item.id}
        onActivate={activate}
        onPointerDown={(e) => beginPress(itemFor(item), e)}
        onContextMenu={openMenu}
      />
    );
  };

  const itemFor = (row: RowItem): ShelfItem => {
    const [first] = row.tabs;
    return {
      flipId: row.id,
      kind: row.tabs.length > 1 ? "split" : "tab",
      entityId: row.id,
      title: first?.title ?? "",
      url: first?.url ?? "",
      faviconUrl: first?.faviconUrl ?? null,
      tabs: row.tabs,
    };
  };
  const pinItem = (pin: SidebarPin): ShelfItem => {
    const live = liveByAnchor.get(pin.id);
    return {
      flipId: pin.id,
      kind: "pin",
      entityId: pin.id,
      title: pin.title,
      url: pin.url,
      faviconUrl: pin.faviconUrl,
      tabs: live === undefined ? [] : [live],
    };
  };
  const folderItem = (folder: SidebarFolder): ShelfItem => ({
    flipId: folder.id,
    kind: "folder",
    entityId: folder.id,
    title: folder.name,
    url: "",
    faviconUrl: null,
    tabs: [],
  });

  return (
    <>
      <div
        ref={scrollerRef}
        data-testid="sidebar-tab-list"
        onPointerMove={(e) => {
          pointerAt.current = { x: e.clientX, y: e.clientY };
        }}
        className="no-drag scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      >
        <div
          ref={listRef}
          className="relative flex flex-col gap-0.5 px-2 py-1"
          style={{ paddingBottom: mediaInset + 4 }}
        >
          {rows.length > 0 ? (
            <SectionHeader
              id="pinned"
              label="Pinned"
              count={rows.length}
              open={sectionOpen("pinned")}
              onToggle={() => toggleSection("pinned")}
              onContextMenu={(e) => {
                e.preventDefault();
                menu.open(e, pinnedSectionMenu());
              }}
            />
          ) : null}
          <SectionBody open={sectionOpen("pinned")} unclipped={drag !== null}>
            <div
              role="list"
              aria-label="Pinned"
              id="sidebar-section-pinned"
              data-testid="pinned-section"
              className="flex flex-col gap-0.5"
            >
              {rows.map((row) =>
                row.kind === "folder" ? (
                  <FolderRow
                    key={row.folder.id}
                    folder={row.folder}
                    count={row.count}
                    receiving={receivingFolderId === row.folder.id}
                    renaming={renaming === row.folder.id}
                    dragging={grabbedId === row.folder.id}
                    onToggle={() => {
                      if (!justDragged())
                        void sidebarCommand({
                          type: "toggleFolder",
                          folderId: row.folder.id,
                        });
                    }}
                    onRename={(name) =>
                      renaming === row.folder.id
                        ? finishRename(row.folder.id, name)
                        : setRenaming(row.folder.id)
                    }
                    onPointerDown={(e) => beginPress(folderItem(row.folder), e)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      menu.open(e, folderMenu(row.folder));
                    }}
                  />
                ) : (
                  <PinRow
                    key={row.pin.id}
                    pin={row.pin}
                    depth={row.depth}
                    live={liveFor(row.pin)}
                    selected={isShownSelected(pinSelectionKey(row.pin.id))}
                    dragging={grabbedId === row.pin.id}
                    onOpen={(event) => openPin(row.pin, event)}
                    onPointerDown={(e) => beginPress(pinItem(row.pin), e)}
                    onContextMenu={(e) => {
                      openTabContextMenu(
                        pinSelectionKey(row.pin.id),
                        e,
                        () => pinMenu(row.pin),
                      );
                    }}
                  />
                ),
              )}
            </div>
          </SectionBody>
          <NewTabRow onNewFolder={() => newFolder()} />
          <div className="group/live flex min-w-0 items-center gap-0.5">
            {/* The header is w-full by itself; here it shares its row. */}
            <div className="min-w-0 flex-1">
            <SectionHeader
              id="live"
              label="Live tabs"
              count={units.length}
              open={sectionOpen("live")}
              busyLabel={tidyRunning ? "Tidying tabs…" : null}
              onToggle={() => toggleSection("live")}
              onContextMenu={(e) => {
                e.preventDefault();
                menu.open(e, liveSectionMenu());
              }}
            />
            </div>
            {/* Tidy, where the tabs it tidies are (docs/tab-tidy.md §3.2): there on hover, and for as long as a run takes. */}
            <button
              type="button"
              title={tidyRunning ? "Tidying tabs…" : "Tidy tabs — archive idle tabs and group related ones"}
              aria-label="Tidy tabs"
              data-testid="tidy-tabs-button"
              data-running={tidyRunning ? "" : undefined}
              disabled={tidyRunning}
              onClick={() => tidyAction.run()}
              className="no-drag grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-gray-700 opacity-0 outline-none transition-[opacity,background-color,color] duration-150 group-hover/live:opacity-100 hover:bg-alpha-200 hover:text-gray-1000 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default data-[running]:opacity-100 motion-reduce:transition-none"
            >
              <Sparkles aria-hidden="true" className={cn("size-3.5", tidyRunning && "animate-pulse text-green-900")} />
            </button>
          </div>
          <SectionBody open={sectionOpen("live")} unclipped={drag !== null}>
            <div
              role="tablist"
              aria-orientation="vertical"
              aria-label="Open tabs"
              aria-busy={tidyRunning}
              id="sidebar-section-live"
              data-tidying={tidyRunning ? "" : undefined}
              // While Tidy reads the tabs a light sweeps down the list, so a run
              // that takes a few seconds reads as work under way on these rows.
              className={cn("flex flex-col gap-0.5", tidyRunning && "tidy-sweep")}
            >
              {units.map((unit) =>
                unit.kind === "row" ? (
                  renderRow(unit.row, null)
                ) : (
                  <TabGroupRow
                    key={unit.id}
                    group={unit.group}
                    flipId={unit.id}
                    tabs={unit.tabs}
                    // A group in hand is drawn closed: it is one thing being moved.
                    expanded={grabbedId !== unit.id && isExpanded(unit)}
                    held={isHeld(unit)}
                    snapClose={drag !== null || snapCloseId === unit.group.id}
                    renaming={renaming === unit.group.id}
                    receiving={receivingGroupId === unit.group.id}
                    dragging={grabbedId === unit.id}
                    onHover={(inside) => onGroupHover(unit.group.id, inside)}
                    onToggleOpen={() => {
                      if (!justDragged()) toggleGroup(unit);
                    }}
                    onRename={(title) => (renaming === unit.group.id ? finishGroupRename(unit.group.id, title) : setRenaming(unit.group.id))}
                    onOpenAsSplit={() => void tabGroupCommand({ type: "openAsSplit", groupId: unit.group.id })}
                    onClose={() => closeGroup(unit.group)}
                    onPointerDown={(e) => beginPress(groupItem(unit), e)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenuGroupId(unit.group.id);
                      menu.open(e, groupMenu(unit.group));
                    }}
                  >
                    {unit.rows.map((row) => renderRow(row, unit.group.id))}
                  </TabGroupRow>
                ),
              )}
            </div>
          </SectionBody>
        </div>
      </div>
      {menu.menu}
    </>
  );
}
