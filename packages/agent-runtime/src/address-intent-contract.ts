/**
 * What the typed words in the address bar most likely MEAN, as judged by a
 * System One evaluation model (TypeSafe's Jev, through the Vercel AI Gateway:
 * docs/smart-suggestions.md) — the wire shapes alone.
 *
 * The address bar's own heuristics still decide everything they can decide
 * alone — a typed or pasted address is a place to go, and no model is asked.
 * What they cannot tell apart is prose: "best pistachio gelato" is a web
 * search, "explain how tls handshakes work" is a prompt for an assistant,
 * "change theme color" is a settings page, "my email" is the Gmail tab. For
 * those the shell sends the typed text, a little context, and the candidates
 * it could offer, and gets back a probability for each reading. The shell —
 * never the model — decides what to do with them (lib/intent-ranking).
 *
 * The model picks only among ids the shell sent. It writes no text, names no
 * address, and runs nothing; the worst a wrong (or manipulated — page titles
 * are untrusted) answer can do is put the wrong row first.
 *
 * This file is the shapes and the bounds, and NOTHING else: no `ai` import,
 * no Node, no DOM. It sits here rather than in `@pistachio/shell-contracts`
 * (which re-exports it verbatim as `@pistachio/shell-contracts/address-intent`,
 * the name the shell UI imports) because the evaluator beside it —
 * ./address-intent.ts — is what both hosts call, and that package already
 * depends on this one; the other direction would be a cycle. The split also
 * keeps the AI SDK out of the renderer bundle: the contract a page imports
 * pulls in no model code at all.
 */

/** The four readings of typed prose. Ids are the model's option names. */
export const ADDRESS_INTENTS = ["web_search", "ai_prompt", "open_page", "browser_command"] as const;
export type AddressIntent = (typeof ADDRESS_INTENTS)[number];

/** The option that means "none of the candidates is what they want". */
export const NO_TARGET = "none";

/**
 * One thing the shell could offer for the typed text, beyond the two
 * searches. `id` is the shell's own entry id (`settings-intent:theme`,
 * `chrome:newTab`, `typed-tab:…`) and comes back as the key of
 * `AddressIntentRanking.targets`.
 */
export interface AddressIntentCandidate {
  id: string;
  /**
   * "page": an open tab, a kept page, a recent site — somewhere to GO.
   * "command": a chrome action, a Space switch, a settings destination —
   * something the browser DOES.
   */
  kind: "page" | "command";
  /** What the row is called: "Theme & colors", "Gmail — Inbox". */
  label: string;
  /** What choosing it does or controls, in a sentence the model can read. */
  detail?: string;
}

/** A page the person has been on lately: title and host only, never a full URL. */
export interface AddressIntentPage {
  title: string;
  host: string;
}

export interface AddressIntentRequest {
  /** The trimmed typed text. */
  query: string;
  /** The page being edited over, when there is one. */
  currentPage: AddressIntentPage | null;
  /** Most recent first. */
  recentPages: AddressIntentPage[];
  candidates: AddressIntentCandidate[];
}

export interface AddressIntentRanking {
  /** Echoed, so an answer that outlived its keystroke can be dropped. */
  query: string;
  /** P(each reading); sums to ~1. */
  intents: Record<AddressIntent, number>;
  /** How concentrated `intents` is, 0–1 (the provider's own figure when it sends one). */
  intentConfidence: number;
  /** P(each candidate id), and `NO_TARGET`; sums to ~1. Empty when no candidates were sent. */
  targets: Record<string, number>;
  targetConfidence: number;
  /** Wall time of the model call, for the dev overlay and the eval script. */
  latencyMs: number;
}

/** Bounds every host enforces on a request before it costs anything. */
export const ADDRESS_INTENT_LIMITS = {
  /** Shorter than this is a prefix, not an intent; the fuzzy list handles it. */
  minQueryChars: 3,
  /** Longer is truncated: the opening words carry the intent. */
  maxQueryChars: 300,
  maxCandidates: 48,
  maxRecentPages: 6,
  maxLabelChars: 80,
  maxDetailChars: 160,
  maxTitleChars: 80,
  /** A suggestion that arrives later than this is worth less than none. */
  timeoutMs: 1500,
} as const;

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function pageOf(value: unknown): AddressIntentPage | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const title = clip(record["title"], ADDRESS_INTENT_LIMITS.maxTitleChars);
  const host = clip(record["host"], ADDRESS_INTENT_LIMITS.maxTitleChars);
  return title === "" && host === "" ? null : { title, host };
}

/**
 * A request from another process (the renderer, a browser tab over the
 * socket) made safe to spend on: every string clipped, every list capped,
 * duplicate and reserved candidate ids dropped. Null when there is nothing
 * worth asking — the caller answers null without reaching a model.
 */
export function sanitizeAddressIntentRequest(value: unknown): AddressIntentRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const query = clip(record["query"], ADDRESS_INTENT_LIMITS.maxQueryChars);
  if (query.length < ADDRESS_INTENT_LIMITS.minQueryChars) return null;
  const seen = new Set<string>([NO_TARGET]);
  const candidates: AddressIntentCandidate[] = [];
  for (const raw of Array.isArray(record["candidates"]) ? record["candidates"] : []) {
    if (candidates.length === ADDRESS_INTENT_LIMITS.maxCandidates) break;
    if (typeof raw !== "object" || raw === null) continue;
    const candidate = raw as Record<string, unknown>;
    const id = clip(candidate["id"], 120);
    const label = clip(candidate["label"], ADDRESS_INTENT_LIMITS.maxLabelChars);
    const kind = candidate["kind"];
    if (id === "" || label === "" || seen.has(id) || (kind !== "page" && kind !== "command")) continue;
    seen.add(id);
    const detail = clip(candidate["detail"], ADDRESS_INTENT_LIMITS.maxDetailChars);
    candidates.push(detail === "" ? { id, kind, label } : { id, kind, label, detail });
  }
  const recentPages: AddressIntentPage[] = [];
  for (const raw of Array.isArray(record["recentPages"]) ? record["recentPages"] : []) {
    if (recentPages.length === ADDRESS_INTENT_LIMITS.maxRecentPages) break;
    const page = pageOf(raw);
    if (page !== null) recentPages.push(page);
  }
  return { query, currentPage: pageOf(record["currentPage"]), recentPages, candidates };
}
