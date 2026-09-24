import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { startFixture, type FixtureServer } from "../../../../services/cloud-browser/test/helpers/fixture-server.js";
import { chromiumPath, openBrowseShell, openNewTab, signUpInTab, startWebStack, walkFirstRun, type WebStack } from "./web-harness";

/**
 * The live DOM mirror end to end (docs/web-browser-design.md §16).
 *
 * The same real stack `web-browse.spec.ts` walks — control on PGlite, a real
 * Chromium worker, the browser app as `next dev` — but with the DOM mirror
 * turned on (`NEXT_PUBLIC_PISTACHIO_DOM_MIRROR=1`). What this proves is the
 * thing the screencast can never do: the pane is a real document. So the
 * fixture's heading is asserted as TEXT inside the pane's own iframe, not as
 * pixels, and typing into the mirrored field reaches the cloud page and comes
 * back to the fixture — input by node identity, the round trip §16 describes.
 */

const PASSWORD = "correct-horse-battery";
const TYPED = "typed into the mirror";
const SCREENSHOTS = "e2e/screenshots/web-mirror";

async function openTab(page: Page, url: string): Promise<void> {
  const address = await openNewTab(page);
  await address.fill(url);
  await address.press("Enter");
}

test("the web app mirrors a cloud tab's document and takes typed input", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  const consoleMessages: string[] = [];
  page.on("console", message => consoleMessages.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", error => errors.push(error.message));
  const chromium = chromiumPath();
  test.skip(chromium === null, "no Chromium build is available for the cloud browser");

  const typed: string[] = [];
  const fixture: FixtureServer = await startFixture((request, response, body) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (request.method === "POST" && url.pathname === "/note") {
      typed.push(new URLSearchParams(body.toString()).get("note") ?? "");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Saved</title><p>saved</p>");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><html><head><title>Mirror fixture</title>
<style>#heading{color:rgb(12,34,56)}</style></head>
<body style="margin:0;font-family:system-ui">
<h1 id="heading">Mirror me exactly</h1>
<form method="post" action="/note">
  <input id="note" name="note" aria-label="note" />
  <button id="save" type="submit">Save</button>
</form>
</body></html>`,
    );
  });

  let stack: WebStack | null = null;
  try {
    stack = await startWebStack({
      chromium,
      name: "web-mirror",
      allowedOrigins: [fixture.origin],
      webEnv: { NEXT_PUBLIC_PISTACHIO_DOM_MIRROR: "1" },
    });
    const { webUrl } = stack;

    const email = `mirror-${randomUUID().slice(0, 8)}@example.com`;
    await signUpInTab(page, { webUrl, email, password: PASSWORD });
    await openBrowseShell(page);
    await walkFirstRun(page, "Browse");
    expect(errors).toEqual([]);
    await page.screenshot({ path: `${SCREENSHOTS}/01-shell-open.png`, fullPage: true });

    await openTab(page, fixture.origin);

    // The pane is a DOM mirror, not a screencast: it announces itself with the
    // mirror test id and paints when the document arrives.
    const pane = page.getByRole("region", { name: /Mirror fixture/u });
    await expect(pane).toBeVisible({ timeout: 60_000 });
    const mirrorPane = page.locator("[data-mirror-pane]");
    await expect(mirrorPane).toHaveAttribute("data-painted", "1", { timeout: 60_000 });
    await page.screenshot({ path: `${SCREENSHOTS}/02-mirror-painted.png`, fullPage: true });

    // The proof the screencast could never give: the heading is real, selectable
    // TEXT inside the pane's own iframe, and the stylesheet came across with it.
    await expect(mirrorPane.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
    const inner = mirrorPane.frameLocator("iframe");
    await expect(inner.locator("#heading")).toHaveText("Mirror me exactly", { timeout: 30_000 });
    const color = await inner.locator("#heading").evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(12, 34, 56)");
    await inner.locator("#heading").click({ button: "right" });
    await expect(page.getByTestId("pane-context-menu")).toBeVisible();
    const headingBox = await inner.locator("#heading").boundingBox();
    const menuBox = await page.getByTestId("pane-context-menu").boundingBox();
    expect(Math.abs(menuBox!.x - (headingBox!.x + headingBox!.width / 2))).toBeLessThan(2);
    expect(Math.abs(menuBox!.y - (headingBox!.y + headingBox!.height / 2))).toBeLessThan(2);
    await page.screenshot({ path: `${SCREENSHOTS}/02-context-menu.png`, fullPage: true });
    await inner.locator("#note").click();
    await expect(page.getByTestId("pane-context-menu")).toBeHidden();

    // Typing into the mirrored field reaches the cloud page and the fixture,
    // then the mirrored button submits the form.
    await inner.locator("#note").click({ timeout: 30_000 });
    await page.keyboard.type(TYPED, { delay: 20 });
    await page.screenshot({ path: `${SCREENSHOTS}/03-typed.png`, fullPage: true });
    await inner.locator("#save").click({ timeout: 30_000 });
    await expect
      .poll(() => typed, { timeout: 60_000, message: "the fixture never received the typed note" })
      .toContain(TYPED);
    await page.screenshot({ path: `${SCREENSHOTS}/04-submitted.png`, fullPage: true });
    expect(errors).toEqual([]);
  } catch (error) {
    console.error("Browser diagnostics:", consoleMessages.join("\n"), errors);
    if (stack !== null) {
      const logs = stack.logs();
      console.error("web log:\n", logs.web.slice(-4000));
    }
    throw error;
  } finally {
    await stack?.close();
    await fixture.close();
  }
});
