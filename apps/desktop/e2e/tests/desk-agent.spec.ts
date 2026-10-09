/**
 * The desk's agent end to end (docs/desk-agent.md): the Bar — a nub in the
 * desk's trailing foot corner, its menu, the pill and the answer on it, the
 * conversations — the group's context as a Stack in the dock, and a turn through the
 * real controller and runner on a scripted model (PISTACHIO_AGENT_SCRIPT) —
 * the agent arranging the windows, wearing its ring on the window it works
 * in, pinning a note, saving a fact to the Stack; Undo layout; the
 * conversations; ⌘I. A turn going on in its group once the desk is left is
 * desk-agent.test's (apps/desktop/test).
 */

import { expect, test } from "@playwright/test";
import { api, box, createGroup, INVOICES, launchDesk, openChats, selectSpace, openTabs, openTray, reachBar, screenshots, selectTab, settled, snapshot, VENDOR, windowSelector, type Box } from "./desk-harness";

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
    { text: "Atlas Medical is beside the invoice now. Their terms are **net 30**, so NS-2048 is due Oct 12 — I saved that to this space's context." },
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
    await selectSpace(shell, "desk-agent");
    await expect(shell.locator('[data-testid="tab-group"] [role="tab"]')).toHaveCount(2);
    await settled(shell, app);
    const stage = await box(shell, ".desk-stage");
    const away = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.6, stage.y + stage.height * 0.4);
    await away();

    // ── 1. The Bar, a nub in the desk's trailing foot corner, over the windows there; the Stack in the dock, empty ─
    const bar = shell.getByTestId("desk-bar");
    const nub = shell.getByTestId("desk-nub");
    await expect(nub).toBeVisible();
    // The pill is the field and its buttons: it asks about the group by name.
    await expect(shell.getByTestId("desk-bar-input")).toHaveAttribute("placeholder", "Ask about Northstar…");
    // Idle, the pill is in the nub, which says what it is for (and the key that opens it) when the pointer rests on it.
    await expect(bar).toHaveAttribute("data-compact", "");
    await expect(nub).toHaveAttribute("aria-label", "Ask about Northstar");
    // (Its circle, the face's box, stands in the corner, a hair short of both edges; the hole is cut to the desk's curve.)
    const idle = await box(shell, '[data-testid="desk-nub"]');
    near(idle.x + idle.width, stage.x + stage.width - 2, 1);
    near(idle.y + idle.height, stage.y + stage.height - 2, 1);
    // A window reaching the desk's foot under it keeps its whole page: the nub lies over it, not cutting it.
    const entryPage = await box(shell, `${windowSelector(invoice)} [data-testid="desk-window-page"]`);
    if (entryPage.x + entryPage.width > idle.x - 20 && entryPage.y + entryPage.height > idle.y - 20) near(entryPage.y + entryPage.height, stage.y + stage.height - 5, 1);
    await capture(app, shell, "01a-desk-nub.png");
    // The pointer resting on it swells it, and its tooltip names the group and the key. It is the circle that grows, drawn
    // out of the corner as if pulled from it, clear of both edges — its joins to them tightening, reaching no further
    // along them (the hole's outline leaves the foot no further from the corner than it did).
    const footReach = () =>
      shell.locator(".desk-stage").evaluate((el) => {
        const found = /Z M (-?[\d.]+) /.exec((el as HTMLElement).style.getPropertyValue("--desk-notch-clip"));
        return found === null ? null : el.getBoundingClientRect().width - Number(found[1]);
      });
    const idleReach = (await footReach())!;
    await nub.hover();
    await expect(nub).toHaveAttribute("data-hovered", "");
    await expect.poll(async () => (await box(shell, '[data-testid="desk-nub"]')).width).toBeGreaterThan(idle.width + 6);
    await shell.waitForTimeout(400);
    const swelled = await box(shell, '[data-testid="desk-nub"]');
    expect(stage.x + stage.width - (swelled.x + swelled.width)).toBeGreaterThan(stage.x + stage.width - (idle.x + idle.width) + 2);
    expect(stage.y + stage.height - (swelled.y + swelled.height)).toBeGreaterThan(stage.y + stage.height - (idle.y + idle.height) + 2);
    expect(await footReach()).toBeLessThanOrEqual(idleReach + 0.5);
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]')).toHaveText(/^Ask about Northstar/);
    // A click lets out its menu: the nub lets go of the desk's edges — a button of its own, its close, clear of the foot
    // and the trailing edge, nothing of it cut into the corner any more — and three droplets as round as it fan out of
    // it over the desk's quarter: the prompt along the foot, the microphone between, past chats up the trailing edge.
    await nub.click();
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(1);
    await expect(nub).toHaveAttribute("aria-expanded", "true");
    const droplet = (id: string) => shell.getByTestId(id);
    await expect.poll(() => droplet("desk-nub-chats").evaluate((el) => (el as HTMLElement).style.transform)).toBe("");
    // (Once it has come to rest: it goes a little past where it stands free, and back.)
    await expect.poll(async () => Math.abs((await box(shell, '[data-testid="desk-nub"]')).x + 40 - (stage.x + stage.width - 8)) < 1).toBe(true);
    const free = await box(shell, '[data-testid="desk-nub"]');
    near(free.width, 40, 1);
    near(free.x + free.width, stage.x + stage.width - 8, 1);
    near(free.y + free.height, stage.y + stage.height - 8, 1);
    expect(await shell.locator(".desk-stage").evaluate((el) => (el as HTMLElement).style.getPropertyValue("--desk-notch-clip"))).toBe("");
    // Its close is centred on it — on the circle as it is drawn (in the corner, its mark sits a little up and in, where
    // the circle shows).
    const mark = await box(shell, '[data-testid="desk-nub"] .desk-nub-close');
    const drawn = await shell.locator('[data-testid="desk-nub-box"] .desk-nub-paint svg').evaluate((svg) => {
      const circle = svg.querySelectorAll("g > circle")[1]!;
      const rect = svg.getBoundingClientRect();
      return { x: rect.right + Number(circle.getAttribute("cx")), y: rect.bottom + Number(circle.getAttribute("cy")), r: Number(circle.getAttribute("r")) };
    });
    near(drawn.x, free.x + free.width / 2, 0.5);
    near(drawn.y, free.y + free.height / 2, 0.5);
    near(drawn.r * 2, free.width, 0.5);
    near(mark.x + mark.width / 2, drawn.x, 0.5);
    near(mark.y + mark.height / 2, drawn.y, 0.5);
    const centreOf = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    const hub = centreOf(free);
    const [prompt, mic, chats] = (await Promise.all(["desk-nub-prompt", "desk-nub-mic", "desk-nub-chats"].map((id) => box(shell, `[data-testid="${id}"]`)))) as [Box, Box, Box];
    for (const drop of [prompt, mic, chats]) {
      near(drop.width, free.width, 1);
      near(Math.hypot(centreOf(drop).x - hub.x, centreOf(drop).y - hub.y), 70, 1.5);
    }
    near(centreOf(prompt).y, hub.y, 1);
    near(centreOf(chats).x, hub.x, 1);
    expect(centreOf(mic).x).toBeLessThan(hub.x);
    expect(centreOf(mic).y).toBeLessThan(hub.y);
    await droplet("desk-nub-mic").hover();
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]')).toHaveText("Dictate");
    await capture(app, shell, "01b-desk-nub-menu.png");
    // Escape puts them back into the nub.
    await shell.keyboard.press("Escape");
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(0);
    await expect(nub).toHaveAttribute("aria-expanded", "false");
    // From the keys: Enter on the nub lets the menu out with the keys on its first droplet, the arrows go up and down
    // the column, and Escape puts it back with the keys on the nub.
    await nub.focus();
    await shell.keyboard.press("Enter");
    await expect(droplet("desk-nub-prompt")).toBeFocused();
    await shell.keyboard.press("ArrowUp");
    await expect(droplet("desk-nub-mic")).toBeFocused();
    await shell.keyboard.press("Escape");
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(0);
    await expect(nub).toBeFocused();
    await nub.blur();
    // Escape is for what is in front: the address bar opened over the menu goes first, and the menu after it.
    await nub.click();
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(1);
    await shell.keyboard.press("Meta+L");
    await expect(shell.getByTestId("address-input")).toBeFocused();
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(1);
    await shell.keyboard.press("Escape");
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(0);
    // The keyboard left on another of the shell's controls (the sidebar's menu button), the menu and the conversations
    // let out with the pointer: an Escape nothing else takes still puts them back, the conversations first.
    const elsewhere = shell.getByTestId("sidebar-menu-button");
    await elsewhere.focus();
    await nub.click();
    await droplet("desk-nub-chats").click();
    await expect(shell.locator('[data-testid="desk-conversations"]')).toHaveCount(1);
    await expect(elsewhere).toBeFocused();
    // (The other droplets, run back into the nub out of the conversations' way, are out of the keys' reach too.)
    for (const id of ["desk-nub-prompt", "desk-nub-mic"]) {
      await droplet(id).focus();
      await expect(droplet(id)).not.toBeFocused();
    }
    await elsewhere.focus();
    await shell.keyboard.press("Escape");
    await expect(shell.locator('[data-testid="desk-conversations"]')).toHaveCount(0);
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(1);
    await shell.keyboard.press("Escape");
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(0);
    await elsewhere.blur();
    // ⌘I with the conversations out: the pill, the keyboard in its field — the conversations go in with the menu.
    await nub.click();
    await droplet("desk-nub-chats").click();
    await expect(shell.locator('[data-testid="desk-conversations"]')).toHaveCount(1);
    await shell.keyboard.press("Meta+i");
    await expect(shell.getByTestId("desk-bar-input")).toBeFocused();
    await expect(shell.locator('[data-testid="desk-conversations"]')).toHaveCount(0);
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(0);
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    // With reduced motion the other droplets do not run back into the nub out of the conversations' way: they are gone
    // while the conversations are up (out of reach, so not to be seen either), and back once they are put away.
    await shell.emulateMedia({ reducedMotion: "reduce" });
    const opacityOf = (id: string) => droplet(id).evaluate((el) => getComputedStyle(el).opacity);
    await nub.click();
    await droplet("desk-nub-chats").click();
    await expect(shell.locator('[data-testid="desk-conversations"]')).toHaveCount(1);
    for (const id of ["desk-nub-prompt", "desk-nub-mic"]) await expect.poll(() => opacityOf(id)).toBe("0");
    await shell.keyboard.press("Escape");
    await expect(shell.locator('[data-testid="desk-conversations"]')).toHaveCount(0);
    for (const id of ["desk-nub-prompt", "desk-nub-mic"]) await expect.poll(() => opacityOf(id)).toBe("1");
    await shell.keyboard.press("Escape");
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(0);
    await shell.emulateMedia({ reducedMotion: null });
    // The prompt's droplet: the pill, out of it at the desk's foot beside the nub, as tall as the Bar was before the nub,
    // the keyboard in its field, its words a little larger than the page's chrome.
    await reachBar(shell);
    await expect(shell.getByTestId("desk-bar-input")).toBeFocused();
    const pill = await box(shell, '[data-testid="desk-bar"]');
    near(pill.height, 52, 1);
    expect(await shell.getByTestId("desk-bar-input").evaluate((el) => getComputedStyle(el).fontSize)).toBe("15px");
    near(pill.y + pill.height, stage.y + stage.height - 8, 1);
    near(pill.x + pill.width, stage.x + stage.width - 54, 1);
    // Its close stands above the nub while it is out, small, where the menu's droplets once stood in a column. A pill
    // holding something stays out when the keyboard leaves it; its close puts it away all the same — and what was typed
    // is there when it comes out again.
    const close = shell.getByTestId("desk-bar-close");
    await expect(close).toHaveAttribute("data-shown", "");
    await expect.poll(async () => Math.round((await box(shell, '[data-testid="desk-bar-close"]')).width)).toBe(32);
    const closeBox = await box(shell, '[data-testid="desk-bar-close"]');
    near(closeBox.x + closeBox.width / 2, stage.x + stage.width - 22, 1);
    const closeMark = await box(shell, '[data-testid="desk-bar-close"] svg');
    near(closeMark.x + closeMark.width / 2, closeBox.x + closeBox.width / 2, 0.5);
    near(closeMark.y + closeMark.height / 2, closeBox.y + closeBox.height / 2, 0.5);
    expect(closeBox.y + closeBox.height).toBeLessThan(idle.y);
    await shell.getByTestId("desk-bar-input").fill("A draft to keep");
    await shell.getByTestId("desk-bar-input").blur();
    await shell.waitForTimeout(400);
    await expect(shell.getByTestId("desk-bar")).not.toHaveAttribute("data-compact", "");
    await close.click();
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    await expect(close).not.toHaveAttribute("data-shown", "");
    await reachBar(shell);
    await expect(shell.getByTestId("desk-bar-input")).toHaveValue("A draft to keep");
    await expect(close).toHaveAttribute("data-shown", "");
    await shell.getByTestId("desk-bar-input").fill("");
    await expect(shell.getByTestId("desk-bar-input")).toBeFocused();
    // The pill and the menu are one or the other, never both: the nub pressed with the pill out puts the pill away (what
    // is typed in it kept, as its close keeps it) and lets out the menu; the prompt's droplet brings the pill back, the
    // menu going in.
    await shell.getByTestId("desk-bar-input").fill("Still here");
    await nub.click();
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(1);
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    await expect(shell.getByTestId("desk-bar-close")).not.toHaveAttribute("data-shown", "");
    await expect(shell.getByTestId("desk-bar-input")).not.toBeFocused();
    await droplet("desk-nub-prompt").click();
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(0);
    await expect(shell.getByTestId("desk-bar")).not.toHaveAttribute("data-compact", "");
    await expect(shell.getByTestId("desk-bar-input")).toHaveValue("Still here");
    await shell.getByTestId("desk-bar-input").fill("");
    await expect(shell.getByTestId("desk-bar-input")).toBeFocused();
    // The tray at the field's leading end: its plus, under the pointer, lets out attach and a new conversation,
    // turning into its close and sliding the field aside; its tools out of reach while it is shut.
    const tray = shell.getByTestId("desk-bar-tray");
    const more = shell.getByTestId("desk-bar-more");
    await expect(tray).not.toHaveAttribute("data-open", "");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    expect(await shell.locator(".desk-bar-tray-items").evaluate((el) => [el.getBoundingClientRect().width, (el as HTMLElement).inert])).toEqual([0, true]);
    const fieldShut = await box(shell, '[data-testid="desk-bar-input"]');
    await more.hover();
    await expect(tray).toHaveAttribute("data-open", "");
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect.poll(async () => (await box(shell, '[data-testid="desk-bar-input"]')).x).toBeGreaterThan(fieldShut.x + 50);
    await expect.poll(() => more.locator("svg").evaluate((el) => getComputedStyle(el).rotate)).toBe("45deg");
    await capture(app, shell, "01c-desk-bar-tray.png");
    // Every button says what it does.
    await shell.getByTestId("desk-bar-attach").hover();
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]')).toHaveText("Attach files");
    await capture(app, shell, "01d-desk-bar-tooltip.png");
    await shell.getByTestId("desk-bar-new-conversation").hover();
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]', { hasText: "New conversation" })).toBeVisible();
    await shell.getByTestId("desk-bar-send").hover();
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]', { hasText: "Send" })).toBeVisible();
    // Off it, the tray goes back, and the field with it.
    await expect(tray).not.toHaveAttribute("data-open", "");
    await expect.poll(async () => (await box(shell, '[data-testid="desk-bar-input"]')).x).toBeLessThan(fieldShut.x + 2);
    await away();
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]')).toHaveCount(0);
    await capture(app, shell, "01-desk-bar.png");
    // Escape with nothing in it: the pill goes back into the nub.
    await shell.getByTestId("desk-bar-input").focus();
    await shell.keyboard.press("Escape");
    await expect(bar).toHaveAttribute("data-compact", "");
    await expect(shell.getByTestId("desk-stack")).toHaveAttribute("data-count", "0");

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
    // With reduced motion, the docked answer is there at once: no reveal out of the pill, overshoot and all.
    await shell.emulateMedia({ reducedMotion: "reduce" });
    const revealMs = await shell
      .locator('[data-testid="desk-answer"][data-shown] .desk-answer-vis')
      .evaluate((el) => Math.max(...getComputedStyle(el).transitionDuration.split(",").map((value) => Number.parseFloat(value) * 1000)));
    expect(revealMs).toBe(0);
    await shell.emulateMedia({ reducedMotion: null });

    // The answer rests on the pill, as wide as it, however tall the pill grows; it collapses with a chevron.
    const card = await box(shell, '[data-testid="desk-answer"]');
    const barNow = await box(shell, '[data-testid="desk-bar"]');
    near(card.width, barNow.width, 1);
    near(card.x, barNow.x, 1);
    // Out of the pill, nothing is left clipping it: a clip would make it a backdrop root, its glass blurring nothing.
    await expect.poll(() => shell.locator('[data-testid="desk-answer"] .desk-answer-vis').evaluate((el) => getComputedStyle(el).clipPath)).toBe("none");
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
    // The pill wears the answer's fill.
    const fills = await shell.evaluate(() => [getComputedStyle(document.querySelector('[data-testid="desk-answer"] .desk-answer-frame')!).backgroundColor, getComputedStyle(document.querySelector('[data-testid="desk-bar"] .desk-bar-frame')!).backgroundColor]);
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
    // (The width it was docked at, the pill's: it keeps it torn off.)
    near(floating.width, 480, 4);
    // The nub says it is out on the desk.
    await expect(shell.getByTestId("desk-nub")).toHaveAttribute("data-floating", "");
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

    // ── 9. The conversations, grown out of the nub's past-chats droplet: this desk's, marked; a new one starts empty ─
    await openChats(shell);
    await expect(shell.getByTestId("desk-nub-chats")).toHaveAttribute("aria-expanded", "true");
    await expect(shell.getByTestId("desk-conversation")).toHaveCount(1);
    await expect(shell.getByTestId("desk-conversation").first()).toContainText("This space");
    // Rows, as the mentions' are: New conversation first; no heading.
    await expect(shell.getByTestId("desk-conversations")).not.toContainText("Conversations");
    await expect(shell.getByTestId("desk-conversation-new")).toHaveText("New conversation");
    await expect(shell.getByTestId("desk-conversation").first()).toHaveAttribute("aria-current", "true");
    await capture(app, shell, "06-desk-conversations.png");
    // The pill is away while they are out (the pill and the menu are one or the other). A press anywhere else puts them
    // away, and the menu with them: in the shell…
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    await shell.locator("body").click({ position: { x: 5, y: 5 } });
    await expect(shell.getByTestId("desk-conversations")).toHaveCount(0);
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(0);
    // …or in a live page, which main relays.
    await openChats(shell);
    await app.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      contents.sendInputEvent({ type: "mouseMove", x: 420, y: 24 });
      contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: 420, y: 24 });
      await new Promise((done) => setTimeout(done, 40));
      contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: 420, y: 24 });
    }, ACCOUNTS);
    await expect(shell.getByTestId("desk-conversations")).toHaveCount(0);
    // Escape unwinds one at a time: the conversations back into their droplet, then the droplets into the nub.
    await openChats(shell);
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("desk-conversations")).toHaveCount(0);
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(1);
    await shell.keyboard.press("Escape");
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(0);
    // The nub itself puts both away.
    await openChats(shell);
    await shell.getByTestId("desk-nub").click();
    await expect(shell.getByTestId("desk-conversations")).toHaveCount(0);
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(0);
    await openChats(shell);
    const runId = run.runId;
    await shell.getByTestId("desk-conversation-new").click();
    await expect.poll(async () => (await snapshot(shell)).run).toBeNull();
    await expect(shell.getByTestId("desk-answer")).toHaveCount(0);
    // And the earlier one is still there to continue here.
    await openChats(shell);
    await shell.locator(`[data-testid="desk-conversation"][data-run-id="${runId}"]`).click();
    await expect.poll(async () => (await snapshot(shell)).run?.runId).toBe(runId);
    // Chosen, it opens on its messages — the person sees they are in another thread — and the picker goes.
    await expect(shell.locator('[data-testid="desk-answer"][data-shown]')).toHaveCount(1);
    await expect(shell.getByTestId("desk-answer")).toContainText("Opened the vendor record from the invoice");
    await expect(shell.getByTestId("desk-conversations")).toHaveCount(0);
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(0);
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
