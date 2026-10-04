import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { sidebarMenuItem } from "./footer";
import { pageFirst, shellReady } from "./windows";
import type { WebContentsView } from "electron";
import { SIDEBAR_EDGE_W, SIDEBAR_TRIGGER_W } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { DesktopSettings } from "@pistachio/shell-contracts/settings";
import { captureEnabled, launchApp } from "./app";
import { captureShell, captureWindow, visibleTabViews } from "./chrome-harness";

const FOLDER = "layout";

/**
 * The window buttons as main has them, and whether a sidebar chrome view
 * exists at all (it must not: the compact sidebar is the shell's own column).
 * Electron exposes no public getter for the buttons' visibility;
 * `_getWindowButtonVisibility` is the internal one its own test suite reads.
 */
function windowState(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const sidebarView = window.contentView.children.some(
      (child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith("#sidebar"),
    );
    const buttons = (window as unknown as { _getWindowButtonVisibility?: () => boolean })._getWindowButtonVisibility;
    return { sidebarView, windowButtons: buttons?.call(window) ?? null };
  });
}

/** Open Settings by key, or by the sidebar footer menu's row. */
async function openGeneralSettings(shell: Page, viaButton = false) {
  if (!viaButton) await shell.keyboard.press("Meta+,");
  else await (await sidebarMenuItem(shell, "settings-button")).click();
  const page = shell.getByTestId("settings-page");
  await expect(page).toBeVisible();
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
  return page;
}

async function storedLayout(userData: string): Promise<DesktopSettings["layout"] | null> {
  try {
    const raw = await readFile(join(userData, "settings.json"), "utf8");
    return (JSON.parse(raw) as DesktopSettings).layout;
  } catch {
    return null;
  }
}

interface GeometrySample {
  time: number;
  sidebarWidth: number;
  pageX: number;
}

/** Sample the sidebar's width and the page's left edge on every frame for 420ms: jumps that settled screenshots miss. */
async function beginGeometrySampling(shell: Page): Promise<void> {
  await shell.evaluate(() => {
    const target = window as unknown as { __compactSamples?: GeometrySample[]; __compactSamplingDone?: boolean };
    target.__compactSamples = [];
    target.__compactSamplingDone = false;
    const started = performance.now();
    const sample = (now: number) => {
      const slot = document.querySelector<HTMLElement>('[data-testid="sidebar-motion-slot"]');
      const pane = document.querySelector<HTMLElement>('[data-testid="sidebar-pane"]');
      const edge = document.querySelector<HTMLElement>('[data-testid="sidebar-edge"]');
      const primary = document.querySelector<HTMLElement>('[data-testid="primary-pane"]');
      const sidebar = slot?.getBoundingClientRect() ?? pane?.getBoundingClientRect() ?? edge?.getBoundingClientRect();
      target.__compactSamples?.push({ time: now - started, sidebarWidth: sidebar?.width ?? 0, pageX: primary?.getBoundingClientRect().x ?? 0 });
      if (now - started < 420) requestAnimationFrame(sample);
      else target.__compactSamplingDone = true;
    };
    requestAnimationFrame(sample);
  });
}

async function finishGeometrySampling(shell: Page): Promise<GeometrySample[]> {
  await expect
    .poll(() => shell.evaluate(() => (window as unknown as { __compactSamplingDone?: boolean }).__compactSamplingDone === true), { intervals: [20] })
    .toBe(true);
  return shell.evaluate(() => (window as unknown as { __compactSamples?: GeometrySample[] }).__compactSamples ?? []);
}

function geometrySummary(samples: GeometrySample[]) {
  const widths = samples.map((sample) => sample.sidebarWidth);
  const deltas = widths.slice(1).map((width, index) => Math.abs(width - widths[index]!));
  const pageXs = samples.map((sample) => sample.pageX);
  return {
    frames: samples.length,
    distinctWidths: new Set(widths.map(Math.round)).size,
    distinctPageXs: new Set(pageXs.map(Math.round)).size,
    maxWidthDelta: Math.max(0, ...deltas),
    minWidth: Math.min(...widths),
    maxWidth: Math.max(...widths),
  };
}

