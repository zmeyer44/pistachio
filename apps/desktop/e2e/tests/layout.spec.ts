import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { sidebarMenuItem } from "./footer";
import { pageFirst, shellReady } from "./windows";
import type { WebContentsView } from "electron";
import { SIDEBAR_DESK_TRIGGER_W, SIDEBAR_EDGE_W } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { DesktopSettings } from "@pistachio/shell-contracts/settings";
import { captureEnabled, launchApp } from "./app";
import { captureShell, captureWindow, visibleTabViews } from "./chrome-harness";

const FOLDER = "layout";

/**
 * The window buttons as main has them, and whether a sidebar chrome view
 * exists at all (it must not: the hidden sidebar is the shell's own column).
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
  paneX: number;
  stageX: number;
}

/** Sample the column's place and the desk's leading edge on every frame for `ms`: jumps that settled screenshots miss. */
async function beginGeometrySampling(shell: Page, ms = 700): Promise<void> {
  await shell.evaluate((ms) => {
    const target = window as unknown as { __sidebarSamples?: GeometrySample[]; __sidebarSamplingDone?: boolean };
    target.__sidebarSamples = [];
    target.__sidebarSamplingDone = false;
    const started = performance.now();
    const sample = (now: number) => {
      const pane = document.querySelector<HTMLElement>('[data-testid="sidebar-pane"]');
      const stage = document.querySelector<HTMLElement>(".desk-stage");
      target.__sidebarSamples?.push({ time: now - started, paneX: pane?.getBoundingClientRect().x ?? 0, stageX: stage?.getBoundingClientRect().x ?? 0 });
      if (now - started < ms) requestAnimationFrame(sample);
      else target.__sidebarSamplingDone = true;
    };
    requestAnimationFrame(sample);
  }, ms);
}

async function finishGeometrySampling(shell: Page): Promise<GeometrySample[]> {
  await expect
    .poll(() => shell.evaluate(() => (window as unknown as { __sidebarSamplingDone?: boolean }).__sidebarSamplingDone === true), { intervals: [20] })
    .toBe(true);
  return shell.evaluate(() => (window as unknown as { __sidebarSamples?: GeometrySample[] }).__sidebarSamples ?? []);
}

function geometrySummary(samples: GeometrySample[]) {
  const xs = samples.map((sample) => sample.paneX);
  const deltas = xs.slice(1).map((x, index) => Math.abs(x - xs[index]!));
  return {
    frames: samples.length,
    distinctPaneXs: new Set(xs.map(Math.round)).size,
    distinctStageXs: new Set(samples.map((sample) => Math.round(sample.stageX))).size,
    maxPaneDelta: Math.max(0, ...deltas),
    minPaneX: Math.min(...xs),
    maxPaneX: Math.max(...xs),
  };
}

/** A slide over several frames, never a jump — and the desk beside it never moves (an overlay, not a reflow). */
function expectSmoothSlide(samples: GeometrySample[]): void {
  const summary = geometrySummary(samples);
  expect(summary.distinctPaneXs).toBeGreaterThanOrEqual(6);
  expect(summary.maxPaneDelta).toBeLessThan(120);
  expect(summary.minPaneX).toBeLessThan(-150);
  expect(summary.maxPaneX).toBeCloseTo(0, 0);
  expect(summary.distinctStageXs).toBe(1);
}

