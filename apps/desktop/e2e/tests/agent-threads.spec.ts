import { expect, test } from "@playwright/test";
import { shellReady } from "./windows";
import { launchApp } from "./app";
import { snapshot } from "./agent-harness";
import { openChats, openTray, reachBar } from "./desk-harness";

/**
 * Conversations persist: a finished thread stays in the list, a new
 * conversation clears the chat without losing it, it reopens with its
 * result, and deleting it empties both — all at the desk's nub, the
 * desktop's one chat (no panel stands beside the desk since 2026-11-16).
 * The demo agent (no model) drives the run itself; this spec is about the
 * thread around it. That a thread comes back after a restart is the seeded
 * thread output-card.spec opens on, and thread-store.test /
 * run-controller.test's restore cases.
 */

test("a finished conversation stays in the list, reopens, and can be deleted", { tag: ["@agent"] }, async () => {
  test.setTimeout(60_000);
  const { app } = await launchApp({
    name: "threads",
    settings: { layout: { sidebar: "pinned" } },
  });
  try {
    const shell = await shellReady(app);
    // The answer card: the conversation of the space in front.
    const card = shell.getByTestId("desk-answer");
    const rows = shell.locator('[data-testid="desk-conversations"] [data-testid="desk-conversation"]');
    const row = (runId: string) => shell.locator(`[data-testid="desk-conversations"] [data-testid="desk-conversation"][data-run-id="${runId}"]`);
    const status = (): Promise<string | null> => snapshot(shell).then((state) => state.run?.status ?? null);
    await expect(shell.getByTestId("agent-panel")).toHaveCount(0);

    // Nothing yet: no thread, and the nub's past chats say so.
    expect((await snapshot(shell)).threads).toEqual([]);
    await openChats(shell);
    await expect(rows).toHaveCount(0);
    await expect(shell.getByTestId("desk-conversations")).toContainText("No conversations yet");
    await shell.keyboard.press("Escape");
    await shell.keyboard.press("Escape");

    // The demo run: start, reach the approval, decline it — a finished
    // thread without the demo invoice page the approval would submit to.
    await reachBar(shell);
    await shell.getByTestId("desk-bar-input").fill("Reconcile the invoice and route it for payment");
    await shell.getByTestId("desk-bar-input").press("Enter");
    await expect(card.getByTestId("approval-card")).toBeVisible();
    await card.getByTestId("reject-button").click();
    await expect.poll(status).toBe("rejected");
    await expect(card.getByText("I left the draft in place", { exact: false })).toBeVisible();

    const first = await snapshot(shell);
    if (first.run === null) throw new Error("the run is missing after completion");
    const runId = first.run.runId;
    expect(first.run.title).toBe("Reconcile the invoice and route it for payment");
    expect(first.run.turns).toBe(1);
    expect(first.threads.map((thread) => thread.runId)).toEqual([runId]);
    expect(first.threads[0]?.status).toBe("rejected");

    // The list shows it as the current one.
    await openChats(shell);
    await expect(row(runId)).toHaveAttribute("aria-current", "true");
    await shell.keyboard.press("Escape");
    await shell.keyboard.press("Escape");

    // A new conversation clears the chat; the old thread waits in the list.
    await openTray(shell);
    await shell.getByTestId("desk-bar-new-conversation").click();
    await expect.poll(async () => (await snapshot(shell)).run).toBeNull();
    await expect(card.getByText("I left the draft in place", { exact: false })).toHaveCount(0);
    expect((await snapshot(shell)).threads.map((thread) => thread.runId)).toEqual([runId]);

    // Reopening brings the result back, whole.
    await openChats(shell);
    await expect(row(runId)).not.toHaveAttribute("aria-current", "true");
    await row(runId).click();
    await expect(card.getByText("I left the draft in place", { exact: false })).toBeVisible();
    await expect.poll(status).toBe("rejected");
    const reopened = await snapshot(shell);
    expect(reopened.run?.runId).toBe(runId);
    expect(reopened.run?.messages.length ?? 0).toBeGreaterThan(1);

    // Deleting it — its ×, pressed twice: the first arms it, and says so — empties the chat and the list.
    await openChats(shell);
    await row(runId).hover();
    const remove = shell.locator(`[data-testid="desk-conversation-delete"][data-run-id="${runId}"]`);
    await remove.click();
    await expect(remove).toHaveAttribute("title", "Click again to delete");
    expect((await snapshot(shell)).threads.map((thread) => thread.runId)).toEqual([runId]);
    await remove.click();
    await expect(rows).toHaveCount(0);
    await expect.poll(async () => (await snapshot(shell)).threads).toEqual([]);
    expect((await snapshot(shell)).run).toBeNull();
    await expect(card.getByText("I left the draft in place", { exact: false })).toHaveCount(0);
  } finally {
    await app.close();
  }
});
