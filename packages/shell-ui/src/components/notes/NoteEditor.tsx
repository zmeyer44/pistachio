/**
 * One note (docs/notes.md §5). A blank page with a title and a body: no
 * toolbar of heading buttons, no save. The person types, `#`, `-`, `[]`, `>`,
 * ` ``` ` and `/` do what they do in Notion, every block has a handle that
 * drags it and a menu that turns it into another, and `lib/notes-autosave.ts`
 * decides when what they wrote goes to the host.
 *
 * What is drawn here is the chrome around the document: a 52px bar, the
 * title, and the shell's answers to what the editor asks for — where a link
 * opens, where a note's own pictures are, how a dropped file becomes one,
 * where a widget's document is served. The document itself is
 * `@pistachio/note-editor` (`NoteBlockEditor`), the same surface the web
 * shell and the account site mount; the arithmetic of saving and of
 * accepting a picture is in `src/lib`, tested without a DOM. The body the
 * host keeps is the editor's own HTML (N1); the host derives the markdown.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Copy, LoaderCircle, LogIn, Share2, Trash2, Volume2 } from "lucide-react";
import { htmlToMarkdown, jsonToMarkdown } from "@pistachio/notes";
import { NoteBlockEditor, NoteTitle, type NoteBlockEditorHandle, type NoteEditorHost } from "@pistachio/note-editor";
import {
  MAX_NOTE_BLOBS_PER_NOTE,
  MAX_NOTE_TITLE,
  NOTE_UNTITLED,
  noteBlobIdsIn,
  noteFrameUrl,
  NOTES_PAGE_URL,
  type Note,
  type NoteBlobMediaType,
} from "@pistachio/shell-contracts/notes";
import { shellApi } from "../../api";
import { cn } from "../../lib/cn";
import {
  autosave,
  createAutosave,
  nextAction,
  noteStamp,
  SAVE_STATE_LABEL,
  saveState,
  type AutosaveState,
} from "../../lib/notes-autosave";
import { acceptNoteImage, encodeTarget, imageBlobId, mayHaveAlpha, planDownscale, withinBlobCap } from "../../lib/notes-images";
import { noteSpeechText } from "../../lib/notes-speech";
import { useAppStore } from "../../store";
import { usePagePreview } from "../page-preview";
import { ShareMenu } from "./ShareMenu";
import { FOCUS, LINK, NOTE_BAR_HEIGHT, NOTE_COLUMN, RowMenu, useTransient, type RowMenuItem } from "./parts";
import { useNotes } from "./use-notes";

/** How long a title sits still before the tab is told about it. */
const TAB_TITLE_MS = 300;
/** How long "Edited on another device" stays up. */
const REMOTE_NOTICE_MS = 4_000;

/**
 * Decode a picture the way the page would draw it — an `<img>` over an
 * object URL — rather than `createImageBitmap`, which refuses a `File`
 * handed to a file input by automation and has no better answer for a
 * format the renderer can show but not decode off-thread. The caller
 * revokes the URL once the pixels are on a canvas.
 */
function decodeImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("the picture could not be decoded"));
    };
    image.src = url;
  });
}

/**
 * Whether this shell is the desktop's. Only there is a page's own policy too
 * strict for a widget's `srcdoc` frame (docs/notes.md §5), and only there
 * does main answer `pistachio-app://note-frame/` with the document served
 * under a policy of its own.
 */
const onDesktop = typeof window !== "undefined" && "pistachio" in window;

export function NoteEditor({ tabId, noteId, active }: { tabId: string | null; noteId: string; active: boolean }) {
  const note = useNotes((state) => state.notes[noteId]);
  const unsupported = useNotes((state) => state.unsupported);
  const error = useNotes((state) => state.error);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setMissing(false);
    void useNotes.getState().load();
    void useNotes
      .getState()
      .open(noteId)
      .then((found) => {
        if (found === null) setMissing(true);
      });
  }, [noteId]);

  if (unsupported) return <Message title="Notes live in the desktop app" text="What you write is kept on your computer and synced from there. Open the desktop app to read and write notes." />;
  if (missing) return <Message title="That note is gone" text="It was deleted, or it has not reached this device yet." />;
  if (note === undefined) {
    return error === null ? <Loading /> : <Message title="That note could not be opened" text={error} />;
  }
  // Keyed by id, so opening a different note builds a different editor
  // rather than reusing this one's document.
  return <NoteBody key={noteId} tabId={tabId} note={note} active={active} />;
}

