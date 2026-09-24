import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FileClock, Globe, Search, X } from "lucide-react";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import { isShellPageUrl } from "@pistachio/shell-contracts/shell-pages";
import { DEFAULT_SIDEBAR_STATE, favoriteOf, isPresetAnchorId } from "@pistachio/shell-contracts/sidebar";
import { cn } from "../lib/cn";
import { displayHost, hostOf, prettyUrl } from "../lib/url";
import { recentFaviconUrl } from "../lib/recents";
import { selectActiveTab, useAppStore } from "../store";
import { Favicon, TabMark } from "./Favicon";
import { Kbd } from "./ui/kbd";
import { useIntentOrder } from "../lib/use-address-intent";
import { useFieldPreview } from "../lib/use-field-preview";
import { PALETTE_DETAIL_CLASS, PALETTE_FAVICON_CLASS, PALETTE_ROW_CLASS, PALETTE_TITLE_CLASS, PaletteResultRow, primaryItemFor, usePaletteInventory, useShelfRows, useTypedEntries, type Entry } from "./address-palette";

import { shellApi } from "../api";
import { useSurface } from "../surface";
import type { WatchtowerHit } from "@pistachio/shell-contracts/watchtower";

const HORIZONTAL_KINDS: ReadonlySet<Entry["kind"]> = new Set(["recent"]);

/** A run of same-kind entries — the unit ↑/↓ jump between. */
interface Zone {
  start: number;
  end: number;
  horizontal: boolean;
}

function zonesOf(entries: Entry[]): Zone[] {
  const zones: Zone[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const last = zones.at(-1);
    const horizontal = HORIZONTAL_KINDS.has(entry.kind);
    const sameRun = last !== undefined && last.end === i && entries[i - 1]?.kind === entry.kind;
    if (sameRun && last !== undefined) last.end = i + 1;
    else zones.push({ start: i, end: i + 1, horizontal });
  }
  return zones;
}

const BROWSE_RECENTS = 8;
const BROWSE_HISTORY_ROWS = 6;
const BROWSE_TAB_ROWS = 8;
const BROWSE_SHELF_ROWS = 8;

/** The dialog's width, and what the list and the chips row pad it by (px-2.5 each, both sides). */
const MODAL_MAX_W = 700;
const CHIP_ROW_PADDING = 40;

/**
 * The list under the field, and a group's label in it — the home search's own
 * (components/home/HomeSearch.tsx), so the two read as one control.
 */
const LIST_CLASS = "min-h-0 flex-1 overflow-y-auto border-t border-alpha-200 px-2.5 pt-2 pb-2.5";
const GROUP_LABEL_CLASS = "px-2.5 pt-1 pb-1.5 text-[11.5px] font-medium text-gray-700";

/**
 * A chip's rendered width, estimated from its label so the row can be SLICED
 * to what fits — the chips are a shelf, not a scroller, and a clipped
 * half-chip at the edge reads as broken.
 */
function chipWidthEstimate(label: string): number {
  const text = Math.min(label.length * 7, 110);
  return 8 + 20 + 8 + text + 14 + 8;
}

/**
 * The address bar, as a search-style modal (⌘L, ⌘T's new tab, or clicking a
 * visible tab's URL). The tab strip has no editable field of its own: editing
 * happens here, with the input prefilled with the current URL and selected, so
 * typing replaces it and Escape leaves the page untouched.
 *
 * Two faces, keyed on whether the address has been EDITED:
 *
 * BROWSE — the field still holds what it opened with (or nothing): a row of
 * recently-visited sites as chips, then the shelf, recent pages and the open
 * tabs, each group under its label in one column.
 * Nothing is selected at first, so ⌘L ↵ still just re-commits the current
 * address; arrows step into the regions.
 *
 * TYPING — the classic suggestion list: go-to/search for what was typed,
 * plus matching recents.
 *
 * On either face the field shows where the active row goes once the person
 * has steered to it (lib/use-field-preview.ts); `query` stays what they typed.
 */
export function UrlBar() {
  // Closed, the bar is nothing: none of the dialog's selectors, memos, or
  // effects run, and opening mounts it fresh (its open effect prefills it).
  const open = useAppStore((s) => s.overlay === "url");
  return open ? <UrlBarDialog /> : null;
}

const EMPTY_TABS: BrowserTabInfo[] = [];

