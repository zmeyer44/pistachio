import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findPage, shellReady } from "./windows";

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find((candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")));
}

test("managed site controls and native find are enforced across Chromium views", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-browser-basics-"));
  const passkeyServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Passkey test</title><h1>Passkey test</h1>");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    passkeyServer.once("error", rejectListen);
    passkeyServer.listen(0, "127.0.0.1", () => resolveListen());
  });
  const serverAddress = passkeyServer.address();
  if (serverAddress === null || typeof serverAddress === "string") throw new Error("Passkey test server did not bind a TCP port");
  const passkeyUrl = `http://localhost:${serverAddress.port}/`;
  await writeFile(
    join(userData, "enterprise-policy.json"),
    JSON.stringify({
      version: 1,
      rules: [
        {
          pattern: "pistachio://demo",
          permissions: { notifications: "block" },
          actions: { download: "block", copy: "block", print: "block" },
        },
      ],
    }),
  );
  // The window opens on the home page, and this spec's managed rules are
  // written for the demo site — so make the demo page the home page rather
  // than expecting a demo tab that launch no longer creates.
  await writeFile(join(userData, "settings.json"), JSON.stringify({ general: { homeUrl: "pistachio://demo/invoices" } }));

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellReady(app);

    const notificationResult = await app.evaluate(async ({ webContents }) => {
      const tab = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("pistachio://demo/invoices"));
      if (tab === undefined) throw new Error("Demo tab is unavailable");
      return tab.executeJavaScript("Notification.requestPermission()") as Promise<NotificationPermission>;
    });
    expect(notificationResult).toBe("denied");

    await shell.evaluate(async (url) => {
      const api = (window as unknown as { pistachio: { getSnapshot(): Promise<{ activeTabId: string | null }>; navigate(tabId: string, value: string): Promise<void> } })
        .pistachio;
      const snapshot = await api.getSnapshot();
      if (snapshot.activeTabId === null) throw new Error("No active tab");
      await api.navigate(snapshot.activeTabId, url);
    }, passkeyUrl);

    const passkeySetup = await app.evaluate(async ({ webContents }) => {
      const tab = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("http://localhost:"));
      if (tab === undefined) throw new Error("Passkey test tab is unavailable");
      let authenticatorId: string | null = null;
      let stage = "attach";
      try {
        tab.debugger.attach("1.3");
        stage = "enable";
        await tab.debugger.sendCommand("WebAuthn.enable");
        stage = "add authenticator";
        const added = (await tab.debugger.sendCommand("WebAuthn.addVirtualAuthenticator", {
          options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            automaticPresenceSimulation: true,
            isUserVerified: true,
          },
        })) as { authenticatorId: string };
        authenticatorId = added.authenticatorId;
        stage = "reload";
        await new Promise<void>((resolveLoad) => {
          tab.once("did-finish-load", () => resolveLoad());
          tab.reload();
        });
        tab.focus();
        stage = "create";
        return (await tab.executeJavaScript(
          `(async () => {
            try {
              const bytes = (text) => new TextEncoder().encode(text);
              const rpId = location.hostname;
              const create = (id, name, displayName, challenge) => navigator.credentials.create({
                publicKey: {
                  challenge: bytes(challenge),
                  rp: { id: rpId, name: "Pistachio Passkey Test" },
                  user: { id: bytes(id), name, displayName },
                  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                  authenticatorSelection: {
                    authenticatorAttachment: "platform",
                    residentKey: "required",
                    userVerification: "required"
                  },
                  timeout: 10000,
                  attestation: "none"
                }
              });
              const created = await create("e2e-user-1", "passkey@example.test", "Passkey Tester", "pistachio-create-1");
              await create("e2e-user-2", "backup@example.test", "Backup Account", "pistachio-create-2");
              globalThis.__pistachioPasskeyResult = navigator.credentials.get({
                publicKey: {
                  challenge: bytes("pistachio-get-challenge"),
                  rpId,
                  userVerification: "required",
                  timeout: 10000
                }
              }).then((assertion) => ({ assertionId: assertion?.id ?? null }))
                .catch((error) => ({ assertionId: null, error: error.name + ": " + error.message }));
              return {
                createdId: created?.id ?? null,
                platformAvailable: await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
              };
            } catch (error) {
              return {
                createdId: null,
                platformAvailable: false,
                authenticatorId: null,
                error: error.name + ": " + error.message + " (secure=" + isSecureContext + ", host=" + location.hostname + ")"
              };
            }
          })()`,
          true,
        ).then((result: { createdId: string | null; platformAvailable: boolean; error?: string }) => ({
          ...result,
          authenticatorId,
        }))) as { createdId: string | null; platformAvailable: boolean; authenticatorId: string | null; error?: string };
      } catch (error) {
        if (authenticatorId !== null) await tab.debugger.sendCommand("WebAuthn.removeVirtualAuthenticator", { authenticatorId }).catch(() => undefined);
        if (tab.debugger.isAttached()) tab.debugger.detach();
        return {
          createdId: null,
          platformAvailable: false,
          authenticatorId: null,
          error:
            typeof error === "object" && error !== null
              ? `${stage}: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`
              : `${stage}: ${String(error)}`,
        };
      }
    });
    expect(passkeySetup.error).toBeUndefined();
    expect(passkeySetup.createdId).not.toBeNull();
    expect(passkeySetup.platformAvailable).toBe(true);
    expect(passkeySetup.authenticatorId).not.toBeNull();

    // The request comes up as a dialog over the page, not the full Site
    // controls page; answering it hands the page straight back.
    const prompt = shell.getByTestId("permission-prompt");
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText("Choose a passkey for localhost");
    const chooser = prompt.getByTestId("passkey-account-chooser");
    await expect(chooser).toBeVisible();
    await expect(chooser).toContainText("Passkey Tester");
    await expect(chooser).toContainText("Backup Account");
    await chooser.getByText("Passkey Tester", { exact: true }).click();
    const passkeyResult = await app.evaluate(async ({ webContents }) => {
      const tab = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("http://localhost:"));
      if (tab === undefined) throw new Error("Passkey test tab is unavailable");
      return tab.executeJavaScript("globalThis.__pistachioPasskeyResult") as Promise<{ assertionId: string | null; error?: string }>;
    });
    expect(passkeyResult.error).toBeUndefined();
    expect(passkeyResult.assertionId).toBe(passkeySetup.createdId);
    // Answered, the dialog steps aside on its own: the page is back with
    // nothing to close.
    await expect(prompt).toHaveCount(0);
    await expect(shell.getByTestId("site-controls")).toHaveCount(0);
    await app.evaluate(async ({ webContents }, authenticatorId) => {
      const tab = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("http://localhost:"));
      if (tab === undefined || typeof authenticatorId !== "string") return;
      await tab.debugger.sendCommand("WebAuthn.removeVirtualAuthenticator", { authenticatorId }).catch(() => undefined);
      await tab.debugger.sendCommand("WebAuthn.disable").catch(() => undefined);
      if (tab.debugger.isAttached()) tab.debugger.detach();
    }, passkeySetup.authenticatorId);
    await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: { getSnapshot(): Promise<{ activeTabId: string | null }>; navigate(tabId: string, value: string): Promise<void> } })
        .pistachio;
      const snapshot = await api.getSnapshot();
      if (snapshot.activeTabId === null) throw new Error("No active tab");
      await api.navigate(snapshot.activeTabId, "pistachio://demo/invoices");
    });

    await app.evaluate(async ({ webContents }) => {
      const tab = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("pistachio://demo/invoices"));
      if (tab === undefined) throw new Error("Demo tab is unavailable");
      await tab.executeJavaScript(`(() => {
        const link = document.createElement("a");
        link.href = "data:text/plain,managed-export";
        link.download = "managed-export.txt";
        document.body.append(link);
        link.click();
        link.remove();
      })()`);
    });

    // The sidebar footer's menu shows on hover, and a click pins it.
    const menuButton = shell.getByTestId("sidebar-menu-button");
    await menuButton.hover();
    const footerMenu = shell.getByTestId("sidebar-menu");
    await expect(footerMenu).toBeVisible();
    await menuButton.click();
    await expect(footerMenu).toHaveAttribute("data-pinned", "");
    await menuButton.press("Escape");
    await expect(footerMenu).toHaveCount(0);

    // The page card's site-info popover opens the full Site controls page.
    // Its button rides the pane toolbar, revealed here by the trigger strip's
    // own pointer move (main cannot read the OS pointer under Playwright).
    await expect(async () => {
      const trigger = shell.getByTestId("pane-toolbar-trigger");
      if ((await trigger.count()) > 0) await trigger.dispatchEvent("pointermove");
      await shell.getByTestId("site-info-button").click({ timeout: 1_000 });
      await expect(shell.getByTestId("site-info-popover")).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await shell.getByTestId("site-info-popover").getByTestId("site-info-site-controls").click();

    const controls = shell.getByTestId("site-controls");
    await expect(controls).toBeVisible();
    await expect(controls.getByRole("heading", { name: "pistachio://demo" })).toBeVisible();
    await expect(controls.getByTestId("policy-action-download")).toContainText("block");
    await expect(controls.getByTestId("policy-action-print")).toContainText("block");
    await expect(controls.getByTestId("passkey-status")).toContainText("Passkeys unavailable");
    await expect(controls.getByLabel("Notifications permission")).toBeDisabled();
    await expect(controls.getByText("managed-export.txt")).toBeVisible();
    await expect(controls.getByText("managed-export.txt").locator("..")).toContainText("blocked");

    await controls.getByRole("button", { name: "Zoom in" }).click();
    await expect(controls.getByRole("button", { name: "110%" })).toBeVisible();
    await controls.getByRole("button", { name: "Close site controls" }).click();

    await shell.keyboard.press("Meta+f");
    const find = await findPage(app);
    const input = find.getByRole("textbox", { name: "Find in page" });
    await expect(input).toBeFocused();
    await input.fill("invoice");
    await expect(input).toHaveValue("invoice");
    await expect
      .poll(() =>
        find.evaluate(() =>
          (window as unknown as { pistachio: { getFindState(): Promise<unknown> } }).pistachio.getFindState(),
        ),
      )
      .toMatchObject({ open: true, query: "invoice" });
    await input.press("Escape");
    await expect
      .poll(() =>
        find.evaluate(() =>
          (window as unknown as { pistachio: { getFindState(): Promise<unknown> } }).pistachio.getFindState(),
        ),
      )
      .toMatchObject({ open: false });
  } finally {
    passkeyServer.closeAllConnections();
    passkeyServer.close();
    await app.close();
  }
});
