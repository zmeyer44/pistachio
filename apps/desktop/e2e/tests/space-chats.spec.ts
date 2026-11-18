/**
 * The chat is its space's (docs/desk-agent.md §1, "The chat is its space's";
 * §3, "Conversations stay in their space"), through the real app on a
 * scripted model: a chat taken to the side in one space, its agent at work,
 * and the person gone to another — nothing goes with them. The space they
 * come to has its own chat (none yet, in its nub), its own field and its
 * whole desk; they ask there, and that conversation runs beside the first,
 * which goes on where it was asked: its tile on the rail says it is working,
 * then that it has answered. Back in the first space its chat is at the side
 * again, as it was left, with the answer. And the next launch finds each
 * space's chat where it stood.
 */

import { expect, test } from "@playwright/test";
import { api, box, chatSpot, chooseSpace, createGroup, INVOICES, launchDesk, openTabs, pressNubButton, railSpace, reachBar, selectSpace, selectTab, settled, snapshot, tabGroupCommand, VENDOR, windowSelector } from "./desk-harness";
import { shellReady } from "./windows";

/** The first space's turn lingers on its first step (the model is slow to answer) while the person is elsewhere. */
const LINGER_MS = 9_000;

const SCRIPT = {
  steps: [
    // The invoice space's turn: a look at its tabs, a long time coming, then its answer.
    { delayMs: LINGER_MS, tools: [{ name: "tabs_list", input: {} }] },
    // The vendor space's turn, asked while the first is still at it.
    { text: "For the vendor space." },
    { text: "Done in the invoice space." },
  ],
};

function near(actual: number, expected: number, within = 3): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(within);
}

