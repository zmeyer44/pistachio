/**
 * Live accuracy check for the address bar's intent model
 * (docs/smart-suggestions.md): the real Jev through the real gateway, the
 * real settings catalog and action descriptions, the real request builder
 * and the real ordering policy — everything except React. What it measures
 * is the only thing a person experiences: WHICH ROW IS UNDER ↵.
 *
 * Skipped unless PISTACHIO_INTENT_LIVE=1 and the workspace has a gateway
 * key. Run it deliberately, from packages/shell-ui:
 *   PISTACHIO_INTENT_LIVE=1 pnpm vitest run test/address-intent.live.test.ts
 *
 * It prints one line per query — what the heuristics alone would put first,
 * what the model made of it, what ended up first — and the two accuracies
 * side by side. A full pass costs well under a tenth of a cent.
 *
 * The bar it asserts is deliberately below what it measures today: this is
 * a tripwire for a description or threshold change that breaks the feature,
 * not a benchmark to chase. Two properties are asserted outright, because
 * they are promises rather than accuracy: a destructive row is never first,
 * and the model's answer never makes ↵ WORSE on a plain web search more
 * than rarely.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createGateway } from "ai";
import { describe, expect, it } from "vitest";
import { evaluateAddressIntent } from "@pistachio/agent-runtime/address-intent";
import { sanitizeAddressIntentRequest, type AddressIntentRanking } from "@pistachio/shell-contracts/address-intent";
import { DEFAULT_SETTINGS } from "@pistachio/shell-contracts/settings";
import type { Entry } from "../src/components/address-palette";
import { ACTION_INTENT_DETAILS } from "../src/lib/action-intents";
import { rankFuzzy, STRONG_FUZZY_SCORE, type FuzzyCandidate } from "../src/lib/fuzzy";
import {
  applyIntentRanking,
  buildIntentRequest,
  NEVER_FIRST,
  shouldAskIntentModel,
  type IntentCandidateSeed,
} from "../src/lib/intent-ranking";
import { primaryItemFor, secondarySearchItems } from "../src/lib/search-suggestions";
import { SETTINGS_INTENTS, settingsIntentEntryId, settingsIntentKeywords } from "../src/lib/settings-intents";

const envPath = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find((path) => existsSync(path));
// Only when asked: an ordinary test run reads no secrets.
if (envPath !== undefined && process.env["PISTACHIO_INTENT_LIVE"] === "1") process.loadEnvFile(envPath);
const KEY = process.env["AI_GATEWAY_API_KEY"]?.trim() ?? "";
const LIVE = process.env["PISTACHIO_INTENT_LIVE"] === "1" && KEY !== "";
const MODEL_ID = process.env["PISTACHIO_INTENT_MODEL"]?.trim() || "typesafe-ai/jev";

/** A desk like anyone's: a few tabs open, a few places recently been. */
const CURRENT = { title: "Pull requests · pistachio", host: "github.com" };
const TABS = [
  { title: "Inbox (3) - zach@example.com - Gmail", host: "mail.google.com" },
  { title: "Q3 planning - Google Docs", host: "docs.google.com" },
  { title: "Linear – Active issues", host: "linear.app" },
  { title: "YouTube", host: "www.youtube.com" },
];
const RECENTS = [
  { title: "Hacker News", host: "news.ycombinator.com" },
  { title: "Vercel Dashboard", host: "vercel.com" },
  { title: "Google Calendar - Week of September 14", host: "calendar.google.com" },
];

