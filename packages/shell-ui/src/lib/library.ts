/**
 * The Library (components/library/LibraryPage.tsx): everything the person
 * keeps, in one place — the pages the agent built, their notes, the pages
 * they saved, and what Watchtower read. What the page shows of each kind and
 * how a typed filter narrows it live here, apart from React, so the rules
 * are tested without a host.
 */

import type { ArtifactListing } from "@pistachio/shell-contracts/artifacts";
import type { Bookmark } from "@pistachio/shell-contracts/bookmarks";
import { noteTitle, type NoteSummary } from "@pistachio/shell-contracts/notes";

/** "all" is the overview; each other view is one kind, whole. */
export type LibraryView = "all" | "artifacts" | "notes" | "saved" | "watchtower";

/** How many of each kind the overview shows before "Show all". */
export const LIBRARY_PREVIEW = 5;

/**
 * Whether every word typed appears somewhere in the item's fields, in any
 * order and any case: "trip lisbon" finds "Lisbon — trip plan". Nothing
 * typed matches everything.
 */
export function matchesLibraryQuery(fields: readonly string[], query: string): boolean {
  const words = query.toLowerCase().split(/\s+/u).filter((word) => word !== "");
  if (words.length === 0) return true;
  const haystack = fields.join("\n").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function filterArtifacts(artifacts: readonly ArtifactListing[], query: string): ArtifactListing[] {
  return artifacts.filter((artifact) => matchesLibraryQuery([artifact.title, artifact.brief], query));
}

export function filterNotes(notes: readonly NoteSummary[], query: string): NoteSummary[] {
  return notes.filter((note) => matchesLibraryQuery([noteTitle(note), note.snippet], query));
}

export function filterSaved(bookmarks: readonly Bookmark[], query: string): Bookmark[] {
  return bookmarks.filter((bookmark) =>
    matchesLibraryQuery([bookmark.title, bookmark.url, bookmark.siteName, bookmark.description, bookmark.note, ...bookmark.keywords], query),
  );
}

/** How many of each kind there are; null while a kind is unknown — not yet read, or not kept on this host. */
export interface LibraryCounts {
  artifacts: number | null;
  notes: number | null;
  saved: number | null;
  visits: number | null;
}

const count = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * The header's line: what is known, in the page's order — "3 artifacts ·
 * 12 notes · 40 saved · 1,203 visits". A kind not known yet is left out
 * rather than shown as zero; nothing known at all is "".
 */
export function librarySummary(counts: LibraryCounts): string {
  const parts: string[] = [];
  if (counts.artifacts !== null) parts.push(count(counts.artifacts, "artifact"));
  if (counts.notes !== null) parts.push(count(counts.notes, "note"));
  if (counts.saved !== null) parts.push(`${counts.saved.toLocaleString()} saved`);
  if (counts.visits !== null) parts.push(count(counts.visits, "visit"));
  return parts.join(" · ");
}
