/**
 * The Bar's pill out, the page under it stays live (docs/desk-agent.md
 * §1, "The pill"; docs/desk.md, "The foot"). Until 2026-11-05 the pill was
 * a cover like the nub's menu: the window under it gave way to its still,
 * and a page that reached the desk's foot — every filled one — was a picture
 * dead to the pointer for as long as the pill was out, as if a pane of glass
 * lay over it. Now the desk keeps a band clear at its foot for the pill
 * (DeskEngine.setBand): the windows glide up out of it, their pages live,
 * the pill lies on the ground the band leaves, and they come back as the
 * pill goes in. The pill's close and side buttons above the nub, which lie
 * over the page, are drawn by main's notch view there, as the nub is.
 */

import { expect, test, type ElectronApplication } from "@playwright/test";
import type { WebContentsView } from "electron";
import { box, createGroup, INVOICES, launchDesk, openTabs, pressNubButton, reachBar, screenshots, selectSpace, selectTab, settled, windowSelector, type Box } from "./desk-harness";
import { pageAt } from "./pages-harness";
import { liveViews } from "./windows";

// (With the notch view in the picture: over a live page it draws the nub and the pill's buttons.)
const capture = screenshots("desk-bar-live", ["notch"]);

/** A press through the window at a point of its content box, as the OS would land it: on the topmost view there, else the shell. Which page took it. */
function pressThrough(app: ElectronApplication, x: number, y: number): Promise<string> {
  return app.evaluate(
    async ({ BrowserWindow }, at) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("Pistachio window is unavailable");
      let target = window.webContents;
      let local = { x: at.x, y: at.y };
      const views = window.contentView.children;
      for (let i = views.length - 1; i >= 0; i--) {
        const view = views[i]!;
        if (!("webContents" in view) || !view.getVisible()) continue;
        const bounds = view.getBounds();
        if (at.x < bounds.x || at.y < bounds.y || at.x >= bounds.x + bounds.width || at.y >= bounds.y + bounds.height) continue;
        target = (view as WebContentsView).webContents;
        local = { x: at.x - bounds.x, y: at.y - bounds.y };
        break;
      }
      const x = Math.round(local.x);
      const y = Math.round(local.y);
      target.sendInputEvent({ type: "mouseMove", x, y });
      await new Promise((done) => setTimeout(done, 20));
      target.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x, y });
      await new Promise((done) => setTimeout(done, 30));
      target.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x, y });
      await new Promise((done) => setTimeout(done, 60));
      return target.getURL();
    },
    { x, y },
  );
}

/**
 * A press dragged through the window from one point of its content box to another, as the OS would land it: on the
 * topmost view at the first point, else the shell. Which page took it.
 */
function dragThrough(app: ElectronApplication, from: { x: number; y: number }, to: { x: number; y: number }): Promise<string> {
  return app.evaluate(
    async ({ BrowserWindow }, { from, to }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("Pistachio window is unavailable");
      let target = window.webContents;
      let origin = { x: 0, y: 0 };
      const views = window.contentView.children;
      for (let i = views.length - 1; i >= 0; i--) {
        const view = views[i]!;
        if (!("webContents" in view) || !view.getVisible()) continue;
        const bounds = view.getBounds();
        if (from.x < bounds.x || from.y < bounds.y || from.x >= bounds.x + bounds.width || from.y >= bounds.y + bounds.height) continue;
        target = (view as WebContentsView).webContents;
        origin = { x: bounds.x, y: bounds.y };
        break;
      }
      const at = (point: { x: number; y: number }): { x: number; y: number } => ({ x: Math.round(point.x - origin.x), y: Math.round(point.y - origin.y) });
      const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
      target.sendInputEvent({ type: "mouseMove", ...at(from) });
      await pause(20);
      target.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...at(from) });
      for (let step = 1; step <= 8; step++) {
        await pause(16);
        target.sendInputEvent({ type: "mouseMove", button: "left", x: at(from).x + ((at(to).x - at(from).x) * step) / 8, y: at(from).y + ((at(to).y - at(from).y) * step) / 8 });
      }
      await pause(30);
      target.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...at(to) });
      await pause(60);
      return target.getURL();
    },
    { from, to },
  );
}