test("a chat stays in its space: at the side in one, working in the background, while another space has its own", { tag: ["@desk", "@agent"] }, async () => {
  test.setTimeout(150_000);
  const first = await launchDesk({ name: "space-chats", env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify(SCRIPT) } });
  let app = first.app;
  let shell = first.shell;
  try {
    const [invoice, vendor] = (await openTabs(shell, [INVOICES, VENDOR])) as [string, string];
    await createGroup(shell, "space-invoices", [invoice], "Invoices", "green");
    await createGroup(shell, "space-vendors", [vendor], "Vendors", "blue");
    await selectTab(shell, invoice);
    await selectSpace(shell, "space-invoices");
    await settled(shell, app);
    const answer = shell.getByTestId("desk-answer");
    const input = shell.getByTestId("desk-bar-input");
    const agents = (): Promise<Record<string, string>> => snapshot(shell).then((state) => state.spaceAgents ?? {});

    // ── 1. Asked in the invoice space, its chat taken to the side: a part of that desk, the windows giving way ─
    const whole = await box(shell, windowSelector(invoice));
    await reachBar(shell);
    await input.fill("What is on this desk?");
    await input.press("Enter");
    await expect(shell.locator('[data-testid="desk-answer"][data-shown]')).toHaveCount(1);
    const invoices = (await snapshot(shell)).run!.runId;
    await pressNubButton(app, shell, "desk-answer-side");
    await expect(answer).toHaveAttribute("data-zone", "chat");
    await settled(shell, app);
    const stage = await box(shell, ".desk-stage");
    const atSide = await box(shell, '[data-testid="desk-answer"]');
    near(atSide.x + atSide.width, stage.x + stage.width);
    const beside = await box(shell, windowSelector(invoice));
    expect(beside.x + beside.width).toBeLessThan(atSide.x);
    await expect.poll(() => chatSpot(shell, "space-invoices").then((spot) => spot?.zone)).toBe("chat");
    expect((await snapshot(shell)).run?.status).toBe("running");

    // ── 2. The person goes to the vendor space: nothing of the invoice space's chat goes with them ─
    await chooseSpace(shell, "space-vendors");
    await settled(shell, app);
    // No chat at the side here, no card, the pill in its nub — and this space's conversation is its own: none yet.
    await expect(answer).toHaveCount(0);
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    await expect.poll(async () => (await snapshot(shell)).run).toBeNull();
    expect(await chatSpot(shell, "space-vendors")).toBeNull();
    // Its desk is whole: no room kept for a chat that is not this space's.
    const vendorWindow = await box(shell, windowSelector(vendor));
    expect(vendorWindow.x + vendorWindow.width).toBeGreaterThan(atSide.x + 40);
    // The invoice space goes on where it was asked: its tile says the agent is at work there.
    expect(await agents()).toEqual({ "space-invoices": "working" });
    await expect(railSpace(shell, "space-invoices")).toHaveAttribute("data-agent", "working");
    await expect(railSpace(shell, "space-invoices").getByTestId("rail-space-agent")).toHaveAttribute("data-state", "working");
    await expect(railSpace(shell, "space-invoices")).toHaveAttribute("aria-label", /Pistachio is working here/);
    await expect(railSpace(shell, "space-vendors").getByTestId("rail-space-agent")).toHaveCount(0);

    // ── 3. Asked here, this space's own conversation runs beside the other, start to finish ─
    await reachBar(shell);
    await expect(input).toHaveValue("");
    await expect(shell.getByTestId("desk-bar-stop")).toHaveCount(0);
    await input.fill("What about the vendor?");
    await input.press("Enter");
    await expect(answer).toContainText("For the vendor space.");
    await expect(answer).toHaveAttribute("data-mode", "docked");
    const vendors = await snapshot(shell);
    expect(vendors.run?.runId).not.toBe(invoices);
    expect(vendors.run?.groupId).toBe("space-vendors");
    expect(vendors.run?.status).toBe("completed");
    // (The invoice space's turn is still at its first step: the two never waited on each other.)
    expect(vendors.threads.find((thread) => thread.runId === invoices)?.status).toBe("running");
    expect(await agents()).toEqual({ "space-invoices": "working" });
    // A draft left in this space's field is this space's.
    await input.fill("a vendor draft");

    // ── 4. The invoice space's turn ends with nobody looking: its tile says there is an answer to read ─
    await expect.poll(agents, { timeout: LINGER_MS + 15_000 }).toEqual({ "space-invoices": "answered" });
    await expect(railSpace(shell, "space-invoices").getByTestId("rail-space-agent")).toHaveAttribute("data-state", "answered");
    await expect(railSpace(shell, "space-invoices")).toHaveAttribute("aria-label", /Pistachio has answered here/);
    // (Nothing of it came here: this space's card still shows its own.)
    await expect(answer).toContainText("For the vendor space.");
    await expect(answer).not.toContainText("Done in the invoice space.");

    // ── 5. Back in the invoice space: its chat at the side, as it was left, with the answer; its windows where they were ─
    await chooseSpace(shell, "space-invoices");
    await settled(shell, app);
    await expect(answer).toHaveAttribute("data-zone", "chat");
    await expect(answer).toContainText("Done in the invoice space.");
    await expect(answer).not.toContainText("For the vendor space.");
    expect((await snapshot(shell)).run?.runId).toBe(invoices);
    const back = await box(shell, '[data-testid="desk-answer"]');
    near(back.x, atSide.x);
    near(back.width, atSide.width);
    const besideAgain = await box(shell, windowSelector(invoice));
    near(besideAgain.x, beside.x);
    near(besideAgain.width, beside.width);
    // Looked at, its tile has nothing more to say; and its field is its own (the vendor space's draft stayed there).
    await expect.poll(agents).toEqual({});
    await expect(railSpace(shell, "space-invoices").getByTestId("rail-space-agent")).toHaveCount(0);
    await expect(input).toHaveValue("");
    await chooseSpace(shell, "space-vendors");
    await settled(shell, app);
    // (Its card was docked on the pill, which a press elsewhere puts away — the press that left this space did. The
    // pill is out for the draft it holds, and its answer button brings the card back: this space's own conversation.)
    await expect(input).toHaveValue("a vendor draft");
    await expect(answer).toHaveCount(0);
    await shell.getByTestId("desk-bar-answer").click();
    await expect(answer).toHaveAttribute("data-mode", "docked");
    await expect(answer).toContainText("For the vendor space.");
    await expect(answer).not.toContainText("Done in the invoice space.");
    near((await box(shell, windowSelector(vendor))).width, vendorWindow.width);
    await input.fill("");

    // ── 6. Taken out of its place, the invoice space's windows have the whole desk back, exactly ─
    await chooseSpace(shell, "space-invoices");
    await settled(shell, app);
    await shell.getByTestId("desk-answer-dismiss").click();
    await expect(answer).toHaveCount(0);
    await settled(shell, app);
    const wholeAgain = await box(shell, windowSelector(invoice));
    near(wholeAgain.x, whole.x);
    near(wholeAgain.width, whole.width);
    // (Where it was is kept for when it comes up again: this space's, at the side — and that the person closed it there.)
    await expect.poll(() => chatSpot(shell, "space-invoices").then((spot) => [spot?.zone, spot?.shut])).toEqual(["chat", true]);
    expect((await chatSpot(shell, "space-vendors"))?.floating ?? false).toBe(false);
    // Closed, it stays closed: the desk gone to another space and back does not bring it up again.
    await chooseSpace(shell, "space-vendors");
    await settled(shell, app);
    await chooseSpace(shell, "space-invoices");
    await settled(shell, app);
    await expect(answer).toHaveCount(0);
    near((await box(shell, windowSelector(invoice))).width, whole.width);
  } finally {
    await app.close();
  }

  // ── 7. The next launch: each space's chat stands where it stood — and one closed is closed still ─
  const second = await launchDesk({ name: "space-chats", userData: first.userData, env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify({ steps: [] }) } });
  app = second.app;
  shell = second.shell;
  try {
    await selectSpace(shell, "space-invoices");
    await settled(shell, app);
    const answer = shell.getByTestId("desk-answer");
    // The invoice space's chat was closed before Pistachio quit: it does not come up by itself. Asked for, it is at
    // the side — its place — with its conversation; the vendor space's is in its nub.
    await expect(answer).toHaveCount(0);
    await reachBar(shell);
    await shell.getByTestId("desk-bar-answer").click();
    await expect(answer).toHaveAttribute("data-zone", "chat");
    await expect(answer).toContainText("Done in the invoice space.");
    await expect.poll(() => chatSpot(shell, "space-invoices").then((spot) => spot?.shut)).toBeUndefined();
    await chooseSpace(shell, "space-vendors");
    await settled(shell, app);
    await expect(answer).toHaveCount(0);
    await expect.poll(async () => (await snapshot(shell)).run?.groupId).toBe("space-vendors");
    await reachBar(shell);
    await shell.getByTestId("desk-bar-answer").click();
    await expect(answer).toHaveAttribute("data-mode", "docked");
    await expect(answer).toContainText("For the vendor space.");
    // Left up at the side, the invoice space's chat is up there when the person is back — and when Pistachio next
    // opens: a chat a space keeps beside its windows stays until it is closed.
    await chooseSpace(shell, "space-invoices");
    await settled(shell, app);
    await expect(answer).toHaveAttribute("data-zone", "chat");
    await shell.reload();
    await shellReady(app);
    await settled(shell, app);
    await expect(answer).toHaveAttribute("data-zone", "chat");
    await expect(answer).toContainText("Done in the invoice space.");
  } finally {
    await app.close();
  }
});

