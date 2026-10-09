/**
 * Minimized desk windows end to end (docs/desk.md, "Minimize"): the
 * window's Minimize button shrinks it into the shelf at the desk's foot,
 * beside the sidebar, peeking up a quarter of its height, its page shown as if
 * zoomed to 50% (laid out twice the window's size, and only that tab: its
 * site's other tab is untouched) and live, its view cut short at the desk's
 * edge. The pointer on it — on its frame, or on its live page, which main
 * relays — raises it into view, and a click lands on the page where it is
 * drawn. The next one stacks to the right, overlapping it by half. Dragged
 * out it is a minimized window like any other, resized and still zoomed;
 * the shelf lies over the windows there, their pages cut short of it;
 * Expand gives each its box and its page
 * its own size back; Collapse (the old Put away) sends one into the sidebar.
 */

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { box, createGroup, fromFrameMenu, INVOICES, launchDesk, liveViews, selectSpace, openTabs, rowSelector, screenshots, selectTab, settled, snapshot, VENDOR, windowSelector, type Box } from "./desk-harness";

const capture = screenshots("desk-minimize");

function near(actual: number, expected: number, within = 2): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(within);
}

/** A tab's view's box, whether it is on screen or not. */
function viewBounds(app: ElectronApplication, url: string): Promise<Box | null> {
  return app.evaluate(({ BrowserWindow }, url) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window?.contentView.children.find((child) => "webContents" in child && (child as WebContentsView).webContents.getURL() === url) as WebContentsView | undefined;
    return view === undefined ? null : view.getBounds();
  }, url);
}

/** The desk's shelf view (main's "shelf" chrome view) on screen, and its box; null while it is not. */
function shelfView(app: ElectronApplication): Promise<Box | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window?.contentView.children.find(
      (child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith("#shelf") && (child as WebContentsView).getVisible(),
    ) as WebContentsView | undefined;
    return view === undefined ? null : view.getBounds();
  });
}

/** A mouse event on the shelf view, as the person's pointer would reach it. */
function shelfMouse(app: ElectronApplication, type: "mouseMove" | "mouseLeave", x: number, y: number): Promise<void> {
  return app.evaluate(
    async ({ webContents }, { type, x, y }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith("#shelf"));
      if (contents === undefined) throw new Error("no shelf view");
      contents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y) });
      await new Promise((done) => setTimeout(done, 60));
    },
    { type, x, y },
  );
}

/** Run a script in the tab's page. */
function inPage<T>(app: ElectronApplication, url: string, script: string): Promise<T> {
  return app.evaluate(
    async ({ webContents }, { url, script }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
      if (contents === undefined) throw new Error(`no page at ${url}`);
      return contents.executeJavaScript(script) as Promise<T>;
    },
    { url, script },
  );
}

/** The tab's page and its zoom factor: what it lays out at, and whether the site's zoom was touched. */
function pageSize(app: ElectronApplication, url: string): Promise<{ width: number; height: number; zoom: number }> {
  return app.evaluate(
    async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
      if (contents === undefined) throw new Error(`no page at ${url}`);
      const [width, height] = (await contents.executeJavaScript("[innerWidth, innerHeight]")) as [number, number];
      return { width, height, zoom: contents.getZoomFactor() };
    },
    url,
  );
}

/** A mouse event on the tab's page, as the person's would reach it (main's mouse hook sees it). */
function pageMouse(app: ElectronApplication, url: string, type: "mouseMove" | "mouseLeave" | "click", x: number, y: number): Promise<void> {
  return app.evaluate(
    async ({ webContents }, { url, type, x, y }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
      if (contents === undefined) throw new Error(`no page at ${url}`);
      if (type === "click") {
        contents.sendInputEvent({ type: "mouseMove", x, y });
        contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
        await new Promise((done) => setTimeout(done, 40));
        contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      } else contents.sendInputEvent({ type, x, y });
      await new Promise((done) => setTimeout(done, 60));
    },
    { url, type, x, y },
  );
}

const ACCOUNTS = "pistachio://demo/auth/relying-party";
/** A minimized window (the least a window may be), its page box inside the title bar frame, and that box at 50%. */
const MINI = { w: 300, h: 200 };
const MINI_PAGE = { w: 290, h: 161 };
/** Where the shelf begins: in from the desk's leading edge, clear of its rounded corner (the engine's SHELF_INSET). */
const LEFT = 18;

