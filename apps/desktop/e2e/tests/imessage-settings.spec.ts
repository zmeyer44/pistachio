import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { IPC } from "@pistachio/shell-contracts/ipc";
import { sidebarMenuItem } from "./footer";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/imessage-settings");

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find(
    (candidate) =>
      candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function capture(page: Page, filename: string): Promise<void> {
  await new Promise((done) => setTimeout(done, 250));
  await page.screenshot({ path: join(screenshotDirectory, filename), fullPage: true });
}

async function appShell(app: ElectronApplication): Promise<Page> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    for (const page of app.windows()) {
      try {
        const url = new URL(page.url());
        if (url.protocol === "file:" && url.hash === "") return page;
      } catch {
        // A WebContents may be between navigations; inspect it again below.
      }
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Pistachio shell was not found; open pages: ${app.windows().map((page) => page.url()).join(", ")}`);
}

/**
 * Keep this a renderer-to-main E2E without reaching a real phone: the main
 * process owns a tiny BlueBubbles/control test double, while the production
 * preload bridge and every settings component remain real.
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

test("a person links an iMessage number from Settings", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-imessage-settings-"));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });

  try {
    const shell = await appShell(app);
    await shell.waitForLoadState("domcontentloaded");
    await installIMessageFixture(app);
    await shell.reload();
    await shell.waitForLoadState("domcontentloaded");
    await shell.bringToFront();
    await mkdir(screenshotDirectory, { recursive: true });

    await (await sidebarMenuItem(shell, "settings-button")).click();
    const settings = shell.getByTestId("settings-page");
    await settings.getByRole("button", { name: "Account", exact: true }).click();
    const phone = settings.getByTestId("imessage-phone");
    await phone.scrollIntoViewIfNeeded();
    await expect(phone).toBeVisible();
    await capture(shell, "01-phone-entry.png");

    await phone.fill("+1 212 555 0123");
    await capture(shell, "02-phone-filled.png");
    await settings.getByRole("button", { name: "Send code", exact: true }).click();

    const code = settings.getByTestId("imessage-code");
    await expect(code).toBeVisible();
    await code.fill("123456");
    await capture(shell, "03-code-entry.png");
    await settings.getByRole("button", { name: "Verify number", exact: true }).click();

    const linked = settings.getByTestId("imessage-linked-phone");
    await expect(linked).toHaveText("••• ••• 0123");
    await expect(settings.getByText("Replies answer the newest pending agent question.", { exact: false })).toBeVisible();
    await capture(shell, "04-connected.png");
  } finally {
    await app.close();
  }
});
