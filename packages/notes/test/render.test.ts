/**
 * What a published note may and may not contain.
 *
 * Several of these are security tests wearing ordinary clothes. A note is a
 * person's own writing, and a person pastes things — `<script>` from a page
 * they were reading — and a note may hold a widget that runs scripts on
 * purpose. The page it becomes is served under `NOTE_PAGE_CSP`: an opaque
 * origin that may run inline script, because a widget's own document, in a
 * `srcdoc` frame, inherits the page's policy. So the rule the renderer holds
 * is where script may be: inside a widget's frame, and in the page's one
 * listener that sizes those frames — never loose in the body, whatever the
 * note held. A picture is shown from its own register or from a web
 * address; a link is web or mail or just its words.
 */

import { describe, expect, it } from "vitest";
import { HTML_BLOCK_FRAME_CSP, NOTE_PAGE_CSP, NOTE_PAGE_META_CSP, NOTE_PAGE_SCRIPT, renderNoteBody, renderNoteHtml } from "../src/index.js";

const PIXEL = "iVBORw0KGgoAAAANSUhEUg==";
const BLOB_ID = "0123456789abcdef01234567";

const blobs = (id: string): { mediaType: string; data: string } | null =>
  id === BLOB_ID ? { mediaType: "image/png", data: PIXEL } : null;

function body(html: string): string {
  return renderNoteBody(html, { blob: blobs });
}

