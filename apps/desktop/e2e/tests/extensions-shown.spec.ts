/**
 * What the shell draws for an extension (docs/primitives.md §4, stage 3's
 * gate), end to end through a fixture on the public API alone
 * (e2e/fixtures/extensions/stadium): "a stadium backdrop on the Football
 * space while the games are on" — a backdrop in the desk's well, an accent,
 * and a mark on the space's tile, while a window trigger holds.
 *
 * - its sheet says what it may show; an item in the space's own menu gives
 *   it the space, and on a Saturday nothing is shown;
 * - Sunday morning, with nobody there: the backdrop is in the well of that
 *   space alone, from main's own copy of the picture; the accent is the
 *   theme's in every view while the space is in front and the person's own
 *   elsewhere; the tile wears the mark; the journal has the theme with Undo;
 * - Pistachio restarted: all of it is there with no worker running — main
 *   keeps it, nothing of the extension's does;
 * - Sunday night: the trigger takes it all down;
 * - the next Sunday it is back, and the person removes the backdrop from
 *   the space's menu and the mark from the Extensions page.
 *
 * The store, the picture's checks and the scope's rules are
 * extensions-shown.test; the shapes and the contrast rule
 * packages/extension-api/test/theme.test. This proves the wiring only the
 * app has.
 */

import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { ExtensionsSnapshot } from "@pistachio/shell-contracts/extensions";
import { chooseHome, chooseSpace, createGroup, launchDesk, openTabs, railSpace, screenshots, selectTab, settled, snapshot, VENDOR } from "./desk-harness";

const capture = screenshots("extensions-shown");
const ID = "dev.pistachio-e2e.stadium";
const FIXTURE = fileURLToPath(new URL("../fixtures/extensions/stadium", import.meta.url));
const NORTH = "pistachio://demo/invoices?page=north";
const FOOTBALL = "football";
const ACCENT = "#1f8a4c";

/** An instant by this Mac's own clock in November 2026: the 14th is a Saturday, the 15th and the 22nd Sundays. */
const at = (day: number, hour: number, minute = 0, second = 0): number => new Date(2026, 10, day, hour, minute, second).getTime();

type WithExtensions = { pistachio: { extensions(request: unknown): Promise<unknown>; onExtensions(listener: (snapshot: ExtensionsSnapshot) => void): () => void }; __ext?: ExtensionsSnapshot };

function extensionsSnapshot(shell: Page): Promise<ExtensionsSnapshot | null> {
  return shell.evaluate(() => (window as unknown as WithExtensions).__ext ?? null);
}

function extensionsRequest(shell: Page, request: unknown): Promise<unknown> {
  return shell.evaluate((body) => (window as unknown as WithExtensions).pistachio.extensions(body), request);
}

const stadium = async (shell: Page) => (await extensionsSnapshot(shell))?.extensions.find((extension) => extension.id === ID);

async function stored<T>(userData: string, key: string): Promise<T | null> {
  try {
    const values = JSON.parse(await readFile(join(userData, "ExtensionData", ID, "storage.json"), "utf8")) as Record<string, unknown>;
    return (values[key] as T | undefined) ?? null;
  } catch {
    return null;
  }
}

/** The person's own "Open the agent chat on launch", as main wrote it to the settings file; null before it has. */
async function kept(userData: string): Promise<boolean | null> {
  try {
    return (JSON.parse(await readFile(join(userData, "settings.json"), "utf8")) as { general?: { consoleOpenOnLaunch?: boolean } }).general?.consoleOpenOnLaunch ?? null;
  } catch {
    return null;
  }
}

/** The accent the shell draws with now (ThemeRuntime writes it on the root). */
const shellAccent = (shell: Page): Promise<string> => shell.evaluate(() => document.documentElement.style.getPropertyValue("--theme-accent").trim().toLowerCase());

/** The accent of every view of the app that runs the theme — the shell and each chrome view (the Bar's nub, the notices…) — pages left out. */
async function everyAccent(app: ElectronApplication): Promise<string[]> {
  const values = await app.evaluate(async ({ webContents }) => {
    const read = "document.documentElement.style.getPropertyValue('--theme-accent').trim().toLowerCase()";
    return Promise.all(webContents.getAllWebContents().map((contents) => (contents.isDestroyed() ? "" : contents.executeJavaScript(read).catch(() => ""))));
  });
  return (values as string[]).filter((value) => value !== "");
}

