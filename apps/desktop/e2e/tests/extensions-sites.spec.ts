/**
 * The places an extension fills with rows (docs/primitives.md §4.5, stage
 * 4's gate), end to end through a fixture on the public API alone
 * (e2e/fixtures/extensions/scoreboard): "show today's games in a strip
 * beside the Bar on Sundays" — rows in the band, in the Bar's lane, and in
 * a section of the sidebar, while a window trigger holds.
 *
 * - its sheet says what it adds; an item in the space's own menu gives it
 *   the space, and on a Saturday nothing is shown;
 * - Sunday morning, with nobody there: the strip's chips lie in the lane in
 *   every space — in the shell's row, and in main's notch view over a live
 *   page — and the section is in the sidebar of that space alone;
 * - a press on a row, on a row's button, and on a chip in the notch view
 *   each wake the extension with what was pressed;
 * - an item in a tab's own menu wakes it with that tab;
 * - Pistachio restarted: the rows are there with no worker running;
 * - Sunday night takes them down, the next Sunday they are back, and the
 *   person removes the section with its × and the strip with its own.
 *
 * The store and the scope's rules are extensions-sites.test; the shapes
 * packages/extension-api/test/sites.test; the shell's reading
 * packages/shell-ui/test/extension-shown.test. This proves the wiring only
 * the app has.
 */

import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { ExtensionsSnapshot } from "@pistachio/shell-contracts/extensions";
import { chooseHome, chooseSpace, createGroup, launchDesk, openTabs, railSpace, rowSelector, screenshots, settled, VENDOR } from "./desk-harness";

const capture = screenshots("extensions-sites", ["notch"]);
const ID = "dev.pistachio-e2e.scoreboard";
const FIXTURE = fileURLToPath(new URL("../fixtures/extensions/scoreboard", import.meta.url));
const NORTH = "pistachio://demo/invoices?page=north";
const FOOTBALL = "football";

/** An instant by this Mac's own clock in November 2026: the 14th is a Saturday, the 15th and the 22nd Sundays. */
const at = (day: number, hour: number, minute = 0, second = 0): number => new Date(2026, 10, day, hour, minute, second).getTime();

type WithExtensions = { pistachio: { extensions(request: unknown): Promise<unknown>; onExtensions(listener: (snapshot: ExtensionsSnapshot) => void): () => void }; __ext?: ExtensionsSnapshot };

function extensionsSnapshot(shell: Page): Promise<ExtensionsSnapshot | null> {
  return shell.evaluate(() => (window as unknown as WithExtensions).__ext ?? null);
}

function extensionsRequest(shell: Page, request: unknown): Promise<unknown> {
  return shell.evaluate((body) => (window as unknown as WithExtensions).pistachio.extensions(body), request);
}

const scoreboard = async (shell: Page) => (await extensionsSnapshot(shell))?.extensions.find((extension) => extension.id === ID);

