/**
 * Intervals and signals (docs/primitives.md §3.6, stage 5's gate), end to
 * end through a fixture on the public API alone
 * (e2e/fixtures/extensions/stand-up): "when my stand-up starts, bring the
 * Team space back" — a declared signal on the person's calendar, an interval
 * that runs while it holds, and a second signal on the Mac's power.
 *
 * - its sheet says, in the shell's words, the one thing it will be told of
 *   the calendar; before anyone approves, nothing of the Mac or the calendar
 *   is read for it — its status file says neither on nor off;
 * - approved with no calendar connected, the signal is not known: nothing is
 *   heard, and the page says what would let it be read;
 * - the calendar connected, `/standup` in a space sends it away; two minutes
 *   before the stand-up, with nobody there, the space is back and main wrote
 *   it down — the extension never saw the event;
 * - the interval keeps a row beside the Bar current with no worker kept up:
 *   one call for however many minutes passed;
 * - the calendar gone mid-meeting is not the meeting ending: nothing is
 *   heard, and the space stays; read again, the end is heard and it goes;
 * - the charger pulled is heard, and the Extensions page says each signal.
 *
 * The readings, the marks and the runner are extensions-signals.test; the
 * schema and the words packages/extension-api/test/triggers.test. This
 * proves the wiring only the app has.
 */

import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { AwaySpaceInfo } from "@pistachio/shell-contracts/away";
import type { ExtensionsSnapshot } from "@pistachio/shell-contracts/extensions";
import { chooseHome, chooseSpace, createGroup, launchDesk, openTabs, railSpace, screenshots, selectTab, settled, snapshot, VENDOR } from "./desk-harness";

const capture = screenshots("extensions-signals");
const ID = "dev.pistachio-e2e.stand-up";
const FIXTURE = fileURLToPath(new URL("../fixtures/extensions/stand-up", import.meta.url));
const NORTH = "pistachio://demo/invoices?page=north";
const TEAM = "team";
const EVENT = "a calendar event with “stand-up” in its name is on, and for 2 minutes before it";
const SAYS = { standup: `While ${EVENT}`, minute: `Every minute while ${EVENT}`, unplugged: "While this Mac is on battery" };
const CONNECT = "Connect Google Calendar in Settings";

/** An instant by this Mac's own clock on Monday the 16th of November 2026. */
const at = (hour: number, minute = 0, second = 0): number => new Date(2026, 10, 16, hour, minute, second).getTime();
/** The day's calendar: the stand-up at half past nine, and a lunch that is nobody's signal. */
const CALENDAR = [
  { title: "Team Stand-Up", start: at(9, 30), end: at(9, 45) },
  { title: "Lunch", start: at(12), end: at(13) },
];

type WithExtensions = { pistachio: { extensions(request: unknown): Promise<unknown>; onExtensions(listener: (snapshot: ExtensionsSnapshot) => void): () => void }; __ext?: ExtensionsSnapshot };

function extensionsSnapshot(shell: Page): Promise<ExtensionsSnapshot | null> {
  return shell.evaluate(() => (window as unknown as WithExtensions).__ext ?? null);
}

function extensionsRequest(shell: Page, request: unknown): Promise<unknown> {
  return shell.evaluate((body) => (window as unknown as WithExtensions).pistachio.extensions(body), request);
}

const standUp = async (shell: Page) => (await extensionsSnapshot(shell))?.extensions.find((extension) => extension.id === ID);
const trigger = async (shell: Page, id: string) => (await standUp(shell))?.triggers?.find((candidate) => candidate.id === id);

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

