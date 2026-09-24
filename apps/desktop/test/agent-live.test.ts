/**
 * Live, end-to-end exercise of the long-running agent: the real model (the
 * workspace's AI Gateway key), the real runner, controller, and thread
 * store — against a browser that fetches real pages over HTTP instead of
 * an Electron view, so it runs without the app.
 *
 * Skipped unless PISTACHIO_AGENT_LIVE=1. Run it deliberately:
 *   PISTACHIO_AGENT_LIVE=1 pnpm vitest run test/agent-live.test.ts
 *
 * Budgets are set small on purpose so compaction and checkpoints happen
 * during a task of ordinary size, and every one of those paths is seen
 * working with a real model rather than a scripted one.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NotificationRouter } from "@pistachio/notifications";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import type { BrowserController } from "../src/main/browser-controller";
import { RunController } from "../src/main/run-controller";
import { ThreadStore } from "../src/main/thread-store";

const LIVE = process.env["PISTACHIO_AGENT_LIVE"] === "1";

interface Control {
  role: string;
  name: string;
  selector: string;
  href: string | null;
  type: string | null;
  disabled: boolean;
}

interface Page {
  title: string;
  url: string;
  text: string;
  controls: Control[];
}

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** A page as the agent's page_inspect would see it, from raw HTML. */
function parsePage(url: string, html: string): Page {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? url).trim();
  const controls: Control[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const name = decode((match[2] ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (name === "") continue;
    let href: string;
    try {
      href = new URL(match[1] ?? "", url).toString();
    } catch {
      continue;
    }
    const selector = `a[href="${href}"]`;
    if (seen.has(selector)) continue;
    seen.add(selector);
    controls.push({ role: "link", name: name.slice(0, 120), selector, href, type: null, disabled: false });
    if (controls.length >= 180) break;
  }
  const text = decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24_000);
  return { title, url, text, controls };
}

/**
 * The browser the controller drives: tabs whose pages come from fetch.
 * Clicking a link navigates; typing has nothing to type into.
 */
class FetchBrowser {
  readonly #tabs = new Map<string, { info: BrowserTabInfo; page: Page | null; history: string[]; index: number }>();
  #active: string | null = null;
  #next = 1;
  readonly fetched: string[] = [];

  constructor() {
    const id = this.#add("about:blank");
    this.#active = id;
  }

  #add(url: string): string {
    const id = `tab-${String(this.#next++)}`;
    this.#tabs.set(id, {
      info: { id, spaceId: "work", title: url, url, faviconUrl: null, loading: false, canGoBack: false, canGoForward: false, kind: "human", runId: null, anchorId: null, lifecycle: "live", lastActiveAt: Date.now(), unlisted: false },
      page: null,
      history: [url],
      index: 0,
    });
    return id;
  }

  #require(tabId: string) {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) throw new Error(`no tab ${tabId}`);
    return tab;
  }

  async #load(tabId: string, url: string, record = true): Promise<void> {
    const tab = this.#require(tabId);
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Pistachio live test)" }, redirect: "follow" });
    const html = await response.text();
    this.fetched.push(url);
    tab.page = parsePage(response.url || url, html);
    tab.info = { ...tab.info, url: tab.page.url, title: tab.page.title };
    if (record) {
      tab.history = [...tab.history.slice(0, tab.index + 1), tab.page.url];
      tab.index = tab.history.length - 1;
    }
    tab.info.canGoBack = tab.index > 0;
    tab.info.canGoForward = tab.index < tab.history.length - 1;
  }

  allTabs(): BrowserTabInfo[] {
    return [...this.#tabs.values()].map((tab) => ({ ...tab.info }));
  }

  activeTab(): BrowserTabInfo | null {
    return this.#active === null ? null : { ...this.#require(this.#active).info };
  }

  tab(tabId: string): BrowserTabInfo | null {
    return this.#tabs.get(tabId)?.info ?? null;
  }

  async createTab(url?: string): Promise<string> {
    const id = this.#add(url ?? "about:blank");
    this.#active = id;
    if (url !== undefined) await this.#load(id, url);
    return id;
  }

  async selectTab(tabId: string): Promise<void> {
    this.#require(tabId);
    this.#active = tabId;
  }

  async navigate(tabId: string, url: string): Promise<void> {
    await this.#load(tabId, url);
  }

  async goBack(tabId: string): Promise<void> {
    const tab = this.#require(tabId);
    if (tab.index === 0) return;
    tab.index -= 1;
    await this.#load(tabId, tab.history[tab.index]!, false);
  }

  async goForward(tabId: string): Promise<void> {
    const tab = this.#require(tabId);
    if (tab.index >= tab.history.length - 1) return;
    tab.index += 1;
    await this.#load(tabId, tab.history[tab.index]!, false);
  }

  async reload(tabId: string): Promise<void> {
    const tab = this.#require(tabId);
    await this.#load(tabId, tab.info.url, false);
  }

  async inspectPage(tabId: string): Promise<Page> {
    const tab = this.#require(tabId);
    if (tab.page === null) return { title: tab.info.title, url: tab.info.url, text: "", controls: [] };
    return tab.page;
  }

  async clickPage(tabId: string, target: string): Promise<void> {
    const tab = this.#require(tabId);
    const wanted = target.trim().toLowerCase();
    const control = tab.page?.controls.find((item) => item.selector === target || item.name.toLowerCase() === wanted || item.href === target)
      ?? tab.page?.controls.find((item) => item.name.toLowerCase().includes(wanted));
    if (control?.href === null || control === undefined) throw new Error(`no clickable control matches ${target}`);
    await this.#load(tabId, control.href);
  }

  async typePage(): Promise<void> {
    throw new Error("no editable control on this page");
  }

  async scrollPage(): Promise<void> {}

  async screenshotPage(): Promise<string> {
    return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  }

  async submitAgentAction(): Promise<string> {
    return "completed";
  }

  async applyAgentDraft(): Promise<void> {}
}

