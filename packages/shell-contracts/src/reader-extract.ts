/**
 * Reading a page for its ARTICLE, as a string to evaluate in it.
 *
 * Lifted out of `apps/desktop/src/main/reader-extract.ts` in S6 so both hosts
 * read a page the same way (docs/web-browser-design.md §11, "Reader"): the
 * desktop through `webContents.executeJavaScript`, the cloud shell through
 * `page.evaluate`. Nothing here is Electron's, and nothing here is Node's.
 *
 * It scores the page's containers the way Readability does — prose length and
 * comma count credited up to a parent, chrome-sounding class names penalized,
 * link-dense containers discarded — then walks the winner into the flat block
 * model in `./reader.ts`.
 *
 * The script returns DATA, never markup: every caller re-validates through
 * `normalizeReaderArticle`, so nothing a page writes reaches a reader view as
 * HTML.
 *
 * Written as a string on purpose: it is evaluated in a context that shares
 * nothing with this module. It therefore uses no backticks and no template
 * literals of its own.
 */

import {
  MAX_READER_BLOCKS,
  MAX_READER_CODE,
  MAX_READER_INLINE_TEXT,
} from "./reader.js";

/** Containers whose names say "not the article". */
const NEGATIVE = "comment|meta-|footer|footnote|sidebar|sponsor|advert|promo|masthead|social|share|related|recommend|newsletter|subscribe|paywall|popup|modal|banner|nav|menu|breadcrumb|pagination|disqus|cookie|consent|skip";
/** Containers whose names say "this is it". */
const POSITIVE = "article|body|content|entry|main|page|post|story|text|blog|column";
/** The author-and-date line, which the reader header already states. */
const BYLINE = "byline|by-line|dateline|author|post-meta|entry-meta|article-meta|posted-on|timestamp";

