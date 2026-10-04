/**
 * The console router against the real models (docs/console-routing.md),
 * in the real app: a reply-shaped question answered without the browser,
 * its reply's footer, a follow-up that stays on the quick path, a request
 * that needs the web going to the browser agent, and a question about the
 * page in view answered by reading it. Runs only with PISTACHIO_AGENT_LIVE=1
 * — a live model through the account's proxy: the app as installed, on a
 * scratch profile that gets its own anonymous account from control. One
 * launch; each step leaves the console where the next one starts. That
 * PISTACHIO_TURN_ROUTER=off sends every turn down the browser path is
 * model-provider.test / run-controller.test's.
 *
 *   PISTACHIO_AGENT_LIVE=1 pnpm playwright test -c e2e/playwright.config.ts console-routing.live
 */
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { RunSummary } from "@pistachio/protocol";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";
import { launchApp } from "./app";
import { captureShell } from "./agent-harness";

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
  await shell.getByTestId("delegation-intent").fill(prompt);
  await shell.getByTestId("delegate-button").click();
  await expect.poll(async () => (await runSnapshot(shell))?.messages.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(before);
  await expect.poll(async () => (await runSnapshot(shell))?.status ?? "none", { timeout: 240_000 }).toMatch(/completed|failed|human_control|waiting_for_judgment|interrupted/);
  const run = await runSnapshot(shell);
  if (run === null) throw new Error("Agent run disappeared");
  return { run, elapsedMs: Date.now() - started };
}

function labels(run: RunSummary): string[] {
  return run.activity.map((entry) => entry.label);
}

function answeredDirectly(run: RunSummary): number {
  return labels(run).filter((label) => label === "Answering directly").length;
}

