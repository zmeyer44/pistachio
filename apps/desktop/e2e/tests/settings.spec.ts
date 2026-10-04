import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { IPC } from "@pistachio/shell-contracts/ipc";
import { sidebarMenuItem } from "./footer";
import { shellReady } from "./windows";
import { launchApp } from "./app";
import { captureShell as captureWindow, capturePage } from "./pages-harness";

/** The settings page lives in the chrome, so the shell capture is the whole picture — once its 140ms fade-in settles. */
function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  return captureWindow(app, `settings/${filename}`, 400);
}

/**
 * Keep the iMessage link a renderer-to-main E2E without reaching a real
 * phone: the main process owns a tiny BlueBubbles/control test double, while
 * the production preload bridge and every settings component remain real.
 */
async function installIMessageFixture(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, channels) => {
      const installed = Object.values(channels);
      for (const channel of installed) ipcMain.removeHandler(channel);

      let status = { available: true, linked: false, phone: null as string | null, verifiedAt: null as string | null };
      let challengeId: string | null = null;

      ipcMain.handle(channels.accountGet, () => ({
        state: "enrolled",
        email: "messages@example.test",
        userId: "e2e-user",
        deviceId: "e2e-device",
        deviceName: "Test Mac",
        controlUrl: "https://control.example.test",
        encryptionAvailable: true,
        cloudDevicePin: null,
        cloudDeviceChanged: null,
        revoked: false,
        hubUrl: null,
        cloudBrowserUrl: null,
        error: null,
      }));
      ipcMain.handle(channels.imessageGet, () => status);
      ipcMain.handle(channels.imessageStart, (_event, phone: unknown) => {
        if (phone !== "+1 212 555 0123") throw new Error("invalid_phone");
        challengeId = "e2e-challenge";
        return { challengeId, phone: "••• ••• 0123", expiresAt: new Date(Date.now() + 600_000).toISOString() };
      });
      ipcMain.handle(channels.imessageVerify, (_event, suppliedId: unknown, code: unknown) => {
        if (suppliedId !== challengeId || code !== "123456") throw new Error("invalid_code");
        status = {
          available: true,
          linked: true,
          phone: "••• ••• 0123",
          verifiedAt: new Date().toISOString(),
        };
        return status;
      });
      ipcMain.handle(channels.imessageUnlink, () => {
        status = { available: true, linked: false, phone: null, verifiedAt: null };
        challengeId = null;
        return status;
      });
    },
    {
      accountGet: IPC.accountGet,
      imessageGet: IPC.imessageGet,
      imessageStart: IPC.imessageStart,
      imessageVerify: IPC.imessageVerify,
      imessageUnlink: IPC.imessageUnlink,
    },
  );
}

