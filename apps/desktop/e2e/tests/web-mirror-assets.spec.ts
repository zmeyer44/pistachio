import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { startFixture } from "../../../../services/cloud-browser/test/helpers/fixture-server.js";
import { chromiumPath, openBrowseShell, openNewTab, signUpInTab, startWebStack, walkFirstRun, type WebStack } from "./web-harness";

const SHOTS = "e2e/screenshots/web-mirror-assets";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC", "base64");

async function checkRenderingStatus(page: Page, mode: "dom" | "pixels" | "fallback", shot: string): Promise<void> {
  await page.getByTestId("sidebar-menu-button").hover();
  const indicator = page.getByTestId("browser-rendering-status");
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveAttribute("data-renderer", mode);
  await expect(indicator).toContainText(`Rendering${mode === "dom" ? "DOM mirroring" : mode === "fallback" ? "Pixel fallback" : "Pixel stream"}`);
  if (mode === "fallback") {
    await expect(page.getByTestId("browser-rendering-reason")).toHaveText("This page has an embedded frame.");
    await expect(page.getByRole("button", { name: "Retry DOM mirroring", exact: true })).toBeVisible();
  }
  await page.screenshot({ path: `${SHOTS}/${shot}.png`, fullPage: true, animations: "disabled" });
  await page.getByTestId("sidebar-menu-button").press("Escape");
  await expect(page.getByTestId("sidebar-menu")).toBeHidden();
}

