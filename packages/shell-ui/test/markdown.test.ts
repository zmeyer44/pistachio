/**
 * A reply's Markdown as the chat reads it (lib/markdown.ts): the token tree
 * marked hands back, kept safe from markup; a fence still open while the
 * reply streams; the words a text run splits into.
 */

import { describe, expect, it } from "vitest";
import { closeOpenFence, holdUnfinished, isShortReply, parseMarkdown, plainText, words, type MarkdownToken } from "../src/lib/markdown";

/** The spans of a paragraph token, or a loud failure. */
function spansOf(token: MarkdownToken | undefined): MarkdownToken[] {
  if (token?.type !== "paragraph" || token.tokens === undefined) throw new Error("expected a paragraph with spans");
  return token.tokens;
}

describe("parseMarkdown", () => {
  it("reads GitHub-flavoured blocks and spans", () => {
    const tokens = parseMarkdown("# Title\n\nSome **bold** and `code` with a [link](https://example.test).\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~");
    expect(tokens.map((token) => token.type).filter((type) => type !== "space")).toEqual(["heading", "paragraph", "list", "table", "paragraph"]);
    const spans = spansOf(tokens.find((token) => token.type === "paragraph"));
    expect(spans.map((token) => token.type)).toEqual(["text", "strong", "text", "codespan", "text", "link", "text"]);
    expect(spansOf(tokens.at(-1))[0]?.type).toBe("del");
  });

  it("never turns the model's text into markup", () => {
    const tokens = parseMarkdown("before <script>alert(1)</script> after");
    // The tags come back as tokens of their own, which the renderer draws as text.
    expect(spansOf(tokens[0]).map((token) => token.type)).toEqual(["text", "html", "text", "html", "text"]);
    expect(plainText(tokens)).toContain("<script>alert(1)</script>");
  });

  it("keeps a code span's text raw for the renderer to escape", () => {
    const tokens = parseMarkdown("use `a < b && c > d`");
    expect(spansOf(tokens[0])[1]).toMatchObject({ type: "codespan", text: "a < b && c > d" });
  });

  it("reads plain text as one paragraph", () => {
    const tokens = parseMarkdown("Just a line.");
    expect(tokens.map((token) => token.type)).toEqual(["paragraph"]);
    expect(plainText(tokens).trim()).toBe("Just a line.");
  });
});

describe("closeOpenFence", () => {
  it("closes a fence the reply is still inside", () => {
    expect(closeOpenFence("Here:\n\n```ts\nconst a = 1;")).toBe("Here:\n\n```ts\nconst a = 1;\n```");
    const tokens = parseMarkdown("Here:\n\n```ts\nconst a = 1;");
    expect(tokens.at(-1)).toMatchObject({ type: "code", lang: "ts", text: "const a = 1;" });
  });

  it("leaves a closed fence, and a fence of the other marker, alone", () => {
    expect(closeOpenFence("```\nx\n```")).toBe("```\nx\n```");
    expect(closeOpenFence("```\nx\n~~~")).toBe("```\nx\n~~~\n```");
    expect(closeOpenFence("````\n```\ninner\n```\n````")).toBe("````\n```\ninner\n```\n````");
  });
});

describe("words", () => {
  it("splits a run into words and the whitespace between them, keeping line breaks", () => {
    expect(words("two  words\nnext")).toEqual([
      { kind: "word", value: "two" },
      { kind: "space", value: "  " },
      { kind: "word", value: "words" },
      { kind: "space", value: "\n" },
      { kind: "word", value: "next" },
    ]);
    expect(words("")).toEqual([]);
    expect(words(" lead")).toEqual([
      { kind: "space", value: " " },
      { kind: "word", value: "lead" },
    ]);
  });
});

describe("isShortReply", () => {
  it("is a single short line", () => {
    expect(isShortReply("Paris.")).toBe(true);
    expect(isShortReply("One line.\n\nTwo.")).toBe(false);
    expect(isShortReply("x".repeat(200))).toBe(false);
  });
});

describe("holdUnfinished", () => {
  it("waits at a link until its address has arrived", () => {
    expect(holdUnfinished("see ([Serious Eats](https://www.serious")).toBe("see (");
    expect(holdUnfinished("see [Serious")).toBe("see");
    expect(holdUnfinished("see [Serious Eats](https://x.test) now")).toBe("see [Serious Eats](https://x.test) now");
    expect(holdUnfinished("see [Serious Eats] plainly")).toBe("see [Serious Eats] plainly");
  });

  it("waits at an open code span or emphasis", () => {
    expect(holdUnfinished("run `npm ins")).toBe("run");
    expect(holdUnfinished("run `npm install` now")).toBe("run `npm install` now");
    expect(holdUnfinished("this is **impor")).toBe("this is");
    expect(holdUnfinished("this is **important** here")).toBe("this is **important** here");
  });

  it("leaves a fence alone", () => {
    expect(holdUnfinished("```ts\nconst a = `x`;\n")).toBe("```ts\nconst a = `x`;\n");
    expect(holdUnfinished("```")).toBe("```");
  });
});
