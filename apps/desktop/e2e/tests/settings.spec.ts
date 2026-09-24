import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { sidebarMenuItem } from "./footer";
import { shellReady } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/settings");

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", executableSuffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", executableSuffix),
  ];
  return candidates.find(
    (candidate) =>
      candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

/** The settings page lives in the chrome, so the shell capture is the whole picture. */
async function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  // Let the page's 140ms fade-in settle first.
  await new Promise((done) => setTimeout(done, 400));
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

test("settings open with ⌘,, every section renders, and a change persists to disk", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-settings-"));

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellReady(app);

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
    await expect(page.getByRole("heading", { name: "Site data" })).toBeVisible();
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

    // A deep link into the group's prefix opens its menu — the open menu is a
    // function of the address, not of click history.
    await page.getByRole("button", { name: "General", exact: true }).click();
    await expect(page.getByTestId("settings-menu-root")).toBeVisible();
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
  } finally {
    await app.close();
  }
});
