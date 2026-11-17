/**
 * An extension that runs by itself (docs/primitives.md §3, stage 2's gate),
 * end to end through the extension §6 gives as the example
 * (e2e/fixtures/extensions/game-day): a space that is here on Sundays and
 * away the rest of the week. The spec moves the clock main reads triggers
 * against (PISTACHIO_E2E_TRIGGER_CLOCK), never the extension's code:
 *
 * - the sheet says when it runs by itself, in the shell's words, and the
 *   status file lists the week ahead before anyone approves it;
 * - Pistachio closed on Saturday and opened on Sunday morning: the worker,
 *   which nothing else started, is woken, the space comes back as itself,
 *   main writes it in the journal, and the worker is stopped again;
 * - Sunday night with the person in the space: it is not taken from under
 *   them; it goes once they have moved on;
 * - the Extensions page lists what it did, Undo takes it back, Pause holds
 *   it and lifting the pause catches up;
 * - a trigger whose times changed waits on the sheet.
 *
 * The schedule math, the runner's retries and the unattended rule are
 * extensions-triggers.test; the manifest and the words
 * packages/extension-api/test/triggers.test. This proves the wiring only the
 * app has: main's clock waking a stopped worker, a trigger invocation
 * reaching the scope as unattended, the journal reaching the page.
 */

import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AwaySpaceInfo } from "@pistachio/shell-contracts/away";
import type { ExtensionsSnapshot } from "@pistachio/shell-contracts/extensions";
import { chooseHome, chooseSpace, createGroup, launchDesk, openTabs, railSpace, screenshots, selectTab, settled, snapshot, VENDOR } from "./desk-harness";

const capture = screenshots("extensions-triggers");
const ID = "dev.pistachio-e2e.game-day";
const FIXTURE = fileURLToPath(new URL("../fixtures/extensions/game-day", import.meta.url));
const NORTH = "pistachio://demo/invoices?page=north";
const FOOTBALL = "football";
const SAYS = "Sundays 8:00 AM–11:00 PM";

/** An instant by this Mac's own clock in November 2026: the 14th is a Saturday, the 15th and the 22nd Sundays. */
const at = (day: number, hour: number, minute = 0, second = 0): number => new Date(2026, 10, day, hour, minute, second).getTime();

type WithExtensions = { pistachio: { extensions(request: unknown): Promise<unknown>; onExtensions(listener: (snapshot: ExtensionsSnapshot) => void): () => void }; __ext?: ExtensionsSnapshot };

function extensionsSnapshot(shell: Page): Promise<ExtensionsSnapshot | null> {
  return shell.evaluate(() => (window as unknown as WithExtensions).__ext ?? null);
}

function extensionsRequest(shell: Page, request: unknown): Promise<unknown> {
  return shell.evaluate((body) => (window as unknown as WithExtensions).pistachio.extensions(body), request);
}

const gameDay = async (shell: Page) => (await extensionsSnapshot(shell))?.extensions.find((extension) => extension.id === ID);

async function away(shell: Page): Promise<AwaySpaceInfo[]> {
  return (await snapshot(shell)).awaySpaces ?? [];
}

/** What the fixture left in its storage under `key` (main's file of it), or null. */
async function stored<T>(userData: string, key: string): Promise<T | null> {
  try {
    const values = JSON.parse(await readFile(join(userData, "ExtensionData", ID, "storage.json"), "utf8")) as Record<string, unknown>;
    return (values[key] as T | undefined) ?? null;
  } catch {
    return null;
  }
}

type Heard = { holds: boolean; changesAt: number | null }[];
const heard = async (userData: string): Promise<boolean[]> => ((await stored<Heard>(userData, "heard")) ?? []).map((state) => state.holds);