function lastAssistant(run: RunSummary): string {
  return [...run.messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
}

test.describe.serial("the console routes each turn", { tag: ["@agent", "@live"] }, () => {
  test.describe.configure({ timeout: 360_000 });

  let app: ElectronApplication;
  let shell: Page;
  const report: string[] = [];
  /** What the thread held after the first question's reply (and its retry). */
  let firstToolCount = 0;
  let directAfterFirst = 0;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    // Not under PISTACHIO_E2E: that flag keeps the account services — and with
    // them every model — off. This is the app as installed, on a scratch
    // profile that gets its own anonymous account.
    ({ app } = await launchApp({
      name: "console-routing",
      settings: { layout: { sidebar: "pinned" }, general: { consoleOpenOnLaunch: true }, onboarding: { completed: true, completedAt: new Date().toISOString() } },
      env: { PISTACHIO_E2E: undefined, PISTACHIO_AGENT_LIVE: "1" },
    }));
    shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await expect(shell.getByTestId("agent-panel")).toBeVisible();
    // A fresh profile gets its anonymous account's token from control a
    // moment after launch (docs/anonymous-accounts.md); the models — and the
    // router — are unreachable until then.
    await expect
      .poll(async () => shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getAiStatus().then((status) => status.available)), { timeout: 60_000 })
      .toBe(true);
  });

  test.afterAll(async () => {
    console.log(`[console routing live]\n${report.join("\n")}`);
    await app?.close();
  });

  test("a question is answered directly, and its reply's footer copies, retries, and reads aloud", async () => {
    // General knowledge: no browser, no tool calls, no "I'm on it".
    const first = await ask(shell, "In two sentences, what is a hash map?");
    await capture(shell, "01-answered.png");
    report.push(`answer  ${String(first.elapsedMs)} ms  steps=${String(first.run.context.steps)} tools=${String(first.run.toolCalls.length)}  ${labels(first.run).join(" | ")}`);
    expect(first.run.status).toBe("completed");
    expect(labels(first.run)).toContain("Answering directly");
    expect(labels(first.run)).not.toContain("Agent started");
    expect(first.run.toolCalls).toEqual([]);
    expect(first.run.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(lastAssistant(first.run)).toMatch(/hash|key/i);

    // The person's bubble carries no controls; the reply carries three.
    expect(await shell.getByTestId("message-actions").count()).toBe(1);
    await expect(shell.getByTestId("message-copy")).toBeVisible();
    await expect(shell.getByTestId("message-read-aloud")).toBeVisible();
    await expect(shell.getByTestId("message-retry")).toBeVisible();

    await shell.getByTestId("message-copy").click();
    await expect(shell.getByTestId("message-copy")).toHaveAttribute("aria-label", "Copied");
    const clipboard = await app.evaluate(({ clipboard: board }) => board.readText());
    expect(clipboard).toBe(lastAssistant(first.run));

    const started = Date.now();
    await shell.getByTestId("message-retry").click();
    await expect.poll(async () => (await runSnapshot(shell))?.status ?? "none", { timeout: 120_000 }).toMatch(/completed|failed/);
    const retried = await runSnapshot(shell);
    if (retried === null) throw new Error("run disappeared");
    report.push(`retry  ${String(Date.now() - started)} ms  ${labels(retried).slice(-3).join(" | ")}`);
    expect(retried.status).toBe("completed");
    expect(retried.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(labels(retried)).toContain("Retrying");
    await capture(shell, "02-retried.png");

    await shell.getByTestId("message-read-aloud").click();
    await expect(shell.getByTestId("message-read-aloud")).toHaveAttribute("aria-label", "Preparing…");
    await expect(shell.getByTestId("message-read-aloud")).toHaveAttribute("aria-label", "Read aloud", { timeout: 60_000 });
    // The player is a tab in the media stack, as for a page selection.
    await expect.poll(async () => shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getMedia().then((media) => media.length)), { timeout: 30_000 }).toBeGreaterThan(0);
    await capture(shell, "03-read-aloud.png");

    firstToolCount = retried.toolCalls.length;
    directAfterFirst = answeredDirectly(retried);
  });

  test("a follow-up stays quick, and web work goes to the browser", async () => {
    // A follow-up on the finished thread: still a reply, from the conversation.
    const second = await ask(shell, "now say that in one sentence a child would understand");
    await capture(shell, "04-followup.png");
    report.push(`answer  ${String(second.elapsedMs)} ms  steps=${String(second.run.context.steps)} tools=${String(second.run.toolCalls.length - firstToolCount)}  ${labels(second.run).slice(-2).join(" | ")}`);
    expect(second.run.status).toBe("completed");
    expect(second.run.toolCalls).toHaveLength(firstToolCount);
    expect(answeredDirectly(second.run)).toBe(directAfterFirst + 1);

    // Something on the web: the browser path, with real tool calls.
    const third = await ask(shell, "What's the weather forecast for Denver this weekend? Check a weather site.");
    await capture(shell, "05-browsed.png");
    report.push(`browse  ${String(third.elapsedMs)} ms  steps=${String(third.run.context.steps)} tools=${String(third.run.toolCalls.length)}  ${labels(third.run).slice(-3).join(" | ")}`);
    expect(["completed", "human_control", "interrupted"]).toContain(third.run.status);
    expect(answeredDirectly(third.run)).toBe(directAfterFirst + 1);
    expect(third.run.toolCalls.some((call) => call.name === "tabs.list")).toBe(true);
  });

  test("a question about the page in view is answered by reading it, with no browser action", async () => {
    // A conversation of its own, about a real page in the person's tab: the
    // IETF's example domain, small and stable.
    await shell.getByTestId("new-conversation").click();
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
    expect(labels(run)).toContain("Answering from the page");
    expect(run.activity.find((entry) => entry.label === "Answering from the page")?.detail).toMatch(/Read “Example Domain”/);
    expect(run.toolCalls).toEqual([]);
    expect(run.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(lastAssistant(run)).toMatch(/illustrative|example|documentation|literature|without.*permission/i);
  });
});
