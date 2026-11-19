/**
 * A space an extension makes by itself (docs/primitives.md §2.7), end to end
 * through the wish that asked for the verb: "every weekday at 5:30 PM a new
 * space called Chess time with one tab on chess.com, closed again at 6:00 PM"
 * (e2e/fixtures/extensions/chess-time, as an agent would write it). The spec
 * moves the clock main reads triggers against (PISTACHIO_E2E_TRIGGER_CLOCK),
 * never the extension's code; the page's address is a local one.
 *
 * - the sheet says when it runs, that it makes spaces and closes them, and
 *   that one it made can be closed while the person is in it;
 * - half past five, with nobody there: the space is on the rail under its
 *   name with its tab, behind what is in front; main says so, with Show, and
 *   writes it down;
 * - six o'clock with the person in it: it closes all the same — the desk
 *   passes on — and is filed in the archive, said with Undo;
 * - the next day it is made again; the journal's Undo closes it, and six
 *   o'clock, finding nothing left to close, fails nothing.
 *
 * The verb, its limits and the sheet's words are space-making.test and
 * extensions-making.test. This proves the wiring only the app has: main's
 * clock waking a stopped worker, a real space and tab made in the session
 * without the person being moved, the desk passing on at the close.
 */

import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { ExtensionsSnapshot } from "@pistachio/shell-contracts/extensions";
import { launchDesk, railSpace, screenshots, settled, snapshot } from "./desk-harness";
import { noticePage } from "./windows";

const capture = screenshots("extensions-chess-time");
const ID = "dev.pistachio-e2e.chess-time";
const FIXTURE = fileURLToPath(new URL("../fixtures/extensions/chess-time", import.meta.url));
const SAYS = "Weekdays 5:30 PM–6:00 PM";
const LIMIT =
  "With nobody there it can only make new spaces and close spaces you gave it into the archive. A space it made counts as one you gave it, and can be closed while you are in it. What it does to your spaces and tabs is listed, and can be undone.";
const BOARD = "<!doctype html><title>Chess</title><body style=\"margin:0;font:600 28px system-ui;display:grid;place-items:center;height:100vh;background:#312e2b;color:#fff\">Chess</body>";

/** An instant by this Mac's own clock in November 2026: the 16th is a Monday, the 17th a Tuesday. */
const at = (day: number, hour: number, minute = 0, second = 0): number => new Date(2026, 10, day, hour, minute, second).getTime();

type WithExtensions = { pistachio: { extensions(request: unknown): Promise<unknown>; onExtensions(listener: (snapshot: ExtensionsSnapshot) => void): () => void }; __ext?: ExtensionsSnapshot };

function extensionsSnapshot(shell: Page): Promise<ExtensionsSnapshot | null> {
  return shell.evaluate(() => (window as unknown as WithExtensions).__ext ?? null);
}

function extensionsRequest(shell: Page, request: unknown): Promise<unknown> {
  return shell.evaluate((body) => (window as unknown as WithExtensions).pistachio.extensions(body), request);
}

const chessTime = async (shell: Page) => (await extensionsSnapshot(shell))?.extensions.find((extension) => extension.id === ID);

/** The window in front, as far as main can tell: what a notice held for somebody to read waits for. */
async function inFront(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible());
    if (window === undefined) return;
    window.focus();
    if (!window.isFocused()) window.emit("focus");
  });
}

