/**
 * A note as one HTML document that stands on its own (docs/notes.md §2).
 *
 * This is what gets published: `hosted_artifacts.public_html`, served under
 * `NOTE_PAGE_CSP` (`csp.ts`) — an opaque origin, inline styles and scripts,
 * and the web reachable for what a widget is made of. The note's own
 * pictures travel inside the document as `data:` URIs from the blob registers
 * the caller resolves; a picture by address is left as its address.
 *
 * The body is parsed through the note schema first — the closed schema is the
 * sanitizer — and then written out by hand, node by node, so this module
 * decides exactly what each kind of block becomes: a toggle is a native
 * `<details>`, a to-do a disabled box, an embed the same sandboxed frame the
 * editor shows with a link to its source under it, and a live HTML block the
 * same `allow-scripts` frame it runs in while being written, sized by the
 * height it reports (N9). The page's one script of its own is the listener
 * that sizes those frames; nothing the note held is written as a `<script>`
 * outside a frame, and no link is anything but web or mail.
 *
 * Pure and browser-safe: the desktop renders here before uploading, and the
 * cloud worker renders here for a note it already holds.
 */

import type { JSONContent } from "@tiptap/core";
import { htmlToJson } from "./dom.js";
import { markdownToHtml } from "./markdown.js";
import { EMBED_ALLOW, EMBED_SANDBOX, resolveEmbed, sanitizeEmbedSrc } from "./nodes/embed.js";
import { buildHtmlBlockDocument, HTML_BLOCK_HEIGHT_MESSAGE, HTML_BLOCK_SANDBOX } from "./nodes/html-document.js";
import { NOTE_STYLESHEET } from "./styles.js";

/** The half of a note this module needs: no ids, no timestamps, no source. */
export interface RenderableNote {
  title: string;
  /** The canonical body. When empty, `markdown` is rendered instead. */
  html?: string | undefined;
  markdown?: string | undefined;
  icon: string | null;
}

/** One image register, as `renderNoteHtml` needs to see it. */
export interface RenderableBlob {
  mediaType: string;
  /** base64 */
  data: string;
}

export interface RenderNoteOptions {
  /** The `note-blob:<id>` registers this note references, or null for one that is gone. */
  blob: (id: string) => RenderableBlob | null;
}

/** What the library shows for a note whose title is still empty. */
const UNTITLED = "Untitled";

const BLOB_SRC = /^note-blob:([a-f0-9]{24})$/u;
/** A picture by address: the web, and only the web. */
const WEB_SRC = /^https?:\/\/\S+$/iu;

/** The frame's height before a widget has reported one, and the most a report may ask for. */
const FRAME_FALLBACK_HEIGHT = 120;
const FRAME_MIN_HEIGHT = 24;
const FRAME_MAX_HEIGHT = 4000;

/**
 * The published page's one script: every widget frame posts its content
 * height (`buildHtmlBlockDocument`), and the frame it came from — matched by
 * its window, since an opaque origin has no name — is made that tall.
 */
export const NOTE_PAGE_SCRIPT = [
  "(function(){",
  'addEventListener("message",function(event){',
  "var data=event.data;",
  `if(!data||data.type!==${JSON.stringify(HTML_BLOCK_HEIGHT_MESSAGE)}||typeof data.height!=="number")return;`,
  'var frames=document.querySelectorAll("iframe.note-html-frame");',
  "for(var i=0;i<frames.length;i++){",
  "if(frames[i].contentWindow!==event.source)continue;",
  `frames[i].style.height=Math.min(${String(FRAME_MAX_HEIGHT)},Math.max(${String(FRAME_MIN_HEIGHT)},Math.ceil(data.height)))+"px";`,
  "break;",
  "}",
  "});",
  "})();",
].join("");

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** A link a reader may follow: web and mail. Anything else is just its text. */
function safeHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const href = value.trim();
  return /^(https?:\/\/|mailto:)/iu.test(href) ? href : null;
}

/**
 * A picture the reader cannot be shown: a blob this device does not hold, or
 * a `src` that is neither a register nor a web address. It is said quietly
 * rather than left as a broken image, because a published note is read by
 * someone who cannot go and look for the original.
 */
