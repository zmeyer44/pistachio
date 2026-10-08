/**
 * The desk's agent end to end (docs/desk-agent.md): the Bar at the desk's
 * foot, the group's context as a Stack in the dock, and a turn through the
 * real controller and runner on a scripted model (PISTACHIO_AGENT_SCRIPT) —
 * the agent arranging the windows, wearing its ring on the window it works
 * in, pinning a note, saving a fact to the Stack; Undo layout; the
 * conversations; ⌘I. A turn going on in its group once the desk is left is
 * desk-agent.test's (apps/desktop/test).
 */

import { expect, test } from "@playwright/test";
import { api, box, createGroup, INVOICES, launchDesk, openGroupDesk, openTabs, openTray, reachBar, screenshots, selectTab, settled, snapshot, VENDOR, windowSelector } from "./desk-harness";

const capture = screenshots("desk-agent");

function near(actual: number, expected: number, within = 2): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(within);
}

const ACCOUNTS = "pistachio://demo/auth/relying-party";

/**
 * The agent's model, scripted: tab and item ids are named by what the
 * prompt shows (scripted-agent-model.ts). The first turn arranges the
 * invoice and the vendor side by side, reads the vendor, pins a note and
 * saves a fact — pausing while it thinks, so its presence can be seen.
 */
const SCRIPT = {
  steps: [
    {
      tools: [
        {
          name: "desk_arrange",
          input: {
            layout: null,
            place: [
              { tabId: "{{tab:Northstar}}", zone: "left", box: null },
              { tabId: "{{tab:Atlas}}", zone: "right", box: null },
            ],
            bringOut: null,
            putAway: null,
          },
        },
      ],
    },
    { tools: [{ name: "page_inspect", input: { tabId: "{{tab:Atlas}}" } }] },
    {
      delayMs: 2_500,
      tools: [
        { name: "desk_note", input: { tabId: "{{tab:Atlas}}", text: "Net 30 · due Oct 12" } },
        { name: "context_save", input: { kind: "fact", text: "Atlas Medical invoice NS-2048 is due Oct 12", url: null, title: null } },
      ],
    },
    { text: "Atlas Medical is beside the invoice now. Their terms are **net 30**, so NS-2048 is due Oct 12 — I saved that to this desk's context." },
    // The second opens a page — hidden — then, lingering, shows it on the desk.
    { tools: [{ name: "tab_open", input: { url: ACCOUNTS } }] },
    { tools: [{ name: "tabs_list", input: {} }] },
    { delayMs: 2_500, tools: [{ name: "tab_show", input: { tabId: "{{tab:relying-party}}" } }] },
    { text: "Opened the connected accounts beside it." },
    // The third clicks a link that opens a new tab, in the invoice while it is in the dock.
    { tools: [{ name: "page_click", input: { tabId: "{{tab:Northstar}}", target: "#vendor-record-link" } }] },
    { text: "Opened the vendor record from the invoice." },
  ],
};

