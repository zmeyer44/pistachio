/**
 * The sidebar's three modes on the desk (docs/spaces.md §3): whole, a rail,
 * or hidden until the pointer comes to the window's edge — one setting
 * (`layout.sidebar`), ⌘S cycling whole → rail → hidden. Whole and rail are
 * the column in the layout, the desk beside it rescaling its windows; hidden
 * on the desk is an OVERLAY: the slot stays its strip, the stage never moves,
 * and the column brought out is a cover over the desk — the windows under it
 * give way to their stills before it slides in, and it goes on main's word
 * that the OS pointer has left it. A window carried to the leading edge, or
 * resized from the west edge of one flush with it, never brings it out; a
 * window put away goes into the window's edge; a row pulled out of the
 * overlaid column is in hand as the column goes; a card it opened holds it.
 *
 * The OS pointer is main's `screen.getCursorScreenPoint`, stubbed here
 * (PISTACHIO_E2E_CURSOR lets main read it under Playwright), as
 * desk-bar-pointer.spec does. The pure parts — the cycle, the overlay's state
 * machine, the trigger's width — are sidebar-modes.test's and
 * sidebar-pointer.test's.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { SIDEBAR_DEFAULT_W, SIDEBAR_EDGE_W, SIDEBAR_RAIL_W } from "@pistachio/shell-contracts/chrome";
import type { SidebarMode } from "@pistachio/shell-contracts/settings";
import {
  box,
  center,
  createGroup,
  INVOICES,
  launchDesk,
  selectSpace,
  openMore,
  openTabs,
  rowSelector,
  screenshots,
  selectTab,
  settled,
  VENDOR,
  windowSelector,
  type Box,
} from "./desk-harness";

const capture = screenshots("sidebar-modes");
const SLOT = '[data-testid="sidebar-motion-slot"]';
const PANE = '[data-testid="sidebar-pane"]';

/** Where the OS's pointer is, in the window's content box, from now on. */
function pointerAt(app: ElectronApplication, x: number, y: number): Promise<void> {
  return app.evaluate(
    ({ BrowserWindow, screen }, at) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("Pistachio window is unavailable");
      const state = globalThis as unknown as { __pointer?: { x: number; y: number } };
      state.__pointer = at;
      screen.getCursorScreenPoint = () => {
        const content = window.getContentBounds();
        return { x: content.x + state.__pointer!.x, y: content.y + state.__pointer!.y };
      };
    },
    { x, y },
  );
}

/** Every time main shows or hides the window's buttons from now on — and, first, as main has them now (Electron's own getter). */
function recordButtons(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const record = globalThis as unknown as { buttons: boolean[]; buttonsHooked?: boolean };
    const shown = (window as unknown as { _getWindowButtonVisibility?: () => boolean })._getWindowButtonVisibility?.call(window);
    record.buttons = shown === undefined ? [] : [shown];
    if (record.buttonsHooked === true) return;
    record.buttonsHooked = true;
    const set = window.setWindowButtonVisibility.bind(window);
    window.setWindowButtonVisibility = (visible: boolean) => {
      record.buttons.push(visible);
      set(visible);
    };
  });
}

const buttonsNow = (app: ElectronApplication): Promise<boolean | undefined> => app.evaluate(() => (globalThis as unknown as { buttons: boolean[] }).buttons.at(-1));

async function storedMode(userData: string): Promise<SidebarMode | null> {
  try {
    return (JSON.parse(await readFile(join(userData, "settings.json"), "utf8")) as { layout?: { sidebar?: SidebarMode } }).layout?.sidebar ?? null;
  } catch {
    return null;
  }
}

/** The hidden column's edge under the pointer — the OS's and the shell's — as a person's pointer pushed to the window's edge. */
async function revealAt(app: ElectronApplication, shell: Page, y: number): Promise<void> {
  await pointerAt(app, 2, y);
  // A raw move, not hover(): the strip goes the moment the pointer moves in it.
  await shell.mouse.move(2, y);
  await shell.mouse.move(3, y + 6);
  await expect(shell.locator(`${PANE}:not([data-hidden])`)).toHaveCount(1);
}