// One window, signed out and with no update feed (a dev run's): every
// section, then About's word on updates, then — the account answered by a
// test double — the iMessage link.
test.describe.serial("Settings", { tag: ["@settings"] }, () => {
  test.describe.configure({ timeout: 60_000 });
  let app: ElectronApplication;
  let userData: string;
  let shell: Page;

  test.beforeAll(async () => {
    ({ app, userData } = await launchApp({ env: { PISTACHIO_UPDATE_FEED: "" }, name: "settings" }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("settings open with ⌘,, every section renders, and a change persists to disk", { tag: ["@smoke"] }, async () => {
    await shell.keyboard.press("Meta+,");
    const page = shell.getByTestId("settings-page");
    await expect(page).toBeVisible();
    await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
    await captureShell(app, "01-general.png");

    const visit = async (sections: ReadonlyArray<readonly [label: string, file: string]>) => {
      for (const [label, file] of sections) {
        await page.getByRole("button", { name: label, exact: true }).click();
        await captureShell(app, file);
      }
    };
    await visit([
      ["Appearance", "02-appearance.png"],
      ["Shortcuts", "06-shortcuts.png"],
      ["About", "07-about.png"],
    ]);
    // Agent is a nav group: selecting it pushes its menu and lands on the
    // delegation page, which is titled "Agent" (SETTINGS_SECTIONS); Approvals
    // and Evidence are rows of that menu.
    await visit([
      ["Agent", "02-delegation.png"],
      ["Approvals", "03-approvals.png"],
      ["Evidence", "04-evidence.png"],
    ]);
    await page.getByTestId("settings-menu-delegation").getByRole("button", { name: /^Back to all settings/ }).click();
    // The identity pages (docs/cloud-sync-design.md §10.6). Under
    // PISTACHIO_E2E=1 nothing dials control, so every one of them renders
    // its signed-out state from the store's .catch() defaults — which is
    // exactly the state that must never hang the shell. Account is a nav
    // group too, and the rest are rows of its menu.
    await visit([
      ["Account", "08-account.png"],
      ["Devices", "09-devices.png"],
      ["Sync", "10-sync.png"],
      ["Cloud browser", "11-cloud.png"],
      ["Identity egress", "12-egress.png"],
    ]);

    // With no account and no control plane, the identity pages still render
    // their signed-out state rather than waiting on a getter that will never
    // answer: the sign-in form is there, and sync reads Off.
    await page.getByRole("button", { name: "Account", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
    await expect(page.getByTestId("account-submit")).toBeVisible();
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(page.getByTestId("sync-state")).toHaveText("Off");
    // The cloud browser is unavailable and the gateway is off, and both pages
    // say so rather than showing a control that could only fail.
    await page.getByRole("button", { name: "Cloud browser", exact: true }).click();
    await expect(page.getByTestId("cloud-available")).toHaveText("Unavailable");
    await expect(page.getByTestId("channel-create")).toBeDisabled();
    await page.getByRole("button", { name: "Identity egress", exact: true }).click();
    await expect(page.getByTestId("egress-health")).toHaveText("Off");
    await expect(page.getByTestId("egress-gateway")).toHaveText("No gateway assigned");

    // The identity pages' flat addresses still open the Account menu, and its
    // back control returns to the root, where Account reads as active.
    const accountMenu = page.getByTestId("settings-menu-account");
    await expect(accountMenu.getByRole("button", { name: "Identity egress", exact: true })).toHaveAttribute("aria-current", "page");
    await accountMenu.getByRole("button", { name: /^Back to all settings/ }).click();
    await expect(page.getByTestId("settings-menu-root").getByRole("button", { name: "Account", exact: true })).toHaveClass(/shadow-small/);

    // NESTED NAV. Privacy & security is a group: selecting it pushes its own
    // menu over the root and lands on the first sub-page.
    await page.getByRole("button", { name: "Privacy & security", exact: true }).click();
    const privacyMenu = page.getByTestId("settings-menu-privacy");
    await expect(privacyMenu).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ads & trackers" })).toBeVisible();
    // The outgoing root menu is gone once the push settles.
    await expect(page.getByTestId("settings-menu-root")).toHaveCount(0);
    await captureShell(app, "05a-privacy-menu.png");

    // Sub-pages route within the group without leaving its menu.
    await privacyMenu.getByRole("button", { name: "Spaces", exact: true }).click();
    // The page's own title; the section below it heads "Your Spaces".
    await expect(page.getByRole("heading", { name: "Spaces", exact: true })).toBeVisible();
    await expect(privacyMenu.getByRole("button", { name: "Spaces", exact: true })).toHaveAttribute("aria-current", "page");
    await captureShell(app, "05b-privacy-spaces.png");
    await privacyMenu.getByRole("button", { name: "Agent isolation", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Agent isolation" })).toBeVisible();
    await captureShell(app, "05c-privacy-isolation.png");

    // Back steps up a level WITHOUT navigating: the page stays put, the root
    // menu returns, and the group row reads as active because it owns the
    // section being shown.
    await privacyMenu.getByRole("button", { name: /^Back to all settings/ }).click();
    const root = page.getByTestId("settings-menu-root");
    await expect(root).toBeVisible();
    await expect(page.getByTestId("settings-menu-privacy")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Agent isolation" })).toBeVisible();
    await expect(root.getByRole("button", { name: "Privacy & security", exact: true })).toHaveClass(/shadow-small/);
    await captureShell(app, "05d-privacy-back.png");

    // Closed on a sub-page, Settings reopens at its root, not where it was left.
    await shell.keyboard.press("Escape");
    await expect(page).toBeHidden();
    // Settings now lives in the active layout's chrome: a row of the sidebar footer's menu.
    await (await sidebarMenuItem(shell, "settings-button")).click();
    await expect(page).toBeVisible();
    await expect(page.getByTestId("settings-menu-root")).toBeVisible();
    await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
    await captureShell(app, "05e-settings-button.png");

    // Flip a switch and confirm main wrote it, sanitized, to the file. The
    // Agent page's per-action grants are not the subject any more: it now
    // states outright that per-action controls are planned, so General's own
    // window switch is the one live toggle that lands in settings.json.
    const consoleOnLaunch = page.getByRole("switch", { name: "Open the agent chat on launch" });
    await expect(consoleOnLaunch).toHaveAttribute("aria-checked", "false");
    await consoleOnLaunch.click();
    await expect(consoleOnLaunch).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(async () => {
        try {
          const raw = await readFile(join(userData, "settings.json"), "utf8");
          return (JSON.parse(raw) as { general: { consoleOpenOnLaunch: boolean } }).general.consoleOpenOnLaunch;
        } catch {
          return null;
        }
      })
      .toBe(true);

    // ⌘I opens that same console now, without waiting for a relaunch.
    await shell.keyboard.press("Escape");
    await expect(page).toBeHidden();
    await shell.keyboard.press("Meta+i");
    await expect(shell.getByTestId("agent-panel")).toBeVisible();
  });

  test("a dev run without a feed says updates are for the installed app", async () => {
    await expect(shell.getByTestId("update-pill")).toHaveCount(0);
    await shell.keyboard.press("Meta+,");
    const page = shell.getByTestId("settings-page");
    await page.getByRole("button", { name: "About", exact: true }).click();
    await expect(page.getByText("Updates apply to the installed app")).toBeVisible();
    await shell.keyboard.press("Escape");
    await expect(page).toBeHidden();
  });

  test("a person links an iMessage number from Settings", async () => {
    await installIMessageFixture(app);
    await shell.reload();
    shell = await shellReady(app);
    await shell.bringToFront();

    await (await sidebarMenuItem(shell, "settings-button")).click();
    const settings = shell.getByTestId("settings-page");
    await settings.getByRole("button", { name: "Account", exact: true }).click();
    const phone = settings.getByTestId("imessage-phone");
    await phone.scrollIntoViewIfNeeded();
    await expect(phone).toBeVisible();
    await capturePage(shell, "imessage-settings/01-phone-entry.png", { fullPage: true, settleMs: 250 });

    await phone.fill("+1 212 555 0123");
    await capturePage(shell, "imessage-settings/02-phone-filled.png", { fullPage: true, settleMs: 250 });
    await settings.getByRole("button", { name: "Send code", exact: true }).click();

    const code = settings.getByTestId("imessage-code");
    await expect(code).toBeVisible();
    await code.fill("123456");
    await capturePage(shell, "imessage-settings/03-code-entry.png", { fullPage: true, settleMs: 250 });
    await settings.getByRole("button", { name: "Verify number", exact: true }).click();

    const linked = settings.getByTestId("imessage-linked-phone");
    await expect(linked).toHaveText("••• ••• 0123");
    await expect(settings.getByText("Replies answer the newest pending agent question.", { exact: false })).toBeVisible();
    await capturePage(shell, "imessage-settings/04-connected.png", { fullPage: true, settleMs: 250 });
  });
});
