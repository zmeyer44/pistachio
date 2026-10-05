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
 * side by side. Then the two things the choice between the web search and
 * the assistant is judged on: which of them leads for an open question
 * against a lookup, and how often that changes while a sentence is typed
 * out one character at a time. A full pass costs about a cent.
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
  aiLeadsSearch,
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

/**
 * Web search or assistant: the one choice every typed sentence faces. "ai"
 * is an open question or a task — an explanation is wanted; "search" is a
 * lookup — keywords, a place to go, something to buy, or a question whose
 * answer is one live or local fact — and is right whenever the AI row is NOT
 * first; "either" is a settled fact both answer well, printed and not
 * scored. The second table was written after the option wording was fixed
 * (agent-runtime/address-intent.ts), to check the wording had not simply
 * learned the first.
 */
type Lean = "ai" | "search" | "either";

const SEARCH_OR_AI: Array<[string, Lean]> = [
  ["how does this company work?", "ai"],
  ["how does this company work", "ai"],
  ["what are some of the reasons why Amazon makes money?", "ai"],
  ["what are some of the reasons why amazon makes money", "ai"],
  ["how does stripe make money", "ai"],
  ["why is the sky blue", "ai"],
  ["why did the roman empire fall", "ai"],
  ["what should i know before buying a used car", "ai"],
  ["how do i get better at public speaking", "ai"],
  ["what is the best way to learn rust", "ai"],
  ["is it worth upgrading to the new macbook", "ai"],
  ["pros and cons of electric cars", "ai"],
  ["difference between llc and s corp", "ai"],
  ["how does a mortgage work", "ai"],
  ["what does a product manager do", "ai"],
  ["should i learn python or javascript first", "ai"],
  ["how does nvidia compare to amd", "ai"],
  ["what would happen if the moon disappeared", "ai"],
  ["can you explain quantum computing simply", "ai"],
  ["ideas for a 5 year old birthday party", "ai"],
  ["how do airlines decide ticket prices", "ai"],
  ["why are interest rates so high right now", "ai"],
  ["what makes a good cover letter", "ai"],
  ["how does openai make money", "ai"],
  ["tell me about the history of the internet", "ai"],
  ["what is a good name for a dog", "ai"],
  ["explain how a tls handshake works step by step", "ai"],
  ["write a polite email declining a meeting invitation", "ai"],
  ["help me plan a 3 day itinerary for lisbon with a toddler", "ai"],
  ["give me five name ideas for a browser startup", "ai"],
  ["why do cats purr", "ai"],
  ["what is the point of a 401k", "ai"],
  ["how come some startups fail even with lots of funding", "ai"],
  ["whats the difference between a virus and a bacteria", "ai"],
  ["how should i prepare for a system design interview", "ai"],
  ["what are the tradeoffs of server components", "ai"],
  ["is rust harder than go", "ai"],
  ["why does my sourdough not rise", "ai"],
  ["what is it like to work at a hedge fund", "ai"],
  ["how would you structure a seed round", "ai"],
  ["compare postgres and mysql for a small app", "ai"],
  ["what do economists think about tariffs", "ai"],
  ["how to tie a tie", "either"],
  ["how old is tom cruise", "either"],
  ["who is the ceo of nvidia", "either"],
  ["what is the capital of australia", "either"],
  ["who won the 1998 world cup", "either"],
  ["react useeffect cleanup", "either"],
  ["typescript satisfies operator", "either"],
  ["how do cookies work", "either"],
  ["is it safe to clear cookies", "either"],
  ["how many ounces in a cup", "either"],
  ["what does ymmv mean", "either"],
  ["how to center a div", "either"],
  ["what time is it in tokyo", "search"],
  ["what is the weather in paris this weekend", "search"],
  ["who won the lakers game last night", "search"],
  ["when does the new iphone come out", "search"],
  ["where to buy concert tickets", "search"],
  ["how much is a tesla model 3", "search"],
  ["is costco open today", "search"],
  ["when is thanksgiving 2026", "search"],
  ["what's the score of the giants game", "search"],
  ["where can i watch severance", "search"],
  ["best pistachio gelato", "search"],
  ["weather tomorrow", "search"],
  ["nba scores", "search"],
  ["iphone 17 price", "search"],
  ["flights sfo to jfk", "search"],
  ["amazon", "search"],
  ["amazon stock", "search"],
  ["amazon stock price today", "search"],
  ["nvidia earnings", "search"],
  ["stripe pricing", "search"],
  ["tesla model y review", "search"],
  ["coffee near me", "search"],
  ["new york times", "search"],
  ["react docs", "search"],
  ["taylor swift tour dates", "search"],
  ["cheap hotels in lisbon", "search"],
  ["buy airpods pro", "search"],
  ["python download", "search"],
  ["openai", "search"],
  ["latest news on the election", "search"],
  ["restaurants open now", "search"],
  ["pistachio nutrition facts", "search"],
  ["best keyboard shortcuts for vim", "search"],
  ["gmail vs outlook comparison", "either"],
  ["youtube video about sourdough starter", "search"],
  ["hacker news api documentation", "search"],
  ["settings for minecraft server", "either"],
  ["air fryer chicken thighs recipe", "search"],
  ["lebron james", "search"],
  ["openai careers", "search"],
  ["zillow san francisco", "search"],
  ["used honda civic for sale", "search"],
  ["chatgpt", "search"],
  ["facebook login", "search"],
  ["translate hello to spanish", "either"],
  ["population of canada", "either"],
];