test("a tab of Home's has its own chat: a change of tab never opens it, one closed stays closed, and it comes up at Home's side where it is asked for; a space of its own has its own", { tag: ["@desk", "@agent"] }, async () => {
  test.setTimeout(90_000);
  const { app, shell } = await launchDesk({ name: "space-chats-home", env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify({ steps: [{ text: "About the invoices." }] }) } });
  try {
    // Two tabs of Home's: under the hood each is a space of its own, with a conversation of its own.
    const [invoice, vendor] = (await openTabs(shell, [INVOICES, VENDOR])) as [string, string];
    await selectTab(shell, invoice);
    await expect(shell.locator(windowSelector(invoice))).toHaveCount(1);
    await settled(shell, app);
    const answer = shell.getByTestId("desk-answer");
    const profile = (await snapshot(shell)).activeSpaceId;
    const whole = await box(shell, windowSelector(invoice));

    // Asked on the invoice tab, the chat taken to the side: the page gives way to it.
    await reachBar(shell);
    await shell.getByTestId("desk-bar-input").fill("What is this page?");
    await shell.getByTestId("desk-bar-input").press("Enter");
    await expect(answer).toContainText("About the invoices.");
    await pressNubButton(app, shell, "desk-answer-side");
    await expect(answer).toHaveAttribute("data-zone", "chat");
    await settled(shell, app);
    const invoices = (await snapshot(shell)).run!.runId;
    const beside = await box(shell, windowSelector(invoice));
    expect(beside.width).toBeLessThan(whole.width - 200);
    // Where it stands is kept as Home's place, not the tab's.
    await expect.poll(() => chatSpot(shell, `home:${profile}`).then((spot) => spot?.zone)).toBe("chat");

    // The other Home tab: no chat comes up beside it — it was never opened there — and its page has the whole desk.
    // (Until 2026-11-17 the chat at Home's side opened beside every tab of Home, with every change of tab.)
    await selectTab(shell, vendor);
    await expect(shell.locator(windowSelector(vendor))).toHaveCount(1);
    await settled(shell, app);
    await expect(answer).toHaveCount(0);
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    await expect.poll(async () => (await snapshot(shell)).run).toBeNull();
    near((await box(shell, windowSelector(vendor))).width, whole.width);
    // And back: the invoice tab's chat as it was left — up, at the side, with its conversation.
    await selectTab(shell, invoice);
    await settled(shell, app);
    await expect(answer).toHaveAttribute("data-zone", "chat");
    await expect(answer).toContainText("About the invoices.");
    expect((await snapshot(shell)).run?.runId).toBe(invoices);

    // Closed beside the invoice tab, it stays closed there: to the other tab and back, nothing opens.
    await shell.getByTestId("desk-answer-dismiss").click();
    await expect(answer).toHaveCount(0);
    await selectTab(shell, vendor);
    await settled(shell, app);
    await expect(answer).toHaveCount(0);
    await selectTab(shell, invoice);
    await settled(shell, app);
    await expect(answer).toHaveCount(0);
    near((await box(shell, windowSelector(invoice))).width, whole.width);
    // (Home's place is every tab's: whether a tab's chat is up is never written into it.)
    expect((await chatSpot(shell, `home:${profile}`))?.shut).toBeUndefined();
    // Asked for again, it comes up where Home's chat stands — at the side — with this tab's conversation.
    await reachBar(shell);
    await shell.getByTestId("desk-bar-answer").click();
    await expect(answer).toHaveAttribute("data-zone", "chat");
    await expect(answer).toContainText("About the invoices.");
    await settled(shell, app);

    // A space of its own is its own place: its chat is in its nub, though Home's stands at the side.
    await createGroup(shell, "space-vendors", [vendor], "Vendors", "blue");
    await selectSpace(shell, "space-vendors");
    await settled(shell, app);
    await expect(answer).toHaveCount(0);
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    expect(await chatSpot(shell, "space-vendors")).toBeNull();
    await selectTab(shell, invoice);
    await settled(shell, app);
    await expect(answer).toHaveAttribute("data-zone", "chat");
    await expect(answer).toContainText("About the invoices.");

    // The invoice tab breaks away where it stands: a space of its own from here on — the same space, another place.
    // Its chat stays exactly as it is, at the side, and that is its own place's word now.
    const [auth] = (await openTabs(shell, ["pistachio://demo/auth/relying-party"])) as [string];
    await selectTab(shell, invoice);
    await settled(shell, app);
    await expect(answer).toHaveAttribute("data-zone", "chat");
    const own = (await snapshot(shell)).currentGroupId!;
    await tabGroupCommand(shell, { type: "ownSpace", groupId: own });
    await expect.poll(async () => (await snapshot(shell)).tabGroups.some((group) => group.id === own)).toBe(true);
    await settled(shell, app);
    expect((await snapshot(shell)).currentGroupId).toBe(own);
    await expect(answer).toHaveAttribute("data-zone", "chat");
    await expect(answer).toContainText("About the invoices.");
    await expect.poll(() => chatSpot(shell, own).then((spot) => spot?.zone)).toBe("chat");
    // Straight to a Home tab never asked in: no chat. Asked for there, it is at the side, where Home's stands; sent
    // back to its pill there, it is Home's place that is docked from now — the space that broke away keeps its own,
    // at the side. (2026-11-17: the card went on keeping its place for the space it had left with, and Home's was
    // never written.)
    await selectTab(shell, auth);
    await expect(shell.locator(windowSelector(auth))).toHaveCount(1);
    await settled(shell, app);
    await expect(answer).toHaveCount(0);
    await reachBar(shell);
    await pressNubButton(app, shell, "desk-answer-side");
    await expect(answer).toHaveAttribute("data-zone", "chat");
    await expect(answer.getByTestId("desk-answer-empty")).toBeVisible();
    await shell.getByTestId("desk-answer-dock").click();
    await expect.poll(() => chatSpot(shell, `home:${profile}`).then((spot) => spot?.floating)).toBe(false);
    expect((await chatSpot(shell, own))?.zone).toBe("chat");
    await selectSpace(shell, own);
    await settled(shell, app);
    await expect(answer).toHaveAttribute("data-zone", "chat");
    await expect(answer).toContainText("About the invoices.");
  } finally {
    await app.close();
  }
});

