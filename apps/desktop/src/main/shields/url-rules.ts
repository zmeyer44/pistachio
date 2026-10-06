/**
 * The address rules Shields applies on its own, without a filter list
 * (docs/shields.md §4): tracking parameters, bounce-tracking redirect pages,
 * cross-site referrers, which http:// addresses may be tried over HTTPS, and
 * which sites get Chrome's user agent (§5).
 *
 * Pure — URLs in, URLs out — so vitest pins every rule without Electron.
 */

import { getDomain } from "tldts";
import { isPrivateHost } from "@pistachio/shell-contracts/private-network";
import type { ShieldsReferrer, ShieldsTrackingParams } from "@pistachio/shell-contracts/shields";

/**
 * Parameters that exist only to identify a click, a recipient, or a session
 * across sites — never to choose what the page shows. The union of Brave's
 * query filter (brave-core components/query_filter) and Firefox's query
 * stripping list, minus the ones either keeps for some sites only.
 */
const TRACKING_PARAMS = new Set([
  "__hsfp",
  "__hssc",
  "__hstc",
  "__s",
  "_bhlid",
  "_branch_match_id",
  "_branch_referrer",
  "_gl",
  "_hsenc",
  "_kx",
  "_openstat",
  "at_recipient_id",
  "at_recipient_list",
  "bbeml",
  "bsft_clkid",
  "bsft_uid",
  "dclid",
  "et_rid",
  "fb_action_ids",
  "fb_comment_id",
  "fbclid",
  "gbraid",
  "gclid",
  "guce_referrer",
  "guce_referrer_sig",
  "hsctatracking",
  "irclickid",
  "mc_eid",
  "ml_subscriber",
  "ml_subscriber_hash",
  "msclkid",
  "mtm_cid",
  "oft_c",
  "oft_ck",
  "oft_d",
  "oft_id",
  "oft_ids",
  "oft_k",
  "oft_lk",
  "oft_sk",
  "oly_anon_id",
  "oly_enc_id",
  "pk_cid",
  "rb_clickid",
  "s_cid",
  "sc_customer",
  "sc_eh",
  "sc_uid",
  "srsltid",
  "ss_email_id",
  "twclid",
  "unicorn_click_id",
  "vero_conv",
  "vero_id",
  "vgo_ee",
  "wbraid",
  "wickedid",
  "yclid",
  "ymclid",
  "ysclid",
]);

/** Parameters that track only on the sites that coin them; elsewhere they may mean something. */
const SITE_TRACKING_PARAMS: readonly { sites: readonly string[]; params: readonly string[] }[] = [
  { sites: ["youtube.com", "youtu.be", "spotify.com"], params: ["si"] },
  { sites: ["instagram.com"], params: ["igsh", "igshid"] },
  { sites: ["twitter.com", "x.com"], params: ["ref_src", "ref_url", "s", "t"] },
  { sites: ["tiktok.com"], params: ["_r", "_t", "is_from_webapp", "sender_device"] },
  { sites: ["amazon.com", "amazon.co.uk", "amazon.de", "amazon.fr", "amazon.ca"], params: ["pd_rd_r", "pd_rd_w", "pd_rd_wg", "pf_rd_p", "pf_rd_r", "_encoding", "psc", "ref_"] },
  { sites: ["linkedin.com"], params: ["trk", "trkinfo", "lipi", "licu"] },
];

/** Campaign tags: strict only — some sites read them to choose what to show. */
const CAMPAIGN_PARAM = /^(utm_[a-z_]+|mkt_tok_unused|hsa_[a-z]+|cmpid|cm_mmc)$/;

/**
 * The address without its tracking parameters, or null when nothing was
 * removed. The fragment and every other parameter are kept as written.
 */
export function stripTrackingParams(url: string, mode: ShieldsTrackingParams): string | null {
  if (mode === "off") return null;
  const query = url.indexOf("?");
  if (query === -1) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const site = siteOf(parsed.hostname);
  const extra = new Set(SITE_TRACKING_PARAMS.filter((rule) => rule.sites.includes(site)).flatMap((rule) => rule.params));
  const keep: [string, string][] = [];
  let removed = false;
  for (const [key, value] of parsed.searchParams) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.has(lower) || extra.has(lower) || (mode === "strict" && CAMPAIGN_PARAM.test(lower))) {
      removed = true;
      continue;
    }
    keep.push([key, value]);
  }
  if (!removed) return null;
  // Rebuilt by hand from the original text so the kept parameters keep their
  // spelling: URLSearchParams would re-encode `+`, `%20`, and bare keys.
  const kept = new Set(keep.map(([key]) => key));
  const fragment = url.indexOf("#", query);
  const rawQuery = url.slice(query + 1, fragment === -1 ? undefined : fragment);
  const parts = rawQuery.split("&").filter((part) => {
    const key = decodeParam(part.split("=")[0] ?? "");
    return kept.has(key);
  });
  const base = url.slice(0, query);
  const hash = fragment === -1 ? "" : url.slice(fragment);
  return parts.length === 0 ? `${base}${hash}` : `${base}?${parts.join("&")}${hash}`;
}

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/**
 * Redirect pages that only exist to record a click on the way out: the
 * destination is in the address, so the hop is skipped (Brave's debouncing).
 * `param` names where the destination is; a page without it is left alone.
 */
