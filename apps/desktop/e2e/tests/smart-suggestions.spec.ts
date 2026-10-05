import { expect, test, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { pageFirst, shellReady } from "./windows";
import { launchApp } from "./app";
import { capturePage } from "./pages-harness";

/**
 * Smart suggestions, end to end in the real app (docs/smart-suggestions.md):
 * the renderer's asking, the IPC hop, main's ranker, the real evaluator and
 * the real ordering policy — over a SCRIPTED intent model
 * (PISTACHIO_INTENT_SCRIPT, main/address-intent.ts), because what is under
 * test is the address bar, not a model's opinion. The model's own accuracy
 * is measured live in packages/shell-ui/test/address-intent.live.test.ts.
 */

const SCRIPT = {
  // Words that share no letters with the row they mean: only the model can find it.
  "make it prettier": { intent: "browser_command", target: "Theme & colors" },
  "explain tls": { intent: "ai_prompt" },
  // Slow, so that what the bar shows while it waits can be seen.
  "explain tls prices": { intent: "web_search", delayMs: 1200 },
};

async function type(shell: Page, query: string): Promise<void> {
  await shell.keyboard.press("Meta+L");
  const input = shell.getByTestId("address-input");
  await expect(input).toBeFocused();
  await input.fill(query);
}

test("the intent model reorders the address bar, and the heuristics keep what is theirs", { tag: ["@address"] }, async () => {
  const { app } = await launchApp({
    settings: pageFirst(),
    env: { PISTACHIO_INTENT_SCRIPT: JSON.stringify(SCRIPT) },
    name: "smart-suggestions",
  });

  try {
    const shell = await shellReady(app);
    const results = shell.getByTestId("command-results");
    const first = results.locator('[data-index="0"]');

    // A settings page the words never name: the heuristics paint a web
    // search, then the answer lands and the page takes ↵.
    await type(shell, "make it prettier");
    await expect(results).toHaveAttribute("data-intent-ranked", "applied");
    await expect(first).toHaveAttribute("data-action-id", "settings:appearance");
    await expect(results.locator('[data-suggestion-kind="search"]')).toHaveAttribute("data-index", "1");
    await capturePage(shell, "smart-suggestions-settings.png");
    // ↵ just after a reorder means the row that was there before it
    // (shell-ui lib/intent-ranking.ts REORDER_GRACE_MS, 150 ms): a person
    // looks first, and so does this.
    await shell.waitForTimeout(200);
    await shell.keyboard.press("Enter");
    await expect(shell.getByRole("heading", { name: "Appearance" })).toBeVisible();
    await shell.keyboard.press("Escape");

    // A prompt: the assistant takes ↵ from the web search, and says so.
    await type(shell, "explain tls");
    await expect(results).toHaveAttribute("data-intent-ranked", "applied");
    await expect(first).toHaveAttribute("data-suggestion-kind", "ai");
    await expect(first).toContainText("↵");
    await capturePage(shell, "smart-suggestions-ai.png");

    // Typing on does not hand ↵ back to the web search while the next answer
    // is awaited: the choice belongs to the sentence, not the keystroke. It
    // moves when an answer says so — and this one, when it comes, does.
    await shell.getByTestId("address-input").fill("explain tls prices");
    await expect(
      shell.locator('[data-testid="command-results"][data-intent-ranked="pending"] [data-index="0"][data-suggestion-kind="ai"]'),
    ).toBeVisible();
    await expect(results).toHaveAttribute("data-intent-ranked", "applied");
    await expect(first).toHaveAttribute("data-suggestion-kind", "search");
    await expect(first).toContainText("↵");

    // An address is the heuristics' to decide: nobody is asked.
    await shell.getByTestId("address-input").fill("github.com");
    await expect(results).toHaveAttribute("data-intent-ranked", "none");
    await expect(first).toHaveAttribute("data-suggestion-kind", "navigate");
    await shell.keyboard.press("Escape");

    // The setting off: the same prompt is a web search again, and nothing is asked.
    await shell.evaluate(() =>
      (window as unknown as { pistachio: PistachioApi }).pistachio.updateSettings({
        search: { smartSuggestions: false },
      }),
    );
    await type(shell, "explain tls");
    await expect(results).toHaveAttribute("data-intent-ranked", "none");
    await expect(first).toHaveAttribute("data-suggestion-kind", "search");
  } finally {
    await app.close();
  }
});
