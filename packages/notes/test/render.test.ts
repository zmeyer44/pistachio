/**
 * What a published note may and may not contain.
 *
 * Two of these are security tests wearing ordinary clothes. A note is a
 * person's own writing, and a person pastes things — `<script>` from a page
 * they were reading, an image from the web. The page it becomes is served
 * under `ARTIFACT_CSP` (`default-src 'none'`), which would refuse to load
 * either; the renderer refuses first, so the document is the same whether or
 * not the CSP header survives the trip. Hence: no `<script>` anywhere, and no
 * `src` that is not a `data:` URI this device already held.
 */

import { describe, expect, it } from "vitest";
import { noteToPlainText, noteWordCount, renderNoteBody, renderNoteHtml } from "../src/index.js";

const PIXEL = "iVBORw0KGgoAAAANSUhEUg==";
const BLOB_ID = "0123456789abcdef01234567";

const blobs = (id: string): { mediaType: string; data: string } | null =>
  id === BLOB_ID ? { mediaType: "image/png", data: PIXEL } : null;

function body(markdown: string): string {
  return renderNoteBody(markdown, { blob: blobs });
}

describe("renderNoteBody", () => {
  it("renders headings, lists and quotes", () => {
    const html = body("# One\n## Two\n\n- a\n- b\n\n1. first\n\n> said\n");
    expect(html).toContain("<h1>One</h1>");
    expect(html).toContain("<h2>Two</h2>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<blockquote>");
  });

  it("renders the editor's ++underline++ and leaves a lone plus alone", () => {
    expect(body("a ++word++ here\n")).toContain("a <u>word</u> here");
    expect(body("2 ++ 2 and c++\n")).not.toContain("<u>");
    expect(body("++<b>x</b>++\n")).toContain("<u>&lt;b&gt;x&lt;/b&gt;</u>");
  });

  it("renders task lists with the boxes disabled", () => {
    const html = body("- [ ] butter\n- [x] flour\n");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("disabled");
    expect(html).toContain("checked");
    // A reader cannot tick a published note.
    expect(html).not.toMatch(/<input(?![^>]*disabled)[^>]*>/u);
  });

  it("renders code, inline and fenced, and a table", () => {
    expect(body("`x`")).toContain("<code>x</code>");
    expect(body("```\nconst a = 1;\n```\n")).toContain("<pre>");
    const table = body("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    expect(table).toContain("<table>");
    expect(table).toContain("<th>a</th>");
    expect(table).toContain("<td>1</td>");
  });

  it("inlines a note's own image as a data URI", () => {
    const html = body(`![a pie](note-blob:${BLOB_ID})`);
    expect(html).toContain(`src="data:image/png;base64,${PIXEL}"`);
    expect(html).toContain('alt="a pie"');
  });

  it("says so quietly when the blob is gone, rather than leaving a broken image", () => {
    const html = body("![a pie](note-blob:ffffffffffffffffffffffff)");
    expect(html).toContain("note-image-missing");
    expect(html).toContain("a pie");
    expect(html).not.toContain("<img");
  });

  it("lets no http or external src survive — nothing is ever fetched", () => {
    const html = body("![x](https://example.com/x.png)\n\n![y](http://example.com/y.gif)\n");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).not.toMatch(/src="(?!data:)/u);
  });

  it("gives every link rel=\"noopener noreferrer\"", () => {
    const html = body("[a](https://example.com/) and [b](https://example.org/)");
    expect(html.match(/rel="noopener noreferrer"/gu)).toHaveLength(2);
  });

  it("escapes HTML a person typed instead of running it", () => {
    const html = body('<script>alert(1)</script>\n\n<b onclick="x()">not bold</b>\n');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b ");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b onclick=");
  });

  it("refuses a javascript: link — the words stay, the link does not", () => {
    const html = body("[x](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain('href="javascript:');
  });
});

describe("renderNoteHtml", () => {
  const note = { title: "Sour cherry pie", markdown: "# Sunday\n\nLattice top.", icon: "🥧" };

  it("is one document that loads nothing", () => {
    const html = renderNoteHtml(note, { blob: blobs });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Sour cherry pie</title>");
    expect(html).toContain("🥧");
    expect(html).toContain("<style>");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).not.toMatch(/<script/iu);
    expect(html).not.toMatch(/<link\b/iu);
    expect(html).not.toContain("@import");
    expect(html).not.toMatch(/https?:\/\//u);
  });

  it("escapes the title rather than letting it close the tag", () => {
    const html = renderNoteHtml({ ...note, title: '</title><script>alert(1)</script>' }, { blob: blobs });
    expect(html).not.toMatch(/<script/iu);
    expect(html).toContain("&lt;script&gt;");
  });

  it("names an untitled note", () => {
    expect(renderNoteHtml({ title: "  ", markdown: "", icon: null }, { blob: blobs })).toContain("<title>Untitled</title>");
  });
});

describe("noteToPlainText / noteWordCount", () => {
  it("reads what a reader would see, not what was typed", () => {
    expect(noteToPlainText("# One\n\n**two** [three](https://example.com/) `four`")).toBe("One two three four");
    expect(noteToPlainText(`![a pie](note-blob:${BLOB_ID})`)).toBe("a pie");
  });

  it("counts the words, and counts nothing as nothing", () => {
    expect(noteWordCount("# One\n\n- two\n- three")).toBe(3);
    expect(noteWordCount("")).toBe(0);
  });
});
