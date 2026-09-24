import { describe, expect, it } from "vitest";
import { ADDRESS_INTENT_LIMITS, NO_TARGET, type AddressIntent, type AddressIntentRanking } from "@pistachio/shell-contracts/address-intent";
import {
  AI_INTENT_FLOOR,
  applyIntentRanking,
  buildIntentRequest,
  MAX_PAGE_CANDIDATES,
  NEVER_FIRST,
  TARGET_OVERRIDE_SCORE,
  shouldAskIntentModel,
  type IntentCandidateSeed,
} from "../src/lib/intent-ranking";
import type { Entry } from "../src/components/address-palette";
import type { UrlItem } from "../src/lib/search-suggestions";

const QUERY = "change theme color";

function search(hint = "↵"): Entry {
  const item: UrlItem = { id: "search", kind: "search", title: "Search Google", hint, url: "https://g/?q=x", provider: "google" };
  return { kind: "suggestion", id: item.id, url: item.url, item };
}

function ai(hint = "AI"): Entry {
  const item: UrlItem = { id: "ai-search", kind: "ai", title: "Ask ChatGPT", hint, url: "https://c/?q=x", provider: "chatgpt" };
  return { kind: "suggestion", id: item.id, url: item.url, item };
}

function goto(): Entry {
  const item: UrlItem = { id: "goto", kind: "navigate", title: "Go to github.com", hint: "↵", url: "github.com" };
  return { kind: "suggestion", id: item.id, url: item.url, item };
}

function action(id: string, title: string): Entry {
  return { kind: "action", id, title, category: "Settings", icon: null, run: () => undefined };
}

type RankingOver = Partial<Omit<AddressIntentRanking, "intents">> & { intents?: Partial<Record<AddressIntent, number>> };

/** A ranking with everything unmentioned at zero — the shape the hosts send. */
function ranked(over: RankingOver = {}): AddressIntentRanking {
  return {
    query: over.query ?? QUERY,
    intents: { web_search: 0, ai_prompt: 0, open_page: 0, browser_command: 0, ...over.intents },
    intentConfidence: over.intentConfidence ?? 0.9,
    targets: over.targets ?? {},
    targetConfidence: over.targetConfidence ?? 0.9,
    latencyMs: over.latencyMs ?? 180,
  };
}

const theme = action("settings-intent:theme", "Theme & colors");
const closeTab = action("tab:close-current", "Close current tab");

function ids(entries: readonly Entry[]): string[] {
  return entries.map((entry) => entry.id);
}

function hintOf(entries: readonly Entry[], id: string): string | undefined {
  const found = entries.find((entry) => entry.id === id);
  return found?.kind === "suggestion" ? found.item.hint : undefined;
}

describe("whether the model is asked at all", () => {
  const on = { browsing: false, primaryKind: "search" as const, enabled: true };

  it("asks about prose", () => {
    expect(shouldAskIntentModel("best pistachio gelato", on)).toBe(true);
  });

  it("never asks about an address", () => {
    expect(shouldAskIntentModel("github.com", { ...on, primaryKind: "navigate" })).toBe(false);
    // Even if the caller forgot to say so.
    expect(shouldAskIntentModel("https://example.com/x", on)).toBe(false);
  });

  it("never asks about a prefix, an unedited bar, or the setting turned off", () => {
    expect(shouldAskIntentModel("th", on)).toBe(false);
    expect(shouldAskIntentModel("theme", { ...on, browsing: true })).toBe(false);
    expect(shouldAskIntentModel("theme", { ...on, enabled: false })).toBe(false);
  });

  it("never sends a long unbroken token, wherever it sits", () => {
    const key = "sk-".concat("a".repeat(48));
    expect(shouldAskIntentModel(key, on)).toBe(false);
    expect(shouldAskIntentModel(`decode ${key} please`, on)).toBe(false);
    // A long PHRASE is prose, and fine.
    expect(shouldAskIntentModel("explain how a tls handshake works step by step", on)).toBe(true);
  });
});

