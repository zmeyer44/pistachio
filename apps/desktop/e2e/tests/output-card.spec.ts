import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { RunSummary, ThreadListItem } from "@pistachio/protocol";
import { shellReady } from "./windows";
import { launchApp } from "./app";
import { activeTabUrl, captureShell, captureWindow } from "./agent-harness";

/**
 * Finished conversations read back from disk, as a previous session left
 * them: the newest opens in the console at launch (a note the agent wrote,
 * shown as a card), and the other is opened from the thread list (a
 * completed task's footer). One launch, both threads seeded.
 */

const NOTE_START = "2026-09-23T14:59:00.000Z";
const NOTE_LATER = "2026-09-23T14:59:08.000Z";
const NOTE_REPLY =
  "Created a new note: “Waymo transit rewards program.” It covers eligibility, the $2.85 reward, Bay Area rollout, Caltrain partnership, and expansion plans.";

const META_START = "2026-08-29T22:38:46.000Z";
const META_ANSWER =
  "I couldn’t find a current Costco.com listing for qualifying jackfruit chips. The closest Costco-related option is PHO’NOMENAL Ripened Jackfruit Chips.";

function noteRun(): RunSummary {
  return {
    runId: "output-card",
    taskId: "task-output-card",
    status: "completed",
    purpose: "Summarize this page into a new note",
    title: "Summarize this page into a new note",
    updatedAt: NOTE_LATER,
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
    startedAt: NOTE_START,
    completedAt: NOTE_LATER,
    control: "human",
    pendingApproval: null,
    pendingQuestion: null,
    pendingTakeover: null,
    messages: [
      { id: "request", at: NOTE_START, role: "user", content: "Summarize this page into a new note", turn: 1 },
      { id: "answer", at: NOTE_LATER, role: "assistant", content: NOTE_REPLY, turn: 1 },
    ],
    toolCalls: [
      {
        id: "tool-1",
        name: "note.create",
        label: "Write note",
        detail: "Wrote: Waymo transit rewards program — note, edited 2026-09-23",
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
    result: { summary: NOTE_REPLY, changes: [], capsuleRevoked: false, evidenceEntries: 7, rootHash: "" },
  };
}

function completedRun(): RunSummary {
  return {
    runId: "completion-meta",
    taskId: "task-completion-meta",
    status: "completed",
    purpose: "Find qualifying jackfruit chips",
    title: "Find qualifying jackfruit chips",
    updatedAt: META_START,
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
    startedAt: META_START,
    completedAt: META_START,
    control: "human",
    pendingApproval: null,
    pendingQuestion: null,
    pendingTakeover: null,
    messages: [
      { id: "request", at: META_START, role: "user", content: "Find qualifying jackfruit chips", turn: 1 },
      { id: "answer", at: META_START, role: "assistant", content: META_ANSWER, turn: 1 },
    ],
    toolCalls: [],
    subagents: [],
    activity: [],
    result: { summary: META_ANSWER, changes: [], capsuleRevoked: false, evidenceEntries: 84, rootHash: "" },
  };
}

function listItem(run: RunSummary): ThreadListItem {
  return {
    runId: run.runId,
    title: run.title,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    turns: run.turns,
    messageCount: run.messages.length,
  };
}

function threadFile(run: RunSummary): unknown {
  return { version: 1, run, model: [], evidence: [], learnedThrough: run.messages.length };
}

test.describe.serial("a finished conversation read back from disk", { tag: ["@agent"] }, () => {
  test.describe.configure({ timeout: 45_000 });

  let app: ElectronApplication;
  let shell: Page;

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    const note = noteRun();
    const meta = completedRun();
    ({ app } = await launchApp({
      name: "output-card",
      // The finished conversations are read in the console, which opens closed.
      settings: { layout: { sidebar: "pinned" }, general: { consoleOpenOnLaunch: true } },
      files: {
        // Newest first: the note's thread is the one open at launch.
        "threads/threads.json": { version: 1, threads: [listItem(note), listItem(meta)] },
        [`threads/${note.runId}.json`]: threadFile(note),
        [`threads/${meta.runId}.json`]: threadFile(meta),
      },
    }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("a note the agent wrote shows as a card under the reply and opens", async () => {
    const card = shell.getByTestId("output-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Waymo transit rewards program");
    await expect(card).toContainText("Note · Created");
    await captureWindow(app, "agent-console", "output-card.png", 400);

    await card.click();
    // The note opens as its own tab, at the notes page's address for it.
    await expect.poll(() => activeTabUrl(shell)).toBe("pistachio://notes/note-waymo");
    await captureWindow(app, "agent-console", "output-card-opened.png", 800);
  });

  test("completion metadata does not repeat the final answer", async () => {
    await shell.getByTestId("thread-list-button").click();
    await shell.getByTestId("thread-item-completion-meta").click();
    await expect(shell.getByTestId("completion-meta")).toBeVisible();
    await expect(shell.getByRole("status")).toHaveText("Task completed");
    await expect(shell.getByText(META_ANSWER, { exact: true })).toHaveCount(1);
    await expect(shell.getByTestId("completion-meta")).not.toContainText(META_ANSWER);
    // The record's size comes from the stored result; the replay it opens is delegation.spec's.
    await expect(shell.getByRole("button", { name: "View 84 activity records" })).toBeVisible();
    await captureShell(shell, "agent-console", "completion-meta.png");
  });
});