const SEARCH_OR_AI_HELD_OUT: Array<[string, Lean]> = [
  ["how does costco keep prices so low", "ai"],
  ["why do airlines overbook flights", "ai"],
  ["what are the main causes of inflation", "ai"],
  ["how is uber different from lyft", "ai"],
  ["what makes tsmc so important", "ai"],
  ["how does this startup plan to make money", "ai"],
  ["why does google give away android for free", "ai"],
  ["how do credit card companies make a profit", "ai"],
  ["what should i consider when choosing a health insurance plan", "ai"],
  ["how can i negotiate a higher salary", "ai"],
  ["what is the best way to structure a react app", "ai"],
  ["why is my code slow", "ai"],
  ["is it better to rent or buy a house", "ai"],
  ["advantages of nuclear power", "ai"],
  ["tips for a first time manager", "ai"],
  ["ways to improve my sleep", "ai"],
  ["what happens if you dont pay taxes", "ai"],
  ["how did netflix beat blockbuster", "ai"],
  ["what are the implications of the new ai regulation", "ai"],
  ["walk me through how dns resolution works", "ai"],
  ["draft a linkedin post announcing my new job", "ai"],
  ["can you recommend a good framework for decision making", "ai"],
  ["what are good questions to ask in an interview", "ai"],
  ["how does the stock market work", "ai"],
  ["what is the meaning of life", "ai"],
  ["which is healthier, oats or eggs", "ai"],
  ["explain the plot of inception", "ai"],
  ["how are llms trained", "ai"],
  ["what does it mean when a company goes public", "ai"],
  ["who would win in a fight between a bear and a gorilla", "ai"],
  ["what is apple's business model", "ai"],
  ["thoughts on remote work vs office", "ai"],
  ["what's the story behind the fall of enron", "ai"],
  ["how do I think about pricing a saas product", "ai"],
  ["why are eggs so expensive", "either"],
  ["how tall is mount everest", "either"],
  ["who wrote pride and prejudice", "either"],
  ["what year did the berlin wall fall", "either"],
  ["calories in a banana", "either"],
  ["define ubiquitous", "either"],
  ["what is 15% of 240", "either"],
  ["how long is the flight from sfo to tokyo", "either"],
  ["how much does a stamp cost", "either"],
  ["when do the clocks change", "either"],
  ["costco hours", "search"],
  ["uber promo code", "search"],
  ["tsmc stock", "search"],
  ["netflix login", "search"],
  ["inflation rate september 2026", "search"],
  ["nyc to boston train", "search"],
  ["sushi delivery", "search"],
  ["ps5 pro best buy", "search"],
  ["warriors schedule", "search"],
  ["oppenheimer showtimes", "search"],
  ["figma", "search"],
  ["linkedin jobs product designer", "search"],
  ["dmv appointment", "search"],
  ["usps tracking", "search"],
  ["nike air max 90", "search"],
  ["eur to usd", "search"],
  ["bitcoin price", "search"],
  ["what channel is the super bowl on", "search"],
  ["who is playing at coachella this year", "search"],
  ["is the bay bridge closed right now", "search"],
  ["where is the nearest gas station", "search"],
  ["node 22 release notes", "search"],
  ["tailwind docs grid", "search"],
  ["mdn array flatmap", "search"],
  ["airbnb lisbon", "search"],
  ["reddit best budget laptop", "search"],
  ["kendrick lamar new album", "search"],
  ["apartments for rent in austin", "search"],
  ["walmart", "search"],
  ["john wick 5 trailer", "search"],
  ["taxi number", "search"],
];

