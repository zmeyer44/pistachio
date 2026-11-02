/**
 * Callout: an emoji-led tinted box holding blocks (docs/notes.md §5).
 *
 * Storage: `<div data-type="callout" data-emoji="💡">…blocks…</div>`.
 * Markdown: exported as an emoji blockquote (`> 💡 text`); imported from that
 * form, from GitHub alerts (`> [!NOTE]`) and from `:::callout {emoji="…"}`.
 */

import {
  createBlockMarkdownSpec,
  mergeAttributes,
  Node,
  type JSONContent,
  type MarkdownParseHelpers,
  type MarkdownToken,
  type MarkdownTokenizer,
} from "@tiptap/core";

export const DEFAULT_CALLOUT_EMOJI = "💡";

export const CALLOUT_EMOJI_PRESETS = [
  "💡", "📌", "⚠️", "❗", "✅", "❌", "ℹ️", "🔥",
  "⭐", "📝", "💬", "🧠", "🔍", "📊", "🚀", "🎯",
] as const;

const GITHUB_ALERT_EMOJI: Record<string, string> = {
  NOTE: "ℹ️",
  TIP: "💡",
  IMPORTANT: "❗",
  WARNING: "⚠️",
  CAUTION: "🛑",
};

/** A single (possibly ZWJ/variation-selector) emoji followed by whitespace. */
const LEADING_EMOJI = /^(\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier}|‍\p{Extended_Pictographic}️?)*)\s+/u;
/** The same, on a line that may hold nothing after the emoji (`> 💡` with its blocks below). */
const LEADING_EMOJI_ALONE = /^(\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier}|‍\p{Extended_Pictographic}️?)*)(?:\s+|$)/u;
const GITHUB_ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/iu;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      /** Wraps the selected blocks in a callout. */
      setCallout: (attrs?: { emoji?: string }) => ReturnType;
    };
  }
}

const pandocSpec = createBlockMarkdownSpec({ nodeName: "callout", allowedAttributes: ["emoji"] });

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      emoji: {
        default: DEFAULT_CALLOUT_EMOJI,
        parseHTML: (el) => el.getAttribute("data-emoji") || DEFAULT_CALLOUT_EMOJI,
        renderHTML: (attrs) => ({ "data-emoji": attrs["emoji"] }),
      },
      // The GitHub alert type a callout was imported from (NOTE, TIP…), so it
      // exports back as `> [!NOTE]` while its emoji still matches.
      alert: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-alert")?.toUpperCase() || null,
        renderHTML: (attrs) => (attrs["alert"] ? { "data-alert": attrs["alert"] } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "callout" }, HTMLAttributes), 0];
  },

  markdownTokenizer: pandocSpec.markdownTokenizer,
  parseMarkdown: pandocSpec.parseMarkdown,

  renderMarkdown(node, h) {
    const emoji = (node.attrs?.["emoji"] as string | undefined) || DEFAULT_CALLOUT_EMOJI;
    const alert = typeof node.attrs?.["alert"] === "string" ? (node.attrs["alert"] as string) : null;
    const body = h.renderChildren(node.content ?? [], "\n\n").trim();
    const quote = (line: string) => (line ? `> ${line}` : ">");
    if (alert && GITHUB_ALERT_EMOJI[alert] === emoji) return [`> [!${alert}]`, ...body.split("\n").map(quote)].join("\n");
    return body
      .split("\n")
      .map((line, i) => (i === 0 ? `> ${emoji} ${line}` : quote(line)))
      .join("\n");
  },

  addCommands() {
    return {
      setCallout:
        (attrs) =>
        ({ commands }) =>
          commands.wrapIn(this.name, attrs),
    };
  },

  addKeyboardShortcuts() {
    return {
      // Enter on an empty last paragraph leaves the callout, like Notion.
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parent.content.size > 0 || $from.depth < 2) return false;
        const wrapper = $from.node(-1);
        if (wrapper.type.name !== this.name || $from.index(-1) !== wrapper.childCount - 1) return false;
        return editor.commands.lift(this.name);
      },
    };
  },
});

