import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/question-continue");

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find((candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")));
}

test("a structured question disappears and the run resumes after Continue", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-question-continue-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "top", sidebar: "pinned" }, general: { consoleOpenOnLaunch: true } }),
  );
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });

  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await mkdir(screenshotDirectory, { recursive: true });

    // The paused frame proves the question and its available directions are visible together.
    await shell.getByTestId("delegation-intent").fill("Help");
    await shell.getByTestId("delegate-button").click();
    const card = shell.getByTestId("questionnaire-card");
    await expect(card).toBeVisible();
    await expect(card.getByText("Inspect and report", { exact: true })).toBeVisible();
    await shell.screenshot({ path: join(screenshotDirectory, "01-question-paused.png"), fullPage: true });

    // The selected frame proves Continue has a concrete value to submit.
    await card.getByText("Inspect and report", { exact: true }).click();
    await expect(card.getByRole("button", { name: "Continue" })).toBeEnabled();
    await shell.screenshot({ path: join(screenshotDirectory, "02-direction-selected.png"), fullPage: true });

    // Removing the card is the user-visible contract that the answer resumed this conversation.
    await card.getByRole("button", { name: "Continue" }).click();
    await expect(card).toHaveCount(0);
    await expect(shell.getByTestId("run-status")).toContainText("Running");
    await shell.screenshot({ path: join(screenshotDirectory, "03-run-resumed.png"), fullPage: true });
  } finally {
    await app.close();
  }
});
