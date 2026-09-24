import { HOME_PAGE_URL } from "./home.js";
import { webSearchUrl, type WebSearchProvider } from "./search.js";

/**
 * Where a fresh tab lands when nothing else says: the window's first tab,
 * a Space that has none, a split's second pane. Settings → General lets a
 * person choose their own (`general.homeUrl`); this is the value that
 * choice starts from and falls back to — Pistachio's own home page.
 */
const DEFAULT_HOME_URL = HOME_PAGE_URL;

const VIEW_SOURCE_PREFIX = "view-source:";

export function isAllowedNavigation(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    if (protocol === VIEW_SOURCE_PREFIX) {
      // Chrome lets a page's source open as its own tab. The wrapped address
      // is held to the web schemes only, so no privileged scheme sneaks in.
      const inner = value.slice(VIEW_SOURCE_PREFIX.length);
      return /^https?:/iu.test(inner) && isAllowedNavigation(inner);
    }
    return ["http:", "https:", "pistachio:"].includes(protocol);
  } catch {
    return false;
  }
}

/**
 * Schemes the browser itself answers, or that must never leave it. None of
 * them is a hand-off to another app, whatever the system has registered.
 */
const INTERNAL_SCHEMES: ReadonlySet<string> = new Set([
  "http",
  "https",
  "ws",
  "wss",
  "ftp",
  "file",
  "filesystem",
  "data",
  "blob",
  "javascript",
  "about",
  "view-source",
  "chrome",
  "chrome-extension",
  "chrome-error",
  "chrome-untrusted",
  "devtools",
  "pistachio",
  "pistachio-app",
]);

/**
 * System handlers with a history of running whatever a web page hands them
 * (Windows' diagnostic, search and Office launchers). No prompt makes these
 * safe to reach from a page, so they are never offered.
 */
const UNSAFE_EXTERNAL_SCHEMES: ReadonlySet<string> = new Set([
  "ms-msdt",
  "search-ms",
  "search",
  "ms-officecmd",
  "ms-cxh",
  "ms-cxh-full",
  "ms-appinstaller",
  "vbscript",
  "shell",
  "res",
  "jar",
]);

/** Well past any real deep link; keeps a hostile page from handing the OS a novel. */
const MAX_EXTERNAL_URL_LENGTH = 8192;

/**
 * The scheme of a link meant for another app — `zoommtg` out of
 * `zoommtg://zoom.us/join?…`, `mailto` out of `mailto:a@b.test` — or null
 * when the address is the browser's own to handle, is malformed, or names a
 * handler no page should reach. Deliberately separate from
 * `isAllowedNavigation`: a tab never NAVIGATES to these, it may only ask
 * for them to be handed to the system.
 */
export function externalAppScheme(value: string): string | null {
  if (value.length > MAX_EXTERNAL_URL_LENGTH) return null;
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    return null;
  }
  const scheme = protocol.slice(0, -1).toLowerCase();
  if (!/^[a-z][a-z\d+.-]*$/u.test(scheme)) return null;
  if (INTERNAL_SCHEMES.has(scheme) || UNSAFE_EXTERNAL_SCHEMES.has(scheme)) return null;
  return scheme;
}

/** The address of a page's source, or null when the page has none to show. */
export function viewSourceUrl(pageUrl: string): string | null {
  const url = `${VIEW_SOURCE_PREFIX}${pageUrl}`;
  return /^https?:/iu.test(pageUrl) && isAllowedNavigation(url) ? url : null;
}

/**
 * A web search for `query`, the same one the address bar runs for prose.
 * `provider` is the engine Settings → General names (`search.webProvider`);
 * a caller with no settings to read gets the default engine.
 */
export function searchUrl(query: string, provider?: WebSearchProvider): string {
  return webSearchUrl(query, provider);
}

/**
 * Hosts that are only ever reached over plain HTTP: the machine itself and
 * private networks. A dev server on `localhost:3000` has no certificate, so
 * upgrading it to https fails with ERR_SSL_PROTOCOL_ERROR before the page
 * even loads. Everything else gets https, the way the address bar of any
 * modern browser gives it.
 */
const LOCAL_HOST_RE =
  /^(?:localhost|[\w-]+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\])$/iu;

/** Give scheme-less input the scheme its host is actually served over. */
export function withScheme(bare: string): string {
  const host = bare.split(/[/?#]/u, 1)[0]?.replace(/:\d+$/u, "") ?? "";
  return `${LOCAL_HOST_RE.test(host) ? "http" : "https"}://${bare}`;
}

/**
 * A host with no scheme — `example.com/path`, `localhost:3000`, an IPv4 —
 * the shape a person copies out of prose or a slide.
 */
const BARE_HOST_RE = /^(?:localhost|(?:[\w-]+\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]\S*)?$/iu;

/**
 * A single-label host — `intranet`, `build-box` — but only when the input
 * itself says host rather than word: a port or a path follows it. A bare
 * word ("hackernews") is what someone means to SEARCH for, so it must never
 * become `https://hackernews`, which resolves nowhere.
 */
const LOCAL_LABEL_RE = /^[\w-]+(?::\d+(?:[/?#]\S*)?|[/?#]\S*)$/u;

/**
 * The address typed text means: itself when it is one, a host given its
 * scheme, and otherwise a search for the words — on `webSearch`, the engine
 * the person chose, when the caller has their settings to read it from.
 */
export function normalizeNavigation(value: string, webSearch?: WebSearchProvider): string {
  const trimmed = value.trim();
  if (trimmed === "") return DEFAULT_HOME_URL;
  if (isAllowedNavigation(trimmed)) return trimmed;
  if (BARE_HOST_RE.test(trimmed) || LOCAL_LABEL_RE.test(trimmed)) return withScheme(trimmed);
  return searchUrl(trimmed, webSearch);
}

/**
 * The address the clipboard's text would open, or null when it holds
 * anything else. This decides the address bar's "Paste and Go", so it is
 * stricter than `normalizeNavigation`: an address is offered, but a search
 * is never invented from copied prose, and only what the browser may
 * navigate to (`isAllowedNavigation`) gets a scheme.
 */
export function pasteAndGoUrl(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "" || /\s/u.test(trimmed)) return null;
  if (isAllowedNavigation(trimmed)) return trimmed;
  if (BARE_HOST_RE.test(trimmed)) return withScheme(trimmed);
  return null;
}

export { DEFAULT_HOME_URL };
