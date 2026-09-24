import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Star } from "lucide-react";
import { DEFAULT_SIDEBAR_STATE, presetAnchorId } from "@pistachio/shell-contracts/sidebar";
import { isAllowedNavigation, withScheme } from "@pistachio/shell-contracts/url";
import { cn } from "../../lib/cn";
import { siteHost, siteName, topSites } from "../../lib/home";
import { isProbablyUrl, prettyUrl } from "../../lib/url";
import { useAppStore } from "../../store";
import type { HomeNavigation } from "./navigation";
import { SiteIcon } from "./parts";

/** Tiles past this many would push the cards off the first screen. */
const MAX_KEPT = 10;
/** With fewer kept pages than this, the most visited sites fill the row. */
const FILL_TO = 6;

interface AppTile {
  id: string;
  url: string;
  title: string;
  faviconUrl: string | null;
  /** A kept page's anchor; null for a site suggested from the recent ones. */
  anchorId: string | null;
}

const TILE_SHADOW =
  "shadow-[0_0_0_1px_var(--color-alpha-300),0_1px_2px_var(--color-alpha-100)] group-hover/app:shadow-[0_0_0_1px_var(--color-alpha-400),0_6px_16px_-6px_var(--color-alpha-500)]";

function tileLabel(tile: AppTile): string {
  return tile.title !== "" && tile.title.length <= 14 ? tile.title : siteName(tile.title, tile.url);
}

/**
 * The row under the search: the organization's links and the person's
 * favorites first — the same kept pages the sidebar's grid holds, opened the
 * same way (their own tab, by anchor) — then, while there are few of those,
 * the sites visited most, each one star away from becoming a favorite. The
 * last tile adds one by address.
 */
export function HomeApps({ navigation }: { navigation: HomeNavigation }) {
  const presets = useAppStore((s) => s.settings.organization.presetLinks);
  const favorites = useAppStore((s) => s.snapshot?.sidebar.favorites ?? DEFAULT_SIDEBAR_STATE.favorites);
  const recents = useAppStore((s) => s.recents);
  const sidebarCommand = useAppStore((s) => s.sidebarCommand);

  const kept = useMemo<AppTile[]>(
    () =>
      [
        ...presets.map((link) => ({ id: presetAnchorId(link.url), url: link.url, title: link.title, faviconUrl: null, anchorId: presetAnchorId(link.url) })),
        ...favorites.map((favorite) => ({ id: favorite.id, url: favorite.url, title: favorite.title, faviconUrl: favorite.faviconUrl, anchorId: favorite.id })),
      ].slice(0, MAX_KEPT),
    [presets, favorites],
  );

  const suggested = useMemo<AppTile[]>(() => {
    const taken = new Set(kept.map((tile) => siteHost(tile.url)));
    return topSites(recents, taken, FILL_TO - kept.length).map((site) => ({
      id: `site:${site.host}`,
      url: site.url,
      title: siteName(site.title, site.url),
      faviconUrl: site.faviconUrl,
      anchorId: null,
    }));
  }, [kept, recents]);

  return (
    <nav aria-label="Favorites" data-testid="home-apps" className="flex flex-wrap justify-center gap-x-2 gap-y-4">
      {kept.map((tile) => (
        <AppButton
          key={tile.id}
          tile={tile}
          testId="home-app"
          onOpen={() => navigation.leaveFor(() => navigation.openAnchor(tile.anchorId ?? tile.id))}
        />
      ))}
      {suggested.map((tile) => (
        <AppButton
          key={tile.id}
          tile={tile}
          testId="home-app-suggested"
          onOpen={() => navigation.open(tile.url)}
          onKeep={() => void sidebarCommand({ type: "addFavorite", source: { url: tile.url, title: tile.title } })}
        />
      ))}
      <AddApp />
    </nav>
  );
}

