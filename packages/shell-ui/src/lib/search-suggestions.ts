/**
 * What the address bar offers for the typed text itself, before anything it
 * matches: going to it when it reads as an address, searching the web for
 * it, and sending it to an AI assistant as a prompt. The engine and the
 * assistant are the person's choice (`settings.search`), and the address of
 * each search is built here, so every host opens the same one. Pure.
 */

import {
  aiSearchLabel,
  aiSearchUrl,
  webSearchLabel,
  webSearchUrl,
  type AiSearchProvider,
  type WebSearchProvider,
} from "@pistachio/shell-contracts/search";
import type { DesktopSettings } from "@pistachio/shell-contracts/settings";
import { isProbablyUrl, prettyUrl } from "./url";

export interface UrlItem {
  id: string;
  /** "search" is the web engine, "ai" the assistant — both the person's choice (`settings.search`). */
  kind: "navigate" | "search" | "ai" | "recent";
  title: string;
  subtitle?: string;
  hint?: string;
  url: string;
  /** The engine or assistant a "search" or "ai" item goes to — the row draws its logo. */
  provider?: WebSearchProvider | AiSearchProvider;
}

type SearchSettings = DesktopSettings["search"];

/** A search for the typed text on the person's web engine. */
function webSearchItem(q: string, search: SearchSettings, hint: string): UrlItem {
  return {
    id: "search",
    kind: "search",
    title: `Search ${webSearchLabel(search.webProvider)} for “${q}”`,
    hint,
    url: webSearchUrl(q, search.webProvider),
    provider: search.webProvider,
  };
}

/** The typed text sent as a prompt to the person's AI assistant. */
function aiSearchItem(q: string, search: SearchSettings): UrlItem {
  return {
    id: "ai-search",
    kind: "ai",
    title: `Ask ${aiSearchLabel(search.aiProvider)} “${q}”`,
    hint: "AI",
    url: aiSearchUrl(q, search.aiProvider),
    provider: search.aiProvider,
  };
}

/** The first result for typed text: go to it when it reads as an address, else search the web for it. */
export function primaryItemFor(q: string, search: SearchSettings): UrlItem | null {
  if (q.length === 0) return null;
  return isProbablyUrl(q)
    ? { id: "goto", kind: "navigate", title: `Go to ${prettyUrl(q)}`, subtitle: q, hint: "↵", url: q }
    : webSearchItem(q, search, "↵");
}

/**
 * The searches offered beside `primaryItem`: the AI prompt always, and the
 * web search too when the primary is an address — "github.com" is a place to
 * go first, but still words someone may have meant to look up.
 */
export function secondarySearchItems(q: string, primaryItem: UrlItem, search: SearchSettings): UrlItem[] {
  const ai = aiSearchItem(q, search);
  return primaryItem.kind === "search" ? [ai] : [webSearchItem(q, search, "Web"), ai];
}
