import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { pageFirst, shellPage } from "./windows";

/**
 * Smart suggestions, end to end in the real app (docs/smart-suggestions.md):
 * the renderer's debounce, the IPC hop, main's ranker, the real evaluator and
 * the real ordering policy — over a SCRIPTED intent model
 * (PISTACHIO_INTENT_SCRIPT, main/address-intent.ts), because what is under
 * test is the address bar, not a model's opinion. The model's own accuracy
 * is measured live in packages/shell-ui/test/address-intent.live.test.ts.
 */

const SCRIPT = {
  // Words that share no letters with the row they mean: only the model can find it.
  "make it prettier": { intent: "browser_command", target: "Theme & colors" },
  "explain tls": { intent: "ai_prompt" },
};

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(
      process.cwd(),
      "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron",
      suffix,
    ),
  ].find(
    (candidate) =>
      candidate !== undefined &&
      existsSync(candidate) &&
      existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function type(shell: Page, query: string): Promise<void> {
  await shell.keyboard.press("Meta+L");
  const input = shell.getByTestId("address-input");
  await expect(input).toBeFocused();
  await input.fill(query);
}

test("the intent model reorders the address bar, and the heuristics keep what is theirs", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-smart-suggestions-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst()));
  const app: ElectronApplication = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: {
      ...process.env,
      PISTACHIO_E2E: "1",
      PISTACHIO_USER_DATA: userData,
      PISTACHIO_INTENT_SCRIPT: JSON.stringify(SCRIPT),
    },
  });

  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const results = shell.getByTestId("command-results");
    const first = results.locator('[data-index="0"]');

    // A settings page the words never name: the heuristics paint a web
    // search, then the answer lands and the page takes ↵.
    await type(shell, "make it prettier");
    await expect(results).toHaveAttribute("data-intent-ranked", "applied");
    await expect(first).toHaveAttribute("data-action-id", "settings:appearance");
    await expect(results.locator('[data-suggestion-kind="search"]')).toHaveAttribute("data-index", "1");
    await shell.screenshot({ path: "e2e/screenshots/smart-suggestions-settings.png" });
    await shell.keyboard.press("Enter");
    await expect(shell.getByRole("heading", { name: "Appearance" })).toBeVisible();
    await shell.keyboard.press("Escape");

    // A prompt: the assistant takes ↵ from the web search, and says so.
    await type(shell, "explain tls");
    await expect(results).toHaveAttribute("data-intent-ranked", "applied");
    await expect(first).toHaveAttribute("data-suggestion-kind", "ai");
    await expect(first).toContainText("↵");
    await shell.screenshot({ path: "e2e/screenshots/smart-suggestions-ai.png" });

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
    // These profiles pile up in $TMPDIR otherwise, on a disk with little room.
    await rm(userData, { recursive: true, force: true });
  }
});
