/**
 * The home page (@pistachio/shell-contracts/home): the first tab of a fresh
 * window, what ⌘T opens, and what a window whose last tab closed comes back
 * to. The shell draws it in the pane — the tab's own view stays hidden — so
 * this drives it as the shell's DOM and checks main's views alongside.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import { HOME_PAGE_URL } from "@pistachio/shell-contracts/home";
import { IPC, type CalendarAgenda, type PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/home-page");

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [process.env["PISTACHIO_ELECTRON_PATH"], join(process.cwd(), "node_modules/electron", executableSuffix)];
  return candidates.find(
    (candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

/** Tab views main is showing (the chrome's own utility views excluded). */
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

async function activeTabId(shell: Page): Promise<string | null> {
  return shell.evaluate(async () => (await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot()).activeTabId);
}

function fixturePage(title: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
}

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const title = path === "/one" ? "Fixture One" : path === "/two" ? "Fixture Two" : null;
    if (title === null) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixturePage(title));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

test("a new window, a new tab and an emptied window all land on the home page, and its search drives the tab", async () => {
  test.setTimeout(120_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-home-page-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }));

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");

    // A fresh window's first tab is the home page, drawn by the shell: the
    // tab's own view stays down under it.
    const home = shell.getByTestId("home-page");
    await expect(home).toBeVisible();
    await expect.poll(async () => (await tabs(shell)).map((tab) => tab.url)).toEqual([HOME_PAGE_URL]);
    await expect.poll(async () => (await tabs(shell))[0]?.title).toBe("Home");
    await expect.poll(() => visibleTabViews(app)).toBe(0);

    // The clock is the machine's own, to the minute.
    await expect(shell.getByTestId("home-greeting")).toHaveText(/^Good (morning|afternoon|evening)/u);
    await expect
      .poll(async () => {
        const [shown, expected] = await Promise.all([
          shell.getByTestId("home-time").textContent(),
          shell.evaluate(() => new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })),
        ]);
        return shown === expected;
      })
      .toBe(true);
    await expect(shell.getByTestId("home-weather")).toBeVisible();

    // The search has the keyboard as the page shows, and ↵ takes THIS tab there.
    const input = shell.getByTestId("home-search-input");
    await expect(input).toBeFocused();
    await captureShell(app, "01-home-page.png");
    const firstId = (await tabs(shell))[0]!.id;
    await shell.keyboard.type(`${origin.replace("http://", "")}/one`);
    await expect(shell.getByTestId("home-search-results")).toBeVisible();
    await expect(shell.getByTestId("home-search-results").locator('[data-result-kind="suggestion"]').first()).toContainText("Go to");
    await shell.keyboard.press("Enter");
    await expect.poll(async () => (await tabs(shell)).map((tab) => tab.url)).toEqual([`${origin}/one`]);
    await expect(home).toHaveCount(0);
    await expect.poll(() => visibleTabViews(app)).toBe(1);

    // Back is a real history entry: the page comes home, and the view goes down again.
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.goBack(id), firstId);
    await expect(home).toBeVisible();
    await expect.poll(() => visibleTabViews(app)).toBe(0);
    // ...and what was visited is there to pick up again.
    await expect(shell.getByTestId("home-recent").first()).toContainText("Fixture One");

    // ⌘T opens a new home tab whose search takes the keyboard; typing ranks
    // the same inventory the address modal does.
    await shell.keyboard.press("Meta+T");
    await expect.poll(async () => (await tabs(shell)).length).toBe(2);
    const secondId = await activeTabId(shell);
    expect(secondId).not.toBe(firstId);
    await expect(shell.locator(`[data-testid="home-page"][data-tab-id="${secondId!}"]`)).toBeVisible();
    await expect(shell.locator(`[data-testid="home-page"][data-tab-id="${secondId!}"] [data-testid="home-search-input"]`)).toBeFocused();
    await shell.keyboard.type("Fixture");
    const results = shell.getByTestId("home-search-results");
    await expect(results.locator('[data-result-kind="history"]').first()).toContainText("Fixture One");
    await captureShell(app, "02-search-suggestions.png");
    await shell.keyboard.press("Escape");
    await shell.keyboard.press("Escape");
    await expect(results).toHaveCount(0);

    // ⌘L raises the address modal over a home tab as over any other: empty
    // (the home address is not one to edit), and Escape hands the keyboard
    // back to the page's own search.
    await shell.getByTestId("home-greeting").last().click();
    await shell.keyboard.press("Meta+L");
    await expect(shell.getByTestId("url-bar")).toBeVisible();
    await expect(shell.getByTestId("address-input")).toBeFocused();
    await expect(shell.getByTestId("address-input")).toHaveValue("");
    await shell.keyboard.type("Fixture");
    await expect(shell.getByTestId("command-results").locator('[data-result-kind="history"]').first()).toContainText("Fixture One");
    // Captured once the open animation has settled, on the theme's ground.
    await expect(shell.getByTestId("url-bar-veil")).toHaveAttribute("data-ready", "");
    await expect(shell.getByTestId("url-bar")).toHaveCSS("opacity", "1");
    await expect(shell.getByTestId("url-bar")).toHaveClass(/palette-surface/u);
    await captureShell(app, "03-address-modal-over-home.png");
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("url-bar-veil")).toHaveCount(0);
    await expect(shell.locator(`[data-testid="home-page"][data-tab-id="${secondId!}"] [data-testid="home-search-input"]`)).toBeFocused();

    // A to-do, ticked off.
    await shell.getByTestId("home-todo-add").last().click();
    await shell.keyboard.type("Ship the home page");
    await shell.keyboard.press("Enter");
    await shell.keyboard.press("Escape");
    const todo = shell.getByTestId("home-todo").filter({ hasText: "Ship the home page" }).last();
    await expect(todo).toBeVisible();
    await todo.getByRole("checkbox").click();
    await expect(todo.getByRole("checkbox")).toHaveAttribute("aria-checked", "true");

    // A favorite added by address becomes a tile; opening it from a home
    // tab that was only a launcher leaves no empty tab behind.
    await shell.getByTestId("home-app-add").last().click();
    const form = shell.getByTestId("home-app-add-form");
    await form.getByLabel("Address").fill(`${origin.replace("http://", "")}/two`);
    await form.getByLabel("Name").fill("Two");
    await form.getByRole("button", { name: "Add" }).click();
    const tile = shell.locator(`[data-testid="home-page"][data-tab-id="${secondId!}"] [data-testid="home-app"]`).filter({ hasText: "Two" });
    await expect(tile).toBeVisible();
    await captureShell(app, "04-favorite-and-todo.png");
    await tile.click();
    await expect.poll(async () => (await tabs(shell)).map((tab) => tab.url).sort()).toEqual([HOME_PAGE_URL, `${origin}/two`].sort());
    await expect.poll(async () => (await tabs(shell)).some((tab) => tab.id === secondId)).toBe(false);

    // The schedule opens the reminders' calendar.
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(id), firstId);
    await expect(home).toBeVisible();
    await shell.getByTestId("home-open-calendar").click();
    const reminders = shell.getByTestId("reminders-page");
    await expect(reminders).toBeVisible();
    await shell.keyboard.press("Escape");
    await expect(reminders).toHaveCount(0);

    // Closing every tab brings the window back to a home page.
    for (const tab of await tabs(shell)) {
      await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(id), tab.id);
    }
    await expect.poll(async () => (await tabs(shell)).map((tab) => tab.url)).toEqual([HOME_PAGE_URL]);
    await expect(home).toBeVisible();
    await captureShell(app, "05-after-closing-every-tab.png");
  } finally {
    await app.close();
  }
});

