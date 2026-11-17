/**
 * The desk's chat against the real models, in the real app (docs/desk-agent.md;
 * docs/console-routing.md §10): a question answered in the space's card, its
 * reply's footer, a follow-up on the same conversation, a request that needs
 * the web, and a question about the page in the window in use, answered by
 * reading it.
 *
 * Until 2026-11-16 this drove the sidebar console and checked the router's
 * quick paths (answer, page). The desktop draws no console now — its chat is
 * the desk's Bar and card — and a turn at a desk is always the browser's
 * (every space has a desk, a Home tab's too, since 2026-10-09: the router is
 * skipped, `turn.routed` basis "skipped"), so what is checked is the desk's
 * own way: no "Answering directly" / "Answering from the page", the browser
 * agent answering with or without tool steps as the question needs. The
 * router's own decisions are run-controller.test's ("routing a request") and
 * agent-runtime's turn-route.test's.
 *
 * Runs only with PISTACHIO_AGENT_LIVE=1 — a live model through the account's
 * proxy: the app as installed, on a scratch profile that gets its own
 * anonymous account from control. One launch; each step leaves the chat where
 * the next one starts.
 *
 *   PISTACHIO_AGENT_LIVE=1 pnpm playwright test -c e2e/playwright.config.ts console-routing.live
 */
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { RunSummary } from "@pistachio/protocol";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";
import { launchApp } from "./app";
import { captureShell } from "./agent-harness";
import { openTray, reachBar } from "./desk-harness";

const live = process.env["PISTACHIO_AGENT_LIVE"] === "1";

test.skip(!live, "needs PISTACHIO_AGENT_LIVE=1 and a reachable control plane");

function capture(shell: Page, filename: string): Promise<void> {
  return captureShell(shell, "console-routing", filename);
}

async function runSnapshot(shell: Page): Promise<RunSummary | null> {
  return shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot().then((value) => value.run));
}

