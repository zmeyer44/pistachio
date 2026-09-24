/**
 * `pistachio://notes` — everything the person has written (docs/notes.md §5).
 *
 * One column, one list. A note's row is its title, the first line of what it
 * says, and when it was last touched: enough to recognise a note without
 * opening it, and nothing else. The search is client-side over the summaries
 * the subscription already holds, because a keystroke must not be a round
 * trip to the host.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, FileText, Plus, Search, SquarePen, SquareSplitHorizontal, Trash2 } from "lucide-react";
import { noteUrl, searchNotes, NOTE_UNTITLED, type NoteSummary } from "@pistachio/shell-contracts/notes";
import { shortcutLabel } from "@pistachio/shell-contracts/shortcuts";
import { cn } from "../../lib/cn";
import { useAppStore } from "../../store";
import { relativeTime } from "../reminders/parts";
import { useNow } from "../home/use-now";
import { FOCUS, NOTE_COLUMN, PILL, RowMenu, type RowMenuItem } from "./parts";
import { summaryAsNote, useNotes } from "./use-notes";

export function NoteLibrary({ tabId }: { tabId: string | null }) {
  const now = useNow();
  const summaries = useNotes((state) => state.summaries);
  const unsupported = useNotes((state) => state.unsupported);
  const error = useNotes((state) => state.error);
  const openNotes = useAppStore((state) => state.openNotes);
  const newNote = useAppStore((state) => state.newNote);
  const shortcuts = useAppStore((state) => state.settings.shortcuts);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    void useNotes.getState().load();
  }, []);

  const rows = useMemo(() => {
    const all = summaries ?? [];
    if (query.trim() === "") return [...all].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const found = searchNotes(all.map(summaryAsNote), query);
    const byId = new Map(all.map((summary) => [summary.id, summary]));
    return found.flatMap((note) => {
      const summary = byId.get(note.id);
      return summary === undefined ? [] : [summary];
    });
  }, [summaries, query]);

  // A shorter list must never leave the selection pointing past its end.
  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  const open = (id: string) => openNotes(id);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = Math.min(rows.length - 1, Math.max(0, selected + step));
      setSelected(next);
      listRef.current?.querySelectorAll<HTMLElement>("[data-testid='note-row']")[next]?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "Enter") {
      const row = rows[selected];
      if (row === undefined) return;
      event.preventDefault();
      open(row.id);
    }
  };

  const newNoteHint = shortcutLabel(shortcuts.newNote, /Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : "other");

  return (
    <div
      data-testid="notes-library"
      data-tab-id={tabId ?? undefined}
      className="@container absolute inset-0 overflow-y-auto bg-background-200 text-gray-1000"
      onKeyDown={onKeyDown}
    >
      <div className={cn(NOTE_COLUMN, "pt-10 pb-16 @max-[561px]:pt-6")}>
        <header className="flex items-end justify-between gap-4">
          <h1 className="text-[34px] leading-[1.05] font-semibold tracking-[-0.04em]">Notes</h1>
          <button type="button" data-testid="notes-new" className={PILL} onClick={() => void newNote()} title={newNoteHint === null ? "New note" : `New note (${newNoteHint})`}>
            <Plus className="size-3.5" strokeWidth={2} aria-hidden="true" />
            New note
          </button>
        </header>

        <label className={cn("mt-6 flex h-9 items-center gap-2 rounded-[10px] bg-alpha-100 px-3 transition-colors focus-within:bg-alpha-200", FOCUS)}>
          <Search className="size-4 shrink-0 text-gray-700" strokeWidth={1.75} aria-hidden="true" />
          <input
            type="text"
            data-testid="notes-search"
            aria-label="Search notes"
            placeholder="Search notes"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-gray-1000 placeholder:text-gray-700 focus:outline-none"
          />
        </label>

        {unsupported ? (
          <Empty title="Notes live in the desktop app" text="What you write is kept on your computer and synced from there. Open the desktop app to read and write notes." />
        ) : error !== null ? (
          <Empty title="Your notes could not be read" text={error} />
        ) : summaries === null ? (
          <Skeleton />
        ) : rows.length === 0 ? (
          query.trim() === "" ? (
            <Empty
              title="Nothing written yet"
              text={`Start a note and it is kept as you type — on every device, with nothing to save.${newNoteHint === null ? "" : ` ${newNoteHint} makes one.`}`}
              action={{ label: "New note", run: () => void newNote() }}
            />
          ) : (
            <Empty title="No note says that" text={`Nothing in your notes matches “${query.trim()}”.`} />
          )
        ) : (
          <ul ref={listRef} className="mt-4 flex flex-col">
            {rows.map((summary, index) => (
              <Row
                key={summary.id}
                summary={summary}
                now={now}
                selected={index === selected}
                onHover={() => setSelected(index)}
                onOpen={() => open(summary.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Row({
  summary,
  now,
  selected,
  onHover,
  onOpen,
}: {
  summary: NoteSummary;
  now: Date;
  selected: boolean;
  onHover(): void;
  onOpen(): void;
}) {
  const openInSplit = useAppStore((state) => state.openNoteInSplit);
  const showNotice = useAppStore((state) => state.showNotice);
  const [confirming, setConfirming] = useState(false);
  const title = summary.title.trim() === "" ? NOTE_UNTITLED : summary.title;

  const items: RowMenuItem[] = [
    { id: "open", label: "Open", icon: <FileText />, run: onOpen },
    { id: "split", label: "Open in split", icon: <SquareSplitHorizontal />, run: () => void openInSplit(summary.id) },
    {
      id: "copy",
      label: "Copy link",
      icon: <Copy />,
      run: () => {
        void navigator.clipboard.writeText(noteUrl(summary.id));
        showNotice("Link copied", { tone: "success" });
      },
    },
    {
      id: "delete",
      label: confirming ? "Really delete?" : "Delete",
      icon: <Trash2 />,
      tone: "danger",
      // A note is the person's own writing and there is no undo for it, so
      // the row asks once before it goes.
      keepOpen: !confirming,
      run: () => {
        if (!confirming) {
          setConfirming(true);
          return;
        }
        setConfirming(false);
        void useNotes.getState().remove(summary.id);
      },
    },
  ];

  return (
    <li
      data-testid="note-row"
      data-note-id={summary.id}
      onMouseMove={onHover}
      className={cn("group flex items-center gap-3 rounded-xl px-3 transition-colors", selected ? "bg-alpha-200" : "hover:bg-alpha-100")}
    >
      <button type="button" onClick={onOpen} className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2.5 text-left", FOCUS)}>
        <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-alpha-100 text-[16px] text-gray-800">
          {summary.icon ?? <FileText className="size-4" strokeWidth={1.75} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium text-gray-1000">{title}</span>
          <span className="block truncate text-[13px] text-gray-700">{summary.snippet === "" ? "Empty note" : summary.snippet}</span>
        </span>
      </button>
      <span className="shrink-0 text-[12px] text-gray-700 tabular-nums @max-[481px]:hidden">{relativeTime(summary.updatedAt, now)}</span>
      <RowMenu label={`Actions for ${title}`} items={items} onClose={() => setConfirming(false)} />
    </li>
  );
}

function Empty({ title, text, action }: { title: string; text: string; action?: { label: string; run(): void } }) {
  return (
    <div data-testid="notes-empty" className="flex flex-col items-center gap-3 px-4 py-24 text-center @max-[561px]:py-16">
      <span aria-hidden="true" className="grid size-10 place-items-center rounded-xl bg-alpha-100 text-gray-700">
        <SquarePen className="size-5" strokeWidth={1.5} />
      </span>
      <h2 className="text-[20px] leading-[1.2] font-semibold tracking-[-0.02em] text-balance">{title}</h2>
      <p className="max-w-[420px] text-[14px] leading-[21px] text-pretty text-gray-800">{text}</p>
      {action === undefined ? null : (
        <button type="button" className={cn(PILL, "mt-1")} onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/** The list's own outline, at the row's height, so nothing moves when it arrives. */
function Skeleton() {
  return (
    <ul className="mt-4 flex flex-col gap-1" aria-busy="true">
      {[0, 1, 2, 3].map((index) => (
        <li key={index} className="flex items-center gap-3 px-3 py-2.5">
          <span className="size-8 shrink-0 animate-pulse rounded-lg bg-alpha-200" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="h-3.5 w-[40%] animate-pulse rounded bg-alpha-200" />
            <span className="h-3 w-[70%] animate-pulse rounded bg-alpha-100" />
          </span>
        </li>
      ))}
    </ul>
  );
}
