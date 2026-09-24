/**
 * A note as the web app renders and shares it (docs/notes.md §8).
 *
 * The document itself is built by `@pistachio/notes`, the same pure renderer
 * the Mac publishes with, so what a reader sees at `/notes/<shareId>` and
 * what the owner sees in `/app/notes/<noteId>` are the same page. The only
 * thing added here is the isolation wrapper the artifact viewer already uses:
 * a rendered note is still a document assembled from text a person (or the
 * agent) wrote, and it runs in the same sandboxed frame with the same policy.
 */

import { renderNoteHtml } from "@pistachio/notes";
import type { NoteBlobRecord, NoteRecord } from "@pistachio/sync-protocol";
import { isolatedArtifactDocument } from "./artifacts";
import type { HostedNote } from "./control";

export type NoteHostingById = ReadonlyMap<string, HostedNote>;

/** The finished, self-contained document for one note. */
export function noteDocumentHtml(note: NoteRecord, blobs: ReadonlyMap<string, NoteBlobRecord>): string {
  return renderNoteHtml(note, { blob: (id) => blobs.get(id) ?? null });
}

/** That document, wrapped for an iframe whose sandbox supplies the opaque origin. */
export function isolatedNoteDocument(note: NoteRecord, blobs: ReadonlyMap<string, NoteBlobRecord>): string {
  return isolatedArtifactDocument({ html: noteDocumentHtml(note, blobs) });
}

/**
 * A note someone shared with this account (docs/notes.md §9), as a document.
 *
 * Its text arrives from control in plaintext — that is what a share IS — but
 * its pictures do not: `note-blob:` registers stay in the owner's sealed
 * workspace, so the renderer draws its own "unavailable" placeholder for
 * each one rather than reaching for the network. Same wrapper, same sandbox,
 * same policy as a note of the person's own.
 */
export function isolatedSharedNoteDocument(note: { title: string; markdown: string }): string {
  return isolatedArtifactDocument({
    html: renderNoteHtml({ title: note.title, markdown: note.markdown, icon: null }, { blob: () => null }),
  });
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
