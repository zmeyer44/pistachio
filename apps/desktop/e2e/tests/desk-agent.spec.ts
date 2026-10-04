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
import { api, box, createGroup, INVOICES, launchDesk, openGroupDesk, openTabs, reachBar, screenshots, selectTab, settled, snapshot, VENDOR, windowSelector } from "./desk-harness";

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
    // The second turn opens a page into the group.
    { tools: [{ name: "tab_open", input: { url: ACCOUNTS } }] },
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
    // Every button says what it does.
    await shell.getByTestId("desk-bar-attach").hover();
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]')).toHaveText("Attach files");
    await capture(app, shell, "01b-desk-bar-tooltip.png");
    await shell.getByTestId("desk-bar-send").hover();
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]', { hasText: "Send" })).toBeVisible();
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

    // ── 7. A tab it opens joins the group and comes out quietly, under the window in use ─
    await shell.getByTestId("desk-bar-input").fill("Open the connected accounts too");
    await shell.getByTestId("desk-bar-input").press("Enter");
    await expect(shell.getByTestId("desk-answer")).toContainText("Opened the connected accounts", { timeout: 15_000 });
    await expect(shell.locator('[data-testid="tab-group"] [role="tab"]')).toHaveCount(3);
    const opened = (await snapshot(shell)).tabs.find((tab) => tab.url === ACCOUNTS)!;
    expect((await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-agent")?.tabIds).toContain(opened.id);
    await expect(shell.locator(windowSelector(opened.id))).toHaveCount(1);
    expect((await snapshot(shell)).activeTabId).toBe(invoice);
    await settled(shell, app);
    await capture(app, shell, "05-desk-agent-opened.png");

    // ── 8. A page the agent's click opens joins the group — from a tab in the dock too — and comes out quietly ─
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
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => tab.url === VENDOR).length).toBe(2);
    const fromLink = (await snapshot(shell)).tabs.find((tab) => tab.url === VENDOR && tab.id !== vendor)!;
    expect((await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-agent")?.tabIds).toContain(fromLink.id);
    await expect(shell.locator(windowSelector(fromLink.id))).toHaveCount(1);
    expect((await snapshot(shell)).activeTabId).toBe(inUseBefore);
    await expect(shell.getByTestId("desk-surface")).toHaveCount(1);

    // ── 9. The conversations: this desk's, marked; a new one starts empty ─
    await reachBar(shell);
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
    await reachBar(shell);
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
    await reachBar(shell);
    await shell.getByTestId("desk-bar-conversations").click();
    await expect(shell.locator('[data-testid="desk-conversations"][data-shown]')).toHaveCount(1);
    await reachBar(shell);
    await shell.getByTestId("desk-bar-conversations").click();
    await expect(shell.getByTestId("desk-conversations")).toHaveCount(0);
    await reachBar(shell);
    await shell.getByTestId("desk-bar-conversations").click();
    await expect(shell.locator('[data-testid="desk-conversations"][data-shown]')).toHaveCount(1);
    const runId = run.runId;
    await shell.getByTestId("desk-conversation-new").click();
    await expect.poll(async () => (await snapshot(shell)).run).toBeNull();
    await expect(shell.getByTestId("desk-answer")).toHaveCount(0);
    // And the earlier one is still there to continue here.
    await reachBar(shell);
    await shell.getByTestId("desk-bar-conversations").click();
    await shell.locator(`[data-testid="desk-conversation"][data-run-id="${runId}"]`).click();
    await expect.poll(async () => (await snapshot(shell)).run?.runId).toBe(runId);

  } finally {
    await app.close();
  }
});
