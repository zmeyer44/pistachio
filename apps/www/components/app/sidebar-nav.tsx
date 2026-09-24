"use client";

/**
 * The dashboard rail's nav: a menu stack whose menus PUSH rather than swap.
 * Selecting a group slides its menu in from the right over the one that
 * opened it; the back control slides the parent menu back in from the left.
 *
 * The push is opaque, not a crossfade. A crossfade leaves both label sets
 * legible on top of each other for a beat, so the incoming panel carries the
 * rail's own background and occludes the outgoing one, which trails at a
 * quarter distance for depth and empties its opacity over the first half of
 * the travel. Timings and curve live in app/app/app.css (`.pa-menu-*`), which
 * also owns the reduced-motion form. This is the desktop settings rail's
 * transition, on the same clock.
 *
 * WHICH MENU IS OPEN IS A FUNCTION OF THE ADDRESS. Any navigation into a
 * group's pages opens that group — a deep link, the back button. The back
 * control is the one exception: it steps up a level WITHOUT navigating (you
 * are still on the page you were reading), which is why the open menu is
 * state rather than a pure derivation of the path.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  APP_NAV,
  isActive,
  isNavGroup,
  type NavEntry,
  type NavGroup,
  type NavItem,
  type NavSection,
} from "./nav-config";

/** Must outlast the longest `.pa-menu-*` animation in app.css. */
const PUSH_MS = 320;

export function SidebarNav(): ReactNode {
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const { direction, focusTarget, groupPath, onBack, onOpenGroup } = useNavDrilldown(pathname);
  const panels = usePushStack(groupPath.join("/"), direction);
  const searching = query.trim() !== "";
  const matches = useMemo(() => matchingItems(query), [query]);
  // The row Enter opens. Reset to the first match whenever the query changes:
  // an index into the old list is meaningless against the new one.
  const [cursor, setCursor] = useState(0);
  const [cursorQuery, setCursorQuery] = useState(query);
  if (cursorQuery !== query) {
    setCursorQuery(query);
    setCursor(0);
  }
  const resultsId = useId();
  const active = matches[Math.min(cursor, Math.max(matches.length - 1, 0))] ?? null;

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      setQuery("");
      return;
    }
    if (!searching || matches.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((current) => (current + 1) % matches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((current) => (current - 1 + matches.length) % matches.length);
    } else if (event.key === "Enter" && active !== null) {
      event.preventDefault();
      setQuery("");
      router.push(active.href);
    }
  };

  return (
    <>
      <div className="px-3 pb-2">
        <SearchBox
          activeId={active === null || !searching ? undefined : optionId(resultsId, active.key)}
          expanded={searching}
          listId={resultsId}
          onChange={setQuery}
          onKeyDown={onSearchKey}
          value={query}
        />
      </div>

      {/*
        overflow-clip, not -hidden: a hidden box is still programmatically
        scrollable, so anything that scrolls-into-view (focus, a screen reader)
        can shove the clipped menu sideways and cancel the push. clip forbids
        scrolling outright.
      */}
      <nav aria-label="Dashboard sections" className="relative isolate min-h-0 flex-1 overflow-clip">
        {searching ? (
          <Results
            activeKey={active?.key ?? null}
            id={resultsId}
            matches={matches}
            onHover={(index) => {
              setCursor(index);
            }}
            onPick={() => {
              setQuery("");
            }}
            pathname={pathname}
            query={query}
          />
        ) : (
          panels.map((panel) => {
            const groups = resolveGroupPath(panel.key);
            const group = groups[groups.length - 1] ?? null;
            return (
              <Menu
                className={panel.className}
                focusTarget={panel.leaving ? null : focusTarget}
                group={group}
                inert={panel.leaving}
                key={panel.key}
                onBack={onBack}
                onOpenGroup={(entry) => {
                  onOpenGroup(entry.key);
                  router.push(entry.href);
                }}
                pathname={pathname}
                sections={group === null ? APP_NAV : [{ key: group.key, items: group.items }]}
              />
            );
          })
        )}
      </nav>
    </>
  );
}

/* ------------------------------- the search ------------------------------- */

/** Every leaf whose label contains the query, in nav order. */
function matchingItems(query: string): NavItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const walk = (entries: NavEntry[]): NavItem[] =>
    entries.flatMap((entry) => (isNavGroup(entry) ? walk(entry.items) : [entry]));
  return walk(APP_NAV.flatMap((section) => section.items)).filter((item) => item.label.toLowerCase().includes(needle));
}

