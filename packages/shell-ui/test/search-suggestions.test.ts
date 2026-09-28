import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@pistachio/shell-contracts/settings";
import { primaryItemFor, secondarySearchItems } from "../src/lib/search-suggestions";

const DEFAULTS = DEFAULT_SETTINGS.search;

describe("the address bar's search suggestions", () => {
  it("offers nothing for an empty field", () => {
    expect(primaryItemFor("", DEFAULTS)).toBeNull();
  });

  it("searches the chosen web engine for prose, as the ↵ result", () => {
    const item = primaryItemFor("best pistachio gelato", { webProvider: "duckduckgo", aiProvider: "claude", smartSuggestions: true, smartFind: true });
    expect(item).toMatchObject({
      kind: "search",
      title: "Search DuckDuckGo for “best pistachio gelato”",
      hint: "↵",
      url: "https://duckduckgo.com/?q=best%20pistachio%20gelato",
      provider: "duckduckgo",
    });
  });

  it("offers the chosen assistant beside a web search", () => {
    const search = { webProvider: "google", aiProvider: "claude", smartSuggestions: true, smartFind: true } as const;
    const primary = primaryItemFor("best pistachio gelato", search);
    expect(primary).not.toBeNull();
    if (primary === null) return;
    expect(secondarySearchItems("best pistachio gelato", primary, search)).toEqual([
      {
        id: "ai-search",
        kind: "ai",
        title: "Ask Claude “best pistachio gelato”",
        hint: "AI",
        url: "https://claude.ai/new?q=best%20pistachio%20gelato",
        provider: "claude",
      },
    ]);
  });

  it("goes to a typed address first, and still offers both searches for its letters", () => {
    const primary = primaryItemFor("github.com", DEFAULTS);
    expect(primary).toMatchObject({ kind: "navigate", url: "github.com" });
    if (primary === null) return;
    const rest = secondarySearchItems("github.com", primary, DEFAULTS);
    expect(rest.map((item) => item.kind)).toEqual(["search", "ai"]);
    // Each search row knows whose logo to draw; the address row has none.
    expect(rest.map((item) => item.provider)).toEqual(["google", "chatgpt"]);
    expect(primary.provider).toBeUndefined();
    expect(rest.map((item) => item.title)).toEqual(["Search Google for “github.com”", "Ask ChatGPT “github.com”"]);
    expect(rest[0]?.url).toBe("https://www.google.com/search?q=github.com");
    // No two rows of one list may share an id: React keys and ↑/↓ both use it.
    expect(new Set([primary.id, ...rest.map((item) => item.id)]).size).toBe(3);
  });
});

describe("the home page's own assistant", () => {
  it("keeps the question on the page: the row names Pistachio and goes nowhere", () => {
    const search = { webProvider: "google", aiProvider: "claude", smartSuggestions: true, smartFind: true } as const;
    const primary = primaryItemFor("why is the sky blue", search);
    if (primary === null) throw new Error("no primary item");
    const [ai] = secondarySearchItems("why is the sky blue", primary, search, "pistachio");
    expect(ai).toEqual({ id: "ai-search", kind: "ai", title: "Ask Pistachio “why is the sky blue”", hint: "AI", url: "" });
    // The modal's row is untouched: the same call without the target still names the provider.
    expect(secondarySearchItems("why is the sky blue", primary, search)[0]?.title).toBe("Ask Claude “why is the sky blue”");
  });
});