function expectSmoothTransition(samples: GeometrySample[]): void {
  const summary = geometrySummary(samples);
  expect(summary.distinctWidths).toBeGreaterThanOrEqual(8);
  expect(summary.distinctPageXs).toBeGreaterThanOrEqual(8);
  expect(summary.maxWidthDelta).toBeLessThan(100);
  expect(summary.minWidth).toBeCloseTo(SIDEBAR_EDGE_W, 0);
  expect(summary.maxWidth).toBeGreaterThan(240);
}

/** How far the sidebar's width (or slide) transition has run, 0–1; 0 with none running. */
async function motionProgress(shell: Page): Promise<number> {
  return shell.getByTestId("sidebar-motion-slot").evaluate((element) => {
    const transition = element
      .getAnimations({ subtree: true })
      .find(
        (animation) =>
          animation instanceof CSSTransition && (animation.transitionProperty === "width" || animation.transitionProperty === "transform"),
      );
    if (transition === undefined) return 0;
    const timing = transition.effect?.getComputedTiming();
    const duration = typeof timing?.duration === "number" ? timing.duration : 0;
    const current = typeof transition.currentTime === "number" ? transition.currentTime : 0;
    return duration === 0 ? 1 : current / duration;
  });
}

/** The sidebar's side of the shell, mid-motion. */
async function captureLeft(shell: Page, filename: string): Promise<void> {
  if (!captureEnabled) return;
  const viewport = await shell.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const directory = join(process.cwd(), "e2e/screenshots", FOLDER);
  await mkdir(directory, { recursive: true });
  await shell.screenshot({
    path: join(directory, filename),
    clip: { x: 0, y: 0, width: Math.min(360, viewport.width), height: viewport.height },
  });
}

