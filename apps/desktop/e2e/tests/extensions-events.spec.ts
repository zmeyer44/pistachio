/**
 * What happens, and what the browser holds (docs/primitives.md §3.6, §3.7 —
 * stage 5b's gate), end to end through a fixture on the public API alone
 * (e2e/fixtures/extensions/call-guard): "send Football away while a Meet
 * call is open" — a declared signal of the browser's own, a page under an
 * address being open — beside events, a locked screen and a page opened at
 * nine with nobody there. The "call" is a page this spec serves.
 *
 * - its sheet says each trigger in the shell's words, and what it may do
 *   with nobody there by what it asks for;
 * - a call page opened: the space goes away with nobody there and main
 *   writes it down; the events say a tab opened and a page arrived, with the
 *   tab and never its address; the page closed, the space is back;
 * - nine o'clock: a page opens behind what is in front, whatever was asked;
 *   it is in the journal, and Undo closes it;
 * - the screen locked: the space in front goes — it is in front of no one —
 *   and nothing is said to the empty room: what is said waits for somebody;
 * - paused, what happens is missed for good, not kept for later.
 *
 * The readings, the event queue and the scope's rules are
 * extensions-events.test; the schema and the words
 * packages/extension-api/test/triggers.test. This proves the wiring only the
 * app has: main's tab tick reaching a stopped worker.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { AwaySpaceInfo } from "@pistachio/shell-contracts/away";
import type { ExtensionsSnapshot } from "@pistachio/shell-contracts/extensions";
import { chooseHome, chooseSpace, createGroup, launchDesk, openTabs, railSpace, screenshots, selectTab, settled, snapshot, VENDOR } from "./desk-harness";
import { noticePage } from "./windows";

const capture = screenshots("extensions-events");
const ID = "dev.pistachio-e2e.call-guard";
const FIXTURE = fileURLToPath(new URL("../fixtures/extensions/call-guard", import.meta.url));
const NORTH = "pistachio://demo/invoices?page=north";
const FOOTBALL = "football";
const SAYS = {
  call: "While a page under 127.0.0.1/call is open",
  locked: "While this Mac's screen is locked",
  opened: "When a tab opens",
  closed: "When a tab closes",
  arrived: "When a page under 127.0.0.1/call opens",
  nine: "Every day at 9:00 AM",
  ten: "Every day at 10:00 AM",
};
const LIMIT = "With nobody there it can only send away and bring back spaces you gave it and open tabs behind what you are doing. What it does to your spaces and tabs is listed, and can be undone.";

/** An instant by this Mac's own clock on Monday the 16th of November 2026. */
const at = (hour: number, minute = 0, second = 0): number => new Date(2026, 10, 16, hour, minute, second).getTime();

type WithExtensions = { pistachio: { extensions(request: unknown): Promise<unknown>; onExtensions(listener: (snapshot: ExtensionsSnapshot) => void): () => void }; __ext?: ExtensionsSnapshot };

function extensionsSnapshot(shell: Page): Promise<ExtensionsSnapshot | null> {
  return shell.evaluate(() => (window as unknown as WithExtensions).__ext ?? null);
}

function extensionsRequest(shell: Page, request: unknown): Promise<unknown> {
  return shell.evaluate((body) => (window as unknown as WithExtensions).pistachio.extensions(body), request);
}

const guard = async (shell: Page) => (await extensionsSnapshot(shell))?.extensions.find((extension) => extension.id === ID);
const trigger = async (shell: Page, id: string) => (await guard(shell))?.triggers?.find((candidate) => candidate.id === id);
const journal = async (shell: Page) => (await guard(shell))?.journal ?? [];

async function away(shell: Page): Promise<AwaySpaceInfo[]> {
  return (await snapshot(shell)).awaySpaces ?? [];
}

/** What the fixture left in its storage under `key` (main's file of it); `[]` when nothing. */
async function stored<T>(userData: string, key: string): Promise<T[]> {
  try {
    const values = JSON.parse(await readFile(join(userData, "ExtensionData", ID, "storage.json"), "utf8")) as Record<string, unknown>;
    return (values[key] as T[] | undefined) ?? [];
  } catch {
    return [];
  }
}