const BOUNCE_RULES: readonly { host: RegExp; path: RegExp; param: string }[] = [
  { host: /^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/, path: /^\/url$/, param: "url" },
  { host: /^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/, path: /^\/url$/, param: "q" },
  { host: /^(l|lm)\.facebook\.com$/, path: /^\/l\.php$/, param: "u" },
  { host: /^l\.messenger\.com$/, path: /^\/l\.php$/, param: "u" },
  { host: /^l\.instagram\.com$/, path: /^\/$/, param: "u" },
  { host: /^l\.threads\.net$/, path: /^\/$/, param: "u" },
  { host: /^out\.reddit\.com$/, path: /^\//, param: "url" },
  { host: /^(www\.)?youtube\.com$/, path: /^\/redirect$/, param: "q" },
  { host: /^steamcommunity\.com$/, path: /^\/linkfilter\/?$/, param: "url" },
  { host: /^steamcommunity\.com$/, path: /^\/linkfilter\/?$/, param: "u" },
  { host: /^slack-redir\.net$/, path: /^\/link$/, param: "url" },
  { host: /^(www\.)?linkedin\.com$/, path: /^\/safety\/go$/, param: "url" },
  { host: /^t\.umblr\.com$/, path: /^\/redirect$/, param: "z" },
  { host: /^(away\.)?vk\.com$/, path: /^\/away\.php$/, param: "to" },
  { host: /^exit\.sc$/, path: /^\/$/, param: "url" },
  { host: /^(www\.)?deviantart\.com$/, path: /^\/users\/outgoing$/, param: "" },
  { host: /^href\.li$/, path: /^\/$/, param: "" },
];

/**
 * Where a bounce page would send the browser, or null when `url` is not one
 * (or names no http(s) destination). An empty `param` means the whole query
 * string is the destination (href.li, DeviantArt's outgoing page).
 */
export function bounceDestination(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  for (const rule of BOUNCE_RULES) {
    if (!rule.host.test(parsed.hostname) || !rule.path.test(parsed.pathname)) continue;
    const raw = rule.param === "" ? decodeParam(parsed.search.slice(1)) : parsed.searchParams.get(rule.param);
    if (raw === null || raw === "") continue;
    try {
      const destination = new URL(raw);
      if (destination.protocol !== "http:" && destination.protocol !== "https:") continue;
      // A bounce to itself would loop.
      if (destination.hostname === parsed.hostname) continue;
      return destination.toString();
    } catch {
      continue;
    }
  }
  return null;
}

/** The registrable domain (eTLD+1) — the "site" of the same-site rules — or the host itself. */
export function siteOf(host: string): string {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return getDomain(bare, { allowPrivateDomains: true }) ?? bare;
}

/** Whether two addresses are on different sites. An address that does not parse is cross-site. */
export function isCrossSite(a: string, b: string): boolean {
  try {
    return siteOf(new URL(a).hostname) !== siteOf(new URL(b).hostname);
  } catch {
    return true;
  }
}

/**
 * The Referer a request should carry: unchanged (`undefined`), trimmed to an
 * origin, or none (`null`). Same-site referrers are never touched; the page's
 * own site may know where its visitor was.
 */
export function referrerFor(referrer: string, requestUrl: string, mode: ShieldsReferrer): string | null | undefined {
  if (mode === "default" || referrer === "") return undefined;
  let from: URL;
  try {
    from = new URL(referrer);
  } catch {
    return undefined;
  }
  if (!isCrossSite(referrer, requestUrl)) return undefined;
  if (mode === "strip") return null;
  const trimmed = `${from.origin}/`;
  return trimmed === referrer ? undefined : trimmed;
}

/**
 * The https:// address to try for an http:// navigation, or null when it is
 * not one to try: a private or single-label host, an IP literal, an explicit
 * port (a dev server on :8080 has no TLS on :8080), or a host that already
 * failed over HTTPS this session. Chrome's HTTPS-Upgrades exempts the same.
 */
export function httpsUpgradeFor(url: string, failedHosts: Pick<ReadonlySet<string>, "has">): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" || parsed.port !== "") return null;
  const host = parsed.hostname.toLowerCase();
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("[") || isPrivateHost(host)) return null;
  if (/\.(test|example|invalid|localhost|onion|i2p)$/.test(host)) return null;
  if (failedHosts.has(host)) return null;
  parsed.protocol = "https:";
  return parsed.toString();
}

/**
 * Hosts that get Chrome's user agent rather than Electron's (docs/shields.md
 * §5): Google's sign-in, which refuses embedded browsers. Everywhere else the
 * user agent stays Electron's own — Cloudflare Turnstile fails a page whose
 * user agent hides the `Electron/` token (error 600010), so it is never
 * reduced across the board.
 */
export const CHROME_USER_AGENT_HOSTS: readonly string[] = ["accounts.google.com"];

/** Whether this address is on one of `hosts` (or below it). */
export function wantsChromeUserAgent(url: string, hosts: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host !== "" && hosts.some((listed) => host === listed || host.endsWith(`.${listed}`));
}

/**
 * Electron's user agent as Chrome of the same version spells it: the app's
 * and Electron's tokens out, and the version reduced to its major number the
 * way Chrome has frozen it since Chrome 110 (`Chrome/150.0.0.0`).
 */
export function chromeUserAgent(userAgent: string): string {
  const match = /^(Mozilla\/5\.0 \([^)]*\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\)).*?Chrome\/(\d+)[\d.]*.*?(Safari\/[\d.]+)/.exec(userAgent);
  if (match === null) return userAgent.replace(/\sElectron\/\S+/, "");
  return `${match[1] ?? ""} Chrome/${match[2] ?? ""}.0.0.0 ${match[3] ?? ""}`;
}