/**
 * The nub's views over a live page (main's chrome views, by the hash each loads): the nub's own, in the desk's corner
 * — one box, whatever comes out of the nub; its menu's, over it, the droplets' fan; and the pill's buttons', above it.
 * (Until 2026-11-19 they were one view, grown to the fan and up over the buttons: a view's page is drawn again for a
 * new box a frame or two after the box is laid, and showed the nub in the wrong place meanwhile.)
 */
const NUB = "#notch";
const FAN = "#notch-fan";
const BUTTONS = "#notch-buttons";
type NubView = typeof NUB | typeof FAN | typeof BUTTONS;

/** Where something one of the nub's views draws is, in the view's own box (its centre), once it has come to rest there; null if it draws none. */
async function notchSpot(app: ElectronApplication, selector: string, which: NubView = NUB): Promise<{ x: number; y: number }> {
  const read = (): Promise<{ x: number; y: number } | null> =>
    app.evaluate(async ({ BrowserWindow }, { query, hash }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const view = window?.contentView.children.find(
        (child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith(hash) && child.getVisible(),
      ) as WebContentsView | undefined;
      if (view === undefined) return null;
      return (await view.webContents.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(query)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      )) as { x: number; y: number } | null;
    }, { query: selector, hash: which });
  let last: { x: number; y: number } | null = null;
  await expect
    .poll(
      async () => {
        const now = await read();
        const still = now !== null && last !== null && Math.abs(now.x - last.x) < 0.5 && Math.abs(now.y - last.y) < 0.5;
        last = now;
        return still;
      },
      { intervals: [80], timeout: 5_000 },
    )
    .toBe(true);
  return last!;
}

/** A press in one of the nub's views at a point of its own box, as its page hears one. */
function pressNotch(app: ElectronApplication, at: { x: number; y: number }, press = true, which: NubView = NUB): Promise<void> {
  return app.evaluate(
    async ({ webContents }, { x, y, press, hash }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith(hash));
      if (contents === undefined) throw new Error("no notch view");
      contents.sendInputEvent({ type: "mouseMove", x, y });
      await new Promise((done) => setTimeout(done, 30));
      if (!press) return;
      contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x, y });
      await new Promise((done) => setTimeout(done, 40));
      contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x, y });
      await new Promise((done) => setTimeout(done, 60));
    },
    { x: Math.round(at.x), y: Math.round(at.y), press, hash: which },
  );
}

/** What one of the nub's views says of its own page, read there. */
function inNotch<T>(app: ElectronApplication, script: string, which: NubView = NUB): Promise<T> {
  return app.evaluate(async ({ webContents }, { source, hash }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith(hash));
    if (contents === undefined) throw new Error("no notch view");
    return (await contents.executeJavaScript(source)) as never;
  }, { source: script, hash: which }) as Promise<T>;
}

/** One of the nub's views on screen: its box in the window, or null. */
function notchBounds(app: ElectronApplication, which: NubView = NUB): Promise<Box | null> {
  return app.evaluate(({ BrowserWindow }, hash) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window?.contentView.children.find(
      (child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith(hash) && child.getVisible(),
    ) as WebContentsView | undefined;
    return view === undefined ? null : view.getBounds();
  }, which);
}

