/** Display-side URL helpers for the chrome. Pure. */

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const INTERNAL_RE = /^(about|pistachio):/i;
const LOCALHOST_RE = /^localhost(:\d+)?([/?#]|$)/i;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/;
const DOMAIN_RE = /^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i;

export function isProbablyUrl(raw: string): boolean {
  const input = raw.trim();
  if (input.length === 0 || input.includes(" ")) return false;
  return (
    SCHEME_RE.test(input) ||
    INTERNAL_RE.test(input) ||
    LOCALHOST_RE.test(input) ||
    IPV4_RE.test(input) ||
    DOMAIN_RE.test(input)
  );
}

/** Hostname of a URL, or "" when unparsable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Compact display form: strip scheme, www. and trailing slash. */
export function prettyUrl(url: string): string {
  return url
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "");
}

/**
 * The demo portal is served from the app's own scheme; give it a friendly
 * host. Every other app page (the welcome tabs, reminders) shows as its
 * address, so the bar says where you are rather than naming the demo.
 */
export function displayHost(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "pistachio:") return parsed.host;
    return parsed.host === "demo" || parsed.host === "accounts" ? "northstar.demo" : `pistachio://${parsed.host}`;
  } catch {
    return url;
  }
}
