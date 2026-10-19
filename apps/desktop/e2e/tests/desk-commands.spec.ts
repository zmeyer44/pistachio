/**
 * `/` commands in the desk's Bar (docs/desk-agent.md, *Commands*;
 * lib/desk/slash-commands.ts): a `/` at the head of the field lets out the
 * commands over it, grouped, and typing narrows them; the keys walk, choose
 * and dismiss them. Through the real app: `/search` opens a search on the
 * engine the person chose in a new tab of the space, `/remember` saves a
 * fact to the space's context, `/summarize` is a turn at this desk asking as
 * a person would (on a scripted model, PISTACHIO_AGENT_SCRIPT), and `/new`
 * starts a new conversation, and `/find` searches from the Find bar. The
 * list over the field is a cover whichever list it is, and one put away
 * comes back for the next message. What the
 * menu offers for what was typed, and what each request says, are
 * desk-slash-commands.test's.
 */

import { expect, test } from "@playwright/test";
import { api, box, createGroup, INVOICES, launchDesk, layoutOption, liveViews, openTabs, reachBar, screenshots, selectSpace, selectTab, settled, snapshot, windowSelector } from "./desk-harness";
import { activeUrl } from "./pages-harness";
import { findPage } from "./windows";

const capture = screenshots("desk-commands");

const REPLY = "Atlas Medical's invoice NS-2048 is for $4,200, due Oct 12.";
const SCRIPT = { steps: [{ text: REPLY }] };