test("a tab chosen in another space takes the person there, though this space's answer is up over its window", { tag: ["@desk", "@agent"] }, async () => {
  test.setTimeout(90_000);
  const { app, shell } = await launchDesk({ name: "space-chats-leave", env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify({ steps: [{ text: "Here is the invoice." }] }) } });
  try {
    const [invoice] = (await openTabs(shell, [INVOICES])) as [string];
    await createGroup(shell, "space-invoices", [invoice], "Invoices", "green");
    await selectTab(shell, invoice);
    await selectSpace(shell, "space-invoices");
    await settled(shell, app);
    const answer = shell.getByTestId("desk-answer");

    // Asked here: the answer is up, docked on the pill, over the window in use.
    await reachBar(shell);
    await shell.getByTestId("desk-bar-input").fill("Show me the invoice");
    await shell.getByTestId("desk-bar-input").press("Enter");
    await expect(answer).toContainText("Here is the invoice.");
    await settled(shell, app);
    // Away and back with no press of the pointer (a shortcut's way; here, a tab opened elsewhere, which passes the
    // desk to a space made for it and back): this space's card is up again as it was left, over the window that
    // came back in use — whose page is a still under it, waiting for the keyboard.
    const [elsewhere] = (await openTabs(shell, ["pistachio://demo/auth/relying-party"])) as [string];
    await expect(shell.locator('.desk-stage[data-phase="open"][data-group-id="space-invoices"]')).toHaveCount(1);
    await expect(answer).toContainText("Here is the invoice.");
    await settled(shell, app);

    // A tab of another space chosen (its row, the tab switcher, the palette: main's selectTab, which wakes the tab
    // before it is in use): the desk passes to its space, and stays. This space's card goes as the desk passes — and
    // the window it uncovers, on its way out, is not handed the keyboard: main would make ITS tab the one in use
    // again, over the tab just chosen (2026-11-16: the person was put straight back where they came from).
    await selectTab(shell, elsewhere);
    await expect(shell.locator('.desk-stage[data-phase="open"]:not([data-group-id="space-invoices"])')).toHaveCount(1);
    await settled(shell, app);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(elsewhere);
    await expect(answer).toHaveCount(0);
    await expect(shell.locator(windowSelector(elsewhere))).toHaveCount(1);
    // (Still there a moment later: nothing took them back.)
    await shell.waitForTimeout(500);
    const state = await snapshot(shell);
    expect(state.activeTabId).toBe(elsewhere);
    expect(state.currentGroupId).not.toBe("space-invoices");
    expect(state.run).toBeNull();
    // And back by its tile: the conversation is the invoice space's still.
    await chooseSpace(shell, "space-invoices");
    await settled(shell, app);
    await expect.poll(async () => (await snapshot(shell)).run?.groupId).toBe("space-invoices");
  } finally {
    await app.close();
  }
});

