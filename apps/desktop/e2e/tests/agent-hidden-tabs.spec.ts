/**
 * The agent's hidden tabs (src/main/agent-browser-tools.ts,
 * BrowserController.openHiddenTab), through the real controller and runner
 * on a scripted model (PISTACHIO_AGENT_SCRIPT): a turn looks a page
 * up in a tab the person never sees — not in the sidebar, the snapshot's
 * tabs or the palette, their own tab still the one in front — and shows it
 * only when asked
 * (tab_show: it joins their tabs in the space it was asked from, its window
 * out on the desk under the one in use). A page the agent's
 * own click opens, from the person's tab, opens hidden too; and what the
 * conversation kept hidden closes when it is set aside.
 */

import { expect, test } from "@playwright/test";
import { launchApp } from "./app";
import { api, INVOICES, openTabs, rowSelector, selectTab, snapshot, VENDOR, windowSelector } from "./desk-harness";
import { shellReady } from "./windows";

const SCRIPT = {
  steps: [
    // 1. Looks the vendor up out of sight, lingering on it so the chat can be seen saying so.
    { tools: [{ name: "tab_open", input: { url: VENDOR } }] },
    { tools: [{ name: "tabs_list", input: {} }] },
    { delayMs: 2_500, tools: [{ name: "page_inspect", input: { tabId: "{{tab:atlas}}" } }] },
    { text: "Atlas Medical's terms are net 30." },
    // 2. Asked to open it, shows it.
    { tools: [{ name: "tab_show", input: { tabId: "{{tab:atlas}}" } }] },
    { text: "Here it is." },
    // 3. Clicks a link in the person's own tab that opens its page in a new tab.
    { tools: [{ name: "page_click", input: { tabId: "{{tab:invoices}}", target: "#vendor-record-link" } }] },
    { text: "Opened the vendor record." },
  ],
};