test("the pill out, the page under it stays live and takes a click; the pill's buttons over it are the notch view's; the page comes back as the pill goes in", { tag: ["@desk"] }, async () => {
  test.setTimeout(90_000);
  const { app, shell } = await launchDesk({ name: "bar-live" });
  try {
    const [invoice] = (await openTabs(shell, [INVOICES])) as [string];
    await createGroup(shell, "bar-live", [invoice], "Northstar", "green");
    await selectTab(shell, invoice);
    await selectSpace(shell, "bar-live");
    await settled(shell, app);
    const stage = await box(shell, ".desk-stage");
    const win = shell.locator(windowSelector(invoice));
    await expect(win).toHaveCount(1);
    // The page fills the desk, down to its foot, live.
    const before = (await liveViews(app)).find((view) => view.url === INVOICES);
    expect(before).toBeDefined();
    expect(before!.bounds.y + before!.bounds.height).toBeGreaterThan(stage.y + stage.height - 4);
    const page = await pageAt(app, INVOICES);
    await page.evaluate(() => {
      const state = window as unknown as { __clicks: number };
      state.__clicks = 0;
      document.addEventListener("click", () => (state.__clicks += 1));
    });

    // The pill out of the nub's prompt droplet: the window gives way by moving, not by freezing — its page live, its
    // view's foot above the pill's footprint, the pill on the ground below it.
    await reachBar(shell);
    await expect(shell.getByTestId("desk-bar-input")).toBeFocused();
    await settled(shell, app);
    await expect(win).not.toHaveAttribute("data-drawn", "");
    const pill = await box(shell, '[data-testid="desk-bar"]');
    const live = (await liveViews(app)).find((view) => view.url === INVOICES);
    expect(live, "the page's view is on screen with the pill out").toBeDefined();
    expect(live!.bounds.y + live!.bounds.height).toBeLessThanOrEqual(pill.y - 8 + 1);
    expect(live!.bounds.y + live!.bounds.height).toBeGreaterThan(pill.y - 40);
    await capture(app, shell, "01-pill-out-page-live.png");

    // A click lands on the page, where the pill's cover would have held its still: in the view, counted by the page.
    const at = { x: live!.bounds.x + live!.bounds.width * 0.5, y: live!.bounds.y + live!.bounds.height - 30 };
    expect(await pressThrough(app, at.x, at.y)).toBe(INVOICES);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(1);
    // (The press on the page took the keyboard from the pill, as a press on any window does; the pill, empty, went in.)

    // Out again with words in it, the pill stays out whatever has the keyboard: its close above the nub lies over the
    // live page, so it is main's that draws it (the shell's stands veiled in its place) — in the buttons' own view,
    // above the nub's, whose box reaches up over it. The nub's own view is as it was: not grown to hold them.
    const nubBefore = await notchBounds(app);
    expect(nubBefore).not.toBeNull();
    await reachBar(shell);
    await shell.getByTestId("desk-bar-input").fill("A question to keep");
    await settled(shell, app);
    const close = shell.getByTestId("desk-bar-close");
    await expect(close).toHaveAttribute("data-shown", "");
    await expect(close).toHaveAttribute("data-veiled", "");
    const closeBox = await box(shell, '[data-testid="desk-bar-close"]');
    await expect.poll(() => notchBounds(app, BUTTONS)).not.toBeNull();
    const notch = await notchBounds(app, BUTTONS);
    expect(notch!.y).toBeLessThanOrEqual(closeBox.y - stage.y + 0);
    expect(notch!.x + notch!.width).toBeGreaterThanOrEqual(stage.x + stage.width - 1);
    expect(await notchBounds(app)).toEqual(nubBefore);
    await capture(app, shell, "02-close-in-the-view.png", 400, undefined);
    // The page is live under it still, and takes a click beside the column.
    const again = (await liveViews(app)).find((view) => view.url === INVOICES);
    expect(again).toBeDefined();
    expect(await pressThrough(app, again!.bounds.x + again!.bounds.width * 0.5, again!.bounds.y + again!.bounds.height - 30)).toBe(INVOICES);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(2);
    await expect(shell.getByTestId("desk-bar")).not.toHaveAttribute("data-compact", "");

    // The view's close pressed: the pill goes in (what was typed kept), and the window comes back down to the foot.
    await pressNubButton(app, shell, "desk-bar-close");
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    await settled(shell, app);
    // The buttons back in the nub, their view is gone from over the page; the nub's own never changed.
    await expect.poll(() => notchBounds(app, BUTTONS)).toBeNull();
    expect(await notchBounds(app)).toEqual(nubBefore);
    const after = (await liveViews(app)).find((view) => view.url === INVOICES);
    expect(after).toBeDefined();
    expect(after!.bounds.y + after!.bounds.height).toBeGreaterThan(stage.y + stage.height - 4);
    await expect(win).not.toHaveAttribute("data-drawn", "");
    await reachBar(shell);
    await expect(shell.getByTestId("desk-bar-input")).toHaveValue("A question to keep");
    await capture(app, shell, "03-back-at-the-foot.png");
  } finally {
    await app.close();
  }
});