/**
 * Main's answer for the connected calendar, replaced: a profile with no
 * account has no calendar, and Google is not part of this suite. Everything
 * after the handler — the shell's read, the merge, the card — is the app's own.
 */
async function answerCalendarWith(app: ElectronApplication, agenda: CalendarAgenda): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, { channel, answer }) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => answer);
    },
    { channel: IPC.integrationCalendarEvents, answer: agenda },
  );
}

async function launchHome(prefix: string): Promise<ElectronApplication> {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }));
  return electron.launch({ args: ["."], cwd: process.cwd(), executablePath, env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData } });
}

test("the schedule shows a connected Google Calendar's day: all-day first, what is on now, a way into the call", async () => {
  test.setTimeout(120_000);
  const app = await launchHome("pistachio-home-calendar-");
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await expect(shell.getByTestId("home-schedule")).toBeVisible();

    const now = Date.now();
    const at = (minutes: number): string => new Date(now + minutes * 60_000).toISOString();
    const day = (offset: number): string => {
      const date = new Date();
      const local = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
      return `${String(local.getFullYear())}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
    };
    const event = (id: string, title: string, start: string, end: string, extra: Partial<CalendarAgenda["events"][number]> = {}) => ({
      id,
      title,
      start,
      end,
      allDay: false,
      location: "",
      meetingUrl: null,
      webUrl: `https://calendar.google.com/calendar/u/0/r/eventedit/${id}`,
      ...extra,
    });
    await answerCalendarWith(app, {
      status: "ok",
      connectable: false,
      accountLabel: "alex@example.com",
      events: [
        event("live", "Vendor sync", at(-10), at(20), { meetingUrl: "https://meet.google.com/abc-defg-hij" }),
        event("done", "Standup", at(-120), at(-90), { meetingUrl: "https://meet.google.com/old-call" }),
        event("offsite", "Team offsite", day(0), day(1), { allDay: true }),
        // The calendar's zone made yesterday's all-day event part of the answer; it is not today's.
        event("stale", "Yesterday's holiday", day(-1), day(0), { allDay: true }),
      ],
    });
    // The first read was answered before the handler was replaced, by a Mac with no account; a new home page asks again.
    await shell.waitForTimeout(16_000);
    await shell.keyboard.press("Meta+t");
    const schedule = shell.getByTestId("home-schedule").last();
    const rows = schedule.getByTestId("home-agenda-item");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("All day");
    await expect(rows.nth(0)).toContainText("Team offsite");
    await expect(rows.nth(1)).toContainText("Standup");
    await expect(rows.nth(1)).toHaveClass(/opacity-55/u);
    await expect(rows.nth(2)).toContainText("Now");
    await expect(rows.nth(2)).toContainText("Vendor sync");
    await expect(rows.nth(2)).toHaveAttribute("data-kind", "event");
    // A call that is over is not offered; the one under way is.
    await expect(schedule.getByTestId("home-agenda-join")).toHaveCount(1);
    await expect(schedule).not.toContainText("Yesterday");
    // Someone with a calendar is not invited to connect one.
    await expect(schedule.getByTestId("home-calendar-connect")).toHaveCount(0);
    await captureShell(app, "06-schedule-with-google-calendar.png");

    await schedule.getByRole("button", { name: "Join Vendor sync" }).click();
    await expect.poll(async () => (await tabs(shell)).some((tab) => tab.url.startsWith("https://meet.google.com/") || tab.url.includes("google.com"))).toBe(true);
  } finally {
    await app.close();
  }
});

