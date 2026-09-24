"use client";

/**
 * One note someone shared with this account (docs/notes.md §9).
 *
 * A viewer gets the note rendered read-only, in the same sandboxed frame an
 * artifact and a note of the person's own use. An editor gets a plain
 * markdown field beside a live rendering of it, autosaving a second after
 * the typing stops.
 *
 * It is NOT the shell's TipTap editor. That component reaches for the shell
 * socket and the shell store on the way to its first paint; giving this page
 * the same writing surface means either lifting the editor out of
 * `@pistachio/shell-ui` or dragging the shell in behind it, and neither is
 * this stage's work. Markdown IS the note's canonical format (N1), so a
 * field over it loses nothing but the affordances.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Eye, LoaderCircle, Pencil } from "lucide-react";
import {
  ControlError,
  Empty,
  getSharedNote,
  isolatedSharedNoteDocument,
  NOTE_UNTITLED,
  Note as Callout,
  Page,
  putSharedNote,
  type SharedNoteBody,
  useSession,
  When,
} from "@pistachio/web-account";

/** How long the typing settles before a save goes up. */
const SAVE_DEBOUNCE_MS = 1_000;

type SaveState =
  | { kind: "clean" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "conflict" }
  | { kind: "error"; message: string };

const SAVE_LABEL: Record<SaveState["kind"], string> = {
  clean: "",
  pending: "Editing…",
  saving: "Saving…",
  saved: "Saved",
  conflict: "Someone else saved a newer version — reload.",
  error: "",
};

