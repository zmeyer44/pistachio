import { describe, expect, it } from "vitest";
import type { WatchtowerDocument } from "@pistachio/agent-runtime/watchtower";
import { snapshotHtml, WATCHTOWER_DOCUMENT_CSP } from "../src/document.js";

const doc = (blocks: string[], extra: Partial<WatchtowerDocument> = {}): WatchtowerDocument => ({
  observationId: "obs-1",
  visitId: "v-1",
  pageId: 1,
  snapshotId: 1,
  url: "https://example.com/page",
  title: "A page",
  kind: "article",
  visitedAt: 1000,
  capturedAt: 2000,
  coverage: "complete",
  snippet: "",
  markdown: "",
  blocks,
  history: [],
  links: [],
  backlinks: [],
  ...extra,
});

describe("Watchtower saved page", () => {
  it("renders hostile page text as text, never as markup", () => {
    const html = snapshotHtml(
      doc(
        [
          "# A page\n\n</div><script>steal()</script>\n\nCreator: <img src=x onerror=alert(1)>",
          "## </h2><script>alert(1)</script>",
          "A paragraph with <img src=https://tracker.example/p.gif> and <a href=\"javascript:alert(1)\">a link</a>.",
          "- item <b onmouseover=x>one</b>\n- item two",
          "~~~~\n</code></pre><script>1</script>\n~~~~",
          "> quote </blockquote><iframe src=//evil.example>",
        ],
        { title: "\"><script>t()</script>", url: "https://example.com/?q=\"><script>u()</script>" },
      ),
    );
    // Nothing the page wrote survives as an element.
    expect(html).not.toMatch(/<script|<img|<iframe|<a href="javascript/iu);
    // No event handler inside a real tag (the words may appear as escaped text).
    expect(html).not.toMatch(/<[a-z][^>]*\son\w+\s*=/iu);
    expect(html.match(/<\/?(script|img|iframe)\b/giu)).toBeNull();
    expect(html).toContain("&lt;script&gt;steal()&lt;/script&gt;");
    expect(html).toContain("&lt;img src=https://tracker.example/p.gif&gt;");
    // The only links are the two the document itself writes.
    expect(html.match(/<a /gu)).toHaveLength(2);
    expect(html).toContain("<li>item two</li>");
  });

  it("allows nothing to load but the app's own fonts", () => {
    const html = snapshotHtml(doc(["# A page", "Body."]));
    expect(WATCHTOWER_DOCUMENT_CSP).toContain("default-src 'none'");
    expect(WATCHTOWER_DOCUMENT_CSP).not.toMatch(/script-src|img-src|connect-src|https?:/u);
    expect(html).toContain(`content="${WATCHTOWER_DOCUMENT_CSP}"`);
    // Every url() in the stylesheet is the internal font route.
    const urls = [...html.matchAll(/url\("([^"]+)"\)/gu)].map((match) => match[1]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url!.startsWith("pistachio://watchtower/font/"))).toBe(true);
    expect(html).not.toMatch(/<link|@import|src="http/iu);
  });

  it("says why there is no text", () => {
    expect(snapshotHtml(doc([], { coverage: "expired" }))).toContain("expired under your retention setting");
    expect(snapshotHtml(doc([], { coverage: "metadata" }))).toContain("No text was saved");
  });
});
