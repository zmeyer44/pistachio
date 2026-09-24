/**
 * The settings sidebar: a nav stack whose menus PUSH rather than swap.
 * Selecting a group slides its menu in from the right over the one that
 * opened it; the back control slides the parent menu back in from the left.
 *
 * The push is opaque, not a crossfade. A crossfade leaves both label sets
 * legible on top of each other for a beat, so the incoming panel carries the
 * rail's own background and occludes the outgoing one, which trails at a
 * quarter distance for depth and empties its opacity over the first half of
 * the travel. Timings and curve live in styles.css (`.settings-menu-*`),
 * which also owns the reduced-motion form.
 *
 * WHICH MENU IS OPEN IS A FUNCTION OF THE ADDRESS. Any navigation into a
 * group's sections opens that group — a deep link, a console action. The back
 * control is the one exception: it steps up a level WITHOUT navigating (you
 * are still on the page you were reading), which is why the open menu is
 * state rather than a pure derivation of the section.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../../lib/cn";
import { useSurface } from "../../surface";
import type { SettingsSection } from "@pistachio/shell-contracts/settings";
import {
  isNavGroup,
  labelFor,
  ownsSection,
  SETTINGS_NAV,
  settingsNavFor,
  type NavEntry,
  type NavGroup,
  type NavItem,
  type NavSection,
} from "./nav-config";

/** Must outlast the longest `.settings-menu-*` animation in styles.css. */
const PUSH_MS = 320;

export function SettingsNav({
  section,
  onNavigate,
}: {
  section: SettingsSection;
  onNavigate: (section: SettingsSection) => void;
}) {
  // The tree the RAIL renders is the surface's (nav-config's `settingsNavFor`);
  // the lookups below walk the shared one, which they only read keys from.
  const tree = settingsNavFor(useSurface().kind);
  const { direction, focusTarget, groupPath, onBack, onOpenGroup } = useNavDrilldown(section);
  const panels = usePushStack(groupPath.join("/"), direction);

  return (
    // overflow-clip, not -hidden: a hidden box is still programmatically
    // scrollable, so anything that scrolls-into-view (focus, a screen reader)
    // can shove the clipped menu sideways and cancel the push. clip forbids
    // scrolling outright.
    <nav aria-label="Settings sections" className="relative isolate min-h-0 flex-1 overflow-clip">
      {panels.map((panel) => {
        const groups = resolveGroupPath(panel.key);
        const group = groups[groups.length - 1] ?? null;
        return (
          <SettingsMenu
            className={panel.className}
            focusTarget={panel.leaving ? null : focusTarget}
            group={group}
            inert={panel.leaving}
            key={panel.key}
            onBack={onBack}
            onNavigate={onNavigate}
            onOpenGroup={onOpenGroup}
            section={section}
            sections={group === null ? tree : [{ key: group.key, items: group.items }]}
          />
        );
      })}
    </nav>
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
    panels.push({ key: state.leaving, leaving: true, className: `settings-menu-out-${way}` });
  }
  panels.push({
    key: state.current,
    leaving: false,
    // No animation on the very first render: the sidebar opening should show
    // its menu already in place, not slide it in from nowhere.
    className: state.leaving === null ? "" : `settings-menu-in-${way}`,
  });
  return panels;
}

/* ---------------------------- the drill-down ---------------------------- */

type FocusTarget = { key: string; kind: "back" | "group" } | null;

