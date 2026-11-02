/**
 * Markdown in and out of a note's HTML (docs/notes.md §2). Every block kind
 * exports to the markdown a reader elsewhere would expect, and imports back,
 * so a note carried through markdown — to the agent, to the clipboard, to
 * another app — comes home whole.
 */

import { describe, expect, it } from "vitest";
import { applyNoteEdit, htmlToJson, htmlToMarkdown, looksLikeMarkdown, markdownToHtml, normalizeNoteHtml } from "../src/index.js";

const md = (html: string) => htmlToMarkdown(html).trim();

describe("markdown export", () => {
  it.each([
    ["heading", "<h1>Title</h1><h2>Sub</h2><h3>Small</h3>", "# Title\n\n## Sub\n\n### Small"],
    ["inline marks", '<p><strong>b</strong> <em>i</em> <s>s</s> <code>c</code> <a href="https://x.com">l</a></p>', "**b** *i* ~~s~~ `c` [l](https://x.com)"],
    ["bullet list", "<ul><li><p>a</p><ul><li><p>nested</p></li></ul></li><li><p>b</p></li></ul>", "- a\n  - nested\n- b"],
    ["ordered list", "<ol><li><p>one</p></li><li><p>two</p></li></ol>", "1. one\n2. two"],
    ["task list", '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li><li data-type="taskItem" data-checked="false"><p>todo</p></li></ul>', "- [x] done\n- [ ] todo"],
    ["blockquote", "<blockquote><p>quoted</p></blockquote>", "> quoted"],
    ["code block", '<pre><code class="language-ts">const a = 1;</code></pre>', "```ts\nconst a = 1;\n```"],
    ["divider", "<p>a</p><hr><p>b</p>", "a\n\n---\n\nb"],
    ["hard break", "<p>a<br>b</p>", "a  \nb"],
    ["image", '<img src="note-blob:0123456789abcdef01234567" alt="Alt">', "![Alt](note-blob:0123456789abcdef01234567)"],
    ["table (GFM)", "<table><tbody><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table>", "| A   | B   |\n| --- | --- |\n| 1   | 2   |"],
    ["callout", '<div data-type="callout" data-emoji="⚠️"><p>Careful <em>now</em></p><p>more</p></div>', "> ⚠️ Careful *now*\n>\n> more"],
    ["toggle", '<details open=""><summary>More & less</summary><div data-type="detailsContent"><p>Body</p></div></details>', "<details open>\n<summary>More &amp; less</summary>\n\nBody\n\n</details>"],
    ["embed", '<div data-type="embed" data-src="https://youtu.be/abcdefghijk"></div>', "<https://youtu.be/abcdefghijk>"],
    ["html block", '<div data-type="html-block" data-html="<b>x</b> ```"></div>', "````html live\n<b>x</b> ```\n````"],
  ])("%s", (_name, html, expected) => {
    expect(md(html)).toBe(expected);
  });

  it("does not export layout-only empty paragraphs", () => {
    expect(htmlToMarkdown("<p>a</p><p></p><p></p><p>b</p><p></p>")).toBe("a\n\nb\n");
  });

  it("empties to an empty string rather than to a stray paragraph", () => {
    expect(htmlToMarkdown("")).toBe("");
    expect(htmlToMarkdown("<p></p>")).toBe("");
    expect(markdownToHtml("")).toBe("");
  });

  it("never loses block content (every node renders)", () => {
    const html =
      '<h2>H</h2><div data-type="callout" data-emoji="💡"><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>inside callout</p></li></ul></div>' +
      '<details><summary>S</summary><div data-type="detailsContent"><blockquote><p>inside toggle</p></blockquote></div></details>';
    const out = htmlToMarkdown(html);
    for (const text of ["H", "inside callout", "S", "inside toggle"]) expect(out).toContain(text);
  });
});