test.describe.serial("the sidebar's three modes on the desk", { tag: ["@desk", "@sidebar"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let userData: string;
  let invoices: string;
  let vendor: string;
  let stage: Box;

  /** Off the column and the Bar: the middle of the desk, for the OS's pointer and the shell's. */
  const onDesk = async (): Promise<void> => {
    const desk = await box(shell, ".desk-stage");
    await pointerAt(app, desk.x + desk.width * 0.6, desk.y + desk.height * 0.4);
    await shell.mouse.move(desk.x + desk.width * 0.6, desk.y + desk.height * 0.4);
  };
  const gapBetween = async (): Promise<number> => {
    const [a, b] = [await box(shell, windowSelector(invoices)), await box(shell, windowSelector(vendor))].sort((one, two) => one.x - two.x) as [Box, Box];
    return b.x - (a.x + a.width);
  };

  test.beforeAll(async () => {
    ({ app, shell, userData } = await launchDesk({ name: "sidebar-modes", sidebar: "whole", env: { PISTACHIO_E2E_CURSOR: "1" } }));
    // The OS's pointer up in the window, on the desk, until a test says otherwise.
    await pointerAt(app, 900, 300);
    [invoices, vendor] = (await openTabs(shell, [INVOICES, VENDOR])) as [string, string];
    await createGroup(shell, "modes", [invoices, vendor], "Modes", "blue");
    await selectTab(shell, invoices);
    await selectSpace(shell, "modes");
    await settled(shell, app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("⌘S cycles whole → rail → hidden → whole: the slot and the desk beside it, the setting on disk, the window's buttons, and windows a gutter apart kept a gutter apart", async () => {
    test.setTimeout(90_000);
    // Two windows tiled, a gutter between them.
    await shell.locator(rowSelector(vendor)).click();
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await onDesk();
    await settled(shell, app);
    await openMore(shell);
    await shell.getByTestId("desk-tile").click();
    await onDesk();
    await settled(shell, app);
    expect(Math.round(await gapBetween())).toBe(8);
    await recordButtons(app);

    const step = async (mode: SidebarMode, slotWidth: number, buttons: boolean, name: string): Promise<void> => {
      await expect(shell.locator(`${SLOT}[data-mode="${mode}"]`)).toHaveCount(1);
      await expect.poll(async () => Math.round((await box(shell, SLOT)).width)).toBe(slotWidth);
      await expect.poll(() => storedMode(userData)).toBe(mode);
      await settled(shell, app);
      const desk = await box(shell, ".desk-stage");
      // The desk begins where the column ends (its leading inset is the column's, or the strip's).
      expect(Math.abs(desk.x - slotWidth)).toBeLessThan(2);
      await expect.poll(() => buttonsNow(app)).toBe(buttons);
      expect(Math.round(await gapBetween())).toBe(8);
      await capture(app, shell, name);
    };

    // Whole: the column in the layout, the window's buttons over its toolbar.
    await step("whole", SIDEBAR_DEFAULT_W, true, "01-whole.png");
    // Rail: its icons, its head where the buttons were.
    await shell.keyboard.press("Meta+s");
    await step("rail", SIDEBAR_RAIL_W, false, "02-rail.png");
    // Hidden: the strip at the window's edge, its trigger in it; the column away, and the buttons with it.
    await shell.keyboard.press("Meta+s");
    await step("hidden", SIDEBAR_EDGE_W, false, "03-hidden.png");
    await expect(shell.getByTestId("sidebar-edge")).toBeVisible();
    await expect(shell.locator(PANE)).toHaveAttribute("data-hidden", "");
    // And whole again.
    await shell.keyboard.press("Meta+s");
    await step("whole", SIDEBAR_DEFAULT_W, true, "04-whole-again.png");
    await expect(shell.getByTestId("sidebar-edge")).toHaveCount(0);
  });

  test("hidden, the column comes out over the desk: the stage stays put, the window under it gives way before the column shows, and main's word that the pointer left puts it away", async () => {
    test.setTimeout(90_000);
    // Hidden, from its own button (the whole sidebar's: to the rail, then the setting's third place by ⌘S).
    await shell.keyboard.press("Meta+s");
    await shell.keyboard.press("Meta+s");
    await expect(shell.locator(`${SLOT}[data-mode="hidden"]`)).toHaveCount(1);
    // One window filling the desk: wholly under the column when it comes out.
    await shell.locator(windowSelector(vendor)).getByTestId("desk-collapse").click();
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await shell.locator(windowSelector(invoices)).getByRole("button", { name: "Fill the desk" }).click();
    await onDesk();
    await settled(shell, app);
    stage = await box(shell, ".desk-stage");
    await recordButtons(app);
    await expect.poll(() => buttonsNow(app)).toBe(false);
    // From here on, in order: the window becoming its still, and the column shown.
    await shell.evaluate((selector) => {
      const order: string[] = [];
      (window as unknown as { __order: string[] }).__order = order;
      const win = document.querySelector(selector)!;
      const pane = document.querySelector('[data-testid="sidebar-pane"]')!;
      new MutationObserver(() => {
        if (win.hasAttribute("data-drawn") && !order.includes("drawn")) order.push("drawn");
        if (!pane.hasAttribute("data-hidden") && !order.includes("shown")) order.push("shown");
      }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["data-drawn", "data-hidden"] });
    }, windowSelector(invoices));

    // ── 1. The pointer at the window's edge: the column comes out over the window, which gives way first ─
    await revealAt(app, shell, 420);
    await expect(shell.locator(`${SLOT}[data-overlay]`)).toHaveCount(1);
    expect(await shell.evaluate(() => (window as unknown as { __order: string[] }).__order)).toEqual(["drawn", "shown"]);
    await expect(shell.locator(windowSelector(invoices))).toHaveAttribute("data-drawn", "");
    // Nothing reflowed: the slot is the strip still, the stage where it was.
    expect(Math.round((await box(shell, SLOT)).width)).toBe(SIDEBAR_EDGE_W);
    const during = await box(shell, ".desk-stage");
    for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(during[key] - stage[key])).toBeLessThan(1);
    // Out, it is on screen: the window's buttons over its toolbar.
    await expect.poll(() => buttonsNow(app)).toBe(true);
    await capture(app, shell, "05-overlay.png");

    // ── 2. The OS's pointer off it, onto the live page: main says so, the column goes, and the window is live again ─
    await onDesk();
    await expect(shell.locator(PANE)).toHaveAttribute("data-hidden", "");
    await expect(shell.locator(`${SLOT}[data-overlay]`)).toHaveCount(0);
    await expect(shell.locator(windowSelector(invoices))).not.toHaveAttribute("data-drawn", "");
    await expect.poll(() => buttonsNow(app)).toBe(false);
    const after = await box(shell, ".desk-stage");
    for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(after[key] - stage[key])).toBeLessThan(1);
    await capture(app, shell, "06-overlay-gone.png");
  });

  test("hidden: a window carried to the leading edge lights the left half and never brings the column out, nor does a resize from the west edge of a window flush with it", async () => {
    test.setTimeout(90_000);
    await shell.locator(windowSelector(invoices)).getByRole("button", { name: "Restore" }).click();
    await onDesk();
    await settled(shell, app);

    // ── 1. Carried by its bar to the edge and into the strip: the left half lights, the column stays away ─
    const bar = await box(shell, `${windowSelector(invoices)} .desk-window-bar`);
    const grip = { x: bar.x + 60, y: bar.y + bar.height / 2 };
    const edge = { x: 3, y: stage.y + stage.height * 0.5 };
    await shell.mouse.move(grip.x, grip.y);
    await shell.mouse.down();
    await shell.mouse.move(grip.x - 8, grip.y + 4, { steps: 2 });
    for (let step = 1; step <= 14; step += 1) {
      const at = { x: grip.x + ((edge.x - grip.x) * step) / 14, y: grip.y + ((edge.y - grip.y) * step) / 14 };
      await pointerAt(app, at.x, at.y);
      await shell.mouse.move(at.x, at.y);
      await shell.waitForTimeout(16);
    }
    await expect(shell.locator(".desk-zone[data-on]")).toHaveCount(1);
    // (Main's watch had its chance: it polls the OS's pointer, which sits in the strip.)
    await shell.waitForTimeout(400);
    await expect(shell.locator(PANE)).toHaveAttribute("data-hidden", "");
    await capture(app, shell, "07-carried-to-the-edge.png");
    await shell.mouse.up();
    await onDesk();
    await settled(shell, app);
    const half = await box(shell, windowSelector(invoices));
    expect(Math.abs(half.x - stage.x)).toBeLessThan(2);
    await expect(shell.locator(PANE)).toHaveAttribute("data-hidden", "");

    // ── 2. Its west edge, past the 5px trigger, dragged: it resizes, and the column stays away ─
    const west = { x: stage.x + 2, y: half.y + half.height / 2 };
    await pointerAt(app, west.x, west.y);
    await shell.mouse.move(west.x, west.y);
    await shell.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await pointerAt(app, west.x + step * 8, west.y);
      await shell.mouse.move(west.x + step * 8, west.y);
      await shell.waitForTimeout(16);
    }
    await shell.mouse.up();
    await onDesk();
    await settled(shell, app);
    const resized = await box(shell, windowSelector(invoices));
    expect(resized.x).toBeGreaterThan(half.x + 60);
    expect(resized.width).toBeLessThan(half.width - 60);
    await expect(shell.locator(PANE)).toHaveAttribute("data-hidden", "");
  });

  test("hidden: a window put away goes into the window's edge at its row's height, the column staying away", async () => {
    test.setTimeout(60_000);
    // Every frame of the flight: where the window is.
    await shell.evaluate((selector) => {
      const samples: Array<{ x: number; right: number }> = [];
      (window as unknown as { __flight: typeof samples }).__flight = samples;
      const sample = (): void => {
        const el = document.querySelector(selector);
        if (el === null) return;
        const rect = el.getBoundingClientRect();
        samples.push({ x: rect.x, right: rect.right });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, windowSelector(invoices));
    await shell.locator(windowSelector(invoices)).getByTestId("desk-collapse").click();
    await expect(shell.locator(windowSelector(invoices))).toHaveCount(0);
    const flight = await shell.evaluate(() => (window as unknown as { __flight: Array<{ x: number; right: number }> }).__flight);
    expect(flight.length).toBeGreaterThan(3);
    // Never off the window's left edge (where the hidden column's rows lie, translated out of sight)…
    for (const frame of flight) expect(frame.right).toBeGreaterThan(-1);
    // …and into the edge, at the strip.
    expect(flight.at(-1)!.x).toBeLessThan(stage.x + 40);
    await expect(shell.locator(PANE)).toHaveAttribute("data-hidden", "");
    await expect(shell.getByTestId("desk-window")).toHaveCount(0);
  });

  test("hidden: a row pulled out of the column brought out over the desk is its window in hand, and the column goes", async () => {
    test.setTimeout(60_000);
    await revealAt(app, shell, 300);
    await settled(shell, app);
    const row = center(await box(shell, rowSelector(vendor)));
    await pointerAt(app, row.x, row.y);
    await shell.mouse.move(row.x, row.y);
    await shell.mouse.down();
    await shell.mouse.move(row.x + 4, row.y + 6, { steps: 2 });
    const to = { x: stage.x + stage.width * 0.45, y: stage.y + stage.height * 0.3 };
    for (let step = 1; step <= 14; step += 1) {
      const at = { x: row.x + ((to.x - row.x) * step) / 14, y: row.y + ((to.y - row.y) * step) / 14 };
      await pointerAt(app, at.x, at.y);
      await shell.mouse.move(at.x, at.y);
      await shell.waitForTimeout(16);
    }
    // In hand, a window of its own (a tab not out comes out of its row as one: the desk's "spawn"), held by its bar…
    await expect(shell.locator(".desk-stage[data-gesture]")).toHaveCount(1);
    await expect(shell.locator(windowSelector(vendor))).toHaveCount(1);
    // …and the column gives the desk its leading edge back.
    await expect(shell.locator(PANE)).toHaveAttribute("data-hidden", "");
    await capture(app, shell, "08-row-in-hand.png");
    await shell.mouse.up();
    await onDesk();
    await settled(shell, app);
    await expect(shell.locator(windowSelector(vendor))).toHaveCount(1);
    const bar = await box(shell, `${windowSelector(vendor)} .desk-window-bar`);
    // (Set down where it was let go, held by its bar: the bar about the pointer.)
    expect(Math.abs(bar.y + bar.height / 2 - to.y)).toBeLessThan(24);
  });

  test("hidden: the desk's card opened from the column brought out holds it there until the card goes", async () => {
    test.setTimeout(60_000);
    await revealAt(app, shell, 300);
    await settled(shell, app);
    // The card, from the column's toolbar; the pointer on it (the OS's and the shell's), off the column.
    await openMore(shell);
    const card = center(await box(shell, '[data-testid="desk-more-card"]'));
    await pointerAt(app, card.x, card.y);
    await shell.mouse.move(card.x, card.y);
    // Main says the pointer has left the column: the card it opened holds it.
    await shell.waitForTimeout(700);
    await expect(shell.locator(PANE)).not.toHaveAttribute("data-hidden", "");
    await expect(shell.locator('[data-testid="desk-more-card"][data-shown]')).toHaveCount(1);
    await capture(app, shell, "09-card-holds-the-column.png");
    // The card gone, the pointer off the column: the column goes.
    await onDesk();
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("desk-more-card")).toHaveCount(0);
    await expect(shell.locator(PANE)).toHaveAttribute("data-hidden", "");
  });
});