/** Sentences typed out a character at a time, and where the choice should rest at the end. */
const TYPED: Array<[string, "ai" | "search"]> = [
  ["how does this company work", "ai"],
  ["what are some of the reasons why amazon makes money", "ai"],
  ["why did the roman empire fall", "ai"],
  ["how do airlines decide ticket prices", "ai"],
  ["pros and cons of electric cars", "ai"],
  ["amazon stock price today", "search"],
  ["best pistachio gelato in rome", "search"],
  ["what time is it in tokyo", "search"],
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

  /** A few at a time: the order of the answers is the order of the questions. */
  const each = async <T, R>(items: readonly T[], work: (item: T) => Promise<R>, atOnce = 8): Promise<R[]> => {
    const done: R[] = [];
    for (let i = 0; i < items.length; i += atOnce) done.push(...(await Promise.all(items.slice(i, i + atOnce).map(work))));
    return done;
  };

  it("sends an open question to the assistant and a lookup to the web", async () => {
    const lines: string[] = [];
    const tally = { ai: { right: 0, of: 0 }, search: { right: 0, of: 0 } };
    for (const [name, table] of [["first", SEARCH_OR_AI], ["held out", SEARCH_OR_AI_HELD_OUT]] as const) {
      const decided = await each(table, async ([q, want]) => ({ q, want, ...(await decide(q)) }));
      lines.push(`── ${name}`);
      for (const { q, want, after, ranking } of decided) {
        const right = want === "either" || (want === "ai" ? after === "ai" : after !== "ai");
        if (want !== "either") {
          tally[want].of += 1;
          if (right) tally[want].right += 1;
        }
        const spread = ranking === null ? "(no answer)" : `ai ${ranking.intents.ai_prompt.toFixed(2)} web ${ranking.intents.web_search.toFixed(2)}`;
        lines.push(`${right ? (want === "either" ? "·" : "✓") : "✗"} ${want.padEnd(6)} ${q.slice(0, 58).padEnd(58)} → ${after.padEnd(22)} [${spread}]`);
      }
    }
    console.log(
      [
        ...lines,
        "",
        `open questions that reached the assistant: ${String(tally.ai.right)}/${String(tally.ai.of)}`,
        `lookups that stayed off it:                ${String(tally.search.right)}/${String(tally.search.of)}`,
      ].join("\n"),
    );
    expect(tally.ai.right / tally.ai.of).toBeGreaterThanOrEqual(0.85);
    expect(tally.search.right / tally.search.of).toBeGreaterThanOrEqual(0.95);
  }, 180_000);

  it("settles on one of the two searches while a sentence is typed, and stays there", async () => {
    const lines: string[] = [];
    let changes = 0;
    let coldChanges = 0;
    let wrong = 0;
    for (const [sentence, want] of TYPED) {
      const prefixes: string[] = [];
      for (let end = 3; end <= sentence.length; end++) {
        const prefix = sentence.slice(0, end).trim();
        if (prefixes[prefixes.length - 1] !== prefix) prefixes.push(prefix);
      }
      const answers = await each(prefixes, async (q) => (await decide(q)).ranking, 12);
      // The bar's own rule (lib/use-address-intent.ts): each answer moves the
      // choice from where the last one left it. `cold` is every answer read
      // alone, which is what a bar that forgot between keystrokes would show.
      let led = false;
      let cold = false;
      let moved = 0;
      let coldMoved = 0;
      let trace = "";
      for (const ranking of answers) {
        if (ranking !== null) {
          const next = aiLeadsSearch(ranking, led);
          if (next !== led) moved += 1;
          led = next;
          const alone = aiLeadsSearch(ranking);
          if (alone !== cold) coldMoved += 1;
          cold = alone;
        }
        trace += ranking === null ? "?" : led ? "A" : "w";
      }
      changes += moved;
      coldChanges += coldMoved;
      const right = (want === "ai") === led;
      if (!right) wrong += 1;
      lines.push(`${right ? "✓" : "✗"} ${sentence.padEnd(52)} changed ${String(moved)}× (read cold: ${String(coldMoved)}×)  ${trace}`);
    }
    console.log([...lines, "", `changes of mind: ${String(changes)} held, ${String(coldChanges)} read cold, over ${String(TYPED.length)} sentences`].join("\n"));
    // Once per sentence is the ideal — the moment the words become a
    // question — and a lookup never should at all.
    expect(changes).toBeLessThanOrEqual(TYPED.length + 2);
    expect(wrong).toBeLessThanOrEqual(1);
  }, 300_000);

  it("never puts a destructive row first, however plainly it is asked for", async () => {
    for (const q of DESTRUCTIVE) {
      const { after } = await decide(q);
      expect(NEVER_FIRST.has(after), `“${q}” put ${after} under ↵`).toBe(false);
    }
  }, 30_000);
});
