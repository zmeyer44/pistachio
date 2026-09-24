import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { startFixture } from "../../../../services/cloud-browser/test/helpers/fixture-server.js";
import { chromiumPath, openBrowseShell, openNewTab, signUpInTab, startWebStack, walkFirstRun, type WebStack } from "./web-harness";

// Journey: idle timeline stays DOM; click queues typing until remote focus;
// pixels preserve the draft; paste/IME commit once; blur/retry restores DOM;
// keyboard traversal uses the same handoff.
test("idle composers mirror and acknowledged editor handoff preserves typing, paste and composition", async ({ page }) => {
  test.setTimeout(180_000); page.setDefaultTimeout(15_000);
  const chromium = chromiumPath(); test.skip(!chromium, "Chromium required");
  let draft = "";
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const fixture = await startFixture((request, response, body) => {
    if (request.url === "/draft") { draft = body.toString(); response.end("ok"); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Composer fixture</title><style>body{font:20px system-ui;padding:32px}#composer{min-height:120px;border:1px solid #ccc;padding:16px}h1{color:#126454}</style>
      <h1>Timeline beside an idle composer</h1><button id="read">Read timeline</button>
      <div id="composer" contenteditable role="textbox" aria-label="Composer"></div>
      <p>Reading stays in DOM mode. Editing uses the cloud composer.</p>
      <script>const editor=document.querySelector('#composer');editor.addEventListener('input',()=>fetch('/draft',{method:'POST',body:editor.textContent}));
      let ticks=0;const timer=setInterval(()=>{history.replaceState({},'',location.href);if(++ticks===30)clearInterval(timer)},100);</script>`);
  });
  let acknowledge: (() => void) | undefined;
  let delayAck = true;
  await page.routeWebSocket(/\/v1\/shell\//u, route => {
    const server = route.connectToServer(); route.onMessage(message => server.send(message));
    server.onMessage(message => {
      if (typeof message === "string" && delayAck) {
        const frame = JSON.parse(message);
        if (frame.t === "mirror" && frame.msg.k === "editorFocused") { acknowledge = () => route.send(message); return; }
      }
      route.send(message);
    });
  });
  const openMenu = async () => { await page.getByTestId("sidebar-menu-button").press("Escape"); await page.getByTestId("sidebar-menu-button").click(); };
  const shots = "e2e/screenshots/web-editor";
  let stack: WebStack | null = null;
  try {
    stack = await startWebStack({ chromium, name: "web-editor", allowedOrigins: [fixture.origin], webEnv: { NEXT_PUBLIC_PISTACHIO_DOM_MIRROR: "1" } });
    await signUpInTab(page, { webUrl: stack.webUrl, email: `editor-${randomUUID()}@example.com`, password: "correct-horse-battery" });
    await openBrowseShell(page); await walkFirstRun(page, "Browse");
    const address = await openNewTab(page); await address.fill(fixture.origin); await address.press("Enter");
    const mirror = page.locator("[data-mirror-pane]"); const inner = mirror.frameLocator("iframe");
    const composer = inner.getByRole("textbox", { name: "Composer", exact: true });
    await expect(inner.getByRole("heading")).toHaveText("Timeline beside an idle composer");
    expect(await composer.evaluate(el => (el as HTMLElement).isContentEditable)).toBe(false);
    await page.screenshot({ path: `${shots}/01-idle-dom.png`, animations: "disabled" });

    // Hold the real cloud acknowledgement while typing; no text may leak early.
    await composer.click();
    const input = page.getByTestId("cloud-editor-input"); await expect(input).toBeFocused();
    await page.keyboard.type("Hello during handoff");
    await expect.poll(() => Boolean(acknowledge)).toBe(true); expect(draft).toBe(""); await expect(input).toBeFocused();
    await page.screenshot({ path: `${shots}/02-pending-handoff.png`, animations: "disabled" });
    delayAck = false; acknowledge!();
    await expect(page.getByTestId("streamed-pane-frame")).toBeVisible();
    await expect.poll(() => draft).toBe("Hello during handoff");
    await expect(input).toBeFocused();

    // Native paste and composition use one insertion each, including Unicode.
    await input.evaluate(el => { const data = new DataTransfer(); data.setData("text/plain", " — pasted"); el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data })); });
    await input.evaluate(el => {
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      (el as HTMLTextAreaElement).value = " 日本語";
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: " 日本語", isComposing: true }));
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: " 日本語" }));
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: " 日本語" }));
    });
    await expect.poll(() => draft).toBe("Hello during handoff — pasted 日本語");
    await openMenu(); await expect(page.getByTestId("browser-rendering-reason")).toContainText("rich text editor is active");
    await page.screenshot({ path: `${shots}/03-pixel-draft.png`, animations: "disabled" });

    // Blur remotely with a click in the pixel view, then retry the same page.
    await page.getByTestId("sidebar-menu-button").press("Escape");
    const frame = page.getByTestId("streamed-pane-frame"); await frame.click({ position: { x: 100, y: 130 } });
    await openMenu(); await page.getByRole("button", { name: "Retry DOM mirroring", exact: true }).click();
    await expect(composer).toHaveText("Hello during handoff — pasted 日本語");
    await page.getByTestId("sidebar-menu-button").press("Escape");
    // A click at the end of the draft must preserve that caret in the cloud.
    await composer.click({ position: { x: 650, y: 24 } });
    await expect(input).toBeFocused(); await page.keyboard.type(" END");
    await expect.poll(() => draft).toBe("Hello during handoff — pasted 日本語 END");
    await page.getByTestId("streamed-pane-frame").click({ position: { x: 100, y: 130 } });
    await openMenu(); await page.getByRole("button", { name: "Retry DOM mirroring", exact: true }).click();
    await expect(composer).toBeVisible();
    await page.getByTestId("sidebar-menu-button").press("Escape");
    await inner.getByRole("button", { name: "Read timeline" }).focus();
    await page.keyboard.press("Tab");
    await expect(input).toBeFocused(); await page.keyboard.type("!");
    await expect.poll(() => draft).toContain("!");
    await page.screenshot({ path: `${shots}/04-keyboard-handoff.png`, animations: "disabled" });
    // A missing acknowledgement preserves the draft locally and sends nothing.
    await page.getByTestId("streamed-pane-frame").click({ position: { x: 100, y: 130 } });
    await openMenu(); await page.getByRole("button", { name: "Retry DOM mirroring", exact: true }).click();
    await expect(composer).toBeVisible();
    await page.getByTestId("sidebar-menu-button").press("Escape");
    delayAck = true; acknowledge = undefined;
    const previousDraft = draft;
    await composer.click(); await expect(input).toBeFocused();
    await page.keyboard.type("Unsent draft");
    await expect(page.getByRole("textbox", { name: "Unsent editor text", exact: true })).toHaveValue("Unsent draft", { timeout: 12_000 });
    await expect(input).toBeDisabled(); expect(draft).toBe(previousDraft);
    await page.screenshot({ path: `${shots}/05-unsent-draft.png`, animations: "disabled" });
    expect(errors).toEqual([]);
  } finally { await stack?.close(); await fixture.close(); }
});
