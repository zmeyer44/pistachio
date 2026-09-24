import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
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
 * §14's gate (docs/web-browser-design.md): the first run, on the web.
 *
 * A person who creates their account in the browser lands in the browser's
 * walkthrough at once, and the walkthrough is the DESKTOP'S — the same four
 * steps, the same stages, the same completion — running on a stream surface
 * over a real cloud-browser session. The stack under it is the one
 * `web-browse.spec.ts` uses (`web-harness.ts`): control on PGlite, a worker
 * with real Chromium, and the browser app (`web`) as `next dev`. The
 * dashboard is not booted; nothing here needs it.
 *
 * What it walks, in order:
 *
 *  - sign up at `/`, with the walkthrough up at `about` rather than the
 *    chrome. That is the whole first-run mechanism in one assertion: a NEW
 *    account created on the browser app is already standing where its first
 *    run happens (§15), the page wrote `onboarding.completed: false` before
 *    the shell mounted, and the store's own first-load rule opened the
 *    wizard.
 *  - the wording every step uses for WHERE WHAT YOU GAVE GOES, which is a
 *    promise about storage and so is the surface's, not the desktop's: an
 *    introduction sealed under the account's keys and synced, an appearance
 *    saved to the account's settings — and nowhere in the walkthrough the
 *    phrase "this Mac", which in a browser tab would be a false promise.
 *  - a typed introduction. The models come with the account, so the mic is
 *    offered — but no gateway key is configured in a test, so nothing is
 *    spoken here and the step's other half, typing, is what is used.
 *  - the import step's WEB variant: the reason, the sync explanation, a
 *    download link, and an enabled "Continue" — with none of the Mac's
 *    browser cards, because `detectBrowsers` is never called.
 *  - a reload MID-WALKTHROUGH, right after the about step, which must reopen
 *    it: the account database still says incomplete.
 *  - a fresh browser signing in to the unfinished account also sees the wizard.
 *  - favorites, including a site of the person's own, and a preset.
 *  - the reveal: three tiles in the grid, the Space named after them, and the
 *    welcome overview open as a tab at its own `pistachio://` address.
 *  - a second visit, which opens on the browser: the walkthrough is done.
 */

const PASSWORD = "correct-horse-battery";
const NAME = "Ada Lovelace";
const BIO = "Writes compilers and reads about engines.";
const OWN_SITE = "news.ycombinator.com";
const SCREENSHOTS = "e2e/screenshots/web-onboarding";

/** The about step, filled in by hand. The mic needs a model; typing never does. */
async function typeIntroduction(page: Page): Promise<void> {
  const typeInstead = page.getByTestId("onboarding-type-instead");
  // Offered only while the fields are hidden — which they are whenever a
  // model can be reached, and this browser is an enrolled device.
  if (await typeInstead.isVisible()) await typeInstead.click();
  await expect(page.getByTestId("onboarding-about-fields")).toBeVisible();
  await page.getByTestId("onboarding-name").fill(NAME);
  await page.getByTestId("onboarding-bio").fill(BIO);
}

