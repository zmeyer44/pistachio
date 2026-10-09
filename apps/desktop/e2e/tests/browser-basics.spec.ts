import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { shellReady } from "./windows";
import { launchApp } from "./app";
import { openSiteInfo } from "./pages-harness";

// Find in page (⌘F, Escape) is smart-find.spec.ts's: it opens the same bar.
test("managed site controls and passkeys are enforced across Chromium views, and the footer menu pins", { tag: ["@site", "@sidebar"] }, async () => {
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
  const { app } = await launchApp({
    // The window opens on the home page, and this spec's managed rules are
    // written for the demo site — so make the demo page the home page rather
    // than expecting a demo tab that launch no longer creates.
    settings: { general: { homeUrl: "pistachio://demo/invoices" } },
    files: {
      "enterprise-policy.json": {
        version: 1,
        rules: [
          {
            pattern: "pistachio://demo",
            permissions: { notifications: "block" },
            actions: { download: "block", copy: "block", print: "block" },
          },
        ],
      },
    },
    name: "browser-basics",
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
    await (await openSiteInfo(shell, app)).getByTestId("site-info-site-controls").click();

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
    await expect(controls).toHaveCount(0);
  } finally {
    passkeyServer.closeAllConnections();
    passkeyServer.close();
    await app.close();
  }
});
