/**
 * A tab's app icon: the large square icon a site declares for itself — its
 * apple-touch-icon, or failing that a declared icon of 96px or more — which
 * the desk's dock draws in place of a 16px favicon (docs/desk.md).
 *
 * Read from the page's own <link>s in an isolated world, so the page's
 * scripts cannot answer for it, and only an http(s) address is kept: the
 * shell loads it as it loads a favicon.
 *
 * `pickAppIcon` is pure, so vitest pins it under node.
 */

/** Watchtower's capture runs in 991, smart find's in 992. */
export const APP_ICON_WORLD = 993;

/** The page's icon links, as they are: main chooses. */
export const APP_ICON_SCRIPT = `(() => Array.from(document.querySelectorAll("link[rel][href]"), (link) => ({
  href: link.href,
  rel: String(link.getAttribute("rel") || ""),
  sizes: String(link.getAttribute("sizes") || ""),
  type: String(link.getAttribute("type") || ""),
})).slice(0, 64))()`;

/** A declared icon smaller than this is a favicon, not an app icon. */
export const MIN_APP_ICON_PX = 96;
const MAX_ICON_URL_LENGTH = 2_048;

/** The side of a declared icon, from its `sizes` (`any` — an SVG's — is any size), or 0 when it says none. */
export function iconSide(sizes: string): number {
  if (/\bany\b/i.test(sizes)) return Number.POSITIVE_INFINITY;
  let side = 0;
  for (const match of sizes.matchAll(/(\d+)\s*x\s*(\d+)/gi)) side = Math.max(side, Math.min(Number(match[1]), Number(match[2])));
  return side;
}

export function safeIconUrl(href: string): string | null {
  if (href.length === 0 || href.length > MAX_ICON_URL_LENGTH) return null;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The page's app icon among its links, or null. An apple-touch-icon is
 * made to be one (a full square tile), so any of them beats every other
 * icon, the largest first; otherwise the largest declared icon of at least
 * MIN_APP_ICON_PX — an SVG counts, being any size.
 */
export function pickAppIcon(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  let best: { url: string; touch: boolean; side: number } | null = null;
  for (const raw of links.slice(0, 64)) {
    if (typeof raw !== "object" || raw === null) continue;
    const link = raw as Record<string, unknown>;
    const href = typeof link["href"] === "string" ? link["href"] : "";
    const rels = (typeof link["rel"] === "string" ? link["rel"] : "").toLowerCase().split(/\s+/);
    const sizes = typeof link["sizes"] === "string" ? link["sizes"] : "";
    const type = typeof link["type"] === "string" ? link["type"].toLowerCase() : "";
    const touch = rels.includes("apple-touch-icon") || rels.includes("apple-touch-icon-precomposed");
    if (!touch && !rels.includes("icon")) continue;
    const svg = type === "image/svg+xml" || /\.svg(?:[?#]|$)/i.test(href);
    // A touch icon that names no size is the 180px one iOS asks for.
    const side = iconSide(sizes) || (touch ? 180 : svg ? Number.POSITIVE_INFINITY : 0);
    if (!touch && side < MIN_APP_ICON_PX) continue;
    const url = safeIconUrl(href);
    if (url === null) continue;
    const better = best === null || (touch && !best.touch) || (touch === best.touch && side > best.side);
    if (better) best = { url, touch, side };
  }
  return best?.url ?? null;
}