test("the agent searches in hidden tabs, shows one only when asked, and closes them with the conversation", { tag: ["@agent"] }, async () => {
  test.setTimeout(90_000);
  const { app } = await launchApp({ name: "agent-hidden-tabs", env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify(SCRIPT) } });
  try {
    const shell = await shellReady(app);
    const [invoices] = (await openTabs(shell, [INVOICES])) as [string];
    await selectTab(shell, invoices);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(invoices);
    const before = (await snapshot(shell)).tabs.map((tab) => tab.id);
    const rows = shell.locator('[data-testid="sidebar-tab-list"] [role="tab"]');
    const rowCount = await rows.count();
    // The chat asked for by something other than the person at the Bar (the shell's `openConsole`: a reminder fired, a
    // notification pressed), with nothing to show yet: no panel opens beside the desk — what it was asked for comes
    // up as it comes (the conversation below).
    const wantChat = (): Promise<void> => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("pistachio:shell-command", { type: "openConsole" }));
    await wantChat();
    await expect(shell.getByTestId("agent-panel")).toHaveCount(0);
    // The answer card: the conversation of the space in front.
    const panel = shell.getByTestId("desk-answer");

    // ── 1. The lookup happens in a hidden tab ─
    const first = api(shell, (pistachio) => pistachio.startDelegation("What are Atlas Medical's payment terms?", [], { page: false }));
    // (Should a check below fail, the app closes under this call: that is not the failure to report.)
    first.catch(() => undefined);
    // While it works there, nothing of the person's moves. (At a desk the agent is seen on the windows and in the
    // card's lines: no chip says where it browses.)
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await snapshot(shell)).hiddenTabs?.some((tab) => tab.url === VENDOR) ?? false, { timeout: 15_000 }).toBe(true);
    let shot = await snapshot(shell);
    const hidden = shot.hiddenTabs?.find((tab) => tab.url === VENDOR);
    expect(hidden?.hiddenFor).toBe(shot.run?.runId);
    expect(hidden?.unlisted).toBe(true);
    expect(shot.tabs.map((tab) => tab.id)).toEqual(before);
    expect(shot.activeTabId).toBe(invoices);
    expect(shot.visibleTabIds).not.toContain(hidden!.id);
    await expect(rows).toHaveCount(rowCount);
    const palette = await api(shell, (pistachio) => pistachio.getCommandPalette());
    expect(palette.tabs.map((tab) => tab.id)).not.toContain(hidden!.id);
    await first;
    await expect(panel.getByTestId("assistant-message").last()).toContainText("net 30");
    shot = await snapshot(shell);
    expect(shot.tabs.map((tab) => tab.id)).toEqual(before);
    expect(shot.hiddenTabs?.map((tab) => tab.id)).toEqual([hidden!.id]);
    // The turn read the hidden page.
    expect(shot.run?.toolCalls.find((tool) => tool.name === "page.inspect")).toMatchObject({ status: "completed", tabId: hidden!.id });

    // ── 2. Asked to open it, the agent shows it: one of the person's tabs, in the space it was asked from, its window
    //       out on the desk — under the window in use, the person left where they are (docs/spaces.md §1) ─
    await api(shell, (pistachio) => pistachio.sendAgentMessage("Open it for me", [], { page: false }));
    await expect(panel.getByTestId("assistant-message").last()).toContainText("Here it is.");
    await expect.poll(async () => (await snapshot(shell)).tabs.map((tab) => tab.id)).toEqual([...before, hidden!.id]);
    shot = await snapshot(shell);
    const shown = shot.tabs.find((tab) => tab.id === hidden!.id)!;
    expect(shown.unlisted).toBe(false);
    expect(shown.hiddenFor).toBeUndefined();
    expect(shot.hiddenTabs).toEqual([]);
    expect(shot.activeTabId).toBe(invoices);
    expect([...shot.tabGroups, ...(shot.looseGroups ?? [])].find((group) => group.id === shot.currentGroupId)?.tabIds).toContain(hidden!.id);
    await expect(shell.locator(windowSelector(hidden!.id))).toHaveCount(1);
    await expect(shell.locator(rowSelector(hidden!.id))).toHaveCount(1);

    // ── 3. A page the agent's click opens from the person's tab opens hidden, the conversation's ─
    await api(shell, (pistachio) => pistachio.sendAgentMessage("Open the vendor record from the invoice", [], { page: false }));
    await expect(panel.getByTestId("assistant-message").last()).toContainText("Opened the vendor record.");
    await expect.poll(async () => (await snapshot(shell)).hiddenTabs?.length ?? 0).toBe(1);
    shot = await snapshot(shell);
    const fromLink = shot.hiddenTabs![0]!;
    expect(fromLink.url).toBe(VENDOR);
    expect(fromLink.hiddenFor).toBe(shot.run?.runId);
    expect(shot.tabs.map((tab) => tab.id)).toEqual([...before, hidden!.id]);
    expect(shot.activeTabId).toBe(invoices);
    // The click's result named it, for the agent to carry on there or show.
    expect(shot.run?.toolCalls.find((tool) => tool.name === "page.click")?.detail).toContain(fromLink.id);

    // ── 4. Set aside, the conversation takes what it kept hidden with it; what it showed stays ─
    await api(shell, (pistachio) => pistachio.newThread());
    await expect.poll(async () => (await snapshot(shell)).hiddenTabs ?? []).toEqual([]);
    expect((await snapshot(shell)).tabs.map((tab) => tab.id)).toEqual([...before, hidden!.id]);
    const closed = await api(shell, (pistachio) => pistachio.getCommandPalette());
    expect(closed.recentlyClosedTabs.map((tab) => tab.url)).not.toContain(VENDOR);

    // ── 5. The chat asked for again, long after launch, with nothing to show (no conversation here now): nothing comes
    //       out, and the keyboard is not taken from where the person has it — a reminder fires while they type ─
    await expect(shell.getByTestId("desk-answer")).toHaveCount(0);
    // (Asked for as the app started, above, the pill came out with the keyboard: a press on the desk puts it away.)
    await shell.getByTestId("desk-surface").click({ position: { x: 4, y: 4 } });
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    await expect(shell.getByTestId("desk-bar-input")).not.toBeFocused();
    await wantChat();
    await expect(shell.getByTestId("agent-panel")).toHaveCount(0);
    // (Long enough for a pill to have come out, had it been going to.)
    await expect.poll(async () => (await shell.getByTestId("desk-bar").getAttribute("data-compact")) === "" && !(await shell.getByTestId("desk-bar-input").evaluate((el) => el === document.activeElement)), { timeout: 2_000 }).toBe(true);
    await shell.waitForTimeout(600);
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    await expect(shell.getByTestId("desk-bar-input")).not.toBeFocused();
  } finally {
    await app.close();
  }
});