function NoteBody({ tabId, note, active }: { tabId: string | null; note: Note; active: boolean }) {
  // Drawn as a preview of itself (a desk hover card): read only, and nothing it does is written.
  const preview = usePagePreview();
  const navigate = useAppStore((state) => state.navigate);
  const createTab = useAppStore((state) => state.createTab);
  const openLink = useAppStore((state) => state.openLink);
  const showNotice = useAppStore((state) => state.showNotice);
  const readAloudText = useAppStore((state) => state.readAloudText);
  const openSettings = useAppStore((state) => state.openSettings);
  const enrolled = useAppStore((state) => state.account.state === "enrolled");
  const [remoteNotice, sayRemote] = useTransient(REMOTE_NOTICE_MS);
  const [refusal, sayRefusal] = useTransient(REMOTE_NOTICE_MS);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /** The Share panel, and the corner of the bar it hangs off (docs/notes.md §8). */
  const [sharing, setSharing] = useState(false);
  const [shareAnchor, setShareAnchor] = useState<HTMLElement | null>(null);

  // The state machine lives in a ref: it is stepped from ProseMirror
  // callbacks and from timers, neither of which should re-render the page.
  const save = useRef<AutosaveState>(createAutosave({ revision: note.revision, stamp: noteStamp(note), title: note.title, html: note.html }));
  const [badge, setBadge] = useState(() => saveState(save.current));
  const timer = useRef<number | null>(null);
  const titleTimer = useRef<number | null>(null);
  const [title, setTitle] = useState(note.title);
  const editor = useRef<NoteBlockEditorHandle>(null);

  /* ── saving ───────────────────────────────────────────────────────── */

  /** Step the machine, then do whatever it asks for. */
  const step = useCallback(
    (next: AutosaveState) => {
      save.current = next;
      setBadge(saveState(next));
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      const action = nextAction(next, Date.now());
      if (action.type === "wait") {
        timer.current = window.setTimeout(() => step(save.current), action.ms);
        return;
      }
      if (action.type === "flush") {
        const patch = action.patch;
        save.current = autosave(save.current, { type: "sending", at: Date.now() });
        setBadge(saveState(save.current));
        void useNotes
          .getState()
          .save(note.id, patch)
          .then((saved) => {
            if (saved === null) {
              step(autosave(save.current, { type: "failed", at: Date.now() }));
              return;
            }
            const before = save.current;
            const after = autosave(before, {
              type: "saved",
              note: { revision: saved.revision, stamp: noteStamp(saved), title: saved.title, html: saved.html },
              at: Date.now(),
            });
            // A field we did not send came back changed — the host merged a
            // version from elsewhere under our title-only save — and the
            // machine adopted it. The page has to show what it adopted.
            if (after.local.html !== before.local.html) editor.current?.show(after.local.html);
            if (after.local.title !== before.local.title) setTitle(after.local.title);
            step(after);
          });
        return;
      }
      if (action.type === "fetch") {
        void useNotes
          .getState()
          .open(note.id)
          .then((fresh) => {
            if (fresh === null) return;
            // The person started typing again while it was in the air. Their
            // letters are the newer write (N5), so the remote revision goes
            // back to waiting rather than over the top of them.
            if (save.current.dirty || save.current.inflight !== null) {
              step(autosave(save.current, { type: "remote", stamp: noteStamp(fresh), at: Date.now() }));
              return;
            }
            if (fresh.html !== save.current.local.html) editor.current?.show(fresh.html);
            setTitle(fresh.title);
            sayRemote("Edited on another device");
            step(
              autosave(save.current, {
                type: "adopt",
                note: { revision: fresh.revision, stamp: noteStamp(fresh), title: fresh.title, html: fresh.html },
              }),
            );
          });
      }
    },
    // `note.id` is the only identity here; the callbacks it closes over are refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [note.id],
  );

  const edit = useCallback(
    (draft: { title?: string; html?: string }) => {
      // Every write starts here: a preview's machine never has one to send.
      if (preview) return;
      step(autosave(save.current, { type: "edit", draft, at: Date.now() }));
    },
    [step, preview],
  );

  const flushNow = useCallback(() => {
    step(autosave(save.current, { type: "flushNow", at: Date.now() }));
  }, [step]);

  // Every keystroke in the body, as HTML. Serialising per keystroke is what
  // makes "only the changed fields" possible at all, and a note is kilobytes
  // (N4) — the 600ms debounce is what limits the host traffic.
  const onUpdate = useCallback((html: string) => edit({ html }), [edit]);

  // Another device's revision, off the subscription. The machine decides
  // whether it is adopted now or after our own write (N5).
  useEffect(() => {
    return useNotes.subscribe((state, previous) => {
      if (state.summaries === previous.summaries) return;
      const summary = state.summaries?.find((candidate) => candidate.id === note.id);
      if (summary === undefined) return;
      step(autosave(save.current, { type: "remote", stamp: noteStamp(summary), at: Date.now() }));
    });
  }, [note.id, step]);

  // The last chances to write: the pane going quiet, the window hiding, the
  // page unmounting, the app closing.
  useEffect(() => {
    if (!active) flushNow();
  }, [active, flushNow]);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") flushNow();
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("beforeunload", flushNow);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("beforeunload", flushNow);
      flushNow();
      if (timer.current !== null) window.clearTimeout(timer.current);
      if (titleTimer.current !== null) window.clearTimeout(titleTimer.current);
    };
  }, [flushNow]);

  /* ── the tab's own title ──────────────────────────────────────────── */

  // Main sets a shell page's title from a static placeholder, so the page
  // says what it is called (docs/notes.md §4). Debounced: a title is typed a
  // letter at a time and every letter would otherwise republish the snapshot.
  useEffect(() => {
    if (tabId === null || preview) return;
    if (titleTimer.current !== null) window.clearTimeout(titleTimer.current);
    titleTimer.current = window.setTimeout(() => {
      void shellApi()
        .setTabTitle(tabId, title.trim() === "" ? NOTE_UNTITLED : title)
        .catch((cause: unknown) => useAppStore.getState().noteRefusal("setTabTitle", cause));
    }, TAB_TITLE_MS);
  }, [tabId, title, preview]);

  /* ── pictures ─────────────────────────────────────────────────────── */

  /**
   * Decode, downscale, re-encode, hash, keep (N4): one file into one
   * register, answering the `note-blob:` address the editor inserts, or null
   * with the refusal said in the bar. The canvas half lives here because it
   * needs a document; every decision it makes is `lib/notes-images.ts`.
   */
  const takeImage = useCallback(
    async (file: File): Promise<string | null> => {
      if (noteBlobIdsIn(save.current.local.html).length >= MAX_NOTE_BLOBS_PER_NOTE) {
        sayRefusal(`A note holds ${String(MAX_NOTE_BLOBS_PER_NOTE)} pictures`);
        return null;
      }
      const accepted = acceptNoteImage(file);
      if (!accepted.ok) {
        sayRefusal(accepted.reason);
        return null;
      }
      try {
        const picture = await decodeImage(file);
        const box = planDownscale(picture.naturalWidth, picture.naturalHeight);
        const target = encodeTarget(accepted.mediaType, mayHaveAlpha(accepted.mediaType));
        const canvas = document.createElement("canvas");
        canvas.width = box.width;
        canvas.height = box.height;
        const context = canvas.getContext("2d");
        if (context === null) throw new Error("no 2d context");
        // A JPEG has no transparency to keep; anything under it would show
        // through as black without this.
        if (target.mediaType === "image/jpeg") {
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, box.width, box.height);
        }
        context.drawImage(picture, 0, 0, box.width, box.height);
        URL.revokeObjectURL(picture.src);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, target.mediaType, target.quality));
        if (blob === null) throw new Error("could not encode");
        if (!withinBlobCap(blob.size)) {
          sayRefusal(`${file.name} is still too large after shrinking`);
          return null;
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const expected = await imageBlobId(bytes);
        const id = await useNotes.getState().putImage(bytes, target.mediaType as NoteBlobMediaType);
        if (id === null) {
          sayRefusal("That picture could not be kept");
          return null;
        }
        if (id !== expected) {
          // The host content-addresses the same way (N3); a mismatch means
          // the bytes changed on the way, which is worth saying out loud.
          sayRefusal("That picture did not arrive intact");
          return null;
        }
        return `note-blob:${id}`;
      } catch (error) {
        // The person sees one line; the cause goes where a bug report can find it.
        console.warn(`[notes] could not take ${file.name}`, error);
        sayRefusal(`${file.name} could not be read`);
        return null;
      }
    },
    [sayRefusal],
  );

  /* ── what the editor asks the shell for ───────────────────────────── */

  const host = useMemo<NoteEditorHost>(
    () => ({
      // A link opens the way the console's links open (store.openLink).
      openLink: (href, box) => {
        void openLink(href, { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) }, false);
      },
      // A picture the store already holds is answered at once, so nothing flickers.
      blobUrl: (id) => useNotes.getState().blobUrls[id] ?? useNotes.getState().blobUrl(id),
      // One missing here may be resolved elsewhere — another pane, a later
      // upload — and the store's cache is where that shows.
      subscribeBlobs: (listener) =>
        useNotes.subscribe((state, previous) => {
          if (state.blobUrls !== previous.blobUrls) listener();
        }),
      uploadImage: takeImage,
      ...(onDesktop ? { frameSrc: noteFrameUrl } : {}),
    }),
    [openLink, takeImage],
  );

  /* ── the page ─────────────────────────────────────────────────────── */

  const shown = title.trim() === "" ? NOTE_UNTITLED : title;
  const goLibrary = () => {
    if (tabId === null) void createTab(NOTES_PAGE_URL);
    else void navigate(tabId, NOTES_PAGE_URL);
  };

  /** The body as markdown: from the document in hand, or from what the host holds. */
  const markdownNow = () => {
    const current = editor.current?.editor ?? null;
    return (current === null ? htmlToMarkdown(save.current.local.html) : jsonToMarkdown(current.getJSON())).trimEnd();
  };

  const menu: RowMenuItem[] = [
    // Sharing is an account feature end to end (docs/notes.md §8). Signed
    // out, the row says so itself and goes to the sign-in, rather than
    // opening a panel whose only line is that it cannot help.
    enrolled
      ? { id: "share", label: "Share", icon: <Share2 />, run: () => setSharing(true) }
      : { id: "share", label: "Sign in to share", icon: <LogIn />, run: () => openSettings("account") },
    {
      id: "copy-markdown",
      label: "Copy as markdown",
      icon: <Copy />,
      run: () => {
        const body = markdownNow();
        void navigator.clipboard.writeText(title.trim() === "" ? body : `# ${title}\n\n${body}`);
        showNotice("Note copied as markdown", { tone: "success" });
      },
    },
    // The whole note, title first, in the same player and media card as a page's read aloud.
    {
      id: "read-aloud",
      label: "Read aloud",
      icon: <Volume2 />,
      run: () => {
        const current = editor.current;
        if (current === null) return;
        const text = noteSpeechText(title, current.getJSON());
        if (text === "") {
          showNotice("Nothing in this note to read aloud");
          return;
        }
        void readAloudText(text, shown);
      },
    },
    {
      id: "delete",
      label: confirmingDelete ? "Really delete?" : "Delete",
      icon: <Trash2 />,
      tone: "danger",
      keepOpen: !confirmingDelete,
      run: () => {
        if (!confirmingDelete) {
          setConfirmingDelete(true);
          return;
        }
        setConfirmingDelete(false);
        void useNotes
          .getState()
          .remove(note.id)
          .then((gone) => {
            if (gone) goLibrary();
          });
      },
    },
  ];

  return (
    <div
      data-testid="note-editor"
      data-note-id={note.id}
      data-tab-id={tabId ?? undefined}
      data-active={active}
      className="note-page @container absolute inset-0 overflow-y-auto bg-background-200 text-gray-1000"
    >
      <nav aria-label="Note" className="sticky top-0 z-10 flex items-center gap-2 bg-background-200 px-4" style={{ height: NOTE_BAR_HEIGHT }}>
        <button type="button" data-testid="note-back" className={cn(LINK, "shrink-0 gap-0.5 -ml-1 pl-1")} onClick={goLibrary}>
          <ChevronLeft className="size-4" strokeWidth={2} aria-hidden="true" />
          Notes
        </button>
        <span aria-hidden="true" className="shrink-0 text-[14px] text-gray-600">
          /
        </span>
        <span className="min-w-0 flex-1 truncate text-[14px] leading-[21px] font-medium text-gray-1000">{shown}</span>
        {/* A refusal is the more urgent of the two, so it takes the slot. */}
        {(refusal ?? remoteNotice) === null ? null : (
          <span data-testid="note-bar-notice" className="shrink-0 rounded-full bg-alpha-100 px-2 py-0.5 text-[12px] text-gray-800 @max-[561px]:hidden">
            {refusal ?? remoteNotice}
          </span>
        )}
        <span
          data-testid="note-save-state"
          data-state={badge}
          className={cn("shrink-0 text-[12px] tabular-nums @max-[481px]:hidden", badge === "retrying" ? "text-amber-900" : "text-gray-700")}
        >
          {SAVE_STATE_LABEL[badge]}
        </span>
        <span ref={setShareAnchor} className="flex shrink-0">
          <RowMenu label="Note actions" items={menu} testId="note-menu" onClose={() => setConfirmingDelete(false)} className="opacity-100" />
        </span>
        {sharing ? <ShareMenu noteId={note.id} anchor={shareAnchor} onClose={() => setSharing(false)} /> : null}
      </nav>

      <div className={cn(NOTE_COLUMN, "pb-24")}>
        <NoteTitle
          value={title}
          maxLength={MAX_NOTE_TITLE}
          readOnly={preview}
          autoFocus={active && note.title === "" && note.html === ""}
          onChange={(next) => {
            setTitle(next);
            edit({ title: next });
          }}
          onEnterBody={() => editor.current?.focus("start")}
        />
        {/* The gutters `.note-prose` pads — the block handle on the left, a
            widget's edit button on the right — are pulled back out here, so
            the text still lines up under the title while the chrome has room
            inside the editor's own element. `min-h-[50vh]` makes the space
            under the last line part of the page. */}
        <NoteBlockEditor
          ref={editor}
          html={note.html}
          editable={!preview}
          host={host}
          contentClassName="mt-4 -ml-14 -mr-10 min-h-[50vh]"
          onUpdate={onUpdate}
          onBlur={flushNow}
        />
      </div>
    </div>
  );
}

