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

/**
 * Where the "Ask …" row goes. The address modal sends the words to the
 * assistant the person chose in Settings, opened at its own site; the home
 * page keeps them and answers in place, as its own chat
 * (components/home/HomeChat.tsx), so its row names Pistachio and carries no
 * address — the page acts on the row itself.
 */
export type AssistantTarget = "provider" | "pistachio";

/** The name the home page's chat goes by in its row. */
export const IN_APP_ASSISTANT_LABEL = "Pistachio";

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

/** The typed text sent as a prompt to the person's AI assistant — or kept for Pistachio's own chat. */
function aiSearchItem(q: string, search: SearchSettings, assistant: AssistantTarget): UrlItem {
  if (assistant === "pistachio") {
    return { id: "ai-search", kind: "ai", title: `Ask ${IN_APP_ASSISTANT_LABEL} “${q}”`, hint: "AI", url: "" };
  }
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
export function secondarySearchItems(q: string, primaryItem: UrlItem, search: SearchSettings, assistant: AssistantTarget = "provider"): UrlItem[] {
  const ai = aiSearchItem(q, search, assistant);
  return primaryItem.kind === "search" ? [ai] : [webSearchItem(q, search, "Web"), ai];
}
