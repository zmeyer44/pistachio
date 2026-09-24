import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { RunSummary } from "@pistachio/protocol";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/agent-live");
const execFile = promisify(execFileCallback);

test.describe.configure({ timeout: 360_000, mode: "serial" });

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find((candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")));
}

async function captureWindow(app: ElectronApplication, filename: string): Promise<string> {
  const capture = await app.evaluate(async ({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const shell = await window.capturePage();
    const views = await Promise.all(window.contentView.children.flatMap((child) => {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return [];
      const view = child as WebContentsView;
      if (Object.values(hashes).some((hash) => view.webContents.getURL().endsWith(hash))) return [];
      return [view.webContents.capturePage().then((image) => ({
        bounds: view.getBounds(),
        png: image.toPNG().toString("base64"),
      }))];
    }));
    return { shell: shell.toPNG().toString("base64"), views };
  }, CHROME_VIEW_HASHES);
  await mkdir(screenshotDirectory, { recursive: true });
  const outputPath = join(screenshotDirectory, filename);
  const shellPath = join(screenshotDirectory, `.${filename}.shell.png`);
  const viewPaths: string[] = [];
  await writeFile(shellPath, Buffer.from(capture.shell, "base64"));
  const command = [shellPath];
  for (const [index, view] of capture.views.entries()) {
    const path = join(screenshotDirectory, `.${filename}.view-${String(index)}.png`);
    viewPaths.push(path);
    await writeFile(path, Buffer.from(view.png, "base64"));
    // Some GPU-backed sites (notably X) return a capture at the previous
    // compositor size immediately after a tab switch. Normalize it to the
    // actual WebContentsView bounds before layering it over the shell.
    command.push(
      "(",
      path,
      "-resize",
      `${String(view.bounds.width)}x${String(view.bounds.height)}!`,
      ")",
      "-geometry",
      `+${String(view.bounds.x)}+${String(view.bounds.y)}`,
      "-composite",
    );
  }
  command.push(outputPath);
  await execFile("magick", command);
  await Promise.all([shellPath, ...viewPaths].map((path) => unlink(path)));
  return outputPath;
}

async function runSnapshot(shell: Page): Promise<RunSummary | null> {
  return shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot().then((value) => value.run));
}

async function launchAgent(model: string): Promise<{ app: ElectronApplication; shell: Page }> {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-agent-live-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ layout: { mode: "top", sidebar: "pinned" }, general: { consoleOpenOnLaunch: true } }));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: {
      ...process.env,
      PISTACHIO_AGENT_LIVE: "1",
      PISTACHIO_AGENT_MODEL: model,
      PISTACHIO_E2E: "1",
      PISTACHIO_USER_DATA: userData,
    },
  });
  const shell = await shellPage(app);
  await shell.waitForLoadState("domcontentloaded");
  await expect(shell.getByTestId("agent-panel")).toBeVisible();
  return { app, shell };
}

