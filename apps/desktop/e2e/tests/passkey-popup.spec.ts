import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellReady } from "./windows";

test("a sign-in popup completes and cancels discoverable passkey requests", async () => {
  const screenshots = join(process.cwd(), "e2e/screenshots/passkey-popup");
  await mkdir(screenshots, { recursive: true });
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      request.url === "/"
        ? `<!doctype html><title>Passkey relying party</title>
      <h1>Sign in</h1><button onclick="window.open('${origin}/oauth/passkey', 'sign-in', 'width=520,height=600')">Sign in with passkey</button>`
        : `<!doctype html><title>Passkey provider</title><h1>Passkey sign-in</h1>
      <button id="register">Create test accounts</button><button id="login">Use passkey</button>
      <p role="status">Ready</p><script>
        const status = document.querySelector('[role=status]');
        const bytes = text => new TextEncoder().encode(text);
        document.querySelector('#register').onclick = async () => {
          for (const name of ['Avery', 'Blair']) {
            const credential = await navigator.credentials.create({ publicKey: {
              challenge: crypto.getRandomValues(new Uint8Array(32)),
              rp: { id: location.hostname, name: 'Passkey test' },
              user: { id: bytes(name), name: name + '@example.test', displayName: name },
              pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
              authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
            }});
            if (name === 'Avery') window.expectedCredential = credential.id;
          }
          status.textContent = 'Accounts created';
        };
        document.querySelector('#login').onclick = async () => {
          status.textContent = 'Waiting for passkey';
          try {
            const credential = await navigator.credentials.get({ publicKey: {
              challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname,
              userVerification: 'required', timeout: 30000
            }});
            status.textContent = credential.id === window.expectedCredential ? 'Signed in as Avery' : 'Wrong account';
          } catch (error) { status.textContent = error.name; }
        };
      </script>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No test server");
  const origin = `http://localhost:${address.port}`;
  const ownerUrl = `http://127.0.0.1:${address.port}/`;
  const userData = await mkdtemp(join(tmpdir(), "pistachio-passkey-popup-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ general: { consoleOpenOnLaunch: false } }),
  );
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellReady(app);
    await shell.evaluate(
      (url) =>
        (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(
          url,
        ),
      ownerUrl,
    );
    const owner =
      app.windows().find((page) => page.url() === ownerUrl) ??
      (await app.waitForEvent("window", {
        predicate: (page) => page.url() === ownerUrl,
      }));
    // Preserve the real child context used by Google/OAuth handoffs.
    await owner.getByRole("button", { name: "Sign in with passkey" }).click();
    const popupUrl = `${origin}/oauth/passkey`;
    const popup =
      app.windows().find((page) => page.url() === popupUrl) ??
      (await app.waitForEvent("window", {
        predicate: (page) => page.url() === popupUrl,
      }));
    await expect(
      popup.getByRole("heading", { name: "Passkey sign-in" }),
    ).toBeVisible();
    await popup.screenshot({ path: join(screenshots, "01-sign-in-popup.png") });
    await app.evaluate(async ({ webContents }, url) => {
      const page = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL() === url)!;
      page.debugger.attach("1.3");
      await page.debugger.sendCommand("WebAuthn.enable");
      await page.debugger.sendCommand("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          automaticPresenceSimulation: true,
          isUserVerified: true,
        },
      });
    }, popupUrl);
    // Chromium creates real credentials on a test authenticator; no account event is mocked.
    await popup.getByRole("button", { name: "Create test accounts" }).click();
    await expect(popup.getByRole("status")).toHaveText("Accounts created");
    await popup.getByRole("button", { name: "Use passkey" }).click();
    const bar = app
      .windows()
      .find((page) => page.url().startsWith("data:text/html"))!;
    const chooser = bar.getByTestId("passkey-account-chooser");
    await expect(chooser).toBeVisible();
    await expect(chooser).toContainText("localhost");
    await expect(chooser).toContainText("Avery@example.test");
    await expect(chooser).toContainText("Blair@example.test");
    // Only the trusted strip has the bridge; stale messages cannot pick an account.
    expect(await popup.evaluate(() => "pistachioPopup" in window)).toBe(false);
    await bar.evaluate(() => {
      (
        window as unknown as {
          pistachioPopup: {
            selectPasskey(id: string, account: string | null): void;
          };
        }
      ).pistachioPopup.selectPasskey("stale-request", null);
    });
    await expect(chooser).toBeVisible();
    const credentialId = await popup.evaluate(
      () =>
        (window as unknown as { expectedCredential: string })
          .expectedCredential,
    );
    expect(await bar.content()).not.toContain(credentialId);
    await bar.screenshot({
      path: join(screenshots, "02-passkey-account-chooser.png"),
    });
    await chooser
      .getByRole("button", { name: "Avery Avery@example.test", exact: true })
      .click();
    await expect(popup.getByRole("status")).toHaveText("Signed in as Avery");
    await expect(chooser).toBeHidden();
    const controls = await shell.evaluate(() =>
      (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.getBrowserControls(),
    );
    expect(
      controls.recentEvents.find((event) => event.capability === "passkey"),
    ).toMatchObject({
      origin,
      decision: "allow",
    });
    await popup.screenshot({ path: join(screenshots, "03-signed-in.png") });

    // Explicit cancellation rejects the page request and leaves the popup usable.
    await popup.getByRole("button", { name: "Use passkey" }).click();
    await expect(chooser).toBeVisible();
    await chooser.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(popup.getByRole("status")).toHaveText("NotAllowedError");
    await expect(chooser).toBeHidden();
    await popup.screenshot({ path: join(screenshots, "04-cancelled.png") });

    // Same-document navigation preserves a request; a replacement document cancels it.
    await popup.getByRole("button", { name: "Use passkey" }).click();
    await expect(chooser).toBeVisible();
    await popup.evaluate(() => {
      location.hash = "still-signing-in";
    });
    await expect(chooser).toBeVisible();
    await popup.goto(`${popupUrl}?replacement=1`);
    await expect(chooser).toBeHidden();
    await expect(popup.getByRole("status")).toHaveText("Ready");
    await popup.screenshot({
      path: join(screenshots, "05-navigation-cleared-chooser.png"),
    });

    // Closing with an unanswered request removes both popup views without stranding the owner.
    await popup.getByRole("button", { name: "Use passkey" }).click();
    await expect(chooser).toBeVisible();
    await app.evaluate(({ webContents }, url) => {
      webContents
        .getAllWebContents()
        .find((page) => page.getURL() === url)!
        .close();
    }, `${popupUrl}?replacement=1`);
    await expect.poll(() => popup.isClosed() && bar.isClosed()).toBe(true);
    await expect(
      owner.getByRole("button", { name: "Sign in with passkey" }),
    ).toBeVisible();
    await owner.screenshot({ path: join(screenshots, "06-popup-closed.png") });
  } finally {
    await app.close();
    server.closeAllConnections();
    server.close();
  }
});
