import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { KeyboardInputEvent } from "electron";
import { bookmarkToastPage, pageFirst, shellReady } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/bookmarks");

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find((candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")));
}

/** A 1×1 PNG: enough for an <img> to load and the card to show a picture. */
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** A listing the way a store writes one: an SEO title, Open Graph, and a JSON-LD Product. */
function productHtml(origin: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Shop: Breville Barista Express Espresso Machine, Brushed Stainless Steel : Kitchen</title>
<meta property="og:site_name" content="Shop">
<meta property="og:type" content="product">
<meta property="og:title" content="Breville Barista Express Espresso Machine">
<meta property="og:description" content="Grind, dose, tamp, and extract café-quality espresso at home.">
<meta property="og:image" content="${origin}/hero.png">
<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Breville Barista Express Espresso Machine",
    brand: { "@type": "Brand", name: "Breville" },
    image: [`${origin}/hero.png`],
    offers: { "@type": "Offer", price: "699.95", priceCurrency: "USD", availability: "https://schema.org/InStock" },
    aggregateRating: { "@type": "AggregateRating", ratingValue: "4.6", reviewCount: "22041" },
  })}</script>
</head><body><h1>Breville Barista Express Espresso Machine</h1>
<img src="/hero.png" width="600" height="450" alt="">
<p>Grind, dose, tamp, and extract café-quality espresso at home with an integrated conical burr grinder.</p>
</body></html>`;
}

function recipeHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Cacio e Pepe Recipe | Kitchen Notes</title>
<meta property="og:site_name" content="Kitchen Notes">
<meta name="description" content="Three ingredients and one pan of starchy pasta water.">
<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: "Cacio e Pepe",
    totalTime: "PT20M",
    recipeYield: "2 servings",
    recipeCuisine: "Italian",
    author: { "@type": "Person", name: "Priya" },
  })}</script>
</head><body><h1>Cacio e Pepe</h1><p>Boil the pasta. Toss with pecorino and pepper.</p></body></html>`;
}

async function serve(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
    if (request.url === "/hero.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(PIXEL);
      return;
    }
    if (request.url?.startsWith("/recipe") === true) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(recipeHtml());
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(productHtml(origin));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  return { server, origin: `http://127.0.0.1:${String(port)}` };
}

function activeUrl(shell: Page): Promise<string | null> {
  return shell.evaluate(async () => {
    const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
    const current = await api.getSnapshot();
    return current.tabs.find((tab) => tab.id === current.activeTabId)?.url ?? null;
  });
}

async function pageAt(app: ElectronApplication, url: string): Promise<Page> {
  await expect.poll(() => app.windows().some((page) => page.url() === url)).toBe(true);
  const page = app.windows().find((candidate) => candidate.url() === url);
  if (page === undefined) throw new Error(`No Electron page at ${url}`);
  return page;
}

/**
 * Two taps of shift in a tab's page, as the OS delivers them. Playwright's
 * own keyboard drives the renderer over CDP and never passes through
 * Electron's before-input-event, where the gesture is read, so the taps go
 * in through the WebContents like real key presses do.
 */
async function tapShiftTwice(app: ElectronApplication, url: string): Promise<void> {
  await nativeKeys(app, url, [
    { type: "keyDown", keyCode: "Shift" },
    { type: "keyUp", keyCode: "Shift" },
    { type: "keyDown", keyCode: "Shift" },
    { type: "keyUp", keyCode: "Shift" },
  ]);
}

/** Wait until main has observed every input before asserting absence of a save. */
async function nativeKeys(app: ElectronApplication, url: string, inputs: KeyboardInputEvent[]): Promise<void> {
  await app.evaluate(async ({ webContents }, { target, inputs }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === target);
    if (contents === undefined) throw new Error(`no view at ${target}`);
    contents.focus();
    await new Promise<void>((resolve) => {
      let remaining = inputs.length;
      const observed = (): void => {
        remaining -= 1;
        if (remaining !== 0) return;
        contents.removeListener("before-input-event", observed);
        resolve();
      };
      contents.on("before-input-event", observed);
      for (const input of inputs) contents.sendInputEvent(input);
    });
  }, { target: url, inputs });
}

/** Shift held while a letter is typed: a capital, not the gesture. */
async function typeCapital(app: ElectronApplication, url: string, letter: string): Promise<void> {
  await app.evaluate(({ webContents }, { target, key }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === target);
    if (contents === undefined) throw new Error(`no tab at ${target}`);
    contents.sendInputEvent({ type: "keyDown", keyCode: "Shift" });
    contents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers: ["shift"] });
    contents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers: ["shift"] });
    contents.sendInputEvent({ type: "keyUp", keyCode: "Shift" });
  }, { target: url, key: letter });
}

/** A chrome page as it renders — the card's own view, or the shell with the bookmarks page up. */
async function snapshot(page: Page, name: string): Promise<void> {
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: join(screenshotDirectory, `${name}.png`) });
}

