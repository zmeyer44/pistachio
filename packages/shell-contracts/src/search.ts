/**
 * Where prose typed into the address bar goes: the web search engine that
 * answers a query, and the AI assistant that is handed it as a prompt. Both
 * are a person's choice (Settings → General → Search), and both are nothing
 * more than an address with the words folded into it — so every host (the
 * Mac's main process, the cloud browser, the shell's own suggestions) builds
 * the same address from the same table rather than spelling an engine's URL
 * where it happens to need one.
 */

interface SearchProviderDefinition<Id extends string> {
  id: Id;
  /** The name a person knows it by: the select's label, "Search Google for …". */
  label: string;
  /** The address of a search, up to where the encoded words go. */
  prefix: string;
}

export type WebSearchProvider = "google" | "duckduckgo" | "yahoo" | "bing";
export type AiSearchProvider = "chatgpt" | "gemini" | "claude" | "grok" | "perplexity";

export const WEB_SEARCH_PROVIDERS: ReadonlyArray<SearchProviderDefinition<WebSearchProvider>> = [
  { id: "google", label: "Google", prefix: "https://www.google.com/search?q=" },
  { id: "duckduckgo", label: "DuckDuckGo", prefix: "https://duckduckgo.com/?q=" },
  { id: "yahoo", label: "Yahoo", prefix: "https://search.yahoo.com/search?p=" },
  { id: "bing", label: "Bing", prefix: "https://www.bing.com/search?q=" },
];

/**
 * Each assistant's own "open with this prompt" address. Gemini's is the one
 * Chrome's `@gemini` address-bar shortcut uses; the rest are the `?q=` their
 * apps read on load.
 */
export const AI_SEARCH_PROVIDERS: ReadonlyArray<SearchProviderDefinition<AiSearchProvider>> = [
  { id: "chatgpt", label: "ChatGPT", prefix: "https://chatgpt.com/?q=" },
  { id: "gemini", label: "Gemini", prefix: "https://gemini.google.com/app?q=" },
  { id: "claude", label: "Claude", prefix: "https://claude.ai/new?q=" },
  { id: "grok", label: "Grok", prefix: "https://grok.com/?q=" },
  { id: "perplexity", label: "Perplexity", prefix: "https://www.perplexity.ai/search?q=" },
];

export const WEB_SEARCH_PROVIDER_IDS: readonly WebSearchProvider[] = WEB_SEARCH_PROVIDERS.map((provider) => provider.id);
export const AI_SEARCH_PROVIDER_IDS: readonly AiSearchProvider[] = AI_SEARCH_PROVIDERS.map((provider) => provider.id);

export const DEFAULT_WEB_SEARCH_PROVIDER: WebSearchProvider = "google";
export const DEFAULT_AI_SEARCH_PROVIDER: AiSearchProvider = "chatgpt";

function definitionOf<Id extends string>(
  providers: ReadonlyArray<SearchProviderDefinition<Id>>,
  id: Id,
): SearchProviderDefinition<Id> {
  // An id from another process (a stale settings file, a newer build's
  // record) falls back to the first provider — the default — not to a throw.
  const found = providers.find((provider) => provider.id === id) ?? providers[0];
  if (found === undefined) throw new Error("no search providers are defined");
  return found;
}

export function webSearchLabel(provider: WebSearchProvider): string {
  return definitionOf(WEB_SEARCH_PROVIDERS, provider).label;
}

export function aiSearchLabel(provider: AiSearchProvider): string {
  return definitionOf(AI_SEARCH_PROVIDERS, provider).label;
}

/** A web search for `query` on the engine the person chose. */
export function webSearchUrl(query: string, provider: WebSearchProvider = DEFAULT_WEB_SEARCH_PROVIDER): string {
  return `${definitionOf(WEB_SEARCH_PROVIDERS, provider).prefix}${encodeURIComponent(query)}`;
}

/** A new conversation with the assistant the person chose, opened on `prompt`. */
export function aiSearchUrl(prompt: string, provider: AiSearchProvider = DEFAULT_AI_SEARCH_PROVIDER): string {
  return `${definitionOf(AI_SEARCH_PROVIDERS, provider).prefix}${encodeURIComponent(prompt)}`;
}
