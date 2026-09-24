/**
 * The way into the notes from the home page, beside the brief's line: the
 * three most recently edited, and a way to start a fourth. A host with no
 * notes (a cloud session, until stage 2) shows nothing at all.
 */

import { useEffect } from "react";
import { NotebookPen, Plus } from "lucide-react";
import { NOTE_UNTITLED } from "@pistachio/shell-contracts/notes";
import { cn } from "../../lib/cn";
import { useAppStore } from "../../store";
import { useNotes } from "../notes/use-notes";

const CHIP =
  "flex max-w-full cursor-pointer items-center gap-2 rounded-full bg-alpha-100 py-1.5 pr-3 pl-2.5 text-[13px] text-gray-900 transition-colors hover:bg-alpha-200 hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

export function HomeNotes() {
  const summaries = useNotes((state) => state.summaries);
  const unsupported = useNotes((state) => state.unsupported);
  const openNotes = useAppStore((state) => state.openNotes);
  const newNote = useAppStore((state) => state.newNote);

  useEffect(() => {
    void useNotes.getState().load();
  }, []);

  // A host that will never answer shows nothing; one that has not answered
  // yet shows nothing either, rather than a lone button that jumps when the
  // notes arrive beside it.
  if (unsupported || summaries === null) return null;
  const recent = summaries.slice(0, 3);
  return (
    <div data-testid="home-notes" className="mt-3 flex max-w-full flex-wrap items-center justify-center gap-2 @3xl:mt-4">
      {recent.map((summary) => (
        <button
          key={summary.id}
          type="button"
          data-testid="home-note"
          data-note-id={summary.id}
          onClick={() => openNotes(summary.id)}
          className={cn(CHIP, "min-w-0")}
        >
          <span aria-hidden="true" className="shrink-0 text-gray-700">
            {summary.icon ?? <NotebookPen className="size-3.5" strokeWidth={1.75} />}
          </span>
          <span className="truncate font-medium text-gray-1000">{summary.title.trim() === "" ? NOTE_UNTITLED : summary.title}</span>
        </button>
      ))}
      <button type="button" data-testid="home-new-note" onClick={() => void newNote()} className={CHIP}>
        <Plus className="size-3.5 shrink-0 text-gray-700" strokeWidth={2} aria-hidden="true" />
        New note
      </button>
    </div>
  );
}
