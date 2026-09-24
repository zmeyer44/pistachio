"use client";

/**
 * Shared with me (docs/notes.md §9).
 *
 * Everything else in this app is read out of the encrypted workspace and
 * decrypted in the browser. These are not: a note someone shared is held by
 * control in plaintext, deliberately, for exactly as long as the share
 * stands — so this page is the one place here that reads a body from a
 * route instead of from a key, and it says so.
 */

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, Pencil, Users } from "lucide-react";
import {
  Empty,
  Intro,
  listSharedNotes,
  NOTE_UNTITLED,
  Page,
  Section,
  type SharedNoteListItem,
  useSession,
  When,
} from "@pistachio/web-account";

export default function SharedNotesPage(): ReactNode {
  const { token } = useSession();
  const [notes, setNotes] = useState<SharedNoteListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (token === null) return;
    let live = true;
    void listSharedNotes(token)
      .then(({ notes: rows }) => {
        if (live) setNotes(rows);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : "Could not read what is shared with you.");
      });
    return () => {
      live = false;
    };
  }, [token]);

  return (
    <Page>
      <Intro
        title="Shared with me"
        lede="Notes other people have shared with your account. Their text is held on Pistachio's servers so you can read it here — unlike your own notes, which only your devices can open."
      />

      {error !== null ? (
        <Empty title="Could not load">
          <p>{error}</p>
        </Empty>
      ) : notes === null ? (
        <Empty title="Loading">
          <p>Reading what has been shared with you.</p>
        </Empty>
      ) : notes.length === 0 ? (
        <Empty title="Nothing shared with you yet">
          <p>When someone shares a note with the email on this account, it appears here.</p>
        </Empty>
      ) : (
        <Section heading={`${String(notes.length)} note${notes.length === 1 ? "" : "s"}`}>
          <div className="pa-artifact-grid">
            {notes.map((note) => {
              const title = note.title === null || note.title.trim() === "" ? NOTE_UNTITLED : note.title;
              return (
                <Link
                  className="pa-artifact-card"
                  href={`/app/shared/${note.ownerId}/${note.noteId}`}
                  key={`${note.ownerId}:${note.noteId}`}
                >
                  <span className="pa-artifact-card-top">
                    <span className="pa-artifact-glyph" aria-hidden="true">
                      {title.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="pa-artifact-privacy" data-public={note.role === "editor" || undefined}>
                      {note.role === "editor" ? <Pencil size={12} /> : <Users size={12} />}
                      {note.role === "editor" ? "Can edit" : "Can view"}
                    </span>
                  </span>
                  <span className="pa-artifact-card-copy">
                    <strong>{title}</strong>
                    <span>From {note.ownerEmail}</span>
                  </span>
                  <span className="pa-artifact-card-foot">
                    <span>
                      {note.updatedAt === null ? (
                        "Not written yet"
                      ) : (
                        <>
                          Updated <When iso={note.updatedAt} relative />
                        </>
                      )}
                    </span>
                    <ArrowUpRight size={15} aria-hidden="true" />
                  </span>
                </Link>
              );
            })}
          </div>
        </Section>
      )}
    </Page>
  );
}
