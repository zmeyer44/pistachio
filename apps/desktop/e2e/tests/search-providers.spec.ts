import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { shellReady } from "./windows";
import { launchApp } from "./app";
import { activeUrl, captureShell as captureWindow } from "./pages-harness";

/** The whole window, native page views included — the overlay and the page behind it in one picture. */
function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  return captureWindow(app, `search-providers/${filename}`, 400);
}

async function typeInAddressBar(shell: Page, text: string): Promise<void> {
  await shell.keyboard.press("Meta+L");
  const input = shell.getByTestId("address-input");
  await expect(input).toBeFocused();
  await input.fill(text);
  await expect(shell.getByTestId("command-results")).toBeVisible();
  // The veil stays transparent until main has swapped the native page view
  // for its picture; before that the rows exist but nothing shows them.
  await expect(shell.getByTestId("url-bar-veil")).toHaveAttribute("data-ready", "");
}

/**
 * Scroll a control to the middle of the settings page. A select whose trigger
 * sits clipped at the window's foot is scrolled by Playwright's click itself,
 * and that scroll lands after the list opens and dismisses it.
 */
async function centre(control: Locator): Promise<void> {
  await control.evaluate((element) => element.scrollIntoView({ block: "center" }));
}

/** Pick `label` from one of Settings' logo dropdowns, and check every choice is drawn with its mark. */
async function choose(settings: Locator, testId: string, labels: string[], label: string): Promise<void> {
  // The list is portalled to the body (the settings cards clip), so it is found from the page.
  const list = settings.page().getByTestId(`${testId}-list`);
  const button = settings.getByTestId(testId);
  await centre(button);
  await button.click();
  const options = list.getByRole("option");
  await expect(options).toHaveText(labels);
  // One logo per option: a provider added without its mark would leave a bare row.
  await expect(list.locator("svg[data-provider-logo]")).toHaveCount(labels.length);
  await options.filter({ hasText: label }).click();
  await expect(list).toHaveCount(0);
}

