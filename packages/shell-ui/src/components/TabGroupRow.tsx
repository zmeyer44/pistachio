/**
 * A tab group in the sidebar's list (docs/tab-tidy.md §3.3): ONE row at rest
 * — a cluster of its tabs' icons made small, its title in its colour, its
 * count — that opens in place when the pointer settles on it, showing its
 * tabs as ordinary rows under a rail of the same colour.
 *
 * The row decides nothing about WHEN it is open: the list does
 * (components/TabList.tsx), because only one group is ever open by hover and
 * the list keeps the hovered header still under the pointer while another
 * group closes above it. This file draws the two states and reports the
 * pointer's coming and going.
 *
 * The favicon cluster and the colour tone are shared with the strip's chip
 * (components/TabStrip.tsx) and the archive page.
 */

import { useEffect, useState } from "react";
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

/** One bubble of the stack: where it sits in the 20px field, how big it is, and how far it leans. */
interface Bubble {
  x: number;
  y: number;
  size: number;
}

/**
 * The stack's arrangements, in px within a 20×20 field. Hand-placed rather
 * than computed, because what makes a pile of icons read as a PILE is that
 * it is a little uneven: the sizes differ by a hair, nothing shares an edge,
 * and each bubble overlaps the one before it. Later bubbles sit on top.
 */
const STACKS: Record<1 | 2 | 3 | 4, readonly Bubble[]> = {
  1: [{ x: 2, y: 2, size: 16 }],
  2: [
    { x: 0, y: 0, size: 12 },
    { x: 7, y: 7, size: 13 },
  ],
  3: [
    { x: 5, y: 0, size: 11 },
    { x: 0, y: 7.5, size: 11.5 },
    { x: 8.5, y: 9, size: 11 },
  ],
  4: [
    { x: 0, y: 0, size: 12 },
    { x: 9.5, y: 1.5, size: 10 },
    { x: 1.5, y: 10, size: 10 },
    { x: 8.5, y: 8.5, size: 11.5 },
  ],
};

/**
 * A group's tabs as one mark: their icons as a small pile of round bubbles,
 * overlapping the way a stack of avatars does — one large, two on the
 * diagonal, three in a loose triangle, and past four, three with a badge
 * counting the rest. Each bubble is ringed in the surface's colour so the
 * overlaps read as one thing in front of another.
 *
 * The pile is drawn in a 20px field but takes only the 16px a tab's icon
 * does in layout, so a group's title lines up with the tab titles around it.
 */
