import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { test, expect } from "@playwright/test";
import { startFixture } from "../../../../services/cloud-browser/test/helpers/fixture-server.js";
import { chromiumPath, openBrowseShell, openNewTab, signUpInTab, startWebStack, walkFirstRun, type WebStack } from "./web-harness";

const SHOTS = "e2e/screenshots/web-asset-recovery";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC", "base64");

// Journey: render a feed, scroll to slow/broken assets, recover the slow image,
// retry a failed transfer, then verify only a lost required stylesheet uses pixels.
test("scrolling survives slow and broken assets, retries transfers, and preserves critical stylesheet fallback", async ({ page }) => {
  test.setTimeout(240_000);
  const chromium = chromiumPath();
  test.skip(chromium === null, "no Chromium build available");
  let delayed: ServerResponse | undefined;
  const hits = new Map<string, number>();
  const cdn = await startFixture((request, response) => {
    const path = request.url ?? "/";
    hits.set(path, (hits.get(path) ?? 0) + 1);
    response.setHeader("cache-control", "no-store");
    response.setHeader("access-control-allow-origin", "*");
    if (path === "/slow.png") {
      delayed = response;
      response.writeHead(200, { "content-type": "image/png" });
      response.write(PNG.subarray(0, 10));
    } else if (path.startsWith("/missing")) { response.writeHead(404, { "content-type": "text/plain" }); response.end("Not found"); }
    else if (path === "/critical.css") { response.writeHead(200, { "content-type": "text/css" }); response.end("#feed{border:5px solid green}"); }
    else { response.writeHead(200, { "content-type": "image/png" }); response.end(PNG); }
  });
  const fixture = await startFixture((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><title>Asset recovery feed</title>
      <style>body{font:18px system-ui;background:#f3f6f4;margin:24px;color:#163629}article{background:white;border:1px solid #bacfc2;padding:24px;margin:16px 0}img{width:64px;height:64px;background:#cddfd3}button,input{font:inherit}#feed{height:380px;overflow:auto}#gap{height:650px}</style>
      <h1>Asset recovery feed</h1><p>Scrolling and typing stay in DOM mode while resources arrive.</p>
      <input aria-label="Draft" placeholder="Type while images load"><button id="retry" onclick="document.querySelector('#transfer').src='${cdn.origin}/transfer.png'">Load another image</button>
      <button onclick="document.querySelector('#exhaust').src='${cdn.origin}/exhaust.png'">Load unavailable transfer</button>
      <button onclick="const s=document.createElement('link');s.rel='stylesheet';s.href='${cdn.origin}/critical.css';document.head.append(s)">Load required style</button>
      <div id="feed"><article>First post — ready</article><div id="gap"></div><article id="next">Next post
        <img id="slow" alt="Delayed picture"><img id="broken" alt="Unavailable picture"><img id="transfer" alt="Recovered transfer"><img id="exhaust" alt="Unavailable transfer"><p id="font">Readable fallback font</p>
      </article></div>
      <script>document.querySelector('#feed').addEventListener('scroll', function(){if(this.scrollTop<100||this.dataset.loaded)return;this.dataset.loaded='1';
      document.querySelector('#slow').src='${cdn.origin}/slow.png';document.querySelector('#broken').src='${cdn.origin}/missing.png';
      const s=document.createElement('style');s.textContent='@font-face{font-family:Missing;src:url(${cdn.origin}/missing.woff2)}#font{font-family:Missing,system-ui}';document.head.append(s);
      const l=document.createElement('link');l.rel='stylesheet';l.href='${cdn.origin}/missing.css';document.head.append(l);});</script>`);
  });
  let stack: WebStack | null = null;
  let pendingResponses = 0;
  let transferFault = false;
  let transferAttempts = 0;
  let interruptedId = "";
  let criticalFault = false;
  let exhaustFault = false;
  let exhaustAttempts = 0;
  const failures: Array<{ reason: string; context?: string; status?: number }> = [];
  await page.route("**/assets/**", async route => {
    const response = await route.fetch();
    if (response.status() === 202) pendingResponses++;
    if (response.status() === 410) failures.push(await response.json());
    const type = response.headers()["content-type"] ?? "";
    if (exhaustFault && type === "image/png") { exhaustAttempts++; await route.abort("failed"); return; }
    if (criticalFault && type === "text/css") {
      await route.fulfill({ status: 410, contentType: "application/json", body: JSON.stringify({ reason: "evicted", context: "style" }) }); return;
    }
    if (interruptedId && route.request().url() === interruptedId) transferAttempts++;
    if (transferFault && type === "image/png") {
      transferFault = false; interruptedId = route.request().url(); transferAttempts++;
      await route.abort("failed"); return;
    }
    await route.fulfill({ response });
  });
  try {
    stack = await startWebStack({ chromium, name: "web-asset-recovery", allowedOrigins: [fixture.origin, cdn.origin], webEnv: { NEXT_PUBLIC_PISTACHIO_DOM_MIRROR: "1" } });
    await signUpInTab(page, { webUrl: stack.webUrl, email: `recovery-${randomUUID()}@example.com`, password: "correct-horse-battery" });
    await openBrowseShell(page); await walkFirstRun(page, "Browse");
    const address = await openNewTab(page);
    await address.fill(fixture.origin);
    await address.press("Enter");
    const pane = page.locator("[data-mirror-pane]");
    const inner = pane.frameLocator("iframe");
    await expect(inner.getByRole("heading", { name: "Asset recovery feed" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/01-feed.png`, fullPage: true, animations: "disabled" });

    // A source-side 404 (including a stylesheet) must not disable an otherwise readable page.
    await inner.locator("#feed").evaluate(el => el.scrollTo(0, 900));
    await expect.poll(() => failures.filter(failure => failure.reason === "source-http").length).toBeGreaterThanOrEqual(3);
    await expect.poll(() => pendingResponses, { timeout: 20_000 }).toBeGreaterThan(0);
    await inner.getByRole("textbox", { name: "Draft" }).fill("Still typing while images load");
    await expect(inner.getByRole("textbox", { name: "Draft" })).toHaveValue("Still typing while images load");
    await page.getByTestId("sidebar-menu-button").hover();
    await expect(page.getByTestId("browser-rendering-status")).toHaveAttribute("data-renderer", "dom");
    await expect(page.getByTestId("browser-rendering-reason")).toContainText("HTTP 404");
    await page.screenshot({ path: `${SHOTS}/02-pending-and-source-errors.png`, fullPage: true, animations: "disabled" });
    await page.getByTestId("sidebar-menu-button").press("Escape");

    // Completing the original response recovers the image without another origin GET.
    expect(delayed).toBeDefined(); delayed!.end(PNG.subarray(10));
    await expect.poll(() => inner.locator("#slow").evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
    expect(hits.get("/slow.png")).toBe(1);
    await expect(pane).toHaveAttribute("data-painted", "1");
    await page.screenshot({ path: `${SHOTS}/03-delayed-image-recovered.png`, fullPage: true, animations: "disabled" });

    // A failed viewer transfer retries captured bytes, preserving the cloud session and draft.
    transferFault = true;
    await inner.getByRole("button", { name: "Load another image" }).click();
    await expect.poll(() => inner.locator("#transfer").evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
    expect(transferAttempts).toBeGreaterThanOrEqual(2);
    expect(hits.get("/transfer.png")).toBe(1);
    await expect(inner.getByRole("textbox", { name: "Draft" })).toHaveValue("Still typing while images load");
    await page.screenshot({ path: `${SHOTS}/04-transfer-recovered.png`, fullPage: true, animations: "disabled" });

    // Repeated transfer failures stop after three attempts and leave only that image missing.
    exhaustFault = true;
    await inner.getByRole("button", { name: "Load unavailable transfer" }).click();
    await page.getByTestId("sidebar-menu-button").hover();
    await expect(page.getByTestId("browser-rendering-reason")).toContainText("could not be transferred");
    expect(exhaustAttempts).toBe(3);
    expect(hits.get("/exhaust.png")).toBe(1);
    await expect(page.getByTestId("browser-rendering-status")).toHaveAttribute("data-renderer", "dom");
    await page.screenshot({ path: `${SHOTS}/04b-transfer-exhausted.png`, fullPage: true, animations: "disabled" });
    await page.getByTestId("sidebar-menu-button").press("Escape");
    exhaustFault = false;

    // A sheet the source loaded, but the viewer cannot receive, retains an explicit escape hatch.
    criticalFault = true;
    await inner.getByRole("button", { name: "Load required style" }).click();
    await expect(page.getByTestId("streamed-pane-frame")).toBeVisible();
    await page.getByTestId("sidebar-menu-button").hover();
    await expect(page.getByTestId("browser-rendering-status")).toHaveAttribute("data-renderer", "fallback");
    await expect(page.getByTestId("browser-rendering-reason")).toContainText("required stylesheet");
    await expect(page.getByTestId("browser-rendering-reason")).toContainText("removed from the mirror cache");
    await page.screenshot({ path: `${SHOTS}/05-critical-style-fallback.png`, fullPage: true, animations: "disabled" });
    criticalFault = false;
    await page.getByRole("button", { name: "Retry DOM mirroring", exact: true }).click();
    await expect(inner.getByRole("textbox", { name: "Draft" })).toHaveValue("Still typing while images load");
    await expect(inner.locator("#feed")).toHaveCSS("border-top-width", "5px");
    await page.screenshot({ path: `${SHOTS}/06-style-recovered.png`, fullPage: true, animations: "disabled" });
  } catch (error) { if (stack) console.error(stack.logs().runner.slice(-7000)); console.error("Asset diagnostics", failures, Object.fromEntries(hits), { pendingResponses }); throw error; }
  finally { delayed?.end(); await stack?.close(); await fixture.close(); await cdn.close(); }
});
