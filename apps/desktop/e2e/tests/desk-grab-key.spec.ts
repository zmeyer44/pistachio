/**
 * The desk's grab key is believed down only while the OS agrees (docs/desk.md, "Engine notes"; main/os-keys.ts).
 *
 * Main follows the grab key (Shift, unless set otherwise) from the key events the window's views are sent, since a
 * mouse event reaching it carries no modifiers. That is the keyboard's last word to this window, not the keyboard: a
 * Shift that goes up where the window never hears it — ⌘⇧4 takes the keys for its crosshair, and they are let go
 * there — stayed down as far as the desk knew. Every press on a page then grabbed its window, "as if I'm holding down
 * the shift key", until some key was pressed again (2026-11-17). Now what the keyboard last said is checked against
 * the OS's own word for the keys: as a press lands on a page, as the pointer comes onto one, and now and then for as
 * long as any key is believed down.
 *
 * Under Playwright the keys are sent to a page, never pressed, so the OS's word is a file's here
 * (PISTACHIO_E2E_MODIFIERS): absent, nothing is known and the key events stand; written, it is what the OS says.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type ElectronApplication } from "@playwright/test";
import { box, createGroup, INVOICES, launchDesk, openTabs, selectSpace, selectTab, settled, windowSelector } from "./desk-harness";
import { pageAt } from "./pages-harness";

/** Shift going down in a page, as main relays a page's keys — and never up: its release is some other window's. */
function shiftDown(app: ElectronApplication, url: string): Promise<void> {
  return app.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
    contents.sendInputEvent({ type: "keyDown", keyCode: "Shift", modifiers: ["shift"] });
  }, url);
}

/** A press on a page dragged a little way, as its view is sent one (no modifiers on it: main has none on a mouse event). */
function dragOnPage(app: ElectronApplication, url: string): Promise<void> {
  return app.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
    const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
    const at = (step: number): { x: number; y: number } => ({ x: 300 + 14 * step, y: 260 + 8 * step });
    contents.sendInputEvent({ type: "mouseEnter", ...at(0) });
    contents.sendInputEvent({ type: "mouseMove", ...at(0) });
    await pause(30);
    contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...at(0) });
    for (let step = 1; step <= 8; step += 1) {
      await pause(16);
      contents.sendInputEvent({ type: "mouseMove", button: "left", ...at(step) });
    }
    await pause(120);
    contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...at(8) });
    await pause(60);
  }, url);
}

test("a Shift whose release the window never heard is not held for good: the OS's word for the keys puts it right, and a press on the page is the page's again", { tag: ["@desk"] }, async () => {
  test.setTimeout(90_000);
  const keys = join(await mkdtemp(join(tmpdir(), "pistachio-keys-")), "modifiers.json");
  const osSays = (held: { shift: boolean }): Promise<void> => writeFile(keys, JSON.stringify({ shift: held.shift, control: false, alt: false, meta: false }));
  const { app, shell } = await launchDesk({ name: "grab-key", env: { PISTACHIO_E2E_MODIFIERS: keys } });
  try {
    const [invoice] = (await openTabs(shell, [INVOICES])) as [string];
    await createGroup(shell, "grab-key", [invoice], "Northstar", "green");
    await selectTab(shell, invoice);
    await selectSpace(shell, "grab-key");
    await settled(shell, app);
    const win = shell.locator(windowSelector(invoice));
    await expect(win).toHaveCount(1);
    const page = await pageAt(app, INVOICES);
    await page.evaluate(() => {
      const state = window as unknown as { __presses: number };
      state.__presses = 0;
      document.addEventListener("mousedown", () => (state.__presses += 1), true);
    });
    const presses = (): Promise<number> => page.evaluate(() => (window as unknown as { __presses: number }).__presses);
    const cursor = (): Promise<string> => page.evaluate(() => getComputedStyle(document.body).cursor);
    const own = await cursor();
    expect(own).not.toBe("grab");
    const filled = await box(shell, windowSelector(invoice));

    // Shift goes down in the page and its release is never heard here: the desk holds it down — the open hand over the
    // page — and, nothing known of the OS's keys, a press on the page is taken from it and carries the window off.
    await shiftDown(app, INVOICES);
    await expect.poll(cursor).toBe("grab");
    await dragOnPage(app, INVOICES);
    await settled(shell, app);
    expect(await presses()).toBe(0);
    const carried = await box(shell, windowSelector(invoice));
    expect(Math.abs(carried.width - filled.width) + Math.abs(carried.x - filled.x), "the window was carried off, and let go of the desk").toBeGreaterThan(40);

    // The OS says Shift is up. The desk asks it for as long as it believes a key down: the open hand goes, and the
    // next press on the page is the page's — the window stays where it is.
    await osSays({ shift: false });
    await expect.poll(cursor).toBe(own);
    await dragOnPage(app, INVOICES);
    await settled(shell, app);
    expect(await presses()).toBe(1);
    const stayed = await box(shell, windowSelector(invoice));
    for (const side of ["x", "y", "width", "height"] as const) expect(Math.abs(stayed[side] - carried[side]), side).toBeLessThanOrEqual(1);

    // And the other way: a Shift held that no view was sent a key for is the grab key all the same — the OS is asked
    // as the press lands.
    // (Held to the end of the drag it is the snap key too, and the window lands in the tile it lit — where it already
    // stands, as it happens: so the move itself is what is looked for, not where it ends.)
    await shell.evaluate(() => {
      const stage = document.querySelector(".desk-stage")!;
      const state = window as unknown as { __gestures: string[] };
      state.__gestures = [];
      new MutationObserver(() => {
        const gesture = stage.getAttribute("data-gesture");
        if (gesture !== null) state.__gestures.push(gesture);
      }).observe(stage, { attributes: true, attributeFilter: ["data-gesture"] });
    });
    await osSays({ shift: true });
    await dragOnPage(app, INVOICES);
    await settled(shell, app);
    expect(await presses(), "the press was taken from the page").toBe(1);
    expect(await shell.evaluate(() => (window as unknown as { __gestures: string[] }).__gestures)).toContain("move");
    // Let go, it is the page's once more.
    await osSays({ shift: false });
    await expect.poll(cursor).toBe(own);
    await dragOnPage(app, INVOICES);
    expect(await presses()).toBe(2);
  } finally {
    await app.close();
  }
});