async function submit(shell: Page, prompt: string): Promise<void> {
  await shell.getByTestId("delegation-intent").fill(prompt);
  await shell.getByTestId("delegate-button").click();
  await expect.poll(async () => (await runSnapshot(shell))?.toolCalls.length ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
}

async function settleJourney(
  shell: Page,
  app: ElectronApplication,
  prefix: string,
): Promise<RunSummary> {
  for (let question = 0; question < 4; question += 1) {
    await expect.poll(async () => (await runSnapshot(shell))?.status ?? "none", { timeout: 240_000 }).toMatch(
      /completed|failed|human_control|waiting_for_judgment|interrupted/,
    );
    const snapshot = await runSnapshot(shell);
    if (snapshot === null) throw new Error("Agent run disappeared");
    await captureWindow(app, `${prefix}-${String(question + 2).padStart(2, "0")}-${snapshot.status}.png`);
    if (snapshot.status === "interrupted") {
      // The turn paused at its step budget (or without an answer); the
      // composer's Resume continues it — the journey is not over.
      await shell.getByRole("button", { name: "Resume" }).click();
      await expect.poll(async () => (await runSnapshot(shell))?.status ?? "none").not.toBe("interrupted");
      continue;
    }
    if (snapshot.status !== "waiting_for_judgment") return snapshot;
    const firstChoice = snapshot.pendingQuestion?.choices[0];
    if (firstChoice === undefined) throw new Error("Questionnaire has no choices");
    await shell.getByTestId("questionnaire-card").getByText(firstChoice.label, { exact: true }).click();
    await shell.getByTestId("questionnaire-card").getByRole("button", { name: "Continue" }).click();
    await expect.poll(async () => (await runSnapshot(shell))?.status ?? "none").not.toBe("waiting_for_judgment");
    await captureWindow(app, `${prefix}-${String(question + 2).padStart(2, "0")}-answered.png`);
  }
  throw new Error("Agent asked more than four consecutive clarification questions");
}

function conversation(run: RunSummary): string {
  return run.messages.map((message) => message.content).join("\n");
}

async function expectGroundedBrowserWork(run: RunSummary): Promise<void> {
  expect(run.toolCalls.some((call) => call.name === "tabs.list" && call.status === "completed")).toBe(true);
  expect(run.toolCalls.some((call) => call.name === "page.inspect" && call.status === "completed")).toBe(true);
  expect(run.toolCalls.some((call) => ["page.navigate", "tab.open"].includes(call.name) && call.status === "completed")).toBe(true);
}

async function jetsJourney(model: string, prefix: string): Promise<RunSummary> {
  const { app, shell } = await launchAgent(model);
  try {
    await captureWindow(app, `${prefix}-00-ready.png`);
    await submit(shell, "Who are the New York Jets playing in Week 1 of the 2026 regular season? Use an official source.");
    await captureWindow(app, `${prefix}-01-running.png`);
    const run = await settleJourney(shell, app, prefix);
    expect(run.status).toBe("completed");
    expect(conversation(run)).toMatch(/Titans/i);
    expect(conversation(run)).toMatch(/September 13|Sep(?:tember)?\.? 13/i);
    await expectGroundedBrowserWork(run);
    return run;
  } finally {
    await app.close();
  }
}

test("Terra completes a grounded Jets Week 1 lookup", async () => {
  await jetsJourney("openai/gpt-5.6-terra", "terra-jets");
});

test("Terra researches Sam Altman's latest public X activity or requests sign-in takeover", async () => {
  const { app, shell } = await launchAgent("openai/gpt-5.6-terra");
  try {
    await captureWindow(app, "terra-x-00-ready.png");
    await submit(shell, "What has Sam Altman been saying on X/Twitter lately? Review his recent public posts and summarize the main themes with dates.");
    await captureWindow(app, "terra-x-01-running.png");
    const run = await settleJourney(shell, app, "terra-x");
    await expect(shell.getByTestId("agent-panel")).toBeVisible();
    const panelBounds = await shell.getByTestId("agent-panel").boundingBox();
    expect(panelBounds?.width ?? 0).toBeGreaterThan(300);
    expect(["completed", "human_control"]).toContain(run.status);
    await expectGroundedBrowserWork(run);
    if (run.status === "human_control") {
      expect(run.pendingTakeover).not.toBeNull();
      expect(`${run.pendingTakeover?.reason} ${run.pendingTakeover?.instructions}`).toMatch(/sign|log in|captcha|verify|X|Twitter/i);
      await expect(shell.getByTestId("takeover-card")).toBeVisible();
    } else {
      expect(conversation(run)).toMatch(/Sam Altman/i);
      expect(conversation(run)).toMatch(/2026|Aug(?:ust)?/i);
    }
  } finally {
    await app.close();
  }
});

test("Terra finds an Amazon dress and either verifies the cart or hands off at a human barrier", async () => {
  const { app, shell } = await launchAgent("openai/gpt-5.6-terra");
  try {
    await captureWindow(app, "terra-amazon-00-ready.png");
    await submit(shell, "Find me a well-rated women's casual dress on Amazon for under $60, size medium, in black or navy, and add one to my cart. Do not check out.");
    await captureWindow(app, "terra-amazon-01-running.png");
    const run = await settleJourney(shell, app, "terra-amazon");
    expect(["completed", "human_control"]).toContain(run.status);
    await expectGroundedBrowserWork(run);
    expect(run.toolCalls.some((call) => call.name === "page.click" || call.name === "page.type")).toBe(true);
    if (run.status === "human_control") {
      expect(run.pendingTakeover).not.toBeNull();
      expect(`${run.pendingTakeover?.reason} ${run.pendingTakeover?.instructions}`).toMatch(/sign|captcha|verify|select|Amazon/i);
      await expect(shell.getByTestId("takeover-card")).toBeVisible();
      const toolCount = run.toolCalls.length;
      await shell.getByTestId("resume-after-takeover").click();
      await expect.poll(async () => (await runSnapshot(shell))?.toolCalls.length ?? 0, { timeout: 60_000 }).toBeGreaterThan(toolCount);
      const resumed = await settleJourney(shell, app, "terra-amazon-resumed");
      expect(["completed", "human_control"]).toContain(resumed.status);
      expect(resumed.toolCalls.slice(toolCount).some((call) => call.name === "page.inspect")).toBe(true);
    } else {
      expect(conversation(run)).toMatch(/added|cart/i);
      expect(conversation(run)).toMatch(/do not|did not|without|checkout/i);
    }
  } finally {
    await app.close();
  }
});

test("Sol completes the same grounded Jets lookup", async () => {
  await jetsJourney("openai/gpt-5.6-sol", "sol-jets");
});

test("Luna completes the same grounded Jets lookup", async () => {
  await jetsJourney("openai/gpt-5.6-luna", "luna-jets");
});
