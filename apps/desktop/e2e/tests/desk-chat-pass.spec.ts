/**
 * The desk passing between two tabs of Home's, one with its chat up at the
 * side and one without (docs/desk-agent.md §1, "The card goes and comes with
 * its space"): watched frame by frame, in the shell and in main.
 *
 * The page left goes as it stands — never given the room its chat hands
 * back, nor squeezed for the chat of the tab chosen — with its chat's card
 * beside it until the two go together; the page chosen comes in at the size
 * it keeps, its card (if it has one up) with it. Until 2026-11-19 the Bar
 * gave the room a commit before the desk passed: the card was gone at once,
 * the page left grew to the whole desk, laid out again live every frame,
 * and the page chosen came in drawn at the width it had been squeezed to on
 * its own way out, to be laid out again as it landed.
 */

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { barField, box, INVOICES, launchDesk, openTabs, pressNubButton, reachBar, rowSelector, selectTab, settled, snapshot, VENDOR, windowSelector } from "./desk-harness";

/** One frame of the shell's: each window out (its box as the engine wrote it, how it is drawn), the chat's card, and the card going. */
interface Frame {
  t: number;
  windows: Array<{ tabId: string; w: number; h: number; x: number; opacity: number; posed: boolean }>;
  /** The card's own layer: its opacity as drawn, and whether a pose is on it. Null: no card. */
  card: { opacity: number; posed: boolean; x: number; w: number } | null;
  /** The still copy of the card of the space left. Null: none. */
  leaving: { opacity: number; x: number; w: number } | null;
}

/**
 * Watch the shell from now, every frame, until `taken`: each frame as it was drawn — read once the frame's own
 * work is done (the engine writes its windows in an animation frame of its own, before or after this one's), not
 * part-way through it.
 */
async function watch(shell: Page): Promise<void> {
  await shell.evaluate(() => {
    const store = window as unknown as { __pass?: { frames: unknown[]; on: boolean } };
    const state = { frames: [] as unknown[], on: true };
    store.__pass = state;
    const drawn = new MessageChannel();
    const frame = (): void => {
      if (!state.on) return;
      drawn.port2.postMessage(null);
      requestAnimationFrame(frame);
    };
    drawn.port1.onmessage = (): void => {
      if (!state.on) return;
      const windows = [...document.querySelectorAll<HTMLElement>('[data-testid="desk-window"]')].map((el) => {
        const at = /translate3d\((-?[\d.]+)px/.exec(el.style.transform);
        return {
          tabId: el.dataset["tabId"] ?? "",
          w: Number.parseFloat(el.style.width),
          h: Number.parseFloat(el.style.height),
          x: at === null ? Number.NaN : Number(at[1]),
          opacity: Number(getComputedStyle(el).opacity),
          posed: el.dataset["switching"] !== undefined,
        };
      });
      const card = document.querySelector<HTMLElement>('[data-testid="desk-answer"]');
      const vis = card?.querySelector<HTMLElement>(".desk-answer-vis") ?? null;
      const copy = document.querySelector<HTMLElement>('[data-testid="desk-answer-leaving"]');
      const boxOf = (el: HTMLElement): { x: number; w: number } => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x, w: rect.width };
      };
      state.frames.push({
        t: performance.now(),
        windows,
        card: card === null || vis === null ? null : { opacity: Number(getComputedStyle(vis).opacity), posed: vis.dataset["switching"] !== undefined, ...boxOf(card) },
        leaving: copy === null ? null : { opacity: Number(getComputedStyle(copy).opacity), ...boxOf(copy) },
      });
    };
    requestAnimationFrame(frame);
  });
}

async function taken(shell: Page): Promise<Frame[]> {
  return shell.evaluate(() => {
    const state = (window as unknown as { __pass: { frames: unknown[]; on: boolean } }).__pass;
    state.on = false;
    return state.frames as Frame[];
  });
}

/** Every size main gives a page's view from now (a page is laid out again for each new one), by its URL. */
async function watchViews(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const store = globalThis as unknown as { __sizes?: Array<{ url: string; width: number; height: number }>; __sized?: WeakSet<object> };
    store.__sizes = [];
    store.__sized ??= new WeakSet();
    const window = BrowserWindow.getAllWindows()[0]!;
    for (const child of window.contentView.children) {
      if (!("webContents" in child) || store.__sized.has(child)) continue;
      const view = child as WebContentsView;
      if (!view.webContents.getURL().startsWith("pistachio://demo/")) continue;
      store.__sized.add(view);
      const setBounds = view.setBounds.bind(view);
      view.setBounds = (bounds) => {
        store.__sizes!.push({ url: view.webContents.getURL(), width: bounds.width, height: bounds.height });
        setBounds(bounds);
      };
    }
  });
}

