/**
 * A note holds its body twice (docs/notes.md N1): the HTML the editor keeps,
 * and the markdown derived from it that the agent reads, the library searches
 * and an older device can still show. A record is whole when both are there.
 * One that arrived with only one of them — written by a version of the app
 * that knew markdown alone, or by a web editor that writes markdown — gets
 * the other derived here, deterministically, so two devices completing the
 * same record agree byte for byte.
 */

import { htmlToMarkdown, markdownToHtml } from "./markdown.js";

export interface NoteBody {
  html: string;
  markdown: string;
}

export function completeNoteBody(body: { html?: string | undefined; markdown?: string | undefined }): NoteBody {
  const html = body.html ?? "";
  const markdown = body.markdown ?? "";
  if (html.trim() === "" && markdown.trim() !== "") return { html: markdownToHtml(markdown), markdown };
  if (html.trim() !== "" && markdown.trim() === "") return { html, markdown: htmlToMarkdown(html) };
  if (html.trim() === "") return { html: "", markdown: "" };
  return { html, markdown };
}

/** The whole note, body made whole; every other field as it came. */
export function completeNote<T extends { html?: string | undefined; markdown?: string | undefined }>(note: T): T & NoteBody {
  return { ...note, ...completeNoteBody(note) };
}