export default function SharedNotePage(): ReactNode {
  const { ownerId, noteId } = useParams<{ ownerId: string; noteId: string }>();
  const { token } = useSession();
  const [role, setRole] = useState<"owner" | "viewer" | "editor" | null>(null);
  const [body, setBody] = useState<SharedNoteBody | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [save, setSave] = useState<SaveState>({ kind: "clean" });
  /** The revision control holds. A save is always one above it. */
  const revision = useRef(0);
  const timer = useRef<number | null>(null);
  /** What the debounce is holding and has not yet sent, or null. */
  const pending = useRef<{ title: string; markdown: string } | null>(null);

  useEffect(() => {
    if (token === null) return;
    let live = true;
    void getSharedNote(token, ownerId, noteId)
      .then((answer) => {
        if (!live) return;
        setRole(answer.role);
        setBody(answer.note);
        if (answer.note !== null) {
          setTitle(answer.note.title);
          setMarkdown(answer.note.markdown);
          revision.current = answer.note.revision;
        }
      })
      .catch((cause: unknown) => {
        if (!live) return;
        if (cause instanceof ControlError && cause.status === 404) setMissing(true);
        else setError(cause instanceof Error ? cause.message : "That note could not be read.");
      });
    return () => {
      live = false;
    };
  }, [noteId, ownerId, token]);

  const flush = useCallback(
    (nextTitle: string, nextMarkdown: string) => {
      if (token === null) return;
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      pending.current = null;
      setSave({ kind: "saving" });
      void putSharedNote(token, ownerId, noteId, {
        title: nextTitle,
        markdown: nextMarkdown,
        revision: revision.current + 1,
      })
        .then(({ note }) => {
          revision.current = note.revision;
          setSave({ kind: "saved" });
        })
        .catch((cause: unknown) => {
          // A 409 is someone else's save landing first. The page does not
          // guess a merge: it says so, and a reload starts from theirs.
          if (cause instanceof ControlError && cause.status === 409) setSave({ kind: "conflict" });
          else setSave({ kind: "error", message: cause instanceof Error ? cause.message : "Could not save." });
        });
    },
    [noteId, ownerId, token],
  );

  const edit = (nextTitle: string, nextMarkdown: string): void => {
    setTitle(nextTitle);
    setMarkdown(nextMarkdown);
    setSave({ kind: "pending" });
    pending.current = { title: nextTitle, markdown: nextMarkdown };
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flush(nextTitle, nextMarkdown), SAVE_DEBOUNCE_MS);
  };

  // The debounce must not be the only copy of what was typed. Leaving the
  // page — a link in the rail, the tab going into the background, the
  // window closing — sends whatever it was still holding, at once.
  const flushPending = useCallback(() => {
    const held = pending.current;
    if (held !== null) flush(held.title, held.markdown);
  }, [flush]);
  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState === "hidden") flushPending();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flushPending);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flushPending);
      flushPending();
    };
  }, [flushPending]);

  const shown = title.trim() === "" ? NOTE_UNTITLED : title;
  const preview = useMemo(() => isolatedSharedNoteDocument({ title, markdown }), [markdown, title]);

  if (missing) {
    return (
      <Page>
        <Link className="pa-artifact-back" href="/app/shared">
          <ArrowLeft size={14} /> Shared with me
        </Link>
        <Empty title="Not shared with you">
          <p>This note is not shared with your account any more, or never was.</p>
        </Empty>
      </Page>
    );
  }

  if (role === null) {
    return (
      <Page>
        <Link className="pa-artifact-back" href="/app/shared">
          <ArrowLeft size={14} /> Shared with me
        </Link>
        <Empty title={error === null ? "Loading" : "Could not load"}>
          <p>{error ?? "Reading the shared note."}</p>
        </Empty>
      </Page>
    );
  }

  const editable = role === "editor";

  return (
    <div className="pa-artifact-page">
      <header className="pa-artifact-toolbar">
        <div className="pa-artifact-identity">
          <Link className="pa-artifact-back" href="/app/shared">
            <ArrowLeft size={14} /> Shared with me
          </Link>
          <div>
            <h1>{shown}</h1>
            <p>
              {editable ? "You can edit this note" : "You can read this note"}
              {body === null ? null : (
                <>
                  {" · updated "}
                  <When iso={body.updatedAt} relative />
                </>
              )}
            </p>
          </div>
        </div>
        <div className="pa-artifact-actions">
          <span className="pa-artifact-privacy" data-public={editable || undefined}>
            {editable ? <Pencil size={12} /> : <Eye size={12} />}
            {editable ? "Editor" : "Viewer"}
          </span>
          {!editable || save.kind === "clean" ? null : (
            <span className="pa-shared-save" data-tone={save.kind === "conflict" || save.kind === "error" ? "alert" : undefined}>
              {save.kind === "saving" ? <LoaderCircle size={12} className="pa-spin" aria-hidden="true" /> : null}
              {save.kind === "error" ? save.message : SAVE_LABEL[save.kind]}
            </span>
          )}
        </div>
      </header>

      <div className="pa-artifact-disclosure">
        <Eye size={15} />
        <div>
          <strong>Shared with you, not encrypted</strong>
          <span>
            The owner shared this note with your account. Its text is stored on Pistachio&apos;s servers so you can read
            {editable ? " and change" : ""} it here; pictures stay on the owner&apos;s devices and are shown as
            placeholders.
          </span>
        </div>
      </div>
      {error === null ? null : <Callout tone="alert">{error}</Callout>}

      {body === null ? (
        <Empty title="Nothing here yet">
          <p>The owner&apos;s device has not sent this note&apos;s text yet. It appears as soon as it does.</p>
        </Empty>
      ) : editable ? (
        <div className="pa-shared-split">
          <div className="pa-shared-compose">
            <input
              className="pa-shared-title"
              aria-label="Title"
              value={title}
              maxLength={200}
              onChange={(event) => edit(event.target.value, markdown)}
            />
            <textarea
              className="pa-shared-markdown"
              aria-label="Note, in markdown"
              spellCheck
              value={markdown}
              onChange={(event) => edit(title, event.target.value)}
            />
          </div>
          <div className="pa-artifact-stage">
            <iframe
              title={`${shown} — preview`}
              srcDoc={preview}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
            />
          </div>
        </div>
      ) : (
        <div className="pa-artifact-stage">
          <iframe
            title={shown}
            srcDoc={preview}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
          />
        </div>
      )}
    </div>
  );
}