test.describe.serial("extensions: a space that goes away while a call is open", { tag: ["@extensions"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let userData: string;
  let server: Server;
  let origin: string;
  let clock: string;
  let signals: string;
  let vendor: string, north: string;

  /** Make it this instant, as far as the triggers can tell. */
  const setClock = (instant: number): Promise<void> => writeFile(clock, String(instant));
  /** What main reads of the Mac. */
  const setSignals = (readings: { locked: boolean }): Promise<void> => writeFile(signals, JSON.stringify({ battery: false, online: true, displays: 1, idleSeconds: 0, ...readings }));
  const footballTabs = async (): Promise<string[] | null> => (await snapshot(shell)).tabGroups.find((group) => group.id === FOOTBALL)?.tabIds ?? null;
  const tabOn = async (url: string): Promise<string | null> => (await snapshot(shell)).tabs.find((tab) => tab.url === url)?.id ?? null;
  const closeTab = (tabId: string): Promise<void> => shell.evaluate((id) => (window as unknown as { pistachio: { closeTab(tabId: string): Promise<void> } }).pistachio.closeTab(id), tabId);
  const heard = (key: string): Promise<unknown[]> => stored<unknown>(userData, key);

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Fixture ${request.url ?? ""}</title></head><body><h1>${request.url ?? ""}</h1></body></html>`);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const scratch = await mkdtemp(join(tmpdir(), "pistachio-call-guard-"));
    clock = join(scratch, "clock");
    signals = join(scratch, "signals.json");
    // Monday at eight, the screen not locked.
    await setClock(at(8));
    await setSignals({ locked: false });
    ({ app, shell, userData } = await launchDesk({ name: "extensions-events", sidebar: "whole", env: { PISTACHIO_E2E_TRIGGER_CLOCK: clock, PISTACHIO_E2E_SIGNALS: signals } }));
    [vendor, north] = (await openTabs(shell, [VENDOR, NORTH])) as [string, string];
    await createGroup(shell, FOOTBALL, [vendor, north], "Football", "green");
    await expect(railSpace(shell, FOOTBALL)).toHaveCount(1);
    await settled(shell, app);
    const folder = join(scratch, "call-guard");
    await cp(FIXTURE, folder, { recursive: true });
    // (The copy's own file events settle first, or main takes them for an edit and reloads it: extensions-capture.spec.)
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await shell.evaluate(() => {
      const w = window as unknown as WithExtensions;
      w.pistachio.onExtensions((next) => (w.__ext = next));
    });
    await extensionsRequest(shell, { type: "closePanel" });
    await extensionsRequest(shell, { type: "loadFolder", path: folder });
    await expect.poll(async () => (await guard(shell))?.pending?.manifestHash ?? null).not.toBeNull();
  });

  test.afterAll(async () => {
    await app?.close();
    await new Promise<void>((done) => server.close(() => done()));
  });

  test("its sheet says each trigger in the shell's words, and what it may do with nobody there by what it asks for", async () => {
    const pending = (await guard(shell))!.pending!;
    expect(pending.runs).toEqual([SAYS.call, SAYS.locked, SAYS.opened, SAYS.closed, SAYS.arrived, SAYS.nine, SAYS.ten]);
    expect(pending.runsLimit).toBe(LIMIT);
    const icon = shell.locator(`[data-testid="ledge-icon"][data-extension-id="${ID}"]`);
    await expect(icon).toBeVisible({ timeout: 10_000 });
    await icon.click();
    const sheet = shell.getByTestId("extension-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("approval-runs-line")).toHaveText([SAYS.call, SAYS.locked, SAYS.opened, SAYS.closed, SAYS.arrived, SAYS.nine, SAYS.ten]);
    await expect(sheet.getByTestId("approval-runs-limit")).toHaveText(LIMIT);
    await capture(app, shell, "01-sheet-events.png");
    await sheet.getByTestId("extension-sheet-turn-on").click();
    await expect(sheet).toHaveCount(0);

    // Approved: the browser's own signal is read at once — no call is open — and an event has nothing to say yet.
    await expect.poll(() => trigger(shell, "call")).toEqual({ id: "call", text: SAYS.call, holds: false, next: null });
    await expect.poll(() => trigger(shell, "locked")).toEqual({ id: "locked", text: SAYS.locked, holds: false, next: null });
    expect(await trigger(shell, "opened")).toEqual({ id: "opened", text: SAYS.opened, next: null, event: true, last: null });
    await expect.poll(() => heard("heard")).toEqual([false]);
    await expect.poll(() => heard("locked")).toEqual([false]);
  });

  test("a call page opened: the space goes away with nobody there, and the events say what happened — a tab, never its address", async () => {
    test.setTimeout(60_000);
    // /guard in the Football space gives the extension that space; then the person is elsewhere.
    await chooseSpace(shell, FOOTBALL);
    const inUse = (await snapshot(shell)).activeTabId!;
    await extensionsRequest(shell, { type: "barCommand", id: ID, command: "guard", arg: `${origin}/doc`, spaceId: FOOTBALL, tabId: inUse });
    // (Their own command in hand, the microphone the sheet granted is the worker's to ask for.)
    await expect.poll(() => heard("mic")).toEqual(["guard:granted"]);
    await chooseHome(shell);
    expect(await away(shell)).toEqual([]);
    const before = (await heard("opened")).length;

    const [call] = (await openTabs(shell, [`${origin}/call/abc-defg-hij`])) as [string];
    // The signal holds: the space is sent away, and main wrote down who did it and why.
    await expect.poll(async () => (await away(shell)).map((space) => space.id), { timeout: 20_000 }).toEqual([FOOTBALL]);
    await expect.poll(() => heard("heard")).toEqual([false, true]);
    await expect.poll(async () => (await journal(shell)).map((line) => [line.trigger, line.verb, line.spaceId, line.title])).toEqual([["call", "sendAway", FOOTBALL, "Football"]]);
    expect(await trigger(shell, "call")).toMatchObject({ holds: true });
    // The events: the tab that opened is among them, and the page that arrived was read by `tabs.get` — the event
    // itself said only which tab.
    await expect.poll(async () => (await heard("opened")).slice(before)).toContain(call);
    await expect.poll(() => heard("arrived")).toEqual(["/call/abc-defg-hij"]);
    await expect.poll(async () => (await trigger(shell, "arrived"))?.last ?? null).not.toBeNull();
    // A space going away took its tabs with it: none of them was closed.
    expect(await heard("closed")).not.toContain(vendor);
    expect(await heard("closed")).not.toContain(north);
    await capture(app, shell, "02-call-open.png");

    // The call over: its tab closed is an event, the signal is off, and the space is back — never in front.
    await closeTab(call);
    await expect.poll(footballTabs, { timeout: 20_000 }).toEqual([vendor, north]);
    expect(await away(shell)).toEqual([]);
    expect((await snapshot(shell)).currentGroupId).not.toBe(FOOTBALL);
    await expect.poll(() => heard("heard")).toEqual([false, true, false]);
    await expect.poll(() => heard("closed")).toContain(call);
    await expect.poll(async () => (await journal(shell)).map((line) => line.verb)).toEqual(["bringBack", "sendAway"]);
    // And coming back, its tabs were not opened.
    expect((await heard("opened")).slice(before)).not.toContain(vendor);
  });

  test("nine o'clock, with nobody there: a page opens behind what is in front, is written down, and Undo closes it", async () => {
    test.setTimeout(60_000);
    const inUse = (await snapshot(shell)).activeTabId;
    await setClock(at(9, 0, 5));
    await expect.poll(() => tabOn(`${origin}/doc`), { timeout: 20_000 }).not.toBeNull();
    const doc = (await tabOn(`${origin}/doc`))!;
    await expect.poll(() => heard("made")).toEqual([doc]);
    // It asked to be shown; with nobody there nothing is.
    expect((await snapshot(shell)).activeTabId).toBe(inUse);
    // And the microphone it was granted is not a trigger's handler's: asked with nobody there, it is refused.
    expect(await heard("mic")).toEqual(["guard:granted", "nine:denied"]);
    await expect.poll(async () => (await journal(shell))[0]).toMatchObject({ trigger: "nine", verb: "openTab", tabId: doc, title: `${origin.replace("http://", "")}/doc` });
    const line = (await journal(shell))[0]!;
    await extensionsRequest(shell, { type: "undoJournal", entry: line.id });
    await expect.poll(() => tabOn(`${origin}/doc`)).toBeNull();
    await expect.poll(async () => (await journal(shell))[0]?.undone ?? null).not.toBeNull();
  });

  test("the screen locked: the space in front goes — it is in front of no one — and is back, not in front, when it is unlocked", async () => {
    test.setTimeout(60_000);
    await chooseSpace(shell, FOOTBALL);
    expect((await snapshot(shell)).currentGroupId).toBe(FOOTBALL);
    await setSignals({ locked: true });
    await expect.poll(async () => (await away(shell)).map((space) => space.id), { timeout: 20_000 }).toEqual([FOOTBALL]);
    await expect.poll(() => heard("locked")).toEqual([false, true]);
    await expect.poll(async () => (await journal(shell))[0]).toMatchObject({ trigger: "locked", verb: "sendAway", spaceId: FOOTBALL });
    // Nothing is said to an empty room: with the window in front and the screen locked, the notice waits.
    // (In front as a person's click would put it — and, where this Mac's own screen is locked, told that it is.)
    const inFront = (): Promise<void> =>
      app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible());
        if (window === undefined) return;
        window.focus();
        if (!window.isFocused()) window.emit("focus");
      });
    await inFront();
    const notices = await noticePage(app);
    const said = (words: string): Locator => notices.locator('[data-testid="notice-card"]').filter({ hasText: words });
    // (The absence is what is tested: longer than main waits between looks for somebody.)
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await expect(said("“Football”")).toHaveCount(0);

    await setSignals({ locked: false });
    await expect.poll(footballTabs, { timeout: 20_000 }).toEqual([vendor, north]);
    expect((await snapshot(shell)).currentGroupId).not.toBe(FOOTBALL);
    await expect.poll(() => heard("locked")).toEqual([false, true, false]);
    // Somebody is back, at the window: they are told what is so now — the space is back, and who brought it — never
    // that it is away, which it no longer is.
    await inFront();
    await expect(said("“Football” is back · Call guard").first()).toBeVisible({ timeout: 15_000 });
    await expect(said("“Football” is away")).toHaveCount(0);
  });

  test("paused, what happens is missed for good; the Extensions page says when each event was last heard and lists the tab it opened", async () => {
    test.setTimeout(60_000);
    await chooseHome(shell);
    await extensionsRequest(shell, { type: "pauseTriggers", id: ID, paused: true });
    const [missed] = (await openTabs(shell, [`${origin}/missed`])) as [string];
    await extensionsRequest(shell, { type: "pauseTriggers", id: ID, paused: false });
    const [told] = (await openTabs(shell, [`${origin}/told`])) as [string];
    await expect.poll(() => heard("opened"), { timeout: 15_000 }).toContain(told);
    expect(await heard("opened")).not.toContain(missed);

    await openTabs(shell, ["pistachio://extensions/"]);
    const tab = (await snapshot(shell)).tabs.find((candidate) => candidate.url.startsWith("pistachio://extensions"))!;
    await selectTab(shell, tab.id);
    const section = shell.locator(`[data-testid="extension-triggers"][data-extension-id="${ID}"]`);
    await expect(section).toBeVisible({ timeout: 15_000 });
    const line = (id: string): Locator => section.locator(`[data-testid="extension-trigger-line"][data-trigger-id="${id}"]`);
    await expect(line("call")).toContainText(SAYS.call);
    await expect(line("call").getByTestId("extension-trigger-state")).toHaveText("Off now");
    await expect(line("opened").getByTestId("extension-trigger-state")).toContainText("Last heard");
    await expect(line("arrived").getByTestId("extension-trigger-state")).toContainText("Last heard");
    await expect(section).toContainText(`Opened ${origin.replace("http://", "")}/doc`);
    await capture(app, shell, "03-extensions-page-events.png");
  });

  test("a handler that runs past its time is still a trigger's when it goes on: what it then asks is asked as with nobody there", async () => {
    test.setTimeout(90_000);
    await chooseHome(shell);
    const [keep] = (await openTabs(shell, [`${origin}/keep`])) as [string];
    // The person runs /guard: the worker is theirs — started by their own command, not woken by a trigger — and is
    // left a tab for ten o'clock's handler to try to close.
    await extensionsRequest(shell, { type: "barCommand", id: ID, command: "guard", arg: `late:${keep}`, spaceId: FOOTBALL, tabId: keep });
    await expect.poll(async () => (await stored<string>(userData, "late")) as unknown).toBe(keep);
    await setClock(at(10, 0, 5));
    // Ten seconds on Pistachio stops waiting for the handler; a second later it goes on, and asks to close the tab.
    // (The time itself is what is tested: the handler sleeps eleven seconds.)
    await expect.poll(() => heard("late"), { timeout: 40_000, intervals: [1_000] }).toEqual(["PERMISSION_DENIED"]);
    expect(await tabOn(`${origin}/keep`)).toBe(keep);
  });

  test("the next morning, an empty space in front: there is no behind to open into — the page waits, and opens once the person is somewhere", async () => {
    test.setTimeout(90_000);
    // The person is looking at a space with no tab in it. (A space shows the tab it has: one that joined it would be in front.)
    await createGroup(shell, "empty", [], "Empty", "blue");
    await chooseSpace(shell, "empty");
    expect((await snapshot(shell)).activeTabId).toBeNull();
    expect(await tabOn(`${origin}/doc`)).toBeNull();
    const asked = (await heard("mic")).length;
    // Nine o'clock the next day, with nobody there: the handler runs (it asks about the microphone first), and the tab
    // it would open is refused — nothing is opened, nothing is put in front.
    await setClock(at(33, 0, 5));
    await expect.poll(async () => (await heard("mic")).length, { timeout: 20_000 }).toBe(asked + 1);
    await settled(shell, app);
    expect(await tabOn(`${origin}/doc`)).toBeNull();
    expect((await snapshot(shell)).activeTabId).toBeNull();
    // The person goes somewhere. A minute on the handler is run again, and the page opens behind what they are in.
    await chooseHome(shell);
    const inUse = (await snapshot(shell)).activeTabId;
    expect(inUse).not.toBeNull();
    await setClock(at(33, 1, 10));
    await expect.poll(() => tabOn(`${origin}/doc`), { timeout: 20_000 }).not.toBeNull();
    expect((await snapshot(shell)).activeTabId).toBe(inUse);
  });
});