/**
 * The nub's menu out, the page under it stays live (2026-11-17). Until then the menu was a cover wherever it opened:
 * the nub's box and the pill's place along the foot, so every page that reached the foot — every filled one — was its
 * still for as long as the three droplets were out, and a press on that picture was a press on the window: dragged, it
 * carried the window off (one filling the desk let go of it and shrank). Now the menu over a live page is main's notch
 * view's to draw, as the nub is: the page under it is its own, a press on it the page's — and puts the menu away, as a
 * press elsewhere always has — and a droplet pressed in the view is the Bar's.
 */
test("the nub's menu out, the page under it stays live: a drag on it is the page's and carries no window off; the droplets over it are the notch view's", { tag: ["@desk"] }, async () => {
  test.setTimeout(90_000);
  const { app, shell } = await launchDesk({ name: "nub-menu-live" });
  try {
    const [invoice] = (await openTabs(shell, [INVOICES])) as [string];
    await createGroup(shell, "nub-menu-live", [invoice], "Northstar", "green");
    await selectTab(shell, invoice);
    await selectSpace(shell, "nub-menu-live");
    await settled(shell, app);
    const stage = await box(shell, ".desk-stage");
    const win = shell.locator(windowSelector(invoice));
    await expect(win).toHaveCount(1);
    const menu = shell.locator('[data-testid="desk-nub-menu"][data-open]');
    const filled = await box(shell, windowSelector(invoice));
    const page = await pageAt(app, INVOICES);
    await page.evaluate(() => {
      const state = window as unknown as { __heard: string[] };
      state.__heard = [];
      for (const type of ["mousedown", "mouseup", "click"]) document.addEventListener(type, () => state.__heard.push(type), true);
    });
    const heard = (): Promise<string[]> => page.evaluate(() => (window as unknown as { __heard: string[] }).__heard);

    // The page fills the desk, live, so the idle nub over it is the notch view: pressed there, its menu comes out.
    const idle = await notchBounds(app);
    expect(idle).not.toBeNull();
    await pressNotch(app, { x: idle!.width - 21, y: idle!.height - 21 });
    await expect(menu).toHaveCount(1);
    // (The menu's view is over the nub's now, and the pointer is its: the nub's own hears it go. Here each view's
    // pointer is the one this spec moves in it, so it is moved off the nub's by hand — left there, the nub's view
    // would say the pointer had come again as the nub came back under it.)
    await pressNotch(app, { x: 2, y: 2 }, false);
    await settled(shell, app);

    // The page did not give way: no still, its view on screen down to the foot. The menu is main's to draw — in a view
    // of its own over the nub's, its box the droplets' fan, in the desk's corner, its three droplets out in it — and
    // the shell's own stands veiled under it. The nub's own view is the box it was.
    await expect(win).not.toHaveAttribute("data-drawn", "");
    const live = (await liveViews(app)).find((view) => view.url === INVOICES);
    expect(live, "the page's view is on screen with the menu out").toBeDefined();
    expect(live!.bounds.y + live!.bounds.height).toBeGreaterThan(stage.y + stage.height - 4);
    const fan = await notchBounds(app, FAN);
    expect(fan).not.toBeNull();
    expect(await notchBounds(app)).toEqual(idle);
    expect(fan!.width).toBeGreaterThanOrEqual(132);
    expect(fan!.height).toBeGreaterThanOrEqual(132);
    expect(Math.abs(fan!.x + fan!.width - (stage.x + stage.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(fan!.y + fan!.height - (stage.y + stage.height))).toBeLessThanOrEqual(1);
    await expect
      .poll(() =>
        inNotch<number[]>(app, `[...document.querySelectorAll('.desk-nub-menu[data-open] .desk-nub-item')].map((el) => Number(getComputedStyle(el).opacity))`, FAN),
      )
      .toEqual([1, 1, 1]);
    expect(await inNotch<string>(app, `document.querySelector('[data-testid="desk-nub"]').getAttribute("aria-expanded")`, FAN)).toBe("true");
    // (And the nub's own view draws none of the nub meanwhile: two of them would lay its shadow twice where they overlap.)
    await expect.poll(() => inNotch<string | null>(app, `document.querySelector('.desk-notch-view-nub')?.style.opacity ?? null`)).toBe("0");
    await expect(shell.getByTestId("desk-nub-box")).toHaveAttribute("data-veiled", "");
    await capture(app, shell, "04-menu-out-page-live.png", 400, undefined);

    // The pointer resting on a droplet in the view: the shell's own says what it is, beside it.
    const mic = await notchSpot(app, '[data-testid="desk-nub-mic"]', FAN);
    await pressNotch(app, mic, false, FAN);
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]')).toHaveText("Dictate");
    await capture(app, shell, "05-droplet-tooltip.png", 400, undefined);
    await pressNotch(app, { x: 2, y: 2 }, false, FAN);
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]')).toHaveCount(0);
    await settled(shell, app);
    await expect(win).not.toHaveAttribute("data-drawn", "");

    // A drag on the page is the page's. The window stays where it is, filling the desk — over its still, the same drag
    // carried it off and it let go of the desk — and the press, a press elsewhere, puts the menu away.
    const from = { x: live!.bounds.x + live!.bounds.width * 0.4, y: live!.bounds.y + live!.bounds.height * 0.4 };
    expect(await dragThrough(app, from, { x: from.x + 160, y: from.y + 90 })).toBe(INVOICES);
    // (Down and up on the same element of the page are its click too.)
    await expect.poll(heard).toEqual(["mousedown", "mouseup", "click"]);
    await expect(menu).toHaveCount(0);
    await settled(shell, app);
    const after = await box(shell, windowSelector(invoice));
    for (const side of ["x", "y", "width", "height"] as const) expect(Math.abs(after[side] - filled[side]), side).toBeLessThanOrEqual(1);
    await expect(win).not.toHaveAttribute("data-drawn", "");
    // The droplets back in the nub, the menu's view is gone from over the page, and the nub is its own view's again.
    await expect.poll(() => notchBounds(app, FAN)).toBeNull();
    expect(await notchBounds(app)).toEqual(idle);
    expect(await inNotch<string | null>(app, `document.querySelector('.desk-notch-view-nub')?.style.opacity ?? null`)).toBe("");

    // Out again, a droplet pressed in the view is the Bar's: the prompt's brings out the pill, the keyboard in its field.
    const again = await notchBounds(app);
    await pressNotch(app, { x: again!.width - 21, y: again!.height - 21 });
    await expect(menu).toHaveCount(1);
    await pressNotch(app, { x: 2, y: 2 }, false);
    await pressNotch(app, await notchSpot(app, '.desk-nub-menu[data-open] [data-testid="desk-nub-prompt"]', FAN), true, FAN);
    await expect(shell.getByTestId("desk-bar")).not.toHaveAttribute("data-compact", "");
    await expect(shell.getByTestId("desk-bar-input")).toBeFocused();
    await expect(menu).toHaveCount(0);
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    await settled(shell, app);

    // And a press in the view's box beside the droplets is a press elsewhere: the menu goes in, and the page hears nothing.
    const third = await notchBounds(app);
    await pressNotch(app, { x: third!.width - 21, y: third!.height - 21 });
    await expect(menu).toHaveCount(1);
    await pressNotch(app, { x: 2, y: 2 }, false);
    await notchSpot(app, '.desk-nub-menu[data-open] [data-testid="desk-nub-chats"]', FAN);
    await pressNotch(app, { x: 3, y: 3 }, true, FAN);
    await expect(menu).toHaveCount(0);
    expect(await heard()).toEqual(["mousedown", "mouseup", "click"]);
    // The nub's own button, out of the corner, is the menu's close.
    await settled(shell, app);
    const fourth = await notchBounds(app);
    await pressNotch(app, { x: fourth!.width - 21, y: fourth!.height - 21 });
    await expect(menu).toHaveCount(1);
    await pressNotch(app, { x: 2, y: 2 }, false);
    await notchSpot(app, '.desk-nub-menu[data-open] [data-testid="desk-nub-chats"]', FAN);
    await pressNotch(app, await notchSpot(app, '[data-testid="desk-nub"]', FAN), true, FAN);
    await expect(menu).toHaveCount(0);
  } finally {
    await app.close();
  }
});