function optionId(listId: string, key: string): string {
  return `${listId}-${key}`;
}

/**
 * The field is a combobox over the result list: arrows move the highlighted
 * row, Enter opens it, Escape clears. Focus stays in the field the whole
 * time, so Tab still walks the page as before.
 */
function SearchBox({
  activeId,
  expanded,
  listId,
  onChange,
  onKeyDown,
  value,
}: {
  activeId: string | undefined;
  expanded: boolean;
  listId: string;
  onChange: (value: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  value: string;
}): ReactNode {
  const ref = useRef<HTMLInputElement>(null);

  // "/" jumps to the field, the way it does in the reference dashboard —
  // unless the reader is already typing somewhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
        return;
      event.preventDefault();
      ref.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="relative">
      <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-gray-700" />
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={onKeyDown}
        placeholder="Find"
        aria-label="Find a section"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={activeId}
        autoComplete="off"
        className="h-9 w-full rounded-md border border-alpha-400 bg-background-100 pr-9 pl-8 text-label-14 text-gray-1000 outline-none placeholder:text-gray-700 hover:border-alpha-500"
      />
      <kbd
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded-[4px] border border-alpha-400 text-[11px] leading-none text-gray-700"
      >
        /
      </kbd>
    </div>
  );
}

/** Filtering leaves the stack behind: one flat list of every matching leaf. */
function Results({
  activeKey,
  id,
  matches,
  onHover,
  onPick,
  pathname,
  query,
}: {
  activeKey: string | null;
  id: string;
  matches: NavItem[];
  onHover: (index: number) => void;
  onPick: () => void;
  pathname: string;
  query: string;
}): ReactNode {
  return (
    <div
      className="scroll-thin absolute inset-0 flex flex-col gap-0.5 overflow-y-auto bg-background-200 px-3 pb-4"
      id={id}
      role="listbox"
      aria-label="Matching sections"
    >
      {matches.length === 0 ? (
        <p className="px-2.5 py-2 text-label-13 text-gray-700">No section matches “{query.trim()}”.</p>
      ) : (
        matches.map((item, index) => (
          <ItemLink
            highlighted={item.key === activeKey}
            id={optionId(id, item.key)}
            isActive={isActive(item, pathname)}
            item={item}
            key={item.key}
            onHover={() => {
              onHover(index);
            }}
            onNavigate={onPick}
          />
        ))
      )}
    </div>
  );
}

/* --------------------------- the push stack ---------------------------- */

interface Panel {
  key: string;
  /** Mounted only to animate out; kept out of the tab order while it does. */
  leaving: boolean;
  className: string;
}

/**
 * Holds the outgoing menu mounted alongside the incoming one for the length
 * of the push. Two panels at most: a swap that arrives mid-push replaces the
 * one already leaving rather than stacking a third.
 */