/** Sends a message and waits for the turn to settle; returns the run and how long it took. */
async function ask(shell: Page, prompt: string): Promise<{ run: RunSummary; elapsedMs: number }> {
  const before = (await runSnapshot(shell))?.messages.length ?? 0;
  const started = Date.now();
  // The space's Bar: its pill out of the nub, the words, Enter.
  await reachBar(shell);
  await shell.getByTestId("desk-bar-input").fill(prompt);
  await shell.getByTestId("desk-bar-input").press("Enter");
  await expect.poll(async () => (await runSnapshot(shell))?.messages.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(before);
  await expect.poll(async () => (await runSnapshot(shell))?.status ?? "none", { timeout: 240_000 }).toMatch(/completed|failed|human_control|waiting_for_judgment|interrupted/);
  const run = await runSnapshot(shell);
  if (run === null) throw new Error("Agent run disappeared");
  return { run, elapsedMs: Date.now() - started };
}

function labels(run: RunSummary): string[] {
  return run.activity.map((entry) => entry.label);
}

/** The router's quick paths, which a turn at a desk never takes. */
function quickPaths(run: RunSummary): string[] {
  return labels(run).filter((label) => label === "Answering directly" || label === "Answering from the page");
}

function lastAssistant(run: RunSummary): string {
  return [...run.messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
}

test.describe.serial("the desk's chat answers each turn", { tag: ["@agent", "@desk", "@live"] }, () => {
  test.describe.configure({ timeout: 360_000 });

  let app: ElectronApplication;
  let shell: Page;
  const report: string[] = [];
  /** How many tool steps the thread held after the first question's reply (and its retry). */
  let firstToolCount = 0;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    // Not under PISTACHIO_E2E: that flag keeps the account services — and with
    // them every model — off. This is the app as installed, on a scratch
    // profile that gets its own anonymous account.
    ({ app } = await launchApp({
      name: "console-routing",
      settings: { layout: { sidebar: "pinned" }, onboarding: { completed: true, completedAt: new Date().toISOString() } },
      env: { PISTACHIO_E2E: undefined, PISTACHIO_AGENT_LIVE: "1" },
    }));
    shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    // (No panel beside the desk: the chat is in its nub.)
    await expect(shell.getByTestId("desk-bar")).toHaveCount(1);
    await expect(shell.getByTestId("agent-panel")).toHaveCount(0);
    // A fresh profile gets its anonymous account's token from control a
    // moment after launch (docs/anonymous-accounts.md); the models — and the
    // router — are unreachable until then.
    await expect
      .poll(async () => shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getAiStatus().then((status) => status.available)), { timeout: 60_000 })
      .toBe(true);
  });

  test.afterAll(async () => {
    console.log(`[desk chat live]\n${report.join("\n")}`);
    await app?.close();
  });

  test("a question is answered in the space's card, and its reply's footer copies, retries, and reads aloud", async () => {
    // General knowledge, asked at a desk: the browser agent's turn (the router is skipped there), which may answer
    // without a single tool step — and no "I'm on it" (at a desk the agent is seen working on the windows).
    const first = await ask(shell, "In two sentences, what is a hash map?");
    await capture(shell, "01-answered.png");
    report.push(`answer  ${String(first.elapsedMs)} ms  steps=${String(first.run.context.steps)} tools=${String(first.run.toolCalls.length)}  ${labels(first.run).join(" | ")}`);
    expect(first.run.status).toBe("completed");
    expect(labels(first.run)).toContain("Agent started");
    expect(quickPaths(first.run)).toEqual([]);
    expect(first.run.groupId).toBeTruthy();
    expect(first.run.messages[0]?.role).toBe("user");
    expect(lastAssistant(first.run)).toMatch(/hash|key/i);

    // The answer is up in the space's card. The person's bubble carries no controls; the reply carries three.
    const card = shell.getByTestId("desk-answer");
    await expect(card).toContainText(lastAssistant(first.run).slice(0, 24));
    expect(await card.getByTestId("message-actions").count()).toBeGreaterThan(0);
    const copy = card.getByTestId("message-copy").last();
    const retry = card.getByTestId("message-retry").last();
    const readAloud = card.getByTestId("message-read-aloud").last();
    await expect(copy).toBeVisible();
    await expect(readAloud).toBeVisible();
    await expect(retry).toBeVisible();

    await copy.click();
    await expect(copy).toHaveAttribute("aria-label", "Copied");
    const clipboard = await app.evaluate(({ clipboard: board }) => board.readText());
    expect(clipboard).toBe(lastAssistant(first.run));

    const started = Date.now();
    await retry.click();
    await expect.poll(async () => (await runSnapshot(shell))?.status ?? "none", { timeout: 120_000 }).toMatch(/completed|failed/);
    const retried = await runSnapshot(shell);
    if (retried === null) throw new Error("run disappeared");
    report.push(`retry  ${String(Date.now() - started)} ms  ${labels(retried).slice(-3).join(" | ")}`);
    expect(retried.status).toBe("completed");
    expect(retried.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(labels(retried)).toContain("Retrying");
    await capture(shell, "02-retried.png");

    await card.getByTestId("message-read-aloud").last().click();
    await expect(card.getByTestId("message-read-aloud").last()).toHaveAttribute("aria-label", "Preparing…");
    await expect(card.getByTestId("message-read-aloud").last()).toHaveAttribute("aria-label", "Read aloud", { timeout: 60_000 });
    // The player is a tab in the media stack, as for a page selection.
    await expect.poll(async () => shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getMedia().then((media) => media.length)), { timeout: 30_000 }).toBeGreaterThan(0);
    await capture(shell, "03-read-aloud.png");

    firstToolCount = retried.toolCalls.length;
  });

  test("a follow-up goes on in the same conversation, and web work is done in the browser", async () => {
    // A follow-up on the finished thread: the same conversation, the space's own.
    const before = await runSnapshot(shell);
    const second = await ask(shell, "now say that in one sentence a child would understand");
    await capture(shell, "04-followup.png");
    report.push(`answer  ${String(second.elapsedMs)} ms  steps=${String(second.run.context.steps)} tools=${String(second.run.toolCalls.length - firstToolCount)}  ${labels(second.run).slice(-2).join(" | ")}`);
    expect(second.run.status).toBe("completed");
    expect(second.run.runId).toBe(before?.runId);
    expect(second.run.messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(quickPaths(second.run)).toEqual([]);

    // Something on the web: real tool steps, in a tab of the agent's own (hidden) or one of the space's.
    const third = await ask(shell, "What's the weather forecast for Denver this weekend? Check a weather site.");
    await capture(shell, "05-browsed.png");
    report.push(`browse  ${String(third.elapsedMs)} ms  steps=${String(third.run.context.steps)} tools=${String(third.run.toolCalls.length)}  ${labels(third.run).slice(-3).join(" | ")}`);
    expect(["completed", "human_control", "interrupted"]).toContain(third.run.status);
    expect(quickPaths(third.run)).toEqual([]);
    expect(third.run.toolCalls.length).toBeGreaterThan(second.run.toolCalls.length);
    expect(third.run.toolCalls.some((call) => call.name.startsWith("tab") || call.name.startsWith("page"))).toBe(true);
  });

  test("a question about the page in the window in use is answered by reading it", async () => {
    // A conversation of its own (the pill's tray), about a real page in the person's tab: the IETF's example
    // domain, small and stable.
    await openTray(shell);
    await shell.getByTestId("desk-bar-new-conversation").click();
    await expect.poll(() => runSnapshot(shell)).toBeNull();
    const activeTabId = await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot().then((value) => value.activeTabId));
    if (activeTabId === null) throw new Error("no active tab");
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.navigate(id, "https://example.com/"), activeTabId);
    await expect
      .poll(async () => shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot().then((value) => value.tabs.find((tab) => tab.id === value.activeTabId)?.title ?? "")), { timeout: 30_000 })
      .toMatch(/Example Domain/);

    const { run, elapsedMs } = await ask(shell, "What is this page for, and what does it say I'm allowed to do with it?");
    await capture(shell, "06-page-in-view.png");
    report.push(`page  ${String(elapsedMs)} ms  steps=${String(run.context.steps)} tools=${String(run.toolCalls.length)}  ${labels(run).join(" | ")}\n  ${lastAssistant(run)}`);
    expect(run.status).toBe("completed");
    // At a desk the page is not attached to the message (the Bar names none): the desk block names the window, and
    // the agent reads it as a step.
    expect(quickPaths(run)).toEqual([]);
    expect(run.toolCalls.some((call) => call.name.startsWith("page") && call.status === "completed")).toBe(true);
    expect(run.messages[0]?.role).toBe("user");
    expect(lastAssistant(run)).toMatch(/illustrative|example|documentation|literature|without.*permission/i);
  });
});
