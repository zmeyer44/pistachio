import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/text-question-continue");

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find((candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")));
}

test("a person types a requested value and the agent resumes with it", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-text-question-"));
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

    // The first frame proves the agent can request a verbatim value without inventing choices.
    await shell.getByTestId("delegation-intent").fill("I will provide my ZIP code");
    await shell.getByTestId("delegate-button").click();
    const card = shell.getByTestId("questionnaire-card");
    const input = card.getByTestId("question-text-input");
    await expect(card.getByText("What ZIP code should I use?", { exact: true })).toBeVisible();
    await expect(input).toHaveAttribute("placeholder", "ZIP code");
    await expect(card.getByRole("radio")).toHaveCount(0);
    await shell.screenshot({ path: join(screenshotDirectory, "01-text-question.png"), fullPage: true });

    // The filled frame verifies the exact value is staged in the dedicated answer field.
    await input.fill("10001");
    await expect(input).toHaveValue("10001");
    await shell.screenshot({ path: join(screenshotDirectory, "02-answer-entered.png"), fullPage: true });

    // The resumed frame proves Continue consumes the text and returns to the same conversation.
    await card.getByRole("button", { name: "Continue" }).click();
    await expect(card).toHaveCount(0);
    await expect(shell.getByTestId("run-status")).toContainText("Running");
    await expect(shell.getByText("10001", { exact: true })).toBeVisible();
    await shell.screenshot({ path: join(screenshotDirectory, "03-run-resumed.png"), fullPage: true });
  } finally {
    await app.close();
  }
});
