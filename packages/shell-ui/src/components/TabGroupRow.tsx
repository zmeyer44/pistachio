/**
 * A tab group — a space (docs/spaces.md) — in the sidebar's list
 * (docs/tab-tidy.md §3.3): ONE row at rest — a cluster of its tabs' icons
 * made small, its title in its colour, its count — that opens in place when
 * the pointer settles on it, showing its tabs as ordinary rows under a rail
 * of the same colour. An EMPTY space (since 2026-10-09) is its name and
 * colour alone: its mark a ring of its colour (with its Stack's pile over it
 * when it holds something), no count, nothing to open but — the current
 * space's — its Stack's row.
 *
 * The row decides nothing about WHEN it is open: the list does
 * (components/TabList.tsx), because only one group is ever open by hover and
 * the list keeps the hovered header still under the pointer while another
 * group closes above it. This file draws the two states and reports the
 * pointer's coming and going.
 *
 * The favicon cluster and the colour tone are shared with the archive page.
 */

import { Children, useEffect, useState } from "react";
import { ChevronDown, Columns2, X } from "lucide-react";
import { MAX_TAB_GROUP_TITLE, type TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { cn } from "../lib/cn";
import { displayHost } from "../lib/url";
import { Favicon } from "./Favicon";

const ROW_H = 32;

/** What the cluster needs of a tab: enough for an icon or its letter tile. */
export interface ClusterTab {
  title: string;
  url: string;
  faviconUrl: string | null;
}

/**
 * A group's tabs as one mark, in the favorites folder's style (RailFavorites):
 * its first four tabs' icons in a 2×2 of small squares, each icon filling its
 * square, left to right and down; a tab with no icon is a square of the
 * group's colour. On the desk's rail, where the row says nothing else, the
 * mark is a tile of the group's colour and a badge says how many tabs it
 * holds, as the favorites folder's says how many favorites (the whole
 * sidebar's row says the count beside the title instead).
 *
 * With no tabs — an empty space, or an archived one filed without any — the
 * mark is a ring of the group's colour, and no count: there is nothing to
 * count. `stack`, how many things its Stack holds, lays a small pile of
 * sheets over the ring (the Stack's own mark, DeskContextRow's).
 *
 * The mark is drawn in a 20px field but takes only the 16px a tab's icon
 * does in layout, so a group's title lines up with the tab titles around it.
 */
export function FaviconCluster({ tabs, stack = 0, className }: { tabs: readonly ClusterTab[]; stack?: number; className?: string }) {
  const seed = (tab: ClusterTab): string => displayHost(tab.url) || tab.title;
  const shown = tabs.slice(0, 4);
  if (shown.length === 0)
    return (
      <span aria-hidden="true" data-testid="favicon-cluster" data-empty="" className={cn("tab-group-mosaic relative -mx-0.5 size-5 shrink-0", className)}>
        <span data-testid="space-empty-mark" className="tab-group-ring" />
        {stack > 0 ? (
          <span className="tab-group-ring-stack desk-context-pile">
            <span className="desk-context-sheet" data-layer="2" />
            <span className="desk-context-sheet" data-layer="1" />
          </span>
        ) : null}
      </span>
    );
  return (
    <span aria-hidden="true" data-testid="favicon-cluster" className={cn("tab-group-mosaic relative -mx-0.5 size-5 shrink-0", className)}>
      <span className="tab-group-mosaic-grid" data-count={Math.max(1, shown.length)}>
        {shown.map((tab, index) => (
          // A page with no icon is the group's colour: a letter this small reads as dirt.
          <Favicon
            key={index}
            letter={false}
            src={tab.faviconUrl}
            seed={seed(tab)}
            className={cn("tab-group-mosaic-cell object-cover", tab.faviconUrl === null && "bg-(--tg-solid)/55")}
          />
        ))}
      </span>
      <span className="tab-group-mosaic-count">{tabs.length}</span>
    </span>
  );
}

/** A small control on the header's hover, as the pinned rows have. */
function HeaderButton({ label, testId, onClick, disabled = false, children }: { label: string; testId: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className="grid size-6 cursor-pointer place-items-center rounded-md text-(--tg-text) outline-none transition-[background-color,transform] duration-150 hover:bg-(--tg-tint-strong) focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] disabled:cursor-default disabled:opacity-40 motion-reduce:transition-none motion-reduce:active:scale-100 [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}

/**
 * The title field: ↵ or blur commits, Escape keeps the old title.
 *
 * An edit IN PLACE, not a form control dropped into the row: the words stay
 * exactly where the title was, in the group's own colour and weight, with no
 * box around them. What says "you are typing" is the row (its ring, below),
 * the caret, and the selection — all in the group's colour, so nothing about
 * it is a different material from the sidebar it sits in. A desk's dock
 * edits a group's name with it too, on a card beside the group's icon.
 */
export function GroupTitleInput({ title, onDone }: { title: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(title);
  return (
    <input
      autoFocus
      aria-label="Space name"
      data-testid="tab-group-name-input"
      value={value}
      maxLength={MAX_TAB_GROUP_TITLE}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => onDone(value)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onDone(value);
        if (e.key === "Escape") onDone(null);
      }}
      spellCheck={false}
      autoComplete="off"
      placeholder="Space name"
      className="h-6 min-w-0 flex-1 bg-transparent p-0 text-[12.5px] font-medium text-(--tg-text) caret-(--tg-solid) outline-none selection:bg-(--tg-solid)/30 selection:text-(--tg-text) placeholder:text-(--tg-text)/45"
    />
  );
}

export function TabGroupRow({
  group,
  flipId,
  tabs,
  expanded,
  held,
  snapClose = false,
  renaming,
  receiving = false,
  dragging = false,
  onHover,
  onToggleOpen,
  onRename,
  onOpenAsSplit,
  current = false,
  stack = 0,
  onClose,
  onPointerDown,
  onContextMenu,
  mark,
  onHeaderHover,
  children,
}: {
  group: TabGroupInfo;
  flipId: string;
  /** The group's tabs in its own order, for the cluster and the count. */
  tabs: readonly ClusterTab[];
  expanded: boolean;
  /** Open because the person (or the tab in view) holds it open — not just a hover's peek. The chevron says which. */
  held: boolean;
  /** Close without the exit animation: the list is keeping a row still under the pointer, or a drag is measuring rows. */
  snapClose?: boolean;
  renaming: boolean;
  /** A drag would drop into this group. */
  receiving?: boolean;
  dragging?: boolean;
  /** The pointer (or keyboard focus) came to the group, or left it. */
  onHover: (inside: boolean) => void;
  /** A click on the header or its chevron: hold the group open, or fold it away. */
  onToggleOpen: () => void;
  /** Called with null to START renaming (a double click), then with the new title — or null — when the field is done. */
  onRename: (title: string | null) => void;
  /** Show its tabs side by side: the web's alone (splitAvailable); absent on the desktop, where a desk tiles windows. */
  onOpenAsSplit?: () => void;
  /** The current space: the one the desk shows (ShellSnapshot.currentGroupId). */
  current?: boolean;
  /** An empty space's Stack: how many things it holds, drawn as a pile over its mark. */
  stack?: number;
  onClose: () => void;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  /** On the rail, where a group of one tab is that tab: its window's mark on the desk (DeskRowMark), at the header's edge. */
  mark?: React.ReactNode;
  /** The pointer onto the header and off it: on the rail a group of one tab's header is that tab's row (its desk's ⇧⌫). */
  onHeaderHover?: (inside: boolean) => void;
  /** The member rows, drawn while the group is open. */
  children: React.ReactNode;
}) {
  const count = tabs.length;
  const empty = count === 0;
  return (
    <div
      role="group"
      aria-label={`Space: ${group.title}`}
      data-testid="tab-group"
      data-group-id={group.id}
      data-group-color={group.color}
      data-current={current ? "" : undefined}
      data-empty={empty ? "" : undefined}
      data-expanded={expanded ? "" : undefined}
      // One UNIT among the day's rows, whatever it holds. The drag measures
      // its header as the group's row and, while it is open, each tab below
      // as a `member` row — a slot INSIDE the group (lib/sidebar-tree.ts).
      data-flip-id={flipId}
      data-row-kind="group"
      data-entity-id={flipId}
      data-collapsed={expanded ? undefined : ""}
      data-receiving={receiving ? "" : undefined}
      onPointerEnter={() => onHover(true)}
      // A move says it again: after a drag (which hears no enter) or a layout
      // change under a still pointer, the first move is what puts things right.
      onPointerMove={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onHover(false);
      }}
      className={cn("tab-group-tone no-drag relative flex shrink-0 flex-col rounded-md", dragging && "z-30")}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        data-testid="tab-group-header"
        data-group-header=""
        title={renaming ? undefined : empty ? group.title : `${group.title}\n${String(count)} ${count === 1 ? "tab" : "tabs"}`}
        onClick={() => {
          if (!renaming) onToggleOpen();
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (!renaming) onRename(null);
        }}
        onKeyDown={(e) => {
          if (renaming || e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleOpen();
          }
          if (e.key === "F2") onRename(null);
        }}
        onPointerDown={onPointerDown}
        onContextMenu={onContextMenu}
        onPointerEnter={onHeaderHover === undefined ? undefined : () => onHeaderHover(true)}
        onPointerLeave={onHeaderHover === undefined ? undefined : () => onHeaderHover(false)}
        style={{ height: ROW_H }}
        className={cn(
          "group/tg relative flex shrink-0 touch-none items-center gap-2 rounded-md bg-(--tg-tint) px-2 text-[12.5px] font-medium text-(--tg-text) outline-none transition-colors duration-150 hover:bg-(--tg-tint-strong) focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          dragging ? "cursor-grabbing" : "cursor-pointer",
          receiving && "bg-(--tg-tint-strong) ring-1 ring-(--tg-solid) ring-inset",
          // Being named: the row itself is the field — a shade deeper, ringed softly in its own colour.
          renaming && "cursor-text bg-(--tg-tint-strong) ring-1 ring-(--tg-solid)/55 ring-inset",
        )}
      >
        <FaviconCluster tabs={tabs} stack={stack} />
        {renaming ? (
          <GroupTitleInput title={group.title} onDone={onRename} />
        ) : (
          <span className="min-w-0 flex-1 truncate" data-testid="tab-group-title" data-naming={group.naming === true ? "" : undefined}>
            {/* The host is asking the model what to call it: say so, rather than flash a placeholder that is about to change. */}
            {group.naming === true ? <span className="animate-pulse font-normal opacity-70 motion-reduce:animate-none">Naming…</span> : group.title}
          </span>
        )}
        {renaming ? null : (
          <span className="flex h-6 shrink-0 items-center">
            {/* The count gives way to the controls on hover, as a tab's rest mark does (TabTrailing):
                two clip boxes that cross, so the title runs as wide as the count allows at rest and
                only gives up the controls' width while they are out. */}
            <span className="grid grid-cols-[0fr] opacity-0 transition-[grid-template-columns,opacity] duration-200 ease-out group-focus-visible/tg:grid-cols-[1fr] group-focus-visible/tg:opacity-100 group-has-[:focus-visible]/tg:grid-cols-[1fr] group-has-[:focus-visible]/tg:opacity-100 group-hover/tg:grid-cols-[1fr] group-hover/tg:opacity-100 motion-reduce:transition-none">
              <span className="flex min-w-0 items-center overflow-hidden">
                {/* (No desk button since 2026-10-09: the desk is always up, and the row itself chooses the space.) */}
                {onOpenAsSplit === undefined ? null : (
                  <HeaderButton label={count > 4 ? "Open 4 most recent as split view" : "Open as split view"} testId="tab-group-split" disabled={count < 2} onClick={onOpenAsSplit}>
                    <Columns2 aria-hidden="true" />
                  </HeaderButton>
                )}
                <HeaderButton label="Close space" testId="tab-group-close" onClick={onClose}>
                  <X aria-hidden="true" />
                </HeaderButton>
              </span>
            </span>
            <span className="grid grid-cols-[1fr] transition-[grid-template-columns,opacity] duration-200 ease-out group-focus-visible/tg:grid-cols-[0fr] group-focus-visible/tg:opacity-0 group-has-[:focus-visible]/tg:grid-cols-[0fr] group-has-[:focus-visible]/tg:opacity-0 group-hover/tg:grid-cols-[0fr] group-hover/tg:opacity-0 motion-reduce:transition-none">
              <span className="flex min-w-0 items-center justify-end overflow-hidden">
                {/* (An empty space has nothing to count.) */}
                {empty ? null : (
                  <span data-testid="tab-group-count" className="text-[10.5px] font-normal opacity-80">
                    {count}
                  </span>
                )}
              </span>
            </span>
          </span>
        )}
        {renaming || (empty && !current) ? null : (
          // Always there, so how to fold a group away is never a mystery: it points down while the
          // group is open and right while it is folded, and is only faint while a hover is peeking in.
          // (An empty space has nothing to fold, unless it is the current one, its Stack's row under it.)
          <HeaderButton label={held ? "Collapse space" : expanded ? "Keep space open" : "Expand space"} testId="tab-group-toggle" onClick={onToggleOpen}>
            <ChevronDown
              aria-hidden="true"
              data-testid="tab-group-chevron"
              className={cn("transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none", expanded ? "rotate-0" : "-rotate-90", held ? "opacity-100" : expanded ? "opacity-55" : "opacity-70")}
            />
          </HeaderButton>
        )}
        {mark}
      </div>
      <GroupMembers open={expanded} snap={snapClose || dragging} label={`${group.title} tabs`}>
        {children}
      </GroupMembers>
    </div>
  );
}

/** How long a group takes to fold away; the rows below it glide up with it. */
const MEMBERS_EXIT_MS = 200;

/**
 * The member rows under their rail. They appear at once (each row fades in —
 * the list's anti-ripple hover depends on an opening group taking its full
 * height in one render), but they LEAVE smoothly: the box folds to nothing
 * and fades, and only then are the rows unmounted. While folding the rows
 * are inert and marked `data-exiting`, so the drag does not measure them.
 * Opening again mid-fold simply unfolds the same rows.
 */
function GroupMembers({ open: wanted, snap, label, children }: { open: boolean; snap: boolean; label: string; children: React.ReactNode }) {
  // Nothing to draw (an empty space's, not the current one): no strip either, open or not.
  const open = wanted && Children.toArray(children).length > 0;
  const [present, setPresent] = useState(open);
  // Derived in render, so an opening group has its height in the same frame.
  if (open && !present) setPresent(true);
  if (!open && present && snap) setPresent(false);
  const exiting = !open && present;
  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(() => setPresent(false), MEMBERS_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [exiting]);
  if (!open && !present) return null;
  return (
    <div
      data-exiting={exiting ? "" : undefined}
      aria-hidden={exiting || undefined}
      inert={exiting}
      className={cn(
        "grid transition-[grid-template-rows,opacity] ease-out motion-reduce:transition-none",
        exiting ? "grid-rows-[0fr] opacity-0 duration-200" : "grid-rows-[1fr] opacity-100 duration-150",
      )}
    >
      {/* Clipped only as it folds, top to bottom: across, a mark may stand past the rows' edge — on the rail, the
          Stack's count on its pile's corner. No wider than the column for that: unclipped, it is no scroll container,
          and would grow to its longest title (the rows past the sidebar's edge, their titles cut with no ellipsis). */}
      <div className="min-h-0 min-w-0 overflow-x-visible overflow-y-clip">
        <div role="tablist" aria-orientation="vertical" aria-label={label} data-testid="tab-group-members" className="tab-group-members relative mt-0.5 ml-[15px] flex flex-col gap-0.5 border-l-2 border-(--tg-tint-strong) pl-1.5">
          {children}
        </div>
      </div>
    </div>
  );
}