test.describe.serial("extensions: a space made at half past five and closed at six", { tag: ["@extensions"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let userData: string;
  let folder: string;
  let clock: string;
  let server: Server;
  let pageUrl: string;
  /** The space Monday's half hour made. */
  let monday: string;

  const setClock = (instant: number): Promise<void> => writeFile(clock, String(instant));
  /** What the fixture left in its storage under `key` (main's file of it), or null. */
  const stored = async <T,>(key: string): Promise<T | null> => {
    try {
      const values = JSON.parse(await readFile(join(userData, "ExtensionData", ID, "storage.json"), "utf8")) as Record<string, unknown>;
      return (values[key] as T | undefined) ?? null;
    } catch {
      return null;
    }
  };
  const heard = async (): Promise<boolean[]> => (await stored<boolean[]>("heard")) ?? [];
  /** The spaces called Chess time that are here. */
  const chessSpaces = async () => (await snapshot(shell)).tabGroups.filter((group) => group.title === "Chess time");
  const archivedTitles = async (): Promise<string[]> => {
    const profileId = (await snapshot(shell)).tabs[0]!.spaceId;
    const response = await shell.evaluate((spaceId) => (window as unknown as { pistachio: { tabArchive(request: unknown): Promise<{ entries?: { kind: string; group?: { title: string } }[] }> } }).pistachio.tabArchive({ type: "list", spaceId }), profileId);
    return (response.entries ?? []).flatMap((entry) => (entry.kind === "group" && entry.group !== undefined ? [entry.group.title] : []));
  };
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
    // The page's first answer comes later than a trigger's handler is given (ten seconds): the space is made, and its
    // id handed back, when its tab stands in it — not when chess.com has finished loading.
    let asked = 0;
    server = createServer((_request, response) => {
      asked += 1;
      const answer = (): void => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(BOARD);
      };
      if (asked === 1) setTimeout(answer, 14_000);
      else answer();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("the page's server did not bind");
    pageUrl = `http://localhost:${String(address.port)}/`;

    const scratch = await mkdtemp(join(tmpdir(), "pistachio-chess-time-"));
    clock = join(scratch, "clock");
    // A Monday at noon: the half hour is off, and comes on at 5:30.
    await setClock(at(16, 12));
    ({ app, shell, userData } = await launchDesk({ name: "extensions-chess-time", sidebar: "whole", env: { PISTACHIO_E2E_TRIGGER_CLOCK: clock } }));
    await settled(shell, app);
    folder = join(scratch, "chess-time");
    await cp(FIXTURE, folder, { recursive: true });
    // (The page is a local one: the spec's Mac may be offline. Nothing else of the extension is changed.)
    const worker = await readFile(join(folder, "worker.js"), "utf8");
    expect(worker).toContain('"https://www.chess.com/"');
    await writeFile(join(folder, "worker.js"), worker.replace('"https://www.chess.com/"', JSON.stringify(pageUrl)));
    // (The copy's own file events settle first, or main takes them for an edit and reloads it: extensions-capture.spec.)
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await follow();
    await extensionsRequest(shell, { type: "loadFolder", path: folder });
    await expect.poll(async () => (await chessTime(shell))?.pending?.manifestHash ?? null).not.toBeNull();
  });

  test.afterAll(async () => {
    await app?.close();
    server?.close();
  });

  test("its sheet says when it runs, what it can do, and that a space it made can close while you are in it", async () => {
    // ── 1. From the manifest alone, no line of it run ─
    const pending = (await chessTime(shell))!.pending!;
    expect(pending.runs).toEqual([SAYS]);
    expect(pending.runsLimit).toBe(LIMIT);
    expect(pending.can.map((line) => line.text)).toEqual(["Makes new spaces and opens pages in them.", "Closes spaces into the archive, where they can be restored."]);
    const status = JSON.parse(await readFile(join(folder, ".pistachio", "status.json"), "utf8")) as { state: string; triggers: { id: string; says: string; holds?: boolean; next: { iso: string; holds?: boolean }[] }[] };
    expect(status.triggers[0]).toMatchObject({ id: "chess", says: SAYS, holds: false });
    expect(status.triggers[0]!.next.slice(0, 4).map((change) => [new Date(change.iso).getTime(), change.holds])).toEqual([
      [at(16, 17, 30), true],
      [at(16, 18), false],
      [at(17, 17, 30), true],
      [at(17, 18), false],
    ]);
    expect(await heard()).toEqual([]);

    // ── 2. The sheet, as the person reads it ─
    const icon = shell.locator(`[data-testid="ledge-icon"][data-extension-id="${ID}"]`);
    await expect(icon).toBeVisible({ timeout: 10_000 });
    await icon.click();
    const sheet = shell.getByTestId("extension-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("approval-runs-line")).toHaveText([SAYS]);
    await expect(sheet.getByTestId("approval-runs-limit")).toContainText("can be closed while you are in it");
    await capture(app, shell, "01-sheet.png");
    await sheet.getByTestId("extension-sheet-turn-on").click();
    await expect(sheet).toHaveCount(0);

    // ── 3. Approved at noon: it hears that the half hour is off, and makes nothing ─
    await expect.poll(heard).toEqual([false]);
    expect(await chessSpaces()).toEqual([]);
    expect((await chessTime(shell))?.journal ?? []).toEqual([]);
  });

  test("half past five, with nobody there: the space is made behind what is in front, said with Show, and written down", async () => {
    test.setTimeout(90_000);
    const before = await snapshot(shell);
    await setClock(at(16, 17, 30, 5));

    // ── 1. Made: one space under its name, one tab on the page asked for ─
    await expect.poll(async () => (await chessSpaces()).map((group) => group.tabIds.length), { timeout: 30_000 }).toEqual([1]);
    const [made] = await chessSpaces();
    monday = made!.id;
    const after = await snapshot(shell);
    expect(after.tabs.find((tab) => tab.id === made!.tabIds[0])?.url).toBe(pageUrl);
    await expect(railSpace(shell, monday)).toHaveCount(1);
    // Nobody is moved by code: what was in front still is.
    expect(after.currentGroupId).toBe(before.currentGroupId);
    expect(after.activeTabId).toBe(before.activeTabId);
    await expect.poll(heard).toEqual([false, true]);
    expect(await stored<string>("space")).toBe(monday);

    // ── 2. Written down: who, which trigger, what ─
    await expect.poll(async () => (await chessTime(shell))?.journal?.length ?? 0).toBe(1);
    expect((await chessTime(shell))!.journal![0]).toMatchObject({ extensionId: ID, trigger: "chess", verb: "makeSpace", spaceId: monday, title: "Chess time" });

    // ── 3. Said, once somebody is there — and Show chooses it ─
    await inFront(app);
    const notices = await noticePage(app);
    const said = notices.locator('[data-testid="notice-card"][data-phase="live"]').filter({ hasText: "New space “Chess time” · 1 tab · Chess time" });
    await expect(said).toBeVisible();
    await capture(app, shell, "02-made.png");
    await said.getByRole("button", { name: "Show" }).click();
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).toBe(monday);
    await expect(shell.locator(`.desk-stage[data-phase="open"][data-group-id="${monday}"]`)).toHaveCount(1);
    await settled(shell, app);
    await capture(app, shell, "03-in-chess-time.png");
  });

  test("six o'clock with the person in it: it closes all the same, the desk passes on, and Undo is there", async () => {
    test.setTimeout(90_000);
    expect((await snapshot(shell)).currentGroupId).toBe(monday);
    await setClock(at(16, 18, 0, 5));

    // ── 1. Closed, from in front: the space is gone from the rail and the desk has passed on ─
    await expect.poll(chessSpaces, { timeout: 30_000 }).toEqual([]);
    await expect(railSpace(shell, monday)).toHaveCount(0);
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).not.toBe(monday);
    await expect.poll(heard).toEqual([false, true, false]);
    await expect.poll(() => stored<string>("space")).toBeNull();

    // ── 2. Filed, not lost — and written down with the way back ─
    expect(await archivedTitles()).toEqual(["Chess time"]);
    await expect.poll(async () => (await chessTime(shell))?.journal?.map((line) => line.verb)).toEqual(["closeSpace", "makeSpace"]);
    expect((await chessTime(shell))!.journal![0]).toMatchObject({ trigger: "chess", verb: "closeSpace", spaceId: monday, title: "Chess time" });

    // ── 3. Said, with who did it and Undo ─
    await inFront(app);
    const notices = await noticePage(app);
    const said = notices.locator('[data-testid="notice-card"][data-phase="live"]').filter({ hasText: "Closed “Chess time” · 1 tab · Chess time" });
    await expect(said).toBeVisible();
    await expect(said.getByRole("button", { name: "Undo" })).toBeVisible();
    await capture(app, shell, "04-closed-at-six.png");
  });

  test("the next day it is made again; the journal's Undo closes it, and six o'clock fails nothing", async () => {
    test.setTimeout(90_000);
    await setClock(at(17, 17, 31));
    await expect.poll(async () => (await chessSpaces()).length, { timeout: 30_000 }).toBe(1);
    const [tuesday] = await chessSpaces();
    // Another space, not Monday's brought back: each day's is made.
    expect(tuesday!.id).not.toBe(monday);
    await expect.poll(async () => (await chessTime(shell))?.journal?.[0]?.verb).toBe("makeSpace");
    const line = (await chessTime(shell))!.journal![0]!;
    expect(line).toMatchObject({ spaceId: tuesday!.id, title: "Chess time" });

    // ── 1. Undo what it made: closed as the person's own Close space does it ─
    await extensionsRequest(shell, { type: "undoJournal", entry: line.id });
    await expect.poll(chessSpaces).toEqual([]);
    await expect.poll(async () => (await chessTime(shell))?.journal?.[0]?.undone ?? null).not.toBeNull();
    expect(await archivedTitles()).toEqual(["Chess time", "Chess time"]);

    // ── 2. Six o'clock: nothing is left to close, and the handler says so to nobody ─
    await setClock(at(17, 18, 0, 5));
    await expect.poll(heard, { timeout: 30_000 }).toEqual([false, true, false, true, false]);
    await expect.poll(() => stored<string>("space")).toBeNull();
    const status = JSON.parse(await readFile(join(folder, ".pistachio", "status.json"), "utf8")) as { runtimeErrors: unknown[] };
    expect(status.runtimeErrors).toEqual([]);
    // (Nothing more was written down: a close that found nothing changed nothing.)
    expect((await chessTime(shell))?.journal?.map((entry) => entry.verb)).toEqual(["makeSpace", "closeSpace", "makeSpace"]);
  });
});