describe("the request", () => {
  const seeds: IntentCandidateSeed[] = [
    { id: "typed-history:mail.google.com", kind: "page", label: "Gmail — Inbox (12)", detail: "mail.google.com" },
    { id: "typed-tab:7", kind: "page", label: "vendor.example.com/invoices/8837?token=hunter2", detail: "vendor.example.com" },
    { id: "settings-intent:theme", kind: "command", label: "Theme & colors", detail: "Change the theme." },
  ];

  it("names titles and hosts, never an address", () => {
    const request = buildIntentRequest({
      query: "  my email  ",
      currentPage: { title: "Invoices", host: "https://vendor.example.com/secret" },
      recentPages: [{ title: "Tickets", host: "help.example.com" }],
      seeds,
      matchedIds: [],
    });
    expect(request.query).toBe("my email");
    // An untitled tab borrows its own address for a name; the path and the
    // query string do not go with it.
    const tab = request.candidates.find((candidate) => candidate.id === "typed-tab:7");
    expect(tab?.label).toBe("vendor.example.com");
    expect(request.currentPage?.host).toBe("vendor.example.com");
    const text = JSON.stringify(request);
    expect(text).not.toContain("://");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("/invoices");
  });

  it("keeps a real title intact", () => {
    const request = buildIntentRequest({ query: "email", currentPage: null, recentPages: [], seeds, matchedIds: [] });
    expect(request.candidates.find((candidate) => candidate.id === "typed-history:mail.google.com")?.label).toBe("Gmail — Inbox (12)");
  });

  it("budgets the pages, then fills with commands, inside the contract's cap", () => {
    const many: IntentCandidateSeed[] = [
      ...Array.from({ length: 30 }, (_, index) => ({ id: `page:${String(index)}`, kind: "page" as const, label: `Page ${String(index)}`, detail: "example.com" })),
      ...Array.from({ length: 60 }, (_, index) => ({ id: `cmd:${String(index)}`, kind: "command" as const, label: `Command ${String(index)}`, detail: "Do the thing." })),
    ];
    const request = buildIntentRequest({ query: "anything", currentPage: null, recentPages: [], seeds: many, matchedIds: [] });
    expect(request.candidates.length).toBe(ADDRESS_INTENT_LIMITS.maxCandidates);
    expect(request.candidates.filter((candidate) => candidate.kind === "page").length).toBe(MAX_PAGE_CANDIDATES);
    expect(new Set(request.candidates.map((candidate) => candidate.id)).size).toBe(request.candidates.length);
  });

  it("clips the recent pages to the contract's cap", () => {
    const pages = Array.from({ length: 12 }, (_, index) => ({ title: `Page ${String(index)}`, host: "example.com" }));
    const request = buildIntentRequest({ query: "anything", currentPage: null, recentPages: pages, seeds: [], matchedIds: [] });
    expect(request.recentPages.length).toBe(ADDRESS_INTENT_LIMITS.maxRecentPages);
  });

  it("lets the fuzzy pass's favourites lead their kind", () => {
    const request = buildIntentRequest({
      query: "invoices",
      currentPage: null,
      recentPages: [],
      seeds,
      matchedIds: ["typed-tab:7"],
    });
    const pages = request.candidates.filter((candidate) => candidate.kind === "page");
    expect(pages[0]?.id).toBe("typed-tab:7");
  });
});