export function FaviconCluster({ tabs, className }: { tabs: readonly ClusterTab[]; className?: string }) {
  const seed = (tab: ClusterTab): string => displayHost(tab.url) || tab.title;
  const shown = tabs.length > 4 ? tabs.slice(0, 3) : tabs.slice(0, 4);
  const more = tabs.length - shown.length;
  const slots = STACKS[Math.min(4, Math.max(1, shown.length + (more > 0 ? 1 : 0))) as 1 | 2 | 3 | 4];
  const place = (bubble: Bubble | undefined): React.CSSProperties => ({ left: bubble?.x ?? 0, top: bubble?.y ?? 0, width: bubble?.size ?? 0, height: bubble?.size ?? 0 });
  const bubble = "absolute grid place-items-center overflow-hidden rounded-full bg-background-100 shadow-[0_0_0_1.5px_var(--color-background-100),0_1px_2px_rgb(0_0_0/0.22)]";
  return (
    <span aria-hidden="true" data-testid="favicon-cluster" className={cn("relative -mx-0.5 size-5 shrink-0", className)}>
      {shown.length === 0 ? <span className={bubble} style={place(STACKS[1][0])} /> : null}
      {shown.map((tab, index) => (
        <span key={index} className={bubble} style={place(slots[index])}>
          {/* The icon FILLS its bubble, as a face fills an avatar: the bubble clips it round, and an icon
              drawn on transparency shows the bubble's own surface behind it. A page with no icon is the
              group's colour — a letter this small reads as dirt; alone, it has room for its letter.
              (`leading-none` is said AGAIN after the size: the class merger drops the tile's own when
              a font size follows it, and the letter then sits low on the row's line height.) */}
          <Favicon
            letter={shown.length === 1}
            src={tab.faviconUrl}
            seed={seed(tab)}
            className={cn(
              "size-full rounded-none object-cover",
              tab.faviconUrl === null && (shown.length === 1 ? "bg-(--tg-tint-strong) text-[8.5px] leading-none text-(--tg-text)" : "bg-(--tg-solid)/55"),
            )}
          />
        </span>
      ))}
      {more > 0 ? (
        <span className={cn(bubble, "bg-(--tg-solid) text-[5.5px] leading-none font-bold tracking-tight text-white")} style={place(slots[shown.length])}>
          {more > 9 ? "+" : `+${String(more)}`}
        </span>
      ) : null}
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
 * it is a different material from the sidebar it sits in.
 */
function GroupTitleInput({ title, onDone }: { title: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(title);
  return (
    <input
      autoFocus
      aria-label="Group name"
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
      placeholder="Group name"
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
  onClose,
  onPointerDown,
  onContextMenu,
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
  onOpenAsSplit: () => void;
  onClose: () => void;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  /** The member rows, drawn while the group is open. */
  children: React.ReactNode;
}) {
  const count = tabs.length;
  return (
    <div
      role="group"
      aria-label={`Tab group: ${group.title}`}
      data-testid="tab-group"
      data-group-id={group.id}
      data-group-color={group.color}
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
        title={renaming ? undefined : `${group.title}\n${String(count)} ${count === 1 ? "tab" : "tabs"}`}
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
        style={{ height: ROW_H }}
        className={cn(
          "group/tg relative flex shrink-0 touch-none items-center gap-2 rounded-md bg-(--tg-tint) px-2 text-[12.5px] font-medium text-(--tg-text) outline-none transition-colors duration-150 hover:bg-(--tg-tint-strong) focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          dragging ? "cursor-grabbing" : "cursor-pointer",
          receiving && "bg-(--tg-tint-strong) ring-1 ring-(--tg-solid) ring-inset",
          // Being named: the row itself is the field — a shade deeper, ringed softly in its own colour.
          renaming && "cursor-text bg-(--tg-tint-strong) ring-1 ring-(--tg-solid)/55 ring-inset",
        )}
      >
        <FaviconCluster tabs={tabs} />
        {renaming ? (
          <GroupTitleInput title={group.title} onDone={onRename} />
        ) : (
          <span className="min-w-0 flex-1 truncate" data-testid="tab-group-title" data-naming={group.naming === true ? "" : undefined}>
            {/* The host is asking the model what to call it: say so, rather than flash a placeholder that is about to change. */}
            {group.naming === true ? <span className="animate-pulse font-normal opacity-70 motion-reduce:animate-none">Naming…</span> : group.title}
          </span>
        )}
        {renaming ? null : (
          <span className="relative flex h-6 w-12 shrink-0 items-center justify-end">
            {/* The count gives way to the controls on hover — both always in layout, so the title's
                width never changes under the pointer. */}
            <span data-testid="tab-group-count" className="text-[10.5px] font-normal opacity-80 transition-opacity duration-150 group-focus-within/tg:opacity-0 group-hover/tg:opacity-0 motion-reduce:transition-none">
              {count}
            </span>
            <span className="pointer-events-none absolute right-0 flex items-center opacity-0 transition-opacity duration-150 group-focus-within/tg:pointer-events-auto group-focus-within/tg:opacity-100 group-hover/tg:pointer-events-auto group-hover/tg:opacity-100 motion-reduce:transition-none">
              <HeaderButton label={count > 4 ? "Open 4 most recent as split view" : "Open as split view"} testId="tab-group-split" disabled={count < 2} onClick={onOpenAsSplit}>
                <Columns2 aria-hidden="true" />
              </HeaderButton>
              <HeaderButton label="Close group" testId="tab-group-close" onClick={onClose}>
                <X aria-hidden="true" />
              </HeaderButton>
            </span>
          </span>
        )}
        {renaming ? null : (
          // Always there, so how to fold a group away is never a mystery: it points down while the
          // group is open and right while it is folded, and is only faint while a hover is peeking in.
          <HeaderButton label={held ? "Collapse group" : expanded ? "Keep group open" : "Expand group"} testId="tab-group-toggle" onClick={onToggleOpen}>
            <ChevronDown
              aria-hidden="true"
              data-testid="tab-group-chevron"
              className={cn("transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none", expanded ? "rotate-0" : "-rotate-90", held ? "opacity-100" : expanded ? "opacity-55" : "opacity-70")}
            />
          </HeaderButton>
        )}
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
function GroupMembers({ open, snap, label, children }: { open: boolean; snap: boolean; label: string; children: React.ReactNode }) {
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
      <div className="min-h-0 overflow-hidden">
        <div role="tablist" aria-orientation="vertical" aria-label={label} data-testid="tab-group-members" className="tab-group-members relative mt-0.5 ml-[15px] flex flex-col gap-0.5 border-l-2 border-(--tg-tint-strong) pl-1.5">
          {children}
        </div>
      </div>
    </div>
  );
}
