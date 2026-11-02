/**
 * Markdown in and out of a note (docs/notes.md §2). HTML is the canonical
 * body; markdown is what a note exports as, imports from, and what the agent
 * reads and writes, so the conversion has to lose as little as it can: every
 * node declares its own markdown, and `@tiptap/markdown` runs over the same
 * schema the editor does.
 */

import type { JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { docToHtml, htmlToDoc, jsonToDoc } from "./dom.js";
import { noteExtensions } from "./schema.js";

let manager: MarkdownManager | null = null;

// One manager per process: each instance registers its tokenizers on marked's
// shared instance, so creating them per call would pile up registrations.
function markdownManager(): MarkdownManager {
  return (manager ??= new MarkdownManager({ extensions: noteExtensions() }));
}

/** `---` fences at the very start, and what lies between them. */
const FRONTMATTER = /^\uFEFF?---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/u;
/** A line YAML metadata may hold: `key: value`, `- item`, a comment, a blank, an indented continuation. */
const YAML_LINE = /^(?:[ \t]*(?:[A-Za-z_][\w.-]*[ \t]*:(?:[ \t].*)?|-[ \t].*|#.*)?|[ \t]+\S.*)$/u;
const YAML_KEY = /^[A-Za-z_][\w.-]*[ \t]*:(?:[ \t]|$)/u;

/**
 * Frontmatter is metadata, not the note: dropped only when what the fences
 * hold is shaped like YAML, starting with a key. Two rules around prose —
 * `---`, a paragraph, `---` — are two rules, and the paragraph stays.
 */
function stripFrontmatter(markdown: string): string {
  const match = FRONTMATTER.exec(markdown);
  if (match === null) return markdown;
  const lines = match[1]!.split("\n");
  if (!YAML_KEY.test(lines[0] ?? "") || !lines.every((line) => YAML_LINE.test(line))) return markdown;
  return markdown.slice(match[0].length);
}

/* ----------------------------- markdown → doc ----------------------------- */

/** Parses markdown into a document. Frontmatter is dropped. */
export function markdownToDoc(markdown: string, schema?: Schema): PMNode {
  const source = stripFrontmatter(markdown.replace(/\r\n?/gu, "\n"));
  return jsonToDoc(markdownManager().parse(source), schema);
}

export function markdownToJson(markdown: string): JSONContent {
  return markdownToDoc(markdown).toJSON() as JSONContent;
}

/** Parses markdown into canonical document HTML. */
export function markdownToHtml(markdown: string): string {
  return markdown.trim() === "" ? "" : docToHtml(markdownToDoc(markdown));
}

/* ----------------------------- doc → markdown ----------------------------- */

function isEmptyParagraph(node: JSONContent): boolean {
  return node.type === "paragraph" && (node.content?.length ?? 0) === 0;
}

/** Serializes document JSON to markdown. */
export function jsonToMarkdown(doc: JSONContent): string {
  // Empty paragraphs are layout in the editor, not content: they would export
  // as `&nbsp;` lines.
  const body = markdownManager()
    .serialize({ ...doc, content: (doc.content ?? []).filter((n) => !isEmptyParagraph(n)) })
    .trim();
  const markdown = tidyProse(collapseBlankLines(body));
  return markdown ? `${markdown}\n` : "";
}

/** Serializes canonical document HTML to markdown. */
export function htmlToMarkdown(html: string): string {
  return html.trim() === "" ? "" : jsonToMarkdown(htmlToDoc(html).toJSON() as JSONContent);
}

// What a line's content may start after: indentation, list/to-do markers, quote markers.
const LINE_PREFIX = /^\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|>\s?)*/u;

/**
 * The fence a line opens or closes — after any list or quote prefix, since a
 * code block inside a quote is written `> ````, and after a callout's emoji,
 * since one whose first block is code is written `> 💡 ```` — or undefined.
 */
function fenceMarker(line: string): string | undefined {
  const content = line.slice(LINE_PREFIX.exec(line)![0].length);
  return /^(?:\p{Extended_Pictographic}[\p{Extended_Pictographic}\uFE0F\u200D]*\s+)?(`{3,}|~{3,})/u.exec(content)?.[1];
}

/** Collapses runs of blank lines to one, leaving fenced code untouched. */
function collapseBlankLines(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const marker = fenceMarker(line);
    if (marker !== undefined && (fence === null || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence === null ? marker : null;
    }
    if (fence === null && line.trim() === "" && (out.at(-1)?.trim() ?? "") === "") continue;
    out.push(line);
  }
  return out.join("\n");
}

const LINK = /(?<!!)\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s()<>]+)\)/gu;

/**
 * Readability passes over serialized markdown, outside fenced code, inline
 * code and raw HTML lines:
 * - `[https://x.com](https://x.com)` → `<https://x.com>` (and mailto links
 *   whose text is the address). Marks render without seeing their text, so
 *   this cannot happen in the link mark's own renderer.
 * - The serializer entity-encodes `&`, `<` and `>` in all text ("R&amp;D");
 *   each goes back to the plain character wherever it cannot start markup.
 */
function tidyProse(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = fenceMarker(line);
      if (marker !== undefined && (fence === null || (marker[0] === fence[0] && marker.length >= fence.length))) {
        fence = fence === null ? marker : null;
        return line;
      }
      if (fence !== null || /^\s*<\/?[A-Za-z]/u.test(line) || !/&|\]\(/u.test(line)) return line;
      const contentStart = LINE_PREFIX.exec(line)![0].length;
      return proseSegments(line)
        .map(({ text, code, start }) => {
          if (code) return text;
          return text
            .replace(/&gt;/gu, (gt, at: number) => (start + at > contentStart ? ">" : gt)) // ">" opens a quote only at line start
            .replace(/&lt;(?![A-Za-z/!?])/gu, "<") // "<" opens a tag only before a name, "/", "!" or "?"
            .replace(/&amp;(?!#?[A-Za-z0-9]+;)/gu, "&") // "&" only matters when it would spell an entity
            .replace(LINK, (all, text: string, href: string) => (href === text || href === `mailto:${text}` ? `<${text}>` : all));
        })
        .join("");
    })
    .join("\n");
}

/** marked's own reading of a code span: a run of backticks, content, the same run — so `` ``a`b`` `` is one span, not `` ``a` `` and prose. */
const CODE_SPAN = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)/gu;

/** A line as prose and code spans, each with where it starts in the line. */
function proseSegments(line: string): Array<{ text: string; code: boolean; start: number }> {
  const segments: Array<{ text: string; code: boolean; start: number }> = [];
  let at = 0;
  CODE_SPAN.lastIndex = 0;
  for (let match = CODE_SPAN.exec(line); match !== null; match = CODE_SPAN.exec(line)) {
    if (match.index > at) segments.push({ text: line.slice(at, match.index), code: false, start: at });
    segments.push({ text: match[0], code: true, start: match.index });
    at = match.index + match[0].length;
  }
  if (at < line.length) segments.push({ text: line.slice(at), code: false, start: at });
  return segments;
}

/* ----------------------------- paste detection ---------------------------- */

const MARKDOWN_SIGNALS = [
  /^#{1,6}[ \t]+\S/mu, // heading
  /^[ \t]*[-*+][ \t]+\S/mu, // bullet
  /^[ \t]*\d+[.)][ \t]+\S/mu, // ordered
  /^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]/mu, // task
  /^>[ \t]?\S/mu, // quote
  /^(```|~~~)/mu, // fence
  /^\|.+\|[ \t]*\n\|[ \t:|-]+\|/mu, // table
  /\[[^\]\n]+\]\([^)\s]+\)/u, // link
  /(\*\*|__)[^\s*_](?:.*?[^\s*_])?\1/u, // bold
  /`[^`\n]+`/u, // inline code
  /^([-*_])\1{2,}[ \t]*$/mu, // rule
];

/** Heuristic: does plain text carry markdown structure worth converting on paste? */
export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_SIGNALS.some((re) => re.test(text));
}
