/**
 * Where "managed from the web app" goes (docs/web-browser-design.md §15).
 *
 * The bug this pins: the browser app handed the shell the MARKETING ORIGIN,
 * so every one of these refusals opened the landing page. The surface now
 * carries the dashboard's root and the section chooses the page under it, so
 * both halves are pinned — that a section with a page over there reaches it,
 * and that a section without one still lands somewhere real.
 */

import { describe, expect, it } from "vitest";
import { accountHref } from "../src/lib/account-link";

const DASHBOARD = "https://www.pistachio.run/app";

describe("the way to the web app", () => {
  it("lands on the page that answers for the section", () => {
    expect(accountHref(DASHBOARD, "account")).toBe("https://www.pistachio.run/app/settings/account");
    expect(accountHref(DASHBOARD, "vault")).toBe("https://www.pistachio.run/app/settings/vault");
    expect(accountHref(DASHBOARD, "integrations")).toBe("https://www.pistachio.run/app/settings/integrations");
    expect(accountHref(DASHBOARD, "devices")).toBe("https://www.pistachio.run/app/devices");
  });

  it("falls back to the dashboard for a section the web app has no page for", () => {
    // Sync, the cloud browser and egress are refused with the same sentence
    // but have no page of their own; the dashboard is a true destination and
    // a guessed route would 404.
    expect(accountHref(DASHBOARD, "sync")).toBe(DASHBOARD);
    expect(accountHref(DASHBOARD, "cloud")).toBe(DASHBOARD);
    expect(accountHref(DASHBOARD, "egress")).toBe(DASHBOARD);
    expect(accountHref(DASHBOARD)).toBe(DASHBOARD);
  });

  it("never returns the bare site origin", () => {
    // The regression itself: a homepage is not account management.
    for (const section of ["account", "vault", "integrations", "devices", "sync"] as const) {
      expect(accountHref(DASHBOARD, section)).toMatch(/\/app(?:\/|$)/u);
    }
  });

  it("joins one slash, whatever the surface was handed", () => {
    expect(accountHref(`${DASHBOARD}/`, "account")).toBe("https://www.pistachio.run/app/settings/account");
    expect(accountHref(`${DASHBOARD}///`, "devices")).toBe("https://www.pistachio.run/app/devices");
  });

  it("renders nothing where there is no web app to point at", () => {
    // The desktop: it answers for these itself, so there is no link at all.
    expect(accountHref(undefined, "account")).toBeNull();
    expect(accountHref("", "account")).toBeNull();
    expect(accountHref("   ", "account")).toBeNull();
  });
});
