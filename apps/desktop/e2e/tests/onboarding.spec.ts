import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type ElectronApplication } from "@playwright/test";
import { IPC } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";
import { captureEnabled, launchApp } from "./app";
import { captureShell as captureWindow, captureView } from "./pages-harness";

/**
 * Quit, and if Electron's shutdown stalls (it occasionally does while a
 * home-page load is being aborted), kill the process rather than let the
 * worker's teardown time out and leave a stray Electron for the next spec.
 */
async function closeApp(app: ElectronApplication): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const killAfter = new Promise<void>((done) => {
    timer = setTimeout(() => {
      app.process().kill("SIGKILL");
      done();
    }, 10_000);
  });
  await Promise.race([app.close(), killAfter]);
  if (timer !== undefined) clearTimeout(timer);
}

function captureShell(
  app: ElectronApplication,
  filename: string,
): Promise<void> {
  return captureWindow(app, `onboarding/${filename}`, 450);
}

interface StoredSettings {
  onboarding: { completed: boolean; completedAt: string | null };
  appearance: { colors: string[] };
}

interface StoredMemory {
  entries: Array<{ key: string | null; content: string; isLatest: boolean }>;
}

interface StoredSidebar {
  spaces: Record<string, { favorites: Array<{ url: string; title: string }> }>;
}

interface StoredSpaces {
  spaces: Array<{ id: string; name: string }>;
}

/**
 * A fresh install: the wizard stands in front of the chrome and walks its
 * four steps (typed introduction, a fresh start, three favorites, a preset),
 * and on finishing the browser appears with the Space named, the favorites
 * in the grid, memory seeded, and the welcome tabs open. The account step
 * is absent here: the account services do not start under PISTACHIO_E2E, so
 * nothing requires an account (the spec below turns that on).
 * Finished, Settings → About replays it, and Escape leaves the replay.
 */
