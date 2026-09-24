import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { RunSummary, ThreadListItem } from "@pistachio/protocol";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellReady } from "./windows";

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [process.env["PISTACHIO_ELECTRON_PATH"], join(process.cwd(), "node_modules/electron", executableSuffix)];
  return candidates.find(
    (candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

/** The whole window — shell and the page views beside it — as the person sees it. */
async function capture(app: ElectronApplication, path: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await writeFile(path, Buffer.from(png, "base64"));
}

const START = "2026-09-23T14:59:00.000Z";
const LATER = "2026-09-23T14:59:08.000Z";
const REPLY =
  "Created a new note: \u201cWaymo transit rewards program.\u201d It covers eligibility, the $2.85 reward, Bay Area rollout, Caltrain partnership, and expansion plans.";

function noteRun(): RunSummary {
  return {
    runId: "output-card",
    taskId: "task-output-card",
    status: "completed",
    purpose: "Summarize this page into a new note",
    title: "Summarize this page into a new note",
    updatedAt: LATER,
    turns: 1,
    notes: "",
    context: {
      tokens: 2_400,
      compactAt: 100_000,
      window: 200_000,
      compactions: 0,
      steps: 2,
      totalSteps: 2,
      usage: { inputTokens: 2_000, outputTokens: 400 },
    },
    humanTabId: "tab-1",
    agentTabId: null,
    startedAt: START,
    completedAt: LATER,
    control: "human",
    pendingApproval: null,
    pendingQuestion: null,
    pendingTakeover: null,
    messages: [
      { id: "request", at: START, role: "user", content: "Summarize this page into a new note", turn: 1 },
      { id: "answer", at: LATER, role: "assistant", content: REPLY, turn: 1 },
    ],
    toolCalls: [
      {
        id: "tool-1",
        name: "note.create",
        label: "Write note",
        detail: "Wrote: Waymo transit rewards program \u2014 note, edited 2026-09-23",
        status: "completed",
        startedAt: "2026-09-23T14:59:02.000Z",
        completedAt: "2026-09-23T14:59:04.000Z",
        tabId: null,
        turn: 1,
        output: { kind: "note", action: "created", id: "note-waymo", title: "Waymo transit rewards program" },
      },
    ],
    subagents: [],
    activity: [],
    result: { summary: REPLY, changes: [], capsuleRevoked: false, evidenceEntries: 7, rootHash: "" },
  };
}

test("a note the agent wrote shows as a card under the reply and opens", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");

  const userData = await mkdtemp(join(tmpdir(), "pistachio-output-card-"));
  const threadsDirectory = join(userData, "threads");
  const run = noteRun();
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
      JSON.stringify({ layout: { mode: "top", sidebar: "pinned" }, general: { consoleOpenOnLaunch: true } }),
    ),
    writeFile(join(threadsDirectory, "threads.json"), JSON.stringify({ version: 1, threads: [item] })),
    writeFile(
      join(threadsDirectory, `${run.runId}.json`),
      JSON.stringify({ version: 1, run, model: [], evidence: [], learnedThrough: run.messages.length }),
    ),
  ]);

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellReady(app);
    const card = shell.getByTestId("output-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Waymo transit rewards program");
    await expect(card).toContainText("Note · Created");

    const screenshotDirectory = join(process.cwd(), "e2e/screenshots/agent-console");
    await mkdir(screenshotDirectory, { recursive: true });
    await shell.waitForTimeout(400);
    await capture(app, join(screenshotDirectory, "output-card.png"));

    await card.click();
    // The note opens as its own tab, at the notes page's address for it.
    await expect
      .poll(() =>
        shell.evaluate(async () => {
          const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
          const snapshot = await api.getSnapshot();
          return snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId)?.url ?? null;
        }),
      )
      .toBe("pistachio://notes/note-waymo");
    await shell.waitForTimeout(800);
    await capture(app, join(screenshotDirectory, "output-card-opened.png"));
  } finally {
    await app.close();
  }
});
