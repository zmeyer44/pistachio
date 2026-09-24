/**
 * Recently visited sites, kept per renderer in localStorage: the address
 * modal's chips row. Main keeps no history, so the strip records what the
 * snapshot shows it — one entry per host, latest visit first.
 */

export interface RecentSite {
  host: string;
  url: string;
  title: string;
  /** The page's own favicon, once the tab reported one; null until then. */
  faviconUrl: string | null;
  atMs: number;
  /**
   * How many times the site was visited while it stayed on the list — the
   * home page's top sites rank by it. Absent on entries saved before it
   * was counted, which read as one visit.
   */
  visits?: number;
}

import { writeStorageLater } from "./deferred-storage";

const KEY = "pistachio.recents";
const MAX = 24;

export function loadRecents(): RecentSite[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Entries saved before the favicon field existed carry no key at all.
    return (parsed as Array<Omit<RecentSite, "faviconUrl"> & { faviconUrl?: string | null }>).map((item) => ({
      ...item,
      faviconUrl: item.faviconUrl ?? null,
    }));
  } catch {
    return [];
  }
}

export function recordVisit(list: RecentSite[], visit: Omit<RecentSite, "atMs">, atMs: number): RecentSite[] {
  if (visit.host === "") return list;
  const seen = list.find((item) => item.host === visit.host);
  const visits = (seen?.visits ?? (seen === undefined ? 0 : 1)) + 1;
  const next = [{ ...visit, atMs, visits }, ...list.filter((item) => item.host !== visit.host)].slice(0, MAX);
  save(next);
  return next;
}

/**
 * A page already recorded settled on a new title (the badge count, the
 * "(3)" prefix): keep the entry where it is and only refresh what it says.
 * Returns the same list when nothing is recorded for that page.
 */
export function retitleVisit(list: RecentSite[], url: string, title: string): RecentSite[] {
  const index = list.findIndex((item) => item.url === url);
  if (index < 0 || list[index]!.title === title) return list;
  const next = list.slice();
  next[index] = { ...list[index]!, title };
  save(next);
  return next;
}

/**
 * A page's favicon arrived after its visit was recorded — Chromium reports
 * the icon after the load settles, so the visit was recorded without one.
 * Keep the entry in place and fill it in. Returns the same list when nothing
 * is recorded for that page or the icon is already what it says.
 */
export function refaviconVisit(list: RecentSite[], url: string, faviconUrl: string | null): RecentSite[] {
  const index = list.findIndex((item) => item.url === url);
  if (index < 0 || list[index]!.faviconUrl === faviconUrl) return list;
  const next = list.slice();
  next[index] = { ...list[index]!, faviconUrl };
  save(next);
  return next;
}

/**
 * The icon to draw for a recent site: the page's own favicon when the tab
 * reported one, else the favicon service's rendering of the host (the same
 * fallback favorites use), so a chip is never reduced to a letter just
 * because the visit was recorded before the icon arrived. App pages have
 * no public host to look up.
 */
export function recentFaviconUrl(site: Pick<RecentSite, "host" | "url" | "faviconUrl">): string | null {
  if (site.faviconUrl !== null && site.faviconUrl !== "") return site.faviconUrl;
  if (site.url.startsWith("pistachio:")) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(site.host)}&sz=64`;
}

/** Forget every recent site (Settings → Privacy). */
export function clearRecents(): RecentSite[] {
  save([]);
  return [];
}

export function dismissRecent(list: RecentSite[], host: string): RecentSite[] {
  const next = list.filter((item) => item.host !== host);
  save(next);
  return next;
}

function save(list: RecentSite[]): void {
  writeStorageLater(KEY, JSON.stringify(list));
}