test("first run walks the wizard and furnishes the first Profile, and About replays it", { tag: ["@onboarding"] }, async () => {
  // PISTACHIO_ONBOARDING keeps the wizard that every other spec's launch turns off.
  const { app, userData } = await launchApp({ env: { PISTACHIO_ONBOARDING: "1" }, name: "onboarding" });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const wizard = shell.getByTestId("onboarding");
    await expect(wizard).toBeVisible();

    await expect(wizard).toHaveAttribute("data-step", "about");
    await expect(
      shell.getByRole("heading", { name: /Tell us about/ }),
    ).toBeVisible();
    // The chrome is raised above the tab views while the wizard is up.
    await expect(shell.getByTestId("onboarding-ready")).toHaveAttribute(
      "data-ready",
      "",
    );
    await captureShell(app, "01-about.png");

    // With models to listen with, the mic is offered first; without any
    // (always, under E2E) the stage says so. Either way the fields are a
    // click away at most.
    const typeInstead = shell.getByTestId("onboarding-type-instead");
    if (await typeInstead.isVisible()) await typeInstead.click();
    await expect(shell.getByTestId("onboarding-about-fields")).toBeVisible();
    await shell.getByTestId("onboarding-name").fill("Ada Lovelace");
    await shell
      .getByTestId("onboarding-bio")
      .fill("Writes compilers and reads about engines.");
    await shell.getByTestId("onboarding-primary").click();

    await expect(wizard).toHaveAttribute("data-step", "import");
    // Continue waits for a choice; starting fresh is one.
    await expect(shell.getByTestId("onboarding-primary")).toBeDisabled();
    await expect(shell.getByTestId("onboarding-import")).toBeVisible();
    // The first browser found starts open; its header collapses it, and every card may be closed at once.
    const cards = shell
      .getByTestId("onboarding-import")
      .locator("[data-testid^='import-browser-']");
    if ((await cards.count()) > 0) {
      const first = cards.first();
      await expect(first).toHaveAttribute("data-expanded", "");
      await first.getByRole("button").first().click();
      await expect(first).not.toHaveAttribute("data-expanded", "");
      await expect(
        shell.locator("[data-testid^='import-browser-'][data-expanded]"),
      ).toHaveCount(0);
      await first.getByRole("button").first().click();
      await expect(first).toHaveAttribute("data-expanded", "");
    }
    await captureShell(app, "02-import.png");
    await shell.getByTestId("import-fresh").click();
    await expect(shell.getByTestId("onboarding-primary")).toBeEnabled();
    await shell.getByTestId("onboarding-primary").click();

    await expect(wizard).toHaveAttribute("data-step", "favorites");
    const next = shell.getByTestId("onboarding-primary");
    // Three is a suggestion, not a gate: Next is live with nothing picked,
    // and the step can be skipped outright.
    await expect(next).toBeEnabled();
    await expect(shell.getByTestId("onboarding-skip")).toHaveText("Skip for now");
    await shell.getByTestId("favorite-app-figma").click();
    await shell.getByTestId("favorite-app-youtube").click();
    await expect(shell.getByText("2 chosen", { exact: false })).toBeVisible();
    // A site of one's own is checked like the new-tab page: a word is
    // refused, an address is kept and shown on the preview.
    const ownSite = shell.getByLabel("Add your own site");
    await ownSite.fill("hackernews");
    await ownSite.press("Enter");
    await expect(shell.getByRole("alert")).toContainText("web address");
    await ownSite.fill("news.ycombinator.com");
    await ownSite.press("Enter");
    await expect(shell.getByTestId("onboarding-custom-site")).toHaveText(/news\.ycombinator\.com/);
    await expect(shell.getByTestId("preview-favorite-custom")).toHaveCount(1);
    // The preview keeps the order picked, not the catalog's (where Gmail
    // leads and Figma trails): each new pick takes the next slot, a typed-in
    // site included, and nothing already there moves.
    const previewOrder = () =>
      shell
        .getByTestId("onboarding-sidebar-preview")
        .getByRole("listitem")
        .evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute("aria-label")));
    await expect.poll(previewOrder).toEqual(["Figma", "YouTube", "news.ycombinator.com"]);
    await shell.getByTestId("favorite-app-gmail").click();
    await expect.poll(previewOrder).toEqual(["Figma", "YouTube", "news.ycombinator.com", "Gmail"]);
    await shell.getByRole("button", { name: "Remove news.ycombinator.com" }).click();
    await expect(shell.getByTestId("onboarding-custom-site")).toHaveCount(0);
    await expect.poll(previewOrder).toEqual(["Figma", "YouTube", "Gmail"]);
    await expect(shell.getByTestId("favorite-app-figma")).toHaveAttribute(
      "data-selected",
      "",
    );
    await expect(next).toBeEnabled();
    // The picks show in the mock sidebar, the latest as the active page.
    const preview = shell.getByTestId("onboarding-sidebar-preview");
    await expect(preview.getByRole("listitem")).toHaveCount(3);
    await expect(preview.getByTestId("preview-favorite-gmail")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(
      preview.getByTestId("preview-favorite-figma"),
    ).not.toHaveAttribute("aria-current", "page");
    await captureShell(app, "03-favorites.png");
    // Back keeps what was chosen.
    await shell.getByTestId("onboarding-back").click();
    await expect(wizard).toHaveAttribute("data-step", "import");
    await shell.getByTestId("onboarding-primary").click();
    await expect(shell.getByTestId("favorite-app-gmail")).toHaveAttribute(
      "data-selected",
      "",
    );
    await next.click();

    await expect(wizard).toHaveAttribute("data-step", "appearance");
    await shell.getByTestId("appearance-preset-ember").click();
    await expect(shell.getByTestId("appearance-preset-ember")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // The mock sidebar carries over from the favorites step as a live preview of the palette.
    const themed = shell.getByTestId("onboarding-sidebar-preview");
    await expect(themed).toBeVisible();
    await expect(themed.getByRole("listitem")).toHaveCount(3);
    await captureShell(app, "04-appearance.png");
    await shell.getByTestId("onboarding-primary").click();

    // The browser is revealed: the wizard gone, the sidebar showing the
    // favorites, the welcome page as the active tab.
    await expect(wizard).toHaveCount(0, { timeout: 15_000 });
    const grid = shell.getByTestId("favorites-grid");
    await expect(grid).toBeVisible();
    await expect(grid.getByTestId("favorite-tile")).toHaveCount(3);
    await expect(shell.getByTestId("sidebar-menu-button")).toHaveAttribute(
      "aria-label",
      "Profile: Ada",
    );
    const activeUrl = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w === undefined) throw new Error("no window");
      // The active tab view is the topmost child whose page is the welcome address.
      return w.contentView.children
        .map((view) =>
          "webContents" in view
            ? (view as Electron.WebContentsView).webContents.getURL()
            : "",
        )
        .filter((url) => url.startsWith("pistachio://"));
    });
    expect(activeUrl).toContain("pistachio://welcome/");
    expect(activeUrl).toContain("pistachio://learn/agent");
    await captureShell(app, "05-welcome.png");
    // Opening a favorite makes its tile the active one, dressed in its brand.
    const youtube = grid
      .getByTestId("favorite-tile")
      .filter({ hasText: "" })
      .nth(1);
    await youtube.click();
    await expect(youtube).toHaveAttribute("aria-pressed", "true", {
      timeout: 15_000,
    });
    await captureShell(app, "07-favorite-active.png");
    // The welcome page is a native view; capture it on its own, greeting included.
    const welcome = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w === undefined) throw new Error("no window");
      const view = w.contentView.children.find(
        (candidate) =>
          "webContents" in candidate &&
          (candidate as Electron.WebContentsView).webContents.getURL() ===
            "pistachio://welcome/",
      ) as Electron.WebContentsView | undefined;
      if (view === undefined) throw new Error("no welcome view");
      const contents = view.webContents;
      if (contents.isLoading())
        await new Promise<void>((done) =>
          contents.once("did-finish-load", () => done()),
        );
      return {
        title: contents.getTitle(),
        text: await contents.executeJavaScript("document.body.innerText"),
      };
    });
    expect(welcome.title).toBe("Welcome to Pistachio");
    expect(welcome.text).toContain("Let's settle in, Ada.");
    if (captureEnabled) {
      // The welcome page's first paint trails its load by a beat.
      await new Promise((done) => setTimeout(done, 300));
      await captureView(app, "pistachio://welcome/", "onboarding/06-welcome-page.png");
    }

    // What landed on disk.
    const settings = JSON.parse(
      await readFile(join(userData, "settings.json"), "utf8"),
    ) as StoredSettings;
    expect(settings.onboarding.completed).toBe(true);
    expect(settings.onboarding.completedAt).not.toBeNull();
    expect(settings.appearance.colors).toEqual([
      "#F28B62",
      "#D65276",
      "#7650C7",
    ]);
    const memory = JSON.parse(
      await readFile(join(userData, "memory.json"), "utf8"),
    ) as StoredMemory;
    expect(
      memory.entries.find(
        (entry) => entry.key === "profile.name" && entry.isLatest,
      )?.content,
    ).toBe("Ada Lovelace");
    expect(
      memory.entries.find(
        (entry) => entry.key === "profile.about" && entry.isLatest,
      )?.content,
    ).toBe("Writes compilers and reads about engines.");
    const sidebar = JSON.parse(
      await readFile(join(userData, "sidebar.json"), "utf8"),
    ) as StoredSidebar;
    expect(
      Object.values(sidebar.spaces)[0]?.favorites.map(
        (favorite) => favorite.title,
      ),
    ).toEqual(["Figma", "YouTube", "Gmail"]);
    const spaces = JSON.parse(
      await readFile(join(userData, "spaces.json"), "utf8"),
    ) as StoredSpaces;
    expect(spaces.spaces[0]?.name).toBe("Ada");

    // Settings → About replays the wizard; a replay can be left with Esc,
    // and nothing is written.
    await shell.keyboard.press("Meta+,");
    await shell
      .getByTestId("settings-page")
      .getByRole("button", { name: "About", exact: true })
      .click();
    await shell.getByTestId("replay-onboarding").click();
    await expect(wizard).toBeVisible();
    await shell.keyboard.press("Escape");
    await expect(wizard).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});

