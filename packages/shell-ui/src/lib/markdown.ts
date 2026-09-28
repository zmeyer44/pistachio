/**
 * A reply's Markdown, as blocks and spans the chat can draw (components/chat/Markdown.tsx).
 *
 * The model writes Markdown (agent-runtime `FORMAT_RULES`); this reads it
 * with marked's lexer — GitHub-flavoured, so tables and strikethrough
 * parse — and hands back marked's own token tree, never HTML. The renderer
 * turns each token into an element of its own, so nothing the model writes
 * (a `<script>`, an `<img onerror>`) is ever markup: an `html` token draws
 * as the text it was. Pure: no DOM, no React.
 *
 * Two things here are about STREAMING. A reply arrives a few words at a
 * time, so the text this parses is usually cut mid-sentence, mid-list,
 * mid-fence: `closeOpenFence` keeps an unfinished code block a code block
 * rather than three backticks in a paragraph, and `words` splits a text
 * run so each word can resolve into place as it lands.
 */

import { Lexer, type Token, type Tokens } from "marked";

export type MarkdownToken = Token;
export type { Tokens as MarkdownTokens } from "marked";

const OPTIONS = { gfm: true, breaks: false, pedantic: false } as const;

/**
 * A fence the text opens and never closes — the model is still inside it
 * — is closed for the parse, so the block draws as code while it streams
 * rather than flickering into a paragraph of backticks.
 */
export function closeOpenFence(text: string): string {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) continue;
    const marker = fence[1]!;
    if (open === null) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length) open = null;
  }
  return open === null ? text : `${text}\n${open}`;
}

/**
 * A streamed reply cut before a construct it has not finished: a link whose
 * address is still arriving would otherwise draw as a half address, and an
 * open code span or emphasis as its bare marker. The cut waits at the
 * construct's opening until it closes — a few words at most — and never
 * touches text that is not at the very end.
 */
export function holdUnfinished(text: string): string {
  // A link: `[label](address…` with no `)` yet, or `[label` with no `]` yet.
  const openBracket = text.lastIndexOf("[");
  if (openBracket !== -1) {
    const rest = text.slice(openBracket);
    const closed = /^\[[^\]]*\]\([^)]*\)/u.test(rest) || (/^\[[^\]]*\]/u.test(rest) && !/^\[[^\]]*\]\(/u.test(rest));
    if (!closed && !rest.includes("\n\n")) return text.slice(0, openBracket).trimEnd();
  }
  // A code span on the last line: an odd number of backticks means one is open.
  const lastLine = text.slice(text.lastIndexOf("\n") + 1);
  if (!/^\s{0,3}(`{3,}|~{3,})/u.test(lastLine)) {
    const ticks = (lastLine.match(/`/g) ?? []).length;
    if (ticks % 2 === 1) return text.slice(0, text.lastIndexOf("`")).trimEnd();
  }
  // Emphasis opened on the last paragraph and not closed.
  const paragraph = text.slice(text.lastIndexOf("\n\n") + 1);
  const strong = (paragraph.match(/\*\*/g) ?? []).length;
  if (strong % 2 === 1) return text.slice(0, text.lastIndexOf("**")).trimEnd();
  return text;
}

/** The block tokens of a reply. Never throws: text marked cannot read is one paragraph of itself. */
export function parseMarkdown(text: string): MarkdownToken[] {
  const source = closeOpenFence(text);
  try {
    return Lexer.lex(source, OPTIONS);
  } catch {
    return [{ type: "paragraph", raw: source, text: source, tokens: [{ type: "text", raw: source, text: source }] } as Tokens.Paragraph];
  }
}

/**
 * A text run as the words and the spaces between them, in order, so the
 * renderer can wrap each word for the streaming reveal and leave the
 * whitespace — which carries the line breaks — as it was.
 */
export function words(text: string): Array<{ kind: "word" | "space"; value: string }> {
  const parts: Array<{ kind: "word" | "space"; value: string }> = [];
  for (const match of text.matchAll(/(\s+)|(\S+)/g)) {
    parts.push(match[1] !== undefined ? { kind: "space", value: match[1] } : { kind: "word", value: match[2]! });
  }
  return parts;
}

/** The plain text of a token tree — for a copy button, an aria label, a title. */
export function plainText(tokens: readonly MarkdownToken[]): string {
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "text":
      case "codespan":
      case "escape":
        out += "tokens" in token && Array.isArray(token.tokens) && token.tokens.length > 0 ? plainText(token.tokens) : token.text;
        break;
      case "code":
        out += `${token.text}\n`;
        break;
      case "html":
        out += token.text;
        break;
      case "br":
        out += "\n";
        break;
      case "space":
        out += "\n";
        break;
      case "list":
        for (const item of (token as Tokens.List).items) out += `${plainText(item.tokens)}\n`;
        break;
      case "table": {
        const table = token as Tokens.Table;
        out += `${table.header.map((cell) => plainText(cell.tokens)).join(" | ")}\n`;
        for (const row of table.rows) out += `${row.map((cell) => plainText(cell.tokens)).join(" | ")}\n`;
        break;
      }
      default:
        if ("tokens" in token && Array.isArray(token.tokens)) out += plainText(token.tokens);
        else if ("text" in token && typeof token.text === "string") out += token.text;
        if (token.type === "paragraph" || token.type === "heading" || token.type === "blockquote") out += "\n";
    }
  }
  return out;
}

/** Whether a reply is a single short paragraph — one that reads as a line of chat, not a document. */
export function isShortReply(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length <= 160 && !trimmed.includes("\n");
}
