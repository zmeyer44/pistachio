/**
 * The desk's prompt over a live page (docs/desk.md, "The foot";
 * main/desk-bar-view.ts; the shell's lib/desk/prompt-view.ts). Until
 * 2026-11-18 the pill out kept a band of the desk clear for itself: a window
 * that reached the foot glided up out of it, a filled page a hundred pixels
 * shorter for as long as the pill was out. Now the pill is drawn in a view of
 * the shell's own above the tab views — the shell opens a child window by
 * name, main makes a view of it, the Bar draws into its document — so it lies
 * on the page as the nub does: no window moves or changes size, and the page
 * under it is itself, not its still.
 *
 * This proves what only the app has: the child is a view of the window and
 * not a window; it lies where the shell's pill rests, over a page that stays
 * where and as it was and takes a press; the field in it is the Bar's own —
 * typed in, sent from, put away by Escape — and what stands on the pill (the
 * answer) still stands on it.
 *
 * (The other specs write in the shell's own pill: under Playwright the view
 * is refused unless asked for, PISTACHIO_E2E_PROMPT_VIEW=1. That pill is
 * still what the web draws, and what stands in wherever the view cannot.)
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import type { ExtensionsSnapshot } from "@pistachio/shell-contracts/extensions";
import { box, createGroup, launchDesk, openTabs, reachBar, screenshots, selectSpace, selectTab, settled, snapshot, VENDOR } from "./desk-harness";
import { liveViews } from "./windows";

const capture = screenshots("desk-prompt-view", ["notch"]);

const SCRIPT = { steps: [{ text: "It is the invoice for the Northstar order." }] };

type Bounds = { x: number; y: number; width: number; height: number };

/** The prompt's view as main has it: its box, whether it is shown, and whether any tab's view is stacked over it. */
function promptView(app: ElectronApplication): Promise<{ bounds: Bounds; visible: boolean; above: boolean } | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const views = window.contentView.children.filter((child) => "webContents" in child) as WebContentsView[];
    const at = views.findIndex((child) => child.webContents.getURL() === "about:blank");
    if (at < 0) return null;
    const above = views.slice(at + 1).every((child) => /#[a-z-]+$/.test(child.webContents.getURL()) || !child.getVisible());
    return { bounds: views[at]!.getBounds(), visible: views[at]!.getVisible(), above };
  });
}

/** A press through the window at a point of its content box, as the OS would land it: on the topmost view there. Which page took it. */
function pressThrough(app: ElectronApplication, x: number, y: number): Promise<string> {
  return app.evaluate(
    async ({ BrowserWindow }, at) => {
      const window = BrowserWindow.getAllWindows()[0]!;
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
      const px = Math.round(local.x);
      const py = Math.round(local.y);
      target.sendInputEvent({ type: "mouseMove", x: px, y: py });
      await new Promise((done) => setTimeout(done, 20));
      target.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: px, y: py });
      await new Promise((done) => setTimeout(done, 30));
      target.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: px, y: py });
      await new Promise((done) => setTimeout(done, 60));
      return target.getURL();
    },
    { x, y },
  );
}

