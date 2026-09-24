import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import {
  chromiumPath,
  corsAllowed,
  enterPin,
  openBrowseShell,
  signInInTab,
  signUpInTab,
  startWebStack,
  type WebStack,
} from "./web-harness";

/**
 * §15's seam: two sites, one account.
 *
 * `www` is the site and the account dashboard; `web` is the browser. They are
 * different origins, which is the whole reason this test exists — device keys
 * live in the origin's IndexedDB, so an account signed in to both is signed in
 * as TWO devices, and everything either of them reads has to come from the
 * control plane rather than from anything they could have shared in a tab.
 *
 * What it walks:
 *
 *  - sign up on `www`, which lands on the dashboard rather than in a browser.
 *  - follow the rail's "Open the browser" to the other site, which knows
 *    nothing about this person yet and asks them to sign in.
 *  - sign in there: a second device, a second set of keys derived from the
 *    same password, and the SAME Space — the one `www` just listed — open in
 *    the shell.
 *  - back on `www`: two devices, and the browser is the one named "Browser".
 */

const PASSWORD = "correct-horse-battery";
const SCREENSHOTS = "e2e/screenshots/web-two-apps";

test("one account, two sites: the dashboard hands over to the browser", async ({ page }) => {
  // Two cold `next dev` processes, a real Chromium fleet, and a claimed
  // session on the other side of the hand-over.
  test.setTimeout(600_000);
  const chromium = chromiumPath();
  test.skip(chromium === null, "no Chromium build is available for the cloud browser");

  const stack: WebStack = await startWebStack({ chromium, name: "web-two-apps", apps: ["www", "web"] });
  const { controlUrl, runnerUrl, urls } = stack;
  // Both origins are allowed, or the second site's first call dies in a
  // preflight and the failure surfaces much later as an empty screen.
  expect(await corsAllowed(controlUrl, urls.www)).toBe(urls.www);
  expect(await corsAllowed(controlUrl, urls.web)).toBe(urls.web);
  page.on("console", (message) => {
    stack.noteWebLog(`Browser console: ${message.type()} ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    stack.noteWebLog(`Browser error: ${error.message}`);
  });

  try {
    /* ---------------------------- the dashboard ----------------------------- */

    const email = `two-apps-${randomUUID().slice(0, 8)}@example.com`;
    // Signing up on `www` stays on `www` (§15): the account is made, the keys
    // are derived, the first Space is wrapped for the cloud device, and what
    // replaces the gate is the dashboard — not a browser.
    await signUpInTab(page, { webUrl: urls.www, email, password: PASSWORD, at: "/app" });
    await expect(page.getByRole("navigation")).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: `${SCREENSHOTS}/01-dashboard.png`, fullPage: true });

    // The Space the browser will open, read where the dashboard lists it, so
    // what the other site shows is compared against a name rather than an
    // assumption. It is the one sign-up turned the cloud on for — the browser
    // opens a cloud Space and nothing else.
    await page.goto(`${urls.www}/app/spaces`);
    await enterPin(page);
    const cloudRows = page.locator("table tbody tr").filter({ hasText: "Can run" });
    await expect(cloudRows).toHaveCount(1, { timeout: 60_000 });
    const spaceId = await cloudRows.first().getAttribute("data-space");
    expect(spaceId).not.toBeNull();

    /* --------------------------- over to the browser ------------------------ */

    // The rail's own link, not a typed address: what a person actually
    // follows, and proof that `NEXT_PUBLIC_PISTACHIO_BROWSER_URL` reached the
    // nav rather than a default.
    await page.goto(`${urls.www}/app`);
    await enterPin(page);
    const openBrowser = page.getByRole("link", { name: "Open the browser" }).first();
    await expect(openBrowser).toBeVisible({ timeout: 60_000 });
    expect(await openBrowser.getAttribute("href")).toBe(urls.web);
    await openBrowser.click();
    await expect(page).toHaveURL(`${urls.web}/`, { timeout: 60_000 });

    // A different origin: no device, no keys, and so the gate — the same gate,
    // because it is the account package's on both sites.
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: `${SCREENSHOTS}/02-browser-gate.png`, fullPage: true });

    await signInInTab(page, { webUrl: urls.web, email, password: PASSWORD });
    await openBrowseShell(page);
    await page.screenshot({ path: `${SCREENSHOTS}/03-browser-shell.png`, fullPage: true });

    // The same Space. By id, not by label: the two sites read a Space's NAME
    // from different places — control's row on the dashboard, the sealed
    // `space:` record in the shell — and what makes it one Space is the id
    // both hold. This is the id the browser app opened a session for, and the
    // shell above it is proof that this device could unseal it.
    await expect
      .poll(async () => page.evaluate(() => window.localStorage.getItem("pistachio.browse.space")), {
        timeout: 60_000,
        message: "the browser app never recorded which Space it opened",
      })
      .toBe(spaceId);
    // And the shell says whose Space it is, in its own footer control.
    await expect(page.getByTestId("sidebar-menu-button")).toBeVisible({ timeout: 60_000 });

    /* ----------------------- and back, as a second device ------------------- */

    await page.goto(`${urls.www}/app/devices`);
    await enterPin(page);
    // Three keys to this account now: this site, the browser app, and the
    // cloud device sign-up enrolled to run the Space.
    await expect(page.locator("table tbody tr")).toHaveCount(3, { timeout: 60_000 });
    // Each site enrols under its own name, so the list says which is which —
    // they are both `web` devices, and the name is the only thing that tells
    // them apart (§15).
    await expect(page.getByRole("rowheader", { name: /^Web — / })).toHaveCount(1);
    await expect(page.getByRole("rowheader", { name: /^Browser — / })).toHaveCount(1);
    await expect(page.getByRole("cell", { name: "Browser", exact: true })).toHaveCount(2);
    await expect(page.getByRole("cell", { name: "Cloud browser", exact: true })).toHaveCount(1);
    // The one this tab is signed in as is the dashboard's own device.
    await expect(page.getByRole("rowheader", { name: /^Web — .* · this browser$/u })).toHaveCount(1);
    await page.screenshot({ path: `${SCREENSHOTS}/04-two-devices.png`, fullPage: true });
  } catch (error) {
    const log = stack.logs();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nControl at ${controlUrl}, runner at ${runnerUrl}, www at ${urls.www}, web at ${urls.web}\nControl log:\n${log.control.slice(-6_000)}\nRunner log:\n${log.runner.slice(-4_000)}\nWeb output:\n${log.web.slice(-8_000)}`,
    );
  } finally {
    await stack.close();
  }
});
