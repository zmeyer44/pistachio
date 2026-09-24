/**
 * Where "managed from the web app" actually goes (docs/web-browser-design.md
 * §15).
 *
 * A cloud host refuses a whole family of members with that sentence, and the
 * settings section renders `Unavailable` with a link beside the reason. The
 * ADDRESS is the app's — only the browser app knows where the dashboard is —
 * but the ROUTE within it belongs to the section that is being refused: a
 * person who opened Settings → Account and was told the web app owns it
 * should land on the account page, not on a dashboard home they then have to
 * navigate themselves, and never on the marketing site.
 *
 * So the surface carries the dashboard's ROOT and this maps the section onto
 * the dashboard's own route. Only the sections that have a page over there
 * appear; everything else lands on the dashboard root, which is a true
 * destination rather than a guess at one.
 *
 * Pure on purpose — no React, no DOM — so `test/account-link.test.ts` pins
 * every route without a browser.
 */

import type { SettingsSection } from "@pistachio/shell-contracts/settings";

/**
 * The dashboard's routes, relative to its root, for the settings sections
 * that have one. `apps/www/app/app/**` is the other half of this table; a
 * route removed there must be removed here.
 */
const DASHBOARD_ROUTES: Partial<Record<SettingsSection, string>> = {
  account: "/settings/account",
  devices: "/devices",
  vault: "/settings/vault",
  integrations: "/settings/integrations",
  memory: "/memory",
  reminders: "/reminders",
  bookmarks: "/bookmarks",
};

/**
 * The link for `section`, or null when this surface has no dashboard to point
 * at (the desktop, which answers for itself).
 *
 * `accountUrl` is the dashboard's root — `${WWW_URL}/app`, not the site's
 * origin. A trailing slash on it is dropped so the joined route never doubles
 * one, and a root that is blank is the same as none at all.
 */
export function accountHref(accountUrl: string | undefined, section?: SettingsSection): string | null {
  const root = (accountUrl ?? "").trim().replace(/\/+$/u, "");
  if (root === "") return null;
  return `${root}${(section === undefined ? undefined : DASHBOARD_ROUTES[section]) ?? ""}`;
}