test("assets, local responsiveness, reconnect and compatibility fallback over the real web stack", async ({ page }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(20_000);
  const chromium = chromiumPath();
  test.skip(chromium === null, "no Chromium build available");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let lag = 0;
  let latestSocket: WebSocketRoute | null = null;
  let lastEdit = "";
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let measuredMode: "dom" | "pixels" = "dom";
  const traffic = { dom: { socket: 0, assets: 0 }, pixels: { socket: 0, assets: 0 } };
  await page.routeWebSocket(/\/v1\/shell\//u, route => {
    latestSocket = route;
    const server = route.connectToServer();
    const deliver = (destination: WebSocketRoute, message: string | Buffer): void => {
      if (!lag) { destination.send(message); return; }
      const timer = setTimeout(() => { timers.delete(timer); try { destination.send(message); } catch { /* reconnect discarded this packet */ } }, lag);
      timers.add(timer);
    };
    route.onMessage(message => deliver(server, message));
    server.onMessage(message => {
      if (typeof message === "string") {
        const frame = JSON.parse(message);
        if (frame.t === "mirror" && frame.msg.k === "edited") lastEdit = frame.msg.v;
      }
      traffic[measuredMode].socket += typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
      deliver(route, message);
    });
  });
  page.on("response", response => {
    if (response.url().includes("/assets/")) traffic[measuredMode].assets += Number(response.headers()["content-length"] ?? 0);
  });
  const font = await readFile(new URL("../../../web/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2", import.meta.url));
  const hits = new Map<string, number>();
  const cdn = await startFixture((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    response.setHeader("cache-control", "no-store");
    if (path === "/sheet.css") { response.writeHead(200, { "content-type": "text/css" }); response.end('@import "nested.css"; #heading{color:rgb(12,34,56)}'); }
    else if (path === "/nested.css") { response.writeHead(200, { "content-type": "text/css" }); response.end('@font-face{font-family:MirrorFont;src:url(font.woff2)} #heading{font-family:MirrorFont} @font-face{font-family:Unused;src:url(unused.woff2)} #later{display:none;width:32px;height:32px;background-image:url(later.png)}'); }
    else if (path === "/font.woff2") { response.writeHead(200, { "content-type": "font/woff2", "access-control-allow-origin": "*" }); response.end(font); }
    else if (path === "/embedded") { response.writeHead(200, { "content-type": "text/html" }); response.end('<h1 style="color:green">Embedded content works</h1>'); }
    else { response.writeHead(200, { "content-type": "image/png" }); response.end(PNG); }
  });
  const submitted: string[] = [];
  const fixture = await startFixture((request, response, body) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    if (request.method === "POST") { submitted.push(new URLSearchParams(body.toString()).get("note") ?? ""); response.end('<title>Saved fixture</title><h1>Saved</h1><a href="/frame">Open embed</a>'); return; }
    if (path === "/frame") { response.end(`<title>Embedded fixture</title><button style="position:fixed;left:0;top:0;width:140px;height:40px;z-index:2" onclick="document.querySelector('iframe').remove();this.textContent='Embed closed'">Close embed</button><iframe src="${cdn.origin}/embedded" width="550" height="300"></iframe>`); return; }
    response.end(`<!doctype html><title>Asset fixture</title><link rel="stylesheet" href="${cdn.origin}/sheet.css">
      <style>body{margin:0} #heading{font-size:30px} @media(max-width:700px){#heading{font-size:20px}} #scroll{height:90px;overflow:auto} input,button{font:16px system-ui}</style>
      <div style="opacity:0;pointer-events:none;position:fixed;top:0"><iframe src="${cdn.origin}/embedded" width="400" height="200"></iframe><video width="300" height="180"></video></div>
      <h1 id="heading">Crisp local text</h1><img id="logo" width="32" height="32" src="${cdn.origin}/logo.png">
      <div id="later"></div><button type="button" id="reveal" onclick="document.querySelector('#later').style.display='block'">Reveal image</button>
      <img id="blob" width="32" height="32"><div id="scroll"><div style="height:600px">Scrollable content</div></div>
      <form method="post"><input id="note" name="note" aria-label="Note"><button type="submit">Save</button></form>
      <script>document.querySelector('#blob').src=URL.createObjectURL(new Blob([Uint8Array.from(atob('${PNG.toString("base64")}'),c=>c.charCodeAt(0))],{type:'image/png'})); window.siteRan=true;</script>`);
  });
  let stack: WebStack | null = null;
  try {
    stack = await startWebStack({ chromium, name: "web-mirror-assets", allowedOrigins: [fixture.origin, cdn.origin], webEnv: { NEXT_PUBLIC_PISTACHIO_DOM_MIRROR: "1" } });
    await signUpInTab(page, { webUrl: stack.webUrl, email: `assets-${randomUUID()}@example.com`, password: "correct-horse-battery" });
    await openBrowseShell(page); await walkFirstRun(page, "Browse");
    await expect(page.getByTestId("new-tab-button").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/01-shell.png`, fullPage: true });
    const open = async (url: string): Promise<void> => {
      const address = await openNewTab(page); await address.fill(url); await address.press("Enter");
    };
    // The address bar accepts a host without a scheme in the new-tab flow.
    await open(fixture.origin.replace("http://", ""));
    const mirror = page.locator("[data-mirror-pane]");
    await expect(mirror).toHaveAttribute("data-painted", "1");
    const inner = mirror.frameLocator("iframe");
    await expect(inner.locator("#heading")).toHaveCSS("color", "rgb(12, 34, 56)");
    await expect.poll(() => inner.locator("#heading").evaluate(() => [...document.fonts].some(font => font.family === "MirrorFont" && font.status === "loaded"))).toBe(true);
    for (const id of ["logo", "blob"]) await expect.poll(() => inner.locator(`#${id}`).evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
    expect(hits.get("/logo.png")).toBe(1); expect(hits.get("/font.woff2")).toBe(1);
    expect(await mirror.locator("iframe").evaluate(el => (el as HTMLIFrameElement).contentDocument)).toBeNull();
    await page.screenshot({ path: `${SHOTS}/02-assets.png`, fullPage: true });
    // The footer reports the renderer that actually painted this tab.
    await checkRenderingStatus(page, "dom", "02-dom-status");
    // Unused CSS URLs stay deferred, then arrive over HTTP when the cloud needs them.
    expect(hits.get("/unused.woff2")).toBeUndefined();
    expect(hits.get("/later.png")).toBeUndefined();
    await inner.getByRole("button", { name: "Reveal image" }).click();
    await expect.poll(() => inner.locator("#later").evaluate(el => getComputedStyle(el).backgroundImage)).toContain("blob:");
    await expect.poll(() => inner.locator("#later").evaluate(async el => {
      const image = new Image();
      image.src = getComputedStyle(el).backgroundImage.slice(5, -2);
      await image.decode();
      return image.naturalWidth;
    })).toBe(1);
    expect(hits.get("/later.png")).toBe(1);
    await checkRenderingStatus(page, "dom", "02-deferred-image-loaded");

    // 200ms each way on the real control connection; local edits still paint immediately.
    lag = 200;
    await page.setViewportSize({ width: 850, height: 750 });
    await expect(inner.locator("#heading")).toHaveCSS("font-size", "20px");
    await inner.locator("#note").evaluate(el => {
      (window as unknown as { samples: number[] }).samples = [];
      el.addEventListener("input", () => { const at = performance.now(); requestAnimationFrame(() => (window as unknown as { samples: number[] }).samples.push(performance.now() - at)); });
    });
    await inner.locator("#note").click();
    await page.keyboard.type("local under latency", { delay: 20 });
    expect(await inner.locator("#note").inputValue()).toBe("local under latency");
    const samples = await inner.locator("#note").evaluate(() => (window as unknown as { samples: number[] }).samples);
    expect(samples.length).toBeGreaterThan(10);
    expect(Math.max(...samples)).toBeLessThan(150);
    await inner.locator("#scroll").evaluate(el => el.scrollTo(0, 300));
    await expect.poll(() => inner.locator("#scroll").evaluate(el => el.scrollTop)).toBe(300);
    await page.screenshot({ path: `${SHOTS}/03-local-under-latency.png`, fullPage: true });

    // Reconnect restores the cloud document, including the accepted input value.
    await expect.poll(() => lastEdit).toBe("local under latency");
    lag = 0;
    const disconnect = latestSocket as WebSocketRoute | null;
    await disconnect?.close({ code: 1012, reason: "test reconnect" });
    await expect.poll(() => latestSocket !== disconnect, { timeout: 20000 }).toBe(true);
    await expect(mirror).toHaveAttribute("data-painted", "1");
    await expect(inner.locator("#note")).toHaveValue("local under latency");
    await page.screenshot({ path: `${SHOTS}/04-reconnected.png`, fullPage: true });
    await inner.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => submitted).toContain("local under latency");
    await expect(inner.getByRole("heading", { name: "Saved", exact: true })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/05-submitted.png`, fullPage: true });
    await inner.getByRole("link", { name: "Open embed" }).click();
    await expect(page.locator("[data-streamed-pane]")).toBeVisible();
    await expect(page.getByTestId("streamed-pane-frame")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/06-fallback.png`, fullPage: true });
    // A real cross-origin embed forces compatibility fallback; the label follows it.
    await checkRenderingStatus(page, "fallback", "06-fallback-status");
    // Pixel input can dismiss the incompatible content; retry preserves this document.
    await page.locator("[data-streamed-pane]").click({ position: { x: 70, y: 20 } });
    await page.getByTestId("sidebar-menu-button").hover();
    await page.getByRole("button", { name: "Retry DOM mirroring", exact: true }).click();
    await expect(mirror).toHaveAttribute("data-painted", "1");
    await expect(inner.getByRole("button", { name: "Embed closed", exact: true })).toBeVisible();
    await checkRenderingStatus(page, "dom", "06-retry-recovers-dom");
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(page.getByTestId("streamed-pane-frame")).toBeVisible();
    await checkRenderingStatus(page, "fallback", "06-reloaded-fallback");
    // Editing a fallback tab's address accepts a bare host and retries DOM for the new page.
    const tabCount = await page.getByTestId("human-tab").count();
    await page.getByRole("button", { name: "Edit address", exact: true }).click();
    await page.getByTestId("address-input").fill(fixture.origin.replace("http://", ""));
    await page.getByTestId("address-input").press("Enter");
    await expect(mirror).toHaveAttribute("data-painted", "1");
    await expect(inner.locator("#heading")).toHaveText("Crisp local text");
    expect(await page.getByTestId("human-tab").count()).toBe(tabCount);
    await checkRenderingStatus(page, "dom", "06-navigation-recovers-dom");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByTestId("streamed-pane-frame")).toBeVisible();

    // Five first-paint trials per transport. Local fixture results are not a
    // claim about every site; pixel first-frame and DOM first-document differ.
    const firstPaint: Record<string, number[]> = { dom: [], pixels: [] };
    for (const mode of ["pixels", "dom"] as const) {
      await page.evaluate(mode => localStorage.setItem("pistachio.browse.renderer", mode), mode);
      measuredMode = mode;
      traffic[mode] = { socket: 0, assets: 0 };
      for (let trial = 0; trial < 5; trial += 1) {
        const at = performance.now();
        await open(`${fixture.origin}/?trial=${mode}-${trial}`);
        const current = page.locator(mode === "dom" ? "[data-mirror-pane]" : "[data-streamed-pane]");
        await expect(current).toHaveAttribute("aria-label", `Asset fixture — ${fixture.origin}/?trial=${mode}-${trial}`);
        if (mode === "dom") {
          await expect(current).toHaveAttribute("data-painted", "1");
          await expect(current.frameLocator("iframe").locator("#heading")).toHaveText("Crisp local text");
        } else await expect(page.getByTestId("streamed-pane-frame")).toBeVisible();
        firstPaint[mode]!.push(performance.now() - at);
      }
      if (mode === "pixels") await expect.poll(() => page.getByTestId("streamed-pane-frame").evaluate(el => {
        const image = el as HTMLImageElement;
        const pane = image.closest("[data-streamed-pane]")!.getBoundingClientRect();
        return Math.abs(image.naturalWidth / image.naturalHeight - pane.width / pane.height);
      })).toBeLessThan(0.02);
      else await expect.poll(() => page.locator("[data-mirror-pane]").frameLocator("iframe").locator("#heading").evaluate(() =>
        [...document.fonts].some(font => font.family === "MirrorFont" && font.status === "loaded"))).toBe(true);
      await page.screenshot({ path: `${SHOTS}/07-${mode}-comparison.png`, fullPage: true });
      // New tabs use their own renderer, with explicit pixels distinguished from fallback.
      await checkRenderingStatus(page, mode, `07-${mode}-status`);
    }
    // Returning to an older fallback tab must not retain the new tab's DOM label.
    await page.getByTestId("human-tab").filter({ hasText: "Embedded fixture" }).click();
    await expect(page.getByTestId("streamed-pane-frame")).toBeVisible();
    await checkRenderingStatus(page, "fallback", "08-returned-fallback-status");
    await page.getByTestId("human-tab").filter({ hasText: "Asset fixture" }).last().click();
    await expect(page.locator("[data-mirror-pane]")).toHaveAttribute("data-painted", "1");
    for (const id of ["logo", "blob"]) await expect.poll(() => page.locator("[data-mirror-pane]").frameLocator("iframe").locator(`#${id}`).evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
    await checkRenderingStatus(page, "dom", "09-returned-dom-status");
    const result = { latencyEachWayMs: 200, localInputToAnimationFrameMs: samples, firstPaintMs: firstPaint, receivedBytes: traffic };
    await writeFile(`${SHOTS}/measurements.json`, JSON.stringify(result, null, 2));
    console.log("Mirror measurements:", JSON.stringify(result));
    expect(errors).toEqual([]);
  } catch (error) { if (stack) console.error(stack.logs().web.slice(-6000)); throw error; }
  finally { timers.forEach(clearTimeout); await stack?.close(); await fixture.close(); await cdn.close(); }
});
