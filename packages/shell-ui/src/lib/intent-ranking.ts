/**
 * The policy that turns the intent model's probabilities into an order
 * (docs/smart-suggestions.md §3 and §6). Pure: no React, no store, no fetch.
 *
 * The division of labour this file exists to enforce: the MODEL RANKS, the
 * SHELL DECIDES. Everything arriving here is a number attached to an id the
 * shell itself offered. Nothing here can introduce a row, an address or an
 * action, and every threshold is a named constant so the policy can be read
 * and argued with rather than reverse-engineered from a sort.
 *
 * Three questions, in the order they are asked:
 *
 * 1. `shouldAskIntentModel` — is this even prose? A typed address, a
 *    two-letter prefix, a pasted forty-character token and an untouched
 *    prefill are all decided by the heuristics alone, and cost nothing.
 * 2. `buildIntentRequest` — what may the model choose between? Titles and
 *    hosts only; never a URL, a path or a query string.
 * 3. `applyIntentRanking` — given an answer, what does the list look like?
 *    When the answer is null, stale, or not confident enough to move
 *    anything, the heuristic array comes back REFERENTIALLY UNCHANGED, so
 *    React re-renders nothing at all.
 */

import {
  ADDRESS_INTENT_LIMITS,
  NO_TARGET,
  type AddressIntent,
  type AddressIntentCandidate,
  type AddressIntentPage,
  type AddressIntentRanking,
  type AddressIntentRequest,
} from "@pistachio/shell-contracts/address-intent";
import type { Entry } from "../components/address-palette";
import type { UrlItem } from "./search-suggestions";
import { isProbablyUrl } from "./url";

// ── Thresholds ─────────────────────────────────────────────────────────────
// Every number the policy turns on, in one place. They are deliberately
// conservative: a wrong row under ↵ costs far more than a right row in
// second place, and the model's own documentation asks for confidence gates
// rather than argmax.

/** The AI prompt takes ↵ from the web search only at or above this. */
export const AI_INTENT_FLOOR = 0.55;
/** …and only while it leads the web search by at least this much. */
export const AI_INTENT_LEAD = 0.15;
/** A target is considered at all only when the two "a thing" readings sum to this. */
export const TARGET_INTENT_FLOOR = 0.5;
/** A target at or above this takes the first row outright. */
export const TARGET_FIRST_SCORE = 0.5;
/**
 * A target at or above this leads even when the `intent` question read the
 * words as a search or a prompt. The two questions are answered
 * independently and sometimes disagree — "my email" reads as a web search
 * (0.73) while naming the open Gmail tab (0.84) — and of the two, a
 * near-certain pick among concrete rows is the better evidence: `none` is
 * always on offer, and ordinary searches put 0.95+ on it.
 */
export const TARGET_OVERRIDE_SCORE = 0.8;
/** Below that but at or above this, it is shown second — visible, never the default. */
export const TARGET_SECOND_SCORE = 0.25;
/** Further targets worth listing behind the first one. */
export const TARGET_KEEP_SCORE = 0.15;
/** A single unbroken token longer than this is a key or a paste, not an intent. */
export const MAX_INTENT_TOKEN_CHARS = 32;
/** How many places-to-go the request may name, leaving room for the commands. */
export const MAX_PAGE_CANDIDATES = 10;
/** Milliseconds a reorder keeps answering ↵ with the row that was first before it. */
export const REORDER_GRACE_MS = 150;

/**
 * Rows the model may never promote to the first position, however sure it
 * is. Each of them destroys something a person would have to rebuild by
 * hand, and "I meant the other one" is not an undo. They may still rise to
 * second, where they are visible but not what ↵ does.
 *
 * - `tab:close-current` — closes the page being edited over.
 * - `tabs:clear-unpinned` — closes every day tab in the Space at once.
 * - `chrome:togglePin` — on a pinned tab this UNPINS it, dropping the kept
 *   page out of the sidebar (CHROME_ACTIONS.togglePin). Nothing else in
 *   CHROME_ACTIONS removes anything: the rest navigate, toggle a panel,
 *   copy, open a page, or fork a Space, and all of them are undone by doing
 *   them again.
 */
