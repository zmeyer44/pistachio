/**
 * HTML block: arbitrary live HTML rendered in a sandboxed iframe (scripts
 * allowed, same-origin never). The flagship "HTML-first" block: a widget
 * inside a note.
 *
 * Storage: `<div data-type="html-block" data-html="…raw html…"></div>`.
 * Markdown: a fenced block with the info string `html live`, which imports
 * back as an HTML block (a plain ```html fence stays a code block).
 */

import { mergeAttributes, Node } from "@tiptap/core";

export { buildHtmlBlockDocument, HTML_BLOCK_HEIGHT_MESSAGE, HTML_BLOCK_SANDBOX, HTML_BLOCK_TOKENS } from "./html-document.js";

export const LIVE_HTML_FENCE_INFO = "html live";

export function isLiveHtmlFence(lang: unknown): boolean {
  return typeof lang === "string" && /^html\s+live\b/iu.test(lang.trim());
}

/** Wraps code in a backtick fence longer than any backtick run inside it. */
export function fence(info: string, code: string): string {
  const longestRun = Math.max(0, ...(code.match(/`+/gu) ?? []).map((run) => run.length));
  const ticks = "`".repeat(Math.max(3, longestRun + 1));
  return `${ticks}${info}\n${code.replace(/\n$/u, "")}\n${ticks}`;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    htmlBlock: {
      insertHtmlBlock: (html?: string) => ReturnType;
    };
  }
}

export const HtmlBlock = Node.create({
  name: "htmlBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      html: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-html") ?? el.querySelector("template")?.innerHTML ?? "",
        renderHTML: (attrs) => ({ "data-html": (attrs["html"] as string | undefined) ?? "" }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="html-block"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "html-block" }, HTMLAttributes)];
  },

  renderMarkdown(node) {
    return fence(LIVE_HTML_FENCE_INFO, (node.attrs?.["html"] as string | undefined) ?? "");
  },

  addCommands() {
    return {
      insertHtmlBlock:
        (html = "") =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { html } }),
    };
  },
});