test("a stopped turn is resumed from its card, and a message is its own space's though the person has gone on", { tag: ["@desk", "@agent"] }, async () => {
  test.setTimeout(120_000);
  const script = {
    steps: [
      // The turn the person stops: its first step is a long time coming, and is cut short.
      { delayMs: 8_000, tools: [{ name: "tabs_list", input: {} }] },
      { text: "Picked up where it stopped." },
      { text: "For the invoice space, from afar." },
      // The turn the person stops and then ends.
      { delayMs: 8_000, tools: [{ name: "tabs_list", input: {} }] },
    ],
  };
  const { app, shell } = await launchDesk({ name: "space-chats-resume", env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify(script) } });
  try {
    const [invoice, vendor] = (await openTabs(shell, [INVOICES, VENDOR])) as [string, string];
    await createGroup(shell, "space-invoices", [invoice], "Invoices", "green");
    await createGroup(shell, "space-vendors", [vendor], "Vendors", "blue");
    await selectTab(shell, invoice);
    await selectSpace(shell, "space-invoices");
    await settled(shell, app);
    const answer = shell.getByTestId("desk-answer");
    const input = shell.getByTestId("desk-bar-input");
    const resume = shell.getByTestId("desk-answer-resume");
    const end = shell.getByTestId("desk-answer-end");

    // ── 1. Stopped, the card has Resume (the sidebar console's, until the panel went): the turn goes on from there ─
    await reachBar(shell);
    await input.fill("What is on this desk?");
    await input.press("Enter");
    await expect.poll(async () => (await snapshot(shell)).run?.status).toBe("running");
    // (While the agent is at it there is Stop, and nothing to resume or end.)
    await expect(resume).toHaveCount(0);
    await expect(end).toHaveCount(0);
    await shell.getByTestId("desk-bar-stop").click();
    await expect.poll(async () => (await snapshot(shell)).run?.status).toBe("interrupted");
    await expect(resume).toBeVisible();
    await expect(end).toBeVisible();
    await resume.click();
    await expect(answer).toContainText("Picked up where it stopped.");
    await expect(resume).toHaveCount(0);
    await expect(end).toHaveCount(0);
    const invoices = await snapshot(shell);
    expect(invoices.run?.status).toBe("completed");
    expect(invoices.run?.messages.filter((message) => message.role === "user")).toHaveLength(1);

    // ── 2. A message from this space's Bar that main hears once the person is in another (a file it mentions was
    //       still being read) is this space's: it runs here, behind them, and the space they are in is handed nothing ─
    await chooseSpace(shell, "space-vendors");
    await settled(shell, app);
    await expect.poll(async () => (await snapshot(shell)).run).toBeNull();
    await api(shell, (pistachio) => pistachio.sendAgentMessage("And the totals?", [], { page: false, groupId: "space-invoices" }));
    await expect.poll(async () => (await snapshot(shell)).spaceAgents?.["space-invoices"]).toBe("answered");
    const vendors = await snapshot(shell);
    expect(vendors.currentGroupId).toBe("space-vendors");
    expect(vendors.run).toBeNull();
    expect(vendors.threads.filter((thread) => thread.groupId === "space-vendors")).toEqual([]);
    await expect(answer).toHaveCount(0);
    await expect(railSpace(shell, "space-invoices")).toHaveAttribute("data-agent", "answered");
    // Back in the invoice space: the same conversation, gone on, its answer up to be read.
    await chooseSpace(shell, "space-invoices");
    await settled(shell, app);
    await expect(answer).toContainText("For the invoice space, from afar.");
    const back = await snapshot(shell);
    expect(back.run?.runId).toBe(invoices.run?.runId);
    expect(back.run?.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["What is on this desk?", "And the totals?"]);

    // ── 3. Stopped again, and ended this time (the console's End task): over, with nothing left to resume ─
    await reachBar(shell);
    await input.fill("One more look");
    await input.press("Enter");
    await expect.poll(async () => (await snapshot(shell)).run?.status).toBe("running");
    await shell.getByTestId("desk-bar-stop").click();
    await expect.poll(async () => (await snapshot(shell)).run?.status).toBe("interrupted");
    await expect(end).toBeVisible();
    await end.click();
    await expect.poll(async () => (await snapshot(shell)).run?.status).toBe("revoked");
    await expect(resume).toHaveCount(0);
    await expect(end).toHaveCount(0);

    // ── 4. Asked about a tab of another space (its menu's Ask Pistachio): the desk passes to that space, and it is
    //       that space's field that takes the keyboard — not the one being left, which goes with its space ─
    await app.evaluate(({ BrowserWindow }, tabId) => BrowserWindow.getAllWindows()[0]!.webContents.send("pistachio:shell-command", { type: "delegate", tabId }), vendor);
    await expect(shell.locator('.desk-stage[data-phase="open"][data-group-id="space-vendors"]')).toHaveCount(1);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(vendor);
    await expect(input).toBeFocused();
    await expect(shell.getByTestId("desk-bar")).not.toHaveAttribute("data-compact", "");
    await expect(input).toHaveValue("");
  } finally {
    await app.close();
  }
});