async function stored<T>(userData: string, key: string): Promise<T | null> {
  try {
    const values = JSON.parse(await readFile(join(userData, "ExtensionData", ID, "storage.json"), "utf8")) as Record<string, unknown>;
    return (values[key] as T | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Main's notch view while it is on screen: run `script` in it; null when it is not up. */
function inNotch<T>(app: ElectronApplication, script: string): Promise<T | null> {
  return app.evaluate(async ({ BrowserWindow }, code) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window?.contentView.children.find(
      (child) => "webContents" in child && (child as Electron.WebContentsView).webContents.getURL().endsWith("#notch") && child.getVisible(),
    ) as Electron.WebContentsView | undefined;
    if (view === undefined) return null;
    return (await view.webContents.executeJavaScript(code)) as never;
  }, script) as Promise<T | null>;
}

/** What the band's chips say in the notch view, in the order they are in its DOM. */
const notchRows = (app: ElectronApplication): Promise<string[] | null> =>
  inNotch<string[]>(app, `[...document.querySelectorAll('[data-testid="extension-band-row"]')].map((el) => el.querySelector('.extension-status-text')?.textContent ?? "")`);

test.describe.serial("extensions: rows in the band beside the Bar and in a section of the sidebar", { tag: ["@extensions"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let userData: string;
  let folder: string;
  let clock: string;
  let vendor: string;

  const setClock = (instant: number): Promise<void> => writeFile(clock, String(instant));
  const follow = async (): Promise<void> => {
    await shell.evaluate(() => {
      const w = window as unknown as WithExtensions;
      w.pistachio.onExtensions((next) => (w.__ext = next));
    });
    await extensionsRequest(shell, { type: "closePanel" });
  };
  /** The band's chips in the shell's own row (the lane), and the sidebar's section. */
  const chips = (): Locator => shell.locator(`[data-testid="extension-status-pills"] [data-testid="extension-band-row"][data-extension-id="${ID}"]`);
  const band = (): Locator => shell.locator(`[data-testid="extension-status-pills"] [data-testid="extension-band"][data-extension-id="${ID}"]`);
  const section = (): Locator => shell.locator(`[data-testid="extension-section"][data-extension-id="${ID}"]`);
  const sectionRow = (row: string): Locator => section().locator(`[data-testid="extension-section-row"][data-row="${row}"]`);
  const presses = (): Promise<unknown[]> => stored<unknown[]>(userData, "presses").then((kept) => kept ?? []);

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const scratch = await mkdtemp(join(tmpdir(), "pistachio-scoreboard-"));
    clock = join(scratch, "clock");
    await setClock(at(14, 12));
    ({ app, shell, userData } = await launchDesk({ name: "extensions-sites", sidebar: "whole", env: { PISTACHIO_E2E_TRIGGER_CLOCK: clock } }));
    const [first, north] = (await openTabs(shell, [VENDOR, NORTH])) as [string, string];
    vendor = first;
    // (A space of tabs: its page fills the desk, so a live page lies under the Bar's lane.)
    await createGroup(shell, FOOTBALL, [vendor, north], "Football", "green", { windows: false });
    await expect(railSpace(shell, FOOTBALL)).toHaveCount(1);
    await settled(shell, app);
    folder = join(scratch, "scoreboard");
    await cp(FIXTURE, folder, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await follow();
    await extensionsRequest(shell, { type: "loadFolder", path: folder });
    await expect.poll(async () => (await scoreboard(shell))?.pending?.manifestHash ?? null).not.toBeNull();
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("its sheet says what it adds; chosen from the space's own menu it is given that space — and on a Saturday shows nothing", async () => {
    const pending = (await scoreboard(shell))!.pending!;
    expect(pending.adds).toEqual(["a strip beside the Bar", "a section in the sidebar", "2 items in the right-click menu"]);
    // A place is no capability: it asks for nothing of the person's.
    expect(pending.can).toEqual([]);
    expect(pending.runs).toEqual(["Sundays 8:00 AM–11:00 PM"]);
    await extensionsRequest(shell, { type: "approve", id: ID, manifestHash: pending.manifestHash });
    await expect.poll(async () => (await scoreboard(shell))?.status).toMatch(/idle|running/);

    await railSpace(shell, FOOTBALL).click({ button: "right" });
    const item = shell.getByTestId("space-extension-item");
    await expect(item).toContainText("Games here");
    await item.click();
    // An extension that only shows rows is given the space all the same: its section is for that space.
    await expect.poll(() => stored<string>(userData, "space")).toBe(FOOTBALL);
    await chooseSpace(shell, FOOTBALL);
    await expect(chips()).toHaveCount(0);
    await expect(section()).toHaveCount(0);
    expect((await scoreboard(shell))?.shows ?? []).toEqual([]);
  });

  test("Sunday morning, with nobody there: the strip's chips in the Bar's lane in every space, the section in that space's sidebar", async () => {
    test.setTimeout(60_000);
    await setClock(at(15, 8, 0, 30));

    // ── 1. The strip: two chips in the lane, the shell's own rows with the extension's words inside ─
    await expect(chips()).toHaveCount(2, { timeout: 20_000 });
    await expect(chips().nth(0)).toHaveAttribute("data-row", "game:kc-buf");
    await expect(chips().nth(0)).toHaveAttribute("data-scope", "*");
    await expect(chips().nth(0).locator(".extension-status-text")).toHaveText("KC 21 – BUF 17");
    await expect(chips().nth(0).locator(".shown-row-value")).toHaveText("4:12");
    await expect(chips().nth(0).locator(".shown-row-mark")).toHaveAttribute("data-tone", "red");
    // They are one group, the extension's, under its mark, in the rows' own order; each says whose it is to a screen reader.
    await expect(band()).toHaveAttribute("aria-label", "Scoreboard");
    await expect(band().locator(".extension-mark")).toHaveCount(1);
    await expect(chips().nth(1).locator(".extension-status-text")).toHaveText("DAL 3 – PHI 10");
    await expect(chips().nth(1).getByTestId("extension-band-press")).toHaveAttribute("aria-label", "Scoreboard: DAL 3 – PHI 10, 9:40");
    const [kc, dal] = await Promise.all([chips().nth(0).boundingBox(), chips().nth(1).boundingBox()]);
    expect(kc!.x).toBeLessThan(dal!.x);
    // The nub is drawn out along the foot for them, as it is for a live pill.
    await expect(shell.getByTestId("extension-status-pills")).toHaveAttribute("data-shown", "");

    // ── 2. Over a live page main's notch view draws the same chips ─
    await settled(shell, app);
    await expect.poll(() => notchRows(app), { timeout: 10_000 }).toEqual(["KC 21 – BUF 17", "DAL 3 – PHI 10"]);
    await capture(app, shell, "01-sunday-football.png");

    // ── 3. The section: in the sidebar's card for the space it was given, under the title it gave ─
    await expect(section()).toHaveCount(1);
    await expect(section()).toHaveAttribute("data-scope", FOOTBALL);
    await expect(section().getByTestId("extension-section-title")).toHaveText("Today’s games");
    await expect(section().getByTestId("extension-section-row")).toHaveCount(3);
    await expect(sectionRow("game:sf-sea").locator(".extension-section-text")).toHaveText("SF at SEA");
    await expect(sectionRow("game:sf-sea").locator(".shown-row-detail")).toHaveText("4:25 PM");
    // (A row's button comes up in its value's place while the pointer is on the row.)
    await sectionRow("game:kc-buf").hover();
    await expect(sectionRow("game:kc-buf").getByTestId("extension-section-button")).toHaveText("Open");

    // ── 4. Listed as its own, and written in no journal: the rows say whose they are where they are ─
    expect((await scoreboard(shell))?.shows).toEqual([
      { what: "band", spaceId: null, space: "", detail: "KC 21 – BUF 17" },
      { what: "sidebar", spaceId: FOOTBALL, space: "Football", detail: "Today’s games" },
    ]);
    expect((await scoreboard(shell))?.journal ?? []).toEqual([]);

    // ── 5. Home: the strip is for every space; the section is Football's alone ─
    await chooseHome(shell);
    await expect(chips()).toHaveCount(2);
    await expect(section()).toHaveCount(0);
    await chooseSpace(shell, FOOTBALL);
    await expect(section()).toHaveCount(1);
  });

  test("a press on a row, on its button, and on a chip in the notch view each wake the extension with what was pressed", async () => {
    test.setTimeout(60_000);
    // ── 1. A row of the section, pressed whole ─
    await sectionRow("game:dal-phi").getByTestId("extension-section-press").click();
    await expect.poll(presses).toEqual([{ site: "sidebar", row: "game:dal-phi", button: null, spaceId: FOOTBALL }]);
    // The handler said the rows again: Pistachio draws what it now keeps, in both places.
    await expect(sectionRow("game:dal-phi").locator(".shown-row-detail")).toHaveText("Following");
    await expect(chips().nth(1).locator(".shown-row-detail")).toHaveText("Following");

    // ── 2. A row's button, on its own ─
    await sectionRow("game:kc-buf").hover();
    await sectionRow("game:kc-buf").getByTestId("extension-section-button").click();
    await expect.poll(async () => (await presses())[1]).toEqual({ site: "sidebar", row: "game:kc-buf", button: "open", spaceId: FOOTBALL });
    await expect(sectionRow("game:kc-buf").locator(".shown-row-detail")).toHaveText("Following");

    // ── 3. A chip in main's notch view, over the live page: the press comes back through the shell ─
    await settled(shell, app);
    const clicked = await inNotch<boolean>(
      app,
      `(() => { const chip = document.querySelector('[data-testid="extension-band-row"][data-row="game:dal-phi"] [data-testid="extension-band-press"]'); if (!chip) return false; chip.click(); return true; })()`,
    );
    expect(clicked).toBe(true);
    await expect.poll(async () => (await presses())[2]).toEqual({ site: "band", row: "game:dal-phi", button: null, spaceId: FOOTBALL });

    // ── 4. A press names only what main keeps: one for a row that is not there wakes nobody ─
    await extensionsRequest(shell, { type: "press", id: ID, site: "band", scope: null, row: "game:nobody", button: null });
    await extensionsRequest(shell, { type: "press", id: ID, site: "sidebar", scope: null, row: "game:kc-buf", button: null });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await presses()).toHaveLength(3);
    // And a press gives the extension no space: it still holds the one it was given, and no other.
    await capture(app, shell, "02-following.png");
  });

  test("an item in a tab's own menu wakes it with that tab", async () => {
    await shell.locator(rowSelector(vendor)).click({ button: "right" });
    const item = shell.getByTestId("tab-extension-item");
    await expect(item).toContainText("Follow this game");
    // (A space's item is not offered on a tab, nor a tab's on a space.)
    await expect(shell.getByTestId("space-extension-item")).toHaveCount(0);
    await item.click();
    await expect.poll(() => stored<{ tabId: string; pageUrl: string; fromTab: boolean }>(userData, "followed")).toEqual({ tabId: vendor, pageUrl: VENDOR, fromTab: true });
    // Main checks where an item is for: the space's item is refused from a tab, in a sentence.
    const refused = await shell.evaluate(
      async ({ id, tabId }) => {
        try {
          await (window as unknown as WithExtensions).pistachio.extensions({ type: "menu", id, item: "here", click: { tabId, pageUrl: null, fromTab: true } });
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      { id: ID, tabId: vendor },
    );
    expect(refused).toContain("is not for a tab's menu");
  });

  test("Pistachio restarted: the rows are there with no worker running — main keeps them, nothing of the extension's does", async () => {
    test.setTimeout(120_000);
    await app.close();
    ({ app, shell } = await launchDesk({ name: "extensions-sites", userData, env: { PISTACHIO_E2E_TRIGGER_CLOCK: clock } }));
    await follow();
    await chooseSpace(shell, FOOTBALL);
    await expect(chips()).toHaveCount(2, { timeout: 20_000 });
    await expect(chips().nth(1).locator(".shown-row-detail")).toHaveText("Following");
    await expect(section().getByTestId("extension-section-row")).toHaveCount(3);
    // (As the last press left them: the chip pressed in the notch view was DAL – PHI's.)
    await expect(sectionRow("game:dal-phi").locator(".shown-row-detail")).toHaveText("Following");
    await expect(sectionRow("game:kc-buf").locator(".shown-row-detail")).toHaveText("3rd quarter");
    // The window still holds, and that was heard on Sunday morning: nothing woke the extension to put these back.
    expect((await scoreboard(shell))?.status).toBe("idle");
    expect(await stored<boolean[]>(userData, "heard")).toEqual([false, false, true]);
    // A press still finds its worker: it is woken for it.
    await sectionRow("game:sf-sea").getByTestId("extension-section-press").click();
    await expect.poll(async () => (await presses())[3]).toEqual({ site: "sidebar", row: "game:sf-sea", button: null, spaceId: FOOTBALL });
    await expect(sectionRow("game:sf-sea").locator(".shown-row-detail")).toHaveText("Following");
  });

  test("Sunday night takes them down; the next Sunday they are back, and the person removes each with its own ×", async () => {
    test.setTimeout(90_000);
    await setClock(at(15, 23, 0, 30));
    await expect(chips()).toHaveCount(0, { timeout: 20_000 });
    await expect(section()).toHaveCount(0);
    expect((await scoreboard(shell))?.shows ?? []).toEqual([]);

    await setClock(at(22, 8, 0, 30));
    await expect(chips()).toHaveCount(2, { timeout: 20_000 });
    await expect(section()).toHaveCount(1);

    // ── 1. The section's ×, on its head: gone at once ─
    await section().hover();
    const removeSection = section().getByTestId("extension-section-remove");
    await expect(removeSection).toHaveAttribute("aria-label", "Remove Scoreboard’s section");
    await removeSection.click();
    await expect(section()).toHaveCount(0);
    expect((await scoreboard(shell))?.shows).toEqual([{ what: "band", spaceId: null, space: "", detail: "KC 21 – BUF 17" }]);

    // ── 2. The strip's ×: the extension's mark at its head, while the pointer is on the strip ─
    const removeStrip = band().getByTestId("extension-band-remove");
    await expect(removeStrip).toHaveAttribute("aria-label", "Remove Scoreboard’s strip");
    await band().hover();
    await removeStrip.click();
    await expect(chips()).toHaveCount(0);
    expect((await scoreboard(shell))?.shows ?? []).toEqual([]);

    // Removed by hand, they stay off: the window still holds, and nothing puts them back.
    const heard = await stored<boolean[]>(userData, "heard");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await expect(chips()).toHaveCount(0);
    await expect(section()).toHaveCount(0);
    expect(await stored<boolean[]>(userData, "heard")).toEqual(heard);
  });
});