test.describe.serial("extensions: a backdrop, an accent and a mark on a space", { tag: ["@extensions"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let userData: string;
  let folder: string;
  let clock: string;
  let own: string;

  const setClock = (instant: number): Promise<void> => writeFile(clock, String(instant));
  const follow = async (): Promise<void> => {
    await shell.evaluate(() => {
      const w = window as unknown as WithExtensions;
      w.pistachio.onExtensions((next) => (w.__ext = next));
    });
    await extensionsRequest(shell, { type: "closePanel" });
  };
  const backdrop = (): Locator => shell.getByTestId("desk-backdrop");
  const mark = (): Locator => railSpace(shell, FOOTBALL).getByTestId("rail-space-mark");
  /** A space's own menu, from its tile on the rail. */
  const spaceMenuItem = async (testId: string): Promise<Locator> => {
    await railSpace(shell, FOOTBALL).click({ button: "right" });
    const item = shell.getByTestId(testId);
    await expect(item).toBeVisible();
    return item;
  };

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const scratch = await mkdtemp(join(tmpdir(), "pistachio-stadium-"));
    clock = join(scratch, "clock");
    await setClock(at(14, 12));
    ({ app, shell, userData } = await launchDesk({ name: "extensions-shown", sidebar: "whole", env: { PISTACHIO_E2E_TRIGGER_CLOCK: clock } }));
    const [vendor, north] = (await openTabs(shell, [VENDOR, NORTH])) as [string, string];
    await createGroup(shell, FOOTBALL, [vendor, north], "Football", "green");
    await expect(railSpace(shell, FOOTBALL)).toHaveCount(1);
    await settled(shell, app);
    // The person's own accent, before any theme.
    own = await shellAccent(shell);
    expect(own).toMatch(/^#[0-9a-f]{6}$/);
    expect(own).not.toBe(ACCENT);
    folder = join(scratch, "stadium");
    await cp(FIXTURE, folder, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await follow();
    await extensionsRequest(shell, { type: "loadFolder", path: folder });
    await expect.poll(async () => (await stadium(shell))?.pending?.manifestHash ?? null).not.toBeNull();
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("its sheet says what it may show; chosen from the space's own menu it is given that space — and on a Saturday shows nothing", async () => {
    const pending = (await stadium(shell))!.pending!;
    expect(pending.can).toContainEqual({ tier: "medium", text: "Changes the backdrop and accent colour of your spaces." });
    expect(pending.can).toContainEqual({ tier: "low", text: "Puts a small mark on the spaces you ran it in." });
    expect(pending.runs).toEqual(["Sundays 8:00 AM–11:00 PM"]);
    await extensionsRequest(shell, { type: "approve", id: ID, manifestHash: pending.manifestHash });
    await expect.poll(async () => (await stadium(shell))?.status).toMatch(/idle|running/);

    // The space's menu, on its tile: the extension's item, under the shell's caption.
    const item = await spaceMenuItem("space-extension-item");
    await expect(item).toContainText("Game day here");
    await capture(app, shell, "01-space-menu.png");
    await item.click();
    await expect.poll(() => stored<string>(userData, "space")).toBe(FOOTBALL);
    // Saturday: the window is off, and nothing is shown.
    await chooseSpace(shell, FOOTBALL);
    await expect(backdrop()).toHaveCount(0);
    await expect(mark()).toHaveCount(0);
    expect(await shellAccent(shell)).toBe(own);
    expect((await stadium(shell))?.shows ?? []).toEqual([]);
  });

  test("Sunday morning, with nobody there: the backdrop in that space's well, the accent in every view, the mark on its tile", async () => {
    test.setTimeout(60_000);
    await setClock(at(15, 8, 0, 30));

    // ── 1. The backdrop: in the well of the space in front, from main's own copy of the picture ─
    await expect(backdrop()).toHaveCount(1, { timeout: 20_000 });
    await expect(backdrop()).toHaveAttribute("data-kind", "image");
    await expect(backdrop()).toHaveAttribute("data-extension-id", ID);
    await expect(backdrop()).toHaveAttribute("data-space-id", FOOTBALL);
    const image = await backdrop().evaluate((element) => (element as HTMLElement).style.backgroundImage);
    expect(image).toMatch(/^url\("pistachio-ext:\/\/theme\/[0-9a-f]{32}\.svg"\)$/);
    // (The picture loads in the shell: main serves it, the shell's own policy allows it.)
    const width = await shell.evaluate(
      (url) =>
        new Promise<number>((resolve) => {
          const picture = new Image();
          picture.onload = () => resolve(picture.naturalWidth);
          picture.onerror = () => resolve(0);
          picture.src = url;
        }),
      image.slice(5, -2),
    );
    expect(width).toBeGreaterThan(0);
    await expect.poll(() => backdrop().evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    await expect(backdrop().locator(".desk-backdrop-scrim")).toHaveCount(1);
    // The Bar's nub is still a hole in the well: the backdrop is clipped as the well is.
    expect(await backdrop().evaluate((element) => getComputedStyle(element.parentElement!).clipPath)).toMatch(/^path\(/);
    await capture(app, shell, "02-sunday-football.png");

    // ── 2. The accent: the theme's, in the shell and in every chrome view alike ─
    await expect.poll(() => shellAccent(shell)).toBe(ACCENT);
    await expect.poll(async () => [...new Set(await everyAccent(app))]).toEqual([ACCENT]);
    expect((await everyAccent(app)).length).toBeGreaterThan(2);

    // ── 3. The mark, on its tile, said as the extension's ─
    await expect(mark()).toHaveText("🏈");
    await expect(mark()).toHaveAttribute("data-tone", "green");
    await expect(railSpace(shell, FOOTBALL)).toHaveAttribute("aria-label", /Stadium: Games on/);

    // ── 4. Written down: a theme set with nobody there, with the trigger that asked ─
    await expect.poll(async () => (await stadium(shell))?.journal?.map((line) => line.verb)).toEqual(["setTheme"]);
    expect((await stadium(shell))!.journal![0]).toMatchObject({ trigger: "sunday", spaceId: FOOTBALL, title: "Football" });
    expect((await stadium(shell))?.shows).toEqual([
      { what: "theme", spaceId: FOOTBALL, space: "Football", detail: "Backdrop and accent" },
      { what: "mark", spaceId: FOOTBALL, space: "Football", detail: "Games on" },
    ]);

    // ── 4b. A setting of the person's own changed meanwhile leaves the theme's accent where it is — drawn (the views
    //        hear the change with the accent in it), and in main's answer to the change, which the shell keeps ─
    await shell.keyboard.press("Meta+,");
    const settings = shell.getByTestId("settings-page");
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "General", exact: true }).click();
    const onLaunch = settings.getByRole("switch", { name: "Open the agent chat on launch" });
    for (const checked of ["true", "false"]) {
      await onLaunch.click();
      await expect(onLaunch).toHaveAttribute("aria-checked", checked);
      await expect.poll(() => kept(userData)).toBe(checked === "true");
      // (Main's answer to the change is in the shell by the time a later question of its is answered, and drawn a frame on.)
      await shell.evaluate(async () => {
        await (window as unknown as { pistachio: { getSettings(): Promise<unknown> } }).pistachio.getSettings();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      expect(await shellAccent(shell)).toBe(ACCENT);
    }
    await shell.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    expect([...new Set(await everyAccent(app))]).toEqual([ACCENT]);
    // (The answer itself, to a change that changes nothing: the settings as shown, the accent in force among them.)
    const answer = await shell.evaluate(() => (window as unknown as { pistachio: { updateSettings(patch: unknown): Promise<{ appearance: { accentOverride?: string } }> } }).pistachio.updateSettings({}));
    expect(answer.appearance.accentOverride).toBe(ACCENT);
    expect(await kept(userData)).toBe(false);

    // ── 5. That space's alone: Home has no backdrop and the person's own accent; back in Football both return ─
    await chooseHome(shell);
    await expect(backdrop()).toHaveCount(0);
    await expect.poll(() => shellAccent(shell)).toBe(own);
    await expect.poll(async () => [...new Set(await everyAccent(app))]).toEqual([own]);
    await expect(mark()).toHaveCount(1);
    await chooseSpace(shell, FOOTBALL);
    await expect(backdrop()).toHaveCount(1);
    await expect.poll(() => shellAccent(shell)).toBe(ACCENT);
  });

  test("Pistachio restarted: it is all there with no worker running — main keeps it, nothing of the extension's does", async () => {
    test.setTimeout(120_000);
    await app.close();
    ({ app, shell } = await launchDesk({ name: "extensions-shown", userData, env: { PISTACHIO_E2E_TRIGGER_CLOCK: clock } }));
    await follow();
    await chooseSpace(shell, FOOTBALL);
    await expect(backdrop()).toHaveCount(1, { timeout: 20_000 });
    await expect(backdrop()).toHaveAttribute("data-space-id", FOOTBALL);
    await expect(mark()).toHaveText("🏈");
    await expect.poll(() => shellAccent(shell)).toBe(ACCENT);
    // The window still holds, and that was heard on Sunday morning: nothing woke the extension to put this back.
    expect((await stadium(shell))?.status).toBe("idle");
    expect(await stored<boolean[]>(userData, "heard")).toEqual([false, false, true]);
    // And what it did is still written down, with its way back.
    expect((await stadium(shell))?.journal?.map((line) => line.verb)).toEqual(["setTheme"]);
  });

  test("Sunday night: the trigger takes it all down; the next Sunday it is back", async () => {
    test.setTimeout(60_000);
    await setClock(at(15, 23, 0, 30));
    await expect(backdrop()).toHaveCount(0, { timeout: 20_000 });
    await expect(mark()).toHaveCount(0);
    await expect.poll(() => shellAccent(shell)).toBe(own);
    expect((await stadium(shell))?.shows ?? []).toEqual([]);
    // (Taking its own down is not written: only what was put up is.)
    expect((await stadium(shell))?.journal?.map((line) => line.verb)).toEqual(["setTheme"]);

    await setClock(at(22, 8, 0, 30));
    await expect(backdrop()).toHaveCount(1, { timeout: 20_000 });
    await expect(mark()).toHaveText("🏈");
    await expect.poll(async () => (await stadium(shell))?.journal?.length).toBe(2);
  });

  test("the person removes the backdrop from the space's own menu, and the mark from the Extensions page", async () => {
    test.setTimeout(60_000);
    // ── 1. The space's menu names whose backdrop it is, and one press takes it off — the accent with it ─
    const remove = await spaceMenuItem("space-remove-backdrop");
    await expect(remove).toHaveText("Remove backdrop · Stadium");
    await remove.click();
    await expect(backdrop()).toHaveCount(0);
    await expect.poll(() => shellAccent(shell)).toBe(own);
    expect((await stadium(shell))?.shows).toEqual([{ what: "mark", spaceId: FOOTBALL, space: "Football", detail: "Games on" }]);
    // Removed by hand, it stays off: the window still holds, and nothing puts it back.
    const heard = await stored<boolean[]>(userData, "heard");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await expect(backdrop()).toHaveCount(0);
    expect(await stored<boolean[]>(userData, "heard")).toEqual(heard);

    // ── 2. The Extensions page lists what it shows, each with Remove ─
    await openTabs(shell, ["pistachio://extensions/"]);
    const tab = (await snapshot(shell)).tabs.find((candidate) => candidate.url.startsWith("pistachio://extensions"))!;
    await selectTab(shell, tab.id);
    const shows = shell.locator(`[data-testid="extension-shows"][data-extension-id="${ID}"]`);
    await expect(shows).toBeVisible({ timeout: 15_000 });
    const row = shows.locator('[data-testid="extension-shown"][data-what="mark"]');
    await expect(row).toContainText("Mark on “Football” · Games on");
    await capture(app, shell, "03-what-it-shows.png");
    await row.getByTestId("extension-shown-remove").click();
    await expect(mark()).toHaveCount(0);
    await expect(shows).toHaveCount(0);
  });
});
