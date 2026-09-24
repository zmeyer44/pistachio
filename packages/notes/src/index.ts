/**
 * A note as one HTML document that stands on its own (docs/notes.md §2).
 *
 * This is what gets published: `hosted_artifacts.public_html` is served under
 * `ARTIFACT_CSP` — `default-src 'none'`, `img-src data: blob:`,
 * `style-src 'unsafe-inline'` — so a page that fetched a font, a stylesheet or
 * a picture would arrive blank. Everything therefore travels inside the
 * document: the CSS inline, the note's own images inlined as `data:` URIs from
 * the blob registers the caller resolves, and nothing else at all.
 *
 * Markdown is rendered with `html: false`, which makes the closed renderer the
 * sanitizer: HTML a person typed into their note is shown as the characters
 * they typed, not run. `linkify` is off for the same reason the editor has it
 * off — a person's note is not a place where bare text quietly becomes a link.
 *
 * Pure and browser-safe: the desktop renders here before uploading, and the
 * cloud worker renders here for a note it already holds.
 */

// The plugin ships no types, and an ambient declaration reaches a program only
// when it is part of it: a package that imports this file (the desktop main
// process, the cloud worker) compiles these sources without ever including
// `packages/notes`' own tsconfig, so the declaration is referenced here rather
// than left to be picked up by proximity.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- see above
/// <reference path="./markdown-it-task-lists.d.ts" />
import MarkdownItCallable, { type MarkdownIt } from "markdown-it";
import taskLists from "markdown-it-task-lists";
import { NOTE_STYLESHEET } from "./styles.js";

/** The half of a note this module needs: no ids, no timestamps, no source. */
export interface RenderableNote {
  title: string;
  markdown: string;
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

const BLOB_SRC = /^note-blob:([a-f0-9]{24})$/;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * `++underlined++`, the way the editor's markdown writes an underline (there
 * is no CommonMark spelling for one). A small inline rule rather than a
 * plugin: the syntax is two characters, and nothing else in a note uses `+`
 * in pairs.
 */
function underline(md: MarkdownIt): void {
  md.inline.ruler.before("emphasis", "underline", (state, silent) => {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 0x2b /* + */ || state.src.charCodeAt(start + 1) !== 0x2b) return false;
    const end = state.src.indexOf("++", start + 2);
    if (end === -1 || end === start + 2) return false;
    const inner = state.src.slice(start + 2, end);
    // Like emphasis: an underline hugs its words. `2 ++ 2` is arithmetic.
    if (/^\s|\s$/u.test(inner)) return false;
    if (!silent) {
      state.push("u_open", "u", 1);
      const text = state.push("text", "", 0);
      text.content = inner;
      state.push("u_close", "u", -1);
    }
    state.pos = end + 2;
    return true;
  });
}

function markdownIt(): MarkdownIt {
  return new MarkdownItCallable({ html: false, linkify: false, typographer: false, breaks: false }).use(taskLists).use(underline);
}

/**
 * A picture the reader cannot be shown: a blob this device does not hold, or
 * an address that would have to be fetched. It is said quietly rather than
 * left as a broken image, because a published note is read by someone who
 * cannot go and look for the original.
 */
function missingImage(alt: string): string {
  const label = alt.trim() === "" ? "Image unavailable" : alt.trim();
  return `<div class="note-image-missing">${escapeHtml(label)}</div>`;
}

function renderer(options: RenderNoteOptions): MarkdownIt {
  const md = markdownIt();

  md.renderer.rules["image"] = (tokens, index) => {
    const token = tokens[index]!;
    const alt = token.content;
    const src = String(token.attrGet("src") ?? "");
    const id = BLOB_SRC.exec(src)?.[1];
    // Anything that is not one of this note's own registers — an http address,
    // a data URI a paste carried in — becomes the placeholder, so the document
    // never asks the network for a byte.
    if (id === undefined) return missingImage(alt);
    const blob = options.blob(id);
    if (blob === null) return missingImage(alt);
    return `<img src="data:${escapeHtml(blob.mediaType)};base64,${escapeHtml(blob.data)}" alt="${escapeHtml(alt)}" />`;
  };

  md.renderer.rules["link_open"] = (tokens, index, opts, _env, self) => {
    tokens[index]!.attrSet("rel", "noopener noreferrer");
    return self.renderToken(tokens, index, opts);
  };

  return md;
}

/** A note's body as HTML, without the document around it. */
export function renderNoteBody(markdown: string, options: RenderNoteOptions): string {
  return renderer(options).render(markdown);
}

/**
 * One self-contained document for the whole note: its title, its icon and its
 * body, with the stylesheet and every picture inside it.
 */
export function renderNoteHtml(note: RenderableNote, options: RenderNoteOptions): string {
  const title = note.title.trim() === "" ? UNTITLED : note.title.trim();
  const icon = note.icon === null || note.icon.trim() === "" ? "" : `<span class="note-icon">${escapeHtml(note.icon.trim())}</span>`;
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
${renderNoteBody(note.markdown, options)}
      </div>
    </main>
  </body>
</html>
`;
}

/**
 * A note's markdown as the words in it. Rendered first and then stripped, so
 * what comes back is what a reader would see rather than what was typed —
 * `**bold**` is one word, a link is its text, a picture is its alt.
 */
export function noteToPlainText(markdown: string): string {
  const html = markdownIt().render(markdown);
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gu, " ")
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/\s+/gu, " ")
    .trim();
}

/** How long the note is, in words — the library's "412 words". */
export function noteWordCount(markdown: string): number {
  const text = noteToPlainText(markdown);
  return text === "" ? 0 : text.split(" ").length;
}

export { NOTE_STYLESHEET } from "./styles.js";