test("a calendar whose grant died says so on the schedule and leads to Integrations", async () => {
  test.setTimeout(120_000);
  const app = await launchHome("pistachio-home-calendar-dead-");
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await expect(shell.getByTestId("home-schedule")).toBeVisible();
    await answerCalendarWith(app, { status: "reconnect_required", connectable: false, accountLabel: "alex@example.com", events: [] });
    await shell.waitForTimeout(16_000);
    await shell.keyboard.press("Meta+t");
    const schedule = shell.getByTestId("home-schedule").last();
    await expect(schedule).toContainText("Google Calendar needs reconnecting");
    await schedule.getByTestId("home-calendar-reconnect").click();
    await expect(shell.getByTestId("settings-page")).toBeVisible();
    await expect(shell.getByTestId("settings-page")).toContainText("Google Calendar");
  } finally {
    await app.close();
  }
});

test("someone with no calendar is invited to connect one from the schedule, once — and can say no for good", async () => {
  test.setTimeout(120_000);
  const app = await launchHome("pistachio-home-calendar-invite-");
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const first = shell.getByTestId("home-schedule");
    await expect(first).toBeVisible();
    // A Mac with no account cannot connect anything: main says so, and the card does not ask.
    await expect(first.getByTestId("home-calendar-connect")).toHaveCount(0);

    await answerCalendarWith(app, { status: "not_connected", connectable: true, accountLabel: null, events: [] });
    await shell.waitForTimeout(16_000);
    await shell.keyboard.press("Meta+t");
    const schedule = shell.getByTestId("home-schedule").last();
    const invitation = schedule.getByTestId("home-calendar-connect");
    await expect(invitation).toBeVisible();
    await expect(invitation).toContainText("See today’s Google Calendar events here");
    await expect(schedule.getByTestId("home-open-calendar")).toBeVisible();
    // capturePage hands back the last frame composited, which can trail the DOM by a beat.
    await shell.waitForTimeout(400);
    await captureShell(app, "07-schedule-invites-to-connect.png");

    // The way in is Settings → Integrations, where the connection is made.
    await invitation.getByTestId("home-calendar-connect-action").click();
    await expect(shell.getByTestId("settings-page")).toBeVisible();
    await expect(shell.getByTestId("settings-page")).toContainText("Google Calendar");
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("settings-page")).toHaveCount(0);

    // “No” is remembered: gone from every home page showing, and from the next one.
    await invitation.getByTestId("home-calendar-connect-dismiss").click();
    await expect(shell.getByTestId("home-calendar-connect")).toHaveCount(0);
    await shell.keyboard.press("Meta+t");
    await expect(shell.getByTestId("home-schedule").last()).toBeVisible();
    await expect(shell.getByTestId("home-calendar-connect")).toHaveCount(0);
    expect(await shell.evaluate(() => localStorage.getItem("pistachio.home.calendar-prompt-dismissed"))).toBe("1");
  } finally {
    await app.close();
  }
});
