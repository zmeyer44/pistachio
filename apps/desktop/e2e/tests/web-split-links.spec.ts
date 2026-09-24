import { randomUUID } from "node:crypto";
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  chromiumPath,
  corsAllowed,
  openBrowseShell,
  signUpInTab,
  startWebStack,
  walkFirstRun,
  type WebStack,
} from "./web-harness";
import { openSidebarMenu, sidebarMenuItem } from "./footer";

/**
 * §15's escape hatch: what "managed from the web app" actually does.
 *
 * A cloud host refuses a whole family of settings members — the account,
 * devices, the vault, integrations — because the DASHBOARD owns them, and the
 * shell renders the host's reason with a way there beside it. Two things went
 * wrong with that way out, and both are walked here against the real thing:
 *
 *  - it CRASHED. The link is a `<Button asChild>`, and the shared Button
 *    handed Radix's Slot three children (prefix, child, suffix) where Slot
 *    merges onto exactly one, so opening Settings → Account threw "Slot
 *    failed to slot onto its children" and the boundary above replaced the
 *    whole shell. Nothing below can be reached from a shell that is gone, so
 *    the spec watches `pageerror` for the whole walk as well.
 *  - it pointed at the MARKETING HOMEPAGE. `NEXT_PUBLIC_PISTACHIO_WWW_URL` is
 *    the other app's ORIGIN; the dashboard is `/app` on it, and each refused
 *    section has a page under that. A landing page is not account management.
 *
 * Both apps are booted, so the destinations are asserted as addresses AND
 * fetched: a route that has moved out from under the link would still match
 * the string.
 *
 * The same walk is also where the SHELL'S COPY is held to the surface it is
 * on (`packages/shell-ui/src/lib/surface-copy.ts`). Settings is the densest
 * place the shell answers "where does this live?", and on a Mac it answers
 * "this Mac" — which in a browser tab is not a stale phrasing but a false
 * promise about storage. `surface-copy.test.ts` pins the strings; what only a
 * real tab can show is that the strings that reach the SCREEN are the web's:
 * the rail's lede, every nav caption, and the pages a person actually opens
 * to read about storage — Appearance, Privacy and Memory.
 */

const PASSWORD = "correct-horse-battery";
const SCREENSHOTS = "e2e/screenshots/web-split-links";

/**
 * What a browser tab must never say about where things are kept. The Mac's
 * own wording is right on a Mac and a false promise here, so the assertion
 * is on the rendered text of the whole page — the rail's captions included —
 * rather than on any one string the test knows to look for.
 */
async function expectNoMacTalk(settings: Locator, where: string): Promise<void> {
  const text = await settings.innerText();
  for (const phrase of ["this Mac", "your Mac", "per-machine", "on disk", "this machine", "macOS"]) {
    expect(text.toLowerCase(), `${where} must not say "${phrase}" in a browser tab`).not.toContain(
      phrase.toLowerCase(),
    );
  }
}

/** Open a settings section from the rail and hand back the page. */
/** The nav groups a section may sit under, by the label of the row that opens each. */
const NAV_GROUPS = { Account: "account", Agent: "delegation" } as const;

/**
 * Opens a settings section from wherever the rail is. `group` names the nav
 * group whose menu lists it; without one the section is a row of the root.
 */
async function openSection(page: Page, name: string, group?: keyof typeof NAV_GROUPS): Promise<Locator> {
  const settings = page.getByTestId("settings-page");
  // :not([inert]) skips a menu that is only still mounted to animate out.
  const menu = (key: string) => settings.locator(`[data-testid="settings-menu-${key}"]:not([inert])`);
  const wanted = group === undefined ? "root" : NAV_GROUPS[group];
  if ((await menu(wanted).count()) === 0) {
    if ((await menu("root").count()) === 0) {
      await settings.getByRole("button", { name: /^Back to all settings/ }).click();
    }
    if (group !== undefined) await settings.getByRole("button", { name: group, exact: true }).click();
  }
  await settings.getByRole("button", { name, exact: true }).click();
  return settings;
}

/**
 * The affordance §15 promises: the host's reason, and one link out. Answers
 * with the address it points at.
 */
async function unavailableLink(settings: Locator, title: string): Promise<string> {
  await expect(settings.getByRole("heading", { name: title })).toBeVisible({ timeout: 30_000 });
  // The row is the whole point: a refusal that says WHY, next to a way to the
  // place that can. Its presence is also the proof the Button rendered — the
  // crash took the shell, not just the button.
  await expect(settings.getByText("Not available here")).toBeVisible({ timeout: 30_000 });
  const link = settings.getByTestId("settings-account-link");
  await expect(link).toBeVisible();
  await expect(link).toHaveText("Open the web app");
  const href = await link.getAttribute("href");
  expect(href).not.toBeNull();
  return href ?? "";
}

