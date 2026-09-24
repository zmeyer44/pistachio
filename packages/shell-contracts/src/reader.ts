/**
 * Reader view's article model.
 *
 * A page is read into ONE structured document (`ReaderArticle`) and every
 * output is a rendering of it: the reader page's HTML, the Markdown the
 * person copies or saves, and the plain prose handed to "Read aloud". Three
 * renderers over one model, so what is spoken is what is shown is what is
 * copied.
 *
 * The model carries no HTML. The extractor that runs inside the page
 * (main/reader-extract.ts) reduces the DOM to these blocks and inlines, and
 * `normalizeReaderArticle` validates and bounds them the way
 * `normalizeTabMediaReport` does for media — so a hostile page cannot reach
 * the reader page through its own markup, and the reader page never needs
 * to trust what it renders.
 */

/** Inline runs inside a block. Nesting is deliberately flat. */
export type ReaderInline =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "emphasis"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; href: string; text: string };

export type ReaderBlock =
  | { type: "heading"; level: 2 | 3 | 4; id: string; text: ReaderInline[] }
  | { type: "paragraph"; text: ReaderInline[] }
  | { type: "list"; ordered: boolean; items: ReaderInline[][] }
  | { type: "quote"; paragraphs: ReaderInline[][] }
  | { type: "code"; text: string; lang: string | null }
  | { type: "image"; src: string; alt: string; caption: string | null }
  | { type: "rule" };

export interface ReaderArticle {
  title: string;
  byline: string | null;
  siteName: string;
  /** As the page stated it — already formatted for display, never re-parsed. */
  published: string | null;
  lang: string;
  url: string;
  faviconUrl: string | null;
  leadImage: string | null;
  blocks: ReaderBlock[];
  wordCount: number;
  readingMinutes: number;
}

export const READER_HOST = "reader";

export const MAX_READER_BLOCKS = 1_500;
export const MAX_READER_INLINES = 250;
export const MAX_READER_INLINE_TEXT = 10_000;
export const MAX_READER_CODE = 20_000;
export const MAX_READER_LIST_ITEMS = 300;
export const MAX_READER_TITLE = 300;
export const MAX_READER_BYLINE = 200;
/** Average adult prose rate; the figure the header quotes. */
const WORDS_PER_MINUTE = 230;

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const IMAGE_PROTOCOLS = new Set(["http:", "https:", "data:"]);

/** Reader ids are the same shape as an artifact's: opaque and URL-safe. */
export function isReaderId(value: string): boolean {
  return /^[0-9a-f]{32}$/u.test(value);
}

export function readerUrl(id: string): string {
  return `pistachio://${READER_HOST}/${id}`;
}

/** Whether an address is a reader page. */
export function isReaderUrl(url: string): boolean {
  return new RegExp(`^pistachio://${READER_HOST}/[0-9a-f]{32}$`, "u").test(url);
}

/** Whether reader view can be offered for an address at all. */
export function canReadUrl(url: string): boolean {
  return /^https?:\/\//u.test(url) || isReaderUrl(url);
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return [...value.slice(0, max)]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      // Keep newlines and tabs: code blocks are the one place they carry meaning.
      if (code === 10 || code === 9) return character;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .slice(0, max);
}

function collapsed(value: unknown, max: number): string {
  return boundedText(value, max).replace(/\s+/gu, " ").trim();
}

/**
 * Collapse whitespace WITHOUT trimming. The single space between a word and
 * the `<strong>` that follows it belongs to the run before it; trimming each
 * run is what turns "moved into complexity" into "moved intocomplexity".
 * A block's outer edges are trimmed once, in `normalizeInlines`.
 */
function collapsedLoose(value: unknown, max: number): string {
  return boundedText(value, max).replace(/\s+/gu, " ");
}