test("minimized windows: parked peeking at the desk's foot, zoomed out and live, raised by the pointer, stacked, dragged out, resized, expanded", { tag: ["@desk"] }, async () => {
  test.setTimeout(150_000);
  const { app, shell } = await launchDesk({ name: "minimize" });
  try {
    const pageErrors: string[] = [];
    shell.on("pageerror", (error) => pageErrors.push(error.message));
    const [invoice, vendor, accounts] = (await openTabs(shell, [INVOICES, VENDOR, ACCOUNTS])) as [string, string, string];
    await createGroup(shell, "desk-mini", [invoice, vendor, accounts], "Northstar", "blue");
    await selectTab(shell, invoice);
    await selectSpace(shell, "desk-mini");
    await expect(shell.locator('[data-testid="tab-group"] [role="tab"]')).toHaveCount(3);
    await settled(shell, app);
    // The vendor and the accounts out too: three windows.
    for (const tabId of [vendor, accounts]) {
      await shell.locator(rowSelector(tabId)).click();
      await settled(shell, app);
    }
    await expect(shell.locator('[data-testid="desk-window"]')).toHaveCount(3);
    const stage = await box(shell, ".desk-stage");
    const foot = stage.y + stage.height;
    // A parked window peeks up from the desk card's foot, cut off there: the surface's gutter below stays clear.
    const edge = foot;
    /** Where the shelf's windows peek up from, and the line the desk's windows keep above. */
    // (A quarter of it shows: its title bar and a strip of its page.)
    const peekY = edge - MINI.h / 4;
    /** Where a minimized window let go parks: in the shelf's band, from a gap above where they peek up. */
    const shelfTop = peekY - 8;
    const away = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.7, stage.y + 40);
    await away();
    const invoiceWindow = shell.locator(windowSelector(invoice));
    const vendorWindow = shell.locator(windowSelector(vendor));
    // The invoice in use, on top.
    await selectTab(shell, invoice);
    await settled(shell, app);
    const invoiceBefore = await box(shell, windowSelector(invoice));
    const invoicePageBefore = await pageSize(app, INVOICES);
    await capture(app, shell, "01-three-windows.png");

    // ── 1. Minimize: into the shelf at the desk's foot, beside the sidebar, three quarters of it below the desk's edge ─
    await fromFrameMenu(shell, invoiceWindow, "desk-minimize");
    await settled(shell, app);
    await expect(invoiceWindow).toHaveAttribute("data-mini", "parked");
    const parked = await box(shell, windowSelector(invoice));
    near(parked.x, stage.x + LEFT);
    near(parked.y, peekY);
    near(parked.width, MINI.w);
    near(parked.height, MINI.h);
    // Its page is zoomed out: laid out at twice its box. Its site's other tab, and the site's own zoom, untouched.
    await expect.poll(() => pageSize(app, INVOICES)).toEqual({ width: MINI_PAGE.w * 2, height: MINI_PAGE.h * 2, zoom: 1 });
    const vendorView = (await viewBounds(app, VENDOR))!;
    await expect.poll(() => pageSize(app, VENDOR)).toEqual({ width: vendorView.width, height: vendorView.height, zoom: 1 });
    // Live while it peeks: its view cut short at the desk's edge.
    await expect
      .poll(async () => (await liveViews(app)).find((view) => view.url === INVOICES)?.bounds ?? null)
      .toEqual({ x: Math.round(parked.x + 5), y: Math.round(parked.y + 34), width: MINI_PAGE.w, height: Math.round(edge - (parked.y + 34)) });
    // The shelf lies over the windows at the desk's foot: a live page under it stops where it peeks up.
    for (const url of [VENDOR, ACCOUNTS]) {
      const view = (await liveViews(app)).find((candidate) => candidate.url === url);
      if (view !== undefined && view.bounds.x < parked.x + parked.width && parked.x < view.bounds.x + view.bounds.width)
        expect(view.bounds.y + view.bounds.height).toBeLessThanOrEqual(peekY + 1);
    }
    await capture(app, shell, "02-minimized.png");

    // ── 2. The pointer on its live page (main's word) raises it into view; a click lands where the page is drawn ─
    await pageMouse(app, INVOICES, "mouseMove", 120, 8);
    await expect(invoiceWindow).toHaveAttribute("data-raised", "");
    await expect.poll(async () => Math.round((await box(shell, windowSelector(invoice))).y)).toBe(Math.round(foot - MINI.h - 8));
    await expect
      .poll(async () => (await liveViews(app)).find((view) => view.url === INVOICES)?.bounds.height ?? 0)
      .toBe(MINI_PAGE.h);
    await inPage(app, INVOICES, "window.__pressed = []; addEventListener('mousedown', (event) => __pressed.push([event.clientX, event.clientY]), true); true");
    await pageMouse(app, INVOICES, "click", 100, 60);
    await expect.poll(() => inPage<number[][]>(app, INVOICES, "window.__pressed")).toEqual([[200, 120]]);
    await capture(app, shell, "03-raised.png");
    // Off its page: back down a moment later.
    await pageMouse(app, INVOICES, "mouseLeave", 120, 8);
    await expect(invoiceWindow).not.toHaveAttribute("data-raised", "");
    await expect.poll(async () => Math.round((await box(shell, windowSelector(invoice))).y)).toBe(Math.round(peekY));

    // ── 3. The next one stacks to the right, overlapping it by half, and over it; the pointer on its frame raises only it ─
    await fromFrameMenu(shell, vendorWindow, "desk-minimize");
    await settled(shell, app);
    await expect(vendorWindow).toHaveAttribute("data-mini", "parked");
    const second = await box(shell, windowSelector(vendor));
    near(second.x, stage.x + LEFT + MINI.w / 2);
    near(second.y, peekY);
    const z = async (selector: string): Promise<number> => Number(await shell.locator(selector).evaluate((el) => getComputedStyle(el).zIndex));
    expect(await z(windowSelector(vendor))).toBeGreaterThan(await z(windowSelector(invoice)));
    await shell.mouse.move(second.x + MINI.w - 60, second.y + 17);
    await expect(vendorWindow).toHaveAttribute("data-raised", "");
    await expect(invoiceWindow).not.toHaveAttribute("data-raised", "");
    await capture(app, shell, "04-stacked-one-raised.png", 600);
    await away();
    await expect(vendorWindow).not.toHaveAttribute("data-raised", "");
    await settled(shell, app);

    // ── 4. Dragged out by its title bar: out on the desk, still minimized and zoomed; the shelf closes up ─
    const grip = { x: second.x + MINI.w - 80, y: second.y + 17 };
    await shell.mouse.move(grip.x, grip.y);
    await shell.mouse.down();
    for (let step = 1; step <= 24; step += 1) await shell.mouse.move(grip.x + step * 22, grip.y - step * 18);
    // Held still before letting go: set down, not thrown.
    await shell.waitForTimeout(250);
    await shell.mouse.move(grip.x + 24 * 22, grip.y - 24 * 18);
    await shell.waitForTimeout(150);
    await shell.mouse.up();
    await settled(shell, app);
    await expect(vendorWindow).toHaveAttribute("data-mini", "free");
    const free = await box(shell, windowSelector(vendor));
    near(free.width, MINI.w);
    near(free.height, MINI.h);
    expect(free.y + free.height).toBeLessThanOrEqual(shelfTop + 1);
    near((await box(shell, windowSelector(invoice))).x, stage.x + LEFT);
    // Resized from its corner, its page is laid out at twice its new box.
    const corner = await box(shell, `${windowSelector(vendor)} [data-desk-edge="se"]`);
    await shell.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await shell.mouse.down();
    for (let step = 1; step <= 10; step += 1) await shell.mouse.move(corner.x + corner.width / 2 + step * 12, corner.y + corner.height / 2 + step * 8);
    await shell.waitForTimeout(150);
    await shell.mouse.up();
    await settled(shell, app);
    const resized = await box(shell, windowSelector(vendor));
    expect(resized.width).toBeGreaterThan(MINI.w + 100);
    await expect
      .poll(async () => (await pageSize(app, VENDOR)).width)
      .toBe(Math.round(resized.width - 10) * 2);
    await capture(app, shell, "05-dragged-out-resized.png");

    // ── 5. Filling the desk, a window grows into it as its live page, laid out at the desk's size from the start
    //       — never its still stretched to it — the shelf over its foot ─
    await selectTab(shell, accounts);
    await settled(shell, app);
    await inPage(app, ACCOUNTS, "window.__widths = [[Date.now(), innerWidth]]; (function tick() { if (__widths.at(-1)[1] !== innerWidth) __widths.push([Date.now(), innerWidth]); requestAnimationFrame(tick); })(); true");
    const accountsBefore = (await pageSize(app, ACCOUNTS)).width;
    const fillAt = await shell.evaluate((selector) => {
      const samples: boolean[] = [];
      (window as unknown as { __fillDrawn: boolean[] }).__fillDrawn = samples;
      const at = Date.now();
      document.querySelector<HTMLElement>(`${selector} button[aria-label="Fill the desk"]`)!.click();
      let left = 40;
      const sample = (): void => {
        samples.push(document.querySelector(selector)!.hasAttribute("data-drawn"));
        if ((left -= 1) > 0) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return at;
    }, windowSelector(accounts));
    await settled(shell, app);
    const filled = await box(shell, windowSelector(accounts));
    // The whole card, its whole page live under the parked window, which main's shelf view draws over it.
    near(filled.y + filled.height, foot, 3);
    await expect.poll(async () => {
      const view = (await liveViews(app)).find((candidate) => candidate.url === ACCOUNTS);
      return view === undefined ? null : Math.abs(view.bounds.y + view.bounds.height - (foot - 5)) <= 1;
    }).toBe(true);
    await expect.poll(() => shelfView(app)).not.toBeNull();
    const shelfBox = (await shelfView(app))!;
    near(shelfBox.x, stage.x + LEFT - 2, 2);
    near(shelfBox.y, peekY - 2, 2);
    near(shelfBox.y + shelfBox.height, foot, 2);
    expect(await shell.evaluate(() => (window as unknown as { __fillDrawn: boolean[] }).__fillDrawn.filter(Boolean))).toEqual([]);
    const fillWidths = await inPage<Array<[number, number]>>(app, ACCOUNTS, "__widths");
    expect(fillWidths[0]![1]).toBe(accountsBefore);
    // Straight to the filled page's width, at once, and nothing after.
    expect(fillWidths.slice(1).map(([, width]) => width)).toEqual([Math.round(filled.width - 10)]);
    expect(fillWidths[1]![0] - fillAt).toBeLessThan(150);

    // ── 6. Expand: back to the box it had, its page at its own size again. The pointer onto the shelf view raises it,
    //       as onto its frame, and over the page it rises the shell's again ─
    await shelfMouse(app, "mouseMove", 62, 19);
    await expect(invoiceWindow).toHaveAttribute("data-raised", "");
    await expect.poll(() => shelfView(app)).toBeNull();
    await shell.mouse.move(parked.x + 60, peekY + 17);
    await expect(invoiceWindow).toHaveAttribute("data-raised", "");
    await invoiceWindow.getByTestId("desk-expand").click();
    await settled(shell, app);
    await expect(invoiceWindow).not.toHaveAttribute("data-mini", /.+/);
    const back = await box(shell, windowSelector(invoice));
    near(back.x, invoiceBefore.x, 3);
    near(back.y, invoiceBefore.y, 3);
    near(back.width, invoiceBefore.width, 3);
    near(back.height, invoiceBefore.height, 3);
    await expect.poll(() => pageSize(app, INVOICES)).toEqual(invoicePageBefore);
    // The shelf is empty: the window filling the desk keeps its whole page again (the Bar's notch lies over it, cutting nothing).
    const filledNow = await box(shell, windowSelector(accounts));
    near(filledNow.y + filledNow.height, foot, 3);
    await expect.poll(async () => {
      const page = await box(shell, `${windowSelector(accounts)} [data-testid="desk-window-page"]`);
      return Math.round(page.y + page.height);
    }).toBe(Math.round(foot - 5));
    await capture(app, shell, "06-expanded.png");

    // ── 7. Snapped as any window is — into the left half, at the desk's edge — it is a window at its own size again ─
    await selectTab(shell, vendor);
    await settled(shell, app);
    await expect(vendorWindow).toHaveAttribute("data-mini", "free");
    const carried = await box(shell, windowSelector(vendor));
    const hold = { x: carried.x + 60, y: carried.y + 17 };
    // (In the desk's leading edge band, its first 30px.)
    const zoneAt = { x: stage.x + 12, y: stage.y + stage.height * 0.45 };
    await shell.mouse.move(hold.x, hold.y);
    await shell.mouse.down();
    for (let step = 1; step <= 24; step += 1) await shell.mouse.move(hold.x + ((zoneAt.x - hold.x) * step) / 24, hold.y + ((zoneAt.y - hold.y) * step) / 24);
    await shell.waitForTimeout(250);
    await shell.mouse.move(zoneAt.x, zoneAt.y);
    await expect(shell.locator(".desk-zone[data-on]")).toHaveCount(1);
    await shell.mouse.up();
    await settled(shell, app);
    await expect(vendorWindow).not.toHaveAttribute("data-mini", /.+/);
    const half = await box(shell, windowSelector(vendor));
    near(half.x, stage.x);
    near(half.y, stage.y);
    near(half.width, (stage.width - 8) / 2);
    const halfView = (await viewBounds(app, VENDOR))!;
    await expect.poll(() => pageSize(app, VENDOR)).toEqual({ width: halfView.width, height: halfView.height, zoom: 1 });
    await capture(app, shell, "07-snapped-to-a-half.png");

    // ── 8. Collapse (the old Put away) sends a minimized window into the sidebar ─
    await fromFrameMenu(shell, vendorWindow, "desk-minimize");
    await settled(shell, app);
    await expect(vendorWindow).toHaveAttribute("data-mini", "parked");
    await vendorWindow.getByTestId("desk-collapse").click();
    await expect(vendorWindow).toHaveCount(0);
    await expect(shell.locator('[data-testid="desk-window"]')).toHaveCount(2);
    // Its page is its own size again.
    await expect.poll(async () => (await pageSize(app, VENDOR)).zoom).toBe(1);

    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("a desk come back after a relaunch, a minimized window's tab asleep: raised, the tab wakes zoomed out, and the app stays up", { tag: ["@desk", "@startup"] }, async () => {
  test.setTimeout(120_000);
  let userData: string | undefined;
  /** The app on the profile (a new one first, then the same again), and the signal it ever exits on. */
  const launch = async (): Promise<{ app: ElectronApplication; shell: Page; exits: Array<string | null> }> => {
    const launched = await launchDesk({ name: "mini-relaunch", userData });
    userData = launched.userData;
    const exits: Array<string | null> = [];
    launched.app.process().on("exit", (_code, signal) => exits.push(signal));
    return { app: launched.app, shell: launched.shell, exits };
  };

  // ── 1. A desk with a window minimized into the shelf, left, and the app quit ─
  let vendor = "";
  {
    const { app, shell } = await launch();
    try {
      const [invoice, made, accounts] = (await openTabs(shell, [INVOICES, VENDOR, ACCOUNTS])) as [string, string, string];
      vendor = made;
      await createGroup(shell, "desk-relaunch", [invoice, vendor, accounts], "Northstar", "blue");
      await selectTab(shell, invoice);
      await selectSpace(shell, "desk-relaunch");
      await settled(shell, app);
      await shell.locator(rowSelector(vendor)).click();
      await settled(shell, app);
      await fromFrameMenu(shell, shell.locator(windowSelector(vendor)), "desk-minimize");
      await settled(shell, app);
      await expect(shell.locator(windowSelector(vendor))).toHaveAttribute("data-mini", "parked");
      // (The desk keeps its arrangement as it changes, in the shell's storage: the minimized window is in it before the quit.)
      await expect
        .poll(() =>
          shell.evaluate((id) => {
            const saved = (JSON.parse(localStorage.getItem("pistachio.desk.v1") ?? "{}") as { saved?: Record<string, { windows: Array<{ tabId: string; mini?: { parked: boolean } }> }> }).saved;
            return saved?.["desk-relaunch"]?.windows.find((window) => window.tabId === id)?.mini?.parked ?? null;
          }, vendor),
        )
        .toBe(true);
    } finally {
      await app.close();
    }
  }

  // ── 2. Relaunched, the space's tabs asleep: the app comes up on its desk — the space current when it quit — with
  //       its saved windows, nothing asked to open it. The minimized one is a placeholder, asleep, until it is raised
  //       (docs/spaces.md §2, "Waking"); the pointer on its frame raises it, its tab wakes, and its page is zoomed out
  //       once it has one — never before, which crashed main ─
  const { app, shell, exits } = await launch();
  try {
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).toBe("desk-relaunch");
    await expect(shell.locator('.desk-stage[data-phase="open"][data-group-id="desk-relaunch"]')).toHaveCount(1);
    await settled(shell, app);
    await expect(shell.locator('[data-testid="desk-window"]')).toHaveCount(2);
    const vendorWindow = shell.locator(windowSelector(vendor));
    await expect(vendorWindow).toHaveAttribute("data-mini", "parked");
    expect((await snapshot(shell)).tabs.find((tab) => tab.id === vendor)?.lifecycle).toBe("suspended");
    const parked = await box(shell, windowSelector(vendor));
    await shell.mouse.move(parked.x + parked.width / 2, parked.y + 12);
    await expect(vendorWindow).toHaveAttribute("data-raised", "");
    await expect.poll(() => pageSize(app, VENDOR).catch(() => null), { timeout: 15_000 }).toEqual({ width: MINI_PAGE.w * 2, height: MINI_PAGE.h * 2, zoom: 1 });
    expect(exits).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
  }
});
