/**
 * The home page (@pistachio/shell-contracts/home): the first tab of a fresh
 * window, what ⌘T opens, and what a window whose last tab closed comes back
 * to. The shell draws it in the pane — the tab's own view stays hidden — so
 * this drives it as the shell's DOM and checks main's views alongside.
 *
 * The address field's preview of the active row (shell-ui's
 * lib/use-field-preview.ts) is driven here too, in the home page's search
 * and the address modal alike, and the schedule's connected calendar last.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { HOME_PAGE_URL } from "@pistachio/shell-contracts/home";
import { IPC, type CalendarAgenda, type PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellReady } from "./windows";
import { launchApp } from "./app";
import { captureShell as captureWindow, humanTabs as tabs, visibleTabViews } from "./pages-harness";

/** The frame that shows a just-made change has to be painted before it can be captured. */
function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  return captureWindow(app, `home-page/${filename}`, 200);
}

async function activeTabId(shell: Page): Promise<string | null> {
  return shell.evaluate(async () => (await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot()).activeTabId);
}

/** ↑/↓ until `row` is the active one — chips and groups make the count the list's business. */
async function arrowTo(shell: Page, list: Locator, row: Locator): Promise<void> {
  const active = list.locator("[data-index].bg-alpha-200, [data-index].bg-alpha-300");
  for (let presses = 0; presses < 24; presses++) {
    const target = Number(await row.getAttribute("data-index"));
    const at = (await active.count()) === 0 ? -1 : Number(await active.first().getAttribute("data-index"));
    if (at === target) return;
    await shell.keyboard.press(at < target ? "ArrowDown" : "ArrowUp");
  }
  await expect(row).toHaveClass(/bg-alpha-200/);
}

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