/** Where main placed the card's view: the active pane's bottom-right corner. */
function bookmarkViewBounds(app: ElectronApplication): Promise<{ x: number; y: number; width: number; height: number; pane: { x: number; y: number; width: number; height: number } | null }> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("no window");
    const views = window.contentView.children;
    const card = views.find((view) => "webContents" in view && (view as { webContents: { getURL(): string } }).webContents.getURL().endsWith("#bookmark"));
    const pane = views.find((view) => "webContents" in view && /^https?:/.test((view as { webContents: { getURL(): string } }).webContents.getURL()));
    if (card === undefined) throw new Error("no bookmark view");
    return { ...card.getBounds(), pane: pane === undefined ? null : pane.getBounds() };
  });
}

test("bookmark gesture requires two completed, uninterrupted Shift taps", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const { server, origin } = await serve();
  const userData = await mkdtemp(join(tmpdir(), "pistachio-bookmark-gesture-"));
  const listing = `${origin}/coffee`;
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst({ general: { homeUrl: listing } })));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  const down = (keyCode = "Shift", modifiers: KeyboardInputEvent["modifiers"] = []): KeyboardInputEvent => ({ type: "keyDown", keyCode, modifiers });
  const up = (keyCode = "Shift", modifiers: KeyboardInputEvent["modifiers"] = []): KeyboardInputEvent => ({ type: "keyUp", keyCode, modifiers });

  try {
    const shell = await shellReady(app);
    const toastView = await bookmarkToastPage(app);
    const page = await pageAt(app, listing);
    const state = () => shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      return { bookmarks: (await api.getBookmarks()).bookmarks, toast: await api.getBookmarkToast() };
    });
    await expect(page.locator("h1")).toHaveText("Breville Barista Express Espresso Machine");
    await snapshot(page, "gesture-01-ready");

    // A standalone tap followed by typing was incorrectly saved on the second key-down.
    // Exercise the native page and shell routes, including keys held before Shift.
    for (const url of [listing, shell.url()]) {
      for (const inputs of [
        [down(), up(), down(), down("A", ["shift"]), up("A", ["shift"]), up()],
        [down("a"), down(), up(), down(), up(), up("a")],
        [down(), up(), down("a"), up("a"), down(), up(), up("a")],
        [down(), up(), down(), down("Meta", ["meta", "shift"]), up("Meta", ["shift"]), up()],
      ]) {
        await nativeKeys(app, url, inputs);
        expect(await state()).toEqual({ bookmarks: [], toast: null });
      }
    }
    await snapshot(page, "gesture-02-no-accidental-save");

    // Even a valid-looking second press must wait for its clean release.
    await page.evaluate(() => {
      document.body.dataset["shiftReleases"] = "0";
      document.addEventListener("keyup", (event) => {
        if (event.key === "Shift") document.body.dataset["shiftReleases"] = String(Number(document.body.dataset["shiftReleases"]) + 1);
      });
    });
    await nativeKeys(app, listing, [down(), up(), down()]);
    expect(await state()).toEqual({ bookmarks: [], toast: null });
    await nativeKeys(app, listing, [up()]);
    const toast = toastView.getByTestId("bookmark-toast");
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute("data-status", "ready");
    expect((await state()).bookmarks).toHaveLength(1);
    await expect(page.locator("body")).toHaveAttribute("data-shift-releases", "2");
    await snapshot(toastView, "gesture-03-clean-taps-saved");

    // A window blur cancels the gesture even if the next tap arrives immediately.
    await toastView.getByTestId("bookmark-toast-dismiss").click();
    await expect(toast).toBeHidden();
    await nativeKeys(app, listing, [down(), up()]);
    await app.evaluate(({ BrowserWindow }) => {
      // Deliver the native lifecycle notification without an OS focus animation
      // accidentally making this a timeout test instead of a reset test.
      BrowserWindow.getAllWindows()[0]!.emit("blur");
    });
    await nativeKeys(app, listing, [down(), up()]);
    expect((await state()).toast).toBeNull();
    await snapshot(page, "gesture-04-blur-cancelled");
  } finally {
    await app.close();
    server.close();
  }
});

