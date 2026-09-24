/**
 * Smart find's page scripts in a real Chromium (docs/smart-find.md §4.1,
 * §4.4): what the collect reads and leaves alone, that a paint draws the
 * right characters with the Custom Highlight API, and that the page's DOM is
 * byte-identical before and after.
 */
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  SMART_FIND_CLEAR_SCRIPT,
  SMART_FIND_HIGHLIGHT_CSS,
  smartFindCollectScript,
  smartFindPaintScript,
  type SmartFindCollection,
  type SmartFindPainted,
} from "@pistachio/smart-find";
import { CHROMIUM, describeChromium } from "../helpers/chromium.js";

const LONG = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} of a very long paragraph that goes on and on about nothing much.`).join(" ");

const HTML = `<!doctype html><html><head><title>t</title><style>
  .hidden{display:none} .ghost{visibility:hidden} .contents{display:contents} .spacer{height:3000px}
</style></head><body>
<header><p>Site masthead with a long enough label</p></header>
<nav><p>Navigation links that should never be read</p></nav>
<main class="contents">
  <article>
    <header><h1>The title of the article lives here</h1></header>
    <p id="plain">A plain paragraph with <b>bold words</b> and <a href="#">a link inside</a> of it.</p>
    <div id="bare">Prose sitting directly in a div, as much of the web writes it.
      <p id="nested">A nested paragraph inside that same div element.</p>
      Trailing prose after the nested paragraph, still in the div.</div>
    <div id="forum">First forum line ends here<br>second line continues the thought<br><br>A new paragraph after a double break.</div>
    <p class="hidden">Hidden by display none, never to be read.</p>
    <p class="ghost">Hidden by visibility, never to be read either.</p>
    <p aria-hidden="true">Aria hidden decoration text goes here.</p>
    <p>short</p>
    <table><tr><td>Plan</td><td>Price</td><td>Storage</td></tr><tr><td>Orchard Plus</td><td>nine dollars</td><td>two terabytes</td></tr></table>
    <textarea>Typed by the person, private, never collected.</textarea>
    <div contenteditable="true">An editor's draft text, never collected.</div>
    <div class="spacer"></div>
    <p id="long">${LONG}</p>
    <div id="host"></div>
  </article>
</main>
<footer><p>Footer boilerplate and copyright notices</p></footer>
<script>
  document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<p>Text inside an open shadow root is read too.</p>";