/**
 * The account channels, answered by a double in main: the account services
 * do not start under PISTACHIO_E2E, and what is under test here is the
 * shell's side of "an account is required" — the wizard's first step, the
 * sign-in screen, and what a sign-out does — not control. The production
 * preload bridge, the store and every component stay real.
 *
 * The double starts where `PISTACHIO_E2E_ACCOUNT=required` leaves main's own
 * answer: nobody signed in, an account owed, a keychain to seal keys with.
 * So the shell's first read, which may land before this is installed, says
 * the same thing either way.
 */
async function installAccountFixture(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, channels) => {
      for (const channel of Object.values(channels)) ipcMain.removeHandler(channel);

      const PASSWORD = "correct horse battery";
      const accounts = new Set<string>();
      let state: "unenrolled" | "signed-up" | "enrolled" = "unenrolled";
      let email: string | null = null;
      /** The account was made on this Mac: its first enrollment mints the recovery code. */
      let fresh = false;
      const account = () => ({
        state,
        required: true,
        email,
        userId: email === null ? null : "e2e-user",
        deviceId: "e2e-device",
        deviceName: "Test Mac",
        controlUrl: "https://control.example.test",
        encryptionAvailable: true,
        cloudDevicePin: null,
        cloudDeviceChanged: null,
        revoked: false,
        hubUrl: null,
        cloudBrowserUrl: null,
        error: null,
      });

      ipcMain.handle(channels.accountGet, () => account());
      ipcMain.handle(channels.accountSignUp, (_event, address: unknown, password: unknown) => {
        if (typeof address !== "string" || accounts.has(address)) throw new Error("That email already has an account. Sign in instead.");
        if (password !== PASSWORD) throw new Error("Choose a password of at least 8 characters.");
        accounts.add(address);
        state = "signed-up";
        email = address;
        fresh = true;
        return account();
      });
      ipcMain.handle(channels.accountSignIn, (_event, address: unknown, password: unknown) => {
        if (typeof address !== "string" || !accounts.has(address) || password !== PASSWORD) {
          throw new Error("That email and password do not match an account.");
        }
        state = "signed-up";
        email = address;
        fresh = false;
        return account();
      });
      ipcMain.handle(channels.accountEnroll, () => {
        if (state === "unenrolled") throw new Error("Sign in first.");
        state = "enrolled";
        const recoveryCode = fresh ? "E2E1-RECO-VERY-CODE" : null;
        fresh = false;
        return { state: account(), recoveryCode };
      });
      ipcMain.handle(channels.accountSignOut, () => {
        state = "unenrolled";
        email = null;
        return account();
      });
    },
    {
      accountGet: IPC.accountGet,
      accountSignUp: IPC.accountSignUp,
      accountSignIn: IPC.accountSignIn,
      accountEnroll: IPC.accountEnroll,
      accountSignOut: IPC.accountSignOut,
    },
  );
}