function safeUrl(value: unknown, protocols: Set<string>): string | null {
  const raw = collapsed(value, 8_192);
  if (raw === "") return null;
  try {
    const parsed = new URL(raw);
    return protocols.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function normalizeInline(value: unknown): ReaderInline | null {
  if (typeof value !== "object" || value === null) return null;
  const run = value as Record<string, unknown>;
  const type = run["type"];
  if (type === "link") {
    const href = safeUrl(run["href"], LINK_PROTOCOLS);
    const text = collapsed(run["text"], MAX_READER_INLINE_TEXT);
    if (text === "") return null;
    // A link whose target we refuse still keeps its words.
    return href === null ? { type: "text", text } : { type: "link", href, text };
  }
  if (type === "text" || type === "strong" || type === "emphasis" || type === "code") {
    const text = collapsedLoose(run["text"], MAX_READER_INLINE_TEXT);
    return text === "" ? null : { type, text };
  }
  return null;
}

function normalizeInlines(value: unknown): ReaderInline[] {
  if (!Array.isArray(value)) return [];
  const runs: ReaderInline[] = [];
  for (const entry of value.slice(0, MAX_READER_INLINES)) {
    const run = normalizeInline(entry);
    if (run !== null) runs.push(run);
  }
  // Inner spacing is kept run to run; only the block's own edges are trimmed.
  const first = runs[0];
  const last = runs[runs.length - 1];
  if (first !== undefined) first.text = first.text.replace(/^ +/u, "");
  if (last !== undefined) last.text = last.text.replace(/ +$/u, "");
  return runs.filter((run) => run.text !== "");
}

function inlineLength(runs: ReaderInline[]): number {
  return runs.reduce((total, run) => total + run.text.length, 0);
}

function normalizeBlock(value: unknown, headingIds: Set<string>): ReaderBlock | null {
  if (typeof value !== "object" || value === null) return null;
  const block = value as Record<string, unknown>;
  switch (block["type"]) {
    case "heading": {
      const text = normalizeInlines(block["text"]);
      if (inlineLength(text) === 0) return null;
      const level = block["level"] === 3 ? 3 : block["level"] === 4 ? 4 : 2;
      return { type: "heading", level, id: uniqueHeadingId(text, headingIds), text };
    }
    case "paragraph": {
      const text = normalizeInlines(block["text"]);
      return inlineLength(text) === 0 ? null : { type: "paragraph", text };
    }
    case "list": {
      if (!Array.isArray(block["items"])) return null;
      const items = block["items"]
        .slice(0, MAX_READER_LIST_ITEMS)
        .map((item) => normalizeInlines(item))
        .filter((item) => inlineLength(item) > 0);
      return items.length === 0 ? null : { type: "list", ordered: block["ordered"] === true, items };
    }
    case "quote": {
      if (!Array.isArray(block["paragraphs"])) return null;
      const paragraphs = block["paragraphs"]
        .slice(0, MAX_READER_LIST_ITEMS)
        .map((item) => normalizeInlines(item))
        .filter((item) => inlineLength(item) > 0);
      return paragraphs.length === 0 ? null : { type: "quote", paragraphs };
    }
    case "code": {
      const text = boundedText(block["text"], MAX_READER_CODE).replace(/\s+$/u, "");
      if (text.trim() === "") return null;
      const lang = collapsed(block["lang"], 40).toLowerCase();
      return { type: "code", text, lang: /^[a-z0-9+#-]{1,40}$/u.test(lang) ? lang : null };
    }
    case "image": {
      const src = safeUrl(block["src"], IMAGE_PROTOCOLS);
      if (src === null) return null;
      const caption = collapsed(block["caption"], 600);
      return {
        type: "image",
        src,
        alt: collapsed(block["alt"], 600),
        caption: caption === "" ? null : caption,
      };
    }
    case "rule":
      return { type: "rule" };
    default:
      return null;
  }
}

/** A stable anchor per heading, for the table of contents. */
function uniqueHeadingId(text: ReaderInline[], taken: Set<string>): string {
  const base =
    plainInline(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 60) || "section";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${String(n)}`;
  taken.add(id);
  return id;
}

export function plainInline(runs: ReaderInline[]): string {
  return runs.map((run) => run.text).join("");
}

function countWords(blocks: ReaderBlock[]): number {
  let words = 0;
  for (const block of blocks) {
    const text = blockPlainText(block);
    if (text !== "") words += text.split(/\s+/u).length;
  }
  return words;
}

function blockPlainText(block: ReaderBlock): string {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return plainInline(block.text);
    case "list":
      return block.items.map(plainInline).join(" ");
    case "quote":
      return block.paragraphs.map(plainInline).join(" ");
    case "code":
      return block.text;
    case "image":
      return block.caption ?? "";
    case "rule":
      return "";
  }
}

/** Validate and bound a page-derived article. Returns null when there is no article. */
export function normalizeReaderArticle(value: unknown): ReaderArticle | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const url = safeUrl(raw["url"], new Set(["http:", "https:", "file:", "pistachio:"]));
  if (url === null) return null;
  const headingIds = new Set<string>();
  const blocks: ReaderBlock[] = [];
  if (Array.isArray(raw["blocks"])) {
    for (const entry of raw["blocks"].slice(0, MAX_READER_BLOCKS)) {
      const block = normalizeBlock(entry, headingIds);
      if (block !== null) blocks.push(block);
    }
  }
  if (blocks.length === 0) return null;
  const byline = collapsed(raw["byline"], MAX_READER_BYLINE);
  const published = collapsed(raw["published"], 120);
  const lang = collapsed(raw["lang"], 20);
  const wordCount = countWords(blocks);
  return {
    title: collapsed(raw["title"], MAX_READER_TITLE) || "Untitled",
    byline: byline === "" ? null : byline,
    siteName: collapsed(raw["siteName"], 120) || hostOf(url),
    published: published === "" ? null : published,
    lang: /^[a-zA-Z-]{2,20}$/u.test(lang) ? lang : "",
    url,
    faviconUrl: safeUrl(raw["faviconUrl"], IMAGE_PROTOCOLS),
    leadImage: safeUrl(raw["leadImage"], IMAGE_PROTOCOLS),
    blocks,
    wordCount,
    readingMinutes: Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE)),
  };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./u, "");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

/** Escape the characters that would otherwise become Markdown syntax. */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]<>])/gu, "\\$1");
}

function inlineMarkdown(runs: ReaderInline[]): string {
  return runs
    .map((run) => {
      switch (run.type) {
        case "text":
          return escapeMarkdown(run.text);
        case "strong":
          return `**${escapeMarkdown(run.text)}**`;
        case "emphasis":
          return `_${escapeMarkdown(run.text)}_`;
        case "code":
          return `\`${run.text.replace(/`/gu, "")}\``;
        case "link":
          return `[${escapeMarkdown(run.text)}](${run.href.replace(/[()\s]/gu, encodeURIComponent)})`;
      }
    })
    .join("");
}