export const NEVER_FIRST: ReadonlySet<string> = new Set(["tab:close-current", "tabs:clear-unpinned", "chrome:togglePin"]);

// ── 1. Whether to ask at all ───────────────────────────────────────────────

export interface IntentGate {
  /** The bar still holds what it opened with: there is no question yet. */
  browsing: boolean;
  /** What the heuristics made of the text: "navigate" is an address, and settled. */
  primaryKind: UrlItem["kind"] | null;
  /** `settings.search.smartSuggestions`. */
  enabled: boolean;
}

/**
 * Whether the typed text is prose worth a model call (§3). Everything this
 * refuses is something the heuristics already decide correctly and for free
 * — and the long-token case is also a promise: a pasted key never leaves the
 * machine looking for a suggestion.
 */
export function shouldAskIntentModel(query: string, gate: IntentGate): boolean {
  if (!gate.enabled || gate.browsing) return false;
  const q = query.trim();
  if (q.length < ADDRESS_INTENT_LIMITS.minQueryChars) return false;
  if (gate.primaryKind === "navigate" || isProbablyUrl(q)) return false;
  return !q.split(/\s+/).some((token) => token.length > MAX_INTENT_TOKEN_CHARS);
}

// ── 2. The request ─────────────────────────────────────────────────────────

/**
 * One row as the request may describe it: what it is called and what it does
 * or controls, with `id` the shell's own entry id so the answer comes back
 * addressed to a row that already exists.
 */
export interface IntentCandidateSeed {
  id: string;
  kind: "page" | "command";
  label: string;
  detail: string;
}

export interface IntentRequestInput {
  query: string;
  currentPage: AddressIntentPage | null;
  /** Most recent first; clipped to the contract's cap. */
  recentPages: readonly AddressIntentPage[];
  /** Everything offerable, in the order the shell would rather send it. */
  seeds: readonly IntentCandidateSeed[];
  /** Entry ids the fuzzy pass matched, best first — they lead their kind. */
  matchedIds: readonly string[];
}