test("shift, shift saves the thing on the page; the card fills in; the page lists it", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const { server, origin } = await serve();
  const userData = await mkdtemp(join(tmpdir(), "pistachio-bookmarks-"));
  const listing = `${origin}/coffee`;
  // The first tab opens on the listing: no trip through the web first, and
  // no error banner (a failed home page) veiling the card over the page.
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst({ general: { homeUrl: listing } })), "utf8");
  const app: ElectronApplication = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });

  try {
    const shell = await shellReady(app);
    const toastView = await bookmarkToastPage(app);
    await toastView.waitForLoadState("domcontentloaded");

    await expect.poll(async () => activeUrl(shell)).toBe(listing);
    const page = await pageAt(app, listing);
    await expect(page.locator("h1")).toHaveText("Breville Barista Express Espresso Machine");

    // The gesture, in the page itself.
    await tapShiftTwice(app, listing);

    const toast = toastView.getByTestId("bookmark-toast");
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute("data-status", "ready");
    await expect(toast).toContainText("Breville Barista Express Espresso Machine");
    await expect(toast).toContainText("Product");
    await expect(toast).toContainText("$699.95");
    await expect(toast).toContainText("From the page's own tags");
    await snapshot(toastView, "card");

    // The card's view sits at the pane's bottom-right corner, sized to the card.
    const placed = await bookmarkViewBounds(app);
    expect(placed.pane).not.toBeNull();
    expect(placed.width).toBe(400);
    expect(placed.x + placed.width).toBeLessThanOrEqual(placed.pane!.x + placed.pane!.width);
    expect(placed.y + placed.height).toBeLessThanOrEqual(placed.pane!.y + placed.pane!.height);
    expect(placed.height).toBeGreaterThan(100);

    // The address is kept clean, and the facts with it.
    const saved = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      return (await api.getBookmarks()).bookmarks;
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      url: listing,
      kind: "product",
      title: "Breville Barista Express Espresso Machine",
      siteName: "Shop",
      imageUrl: `${origin}/hero.png`,
      provenance: "page",
      status: "ready",
    });
    expect(saved[0]?.details).toEqual(expect.arrayContaining([{ label: "Price", value: "$699.95" }, { label: "Brand", value: "Breville" }]));
    expect(saved[0]?.keywords).toEqual(expect.arrayContaining(["breville", "product", "espresso"]));

    // A field fixed from the card.
    await toastView.getByTestId("bookmark-toast-edit").click();
    const editor = toastView.getByTestId("bookmark-editor");
    await expect(editor).toBeVisible();
    await editor.getByLabel("Title").fill("The espresso machine");
    await editor.getByLabel("Note").fill("for the office kitchen");
    await toastView.getByTestId("bookmark-editor-save").click();
    await expect(editor).toBeHidden();
    await expect(toast).toContainText("The espresso machine");

    // A second tap on a saved page shows the card again, not a twin.
    await toastView.getByTestId("bookmark-toast-dismiss").click();
    await expect(toast).toBeHidden();
    await tapShiftTwice(app, listing);
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute("data-existed", "true");
    await expect(toast).toContainText("Saved earlier");
    await toastView.getByTestId("bookmark-toast-dismiss").click();

    // Typing capitals is not the gesture, however quickly.
    await typeCapital(app, listing, "A");
    await typeCapital(app, listing, "B");
    await expect(toast).toBeHidden();

    // The recipe is opened in a tab before it is saved. A save by address
    // alone reads the page over the network, and that read refuses private
    // hosts by design (browser-controller vetUrl: SSRF and DNS rebinding) —
    // which is every address this fixture server can be reached at. With the
    // tab open the save still comes from the bookmarks page's address field
    // rather than the gesture, and the card fills in from the live page.
    await shell.evaluate(
      async (url) => {
        const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
        await api.createTab(url);
      },
      `${origin}/recipe`,
    );
    await expect.poll(async () => activeUrl(shell)).toBe(`${origin}/recipe`);

    // The page: the card in the grid, the search, the detail.
    await shell.keyboard.press("Meta+Shift+B");
    const bookmarks = shell.getByTestId("bookmarks-page");
    await expect(bookmarks).toBeVisible();
    await expect(bookmarks.getByTestId("bookmark-card")).toHaveCount(1);
    await expect(bookmarks.getByTestId("bookmark-card")).toContainText("The espresso machine");

    // A second save, by address rather than by the gesture.
    await bookmarks.getByTestId("new-bookmark").click();
    await bookmarks.getByLabel("Address to bookmark").fill(`${origin}/recipe`);
    await bookmarks.getByTestId("bookmark-add-submit").click();
    await expect(bookmarks.getByTestId("bookmark-card")).toHaveCount(2);
    const recipe = bookmarks.locator('[data-testid="bookmark-card"][data-kind="recipe"]');
    await expect(recipe).toHaveAttribute("data-status", "ready");
    await expect(recipe).toContainText("Cacio e Pepe");
    await expect(recipe).toContainText("20m");

    await bookmarks.getByTestId("bookmark-search").fill("pasta italian");
    await expect(bookmarks.getByTestId("bookmark-card")).toHaveCount(1);
    await bookmarks.getByTestId("bookmark-search").fill("office espresso");
    await expect(bookmarks.getByTestId("bookmark-card")).toHaveCount(1);
    await expect(bookmarks.getByTestId("bookmark-card")).toContainText("The espresso machine");
    await bookmarks.getByTestId("bookmark-search").fill("");
    await bookmarks.getByRole("tab", { name: /Recipes/ }).click();
    await expect(bookmarks.getByTestId("bookmark-card")).toHaveCount(1);
    await bookmarks.getByRole("tab", { name: /All/ }).click();

    await bookmarks.getByTestId("bookmark-card").first().click();
    const detail = bookmarks.getByTestId("bookmark-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("Cacio e Pepe");
    await expect(detail).toContainText("Total time");
    await snapshot(shell, "page");

    // Escape closes the detail, then the page.
    await shell.keyboard.press("Escape");
    await expect(detail).toBeHidden();
    await shell.keyboard.press("Escape");
    await expect(bookmarks).toBeHidden();
  } finally {
    await app.close();
    server.close();
  }
});
