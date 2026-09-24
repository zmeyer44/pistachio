"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowUpRight, LockKeyhole, Search, Share2 } from "lucide-react";
import {
  Empty,
  type HostedNote,
  Intro,
  listHostedNotes,
  NOTE_UNTITLED,
  noteSnippet,
  Page,
  Section,
  useSession,
  When,
} from "@pistachio/web-account";

export default function NotesPage(): ReactNode {
  const { workspace, hubState, token } = useSession();
  const [query, setQuery] = useState("");
  const [hosting, setHosting] = useState<Map<string, HostedNote>>(new Map());

  useEffect(() => {
    if (token === null) return;
    let live = true;
    void listHostedNotes(token).then(({ notes }) => {
      if (live) setHosting(new Map(notes.map((note) => [note.noteId, note])));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [token]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === ""
      ? workspace.notes
      : workspace.notes.filter((note) => `${note.title} ${note.markdown}`.toLowerCase().includes(needle));
  }, [query, workspace.notes]);

  return (
    <Page>
      <Intro
        title="Notes"
        lede="What you have written in Pistachio. Every note is end-to-end encrypted and readable here only on a browser that can unlock your account — until you deliberately publish one."
      />

      {workspace.notes.length === 0 ? (
        <Empty title={hubState === "connected" ? "No notes yet" : "Waiting for your devices"}>
          <p>Write one on your Mac with ⌘⌥N, or ask the agent to write something down for you.</p>
        </Empty>
      ) : (
        <Section
          heading={`${String(workspace.notes.length)} note${workspace.notes.length === 1 ? "" : "s"}`}
          action={
            <label className="pa-artifact-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                placeholder="Filter notes"
                aria-label="Filter notes"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          }
        >
          {shown.length === 0 ? <p className="pa-caption">Nothing matches “{query}”.</p> : (
            <div className="pa-artifact-grid">
              {shown.map((note) => {
                const published = hosting.get(note.id)?.visibility === "public";
                const title = note.title.trim() === "" ? NOTE_UNTITLED : note.title;
                return (
                  <Link className="pa-artifact-card" href={`/app/notes/${note.id}`} key={note.id}>
                    <span className="pa-artifact-card-top">
                      <span className="pa-artifact-glyph" aria-hidden="true">{note.icon ?? title.slice(0, 1).toUpperCase()}</span>
                      <span className="pa-artifact-privacy" data-public={published || undefined}>
                        {published ? <Share2 size={12} /> : <LockKeyhole size={12} />}
                        {published ? "Public" : "Private"}
                      </span>
                    </span>
                    <span className="pa-artifact-card-copy">
                      <strong>{title}</strong>
                      <span>{noteSnippet(note.markdown) || "Empty note"}</span>
                    </span>
                    <span className="pa-artifact-card-foot">
                      <span>Updated <When iso={note.updatedAt} relative /></span>
                      <ArrowUpRight size={15} aria-hidden="true" />
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </Section>
      )}
    </Page>
  );
}
