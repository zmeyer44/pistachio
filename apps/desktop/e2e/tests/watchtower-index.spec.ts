import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import type {
  WatchtowerRequest,
  WatchtowerResponse,
} from "@pistachio/shell-contracts/watchtower";
import { shellReady } from "./windows";

const api = (page: Page, request: WatchtowerRequest): Promise<WatchtowerResponse> =>
  page.evaluate(
    (value) => (window as unknown as { pistachio: PistachioApi }).pistachio.watchtower(value),
    request,
  );

// Journey: opt in (the index is one of the choices) → a page that declares
// what it is about is saved → its product and brand are index entries with
// no model involved → the entry opens, and leads back to the saved page →
// forgetting the page empties the index.
test("Watchtower files a saved page under what it declares it is about", async () => {
  test.setTimeout(180000);
  const product = `<!doctype html><title>Air Runner 2 – Acme Shoes</title>
    <script type="application/ld+json">[{"@context":"https://schema.org","@type":"WebSite","name":"Acme Shop"},
    {"@context":"https://schema.org","@type":"Product","name":"Air Runner 2","brand":{"@type":"Brand","name":"Acme Shoes"}}]</script>
    <main><h1>Air Runner 2</h1><p>The Air Runner 2 is a lightweight trainer for long runs on the road.</p>
    <p>Every pair is tested for a thousand kilometres before it ships.</p></main>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(product);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture missing");
  const url = `http://127.0.0.1:${address.port}/p/air-runner-2`;
  const userData = await mkdtemp(join(tmpdir(), "watchtower-index-e2e-"));
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      cwd: process.cwd(),
      executablePath: join(process.cwd(), "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
      env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
    });
    const page = await shellReady(app);
    await page.waitForLoadState("domcontentloaded");
    // Automation cannot acquire macOS foreground ownership on every runner.
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      for (const window of BrowserWindow.getAllWindows()) {
        window.show();
        window.focus();
        window.isFocused = () => true;
      }
    });
    await expect
      .poll(async () => {
        try {
          return (await api(page, { type: "status" })).settings.enabled;
        } catch {
          return null;
        }
      })
      .not.toBeNull();

    await page.keyboard.press("Meta+L");
    await page.getByTestId("address-input").fill("watchtower");
    await page.locator('[data-testid="command-result"][data-action-id="chrome:openWatchtower"]').click();
    await expect(page.getByTestId("watchtower-onboarding")).toBeVisible();
    const index = page.getByRole("switch", { name: "Index people, companies and ideas with Jev" });
    await expect(index).toBeChecked();
    await page.getByRole("button", { name: "Enable Watchtower", exact: true }).click();
    expect((await api(page, { type: "status" })).settings.smartIndex).toBe(true);
    await page.getByRole("button", { name: "Close Watchtower", exact: true }).click();

    await page.evaluate((url) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url), url);
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0]?.focus();
    });
    await expect
      .poll(
        async () =>
          ((await api(page, { type: "entities" })).index?.entities ?? [])
            .map((entity) => `${entity.kind}:${entity.name}`)
            .sort(),
        { timeout: 20000 },
      )
      .toEqual(["company:Acme Shoes", "product:Air Runner 2"]);

    await page.keyboard.press("Meta+L");
    await page.getByTestId("address-input").fill("watchtower");
    await page.locator('[data-testid="command-result"][data-action-id="chrome:openWatchtower"]').click();
    await page.getByTestId("watchtower-view-index").click();
    await expect(page.getByTestId("watchtower-entity")).toHaveCount(2);
    await page.getByTestId("watchtower-entity").filter({ hasText: "Air Runner 2" }).click();
    const reader = page.getByTestId("watchtower-entity-reader");
    await expect(reader).toContainText("Named on 1 saved page");
    await reader.getByRole("button", { name: /Air Runner 2 – Acme Shoes/u }).click();
    const saved = page.getByTestId("watchtower-document");
    await expect(saved).toContainText("Every pair is tested for a thousand kilometres");
    // The saved page names what it is about, and leads back to it.
    await expect(saved.getByTestId("watchtower-entity-chip")).toHaveText(["Air Runner 2", "Acme Shoes"]);
    await saved.getByTestId("watchtower-entity-chip").filter({ hasText: "Acme Shoes" }).click();
    await expect(page.getByTestId("watchtower-entity-reader")).toContainText("Company");

    const pageId = (await api(page, { type: "search", query: "kilometres" })).results![0]!.pageId;
    await api(page, { type: "forget", pageId });
    expect((await api(page, { type: "entities" })).index?.entities).toEqual([]);
  } finally {
    await app?.close();
    server.close();
  }
});