test("the chosen web and AI search providers drive the suggestions of the address bar and the home page", { tag: ["@address", "@home", "@settings"] }, async () => {
  test.setTimeout(90_000);
  // Default settings: the window opens on the home page, whose search is half the subject.
  const { app, userData } = await launchApp({ settings: { layout: { sidebar: "pinned" } }, name: "search-providers" });
  try {
    const shell = await shellReady(app);
    const query = `best pistachio gelato ${String(Date.now())}`;

    // ── The home page's search, on the defaults ─────────────────────────────
    const homeInput = shell.getByTestId("home-search-input");
    const homeResults = shell.getByTestId("home-search-results");
    await expect(shell.getByTestId("home-page")).toBeVisible();
    await homeInput.click();
    await homeInput.fill(query);
    const homeWeb = homeResults.locator('[data-suggestion-kind="search"]');
    const homeAi = homeResults.locator('[data-suggestion-kind="ai"]');
    await expect(homeWeb).toContainText(`Search Google for “${query}”`);
    // The home page answers a question itself (shell-ui components/home/HomeChat.tsx):
    // its AI row names Pistachio, whichever assistant Settings chose for the address bar.
    await expect(homeAi).toContainText(`Ask Pistachio “${query}”`);
    // The web row is drawn with its provider's own logo, not a generic glyph; the AI row wears the brand mark.
    await expect(homeWeb.locator('svg[data-provider-logo="google"]')).toBeVisible();
    await expect(homeAi.locator("svg[data-provider-logo]")).toHaveCount(0);
    await captureShell(app, "01-home-default-suggestions.png");
    await homeInput.fill("");

    // ── Settings → General carries the two choices, each option with its logo ─
    await shell.keyboard.press("Meta+,");
    const settings = shell.getByTestId("settings-page");
    await expect(settings.getByRole("heading", { name: "General" })).toBeVisible();
    const web = settings.getByTestId("web-search-provider");
    const ai = settings.getByTestId("ai-search-provider");
    await centre(ai);
    await expect(web).toHaveAttribute("data-value", "google");
    await expect(ai).toHaveAttribute("data-value", "chatgpt");
    await expect(web.locator('svg[data-provider-logo="google"]')).toBeVisible();
    await expect(ai.locator('svg[data-provider-logo="chatgpt"]')).toBeVisible();

    await web.click();
    await expect(shell.getByTestId("web-search-provider-list")).toBeVisible();
    await captureShell(app, "02-settings-web-list.png");
    await shell.keyboard.press("Escape");
    // Escape closed the list, not the settings page under it.
    await expect(shell.getByTestId("web-search-provider-list")).toHaveCount(0);
    await expect(settings).toBeVisible();

    await ai.click();
    // The list hangs outside its card: every option is on screen, none cut off at the card's edge.
    for (const option of await shell.getByTestId("ai-search-provider-list").getByRole("option").all()) {
      await expect(option).toBeInViewport({ ratio: 1 });
    }
    await captureShell(app, "03-settings-ai-list.png");
    await ai.click();

    // Each dropdown writes its own field: changing the second must not undo the first.
    await choose(settings, "web-search-provider", ["Google", "DuckDuckGo", "Yahoo", "Bing"], "DuckDuckGo");
    await choose(settings, "ai-search-provider", ["ChatGPT", "Gemini", "Claude", "Grok", "Perplexity"], "Claude");
    await expect
      .poll(async () => {
        const raw = await readFile(join(userData, "settings.json"), "utf8");
        return (JSON.parse(raw) as { search?: unknown }).search;
      })
      .toEqual({ webProvider: "duckduckgo", aiProvider: "claude", smartSuggestions: true, smartFind: true });
    await expect(web).toHaveAttribute("data-value", "duckduckgo");
    await expect(ai).toHaveAttribute("data-value", "claude");

    // The keyboard works it as it would a native select: ↓ opens on the value, ↓ moves, ↵ chooses.
    await web.focus();
    await shell.keyboard.press("ArrowDown");
    await shell.keyboard.press("ArrowDown");
    await shell.keyboard.press("Enter");
    await expect(web).toHaveAttribute("data-value", "yahoo");
    await choose(settings, "web-search-provider", ["Google", "DuckDuckGo", "Yahoo", "Bing"], "DuckDuckGo");
    await captureShell(app, "04-settings-chosen.png");
    await shell.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    // ── The home page's search now offers the chosen pair ───────────────────
    await homeInput.click();
    await homeInput.fill(query);
    await expect(homeWeb).toContainText(`Search DuckDuckGo for “${query}”`);
    await expect(homeAi).toContainText(`Ask Pistachio “${query}”`);
    await expect(homeWeb.locator('svg[data-provider-logo="duckduckgo"]')).toBeVisible();
    await captureShell(app, "05-home-chosen-suggestions.png");

    // A typed address still goes first there; both searches stay beneath it, logos and all.
    await homeInput.fill("github.com");
    await expect(homeResults.locator('[data-suggestion-kind="navigate"]')).toHaveAttribute("data-index", "0");
    await expect(homeWeb).toContainText("Search DuckDuckGo for “github.com”");
    await expect(homeAi).toContainText("Ask Pistachio “github.com”");
    await expect(homeWeb.locator('svg[data-provider-logo="duckduckgo"]')).toBeVisible();
    await captureShell(app, "06-home-address-with-searches.png");
    // (↵ on the home page's AI row is the chat's own journey: e2e/tests/home-chat.spec.ts.)
    await homeInput.fill("");

    // ── The address bar (⌘L) offers the same pair ───────────────────────────
    const results = shell.getByTestId("command-results");
    const webRow = results.locator('[data-suggestion-kind="search"]');
    const aiRow = results.locator('[data-suggestion-kind="ai"]');
    await typeInAddressBar(shell, query);
    await expect(webRow).toContainText(`Search DuckDuckGo for “${query}”`);
    await expect(aiRow).toContainText(`Ask Claude “${query}”`);
    await expect(webRow).toHaveAttribute("data-index", "0");
    await expect(aiRow).toHaveAttribute("data-index", "1");
    await expect(webRow.locator('svg[data-provider-logo="duckduckgo"]')).toBeVisible();
    await expect(aiRow.locator('svg[data-provider-logo="claude"]')).toBeVisible();
    await captureShell(app, "07-bar-chosen-suggestions.png");

    await shell.keyboard.press("Escape");
    await typeInAddressBar(shell, "github.com");
    await expect(results.locator('[data-suggestion-kind="navigate"]')).toHaveAttribute("data-index", "0");
    await expect(webRow).toContainText("Search DuckDuckGo for “github.com”");
    await expect(aiRow).toContainText("Ask Claude “github.com”");
    await expect(webRow.locator('svg[data-provider-logo="duckduckgo"]')).toBeVisible();
    await expect(aiRow.locator('svg[data-provider-logo="claude"]')).toBeVisible();
    await captureShell(app, "08-bar-address-with-searches.png");
    await shell.keyboard.press("Escape");

    // ↵ on prose runs the web search on the chosen engine.
    await typeInAddressBar(shell, query);
    await shell.keyboard.press("Enter");
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    await expect.poll(() => activeUrl(shell)).toContain(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`);
  } finally {
    await app.close();
  }
});
