/**
 * The note schema and HTML through it, with no browser at all: what the
 * editor would keep for each kind of block is what comes back out of
 * zeed-dom, byte for byte.
 */

import { flattenExtensions, getExtensionField, type AnyExtension } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { docToHtml, htmlToDoc, noteExtensions, noteSchema, resolveEmbed, sanitizeEmbedSrc } from "../src/index.js";

const roundTrip = (html: string) => docToHtml(htmlToDoc(html));

describe("schema", () => {
  it("gives every node type a renderMarkdown (nodes without one vanish on export)", () => {
    const extensions = flattenExtensions(noteExtensions()) as AnyExtension[];
    const missing = Object.keys(noteSchema().nodes).filter((name) => {
      const ext = extensions.find((e) => e.name === name);
      return !ext || !getExtensionField(ext, "renderMarkdown", { name, options: ext.options, storage: ext.storage });
    });
    expect(missing).toEqual([]);
  });

  it("declares each name once — a duplicate would double every input rule", () => {
    const names = flattenExtensions(noteExtensions()).map((extension) => extension.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("includes the custom nodes", () => {
    const schema = noteSchema();
    for (const node of ["callout", "details", "detailsSummary", "detailsContent", "embed", "htmlBlock", "taskList", "table", "image"]) {
      expect(schema.nodes[node], node).toBeDefined();
    }
  });
});

describe("HTML round trip", () => {
  it("keeps callouts with nested blocks", () => {
    const html = '<div data-type="callout" data-emoji="⚠️"><p>Careful</p><ul><li><p>one</p></li></ul></div>';
    expect(roundTrip(html)).toBe(html);
  });

  it("keeps toggles, open and closed", () => {
    const open = '<details open=""><summary>Title</summary><div data-type="detailsContent"><p>Body</p></div></details>';
    const closed = '<details><summary>Title</summary><div data-type="detailsContent"><p>Body</p></div></details>';
    expect(roundTrip(open)).toBe(open);
    expect(roundTrip(closed)).toBe(closed);
  });

  it("keeps HTML blocks byte for byte, scripts and quotes included", () => {
    const raw = `<div class="w" style="color:red">"quoted" & <b>bold</b></div><script>let x = '<p>';</script>`;
    const html = `<div data-type="html-block" data-html="${raw.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")}"></div>`;
    const doc = htmlToDoc(html);
    expect(doc.firstChild?.attrs["html"]).toBe(raw);
    expect(htmlToDoc(roundTrip(html)).firstChild?.attrs["html"]).toBe(raw);
  });

  it("stores embeds with their source and a sandboxed fallback iframe", () => {
    const out = roundTrip('<div data-type="embed" data-src="https://youtu.be/dQw4w9WgXcQ"></div>');
    expect(out).toContain('data-src="https://youtu.be/dQw4w9WgXcQ"');
    expect(out).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(out).toContain('sandbox="allow-scripts allow-same-origin');
    expect(htmlToDoc(out).firstChild?.attrs["src"]).toBe("https://youtu.be/dQw4w9WgXcQ");
  });

  it("drops non-https embed sources on parse", () => {
    const doc = htmlToDoc('<div data-type="embed" data-src="javascript:alert(1)"></div><div data-type="embed" data-src="http://x.com"></div>');
    doc.forEach((node) => {
      if (node.type.name === "embed") expect(node.attrs["src"]).toBe("");
    });
  });

  it("keeps task lists, tables, code and images", () => {
    const html =
      '<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>done</p></div></li></ul>' +
      '<pre><code class="language-ts">const a = 1;</code></pre><img src="note-blob:0123456789abcdef01234567" alt="A">';
    expect(roundTrip(html)).toBe(html);
    const table = roundTrip("<table><tbody><tr><th><p>H</p></th></tr><tr><td><p>1</p></td></tr></tbody></table>");
    expect(table).toContain("<th");
    expect(table).toContain("<td");
  });

  it("drops what the schema does not know — a script tag is not a node", () => {
    const out = roundTrip("<p>hi</p><script>alert(1)</script><p onclick=\"x()\">there</p>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onclick");
    expect(out).toBe("<p>hi</p><p>there</p>");
  });

  it("refuses a javascript: link — the words stay, the link does not", () => {
    const out = roundTrip('<p><a href="javascript:alert(1)">x</a></p>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain("x");
  });
});

describe("embed URLs", () => {
  it("requires https and adds a missing scheme", () => {
    expect(sanitizeEmbedSrc("loom.com/share/abc")).toBe("https://loom.com/share/abc");
    expect(sanitizeEmbedSrc("http://example.com")).toBeNull();
    expect(sanitizeEmbedSrc("javascript:alert(1)")).toBeNull();
    expect(sanitizeEmbedSrc("not a url")).toBeNull();
  });

  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=65", "YouTube"],
    ["https://youtu.be/dQw4w9WgXcQ?t=90", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90", "YouTube"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "YouTube"],
    ["https://www.loom.com/share/0123abcd", "https://www.loom.com/embed/0123abcd", "Loom"],
    ["https://vimeo.com/76979871", "https://player.vimeo.com/video/76979871", "Vimeo"],
    ["https://example.com/page", "https://example.com/page", "Web"],
  ])("normalises %s", (input, embedUrl, provider) => {
    expect(resolveEmbed(input)).toEqual({ embedUrl, provider });
  });

  it("wraps Figma links in Figma's embed endpoint", () => {
    const target = resolveEmbed("https://www.figma.com/design/abc/File");
    expect(target?.provider).toBe("Figma");
    expect(target?.embedUrl).toBe(`https://www.figma.com/embed?embed_host=pistachio&url=${encodeURIComponent("https://www.figma.com/design/abc/File")}`);
  });
});