describe("applying a ranking", () => {
  const primary: UrlItem = { id: "search", kind: "search", title: "Search Google", hint: "↵", url: "https://g/?q=x" };
  const base = () => [search(), ai()];
  const candidates = new Map<string, Entry>([
    [theme.id, theme],
    [closeTab.id, closeTab],
  ]);
  const apply = (heuristicEntries: Entry[], ranking: AddressIntentRanking | null, primaryItem: UrlItem | null = primary) =>
    applyIntentRanking({ heuristicEntries, candidateEntries: candidates, ranking, query: QUERY, primaryItem });

  it("changes nothing at all when there is no answer", () => {
    const entries = base();
    // Referentially the same array: React re-renders nothing.
    expect(apply(entries, null)).toBe(entries);
  });

  it("ignores an answer to a question that is no longer being asked", () => {
    const entries = base();
    expect(apply(entries, ranked({ query: "something else", intents: { ai_prompt: 0.9 } }))).toBe(entries);
  });

  it("leaves a typed address alone", () => {
    const entries = [goto(), search("Web"), ai()];
    const typed: UrlItem = { id: "goto", kind: "navigate", title: "Go to github.com", hint: "↵", url: "github.com" };
    expect(apply(entries, ranked({ intents: { ai_prompt: 0.95 }, targets: { [theme.id]: 0.99, ...{} } }), typed)).toBe(entries);
  });

  it("gives ↵ to the AI row only past both thresholds", () => {
    const entries = base();
    const promoted = apply(entries, ranked({ intents: { ai_prompt: 0.7, web_search: 0.2 } }));
    expect(ids(promoted)).toEqual(["ai-search", "search"]);
    // ↵ is always on row one, and the row it left says what it is again.
    expect(hintOf(promoted, "ai-search")).toBe("↵");
    expect(hintOf(promoted, "search")).toBe("Web");
  });

  it("leaves the web search first when the AI row leads by too little", () => {
    const entries = base();
    expect(apply(entries, ranked({ intents: { ai_prompt: 0.6, web_search: 0.5 } }))).toBe(entries);
  });

  it("leaves the web search first when the AI row is under the floor", () => {
    const entries = base();
    expect(AI_INTENT_FLOOR).toBeGreaterThan(0.5);
    expect(apply(entries, ranked({ intents: { ai_prompt: 0.5, web_search: 0.1 } }))).toBe(entries);
  });

  it("puts a confident target first even though it never fuzzy-matched", () => {
    const entries = base();
    const order = apply(entries, ranked({ intents: { browser_command: 0.8, web_search: 0.1 }, targets: { [theme.id]: 0.82, [NO_TARGET]: 0.1 } }));
    // "change theme color" shares no letters with "Theme & colors" under the
    // fuzzy ranker's token rules; the policy pulls it from the candidate map.
    expect(ids(order)).toEqual([theme.id, "search", "ai-search"]);
    // ↵ is on row one, so neither search claims it.
    expect(hintOf(order, "search")).toBe("Web");
    expect(hintOf(order, "ai-search")).toBe("AI");
  });

  it("shows a merely likely target second, never under ↵", () => {
    const entries = base();
    const order = apply(entries, ranked({ intents: { browser_command: 0.6 }, targets: { [theme.id]: 0.35 } }));
    expect(ids(order)).toEqual(["search", theme.id, "ai-search"]);
  });

  it("ignores a likely target the intents do not ask for", () => {
    const entries = base();
    // Fairly sure about the ROW, but it read the words as a web search:
    // "youtube video about sourdough" names YouTube (0.69) and is a search.
    expect(apply(entries, ranked({ intents: { web_search: 0.9 }, targets: { [theme.id]: 0.7 } }))).toBe(entries);
  });

  it("lets a near-certain target lead even when the intents disagree", () => {
    // The two questions are answered independently: "my email" read as a web
    // search (0.73) while naming the open Gmail tab (0.84).
    const order = apply(base(), ranked({ intents: { web_search: 0.73 }, targets: { [theme.id]: TARGET_OVERRIDE_SCORE } }));
    expect(ids(order)).toEqual([theme.id, "search", "ai-search"]);
    expect(hintOf(order, "search")).toBe("Web");
  });

  it("keeps a destructive row off ↵ under the override too", () => {
    const order = apply(base(), ranked({ intents: { web_search: 0.9 }, targets: { [closeTab.id]: 0.99 } }));
    expect(order[0]?.id).toBe("search");
    expect(order[1]?.id).toBe(closeTab.id);
  });

  it("ignores `none` and everything under the floor", () => {
    const entries = base();
    expect(apply(entries, ranked({ intents: { open_page: 0.6 }, targets: { [NO_TARGET]: 0.8, [theme.id]: 0.2 } }))).toBe(entries);
  });

  it("never lets a destructive row take ↵, however sure the model is", () => {
    const entries = base();
    expect(NEVER_FIRST.has(closeTab.id)).toBe(true);
    const order = apply(entries, ranked({ intents: { browser_command: 0.95 }, targets: { [closeTab.id]: 0.97 } }));
    expect(order[0]?.id).toBe("search");
    expect(order[1]?.id).toBe(closeTab.id);
  });

  it("lists the runners-up behind a confident winner, in probability order", () => {
    const entries = base();
    const order = apply(
      entries,
      ranked({ intents: { browser_command: 0.9 }, targets: { [theme.id]: 0.6, [closeTab.id]: 0.2, [NO_TARGET]: 0.2 } }),
    );
    expect(ids(order)).toEqual([theme.id, closeTab.id, "search", "ai-search"]);
  });

  it("keeps a strong fuzzy match above the searches, and the target above it", () => {
    const strong = action("typed-tab:9", "Theme gallery");
    const entries = [strong, search(), ai()];
    const map = new Map(candidates);
    map.set(strong.id, strong);
    const kept = applyIntentRanking({
      heuristicEntries: entries,
      candidateEntries: map,
      ranking: ranked({ intents: { ai_prompt: 0.8, web_search: 0.1 } }),
      query: QUERY,
      primaryItem: primary,
    });
    // The model reorders the two searches; it does not demote the match.
    expect(ids(kept)).toEqual([strong.id, "ai-search", "search"]);
    expect(hintOf(kept, "ai-search")).toBe("AI");

    const beaten = applyIntentRanking({
      heuristicEntries: entries,
      candidateEntries: map,
      ranking: ranked({ intents: { browser_command: 0.85 }, targets: { [theme.id]: 0.7 } }),
      query: QUERY,
      primaryItem: primary,
    });
    expect(ids(beaten)).toEqual([theme.id, strong.id, "search", "ai-search"]);
  });

  it("inserts a row the fuzzy pass already found exactly once", () => {
    const entries = [search(), ai(), theme];
    const order = apply(entries, ranked({ intents: { browser_command: 0.8 }, targets: { [theme.id]: 0.9 } }));
    expect(ids(order)).toEqual([theme.id, "search", "ai-search"]);
    expect(new Set(ids(order)).size).toBe(order.length);
  });

  it("never emits a duplicate id", () => {
    const entries = [search(), ai(), theme, closeTab];
    const order = apply(
      entries,
      ranked({ intents: { browser_command: 0.9 }, targets: { [theme.id]: 0.6, [closeTab.id]: 0.3 } }),
    );
    expect(new Set(ids(order)).size).toBe(order.length);
    expect(order.length).toBe(entries.length);
  });

  it("orders equal probabilities by where the list already had them", () => {
    const entries = [search(), ai(), closeTab, theme];
    const order = apply(
      entries,
      ranked({ intents: { browser_command: 0.9 }, targets: { [theme.id]: 0.6, [closeTab.id]: 0.6 } }),
    );
    // Same probability: the row already nearer the top wins, and the
    // destructive one is still not allowed to lead.
    expect(order[0]?.id).toBe("search");
    expect(ids(order).indexOf(closeTab.id)).toBeLessThan(ids(order).indexOf(theme.id));
  });
});
