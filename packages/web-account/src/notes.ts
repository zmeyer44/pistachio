/**
 * A note as the web app renders and shares it (docs/notes.md §8).
 *
 * The document itself is built by `@pistachio/notes`, the same pure renderer
 * the Mac publishes with, so what a reader sees at `/notes/<shareId>` and
 * what the owner sees in `/app/notes/<noteId>` are the same page. What is
 * added here is the isolation the artifact viewer already has — a sandboxed
 * frame with the page's own policy written into it — under the NOTE policy
 * rather than the artifact's: a note's widgets run scripts on purpose, in
 * frames that inherit the page's policy, so the page allows inline script
 * and the web within reach, and the frame around it keeps the whole thing
 * in an opaque origin.
 */

import { NOTE_PAGE_CSP, NOTE_PAGE_META_CSP, renderNoteHtml } from "@pistachio/notes";
import type { NoteBlobRecord, NoteRecord } from "@pistachio/sync-protocol";
import type { HostedNote } from "./control";

export type NoteHostingById = ReadonlyMap<string, HostedNote>;

/** The policy a served note page carries (the `/notes/[shareId]` route). */
export const NOTE_DOCUMENT_CSP = NOTE_PAGE_CSP;

/** The `sandbox` of the frame a note is shown in on the dashboard: scripts for its widgets, never the same origin. */
export const NOTE_FRAME_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

/** The finished, self-contained document for one note. */
export function noteDocumentHtml(note: NoteRecord, blobs: ReadonlyMap<string, NoteBlobRecord>): string {
  return renderNoteHtml(note, { blob: (id) => blobs.get(id) ?? null });
}

/** Insert the policy before any authored content can execute; the frame's sandbox supplies the opaque origin. */
export function isolatedNoteHtml(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${NOTE_PAGE_META_CSP}"><meta name="referrer" content="no-referrer">`;
  return /<head(?:\s[^>]*)?>/iu.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${meta}`)
    : `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

/** That document, wrapped for an iframe whose sandbox supplies the opaque origin. */
export function isolatedNoteDocument(note: NoteRecord, blobs: ReadonlyMap<string, NoteBlobRecord>): string {
  return isolatedNoteHtml(noteDocumentHtml(note, blobs));
}

export function publicNotePath(hosting: Pick<HostedNote, "shareId">): string {
  return `/notes/${hosting.shareId}`;
}

/** What the library shows for a note whose title is still empty. */
export const NOTE_UNTITLED = "Untitled";

/** The first line or so of a note's body, for a library row. */
export function noteSnippet(markdown: string, limit = 160): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[#>*_`~-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return plain.length > limit ? `${plain.slice(0, limit - 1).trimEnd()}…` : plain;
}
