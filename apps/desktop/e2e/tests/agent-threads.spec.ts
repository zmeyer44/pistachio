import { expect, test } from "@playwright/test";
import { shellPage } from "./windows";
import { launchApp } from "./app";
import { snapshot } from "./agent-harness";

/**
 * Conversations persist: a finished thread stays in the list, a new
 * conversation clears the console without losing it, it reopens with its
 * result, and deleting it empties both. The demo agent (no model) drives
 * the run itself; this spec is about the thread around it. That a thread
 * comes back after a restart is the seeded thread output-card.spec opens
 * on, and thread-store.test / run-controller.test's restore cases.
 */

test("a finished conversation stays in the list, reopens, and can be deleted", { tag: ["@agent"] }, async () => {
  test.setTimeout(60_000);
  const { app } = await launchApp({
    name: "threads",
    settings: { layout: { sidebar: "pinned" }, general: { consoleOpenOnLaunch: true } },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    // The console; the desk's Bar beside it shows the same conversation (its answer card), so what is read is read here.
    const panel = shell.getByTestId("agent-panel");
    await expect(panel).toBeVisible();

    // Nothing yet: no thread, no list.
    expect((await snapshot(shell)).threads).toEqual([]);
    await shell.getByTestId("thread-list-button").click();
    await expect(shell.getByTestId("thread-list-empty")).toBeVisible();
    await shell.keyboard.press("Escape");

    // The demo run: start, reach the approval, decline it — a finished
    // thread without the demo invoice page the approval would submit to.
    await shell.getByTestId("delegation-intent").fill("Reconcile the invoice and route it for payment");
    await shell.getByTestId("delegate-button").click();
    await expect(panel.getByTestId("run-status")).toContainText("Running");
    await expect(panel.getByTestId("approval-card")).toBeVisible();
    await panel.getByTestId("reject-button").click();
    await expect(panel.getByTestId("run-status")).toContainText("Rejected");
    await expect(panel.getByText("I left the draft in place", { exact: false })).toBeVisible();

    const first = await snapshot(shell);
    if (first.run === null) throw new Error("the run is missing after completion");
    const runId = first.run.runId;
    expect(first.run.title).toBe("Reconcile the invoice and route it for payment");
    expect(first.run.turns).toBe(1);
    expect(first.threads.map((thread) => thread.runId)).toEqual([runId]);
    expect(first.threads[0]?.status).toBe("rejected");

    // The list shows it as the current one.
    await shell.getByTestId("thread-list-button").click();
    await expect(shell.getByTestId(`thread-item-${runId}`)).toHaveAttribute("aria-current", "true");
    await shell.keyboard.press("Escape");

    // A new conversation clears the console; the old thread waits in the list.
    await shell.getByTestId("new-conversation").click();
    await expect(panel.getByText("I left the draft in place", { exact: false })).toHaveCount(0);
    await expect(shell.getByTestId("recent-threads")).toBeVisible();
    expect((await snapshot(shell)).run).toBeNull();
    expect((await snapshot(shell)).threads.map((thread) => thread.runId)).toEqual([runId]);

    // Reopening brings the result back, whole.
    await shell.getByTestId(`recent-thread-${runId}`).click();
    await expect(panel.getByText("I left the draft in place", { exact: false })).toBeVisible();
    await expect(panel.getByTestId("run-status")).toContainText("Rejected");
    const reopened = await snapshot(shell);
    expect(reopened.run?.runId).toBe(runId);
    expect(reopened.run?.messages.length ?? 0).toBeGreaterThan(1);

    // Deleting it empties the console and the list.
    await shell.getByTestId("thread-list-button").click();
    await shell.getByTestId(`thread-delete-${runId}`).click();
    await shell.getByTestId(`thread-delete-${runId}`).click(); // arms, then confirms
    await expect(shell.getByTestId("thread-list-empty")).toBeVisible();
    await shell.keyboard.press("Escape");
    await expect(panel.getByText("I left the draft in place", { exact: false })).toHaveCount(0);
    expect((await snapshot(shell)).run).toBeNull();
    expect((await snapshot(shell)).threads).toEqual([]);
  } finally {
    await app.close();
  }
});