/** Strip the scheme, path, query and fragment from a token that reads as an address. */
function hostPart(token: string): string {
  const bare = token.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "");
  const cut = bare.search(/[/?#]/);
  return cut < 0 ? bare : bare.slice(0, cut);
}

/**
 * Text safe to send. Titles are not under our control — an untitled tab
 * borrows its own address for a name — so any word that reads as an address
 * is reduced to its host before it leaves. Whitespace is collapsed and the
 * result clipped, the same way the host's sanitizer would.
 */
function scrubbed(text: string, max: number): string {
  return text
    .split(/\s+/)
    .map((token) => (isProbablyUrl(token) ? hostPart(token) : token))
    .join(" ")
    .trim()
    .slice(0, max);
}

function candidateOf(seed: IntentCandidateSeed): AddressIntentCandidate {
  const label = scrubbed(seed.label, ADDRESS_INTENT_LIMITS.maxLabelChars);
  const detail = scrubbed(seed.detail, ADDRESS_INTENT_LIMITS.maxDetailChars);
  return detail === "" ? { id: seed.id, kind: seed.kind, label } : { id: seed.id, kind: seed.kind, label, detail };
}

function pageOf(page: AddressIntentPage): AddressIntentPage {
  return {
    title: scrubbed(page.title, ADDRESS_INTENT_LIMITS.maxTitleChars),
    host: scrubbed(page.host, ADDRESS_INTENT_LIMITS.maxTitleChars),
  };
}

/**
 * The request for one keystroke's worth of typing (§4). Small on purpose:
 * the model's documented weakness is a state full of irrelevant detail, and
 * its documented blast radius is whatever it is told. So the context is the
 * current page and at most six recent ones as title and host, and the
 * candidates are capped with the PAGES budgeted first (ten) and the commands
 * filling the rest — commands the fuzzy pass already liked leading, then
 * every settings errand, then whatever else fits.
 *
 * The host re-enforces all of this (`sanitizeAddressIntentRequest`); doing it
 * here too is what keeps a rejected request from being the way we find out.
 */
export function buildIntentRequest(input: IntentRequestInput): AddressIntentRequest {
  const rank = new Map(input.matchedIds.map((id, index) => [id, index] as const));
  const byMatch = (seeds: readonly IntentCandidateSeed[]): IntentCandidateSeed[] =>
    seeds
      .map((seed, order) => ({ seed, order, rank: rank.get(seed.id) ?? Number.POSITIVE_INFINITY }))
      .sort((left, right) => left.rank - right.rank || left.order - right.order)
      .map(({ seed }) => seed);

  const seen = new Set<string>([NO_TARGET]);
  const unique = input.seeds.filter((seed) => {
    if (seed.id === "" || seed.label === "" || seen.has(seed.id)) return false;
    seen.add(seed.id);
    return true;
  });

  const pages = byMatch(unique.filter((seed) => seed.kind === "page")).slice(0, MAX_PAGE_CANDIDATES);
  const commands = byMatch(unique.filter((seed) => seed.kind === "command")).slice(
    0,
    Math.max(0, ADDRESS_INTENT_LIMITS.maxCandidates - pages.length),
  );

  return {
    query: input.query.trim().slice(0, ADDRESS_INTENT_LIMITS.maxQueryChars),
    currentPage: input.currentPage === null ? null : pageOf(input.currentPage),
    recentPages: input.recentPages.slice(0, ADDRESS_INTENT_LIMITS.maxRecentPages).map(pageOf),
    candidates: [...commands, ...pages].map(candidateOf),
  };
}

// ── 3. The order ───────────────────────────────────────────────────────────

export interface IntentRankingInput {
  /** The order the heuristics produced — what is on screen right now. */
  heuristicEntries: Entry[];
  /** Every row the model was allowed to name, including ones the fuzzy pass dropped. */
  candidateEntries: ReadonlyMap<string, Entry>;
  /** The answer, or null while there is none (or none was asked for). */
  ranking: AddressIntentRanking | null;
  /** What is typed NOW: an answer to anything else is stale and ignored. */
  query: string;
  /** The heuristics' first result; a typed address is never reordered. */
  primaryItem: UrlItem | null;
}

/** The hint a suggestion row wears when it is not the one under ↵. */
function restingHint(item: UrlItem): string | undefined {
  if (item.kind === "search") return "Web";
  if (item.kind === "ai") return "AI";
  return item.hint;
}

function withHint(entry: Entry, hint: string | undefined): Entry {
  if (entry.kind !== "suggestion" || entry.item.hint === hint) return entry;
  const item: UrlItem = { ...entry.item };
  if (hint === undefined) delete item.hint;
  else item.hint = hint;
  return { ...entry, item };
}

function sameOrder(left: readonly Entry[], right: readonly Entry[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * The model's answer, turned into a list (§6).
 *
 * Three moves, each gated on its own threshold, and each of them only ever a
 * REORDER of rows the shell already built:
 *
 * - **Search versus AI.** The AI row takes ↵ from the web search when
 *   `P(ai_prompt) ≥ AI_INTENT_FLOOR` and it leads `P(web_search)` by
 *   `AI_INTENT_LEAD`. Nothing else moves; the two searches stay adjacent,
 *   because they are one question — "where should these words go".
 * - **A confident target.** When the two "a thing" readings together reach
 *   `TARGET_INTENT_FLOOR` and the best named row reaches
 *   `TARGET_FIRST_SCORE` — or the row reaches `TARGET_OVERRIDE_SCORE` on its
 *   own, whatever the intent question made of the words — that row leads, and the other named rows above
 *   `TARGET_KEEP_SCORE` follow it in probability order. The rest of the list
 *   keeps the order the heuristics gave it, which is how a strong fuzzy
 *   match keeps its place above the searches — the model's target goes above
 *   it, not the searches.
 * - **A likely target.** Between `TARGET_SECOND_SCORE` and
 *   `TARGET_FIRST_SCORE` — or above it but on the `NEVER_FIRST` list — the
 *   row is inserted SECOND: the person sees it without ↵ committing to it.
 *
 * Ties (equal probabilities) fall first to the row already nearer the top of
 * the heuristic list, then to the lexicographically smaller id, so the same
 * answer always produces the same list.
 *
 * Returns `heuristicEntries` itself whenever nothing moved.
 */
export function applyIntentRanking(input: IntentRankingInput): Entry[] {
  const { heuristicEntries, candidateEntries, ranking, primaryItem } = input;
  if (ranking === null) return heuristicEntries;
  // A typed address is settled; no request was made, and a late answer to an
  // earlier keystroke describes a list that is no longer on screen.
  if (primaryItem?.kind === "navigate") return heuristicEntries;
  if (ranking.query !== input.query.trim()) return heuristicEntries;

  const intents = (name: AddressIntent): number => {
    const value = ranking.intents[name];
    return Number.isFinite(value) ? value : 0;
  };

  // The search block, reordered in place: the rows keep the slots the
  // heuristics gave them, only their contents may swap.
  const aiLeads = intents("ai_prompt") >= AI_INTENT_FLOOR && intents("ai_prompt") - intents("web_search") >= AI_INTENT_LEAD;
  const slots: number[] = [];
  const block: Entry[] = [];
  heuristicEntries.forEach((entry, index) => {
    if (entry.kind !== "suggestion") return;
    slots.push(index);
    block.push(entry);
  });
  if (aiLeads) {
    const ai = block.findIndex((entry) => entry.kind === "suggestion" && entry.item.kind === "ai");
    if (ai > 0) block.unshift(...block.splice(ai, 1));
  }
  const base = heuristicEntries.slice();
  slots.forEach((slot, index) => {
    const entry = block[index];
    if (entry !== undefined) base[slot] = entry;
  });

  // The targets the model named, best first, ignoring `none`, anything it
  // scored too low to be worth a row, and anything the shell cannot resolve.
  const position = new Map(heuristicEntries.map((entry, index) => [entry.id, index] as const));
  const targets = Object.entries(ranking.targets)
    .filter(([id, p]) => id !== NO_TARGET && Number.isFinite(p) && p >= TARGET_KEEP_SCORE)
    .map(([id, p]) => ({ id, p, entry: candidateEntries.get(id) ?? heuristicEntries.find((row) => row.id === id) }))
    .filter((target): target is { id: string; p: number; entry: Entry } => target.entry !== undefined)
    .sort(
      (left, right) =>
        right.p - left.p ||
        (position.get(left.id) ?? Number.POSITIVE_INFINITY) - (position.get(right.id) ?? Number.POSITIVE_INFINITY) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );

  const wantsTarget = intents("open_page") + intents("browser_command") >= TARGET_INTENT_FLOOR;
  const best = targets[0];
  const certain = best !== undefined && best.p >= TARGET_OVERRIDE_SCORE;
  const leads =
    best !== undefined && !NEVER_FIRST.has(best.id) && (certain || (wantsTarget && best.p >= TARGET_FIRST_SCORE));
  const shows = best !== undefined && (certain || (wantsTarget && best.p >= TARGET_SECOND_SCORE));

  let ordered: Entry[];
  if (leads) {
    const promoted = targets.map((target) => target.entry);
    const promotedIds = new Set(promoted.map((entry) => entry.id));
    ordered = [...promoted, ...base.filter((entry) => !promotedIds.has(entry.id))];
  } else if (shows && best !== undefined) {
    const rest = base.filter((entry) => entry.id !== best.id);
    ordered = [...rest.slice(0, 1), best.entry, ...rest.slice(1)];
  } else {
    ordered = base;
  }

  // Ids are React keys and the index ↑/↓ walks; a row pulled from the
  // candidate map must appear exactly once.
  const emitted = new Set<string>();
  const deduped = ordered.filter((entry) => (emitted.has(entry.id) ? false : (emitted.add(entry.id), true)));
  if (sameOrder(deduped, heuristicEntries)) return heuristicEntries;

  // ↵ is always on row one, so the hints have to say so: whichever search
  // ends up leading wears the ↵, and the one that did not goes back to
  // naming itself.
  return deduped.map((entry, index) =>
    entry.kind === "suggestion" ? withHint(entry, index === 0 ? "↵" : restingHint(entry.item)) : entry,
  );
}