test("a card on its way back to the pill as the desk passes keeps its word for its own space", { tag: ["@desk", "@agent"] }, async () => {
  test.setTimeout(120_000);
  const script = { steps: [{ text: "For the vendor space." }, { text: "For the invoice space." }] };
  const { app, shell } = await launchDesk({ name: "space-chats-docking", env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify(script) } });
  try {
    const [invoice, vendor] = (await openTabs(shell, [INVOICES, VENDOR])) as [string, string];
    await createGroup(shell, "space-invoices", [invoice], "Invoices", "green");
    await createGroup(shell, "space-vendors", [vendor], "Vendors", "blue");
    const answer = shell.getByTestId("desk-answer");
    const input = shell.getByTestId("desk-bar-input");
    // Each space's chat is taken to the side, the vendor space's first.
    for (const [space, tab, words] of [["space-vendors", vendor, "For the vendor space."], ["space-invoices", invoice, "For the invoice space."]] as const) {
      await selectTab(shell, tab);
      await selectSpace(shell, space);
      await settled(shell, app);
      await reachBar(shell);
      await input.fill("What is here?");
      await input.press("Enter");
      await expect(answer).toContainText(words);
      await pressNubButton(app, shell, "desk-answer-side");
      await expect(answer).toHaveAttribute("data-zone", "chat");
      await settled(shell, app);
      await expect.poll(() => chatSpot(shell, space).then((spot) => spot?.zone)).toBe("chat");
    }

    // The invoice space's card is sent back to its pill, and the desk passes to the vendor space while it is still
    // on its way — a tab of that space chosen (its row, the tab switcher: the Bar stays as it is, drawn for the next
    // space). What the card writes as it goes — docked, from now — is the invoice space's; the vendor space's chat is
    // at the side, as it was left. (2026-11-17: it was written over the space arrived at, whose chat came up docked.)
    // (Every write of the spots from here on is kept, as it is made: a wrong one may be put right a moment later.)
    await shell.evaluate(() => {
      const writes: unknown[] = [];
      (window as unknown as { spotWrites: unknown[] }).spotWrites = writes;
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (this: Storage, key: string, value: string): void {
        if (key === "pistachio.desk.answer.v2") writes.push(JSON.parse(value));
        set.call(this, key, value);
      };
    });
    // (The press and the passing in one breath: the card has only begun its way back.)
    await shell.evaluate((tabId) => {
      document.querySelector<HTMLElement>('[data-testid="desk-answer-dock"]')!.click();
      return (window as unknown as { pistachio: { selectTab(id: string): Promise<unknown> } }).pistachio.selectTab(tabId);
    }, vendor);
    await expect(shell.locator('.desk-stage[data-phase="open"][data-group-id="space-vendors"]')).toHaveCount(1);
    await settled(shell, app);
    await expect(answer).toContainText("For the vendor space.");
    await expect(answer).toHaveAttribute("data-zone", "chat");
    expect((await chatSpot(shell, "space-vendors"))?.zone).toBe("chat");
    await expect.poll(() => chatSpot(shell, "space-invoices").then((spot) => spot?.floating)).toBe(false);
    const writes = await shell.evaluate(() => (window as unknown as { spotWrites: Array<Record<string, { floating?: boolean; zone?: string } | undefined>> }).spotWrites);
    expect(writes.some((spots) => spots["space-invoices"]?.floating === false)).toBe(true);
    expect(writes.filter((spots) => spots["space-vendors"]?.zone !== "chat")).toEqual([]);
    // And back, the same way: the invoice space's card is on its pill.
    await selectTab(shell, invoice);
    await expect(shell.locator('.desk-stage[data-phase="open"][data-group-id="space-invoices"]')).toHaveCount(1);
    await settled(shell, app);
    await expect(answer).toContainText("For the invoice space.");
    await expect(answer).toHaveAttribute("data-mode", "docked");
  } finally {
    await app.close();
  }
});

