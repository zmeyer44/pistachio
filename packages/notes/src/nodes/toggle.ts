/**
 * Toggle: `@tiptap/extension-details` (details > summary + content), with the
 * open state persisted (docs/notes.md §5). Markdown uses raw `<details>` HTML,
 * which GitHub and most renderers display natively, and imports back into a
 * toggle.
 */

import type { JSONContent, MarkdownToken, MarkdownTokenizer } from "@tiptap/core";
import { Details, DetailsContent, DetailsSummary } from "@tiptap/extension-details";
import { TextSelection } from "@tiptap/pm/state";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function decodeHtml(text: string): string {
  return text
    .replace(/<[^>]+>/gu, "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function plainText(node: JSONContent | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return " ";
  return (node.content ?? []).map(plainText).join("");
}

const OPEN_TAG = /^<details(\s[^>]*)?>[ \t]*\n?/iu;
const SUMMARY = /^\s*<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>[ \t]*\n?/iu;
const TAG = /<(\/?)details\b[^>]*>/giu;

/** The spans of `src`, from `from` on, that lie inside fenced code. */
function fencedSpans(src: string, from: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let fence: string | null = null;
  let start = 0;
  let at = from;
  for (const line of src.slice(from).split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker !== undefined && (fence === null || (marker[0] === fence[0] && marker.length >= fence.length))) {
      if (fence === null) {
        fence = marker;
        start = at;
      } else {
        fence = null;
        spans.push([start, at + line.length]);
      }
    }
    at += line.length + 1;
  }
  if (fence !== null) spans.push([start, src.length]);
  return spans;
}

const detailsTokenizer: MarkdownTokenizer = {
  name: "details",
  level: "block",
  start: (src) => src.search(/^<details[\s>]/imu),
  tokenize(src, _tokens, lexer) {
    const open = OPEN_TAG.exec(src);
    if (!open) return undefined;

    let cursor = open[0].length;
    const summary = SUMMARY.exec(src.slice(cursor));
    if (summary) cursor += summary[0].length;

    // Find the matching close tag, allowing nested toggles. A tag inside
    // fenced code is the code's own text — a toggle explaining toggles — and
    // closes nothing.
    const fenced = fencedSpans(src, cursor);
    TAG.lastIndex = cursor;
    let depth = 1;
    let match: RegExpExecArray | null;
    while ((match = TAG.exec(src))) {
      const at = match.index;
      if (fenced.some(([from, to]) => at >= from && at < to)) continue;
      depth += match[1] ? -1 : 1;
      if (depth === 0) break;
    }
    if (!match || depth !== 0) return undefined;

    const inner = src.slice(cursor, match.index);
    const end = match.index + match[0].length;
    const raw = src.slice(0, end) + (/^[ \t]*\n/u.exec(src.slice(end))?.[0] ?? "");
    return {
      type: "details",
      raw,
      open: /\sopen\b/iu.test(open[1] ?? ""),
      summary: decodeHtml(summary?.[1] ?? "").trim(),
      tokens: inner.trim() ? lexer.blockTokens(`${inner.trim()}\n`) : [],
    };
  },
};

export const Toggle = Details.extend({
  markdownTokenizer: detailsTokenizer,

  parseMarkdown(token: MarkdownToken, h) {
    const children = h.parseChildren(token.tokens ?? []);
    const summary: string = typeof token["summary"] === "string" ? (token["summary"] as string) : "";
    return h.createNode("details", { open: Boolean(token["open"]) }, [
      h.createNode("detailsSummary", undefined, summary ? [h.createTextNode(summary)] : []),
      h.createNode("detailsContent", undefined, children.length ? children : [{ type: "paragraph" }]),
    ]);
  },

  addKeyboardShortcuts() {
    const inherited = this.parent?.() ?? {};
    return {
      ...inherited,
      // Enter at the end of an open toggle's title steps into its empty first
      // line (as in Notion) instead of stacking another empty line above it.
      Enter: (props) => {
        const { state, view } = this.editor;
        const { $head, empty } = state.selection;
        if (empty && $head.parent.type.name === "detailsSummary" && $head.parentOffset === $head.parent.content.size) {
          const details = $head.node(-1);
          const first = details.attrs["open"] ? details.lastChild?.firstChild : null;
          if (first?.type.name === "paragraph" && first.content.size === 0) {
            view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, $head.after() + 2)).scrollIntoView());
            return true;
          }
        }
        return inherited["Enter"]?.(props) ?? false;
      },
    };
  },

  renderMarkdown(node, h) {
    const [summary, content] = node.content ?? [];
    const body = content ? h.renderChildren(content.content ?? [], "\n\n").trim() : "";
    const open = node.attrs?.["open"] ? " open" : "";
    return [`<details${open}>`, `<summary>${escapeHtml(plainText(summary))}</summary>`, "", body, "", "</details>"].join("\n");
  },
}).configure({ persist: true });

export const ToggleSummary = DetailsSummary;
export const ToggleContent = DetailsContent;