test.describe.serial("the desk's prompt, over a live page", { tag: ["@desk", "@agent"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  /** The view's own page: the document the Bar draws the pill into. */
  let prompt: Page;
  /** The page filling the desk, as main shows it, before the pill was ever out. */
  let pageBefore: Bounds;

  const pageNow = async (): Promise<Bounds | null> => (await liveViews(app)).find((view) => view.url.includes("invoices"))?.bounds ?? null;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    ({ app, shell } = await launchDesk({ name: "desk-prompt-view", env: { PISTACHIO_E2E_PROMPT_VIEW: "1", PISTACHIO_AGENT_SCRIPT: JSON.stringify(SCRIPT) } }));
    await settled(shell, app);
    await expect.poll(() => app.windows().some((page) => page.url() === "about:blank")).toBe(true);
    prompt = app.windows().find((page) => page.url() === "about:blank")!;
    const before = await pageNow();
    expect(before).not.toBeNull();
    pageBefore = before!;
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("the shell opens it: a view of the window, not a window, with the shell's own styles — unseen while the pill is in", async () => {
    // (Found among the window's own views — promptView reads them — and no window was made for it.)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect.poll(() => promptView(app)).toMatchObject({ visible: false });
    await expect(prompt.locator(".desk-prompt-view")).toHaveCount(1);
    // The shell's rules are the view's: what it draws there looks as it does in the shell.
    expect(await prompt.evaluate(() => document.styleSheets.length)).toBeGreaterThan(0);
    expect(await prompt.evaluate(() => document.body.dataset["chromeView"])).toBe("prompt");
    expect(await prompt.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    // Idle, the pill is in the nub and its field is the shell's own, holding the keyboard's place.
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    await expect(shell.getByTestId("desk-bar-input")).toHaveCount(1);
    await expect(prompt.getByTestId("desk-bar-input")).toHaveCount(0);
    // Any other window the shell might open is still refused.
    const opened = await shell.evaluate(() => [window.open("about:blank", "something-else") === null, window.open("https://example.com/", "pistachio-desk-prompt-2") === null]);
    expect(opened).toEqual([true, true]);
  });

  test("the pill out: drawn in the view where the pill rests, the field in it; the page under it neither moves nor changes size, and takes a press", async () => {
    await reachBar(shell);
    const bar = shell.getByTestId("desk-bar");
    await expect(bar).toHaveAttribute("data-over", "");

    // ── 1. The view lies where the shell's pill rests, over every tab's view ─
    const pill = await box(shell, '[data-testid="desk-bar"]');
    await expect
      .poll(async () => {
        const view = await promptView(app);
        return view === null ? null : { visible: view.visible, above: view.above, x: Math.abs(view.bounds.x - (pill.x - 16)) <= 1, y: Math.abs(view.bounds.y - (pill.y - 10)) <= 1, w: Math.abs(view.bounds.width - (pill.width + 32)) <= 1 };
      })
      .toEqual({ visible: true, above: true, x: true, y: true, w: true });

    // ── 2. The pill and its row are the view's: the Bar's own field, with the keyboard ─
    await expect(prompt.locator('[data-testid="desk-bar-over"][data-shown]')).toHaveCount(1);
    const field = prompt.getByTestId("desk-bar-input");
    await expect(field).toBeVisible();
    await expect(shell.getByTestId("desk-bar-input")).toHaveCount(0);
    await expect.poll(() => prompt.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset["testid"] ?? null)).toBe("desk-bar-input");
    // Drawn as the shell draws it: its glass has its ring and its shadow (the rules' own variables reach the view).
    const glass = await prompt.locator('[data-testid="desk-bar-over"] > .desk-bar-frame').evaluate((el) => {
      const style = getComputedStyle(el);
      return { shadow: style.boxShadow, fill: style.backgroundColor };
    });
    expect(glass.shadow).not.toBe("none");
    expect(glass.shadow).toContain("inset");
    expect(glass.fill).not.toBe("rgba(0, 0, 0, 0)");
    // Solid: a view cannot blur the page under it as the shell's glass does, so nothing of the page shows through.
    expect(glass.fill).not.toMatch(/\/\s*0?\.\d+\s*\)|rgba\(/);
    // The pill fills the view's box but for the room its shadow takes.
    const drawn = (await prompt.getByTestId("desk-bar-over").boundingBox())!;
    expect(Math.abs(drawn.x - 16)).toBeLessThanOrEqual(1);
    expect(Math.abs(drawn.width - pill.width)).toBeLessThanOrEqual(1);

    // ── 3. The page under it is where and as it was: no band, no still ─
    await settled(shell, app);
    expect(await pageNow()).toEqual(pageBefore);
    // (It reaches under the pill: the pill lies on it.)
    expect(pageBefore.y + pageBefore.height).toBeGreaterThan(pill.y + pill.height);
    await capture(app, shell, "01-pill-over-the-page.png");

    // ── 4. Typed in, the words are the Bar's; a press on the page is the page's, and the pill stays for its words ─
    await field.fill("what is this page?");
    await expect(field).toHaveValue("what is this page?");
    const took = await pressThrough(app, pageBefore.x + pageBefore.width / 2, pageBefore.y + 120);
    expect(took).toContain("invoices");
    await expect(bar).not.toHaveAttribute("data-compact", "");
    await expect.poll(async () => (await promptView(app))?.visible).toBe(true);
    expect(await pageNow()).toEqual(pageBefore);
    // A press beside the pill, on the page past the view's box's edge, is the page's too: the view is the pill's box.
    const beside = await pressThrough(app, pill.x - 60, pill.y + pill.height / 2);
    expect(beside).toContain("invoices");
  });

  test("a shortcut struck in the prompt is the window's: ⌘L opens the address bar, the keys with it", async () => {
    const field = prompt.getByTestId("desk-bar-input");
    await field.click();
    // (Through main's own hook on the view's keys, as the OS would deliver it: Playwright's keyboard goes around it.)
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const view = (window.contentView.children.filter((child) => "webContents" in child) as WebContentsView[]).find((child) => child.webContents.getURL() === "about:blank")!;
      view.webContents.sendInputEvent({ type: "keyDown", keyCode: "L", modifiers: ["meta"] });
      view.webContents.sendInputEvent({ type: "keyUp", keyCode: "L", modifiers: ["meta"] });
    });
    await expect(shell.getByTestId("url-bar")).toBeVisible();
    await shell.getByTestId("url-bar").press("Escape");
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    // The words in the prompt are still there: the pill held them.
    await expect(field).toHaveValue("what is this page?");
  });

  test("the commands a slash offers are the prompt's own: in its document, where the field names them, and the page under them is itself", async () => {
    const field = prompt.getByTestId("desk-bar-input");
    const held = await field.inputValue();
    const pillOnly = (await promptView(app))!.bounds;
    await field.fill("/");
    // ── 1. The list is in the view, over the page — not in the shell under a cover ─
    const list = prompt.locator('[data-testid="desk-commands"][data-shown]');
    await expect(list).toHaveCount(1);
    await expect(shell.getByTestId("desk-commands")).toHaveCount(0);
    // As tall as the shell draws it — by the window's height, not the little view's: a dozen rows, not three.
    await expect.poll(async () => (await list.boundingBox())!.height).toBeGreaterThan(300);
    // The view's box reaches up over it; its foot is where it was.
    const height = (await list.boundingBox())!.height;
    await expect.poll(async () => (await promptView(app))!.bounds.height).toBeGreaterThanOrEqual(pillOnly.height + height);
    const withList = (await promptView(app))!.bounds;
    expect(Math.abs(withList.y + withList.height - (pillOnly.y + pillOnly.height))).toBeLessThanOrEqual(1);
    // The page under it is still its own, where it was: no cover, no still.
    await settled(shell, app);
    expect(await pageNow()).toEqual(pageBefore);
    await capture(app, shell, "01b-commands-over-the-page.png");

    // ── 2. What the field says it controls is there to be found: the list, and the option that is lit ─
    const named = await field.evaluate((el) => {
      const controls = el.getAttribute("aria-controls");
      const lit = el.getAttribute("aria-activedescendant");
      const option = lit === null ? null : el.ownerDocument.getElementById(lit);
      return {
        expanded: el.getAttribute("aria-expanded"),
        list: controls === null ? null : (el.ownerDocument.getElementById(controls)?.getAttribute("role") ?? null),
        option: option?.getAttribute("role") ?? null,
        selected: option?.getAttribute("aria-selected") ?? null,
      };
    });
    expect(named).toEqual({ expanded: "true", list: "listbox", option: "option", selected: "true" });
    // The arrows move what is lit, and the field follows it.
    const first = await field.getAttribute("aria-activedescendant");
    await field.press("ArrowDown");
    await expect.poll(() => field.getAttribute("aria-activedescendant")).not.toBe(first);
    expect(await field.evaluate((el) => el.ownerDocument.getElementById(el.getAttribute("aria-activedescendant") ?? "")?.getAttribute("aria-selected") ?? null)).toBe("true");

    // ── 3. The pointer on a row lights it, and a press there leaves the keyboard in the field: the list is its document's ─
    const row = prompt.locator('[data-testid="desk-command"][data-command="summarize"]');
    await row.hover();
    await expect.poll(() => field.getAttribute("aria-activedescendant")).toBe(await row.getAttribute("id"));
    await row.dispatchEvent("mousedown");
    expect(await prompt.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset["testid"] ?? null)).toBe("desk-bar-input");
    // Escape puts the list away, not the pill; the view is the pill's box again.
    await field.press("Escape");
    await expect(prompt.getByTestId("desk-commands")).toHaveCount(0);
    await expect(shell.getByTestId("desk-bar")).not.toHaveAttribute("data-compact", "");
    await expect.poll(async () => (await promptView(app))!.bounds.height).toBeLessThan(pillOnly.height + 40);
    await field.fill(held);
  });

  test("a file dropped on the pill is staged once", async () => {
    const transfer = await prompt.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(["Seat 14C, gate closes 09:10"], "boarding-pass.txt", { type: "text/plain" }));
      return data;
    });
    // On the pill itself, beside its row: the view's own element, which the Bar's handlers hear through the portal.
    for (const type of ["dragenter", "dragover", "drop"]) await prompt.dispatchEvent('[data-testid="desk-bar-over"]', type, { dataTransfer: transfer });
    const staged = prompt.locator('[data-testid="desk-bar-staged"] > span');
    await expect(staged.first()).toContainText("boarding-pass.txt");
    await expect(staged).toHaveCount(1);
    // Taken off again: what follows writes in a pill that holds only its words.
    await staged.first().hover();
    await staged.first().getByRole("button").click();
    await expect(prompt.getByTestId("desk-bar-staged")).toHaveCount(0);
  });

  test("sent from the view, the message starts the conversation and the answer docks on the pill", async () => {
    test.setTimeout(60_000);
    const field = prompt.getByTestId("desk-bar-input");
    await field.click();
    await field.press("Enter");
    await expect(field).toHaveValue("");
    // The Bar's own send: the conversation opens docked on the pill, with what was asked and what came back.
    await expect(shell.getByTestId("desk-answer")).toContainText("what is this page?", { timeout: 15_000 });
    await expect(shell.getByTestId("desk-answer")).toContainText("Northstar order", { timeout: 15_000 });
    // The answer stands on the pill, as it did: the shell's pill keeps the view's pill's box.
    const card = await box(shell, '[data-testid="desk-answer"]');
    const pill = await box(shell, '[data-testid="desk-bar"]');
    expect(card.y + card.height).toBeLessThanOrEqual(pill.y);
    await expect.poll(async () => (await promptView(app))?.visible).toBe(true);
    await capture(app, shell, "02-answer-on-the-pill.png");
  });

  test("Escape puts the answer away, then the empty pill: the view goes, the page still as it was", async () => {
    const field = prompt.getByTestId("desk-bar-input");
    await field.click();
    await field.press("Escape");
    await expect(shell.locator('[data-testid="desk-answer"][data-shown]')).toHaveCount(0);
    await expect(shell.getByTestId("desk-bar")).not.toHaveAttribute("data-compact", "");
    // Words in it hold it out.
    await field.fill("still here");
    await field.press("Escape");
    await expect(shell.getByTestId("desk-bar")).not.toHaveAttribute("data-compact", "");
    await field.fill("");
    await field.press("Escape");
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    await expect.poll(async () => (await promptView(app))?.visible).toBe(false);
    // In again, the field is the shell's own, where ⌘I finds it.
    await expect(shell.getByTestId("desk-bar-input")).toHaveCount(1);
    await settled(shell, app);
    expect(await pageNow()).toEqual(pageBefore);
  });

  test("a taller message: the view grows with the pill, upward, and the page still does not move", async () => {
    await reachBar(shell);
    const field = prompt.getByTestId("desk-bar-input");
    await expect(field).toBeVisible();
    const one = (await promptView(app))!.bounds;
    await field.fill("one\ntwo\nthree\nfour");
    await expect.poll(async () => (await promptView(app))!.bounds.height).toBeGreaterThan(one.height + 30);
    const grown = (await promptView(app))!.bounds;
    // Its foot stays where it was: it grows upward.
    expect(Math.abs(grown.y + grown.height - (one.y + one.height))).toBeLessThanOrEqual(1);
    expect(await pageNow()).toEqual(pageBefore);
    await capture(app, shell, "03-taller.png");
    await field.fill("");
    await field.press("Escape");
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
  });
});