/** The chrome's actions as the palette labels them (chrome/actions.tsx), minus React. */
const ACTION_LABELS: Record<string, string> = {
  "chrome:back": "Back",
  "chrome:forward": "Forward",
  "chrome:reload": "Reload",
  "chrome:readerView": "Reader view",
  "chrome:copyUrl": "Copy page URL",
  "chrome:copyUrlMarkdown": "Copy page URL as Markdown",
  "chrome:newTab": "New tab",
  "chrome:delegate": "Ask Pistachio about this tab",
  "chrome:toggleSplit": "Split view",
  "chrome:toggleConsole": "Open agent panel",
  "chrome:openSettings": "Settings",
  "chrome:openBrief": "Daily Brief",
  "chrome:openNotes": "Notes",
  "chrome:newNote": "New note",
  "chrome:openReminders": "Reminders",
  "chrome:openBookmarks": "Bookmarks",
  "chrome:bookmarkPage": "Bookmark this page",
  "chrome:openDownloads": "Downloads",
  "chrome:forkSpace": "Fork Space",
  "chrome:toggleSidebarPinned": "Compact sidebar",
  "chrome:togglePin": "Pin tab",
  "tab:close-current": "Close current tab",
  "tabs:clear-unpinned": "Clear unpinned tabs",
};

/**
 * `expect` lists every first row that would be RIGHT: "search", "ai",
 * "settings:<section>" (any errand on that page), "page:<host>", or an
 * action's entry id. `safe` marks the destructive case.
 */
interface Case {
  q: string;
  expect: string[];
}

const CASES: Case[] = [
  { q: "best pistachio gelato", expect: ["search"] },
  { q: "weather tomorrow", expect: ["search"] },
  { q: "nba scores", expect: ["search"] },
  { q: "iphone 17 price", expect: ["search"] },
  { q: "flights sfo to jfk", expect: ["search"] },
  { q: "taylor swift tour dates", expect: ["search"] },
  { q: "coffee near me", expect: ["search"] },
  { q: "react useeffect cleanup", expect: ["search", "ai"] },
  { q: "typescript satisfies operator", expect: ["search", "ai"] },
  { q: "who won the 1998 world cup", expect: ["search", "ai"] },
  { q: "pistachio nutrition facts", expect: ["search"] },
  { q: "settings for minecraft server", expect: ["search", "ai"] },
  // Words that NAME a row without asking for it: the traps for a target that overrides the intent.
  { q: "explain how dark mode affects battery life", expect: ["search", "ai"] },
  { q: "how do cookies work", expect: ["search", "ai"] },
  { q: "best keyboard shortcuts for vim", expect: ["search", "ai"] },
  { q: "gmail vs outlook comparison", expect: ["search", "ai"] },
  { q: "youtube video about sourdough starter", expect: ["search", "ai"] },
  { q: "why is my calendar not syncing on iphone", expect: ["search", "ai"] },
  { q: "hacker news api documentation", expect: ["search", "ai"] },
  { q: "is it safe to clear cookies", expect: ["search", "ai"] },

  { q: "explain how a tls handshake works step by step", expect: ["ai"] },
  { q: "write a polite email declining a meeting invitation", expect: ["ai"] },
  { q: "what's the difference between a mutex and a semaphore and when should I use each", expect: ["ai"] },
  { q: "help me plan a 3 day itinerary for lisbon with a toddler", expect: ["ai"] },
  { q: "summarize the main arguments for and against a four day work week", expect: ["ai"] },
  { q: "write a regex that matches iso 8601 dates", expect: ["ai"] },
  { q: "give me five name ideas for a browser startup", expect: ["ai"] },
  { q: "rewrite this sentence to sound more confident: i think we might be able to ship", expect: ["ai"] },

  { q: "my email", expect: ["page:mail.google.com"] },
  { q: "gmail", expect: ["page:mail.google.com"] },
  { q: "the planning doc", expect: ["page:docs.google.com"] },
  { q: "linear issues", expect: ["page:linear.app"] },
  { q: "hacker news", expect: ["page:news.ycombinator.com"] },
  { q: "my calendar", expect: ["page:calendar.google.com"] },

  { q: "change theme color", expect: ["settings:appearance"] },
  { q: "dark mode", expect: ["settings:appearance"] },
  { q: "change default search engine", expect: ["settings:"] },
  { q: "clear cookies", expect: ["settings:privacy"] },
  { q: "delete my browsing history", expect: ["settings:privacy"] },
  { q: "keyboard shortcuts", expect: ["settings:shortcuts"] },
  { q: "change what the agent remembers about me", expect: ["settings:memory"] },
  { q: "connect gmail to the agent", expect: ["settings:integrations"] },
  { q: "saved passwords", expect: ["settings:vault"] },
  { q: "sign out of my account", expect: ["settings:account"] },
  { q: "which version am i on", expect: ["settings:about"] },
  { q: "turn off notifications", expect: ["settings:approvals"] },
  { q: "sync my tabs", expect: ["settings:sync"] },

  { q: "open a new tab", expect: ["chrome:newTab"] },
  { q: "reload this page", expect: ["chrome:reload"] },
  { q: "copy link", expect: ["chrome:copyUrl", "chrome:copyUrlMarkdown"] },
  { q: "split screen", expect: ["chrome:toggleSplit"] },
  { q: "bookmark this", expect: ["chrome:bookmarkPage"] },
  { q: "show my downloads", expect: ["chrome:openDownloads"] },
  { q: "write something down", expect: ["chrome:newNote"] },
  { q: "my notes", expect: ["chrome:openNotes"] },
];