/** How far the column's slide (its transform) has run, 0–1; 0 with none running. */
async function motionProgress(shell: Page): Promise<number> {
  return shell.getByTestId("sidebar-motion-slot").evaluate((element) => {
    const transition = element
      .getAnimations({ subtree: true })
      .find((animation) => animation instanceof CSSTransition && (animation.transitionProperty === "width" || animation.transitionProperty === "transform"));
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

/** Into the hidden sidebar's edge strip: raw moves, not hover() — the strip goes the moment the pointer moves in it. */
async function intoEdge(shell: Page, y: number): Promise<void> {
  await shell.mouse.move(2, y);
  await shell.mouse.move(3, y + 10);
}

// One window over a web page, its sidebar whole, through the sidebar's modes:
// its context menu over the native page, every control it holds, hidden and
// brought out over the desk and back, the rail, and the hidden column's slide
// frame by frame (sidebar-modes.spec has the desk's own cases: the cover, the
// pointer's word from main, a carry to the edge).
test.describe.serial("the sidebar layout", { tag: ["@sidebar", "@settings"] }, () => {
  test.describe.configure({ timeout: 60_000 });
  let app: ElectronApplication;
  let userData: string;
  let shell: Page;

  test.beforeAll(async () => {
    ({ app, userData } = await launchApp({ settings: pageFirst(), sidebar: "whole", name: "layout" }));
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
    // Under the menu the page's window is its still (the live page goes down for it).
    await expect(shell.locator('[data-testid="desk-window-page"] img.desk-still')).toHaveCount(1);
    await expect.poll(() => visibleTabViews(app)).toBe(0);
    await expect(menu.getByRole("menuitem", { name: "Close tab" })).toBeVisible();
    await captureShell(app, FOLDER, "context-menu-02-menu-over-page.png");

    // Dismissal lowers the shell and restores the live native page.
    await shell.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect.poll(() => visibleTabViews(app)).toBe(1);
    await captureShell(app, FOLDER, "context-menu-03-menu-dismissed.png");
  });

  test("the sidebar holds every control, whole, as a rail and hidden over the desk", { tag: ["@smoke"] }, async () => {
    // WHOLE: the column holds the address, the tab list with its "New tab"
    // row, and the button down to the rail.
    const sidebar = shell.getByTestId("sidebar-chrome");
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByTestId("sidebar-address")).toBeVisible();
    await expect(sidebar.getByTestId("sidebar-tab-list")).toBeVisible();
    await expect(sidebar.getByTestId("human-tab")).toBeVisible();
    await expect(shell.getByRole("tablist", { name: "Open tabs" })).toHaveAttribute("aria-orientation", "vertical");
    await expect(shell.getByTestId("new-tab-button")).toHaveCount(1);
    await expect(sidebar.getByTestId("new-tab-button")).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "Collapse sidebar to a rail" })).toBeVisible();
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: true, sidebarView: false });

    // The footer is one button, the Profile's avatar: its menu has the Profile
    // on top and the chrome's other controls as rows below. Hovering it shows
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

    // No split view on the desktop: the desk lays windows side by side instead.
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.setSplit("vertical"));
    await expect(shell.getByTestId("secondary-pane")).toHaveCount(0);
    expect(await shell.evaluate(async () => (await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot()).splitMode)).toBe("single");

    // The list's "New tab" row does what ⌘T does on the desk: a new tab in
    // the current space, on the home page (an address, here), out as the
    // window in use.
    const tabsBefore = await shell.evaluate(async () => (await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot()).tabs.map((tab) => tab.id));
    await sidebar.getByTestId("new-tab-button").click();
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    const made = await shell.evaluate(async (before) => {
      const snapshot = await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot();
      return snapshot.tabs.find((tab) => !before.includes(tab.id) && tab.id === snapshot.activeTabId)?.id ?? null;
    }, tabsBefore);
    expect(made).not.toBeNull();
    await expect(shell.locator(`[data-testid="desk-window"][data-tab-id="${made!}"][data-focused]`)).toHaveCount(1);
    expect(await shell.evaluate(async (id) => (await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot()).tabs.find((tab) => tab.id === id)?.url, made!)).toBe(
      "https://www.google.com/",
    );
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(id), made!);
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await expect.poll(() => visibleTabViews(app)).toBe(1);
    // Let the layout's re-arrangement and the page's fade-in settle first.
    await captureWindow(app, FOLDER, "01-sidebar-whole.png", 400);

    // HIDDEN: the column leaves the layout; only the edge's strip stays, and
    // the traffic lights go with the sidebar. No chrome view is involved: it
    // is the same column, hidden — over the desk, an overlay when it comes out.
    const settings = await openGeneralSettings(shell, true);
    await settings.getByTestId("sidebar-presentation").selectOption("hidden");
    await shell.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    // The column remains mounted so a reveal and its retreat can reverse
    // without recreating it; hidden makes it inert after the retreat lands.
    await expect(shell.getByTestId("sidebar-chrome")).toBeHidden();
    await expect(shell.getByTestId("sidebar-edge")).toBeVisible();
    await expect.poll(() => storedLayout(userData)).toEqual({ sidebar: "hidden" });
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: false, sidebarView: false });
    await expect.poll(async () => Math.round((await shell.getByTestId("sidebar-motion-slot").boundingBox())?.width ?? 0)).toBe(SIDEBAR_EDGE_W);
    const stage = await shell.locator(".desk-stage").boundingBox();
    expect(stage!.x).toBeCloseTo(SIDEBAR_EDGE_W, 0);
    await captureWindow(app, FOLDER, "02-sidebar-hidden.png", 400);

    // Pointer movement in the edge brings the SAME column out — over the desk,
    // which does not move — with the traffic lights back over its toolbar.
    const edge = await shell.getByTestId("sidebar-edge").boundingBox();
    expect(edge!.width).toBeCloseTo(SIDEBAR_DESK_TRIGGER_W, 0);
    await intoEdge(shell, edge!.y + 200);
    const pane = shell.getByTestId("sidebar-pane");
    await expect(pane).not.toHaveAttribute("data-hidden", "");
    await expect(pane).toBeVisible();
    await expect(pane).toHaveAttribute("data-auto-hide", "");
    await expect(pane).toHaveAttribute("data-overlay", "");
    await expect(shell.getByTestId("sidebar-edge")).toHaveCount(0);
    await expect(shell.getByTestId("sidebar-chrome")).toBeVisible();
    await expect(pane.getByTestId("human-tab").first()).toBeVisible();
    await expect(pane.getByTestId("sidebar-address")).toBeVisible();
    await expect(pane.getByRole("button", { name: "Keep the sidebar open" })).toBeVisible();
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: true, sidebarView: false });
    expect(Math.round((await shell.getByTestId("sidebar-motion-slot").boundingBox())!.width)).toBe(SIDEBAR_EDGE_W);
    expect((await shell.locator(".desk-stage").boundingBox())!.x).toBeCloseTo(stage!.x, 0);
    await captureWindow(app, FOLDER, "03-sidebar-hidden-revealed.png", 400);
    // (Onto the column itself once its slide has landed, as a pointer coming out of the edge goes.)
    await expect.poll(async () => Math.round((await pane.boundingBox())?.x ?? -1)).toBe(0);
    await shell.mouse.move(60, edge!.y + 220);

    // Moving onto the page is the leave: the column goes, the edge returns.
    // (Main cannot read the OS pointer under Playwright: the page's leave stands.)
    await shell.mouse.move(stage!.x + stage!.width / 2, stage!.y + stage!.height / 2);
    await expect(pane).toHaveAttribute("data-hidden", "");
    await expect(shell.getByTestId("sidebar-edge")).toBeVisible();
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: false });

    // And again: the edge is back, and movement in it brings the column out
    // a second time — the cycle that used to break.
    await intoEdge(shell, edge!.y + 300);
    await expect(pane).not.toHaveAttribute("data-hidden", "");
    await expect(shell.getByTestId("sidebar-edge")).toHaveCount(0);
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: true });
    // Resting on the column keeps it: no hide creeps in on its own.
    await expect.poll(async () => Math.round((await pane.boundingBox())?.x ?? -1)).toBe(0);
    await shell.mouse.move(60, 400);
    await shell.waitForTimeout(500);
    await expect(pane).not.toHaveAttribute("data-hidden", "");
    await shell.mouse.move(stage!.x + stage!.width / 2, stage!.y + stage!.height / 2);
    await expect(pane).toHaveAttribute("data-hidden", "");
    await expect(shell.getByTestId("sidebar-edge")).toBeVisible();

    // ⌘S goes on round the modes: whole, then a rail, then hidden again.
    await shell.keyboard.press("Meta+s");
    await expect.poll(() => storedLayout(userData)).toEqual({ sidebar: "whole" });
    await expect(shell.getByTestId("sidebar-chrome")).toBeVisible();
    await expect(pane).not.toHaveAttribute("data-auto-hide", "");
    await expect(shell.getByTestId("sidebar-edge")).toHaveCount(0);
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: true });
    await shell.keyboard.press("Meta+s");
    await expect.poll(() => storedLayout(userData)).toEqual({ sidebar: "rail" });
    await expect(shell.locator('[data-testid="sidebar-motion-slot"][data-mode="rail"]')).toHaveCount(1);
    await expect(shell.getByRole("button", { name: "Show the whole sidebar" })).toBeVisible();
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: false });
    await shell.keyboard.press("Meta+s");
    await expect.poll(() => storedLayout(userData)).toEqual({ sidebar: "hidden" });
    await expect(shell.getByTestId("sidebar-chrome")).toBeHidden();
    await expect(shell.getByTestId("sidebar-edge")).toBeVisible();
  });

  test("the hidden sidebar slides out over the desk over several frames, and back, the desk beside it never moving", async () => {
    // Hidden must be at rest before the reveal is measured.
    const edge = shell.getByTestId("sidebar-edge");
    await expect(edge).toBeVisible();
    const pane = shell.getByTestId("sidebar-pane");
    await expect(pane).toHaveAttribute("data-hidden", "");
    await captureLeft(shell, "hidden-01-away.png");
    const box = await edge.boundingBox();
    if (box === null) throw new Error("the hidden sidebar's edge has no box");
    const stage = await shell.locator(".desk-stage").boundingBox();
    if (stage === null) throw new Error("no desk");

    // Sampling from before the gesture exposes jumps that settled screenshots miss.
    // (The column waits for the page under it to give way to its still, then slides: the window is long enough for both.)
    await beginGeometrySampling(shell, 900);
    await intoEdge(shell, box.y + 200);
    await expect(pane).not.toHaveAttribute("data-hidden", "");
    await expect.poll(() => motionProgress(shell), { intervals: [8] }).toBeGreaterThan(0.18);
    await captureLeft(shell, "hidden-02-revealing.png");
    // Playwright has no OS cursor for main's watch, so carry its pointer into the column.
    await shell.mouse.move(60, box.y + 210);
    const revealSamples = await finishGeometrySampling(shell);
    expectSmoothSlide(revealSamples);
    await captureLeft(shell, "hidden-03-revealed.png");

    // The retreat slides the same way rather than disappearing first.
    await beginGeometrySampling(shell, 500);
    await shell.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await expect(pane).toHaveAttribute("data-hidden", "");
    await expect.poll(() => motionProgress(shell), { intervals: [8] }).toBeGreaterThan(0.18);
    await captureLeft(shell, "hidden-04-hiding.png");
    const hideSamples = await finishGeometrySampling(shell);
    expectSmoothSlide(hideSamples);
    await expect(edge).toBeVisible();

    // A normal re-entry proves the edge stays live after a completed retreat.
    await intoEdge(shell, box.y + 300);
    await expect(pane).not.toHaveAttribute("data-hidden", "");
    await shell.mouse.move(60, box.y + 310);
    await expect.poll(async () => Math.round((await pane.boundingBox())?.x ?? -1)).toBe(0);
    await captureLeft(shell, "hidden-05-revealed-again.png");
    console.log(`hidden-sidebar geometry ${JSON.stringify({ reveal: geometrySummary(revealSamples), hide: geometrySummary(hideSamples) })}`);
  });
});