function usePushStack(key: string, direction: number): Panel[] {
  const [state, setState] = useState<{ current: string; leaving: string | null }>(() => ({
    current: key,
    leaving: null,
  }));
  const timer = useRef<number | null>(null);

  if (state.current !== key) {
    setState({ current: key, leaving: state.current });
  }

  useEffect(() => {
    if (state.leaving === null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setState((s) => ({ ...s, leaving: null }));
    }, PUSH_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [state.leaving]);

  const way = direction > 0 ? "fwd" : "back";
  const panels: Panel[] = [];
  if (state.leaving !== null) {
    panels.push({ key: state.leaving, leaving: true, className: `pa-menu-out-${way}` });
  }
  panels.push({
    key: state.current,
    leaving: false,
    // No animation on the very first render: the rail should show its menu
    // already in place, not slide it in from nowhere.
    className: state.leaving === null ? "" : `pa-menu-in-${way}`,
  });
  return panels;
}

/* ---------------------------- the drill-down ---------------------------- */

type FocusTarget = { key: string; kind: "back" | "group" } | null;

function useNavDrilldown(pathname: string) {
  const [state, setState] = useState(() => ({
    direction: 1,
    // What the newly rendered menu should focus, when the swap came from a
    // keyboard or pointer interaction in the rail. Null for address-driven
    // swaps — stealing focus on page open would trap it in the nav.
    focusTarget: null as FocusTarget,
    path: findGroupPath(pathname),
    /** The pathname `path` was last reconciled against. */
    syncedPath: pathname,
  }));

  // Derived during render rather than in an effect: an effect would paint one
  // frame of the wrong menu after a deep link.
  if (state.syncedPath !== pathname) {
    const path = findGroupPath(pathname);
    setState({
      direction: path.length >= state.path.length ? 1 : -1,
      focusTarget: null,
      path,
      syncedPath: pathname,
    });
  }

  const groupPath = resolveGroupPath(state.path.join("/")).map((group) => group.key);

  return {
    direction: state.direction,
    focusTarget: state.focusTarget,
    groupPath,
    onBack: () =>
      setState((current) => ({
        ...current,
        direction: -1,
        // Focus returns to the entry that opened the menu — how a menu stack
        // is expected to behave.
        focusTarget: { key: groupPath[groupPath.length - 1] ?? "", kind: "group" },
        path: groupPath.slice(0, -1),
      })),
    onOpenGroup: (key: string) =>
      setState((current) => ({
        ...current,
        direction: 1,
        focusTarget: { key, kind: "back" },
        path: [...groupPath, key],
      })),
  };
}

/** Deepest-first chain of group keys owning `pathname`. */
function findGroupPath(pathname: string): string[] {
  const walk = (entries: NavEntry[]): string[] => {
    for (const entry of entries) {
      if (!isNavGroup(entry) || !isActive(entry, pathname)) continue;
      return [entry.key, ...walk(entry.items)];
    }
    return [];
  };
  return walk(APP_NAV.flatMap((section) => section.items));
}

/**
 * Walk an "a/b" key chain back into group objects, stopping at the first key
 * that no longer resolves — so a stale path degrades to its valid prefix.
 */
function resolveGroupPath(key: string): NavGroup[] {
  const groups: NavGroup[] = [];
  let level = APP_NAV.flatMap((section) => section.items);
  for (const step of key.split("/").filter((part) => part.length > 0)) {
    const match = level.find((entry) => entry.key === step);
    if (match === undefined || !isNavGroup(match)) break;
    groups.push(match);
    level = match.items;
  }
  return groups;
}

/* ------------------------------ the menu ------------------------------- */

function Menu({
  className,
  focusTarget,
  group,
  inert,
  onBack,
  onOpenGroup,
  pathname,
  sections,
}: {
  className: string;
  focusTarget: FocusTarget;
  group: NavGroup | null;
  inert: boolean;
  onBack: () => void;
  onOpenGroup: (group: NavGroup) => void;
  pathname: string;
  sections: NavSection[];
}): ReactNode {
  return (
    <div
      // The outgoing menu lingers for the length of the push. Taking it out of
      // the tab order and the accessibility tree keeps a fast Tab (or a screen
      // reader) from landing on links on their way out.
      aria-hidden={inert ? true : undefined}
      inert={inert ? true : undefined}
      data-testid={group === null ? "app-menu-root" : `app-menu-${group.key}`}
      // bg-background-200 is the rail's own surface: it is what makes the push
      // opaque, so the outgoing menu is never legible through this one.
      className={cn("absolute inset-0 flex flex-col overflow-x-hidden overflow-y-auto bg-background-200 px-3 pb-4", className)}
    >
      {group === null ? null : <MenuHeader autoFocus={focusTarget?.kind === "back"} group={group} onBack={onBack} />}
      {sections.map((section, index) => (
        <div className="flex w-full flex-col" key={section.key}>
          {index === 0 ? null : <Rule className="my-1.5" />}
          {section.label === undefined ? null : (
            <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-gray-700">{section.label}</p>
          )}
          <div className="flex flex-col gap-0.5">
            {section.items.map((entry) =>
              isNavGroup(entry) ? (
                <GroupButton
                  autoFocus={focusTarget?.kind === "group" && focusTarget.key === entry.key}
                  group={entry}
                  isActive={isActive(entry, pathname)}
                  key={entry.key}
                  onOpen={() => {
                    onOpenGroup(entry);
                  }}
                />
              ) : (
                <ItemLink isActive={isActive(entry, pathname)} item={entry} key={entry.key} />
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Programmatic focus after a pointer click does not match :focus-visible in
 * any current engine, so this only draws a ring for keyboard users.
 */
function useAutoFocus(shouldFocus: boolean) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // preventScroll is load-bearing: the target sits in a panel mid-push from
    // translateX(100%), and a bare focus() would scroll the nav's overflow
    // ancestors by the panel's full width to reveal it.
    if (shouldFocus) ref.current?.focus({ preventScroll: true });
    // Mount-only: the menu remounts on every swap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

/** Full-bleed against the panel's px-3, so the rule reaches the rail's edges. */
function Rule({ className }: { className: string }): ReactNode {
  return <div aria-hidden="true" className={cn("-mx-3 h-px shrink-0 bg-alpha-400", className)} />;
}

function MenuHeader({ autoFocus, group, onBack }: { autoFocus: boolean; group: NavGroup; onBack: () => void }): ReactNode {
  const ref = useAutoFocus(autoFocus);
  return (
    <div className="flex flex-col">
      <button
        ref={ref}
        type="button"
        onClick={onBack}
        aria-label={`Back to all sections from ${group.label}`}
        title={group.label}
        // Padding and gap match ItemLink exactly, so the menu title sits on
        // the same text column as the entries under it.
        className="group/back flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left outline-none transition-colors hover:bg-alpha-100"
      >
        <ChevronLeft
          aria-hidden="true"
          className="size-4 shrink-0 text-gray-900 transition-all duration-200 group-hover/back:-translate-x-0.5 group-hover/back:text-gray-1000"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-heading-14 text-gray-1000">{group.label}</span>
          <span className="block truncate text-[10.5px] leading-4 text-gray-700">{group.description}</span>
        </span>
      </button>
      <Rule className="my-1.5" />
    </div>
  );
}

const ENTRY =
  "group/nav flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left outline-none transition-[background-color,box-shadow,color] duration-150";

/** The selected row is a flat tint, the way the reference dashboard marks it. */
function entryState(active: boolean): string {
  return active ? "bg-alpha-200 text-gray-1000" : "text-gray-900 hover:bg-alpha-100 hover:text-gray-1000";
}

function iconState(active: boolean): string {
  return cn("size-4 shrink-0 transition-colors", active ? "text-gray-1000" : "text-gray-700 group-hover/nav:text-gray-900");
}

function ItemLink({
  highlighted,
  id,
  isActive: active,
  item,
  onHover,
  onNavigate,
}: {
  /** In a result list: the row the keyboard cursor is on. */
  highlighted?: boolean;
  id?: string;
  isActive: boolean;
  item: NavItem;
  onHover?: () => void;
  onNavigate?: () => void;
}): ReactNode {
  const Icon = item.icon;
  const inList = id !== undefined;
  // A row that leaves this site is an anchor, not a route: there is nothing
  // for the router to prefetch and nothing here to keep mounted (§15).
  const Anchor = item.external === true ? "a" : Link;
  return (
    <Anchor
      href={item.href}
      id={id}
      onClick={onNavigate}
      onMouseMove={onHover}
      aria-current={active ? "page" : undefined}
      // The caption is a hint, not part of the name.
      aria-label={item.label}
      title={item.label}
      role={inList ? "option" : undefined}
      aria-selected={inList ? highlighted === true : undefined}
      className={cn(ENTRY, entryState(active), highlighted === true && !active && "bg-alpha-100 text-gray-1000", "no-underline")}
    >
      <Icon className={iconState(active)} strokeWidth={1.8} />
      <span className="min-w-0 flex-1 truncate text-label-14">{item.label}</span>
    </Anchor>
  );
}

function GroupButton({
  autoFocus,
  group,
  isActive: active,
  onOpen,
}: {
  autoFocus: boolean;
  group: NavGroup;
  isActive: boolean;
  onOpen: () => void;
}): ReactNode {
  const ref = useAutoFocus(autoFocus);
  const Icon = group.icon;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      aria-label={group.label}
      aria-haspopup="menu"
      title={group.label}
      className={cn(ENTRY, entryState(active))}
    >
      <Icon className={iconState(active)} strokeWidth={1.8} />
      <span className="min-w-0 flex-1 truncate text-label-14">{group.label}</span>
      <ChevronRight
        aria-hidden="true"
        className="size-3.5 shrink-0 text-gray-700 transition-all duration-200 group-hover/nav:translate-x-0.5 group-hover/nav:text-gray-900"
      />
    </button>
  );
}
