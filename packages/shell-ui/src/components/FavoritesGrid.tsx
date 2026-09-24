import { useMemo } from "react";
import { Building2, Copy, Star, StarOff, X } from "lucide-react";
import {
  DEFAULT_SIDEBAR_STATE,
  presetAnchorId,
  type SidebarFavorite,
} from "@pistachio/shell-contracts/sidebar";
import { useShelfDrag, type ShelfItem } from "../chrome/shelf-drag";
import { useChromeTabs, type ChromeTab } from "../chrome/tabs";
import { cn } from "../lib/cn";
import { prettyUrl } from "../lib/url";
import { useAppStore } from "../store";
import { useContextMenu, type MenuEntry } from "./ContextMenu";
import { useBrandColors } from "../lib/brand-colors";
import { BrandWash, brandBorderStyle } from "./BrandTile";
import { Favicon, TabMark } from "./Favicon";

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
          canReceive && "min-h-10 ring-1 ring-alpha-400",
          canReceive && drag?.drop?.zone !== "favorites" && "bg-alpha-100",
          canReceive &&
            drag?.drop?.zone === "favorites" &&
            "bg-green-100 ring-green-400",
        )}
      >
        {tiles.length === 0 ? (
          <span className="col-span-3 grid h-10 place-items-center text-[11px] text-gray-700">
            <span className="flex items-center gap-1">
              <Star className="size-3" aria-hidden="true" /> Drop to add a
              favorite
            </span>
          </span>
        ) : null}
        {tiles.map((tile) => {
          const live = liveFor(tile);
          const active = live?.active === true;
          const glanced =
            !tile.managed && glance !== null && live?.id === glance.ownerTabId
              ? glance.tab
              : null;
          const label = tile.title || prettyUrl(tile.url);
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
                  aria-label={label}
                  aria-pressed={active}
                  title={`${label}\n${prettyUrl(tile.url)}${tile.managed ? "\nProvided by your organization" : ""}`}
                  onClick={() => {
                    if (!justDragged())
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
                    "relative grid h-10 touch-none place-items-center rounded-md border-[1.5px] outline-none transition-[background-color,box-shadow]",
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
                </button>
              )}
            </FavoriteTile>
          );
        })}
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
