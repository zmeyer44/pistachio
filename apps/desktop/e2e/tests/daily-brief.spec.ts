/**
 * The daily brief (docs/reports.md): `pistachio://brief/`, a report the shell
 * draws in the pane from a json-render spec over the report catalog. The day
 * is scripted (`PISTACHIO_BRIEF_SCRIPT`), so this needs no account: what it
 * proves is the path from materials to a drawn page — the built-in layout
 * (the models stay off under e2e), the catalog components, the clock-driven
 * schedule states, ticks that persist and reach the home page's to-dos, and
 * a native view that stays hidden behind the shell's page.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { BRIEF_PAGE_URL } from "@pistachio/shell-contracts/reports";
import { noticePage, shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/daily-brief");

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [process.env["PISTACHIO_ELECTRON_PATH"], join(process.cwd(), "node_modules/electron", executableSuffix)];
  return candidates.find(
    (candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function captureShell(app: ElectronApplication, shell: Page, filename: string): Promise<void> {
  // capturePage can trail the DOM by a frame or two; let the page settle first.
  await shell.waitForTimeout(400);
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

function visibleTabViews(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return window.contentView.children.filter((child) => {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return false;
      const url = (child as WebContentsView).webContents.getURL();
      return !Object.values(hashes).some((hash) => url.endsWith(hash));
    }).length;
  }, CHROME_VIEW_HASHES);
}

async function tabs(shell: Page): Promise<Array<{ id: string; url: string; title: string }>> {
  return shell.evaluate(async () => {
    const snapshot = await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot();
    return snapshot.tabs.filter((tab) => tab.kind === "human").map(({ id, url, title }) => ({ id, url, title }));
  });
}

/** A day built around the moment the spec runs: one meeting under way, one coming up, one tonight. */
function scriptedDay(): string {
  const now = Date.now();
  const at = (minutes: number): string => new Date(now + minutes * 60_000).toISOString();
  const day = new Date(now);
  const allDay = `${String(day.getFullYear())}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  return JSON.stringify({
    events: [
      { id: "e0", title: "Company offsite", start: allDay, end: allDay, allDay: true, location: "", meetingUrl: null, webUrl: "https://calendar.google.com/e0" },
      { id: "e1", title: "Design review", start: at(-10), end: at(20), allDay: false, location: "Room 4", meetingUrl: "https://meet.google.com/abc-defg-hij", webUrl: "https://calendar.google.com/e1" },
      { id: "e2", title: "1:1 with Dana", start: at(45), end: at(75), allDay: false, location: "", meetingUrl: null, webUrl: "https://calendar.google.com/e2" },
      { id: "e3", title: "Investor dinner", start: at(240), end: at(360), allDay: false, location: "Lilia, Brooklyn", meetingUrl: null, webUrl: "https://calendar.google.com/e3" },
    ],
    messages: [
      { id: "m1", threadId: "t1", from: "Dana Whitfield <dana@example.com>", subject: "Q4 budget — need your call", snippet: "Can you confirm the headcount number before Wednesday? Finance is waiting on it and I would rather not guess.", date: at(-50), unread: true, labels: ["INBOX", "UNREAD", "IMPORTANT", "CATEGORY_PERSONAL"], webUrl: "https://mail.google.com/mail/u/0/#all/m1" },
      { id: "m2", threadId: "t2", from: "Priya Natarajan <priya@example.com>", subject: "Intro to the Lisbon team?", snippet: "Happy to connect you with Tomás before your trip — want me to set something up for next week?", date: at(-130), unread: true, labels: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"], webUrl: "https://mail.google.com/mail/u/0/#all/m2" },
      { id: "m3", threadId: "t3", from: "GitHub <notifications@github.com>", subject: "[pistachio] PR #16 merged", snippet: "Merged #16 into main.", date: at(-200), unread: true, labels: ["INBOX", "UNREAD", "CATEGORY_UPDATES"], webUrl: "https://mail.google.com/mail/u/0/#all/m3" },
      { id: "m4", threadId: "t4", from: "Shoes Weekly <news@shoes.example>", subject: "40% off everything", snippet: "This week only.", date: at(-220), unread: true, labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"], webUrl: "https://mail.google.com/mail/u/0/#all/m4" },
    ],
    reminders: [{ id: "r1", title: "Send the deck to Priya", at: at(150), state: "upcoming" }],
    pages: [
      { url: "https://www.inkandswitch.com/local-first/", title: "Local-first software: you own your data, in spite of the cloud", host: "inkandswitch.com", visitedAt: now - 3_600_000 * 14, snippet: "Cloud apps are convenient, but the data lives on someone else's computer.", kind: "article" },
      { url: "https://json-render.dev/docs", title: "json-render documentation", host: "json-render.dev", visitedAt: now - 3_600_000 * 16, snippet: "Catalogs, specs and registries.", kind: "article" },
    ],
    threads: [{ id: "th1", title: "Compare flight prices to Lisbon", updatedAt: at(-600), status: "Finished" }],
    sources: [
      { source: "calendar", state: "ok", connectable: false, accountLabel: "zach@example.com", count: 4 },
      { source: "gmail", state: "ok", connectable: false, accountLabel: "zach@example.com", count: 4 },
    ],
  });
}

async function launchBrief(prefix: string, general: Record<string, unknown> = {}): Promise<{ app: ElectronApplication; userData: string }> {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" }, general }));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData, PISTACHIO_BRIEF_SCRIPT: scriptedDay() },
  });
  return { app, userData };
}

test("the daily brief: from the home page, a composed report of the day with ticks that stick", async () => {
  test.setTimeout(150_000);
  const { app, userData } = await launchBrief("pistachio-brief-");
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");

    // A to-do written on the home page is part of the day the brief reads.
    await expect(shell.getByTestId("home-page")).toBeVisible();
    await shell.getByTestId("home-todo-add").last().click();
    await shell.keyboard.type("Book flights to Lisbon");
    await shell.keyboard.press("Enter");
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("home-todo").filter({ hasText: "Book flights to Lisbon" }).last()).toBeVisible();

    // The way in: one line under the greeting.
    const teaser = shell.getByTestId("home-brief");
    await expect(teaser).toContainText("Daily Brief");
    await captureShell(app, shell, "01-home-teaser.png");
    await teaser.click();

    // The brief opens as its own tab and makes itself.
    const page = shell.getByTestId("brief-page").last();
    await expect(page).toBeVisible();
    await expect(page.getByTestId("report-title")).toContainText("Brief", { timeout: 30_000 });
    expect((await tabs(shell)).some((tab) => tab.url === BRIEF_PAGE_URL)).toBe(true);
    // The shell draws it; the tab's own view stays out of sight.
    await expect.poll(() => visibleTabViews(app)).toBe(0);

    // Masthead: the title names the day, the summary is the template's (the models are off here).
    await expect(page.getByTestId("report-title")).toHaveText(/^The \w+day Brief$/u);
    await expect(page.getByTestId("report-summary")).toContainText("In a meeting now · 2 meetings ahead");
    await expect(page.getByTestId("report-summary")).toContainText("waiting on you");

    // The schedule knows the time: one meeting under way, exactly one next.
    await expect(page.getByTestId("report-timeline")).toBeVisible();
    await expect(page.locator('[data-testid="report-event"][data-moment="live"]')).toContainText("Design review");
    await expect(page.locator('[data-testid="report-event"][data-moment="next"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="report-event"][data-moment="next"]')).toContainText("1:1 with Dana");
    // The focus card is the meeting inside the hour.
    await expect(page.getByTestId("report-focus")).toContainText("1:1 with Dana");

    // Mail: what needs a reply is quoted, automated mail is an update, a promotion is nowhere.
    await expect(page.getByTestId("report-messages")).toContainText("Finance is waiting on it");
    await expect(page.getByTestId("report-messages")).toContainText("Priya Natarajan");
    await expect(page.getByTestId("report-list").filter({ hasText: "New updates" })).toContainText("PR #16 merged");
    await expect(page).not.toContainText("40% off");
    await expect(page.getByTestId("report-links")).toContainText("Local-first software");
    // A list the layout put in the narrow column draws as a quiet panel there.
    await expect(page.getByTestId("report-aside").getByTestId("report-list")).toContainText("Compare flight prices");
    await expect(page.getByTestId("brief-footer")).toContainText("Built-in layout");
    await captureShell(app, shell, "02-brief-top.png");

    // Pressing an item opens its preview beside the page rather than a tab: its own details, its own actions,
    // and the arrows step through the page in reading order. Escape puts the page back.
    const tabsBefore = (await tabs(shell)).length;
    await page.locator('[data-testid="report-event"][data-moment="next"]').getByRole("button", { name: /1:1 with Dana/u }).click();
    const preview = page.getByTestId("report-preview");
    await expect(preview.getByTestId("report-preview-title")).toContainText("1:1 with Dana");
    await expect(preview.getByTestId("report-preview-actions")).toContainText("Up next");
    await expect(preview.getByTestId("report-preview-ask")).toHaveText(/Prep me/u);
    expect((await tabs(shell)).length).toBe(tabsBefore);
    await captureShell(app, shell, "02b-brief-preview.png");
    await preview.getByTestId("report-preview-next").click();
    await expect(preview.getByTestId("report-preview-title")).not.toContainText("1:1 with Dana");
    await shell.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);

    // Ticking the to-do here finishes it on the home page too, and the tick is filed with the brief.
    const todo = page.getByTestId("report-todo").filter({ hasText: "Book flights to Lisbon" });
    await todo.getByRole("checkbox").click();
    await expect(todo.getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
    // The home page is the truth about to-dos in BOTH directions: reopened there, it is unticked here,
    // whatever this brief filed a moment ago.
    await shell.keyboard.press("Meta+t");
    const between = shell.getByTestId("home-page").last();
    const homeTodo = between.getByTestId("home-todo").filter({ hasText: "Book flights to Lisbon" });
    await expect(homeTodo.getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
    await homeTodo.getByRole("checkbox").click();
    await expect(homeTodo.getByRole("checkbox")).toHaveAttribute("aria-checked", "false");
    await between.getByTestId("home-brief").click();
    await expect(todo.getByRole("checkbox")).toHaveAttribute("aria-checked", "false");
    // The correction is filed with the brief, not just drawn: a refresh keeps ticks, and must not bring this one back.
    const briefFile = (await readdir(join(userData, "briefs"))).find((name) => name.includes("__")) ?? "";
    const todoTicks = async (): Promise<number> => {
      const stored = JSON.parse(await readFile(join(userData, "briefs", briefFile), "utf8")) as { spec: { state: { ticks?: Record<string, boolean> } } };
      return Object.keys(stored.spec.state.ticks ?? {}).filter((key) => key.startsWith("todo:")).length;
    };
    await expect.poll(todoTicks).toBe(0);
    await page.getByTestId("brief-refresh").click();
    await expect(page.getByTestId("brief-refresh")).toBeEnabled({ timeout: 30_000 });
    await expect(todo.getByRole("checkbox")).toHaveAttribute("aria-checked", "false");
    await captureShell(app, shell, "09-todo-reopened.png");
    // Finished for good this time.
    await todo.getByRole("checkbox").click();
    await expect(todo.getByRole("checkbox")).toHaveAttribute("aria-checked", "true");

    const message = page.getByTestId("report-message").filter({ hasText: "Q4 budget" });
    await message.getByRole("checkbox").click();
    await expect(message).toContainText("Handled");

    await page.evaluate((element) => element.scrollTo({ top: element.scrollHeight }), await page.elementHandle());
    await captureShell(app, shell, "03-brief-bottom.png");

    const files = (await readdir(join(userData, "briefs"))).filter((name) => name.includes("__"));
    expect(files).toHaveLength(1);

    // Refreshing makes the brief again; the ticks are keyed by source, so they survive.
    await page.evaluate((element) => element.scrollTo({ top: 0 }), await page.elementHandle());
    await page.getByTestId("brief-refresh").click();
    await expect(page.getByTestId("brief-refresh")).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId("report-message").filter({ hasText: "Q4 budget" })).toContainText("Handled");

    // Back on a home page the to-do is done.
    await shell.keyboard.press("Meta+t");
    const home = shell.getByTestId("home-page").last();
    await expect(home.getByTestId("home-todo").filter({ hasText: "Book flights to Lisbon" }).getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
    // …and its teaser now carries the brief's own headline.
    await expect(home.getByTestId("home-brief")).toContainText("waiting on you");
    await captureShell(app, shell, "04-home-after.png");

  } finally {
    await app.close();
  }
});

test("the daily brief in a narrow pane and in the dark", async () => {
  test.setTimeout(150_000);
  const { app } = await launchBrief("pistachio-brief-dark-");
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await shell.evaluate(async () => {
      await (window as unknown as { pistachio: PistachioApi }).pistachio.updateSettings({ appearance: { scheme: "dark" } });
    });
    await shell.getByTestId("home-brief").click();
    const page = shell.getByTestId("brief-page").last();
    await expect(page.getByTestId("report-title")).toContainText("Brief", { timeout: 30_000 });
    await captureShell(app, shell, "05-brief-dark.png");

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(760, 900));
    await expect(page.getByTestId("report-aside")).toBeVisible();
    await captureShell(app, shell, "06-brief-narrow.png");
  } finally {
    await app.close();
  }
});

test("the scheduled brief: past its hour at launch, it makes itself and says so", async () => {
  test.setTimeout(150_000);
  // Midnight has always passed: this is the Mac that was closed at the hour and opened later.
  const { app, userData } = await launchBrief("pistachio-brief-clock-", { morningBrief: true, morningBriefTime: "00:00" });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await expect(shell.getByTestId("home-page")).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());

    // Nobody opens anything. The clock asks the shell, the shell makes the brief, main files it.
    await expect
      .poll(async () => (await readdir(join(userData, "briefs")).catch(() => [])).filter((name) => name.includes("__")).length, { timeout: 40_000 })
      .toBe(1);
    // The home page already carries its headline…
    await expect(shell.getByTestId("home-brief")).toContainText("waiting on you", { timeout: 15_000 });
    // …and the window says it is ready, with a way in. (Under e2e the system notification is never posted.)
    const notices = await noticePage(app);
    const card = notices.locator('[data-testid="notice-card"][data-depth="0"]');
    await expect(card).toContainText(/The \w+day Brief is ready/u);
    await notices.screenshot({ path: join(screenshotDirectory, "07-scheduled-notice.png") });
    await card.getByRole("button", { name: "Read" }).click();
    await expect(shell.getByTestId("brief-page").last().getByTestId("report-title")).toBeVisible();
    // One attempt a day is on file, so a relaunch does not make a second brief.
    expect(await readdir(join(userData, "briefs"))).toContain("schedule.json");
    await captureShell(app, shell, "08-scheduled-brief.png");
  } finally {
    await app.close();
  }
});
