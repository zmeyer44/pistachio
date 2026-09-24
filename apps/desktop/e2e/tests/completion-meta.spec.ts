import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { RunSummary, ThreadListItem } from "@pistachio/protocol";
import { shellReady } from "./windows";

const START = "2026-08-29T22:38:46.000Z";
const ANSWER =
  "I couldn’t find a current Costco.com listing for qualifying jackfruit chips. The closest Costco-related option is PHO’NOMENAL Ripened Jackfruit Chips.";

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

function completedRun(): RunSummary {
  return {
    runId: "completion-meta",
    taskId: "task-completion-meta",
    status: "completed",
    purpose: "Find qualifying jackfruit chips",
    title: "Find qualifying jackfruit chips",
    updatedAt: START,
    turns: 1,
    notes: "",
    context: {
      tokens: 2_400,
      compactAt: 100_000,
      window: 200_000,
      compactions: 0,
      steps: 4,
      totalSteps: 4,
      usage: { inputTokens: 2_000, outputTokens: 400 },
    },
    humanTabId: "tab-1",
    agentTabId: null,
    startedAt: START,
    completedAt: START,
    control: "human",
    pendingApproval: null,
    pendingQuestion: null,
    pendingTakeover: null,
    messages: [
      {
        id: "request",
        at: START,
        role: "user",
        content: "Find qualifying jackfruit chips",
        turn: 1,
      },
      {
        id: "answer",
        at: START,
        role: "assistant",
        content: ANSWER,
        turn: 1,
      },
    ],
    toolCalls: [],
    subagents: [],
    activity: [],
    result: {
      summary: ANSWER,
      changes: [],
      capsuleRevoked: false,
      evidenceEntries: 84,
      rootHash: "",
    },
  };
}

test("completion metadata does not repeat the final answer", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");

  const userData = await mkdtemp(join(tmpdir(), "pistachio-completion-meta-"));
  const threadsDirectory = join(userData, "threads");
  const run = completedRun();
  const item: ThreadListItem = {
    runId: run.runId,
    title: run.title,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    turns: run.turns,
    messageCount: run.messages.length,
  };
  await mkdir(threadsDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      join(userData, "settings.json"),
      // The finished conversation is read in the console, which opens closed.
      JSON.stringify({
        layout: { mode: "top", sidebar: "pinned" },
        general: { consoleOpenOnLaunch: true },
      }),
    ),
    writeFile(
      join(threadsDirectory, "threads.json"),
      JSON.stringify({ version: 1, threads: [item] }),
    ),
    writeFile(
      join(threadsDirectory, `${run.runId}.json`),
      JSON.stringify({
        version: 1,
        run,
        model: [],
        evidence: [],
        learnedThrough: run.messages.length,
      }),
    ),
  ]);

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: {
      ...process.env,
      PISTACHIO_E2E: "1",
      PISTACHIO_USER_DATA: userData,
    },
  });
  try {
    const shell = await shellReady(app);
    await expect(shell.getByTestId("completion-meta")).toBeVisible();
    await expect(shell.getByRole("status")).toHaveText("Task completed");
    await expect(shell.getByText(ANSWER, { exact: true })).toHaveCount(1);
    await expect(shell.getByTestId("completion-meta")).not.toContainText(
      ANSWER,
    );
    const activityButton = shell.getByRole("button", {
      name: "View 84 activity records",
    });
    await expect(activityButton).toBeVisible();

    const screenshotDirectory = join(
      process.cwd(),
      "e2e/screenshots/agent-console",
    );
    await mkdir(screenshotDirectory, { recursive: true });
    await shell.screenshot({
      path: join(screenshotDirectory, "completion-meta.png"),
    });
    await activityButton.click();
    await expect(shell.getByTestId("evidence-replay")).toBeVisible();
  } finally {
    await app.close();
  }
});
