/**
 * The console router against the real models (docs/console-routing.md),
 * in the real app: a reply-shaped question answered without the browser,
 * a follow-up that stays on the quick path, and a request that needs the
 * web going to the browser agent. Runs only with PISTACHIO_AGENT_LIVE=1
 * — a live model through the account's proxy: the app as installed, on a
 * scratch profile that gets its own anonymous account from control.
 *
 *   PISTACHIO_AGENT_LIVE=1 pnpm playwright test -c e2e/playwright.config.ts console-routing.live
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { RunSummary } from "@pistachio/protocol";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/console-routing");
const live = process.env["PISTACHIO_AGENT_LIVE"] === "1";

test.describe.configure({ timeout: 360_000, mode: "serial" });
test.skip(!live, "needs PISTACHIO_AGENT_LIVE=1 and a reachable control plane");

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [process.env["PISTACHIO_ELECTRON_PATH"], join(process.cwd(), "node_modules/electron", suffix)].find(
    (candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function capture(shell: Page, filename: string): Promise<void> {
  await mkdir(screenshotDirectory, { recursive: true });
  // A playing media card animates continuously, which stalls a screenshot
  // that waits for the frame to settle: freeze animations, and never hang.
  await shell.screenshot({ path: join(screenshotDirectory, filename), animations: "disabled", timeout: 15_000 });
}

async function runSnapshot(shell: Page): Promise<RunSummary | null> {
  return shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot().then((value) => value.run));
}

async function launch(extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; shell: Page }> {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-console-routing-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "top", sidebar: "pinned" }, general: { consoleOpenOnLaunch: true }, onboarding: { completed: true, completedAt: new Date().toISOString() } }),
  );
  // Not under PISTACHIO_E2E: that flag keeps the account services — and with
  // them every model — off. This is the app as installed, on a scratch
  // profile that gets its own anonymous account.
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_AGENT_LIVE: "1", PISTACHIO_USER_DATA: userData, ...extraEnv },
  });
  const shell = await shellPage(app);
  await shell.waitForLoadState("domcontentloaded");
  await expect(shell.getByTestId("agent-panel")).toBeVisible();
  // A fresh profile gets its anonymous account's token from control a
  // moment after launch (docs/anonymous-accounts.md); the models — and the
  // router — are unreachable until then.
  await expect
    .poll(async () => shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getAiStatus().then((status) => status.available)), { timeout: 60_000 })
    .toBe(true);
  return { app, shell };
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

function lastAssistant(run: RunSummary): string {
  return [...run.messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
}

test("a question is answered directly, a follow-up stays quick, and web work goes to the browser", async () => {
  const { app, shell } = await launch();
  const report: string[] = [];
  try {
    // 1. General knowledge: no browser, no tool calls, no "I'm on it".
    const first = await ask(shell, "In two sentences, what is a hash map?");
    await capture(shell, "01-answered.png");
    report.push(`answer  ${String(first.elapsedMs)} ms  steps=${String(first.run.context.steps)} tools=${String(first.run.toolCalls.length)}  ${labels(first.run).join(" | ")}`);
    expect(first.run.status).toBe("completed");
    expect(labels(first.run)).toContain("Answering directly");
    expect(labels(first.run)).not.toContain("Agent started");
    expect(first.run.toolCalls).toEqual([]);
    expect(first.run.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(lastAssistant(first.run)).toMatch(/hash|key/i);
    const firstToolCount = first.run.toolCalls.length;

    // 2. A follow-up on the finished thread: still a reply, from the conversation.
    const second = await ask(shell, "now say that in one sentence a child would understand");
    await capture(shell, "02-followup.png");
    report.push(`answer  ${String(second.elapsedMs)} ms  steps=${String(second.run.context.steps)} tools=${String(second.run.toolCalls.length - firstToolCount)}  ${labels(second.run).slice(-2).join(" | ")}`);
    expect(second.run.status).toBe("completed");
    expect(second.run.toolCalls).toHaveLength(firstToolCount);
    expect(labels(second.run).filter((label) => label === "Answering directly")).toHaveLength(2);

    // 3. Something on the web: the browser path, with real tool calls.
    const third = await ask(shell, "What's the weather forecast for Denver this weekend? Check a weather site.");
    await capture(shell, "03-browsed.png");
    report.push(`browse  ${String(third.elapsedMs)} ms  steps=${String(third.run.context.steps)} tools=${String(third.run.toolCalls.length)}  ${labels(third.run).slice(-3).join(" | ")}`);
    expect(["completed", "human_control", "interrupted"]).toContain(third.run.status);
    expect(labels(third.run).filter((label) => label === "Answering directly")).toHaveLength(2);
    expect(third.run.toolCalls.some((call) => call.name === "tabs.list")).toBe(true);
  } finally {
    console.log(`[console routing live]\n${report.join("\n")}`);
    await app.close();
  }
});

test("the same question with the router off goes through the browser path (the baseline)", async () => {
  const { app, shell } = await launch({ PISTACHIO_TURN_ROUTER: "off" });
  try {
    const { run, elapsedMs } = await ask(shell, "In two sentences, what is a hash map?");
    await capture(shell, "04-baseline-router-off.png");
    console.log(`[console routing live] baseline (router off)  ${String(elapsedMs)} ms  steps=${String(run.context.steps)} tools=${String(run.toolCalls.length)}  ${labels(run).join(" | ")}`);
    expect(labels(run)).toContain("Agent started");
    expect(labels(run)).not.toContain("Answering directly");

    const activeTabId = await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot().then((value) => value.activeTabId));
    if (activeTabId === null) throw new Error("no active tab");
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.navigate(id, "https://example.com/"), activeTabId);
    await expect
      .poll(async () => shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot().then((value) => value.tabs.find((tab) => tab.id === value.activeTabId)?.title ?? "")), { timeout: 30_000 })
      .toMatch(/Example Domain/);
    const about = await ask(shell, "What is this page for, and what does it say I'm allowed to do with it?");
    console.log(`[console routing live] baseline (router off) page question  ${String(about.elapsedMs)} ms  steps=${String(about.run.context.steps)} tools=${String(about.run.toolCalls.length - run.toolCalls.length)}`);
    expect(labels(about.run)).not.toContain("Answering from the page");
  } finally {
    await app.close();
  }
});

test("a question about the page in view is answered by reading it, with no browser action", async () => {
  const { app, shell } = await launch();
  try {
    // A real page in the person's tab: the IETF's example domain, small and stable.
    const activeTabId = await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot().then((value) => value.activeTabId));
    if (activeTabId === null) throw new Error("no active tab");
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.navigate(id, "https://example.com/"), activeTabId);
    await expect
      .poll(async () => shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot().then((value) => value.tabs.find((tab) => tab.id === value.activeTabId)?.title ?? "")), { timeout: 30_000 })
      .toMatch(/Example Domain/);

    const { run, elapsedMs } = await ask(shell, "What is this page for, and what does it say I'm allowed to do with it?");
    await capture(shell, "05-page-in-view.png");
    console.log(`[console routing live] page  ${String(elapsedMs)} ms  steps=${String(run.context.steps)} tools=${String(run.toolCalls.length)}  ${labels(run).join(" | ")}\n  ${lastAssistant(run)}`);
    expect(run.status).toBe("completed");
    expect(labels(run)).toContain("Answering from the page");
    expect(run.activity.find((entry) => entry.label === "Answering from the page")?.detail).toMatch(/Read “Example Domain”/);
    expect(run.toolCalls).toEqual([]);
    expect(run.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(lastAssistant(run)).toMatch(/illustrative|example|documentation|literature|without.*permission/i);
  } finally {
    await app.close();
  }
});

test("a reply's footer copies, retries, and reads aloud", async () => {
  const { app, shell } = await launch();
  try {
    const first = await ask(shell, "In one sentence, what is a hash map?");
    expect(first.run.status).toBe("completed");
    await capture(shell, "06-message-actions.png");
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
    console.log(`[console routing live] retry  ${String(Date.now() - started)} ms  ${labels(retried).slice(-3).join(" | ")}\n  ${lastAssistant(retried)}`);
    expect(retried.status).toBe("completed");
    expect(retried.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(labels(retried)).toContain("Retrying");
    await capture(shell, "07-retried.png");

    await shell.getByTestId("message-read-aloud").click();
    await expect(shell.getByTestId("message-read-aloud")).toHaveAttribute("aria-label", "Preparing…");
    await expect(shell.getByTestId("message-read-aloud")).toHaveAttribute("aria-label", "Read aloud", { timeout: 60_000 });
    // The player is a tab in the media stack, as for a page selection.
    await expect.poll(async () => shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getMedia().then((media) => media.length)), { timeout: 30_000 }).toBeGreaterThan(0);
    await capture(shell, "08-read-aloud.png");
  } finally {
    await app.close();
  }
});
