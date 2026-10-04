/**
 * The two pages Shields puts in front of a page it stopped
 * (docs/shields.md §4): a site on a Security list, and — under HTTPS-Only —
 * a site that has no HTTPS. Both say what happened in plain words and offer
 * the way back and the way through; going through is remembered for the
 * site for the rest of this run.
 *
 * Served at `pistachio://shields/<kind>?t=<token>`. The token stands for the
 * stopped address (kept in main, never in the page's address), so a page
 * cannot forge a "continue" for an address of its choosing.
 */

export type InterstitialKind = "danger" | "insecure";

export interface InterstitialPage {
  kind: InterstitialKind;
  url: string;
  /** The list that named the site, for a dangerous page. */
  list: string | null;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const STYLE = `
  :root { color-scheme: light dark; --bg: #f8f8f3; --ink: #1c1c1a; --muted: #6b6b66; --line: rgba(0,0,0,.12); --card: #ffffff; --accent: #1c1c1a; --accent-ink: #ffffff; --warn: #b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg: #202225; --ink: #ececea; --muted: #a2a29c; --line: rgba(255,255,255,.14); --card: #2a2c30; --accent: #ececea; --accent-ink: #1c1c1a; --warn: #f97066; } }
  html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--ink); }
  body { display: grid; place-items: center; padding: 48px 24px; box-sizing: border-box; min-height: 100vh; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 460px; width: 100%; }
  .mark { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; background: var(--card); box-shadow: 0 0 0 1px var(--line); margin-bottom: 20px; color: var(--warn); }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.01em; overflow-wrap: anywhere; }
  p { margin: 0 0 16px; color: var(--muted); }
  .url { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); overflow-wrap: anywhere; margin-bottom: 20px; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  a.button, button { font: inherit; font-size: 14px; font-weight: 500; padding: 8px 16px; border-radius: 8px; border: 0; cursor: pointer; background: var(--accent); color: var(--accent-ink); text-decoration: none; }
  a.through { font-size: 13px; color: var(--muted); text-decoration: underline; text-underline-offset: 2px; }
  a:focus-visible, button:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
`;

const SHIELD_ICON =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';

export function interstitialTitle(page: InterstitialPage): string {
  return page.kind === "danger" ? "Dangerous site blocked" : "Site has no secure connection";
}

/** The warning page. `proceed` is the `pistachio://shields/proceed?t=…` address. */
export function interstitialHtml(page: InterstitialPage, proceed: string): string {
  const host = hostOf(page.url);
  const heading =
    page.kind === "danger" ? `${host} may be dangerous` : `${host} doesn't support a secure connection`;
  const detail =
    page.kind === "danger"
      ? `Pistachio stopped this page because ${page.list ?? "a security list"} lists ${host} as a site that serves malware, scams, or phishing. Pages like this can try to steal passwords or install software.`
      : "Pistachio asked for this page over HTTPS and the site did not answer securely. Anything you see or send on it can be read or changed on the way.";
  const through = page.kind === "danger" ? "I understand the risk — continue to the site" : "Continue to the HTTP site";
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(interstitialTitle(page))}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true">${SHIELD_ICON}</div>
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(detail)}</p>
  <div class="url">${escapeHtml(page.url)}</div>
  <div class="actions">
    <button type="button" id="back" autofocus>Go back</button>
    <a class="through" id="proceed" href="${escapeHtml(proceed)}">${escapeHtml(through)}</a>
  </div>
</main>
<script>
  document.getElementById("back").addEventListener("click", () => {
    if (history.length > 1) history.back(); else location.href = "pistachio://home/";
  });
</script>
</body></html>`;
}

/** What `proceed` answers once the site is let through: straight on to the page. */
export function proceedHtml(url: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeHtml(url)}"><title>${escapeHtml(hostOf(url))}</title></head><body></body></html>`;
}
