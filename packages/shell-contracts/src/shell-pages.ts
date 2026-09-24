/**
 * Shell-drawn pages: addresses whose pane the SHELL paints, not a host.
 *
 * The home page was the first (`./home.ts` says why: local typing, the
 * viewer's own clock); the daily brief (`pistachio://brief/`, `./reports.ts`)
 * is the second; notes (`pistachio://notes/`, `./notes.ts`) are the third.
 * For all of them the host owns only the TAB — a strip entry with a title, an
 * icon and back/forward history — and keeps the tab's own view down under the
 * shell's drawing. Everything that asks "who draws this pane?" or "who holds
 * the keyboard?" asks `isShellPageUrl`, so the next page is one entry here
 * rather than another predicate beside every `isHomeUrl`.
 *
 * What stays home-only is what is ABOUT the home page: the new-tab and
 * home-page settings, and Tidy closing idle home tabs.
 */
import { homePlaceholderHtml, isHomeUrl } from "./home.js";
import { NOTES_PAGE_FAVICON, NOTES_PAGE_TITLE, isNotesUrl } from "./notes.js";
import { BRIEF_PAGE_TITLE, isBriefUrl } from "./reports.js";

export type ShellPage = "home" | "brief" | "notes";

/** A folded sheet with three lines of text, in the brand's green: the brief tab's favicon. */
export const BRIEF_PAGE_FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='18' fill='%2352a862'/%3E%3Cpath d='M20 22h24M20 32h24M20 42h14' stroke='white' stroke-width='5' stroke-linecap='round'/%3E%3C/svg%3E";

/** Which shell-drawn page an address is, or null when a host draws it. */
export function shellPageOf(url: string): ShellPage | null {
  if (isHomeUrl(url)) return "home";
  if (isBriefUrl(url.trim())) return "brief";
  if (isNotesUrl(url)) return "notes";
  return null;
}

export function isShellPageUrl(url: string): boolean {
  return shellPageOf(url) !== null;
}

/**
 * The document the desktop's protocol serves at a shell-drawn address, or
 * null when the address is not one. Nobody sees it — the view stays hidden
 * while the shell paints the pane — but it names the tab and gives it an icon.
 */
export function shellPagePlaceholderHtml(url: string): string | null {
  const page = shellPageOf(url);
  if (page === null) return null;
  if (page === "home") return homePlaceholderHtml();
  const title = page === "notes" ? NOTES_PAGE_TITLE : BRIEF_PAGE_TITLE;
  const favicon = page === "notes" ? NOTES_PAGE_FAVICON : BRIEF_PAGE_FAVICON;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:" />
    <meta name="color-scheme" content="light dark" />
    <title>${title}</title>
    <link rel="icon" href="${favicon}" />
    <style>html,body{margin:0;height:100%;background:Canvas}</style>
  </head>
  <body></body>
</html>`;
}
