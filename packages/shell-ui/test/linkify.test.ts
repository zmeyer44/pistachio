import { describe, expect, it } from "vitest";
import { linkify } from "../src/lib/linkify";

describe("linkify", () => {
  it("returns plain text untouched", () => {
    expect(linkify("")).toEqual([]);
    expect(linkify("no links here, just node.js and e.g. prose")).toEqual([{ type: "text", value: "no links here, just node.js and e.g. prose" }]);
  });

  it("splits http(s) URLs out of surrounding prose", () => {
    expect(linkify("See https://z.ai/blog/glm-5.3-flash for details")).toEqual([
      { type: "text", value: "See " },
      { type: "link", href: "https://z.ai/blog/glm-5.3-flash", label: "https://z.ai/blog/glm-5.3-flash" },
      { type: "text", value: " for details" },
    ]);
  });

  it("keeps one link per line in an agent summary", () => {
    const text =
      "• Nvidia agrees to acquire Hugging Face — 1,391 points\nhttps://www.businessinsider.com/nvidia-in-talks-to-buy-hugging-face-13-billion-dollars-2026-8\nThe clear #1 story.";
    const parts = linkify(text);
    expect(parts).toHaveLength(3);
    expect(parts[1]).toEqual({
      type: "link",
      href: "https://www.businessinsider.com/nvidia-in-talks-to-buy-hugging-face-13-billion-dollars-2026-8",
      label: "https://www.businessinsider.com/nvidia-in-talks-to-buy-hugging-face-13-billion-dollars-2026-8",
    });
    expect(parts[2]).toEqual({ type: "text", value: "\nThe clear #1 story." });
  });

  it("leaves sentence punctuation outside the link", () => {
    expect(linkify("Read https://example.com/a. Then https://example.com/b, ok?")).toEqual([
      { type: "text", value: "Read " },
      { type: "link", href: "https://example.com/a", label: "https://example.com/a" },
      { type: "text", value: ". Then " },
      { type: "link", href: "https://example.com/b", label: "https://example.com/b" },
      { type: "text", value: ", ok?" },
    ]);
  });

  it("keeps balanced brackets but drops an unmatched closer", () => {
    expect(linkify("(https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([
      { type: "text", value: "(" },
      { type: "link", href: "https://en.wikipedia.org/wiki/Foo_(bar)", label: "https://en.wikipedia.org/wiki/Foo_(bar)" },
      { type: "text", value: ")" },
    ]);
    expect(linkify("<https://example.com/x>")).toEqual([
      { type: "text", value: "<" },
      { type: "link", href: "https://example.com/x", label: "https://example.com/x" },
      { type: "text", value: ">" },
    ]);
  });

  it("links bare www. hosts over https", () => {
    expect(linkify("try www.mturk.com today")).toEqual([
      { type: "text", value: "try " },
      { type: "link", href: "https://www.mturk.com/", label: "www.mturk.com" },
      { type: "text", value: " today" },
    ]);
  });

  it("links the app's own pistachio:// pages", () => {
    expect(linkify("Open pistachio://demo/vendors/atlas-medical.")).toEqual([
      { type: "text", value: "Open " },
      { type: "link", href: "pistachio://demo/vendors/atlas-medical", label: "pistachio://demo/vendors/atlas-medical" },
      { type: "text", value: "." },
    ]);
  });

  it("ignores schemes a Glance cannot show", () => {
    expect(linkify("mailto:me@example.com and ftp://host/file")).toEqual([{ type: "text", value: "mailto:me@example.com and ftp://host/file" }]);
  });

  it("does not linkify a scheme with nothing after it", () => {
    expect(linkify("prefix https:// alone")).toEqual([{ type: "text", value: "prefix https:// alone" }]);
  });
});
