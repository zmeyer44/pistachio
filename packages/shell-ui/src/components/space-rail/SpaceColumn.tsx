import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SIDEBAR_CARD_INSET, SIDEBAR_RAIL_W } from "@pistachio/shell-contracts/chrome";
import type { SidebarMode } from "@pistachio/shell-contracts/settings";
import { DEFAULT_SIDEBAR_STATE, presetAnchorId } from "@pistachio/shell-contracts/sidebar";
import { ShelfDragProvider } from "../../chrome/shelf-drag";
import { useNewGroupNaming } from "../../chrome/tab-group-menu";
import { NEW_SPACE_EVENT } from "../../lib/desk/open";
import { pinnedRows } from "../../lib/sidebar-tree";
import { useAppStore } from "../../store";
import { renameSpace, useHomeMemory, useSpaceRename } from "./column-state";
import { SpaceFlights, type FlightSpace } from "./flights";
import { backingOutline, cardOutline, columnViewOf, grewInto, HOME_VIEW, homeTabIdsOf, HOUSE_EASE, railSpacesOf, type ColumnView } from "./rail-model";
import { SpaceCard as SpaceCardView } from "./SpaceCard";
import { SpaceRail as SpaceRailView } from "./SpaceRail";

// The rail and the card render from their own props and subscriptions: not again for the column's (a tab chosen).
const SpaceRail = memo(SpaceRailView);
const SpaceCard = memo(SpaceCardView);

/* The column's geometry, in its own coordinates (the window's: it starts at the window's left edge). */
/** The traffic lights' pocket: the card's shoulder steps round x < 78, y < 36 (the lights stand at x 16–68, y 15–27). */
const SHOULDER_X = 78;
const SHOULDER_Y = 36;
/** The tab's leading edge, out over the rail, and its margin round the chosen item. */
const TAB_LEFT = 3;
const TAB_PAD = 6;
/** A rail item. */
const TILE = 38;
/** The tab's slide (the house ease) and the wash's cross-fade. */
const TAB_SLIDE_MS = 230;
const WASH_MS = 200;
/** A Home tab growing into a space: the card turns, and the tab and the wash follow its flight (the lab's timings). */
const GROW = { swap: 230, tabDelay: 170, tabMs: 320, washDelay: 300, washMs: 420 };
/** A space being named, its name come: the colour washes in slowly. */
const NAMED = { washDelay: 160, washMs: 640 };

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** prefers-reduced-motion, kept current. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reducedMotion);
  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return;
    }
    const onChange = (): void => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * The desktop's sidebar column (docs/double-sidebar.md): the RAIL at the
 * window's edge — Home and every space with more than one window — and,
 * whole or brought out from hidden, beside it the CARD with the chosen one
 * in detail. The two are one object: the card's outline (one SVG path, the
 * lab's variant B) grows a TAB out of its leading edge round the chosen rail
 * item, joined by concave fillets, and steps round the traffic lights with
 * a shoulder; choosing another item slides the tab to it, the path redrawn
 * every frame (230ms on the house ease), while the card's contents
 * cross-fade (SpaceCard). On the rail alone the chosen tile sits on the tab
 * without its card. A space's colour washes the card's top, painted on the
 * same outline.
 *
 * Which item is chosen is the card's view (columnViewOf: Home's while the
 * space in use is one of Home's, else the space's), drawn a beat late when
 * a Home tab has just grown into a space — its row flying up to its tile
 * first (SpaceFlights) — so the card turns as the ghost lands.
 *
 * The column hosts the shelf drag (chrome/shelf-drag.tsx) over both: rows
 * in the card, drops on the rail's tiles. It is mounted by SidebarColumn
 * (layouts/SidebarLayout.tsx) in place of SidebarChrome on the desktop; the
 * web keeps the single sidebar.
 */
