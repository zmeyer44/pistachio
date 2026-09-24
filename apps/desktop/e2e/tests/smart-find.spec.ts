import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { findPage, pageFirst, shellPage } from "./windows";

/**
 * Smart find, end to end in the real app (docs/smart-find.md): the shortcut,
 * the bar's pause, the IPC hop, the controller's session, the page scripts
 * in the tab's isolated world, the real ranking and policy — over a SCRIPTED
 * model (PISTACHIO_FIND_SCRIPT, @pistachio/smart-find/scripted), because what
 * is under test is find in page, not a model's opinion. The model's own
 * accuracy is measured live in packages/smart-find/test/smart-find.live.test.ts.
 */

const SCRIPT = {
  "how do I get my money back": ["refund"],
  "how long things take": ["days"],
  "money back guarantee": ["refund"],
  "something this page never says": [],
};

// The CSP refuses inline styles too, so the page's height comes from an empty <pre>.
const PAGE = `<!doctype html><html><head><title>Orchard terms</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'none'">
</head><body>
<h1>Terms of the Orchard storage service</h1>
<p>Welcome to the store. We sell nuts of every kind and ship them everywhere.</p>
<p>Shipping takes three to five days. Damaged parcels are replaced free of charge.</p>
<pre>${"\n".repeat(200)}</pre>
<p id="refunds">We value every customer. Refunds are issued to the original card within five working days. Contact support for anything else.</p>
<p>Our founders started the company in a garage a long time ago.</p>
</body></html>`;

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find((candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")));
}

/** What the tab's own document shows: the highlighted text per layer, and how far it has scrolled. */
const pageState = (app: ElectronApplication, origin: string) =>
  app.evaluate(async ({ webContents }, url) => {
    const tab = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(url));
    if (tab === undefined) throw new Error("The test tab is unavailable");
    return tab.executeJavaScript(`(() => {
      const layer = (name) => [...(CSS.highlights.get(name) ?? [])].map((range) => range.toString().replace(/\\s+/g, " ").trim());
      return {
        match: layer("pistachio-find-match"),
        focus: layer("pistachio-find-focus"),
        active: layer("pistachio-find-active"),
        scrollY: Math.round(scrollY),
        styles: document.querySelectorAll("style").length,
      };
    })()`) as Promise<{ match: string[]; focus: string[]; active: string[]; scrollY: number; styles: number }>;
  }, origin);

test("find by meaning lands on the passage a description means, steps, clears, and stays off when switched off", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const userData = await mkdtemp(join(tmpdir(), "pistachio-smart-find-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst()));
  const app: ElectronApplication = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData, PISTACHIO_FIND_SCRIPT: JSON.stringify(SCRIPT) },
  });

  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await shell.evaluate(async (url) => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      const snapshot = await api.getSnapshot();
      if (snapshot.activeTabId === null) throw new Error("No active tab");
      await api.navigate(snapshot.activeTabId, url);
    }, `${origin}/terms`);
    await expect.poll(() => pageState(app, origin).then((state) => state.scrollY).catch(() => -1)).toBe(0);

    // The shortcut opens the bar already finding by meaning, and says what that sends.
    await shell.keyboard.press("Meta+Alt+f");
    const find = await findPage(app);
    const bar = find.locator("[data-find-mode]");
    await expect(bar).toHaveAttribute("data-find-mode", "smart");
    const input = find.getByRole("textbox", { name: "Find by meaning" });
    await expect(input).toBeFocused();
    await expect(find.getByTestId("find-detail")).toContainText("sends this page's text");

    // A description sharing no word with its answer: asked after the pause,
    // the paragraph is painted, its key sentence brightened, the page scrolled.
    await input.fill("how do I get my money back");
    await expect(bar).toHaveAttribute("data-smart-status", "done");
    await expect(find.getByTestId("find-count")).toHaveText("1 / 1");
    await expect(find.getByTestId("find-detail")).toHaveText("Refunds are issued to the original card within five working days.");
    await expect.poll(() => pageState(app, origin).then((state) => state.active)).toEqual(["Refunds are issued to the original card within five working days."]);
    const landed = await pageState(app, origin);
    expect(landed.match).toEqual(["We value every customer. Refunds are issued to the original card within five working days. Contact support for anything else."]);
    await expect.poll(() => pageState(app, origin).then((state) => state.scrollY)).toBeGreaterThan(1000);
    // Nothing was added to the page's DOM — and its CSP would have refused a <style> anyway.
    expect(landed.styles).toBe(0);
    await find.screenshot({ path: "e2e/screenshots/smart-find-match.png" });
    // The tab is a native view the shell's screenshot cannot see: capture it directly.
    const capture = await app.evaluate(async ({ webContents }, url) => {
      const tab = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(url))!;
      return (await tab.capturePage()).toPNG().toString("base64");
    }, origin);
    await writeFile("e2e/screenshots/smart-find-page.png", Buffer.from(capture, "base64"));

    // Two matches: ↵ steps, ⇧↵ steps back, and the page follows.
    await input.fill("how long things take");
    await expect(find.getByTestId("find-count")).toHaveText("1 / 2");
    await input.press("Enter");
    await expect(find.getByTestId("find-count")).toHaveText("2 / 2");
    await input.press("Shift+Enter");
    await expect(find.getByTestId("find-count")).toHaveText("1 / 2");

    // Nothing on the page: said plainly, and nothing painted.
    await input.fill("something this page never says");
    await expect(find.getByTestId("find-detail")).toHaveText("Nothing on this page matches.");
    expect((await pageState(app, origin)).match).toEqual([]);

    // Escape takes everything down.
    await input.fill("how do I get my money back");
    await expect(find.getByTestId("find-count")).toHaveText("1 / 1");
    await input.press("Escape");
    await expect.poll(() => pageState(app, origin).then((state) => state.match.length + state.active.length)).toBe(0);

    // The ordinary find, finding nothing for a description, offers the other way — and ↵ takes it.
    await shell.keyboard.press("Meta+f");
    const exact = find.getByRole("textbox", { name: "Find in page" });
    await expect(exact).toBeFocused();
    await exact.fill("money back guarantee");
    await expect(find.getByTestId("find-offer-smart")).toBeVisible();
    await find.screenshot({ path: "e2e/screenshots/smart-find-offer.png" });
    await exact.press("Enter");
    await expect(bar).toHaveAttribute("data-find-mode", "smart");
    await expect(find.getByTestId("find-count")).toHaveText("1 / 1");
    // Tab goes back to exact words, and the highlights come down.
    await find.getByRole("textbox", { name: "Find by meaning" }).press("Tab");
    await expect(bar).toHaveAttribute("data-find-mode", "exact");
    await expect.poll(() => pageState(app, origin).then((state) => state.match.length)).toBe(0);
    await find.getByRole("textbox", { name: "Find in page" }).press("Escape");

    // The setting off: the shortcut opens a plain find, with no way into the other.
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.updateSettings({ search: { smartFind: false } }));
    await shell.keyboard.press("Meta+Alt+f");
    await expect(bar).toHaveAttribute("data-find-mode", "exact");
    await expect(find.getByTestId("find-mode-toggle")).toHaveCount(0);
    await find.getByRole("textbox", { name: "Find in page" }).fill("money back guarantee");
    await expect(find.getByTestId("find-offer-smart")).toHaveCount(0);
  } finally {
    await app.close();
    server.closeAllConnections();
    server.close();
    // These profiles pile up in $TMPDIR otherwise, on a disk with little room.
    await rm(userData, { recursive: true, force: true });
  }
});
