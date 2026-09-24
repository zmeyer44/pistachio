/**
 * What a tab shows when a navigation fails before a document arrives
 * (connection refused, no such host, unsafe port, bad certificate…).
 *
 * Electron commits an empty `chrome-error://chromewebdata/` document at the
 * failed address, so the tab keeps its URL and history but shows nothing.
 * Rather than load a `pistachio://` page (which would replace the address
 * and add a history entry), the controller writes this document into that
 * error page from `did-fail-load`: Retry is a plain reload — Chromium
 * retries the failed address — and Back is the tab's own history.
 */

export interface NavigationFailure {
  /** The address that failed, as Chromium validated it. */
  url: string;
  /** Chromium's net error code (negative; -102 is ERR_CONNECTION_REFUSED). */
  code: number;
  /** Chromium's error name, e.g. `ERR_CONNECTION_REFUSED`. */
  description: string;
  /** Whether the tab has somewhere to go back to. */
  canGoBack: boolean;
}

interface Explanation {
  title: string;
  detail: string;
}

/** Plain-language readings of the net errors a person is likely to hit. */
function explain(code: number, host: string): Explanation {
  const site = host === "" ? "This site" : host;
  switch (code) {
    case -102: // ERR_CONNECTION_REFUSED
      return {
        title: `${site} refused to connect`,
        detail: "Nothing is answering at this address. It may be down, or the port may be wrong.",
      };
    case -105: // ERR_NAME_NOT_RESOLVED
    case -137: // ERR_NAME_RESOLUTION_FAILED
      return {
        title: `${site} could not be found`,
        detail: "The address does not match any known server. Check the spelling of the site name.",
      };
    case -106: // ERR_INTERNET_DISCONNECTED
      return {
        title: "You are offline",
        detail: "Reconnect to the internet, then try again.",
      };
    case -7: // ERR_TIMED_OUT
    case -118: // ERR_CONNECTION_TIMED_OUT
      return {
        title: `${site} took too long to respond`,
        detail: "The connection timed out. The site may be overloaded, or the network may be slow.",
      };
    case -100: // ERR_CONNECTION_CLOSED
    case -101: // ERR_CONNECTION_RESET
    case -103: // ERR_CONNECTION_ABORTED
    case -104: // ERR_CONNECTION_FAILED
      return {
        title: `The connection to ${site} was interrupted`,
        detail: "The site closed the connection before the page arrived.",
      };
    case -21: // ERR_NETWORK_CHANGED
      return {
        title: "The network changed",
        detail: "Your connection changed while the page was loading. Try again.",
      };
    case -312: // ERR_UNSAFE_PORT
      return {
        title: "This port is blocked",
        detail: "The address uses a port reserved for other services, so the browser will not connect to it.",
      };
    case -324: // ERR_EMPTY_RESPONSE
      return {
        title: `${site} sent an empty response`,
        detail: "The site connected but did not send any data.",
      };
    case -310: // ERR_TOO_MANY_REDIRECTS
      return {
        title: `${site} redirected too many times`,
        detail: "The site keeps forwarding to another address. Clearing its cookies can help.",
      };
    case -20: // ERR_BLOCKED_BY_CLIENT
    case -27: // ERR_BLOCKED_BY_RESPONSE
    case -30: // ERR_BLOCKED_BY_CSP
      return {
        title: "This page was blocked",
        detail: "A policy stopped this page from loading.",
      };
    case -501: // ERR_INSECURE_RESPONSE
      return {
        title: `${site} sent an insecure response`,
        detail: "The site's response could not be trusted, so the page was not shown.",
      };
    default:
      if (code <= -200 && code >= -299) {
        return {
          title: `The connection to ${site} is not private`,
          detail: "The site's security certificate could not be verified.",
        };
      }
      return {
        title: `${site} can't be reached`,
        detail: "The page could not be loaded.",
      };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The tab title while the error document is showing. */
export function navigationErrorTitle(failure: Pick<NavigationFailure, "url">): string {
  const host = hostOf(failure.url);
  return host === "" ? "Page unavailable" : `Can't reach ${host}`;
}

/** The complete `<html>` inner markup for the error document. */
export function navigationErrorHtml(failure: NavigationFailure): string {
  const host = hostOf(failure.url);
  const { title, detail } = explain(failure.code, host);
  const code = `${failure.description || "ERR_FAILED"} (${String(failure.code)})`;
  return `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(navigationErrorTitle(failure))}</title>
<style>
  :root { color-scheme: light dark; --bg: #f8f8f3; --ink: #1c1c1a; --muted: #6b6b66; --line: rgba(0,0,0,.12); --card: #ffffff; --accent: #1c1c1a; --accent-ink: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #202225; --ink: #ececea; --muted: #a2a29c; --line: rgba(255,255,255,.14); --card: #2a2c30; --accent: #ececea; --accent-ink: #1c1c1a; } }
  html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--ink); }
  body { display: grid; place-items: center; padding: 48px 24px; box-sizing: border-box; min-height: 100vh; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 440px; width: 100%; }
  .mark { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; background: var(--card); box-shadow: 0 0 0 1px var(--line); margin-bottom: 20px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.01em; overflow-wrap: anywhere; }
  p { margin: 0 0 20px; color: var(--muted); }
  .url { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); overflow-wrap: anywhere; margin-bottom: 20px; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 20px; }
  button { font: inherit; font-size: 14px; font-weight: 500; padding: 8px 16px; border-radius: 8px; border: 0; cursor: pointer; background: var(--card); color: var(--ink); box-shadow: 0 0 0 1px var(--line); }
  button.primary { background: var(--accent); color: var(--accent-ink); box-shadow: none; }
  button:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
  details { color: var(--muted); font-size: 13px; }
  summary { cursor: pointer; }
  details code { display: block; margin-top: 8px; font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 8px 10px; border-radius: 8px; background: var(--card); box-shadow: 0 0 0 1px var(--line); color: var(--ink); overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path></svg></div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(detail)}</p>
  <div class="url">${escapeHtml(failure.url)}</div>
  <div class="actions">
    <button type="button" class="primary" id="retry" autofocus>Retry</button>
    ${failure.canGoBack ? '<button type="button" id="back">Back</button>' : ""}
  </div>
  <details>
    <summary>Technical details</summary>
    <code>${escapeHtml(code)}</code>
  </details>
</main>
</body>`;
}

/**
 * The script the controller runs in the empty error document to turn it
 * into the page above. Handlers are attached here rather than inline so the
 * markup carries no script of its own.
 */
export function navigationErrorScript(failure: NavigationFailure): string {
  return `(() => {
  document.documentElement.innerHTML = ${JSON.stringify(navigationErrorHtml(failure))};
  document.getElementById("retry")?.addEventListener("click", () => location.reload());
  document.getElementById("back")?.addEventListener("click", () => history.back());
  document.getElementById("retry")?.focus();
})();`;
}