export function SpaceColumn({ mode, cardWidth }: { mode: SidebarMode; cardWidth: number }) {
  const card = mode !== "rail";
  const reduced = useReducedMotion();
  // Only what the rail is cut from — never the whole snapshot, which a title or a load publishes anew: the column (and
  // the card under it) would render for every tick.
  const tabGroups = useAppStore((state) => state.snapshot?.tabGroups);
  const anchorGroups = useAppStore((state) => state.snapshot?.anchorGroups);
  const looseGroups = useAppStore((state) => state.snapshot?.looseGroups);
  const splitGroups = useAppStore((state) => state.snapshot?.splitGroups);
  const tabOrder = useAppStore((state) => state.snapshot?.tabs.map((tab) => `${tab.id}\t${tab.anchorId ?? ""}`).join("\n") ?? "");
  const sidebar = useAppStore((state) => state.snapshot?.sidebar ?? DEFAULT_SIDEBAR_STATE);
  const presets = useAppStore((state) => state.settings.organization.presetLinks);
  const view = useAppStore((state) => columnViewOf(state.snapshot?.currentGroupId ?? null, state.snapshot));
  const activeTabId = useAppStore((state) => state.snapshot?.activeTabId ?? null);

  // The rail's spaces, the same array for as long as they stand as they are (the flights compare it).
  const entryOrder = useMemo(
    () => [...presets.map((link) => presetAnchorId(link.url)), ...sidebar.favorites.map((favorite) => favorite.id), ...pinnedRows(sidebar.entries).flatMap((row) => (row.kind === "pin" ? [row.pin.id] : []))],
    [presets, sidebar],
  );
  const computed = useMemo(
    () => {
      const tabs =
        tabOrder === ""
          ? []
          : tabOrder.split("\n").map((entry) => {
              const [id = "", anchorId = ""] = entry.split("\t");
              return { id, anchorId: anchorId === "" ? null : anchorId };
            });
      return tabGroups === undefined ? [] : railSpacesOf({ tabs, tabGroups, splitGroups: splitGroups ?? [], anchorGroups, looseGroups }, entryOrder);
    },
    [tabOrder, tabGroups, splitGroups, anchorGroups, looseGroups, entryOrder],
  );
  const spacesKey = computed.map((space) => `${space.group.id}:${space.group.color}:${space.group.title}:${space.group.naming === true ? "n" : ""}:${space.group.tabIds.join(",")}`).join(" ");
  const spaces = useStable(computed, spacesKey);
  const flightSpaces = useMemo<FlightSpace[]>(() => spaces.map((space) => ({ id: space.group.id, tabIds: space.group.tabIds })), [spaces]);

  // ── The view shown: a beat late after a Home tab grows into a space ─────
  // The Home tabs as the column last saw them: a new space holding one of them grew out of Home (grewInto). Kept
  // current at every change — a tab can become a Home tab while the rail and the view stand as they are.
  const homeComputed = useMemo(() => homeTabIdsOf({ looseGroups, anchorGroups }), [looseGroups, anchorGroups]);
  const homeTabIds = useStable(homeComputed, [...homeComputed].join(" "));
  const [seen, setSeen] = useState({ view, rail: spaces, homeTabIds });
  const [growing, setGrowing] = useState<string | null>(null);
  if (seen.view !== view || seen.rail !== spaces || seen.homeTabIds !== homeTabIds) {
    // (Only a Home tab grown into a space waits for its flight: ⌘N's, New space's, a selection's space turns at once.
    // Until 2026-10-13 any new space chosen while Home showed did.)
    const grew = grewInto(seen, view, spaces);
    setSeen({ view, rail: spaces, homeTabIds });
    if (grew && card && !reduced) setGrowing(view);
    else if (growing !== null && growing !== view) setGrowing(null);
  }
  useEffect(() => {
    if (growing === null) return;
    const timer = window.setTimeout(() => setGrowing(null), GROW.swap);
    return () => window.clearTimeout(timer);
  }, [growing]);
  // The card's contents turn a beat late; the rail's choice, the tab and the wash go at once (with their own delays).
  const shown: ColumnView = growing !== null ? HOME_VIEW : view;
  const shownSpace = shown === HOME_VIEW ? null : (spaces.find((space) => space.group.id === shown) ?? null);
  const chosenSpace = view === HOME_VIEW ? null : (spaces.find((space) => space.group.id === view) ?? null);

  // Home on the rail goes back to the Home tab used last.
  useEffect(() => {
    if (view === HOME_VIEW && activeTabId !== null) useHomeMemory.getState().note(activeTabId);
  }, [view, activeTabId]);

  // A name being edited ends with its space: closed, or left (the card turned to another — a field taken away unfocused
  // hears no blur). Until the card has turned to it, a space chosen for its name is on its way, not left.
  const renaming = useSpaceRename((state) => state.spaceId);
  const renamingShown = useRef(false);
  useEffect(() => {
    if (renaming === null) {
      renamingShown.current = false;
      return;
    }
    if (tabGroups?.some((group) => group.id === renaming) !== true) useSpaceRename.getState().done();
    else if (view === renaming) renamingShown.current = true;
    else if (renamingShown.current) useSpaceRename.getState().done();
  }, [renaming, view, tabGroups]);

  // A new space — ⌘N's, the rail's New space — is named in the card's head, unless the host names it first.
  const track = useNewGroupNaming(renameSpace);
  const trackRef = useRef(track);
  trackRef.current = track;
  useEffect(() => {
    const onNewSpace = (event: Event): void => trackRef.current((event as CustomEvent<string>).detail);
    window.addEventListener(NEW_SPACE_EVENT, onNewSpace);
    return () => window.removeEventListener(NEW_SPACE_EVENT, onNewSpace);
  }, []);

  // ── The sheet: the card's outline, its tab on the chosen item ───────────
  const rootRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const washA = useRef<HTMLDivElement>(null);
  const washB = useRef<HTMLDivElement>(null);
  const railListRef = useRef<HTMLDivElement>(null);
  const frame = useRef({ height: 0, card, cardWidth });
  // The chosen item, for the measures below, which stay the same functions for the column's life: a ResizeObserver
  // made anew for every view would hear its first callback at once and jump the tab to its item, cutting the slide.
  const viewRef = useRef(view);
  viewRef.current = view;
  const tab = useRef<{ y: number | null; target: number | null; raf: number; timer: number }>({ y: null, target: null, raf: 0, timer: 0 });

  const draw = useCallback((y: number) => {
    const { height, card: withCard, cardWidth: width } = frame.current;
    if (height === 0) return;
    const d = withCard
      ? cardOutline(
          { x0: SIDEBAR_RAIL_W, x1: SIDEBAR_RAIL_W + width, y0: SIDEBAR_CARD_INSET, y1: height - SIDEBAR_CARD_INSET, bx: SHOULDER_X, by: SHOULDER_Y, tabLeft: TAB_LEFT },
          { top: y - TAB_PAD, bottom: y + TILE + TAB_PAD },
        )
      : backingOutline(TAB_LEFT, SIDEBAR_RAIL_W - TAB_LEFT, y - TAB_PAD, y + TILE + TAB_PAD);
    pathRef.current?.setAttribute("d", d);
    for (const wash of [washA.current, washB.current]) if (wash !== null) wash.style.clipPath = `path('${d}')`;
  }, []);

  /** Slide the tab to `y` (the chosen item's top), on the house ease — at once the first time, or with reduced motion. */
  const moveTab = useCallback(
    (y: number, options: { delay?: number; duration?: number; force?: boolean } = {}) => {
      const state = tab.current;
      if (state.target === y && options.force !== true) return;
      state.target = y;
      window.clearTimeout(state.timer);
      state.timer = 0;
      if (state.y === null || reduced) {
        cancelAnimationFrame(state.raf);
        state.y = y;
        draw(y);
        return;
      }
      const go = (): void => {
        state.timer = 0;
        cancelAnimationFrame(state.raf);
        const from = state.y ?? y;
        const start = performance.now();
        const duration = Math.max(1, options.duration ?? TAB_SLIDE_MS);
        if (Math.abs(from - y) < 0.5) {
          state.y = y;
          draw(y);
          return;
        }
        const step = (now: number): void => {
          const p = Math.min(1, (now - start) / duration);
          state.y = from + (y - from) * HOUSE_EASE(p);
          draw(state.y);
          if (p < 1) state.raf = requestAnimationFrame(step);
        };
        state.raf = requestAnimationFrame(step);
      };
      if (options.delay !== undefined && options.delay > 0) state.timer = window.setTimeout(go, options.delay);
      else go();
    },
    [draw, reduced],
  );
  useEffect(
    () => () => {
      cancelAnimationFrame(tab.current.raf);
      window.clearTimeout(tab.current.timer);
    },
    [],
  );

  /**
   * The chosen item's top in the column: Home's button, or the space's tile —
   * which, scrolled out of the rail's list, the tab rides the list's edge for
   * (it never leaves the rail's span for the hairline or the foot). A tile is
   * read by its place in the list's layout (offsetTop: the list is its offset
   * parent), not its box: a tile just come grows in from 0.6 (its entrance),
   * which its box would carry, and the tab would settle 8px off it.
   */
  const measure = useCallback((): number | null => {
    const root = rootRef.current;
    if (root === null) return null;
    const item = root.querySelector<HTMLElement>(`[data-rail-key="${CSS.escape(viewRef.current)}"]`) ?? root.querySelector<HTMLElement>(`[data-rail-key="${HOME_VIEW}"]`);
    if (item === null) return null;
    const top = root.getBoundingClientRect().top;
    const list = railListRef.current;
    if (item.dataset["railKey"] === HOME_VIEW || list === null || item.offsetParent !== list) return item.getBoundingClientRect().top - top;
    const span = list.getBoundingClientRect();
    const y = span.top - top + list.clientTop + item.offsetTop - list.scrollTop;
    return Math.max(span.top - top, Math.min(y, span.bottom - top - TILE));
  }, []);

  /** The rail scrolled (or resized) under the tab: it follows its item at once. */
  const remeasure = useCallback(() => {
    const y = measure();
    if (y === null) return;
    cancelAnimationFrame(tab.current.raf);
    window.clearTimeout(tab.current.timer);
    tab.current.y = y;
    tab.current.target = y;
    draw(y);
  }, [measure, draw]);

  // After every render: the frame as drawn (a new size or mode redraws where the tab is), then the tab to its item.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const before = frame.current;
    const next = { height: root.getBoundingClientRect().height, card, cardWidth };
    frame.current = next;
    const y = measure();
    if (y === null) return;
    if (before.height !== next.height || before.card !== next.card || before.cardWidth !== next.cardWidth) {
      if (tab.current.y !== null) draw(tab.current.y);
    }
    moveTab(y, growing !== null ? { delay: GROW.tabDelay, duration: GROW.tabMs } : {});
  });
  // The window's height (the column's), or anything in the rail resizing under the tab.
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const observer = new ResizeObserver(() => {
      frame.current = { ...frame.current, height: root.getBoundingClientRect().height };
      remeasure();
    });
    observer.observe(root);
    if (railListRef.current !== null) observer.observe(railListRef.current);
    return () => observer.disconnect();
  }, [remeasure]);

  // ── The wash: the shown space's colour on the card's top, cross-faded between two layers ─
  const wash = useRef<{ tone: string | null; index: number; view: ColumnView }>({ tone: null, index: 0, view });
  const tone = card && chosenSpace !== null && chosenSpace.group.naming !== true ? chosenSpace.group.color : null;
  useLayoutEffect(() => {
    const layers = [washA.current, washB.current];
    const state = wash.current;
    const sameView = state.view === view;
    state.view = view;
    if (tone === state.tone) return;
    const timing = reduced ? { delay: 0, ms: 0 } : growing !== null ? { delay: GROW.washDelay, ms: GROW.washMs } : sameView && state.tone === null ? { delay: NAMED.washDelay, ms: NAMED.washMs } : { delay: 0, ms: WASH_MS };
    const transition = `opacity ${String(timing.ms)}ms cubic-bezier(0.2, 0.8, 0.3, 1) ${String(timing.delay)}ms`;
    const current = layers[state.index];
    const next = layers[1 - state.index];
    if (current !== null && current !== undefined) {
      current.style.transition = transition;
      delete current.dataset["on"];
    }
    if (tone !== null && next !== null && next !== undefined) {
      next.style.transition = "none";
      next.dataset["groupColor"] = tone;
      void next.offsetWidth;
      next.style.transition = transition;
      next.dataset["on"] = "";
      state.index = 1 - state.index;
    }
    state.tone = tone;
  });

  return (
    // (The sidebar's chrome, as the single sidebar's column is called: what a spec finds the whole column by.)
    <div ref={rootRef} data-testid="sidebar-chrome" data-mode={mode} data-view={shown === HOME_VIEW ? "home" : "space"} className="space-column chrome-sidebar drag-region">
      <ShelfDragProvider className="space-column-drag">
        <svg className="space-column-shape" aria-hidden="true" width="100%" height="100%">
          <path ref={pathRef} className="space-column-sheet" />
        </svg>
        {card ? (
          <>
            <div ref={washA} className="space-card-wash tab-group-tone" aria-hidden="true" />
            <div ref={washB} className="space-card-wash tab-group-tone" aria-hidden="true" />
          </>
        ) : null}
        <SpaceRail spaces={spaces} view={view} railOnly={!card} listRef={railListRef} onLayout={remeasure} />
        {card ? <SpaceCard view={shown} group={shownSpace?.group ?? null} page={shownSpace?.page === true} width={cardWidth} reduced={reduced} /> : null}
        <SpaceFlights spaces={flightSpaces} reduced={reduced} rootRef={rootRef} />
      </ShelfDragProvider>
    </div>
  );
}

/** `value`, the same object for as long as `key` is: a list rebuilt from a snapshot that changed something else stays put. */
function useStable<T>(value: T, key: string): T {
  const [kept, setKept] = useState({ key, value });
  if (kept.key !== key) {
    setKept({ key, value });
    return value;
  }
  return kept.value;
}
