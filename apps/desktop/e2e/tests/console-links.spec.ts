import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/console-links");
const OWNER_URL = "pistachio://demo/invoices";
const PREVIEW_URL = "pistachio://demo/vendors/atlas-medical";
const REMINDER_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OCCURRENCE_ID = "16fd2706-8baf-433b-82eb-8c7fada847da";
const RUN_ID = "3b241101-e2bb-4255-8caf-4136c566a962";

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", executableSuffix),
    resolve(
      process.cwd(),
      "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron",
      executableSuffix,
    ),
  ];
  return candidates.find(
    (candidate) =>
      candidate !== undefined &&
      existsSync(candidate) &&
      existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function pageAt(app: ElectronApplication, url: string): Promise<Page> {
  await expect.poll(() => app.windows().some((page) => page.url() === url)).toBe(true);
  const page = app.windows().find((candidate) => candidate.url() === url);
  if (page === undefined) throw new Error(`No Electron page at ${url}`);
  return page;
}

function visibleTabViews(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return window.contentView.children.flatMap((child) => {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return [];
      const url = (child as WebContentsView).webContents.getURL();
      return Object.values(hashes).some((hash) => url.endsWith(hash)) ? [] : [url];
    });
  }, CHROME_VIEW_HASHES);
}

function tabUrls(shell: Page): Promise<string[]> {
  return shell.evaluate(async () => {
    const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
    return (await api.getSnapshot()).tabs.map(({ url }) => url);
  });
}

/** A finished agent reminder whose report names a page, waiting in the console's inbox. */
function remindersDocument(): string {
  const at = "2026-08-27T13:11:47.556Z";
  return JSON.stringify({
    version: 1,
    reminders: [
      {
        id: REMINDER_ID,
        title: "Vendor review",
        schedule: { kind: "daily", time: "09:10" },
        action: { kind: "agent", prompt: "Find the vendor record that needs review and send me the link." },
        timezone: "America/New_York",
        status: "active",
        source: { kind: "agent", runId: RUN_ID },
        createdAt: at,
        updatedAt: at,
        nextFireAt: "2099-01-01T14:10:00.000Z",
        lastFiredAt: at,
        until: null,
        maxFires: null,
        fireCount: 1,
      },
    ],
    occurrences: [
      {
        id: OCCURRENCE_ID,
        reminderId: REMINDER_ID,
        title: "Vendor review",
        actionKind: "agent",
        scheduledFor: at,
        startedAt: at,
        finishedAt: "2026-08-27T13:12:08.435Z",
        status: "completed",
        output: `One vendor record needs a look:\n${PREVIEW_URL}\nThe contact email bounced twice this week.`,
        error: null,
        runId: RUN_ID,
        acknowledgedAt: null,
      },
    ],
  });
}

test("a link in a console message previews as a Glance; ⌘-click opens a tab instead", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-console-links-"));
  await writeFile(
    join(userData, "settings.json"),
    // The owner page is the window's only tab, so it is the home page: launch
    // opens on `general.homeUrl` and nothing else.
    JSON.stringify({
      layout: { mode: "top", sidebar: "pinned" },
      general: { consoleOpenOnLaunch: true, homeUrl: OWNER_URL },
    }),
  );
  await writeFile(join(userData, "reminders.json"), remindersDocument());

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await pageAt(app, OWNER_URL);
    await shell.waitForLoadState("domcontentloaded");

    // The URL in the report is a real link; the prose around it is not.
    const link = shell.getByRole("link", { name: PREVIEW_URL });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", PREVIEW_URL);
    await mkdir(screenshotDirectory, { recursive: true });
    await shell.screenshot({ path: join(screenshotDirectory, "01-link-in-console.png") });

    // A plain click previews the page above the live tab and creates no tab.
    await link.click();
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    await expect.poll(() => visibleTabViews(app)).toEqual([PREVIEW_URL]);
    const preview = await pageAt(app, PREVIEW_URL);
    expect(await tabUrls(shell)).toEqual([OWNER_URL]);
    await shell.screenshot({ path: join(screenshotDirectory, "02-link-previewed.png") });

    // Escape in the preview runs the usual close motion back to the owner.
    await preview.keyboard.press("Escape");
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await expect.poll(() => visibleTabViews(app)).toEqual([OWNER_URL]);

    // A second click while a preview is open replaces it rather than being ignored.
    await link.click();
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    await link.click();
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    await expect.poll(() => visibleTabViews(app)).toEqual([PREVIEW_URL]);
    expect(await tabUrls(shell)).toEqual([OWNER_URL]);
    await shell.getByTestId("glance-close").click();
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);

    // On the full-window reminders page a preview would open behind the page,
    // so the same link opens a tab and the page steps aside to show it. This
    // goes before the console's own ⌘-click: opening a link in a tab closes
    // any full-window page once the tab has LANDED (store.ts openLink), well
    // after the snapshot that first shows the tab — so a page opened between
    // those two moments would be swept away by the earlier click.
    await shell.getByRole("button", { name: "Details" }).click();
    const page = shell.getByTestId("reminders-page");
    await expect(page).toBeVisible();
    await page.getByRole("link", { name: PREVIEW_URL }).click();
    await expect.poll(() => tabUrls(shell)).toEqual([OWNER_URL, PREVIEW_URL]);
    await expect(page).toHaveCount(0);
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);

    // ⌘-click asks for a real tab, as anywhere else in a browser.
    await link.click({ modifiers: ["Meta"] });
    await expect.poll(() => tabUrls(shell)).toEqual([OWNER_URL, PREVIEW_URL, PREVIEW_URL]);
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