/** The article as a Markdown document, with a YAML front matter header. */
export function renderReaderMarkdown(article: ReaderArticle): string {
  const front = [
    "---",
    `title: ${yamlString(article.title)}`,
    `source: ${yamlString(article.url)}`,
    ...(article.byline === null ? [] : [`author: ${yamlString(article.byline)}`]),
    ...(article.published === null ? [] : [`published: ${yamlString(article.published)}`]),
    `site: ${yamlString(article.siteName)}`,
    `words: ${String(article.wordCount)}`,
    "---",
    "",
    `# ${article.title}`,
    "",
  ];
  const body: string[] = [];
  for (const block of article.blocks) {
    switch (block.type) {
      case "heading":
        body.push(`${"#".repeat(block.level)} ${inlineMarkdown(block.text)}`, "");
        break;
      case "paragraph":
        body.push(inlineMarkdown(block.text), "");
        break;
      case "list":
        block.items.forEach((item, index) => {
          body.push(`${block.ordered ? `${String(index + 1)}.` : "-"} ${inlineMarkdown(item)}`);
        });
        body.push("");
        break;
      case "quote":
        for (const paragraph of block.paragraphs) body.push(`> ${inlineMarkdown(paragraph)}`, ">");
        body.pop();
        body.push("");
        break;
      case "code":
        body.push(`\`\`\`${block.lang ?? ""}`, block.text, "```", "");
        break;
      case "image":
        body.push(`![${escapeMarkdown(block.alt)}](${block.src})`, "");
        if (block.caption !== null) body.push(`_${escapeMarkdown(block.caption)}_`, "");
        break;
      case "rule":
        body.push("---", "");
        break;
    }
  }
  return `${[...front, ...body].join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/* ------------------------------------------------------------------ */
/* Speech                                                              */
/* ------------------------------------------------------------------ */

/**
 * The article as prose to be spoken. Code, images, and rules are dropped —
 * a synthesizer reading a code block aloud is noise — and headings become
 * their own sentence so the voice pauses at a section turn.
 */
export function readerSpeechText(article: ReaderArticle): string {
  const parts: string[] = [article.title];
  if (article.byline !== null) parts.push(`By ${article.byline}.`);
  for (const block of article.blocks) {
    switch (block.type) {
      case "heading":
        parts.push(`${sentence(plainInline(block.text))}`);
        break;
      case "paragraph":
        parts.push(plainInline(block.text));
        break;
      case "list":
        for (const item of block.items) parts.push(sentence(plainInline(item)));
        break;
      case "quote":
        for (const paragraph of block.paragraphs) parts.push(plainInline(paragraph));
        break;
      case "code":
      case "image":
      case "rule":
        break;
    }
  }
  return parts.join("\n\n").replace(/\n{3,}/gu, "\n\n").trim();
}

/** End a fragment with a stop so the voice does not run it into the next line. */
function sentence(text: string): string {
  return /[.!?:;]$/u.test(text) ? text : `${text}.`;
}

/** Headings deep enough to be worth a table of contents. */
export function readerOutline(article: ReaderArticle): Array<{ id: string; level: 2 | 3 | 4; text: string }> {
  return article.blocks
    .filter((block): block is Extract<ReaderBlock, { type: "heading" }> => block.type === "heading")
    .map((block) => ({ id: block.id, level: block.level, text: plainInline(block.text) }));
}
