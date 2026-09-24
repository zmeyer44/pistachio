import { describe, expect, it } from "vitest";
import { pageLinkMarkdown } from "../src/page-link.js";

describe("page link markdown", () => {
  it("links the title to the address", () => {
    expect(pageLinkMarkdown("Pistachio", "https://pistachio.test/")).toBe("[Pistachio](https://pistachio.test/)");
  });

  it("escapes brackets in the title and collapses its whitespace", () => {
    expect(pageLinkMarkdown("  Notes [draft]\n v2 ", "https://x.test/a")).toBe("[Notes \\[draft\\] v2](https://x.test/a)");
  });

  it("falls back to the address as the text, and wraps an address Markdown would cut short", () => {
    expect(pageLinkMarkdown("", "https://x.test/a")).toBe("[https://x.test/a](https://x.test/a)");
    expect(pageLinkMarkdown("Wiki", "https://x.test/Foo_(bar)")).toBe("[Wiki](<https://x.test/Foo_(bar)>)");
  });
});
