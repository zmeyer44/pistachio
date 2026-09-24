import { describe, expect, it } from "vitest";
import { rankFuzzy, STRONG_FUZZY_SCORE } from "../src/lib/fuzzy";

describe("command palette fuzzy ranking", () => {
  const candidates = [
    {
      item: "delegate",
      text: "Delegate current tab",
      keywords: ["agent hand off"],
    },
    { item: "settings", text: "Settings", keywords: ["preferences"] },
    { item: "tab", text: "Vendor invoices", keywords: ["vendor.example"] },
    {
      item: "move",
      text: "Move current tab to Research",
      keywords: ["space workspace"],
    },
  ] as const;

  it("puts exact and word-prefix matches ahead of loose subsequences", () => {
    const matches = rankFuzzy("delegate", candidates);
    expect(matches[0]).toMatchObject({ item: "delegate" });
    expect(matches[0]?.score).toBeGreaterThanOrEqual(STRONG_FUZZY_SCORE);
  });

  it("matches ordered characters and alternate keywords", () => {
    expect(rankFuzzy("vndr inv", candidates)[0]?.item).toBe("tab");
    expect(rankFuzzy("workspace research", candidates)[0]?.item).toBe("move");
  });

  it("requires every token and returns no inventory for an empty query", () => {
    expect(rankFuzzy("delegate research", candidates)).toEqual([]);
    expect(rankFuzzy("   ", candidates)).toEqual([]);
  });
});