</script>
</body></html>`;

describeChromium("smart find page scripts", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: CHROMIUM ?? undefined });
    page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.setContent(HTML);
    await page.addStyleTag({ content: SMART_FIND_HIGHLIGHT_CSS });
  }, 60_000);
  afterAll(async () => browser?.close());

  const collect = (known: number | null = null) =>
    page.evaluate(smartFindCollectScript(known)) as Promise<SmartFindCollection | { generation: number; unchanged: true } | null>;
  const highlighted = (name: string) =>
    page.evaluate((n) => [...(CSS.highlights.get(n) ?? [])].map((range) => (range as Range).toString().replace(/\s+/g, " ")), name);

  it("reads prose wherever it sits and leaves chrome, hidden and private text alone", async () => {
    const read = (await collect()) as SmartFindCollection;
    const texts = read.passages.map((passage) => passage.text);
    expect(texts).toContain("The title of the article lives here");
    expect(texts).toContain("A plain paragraph with bold words and a link inside of it.");
    expect(texts).toContain("Prose sitting directly in a div, as much of the web writes it.");
    expect(texts).toContain("A nested paragraph inside that same div element.");
    expect(texts).toContain("Trailing prose after the nested paragraph, still in the div.");
    // One <br> is a word gap, two are a paragraph.
    expect(texts).toContain("First forum line ends here second line continues the thought");
    expect(texts).toContain("A new paragraph after a double break.");
    // A table row is one passage, its cells kept apart.
    expect(texts).toContain("Orchard Plus nine dollars two terabytes");
    expect(texts).toContain("Text inside an open shadow root is read too.");
    const all = texts.join("\n");
    for (const absent of ["masthead", "Navigation", "Footer", "display none", "visibility", "Aria hidden", "Typed by the person", "editor's draft"])
      expect(all).not.toContain(absent);
    expect(texts).not.toContain("short");
    expect(read.truncated).toBe(false);
  });

  it("splits a long block on sentence boundaries into parts of one block", async () => {
    const read = (await collect()) as SmartFindCollection;
    const parts = read.passages.filter((passage) => passage.text.startsWith("Sentence number"));
    expect(parts.length).toBeGreaterThan(3);
    expect(new Set(parts.map((part) => part.block)).size).toBe(1);
    expect(parts.map((part) => part.id)).toEqual(parts.map((_, i) => `${parts[0]!.block}p${i}`));
    for (const part of parts) {
      expect(part.text.length).toBeLessThanOrEqual(1200);
      expect(part.text.endsWith(".")).toBe(true);
    }
    expect(parts.map((part) => part.text).join(" ")).toBe(LONG);
  });

  it("answers 'unchanged' until the page changes", async () => {
    const first = (await collect()) as SmartFindCollection;
    expect(await collect(first.generation)).toEqual({ generation: first.generation, unchanged: true });
    await page.evaluate(() => document.getElementById("plain")!.append(" More."));
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    const again = (await collect(first.generation)) as SmartFindCollection;
    expect(again.generation).toBe(first.generation + 1);
    expect(again.passages.map((p) => p.text)).toContain("A plain paragraph with bold words and a link inside of it. More.");
    await page.evaluate(() => document.getElementById("plain")!.lastChild!.remove());
  });

  it("paints paragraph, key sentence and active layers across inline tags without touching the DOM", async () => {
    const read = (await collect()) as SmartFindCollection;
    const plain = read.passages.find((passage) => passage.text.startsWith("A plain paragraph"))!;
    const row = read.passages.find((passage) => passage.text.startsWith("Orchard Plus"))!;
    const before = await page.evaluate(() => document.documentElement.outerHTML);
    const start = plain.text.indexOf("bold words");
    const painted = (await page.evaluate(
      smartFindPaintScript({
        generation: read.generation,
        matches: [{ ids: [plain.id], focus: { id: plain.id, start, end: start + "bold words and a link".length } }, { ids: [row.id] }],
        active: 0,
        scroll: false,
        weak: false,
      }),
    )) as SmartFindPainted;
    expect(painted.stale).toEqual([]);
    // A range's own text has no gap between table cells; the passage's does.
    expect(await highlighted("pistachio-find-match")).toEqual([plain.text, "Orchard Plusnine dollarstwo terabytes"]);
    expect(await highlighted("pistachio-find-focus")).toEqual(["bold words and a link"]);
    expect(await highlighted("pistachio-find-active")).toEqual(["bold words and a link"]);
    expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(before);
  });

  it("scrolls the active sentence of a block taller than the window into view", async () => {
    const read = (await collect()) as SmartFindCollection;
    const parts = read.passages.filter((passage) => passage.text.startsWith("Sentence number"));
    const target = parts.at(-1)!;
    const at = target.text.lastIndexOf("Sentence number 59");
    await page.setViewportSize({ width: 320, height: 300 });
    await page.evaluate(() => scrollTo(0, 0));
    await page.evaluate(
      smartFindPaintScript({
        generation: read.generation,
        matches: [{ ids: [target.id], focus: { id: target.id, start: at, end: target.text.length } }],
        active: 0,
        scroll: true,
        weak: true,
      }),
    );
    const rect = await page.evaluate(() => {
      const range = [...CSS.highlights.get("pistachio-find-active")!][0] as Range;
      const box = range.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, height: innerHeight };
    });
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(rect.height);
    expect((await highlighted("pistachio-find-weak")).length).toBe(1);
    expect(await highlighted("pistachio-find-match")).toEqual([]);
    await page.setViewportSize({ width: 900, height: 700 });
  });

  it("reports a passage whose text changed as stale, refuses another generation, and clears completely", async () => {
    const read = (await collect()) as SmartFindCollection;
    const nested = read.passages.find((passage) => passage.text.startsWith("A nested paragraph"))!;
    await page.evaluate(() => (document.getElementById("nested")!.firstChild as Text).replaceData(0, 8, "Replaced"));
    const paint = { generation: read.generation, matches: [{ ids: [nested.id] }], active: 0, scroll: false, weak: false };
    expect(await page.evaluate(smartFindPaintScript(paint))).toEqual({ stale: [nested.id] });
    expect(await page.evaluate(smartFindPaintScript({ ...paint, generation: read.generation + 5 }))).toBeNull();
    expect(await page.evaluate(SMART_FIND_CLEAR_SCRIPT)).toBe(true);
    expect(await page.evaluate(() => CSS.highlights.size)).toBe(0);
    expect(await page.evaluate(smartFindPaintScript(paint))).toBeNull();
  });
});