export const READER_EXTRACT_SCRIPT = `(() => {
  const NEGATIVE = /${NEGATIVE}/i;
  const POSITIVE = /${POSITIVE}/i;
  const BYLINE = /${BYLINE}/i;
  const MAX_BLOCKS = ${String(MAX_READER_BLOCKS)};
  const MAX_TEXT = ${String(MAX_READER_INLINE_TEXT)};
  const MAX_CODE = ${String(MAX_READER_CODE)};

  const clean = (value) => String(value == null ? "" : value).replace(/\\s+/g, " ").trim();

  const absolute = (raw) => {
    if (!raw) return null;
    try { return new URL(raw, document.baseURI).href; } catch { return null; }
  };

  const names = (element) =>
    (String(element.className || "") + " " + String(element.id || "")).toLowerCase();

  const hidden = (element) => {
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return true;
    const style = window.getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0;
  };

  const textOf = (element) => clean(element.innerText || element.textContent || "");

  /** Share of an element's characters that sit inside links — nav is ~1, prose ~0. */
  const linkDensity = (element) => {
    const total = textOf(element).length;
    if (total === 0) return 1;
    let linked = 0;
    for (const anchor of element.querySelectorAll("a")) linked += textOf(anchor).length;
    return linked / total;
  };

  /* ---- 1. Choose the article's container ------------------------------ */

  const SKIP = new Set(["NAV","ASIDE","FOOTER","HEADER","FORM","BUTTON","SCRIPT","STYLE","NOSCRIPT","IFRAME","SVG","CANVAS","VIDEO","AUDIO","SELECT","TEXTAREA","INPUT","LABEL"]);

  const scores = new Map();
  const bump = (element, amount) => {
    if (!element || element.nodeType !== 1 || element === document.body) return;
    scores.set(element, (scores.get(element) || 0) + amount);
  };

  for (const node of document.querySelectorAll("p, pre, blockquote, li")) {
    const text = textOf(node);
    if (text.length < 25) continue;
    if (NEGATIVE.test(names(node))) continue;
    // Readability's shape: a base point, credit for clauses, credit for length.
    let score = 1 + (text.match(/,/g) || []).length + Math.min(Math.floor(text.length / 100), 3);
    if (node.tagName === "LI") score *= 0.4;
    bump(node.parentElement, score);
    bump(node.parentElement && node.parentElement.parentElement, score / 2);
  }

  for (const [element, score] of scores) {
    const name = names(element);
    let adjusted = score;
    if (NEGATIVE.test(name)) adjusted -= 25;
    if (POSITIVE.test(name)) adjusted += 25;
    if (element.tagName === "ARTICLE") adjusted += 30;
    if (element.getAttribute("role") === "main" || element.tagName === "MAIN") adjusted += 20;
    // A container that is mostly links is a list of other pages, not this one.
    adjusted *= 1 - Math.min(linkDensity(element), 0.9);
    scores.set(element, adjusted);
  }

  let root = null;
  let best = 0;
  for (const [element, score] of scores) {
    if (score > best) { best = score; root = element; }
  }
  // A single strong <article> beats a marginal score fight.
  const article = document.querySelector("article");
  if (article && (!root || !article.contains(root)) && textOf(article).length > 400) {
    if (!root || (scores.get(article) || 0) > best * 0.6) root = article;
  }
  if (!root) root = document.querySelector("main") || document.body;
  if (!root || textOf(root).length < 200) return null;

  /* ---- 2. Walk it into blocks ----------------------------------------- */

  const metaOf = (...names) => {
    for (const name of names) {
      const tag = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
      const value = tag && clean(tag.getAttribute("content"));
      if (value) return value;
    }
    return "";
  };

  const heading = document.querySelector("h1");
  const title = metaOf("og:title", "twitter:title") || clean(heading && heading.innerText) || clean(document.title);
  // The reader page prints the title itself; an <h1> repeating it is furniture.
  const titleKey = title.toLowerCase().replace(/[^a-z0-9]+/g, "");

  const inlineOf = (element) => {
    const runs = [];
    // Collapse runs of whitespace but do NOT trim: the single space between a
    // word and the <strong> after it lives at the edge of a text node, and
    // trimming each node is what glues "into" onto "complexity".
    const collapse = (value) => String(value == null ? "" : value).replace(/\\s+/g, " ");
    const push = (type, text, href) => {
      const value = collapse(text);
      if (value === "" || (value === " " && runs.length === 0)) return;
      const previous = runs[runs.length - 1];
      if (previous && previous.type === type && type === "text") {
        previous.text = collapse(previous.text + value).slice(0, MAX_TEXT);
        return;
      }
      runs.push(href ? { type: type, text: value.slice(0, MAX_TEXT), href: href } : { type: type, text: value.slice(0, MAX_TEXT) });
    };
    const walk = (node, mark) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { push(mark || "text", child.nodeValue); continue; }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName;
        if (SKIP.has(tag)) continue;
        if (tag === "BR") { push("text", " "); continue; }
        if (tag === "A") {
          const href = absolute(child.getAttribute("href"));
          const text = textOf(child);
          if (text !== "") push("link", text, href || undefined);
          continue;
        }
        if (tag === "CODE" || tag === "KBD" || tag === "SAMP") { push("code", textOf(child)); continue; }
        if (tag === "STRONG" || tag === "B") { walk(child, "strong"); continue; }
        if (tag === "EM" || tag === "I") { walk(child, "emphasis"); continue; }
        walk(child, mark);
      }
    };
    walk(element, null);
    // The block's own edges are trimmed once, at the end.
    if (runs.length > 0) {
      runs[0].text = runs[0].text.replace(/^\\s+/, "");
      runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\\s+$/, "");
    }
    return runs.filter((run) => run.text !== "");
  };

  const blocks = [];
  const seenImages = new Set();

  const pushImage = (img, caption) => {
    const src = absolute(img.currentSrc || img.src || img.getAttribute("data-src"));
    if (!src || seenImages.has(src)) return;
    const rect = img.getBoundingClientRect();
    const width = img.naturalWidth || Number(img.getAttribute("width")) || rect.width || 0;
    const height = img.naturalHeight || Number(img.getAttribute("height")) || rect.height || 0;
    // Spacers, tracking pixels, and icons are not illustrations.
    if (Math.min(width, height) < 100) return;
    seenImages.add(src);
    blocks.push({ type: "image", src: src, alt: clean(img.getAttribute("alt")), caption: caption ? clean(caption) : "" });
  };

  const visit = (node) => {
    if (blocks.length >= MAX_BLOCKS) return;
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (SKIP.has(tag)) return;
    if (hidden(node)) return;
    if (NEGATIVE.test(names(node)) && tag !== "P") return;

    if (tag === "H1" || tag === "H2" || tag === "H3" || tag === "H4" || tag === "H5" || tag === "H6") {
      const level = tag === "H1" || tag === "H2" ? 2 : tag === "H3" ? 3 : 4;
      const text = inlineOf(node);
      if (text.length === 0) return;
      const key = textOf(node).toLowerCase().replace(/[^a-z0-9]+/g, "");
      // The page's own restatement of the title, which the header already shows.
      if (key !== "" && key === titleKey) return;
      blocks.push({ type: "heading", level: level, text: text });
      return;
    }
    if (tag === "P") {
      if (BYLINE.test(names(node))) return;
      const text = inlineOf(node);
      if (text.length > 0) blocks.push({ type: "paragraph", text: text });
      return;
    }
    if (tag === "PRE") {
      const code = node.querySelector("code");
      const langAttr = String((code || node).className || "").match(/(?:language|lang)-([a-z0-9+#-]+)/i);
      const text = String((code || node).textContent || "").slice(0, MAX_CODE);
      if (text.trim() !== "") blocks.push({ type: "code", text: text, lang: langAttr ? langAttr[1] : "" });
      return;
    }
    if (tag === "BLOCKQUOTE") {
      const paragraphs = [...node.querySelectorAll("p")].map(inlineOf).filter((runs) => runs.length > 0);
      const only = paragraphs.length > 0 ? paragraphs : [inlineOf(node)].filter((runs) => runs.length > 0);
      if (only.length > 0) blocks.push({ type: "quote", paragraphs: only });
      return;
    }
    if (tag === "UL" || tag === "OL") {
      const items = [...node.children]
        .filter((child) => child.tagName === "LI")
        .map(inlineOf)
        .filter((runs) => runs.length > 0);
      if (items.length > 0) blocks.push({ type: "list", ordered: tag === "OL", items: items });
      return;
    }
    if (tag === "FIGURE") {
      const img = node.querySelector("img");
      const caption = node.querySelector("figcaption");
      if (img) pushImage(img, caption ? textOf(caption) : "");
      return;
    }
    if (tag === "IMG") { pushImage(node, ""); return; }
    if (tag === "HR") { blocks.push({ type: "rule" }); return; }
    if (tag === "TABLE") {
      // A data table has no home in the block model; its rows read as lines.
      const rows = [...node.querySelectorAll("tr")]
        .map((row) => clean([...row.children].map(textOf).filter(Boolean).join(" — ")))
        .filter(Boolean);
      if (rows.length > 0) blocks.push({ type: "list", ordered: false, items: rows.map((row) => [{ type: "text", text: row.slice(0, MAX_TEXT) }]) });
      return;
    }
    for (const child of node.children) visit(child);
  };

  for (const child of root.children) visit(child);
  // A root that is itself one prose block (some CMSes) has no element children worth walking.
  if (blocks.length === 0) {
    const text = inlineOf(root);
    if (text.length > 0) blocks.push({ type: "paragraph", text: text });
  }

  /* ---- 3. Metadata ---------------------------------------------------- */

  // In priority order, not DOM order: a page that declares both an apple-touch
  // icon and its own favicon should be represented by the favicon.
  const iconLink =
    document.querySelector('link[rel="icon"]') ||
    document.querySelector('link[rel~="icon"]:not([rel~="apple-touch-icon"])') ||
    document.querySelector('link[rel="shortcut icon"]') ||
    document.querySelector('link[rel~="apple-touch-icon"]');

  return {
    url: location.href,
    title: title,
    byline: metaOf("author", "article:author", "og:article:author") ||
      clean((document.querySelector('[rel="author"], .byline, .author, [itemprop="author"]') || {}).innerText || ""),
    siteName: metaOf("og:site_name") || location.host.replace(/^www\\./, ""),
    published: metaOf("article:published_time", "datePublished", "og:article:published_time") ||
      clean((document.querySelector("time[datetime]") || {}).getAttribute && document.querySelector("time[datetime]").getAttribute("datetime") || ""),
    lang: clean(document.documentElement.lang),
    faviconUrl: iconLink ? absolute(iconLink.getAttribute("href")) : absolute("/favicon.ico"),
    leadImage: absolute(metaOf("og:image", "twitter:image")),
    blocks: blocks.slice(0, MAX_BLOCKS),
  };
})()`;

