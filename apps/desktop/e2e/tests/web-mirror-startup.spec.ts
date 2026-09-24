import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { startFixture } from "../../../../services/cloud-browser/test/helpers/fixture-server.js";
import { chromiumPath, openBrowseShell, openNewTab, signUpInTab, startWebStack, walkFirstRun, type WebStack } from "./web-harness";

test("DOM startup reports missing snapshots and local rendering failures, then recovers on retry", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  const chromium = chromiumPath();
  test.skip(chromium === null, "no Chromium build available");
  const shots = "e2e/screenshots/web-mirror-startup";
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const fixture = await startFixture((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><title>Startup fixture</title><style>body{font:20px system-ui;padding:32px}h1{color:#126454}</style><h1>Cloud document is ready</h1><label>Draft <input aria-label="Draft"></label>');
  });
  const openMenu = async (): Promise<void> => {
    await page.getByTestId("sidebar-menu-button").press("Escape");
    await page.getByTestId("sidebar-menu-button").click();
  };
  let fault: "none" | "drop-once" | "drop" | "render" = "none";
  let lostSnapshot = false;
  // Fault injection on the real connection: auth, browser, document and pixels
  // still come from the real stack. Only snapshot delivery/building is disturbed.
  await page.routeWebSocket(/\/v1\/shell\//u, route => {
    const server = route.connectToServer();
    route.onMessage(message => server.send(message));
    server.onMessage(message => {
      if (typeof message === "string") {
        const frame = JSON.parse(message);
        if (frame.t === "mirror" && frame.msg.k === "snapshot" && frame.msg.url.startsWith(fixture.origin)) {
          if (fault === "drop-once") { lostSnapshot = true; fault = "none"; return; }
          if (fault === "drop") return;
          if (fault === "render") {
            frame.msg.root = { t: "doc", id: 1, c: [{ t: "e", id: 2, tag: "html", c: [
              { t: "e", id: 3, tag: "body", c: [{ t: "e", id: 4, tag: "input", a: { type: "file" }, v: "cannot assign a file path" }] },
            ] }] };
            route.send(JSON.stringify(frame)); return;
          }
        }
      }
      route.send(message);
    });
  });
  let stack: WebStack | null = null;
  try {
    stack = await startWebStack({ chromium, name: "web-mirror-startup", allowedOrigins: [fixture.origin], webEnv: { NEXT_PUBLIC_PISTACHIO_DOM_MIRROR: "1" } });
    await signUpInTab(page, { webUrl: stack.webUrl, email: `startup-${randomUUID()}@example.com`, password: "correct-horse-battery" });
    await openBrowseShell(page); await walkFirstRun(page, "Browse");
    const address = await openNewTab(page);
    await address.fill(fixture.origin);
    await address.press("Enter");
    const mirror = page.locator("[data-mirror-pane]");
    const heading = mirror.frameLocator("iframe").getByRole("heading", { name: "Cloud document is ready" });
    await expect(heading).toBeVisible();
    await page.screenshot({ path: `${shots}/01-dom-ready.png`, fullPage: true, animations: "disabled" });

    // A single lost snapshot is recovered automatically, before pixel fallback.
    await openMenu();
    await page.getByRole("button", { name: "Use pixel rendering", exact: true }).click();
    await expect(page.locator("[data-streamed-pane]")).toBeVisible();
    fault = "drop-once";
    await openMenu();
    await page.getByRole("button", { name: "Use DOM mirroring", exact: true }).click();
    await expect.poll(() => lostSnapshot).toBe(true);
    await expect(mirror).toHaveAttribute("data-painted", "0");
    await expect(heading).toBeVisible({ timeout: 8_000 });
    await page.getByTestId("sidebar-menu-button").press("Escape");
    const recoveredField = mirror.frameLocator("iframe").getByRole("textbox", { name: "Draft" });
    await recoveredField.click();
    await recoveredField.fill("Automatic recovery works");
    await expect(recoveredField).toHaveValue("Automatic recovery works");
    await page.screenshot({ path: `${shots}/01-automatic-recovery.png`, fullPage: true, animations: "disabled" });

    // Reopening DOM with a lost snapshot must give a specific, bounded fallback.
    await openMenu();
    await page.getByRole("button", { name: "Use pixel rendering", exact: true }).click();
    await expect(page.locator("[data-streamed-pane]")).toBeVisible();
    fault = "drop";
    await openMenu();
    await page.getByRole("button", { name: "Use DOM mirroring", exact: true }).click();
    await expect(mirror).toHaveAttribute("data-painted", "0");
    await expect(page.locator("[data-streamed-pane]")).toBeVisible({ timeout: 20_000 });
    await openMenu();
    await expect(page.getByTestId("browser-rendering-reason")).toHaveText("No DOM snapshot arrived from the cloud browser in time.");
    await page.screenshot({ path: `${shots}/02-missing-snapshot.png`, fullPage: true, animations: "disabled" });

    // Retry must recover the same cloud document after the connection is healthy.
    fault = "none";
    await page.getByRole("button", { name: "Retry DOM mirroring", exact: true }).click();
    await expect(heading).toBeVisible();
    await mirror.frameLocator("iframe").getByRole("textbox", { name: "Draft" }).fill("Recovered draft");
    await expect(mirror.frameLocator("iframe").getByRole("textbox", { name: "Draft" })).toHaveValue("Recovered draft");
    await page.screenshot({ path: `${shots}/03-recovered.png`, fullPage: true, animations: "disabled" });

    // Native DOM exceptions must report rendering failure, not a network timeout.
    await openMenu();
    await page.getByRole("button", { name: "Use pixel rendering", exact: true }).click();
    await expect(page.locator("[data-streamed-pane]")).toBeVisible();
    fault = "render";
    await openMenu();
    await page.getByRole("button", { name: "Use DOM mirroring", exact: true }).click();
    await expect(page.locator("[data-streamed-pane]")).toBeVisible({ timeout: 5_000 });
    await openMenu();
    await expect(page.getByTestId("browser-rendering-reason")).toHaveText("Your browser could not render the DOM snapshot.");
    await page.screenshot({ path: `${shots}/04-local-render-failure.png`, fullPage: true, animations: "disabled" });
    fault = "none";
    await page.getByRole("button", { name: "Retry DOM mirroring", exact: true }).click();
    await expect(heading).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await stack?.close(); await fixture.close(); }
});