/** Queries whose right answer is "anything but the destructive row first". */
const DESTRUCTIVE = ["close this tab", "close all my tabs"];

interface Desk {
  heuristicEntries: Entry[];
  candidateEntries: Map<string, Entry>;
  seeds: IntentCandidateSeed[];
  matchedIds: string[];
}

/** The typed face as address-palette.tsx builds it, with rows that are only an id and a kind. */
function deskFor(q: string): Desk {
  const candidates: Array<FuzzyCandidate<Entry>> = [];
  const candidateEntries = new Map<string, Entry>();
  const seeds: IntentCandidateSeed[] = [];
  const offer = (entry: Entry, fuzzy: Omit<FuzzyCandidate<Entry>, "item">, seed: Omit<IntentCandidateSeed, "id">): void => {
    candidates.push({ item: entry, ...fuzzy });
    candidateEntries.set(entry.id, entry);
    seeds.push({ id: entry.id, ...seed });
  };
  const action = (id: string, title: string): Entry => ({ kind: "action", id, title, category: "Action", icon: null, run: () => undefined });
  for (const page of [...RECENTS, ...TABS]) {
    const entry = action(`page:${page.host}`, page.title);
    offer(entry, { text: page.title, keywords: [page.host], priority: 14 }, { kind: "page", label: page.title, detail: page.host });
  }
  for (const [id, label] of Object.entries(ACTION_LABELS)) {
    offer(action(id, label), { text: label, priority: 28 }, { kind: "command", label, detail: ACTION_INTENT_DETAILS[id] ?? "" });
  }
  for (const intent of SETTINGS_INTENTS) {
    const id = settingsIntentEntryId(intent);
    offer(
      action(id, intent.title),
      { text: intent.title, keywords: settingsIntentKeywords(intent), priority: 10 },
      { kind: "command", label: intent.title, detail: intent.description },
    );
  }
  const matches = rankFuzzy(q, candidates);
  const ranked = matches.map((match) => match.item);
  const primaryItem = primaryItemFor(q, DEFAULT_SETTINGS.search);
  if (primaryItem === null) throw new Error("empty query");
  const suggestion = (item: { id: string; url: string }): Entry => ({ kind: "suggestion", id: item.id, url: item.url, item } as Entry);
  const searches = [primaryItem, ...secondarySearchItems(q, primaryItem, DEFAULT_SETTINGS.search)].map(suggestion);
  const strong = (matches[0]?.score ?? 0) >= STRONG_FUZZY_SCORE;
  return {
    heuristicEntries: strong ? [...ranked, ...searches] : [...searches, ...ranked],
    candidateEntries,
    seeds,
    matchedIds: ranked.map((entry) => entry.id),
  };
}

const SECTION_OF = new Map(SETTINGS_INTENTS.map((intent) => [settingsIntentEntryId(intent), intent.section] as const));

