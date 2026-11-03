/**
 * Match patterns (docs/extensions.md §3 `hosts`): what an extension's
 * `net.fetch`, `pages.read` and context-menu items are held to. Chrome's
 * grammar, as the manifest's HOST_PATTERN admits it: `<scheme>://<host><path>`
 * with `*` for any web scheme, `*` or `*.example.com` for the host, an
 * optional port, and `*` as a wildcard in the path; `<all_urls>` is every
 * http(s) and ws(s) address.
 */

import { ALL_URLS } from "@pistachio/extension-api/capabilities";

const WEB_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
/** What `URL.port` leaves empty: the scheme's own port, which a pattern may spell out (`https://h:443/*`). */
const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "ws:": "80", "https:": "443", "wss:": "443" };
const PATTERN = /^(\*|https?|wss?):\/\/(\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d+))?(\/.*)$/;

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Whether `url` is one `pattern` names. A malformed pattern or address matches nothing. */
export function matchesHostPattern(pattern: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!WEB_SCHEMES.has(parsed.protocol)) return false;
  if (pattern === ALL_URLS) return true;
  const match = PATTERN.exec(pattern);
  if (match === null) return false;
  const [, scheme, host, port, path] = match as unknown as [string, string, string, string | undefined, string];
  const protocol = parsed.protocol.slice(0, -1);
  if (scheme === "*" ? protocol !== "http" && protocol !== "https" : protocol !== scheme) return false;
  const hostname = parsed.hostname.toLowerCase();
  if (host !== "*") {
    if (host.startsWith("*.")) {
      const base = host.slice(2);
      if (hostname !== base && !hostname.endsWith(`.${base}`)) return false;
    } else if (hostname !== host) return false;
  }
  if (port !== undefined && (parsed.port === "" ? DEFAULT_PORTS[parsed.protocol] : parsed.port) !== String(Number(port))) return false;
  return globToRegExp(path).test(`${parsed.pathname}${parsed.search}`);
}

export function matchesAnyHost(patterns: readonly string[], url: string): boolean {
  return patterns.some((pattern) => matchesHostPattern(pattern, url));
}

/** The origin an address is on, or null (a gesture grant lasts while the tab stays on it). */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin === "null" ? null : parsed.origin;
  } catch {
    return null;
  }
}
