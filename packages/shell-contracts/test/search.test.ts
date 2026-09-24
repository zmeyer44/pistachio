import { describe, expect, it } from "vitest";
import {
  AI_SEARCH_PROVIDERS,
  DEFAULT_AI_SEARCH_PROVIDER,
  DEFAULT_WEB_SEARCH_PROVIDER,
  WEB_SEARCH_PROVIDERS,
  aiSearchLabel,
  aiSearchUrl,
  webSearchLabel,
  webSearchUrl,
  type WebSearchProvider,
} from "../src/search.js";
import { DEFAULT_SETTINGS, applySettingsPatch, sanitizeSettings } from "../src/settings.js";
import { isAllowedNavigation, normalizeNavigation, searchUrl } from "../src/url.js";

describe("search providers", () => {
  it("builds each web engine's search address", () => {
    expect(webSearchUrl("invoice policy", "google")).toBe("https://www.google.com/search?q=invoice%20policy");
    expect(webSearchUrl("invoice policy", "duckduckgo")).toBe("https://duckduckgo.com/?q=invoice%20policy");
    expect(webSearchUrl("invoice policy", "yahoo")).toBe("https://search.yahoo.com/search?p=invoice%20policy");
    expect(webSearchUrl("invoice policy", "bing")).toBe("https://www.bing.com/search?q=invoice%20policy");
  });

  it("builds each assistant's prompt address", () => {
    expect(aiSearchUrl("why is the sky blue?", "chatgpt")).toBe("https://chatgpt.com/?q=why%20is%20the%20sky%20blue%3F");
    expect(aiSearchUrl("why is the sky blue?", "gemini")).toBe("https://gemini.google.com/app?q=why%20is%20the%20sky%20blue%3F");
    expect(aiSearchUrl("why is the sky blue?", "claude")).toBe("https://claude.ai/new?q=why%20is%20the%20sky%20blue%3F");
    expect(aiSearchUrl("why is the sky blue?", "grok")).toBe("https://grok.com/?q=why%20is%20the%20sky%20blue%3F");
    expect(aiSearchUrl("why is the sky blue?", "perplexity")).toBe("https://www.perplexity.ai/search?q=why%20is%20the%20sky%20blue%3F");
  });

  it("keeps words that would change the address inside the query", () => {
    // `&` and `#` typed as prose must not become a second parameter or a fragment.
    expect(webSearchUrl("a&b #c", "duckduckgo")).toBe("https://duckduckgo.com/?q=a%26b%20%23c");
  });

  it("only ever names an address a tab may load", () => {
    for (const { id } of WEB_SEARCH_PROVIDERS) expect(isAllowedNavigation(webSearchUrl("x", id))).toBe(true);
    for (const { id } of AI_SEARCH_PROVIDERS) expect(isAllowedNavigation(aiSearchUrl("x", id))).toBe(true);
  });

  it("names the providers the way the settings page lists them", () => {
    expect(webSearchLabel("duckduckgo")).toBe("DuckDuckGo");
    expect(aiSearchLabel("chatgpt")).toBe("ChatGPT");
    expect(WEB_SEARCH_PROVIDERS[0]?.id).toBe(DEFAULT_WEB_SEARCH_PROVIDER);
    expect(AI_SEARCH_PROVIDERS[0]?.id).toBe(DEFAULT_AI_SEARCH_PROVIDER);
  });

  it("reads an engine it does not know as the default, not as a throw", () => {
    expect(webSearchUrl("x", "altavista" as WebSearchProvider)).toBe(webSearchUrl("x", DEFAULT_WEB_SEARCH_PROVIDER));
  });
});

describe("the address bar's search follows the chosen engine", () => {
  it("searches prose on the engine it is given, and on the default without one", () => {
    expect(normalizeNavigation("invoice policy", "duckduckgo")).toBe("https://duckduckgo.com/?q=invoice%20policy");
    expect(normalizeNavigation("invoice policy")).toBe(searchUrl("invoice policy", "google"));
  });

  it("leaves addresses alone whatever the engine", () => {
    expect(normalizeNavigation("example.com/path", "yahoo")).toBe("https://example.com/path");
    expect(normalizeNavigation("https://example.com/", "bing")).toBe("https://example.com/");
  });
});

describe("settings.search", () => {
  it("defaults to Google and ChatGPT, and for a file written before the section existed", () => {
    expect(DEFAULT_SETTINGS.search).toEqual({ webProvider: "google", aiProvider: "chatgpt", smartSuggestions: true, smartFind: true });
    expect(sanitizeSettings({ general: { newTab: "home" } }).search).toEqual(DEFAULT_SETTINGS.search);
  });

  it("keeps a stored choice and refuses a provider it does not know", () => {
    expect(sanitizeSettings({ search: { webProvider: "yahoo", aiProvider: "grok" } }).search).toEqual({
      webProvider: "yahoo",
      aiProvider: "grok",
      smartSuggestions: true,
      smartFind: true,
    });
    expect(sanitizeSettings({ search: { webProvider: "https://evil.test/?q=", aiProvider: 7 } }).search).toEqual(DEFAULT_SETTINGS.search);
  });

  it("keeps smart suggestions on for a file written before the setting existed, and off once it is turned off", () => {
    expect(sanitizeSettings({ search: { webProvider: "bing" } }).search.smartSuggestions).toBe(true);
    expect(sanitizeSettings({ search: { smartSuggestions: false } }).search.smartSuggestions).toBe(false);
    // Anything that is not a boolean is not an answer: the default stands.
    expect(sanitizeSettings({ search: { smartSuggestions: "no" } }).search.smartSuggestions).toBe(true);
  });

  it("keeps smart find on for a file written before the setting existed, and off once it is turned off", () => {
    expect(sanitizeSettings({ search: { webProvider: "bing" } }).search.smartFind).toBe(true);
    expect(sanitizeSettings({ search: { smartFind: false } }).search.smartFind).toBe(false);
    expect(sanitizeSettings({ search: { smartFind: 0 } }).search.smartFind).toBe(true);
  });

  it("changes one provider without touching the other", () => {
    const first = applySettingsPatch(DEFAULT_SETTINGS, { search: { webProvider: "duckduckgo" } });
    const second = applySettingsPatch(first, { search: { aiProvider: "claude" } });
    expect(second.search).toEqual({ webProvider: "duckduckgo", aiProvider: "claude", smartSuggestions: true, smartFind: true });
  });
});
