import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { ShellSnapshot, PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

/**
 * Conversations persist and come back: a finished thread stays in the
 * list, a new conversation clears the console without losing it, it
 * reopens with its result, and it is there again after the app restarts.
 * The demo agent (no model) drives the run itself; this spec is about the
 * thread around it.
 */

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find((candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")));
}

async function launch(userData: string): Promise<{ app: ElectronApplication; shell: Page }> {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  const shell = await shellPage(app);
  await shell.waitForLoadState("domcontentloaded");
  await expect(shell.getByTestId("agent-panel")).toBeVisible();
  return { app, shell };
}

async function snapshot(shell: Page): Promise<ShellSnapshot> {
  return shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot());
}

test("a finished conversation stays in the list, reopens, and survives a restart", async () => {
  const userData = await mkdtemp(join(tmpdir(), "pistachio-threads-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ layout: { mode: "top", sidebar: "pinned" }, general: { consoleOpenOnLaunch: true } }));

  let { app, shell } = await launch(userData);
  let runId: string;
  try {
    // Nothing yet: no thread, no list.
    expect((await snapshot(shell)).threads).toEqual([]);
    await shell.getByTestId("thread-list-button").click();
    await expect(shell.getByTestId("thread-list-empty")).toBeVisible();
    await shell.keyboard.press("Escape");

    // The demo run: start, reach the approval, decline it — a finished
    // thread without the demo invoice page the approval would submit to.
    await shell.getByTestId("delegation-intent").fill("Reconcile the invoice and route it for payment");
    await shell.getByTestId("delegate-button").click();
    await expect(shell.getByTestId("run-status")).toContainText("Running");
    await expect(shell.getByTestId("approval-card")).toBeVisible();
    await shell.getByTestId("reject-button").click();
    await expect(shell.getByTestId("run-status")).toContainText("Rejected");
    await expect(shell.getByText("I left the draft in place", { exact: false })).toBeVisible();

    const first = await snapshot(shell);
    if (first.run === null) throw new Error("the run is missing after completion");
    runId = first.run.runId;
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
    await expect(shell.getByText("I left the draft in place", { exact: false })).toHaveCount(0);
    await expect(shell.getByTestId("recent-threads")).toBeVisible();
    expect((await snapshot(shell)).run).toBeNull();
    expect((await snapshot(shell)).threads.map((thread) => thread.runId)).toEqual([runId]);

    // Reopening brings the result back.
    await shell.getByTestId(`recent-thread-${runId}`).click();
    await expect(shell.getByText("I left the draft in place", { exact: false })).toBeVisible();
    await expect(shell.getByTestId("run-status")).toContainText("Rejected");
    expect((await snapshot(shell)).run?.runId).toBe(runId);
  } finally {
    await app.close();
  }

  // After a restart the thread is open again, whole.
  ({ app, shell } = await launch(userData));
  try {
    await expect(shell.getByText("I left the draft in place", { exact: false })).toBeVisible();
    await expect(shell.getByTestId("run-status")).toContainText("Rejected");
    const restored = await snapshot(shell);
    expect(restored.run?.runId).toBe(runId);
    expect(restored.run?.messages.length ?? 0).toBeGreaterThan(1);
    expect(restored.threads.map((thread) => thread.runId)).toEqual([runId]);

    // Deleting it empties the console and the list.
    await shell.getByTestId("thread-list-button").click();
    await shell.getByTestId(`thread-delete-${runId}`).click();
    await shell.getByTestId(`thread-delete-${runId}`).click(); // arms, then confirms
    await expect(shell.getByTestId("thread-list-empty")).toBeVisible();
    await shell.keyboard.press("Escape");
    await expect(shell.getByText("I left the draft in place", { exact: false })).toHaveCount(0);
    expect((await snapshot(shell)).run).toBeNull();
    expect((await snapshot(shell)).threads).toEqual([]);
  } finally {
    await app.close();
  }
});