function UrlBarDialog() {
  const open = useAppStore((s) => s.overlay === "url");
  const overlayReady = useAppStore((s) => s.overlayReady);
  const setOverlay = useAppStore((s) => s.setOverlay);
  const activeTab = useAppStore(selectActiveTab);
  const urlBarTabId = useAppStore((s) => s.urlBarTabId);
  const urlBarNew = useAppStore((s) => s.urlBarNew);
  const targetTab = useAppStore((s) => s.snapshot?.tabs.find((t) => t.id === s.urlBarTabId) ?? null);
  // A null tab means "compose a new tab": ↵ creates one at the address.
  const tab = urlBarNew ? null : urlBarTabId === null ? activeTab : targetTab;
  const tabs = useAppStore((s) => s.snapshot?.tabs ?? EMPTY_TABS);
  const navigate = useAppStore((s) => s.navigate);
  const createTab = useAppStore((s) => s.createTab);
  const selectTab = useAppStore((s) => s.selectTab);
  const recentSites = useAppStore((s) => s.recents);
  const dismissRecent = useAppStore((s) => s.dismissRecent);
  const shelf = useAppStore((s) => s.snapshot?.sidebar ?? DEFAULT_SIDEBAR_STATE);
  const sidebarCommand = useAppStore((s) => s.sidebarCommand);

  const [query, setQuery] = useState("");
  // -1 ⇒ nothing selected: ↵ acts on the typed address, never on a region.
  const [selected, setSelected] = useState(-1);
  /** Chips mid-exit: still mounted, fading and collapsing, inert. */
  const [removingHosts, setRemovingHosts] = useState<ReadonlySet<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pendingSelect = useRef(false);
  /** What the field opened holding — while unchanged, the modal browses. */
  const prefillRef = useRef("");

  const { palette, paletteTabs } = usePaletteInventory(open);

  const currentUrl = tab?.url ?? "";
  useEffect(() => {
    if (!open) return;
    // A shell-drawn page's address (home, the brief) is not one to edit: its field opens empty,
    // as a blank tab's does.
    const prefill = currentUrl.startsWith("about:") || isShellPageUrl(currentUrl) ? "" : currentUrl;
    prefillRef.current = prefill;
    setQuery(prefill);
    setSelected(-1);
    // Selecting the prefill waits for the render that commits it (below) —
    // but React only re-renders when a setter CHANGED something, and a field
    // that opens holding what it already holds (the session's first new-tab
    // bar: empty, opening empty) changes nothing. So the focus happens here,
    // and the select too when there is no commit to wait for; otherwise
    // Escape would have nothing to land on.
    const input = inputRef.current;
    input?.focus();
    pendingSelect.current = query !== prefill;
    if (!pendingSelect.current) input?.select();
    // Keyed on `open` alone: a live navigation while the bar is up must not
    // overwrite what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Selecting has to wait for the render that COMMITS the prefill.
  useLayoutEffect(() => {
    if (!pendingSelect.current) return;
    pendingSelect.current = false;
    const input = inputRef.current;
    input?.focus();
    input?.select();
  });

  const q = query.trim();
  const browsing = q.length === 0 || query === prefillRef.current;

  const searchSettings = useAppStore((s) => s.settings.search);
  const primaryItem = useMemo(() => (browsing ? null : primaryItemFor(q, searchSettings)), [browsing, q, searchSettings]);

  /**
   * "Paste and Go": the clipboard's address, offered FIRST while browsing —
   * the row above the chips, and the first stop on ↓. Nothing is offered
   * when it is the page being edited: ↵ already goes there.
   */
  const pasteRow = useMemo<Extract<Entry, { kind: "paste" }> | null>(() => {
    const url = palette.clipboardUrl;
    if (url === null || prettyUrl(url) === prettyUrl(currentUrl)) return null;
    return { kind: "paste", id: "paste-and-go", url, title: "Paste and Go", subtitle: prettyUrl(url) };
  }, [palette.clipboardUrl, currentUrl]);

  /** Recently-visited SITES as chips, cut to the chips that FIT the row. */
  const recents = useMemo(() => {
    const available = Math.min(MODAL_MAX_W, window.innerWidth - 48) - CHIP_ROW_PADDING;
    let used = 0;
    const out: Array<{ id: string; url: string; label: string; host: string; faviconUrl: string | null }> = [];
    for (const site of recentSites) {
      const label = site.host.replace(/^www\./, "");
      used += chipWidthEstimate(label);
      if (used > available) break;
      out.push({ id: `recent:${site.host}`, url: site.url, label, host: site.host, faviconUrl: recentFaviconUrl(site) });
      if (out.length === BROWSE_RECENTS) break;
    }
    return out;
  }, [recentSites]);

  /** Recent PAGES, minus where we are. */
  const historyRows = useMemo(
    () => recentSites.filter((site) => site.url !== currentUrl).slice(0, BROWSE_HISTORY_ROWS),
    [recentSites, currentUrl],
  );

  // The tab being edited is where ↵ already goes — listing it is noise.
  const tabRows = useMemo(() => tabs.filter((t) => t.id !== tab?.id).slice(0, BROWSE_TAB_ROWS), [tabs, tab?.id]);

  const allShelfRows = useShelfRows(tab?.anchorId);

  const shelfRows = allShelfRows.slice(0, BROWSE_SHELF_ROWS);

  const typed = useTypedEntries({ q, primaryItem, tab, currentUrl, palette, paletteTabs, shelfRows: allShelfRows });
  // The model's answer lands after the list is painted, so the order is held
  // still the moment the person starts steering it (lib/use-address-intent).
  const order = useIntentOrder(typed, q, primaryItem);
  const [savedHits, setSavedHits] = useState<WatchtowerHit[]>([]);
  const activeSpaceId = useAppStore((s) => s.snapshot?.activeSpaceId);
  const surface = useSurface();
  // Once a search says Watchtower was never turned on, the palette stops asking.
  const watchtowerDormant = useRef(false);
  useEffect(() => {
    watchtowerDormant.current = false;
  }, [activeSpaceId]);
  useEffect(() => {
    let cancelled = false;
    // An address is not a memory to search for; neither are two letters.
    const addressLike = /^[a-z][a-z0-9+.-]*:|^[\w-]+(\.[\w-]+)+(\/|:|$)/iu.test(q.trim());
    if (browsing || q.trim().length < 3 || q.length > 1000 || addressLike || surface.kind !== "native" || watchtowerDormant.current) {
      setSavedHits([]);
      return;
    }
    // The rows from the previous keystroke stay until these arrive: no flicker.
    const timer = setTimeout(() => {
      void shellApi().watchtower({ type: "search", query: q, limit: 6 }).then((result) => {
        if (cancelled) return;
        if (!result.settings.enabled && result.stats.visits === 0) watchtowerDormant.current = true;
        setSavedHits((result.results ?? []).filter((hit, i, all) => all.findIndex((other) => other.pageId === hit.pageId) === i).slice(0, 3));
      }).catch(() => { if (!cancelled) setSavedHits([]); });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [q, browsing, activeSpaceId, surface.kind]);
  // Append AFTER intent ranking: saved excerpts never enter automatic remote decisions.
  const typedEntries = useMemo<Entry[]>(() => [...order.entries, ...savedHits.map<Entry>((hit) => ({
    kind: "action", id: `watchtower:${hit.observationId}`, title: hit.title || hostOf(hit.url),
    subtitle: `Saved ${new Date(hit.visitedAt).toLocaleDateString()} · ${hit.snippet}`,
    category: "Saved", hint: "Watchtower", icon: <FileClock size={16} />,
    run: () => { void createTab(`pistachio://watchtower/v/${hit.observationId}`); },
  }))], [order.entries, savedHits, createTab]);

  const entries = useMemo<Entry[]>(() => {
    if (!browsing) return typedEntries;
    return [
      ...(pasteRow === null ? [] : [pasteRow]),
      ...recents.map<Entry>((r) => ({ kind: "recent", ...r })),
      ...shelfRows,
      ...historyRows.map<Entry>((site) => ({ kind: "history", id: `visit:${site.host}`, url: site.url, site })),
      ...tabRows.map<Entry>((t) => ({
        kind: "tab",
        id: `tab:${t.id}`,
        url: t.url,
        tabId: t.id,
        title: t.title || prettyUrl(t.url) || "New tab",
        tab: t,
        note: "Open tab",
      })),
    ];
  }, [browsing, typedEntries, pasteRow, recents, shelfRows, historyRows, tabRows]);

  const zones = useMemo(() => zonesOf(entries), [entries]);
  const total = entries.length;
  const preview = useFieldPreview({ inputRef, typed: query, entries, selected });

  useEffect(() => {
    setSelected(browsing ? -1 : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    setSelected((i) => Math.min(i, total - 1));
  }, [total]);

  useEffect(() => {
    dialogRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  if (!open) return null;

  const close = () => setOverlay("none");

  // A favorite's tab IS its tile's page: sending it elsewhere would quietly
  // turn the x.com favorite into a google.com one. An address entered over a
  // favorite (or an organization link) opens a new tab beside it instead;
  // pins, like day tabs, still navigate in place.
  const favoriteTab =
    tab !== null && tab.anchorId !== null && (isPresetAnchorId(tab.anchorId) || favoriteOf(shelf, tab.anchorId) !== null);

  const commit = (url: string | undefined) => {
    if (url === undefined) return;
    close();
    if (tab === null || favoriteTab) void createTab(url);
    else void navigate(tab.id, url);
  };

  const act = (entry: Entry | undefined) => {
    if (entry === undefined) return;
    if (entry.kind === "action") {
      close();
      entry.run();
      return;
    }
    // In the dedicated new-tab flow every result is an address source. An
    // open-tab or shelf result may already have a live owner, but choosing it
    // here explicitly asks for another tab at that URL, not for that owner.
    if (tab === null) {
      commit(entry.url);
      return;
    }
    if (entry.kind === "tab") {
      close();
      void selectTab(entry.tabId);
      return;
    }
    if (entry.kind === "shelf") {
      close();
      void sidebarCommand({ type: "open", anchorId: entry.anchorId });
      return;
    }
    commit(entry.url);
  };

  /**
   * Hovering a result selects it, and `onMouseMove` fires for the row that
   * is already selected too — so only a change of row counts as steering.
   */
  const selectResult = (index: number) => {
    if (!browsing) order.moved(index, selected);
    preview.steer("pointer", index);
    setSelected(index);
  };

  /** ↑/↓/←/→ landed on `index` (-1: back in the field, which shows the typed text again). */
  const stepTo = (index: number) => {
    preview.steer("keys", index);
    setSelected(index);
  };

  /** The pointer left the list: a row it was only looking at is no longer the active one. */
  const endHover = () => {
    if (preview.leave()) setSelected(browsing ? -1 : 0);
  };

  const zoneAt = (index: number): Zone | undefined => zones.find((z) => index >= z.start && index < z.end);

  /**
   * ↑/↓ run in a RING: off the bottom lands back on the top, and off the top
   * on the bottom. While browsing the field itself (-1, the typed text) is the
   * ring's stop above the first row, exactly as the omnibox has it; while
   * typing there is no such stop, so the ends meet on the rows.
   */
  const firstStop = browsing ? -1 : 0;
  const lastStop = (): number => {
    const last = zones.at(-1);
    if (last === undefined) return firstStop;
    // Entering a row of chips from either end means its FIRST chip.
    return last.horizontal ? last.start : last.end - 1;
  };

  /** The chip's ✕: fade in place, collapse the slot, then record the dismissal. */
  const dismissChip = (host: string) => {
    if (removingHosts.has(host)) return;
    setRemovingHosts((s) => new Set(s).add(host));
    window.setTimeout(() => {
      dismissRecent(host);
      setRemovingHosts((s) => {
        const next = new Set(s);
        next.delete(host);
        return next;
      });
    }, 320);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // Typing: ↵ acts on the row that was under it when they decided to
      // press it, which is not the same thing as the row that is under it
      // now if the model reordered the list a moment ago.
      const entry = browsing ? entries[selected] : order.entryFor(selected);
      if (entry !== undefined) {
        act(entry);
        return;
      }
      if (q.length > 0) commit(q);
      else if (!browsing) act(order.entryFor(0));
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    const zone = zoneAt(selected);
    // Any arrow while typing is the person taking the wheel.
    if (!browsing && e.key.startsWith("Arrow")) order.freeze();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (total === 0) return;
      if (zone === undefined) {
        stepTo(0);
        return;
      }
      // A row of chips is one stop: ↓ leaves it for the zone below.
      const next = zone.horizontal ? zone.end : selected + 1;
      stepTo(next < total ? next : firstStop);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (total === 0) return;
      if (zone === undefined) {
        stepTo(lastStop());
        return;
      }
      if (zone.horizontal || selected === zone.start) {
        const prev = zoneAt(zone.start - 1);
        if (prev === undefined) stepTo(browsing ? -1 : lastStop());
        else stepTo(prev.horizontal ? prev.start : prev.end - 1);
      } else {
        stepTo(selected - 1);
      }
      return;
    }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && zone !== undefined && zone.horizontal) {
      e.preventDefault();
      stepTo(e.key === "ArrowLeft" ? Math.max(selected - 1, zone.start) : Math.min(selected + 1, zone.end - 1));
      return;
    }
    preview.release(e);
  };

  const indexOfKind = (kind: Entry["kind"], offset: number): number =>
    entries.findIndex((entry) => entry.kind === kind) + offset;

  return (
    <div
      className={cn("fixed inset-0 z-40", !overlayReady && "pointer-events-none opacity-0")}
      onClick={close}
      data-testid="url-bar-veil"
      data-ready={overlayReady ? "" : undefined}
    >
      {/* The scrim is the dialog's SIBLING, not its parent: an element whose
          opacity animates is a backdrop root, and a dialog inside it could
          blur nothing but the scrim's own flat colour (.palette-surface). */}
      <div aria-hidden="true" className={cn("veil absolute inset-0", overlayReady && "animate-backdrop-in")} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-label="Address bar"
        data-testid="url-bar"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "palette-surface mx-auto mt-[8vh] flex max-h-[min(560px,76vh)] w-[700px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-[28px] shadow-modal",
          overlayReady && "animate-overlay-in",
        )}
      >
        {/* The field: the home search's own pill (components/home/HomeSearch.tsx),
            opened — the same height, glyph and type, the list hanging under it. */}
        <div className="flex h-14 shrink-0 items-center gap-3.5 pr-3.5 pl-5">
          {tab === null ? (
            <Search className="size-[18px] shrink-0 text-gray-800" strokeWidth={2} aria-hidden="true" />
          ) : (
            <Globe className="size-[18px] shrink-0 text-gray-800" strokeWidth={2} aria-hidden="true" />
          )}
          <input
            ref={inputRef}
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder={tab === null ? "Search, open, or run a command" : "Search, switch tabs, or run a command"}
            aria-label="Address"
            data-testid="address-input"
            value={preview.value}
            onChange={(e) => {
              preview.settle();
              setQuery(e.target.value);
            }}
            onKeyDown={onKeyDown}
            className="h-full min-w-0 flex-1 border-0 bg-transparent text-[16px] text-gray-1000 outline-none placeholder:text-gray-700"
          />
          <Kbd>esc</Kbd>
        </div>

        {/* Browse mode: one column under the field, as the home search lists —
            the clipboard's address, the recent sites as chips, then each group
            under its label. */}
        {browsing && total > 0 ? (
          <div className={LIST_CLASS} onMouseLeave={endHover}>
            {pasteRow !== null ? (
              <PaletteResultRow entry={pasteRow} index={0} selected={selected === 0} onSelect={selectResult} onActivate={act} />
            ) : null}

            {/* Recently-visited sites, as chips. Hovering a chip crossfades its icon
                to a ✕; the ✕ dismisses the chip — fade in place, then the slot
                collapses (grid 0fr trick) so the row slides closed. */}
            {recents.length > 0 ? (
              <div className="flex overflow-hidden px-2.5 pt-1.5 pb-2.5">
                {recents.map((recent, ri) => {
                  const index = indexOfKind("recent", ri);
                  const active = index === selected;
                  const removing = removingHosts.has(recent.host);
                  return (
                    <span
                      key={recent.id}
                      className={cn(
                        "grid transition-[grid-template-columns] duration-200 ease-out",
                        removing ? "grid-cols-[0fr] delay-100" : "grid-cols-[1fr]",
                      )}
                    >
                      <span className="flex min-w-0 overflow-hidden">
                        <button
                          type="button"
                          data-index={index}
                          title={prettyUrl(recent.url)}
                          onMouseMove={() => {
                            if (!removing) selectResult(index);
                          }}
                          onClick={() => {
                            if (!removing) commit(recent.url);
                          }}
                          className={cn(
                            "group/chip flex shrink-0 cursor-pointer items-center gap-2 rounded-full py-1.5 pr-3.5 pl-2 transition-[background-color,opacity] duration-150 ease-out",
                            active && !removing ? "bg-alpha-300" : "bg-alpha-100 hover:bg-alpha-200",
                            removing && "pointer-events-none opacity-0",
                          )}
                        >
                          <span className="relative size-5 shrink-0">
                            <Favicon
                              src={recent.faviconUrl}
                              seed={recent.label}
                              className="size-5 rounded-[6px] text-[10px] transition-opacity duration-150 ease-out group-hover/chip:opacity-0"
                            />
                            <span
                              role="button"
                              aria-label={`Remove ${recent.label} from recent sites`}
                              onClick={(e) => {
                                e.stopPropagation();
                                dismissChip(recent.host);
                              }}
                              className="absolute inset-0 grid cursor-pointer place-items-center opacity-0 transition-opacity duration-150 ease-out group-hover/chip:opacity-100"
                            >
                              <span className="grid size-5 place-items-center rounded-full bg-alpha-600">
                                <X className="size-3 text-white" strokeWidth={3} aria-hidden="true" />
                              </span>
                            </span>
                          </span>
                          <span className="max-w-[110px] truncate text-[12.5px] font-semibold text-gray-1000">{recent.label}</span>
                        </button>
                        <span aria-hidden="true" className="w-2 shrink-0" />
                      </span>
                    </span>
                  );
                })}
              </div>
            ) : null}

            {shelfRows.length > 0 ? (
              <div className="pt-1">
                <p className={GROUP_LABEL_CLASS}>Pinned & favorites</p>
                {shelfRows.map((row, si) => {
                  const index = indexOfKind("shelf", si);
                  return (
                    <button
                      key={row.id}
                      type="button"
                      data-index={index}
                      onMouseMove={() => selectResult(index)}
                      onClick={() => act(row)}
                      className={cn(PALETTE_ROW_CLASS, index === selected && "bg-alpha-200")}
                    >
                      <Favicon src={row.faviconUrl} seed={displayHost(row.url)} className={PALETTE_FAVICON_CLASS} />
                      <span className={PALETTE_TITLE_CLASS}>{row.title || prettyUrl(row.url)}</span>
                      <span className={PALETTE_DETAIL_CLASS}>{prettyUrl(row.url)}</span>
                      <span className="shrink-0 text-[12px] text-gray-700">{row.note}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            {historyRows.length > 0 ? (
              <div className="pt-1">
                <p className={GROUP_LABEL_CLASS}>Recent</p>
                {historyRows.map((site, vi) => {
                  const index = indexOfKind("history", vi);
                  return (
                    <button
                      key={site.host}
                      type="button"
                      data-index={index}
                      onMouseMove={() => selectResult(index)}
                      onClick={() => commit(site.url)}
                      className={cn(PALETTE_ROW_CLASS, index === selected && "bg-alpha-200")}
                    >
                      <Favicon src={recentFaviconUrl(site)} seed={site.host} className={PALETTE_FAVICON_CLASS} />
                      <span className={PALETTE_TITLE_CLASS}>{site.title || prettyUrl(site.url)}</span>
                      <span className={PALETTE_DETAIL_CLASS}>{prettyUrl(site.url)}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            {tabRows.length > 0 ? (
              <div className="pt-1">
                <p className={GROUP_LABEL_CLASS}>Open tabs</p>
                {tabRows.map((t, ti) => {
                  const index = indexOfKind("tab", ti);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      data-testid="open-tab-result"
                      data-tab-id={t.id}
                      data-index={index}
                      onMouseMove={() => selectResult(index)}
                      onClick={() => act(entries[index])}
                      className={cn(PALETTE_ROW_CLASS, index === selected && "bg-alpha-200")}
                    >
                      <TabMark tab={t} className={PALETTE_FAVICON_CLASS} />
                      <span className={PALETTE_TITLE_CLASS}>
                        {t.kind === "agent" ? `Agent · ${t.title}` : t.title || prettyUrl(t.url) || "New tab"}
                      </span>
                      <span className={PALETTE_DETAIL_CLASS}>{displayHost(t.url)}</span>
                      <span className="shrink-0 text-[12px] text-gray-700">{tab === null ? "New tab" : "Switch"}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Typing mode: one fuzzy-ranked inventory, regardless of where an
            item lives. The right-hand source label keeps unlike results
            scannable without breaking relevance into separate lists. */}
        {!browsing && entries.length > 0 ? (
          <div className={LIST_CLASS} data-testid="command-results" data-intent-ranked={order.intentState} onMouseLeave={endHover}>
            {entries.map((entry, i) => (
              <PaletteResultRow key={entry.id} entry={entry} index={i} selected={i === selected} onSelect={selectResult} onActivate={act} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
