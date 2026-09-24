/**
 * `pistachio://notes…` — the library, or one note (docs/notes.md §4). Which
 * one the address says is decided once, by `notesUrlId`, in ContentArea; this
 * only picks the page.
 *
 * The whole editor (TipTap, its ProseMirror plugins, the markdown parser)
 * hangs off this module, which is why ContentArea loads it lazily: none of it
 * is needed to open a web page.
 */

import { NoteEditor } from "./NoteEditor";
import { NoteLibrary } from "./NoteLibrary";

export function NotesPage({ tabId, noteId, active }: { tabId: string | null; noteId: string | null; active: boolean }) {
  return noteId === null ? <NoteLibrary tabId={tabId} /> : <NoteEditor tabId={tabId} noteId={noteId} active={active} />;
}