test("the desk's Bar: / lists the commands, and they search, save a fact, ask Pistachio and start over", { tag: ["@desk", "@agent"] }, async () => {
  test.setTimeout(90_000);
  const { app, shell } = await launchDesk({ name: "commands", env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify(SCRIPT) } });
  try {
    await api(shell, (pistachio) => pistachio.updateSettings({ search: { webProvider: "duckduckgo" } }));
    const [invoice] = (await openTabs(shell, [INVOICES])) as [string];
    await createGroup(shell, "commands", [invoice], "Northstar", "green");
    await selectTab(shell, invoice);
    await selectSpace(shell, "commands");
    await settled(shell, app);
    const input = shell.getByTestId("desk-bar-input");
    const menu = shell.locator('[data-testid="desk-commands"][data-shown]');
    const rows = shell.getByTestId("desk-command");
    const lit = shell.locator('[data-testid="desk-command"][aria-selected="true"]');

    // ── 1. A bare `/` lists every command under its group, the first lit; the search names the engine chosen ─
    await reachBar(shell);
    await expect(input).toHaveAttribute("placeholder", "Ask about Northstar… (/ for commands)");
    await input.fill("/");
    await expect(menu).toBeVisible();
    await expect(rows).toHaveCount(18);
    await expect(menu.getByRole("group")).toHaveCount(4);
    await expect(lit).toHaveAttribute("data-command", "search");
    await expect(lit).toContainText("Search DuckDuckGo in a new tab");
    await expect(lit.locator('svg[data-provider-logo="duckduckgo"]')).toBeVisible();
    await expect(input).toHaveAttribute("aria-activedescendant", "desk-command-0");
    await capture(app, shell, "01-commands.png");

    // ── 2. Typing narrows them; the arrows walk the list round; Escape puts it away, and the field keeps the words ─
    await input.pressSequentially("s");
    await expect(rows.evaluateAll((all) => all.map((row) => row.getAttribute("data-command")))).resolves.toEqual(["search", "summarize", "screenshot", "share"]);
    await input.press("ArrowUp");
    await expect(lit).toHaveAttribute("data-command", "share");
    await input.press("ArrowDown");
    await expect(lit).toHaveAttribute("data-command", "search");
    await input.press("Escape");
    await expect(shell.getByTestId("desk-commands")).toHaveCount(0);
    await expect(input).toHaveValue("/s");
    // (Until the slash goes: typed again, the list is back.)
    await input.fill("");
    await input.pressSequentially("/sea");
    await expect(menu).toBeVisible();

    // ── 3. Enter on a command that waits for what it takes puts it in the field, its hint after it ─
    await input.press("Enter");
    await expect(input).toHaveValue("/search ");
    await expect(shell.getByTestId("desk-commands")).toHaveCount(0);
    await expect(shell.getByTestId("desk-bar-command-hint")).toHaveText("what to search for");
    await capture(app, shell, "02-search-hint.png");
    await input.pressSequentially("pistachio gelato");
    await expect(shell.getByTestId("desk-bar-command-hint")).toHaveCount(0);
    // Sent, it is no message: a search on the engine chosen, in a new tab of this space.
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await expect.poll(() => activeUrl(shell)).toBe(`https://duckduckgo.com/?q=${encodeURIComponent("pistachio gelato")}`);
    const searched = await snapshot(shell);
    expect(searched.tabGroups.find((group) => group.id === "commands")?.tabIds).toContain(searched.activeTabId);
    expect(searched.run?.messages ?? []).toHaveLength(0);

    // ── 4. `/remember` saves a fact to the space's context, as the Stack's own field does ─
    await reachBar(shell);
    await input.fill("/remember Approver: Dana in finance");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await expect
      .poll(async () => (await api(shell, (pistachio) => pistachio.getGroupContexts())).find((context) => context.groupId === "commands")?.items.map((item) => [item.kind, "text" in item ? item.text : null]))
      .toEqual([["fact", "Approver: Dana in finance"]]);

    // ── 5. A request to Pistachio is a turn at this desk, asked as a person would; chosen from the list it runs at once ─
    await reachBar(shell);
    await input.fill("/");
    await input.pressSequentially("summ");
    await expect(lit).toHaveAttribute("data-command", "summarize");
    await input.press("Enter");
    const answer = shell.getByTestId("desk-answer");
    await expect(answer.getByTestId("user-message")).toHaveText("Summarize the page in the window I'm using.");
    await expect(answer).toContainText(REPLY, { timeout: 20_000 });
    await settled(shell, app);
    await capture(app, shell, "03-summarize.png");

    // ── 6. `/new` starts a new conversation for the space ─
    await expect.poll(async () => (await snapshot(shell)).run).not.toBeNull();
    await reachBar(shell);
    await input.fill("/new");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    // As the tray's New conversation: an empty one, which the next message starts.
    await expect.poll(async () => (await snapshot(shell)).run).toBeNull();
    await expect(answer).toHaveCount(0);

    // ── 7. The list over the field is a cover whichever list it is: the @ list turning straight into the commands,
    //       the window the taller list now lies over is a still ─
    const transfer = await shell.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(["Boarding pass BA 0490, seat 14C"], "boarding-pass.txt", { type: "text/plain" }));
      return data;
    });
    for (const type of ["dragenter", "dragover", "drop"]) await shell.dispatchEvent('[data-testid="desk-stack"]', type, { dataTransfer: transfer });
    await expect(shell.getByTestId("desk-stack")).toHaveAttribute("data-count", "2");
    // One window above the other: the upper clear of the pill and of the short @ list, but not of the whole command
    // list once the field is a few lines tall (the list stands on the pill, as tall as it can be).
    await layoutOption(shell, "stack").click();
    await settled(shell, app);
    const boxes = await Promise.all([invoice, searched.activeTabId!].map((id) => box(shell, windowSelector(id))));
    const lowerTop = Math.max(...boxes.map((rect) => rect.y));
    expect(Math.min(...boxes.map((rect) => rect.y))).toBeLessThan(lowerTop - 200);
    const upperLive = async (): Promise<boolean> => (await liveViews(app)).some((view) => view.bounds.y + view.bounds.height <= lowerTop);
    await reachBar(shell);
    await input.fill("/summarize\n\n\n@");
    await expect(shell.locator('[data-testid="desk-mentions"][data-shown]')).toBeVisible();
    await expect.poll(upperLive).toBe(true);
    // The caret put just after the slash, as a click there puts it: the whole list, at once.
    await input.evaluate((field: HTMLTextAreaElement) => {
      field.setSelectionRange(1, 1);
      field.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await expect(menu).toBeVisible();
    await expect(rows).toHaveCount(18);
    await expect.poll(upperLive).toBe(false);
    await input.fill("");
    await expect(shell.getByTestId("desk-commands")).toHaveCount(0);

    // ── 8. A list put away with Escape comes back for the next message's `/`, however the last one went ─
    await input.fill("/remember");
    await expect(menu).toBeVisible();
    await input.press("Escape");
    await expect(shell.getByTestId("desk-commands")).toHaveCount(0);
    await input.pressSequentially(" Desk 4B");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await input.fill("/");
    await expect(menu).toBeVisible();

    // ── 9. `/find` searches the window in use from its Find bar, which shows what it searches — open already or not ─
    await input.fill("/find Reconcile");
    await input.press("Enter");
    const findField = (await findPage(app)).locator("input").first();
    await expect(findField).toHaveValue("Reconcile");
    await reachBar(shell);
    await input.fill("/find Freight");
    await input.press("Enter");
    await expect(findField).toHaveValue("Freight");
  } finally {
    await app.close();
  }
});
