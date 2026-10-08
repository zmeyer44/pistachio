/**
 * The Bar's nub, state by state, for a person to look at (docs/desk-agent.md
 * §1): the idle nub in the desk's trailing foot corner over a live page and
 * over the bare well, swelled under the pointer, its menu out (and frames
 * of the goo as its droplets pinch off, the motion slowed), the pill out of
 * the prompt's droplet, typed into with an @mention, listening, the
 * conversations grown out of past chats' droplet (and a frame of that
 * morph), the answer docked on the pill and torn off — and some of it in
 * dark. Nothing here asserts on a picture: it writes them, at 2×, to
 * e2e/screenshots/desk-nub, and only when captureEnabled.
 */

import { expect, test } from "@playwright/test";
import { IPC } from "@pistachio/shell-contracts/ipc";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { captureEnabled } from "./app";
import { box, createGroup, INVOICES, launchDesk, openGroupDesk, openMore, openNubMenu, openTabs, openTray, reachBar, rowSelector, screenshots, selectTab, settled, VENDOR, windowSelector, type Box } from "./desk-harness";

const shots = screenshots("desk-nub", ["notch"]);

const ACCOUNTS = "pistachio://demo/auth/relying-party";

/** Three conversations' turns, the first with a step the answer shows. */
const SCRIPT = {
  steps: [
    { tools: [{ name: "page_inspect", input: { tabId: "{{tab:Atlas}}" } }] },
    { text: "Atlas Medical bills on **net 30**, so invoice NS-2048 falls due on **Oct 12**. The amount matches the purchase order, and nothing on the vendor record is overdue." },
    { text: "The connected accounts page lists two relying parties; neither has been used since August." },
    { text: "Your boarding pass is for BA 0490, seat 14C — the gate closes at 09:10." },
  ],
};

test.skip(!captureEnabled, "writes pictures only when PISTACHIO_E2E_CAPTURE=1");

