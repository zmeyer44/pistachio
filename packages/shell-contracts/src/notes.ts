/**
 * Notes, as the shell and its hosts speak about them (docs/notes.md §4).
 *
 * The types, caps and sanitizers are the agent runtime's — re-exported rather
 * than re-declared, the way `./reports.ts` re-exports the report contract —
 * so the desktop store, the editor, the cloud host and the model's tools all
 * hold one definition of what a note is. What is added here is only what the
 * shell needs: the address a note is read at, and the request union one
 * `ShellApi` member carries.
 */
export * from "@pistachio/agent-runtime/notes";

import { isNoteId, type Note, type NoteBlob, type NoteBlobMediaType, type NoteInput, type NotePatch, type NoteSummary } from "@pistachio/agent-runtime/notes";

/** The library. A note of its own is `pistachio://notes/<id>`. */
export const NOTES_PAGE_URL = "pistachio://notes/";
export const NOTES_PAGE_TITLE = "Notes";

/** A page with a folded corner and two lines of writing: the notes tab's favicon. */
export const NOTES_PAGE_FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='18' fill='%2352a862'/%3E%3Cpath d='M22 16h14l12 12v20a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4V20a4 4 0 0 1 4-4z' fill='white'/%3E%3Cpath d='M36 16v12h12' fill='none' stroke='%2352a862' stroke-width='3' stroke-linejoin='round'/%3E%3Cpath d='M26 36h14M26 43h9' stroke='%2352a862' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E";

export function isNotesUrl(value: string): boolean {
  return notesUrlId(value) !== undefined;
}

/**
 * `null` for the library, a note's id for one note, `undefined` when the
 * address is not ours at all — the `briefUrlDate` convention, so one call
 * answers both "is this mine?" and "which one?".
 */
export function notesUrlId(value: string): string | null | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "pistachio:" || url.hostname !== "notes" || url.search !== "" || url.hash !== "") return undefined;
  const path = url.pathname.replace(/^\/+|\/+$/gu, "");
  if (path === "") return null;
  return isNoteId(path) ? path : undefined;
}

export function noteUrl(id?: string | null): string {
  return id === undefined || id === null ? NOTES_PAGE_URL : `${NOTES_PAGE_URL}${id}`;
}

/* ------------------------------- the request ----------------------------- */

/**
 * Where a note is published, when it is (§8). Declared now, with the two
 * sharing requests, so the union the hosts and the socket are built from does
 * not change shape once stage 2 lands.
 */
export interface NoteHosting {
  visibility: "private" | "public";
  shareId: string;
  revision: number;
  /** The address a reader without an account opens, or null while private. */
  publicUrl: string | null;
}

/** One account the owner has named on a note (docs/notes.md §9). */
export interface NoteShare {
  id: string;
  /** The account's email — how it was named, and how it is shown. */
  email: string;
  role: "viewer" | "editor";
  createdAt: string;
}

export type NoteRequest =
  | { type: "list" }
  | { type: "search"; query: string; limit?: number }
  | { type: "get"; id: string }
  | { type: "create"; input?: NoteInput }
  | { type: "update"; id: string; patch: NotePatch }
  | { type: "delete"; id: string }
  | { type: "putBlob"; mediaType: NoteBlobMediaType; data: string }
  | { type: "getBlob"; id: string }
  | { type: "exportHtml"; id: string }
  | { type: "sharing"; id: string }
  | { type: "setVisibility"; id: string; visibility: "private" | "public" }
  /* Sharing with named accounts (§9). All three answer `{type:"shares"}`. */
  | { type: "shares"; id: string }
  | { type: "share"; id: string; email: string; role: "viewer" | "editor" }
  | { type: "unshare"; id: string; shareId: string };

export type NoteResponse =
  | { type: "list"; notes: NoteSummary[] }
  | { type: "note"; note: Note }
  | { type: "maybeNote"; note: Note | null }
  | { type: "deleted" }
  | { type: "blobId"; id: string }
  | { type: "blob"; blob: NoteBlob | null }
  | { type: "html"; html: string }
  /** `null` without an account: nothing can be published from a signed-out Mac. */
  | { type: "sharing"; hosting: NoteHosting | null }
  /**
   * Who this note is shared with (§9). `null` for the same reason a hosting
   * row is: a Mac with no account shares with nobody. `found` is false only
   * when a `share` request named an email no Pistachio account holds — the
   * one thing the route deliberately does not distinguish with a status.
   */
  | { type: "shares"; shares: NoteShare[] | null; found: boolean };