function AppButton({ tile, testId, onOpen, onKeep }: { tile: AppTile; testId: string; onOpen: () => void; onKeep?: () => void }) {
  const label = tileLabel(tile);
  return (
    <div className="group/app relative flex w-[84px] flex-col items-center">
      <button
        type="button"
        data-testid={testId}
        title={`${tile.title || label}\n${prettyUrl(tile.url)}`}
        onClick={onOpen}
        className="flex w-full cursor-pointer flex-col items-center gap-2 rounded-2xl pb-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={cn("grid size-[60px] place-items-center rounded-[18px] bg-background-100 transition-[transform,box-shadow] duration-150 group-hover/app:-translate-y-0.5", TILE_SHADOW)}>
          <SiteIcon url={tile.url} faviconUrl={tile.faviconUrl} label={label} className="size-7 rounded-md text-[15px]" />
        </span>
        <span className="max-w-full truncate text-[12.5px] text-gray-800">{label}</span>
      </button>
      {onKeep === undefined ? null : (
        <button
          type="button"
          aria-label={`Add ${label} to favorites`}
          title="Add to favorites"
          onClick={onKeep}
          className="absolute -top-1.5 right-1.5 grid size-6 cursor-pointer place-items-center rounded-full bg-background-100 text-gray-800 opacity-0 shadow-menu transition-opacity duration-150 group-hover/app:opacity-100 hover:text-amber-900 focus-visible:opacity-100"
        >
          <Star className="size-3" strokeWidth={2.25} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** The last tile: a favorite by address, the one way in that needs no open tab to drag. */
function AddApp() {
  const sidebarCommand = useAppStore((s) => s.sidebarCommand);
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    setAddress("");
    setName("");
    setProblem(null);
  };

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("pointerdown", onPointer, true);
    return () => window.removeEventListener("pointerdown", onPointer, true);
  }, [open]);

  const submit = () => {
    const raw = address.trim();
    if (raw === "") return;
    const url = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : withScheme(raw);
    if (!isProbablyUrl(raw) || !isAllowedNavigation(url)) {
      setProblem("That is not a web address — try something like github.com.");
      return;
    }
    const href = new URL(url).toString();
    void sidebarCommand({ type: "addFavorite", source: { url: href, title: name.trim() || siteName("", href) } });
    close();
  };

  return (
    <div ref={rootRef} className="group/app relative flex w-[84px] flex-col items-center">
      <button
        type="button"
        data-testid="home-app-add"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex w-full cursor-pointer flex-col items-center gap-2 rounded-2xl pb-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="grid size-[60px] place-items-center rounded-[18px] bg-alpha-100 text-gray-800 transition-colors duration-150 group-hover/app:bg-alpha-200 group-hover/app:text-gray-1000">
          <Plus className="size-6" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <span className="text-[12.5px] text-gray-800">Add</span>
      </button>
      {open ? (
        <form
          role="dialog"
          aria-label="Add a favorite"
          data-testid="home-app-add-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
          className="absolute top-full left-1/2 z-40 mt-2 flex w-[280px] -translate-x-1/2 flex-col gap-2.5 rounded-2xl bg-background-100 p-4 text-left shadow-menu"
        >
          <p className="text-[13.5px] font-semibold text-gray-1000">Add a favorite</p>
          <input
            autoFocus
            type="text"
            aria-label="Address"
            placeholder="github.com"
            spellCheck={false}
            autoComplete="off"
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setProblem(null);
            }}
            className="h-9 rounded-lg bg-alpha-100 px-3 font-mono text-[13px] text-gray-1000 outline-none placeholder:font-sans placeholder:text-gray-700 focus:ring-2 focus:ring-ring"
          />
          <input
            type="text"
            aria-label="Name"
            placeholder="Name (optional)"
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-9 rounded-lg bg-alpha-100 px-3 text-[13px] text-gray-1000 outline-none placeholder:text-gray-700 focus:ring-2 focus:ring-ring"
          />
          {problem === null ? null : <p className="text-[12px] text-red-900">{problem}</p>}
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" onClick={close} className="h-8 cursor-pointer rounded-lg px-3 text-[13px] text-gray-900 hover:bg-alpha-100">
              Cancel
            </button>
            <button
              type="submit"
              disabled={address.trim() === ""}
              className="h-8 cursor-pointer rounded-lg bg-gray-1000 px-3 text-[13px] font-medium text-background-100 disabled:cursor-default disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
