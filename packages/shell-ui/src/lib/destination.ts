/**
 * One row per PLACE in the address bar's typed face.
 *
 * The inventory is gathered by where a page lives — an open tab, a favorite
 * or a pin, a recent site — and one page routinely lives in all three:
 * GitHub open in a tab, kept as a favorite, and visited this morning is
 * three rows with the same title and the same address, and ↵ on any of them
 * ends up in the same place. To the person reading the list that is one
 * result and two lines of noise; to the intent model
 * (docs/smart-suggestions.md) it is worse, because three identical options
 * split one probability three ways and none of them clears a threshold.
 *
 * So rows are grouped by DESTINATION — the address with everything that does
 * not change where it goes taken off — and each group shows once: at the
 * position of its best-ranked member, as the member that is the best way to
 * get there. Which way is best is the caller's call (`prefer`): this file
 * knows addresses, not tabs and Spaces. Pure.
 */

/** Query parameters that say how someone ARRIVED, never where. */
const TRACKING_PARAM = /^(utm_[a-z_]+|gclid|gbraid|wbraid|dclid|fbclid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi|ref_src)$/i;

/**
 * The place an address goes, as a comparable string; null when there is no
 * address to compare (a blank tab), so such rows are never merged.
 *
 * Equal for addresses that differ only in: `http` versus `https`, a leading
 * `www.`, the host's case, a trailing slash, the default port, tracking
 * parameters, and an in-page fragment (`#pricing`). A fragment that is a
 * ROUTE (`#/inbox`, `#!/thread/4`) is kept — in a hash-routed app it is the
 * page. Every other query parameter is kept, in order: `?q=a` and `?q=b`
 * are different pages.
 */
export function destinationKey(url: string): string | null {
  const raw = url.trim();
  if (raw === "" || /^about:/i.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return raw.toLowerCase();
  }
  const web = parsed.protocol === "http:" || parsed.protocol === "https:";
  const scheme = web ? "https:" : parsed.protocol;
  const host = parsed.host.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.replace(/\/+$/, "");
  const params = [...parsed.searchParams].filter(([name]) => !TRACKING_PARAM.test(name));
  const query = params.length === 0 ? "" : `?${params.map(([name, value]) => `${name}=${value}`).join("&")}`;
  const route = /^#[!/]/.test(parsed.hash) ? parsed.hash : "";
  return `${scheme}//${host}${path}${query}${route}`;
}

export interface CollapsedDestinations<T> {
  /** `ranked` with one row per destination, each at its best member's position. */
  ranked: T[];
  /**
   * Whether an item survives: true for every item that is its destination's
   * one representative (shown or not) and for every item with no
   * destination at all. The intent model is offered exactly these, so it
   * can never name a row the list has folded away.
   */
  kept: (item: T) => boolean;
}

/**
 * Fold the rows that go to the same place into one.
 *
 * `ranked` is the list as relevance ordered it; `all` is everything that
 * could have been listed, matched or not. For each destination the
 * representative is the most PREFERRED member among those that matched the
 * query — someone who typed a favorite's nickname should see the favorite,
 * not a tab whose title they did not type — and, when none matched, the
 * most preferred of all. Ties fall to whichever came first.
 *
 * `keyOf` answers null for rows that are not places (actions, settings);
 * they pass through untouched.
 */
export function collapseDestinations<T>(
  ranked: readonly T[],
  all: readonly T[],
  keyOf: (item: T) => string | null,
  prefer: (item: T) => number,
): CollapsedDestinations<T> {
  const best = (current: T | undefined, item: T): T =>
    current === undefined || prefer(item) > prefer(current) ? item : current;
  const matched = new Map<string, T>();
  for (const item of ranked) {
    const key = keyOf(item);
    if (key !== null) matched.set(key, best(matched.get(key), item));
  }
  const representative = new Map<string, T>(matched);
  for (const item of all) {
    const key = keyOf(item);
    if (key !== null && !matched.has(key)) representative.set(key, best(representative.get(key), item));
  }
  const emitted = new Set<string>();
  const out: T[] = [];
  for (const item of ranked) {
    const key = keyOf(item);
    if (key === null) {
      out.push(item);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    const shown = representative.get(key);
    if (shown !== undefined) out.push(shown);
  }
  return {
    ranked: out,
    kept: (item) => {
      const key = keyOf(item);
      return key === null || representative.get(key) === item;
    },
  };
}