test.describe.serial("extensions: a space that comes back when the stand-up starts", { tag: ["@extensions"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let userData: string;
  let folder: string;
  let clock: string;
  let signals: string;
  let vendor: string, north: string;

  /** Make it this instant, as far as the triggers can tell. */
  const setClock = (instant: number): Promise<void> => writeFile(clock, String(instant));
  /** What main reads of the Mac and the calendar: `calendar` left out is a calendar that is not connected. */
  const setSignals = (readings: { battery: boolean; calendar?: typeof CALENDAR }): Promise<void> => writeFile(signals, JSON.stringify({ online: true, displays: 1, idleSeconds: 0, ...readings }));
  const teamTabs = async (): Promise<string[] | null> => (await snapshot(shell)).tabGroups.find((group) => group.id === TEAM)?.tabIds ?? null;
  const follow = async (): Promise<void> => {
    await shell.evaluate(() => {
      const w = window as unknown as WithExtensions;
      w.pistachio.onExtensions((next) => (w.__ext = next));
    });
    await extensionsRequest(shell, { type: "closePanel" });
  };
  /** The extension's row beside the Bar. */
  const chips = (): Locator => shell.locator(`[data-testid="extension-status-pills"] [data-testid="extension-band-row"][data-extension-id="${ID}"]`);
  const heard = (): Promise<boolean[]> => stored<boolean>(userData, "heard");
  const marks = (): Promise<number[]> => stored<number>(userData, "marks");

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const scratch = await mkdtemp(join(tmpdir(), "pistachio-stand-up-"));
    clock = join(scratch, "clock");
    signals = join(scratch, "signals.json");
    // Monday at nine, plugged in, no calendar connected.
    await setClock(at(9));
    await setSignals({ battery: false });
    ({ app, shell, userData } = await launchDesk({ name: "extensions-signals", sidebar: "whole", env: { PISTACHIO_E2E_TRIGGER_CLOCK: clock, PISTACHIO_E2E_SIGNALS: signals } }));
    [vendor, north] = (await openTabs(shell, [VENDOR, NORTH])) as [string, string];
    await createGroup(shell, TEAM, [vendor, north], "Team", "blue");
    await expect(railSpace(shell, TEAM)).toHaveCount(1);
    await settled(shell, app);
    folder = join(scratch, "stand-up");
    await cp(FIXTURE, folder, { recursive: true });
    // (The copy's own file events settle first, or main takes them for an edit and reloads it: extensions-capture.spec.)
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await follow();
    await extensionsRequest(shell, { type: "loadFolder", path: folder });
    await expect.poll(async () => (await standUp(shell))?.pending?.manifestHash ?? null).not.toBeNull();
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("its sheet says the one thing it will be told; unapproved, nothing is read for it; approved with no calendar, the signal is not known", async () => {
    // ── 1. From the manifest alone: each trigger in the shell's words — an interval says what it runs while, never an id ─
    expect((await standUp(shell))!.pending!.runs).toEqual([SAYS.standup, SAYS.minute, SAYS.unplugged]);
    const status = JSON.parse(await readFile(join(folder, ".pistachio", "status.json"), "utf8")) as { state: string; triggers: { id: string; says: string; holds?: boolean; needs?: string; next: unknown[] }[] };
    expect(status.state).toBe("needs-approval");
    // Nothing of the Mac is read for a draft: its power signal is neither on nor off, though main could tell.
    expect(status.triggers).toEqual([
      { id: "standup", says: SAYS.standup, zone: expect.any(String), next: [] },
      { id: "minute", says: SAYS.minute, zone: expect.any(String), next: [] },
      { id: "unplugged", says: SAYS.unplugged, zone: expect.any(String), next: [] },
    ]);
    expect(await trigger(shell, "unplugged")).toEqual({ id: "unplugged", text: SAYS.unplugged, unknown: true, next: null });

    // ── 2. The sheet says them, and it is turned on ─
    const icon = shell.locator(`[data-testid="ledge-icon"][data-extension-id="${ID}"]`);
    await expect(icon).toBeVisible({ timeout: 10_000 });
    await icon.click();
    const sheet = shell.getByTestId("extension-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("approval-runs-line")).toHaveText([SAYS.standup, SAYS.minute, SAYS.unplugged]);
    await capture(app, shell, "01-sheet-signals.png");
    await sheet.getByTestId("extension-sheet-turn-on").click();
    await expect(sheet).toHaveCount(0);

    // ── 3. Approved: the power signal is said once, as it is; the calendar's is not known, and nothing is heard for it ─
    await expect.poll(() => stored<boolean>(userData, "power")).toEqual([false]);
    await expect.poll(() => trigger(shell, "standup")).toEqual({ id: "standup", text: SAYS.standup, unknown: true, needs: CONNECT, next: null });
    expect(await trigger(shell, "unplugged")).toEqual({ id: "unplugged", text: SAYS.unplugged, holds: false, next: null });
    expect(await trigger(shell, "minute")).toEqual({ id: "minute", text: SAYS.minute, next: null });
    expect(await heard()).toEqual([]);
  });

  test("the calendar connected: no stand-up yet is heard, and /standup in the Team space sends it away", async () => {
    await setSignals({ battery: false, calendar: CALENDAR });
    await expect.poll(() => trigger(shell, "standup"), { timeout: 15_000 }).toEqual({ id: "standup", text: SAYS.standup, holds: false, next: null });
    await expect.poll(heard).toEqual([false]);
    await chooseSpace(shell, TEAM);
    const inUse = (await snapshot(shell)).activeTabId!;
    await extensionsRequest(shell, { type: "barCommand", id: ID, command: "standup", arg: "", spaceId: TEAM, tabId: inUse });
    await expect.poll(async () => (await away(shell)).map((space) => space.id)).toEqual([TEAM]);
    // The person's own command: not in the journal.
    expect((await standUp(shell))?.journal ?? []).toEqual([]);
    await expect(chips()).toHaveCount(0);
  });

  test("two minutes before the stand-up, with nobody there: the space is back, main wrote it down, and a row says so beside the Bar", async () => {
    test.setTimeout(60_000);
    await setClock(at(9, 28, 5));
    await expect.poll(teamTabs, { timeout: 20_000 }).toEqual([vendor, north]);
    expect(await away(shell)).toEqual([]);
    // Never in front: nobody but the person moves them.
    expect((await snapshot(shell)).currentGroupId).not.toBe(TEAM);
    await expect.poll(heard).toEqual([false, true]);
    await expect.poll(async () => (await standUp(shell))?.journal?.length ?? 0).toBe(1);
    expect((await standUp(shell))!.journal![0]).toMatchObject({ extensionId: ID, trigger: "standup", verb: "bringBack", spaceId: TEAM, title: "Team" });
    expect(await trigger(shell, "standup")).toMatchObject({ holds: true });
    await expect(chips()).toHaveCount(1);
    await expect(chips().locator(".extension-status-text")).toHaveText("Stand-up");
    await expect(chips().locator(".shown-row-value")).toHaveText("now");
    // The interval begins quiet: the signal's own handler has just said how things are.
    expect(await marks()).toEqual([]);
    await capture(app, shell, "02-stand-up-on.png");
  });

  test("the interval keeps the row current, across a restart, with no worker kept up: one call for however many minutes passed", async () => {
    test.setTimeout(120_000);
    await setClock(at(9, 29, 5));
    await expect.poll(marks, { timeout: 20_000 }).toEqual([at(9, 29)]);
    await expect(chips().locator(".shown-row-value")).toHaveText("1 min");
    // Pistachio is closed; four marks pass; it is opened again. The row main kept is there before any code has run,
    await app.close();
    await setClock(at(9, 33, 5));
    ({ app, shell } = await launchDesk({ name: "extensions-signals", userData, env: { PISTACHIO_E2E_TRIGGER_CLOCK: clock, PISTACHIO_E2E_SIGNALS: signals } }));
    await follow();
    // and once the calendar has been read again, the interval hears one call — the latest mark, not four, and not
    // none: the moment at launch when the calendar was not yet read did not stop it.
    await expect.poll(marks, { timeout: 30_000 }).toEqual([at(9, 29), at(9, 33)]);
    await expect(chips().locator(".shown-row-value")).toHaveText("2 min");
    // The stand-up was on before and is on now: its own handler is not run again.
    expect(await heard()).toEqual([false, true]);
    // The worker the interval started is stopped once its handler answered: woken code does not stay.
    await expect.poll(async () => (await standUp(shell))?.status).toBe("idle");
    // Rows are not written in the journal: they say whose they are where they are.
    expect((await standUp(shell))?.journal).toHaveLength(1);
  });

  test("the calendar gone mid-meeting is not the meeting ending; read again, the end is heard and the space goes", async () => {
    test.setTimeout(90_000);
    await chooseHome(shell);
    // ── 1. Not known: nothing is heard, the interval stops, the space stays ─
    await setSignals({ battery: false });
    await expect.poll(() => trigger(shell, "standup"), { timeout: 15_000 }).toEqual({ id: "standup", text: SAYS.standup, unknown: true, needs: CONNECT, next: null });
    await setClock(at(9, 40, 5));
    // (The absence is what is tested: four looks of the clock go by.)
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await heard()).toEqual([false, true]);
    expect(await marks()).toHaveLength(2);
    expect(await teamTabs()).toEqual([vendor, north]);

    // ── 2. Read again, still on: nothing new to say of the stand-up, and the interval hears the one mark it is owed ─
    await setSignals({ battery: false, calendar: CALENDAR });
    await expect.poll(() => trigger(shell, "standup"), { timeout: 15_000 }).toMatchObject({ holds: true });
    await expect.poll(marks, { timeout: 15_000 }).toEqual([at(9, 29), at(9, 33), at(9, 40)]);
    expect(await heard()).toEqual([false, true]);

    // ── 3. A quarter to ten: the stand-up is over, the space goes away and the row with it ─
    await setClock(at(9, 45, 10));
    await expect.poll(async () => (await away(shell)).map((space) => space.id), { timeout: 20_000 }).toEqual([TEAM]);
    await expect.poll(heard).toEqual([false, true, false]);
    await expect.poll(async () => (await standUp(shell))?.journal?.map((line) => line.verb)).toEqual(["sendAway", "bringBack"]);
    await expect(chips()).toHaveCount(0);
    // And the interval no longer runs.
    const before = await marks();
    await setClock(at(9, 48, 5));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await marks()).toEqual(before);
  });

  test("the charger pulled is heard, and the Extensions page says where each signal stands", async () => {
    test.setTimeout(60_000);
    await setSignals({ battery: true, calendar: CALENDAR });
    await expect.poll(() => stored<boolean>(userData, "power"), { timeout: 15_000 }).toEqual([false, true]);
    await openTabs(shell, ["pistachio://extensions/"]);
    const tab = (await snapshot(shell)).tabs.find((candidate) => candidate.url.startsWith("pistachio://extensions"))!;
    await selectTab(shell, tab.id);
    const section = shell.locator(`[data-testid="extension-triggers"][data-extension-id="${ID}"]`);
    await expect(section).toBeVisible({ timeout: 15_000 });
    const line = (id: string): Locator => section.locator(`[data-testid="extension-trigger-line"][data-trigger-id="${id}"]`);
    await expect(line("standup")).toContainText(SAYS.standup);
    await expect(line("standup").getByTestId("extension-trigger-state")).toHaveText("Off now");
    await expect(line("unplugged").getByTestId("extension-trigger-state")).toHaveText("On now");
    await expect(line("minute").getByTestId("extension-trigger-state")).toHaveCount(0);
    // With the calendar gone, the page says so and what would let it be read.
    await setSignals({ battery: true });
    await expect(line("standup").getByTestId("extension-trigger-state")).toHaveText(`Not known · ${CONNECT}`, { timeout: 15_000 });
    await expect(line("standup")).toHaveAttribute("data-unknown", "true");
    await capture(app, shell, "03-extensions-page-signals.png");
  });
});