test("a message sent while the agent is at work steers it at once", { tag: ["@desk", "@agent"] }, async () => {
  test.setTimeout(90_000);
  // The first turn's step is a long time coming: long enough that a message which waited for the turn to end would
  // be seen to.
  const SLOW_MS = 20_000;
  const script = { steps: [{ delayMs: SLOW_MS, tools: [{ name: "tabs_list", input: {} }] }, { text: "Steered: the vendor instead." }] };
  const { app, shell } = await launchDesk({ name: "space-chats-steer", env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify(script) } });
  try {
    const [invoice] = (await openTabs(shell, [INVOICES])) as [string];
    await createGroup(shell, "space-invoices", [invoice], "Invoices", "green");
    await selectTab(shell, invoice);
    await selectSpace(shell, "space-invoices");
    await settled(shell, app);
    const input = shell.getByTestId("desk-bar-input");
    await reachBar(shell);
    await input.fill("What is on this desk?");
    await input.press("Enter");
    await expect.poll(async () => (await snapshot(shell)).run?.status).toBe("running");

    // A correction typed while it works reaches main now — the turn under way is cut short for it — not once that
    // turn has run its course. (The Bar is the desktop's only chat: 2026-11-17, its sends waited in line for main's
    // answer to the one before, which comes only when the turn it started has ended.)
    await reachBar(shell);
    await input.fill("Look at the vendor instead");
    await input.press("Enter");
    const said = (): Promise<string[]> => snapshot(shell).then((state) => (state.run?.messages ?? []).filter((message) => message.role === "user").map((message) => message.content));
    await expect.poll(said, { timeout: SLOW_MS / 3 }).toEqual(["What is on this desk?", "Look at the vendor instead"]);
    await expect(shell.getByTestId("desk-answer")).toContainText("Steered: the vendor instead.", { timeout: SLOW_MS / 3 });
    expect((await snapshot(shell)).run?.status).toBe("completed");
  } finally {
    await app.close();
  }
});