const viewSizes = (app: ElectronApplication): Promise<Array<{ url: string; width: number; height: number }>> =>
  app.evaluate(() => (globalThis as unknown as { __sizes: Array<{ url: string; width: number; height: number }> }).__sizes);

const of = (frames: readonly Frame[], tabId: string): Array<Frame["windows"][number] & { frame: Frame }> =>
  frames.flatMap((frame) => frame.windows.filter((window) => window.tabId === tabId).map((window) => ({ ...window, frame })));

test.describe.serial("the desk passing between Home's tabs, the chat at one's side", { tag: ["@desk", "@agent"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let invoice: string;
  let vendor: string;
  let whole: number;
  let beside: number;

  test.beforeAll(async () => {
    // (As the app ships: the pill drawn in the prompt's view, over the pages — PISTACHIO_E2E_PROMPT_VIEW.)
    ({ app, shell } = await launchDesk({ name: "chat-pass", env: { PISTACHIO_E2E_PROMPT_VIEW: "1", PISTACHIO_AGENT_SCRIPT: JSON.stringify({ steps: [{ text: "About the invoices." }] }) } }));
    [invoice, vendor] = (await openTabs(shell, [INVOICES, VENDOR])) as [string, string];
    // Each has been on the desk, whole: its page laid out at the desk's width.
    await selectTab(shell, vendor);
    await expect(shell.locator(windowSelector(vendor))).toHaveCount(1);
    await settled(shell, app);
    await selectTab(shell, invoice);
    await expect(shell.locator(windowSelector(invoice))).toHaveCount(1);
    await settled(shell, app);
    whole = (await box(shell, windowSelector(invoice))).width;
    // Asked on the invoice tab, the chat taken to the side: its page gives way to it.
    await reachBar(shell);
    await (await barField(shell)).fill("What is this page?");
    await (await barField(shell)).press("Enter");
    const answer = shell.getByTestId("desk-answer");
    await expect(answer).toContainText("About the invoices.");
    await pressNubButton(app, shell, "desk-answer-side");
    await expect(answer).toHaveAttribute("data-zone", "chat");
    await settled(shell, app);
    beside = (await box(shell, windowSelector(invoice))).width;
    expect(beside).toBeLessThan(whole - 200);
  });

  test.afterAll(async () => {
    await app.close();
  });

  test("to the tab with no chat: the page left and its card go together as they stand, and the page chosen comes in whole", async () => {
    await watchViews(app);
    await watch(shell);
    // (As the person goes: its row in the sidebar.)
    await shell.locator(rowSelector(vendor)).click();
    await expect(shell.locator(windowSelector(invoice))).toHaveCount(0);
    await settled(shell, app);
    const frames = await taken(shell);
    const sizes = await viewSizes(app);

    // The page left: the width it had beside its chat in every frame it was drawn — never on its way to the whole desk.
    const left = of(frames, invoice);
    expect(left.length).toBeGreaterThan(3);
    for (const window of left) expect(Math.abs(window.w - beside), `the page left, ${window.w} wide`).toBeLessThanOrEqual(1);
    // And its page was never laid out again on its way out.
    expect(sizes.filter((size) => size.url === INVOICES && Math.abs(size.width - beside) > 2)).toEqual([]);
    // The page chosen: the whole desk from its first frame, and its view never given another width.
    const came = of(frames, vendor);
    for (const window of came) expect(Math.abs(window.w - whole), `the page chosen, ${window.w} wide`).toBeLessThanOrEqual(1);
    expect(sizes.filter((size) => size.url === VENDOR && Math.abs(size.width - whole) > 2)).toEqual([]);

    // The card: beside the page left for as long as that page stood whole — in no frame was the page there alone —
    // and gone with it, on the same motion: as far gone as the page in every frame of it.
    const going = left.filter((window) => window.frame.t > frames[0]!.t);
    for (const window of going) {
      const frame = window.frame;
      const card = frame.leaving ?? (frame.card !== null && !frame.card.posed ? frame.card : null);
      if (!window.posed) {
        expect(card, "the page left stood without its card").not.toBeNull();
        expect(card!.opacity).toBeGreaterThan(0.99);
      } else if (frame.leaving !== null) expect(Math.abs(frame.leaving.opacity - window.opacity)).toBeLessThanOrEqual(0.15);
    }
    // It did go on that motion (seen part-way), from where it stood: the copy is the card's own box.
    const partWay = frames.filter((frame) => frame.leaving !== null && frame.leaving.opacity > 0.05 && frame.leaving.opacity < 0.95);
    expect(partWay.length).toBeGreaterThan(1);
    const stood = frames.find((frame) => frame.leaving !== null)!.leaving!;
    expect(Math.abs(stood.x + stood.w - (await box(shell, ".desk-stage")).x - (await box(shell, ".desk-stage")).width)).toBeLessThanOrEqual(12);
    // At rest: nothing of it left, no chat beside this tab, its page the whole desk.
    await expect(shell.getByTestId("desk-answer-leaving")).toHaveCount(0);
    await expect(shell.getByTestId("desk-answer")).toHaveCount(0);
    expect(Math.abs((await box(shell, windowSelector(vendor))).width - whole)).toBeLessThanOrEqual(1);
  });

  test("and back to the tab with its chat at the side: the page left is not squeezed, and the page chosen comes in beside its card, the two together", async () => {
    await watchViews(app);
    await watch(shell);
    await shell.locator(rowSelector(invoice)).click();
    await expect(shell.locator(windowSelector(vendor))).toHaveCount(0);
    await settled(shell, app);
    const frames = await taken(shell);
    const sizes = await viewSizes(app);

    const left = of(frames, vendor);
    expect(left.length).toBeGreaterThan(3);
    for (const window of left) expect(Math.abs(window.w - whole), `the page left, ${window.w} wide`).toBeLessThanOrEqual(1);
    expect(sizes.filter((size) => size.url === VENDOR && Math.abs(size.width - whole) > 2)).toEqual([]);
    // The page chosen stands beside its chat from its first frame: as it was left, so its page is laid out for that width already.
    const came = of(frames, invoice);
    for (const window of came) expect(Math.abs(window.w - beside), `the page chosen, ${window.w} wide`).toBeLessThanOrEqual(1);
    expect(sizes.filter((size) => size.url === INVOICES && Math.abs(size.width - beside) > 2)).toEqual([]);

    // Its card is not up over the page still going: unseen for as long as that page stands whole, and in with its own page.
    for (const window of left) {
      if (window.posed || window.frame.card === null) continue;
      expect(window.frame.card.opacity, "the chosen tab's card was up over the page left").toBeLessThan(0.01);
    }
    const cameIn = frames.filter((frame) => frame.card !== null && frame.card.posed && frame.card.opacity > 0.05 && frame.card.opacity < 0.95);
    expect(cameIn.length).toBeGreaterThan(1);
    for (const frame of cameIn) {
      const page = frame.windows.find((window) => window.tabId === invoice);
      if (page !== undefined && page.posed) expect(Math.abs(page.opacity - frame.card!.opacity)).toBeLessThanOrEqual(0.15);
    }
    // At rest: the card as it was left — at the side, with its conversation, nothing of the motion on it.
    const answer = shell.getByTestId("desk-answer");
    await expect(answer).toHaveAttribute("data-zone", "chat");
    await expect(answer).toContainText("About the invoices.");
    await expect(answer.locator(".desk-answer-vis")).not.toHaveAttribute("data-switching");
    await expect(answer.locator(".desk-answer-vis")).toHaveCSS("opacity", "1");
    expect((await snapshot(shell)).activeTabId).toBe(invoice);
    expect(Math.abs((await box(shell, windowSelector(invoice))).width - beside)).toBeLessThanOrEqual(1);
  });

  test("chosen again before it has gone: the page and its card turn round together, from where they had got to", async () => {
    await watch(shell);
    await shell.locator(rowSelector(vendor)).click();
    // (Part-way out: the copy of its card thinning.)
    await shell.waitForFunction(() => {
      const copy = document.querySelector<HTMLElement>('[data-testid="desk-answer-leaving"]');
      return copy !== null && Number(getComputedStyle(copy).opacity) < 0.8;
    });
    await selectTab(shell, invoice);
    await settled(shell, app);
    const frames = await taken(shell);
    // The page never changed size, there or back; and once the card itself was back, no copy of it stood with it.
    for (const window of of(frames, invoice)) expect(Math.abs(window.w - beside), `the page, ${window.w} wide`).toBeLessThanOrEqual(1);
    const went = frames.findIndex((frame) => frame.leaving !== null);
    expect(went).toBeGreaterThan(0);
    const turned = frames.findIndex((frame, index) => index > went && frame.card !== null);
    expect(turned).toBeGreaterThan(went);
    for (const frame of frames.slice(turned)) expect(frame.leaving).toBeNull();
    // It came back from where it had got to — never from nothing — and no dimmer than its page from there.
    const first = frames[turned]!;
    expect(first.card!.opacity).toBeGreaterThan(0.02);
    for (const frame of frames.slice(turned)) {
      const page = frame.windows.find((window) => window.tabId === invoice);
      if (page !== undefined && frame.card !== null) expect(Math.abs(page.opacity - frame.card.opacity)).toBeLessThanOrEqual(0.3);
    }
    const answer = shell.getByTestId("desk-answer");
    await expect(answer).toHaveAttribute("data-zone", "chat");
    await expect(answer).toContainText("About the invoices.");
    await expect(answer.locator(".desk-answer-vis")).not.toHaveAttribute("data-switching");
    await expect(answer.locator(".desk-answer-vis")).toHaveCSS("opacity", "1");
    await expect(shell.getByTestId("desk-answer-leaving")).toHaveCount(0);
  });

  test("between two tabs with their chats both at the side: each page keeps its width, and one tab's card is never drawn beside the other's page", async () => {
    // The vendor tab asked in too: its chat comes up where Home's stands — at the side.
    await shell.locator(rowSelector(vendor)).click();
    await expect(shell.locator(windowSelector(invoice))).toHaveCount(0);
    await settled(shell, app);
    await reachBar(shell);
    await (await barField(shell)).fill("And this vendor?");
    await (await barField(shell)).press("Enter");
    const answer = shell.getByTestId("desk-answer");
    await expect(answer).toHaveAttribute("data-zone", "chat");
    await expect(answer).toContainText("And this vendor?");
    await expect(answer).not.toContainText("What is this page?");
    await settled(shell, app);
    expect(Math.abs((await box(shell, windowSelector(vendor))).width - beside)).toBeLessThanOrEqual(1);

    await watchViews(app);
    await watch(shell);
    await shell.locator(rowSelector(invoice)).click();
    await expect(shell.locator(windowSelector(vendor))).toHaveCount(0);
    await settled(shell, app);
    const frames = await taken(shell);
    const sizes = await viewSizes(app);
    // Neither page is given another width, in the shell or in main: the room is kept through the passing.
    for (const frame of frames) for (const window of frame.windows) expect(Math.abs(window.w - beside), `a page ${window.w} wide`).toBeLessThanOrEqual(1);
    expect(sizes.filter((size) => Math.abs(size.width - beside) > 2)).toEqual([]);
    // The card is one, kept up for both — and still the vendor's goes with the vendor's page, as its copy, while the
    // invoices' waits unseen: for as long as the vendor's page stands whole, what is seen beside it is the copy.
    // (From the passing on: the frame the copy first stands in.)
    const went = frames.find((frame) => frame.leaving !== null);
    expect(went, "the card left never went as its copy").toBeDefined();
    const left = of(frames, vendor).filter((window) => window.frame.t >= went!.t);
    expect(left.length).toBeGreaterThan(3);
    for (const window of left) {
      if (window.posed) continue;
      expect(window.frame.leaving, "the page left stood without its own card").not.toBeNull();
      expect(window.frame.leaving!.opacity).toBeGreaterThan(0.99);
      expect(window.frame.card?.opacity ?? 0, "the chosen tab's card was up beside the page left").toBeLessThan(0.01);
    }
    await expect(answer).toContainText("What is this page?");
    await expect(answer).not.toContainText("And this vendor?");
    await expect(answer.locator(".desk-answer-vis")).toHaveCSS("opacity", "1");
    await expect(shell.getByTestId("desk-answer-leaving")).toHaveCount(0);
  });
});