/**
 * An account is required (docs/onboarding.md, "The account"): a first run
 * opens on the account step, which cannot be skipped, makes the account and
 * holds the recovery code it is shown once until the person says they have
 * it; and a Mac that finished the walkthrough and signs out is given the
 * sign-in screen in the browser's place, with no way round it, until it
 * signs in again.
 */
test("an account is required: the wizard asks for it first, and signing out closes the browser until someone signs in", { tag: ["@onboarding"] }, async () => {
  const { app } = await launchApp({
    env: { PISTACHIO_ONBOARDING: "1", PISTACHIO_E2E_ACCOUNT: "required" },
    name: "onboarding-account",
  });
  try {
    await installAccountFixture(app);
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const wizard = shell.getByTestId("onboarding");
    const primary = shell.getByTestId("onboarding-primary");
    await expect(wizard).toBeVisible();

    // The account stands first, ahead of the four, and there is nothing to skip it with.
    await expect(wizard).toHaveAttribute("data-step", "account");
    await expect(shell.getByTestId("onboarding-rail")).toContainText("Step 1 of 5");
    await expect(shell.getByRole("heading", { name: /Create your/ })).toBeVisible();
    await expect(shell.getByTestId("onboarding-skip")).toHaveCount(0);
    await expect(shell.getByTestId("onboarding-back")).toHaveCount(0);
    await expect(primary).toBeDisabled();
    await shell.keyboard.press("Escape");
    await expect(wizard).toHaveAttribute("data-step", "account");
    await captureShell(app, "08-account.png");

    // A password that seals the keys is typed twice, and a slip is caught before anything is made.
    await shell.getByTestId("onboarding-account-email").fill("ada@example.test");
    await shell.getByTestId("onboarding-account-password").fill("correct horse battery");
    await shell.getByTestId("onboarding-account-confirm").fill("correct horse batter");
    await expect(primary).toHaveText("Create account");
    await primary.click();
    await expect(shell.getByTestId("onboarding-account").getByRole("alert")).toContainText("do not match");
    await expect(wizard).toHaveAttribute("data-step", "account");
    await shell.getByTestId("onboarding-account-confirm").fill("correct horse battery");
    // Enter in a field runs the step's button, as on every step.
    await shell.getByTestId("onboarding-account-confirm").press("Enter");

    // Made and enrolled in one pass. The recovery code is shown once, so the
    // step holds until the person says they have it.
    await expect(shell.getByTestId("onboarding-account-done")).toContainText("ada@example.test");
    await expect(shell.getByTestId("onboarding-recovery-code")).toHaveText("E2E1-RECO-VERY-CODE");
    await expect(wizard).toHaveAttribute("data-step", "account");
    await expect(primary).toHaveText(/saved it/);
    await captureShell(app, "09-recovery-code.png");
    // But not here: this button is the person saying they have the code, so
    // the Enter that made the account, pressed again, does not answer for them.
    await shell.keyboard.press("Enter");
    await expect(shell.getByTestId("onboarding-recovery-code")).toBeVisible();
    await expect(wizard).toHaveAttribute("data-step", "account");
    await primary.click();
    await expect(wizard).toHaveAttribute("data-step", "about");
    await expect(shell.getByTestId("onboarding-rail")).toContainText("Step 2 of 5");

    // The rest of the walk, by its shortest way.
    await shell.getByTestId("onboarding-skip").click();
    await expect(wizard).toHaveAttribute("data-step", "import");
    await shell.getByTestId("onboarding-skip").click();
    await expect(wizard).toHaveAttribute("data-step", "favorites");
    await shell.getByTestId("onboarding-skip").click();
    await expect(wizard).toHaveAttribute("data-step", "appearance");
    await primary.click();
    await expect(wizard).toHaveCount(0, { timeout: 15_000 });
    await expect(shell.getByTestId("sidebar-menu-button")).toBeVisible();

    // Signing out is leaving the browser: Settings says so, and the sign-in
    // screen comes up in its place.
    await shell.keyboard.press("Meta+,");
    const settings = shell.getByTestId("settings-page");
    await settings.getByRole("button", { name: "Account", exact: true }).click();
    await settings.getByTestId("account-sign-out").click();
    const dialog = shell.getByTestId("sign-out-dialog");
    await expect(dialog).toContainText("until you sign in again");
    await shell.getByTestId("sign-out-dialog-confirm").click();
    await expect(wizard).toBeVisible();
    await expect(wizard).toHaveAttribute("data-sign-in", "");
    await expect(wizard).toHaveAttribute("data-step", "account");
    await expect(shell.getByRole("heading", { name: /Sign in to/ })).toBeVisible();
    await expect(settings).toHaveCount(0);
    // One step is no walk: no rail, nothing to skip, and no way back or out.
    await expect(shell.getByTestId("onboarding-rail")).toHaveCount(0);
    await expect(shell.getByTestId("onboarding-skip")).toHaveCount(0);
    await expect(shell.getByTestId("onboarding-close")).toHaveCount(0);
    await shell.keyboard.press("Escape");
    await shell.keyboard.press("Meta+,");
    await expect(wizard).toBeVisible();
    await expect(settings).toHaveCount(0);
    // The chrome is raised above the tab views while it is up, as for the walkthrough.
    await expect(shell.getByTestId("onboarding-ready")).toHaveAttribute("data-ready", "");
    await captureShell(app, "10-sign-in.png");

    // Someone coming back signs in; a wrong password is said where it was typed and changes nothing.
    await expect(shell.getByTestId("onboarding-account-confirm")).toHaveCount(0);
    await shell.getByTestId("onboarding-account-email").fill("ada@example.test");
    await shell.getByTestId("onboarding-account-password").fill("not the password");
    await expect(primary).toHaveText("Sign in");
    await primary.click();
    await expect(shell.getByTestId("onboarding-account").getByRole("alert")).toContainText("do not match an account");
    await expect(wizard).toBeVisible();
    await shell.getByTestId("onboarding-account-password").fill("correct horse battery");
    await primary.click();

    // Joining an account that exists mints no code, so there is nothing to
    // hold the screen for: the browser is back as it was left.
    await expect(wizard).toHaveCount(0, { timeout: 15_000 });
    await expect(shell.getByTestId("sidebar-menu-button")).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

/**
 * The same rule with nothing standing in: main's own account service, a
 * keychain to seal keys with, and a control plane that does not answer. A
 * Mac that finished the walkthrough and holds no account says so before its
 * first snapshot (the launch state), opens on the sign-in screen rather than
 * the browser, and a sign-in that cannot reach control is said on the stage
 * and changes nothing.
 */
test("a Mac that finished setup and holds no account opens on the sign-in screen", { tag: ["@onboarding"] }, async () => {
  const { app } = await launchApp({
    name: "onboarding-signed-out",
    settings: { onboarding: { completed: true, completedAt: new Date().toISOString() } },
    // The account services run (PISTACHIO_E2E off), on a keychain of the
    // run's own and against an address nothing listens on.
    args: ["--use-mock-keychain"],
    env: { PISTACHIO_E2E: "0", PISTACHIO_CONTROL_URL: "http://127.0.0.1:9" },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    type Bridge = { pistachio: { launchState(): unknown; getAccount(): Promise<unknown> } };
    expect(await shell.evaluate(() => (window as unknown as Bridge).pistachio.launchState())).toEqual({
      firstRun: false,
      signedOut: true,
    });
    expect(await shell.evaluate(() => (window as unknown as Bridge).pistachio.getAccount())).toMatchObject({
      state: "unenrolled",
      required: true,
      encryptionAvailable: true,
    });

    const wizard = shell.getByTestId("onboarding");
    await expect(wizard).toBeVisible();
    await expect(wizard).toHaveAttribute("data-sign-in", "");
    await expect(wizard).toHaveAttribute("data-step", "account");
    await expect(shell.getByRole("heading", { name: /Sign in to/ })).toBeVisible();
    await expect(shell.getByTestId("onboarding-skip")).toHaveCount(0);

    await shell.getByTestId("onboarding-account-email").fill("ada@example.test");
    await shell.getByTestId("onboarding-account-password").fill("correct horse battery");
    await shell.getByTestId("onboarding-primary").click();
    await expect(shell.getByTestId("onboarding-account").getByRole("alert")).toContainText(/unreachable/i);
    await expect(wizard).toHaveAttribute("data-sign-in", "");
    await expect(shell.getByTestId("onboarding-primary")).toHaveText("Sign in");
  } finally {
    await closeApp(app);
  }
});
