import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from "@playwright/test";
import { shellPage, shellReady } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/onboarding");

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(
      process.cwd(),
      "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron",
      suffix,
    ),
  ];
  return candidates.find(
    (c) =>
      c !== undefined &&
      existsSync(c) &&
      existsSync(resolve(dirname(c), "../Info.plist")),
  );
}

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

async function captureShell(
  app: ElectronApplication,
  filename: string,
): Promise<void> {
  await new Promise((done) => setTimeout(done, 450));
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w === undefined) throw new Error("no window");
    return (await w.capturePage()).toPNG().toString("base64");
  });
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(
    join(screenshotDirectory, filename),
    Buffer.from(png, "base64"),
  );
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
 * in the grid, memory seeded, and the welcome tabs open. The about
 * step's "Or sign in" is absent here: the account services do not start
 * under PISTACHIO_E2E, so there is no keychain to offer sign-in with.
 */
test("first run walks the wizard and furnishes the first Space", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No Electron runtime");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-onboarding-"));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    // PISTACHIO_ONBOARDING keeps the wizard that every other spec's launch turns off.
    env: {
      ...process.env,
      PISTACHIO_E2E: "1",
      PISTACHIO_ONBOARDING: "1",
      PISTACHIO_USER_DATA: userData,
    },
  });
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

    // Signed in, the mic is offered first; without an account (always, under
    // E2E) the stage says so. Either way the fields are a click away at most.
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
      "Space: Ada",
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
      await new Promise((done) => setTimeout(done, 300));
      const image = await contents.capturePage();
      return {
        png: image.toPNG().toString("base64"),
        title: contents.getTitle(),
        text: await contents.executeJavaScript("document.body.innerText"),
      };
    });
    expect(welcome.title).toBe("Welcome to Pistachio");
    expect(welcome.text).toContain("Let's settle in, Ada.");
    await writeFile(
      join(screenshotDirectory, "06-welcome-page.png"),
      Buffer.from(welcome.png, "base64"),
    );

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
  } finally {
    await closeApp(app);
  }
});

test("a completed install opens on the browser, and Settings → About replays the wizard", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No Electron runtime");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-onboarding-done-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ onboarding: { completed: true, completedAt: null } }),
  );
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: {
      ...process.env,
      PISTACHIO_E2E: "1",
      PISTACHIO_ONBOARDING: "1",
      PISTACHIO_USER_DATA: userData,
    },
  });
  try {
    const shell = await shellReady(app);
    await expect(shell.getByTestId("sidebar-pane")).toBeVisible();
    await expect(shell.getByTestId("onboarding")).toHaveCount(0);

    await shell.keyboard.press("Meta+,");
    await shell
      .getByTestId("settings-page")
      .getByRole("button", { name: "About", exact: true })
      .click();
    await shell.getByTestId("replay-onboarding").click();
    const wizard = shell.getByTestId("onboarding");
    await expect(wizard).toBeVisible();
    // A replay can be left with Esc; nothing is written.
    await shell.keyboard.press("Escape");
    await expect(wizard).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});