test.describe.serial("extensions: a space that is here on Sundays", { tag: ["@extensions"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let userData: string;
  let folder: string;
  let clock: string;
  let vendor: string, north: string;

  /** Make it this instant, as far as the triggers can tell. */
  const setClock = (instant: number): Promise<void> => writeFile(clock, String(instant));
  const footballTabs = async (): Promise<string[] | null> => (await snapshot(shell)).tabGroups.find((group) => group.id === FOOTBALL)?.tabIds ?? null;
  /** Keep the extensions snapshot main publishes where the spec can read it (the shell's own subscription), and ask for one now. */
  const follow = async (): Promise<void> => {
    await shell.evaluate(() => {
      const w = window as unknown as WithExtensions;
      w.pistachio.onExtensions((next) => (w.__ext = next));
    });
    await extensionsRequest(shell, { type: "closePanel" });
  };

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const scratch = await mkdtemp(join(tmpdir(), "pistachio-game-day-"));
    clock = join(scratch, "clock");
    // A Saturday at noon: the window is off, and comes on tomorrow at eight.
    await setClock(at(14, 12));
    ({ app, shell, userData } = await launchDesk({ name: "extensions-triggers", sidebar: "whole", env: { PISTACHIO_E2E_TRIGGER_CLOCK: clock } }));
    [vendor, north] = (await openTabs(shell, [VENDOR, NORTH])) as [string, string];
    await createGroup(shell, FOOTBALL, [vendor, north], "Football", "green");
    await expect(railSpace(shell, FOOTBALL)).toHaveCount(1);
    await settled(shell, app);
    folder = join(scratch, "game-day");
    await cp(FIXTURE, folder, { recursive: true });
    // (The copy's own file events settle first, or main takes them for an edit and reloads it: extensions-capture.spec.)
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await follow();
    await extensionsRequest(shell, { type: "loadFolder", path: folder });
    await expect.poll(async () => (await gameDay(shell))?.pending?.manifestHash ?? null).not.toBeNull();
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("its sheet says when it runs by itself, and the status file lists the week ahead before anyone approves", async () => {
    // ── 1. From the manifest alone, no line of it run: the sheet's words, and the next seven days for whoever wrote it ─
    expect((await gameDay(shell))!.pending!.runs).toEqual([SAYS]);
    const status = JSON.parse(await readFile(join(folder, ".pistachio", "status.json"), "utf8")) as { state: string; triggers: { id: string; says: string; holds?: boolean; next: { iso: string; holds?: boolean }[] }[] };
    expect(status.state).toBe("needs-approval");
    expect(status.triggers).toHaveLength(1);
    expect(status.triggers[0]).toMatchObject({ id: "sunday", says: SAYS, holds: false });
    expect(status.triggers[0]!.next.map((change) => [new Date(change.iso).getTime(), change.holds])).toEqual([
      [at(15, 8), true],
      [at(15, 23), false],
    ]);
    // Nothing of it has run: no worker, nothing heard.
    expect(await heard(userData)).toEqual([]);

    // ── 2. The sheet: "Runs by itself", the trigger in the shell's words, and what it may do then ─
    const icon = shell.locator(`[data-testid="ledge-icon"][data-extension-id="${ID}"]`);
    await expect(icon).toBeVisible({ timeout: 10_000 });
    await icon.click();
    const sheet = shell.getByTestId("extension-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("approval-runs")).toContainText("Runs by itself");
    await expect(sheet.getByTestId("approval-runs-line")).toHaveText([SAYS]);
    await expect(sheet.getByTestId("approval-runs-limit")).toContainText("can be undone");
    await capture(app, shell, "01-sheet-runs-by-itself.png");
    await sheet.getByTestId("extension-sheet-turn-on").click();
    await expect(sheet).toHaveCount(0);

    // ── 3. Approved: it hears what holds now — off, a Saturday — once, and has no space yet to do anything to ─
    await expect.poll(() => heard(userData)).toEqual([false]);
    expect((await gameDay(shell))?.triggers).toEqual([{ id: "sunday", text: SAYS, holds: false, next: at(15, 8) }]);
    expect(await away(shell)).toEqual([]);
  });

  test("/gameday in a space on a Saturday sends it away: the person's own command, not in the journal", async () => {
    await chooseSpace(shell, FOOTBALL);
    const inUse = (await snapshot(shell)).activeTabId!;
    await extensionsRequest(shell, { type: "barCommand", id: ID, command: "gameday", arg: "", spaceId: FOOTBALL, tabId: inUse });
    await expect.poll(async () => (await away(shell)).map((space) => space.id)).toEqual([FOOTBALL]);
    const [sent] = await away(shell);
    expect(sent).toMatchObject({ title: "Football", tabCount: 2, by: { kind: "extension", extensionId: ID, name: "Game day" } });
    // No time on it: the extension holds no clock. Main does.
    expect(sent!.until).toBeUndefined();
    expect((await gameDay(shell))?.journal ?? []).toEqual([]);
    // The worker is not kept for Sunday: nothing of the extension's waits.
    expect(await heard(userData)).toEqual([false]);
  });

  test("closed on Saturday, opened on Sunday morning: the space is back as itself, and main wrote it down", async () => {
    test.setTimeout(120_000);
    // Pistachio is closed with the space away; Sunday eight o'clock passes; it is opened at half past.
    await app.close();
    await setClock(at(15, 8, 30));
    ({ app, shell } = await launchDesk({ name: "extensions-triggers", userData, env: { PISTACHIO_E2E_TRIGGER_CLOCK: clock } }));
    await follow();
    // Nothing of the extension's was running: main's look at the clock, at launch, woke its worker.
    await expect.poll(footballTabs, { timeout: 30_000 }).toEqual([vendor, north]);
    expect(await away(shell)).toEqual([]);
    // Never in front: nobody but the person moves them.
    expect((await snapshot(shell)).currentGroupId).not.toBe(FOOTBALL);
    await expect(railSpace(shell, FOOTBALL)).toHaveCount(1);
    // Heard once: what it heard on Saturday was kept, and is not said again.
    await expect.poll(() => heard(userData)).toEqual([false, true]);
    // What it did with nobody there: who, which trigger, what, to which space.
    await expect.poll(async () => (await gameDay(shell))?.journal?.length ?? 0).toBe(1);
    expect((await gameDay(shell))!.journal![0]).toMatchObject({ extensionId: ID, trigger: "sunday", verb: "bringBack", spaceId: FOOTBALL, title: "Football" });
    expect((await gameDay(shell))?.triggers).toEqual([{ id: "sunday", text: SAYS, holds: true, next: at(15, 23) }]);
    // And what cannot be undone was refused it there.
    expect(await stored<string>(userData, "alone")).toBe("PERMISSION_DENIED");
    // The worker the trigger started is stopped once its handler answered: woken code does not stay.
    await expect.poll(async () => (await gameDay(shell))?.status).toBe("idle");
  });

  test("Sunday night with the person in the space: it waits, and goes once they have moved on", async () => {
    test.setTimeout(90_000);
    await chooseSpace(shell, FOOTBALL);
    await setClock(at(15, 23, 0, 10));
    // Told the window is over, it asks to send the space away and is refused: the person is in it.
    await expect.poll(async () => readFile(join(folder, ".pistachio", "log.ndjson"), "utf8").catch(() => ""), { timeout: 20_000 }).toContain("That space is in front");
    expect(await footballTabs()).toEqual([vendor, north]);
    expect(await away(shell)).toEqual([]);
    expect((await gameDay(shell))?.journal).toHaveLength(1);

    // They go elsewhere; a minute on, main runs the trigger again and the space goes.
    await chooseHome(shell);
    await setClock(at(15, 23, 1, 15));
    await expect.poll(async () => (await away(shell)).map((space) => space.id), { timeout: 20_000 }).toEqual([FOOTBALL]);
    await expect.poll(async () => (await gameDay(shell))?.journal?.map((line) => line.verb)).toEqual(["sendAway", "bringBack"]);
    expect((await gameDay(shell))!.journal![0]).toMatchObject({ trigger: "sunday", verb: "sendAway", spaceId: FOOTBALL });
  });

  test("the Extensions page lists what it did; Undo takes it back, Pause holds it, and lifting the pause catches up", async () => {
    test.setTimeout(90_000);
    await openTabs(shell, ["pistachio://extensions/"]);
    const tab = (await snapshot(shell)).tabs.find((candidate) => candidate.url.startsWith("pistachio://extensions"))!;
    await selectTab(shell, tab.id);
    const section = shell.locator(`[data-testid="extension-triggers"][data-extension-id="${ID}"]`);
    await expect(section).toBeVisible({ timeout: 15_000 });
    await expect(section.getByTestId("extension-trigger-line")).toContainText(SAYS);
    const entries = section.getByTestId("extension-journal-entry");
    await expect(entries).toHaveCount(2);
    await expect(entries.first()).toContainText("Sent “Football” away");
    await expect(entries.nth(1)).toContainText("Brought “Football” back");
    await capture(app, shell, "02-extensions-page-journal.png");

    // ── 1. Undo the newest: the space is back, the same tabs, and the line says so ─
    await entries.first().getByTestId("extension-journal-undo").click();
    await expect.poll(footballTabs).toEqual([vendor, north]);
    expect(await away(shell)).toEqual([]);
    await expect(entries.first().getByTestId("extension-journal-undone")).toBeVisible();
    // An override by hand sticks: the window is still off, and nothing sends the space away again. (Off was said
    // twice on Sunday night: the handler that was refused the space in front, and the one that ran again.)
    const before = await heard(userData);
    expect(before).toEqual([false, true, false, false]);

    // ── 2. Paused: the next Sunday morning comes and nothing is heard ─
    await section.getByTestId("extension-triggers-pause").click();
    await expect.poll(async () => (await gameDay(shell))?.triggersPaused).toBe(true);
    await setClock(at(22, 8, 1));
    await expect.poll(async () => (await gameDay(shell))?.triggers?.[0]?.holds).toBe(true);
    // (The absence is what is tested: four looks of the clock go by.)
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await heard(userData)).toEqual(before);

    // ── 3. Let run again: what changed meanwhile is heard now — late, not lost ─
    await section.getByTestId("extension-triggers-pause").click();
    await expect.poll(async () => (await gameDay(shell))?.triggersPaused ?? false).toBe(false);
    await expect.poll(() => heard(userData), { timeout: 20_000 }).toEqual([...before, true]);
    // (The space was here already: asked to bring it back, nothing is done and nothing more is written.)
    expect((await gameDay(shell))?.journal).toHaveLength(2);
  });

  test("a trigger whose times changed waits on the sheet: nothing runs at times the person has not seen", async () => {
    const manifest = JSON.parse(await readFile(join(folder, "pistachio.json"), "utf8")) as { triggers: { during: { from: string } }[] };
    manifest.triggers[0]!.during.from = "09:00";
    await writeFile(join(folder, "pistachio.json"), JSON.stringify(manifest, null, 2));
    await expect.poll(async () => (await gameDay(shell))?.status, { timeout: 15_000 }).toBe("paused");
    expect((await gameDay(shell))?.pending?.runs).toEqual(["Sundays 9:00 AM–11:00 PM"]);
    // Paused, the clock moving on wakes nothing.
    const before = await heard(userData);
    await setClock(at(22, 23, 0, 30));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await heard(userData)).toEqual(before);
    expect(await footballTabs()).toEqual([vendor, north]);
  });

  test("its triggers taken out of the manifest: what it did is still on the Extensions page, each line with its way back", async () => {
    const lines = (await gameDay(shell))?.journal?.length ?? 0;
    expect(lines).toBeGreaterThan(0);
    const manifest = JSON.parse(await readFile(join(folder, "pistachio.json"), "utf8")) as { triggers?: unknown };
    delete manifest.triggers;
    await writeFile(join(folder, "pistachio.json"), JSON.stringify(manifest, null, 2));
    await expect.poll(async () => (await gameDay(shell))?.triggers?.length ?? 0, { timeout: 15_000 }).toBe(0);
    // Main still has every line; the page still lists them — with nothing left to pause, no Pause.
    expect((await gameDay(shell))?.journal).toHaveLength(lines);
    const tab = (await snapshot(shell)).tabs.find((candidate) => candidate.url.startsWith("pistachio://extensions"))!;
    await selectTab(shell, tab.id);
    const section = shell.locator(`[data-testid="extension-triggers"][data-extension-id="${ID}"]`);
    await expect(section.getByTestId("extension-journal-entry")).toHaveCount(lines, { timeout: 15_000 });
    await expect(section.getByTestId("extension-trigger-line")).toHaveCount(0);
    await expect(section.getByTestId("extension-triggers-pause")).toHaveCount(0);
    await capture(app, shell, "04-extensions-page-journal-no-triggers.png");
  });
});