/**
 * Tokenizes a blockquote whose first line starts with an emoji or a GitHub
 * alert marker as a `calloutQuote` token (plain blockquotes are left alone).
 * Its own token type keeps the stock blockquote parser and renderer intact.
 */
export const calloutQuoteTokenizer: MarkdownTokenizer = {
  name: "calloutQuote",
  level: "block",
  start: (src) => src.search(/^ {0,3}>[ \t]?(?:\p{Extended_Pictographic}|\[!)/mu),
  tokenize(src, _tokens, lexer) {
    if (!/^ {0,3}>[ \t]?(?:\p{Extended_Pictographic}|\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\])/iu.test(src)) return undefined;
    const raw = /^(?: {0,3}>[^\n]*(?:\n|$))+/u.exec(src)![0];
    const lines = raw
      .replace(/\n$/u, "")
      .split("\n")
      .map((line) => line.replace(/^ {0,3}>[ \t]?/u, ""));
    // The marker is the callout's, not its first block's: taken off the
    // first line before the blocks are read, so a callout whose first block
    // is code, a heading or a list (`> 💡 ```…`) gets that block, not a
    // paragraph holding its syntax.
    const first = lines[0] ?? "";
    const alert = GITHUB_ALERT.exec(first);
    const lead = alert ? null : LEADING_EMOJI_ALONE.exec(first);
    const marker = alert ?? lead;
    if (marker === null) return undefined;
    lines[0] = first.slice(marker[0].length);
    const token: MarkdownToken = { type: "calloutQuote", raw, tokens: lexer.blockTokens(`${lines.join("\n")}\n`) };
    if (alert) token["alert"] = alert[1]!.toUpperCase();
    else token["emoji"] = lead![1];
    return token;
  },
};

/**
 * Recognises a blockquote token that is really a callout: its first paragraph
 * starts with an emoji or a GitHub alert marker. Returns null otherwise.
 */
export function calloutFromBlockquoteToken(token: MarkdownToken, h: MarkdownParseHelpers): JSONContent | null {
  // A token the tokenizer above made carries its marker; its blocks are whole.
  if (typeof token["emoji"] === "string" || typeof token["alert"] === "string") {
    const alertType = typeof token["alert"] === "string" ? token["alert"] : null;
    const emoji = alertType === null ? (token["emoji"] as string) : GITHUB_ALERT_EMOJI[alertType];
    if (emoji === undefined) return null;
    const content = h.parseChildren(token.tokens ?? []);
    if (!content.length) content.push({ type: "paragraph" });
    return h.createNode("callout", alertType ? { emoji, alert: alertType } : { emoji }, content);
  }
  const [first, ...rest] = token.tokens ?? [];
  if (first?.type !== "paragraph" || typeof first.text !== "string") return null;

  let emoji: string | undefined;
  let alertType: string | null = null;
  let text = first.text;
  const alert = GITHUB_ALERT.exec(text);
  const lead = alert ? null : LEADING_EMOJI.exec(text);
  if (alert) {
    alertType = alert[1]!.toUpperCase();
    emoji = GITHUB_ALERT_EMOJI[alertType];
    text = text.slice(alert[0].length);
  } else if (lead) {
    emoji = lead[1];
    text = text.slice(lead[0].length);
  }
  if (!emoji) return null;

  const content: JSONContent[] = [];
  const inline = text.trim() ? h.parseInline(h.tokenizeInline?.(text) ?? [{ type: "text", raw: text, text }]) : [];
  if (inline.length) content.push({ type: "paragraph", content: inline });
  content.push(...h.parseChildren(rest));
  if (!content.length) content.push({ type: "paragraph" });
  return h.createNode("callout", alertType ? { emoji, alert: alertType } : { emoji }, content);
}