/** ⌘T: a new home tab, in front — the home page of the tab now active. */
async function newHomeTab(shell: Page): Promise<Locator> {
  const before = await activeTabId(shell);
  await shell.keyboard.press("Meta+t");
  await expect.poll(() => activeTabId(shell)).not.toBe(before);
  const home = shell.locator(`[data-testid="home-page"][data-tab-id="${(await activeTabId(shell))!}"]`);
  await expect(home).toBeVisible();
  return home;
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

// One window, in order: the home page from launch to an emptied window, the
// field preview over what that left, then the schedule's calendar — whose
// answers are main's replaced handler and whose clock is moved on, so they
// come last.
test.describe.serial("the home page", { tag: ["@address", "@home", "@settings"] }, () => {
  test.describe.configure({ timeout: 90_000 });
  let app: ElectronApplication;
  let shell: Page;

  test.beforeAll(async () => {
    // No model: the order the preview walks is the heuristics' own.
    ({ app } = await launchApp({ settings: { layout: { sidebar: "pinned" } }, env: { PISTACHIO_INTENT_MODEL: "off" }, name: "home-page" }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("a new window and a new tab land on the home page, an emptied one on an empty space, and its search drives the tab", { tag: ["@smoke"] }, async () => {
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

    // ⌘T opens a new home tab — out on the desk as the window in use — whose
    // search takes the keyboard; typing ranks the same inventory the address
    // modal does.
    await shell.keyboard.press("Meta+T");
    await expect.poll(async () => (await tabs(shell)).length).toBe(2);
    await expect.poll(() => activeTabId(shell)).not.toBe(firstId);
    const secondId = await activeTabId(shell);
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
    // The open animation settles, on the theme's ground.
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

    // The schedule opens the reminders' calendar. A Mac with no account
    // cannot connect a calendar: main says so, and the card does not ask.
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(id), firstId);
    await expect(home).toBeVisible();
    await expect(shell.getByTestId("home-schedule")).toBeVisible();
    await expect(shell.getByTestId("home-calendar-connect")).toHaveCount(0);
    await shell.getByTestId("home-open-calendar").click();
    const reminders = shell.getByTestId("reminders-page");
    await expect(reminders).toBeVisible();
    await shell.keyboard.press("Escape");
    await expect(reminders).toHaveCount(0);

    // Closing every tab leaves an empty space on the desk, not a home page:
    // main makes no tab of its own (docs/spaces.md §1). The desk says whose
    // it is and what can be done — its New tab is the home page again.
    for (const tab of await tabs(shell)) {
      await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(id), tab.id);
    }
    await expect.poll(async () => (await tabs(shell)).length).toBe(0);
    await expect.poll(() => activeTabId(shell)).toBeNull();
    await expect(shell.getByTestId("desk-empty")).toBeVisible();
    await expect(shell.getByTestId("home-page")).toHaveCount(0);
    await captureShell(app, "05-after-closing-every-tab.png");
    await shell.getByTestId("desk-empty-new-tab").click();
    await expect.poll(async () => (await tabs(shell)).map((tab) => tab.url)).toEqual([HOME_PAGE_URL]);
    await expect(home).toBeVisible();
  });

  test("the address field shows the active row's text, from the arrows and from the pointer", async () => {
    await expect(shell.getByTestId("home-page")).toBeVisible();
    const homeId = (await tabs(shell))[0]!.id;
    const fixtureUrl = `${origin}/one`;

    // A second tab to find, then back to the home tab.
    await shell.evaluate((url) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url), fixtureUrl);
    await expect.poll(async () => (await tabs(shell)).find((tab) => tab.url === fixtureUrl)?.title).toBe("Fixture One");
    const fixtureId = (await tabs(shell)).find((tab) => tab.url === fixtureUrl)!.id;
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(id), homeId);

    // ── The home page's search ──────────────────────────────────────────────
    const homeInput = shell.getByTestId("home-search-input");
    await homeInput.click();
    await shell.keyboard.type("Fixture");
    const homeResults = shell.getByTestId("home-search-results");
    const homeTabRow = homeResults.locator(`[data-tab-id="${fixtureId}"]`);
    await expect(homeTabRow).toBeVisible();
    // The list's own default selection is not a preview.
    await expect(homeInput).toHaveValue("Fixture");

    // ↓ down the list and ↑ back: the field follows the active row. The rows
    // that ARE the typed text (the web search, the AI prompt) leave it alone.
    await shell.keyboard.press("ArrowDown");
    await arrowTo(shell, homeResults, homeTabRow);
    await expect(homeInput).toHaveValue(fixtureUrl);
    await captureShell(app, "address-preview/01-home-arrow-preview.png");
    await arrowTo(shell, homeResults, homeResults.locator('[data-suggestion-kind="search"]'));
    await expect(homeInput).toHaveValue("Fixture");

    // A row reached by the arrows is text to edit: what is typed next lands on it.
    await arrowTo(shell, homeResults, homeTabRow);
    await shell.keyboard.type("?x");
    await expect(homeInput).toHaveValue(`${fixtureUrl}?x`);
    await expect(homeResults.locator('[data-suggestion-kind="navigate"]')).toBeVisible();

    // The pointer shows the row under it, and puts the typed text back when it
    // leaves the list without a key having landed…
    await homeInput.fill("Fixture");
    await expect(homeTabRow).toBeVisible();
    await homeTabRow.hover();
    await expect(homeInput).toHaveValue(fixtureUrl);
    await captureShell(app, "address-preview/02-home-hover-preview.png");
    await homeInput.hover();
    await expect(homeInput).toHaveValue("Fixture");
    // …but a key over a hovered row edits the row's text, which stays when the pointer leaves.
    await homeTabRow.hover();
    await expect(homeInput).toHaveValue(fixtureUrl);
    await shell.keyboard.press("Backspace");
    await expect(homeInput).toHaveValue(fixtureUrl.slice(0, -1));
    await shell.keyboard.type("x");
    await expect(homeInput).toHaveValue(`${fixtureUrl.slice(0, -1)}x`);
    await homeInput.hover();
    await expect(homeInput).toHaveValue(`${fixtureUrl.slice(0, -1)}x`);
    // A key that only moves the caret takes the row's text as well.
    await homeInput.fill("Fixture");
    await expect(homeTabRow).toBeVisible();
    await homeTabRow.hover();
    await expect(homeInput).toHaveValue(fixtureUrl);
    await shell.keyboard.press("ArrowLeft");
    await homeInput.hover();
    await expect(homeInput).toHaveValue(fixtureUrl);
    await shell.keyboard.press("Escape");
    await expect(homeInput).toHaveValue("");
    await shell.keyboard.press("Escape");

    // ── The address modal ───────────────────────────────────────────────────
    // Over the home tab the field opens empty; ↓ into the open tabs shows the
    // tab's address, and ↑ back out of the list shows the empty field again.
    await shell.keyboard.press("Meta+L");
    const address = shell.getByTestId("address-input");
    await expect(address).toBeFocused();
    await expect(address).toHaveValue("");
    const modal = shell.getByTestId("url-bar");
    // The dialog fades in; a capture before it lands shows no dialog at all.
    await expect(modal).toHaveCSS("opacity", "1");
    const modalTabRow = modal.locator(`[data-testid="open-tab-result"][data-tab-id="${fixtureId}"]`);
    await expect(modalTabRow).toBeVisible();
    await arrowTo(shell, modal, modalTabRow);
    await expect(address).toHaveValue(fixtureUrl);
    await captureShell(app, "address-preview/03-modal-arrow-preview.png");
    for (let presses = 0; presses < 24 && (await address.inputValue()) !== ""; presses++) await shell.keyboard.press("ArrowUp");
    await expect(address).toHaveValue("");
    await shell.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);

    // Over a page the field opens holding its address, selected. Hovering a
    // row shows its address instead, and typing continues that address.
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(id), fixtureId);
    await shell.keyboard.press("Meta+L");
    await expect(address).toBeFocused();
    await expect(address).toHaveValue(fixtureUrl);
    await expect(modal).toHaveCSS("opacity", "1");
    const homeTabInModal = modal.locator(`[data-testid="open-tab-result"][data-tab-id="${homeId}"]`);
    await expect(homeTabInModal).toBeVisible();
    await homeTabInModal.hover();
    await expect(address).not.toHaveValue(fixtureUrl);
    const homeTabText = await address.inputValue();
    await captureShell(app, "address-preview/04-modal-hover-preview.png");
    await shell.keyboard.type("abc");
    await expect(address).toHaveValue(`${homeTabText}abc`);

    // The typed face looks, lets go, and hands over its text the same way.
    const typedHomeRow = modal.getByTestId("command-results").locator(`[data-tab-id="${homeId}"]`);
    await address.fill("Home");
    await expect(typedHomeRow).toBeVisible();
    await typedHomeRow.hover();
    await expect(address).toHaveValue(homeTabText);
    await address.hover();
    await expect(address).toHaveValue("Home");
    await typedHomeRow.hover();
    await expect(address).toHaveValue(homeTabText);
    await shell.keyboard.press("Backspace");
    await expect(address).toHaveValue(homeTabText.slice(0, -1));
    await address.hover();
    await expect(address).toHaveValue(homeTabText.slice(0, -1));
    await shell.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
  });

  /**
   * The schedule's calendar is read when a home page appears, and an answer
   * stands a while (shell-ui home/use-calendar-agenda.ts: 15 s with no
   * events in it, 5 min with). Rather than wait that out, each step moves
   * the shell's clock past it (Playwright's clock: `Date` jumps, timers keep
   * running) and opens a new home page, which asks again.
   */
  let skew = 0;
  async function askAgainAfter(ms: number): Promise<void> {
    skew += ms;
    await shell.clock.setSystemTime(Date.now() + skew);
  }

  test("the schedule shows a connected Google Calendar's day: all-day first, what is on now, a way into the call", async () => {
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
    // The last read was answered before the handler was replaced, by a Mac with no account.
    await askAgainAfter(16_000);
    const schedule = (await newHomeTab(shell)).getByTestId("home-schedule");
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
  });

  test("a calendar whose grant died says so on the schedule and leads to Integrations", async () => {
    await answerCalendarWith(app, { status: "reconnect_required", connectable: false, accountLabel: "alex@example.com", events: [] });
    // A day with events in it stands five minutes.
    await askAgainAfter(5 * 60_000 + 1_000);
    const schedule = (await newHomeTab(shell)).getByTestId("home-schedule");
    await expect(schedule).toContainText("Google Calendar needs reconnecting");
    await schedule.getByTestId("home-calendar-reconnect").click();
    await expect(shell.getByTestId("settings-page")).toBeVisible();
    await expect(shell.getByTestId("settings-page")).toContainText("Google Calendar");
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("settings-page")).toHaveCount(0);
  });

  test("someone with no calendar is invited to connect one from the schedule, once — and can say no for good", async () => {
    await answerCalendarWith(app, { status: "not_connected", connectable: true, accountLabel: null, events: [] });
    await askAgainAfter(16_000);
    const schedule = (await newHomeTab(shell)).getByTestId("home-schedule");
    const invitation = schedule.getByTestId("home-calendar-connect");
    await expect(invitation).toBeVisible();
    await expect(invitation).toContainText("See today’s Google Calendar events here");
    await expect(schedule.getByTestId("home-open-calendar")).toBeVisible();
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
    await expect((await newHomeTab(shell)).getByTestId("home-schedule")).toBeVisible();
    await expect(shell.getByTestId("home-calendar-connect")).toHaveCount(0);
    expect(await shell.evaluate(() => localStorage.getItem("pistachio.home.calendar-prompt-dismissed"))).toBe("1");
  });
});
