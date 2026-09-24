"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, Check, Copy, ExternalLink, Globe2, LockKeyhole } from "lucide-react";
import {
  Button,
  Empty,
  type HostedNote,
  isolatedNoteDocument,
  listHostedNotes,
  listNoteShares,
  NOTE_UNTITLED,
  Note as Callout,
  noteDocumentHtml,
  type NoteShareRow,
  Page,
  publicNotePath,
  putNoteRevision,
  Section,
  setNoteVisibility,
  useSession,
  When,
} from "@pistachio/web-account";

export default function NoteViewerPage(): ReactNode {
  const { noteId } = useParams<{ noteId: string }>();
  const { workspace, hubState, token } = useSession();
  const note = workspace.notes.find((candidate) => candidate.id === noteId) ?? null;
  const [hosting, setHosting] = useState<HostedNote | null>(null);
  const [shares, setShares] = useState<NoteShareRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (token === null) return;
    let live = true;
    void listHostedNotes(token).then(({ notes }) => {
      if (live) setHosting(notes.find((entry) => entry.noteId === noteId) ?? null);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [noteId, token]);

  // Who this note is shared with by name (docs/notes.md §9). Shown, not
  // managed: making and ending a share is the Mac's, because the body a
  // share reads is pushed from there.
  useEffect(() => {
    if (token === null) return;
    let live = true;
    void listNoteShares(token, noteId).then(({ shares: rows }) => {
      if (live) setShares(rows);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [noteId, token]);

  // Heal a public snapshot when this browser sees a newer encrypted revision
  // than the publishing Mac managed to upload — it may have been asleep when
  // the note was last edited. A private note never enters this path, and what
  // is uploaded is rendered here from the same pure renderer the Mac uses.
  useEffect(() => {
    if (token === null || note === null || hosting?.visibility !== "public" || hosting.revision >= note.revision) return;
    let live = true;
    void putNoteRevision(token, note.id, {
      revision: note.revision,
      html: noteDocumentHtml(note, workspace.noteBlobs),
    }).then((result) => {
      if (live && result.note !== undefined) setHosting(result.note);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [hosting, note, token, workspace.noteBlobs]);

  const document = useMemo(
    () => (note === null ? "" : isolatedNoteDocument(note, workspace.noteBlobs)),
    [note, workspace.noteBlobs],
  );
  const sharePath = hosting?.visibility === "public" ? publicNotePath(hosting) : null;

  if (note === null) {
    return (
      <Page>
        <Link className="pa-artifact-back" href="/app/notes"><ArrowLeft size={14} /> Notes</Link>
        <Empty title={hubState === "connected" ? "Note not found" : "Loading the encrypted note"}>
          <p>{hubState === "connected" ? "It may have been deleted on another device." : "This note will appear after workspace sync finishes."}</p>
        </Empty>
      </Page>
    );
  }

  const title = note.title.trim() === "" ? NOTE_UNTITLED : note.title;

  const setVisibility = async (visibility: "private" | "public"): Promise<void> => {
    if (token === null) return;
    if (visibility === "public" && !window.confirm("Publish this note? Anyone with the link can read it, pictures included, without signing in.")) return;
    setBusy(true);
    setError(null);
    try {
      const { note: next } = await setNoteVisibility(token, note.id, {
        revision: note.revision,
        visibility,
        ...(visibility === "public" ? { html: noteDocumentHtml(note, workspace.noteBlobs) } : {}),
      });
      setHosting(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update sharing.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (sharePath === null) return;
    await navigator.clipboard.writeText(new URL(sharePath, window.location.origin).href);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="pa-artifact-page">
      <header className="pa-artifact-toolbar">
        <div className="pa-artifact-identity">
          <Link className="pa-artifact-back" href="/app/notes"><ArrowLeft size={14} /> Notes</Link>
          <div>
            <h1>{title}</h1>
            <p>Revision {note.revision} · updated <When iso={note.updatedAt} relative /></p>
          </div>
        </div>
        <div className="pa-artifact-actions">
          {sharePath === null ? (
            <Button variant="primary" disabled={busy} onClick={() => { void setVisibility("public"); }}>
              <Globe2 size={14} /> Publish link
            </Button>
          ) : (
            <>
              <Button disabled={busy} onClick={() => { void copy(); }}>
                {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy link"}
              </Button>
              <a className="pa-btn" data-variant="default" href={sharePath} target="_blank" rel="noreferrer noopener">
                <ExternalLink size={14} /> Open public page
              </a>
              <Button variant="quiet" disabled={busy} onClick={() => { void setVisibility("private"); }}>
                <LockKeyhole size={14} /> Make private
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="pa-artifact-disclosure" data-public={sharePath !== null || undefined}>
        {sharePath === null ? <LockKeyhole size={15} /> : <Globe2 size={15} />}
        <div>
          <strong>{sharePath === null ? "Private and encrypted" : "Published to the web"}</strong>
          <span>{sharePath === null
            ? "Only signed-in devices that can unlock your workspace can read this note."
            : "Anyone with the link can read this plaintext snapshot, pictures included. Making it private revokes the link immediately."}</span>
        </div>
      </div>
      {error === null ? null : <Callout tone="alert">{error}</Callout>}

      {shares.length === 0 ? null : (
        <Section
          heading={`Shared with ${String(shares.length)} ${shares.length === 1 ? "person" : "people"}`}
        >
          <div className="pa-note-people">
            {shares.map((share) => (
              <div className="pa-note-person" key={share.id}>
                <span>{share.email}</span>
                <span>{share.role === "editor" ? "Can edit" : "Can view"}</span>
              </div>
            ))}
            <p className="pa-caption">
              They read this note&apos;s text on the web, so it is kept on Pistachio&apos;s servers for them. Add or
              remove people from the Share menu on your Mac.
            </p>
          </div>
        </Section>
      )}

      <div className="pa-artifact-stage">
        <iframe
          title={title}
          srcDoc={document}
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  );
}