test.describe("the desk's prompt view among the window's views", { tag: ["@desk"] }, () => {
  test("a tab opened while the pill was in: the pill out lies over that tab's page too, where the pointer reaches it", async () => {
    const { app, shell } = await launchDesk({ name: "desk-prompt-view-stack", env: { PISTACHIO_E2E_PROMPT_VIEW: "1" } });
    try {
      await settled(shell, app);
      await expect.poll(() => app.windows().some((page) => page.url() === "about:blank")).toBe(true);
      const prompt = app.windows().find((page) => page.url() === "about:blank")!;
      // A tab's view is added to the window as the tab is made — over the prompt's, which was not up to be kept on top.
      const [vendor] = await openTabs(shell, [VENDOR]);
      await selectTab(shell, vendor!);
      await settled(shell, app);
      expect((await liveViews(app)).some((view) => view.url.includes("vendors"))).toBe(true);
      // ⌘I: the pill straight out of the nub, nothing else coming up first that might restack the window's views.
      await app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0]!.webContents;
        contents.sendInputEvent({ type: "keyDown", keyCode: "I", modifiers: ["meta"] });
        contents.sendInputEvent({ type: "keyUp", keyCode: "I", modifiers: ["meta"] });
      });
      await expect(shell.getByTestId("desk-bar")).not.toHaveAttribute("data-compact", "");
      await expect(prompt.getByTestId("desk-bar-input")).toBeVisible();
      // The page under it is live (no cover), and the prompt is over it: seen, and the pointer's to reach.
      await settled(shell, app);
      expect((await liveViews(app)).some((view) => view.url.includes("vendors"))).toBe(true);
      await expect.poll(() => promptView(app)).toMatchObject({ visible: true, above: true });
      const pill = await box(shell, '[data-testid="desk-bar"]');
      expect(await pressThrough(app, pill.x + pill.width / 2, pill.y + pill.height / 2)).toBe("about:blank");
    } finally {
      await app.close();
    }
  });
});