test("the desk's agent: the Bar, the Stack, a turn that arranges the windows, its presence, a note, a saved fact, Undo layout, the conversations", { tag: ["@desk", "@agent"] }, async () => {
  test.setTimeout(120_000);
  const { app, shell } = await launchDesk({ name: "agent", env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify(SCRIPT) } });
  try {
    const [invoice, vendor] = (await openTabs(shell, [INVOICES, VENDOR])) as [string, string];
    await createGroup(shell, "desk-agent", [invoice, vendor], "Northstar", "green");
    await selectTab(shell, invoice);
    await openGroupDesk(shell, "desk-agent");
    await expect(shell.locator('[data-testid="tab-group"] [role="tab"]')).toHaveCount(2);
    await settled(shell, app);
    const stage = await box(shell, ".desk-stage");
    const away = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.6, stage.y + stage.height * 0.4);
    await away();

    // ── 1. The Bar, a notch at the desk's foot, over the windows there; the Stack in the dock, empty ─
    const bar = shell.getByTestId("desk-bar");
    await expect(bar).toBeVisible();
    // Just the field and its buttons: it asks about the group by name.
    await expect(shell.getByTestId("desk-bar-input")).toHaveAttribute("placeholder", "Ask about Northstar…");
    // Idle, it is a small notch that says what it is for (and the key that opens it), square at its foot; the pointer
    // coming to it grows it into the Bar, a notch still.
    await expect(bar).toHaveAttribute("data-compact", "");
    await expect(shell.getByTestId("desk-bar-pill")).toContainText("Ask about Northstar");
    await expect.poll(() => bar.evaluate((el) => [getComputedStyle(el).borderTopLeftRadius, getComputedStyle(el).borderBottomLeftRadius])).toEqual(["14px", "0px"]);
    const idle = await box(shell, '[data-testid="desk-bar"]');
    near(idle.y + idle.height, stage.y + stage.height, 1);
    near(idle.height, 32, 1);
    // A window reaching the desk's foot under it keeps its whole page: the notch lies over it, not cutting it.
    const entryPage = await box(shell, `${windowSelector(invoice)} [data-testid="desk-window-page"]`);
    if (entryPage.x < idle.x + idle.width && idle.x < entryPage.x + entryPage.width && entryPage.y + entryPage.height > idle.y - 40)
      near(entryPage.y + entryPage.height, stage.y + stage.height - 5, 1);
    await capture(app, shell, "01a-desk-notch.png");
    await shell.getByTestId("desk-bar-pill").hover();
    await expect(bar).not.toHaveAttribute("data-compact", "");
    await expect.poll(() => bar.evaluate((el) => [getComputedStyle(el).borderTopLeftRadius, getComputedStyle(el).borderBottomLeftRadius])).toEqual(["22px", "0px"]);
    // The tray at the field's leading end: its plus, under the pointer, lets out attach, the conversations and a new
    // one, turning into its close and sliding the field aside; its tools out of reach while it is shut.
    const tray = shell.getByTestId("desk-bar-tray");
    const more = shell.getByTestId("desk-bar-more");
    await expect(tray).not.toHaveAttribute("data-open", "");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    expect(await shell.locator(".desk-bar-tray-items").evaluate((el) => [el.getBoundingClientRect().width, (el as HTMLElement).inert])).toEqual([0, true]);
    const fieldShut = await box(shell, '[data-testid="desk-bar-input"]');
    await more.hover();
    await expect(tray).toHaveAttribute("data-open", "");
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect.poll(async () => (await box(shell, '[data-testid="desk-bar-input"]')).x).toBeGreaterThan(fieldShut.x + 90);
    await expect.poll(() => more.locator("svg").evaluate((el) => getComputedStyle(el).rotate)).toBe("45deg");
    await capture(app, shell, "01b-desk-bar-tray.png");
    // Every button says what it does.
    await shell.getByTestId("desk-bar-attach").hover();
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]')).toHaveText("Attach files");
    await capture(app, shell, "01c-desk-bar-tooltip.png");
    await shell.getByTestId("desk-bar-new-conversation").hover();
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]', { hasText: "New conversation" })).toBeVisible();
    await shell.getByTestId("desk-bar-send").hover();
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]', { hasText: "Send" })).toBeVisible();
    // Off it, the tray goes back, and the field with it.
    await expect(tray).not.toHaveAttribute("data-open", "");
    await expect.poll(async () => (await box(shell, '[data-testid="desk-bar-input"]')).x).toBeLessThan(fieldShut.x + 2);
    await away();
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]')).toHaveCount(0);
    const barBox = await box(shell, '[data-testid="desk-bar"]');
    // Out of the card's foot.
    near(barBox.y + barBox.height, stage.y + stage.height, 1);
    await expect(shell.getByTestId("desk-stack")).toHaveAttribute("data-count", "0");
    await capture(app, shell, "01-desk-bar.png");

    // ── 2. Files dropped on the Stack go into the group's context; a fact typed on its card too ─
    const transfer = await shell.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(["Boarding pass BA 0490, seat 14C, gate closes 09:10"], "boarding-pass.txt", { type: "text/plain" }));
      return data;
    });
    for (const type of ["dragenter", "dragover", "drop"]) await shell.dispatchEvent('[data-testid="desk-stack"]', type, { dataTransfer: transfer });
    await expect(shell.getByTestId("desk-stack")).toHaveAttribute("data-count", "1");
    await shell.getByTestId("desk-stack").click();
    await expect(shell.locator('[data-testid="desk-stack-card"][data-shown]')).toHaveCount(1);
    await expect(shell.getByTestId("desk-stack-file")).toContainText("boarding-pass.txt");
    await shell.getByTestId("desk-stack-fact").fill("Approver: Dana in finance");
    await shell.getByTestId("desk-stack-fact").press("Enter");
    await expect(shell.getByTestId("desk-stack-line")).toContainText("Approver: Dana in finance");
    await expect(shell.getByTestId("desk-stack")).toHaveAttribute("data-count", "2");
    // The card is a cover: the window in use under it is its still meanwhile.
    await expect(shell.locator(`${windowSelector(invoice)}[data-drawn]`)).toHaveCount(1);
    await capture(app, shell, "02-desk-stack.png");
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("desk-stack-card")).toHaveCount(0);
    const synced = await api(shell, (pistachio) => pistachio.getGroupContexts());
    expect(synced.find((context) => context.groupId === "desk-agent")?.items.map((item) => item.kind)).toEqual(["file", "fact"]);

    // ── 3. ⌘I puts the keyboard in the Bar; a message there is a turn at this desk ─
    await shell.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await shell.keyboard.press("Meta+i");
    await expect(shell.getByTestId("desk-bar-input")).toBeFocused();
    const before = await box(shell, windowSelector(invoice));
    await shell.getByTestId("desk-bar-input").fill("Put the vendor beside the invoice and tell me when it's due");
    await shell.getByTestId("desk-bar-input").press("Enter");

    // ── 4. It arranges the windows side by side, the keyboard staying put, and is seen where it works ─
    await expect(shell.locator('[data-testid="desk-answer"][data-shown]')).toHaveCount(1);
    await expect(shell.locator(windowSelector(vendor))).toHaveCount(1);
    await expect(shell.locator(`${windowSelector(vendor)}[data-agent]`)).toHaveCount(1);
    await expect(shell.locator(`${windowSelector(vendor)} [data-testid="desk-window-agent"]`)).toContainText("Thinking");
    await expect(shell.locator(`[data-testid="sidebar-tab-list"] [role="tab"][data-tab-id="${vendor}"] [data-testid="tab-agent-working"]`)).toHaveCount(1);
    await expect(shell.getByTestId("desk-bar-stop")).toBeVisible();
    expect((await snapshot(shell)).activeTabId).toBe(invoice);
    await capture(app, shell, "03-desk-agent-working.png");

    // ── 5. Done: a note on the vendor's window, the fact in the Stack, the answer on the card ─
    await expect(shell.getByTestId("desk-answer")).toContainText("net 30", { timeout: 15_000 });
    await expect(shell.locator(`${windowSelector(vendor)} [data-testid="desk-window-note"]`)).toContainText("Net 30 · due Oct 12");
    await expect(shell.getByTestId("desk-stack")).toHaveAttribute("data-count", "3");
    await expect(shell.locator("[data-agent]")).toHaveCount(0);
    await expect(shell.getByTestId("tab-agent-working")).toHaveCount(0);
    await settled(shell, app);
    const left = await box(shell, windowSelector(invoice));
    const right = await box(shell, windowSelector(vendor));
    expect(left.x + left.width).toBeLessThan(right.x);
    expect(Math.abs(left.width - right.width)).toBeLessThan(4);
    // Halves of the whole card, down to its foot under the Bar.
    near(right.y + right.height, stage.y + stage.height, 2);
    const run = (await snapshot(shell)).run!;
    expect(run.groupId).toBe("desk-agent");
    expect(run.toolCalls.map((call) => call.name)).toEqual(["desk.arrange", "page.inspect", "desk.note", "context.save"]);
    await capture(app, shell, "04-desk-agent-answer.png");

    // The answer is as wide as the Bar and rests on it, however tall the Bar grows; it collapses with a chevron.
    const card = await box(shell, '[data-testid="desk-answer"]');
    const barNow = await box(shell, '[data-testid="desk-bar"]');
    expect(Math.abs(card.width - barNow.width)).toBeLessThan(1);
    expect(Math.abs(card.x - barNow.x)).toBeLessThan(1);
    expect(Math.abs(card.y + card.height + 8 - barNow.y)).toBeLessThan(1.5);
    await shell.getByTestId("desk-bar-input").fill("one\ntwo\nthree\nfour");
    await expect.poll(async () => (await box(shell, '[data-testid="desk-bar"]')).height).toBeGreaterThan(barNow.height + 30);
    const taller = await box(shell, '[data-testid="desk-bar"]');
    const lifted = await box(shell, '[data-testid="desk-answer"]');
    expect(Math.abs(lifted.y + lifted.height + 8 - taller.y)).toBeLessThan(1.5);
    await capture(app, shell, "04b-desk-answer-on-a-tall-bar.png");
    await shell.getByTestId("desk-bar-input").fill("");
    await expect(shell.getByTestId("desk-answer-close")).toHaveAttribute("aria-label", "Hide the answer");

    // ── 6. Undo layout puts every window back where it was before the turn ─
    await shell.getByTestId("desk-undo-layout").click();
    await settled(shell, app);
    await expect(shell.locator(windowSelector(vendor))).toHaveCount(0);
    const undone = await box(shell, windowSelector(invoice));
    expect(Math.abs(undone.x - before.x)).toBeLessThan(3);
    expect(Math.abs(undone.width - before.width)).toBeLessThan(3);
    await expect(shell.getByTestId("desk-undo-layout")).toHaveCount(0);

    // ── 7. A tab it opens is hidden — off the desk, out of the group — until it shows it: then it joins the group and comes out quietly, under the window in use ─
    await shell.getByTestId("desk-bar-input").fill("Open the connected accounts too");
    await shell.getByTestId("desk-bar-input").press("Enter");
    await expect.poll(async () => (await snapshot(shell)).hiddenTabs?.map((tab) => tab.url), { timeout: 15_000 }).toEqual([ACCOUNTS]);
    const hiddenId = (await snapshot(shell)).hiddenTabs![0]!.id;
    expect((await snapshot(shell)).tabs.map((tab) => tab.url)).not.toContain(ACCOUNTS);
    expect((await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-agent")?.tabIds).not.toContain(hiddenId);
    await expect(shell.locator(windowSelector(hiddenId))).toHaveCount(0);
    await expect(shell.locator('[data-testid="tab-group"] [role="tab"]')).toHaveCount(2);
    await expect(shell.getByTestId("desk-answer")).toContainText("Opened the connected accounts", { timeout: 15_000 });
    await expect(shell.locator('[data-testid="tab-group"] [role="tab"]')).toHaveCount(3);
    const opened = (await snapshot(shell)).tabs.find((tab) => tab.url === ACCOUNTS)!;
    expect(opened.id).toBe(hiddenId);
    expect((await snapshot(shell)).hiddenTabs).toEqual([]);
    expect((await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-agent")?.tabIds).toContain(opened.id);
    await expect(shell.locator(windowSelector(opened.id))).toHaveCount(1);
    expect((await snapshot(shell)).activeTabId).toBe(invoice);
    await settled(shell, app);
    await capture(app, shell, "05-desk-agent-opened.png");

    // ── 7b. The answer stays while the person is in the Bar, and goes on a press anywhere else — a live page's, or the shell's — as the conversations do ─
    const answerShown = shell.locator('[data-testid="desk-answer"][data-shown]');
    await shell.getByTestId("desk-bar-input").click();
    await expect(answerShown).toHaveCount(1);
    await app.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      contents.sendInputEvent({ type: "mouseMove", x: 420, y: 24 });
      contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: 420, y: 24 });
      await new Promise((done) => setTimeout(done, 40));
      contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: 420, y: 24 });
    }, ACCOUNTS);
    await expect(shell.getByTestId("desk-answer")).toHaveCount(0);
    await reachBar(shell);
    await shell.getByTestId("desk-bar-answer").click();
    await expect(answerShown).toHaveCount(1);
    // Grown, the Bar wears the answer's fill.
    const fills = await shell.evaluate(() => [getComputedStyle(document.querySelector('[data-testid="desk-answer"] .desk-answer-frame')!).backgroundColor, getComputedStyle(document.querySelector('[data-testid="desk-bar"]')!).backgroundColor]);
    expect(fills[1]).toBe(fills[0]);
    await capture(app, shell, "05b-desk-answer-on-its-bar.png");
    await shell.getByTestId("desk-surface").click({ position: { x: 4, y: 4 } });
    await expect(shell.getByTestId("desk-answer")).toHaveCount(0);

    // ── 7c. The answer taken off the Bar by its header: a window that stays, moves, resizes, and docks back ─
    const answer = shell.getByTestId("desk-answer");
    const answerButton = shell.getByTestId("desk-bar-answer");
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, steps = 24, release = true): Promise<void> => {
      await shell.mouse.move(from.x, from.y);
      await shell.mouse.down();
      for (let i = 1; i <= steps; i++) {
        await shell.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
        await shell.waitForTimeout(16);
      }
      if (release) await shell.mouse.up();
    };
    const grabPoint = async (): Promise<{ x: number; y: number }> => {
      const head = await box(shell, '[data-testid="desk-answer-head"]');
      return { x: head.x + 60, y: head.y + head.height / 2 };
    };
    const atRest = (): Promise<string> => answer.evaluate((el) => (el as HTMLElement).style.transform);
    await reachBar(shell);
    await answerButton.click();
    await expect(shell.locator('[data-testid="desk-answer"][data-shown]')).toHaveCount(1);
    await expect(answer).toHaveAttribute("data-mode", "docked");
    const docked = await box(shell, '[data-testid="desk-answer"]');
    // A short pull and let go: it goes back into its place on the Bar.
    let grab = await grabPoint();
    await drag(grab, { x: grab.x, y: grab.y - 24 }, 8);
    await expect(answer).toHaveAttribute("data-mode", "docked");
    await expect.poll(atRest).toBe("");
    // Pulled further, it tears off: a window, narrower, under the hand.
    grab = await grabPoint();
    await drag(grab, { x: grab.x - 160, y: grab.y - 160 });
    await expect(answer).toHaveAttribute("data-mode", "detached");
    await expect(answerButton).toHaveAttribute("data-floating", "");
    await settled(shell, app);
    let floating = await box(shell, '[data-testid="desk-answer"]');
    near(floating.width, 440, 4);
    expect(floating.width).toBeLessThan(docked.width);
    await expect(shell.getByTestId("desk-answer-dock")).toBeVisible();
    await expect(shell.getByTestId("desk-answer-close")).toBeHidden();
    await capture(app, shell, "05c-desk-answer-floating.png");
    // A window: a press on the desk leaves it be.
    await shell.getByTestId("desk-surface").click({ position: { x: 4, y: 4 } });
    await expect(shell.locator('[data-testid="desk-answer"][data-shown]')).toHaveCount(1);
    // Resized from its corner, the opposite one holding still.
    floating = await box(shell, '[data-testid="desk-answer"]');
    const corner = await box(shell, '[data-testid="desk-answer"] .desk-answer-edge[data-edge="se"]');
    await drag({ x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 }, { x: corner.x + corner.width / 2 + 80, y: corner.y + corner.height / 2 + 40 }, 10);
    await settled(shell, app);
    const resized = await box(shell, '[data-testid="desk-answer"]');
    near(resized.width, floating.width + 80, 3);
    near(resized.x, floating.x, 3);
    near(resized.y, floating.y, 3);
    // A resize called off with Escape: back to its size — and kept at it, not at the size it was being pulled to.
    const kept = (): Promise<number | null> => shell.evaluate(() => (JSON.parse(localStorage.getItem("pistachio.desk.answer.v1") ?? "null") as { w: number } | null)?.w ?? null);
    const pulled = await box(shell, '[data-testid="desk-answer"] .desk-answer-edge[data-edge="se"]');
    await drag({ x: pulled.x + pulled.width / 2, y: pulled.y + pulled.height / 2 }, { x: pulled.x + pulled.width / 2 + 120, y: pulled.y + pulled.height / 2 + 80 }, 10, false);
    await shell.keyboard.press("Escape");
    await shell.mouse.up();
    await expect.poll(async () => Math.round((await box(shell, '[data-testid="desk-answer"]')).width)).toBe(Math.round(resized.width));
    await expect.poll(async () => Math.abs(((await kept()) ?? 0) - resized.width)).toBeLessThan(2);
    await settled(shell, app);
    near((await kept()) ?? 0, resized.width, 2);
    // A window among the desk's: one it lies over, pressed clear of it, comes in front of it, its page live again.
    const under = await shell.evaluate(() => {
      const card = document.querySelector('[data-testid="desk-answer"]')!.getBoundingClientRect();
      const bar = document.querySelector('[data-testid="desk-bar"]')!.getBoundingClientRect();
      const inside = (rect: DOMRect, x: number, y: number): boolean => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      for (const el of document.querySelectorAll<HTMLElement>('[data-testid="desk-window"][data-drawn]')) {
        const rect = el.getBoundingClientRect();
        if (rect.right < card.left || rect.left > card.right || rect.bottom < card.top || rect.top > card.bottom) continue;
        for (const [x, y] of [[rect.left + 40, rect.top + 80], [rect.right - 40, rect.top + 80], [rect.left + 40, rect.bottom - 80], [rect.right - 40, rect.bottom - 80]] as const)
          if (!inside(card, x, y) && !inside(bar, x, y) && document.elementFromPoint(x, y)?.closest('[data-testid="desk-window"]') === el) return { tabId: el.getAttribute("data-tab-id")!, x, y };
      }
      return null;
    });
    expect(under, "a window under the floating answer").not.toBeNull();
    const pressed = shell.locator(`[data-testid="desk-window"][data-tab-id="${under!.tabId}"]`);
    const zIndex = (target: typeof answer): Promise<number> => target.evaluate((el) => Number(getComputedStyle(el).zIndex));
    await shell.mouse.click(under!.x, under!.y);
    await expect(pressed).not.toHaveAttribute("data-drawn", "");
    expect(await zIndex(pressed)).toBeGreaterThan(await zIndex(answer));
    await capture(app, shell, "05c2-desk-answer-behind-a-window.png");
    // The Bar's button calls it out rather than hiding it, back in front of every window.
    await reachBar(shell);
    await answerButton.click();
    await expect(shell.locator('[data-testid="desk-answer"] .desk-answer-flash.desk-answer-flashing')).toHaveCount(1);
    await expect(answer).toHaveAttribute("data-mode", "detached");
    await expect(pressed).toHaveAttribute("data-drawn", "");
    expect(await zIndex(answer)).toBeGreaterThan(await zIndex(pressed));
    // Brought back over the Bar: the slot's ghost comes up and brightens; let go, it docks, as wide as the Bar again.
    grab = await grabPoint();
    const home = await box(shell, '[data-testid="desk-bar"]');
    await drag(grab, { x: home.x + home.width / 2, y: home.y + home.height / 2 }, 30, false);
    await expect(shell.getByTestId("desk-answer-ghost")).toHaveAttribute("data-hot", "");
    await expect.poll(() => shell.getByTestId("desk-answer-ghost").evaluate((el) => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0.5);
    await capture(app, shell, "05d-desk-answer-ghost.png");
    await shell.mouse.up();
    await expect(answer).toHaveAttribute("data-mode", "docked");
    await expect(answerButton).not.toHaveAttribute("data-floating", "");
    await expect.poll(atRest).toBe("");
    const redocked = await box(shell, '[data-testid="desk-answer"]');
    near(redocked.width, docked.width, 1);
    near(redocked.x, docked.x, 1);
    await expect.poll(() => shell.getByTestId("desk-answer-ghost").evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(0);
    await capture(app, shell, "05e-desk-answer-docked-again.png");
    // Torn off again, its dock button puts it back.
    grab = await grabPoint();
    await drag(grab, { x: grab.x + 120, y: grab.y - 140 });
    await expect(answer).toHaveAttribute("data-mode", "detached");
    await settled(shell, app);
    // (It comes back at the size it was left at.)
    near((await box(shell, '[data-testid="desk-answer"]')).width, resized.width, 3);
    await shell.getByTestId("desk-answer-dock").click();
    await expect(answer).toHaveAttribute("data-mode", "docked");
    await expect.poll(atRest).toBe("");
    // Escape while tearing it off: it goes back onto the Bar.
    grab = await grabPoint();
    await drag(grab, { x: grab.x, y: grab.y - 140 }, 16, false);
    await expect(answer).toHaveAttribute("data-mode", "detached");
    await shell.keyboard.press("Escape");
    await expect(answer).toHaveAttribute("data-mode", "docked");
    await shell.mouse.up();
    await expect.poll(atRest).toBe("");
    await expect(shell.locator('[data-testid="desk-answer"][data-shown]')).toHaveCount(1);
    await shell.getByTestId("desk-surface").click({ position: { x: 4, y: 4 } });
    await expect(shell.getByTestId("desk-answer")).toHaveCount(0);
    // Left floating just over the Bar (in reach of its slot), it opens there; a press on its header that never moves
    // only takes it up — it stays a window.
    await shell.evaluate(() => localStorage.setItem("pistachio.desk.answer.v1", JSON.stringify({ floating: true, fx: 0.3, fy: 1, w: 440, h: 240 })));
    await reachBar(shell);
    await answerButton.click();
    await expect(shell.locator('[data-testid="desk-answer"][data-shown]')).toHaveCount(1);
    await expect(answer).toHaveAttribute("data-mode", "detached");
    grab = await grabPoint();
    await shell.mouse.move(grab.x, grab.y);
    await shell.mouse.down();
    // (Held a few frames, as a hand's click is: the card is read where it lies each frame.)
    await shell.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)))));
    await expect(shell.getByTestId("desk-answer-ghost")).not.toHaveAttribute("data-hot", "");
    await shell.mouse.up();
    await shell.evaluate(() => new Promise(requestAnimationFrame));
    await expect(answer).toHaveAttribute("data-mode", "detached");
    // The Bar growing under it (a message of several lines) moves it up, clear of the Bar.
    const field = shell.getByTestId("desk-bar-input");
    await field.fill("one\ntwo\nthree\nfour\nfive");
    const grown = await box(shell, '[data-testid="desk-bar"]');
    expect(grown.height).toBeGreaterThan(80);
    await expect.poll(async () => { const card = await box(shell, '[data-testid="desk-answer"]'); return card.y + card.height <= grown.y + 1; }).toBe(true);
    await field.fill("");
    // Sent home, and a press elsewhere puts it away before it is there: its slot's ghost goes with it.
    await shell.getByTestId("desk-answer-dock").click();
    await shell.getByTestId("desk-surface").click({ position: { x: 4, y: 4 } });
    await expect(shell.getByTestId("desk-answer")).toHaveCount(0);
    await expect.poll(() => shell.getByTestId("desk-answer-ghost").evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(0);
    // (And it opens docked next time: going home is what it was asked.)
    await expect.poll(() => shell.evaluate(() => (JSON.parse(localStorage.getItem("pistachio.desk.answer.v1") ?? "null") as { floating: boolean } | null)?.floating)).toBe(false);

    // ── 8. A page the agent's click opens — from a tab in the dock — is hidden: nowhere on the desk, in no group ─
    await shell.locator(`${windowSelector(invoice)} [data-testid="desk-collapse"]`).click();
    await settled(shell, app);
    await expect(shell.locator(windowSelector(invoice))).toHaveCount(0);
    // The person goes on in another window: the invoice is in the dock, and not the tab in use.
    await selectTab(shell, opened.id);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(opened.id);
    await settled(shell, app);
    const inUseBefore = opened.id;
    await shell.getByTestId("desk-bar-input").fill("Open the vendor record from the invoice");
    await shell.getByTestId("desk-bar-input").press("Enter");
    await expect(shell.getByTestId("desk-answer")).toContainText("Opened the vendor record from the invoice", { timeout: 15_000 });
    await expect.poll(async () => (await snapshot(shell)).hiddenTabs?.map((tab) => tab.url)).toEqual([VENDOR]);
    const fromLink = (await snapshot(shell)).hiddenTabs![0]!;
    expect((await snapshot(shell)).tabs.filter((tab) => tab.url === VENDOR).map((tab) => tab.id)).toEqual([vendor]);
    expect((await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-agent")?.tabIds).not.toContain(fromLink.id);
    await expect(shell.locator(windowSelector(fromLink.id))).toHaveCount(0);
    expect((await snapshot(shell)).activeTabId).toBe(inUseBefore);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);

    // ── 9. The conversations: this desk's, marked; a new one starts empty ─
    await openTray(shell);
    await shell.getByTestId("desk-bar-conversations").click();
    await expect(shell.locator('[data-testid="desk-conversations"][data-shown]')).toHaveCount(1);
    await expect(shell.getByTestId("desk-conversation")).toHaveCount(1);
    await expect(shell.getByTestId("desk-conversation").first()).toContainText("This desk");
    // Rows, as the mentions' are: New conversation first; no heading.
    await expect(shell.getByTestId("desk-conversations")).not.toContainText("Conversations");
    await expect(shell.getByTestId("desk-conversation-new")).toHaveText("New conversation");
    await expect(shell.getByTestId("desk-conversation").first()).toHaveAttribute("aria-current", "true");
    await capture(app, shell, "06-desk-conversations.png");
    // A press anywhere else puts them away: in the shell (the Bar's field)…
    await shell.getByTestId("desk-bar-input").click();
    await expect(shell.getByTestId("desk-conversations")).toHaveCount(0);
    await expect(shell.getByTestId("desk-bar-input")).toBeFocused();
    // …or in a live page, which main relays.
    await openTray(shell);
    await shell.getByTestId("desk-bar-conversations").click();
    await expect(shell.locator('[data-testid="desk-conversations"][data-shown]')).toHaveCount(1);
    await app.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      contents.sendInputEvent({ type: "mouseMove", x: 420, y: 24 });
      contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: 420, y: 24 });
      await new Promise((done) => setTimeout(done, 40));
      contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: 420, y: 24 });
    }, ACCOUNTS);
    await expect(shell.getByTestId("desk-conversations")).toHaveCount(0);
    // Its own button still toggles it.
    await openTray(shell);
    await shell.getByTestId("desk-bar-conversations").click();
    await expect(shell.locator('[data-testid="desk-conversations"][data-shown]')).toHaveCount(1);
    await openTray(shell);
    await shell.getByTestId("desk-bar-conversations").click();
    await expect(shell.getByTestId("desk-conversations")).toHaveCount(0);
    await openTray(shell);
    await shell.getByTestId("desk-bar-conversations").click();
    await expect(shell.locator('[data-testid="desk-conversations"][data-shown]')).toHaveCount(1);
    const runId = run.runId;
    await shell.getByTestId("desk-conversation-new").click();
    await expect.poll(async () => (await snapshot(shell)).run).toBeNull();
    await expect(shell.getByTestId("desk-answer")).toHaveCount(0);
    // And the earlier one is still there to continue here.
    await openTray(shell);
    await shell.getByTestId("desk-bar-conversations").click();
    await shell.locator(`[data-testid="desk-conversation"][data-run-id="${runId}"]`).click();
    await expect.poll(async () => (await snapshot(shell)).run?.runId).toBe(runId);
    // Chosen, it opens on its messages — the person sees they are in another thread — and the picker goes.
    await expect(shell.locator('[data-testid="desk-answer"][data-shown]')).toHaveCount(1);
    await expect(shell.getByTestId("desk-answer")).toContainText("Opened the vendor record from the invoice");
    await expect(shell.getByTestId("desk-conversations")).toHaveCount(0);
    await capture(app, shell, "07-desk-conversation-chosen.png");
    // The tray's New conversation starts an empty one, as the conversations' does.
    await openTray(shell);
    await shell.getByTestId("desk-bar-new-conversation").click();
    await expect.poll(async () => (await snapshot(shell)).run).toBeNull();
    await expect(shell.getByTestId("desk-answer")).toHaveCount(0);

  } finally {
    await app.close();
  }
});
