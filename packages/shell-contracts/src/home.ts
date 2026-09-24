/**
 * The home page: what a new tab shows, and what a window with no tabs shows.
 *
 * Its address is `pistachio://home/`, but neither host draws it as a page.
 * The shell renders it in the pane itself (shell-ui `components/home`), from
 * the store it already holds — the favorites, the recent sites, the open tabs
 * the address modal ranks — and from the viewer's own clock and location. On
 * the web that matters twice over: the page never streams from the cloud
 * Chromium, so typing into its search is local, and "now" and "here" are the
 * person's rather than the worker's.
 *
 * What the hosts still own is the TAB: an entry in the strip with its own
 * back/forward history. The desktop loads the placeholder document below from
 * its `pistachio://` protocol and keeps the view hidden; the cloud host has no
 * such protocol and keeps the page on `about:blank`, reporting the tab under
 * this address instead (docs/web-browser-design.md §14 does the same for the
 * welcome pages).
 */

/** The home page's address, as a standard scheme spells it. */
export const HOME_PAGE_URL = "pistachio://home/";

/** The tab's title while it shows the home page. */
export const HOME_PAGE_TITLE = "Home";

/** The brand mark as a data URL: the tab's favicon, on both hosts. */
export const HOME_PAGE_FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='18' fill='%2352a862'/%3E%3Cpath d='M115.10 51.50A13.5 13.5 0 0 1 115.10 65.00L93.40 102.60A13.5 13.5 0 0 1 81.71 109.35L38.29 109.35A13.5 13.5 0 0 1 26.60 102.60L4.90 65.00A13.5 13.5 0 0 1 4.90 51.50L27.47 12.40A3.5 3.5 0 0 1 33.53 12.40L56.54 52.25A4 4 0 0 0 63.46 52.25L86.47 12.40A3.5 3.5 0 0 1 92.53 12.40Z' transform='translate(12.8 12.8) scale(0.32)' fill='white'/%3E%3C/svg%3E";

/** Whether an address is the home page (`pistachio://home` is also written without the slash). */
export function isHomeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!/^pistachio:/iu.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return url.host === "home" && (url.pathname === "/" || url.pathname === "") && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

/**
 * The document the desktop's protocol serves at the home address. Nobody
 * sees it — the view stays hidden while the shell paints the pane — but it
 * names the tab and gives it the brand's icon, and a blank page in the
 * theme's own ground is the right thing to show for the frame before the
 * shell's page covers it.
 */
export function homePlaceholderHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:" />
    <meta name="color-scheme" content="light dark" />
    <title>${HOME_PAGE_TITLE}</title>
    <link rel="icon" href="${HOME_PAGE_FAVICON}" />
    <style>html,body{margin:0;height:100%;background:Canvas}</style>
  </head>
  <body></body>
</html>`;
}
