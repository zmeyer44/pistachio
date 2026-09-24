import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { chromiumPath, enterPin, openBrowseShell, openNewTab, signInInTab, startWebStack, type WebStack } from "./web-harness";
import { shellPage } from "./windows";

// Unlike the other desktop specs, this launches with accounts and sync ON.
// All services and both device profiles belong to this test, not the developer.
test("desktop signup hands its active tab and signed-in session to a fresh web browser", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const chromium = chromiumPath();
  expect(chromium, "The handoff test needs real Chromium").not.toBeNull();
  const executablePath = process.env["PISTACHIO_ELECTRON_PATH"] ?? join(process.cwd(), "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  expect(existsSync(executablePath), "The handoff test needs real Electron").toBe(true);
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desktop-web-sync-"));
  const cookieValue = randomUUID();
  const accountRequests: boolean[] = [];
  const telemetry = new Map<string, { draft: string; scrollY: number; instance: string; width: number; sequence: number }>();
  const site = createServer((request, response) => {
    if (request.url === "/state" && request.method === "POST") {
      let body = "";
      request.on("data", chunk => { body += String(chunk); });
      request.on("end", () => { const incoming = JSON.parse(body); if (incoming.sequence > (telemetry.get(incoming.instance)?.sequence ?? -1)) telemetry.set(incoming.instance, incoming); response.writeHead(204); response.end(); });
      return;
    }
    if (request.url === "/login") {
      response.writeHead(303, { "set-cookie": `handoff=${cookieValue}; Path=/; HttpOnly; SameSite=Lax`, location: "/account" });
      response.end();
      return;
    }
    const authenticated = request.headers.cookie?.includes(`handoff=${cookieValue}`) === true;
    if (request.url === "/account") accountRequests.push(authenticated);
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(`<!doctype html><title>${authenticated ? "Signed-in handoff" : "Signed out"}</title><h1>${authenticated ? "Your signed-in session is ready" : "Sign in required"}</h1>
      <textarea id="draft" aria-label="Draft" style="position:fixed;left:20px;top:100px;width:300px;height:100px"></textarea>
      <div style="height:3000px;background:linear-gradient(white,skyblue)">Shared scroll position</div>
      <script>
        const instance = crypto.randomUUID(); window.testInstance = instance; let sequence = 0;
        const report = () => fetch('/state', {method:'POST',body:JSON.stringify({instance,sequence:++sequence,draft:document.querySelector('textarea').value,scrollY,width:innerWidth})});
        document.addEventListener('input',report); window.addEventListener('scroll',report); window.addEventListener('resize',report); report();
      </script>`);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const siteUrl = `http://127.0.0.1:${String((site.address() as AddressInfo).port)}`;
  const email = `desktop-web-${randomUUID()}@example.test`;
  const password = "desktop-web-test-password";
  let stack: WebStack | undefined;
  let desktop: ElectronApplication | undefined;
  let desktopLog = "";
  const viewer = await browser.newContext();
  const web = await viewer.newPage();
  try {
    stack = await startWebStack({ name: "desktop-web-sync", chromium, allowedOrigins: [siteUrl] });
    desktop = await electron.launch({
      // This disposable profile must not ask for the developer's login keychain.
      args: ["--use-mock-keychain", "."], cwd: process.cwd(), executablePath, timeout: 30_000,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RENDERER_URL")),
        PISTACHIO_E2E: "0",
        PISTACHIO_USER_DATA: userData,
        PISTACHIO_CONTROL_URL: stack.controlUrl,
        PISTACHIO_HUB_URL: `${stack.controlUrl.replace(/^http/u, "ws")}/v1/hub/ws`,
      },
    });
    desktop.process().stderr?.on("data", (chunk: Buffer) => { desktopLog += chunk.toString(); });
    const shell = await shellPage(desktop);
    shell.on("console", message => { desktopLog += `\n[renderer] ${message.text()}`; });
    shell.on("pageerror", error => { desktopLog += `\n[renderer error] ${error.message}`; });
    const wizard = shell.getByTestId("onboarding");
    // The walkthrough never makes an account (it only offers "Or sign in" to
    // one that exists), so this Mac walks it signed out and signs up in
    // Settings → Account afterwards.
    await expect(wizard).toHaveAttribute("data-step", "about", { timeout: 30_000 });
    await expect(shell.getByTestId("onboarding-sign-in")).toBeVisible();
    const typeInstead = shell.getByTestId("onboarding-type-instead");
    if (await typeInstead.isVisible()) await typeInstead.click();
    await shell.getByTestId("onboarding-name").fill("Desktop Handoff");
    await shell.getByTestId("onboarding-primary").click();
    await expect(wizard).toHaveAttribute("data-step", "import");
    await shell.getByTestId("import-fresh").click();
    await shell.getByTestId("onboarding-primary").click();
    await expect(wizard).toHaveAttribute("data-step", "favorites");
    await shell.getByTestId("onboarding-primary").click();
    await expect(wizard).toHaveAttribute("data-step", "appearance");
    await shell.getByTestId("onboarding-primary").click();
    await expect(wizard).toHaveCount(0, { timeout: 30_000 });
    console.info("[handoff] Desktop onboarding complete");
    await shell.keyboard.press("Meta+,");
    const settings = shell.getByTestId("settings-page");
    await settings.getByRole("button", { name: "Account", exact: true }).click();
    await settings.getByRole("button", { name: "Create an account", exact: true }).click();
    await settings.getByTestId("account-email").fill(email);
    await settings.getByTestId("account-password").fill(password);
    await settings.getByTestId("account-confirm").fill(password);
    await settings.getByTestId("account-submit").click();
    await settings.getByTestId("account-enroll").click({ timeout: 60_000 });
    await expect(settings.getByTestId("account-sign-out")).toBeVisible({ timeout: 60_000 });
    await expect(settings.getByTestId("account-enroll")).toHaveCount(0, { timeout: 60_000 });
    console.info("[handoff] Desktop account enrolled");
    await shell.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expect(shell.getByTestId("linked-controls")).toHaveCount(0);
    await expect(shell.getByTestId("streamed-pane-frame")).toHaveCount(0);

    const address = await openNewTab(shell);
    await address.fill(`${siteUrl}/login`);
    await address.press("Enter");
    await expect.poll(() => accountRequests.length).toBe(1);
    expect(accountRequests).toEqual([true]);
    console.info("[handoff] Desktop page signed in");
    await expect(shell.getByTestId("primary-pane")).toBeVisible();

    const native = async <T,>(script: string, url = `${siteUrl}/account`): Promise<T> => desktop!.evaluate(async ({ webContents }, args) => {
      const contents = webContents.getAllWebContents().find(view => view.getURL() === args.url);
      if (!contents) throw new Error("The site must be a local Electron WebContents: " + JSON.stringify(webContents.getAllWebContents().map(view => ({id:view.id,url:view.getURL()}))));
      return contents.executeJavaScript(args.script, true);
    }, { url, script }) as Promise<T>;
    const fillNative = (value: string) => native(`document.querySelector('textarea').value = ${JSON.stringify(value)}; document.querySelector('textarea').dispatchEvent(new Event('input', {bubbles:true}));`);
    await expect.poll(() => native<string>("window.testInstance").catch(error => String(error))).toMatch(/^[a-f0-9-]{36}$/u);
    const originalInstance = await native<string>("window.testInstance");
    await fillNative("This draft started in native Electron.");
    await native("window.scrollTo(0, 500)");
    const checkpoint = async () => {
      const saved = JSON.parse(await readFile(join(userData, "tab-session.json"), "utf8"));
      return Object.values(saved.spaces as Record<string, { tabs: Array<{ resume?: { drafts: Array<{value: string}>; scrollY: number } }> }>).flatMap(space => space.tabs).find(tab => tab.resume?.drafts[0]?.value)?.resume;
    };
    await expect.poll(async () => (await checkpoint())?.scrollY).toBe(500);
    await expect.poll(async () => (await checkpoint())?.drafts[0]?.value).toBe("This draft started in native Electron.");
    expect(accountRequests).toEqual([true]);

    // A separately enrolled web device gets encrypted session state. It
    // opens its own page; the desktop page and its JS process remain local.
    await signInInTab(web, { webUrl: stack.webUrl, email, password });
    await expect(web.getByTestId("onboarding")).toHaveCount(0);
    const restoredPane = web.getByTestId("primary-pane").getByRole("region", { name: /Signed-in handoff/u });
    await expect(restoredPane).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => accountRequests.length).toBe(2);
    expect(accountRequests).toEqual([true, true]);
    const cloudState = () => [...telemetry.values()].find(state => state.instance !== originalInstance);
    await expect.poll(() => cloudState()?.draft).toBe("This draft started in native Electron.");
    await expect.poll(() => cloudState()?.scrollY).toBe(500);
    expect(await native<string>("window.testInstance")).toBe(originalInstance);
    expect(await native<string>("document.querySelector('textarea').value")).toBe("This draft started in native Electron.");
    await expect(shell.getByTestId("streamed-pane-frame")).toHaveCount(0);
    await expect(shell.getByTestId("linked-controls")).toHaveCount(0);
    await web.screenshot({ path: testInfo.outputPath("native-session-on-web.png") });
    const image = await desktop.evaluate(async ({ webContents }, url) => {
      const page = webContents.getAllWebContents().find(contents => contents.getURL() === url);
      if (!page) throw new Error("Native page disappeared");
      return (await page.capturePage()).toPNG().toString("base64");
    }, `${siteUrl}/account`);
    await writeFile(testInfo.outputPath("native-desktop-page.png"), Buffer.from(image, "base64"));


    // Editing desktop never takes control away from an attached web viewer.
    await fillNative("Desktop continues locally.");
    await expect.poll(async () => (await checkpoint())?.drafts[0]?.value).toBe("Desktop continues locally.");
    expect(cloudState()?.draft).toBe("This draft started in native Electron.");
    await web.goto("about:blank");
    await fillNative("Resume this newer native draft.");
    await expect.poll(async () => (await checkpoint())?.drafts[0]?.value).toBe("Resume this newer native draft.");
    // Return to the already-existing cloud session, not just its first visit.
    await web.goto(stack.webUrl);
    await enterPin(web);
    await openBrowseShell(web);
    await expect(restoredPane).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => [...telemetry.values()].some(state => state.instance !== originalInstance && state.draft === "Resume this newer native draft.")).toBe(true);
    expect(accountRequests).toEqual([true, true, true]);
    expect(await native<string>("window.testInstance")).toBe(originalInstance);
    await web.goto("about:blank");
    await stack.stopCloudBrowser();
    await fillNative("The cloud is stopped and desktop still works.");
    expect(await native<string>("window.testInstance")).toBe(originalInstance);
    await native(`location.href = ${JSON.stringify(`${siteUrl}/after-cloud-stop`)}`);
    await expect.poll(() => native<string>("document.body.innerText", `${siteUrl}/after-cloud-stop`).catch(() => "")).toContain("Your signed-in session is ready");
  } catch (error) {
    await testInfo.attach("handoff-diagnostics", {
      body: JSON.stringify({ ...stack?.logs(), desktop: desktopLog, accountRequests }), contentType: "application/json",
    });
    throw error;
  } finally {
    await viewer.close();
    if (desktop !== undefined) {
      const timer = setTimeout(() => desktop?.process().kill("SIGKILL"), 8_000);
      await desktop.close().catch(() => undefined);
      clearTimeout(timer);
    }
    await stack?.close();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await rm(userData, { recursive: true, force: true });
  }
});