/* -------------------------------- states -------------------------------- */

function Loading() {
  return (
    <div data-testid="note-loading" className="absolute inset-0 grid place-items-center bg-background-200 text-gray-700">
      <LoaderCircle className="size-5 animate-spin" strokeWidth={2} aria-hidden="true" />
    </div>
  );
}

function Message({ title, text }: { title: string; text: string }) {
  const navigate = useAppStore((state) => state.navigate);
  const tabId = useAppStore((state) => state.snapshot?.activeTabId ?? null);
  return (
    <div className="@container absolute inset-0 overflow-y-auto bg-background-200 text-gray-1000">
      <div className={cn(NOTE_COLUMN, "flex flex-col items-center gap-3 py-24 text-center")}>
        <h1 className="text-[24px] leading-[1.2] font-semibold tracking-[-0.02em] text-balance">{title}</h1>
        <p className="max-w-[440px] text-[15px] leading-6 text-pretty text-gray-800">{text}</p>
        <button
          type="button"
          className={cn(LINK, "mt-1")}
          onClick={() => {
            if (tabId !== null) void navigate(tabId, NOTES_PAGE_URL);
          }}
        >
          <ChevronLeft className={cn("size-4", FOCUS)} strokeWidth={2} aria-hidden="true" />
          All notes
        </button>
      </div>
    </div>
  );
}