function useNavDrilldown(section: SettingsSection) {
  const [state, setState] = useState(() => ({
    direction: 1,
    // What the newly rendered menu should focus, when the swap came from a
    // keyboard or pointer interaction in the rail. Null for address-driven
    // swaps — stealing focus on page open would trap it in the nav.
    focusTarget: null as FocusTarget,
    path: findGroupPath(section),
    /** The section `path` was last reconciled against. */
    syncedSection: section as string,
  }));

  // Derived during render rather than in an effect: an effect would paint one
  // frame of the wrong menu after a deep link.
  if (state.syncedSection !== section) {
    const path = findGroupPath(section);
    setState({
      direction: path.length >= state.path.length ? 1 : -1,
      focusTarget: null,
      path,
      syncedSection: section,
    });
  }

  const groupPath = resolveGroupPath(state.path.join("/")).map((g) => g.key);

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

/** Deepest-first chain of group keys owning `section`. */
function findGroupPath(section: string): string[] {
  const walk = (entries: NavEntry[]): string[] => {
    for (const entry of entries) {
      if (!isNavGroup(entry) || !ownsSection(entry, section)) continue;
      return [entry.key, ...walk(entry.items)];
    }
    return [];
  };
  return walk(SETTINGS_NAV.flatMap((s) => s.items));
}

/**
 * Walk a "a/b" key chain back into group objects, stopping at the first key
 * that no longer resolves — so a stale path degrades to its valid prefix.
 */
function resolveGroupPath(key: string): NavGroup[] {
  const groups: NavGroup[] = [];
  let level = SETTINGS_NAV.flatMap((s) => s.items);
  for (const step of key.split("/").filter((k) => k.length > 0)) {
    const match = level.find((entry) => entry.key === step);
    if (match === undefined || !isNavGroup(match)) break;
    groups.push(match);
    level = match.items;
  }
  return groups;
}

/* ------------------------------ the menu ------------------------------- */

function SettingsMenu({
  className,
  focusTarget,
  group,
  inert,
  onBack,
  onNavigate,
  onOpenGroup,
  section,
  sections,
}: {
  className: string;
  focusTarget: FocusTarget;
  group: NavGroup | null;
  inert: boolean;
  onBack: () => void;
  onNavigate: (section: SettingsSection) => void;
  onOpenGroup: (key: string) => void;
  section: SettingsSection;
  sections: NavSection[];
}) {
  return (
    <div
      // The outgoing menu lingers for the length of the push. Taking it out of
      // the tab order and the accessibility tree keeps a fast Tab (or a screen
      // reader) from landing on links on their way out.
      aria-hidden={inert ? true : undefined}
      inert={inert ? true : undefined}
      data-testid={group === null ? "settings-menu-root" : `settings-menu-${group.key}`}
      // bg-background-200 is the rail's own surface: it is what makes the push
      // opaque, so the outgoing menu is never legible through this one.
      className={cn(
        "scroll-thin absolute inset-0 flex flex-col overflow-x-hidden overflow-y-auto bg-background-200 px-2 pt-0.5 pb-4",
        className,
      )}
    >
      {group === null ? null : (
        <MenuHeader autoFocus={focusTarget?.kind === "back"} group={group} onBack={onBack} />
      )}
      {sections.map((navSection, index) => (
        <div className="flex w-full flex-col" key={navSection.key}>
          {index === 0 ? null : <Rule className="my-1.5" />}
          {navSection.label === undefined ? null : (
            <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-gray-700 @max-md:hidden">{navSection.label}</p>
          )}
          <div className="flex flex-col gap-0.5">
            {navSection.items.map((entry) =>
              isNavGroup(entry) ? (
                <GroupButton
                  autoFocus={focusTarget?.kind === "group" && focusTarget.key === entry.key}
                  group={entry}
                  isActive={ownsSection(entry, section)}
                  key={entry.key}
                  onOpen={() => {
                    onOpenGroup(entry.key);
                    onNavigate(entry.section);
                  }}
                />
              ) : (
                <ItemButton
                  isActive={section === entry.section}
                  item={entry}
                  key={entry.key}
                  onSelect={() => onNavigate(entry.section)}
                />
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

/** Full-bleed against the panel's px-2, so the rule reaches the rail's edges. */
function Rule({ className }: { className: string }) {
  return <div aria-hidden="true" className={cn("-mx-2 h-px shrink-0 bg-alpha-400", className)} />;
}

function MenuHeader({ autoFocus, group, onBack }: { autoFocus: boolean; group: NavGroup; onBack: () => void }) {
  const ref = useAutoFocus(autoFocus);
  return (
    <div className="flex flex-col">
      <button
        ref={ref}
        type="button"
        onClick={onBack}
        aria-label={`Back to all settings from ${group.label}`}
        title={group.label}
        // Padding and gap match ItemButton exactly, so the menu title sits on
        // the same text column as the entries under it.
        className="group/back flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left outline-none transition-colors hover:bg-alpha-100 focus-visible:ring-2 focus-visible:ring-ring @max-md:justify-center @max-md:px-0"
      >
        <ChevronLeft
          className="size-4 shrink-0 text-gray-900 transition-all duration-200 group-hover/back:-translate-x-0.5 group-hover/back:text-gray-1000"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 @max-md:hidden">
          <span className="block truncate text-heading-14 text-gray-1000">{group.label}</span>
          <span className="block truncate text-[10.5px] leading-4 text-gray-700">{group.description}</span>
        </span>
      </button>
      <Rule className="my-1.5" />
    </div>
  );
}

const ENTRY =
  "group/nav flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left outline-none transition-[background-color,box-shadow,color] duration-150 focus-visible:ring-2 focus-visible:ring-ring @max-md:justify-center @max-md:px-0";

/**
 * The selected row is a RAISED card, not a tinted wash: the hairline plus
 * the 1px drop make it read as lifted off the recessed rail.
 */
function entryState(isActive: boolean): string {
  return isActive ? "bg-background-100 text-gray-1000 shadow-small" : "text-gray-900 hover:bg-alpha-100 hover:text-gray-1000";
}

function iconState(isActive: boolean): string {
  return `size-4 shrink-0 transition-colors ${isActive ? "text-gray-1000" : "text-gray-700 group-hover/nav:text-gray-900"}`;
}

function ItemButton({ isActive, item, onSelect }: { isActive: boolean; item: NavItem; onSelect: () => void }) {
  const Icon = item.icon;
  const label = labelFor(item);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={isActive ? "page" : undefined}
      // The caption is a hint, not part of the name.
      aria-label={label}
      title={label}
      className={cn(ENTRY, entryState(isActive))}
    >
      <Icon className={iconState(isActive)} strokeWidth={1.8} />
      <span className="min-w-0 flex-1 @max-md:hidden">
        <span className="block truncate text-label-13">{label}</span>
        {item.note === undefined ? null : (
          <span className="block truncate text-[10.5px] leading-4 text-gray-700">{item.note}</span>
        )}
      </span>
    </button>
  );
}

function GroupButton({
  autoFocus,
  group,
  isActive,
  onOpen,
}: {
  autoFocus: boolean;
  group: NavGroup;
  isActive: boolean;
  onOpen: () => void;
}) {
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
      className={cn(ENTRY, entryState(isActive))}
    >
      <Icon className={iconState(isActive)} strokeWidth={1.8} />
      <span className="min-w-0 flex-1 @max-md:hidden">
        <span className="block truncate text-label-13">{group.label}</span>
        <span className="block truncate text-[10.5px] leading-4 text-gray-700">{group.description}</span>
      </span>
      <ChevronRight
        aria-hidden="true"
        className="size-3.5 shrink-0 text-gray-700 transition-all duration-200 group-hover/nav:translate-x-0.5 group-hover/nav:text-gray-900 @max-md:hidden"
      />
    </button>
  );
}