describe("markdown import", () => {
  const html = (source: string) => markdownToHtml(source);

  it("parses headings and paragraphs", () => {
    expect(html("# One\n\n## Two\n\n### Three\n\nText")).toBe("<h1>One</h1><h2>Two</h2><h3>Three</h3><p>Text</p>");
  });

  it("joins soft-wrapped lines", () => {
    expect(html("one\ntwo")).toBe("<p>one two</p>");
  });

  it("parses bullet, ordered and nested lists", () => {
    expect(html("- a\n  - b\n- c")).toBe("<ul><li><p>a</p><ul><li><p>b</p></li></ul></li><li><p>c</p></li></ul>");
    expect(html("1. a\n2. b")).toBe("<ol><li><p>a</p></li><li><p>b</p></li></ol>");
  });

  it("parses task lists", () => {
    const out = html("- [ ] open\n- [x] done");
    expect(out).toContain('<ul data-type="taskList">');
    expect(out).toMatch(/data-checked="false"[^>]*>.*open/u);
    expect(out).toMatch(/data-checked="true"[^>]*>.*done/u);
  });

  it("parses GFM tables", () => {
    const out = html("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(out).toContain("<th");
    expect(out).toContain("<p>A</p>");
    expect(out).toContain("<td");
    expect(out).toContain("<p>2</p>");
  });

  it("parses fenced code with its language", () => {
    expect(html("```js\nlet a = 1;\n\nlet b = 2;\n```")).toBe('<pre><code class="language-js">let a = 1;\n\nlet b = 2;</code></pre>');
  });

  it("turns emoji blockquotes, GitHub alerts and :::callout into callouts", () => {
    expect(html("> 💡 Tip **here**\n> more")).toBe('<div data-type="callout" data-emoji="💡"><p>Tip <strong>here</strong> more</p></div>');
    expect(html("> [!WARNING]\n> Danger")).toBe('<div data-type="callout" data-emoji="⚠️" data-alert="WARNING"><p>Danger</p></div>');
    expect(html(':::callout {emoji="🔥"}\nHot\n:::')).toBe('<div data-type="callout" data-emoji="🔥"><p>Hot</p></div>');
    expect(html("> plain quote")).toBe("<blockquote><p>plain quote</p></blockquote>");
  });

  it("does not take a </details> inside a toggle's code for the toggle's end", () => {
    const html = '<details open=""><summary>How a toggle is written</summary><div data-type="detailsContent"><pre><code>&lt;details&gt;\n&lt;summary&gt;Title&lt;/summary&gt;\nbody\n&lt;/details&gt;</code></pre><p>That is all.</p></div></details>';
    const markdown = htmlToMarkdown(html);
    expect(markdown).toContain("</details>\n```");
    expect(markdownToHtml(markdown)).toBe(html);
  });

  it("round-trips toggles and HTML blocks", () => {
    const source = '<details open=""><summary>S</summary><div data-type="detailsContent"><p>body <strong>b</strong></p></div></details><div data-type="html-block" data-html="<b>x</b>"></div>';
    // (Compared in the serializer's own spelling: it writes `<` in an attribute as `&lt;`, a browser does not.)
    expect(markdownToHtml(htmlToMarkdown(source))).toBe(normalizeNoteHtml(source));
    expect(htmlToJson(markdownToHtml(htmlToMarkdown(source)))).toEqual(htmlToJson(source));
    expect(html("```html\n<b>x</b>\n```")).toBe('<pre><code class="language-html">&lt;b&gt;x&lt;/b&gt;</code></pre>');
  });

  it("carries an image as its blob address, not as bytes", () => {
    expect(html("![a picture](note-blob:0123456789abcdef01234567)")).toBe('<img src="note-blob:0123456789abcdef01234567" alt="a picture">');
  });

  it("strips frontmatter, and only frontmatter", () => {
    expect(html("---\ntitle: X\n---\nSee this.")).toBe("<p>See this.</p>");
    expect(html("\uFEFF---\ntitle: X\ntags:\n  - a\n  - b\n\n# comment\n---\n\nSee this.")).toBe("<p>See this.</p>");
    // Two rules around prose are two rules; the prose between them stays.
    expect(html("---\n\nImportant paragraph\n\n---\n\nTail")).toBe("<hr><p>Important paragraph</p><hr><p>Tail</p>");
    expect(html("---\nNote: remember this\n\nAnd this.\n---\nTail")).toContain("remember this");
    expect(html("---\n\ntitle: X\n---\nTail")).toContain("title: X");
  });

  it("keeps the spaces a note's text holds, through a structural edit and a reopening", () => {
    const html = "<p>A   B</p>";
    expect(markdownToHtml(htmlToMarkdown(html))).toBe(html);
    expect(htmlToJson(html).content?.[0]?.content?.[0]?.text).toBe("A   B");
    expect(applyNoteEdit(html, { mode: "append", markdown: "C" })).toMatchObject({ ok: true, html: "<p>A   B</p><p>C</p>" });
    // Pretty-printed HTML is still only its blocks.
    expect(htmlToJson("<p>a</p>\n  <p>b</p>\n").content?.map((node) => node.type)).toEqual(["paragraph", "paragraph"]);
  });

  it("keeps table alignment with a separator row as wide as each column", () => {
    const source = "| Metric | Before | Mid |\n| :--- | ---: | :---: |\n| p50 | 120 ms | x |";
    expect(htmlToMarkdown(markdownToHtml(source)).trim()).toBe(
      ["| Metric | Before | Mid |", "| :----- | -----: | :-: |", "| p50    | 120 ms | x   |"].join("\n"),
    );
  });

  it("round-trips GitHub alerts while their emoji is unchanged", () => {
    const source = "> [!NOTE]\n> Numbers are from **staging**.\n>\n> Second line.\n";
    expect(htmlToMarkdown(markdownToHtml(source))).toBe(source);
    const edited = markdownToHtml(source).replace('data-emoji="ℹ️"', 'data-emoji="🔥"');
    expect(htmlToMarkdown(edited)).toMatch(/^> 🔥 Numbers/u);
  });

  it("reads a code span by its own delimiters, so what it holds is left alone", () => {
    const html = "<p><code>a`b &amp;amp; c</code> and R&amp;D, <code>x</code> &amp;amp; <code>`y</code></p>";
    const markdown = htmlToMarkdown(html);
    expect(markdown).toBe("``a`b &amp; c`` and R&D, `x` &amp;amp; `` `y ``\n");
    expect(markdownToHtml(markdown)).toBe(html);
  });

  it("writes &, < and > as plain characters wherever they cannot start markup", () => {
    const out = (source: string) => htmlToMarkdown(source).trim();
    expect(out("<p>R&amp;D: if x &gt; 5 and y &lt; 3, AT&amp;T wins &amp; Q&amp;A</p>")).toBe("R&D: if x > 5 and y < 3, AT&T wins & Q&A");
    // Still escaped where they would turn into markup or an entity.
    expect(out("<p>&gt; not a quote</p>")).toBe("&gt; not a quote");
    expect(out("<ul><li><p>&gt; not a quote</p></li></ul>")).toBe("- &gt; not a quote");
    expect(out("<p>&lt;b&gt; is a tag, &amp;copy; an entity</p>")).toBe("&lt;b> is a tag, &amp;copy; an entity");
  });

  it("leaves code alone inside a quote or a callout, entities and blank lines included", () => {
    const quoted = htmlToMarkdown('<blockquote><pre><code class="language-ts">const entity = "&amp;amp;";\n\n\nconst b = 1 &amp;lt; 2;</code></pre></blockquote>');
    expect(quoted).toContain("> ```ts");
    expect(quoted).toContain('const entity = "&amp;";');
    expect(quoted).toContain("const b = 1 &lt; 2;");
    // Blank lines inside the fence are the code's own.
    expect(quoted).toMatch(/&amp;";\n>\s*\n>\s*\n> const b/u);
    const called = htmlToMarkdown('<div data-type="callout" data-emoji="💡"><pre><code>a &amp;amp; b</code></pre></div>');
    expect(called).toContain("a &amp; b");
    // And the same code round-trips: what was written is what comes back.
    expect(htmlToMarkdown(markdownToHtml(quoted))).toBe(quoted);
  });

  it("keeps a callout's first block whatever it is: code, a heading, a list, or nothing on the emoji's line", () => {
    const code = '<div data-type="callout" data-emoji="💡"><pre><code>x = 1</code></pre></div>';
    expect(htmlToMarkdown(code)).toBe("> 💡 ```\n> x = 1\n> ```\n");
    expect(markdownToHtml(htmlToMarkdown(code))).toBe(code);
    const heading = '<div data-type="callout" data-emoji="💡"><h2>Title</h2><p>body</p></div>';
    expect(markdownToHtml(htmlToMarkdown(heading))).toBe(heading);
    const list = '<div data-type="callout" data-emoji="💡"><ul><li><p>one</p></li><li><p>two</p></li></ul></div>';
    expect(markdownToHtml(htmlToMarkdown(list))).toBe(list);
    expect(markdownToHtml("> 💡\n> Below the emoji.")).toBe('<div data-type="callout" data-emoji="💡"><p>Below the emoji.</p></div>');
    expect(markdownToHtml("> [!WARNING]\n> ```\n> rm -rf\n> ```")).toBe('<div data-type="callout" data-emoji="⚠️" data-alert="WARNING"><pre><code>rm -rf</code></pre></div>');
  });

  it("imports H4–H6 as H3", () => {
    expect(markdownToHtml("#### Four\n\n###### Six")).toBe("<h3>Four</h3><h3>Six</h3>");
  });

  it("still reads the `++…++` underline the editor wrote before, and nothing that only looks like it", () => {
    expect(markdownToHtml("++hello++ and C++ and ++i and a ++ b")).toBe("<p><u>hello</u> and C++ and ++i and a ++ b</p>");
    expect(markdownToHtml("++**bold** inside++")).toBe("<p><strong><u>bold</u></strong><u> inside</u></p>");
    // Written back the new way.
    expect(htmlToMarkdown(markdownToHtml("++hello++"))).toBe("<u>hello</u>\n");
  });

  it("exports underline as <u> and reads it back", () => {
    expect(htmlToMarkdown("<p>a <u>b</u> c</p>").trim()).toBe("a <u>b</u> c");
    expect(markdownToHtml("a <u>b</u> c")).toBe("<p>a <u>b</u> c</p>");
  });

  it("does not let markup in markdown become markup in the document", () => {
    // The closed schema is the sanitizer (N11): a script tag is text.
    expect(markdownToHtml("hi <script>alert(1)</script>\n")).not.toContain("<script>");
  });

  it("exports links whose text is the URL as autolinks", () => {
    expect(htmlToMarkdown(markdownToHtml("See https://example.org and <team@example.com>.")).trim()).toBe(
      "See <https://example.org> and <team@example.com>.",
    );
    expect(htmlToMarkdown('<p><a href="https://x.com">x.com</a></p>').trim()).toBe("[x.com](https://x.com)");
  });

  it("round-trips a realistic GFM document without loss", () => {
    const source = [
      "# Atlas",
      "",
      "Atlas is our **retrieval layer**. See the [RFC](https://example.com/rfc) and `atlas-core`.",
      "",
      "> ℹ️ Numbers are from **staging**.",
      "",
      "1. Cut latency",
      "2. Hybrid search",
      "   1. BM25",
      "   2. Dense",
      "",
      "- Owners",
      "  - Search: Priya",
      "    - On-call",
      "",
      "- [x] Write the RFC",
      "- [ ] Benchmark",
      "",
      "| Metric | Before | After |",
      "| ------ | -----: | ----: |",
      "| p50    | 120 ms | 80 ms |",
      "",
      "```python",
      "def f(k: int = 10):",
      "    return k",
      "```",
      "",
      "> Search is a means, not an end.",
      "",
      "![Diagram](note-blob:0123456789abcdef01234567)",
      "",
      "---",
      "",
      "<details>",
      "<summary>Notes</summary>",
      "",
      "Five runs; median.",
      "",
      "</details>",
      "",
      "Autolink <https://example.org>.",
      "",
    ].join("\n");
    expect(htmlToMarkdown(markdownToHtml(source))).toBe(source);
  });

  it("round-trips a full document through markdown", () => {
    const source = "# Title\n\nPara with **bold** and [link](https://x.com).\n\n- [ ] task\n\n> 💡 note\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    const once = htmlToMarkdown(markdownToHtml(source));
    expect(htmlToMarkdown(markdownToHtml(once))).toBe(once);
  });
});

describe("looksLikeMarkdown", () => {
  it("spots structure, not prose", () => {
    for (const text of ["# Head", "- item", "1. one", "> quote", "```\ncode\n```", "a **bold** word", "[x](https://x.com)", "| a | b |\n| - | - |"]) {
      expect(looksLikeMarkdown(text), text).toBe(true);
    }
    for (const text of ["Just a sentence.", "2 * 3 = 6", "Email me at a@b.com", "just a sentence, with a dash - inside"]) {
      expect(looksLikeMarkdown(text), text).toBe(false);
    }
  });
});
