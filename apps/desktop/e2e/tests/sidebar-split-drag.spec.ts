import { expect, test, type ElectronApplication } from "@playwright/test";
import { dragPage, pageFirst, shellReady } from "./windows";
import { launchApp } from "./app";
import { capturePage, captureShell as captureWindowFrame, captureTabView, visibleTabViewBoxes } from "./chrome-harness";

const FOLDER = "sidebar-split-drag";

function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  return captureWindowFrame(app, FOLDER, filename);
}

test("a sidebar tab live-previews the page reflow before it becomes a split", { tag: ["@split", "@sidebar"] }, async () => {
  const { app } = await launchApp({ settings: pageFirst({ layout: { sidebar: "pinned" } }), name: "sidebar-split-drag" });
  try {
    const shell = await shellReady(app);
    const layer = await dragPage(app);
    await layer.waitForLoadState("domcontentloaded");
    const source = shell.getByTestId("sidebar-tab-list").getByTestId("human-tab").first();
    const content = shell.getByTestId("primary-pane");
    await expect(source).toBeVisible();
    await expect(content).toBeVisible();
    await captureShell(app, "01-ready.png");

    // Crossing into the page must resize the live native view and expose one
    // exact landing pane instead of floating four abstract targets over it.
    const sourceBox = await source.boundingBox();
    const contentBox = await content.boundingBox();
    if (sourceBox === null || contentBox === null) throw new Error("drag geometry is unavailable");
    const start = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
    const target = { x: contentBox.x + contentBox.width / 4, y: contentBox.y + contentBox.height / 2 };
    await shell.mouse.move(start.x, start.y);
    await shell.mouse.down();
    await shell.mouse.move(start.x + 8, start.y, { steps: 2 });
    await shell.mouse.move(target.x, target.y, { steps: 12 });

    const landing = shell.getByTestId("split-drop-preview");
    await expect(landing).toBeVisible();
    await expect(landing).toHaveAttribute("data-side", "left");
    await shell.getByTestId("browser-surface").evaluate(async (surface) => {
      await Promise.all(surface.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)));
    });
    await expect(shell.getByTestId("split-drop-zones")).toHaveCount(0);
    await expect(shell.locator("img.pane-still")).toHaveCount(0);
    await expect.poll(() => visibleTabViewBoxes(app).then((boxes) => boxes.length)).toBe(1);
    const previewPageBox = (await visibleTabViewBoxes(app))[0];
    if (previewPageBox === undefined) throw new Error("live preview page has no native bounds");
    expect(previewPageBox.width).toBeLessThan(contentBox.width * 0.62);
    expect(previewPageBox.x).toBeGreaterThan(contentBox.x + contentBox.width * 0.4);
    const ghost = layer.getByTestId("tab-drag-preview");
    await expect(ghost).toBeVisible();
    await expect(ghost).toHaveAttribute("data-split-zone", "left");
    await captureShell(app, "02-live-split-preview.png");
    await captureTabView(app, FOLDER, "03-native-page-reflow.png");
    await capturePage(layer, FOLDER, "04-drag-ghost.png");

    // Once the real pointer is over a page, the drag layer owns its samples.
    // Crossing to the opposite edge must move both the landing pane and the
    // live native view without sending another synthetic move to the shell.
    const rightTarget = { x: contentBox.x + contentBox.width * 0.75, y: contentBox.y + contentBox.height / 2 };
    await layer.evaluate(({ x, y }) => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
    }, rightTarget);
    await expect(landing).toHaveAttribute("data-side", "right");
    await expect(ghost).toHaveAttribute("data-split-zone", "right");
    await shell.getByTestId("browser-surface").evaluate(async (surface) => {
      await Promise.all(surface.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)));
    });
    const movedPageBox = (await visibleTabViewBoxes(app))[0];
    if (movedPageBox === undefined) throw new Error("moved live preview page has no native bounds");
    expect(movedPageBox.x).toBeLessThan(contentBox.x + contentBox.width * 0.1);
    await captureShell(app, "05-live-split-preview-right.png");

    // Releasing commits the already-visible geometry and removes both pieces
    // of transient drag chrome without a one-pane intermediate frame.
    await layer.evaluate(({ x, y }) => {
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: x, clientY: y, bubbles: true }));
    }, rightTarget);
    await expect(landing).toHaveCount(0);
    await expect(ghost).toHaveCount(0);
    await shell.mouse.up();
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
    await expect(shell.getByRole("group", { name: /^Split view:/ })).toBeVisible();
    await expect.poll(() => visibleTabViewBoxes(app).then((boxes) => boxes.length)).toBe(2);
    await shell.getByTestId("sidebar-tab-list").evaluate(async (list) => {
      await Promise.all(list.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)));
    });
    await captureShell(app, "06-split-committed.png");
  } finally {
    await app.close();
  }
});
