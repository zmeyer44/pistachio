import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { dragPage, pageFirst, shellReady } from "./windows";
import { launchApp } from "./app";

/**
 * Where main currently has each visible TAB view — the boxes the pages are
 * laid out at. Utility chrome views (drag capture and find) are excluded by
 * their hash.
 */
function tabViewBoxes(app: ElectronApplication): Promise<Array<{ x: number; width: number }>> {
  return app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return window.contentView.children
      .filter((child) => {
        if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return false;
        return !Object.values(hashes).some((hash) => (child as WebContentsView).webContents.getURL().endsWith(hash));
      })
      .map((child) => {
        const bounds = (child as WebContentsView).getBounds();
        return { x: bounds.x, width: bounds.width };
      })
      .sort((a, b) => a.x - b.x);
  }, CHROME_VIEW_HASHES);
}

/** Whether main has the drag layer up — the view that holds the pointer. */
function dragLayerVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }, hash) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const view = window.contentView.children.find(
      (child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith(hash),
    ) as WebContentsView | undefined;
    if (view === undefined) throw new Error("the drag layer is unavailable");
    return view.getVisible();
  }, CHROME_VIEW_HASHES.drag);
}

async function centreOf(locator: ReturnType<Page["locator"]>): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("the element has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// One window split in two: a drag of the divider through the shell, then
// one whose pointer the drag layer holds.
test.describe.serial("resizing a split", { tag: ["@split"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let layer: Page;

  test.beforeAll(async () => {
    ({ app } = await launchApp({ settings: pageFirst(), name: "pane-resize" }));
    shell = await shellReady(app);
    layer = await dragPage(app);
    await layer.waitForLoadState("domcontentloaded");
    await expect(shell.getByTestId("primary-pane")).toBeVisible();

    // Split vertically: main opens the second tab itself if there is only one.
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.setSplit("vertical"));
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close();
  });

  /**
   * A pane-resize drag must reflow the PAGES as it goes.
   *
   * The regression this guards: the drag used to raise the chrome, which hides
   * every tab view and leaves a captured still of each page in its place. The
   * panes then resized around stretched screenshots and the real pages only
   * caught up when the pointer came up. The drag layer replaced that (see the
   * drag capture section of @pistachio/shell-contracts/chrome), so the assertions below all
   * happen with the pointer still DOWN: views visible, no stills, and main
   * already tracking the views to the new pane boxes.
   */
  test("resizing a split pane reflows the pages during the drag, not after it", async () => {
    const divider = shell.getByRole("separator", { name: "Resize split panes" });
    await expect(divider).toBeVisible();
    await expect.poll(() => tabViewBoxes(app).then((boxes) => boxes.length)).toBe(2);

    const dividerBox = await divider.boundingBox();
    const grabberBox = await divider.locator("svg").boundingBox();
    if (dividerBox === null || grabberBox === null) throw new Error("split grabber has no box");
    expect(grabberBox.x + grabberBox.width / 2).toBeCloseTo(dividerBox.x + dividerBox.width / 2, 5);
    expect(grabberBox.y + grabberBox.height / 2).toBeCloseTo(dividerBox.y + dividerBox.height / 2, 5);

    const before = await tabViewBoxes(app);
    const grip = await centreOf(divider);

    // ── the drag, with the pointer held down throughout ────────────────────
    await shell.mouse.move(grip.x, grip.y);
    await shell.mouse.down();
    await shell.mouse.move(grip.x - 120, grip.y, { steps: 8 });

    // The pages are still on screen: nothing was hidden for the gesture.
    await expect.poll(() => tabViewBoxes(app).then((boxes) => boxes.length)).toBe(2);
    // And no still is standing in for one. A still is what used to stretch.
    await expect(shell.locator("img.pane-still")).toHaveCount(0);
    // Main has already moved the views onto the new panes — mid-drag.
    await expect
      .poll(async () => {
        const boxes = await tabViewBoxes(app);
        return boxes[0]?.width ?? 0;
      })
      .toBeLessThan((before[0]?.width ?? 0) - 40);

    // What the drag shows once main has caught up with the last move: two
    // reads in a row agree (the check above can pass on an earlier move).
    let during = await tabViewBoxes(app);
    await expect
      .poll(async () => {
        const now = await tabViewBoxes(app);
        const steady = now[0]?.width === during[0]?.width;
        during = now;
        return steady;
      })
      .toBe(true);
    await shell.mouse.up();

    // Releasing settles on what the drag already showed rather than jumping.
    await expect
      .poll(async () => {
        const boxes = await tabViewBoxes(app);
        return Math.abs((boxes[0]?.width ?? 0) - (during[0]?.width ?? 0));
      })
      .toBeLessThanOrEqual(2);
  });

  /**
   * The other half of the fix: the pointer a real drag hands to the drag layer
   * actually comes back. Playwright's synthetic pointer belongs to whichever
   * page it is dispatched into and never crosses views, so the test above
   * exercises the shell's own listeners; here the moves are dispatched INSIDE
   * the drag layer, which is what happens on a real machine the moment the
   * pointer leaves the divider and lands on a page. (The divider sits left of
   * centre after the drag above, so this one goes right.)
   */
  test("the drag layer takes the pointer and relays it back to the shell", async () => {
    const divider = shell.getByRole("separator", { name: "Resize split panes" });
    await expect(divider).toBeVisible();
    await expect.poll(() => tabViewBoxes(app).then((boxes) => boxes.length)).toBe(2);

    const before = await tabViewBoxes(app);
    const grip = await centreOf(divider);
    await expect.poll(() => dragLayerVisible(app)).toBe(false);

    await shell.mouse.move(grip.x, grip.y);
    await shell.mouse.down();
    // Pressing the handle is what hands the pointer over.
    await expect.poll(() => dragLayerVisible(app)).toBe(true);
    // Main shows the view and tells its page the cursor to hold in the same
    // breath, but the page hears about it a beat later — and that is when it
    // starts listening. The cursor it is painting is the proof it is armed.
    await expect
      .poll(() => layer.evaluate(() => document.querySelector<HTMLElement>("[data-testid=drag-layer]")?.style.cursor))
      .toBe("col-resize");

    // From here the shell's mouse never moves: every sample comes from the
    // layer, exactly as it would once the pointer is over a page.
    const relay = (x: number, y: number, type: "pointermove" | "pointerup"): Promise<void> =>
      layer.evaluate(
        ({ x: clientX, y: clientY, type: eventType }) => {
          window.dispatchEvent(new PointerEvent(eventType, { clientX, clientY, bubbles: true }));
        },
        { x, y, type },
      );

    // Re-sent on every poll: a sample is an absolute position, so the last
    // one wins, and the real cursor parked elsewhere on the machine gets one
    // move of its own the instant the layer appears under it.
    await expect
      .poll(async () => {
        await relay(grip.x + 130, grip.y, "pointermove");
        return (await tabViewBoxes(app))[0]?.width ?? 0;
      })
      .toBeGreaterThan((before[0]?.width ?? 0) + 40);
    // Still live, still nothing standing in for a page.
    expect(await tabViewBoxes(app)).toHaveLength(2);
    await expect(shell.locator("img.pane-still")).toHaveCount(0);

    // The layer's pointerup ends the gesture and gives the pointer back.
    await relay(grip.x + 130, grip.y, "pointerup");
    await expect.poll(() => dragLayerVisible(app)).toBe(false);
    await shell.mouse.up();
  });
});