/** A first row, in the vocabulary `Case.expect` is written in. */
function nameOf(entry: Entry | undefined): string {
  if (entry === undefined) return "(nothing)";
  if (entry.id === "search") return "search";
  if (entry.id === "ai-search") return "ai";
  const section = SECTION_OF.get(entry.id);
  return section === undefined ? entry.id : `settings:${section}`;
}

function top(ranking: AddressIntentRanking, field: "intents" | "targets"): string {
  const [id, p] = Object.entries(ranking[field]).sort((a, b) => b[1] - a[1])[0] ?? ["-", 0];
  return `${id} ${p.toFixed(2)}`;
}

describe.skipIf(!LIVE)("the intent model, live", () => {
  const model = createGateway({ apiKey: KEY }).evaluationModel(MODEL_ID);

  const decide = async (q: string): Promise<{ before: string; after: string; ranking: AddressIntentRanking | null }> => {
    const desk = deskFor(q);
    const primaryItem = primaryItemFor(q, DEFAULT_SETTINGS.search);
    const before = nameOf(desk.heuristicEntries[0]);
    if (!shouldAskIntentModel(q, { browsing: false, primaryKind: primaryItem?.kind ?? null, enabled: true }))
      return { before, after: before, ranking: null };
    const request = sanitizeAddressIntentRequest(
      buildIntentRequest({ query: q, currentPage: CURRENT, recentPages: RECENTS, seeds: desk.seeds, matchedIds: desk.matchedIds }),
    );
    if (request === null) throw new Error(`the sanitizer refused “${q}”`);
    const ranking = await evaluateAddressIntent({ model, request });
    const entries = applyIntentRanking({ ...desk, ranking, query: q, primaryItem });
    return { before, after: nameOf(entries[0]), ranking };
  };

  it("puts the right row under ↵ more often than the heuristics do", async () => {
    const lines: string[] = [];
    let heuristicRight = 0;
    let modelRight = 0;
    let searchesBroken = 0;
    let unanswered = 0;
    const latencies: number[] = [];
    for (const c of CASES) {
      const { before, after, ranking } = await decide(c.q);
      if (ranking === null) unanswered += 1;
      else latencies.push(ranking.latencyMs);
      const wasRight = c.expect.includes(before);
      const isRight = c.expect.includes(after);
      if (wasRight) heuristicRight += 1;
      if (isRight) modelRight += 1;
      if (c.expect.includes("search") && wasRight && !isRight) searchesBroken += 1;
      lines.push(
        `${isRight ? "✓" : "✗"} ${c.q.slice(0, 44).padEnd(44)} heuristics→${before.padEnd(22)} model→${after.padEnd(22)} ` +
          (ranking === null ? "(no answer)" : `[${top(ranking, "intents")} | ${top(ranking, "targets")}]`),
      );
    }
    latencies.sort((a, b) => a - b);
    const median = latencies[Math.floor(latencies.length / 2)] ?? 0;
    const p90 = latencies[Math.floor(latencies.length * 0.9)] ?? 0;
    console.log(
      [
        ...lines,
        "",
        `heuristics alone: ${String(heuristicRight)}/${String(CASES.length)}`,
        `with the model:   ${String(modelRight)}/${String(CASES.length)}`,
        `searches the model broke: ${String(searchesBroken)} · unanswered: ${String(unanswered)} · latency median ${String(median)} ms, p90 ${String(p90)} ms`,
      ].join("\n"),
    );
    expect(unanswered).toBeLessThanOrEqual(2);
    expect(modelRight).toBeGreaterThan(heuristicRight);
    expect(modelRight / CASES.length).toBeGreaterThanOrEqual(0.75);
    expect(searchesBroken).toBeLessThanOrEqual(1);
  }, 120_000);

  it("never puts a destructive row first, however plainly it is asked for", async () => {
    for (const q of DESTRUCTIVE) {
      const { after } = await decide(q);
      expect(NEVER_FIRST.has(after), `“${q}” put ${after} under ↵`).toBe(false);
    }
  }, 30_000);
});