test("the browser's 'managed from the web app' links reach the dashboard, not the site", async ({ page, request }) => {
  // Two cold `next dev` processes, a real Chromium fleet, a claimed session,
  // and a walkthrough walked before settings can be opened at all.
  test.setTimeout(600_000);
  const chromium = chromiumPath();
  test.skip(chromium === null, "no Chromium build is available for the cloud browser");

  const stack: WebStack = await startWebStack({ chromium, name: "web-split-links", apps: ["web", "www"] });
  const { controlUrl, runnerUrl, urls } = stack;
  expect(await corsAllowed(controlUrl, urls.web)).toBe(urls.web);

  // Every uncaught error for the whole walk. The regression this spec exists
  // for is an exception, not a wrong pixel, so it is collected rather than
  // inferred from what did not render.
  const errors: string[] = [];
  page.on("console", (message) => {
    stack.noteWebLog(`Browser console: ${message.type()} ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
    stack.noteWebLog(`Browser error: ${error.message}`);
  });

  try {
    /* -------------------- an account, and past the first run ---------------- */

    const email = `split-links-${randomUUID().slice(0, 8)}@example.com`;
    await signUpInTab(page, { webUrl: urls.web, email, password: PASSWORD });
    await openBrowseShell(page);
    await walkFirstRun(page, "Ada Lovelace");

    /* --------------------------- the status card ---------------------------- */

    // The sidebar folds the browser-status card into its footer menu, so the
    // plane rows are menu rows here. On a Mac there are three — the account,
    // the cloud browser and identity egress — and every one of their subjects
    // is refused by this host as "managed from the web app". Nothing publishes
    // an account, a sync status, a cloud status or an egress status to this
    // shell, so all three would report their resting DEFAULTS as if they were
    // findings. They fold into one row that says where the answers are.
    const menu = await openSidebarMenu(page);
    const managed = menu.getByTestId("menu-plane-managed");
    await expect(managed).toBeVisible({ timeout: 30_000 });
    await expect(managed).toContainText("Account, sync, cloud and egress are managed from the web app");
    // The way there is the dashboard's account page — the same route Settings
    // → Account's own `Unavailable` offers, and a new tab, never this one.
    await expect(managed).toHaveAttribute("href", `${urls.www}/app/settings/account`);
    await expect(managed).toHaveAttribute("target", "_blank");
    // And not one of the never-published defaults, on the card whose whole job
    // is to be trusted.
    const menuText = await menu.innerText();
    for (const claim of ["Signed out", "Not enrolled", "Revoked", "No Spaces", "Direct"]) {
      expect(menuText, `the status rows must not report "${claim}" from a status nobody sent`).not.toContain(claim);
    }
    expect(menuText).not.toContain("undefined");
    await expect(menu.getByTestId("menu-plane-identity")).toHaveCount(0);
    await expect(menu.getByTestId("menu-plane-cloud")).toHaveCount(0);
    await expect(menu.getByTestId("menu-plane-egress")).toHaveCount(0);
    await page.screenshot({ path: `${SCREENSHOTS}/00-status-managed.png`, fullPage: true });

    /* ------------------------------- settings ------------------------------- */

    await (await sidebarMenuItem(page, "settings-button")).click();
    const settingsPage = page.getByTestId("settings-page");
    await expect(settingsPage).toBeVisible({ timeout: 60_000 });

    // The rail, before anything is opened: its lede and every caption under
    // every icon. The lede used to read "Preferences, kept on this Mac" and
    // Account's caption ended "this Mac" — in a tab there is no Mac, and
    // settings are the sealed account register the host reads and writes.
    await expect(settingsPage.getByText("Preferences, synced to your account")).toBeVisible({ timeout: 30_000 });
    await expectNoMacTalk(settingsPage, "the settings rail");

    // Account: the section the crash was found on, and the one with the most
    // specific page over there.
    const account = await openSection(page, "Account");
    const accountHref = await unavailableLink(account, "Account");
    expect(accountHref, "Account must link into the dashboard's account page").toBe(
      `${urls.www}/app/settings/account`,
    );
    // The regression itself, named: the site's front page is a landing page,
    // and nobody manages an account on one.
    expect(accountHref).not.toBe(urls.www);
    expect(accountHref).not.toBe(`${urls.www}/`);
    // A new tab, never this one: this tab IS the browser.
    await expect(account.getByTestId("settings-account-link")).toHaveAttribute("target", "_blank");
    await page.screenshot({ path: `${SCREENSHOTS}/01-account-unavailable.png`, fullPage: true });

    // Devices, whose dashboard page is not under /settings at all: proof the
    // route is chosen per section rather than pasted on.
    const devices = await openSection(page, "Devices", "Account");
    expect(await unavailableLink(devices, "Devices")).toBe(`${urls.www}/app/devices`);

    // The vault and integrations: the same helper, the same two bugs, and the
    // pages that only learn they are refused when they first ask.
    const vault = await openSection(page, "Vault", "Account");
    expect(await unavailableLink(vault, "Passwords")).toBe(`${urls.www}/app/settings/vault`);
    await page.screenshot({ path: `${SCREENSHOTS}/02-vault-unavailable.png`, fullPage: true });

    const integrations = await openSection(page, "Integrations");
    expect(await unavailableLink(integrations, "Integrations")).toBe(`${urls.www}/app/settings/integrations`);
    await page.screenshot({ path: `${SCREENSHOTS}/03-integrations-unavailable.png`, fullPage: true });

    // Sync has no page of its own over there, so it lands on the dashboard
    // itself — a true destination rather than a guessed route that 404s.
    const sync = await openSection(page, "Sync", "Account");
    expect(await unavailableLink(sync, "Sync")).toBe(`${urls.www}/app`);

    // Not one of them threw. Before the fix the first click replaced the
    // shell with "Slot failed to slot onto its children."
    expect(errors, "the shell must survive every section that is managed elsewhere").toEqual([]);

    /* ------------------- and the sections that DO answer -------------------- */

    // Appearance, Privacy and Memory are the three pages whose whole subject
    // is storage, and all three answer here rather than rendering
    // `Unavailable`: appearance is the account's synced settings register,
    // memory is written by the host under this account's keys, and site data
    // is the Space's cookies and storage on the worker. Each used to say
    // "this Mac" in a tab.
    const appearance = await openSection(page, "Appearance");
    await expect(appearance.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible({ timeout: 30_000 });
    await expectNoMacTalk(appearance, "Settings → Appearance");
    await page.screenshot({ path: `${SCREENSHOTS}/04-appearance.png`, fullPage: true });

    // Privacy & security is a GROUP: selecting it pushes its own menu, whose
    // header carries a caption too, and lands on Site data.
    const privacy = await openSection(page, "Privacy & security");
    await expect(privacy.getByRole("heading", { name: "Site data", exact: true })).toBeVisible({ timeout: 30_000 });
    await expectNoMacTalk(privacy, "Settings → Privacy & security → Site data");
    await privacy.getByRole("button", { name: "Spaces", exact: true }).click();
    await expect(privacy.getByRole("heading", { name: "Spaces", exact: true })).toBeVisible({ timeout: 30_000 });
    await expectNoMacTalk(privacy, "Settings → Privacy & security → Spaces");
    await privacy.getByRole("button", { name: "Agent isolation", exact: true }).click();
    await expect(privacy.getByRole("heading", { name: "Agent isolation", exact: true })).toBeVisible({ timeout: 30_000 });
    await expectNoMacTalk(privacy, "Settings → Privacy & security → Isolation");
    await page.screenshot({ path: `${SCREENSHOTS}/05-privacy.png`, fullPage: true });

    // Back out of the group so the root rail — and the Agent group on it — is reachable.
    await privacy.getByRole("button", { name: "Back to all settings from Privacy & security" }).click();

    const memory = await openSection(page, "Memory", "Agent");
    await expect(memory.getByRole("heading", { name: "Memory", exact: true })).toBeVisible({ timeout: 30_000 });
    await expectNoMacTalk(memory, "Settings → Memory");
    await page.screenshot({ path: `${SCREENSHOTS}/06-memory.png`, fullPage: true });

    // About: the page whose subject IS what this is running in. Its runtime
    // and settings rows were built from `AppInfo` fields a session host does
    // not have, and rendered the gaps — "Electron  · Chromium …" and a
    // settings path of "/settings.json". Both fields are optional on the
    // contract now, the host omits them, and the rows are chosen per surface.
    const about = await openSection(page, "About");
    await expect(about.getByRole("heading", { name: "About", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(about.getByText("Runs in", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(about.getByText("This account's synced settings register")).toBeVisible();
    // The rows render before the asynchronous host version response arrives.
    await expect(about).toContainText("Chromium");
    const aboutText = await about.innerText();
    expect(aboutText, "About must never render a field the host did not answer").not.toContain("undefined");
    expect(aboutText).not.toContain("Electron");
    expect(aboutText).not.toContain("settings.json");
    expect(aboutText).toContain("Chromium");
    await expectNoMacTalk(about, "Settings → About");
    await page.screenshot({ path: `${SCREENSHOTS}/07-about.png`, fullPage: true });

    // Still nothing thrown by any of it.
    expect(errors, "the shell must survive every section a browser tab can open").toEqual([]);

    /* --------------------- and the addresses are real ----------------------- */

    // A matching string is not a working link: each is fetched on the site
    // that serves it, so a dashboard route that moved fails here rather than
    // in someone's browser.
    for (const href of [
      `${urls.www}/app`,
      `${urls.www}/app/settings/account`,
      `${urls.www}/app/devices`,
      `${urls.www}/app/settings/vault`,
      `${urls.www}/app/settings/integrations`,
    ]) {
      expect((await request.get(href)).status(), href).toBe(200);
    }
  } catch (error) {
    const log = stack.logs();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nControl at ${controlUrl}, runner at ${runnerUrl}, web at ${urls.web}, www at ${urls.www}\nControl log:\n${log.control.slice(-6_000)}\nRunner log:\n${log.runner.slice(-4_000)}\nWeb output:\n${log.web.slice(-8_000)}`,
    );
  } finally {
    await stack.close();
  }
});