test("a new web account walks the first run and lands in a furnished Space", async ({ page, browser }) => {
  // A cold `next dev`, a real Chromium fleet, a claimed session, and a
  // walkthrough that ends by opening four tabs.
  test.setTimeout(600_000);
  const chromium = chromiumPath();
  test.skip(chromium === null, "no Chromium build is available for the cloud browser");

  const stack: WebStack = await startWebStack({ chromium, name: "web-onboarding" });
  const { controlUrl, runnerUrl, webUrl } = stack;
  expect(await corsAllowed(controlUrl, webUrl)).toBe(webUrl);
  page.on("console", (message) => {
    stack.noteWebLog(`Browser console: ${message.type()} ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    stack.noteWebLog(`Browser error: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    stack.noteWebLog(`Request failed: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`);
  });

  try {
    /* ------------------- an account, and straight to the browser ------------ */

    const email = `first-run-${randomUUID().slice(0, 8)}@example.com`;
    await signUpInTab(page, { webUrl, email, password: PASSWORD });
    await openBrowseShell(page);

    const wizard = page.getByTestId("onboarding");
    await expect(wizard).toBeVisible({ timeout: 60_000 });
    await expect(wizard).toHaveAttribute("data-step", "about");

    // An existing account with no local browser history still owes onboarding.
    const unfinishedContext = await browser.newContext();
    try {
      const fresh = await unfinishedContext.newPage();
      await signInInTab(fresh, { webUrl, email, password: PASSWORD });
      await openBrowseShell(fresh);
      await expect(fresh.getByTestId("onboarding")).toBeVisible();
      await fresh.screenshot({ path: `${SCREENSHOTS}/01a-fresh-browser-unfinished.png`, fullPage: true, animations: "disabled" });
    } finally {
      await unfinishedContext.close();
    }

    await expect(page.getByRole("heading", { name: /Tell us about/u })).toBeVisible();
    // The step's promise about STORAGE, on the surface it is being made on.
    // A browser tab has no Mac to keep an introduction on: what the host
    // writes is memory sealed under this account's keys, and it syncs. The
    // desktop's own wording is pinned beside this one in
    // packages/shell-ui/test/onboarding-steps.test.ts.
    await expect(wizard).toContainText("sealed under this account's keys and synced to your devices");
    await expect(wizard).toContainText("Settings → Memory");
    await expect(wizard).not.toContainText("this Mac");
    // Four steps, and no "Or sign in" under the introduction: the person
    // signed in on the way to this page (§14).
    await expect(page.getByTestId("onboarding-sign-in")).toHaveCount(0);
    await expect(page.getByTestId("onboarding-rail")).toContainText("Step 1 of 4");
    // Nothing native to raise the chrome over, so the reveal is honest at once.
    await expect(page.getByTestId("onboarding-ready")).toHaveAttribute("data-ready", "");
    await page.screenshot({ path: `${SCREENSHOTS}/01-about.png`, fullPage: true, animations: "disabled" });

    /* --------------------------- a typed introduction ----------------------- */

    await typeIntroduction(page);
    await page.screenshot({ path: `${SCREENSHOTS}/02-about-typed.png`, fullPage: true, animations: "disabled" });

    /* ------------------ the viewer reloads mid-walkthrough ------------------ */

    // The flag is the HOST's. A reload throws away everything this tab held —
    // the wizard's own state included — and the walkthrough must still be
    // there, at its first step, because the sealed settings record still says
    // the first run is not done.
    await page.reload();
    // A kept session comes back behind its PIN now, not straight into the app.
    await enterPin(page);
    await openBrowseShell(page);
    await expect(wizard).toBeVisible({ timeout: 60_000 });
    await expect(wizard).toHaveAttribute("data-step", "about");
    await page.screenshot({ path: `${SCREENSHOTS}/03-reopened-after-reload.png`, fullPage: true, animations: "disabled" });
    await typeIntroduction(page);
    await page.getByTestId("onboarding-primary").click();

    /* ----------------------- bring a browser, on the web -------------------- */

    await expect(wizard).toHaveAttribute("data-step", "import");
    const webImport = page.getByTestId("onboarding-import-web");
    await expect(webImport).toBeVisible();
    // The Mac's stage is not merely empty here — it is absent, because
    // `detectBrowsers` is never called on a stream surface (W12).
    await expect(page.getByTestId("onboarding-import")).toHaveCount(0);
    await expect(page.locator("[data-testid^='import-browser-']")).toHaveCount(0);
    await expect(page.getByTestId("import-fresh")).toHaveCount(0);
    await expect(webImport).toContainText("happens in the Mac app, not in this tab");
    // The one step that names a Mac on purpose — it is about a machine this
    // tab is not — and even it never says "this Mac".
    await expect(wizard).not.toContainText("this Mac");
    await expect(webImport).toContainText("sealed under keys only your devices hold");
    await expect(page.getByTestId("onboarding-import-download")).toHaveAttribute("href", /https?:\/\//u);
    // The primary is a plain Continue, live from the moment the step opens,
    // and there is nothing to "start fresh instead" of.
    const primary = page.getByTestId("onboarding-primary");
    await expect(primary).toHaveText("Continue");
    await expect(primary).toBeEnabled();
    await expect(page.getByTestId("onboarding-skip")).toHaveCount(0);
    // Each step fades in on `key={step}`; the screenshot is this step's record,
    // so it waits for the stage rather than catching it mid-fade.
    await expect(page.getByTestId("onboarding-import-web-body")).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SCREENSHOTS}/04-import-web.png`, fullPage: true, animations: "disabled" });
    await primary.click();

    /* -------------------------------- favorites ----------------------------- */

    await expect(wizard).toHaveAttribute("data-step", "favorites");
    await page.getByTestId("favorite-app-figma").click();
    await page.getByTestId("favorite-app-youtube").click();
    // A site of one's own is checked like the new-tab page: a bare word is
    // refused, an address is kept.
    const ownSite = page.getByLabel("Add your own site");
    await ownSite.fill("hackernews");
    await ownSite.press("Enter");
    // Not `getByRole("alert")`: Next's own route announcer is one too.
    await expect(page.getByText(/A favorite has to be a web address/u)).toBeVisible();
    await ownSite.fill(OWN_SITE);
    await ownSite.press("Enter");
    await expect(page.getByTestId("onboarding-custom-site")).toHaveText(new RegExp(OWN_SITE.replace(/\./gu, "\\.")));
    const preview = page.getByTestId("onboarding-sidebar-preview");
    await expect(preview.getByRole("listitem")).toHaveCount(3);
    await page.screenshot({ path: `${SCREENSHOTS}/05-favorites.png`, fullPage: true, animations: "disabled" });
    await page.getByTestId("onboarding-primary").click();

    /* ------------------------------- appearance ----------------------------- */

    await expect(wizard).toHaveAttribute("data-step", "appearance");
    // The other promise about storage. Appearance is a per-machine preference
    // on a Mac and says so; here the host writes it into the account's own
    // settings register, so it is the account's and it travels.
    await expect(wizard).toContainText("saved to this account's synced settings");
    await expect(wizard).toContainText("every device that reads them");
    await expect(wizard).not.toContainText("per-machine");
    await expect(wizard).not.toContainText("this Mac");
    await page.getByTestId("appearance-preset-ember").click();
    await expect(page.getByTestId("appearance-preset-ember")).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: `${SCREENSHOTS}/06-appearance.png`, fullPage: true, animations: "disabled" });
    await page.getByTestId("onboarding-primary").click();

    /* --------------------------------- reveal ------------------------------- */

    await expect(wizard).toHaveCount(0, { timeout: 120_000 });
    const grid = page.getByTestId("favorites-grid");
    await expect(grid).toBeVisible();
    await expect(grid.getByTestId("favorite-tile")).toHaveCount(3, { timeout: 60_000 });
    // The Space was renamed after the person: the host sealed the record and
    // this side told control's own row about it.
    await expect(page.getByTestId("sidebar-menu-button")).toHaveAttribute("aria-label", "Space: Ada", {
      timeout: 60_000,
    });
    // The welcome tabs are open, at their own logical addresses: the host
    // renders each page as a document and the tab still calls itself
    // `pistachio://welcome/` (§14). The pane's accessible name is the title
    // and the address as the HOST reports them, which is where that shows.
    await expect(page.getByRole("tab", { name: /Welcome to Pistachio/u }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("tab", { name: /Hand work to the agent/u }).first()).toBeVisible({ timeout: 60_000 });
    const welcome = page.getByRole("region", { name: /Welcome to Pistachio — pistachio:\/\/welcome\//u });
    await expect(welcome).toBeVisible({ timeout: 60_000 });
    // …and the overview is the ACTIVE tab, so the address bar says so too.
    await expect(page.getByRole("button", { name: "Edit address" })).toContainText("pistachio://welcome");
    // The page is not merely LISTED: it painted. A welcome tab whose document
    // the host never rendered would sit on "Opening…" forever, and the
    // greeting this walkthrough exists to earn — "Let\u2019s settle in, Ada." — is
    // drawn inside that picture, which is what the screenshot below records.
    await expect(welcome.getByTestId("streamed-pane-waiting")).toHaveCount(0, { timeout: 60_000 });
    await expect(welcome.getByTestId("streamed-pane-frame")).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(
        async () =>
          welcome
            .getByTestId("streamed-pane-frame")
            .evaluate((image: HTMLImageElement) => image.naturalWidth),
        { timeout: 60_000, message: "the welcome pane never decoded a screencast frame" },
      )
      .toBeGreaterThan(0);
    await page.screenshot({ path: `${SCREENSHOTS}/07-revealed.png`, fullPage: true, animations: "disabled" });

    /* ---------------------------- and never again --------------------------- */

    // Database completion survives a reload and a completely fresh browser.
    await page.goto(`${webUrl}/`);
    await enterPin(page);
    await openBrowseShell(page);
    await expect(page.getByTestId("onboarding")).toHaveCount(0);
    await expect(page.getByTestId("favorites-grid").getByTestId("favorite-tile")).toHaveCount(3, {
      timeout: 60_000,
    });
    await page.screenshot({ path: `${SCREENSHOTS}/08-second-visit.png`, fullPage: true, animations: "disabled" });

    const completedContext = await browser.newContext();
    try {
      const fresh = await completedContext.newPage();
      await signInInTab(fresh, { webUrl, email, password: PASSWORD });
      await openBrowseShell(fresh);
      await expect(fresh.getByTestId("onboarding")).toHaveCount(0);
      await fresh.screenshot({ path: `${SCREENSHOTS}/09-fresh-browser-completed.png`, fullPage: true, animations: "disabled" });
    } finally {
      await completedContext.close();
    }
  } catch (error) {
    const log = stack.logs();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nControl at ${controlUrl}, runner at ${runnerUrl}, web at ${webUrl}\nControl log:\n${log.control.slice(-6_000)}\nRunner log:\n${log.runner.slice(-4_000)}\nWeb output:\n${log.web.slice(-8_000)}`,
    );
  } finally {
    await stack.close();
  }
});


test("an account created elsewhere must finish onboarding, including a failed save retry", async ({ page }) => {
  test.setTimeout(240_000);
  const chromium = chromiumPath();
  test.skip(chromium === null, "no Chromium build is available for the cloud browser");
  const stack = await startWebStack({ chromium, name: "web-onboarding-account" });
  const shots = "e2e/screenshots/web-onboarding-account";
  try {
    // Create the account without ever setting browser storage or shell settings.
    const email = `account-onboarding-${randomUUID().slice(0, 8)}@example.com`;
    const signup = await page.request.post(`${stack.controlUrl}/v1/accounts`, {
      data: { email, password: PASSWORD },
    });
    expect(signup.status()).toBe(201);
    const { bootstrapToken } = await signup.json() as { bootstrapToken: string };
    const status = async (): Promise<string | null> => {
      const response = await page.request.get(`${stack.controlUrl}/v1/me`, {
        headers: { authorization: `Bearer ${bootstrapToken}` },
      });
      expect(response.status()).toBe(200);
      return (await response.json() as { onboardingCompletedAt: string | null }).onboardingCompletedAt;
    };
    expect(await status()).toBeNull();
    await signInInTab(page, { webUrl: stack.webUrl, email, password: PASSWORD });
    await openBrowseShell(page);
    const wizard = page.getByTestId("onboarding");
    await expect(wizard).toBeVisible();
    await page.screenshot({ path: `${shots}/01-existing-account-about.png`, fullPage: true, animations: "disabled" });
    await typeIntroduction(page);
    const primary = page.getByTestId("onboarding-primary");
    await primary.click();
    await expect(wizard).toHaveAttribute("data-step", "import");
    await page.screenshot({ path: `${shots}/02-import.png`, fullPage: true, animations: "disabled" });
    await primary.click();
    await expect(wizard).toHaveAttribute("data-step", "favorites");
    await page.screenshot({ path: `${shots}/03-favorites.png`, fullPage: true, animations: "disabled" });
    await primary.click();
    await expect(wizard).toHaveAttribute("data-step", "appearance");
    await page.screenshot({ path: `${shots}/04-appearance.png`, fullPage: true, animations: "disabled" });

    // Lose the account write after the real host finishes: the wizard must stay.
    await page.route("**/v1/me/onboarding/complete", (route) => route.abort("failed"));
    await primary.click();
    await expect(wizard.getByRole("alert")).toBeVisible({ timeout: 60_000 });
    await expect(wizard.getByRole("alert")).toHaveText("We couldn't save your setup. Please try again.");
    expect(await status()).toBeNull();
    await page.screenshot({ path: `${shots}/05-save-failed.png`, fullPage: true, animations: "disabled" });

    // The retry saves completion without opening a second set of welcome tabs.
    await page.unroute("**/v1/me/onboarding/complete");
    await primary.click();
    await expect(wizard).toHaveCount(0, { timeout: 60_000 });
    expect(await status()).toEqual(expect.any(String));
    await expect(page.getByRole("tab", { name: /Welcome to Pistachio/u })).toHaveCount(1);
    await page.screenshot({ path: `${shots}/06-completed.png`, fullPage: true, animations: "disabled" });
  } finally {
    await stack.close();
  }
});