test("the Bar's nub, state by state", { tag: ["@desk"] }, async () => {
  test.setTimeout(240_000);
  const { app, shell } = await launchDesk({
    name: "nub-capture",
    chrome: "drawer",
    args: ["--force-device-scale-factor=2", "--use-fake-device-for-media-stream"],
    env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify(SCRIPT) },
  });
  try {
    // The microphone's prompt would stop the spec; the synthetic device needs none, and nothing is transcribed.
    await app.evaluate(
      ({ ipcMain }, channels) => {
        ipcMain.removeHandler(channels.microphone);
        ipcMain.handle(channels.microphone, () => true);
        ipcMain.removeHandler(channels.speech);
        ipcMain.handle(channels.speech, () => "");
      },
      { microphone: IPC.microphoneRequest, speech: IPC.speechTranscribe },
    );
    const [invoice, vendor, accounts] = (await openTabs(shell, [INVOICES, VENDOR, ACCOUNTS])) as [string, string, string];
    await createGroup(shell, "nub", [invoice, vendor, accounts], "Northstar", "green");
    await selectTab(shell, invoice);
    await openGroupDesk(shell, "nub");
    await settled(shell, app);
    const stage = await box(shell, ".desk-stage");
    const away = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.4, stage.y + stage.height * 0.35);
    // All three out, tiled: a live page lies under the trailing foot corner.
    for (const tabId of [vendor, accounts]) {
      await shell.locator(rowSelector(tabId)).click();
      await expect(shell.locator(windowSelector(tabId))).toHaveCount(1);
    }
    await away();
    await settled(shell, app);
    await openMore(shell);
    await shell.getByTestId("desk-tile").click();
    await away();
    await settled(shell, app);
    await expect.poll(() => shell.evaluate(() => document.querySelectorAll('[data-testid="desk-window"]:not([data-drawn])').length)).toBe(3);
    // The trailing foot corner and enough of the desk around it; and the whole desk, for the pictures that need it.
    const corner: Box = { x: stage.x + stage.width - 620, y: stage.y + stage.height - 420, width: 640, height: 440 };
    const near: Box = { x: stage.x + stage.width - 300, y: stage.y + stage.height - 240, width: 320, height: 260 };
    const whole: Box = { x: stage.x - 12, y: stage.y - 12, width: stage.width + 24, height: stage.height + 24 };
    const nub = shell.getByTestId("desk-nub");
    const slow = (scale: number): Promise<void> => shell.evaluate((value) => document.documentElement.style.setProperty("--desk-nub-time-scale", String(value)), scale);

    // A file in the group's context, to @mention.
    const transfer = await shell.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(["Boarding pass BA 0490, seat 14C, gate closes 09:10"], "boarding-pass.txt", { type: "text/plain" }));
      return data;
    });
    for (const type of ["dragenter", "dragover", "drop"]) await shell.dispatchEvent('[data-testid="desk-stack"]', type, { dataTransfer: transfer });
    await expect(shell.getByTestId("desk-stack")).toHaveAttribute("data-count", "1");
    await away();
    await settled(shell, app);

    // ── 01. Idle, a live page under the corner: main's notch view draws the nub over it ─
    await expect(nub).not.toHaveAttribute("data-hovered", "");
    await shots(app, shell, "01-idle.png", 600, corner);
    await shots(app, shell, "01b-idle-near.png", 200, near);

    // ── 03. The pointer resting on it: it swells, and lifts a little out of the corner ─
    await nub.hover();
    await expect(nub).toHaveAttribute("data-hovered", "");
    await shots(app, shell, "03-hover.png", 600, near);

    // ── 04, 05. A click: the droplets pinch off up the trailing edge (slowed, frames of the goo on the way) ─
    await slow(14);
    await nub.click();
    const t0 = Date.now();
    for (const [i, at] of [
      [1, 1_300],
      [2, 2_100],
      [3, 2_900],
      [4, 4_000],
    ] as const) {
      await shell.waitForTimeout(Math.max(0, at - (Date.now() - t0)));
      await shots(app, shell, `05-menu-mid-${String(i)}.png`, 0, near);
    }
    await slow(1);
    await nub.click();
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(0);
    await shell.waitForTimeout(600);
    await openNubMenu(shell);
    await shell.getByTestId("desk-nub-chats").hover();
    await expect(shell.locator('[data-testid="desk-bar-tip"][data-shown]')).toHaveText("Past chats");
    await shots(app, shell, "04-menu-open.png", 500, corner);

    // ── 06. The prompt's droplet: the pill, out of it, at the foot beside the nub (and a frame of it on its way, the
    // bridge to the nub not yet let go) ─
    await shell.getByTestId("desk-nub-chats").hover();
    await slow(12);
    await shell.getByTestId("desk-nub-prompt").click();
    await shell.waitForTimeout(450);
    await shots(app, shell, "06b-input-mid.png", 0, corner);
    await shell.waitForTimeout(300);
    await shots(app, shell, "06c-input-mid.png", 0, corner);
    await slow(1);
    await shell.waitForTimeout(5_000);
    await expect(shell.getByTestId("desk-bar")).not.toHaveAttribute("data-compact", "");
    await expect(shell.getByTestId("desk-bar-input")).toBeFocused();
    await shell.mouse.move(stage.x + stage.width - 300, stage.y + stage.height - 160);
    await shots(app, shell, "06-input.png", 700, corner);

    // ── 07. Typed into, a file of the context @mentioned ─
    const input = shell.getByTestId("desk-bar-input");
    await input.pressSequentially("Compare the invoice with @bo");
    await expect(shell.locator('[data-testid="desk-mentions"][data-shown]')).toHaveCount(1);
    await shots(app, shell, "07b-input-mention-menu.png", 400, corner);
    await input.press("Enter");
    await input.pressSequentially("— is anything due this week?");
    await expect(shell.locator(".desk-bar-mention")).toHaveText("@boarding-pass.txt");
    await shots(app, shell, "07-input-typed.png", 400, corner);
    await input.fill("");
    await input.blur();
    await away();
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    await shell.waitForTimeout(500);

    // ── 08. The microphone's droplet: the same pill, already listening ─
    await openNubMenu(shell);
    await shell.getByTestId("desk-nub-mic").click();
    await expect(shell.getByTestId("desk-bar-dictation")).toHaveAttribute("data-phase", "recording");
    await expect.poll(() => shell.locator(".desk-bar-wave > span").evaluateAll((bars) => Math.max(0, ...bars.map((bar) => bar.getBoundingClientRect().height))), { timeout: 5_000 }).toBeGreaterThan(6);
    await shell.waitForTimeout(1_200);
    await shots(app, shell, "08-dictation.png", 200, corner);
    await shell.getByTestId("desk-bar-dictation-discard").click();
    await expect(shell.getByTestId("desk-bar-input")).toBeVisible();

    // Three conversations: a turn in each.
    const ask = async (text: string, reply: string): Promise<void> => {
      await reachBar(shell);
      await input.fill(text);
      await input.press("Enter");
      await expect(shell.getByTestId("desk-answer")).toContainText(reply, { timeout: 15_000 });
    };
    await ask("When is the Atlas Medical invoice due?", "net 30");
    await openTray(shell);
    await shell.getByTestId("desk-bar-new-conversation").click();
    await expect(shell.getByTestId("desk-answer")).toHaveCount(0);
    await ask("Who can sign in with my accounts?", "two relying parties");
    await openTray(shell);
    await shell.getByTestId("desk-bar-new-conversation").click();
    await expect(shell.getByTestId("desk-answer")).toHaveCount(0);
    await ask("What's on my boarding pass?", "seat 14C");
    await shell.getByTestId("desk-surface").click({ position: { x: 4, y: 4 } });
    await away();
    await settled(shell, app);

    // ── 09, 10. Past chats' droplet grown into the conversations (and a frame of the morph, slowed) ─
    await openNubMenu(shell);
    await slow(10);
    await shell.getByTestId("desk-nub-chats").click();
    await shell.waitForTimeout(450);
    await shots(app, shell, "10-chats-mid.png", 0, corner);
    await slow(1);
    await expect(shell.locator('[data-testid="desk-conversations"][data-shown]')).toHaveCount(1);
    await expect(shell.getByTestId("desk-conversation")).toHaveCount(3);
    await shell.waitForTimeout(3_000);
    await shots(app, shell, "09-chats.png", 400, corner);

    // ── 11. The first conversation picked up: its answer docked on the pill ─
    await shell.getByTestId("desk-conversation").last().click();
    await expect(shell.locator('[data-testid="desk-answer"][data-shown]')).toHaveCount(1);
    await expect(shell.getByTestId("desk-answer")).toContainText("net 30");
    await shell.mouse.move(stage.x + stage.width - 300, stage.y + stage.height - 160);
    await shots(app, shell, "11-answer.png", 700, whole);

    // ── 12. Torn off by its header: a window of its own, floating; the nub says so ─
    const head = await box(shell, '[data-testid="desk-answer-head"]');
    const from = { x: head.x + 80, y: head.y + head.height / 2 };
    await shell.mouse.move(from.x, from.y);
    await shell.mouse.down();
    for (let i = 1; i <= 24; i += 1) {
      await shell.mouse.move(from.x - (420 * i) / 24, from.y - (200 * i) / 24);
      await shell.waitForTimeout(16);
    }
    await shell.mouse.up();
    await expect(shell.getByTestId("desk-answer")).toHaveAttribute("data-mode", "detached");
    await settled(shell, app);
    await away();
    await shots(app, shell, "12-answer-floating.png", 800, whole);
    await shell.getByTestId("desk-answer-dock").click();
    await expect(shell.getByTestId("desk-answer")).toHaveAttribute("data-mode", "docked");
    await shell.getByTestId("desk-surface").click({ position: { x: 4, y: 4 } });
    await expect(shell.getByTestId("desk-answer")).toHaveCount(0);
    await away();
    await settled(shell, app);

    // ── 13–15. Dark: idle, the pill, the menu ─
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.updateSettings({ appearance: { scheme: "dark" } }));
    await expect(shell.locator("html")).toHaveAttribute("data-color-scheme", "dark");
    await settled(shell, app);
    await shell.waitForTimeout(800);
    await shots(app, shell, "13-dark-idle.png", 600, corner);
    await reachBar(shell);
    await input.fill("Is anything else due this week?");
    await shell.mouse.move(stage.x + stage.width - 300, stage.y + stage.height - 160);
    await shots(app, shell, "14-dark-input.png", 700, corner);
    await input.fill("");
    await input.blur();
    await away();
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    await shell.waitForTimeout(500);
    await openNubMenu(shell);
    await shots(app, shell, "15-dark-menu.png", 600, near);
    await nub.click();
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.updateSettings({ appearance: { scheme: "light" } }));
    await expect(shell.locator("html")).toHaveAttribute("data-color-scheme", "light");
    await away();

    // ── 16, 17. The desktop glass off: the ground is the surface's own colour, the notch view's the same ─
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.updateSettings({ appearance: { desktopGlass: false } }));
    await expect(shell.locator("html")).toHaveAttribute("data-desktop-glass", "off");
    await settled(shell, app);
    await shots(app, shell, "16-glass-off-idle.png", 800, near);
    await openNubMenu(shell);
    await shots(app, shell, "17-glass-off-menu.png", 600, near);
    await nub.click();
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.updateSettings({ appearance: { desktopGlass: true } }));
    await away();

    // ── 02. No window under the corner: the nub is the hole, the shell's own ground ─
    for (const tabId of [invoice, vendor, accounts]) {
      const win = shell.locator(windowSelector(tabId));
      if ((await win.count()) === 0) continue;
      // (Its drawer's own button, pressed where it is folded away.)
      await win.getByTestId("desk-collapse").dispatchEvent("click");
      await expect(win).toHaveCount(0);
    }
    await away();
    await settled(shell, app);
    await shots(app, shell, "02-idle-bare-well.png", 600, corner);
    await nub.hover();
    await expect(nub).toHaveAttribute("data-hovered", "");
    await shots(app, shell, "02b-hover-bare-well.png", 600, near);
    await nub.click();
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(1);
    await shots(app, shell, "02c-menu-bare-well.png", 600, near);
  } finally {
    await app.close();
  }
});