describe("renderNoteBody", () => {
  it("renders headings, lists and quotes", () => {
    const html = body("<h1>One</h1><h2>Two</h2><ul><li><p>a</p></li><li><p>b</p></li></ul><ol><li><p>first</p></li></ol><blockquote><p>said</p></blockquote>");
    expect(html).toContain("<h1>One</h1>");
    expect(html).toContain("<h2>Two</h2>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<blockquote>");
  });

  it("renders the marks, underline included", () => {
    expect(body("<p>a <u>word</u> <strong>b</strong> <em>i</em> <s>s</s> <code>c</code></p>")).toBe("<p>a <u>word</u> <strong>b</strong> <em>i</em> <s>s</s> <code>c</code></p>");
  });

  it("renders task lists with the boxes disabled", () => {
    const html = body('<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>butter</p></li><li data-type="taskItem" data-checked="true"><p>flour</p></li></ul>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("disabled");
    expect(html).toContain("checked");
    // A reader cannot tick a published note.
    expect(html).not.toMatch(/<input(?![^>]*disabled)[^>]*>/u);
  });

  it("renders code, inline and fenced, and a table", () => {
    expect(body("<p><code>x</code></p>")).toContain("<code>x</code>");
    expect(body('<pre><code class="language-ts">const a = 1;</code></pre>')).toBe('<pre><code class="language-ts">const a = 1;</code></pre>');
    const table = body("<table><tbody><tr><th><p>a</p></th><th><p>b</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table>");
    expect(table).toContain("<table>");
    expect(table).toContain("<th><p>a</p></th>");
    expect(table).toContain("<td><p>1</p></td>");
  });

  it("keeps a GFM column's alignment on its cells, and nothing else of a cell's style", () => {
    const aligned = body('<table><tbody><tr><th style="text-align: right"><p>n</p></th><th style="text-align: center; color: red"><p>c</p></th><th style="text-align: bogus"><p>x</p></th></tr></tbody></table>');
    expect(aligned).toContain('<th style="text-align: right"><p>n</p></th>');
    expect(aligned).toContain('<th style="text-align: center"><p>c</p></th>');
    expect(aligned).toContain("<th><p>x</p></th>");
    expect(aligned).not.toContain("color");
  });

  it("renders a callout and a native toggle", () => {
    const callout = body('<div data-type="callout" data-emoji="⚠️"><p>Careful</p></div>');
    expect(callout).toBe('<div class="note-callout" data-emoji="⚠️"><span class="note-callout-emoji">⚠️</span><div class="note-callout-body"><p>Careful</p></div></div>');
    const toggle = body('<details open=""><summary>More</summary><div data-type="detailsContent"><p>inside</p></div></details>');
    expect(toggle).toBe('<details open><summary>More</summary><div class="note-toggle-body"><p>inside</p></div></details>');
  });

  it("renders an embed as the editor's sandboxed frame, with its source as a link under it", () => {
    const embed = body('<div data-type="embed" data-src="https://youtu.be/abcdefghijk"></div>');
    expect(embed).toContain('<div class="note-embed" data-provider="YouTube">');
    expect(embed).toContain('<iframe src="https://www.youtube-nocookie.com/embed/abcdefghijk" title="YouTube embed" sandbox="');
    expect(embed).toContain('<a class="note-embed-caption" href="https://youtu.be/abcdefghijk" rel="noopener noreferrer">');
    expect(embed).toContain("youtu.be/abcdefghijk");
    // Only https ever reaches a frame; the schema already refused the rest.
    expect(body('<div data-type="embed" data-src="javascript:alert(1)"></div>')).toBe("");
  });

  it("renders a widget as its own document in an allow-scripts frame, and nothing loose", () => {
    const widget = body('<div data-type="html-block" data-html="&lt;script&gt;alert(1)&lt;/script&gt;&lt;b&gt;hi&lt;/b&gt;"></div>');
    expect(widget).toMatch(/^<div class="note-html-block"><iframe class="note-html-frame" title="Interactive block" sandbox="allow-scripts" srcdoc="/u);
    expect(widget).not.toContain("allow-same-origin");
    // The widget's markup — script included — is inside the attribute, escaped; the frame runs it, the page does not.
    expect(widget).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&lt;b&gt;hi&lt;/b&gt;");
    expect(widget).not.toMatch(/<script/u);
    expect(widget).not.toContain("<b>");
    // The height reporter travels with it, so the page can size the frame.
    expect(widget).toContain("pistachio:html-block:height");
    // An empty block is not a frame.
    expect(body('<div data-type="html-block" data-html=""></div>')).toBe("");
  });

  it("inlines a note's own image as a data URI", () => {
    const html = body(`<img src="note-blob:${BLOB_ID}" alt="a pie">`);
    expect(html).toContain(`src="data:image/png;base64,${PIXEL}"`);
    expect(html).toContain('alt="a pie"');
  });

  it("says so quietly when the blob is gone, rather than leaving a broken image", () => {
    const html = body('<img src="note-blob:ffffffffffffffffffffffff" alt="a pie">');
    expect(html).toContain("note-image-missing");
    expect(html).toContain("a pie");
    expect(html).not.toContain("<img");
  });

  it("shows a picture by web address from that address, and nothing else by address", () => {
    const html = body('<img src="https://example.com/x.png" alt="x"><img src="http://example.com/y.gif" alt="y">');
    expect(html).toBe('<img src="https://example.com/x.png" alt="x" loading="lazy" referrerpolicy="no-referrer"><img src="http://example.com/y.gif" alt="y" loading="lazy" referrerpolicy="no-referrer">');
    // A data URI a paste carried in, or a path, is the placeholder.
    const other = body('<img src="data:image/png;base64,AAAA" alt="d"><img src="/etc/passwd" alt="p">');
    expect(other).not.toContain("<img");
    expect(other).toContain("note-image-missing");
  });

  it('gives every link rel="noopener noreferrer"', () => {
    const html = body('<p><a href="https://example.com/">a</a> and <a href="https://example.org/">b</a></p>');
    expect(html.match(/rel="noopener noreferrer"/gu)).toHaveLength(2);
  });

  it("escapes HTML a person typed instead of running it", () => {
    const html = body("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><p>&lt;b onclick=\"x()\"&gt;not bold&lt;/b&gt;</p>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b ");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b onclick=");
  });

  it("refuses a javascript: link — the words stay, the link does not", () => {
    const html = body('<p><a href="javascript:alert(1)">x</a></p>');
    expect(html).not.toContain("<a ");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("x");
  });

  it("keeps an empty paragraph as the spacing it was", () => {
    expect(body("<p>a</p><p></p><p>b</p>")).toBe("<p>a</p><p></p><p>b</p>");
  });
});

describe("renderNoteHtml", () => {
  const note = { title: "Sour cherry pie", html: "<h1>Sunday</h1><p>Lattice top.</p>", icon: "🥧" };

  it("is one document that carries its style, and no script while it holds no widget", () => {
    const html = renderNoteHtml(note, { blob: blobs });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Sour cherry pie</title>");
    expect(html).toContain("🥧");
    expect(html).toContain("<style>");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("<h1>Sunday</h1>");
    expect(html).not.toMatch(/<script/iu);
    expect(html).not.toMatch(/<link\b/iu);
    expect(html).not.toContain("@import");
    expect(html).not.toMatch(/https?:\/\//u);
  });

  it("carries the one listener that sizes its widgets, once, when it holds one", () => {
    const html = renderNoteHtml(
      { ...note, html: '<p>a</p><div data-type="html-block" data-html="&lt;p&gt;one&lt;/p&gt;"></div><div data-type="html-block" data-html="&lt;p&gt;two&lt;/p&gt;"></div>' },
      { blob: blobs },
    );
    expect(html.match(/<script>/gu)).toHaveLength(1);
    expect(html).toContain(`<script>${NOTE_PAGE_SCRIPT}</script>`);
    expect(html.match(/<iframe class="note-html-frame"/gu)).toHaveLength(2);
    // The listener sizes a frame by the window the report came from, and clamps what it asks.
    expect(NOTE_PAGE_SCRIPT).toContain("contentWindow!==event.source");
    expect(NOTE_PAGE_SCRIPT).toContain("Math.min(4000,Math.max(24,");
  });

  it("renders from markdown when a note carries no HTML yet", () => {
    const html = renderNoteHtml({ title: "Old", markdown: "# Sunday\n\nLattice top.", icon: null }, { blob: blobs });
    expect(html).toContain("<h1>Sunday</h1><p>Lattice top.</p>");
  });

  it("escapes the title rather than letting it close the tag", () => {
    const html = renderNoteHtml({ ...note, title: "</title><script>alert(1)</script>" }, { blob: blobs });
    expect(html).not.toMatch(/<script/iu);
    expect(html).toContain("&lt;script&gt;");
  });

  it("names an untitled note", () => {
    expect(renderNoteHtml({ title: "  ", html: "", icon: null }, { blob: blobs })).toContain("<title>Untitled</title>");
  });
});

describe("the policies", () => {
  it("serves a page and a widget's document with an opaque origin and the web within reach", () => {
    for (const policy of [NOTE_PAGE_CSP, HTML_BLOCK_FRAME_CSP]) {
      expect(policy).toMatch(/^sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; /u);
      expect(policy).not.toContain("allow-same-origin");
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("script-src 'unsafe-inline' https:");
      expect(policy).toContain("img-src data: blob: https: http:");
      expect(policy).toContain("connect-src https: wss:");
      expect(policy).toContain("form-action 'none'");
      expect(policy).toContain("base-uri 'none'");
    }
    expect(NOTE_PAGE_CSP).toContain("frame-ancestors 'self'");
    expect(HTML_BLOCK_FRAME_CSP).not.toContain("frame-ancestors");
  });

  it("has a meta form without the directives a meta cannot carry", () => {
    expect(NOTE_PAGE_META_CSP).not.toContain("sandbox");
    expect(NOTE_PAGE_META_CSP).not.toContain("frame-ancestors");
    expect(NOTE_PAGE_CSP).toContain(NOTE_PAGE_META_CSP);
  });
});
