import { useCallback, useMemo, useRef } from "react";
import { Building2, Copy, Star, StarOff, X } from "lucide-react";
import {
  DEFAULT_SIDEBAR_STATE,
  presetAnchorId,
  type SidebarFavorite,
} from "@pistachio/shell-contracts/sidebar";
import { useShelfDrag, type ShelfItem } from "../chrome/shelf-drag";
import { useChromeTabs, type ChromeTab } from "../chrome/tabs";
import { cn } from "../lib/cn";
import { useDeskChrome } from "../lib/desk/chrome";
import { showOnDesk } from "../lib/desk/open";
import { hoverDeskRow } from "./desk/DeskSidebarControls";
import { useDeskStore } from "../lib/desk/store";
import { prettyUrl } from "../lib/url";
import { useAppStore } from "../store";
import { useContextMenu, type MenuEntry } from "./ContextMenu";
import { useBrandColors } from "../lib/brand-colors";
import { BrandWash, brandBorderStyle } from "./BrandTile";
import { Favicon, TabMark } from "./Favicon";
import { RailFavorites } from "./RailFavorites";
import { EntryTabCount } from "./EntryTabCount";
import { useSidebarRail } from "./sidebar-rail";

/**
 * The favorites grid under the address row — the `favorites` feature
 * (chrome/manifest-renderers.tsx): a page kept as an icon on the top shelf.
 *
 * Two kinds of tile share the grid. The organization's PRESET LINKS come
 * first (settings.json → organization.presetLinks; a managed deployment
 * seeds them): the sites every employee should reach in one click, drawn
 * with the building mark, opened like any favorite, never moved or removed
 * here. After them come the person's own favorites, added by dragging any
 * row of the list onto the grid or from a row's context menu, reordered by
 * drag, removed from the tile's menu.
 *
 * Like a pin, a favorite keeps its page: its live tab (bound by anchor) is
 * shown or, once closed, opened again on click. A tile with a live page
 * shows a dot; the active page's tile is the raised card.
 *
 * The active page's tile wears its brand: a hairline gradient border and a
 * faint wash in the site's own colours (lib/brand-colors.ts) rather than the
 * theme's raised card, so the active favorite reads the way it did when it
 * was chosen in onboarding.
 *
 * The grid is one zone of the sidebar's shared drag surface
 * (chrome/shelf-drag.tsx): the provider reads its box through `gridRef`,
 * and while a drop is aimed at it the grid draws the dragged item as a tile
 * at the slot it would take. With nothing on it and no drag in flight, the
 * grid takes no room; while a drag is in flight and the grid is still empty,
 * its target OVERLAYS the address row above it instead of pushing the list
 * down — a column that shifts under the pointer the moment a drag starts
 * would move every drop slot away from where the person aimed, and the
 * address row is the one thing in the column nothing can be dropped on.
 */

interface Tile {
  id: string;
  url: string;
  title: string;
  faviconUrl: string | null;
  managed: boolean;
  /** Not a favorite yet: the dragged item drawn at its would-be slot. */
  ghost: boolean;
}