/**
 * The user's report (2026-11-18): "the browser window shouldn't move up or change size to accommodate the text
 * input". Every way a window could give way to the pill, with the prompt as the app ships it (the view): a space
 * shown as tabs, its page filling the desk; a space of windows reaching the foot; and an extension's live pill at
 * the foot, which the pill once took into a band of its own. Each window's box in the shell and each page's view in
 * the window, read before the pill and with it out, typed in, and with the commands up: the same, to the pixel.
 */
test.describe.serial("the desk's prompt: no window gives way to it", { tag: ["@desk", "@extensions"] }, () => {
  const NORTH = "pistachio://demo/invoices?page=north";
  const SOUTH = "pistachio://demo/invoices?page=south";
  const STATUS = "dev.pistachio-e2e.status";
  let app: ElectronApplication;
  let shell: Page;
  let prompt: Page;
  let vendor: string, north: string, south: string;

  type WithExtensions = { pistachio: { extensions(request: unknown): Promise<unknown>; onExtensions(listener: (snapshot: ExtensionsSnapshot) => void): () => void }; __ext?: ExtensionsSnapshot };
  const extensionsRequest = (request: unknown): Promise<unknown> => shell.evaluate((body) => (window as unknown as WithExtensions).pistachio.extensions(body), request);
  const status = async () => (await shell.evaluate(() => (window as unknown as WithExtensions).__ext ?? null))?.extensions.find((extension) => extension.id === STATUS);

  /** Where every window of the desk stands in the shell, and every page's view in the window. */
  const frame = async (): Promise<{ windows: (string | number | null)[][]; views: (string | number)[][] }> => ({
    windows: await shell.locator('[data-testid="desk-window"]').evaluateAll((windows) =>
      windows.map((el) => {
        const at = el.getBoundingClientRect();
        return [el.getAttribute("data-tab-id"), Math.round(at.x), Math.round(at.y), Math.round(at.width), Math.round(at.height)];
      }),
    ),
    views: (await liveViews(app)).map((view) => [view.url, view.bounds.x, view.bounds.y, view.bounds.width, view.bounds.height]),
  });
  /** The pill out and in again, the desk read at each step against how it stood: nothing of it moved. */
  const throughThePill = async (label: string): Promise<void> => {
    await settled(shell, app);
    const before = await frame();
    expect(before.windows.length, label).toBeGreaterThan(0);
    expect(before.views.length, label).toBeGreaterThan(0);
    await reachBar(shell);
    const field = prompt.getByTestId("desk-bar-input");
    await expect(field).toBeVisible();
    // A page reaches under the pill: there was something to give way.
    const pill = await box(shell, '[data-testid="desk-bar"]');
    expect(before.views.some((view) => (view[2] as number) + (view[4] as number) > pill.y + pill.height / 2), label).toBe(true);
    await settled(shell, app);
    expect(await frame(), `${label}: the pill out`).toEqual(before);
    await field.fill("one\ntwo\nthree");
    await settled(shell, app);
    expect(await frame(), `${label}: three lines in it`).toEqual(before);
    await field.fill("/");
    await expect(prompt.locator('[data-testid="desk-commands"][data-shown]')).toHaveCount(1);
    await settled(shell, app);
    expect(await frame(), `${label}: the commands up`).toEqual(before);
    await capture(app, shell, `10-${label.replace(/[^a-z]+/g, "-")}.png`);
    await field.fill("");
    await field.press("Escape");
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    await settled(shell, app);
    expect(await frame(), `${label}: the pill in again`).toEqual(before);
  };

  /** The same, whether or not a window happens to reach the foot: the desk is read all the same. */
  const throughThePillIfReached = async (label: string): Promise<void> => {
    await settled(shell, app);
    const before = await frame();
    await reachBar(shell);
    await expect(prompt.getByTestId("desk-bar-input")).toBeVisible();
    await settled(shell, app);
    expect(await frame(), `${label}: the pill out`).toEqual(before);
    await prompt.getByTestId("desk-bar-input").press("Escape");
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    await settled(shell, app);
    expect(await frame(), `${label}: the pill in again`).toEqual(before);
  };

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    ({ app, shell } = await launchDesk({ name: "desk-prompt-view-still", env: { PISTACHIO_E2E_PROMPT_VIEW: "1" } }));
    await settled(shell, app);
    await expect.poll(() => app.windows().some((page) => page.url() === "about:blank")).toBe(true);
    prompt = app.windows().find((page) => page.url() === "about:blank")!;
    [vendor, north, south] = (await openTabs(shell, [VENDOR, NORTH, SOUTH])) as [string, string, string];
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("a space shown as tabs, its page filling the desk", async () => {
    const [reading] = (await openTabs(shell, ["pistachio://demo/invoices?page=reading"])) as [string];
    await createGroup(shell, "reading", [reading], "Reading", "blue", { windows: false });
    await selectSpace(shell, "reading");
    await throughThePill("a space shown as tabs");
  });

  test("a space of windows, its one window filling the desk down to the foot", async () => {
    await createGroup(shell, "single", [north], "Single", "green");
    await selectSpace(shell, "single");
    await throughThePill("a space of windows");
  });

  test("two windows of a space out on the desk, one of them down to the foot", async () => {
    await createGroup(shell, "pair", [south, vendor], "Pair", "amber");
    await selectSpace(shell, "pair");
    await throughThePillIfReached("two windows");
  });

  test("an extension's live pill at the foot: it stands beside the pill in the view, and still no window moves", async () => {
    test.setTimeout(60_000);
    // An extension that shows a status at the foot when its command is run.
    const folder = join(await mkdtemp(join(tmpdir(), "pistachio-status-")), "status");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "pistachio.json"),
      JSON.stringify({ api: 1, id: STATUS, name: "Status", version: "1.0.0", worker: { type: "web", main: "worker.js" }, bar: { commands: [{ name: "status", description: "Show a status", run: { event: true } }] } }),
    );
    await writeFile(join(folder, "worker.js"), 'pistachio.bar.onCommand("status", async () => { await pistachio.ui.setStatus({ text: "Building" }); });\n');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await shell.evaluate(() => {
      const w = window as unknown as WithExtensions;
      w.pistachio.onExtensions((next) => (w.__ext = next));
    });
    await extensionsRequest({ type: "loadFolder", path: folder });
    await expect.poll(async () => (await status())?.pending?.manifestHash ?? null).not.toBeNull();
    await extensionsRequest({ type: "approve", id: STATUS, manifestHash: (await status())!.pending!.manifestHash });
    await expect.poll(async () => (await status())?.pending ?? null).toBeNull();
    const now = await snapshot(shell);
    await extensionsRequest({ type: "barCommand", id: STATUS, command: "status", arg: "", spaceId: now.currentGroupId, tabId: now.activeTabId });
    // Its pill stands in the nub's lane at the foot (the shell's, or the notch view's over a live page).
    await expect(shell.locator('[data-testid="extension-status-pill"]')).toHaveCount(1);
    await settled(shell, app);

    const before = await frame();
    await reachBar(shell);
    await expect(prompt.getByTestId("desk-bar-input")).toBeVisible();
    await settled(shell, app);
    // No window gave way: the pill is the view's with a live pill at the foot too.
    expect(await frame()).toEqual(before);
    // And the extension's pill stands beside the Bar's pill, in the view: left of it, level with it.
    const chip = prompt.getByTestId("extension-status-pill");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("Building");
    const chipBox = (await chip.boundingBox())!;
    const pillBox = (await prompt.getByTestId("desk-bar-over").boundingBox())!;
    expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(pillBox.x);
    expect(chipBox.y).toBeGreaterThanOrEqual(pillBox.y);
    expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(pillBox.y + pillBox.height);
    await capture(app, shell, "11-with-a-live-pill.png");
    await prompt.getByTestId("desk-bar-input").press("Escape");
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    await settled(shell, app);
    expect(await frame()).toEqual(before);
  });
});