const TASK =
  "Go to https://news.ycombinator.com and collect the titles and point counts of the top 5 stories on the front page. Then open the comment pages (the 'comments' links) of the top 2 stories and count how many comments each shows. Keep your notes as you go. Report the 5 titles with points, and the comment counts for the top 2.";

function controllerFor(
  browser: FetchBrowser,
  threads: ThreadStore,
  log: string[],
  tuning: { compactAt: number; stepsPerCall: number; continuations: number } = { compactAt: 30_000, stepsPerCall: 8, continuations: 6 },
): RunController {
  return new RunController({
    browser: browser as unknown as BrowserController,
    notifications: new NotificationRouter([]),
    onChange: () => {},
    threads,
    // Small on purpose: compaction and checkpoints must happen during this task.
    budget: { window: 200_000, compactAt: tuning.compactAt },
    limits: { stepsPerCall: tuning.stepsPerCall, continuations: tuning.continuations },
    onRunEnded: (run) => log.push(`ended: ${run.status}`),
  });
}

const LONG_TASK =
  "Visit these three Wikipedia articles: https://en.wikipedia.org/wiki/Electron_(software_framework), https://en.wikipedia.org/wiki/Chromium_(web_browser), and https://en.wikipedia.org/wiki/V8_(JavaScript_engine). For each one, record the initial release year and the original developer from the article's infobox. Keep notes as you go. Finally report a three-row list: name — initial release — developer.";

function transcript(controller: RunController): string {
  const run = controller.snapshot();
  if (run === null) return "(no run)";
  const lines = run.messages.map((message) => `${message.role.toUpperCase()} [t${String(message.turn ?? 0)}]: ${message.content}`);
  const tools = run.toolCalls.map((tool) => `  · t${String(tool.turn ?? 0)} ${tool.name} ${tool.status}: ${tool.detail.slice(0, 100)}`);
  return [...lines, "TOOLS:", ...tools, `NOTES:\n${run.notes}`, `CONTEXT: ${JSON.stringify(run.context)}`].join("\n");
}