export function FavoritesGrid() {
  const presets = useAppStore((s) => s.settings.organization.presetLinks);
  const favorites = useAppStore(
    (s) => s.snapshot?.sidebar.favorites ?? DEFAULT_SIDEBAR_STATE.favorites,
  );
  const tabs = useChromeTabs();
  const sidebarCommand = useAppStore((s) => s.sidebarCommand);
  const closeTab = useAppStore((s) => s.closeTab);
  const duplicateTab = useAppStore((s) => s.duplicateTab);
  const glance = useAppStore((s) => s.glance);
  const { drag, beginPress, justDragged, gridRef } = useShelfDrag();
  const menu = useContextMenu();
  // On the desk's rail the favorites are one folder, its sheet holding this grid (RailFavorites).
  const rail = useSidebarRail();
  // A favorite's page's group (TabGroupInfo.anchorId): how many tabs wait on its desk besides its page — and, its desk
  // up, the favorite whose rows the list draws (TabList's entryTabs).
  const pageGroups = useAppStore((s) => s.snapshot?.anchorGroups);
  const deskGroupId = useDeskStore((s) => s.groupId);
  const deskFavorite = pageGroups?.find((group) => group.id === deskGroupId)?.anchorId ?? null;
  // On the rail, the place under that favorite's row where the list draws its desk's tabs and Stack (TabList's entryTabs).
  const entryEl = useRef<HTMLDivElement | null>(null);
  const entryRef = useCallback(
    (el: HTMLDivElement | null) => {
      const chrome = useDeskChrome.getState();
      if (el === null) {
        if (chrome.favoriteEntry !== null && chrome.favoriteEntry.el === entryEl.current) chrome.setFavoriteEntry(null);
        entryEl.current = null;
        return;
      }
      entryEl.current = el;
      if (deskFavorite !== null) chrome.setFavoriteEntry({ anchorId: deskFavorite, el });
    },
    [deskFavorite],
  );
  const tabCounts = useMemo(() => new Map((pageGroups ?? []).map((group) => [group.anchorId ?? "", group.tabIds.length - 1])), [pageGroups]);

  const liveByAnchor = useMemo(() => {
    const map = new Map<string, ChromeTab>();
    for (const tab of tabs)
      if (tab.anchorId !== null) map.set(tab.anchorId, tab);
    return map;
  }, [tabs]);

  // Only the drag's item and drop place a tile; its other fields (lifted, the
  // split zone) do not re-lay the grid out.
  const dragItem = drag?.item ?? null;
  const dragDrop = drag?.drop ?? null;
  const tiles = useMemo<Tile[]>(() => {
    const managed = presets.map<Tile>((link) => ({
      id: presetAnchorId(link.url),
      url: link.url,
      title: link.title,
      faviconUrl:
        liveByAnchor.get(presetAnchorId(link.url))?.faviconUrl ?? null,
      managed: true,
      ghost: false,
    }));
    let own = favorites.map<Tile>((favorite) => ({
      ...favorite,
      managed: false,
      ghost: false,
    }));
    if (dragItem !== null) {
      const item = dragItem;
      const drop = dragDrop;
      if (item.kind === "favorite")
        own = own.filter((tile) => tile.id !== item.entityId);
      if (
        drop !== null &&
        drop.zone === "favorites" &&
        item.kind !== "folder" &&
        item.kind !== "split"
      ) {
        const ghost: Tile = {
          id: item.entityId,
          url: item.url,
          title: item.title,
          faviconUrl: item.faviconUrl,
          managed: false,
          ghost: item.kind !== "favorite",
        };
        own.splice(Math.min(drop.index, own.length), 0, ghost);
      }
    }
    return [...managed, ...own];
  }, [presets, favorites, liveByAnchor, dragItem, dragDrop]);

  // A live gesture the grid could take; a committed drop settling in place is
  // no longer one, though its tile stays drawn until main publishes it.
  const canReceive =
    drag !== null && !drag.settling && drag.item.kind !== "folder" && drag.item.kind !== "split";
  const grabbedId = drag !== null && !drag.settling ? drag.item.entityId : null;
  if (tiles.length === 0 && !canReceive) return null;
  // The ghost tile a drop would add does not count: were it to, the grid would
  // leave its overlay the moment the pointer reached it and slide back under
  // the list, out from under the drop it was showing.
  const overlay = tiles.every((tile) => tile.ghost);

  const liveFor = (tile: Tile): ChromeTab | null =>
    liveByAnchor.get(tile.id) ??
    (drag !== null && drag.item.entityId === tile.id
      ? (drag.item.tabs[0] ?? null)
      : null);

  const itemFor = (tile: Tile): ShelfItem => {
    const live = liveByAnchor.get(tile.id);
    return {
      flipId: tile.id,
      kind: "favorite",
      entityId: tile.id,
      title: tile.title,
      url: tile.url,
      faviconUrl: tile.faviconUrl,
      tabs: live === undefined ? [] : [live],
      managed: tile.managed,
      // Carried out over a desk, its page's window (chrome/shelf-drag.tsx).
      ...(live === undefined ? {} : { deskTab: live }),
    };
  };

  const tileMenu = (tile: Tile): MenuEntry[] => {
    const live = liveByAnchor.get(tile.id) ?? null;
    return [
      {
        label: live === null ? "Open" : "Show",
        onSelect: () =>
          void sidebarCommand({ type: "open", anchorId: tile.id }),
      },
      ...(live !== null
        ? [
            {
              label: "Close tab",
              icon: <X aria-hidden="true" />,
              onSelect: () => void closeTab(live.id),
            },
            // Where the favorite has wandered to, kept as a live tab of its
            // own — focused, with the same back/forward stack — so the page
            // survives without dragging (and so unfavoriting) the tile.
            {
              label: "Duplicate as live tab",
              icon: <Copy aria-hidden="true" />,
              disabled: live.kind !== "human",
              onSelect: () => void duplicateTab(live.id),
            },
          ]
        : []),
      { separator: true },
      ...(tile.managed
        ? [{ note: "Provided by your organization" }]
        : [
            {
              label: "Remove from favorites",
              icon: <StarOff aria-hidden="true" />,
              danger: true,
              onSelect: () =>
                void sidebarCommand({
                  type: "removeFavorite",
                  favoriteId: tile.id,
                }),
            },
          ]),
    ];
  };

  // A drag the grid could take: the grid says so, and where it is aimed, says it will.
  const receiving = cn(
    canReceive && "min-h-10 ring-1 ring-alpha-400",
    canReceive && drag?.drop?.zone !== "favorites" && "bg-alpha-100",
    canReceive && drag?.drop?.zone === "favorites" && "bg-green-100 ring-green-400",
  );
  const tileNodes = tiles.map((tile) => {
    const live = liveFor(tile);
    const active = live?.active === true;
    const glanced =
      !tile.managed && glance !== null && live?.id === glance.ownerTabId
        ? glance.tab
        : null;
    const label = tile.title || prettyUrl(tile.url);
    const waiting = tile.ghost || deskFavorite === tile.id ? 0 : (tabCounts.get(tile.id) ?? 0);
    return (
      <FavoriteTile
        key={tile.id}
        url={tile.url}
        faviconUrl={live?.faviconUrl ?? tile.faviconUrl}
      >
        {(colors) => (
          <button
            type="button"
            role="listitem"
            data-flip-id={tile.id}
            // A control that is also a drag handle: the press starts a drag,
            // and the click that would open it is swallowed once it did.
            data-drag-handle="true"
            data-managed={tile.managed ? "" : undefined}
            data-testid={tile.managed ? "preset-tile" : "favorite-tile"}
            data-live={live === null ? undefined : ""}
            // Its page's window on a desk goes home here (DeskSurface's sidebarHome).
            data-live-tab-id={live?.id}
            aria-label={label}
            aria-pressed={active}
            title={`${label}\n${prettyUrl(tile.url)}${tile.managed ? "\nProvided by your organization" : ""}`}
            onClick={() => {
              if (justDragged()) return;
              // On its own desk, its window is shown there: its tab may still be the one in use, the window put away.
              if (live !== null && showOnDesk(live.id)) return;
              void sidebarCommand({ type: "open", anchorId: tile.id });
            }}
            onAuxClick={(e) => {
              if (e.button === 1 && live !== null) void closeTab(live.id);
            }}
            onPointerDown={(e) => beginPress(itemFor(tile), e)}
            onContextMenu={(e) => {
              e.preventDefault();
              menu.open(e, tileMenu(tile));
            }}
            className={cn(
              "favorite-tile relative grid h-10 touch-none place-items-center rounded-md border-[1.5px] outline-none transition-[background-color,box-shadow]",
              grabbedId === tile.id
                ? "z-30 cursor-grabbing"
                : "cursor-pointer",
              active
                ? "shadow-[0_4px_12px_-6px_rgb(0_0_0/0.25)]"
                : "border-transparent bg-alpha-100 hover:bg-alpha-200",
              tile.ghost && "opacity-80",
            )}
            style={active ? brandBorderStyle(colors) : undefined}
          >
            {active ? <BrandWash colors={colors} /> : null}
            {live === null ? (
              <Favicon
                src={tile.faviconUrl}
                seed={prettyUrl(tile.url)}
                className="size-[18px] rounded-[5px] text-[10px]"
              />
            ) : (
              <span className="[&>*]:size-[18px] [&>*]:rounded-[5px]">
                <TabMark tab={live} fallbackFaviconUrl={tile.faviconUrl} />
              </span>
            )}
            {tile.managed ? (
              <span
                aria-hidden="true"
                className="absolute top-1 right-1 grid size-3 place-items-center rounded-full bg-background-100 text-gray-700 shadow-border"
              >
                <Building2 className="size-2" />
              </span>
            ) : null}
            {glanced === null ? null : (
              <span
                data-testid="favorite-glance-favicon"
                aria-label={`Glancing ${glanced.title}`}
                title={`Glancing ${glanced.title}`}
                className="absolute -top-1 -right-1 z-10 grid size-[18px] place-items-center rounded-[6px]"
              >
                <Favicon
                  src={glanced.faviconUrl}
                  seed={prettyUrl(glanced.url) || glanced.title}
                  className="size-3 rounded-[3px] text-[7px]"
                />
              </span>
            )}
            {live !== null && !active ? (
              <span
                aria-hidden="true"
                className="absolute bottom-1 left-1/2 size-1 -translate-x-1/2 rounded-full bg-gray-700"
              />
            ) : null}
            {live?.loading === true ? (
              <span
                aria-hidden="true"
                className="absolute bottom-1 left-1/2 size-1 -translate-x-1/2 animate-pulse-dot rounded-full bg-green-700"
              />
            ) : null}
            {waiting > 0 ? <EntryTabCount count={waiting} testId="favorite-tab-count" className="absolute -right-1 -bottom-1 bg-background-100 shadow-border" /> : null}
          </button>
        )}
      </FavoriteTile>
    );
  });

  if (rail) {
    // Under the folder, the favorites whose pages are open, a row each (as a tab's on the rail): shown on a click,
    // closed with the middle button, the tile's own menu on a right-click. They keep the favorites' order: the one
    // whose desk is up stays where it is, its desk's tabs and Stack under it (the list draws them there:
    // TabList's entryTabs) — not taken out to stand under the folder's rows, as it was until 2026-10-07, so that
    // choosing one moved it to the end.
    const open = tiles.flatMap((tile) => {
      const live = tile.ghost ? null : liveFor(tile);
      if (live === null) return [];
      const here = deskFavorite === tile.id;
      const label = tile.title || prettyUrl(tile.url);
      // (Its desk up, its tabs are under it, not counted on it.)
      const waiting = here ? 0 : (tabCounts.get(tile.id) ?? 0);
      const flipId = `open:${tile.id}`;
      return [
        <button
          key={tile.id}
          type="button"
          role="listitem"
          data-testid="rail-favorite-open"
          data-active={live.active ? "" : undefined}
          data-live-tab-id={live.id}
          // Carried as its tile is: into the list, a group, the pinned, or out over the desk as its page's window.
          data-flip-id={flipId}
          data-drag-handle="true"
          aria-label={`${label}, open`}
          title={`${label}\n${prettyUrl(tile.url)}`}
          className={cn("rail-favorite-open no-drag relative touch-none", grabbedId === tile.id && "z-30 cursor-grabbing")}
          onPointerDown={(e) => beginPress({ ...itemFor(tile), flipId }, e)}
          onClick={() => {
            if (justDragged()) return;
            if (!showOnDesk(live.id)) void sidebarCommand({ type: "open", anchorId: tile.id });
          }}
          onAuxClick={(e) => {
            if (e.button === 1) void closeTab(live.id);
          }}
          // A desk up, ⇧⌫ closes the tab whose row is under the pointer — this one's page, its desk's (as any tab's row: TabList).
          onPointerEnter={() => hoverDeskRow(live.id, true)}
          onPointerLeave={() => hoverDeskRow(live.id, false)}
          onContextMenu={(e) => {
            e.preventDefault();
            menu.open(e, tileMenu(tile));
          }}
        >
          <span aria-hidden="true" className="[&>*]:size-5 [&>*]:rounded-[5px]">
            <TabMark tab={live} fallbackFaviconUrl={tile.faviconUrl} />
          </span>
          {waiting > 0 ? <EntryTabCount count={waiting} testId="favorite-tab-count" className="absolute -right-0.5 -bottom-0.5 h-3.5 min-w-3.5 bg-background-100 text-[9px] shadow-border" /> : null}
        </button>,
        ...(here ? [<div key={`entry:${tile.id}`} ref={entryRef} role="group" aria-label={`${label}, its desk`} data-testid="rail-favorite-entry" className="rail-favorite-entry" />] : []),
      ];
    });
    return (
      <>
        <RailFavorites
          open={open}
          favorites={tiles.map((tile) => ({ id: tile.id, title: tile.title, url: tile.url, faviconUrl: liveFor(tile)?.faviconUrl ?? tile.faviconUrl, ghost: tile.ghost }))}
          gridRef={gridRef}
          gridClassName={cn("no-drag grid grid-cols-3 gap-1.5 rounded-md transition-[background-color,box-shadow] duration-150", receiving)}
          dragging={canReceive}
          dropping={canReceive && drag?.drop?.zone === "favorites"}
        >
          {tileNodes}
        </RailFavorites>
        {menu.menu}
      </>
    );
  }

  return (
    <div className={cn("shrink-0", overlay ? "relative h-0" : "")}>
      <div
        ref={gridRef}
        role="list"
        aria-label="Favorites"
        data-testid="favorites-grid"
        className={cn(
          "no-drag grid grid-cols-3 gap-1.5 rounded-md transition-[background-color,box-shadow] duration-150",
          overlay
            ? "absolute inset-x-2 -top-10 z-20 h-10 bg-background-200/95"
            : "relative mx-2 mb-2",
          receiving,
        )}
      >
        {tiles.length === 0 ? (
          <span className="favorites-empty col-span-3 grid h-10 place-items-center text-[11px] text-gray-700">
            <span className="flex items-center gap-1">
              <Star className="size-3" aria-hidden="true" /> Drop to add a
              favorite
            </span>
          </span>
        ) : null}
        {tileNodes}
      </div>
      {menu.menu}
    </div>
  );
}

/** Resolves a tile's brand colours — a hook, so one per tile — and hands them to the tile's markup. */
function FavoriteTile({
  url,
  faviconUrl,
  children,
}: {
  url: string;
  faviconUrl: string | null;
  children: (colors: readonly string[]) => React.ReactNode;
}) {
  return <>{children(useBrandColors(url, faviconUrl))}</>;
}

export type { SidebarFavorite };
