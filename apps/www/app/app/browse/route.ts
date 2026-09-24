/**
 * The browser moved to its own site (docs/web-browser-design.md §15).
 *
 * `/app/browse` was where the shell lived while there was one web app. There
 * are two now — this dashboard and the browser — and the browser is a whole
 * site rather than a page in this one, so an address that used to open it
 * still does: it sends the reader across.
 *
 * A route handler rather than a page, so a bookmark gets a real 307 from the
 * server instead of a document that redirects itself once React has loaded.
 */

const BROWSER_URL = process.env["NEXT_PUBLIC_PISTACHIO_BROWSER_URL"]?.trim() || "http://localhost:3001";

export function GET(): Response {
  return Response.redirect(BROWSER_URL, 307);
}
