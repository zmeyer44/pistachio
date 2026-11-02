"use client";

/**
 * One note someone shared with this account (docs/notes.md §9), in the same
 * editor the desktop writes with (`@pistachio/note-editor`): a viewer reads
 * the document live — toggles open, widgets run, embeds play — and an editor
 * writes it the way the owner does, every block and key the same, autosaving
 * a second after the typing stops.
 *
 * What control holds for a share is the body in both its forms (N1): the
 * HTML this page edits, and the markdown derived from it here before each
 * save, so an older device of the owner's still reads what was written. The
 * owner's own pictures are not here — a share carries text, not the sealed
 * registers — and the editor says so in each picture's place; a picture by
 * web address shows from where it is.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowLeft, Eye, LoaderCircle, Pencil } from "lucide-react";
import { htmlToMarkdown, markdownToHtml } from "@pistachio/notes";
import { NoteBlockEditor, NoteTitle, type NoteBlockEditorHandle, type NoteEditorHost } from "@pistachio/note-editor";
import { MAX_NOTE_TITLE, sanitizeNoteMarkdown } from "@pistachio/shell-contracts/notes";
import {
  ControlError,
  Empty,
  getSharedNote,
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

/** The body as the editor takes it: a share from before HTML was canonical carries markdown alone. */
function bodyHtml(body: SharedNoteBody): string {
  return body.html.trim() === "" ? markdownToHtml(body.markdown) : body.html;
}

const subscribeNever = () => () => {};

/** A link in a shared note opens in a tab of its own. */
const HOST: NoteEditorHost = {
  openLink: (href) => {
    window.open(href, "_blank", "noopener,noreferrer");
  },
};

export default function SharedNotePage(): ReactNode {
  const { ownerId, noteId } = useParams<{ ownerId: string; noteId: string }>();
  const { token } = useSession();
  // The editor is browser-only: nothing of it renders on the server or during hydration.
  const isClient = useSyncExternalStore(subscribeNever, () => true, () => false);
  const [role, setRole] = useState<"owner" | "viewer" | "editor" | null>(null);
  const [body, setBody] = useState<SharedNoteBody | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [save, setSave] = useState<SaveState>({ kind: "clean" });
  const editor = useRef<NoteBlockEditorHandle>(null);
  /** The revision control holds. A save is always one above it. */
  const revision = useRef(0);
  const timer = useRef<number | null>(null);
  /** What the page has in hand, and what the debounce is holding and has not yet sent. */
  const draft = useRef<{ title: string; html: string }>({ title: "", html: "" });
  const pending = useRef<{ title: string; html: string } | null>(null);

  // The session re-mints its token on its own, which runs this again. The
  // first answer is the document; a later one is adopted only while nothing
  // of ours is waiting to go up — the mounted editor is told through its
  // handle, since it reads its `html` once — and is otherwise left to the
  // save: a 409 is what says someone else got there first.
  useEffect(() => {
    if (token === null) return;
    let live = true;
    void getSharedNote(token, ownerId, noteId)
      .then((answer) => {
        if (!live) return;
        setRole(answer.role);
        const note = answer.note;
        if (note === null) {
          setBody(null);
          return;
        }
        const first = revision.current === 0;
        const theirs = note.revision > revision.current;
        if (!first && (pending.current !== null || !theirs)) return;
        setBody((held) => held ?? note);
        setTitle(note.title);
        draft.current = { title: note.title, html: bodyHtml(note) };
        revision.current = note.revision;
        if (!first) editor.current?.show(draft.current.html);
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
    (next: { title: string; html: string }) => {
      if (token === null) return;
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      pending.current = null;
      setSave({ kind: "saving" });
      void putSharedNote(token, ownerId, noteId, {
        title: next.title,
        html: next.html,
        // Derived, so clamped to its cap as every host clamps it (N1); the HTML is whole.
        markdown: sanitizeNoteMarkdown(htmlToMarkdown(next.html)),
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

  const edit = useCallback(
    (change: { title?: string; html?: string }) => {
      draft.current = { ...draft.current, ...change };
      const next = draft.current;
      setSave({ kind: "pending" });
      pending.current = next;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => flush(next), SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // The debounce must not be the only copy of what was typed. Leaving the
  // page — a link in the rail, the tab going into the background, the
  // window closing — sends whatever it was still holding, at once.
  const flushPending = useCallback(() => {
    const held = pending.current;
    if (held !== null) flush(held);
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
  const initialHtml = useMemo(() => (body === null ? "" : bodyHtml(body)), [body]);

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
            <span
              className="pa-shared-save"
              data-testid="shared-note-save-state"
              data-state={save.kind}
              data-tone={save.kind === "conflict" || save.kind === "error" ? "alert" : undefined}
            >
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
            {editable ? " and change" : ""} it here; the owner&apos;s own pictures stay on their devices, and a picture by
            web address shows from where it is.
          </span>
        </div>
      </div>
      {error === null ? null : <Callout tone="alert">{error}</Callout>}

      {body === null ? (
        <Empty title="Nothing here yet">
          <p>The owner&apos;s device has not sent this note&apos;s text yet. It appears as soon as it does.</p>
        </Empty>
      ) : (
        <div className="pa-note-document" data-testid="shared-note-document" data-editable={editable || undefined}>
          <div className="pa-note-measure">
            <NoteTitle
              value={title}
              maxLength={MAX_NOTE_TITLE}
              readOnly={!editable}
              autoFocus={false}
              onChange={(next) => {
                setTitle(next);
                edit({ title: next });
              }}
              onEnterBody={() => editor.current?.focus("start")}
            />
            {isClient ? (
              <NoteBlockEditor
                ref={editor}
                html={initialHtml}
                editable={editable}
                host={HOST}
                contentClassName="mt-4 -ml-14 -mr-10 min-h-[50vh]"
                onUpdate={(html) => edit({ html })}
                onBlur={flushPending}
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