function missingImage(alt: string): string {
  const label = alt.trim() === "" ? "Image unavailable" : alt.trim();
  return `<div class="note-image-missing">${escapeHtml(label)}</div>`;
}

function attr(name: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  return ` ${name}="${escapeHtml(String(value))}"`;
}

function text(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(text).join("");
}

function wrapMarks(inner: string, marks: NonNullable<JSONContent["marks"]>): string {
  let out = inner;
  for (const mark of [...marks].reverse()) {
    switch (mark.type) {
      case "bold":
        out = `<strong>${out}</strong>`;
        break;
      case "italic":
        out = `<em>${out}</em>`;
        break;
      case "strike":
        out = `<s>${out}</s>`;
        break;
      case "underline":
        out = `<u>${out}</u>`;
        break;
      case "code":
        out = `<code>${out}</code>`;
        break;
      case "link": {
        const href = safeHref(mark.attrs?.["href"]);
        if (href !== null) out = `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${out}</a>`;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

class Renderer {
  readonly #options: RenderNoteOptions;

  constructor(options: RenderNoteOptions) {
    this.#options = options;
  }

  children(node: JSONContent): string {
    return (node.content ?? []).map((child) => this.node(child)).join("");
  }

  node(node: JSONContent): string {
    const attrs = node.attrs ?? {};
    switch (node.type) {
      case "doc":
        return this.children(node);
      case "text":
        return wrapMarks(escapeHtml(node.text ?? ""), node.marks ?? []);
      case "hardBreak":
        return "<br>";
      case "paragraph":
        return `<p>${this.children(node)}</p>`;
      case "heading": {
        const level = Math.min(Math.max(Number(attrs["level"]) || 1, 1), 3);
        return `<h${String(level)}>${this.children(node)}</h${String(level)}>`;
      }
      case "bulletList":
        return `<ul>${this.children(node)}</ul>`;
      case "orderedList": {
        const start = Number(attrs["start"]);
        return `<ol${Number.isFinite(start) && start !== 1 ? attr("start", start) : ""}>${this.children(node)}</ol>`;
      }
      case "listItem":
        return `<li>${this.children(node)}</li>`;
      case "taskList":
        return `<ul class="note-task-list">${this.children(node)}</ul>`;
      case "taskItem": {
        const checked = attrs["checked"] === true;
        // A reader cannot tick a published note.
        return `<li class="note-task" data-checked="${checked ? "true" : "false"}"><input type="checkbox" disabled${checked ? " checked" : ""}><div>${this.children(node)}</div></li>`;
      }
      case "blockquote":
        return `<blockquote>${this.children(node)}</blockquote>`;
      case "codeBlock": {
        const language = typeof attrs["language"] === "string" && attrs["language"] !== "" ? attrs["language"] : null;
        return `<pre><code${language === null ? "" : attr("class", `language-${language}`)}>${escapeHtml(text(node))}</code></pre>`;
      }
      case "horizontalRule":
        return "<hr>";
      case "image": {
        const alt = typeof attrs["alt"] === "string" ? attrs["alt"] : "";
        const src = typeof attrs["src"] === "string" ? attrs["src"].trim() : "";
        const id = BLOB_SRC.exec(src)?.[1];
        if (id !== undefined) {
          const blob = this.#options.blob(id);
          if (blob === null) return missingImage(alt);
          return `<img src="data:${escapeHtml(blob.mediaType)};base64,${escapeHtml(blob.data)}"${attr("alt", alt)}>`;
        }
        // A picture by address is shown from its address, without telling the
        // host where it was seen. Anything else — a data URI a paste carried
        // in, a file path — is the placeholder.
        if (WEB_SRC.test(src)) return `<img src="${escapeHtml(src)}"${attr("alt", alt)} loading="lazy" referrerpolicy="no-referrer">`;
        return missingImage(alt);
      }
      case "table":
        return `<table><tbody>${this.children(node)}</tbody></table>`;
      case "tableRow":
        return `<tr>${this.children(node)}</tr>`;
      case "tableCell":
      case "tableHeader": {
        const tag = node.type === "tableHeader" ? "th" : "td";
        const span = (name: string) => {
          const value = Number(attrs[name]);
          return Number.isFinite(value) && value > 1 ? attr(name, value) : "";
        };
        // A GFM column's alignment, kept on each cell by the import.
        const align = attrs["align"];
        const aligned = align === "center" || align === "right" || align === "left" ? ` style="text-align: ${align}"` : "";
        return `<${tag}${span("colspan")}${span("rowspan")}${aligned}>${this.children(node)}</${tag}>`;
      }
      case "callout": {
        const emoji = typeof attrs["emoji"] === "string" && attrs["emoji"] !== "" ? attrs["emoji"] : "💡";
        return `<div class="note-callout"${attr("data-emoji", emoji)}><span class="note-callout-emoji">${escapeHtml(emoji)}</span><div class="note-callout-body">${this.children(node)}</div></div>`;
      }
      case "details":
        return `<details${attrs["open"] === true ? " open" : ""}>${this.children(node)}</details>`;
      case "detailsSummary":
        return `<summary>${this.children(node)}</summary>`;
      case "detailsContent":
        return `<div class="note-toggle-body">${this.children(node)}</div>`;
      case "embed": {
        // The same frame the editor shows, and under it the source as a link:
        // a player that will not play inside a sandbox is still a click away.
        const src = sanitizeEmbedSrc(typeof attrs["src"] === "string" ? attrs["src"] : null);
        const target = resolveEmbed(src);
        if (src === null || target === null) return "";
        const shown = src.replace(/^https:\/\/(www\.)?/u, "");
        return (
          `<div class="note-embed"${attr("data-provider", target.provider)}>` +
          `<div class="note-embed-frame"><iframe src="${escapeHtml(target.embedUrl)}" title="${escapeHtml(target.provider)} embed" sandbox="${EMBED_SANDBOX}" allow="${EMBED_ALLOW}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>` +
          `<a class="note-embed-caption" href="${escapeHtml(src)}" rel="noopener noreferrer"><span class="note-embed-provider">${escapeHtml(target.provider)}</span><span class="note-embed-url">${escapeHtml(shown)}</span></a>` +
          "</div>"
        );
      }
      case "htmlBlock": {
        // The widget runs on the page as it runs in the editor: its own
        // document, in a frame with an opaque origin, sized by the height it
        // reports to `NOTE_PAGE_SCRIPT`. An empty block is nothing.
        const html = typeof attrs["html"] === "string" ? attrs["html"] : "";
        if (html.trim() === "") return "";
        const document = buildHtmlBlockDocument(html);
        return `<div class="note-html-block"><iframe class="note-html-frame" title="Interactive block" sandbox="${HTML_BLOCK_SANDBOX}" srcdoc="${escapeHtml(document)}" style="height: ${String(FRAME_FALLBACK_HEIGHT)}px" loading="lazy"></iframe></div>`;
      }
      default:
        // A node the schema admitted but this renderer does not know: its words, at least.
        return this.children(node);
    }
  }
}

/** A note's body as HTML, without the document around it. */
export function renderNoteBody(html: string, options: RenderNoteOptions): string {
  if (html.trim() === "") return "";
  return new Renderer(options).node(htmlToJson(html));
}

/**
 * One self-contained document for the whole note: its title, its icon and its
 * body, with the stylesheet, every one of its own pictures, and the one
 * script that sizes its widgets inside it.
 */
export function renderNoteHtml(note: RenderableNote, options: RenderNoteOptions): string {
  const title = note.title.trim() === "" ? UNTITLED : note.title.trim();
  const icon = note.icon === null || note.icon.trim() === "" ? "" : `<span class="note-icon">${escapeHtml(note.icon.trim())}</span>`;
  const html = (note.html ?? "").trim() !== "" ? (note.html ?? "") : markdownToHtml(note.markdown ?? "");
  const body = renderNoteBody(html, options);
  const script = body.includes('class="note-html-frame"') ? `    <script>${NOTE_PAGE_SCRIPT}</script>\n` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>${escapeHtml(title)}</title>
    <style>
${NOTE_STYLESHEET}
    </style>
  </head>
  <body>
    <main>
      <h1 class="note-title">${icon}${escapeHtml(title)}</h1>
      <div class="note-body">
${body}
      </div>
    </main>
${script}  </body>
</html>
`;
}