describe.skipIf(!LIVE)("live long-running agent", () => {
  it(
    "researches across pages with notes, compaction, and checkpoints; continues after completion; survives a restart",
    async () => {
      process.env["PISTACHIO_AGENT_LIVE"] = "1";
      const dir = mkdtempSync(join(tmpdir(), "pistachio-live-"));
      const log: string[] = [];
      const browser = new FetchBrowser();
      const threads = new ThreadStore(dir);
      const controller = controllerFor(browser, threads, log);

      // Turn 1: the research task.
      await controller.start(TASK);
      let run = controller.snapshot();
      console.log(`\n===== TURN 1 =====\n${transcript(controller)}`);
      expect(run).not.toBeNull();
      expect(run!.status).toBe("completed");
      const runId = run!.runId;
      expect(run!.turns).toBe(1);
      expect(run!.toolCalls.some((tool) => tool.name === "page.inspect" && tool.status === "completed")).toBe(true);
      expect(browser.fetched.some((url) => url.includes("news.ycombinator.com"))).toBe(true);
      const answer1 = run!.messages.filter((message) => message.role === "assistant").at(-1)!.content;
      expect(answer1).not.toMatch(/I finished the browser task and verified/);
      expect(answer1.length).toBeGreaterThan(80);
      // The agent kept notes, and the runtime kept the context bounded.
      expect(run!.notes.trim()).not.toBe("");
      expect(run!.context.totalSteps).toBeGreaterThan(3);
      expect(run!.context.tokens).not.toBeNull();
      expect(run!.context.tokens!).toBeLessThan(60_000);

      // Turn 2: a follow-up that depends on what was learned in turn 1.
      await controller.message("Which of those five stories had the most points? Reply with the title only.");
      run = controller.snapshot();
      console.log(`\n===== TURN 2 =====\n${transcript(controller)}`);
      expect(run!.runId).toBe(runId);
      expect(run!.status).toBe("completed");
      expect(run!.turns).toBe(2);
      const answer2 = run!.messages.filter((message) => message.role === "assistant").at(-1)!.content;
      expect(answer2.trim()).not.toBe("");
      expect(answer2).not.toMatch(/I finished the browser task and verified/);

      // The thread is on disk; a "restart" reopens it with notes and history.
      controller.flush();
      const reopened = new ThreadStore(dir);
      expect(reopened.list().map((item) => item.runId)).toEqual([runId]);
      const second = controllerFor(new FetchBrowser(), reopened, log);
      second.restore();
      const restored = second.snapshot();
      expect(restored?.runId).toBe(runId);
      expect(restored?.status).toBe("completed");
      expect(restored?.notes).toBe(run!.notes);
      expect(restored?.messages.length).toBe(run!.messages.length);

      // Turn 3, after the restart, still answers from the thread's context.
      await second.message("What was the title of the second story in your list? Title only.");
      run = second.snapshot();
      console.log(`\n===== TURN 3 (after restart) =====\n${transcript(second)}`);
      expect(run!.runId).toBe(runId);
      expect(run!.status).toBe("completed");
      expect(run!.turns).toBe(3);
      const answer3 = run!.messages.filter((message) => message.role === "assistant").at(-1)!.content;
      expect(answer3.trim()).not.toBe("");

      // A fresh conversation leaves the old one in the list; it reopens intact.
      await second.newThread();
      expect(second.snapshot()).toBeNull();
      expect(second.threads().map((item) => item.runId)).toEqual([runId]);
      second.openThread(runId);
      expect(second.snapshot()?.runId).toBe(runId);
      expect(second.snapshot()?.turns).toBe(3);
      console.log(`\n===== LOG =====\n${log.join("\n")}`);
    },
    900_000,
  );

  it(
    "compacts a long thread, pauses honestly at the step budget, and resumes to finish",
    async () => {
      process.env["PISTACHIO_AGENT_LIVE"] = "1";
      const dir = mkdtempSync(join(tmpdir(), "pistachio-live-long-"));
      const log: string[] = [];
      const browser = new FetchBrowser();
      const threads = new ThreadStore(dir);
      // Three big pages against a 14k budget forces compaction; three steps
      // per call with no continuation forces a budget pause before the task
      // can finish (a good model reads all three pages in one step).
      const controller = controllerFor(browser, threads, log, { compactAt: 14_000, stepsPerCall: 3, continuations: 0 });

      await controller.start(LONG_TASK);
      let run = controller.snapshot();
      console.log(`\n===== LONG TASK, TURN 1 =====\n${transcript(controller)}`);
      expect(run).not.toBeNull();
      expect(["interrupted", "completed"]).toContain(run!.status);
      const runId = run!.runId;
      let resumes = 0;
      while (run!.status === "interrupted" && resumes < 6) {
        // The honest pause: no result, no "completed", and the person is told why.
        const last = run!.messages.filter((message) => message.role === "assistant").at(-1)!.content;
        expect(last).toMatch(/steps this turn/);
        expect(last).toMatch(/Resume/);
        expect(run!.result).toBeNull();
        expect(controller.busy()).toBe(false);
        resumes += 1;
        await controller.releaseControl();
        run = controller.snapshot();
        console.log(`\n===== LONG TASK, AFTER RESUME ${String(resumes)} =====\n${transcript(controller)}`);
        expect(run!.runId).toBe(runId);
      }
      expect(run!.status).toBe("completed");
      expect(resumes).toBeGreaterThan(0);
      const answer = run!.messages.filter((message) => message.role === "assistant").at(-1)!.content;
      expect(answer).toMatch(/Chromium/);
      expect(answer).toMatch(/V8/);
      expect(answer).toMatch(/Electron/);
      expect(answer).not.toMatch(/I finished the browser task and verified/);
      // Compaction happened, was surfaced in the thread, and the notes carried the facts through it.
      expect(run!.context.compactions).toBeGreaterThan(0);
      expect(run!.messages.some((message) => message.role === "system" && message.content.startsWith("Context compacted"))).toBe(true);
      expect(run!.notes).toMatch(/Chromium/);
      expect(run!.context.tokens).not.toBeNull();
      expect(run!.context.tokens!).toBeLessThan(40_000);
      // Every one of the three pages was actually fetched.
      for (const slug of ["Electron_(software_framework)", "Chromium_(web_browser)", "V8_(JavaScript_engine)"]) {
        expect(browser.fetched.some((url) => url.includes(slug))).toBe(true);
      }
      console.log(`\n===== LOG =====\n${log.join("\n")}`);
    },
    900_000,
  );
});