// One window, pinned over a web page, through the sidebar's two presentations:
// its context menu over the native page, every control it holds, the move to
// compact and back, and the compact reveal's motion frame by frame.
test.describe.serial("the sidebar layout", { tag: ["@sidebar", "@settings"] }, () => {
  test.describe.configure({ timeout: 60_000 });
  let app: ElectronApplication;
  let userData: string;
  let shell: Page;

  test.beforeAll(async () => {
    ({ app, userData } = await launchApp({ settings: pageFirst({ layout: { sidebar: "pinned" } }), name: "layout" }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("a sidebar context menu keeps its pointer anchor above the native page", async () => {
    const sidebar = shell.getByTestId("sidebar-chrome");
    const tab = sidebar.getByTestId("human-tab").first();
    await expect(tab).toBeVisible();
    await captureShell(app, FOLDER, "context-menu-01-sidebar-ready.png");

    const tabBox = await tab.boundingBox();
    if (tabBox === null) throw new Error("tab geometry is unavailable");
    // Preserve the pointer anchor while raising the shell above the native
    // page, so the card can extend naturally beyond the sidebar.
    await tab.click({ button: "right" });
    const menu = shell.getByTestId("context-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCSS("opacity", "1");
    const sidebarBox = await sidebar.boundingBox();
    if (sidebarBox === null) throw new Error("sidebar geometry is unavailable");
    const menuBox = await menu.boundingBox();
    if (menuBox === null) throw new Error("context-menu geometry is unavailable");
    const anchoredLeft = await menu.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left));
    expect(anchoredLeft).toBeCloseTo(tabBox.x + tabBox.width / 2, 0);
    expect(menuBox.x + menuBox.width).toBeGreaterThan(sidebarBox.x + sidebarBox.width + 40);
    await expect(shell.locator("img.pane-still")).toHaveCount(1);
    await expect(menu.getByRole("menuitem", { name: "Close tab" })).toBeVisible();
    await captureShell(app, FOLDER, "context-menu-02-menu-over-page.png");

    // Dismissal lowers the shell and restores the live native page.
    await shell.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(shell.locator("img.pane-still")).toHaveCount(0);
    await captureShell(app, FOLDER, "context-menu-03-menu-dismissed.png");
  });

  test("the sidebar holds every control, pinned and compact", { tag: ["@smoke"] }, async () => {
    // SIDEBAR, PINNED: the column holds the address, the tab list with its
    // "New tab" row, and the pin toggle.
    const sidebar = shell.getByTestId("sidebar-chrome");
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByTestId("sidebar-address")).toBeVisible();
    await expect(sidebar.getByTestId("sidebar-tab-list")).toBeVisible();
    await expect(sidebar.getByTestId("human-tab")).toBeVisible();
    await expect(shell.getByRole("tablist", { name: "Open tabs" })).toHaveAttribute("aria-orientation", "vertical");
    await expect(shell.getByTestId("new-tab-button")).toHaveCount(1);
    await expect(sidebar.getByTestId("new-tab-button")).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "Compact sidebar" })).toBeVisible();

    // The footer is one button, the Space avatar: its menu has the Space on
    // top and the chrome's other controls as rows below. Hovering it shows
    // the menu; moving away hides it again.
    await expect(sidebar.getByTestId("sidebar-menu-button")).toBeVisible();
    await expect(sidebar.getByTestId("split-toggle")).toHaveCount(0);
    await sidebar.getByTestId("sidebar-menu-button").hover();
    const footerMenu = sidebar.getByTestId("sidebar-menu");
    await expect(footerMenu).toBeVisible();
    await expect(footerMenu.getByTestId("sidebar-menu-profile")).toBeVisible();
    await expect(footerMenu.getByTestId("split-toggle")).toHaveCount(0);
    await expect(footerMenu.getByTestId("agent-panel-toggle")).toBeVisible();
    await expect(footerMenu.getByTestId("reminders-button")).toBeVisible();
    await expect(footerMenu.getByTestId("settings-button")).toBeVisible();
    await sidebar.getByTestId("sidebar-address").hover();
    await expect(footerMenu).toHaveCount(0);

    // Split view works without a button (the menu does not list it).
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.setSplit("vertical"));
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
    await expect(sidebar.getByRole("group", { name: /^Split view:/ })).toBeVisible();
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.setSplit("single"));
    await expect(shell.getByTestId("secondary-pane")).toHaveCount(0);

    // The list's "New tab" row does what ⌘T does: the address modal composing
    // a new tab, over the whole window.
    await sidebar.getByTestId("new-tab-button").click();
    await expect(shell.getByTestId("url-bar")).toBeVisible();
    await expect(shell.getByTestId("address-input")).toBeFocused();
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    await expect.poll(() => visibleTabViews(app)).toBe(1);
    // Let the layout's re-arrangement, the page's 140ms fade-in, and the
    // sidebar's 220ms slide settle first.
    await captureWindow(app, FOLDER, "01-sidebar-pinned.png", 400);

    // SIDEBAR, COMPACT: the column leaves the shell's layout; only the edge
    // trigger stays, and the traffic lights go with the sidebar. No chrome
    // view is involved: the compact sidebar is the pinned column, auto-hidden.
    const settings = await openGeneralSettings(shell, true);
    await settings.getByTestId("sidebar-presentation").selectOption("compact");
    await shell.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    // The column remains mounted so compact reveal/hide can reverse without
    // recreating its shelf; hidden makes it inert after the retreat lands.
    await expect(shell.getByTestId("sidebar-chrome")).toBeHidden();
    await expect(shell.getByTestId("sidebar-edge")).toBeVisible();
    await expect.poll(() => storedLayout(userData)).toEqual({ sidebar: "compact" });
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: false, sidebarView: false });
    const hiddenPage = await shell.getByTestId("primary-pane").boundingBox();
    await captureWindow(app, FOLDER, "02-sidebar-compact.png", 400);

    // Pointer movement in the edge puts the SAME column back into the
    // layout, and the page moves over to make room — identical to pinned —
    // with the traffic lights back over its toolbar.
    // A raw move, not locator.hover(): the strip unmounts the moment the
    // pointer moves in it, which hover() would wait out as "unstable".
    const edge = await shell.getByTestId("sidebar-edge").boundingBox();
    await shell.mouse.move(edge!.x + 4, edge!.y + 200);
    await shell.mouse.move(edge!.x + 5, edge!.y + 210);
    const pane = shell.getByTestId("sidebar-pane");
    await expect(pane).toBeVisible();
    await expect(pane).toHaveAttribute("data-auto-hide", "");
    await expect(shell.getByTestId("sidebar-edge")).toHaveCount(0);
    await expect(shell.getByTestId("sidebar-chrome")).toBeVisible();
    await expect(pane.getByTestId("human-tab").first()).toBeVisible();
    await expect(pane.getByTestId("sidebar-address")).toBeVisible();
    await expect(pane.getByRole("button", { name: "Pin sidebar" })).toBeVisible();
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: true, sidebarView: false });
    await expect
      .poll(async () => Math.round((await shell.getByTestId("sidebar-motion-slot").boundingBox())?.width ?? 0))
      .toBe(Math.round((await pane.boundingBox())?.width ?? 0));
    const revealedPage = await shell.getByTestId("primary-pane").boundingBox();
    const paneBox = await pane.boundingBox();
    expect(paneBox).not.toBeNull();
    expect(revealedPage!.x).toBeGreaterThanOrEqual(paneBox!.x + paneBox!.width);
    expect(revealedPage!.width).toBeLessThan(hiddenPage!.width);
    await expect.poll(() => visibleTabViews(app)).toBe(1);
    await captureWindow(app, FOLDER, "03-sidebar-compact-revealed.png", 400);

    // Moving onto the page is the leave: the column goes, the edge returns,
    // and the page takes its width back.
    await shell.mouse.move(revealedPage!.x + revealedPage!.width / 2, revealedPage!.y + revealedPage!.height / 2);
    await expect(shell.getByTestId("sidebar-pane")).toBeHidden();
    await expect(shell.getByTestId("sidebar-edge")).toBeVisible();
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: false });
    await expect.poll(async () => (await shell.getByTestId("primary-pane").boundingBox())?.width).toBe(hiddenPage!.width);

    // And again: the edge is back under the layout, and movement in it
    // brings the column out a second time — the cycle that used to break.
    await shell.mouse.move(edge!.x + 4, edge!.y + 300);
    await shell.mouse.move(edge!.x + 5, edge!.y + 310);
    await expect(shell.getByTestId("sidebar-pane")).toBeVisible();
    await expect(shell.getByTestId("sidebar-edge")).toHaveCount(0);
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: true });
    await expect
      .poll(async () => Math.round((await shell.getByTestId("sidebar-motion-slot").boundingBox())?.width ?? 0))
      .toBe(Math.round((await pane.boundingBox())?.width ?? 0));
    // Resting on the column keeps it: no hide creeps in on its own.
    await shell.mouse.move(60, 400);
    await shell.waitForTimeout(500);
    await expect(shell.getByTestId("sidebar-pane")).toBeVisible();
    await shell.mouse.move(revealedPage!.x + revealedPage!.width / 2, revealedPage!.y + revealedPage!.height / 2);
    await expect(shell.getByTestId("sidebar-pane")).toBeHidden();
    await expect(shell.getByTestId("sidebar-edge")).toBeVisible();

    // ⌘S pins the sidebar back into the layout and again makes it compact
    // (which hides it at once, rather than holding it until the pointer leaves).
    await shell.keyboard.press("Meta+s");
    await expect.poll(() => storedLayout(userData)).toEqual({ sidebar: "pinned" });
    await expect(shell.getByTestId("sidebar-chrome")).toBeVisible();
    await expect(shell.getByTestId("sidebar-pane")).not.toHaveAttribute("data-auto-hide", "");
    await expect(shell.getByTestId("sidebar-edge")).toHaveCount(0);
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: true });
    await shell.keyboard.press("Meta+s");
    await expect.poll(() => storedLayout(userData)).toEqual({ sidebar: "compact" });
    await expect(shell.getByTestId("sidebar-chrome")).toBeHidden();
    await expect(shell.getByTestId("sidebar-edge")).toBeVisible();
  });

  test("the compact sidebar reveals over multiple stable animation frames", async () => {
    // Hidden compact mode must be stable before the reveal is measured.
    const edge = shell.getByTestId("sidebar-edge");
    await expect(edge).toBeVisible();
    await expect(shell.getByTestId("sidebar-pane")).toBeHidden();
    await captureLeft(shell, "compact-01-hidden.png");
    const box = await edge.boundingBox();
    if (box === null) throw new Error("compact sidebar edge has no box");
    expect(box.width).toBeCloseTo(SIDEBAR_TRIGGER_W, 0);
    const hiddenSlot = await shell.getByTestId("sidebar-motion-slot").boundingBox();
    const hiddenPage = await shell.getByTestId("primary-pane").boundingBox();
    if (hiddenSlot === null || hiddenPage === null) throw new Error("compact hidden geometry is missing");
    expect(hiddenSlot.width).toBeCloseTo(SIDEBAR_EDGE_W, 0);
    expect(hiddenPage.x).toBeCloseTo(SIDEBAR_EDGE_W, 0);

    // Sampling from before the gesture exposes jumps that settled screenshots miss.
    await beginGeometrySampling(shell);
    await shell.mouse.move(box.x + 4, box.y + 200);
    await shell.mouse.move(box.x + 5, box.y + 210);
    const pane = shell.getByTestId("sidebar-pane");
    await expect(pane).toBeVisible();
    await expect.poll(() => motionProgress(shell), { intervals: [8] }).toBeGreaterThan(0.18);
    await captureLeft(shell, "compact-02-revealing.png");
    // Playwright has no OS cursor for main's native drag-region backstop, so
    // carry its synthetic pointer into the now-open shell column.
    await shell.mouse.move(60, box.y + 210);
    const revealSamples = await finishGeometrySampling(shell);
    expectSmoothTransition(revealSamples);
    await expect(shell.getByTestId("sidebar-motion-slot")).not.toHaveAttribute("data-hidden", "");
    await captureLeft(shell, "compact-03-revealed.png");

    // The retreat uses the same continuous geometry rather than disappearing first.
    const page = await shell.getByTestId("primary-pane").boundingBox();
    if (page === null) throw new Error("primary pane has no box");
    await beginGeometrySampling(shell);
    await shell.mouse.move(page.x + page.width / 2, page.y + page.height / 2);
    await expect(shell.getByTestId("sidebar-motion-slot")).toHaveAttribute("data-hidden", "");
    await expect.poll(() => motionProgress(shell), { intervals: [8] }).toBeGreaterThan(0.18);
    await captureLeft(shell, "compact-04-hiding.png");
    const hideSamples = await finishGeometrySampling(shell);
    expectSmoothTransition(hideSamples);
    await expect(pane).toBeHidden();
    await expect(edge).toBeVisible();

    // A normal re-entry proves the edge remains live after a completed close.
    await shell.mouse.move(box.x + 4, box.y + 300);
    await shell.mouse.move(box.x + 5, box.y + 310);
    await expect(pane).toBeVisible();
    await expect.poll(() => motionProgress(shell), { intervals: [8] }).toBeGreaterThan(0.18);
    await shell.mouse.move(60, box.y + 310);
    await expect.poll(async () => Math.round((await shell.getByTestId("sidebar-motion-slot").boundingBox())?.width ?? 0)).toBe(248);

    // Re-entering during the next close reverses the live transition instead of snapping.
    await beginGeometrySampling(shell);
    await shell.mouse.move(page.x + page.width / 2, page.y + page.height / 2);
    await expect(shell.getByTestId("sidebar-motion-slot")).toHaveAttribute("data-hidden", "");
    await expect.poll(() => motionProgress(shell), { intervals: [8] }).toBeGreaterThan(0.18);
    await captureLeft(shell, "compact-05-reversing.png");
    await shell.mouse.move(box.x + 4, box.y + 300);
    await shell.mouse.move(box.x + 5, box.y + 310);
    await expect(shell.getByTestId("sidebar-motion-slot")).not.toHaveAttribute("data-hidden", "");
    await shell.mouse.move(60, box.y + 310);
    const reversalSamples = await finishGeometrySampling(shell);
    const reversal = geometrySummary(reversalSamples);
    expect(reversal.distinctWidths).toBeGreaterThanOrEqual(5);
    expect(reversal.maxWidthDelta).toBeLessThan(100);
    expect(reversal.minWidth).toBeLessThan(230);
    expect(reversal.maxWidth).toBeCloseTo(248, 0);
    await expect(pane).toBeVisible();
    await captureLeft(shell, "compact-06-reversed-revealed.png");

    console.log(`compact-sidebar geometry ${JSON.stringify({ reveal: geometrySummary(revealSamples), hide: geometrySummary(hideSamples), reversal })}`);
  });
});
