/**
 * One note (docs/notes.md §5). A blank page with a title and a body: no
 * toolbar of heading buttons, no save. The person types, `#`, `-`, `[]`, `>`,
 * ` ``` ` and `/` do what they do in Notion, and `lib/notes-autosave.ts`
 * decides when what they wrote goes to the host.
 *
 * What is drawn here is chrome around a ProseMirror document: a 52px bar, the
 * title, and the editor. The document's shape is `lib/notes-markdown.ts`; the
 * floating menus are their own files; the arithmetic of saving, of accepting
 * a picture and of filtering `/` is in `src/lib`, tested without a DOM.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, ReactNodeViewRenderer, useEditor, type Editor } from "@tiptap/react";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { TextSelection } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ChevronLeft, Copy, GripVertical, LoaderCircle, LogIn, Share2, Trash2 } from "lucide-react";
import {
  MAX_NOTE_BLOBS_PER_NOTE,
  NOTE_UNTITLED,
  NOTES_PAGE_URL,
  noteBlobIdsIn,
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
import { docToMarkdown, noteExtensions } from "../../lib/notes-markdown";
import type { SlashCommand } from "../../lib/notes-slash";
import { useAppStore } from "../../store";
import { BubbleMenu, type TurnIntoId } from "./BubbleMenu";
import { NoteImageView } from "./NoteImage";
import { NoteTitle } from "./NoteTitle";
import { ShareMenu } from "./ShareMenu";
import { SlashMenu, slashExtension, type SlashBridge, type SlashState } from "./SlashMenu";
import { FOCUS, LINK, NOTE_BAR_HEIGHT, NOTE_COLUMN, RowMenu, useTransient, type RowMenuItem } from "./parts";
import { useNotes } from "./use-notes";

/** How long a title sits still before the tab is told about it. */
const TAB_TITLE_MS = 300;

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
/** How long "Edited on another device" stays up. */
const REMOTE_NOTICE_MS = 4_000;

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
  // Keyed by id AND by the revision the body was first read at, so opening a
  // different note builds a different editor rather than reusing this one's
  // document.
  return <NoteBody key={noteId} tabId={tabId} note={note} active={active} />;
}

function NoteBody({ tabId, note, active }: { tabId: string | null; note: Note; active: boolean }) {
  const navigate = useAppStore((state) => state.navigate);
  const createTab = useAppStore((state) => state.createTab);
  const openLink = useAppStore((state) => state.openLink);
  const showNotice = useAppStore((state) => state.showNotice);
  const openSettings = useAppStore((state) => state.openSettings);
  const enrolled = useAppStore((state) => state.account.state === "enrolled");
  const [remoteNotice, sayRemote] = useTransient(REMOTE_NOTICE_MS);
  const [refusal, sayRefusal] = useTransient(REMOTE_NOTICE_MS);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [revision, setRevision] = useState(0);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /** The Share panel, and the corner of the bar it hangs off (docs/notes.md §8). */
  const [sharing, setSharing] = useState(false);
  const [shareAnchor, setShareAnchor] = useState<HTMLElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // The state machine lives in a ref: it is stepped from ProseMirror
  // callbacks and from timers, neither of which should re-render the page.
  const save = useRef<AutosaveState>(
    createAutosave({ revision: note.revision, stamp: noteStamp(note), title: note.title, markdown: note.markdown }),
  );
  const [badge, setBadge] = useState(() => saveState(save.current));
  const timer = useRef<number | null>(null);
  const titleTimer = useRef<number | null>(null);
  const slashKey = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const bridge = useRef<SlashBridge>({ onKey: (event) => slashKey.current(event), set: setSlash });
  const registerSlashKey = useCallback((handler: (event: KeyboardEvent) => boolean) => {
    slashKey.current = handler;
  }, []);
  const [title, setTitle] = useState(note.title);
  const editorRef = useRef<Editor | null>(null);

  /* ── the document ─────────────────────────────────────────────────── */

  const extensions = useMemo(
    () => [
      ...noteExtensions({ imageNodeView: ReactNodeViewRenderer(NoteImageView) }),
      Placeholder.configure({
        // Only the first empty paragraph: every empty line saying "type /"
        // would be a page of instructions rather than a page.
        placeholder: ({ node, pos }) => (pos === 0 && node.type.name === "paragraph" ? "Type / for commands" : ""),
        showOnlyWhenEditable: true,
      }),
      Markdown,
      slashExtension(bridge),
    ],
    [],
  );

  const editor = useEditor({
    extensions,
    content: note.markdown,
    contentType: "markdown",
    autofocus: false,
    editorProps: {
      attributes: { class: "note-prose", "data-testid": "note-body", spellcheck: "true" },
      handleDrop: (_view, event) => takeFiles((event as DragEvent).dataTransfer?.files ?? null, event),
      handlePaste: (_view, event) => takeFiles((event as ClipboardEvent).clipboardData?.files ?? null, event),
      handleDOMEvents: {
        // A link in a note is text being written, not a page to leave for —
        // unless the person asks with Mod, which opens it the way the console's
        // links open (store.openLink).
        click: (_view, event) => {
          const anchor = event.target instanceof Element ? event.target.closest("a") : null;
          if (anchor === null || !(event.metaKey || event.ctrlKey)) return false;
          const href = anchor.getAttribute("href");
          if (href === null || href === "") return false;
          event.preventDefault();
          const box = anchor.getBoundingClientRect();
          void openLink(href, { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) }, false);
          return true;
        },
      },
    },
  });
  editorRef.current = editor;

  /* ── saving ───────────────────────────────────────────────────────── */

  /** Step the machine, then do whatever it asks for. */
  /**
   * Put a document the host holds into the editor without a keystroke of
   * our own, keeping the caret where it was when the new document is still
   * long enough to hold it; a shorter one takes it wherever it fits.
   */
  const showDocument = useCallback((markdown: string) => {
    const current = editorRef.current;
    if (current === null) return;
    const at = current.state.selection.from;
    current.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
    try {
      const clamped = Math.min(at, current.state.doc.content.size);
      current.view.dispatch(current.state.tr.setSelection(TextSelection.near(current.state.doc.resolve(clamped))));
    } catch {
      // A position that no longer resolves is not worth a crash; the
      // selection stays where setContent put it.
    }
  }, []);

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
              note: { revision: saved.revision, stamp: noteStamp(saved), title: saved.title, markdown: saved.markdown },
              at: Date.now(),
            });
            // A field we did not send came back changed — the host merged a
            // version from elsewhere under our title-only save — and the
            // machine adopted it. The page has to show what it adopted.
            if (after.local.markdown !== before.local.markdown) showDocument(after.local.markdown);
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
            if (fresh.markdown !== save.current.local.markdown) showDocument(fresh.markdown);
            setTitle(fresh.title);
            sayRemote("Edited on another device");
            step(
              autosave(save.current, {
                type: "adopt",
                note: { revision: fresh.revision, stamp: noteStamp(fresh), title: fresh.title, markdown: fresh.markdown },
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
    (draft: { title?: string; markdown?: string }) => {
      step(autosave(save.current, { type: "edit", draft, at: Date.now() }));
    },
    [step],
  );

  const flushNow = useCallback(() => {
    step(autosave(save.current, { type: "flushNow", at: Date.now() }));
  }, [step]);

  // Every keystroke in the body, as markdown. Serialising per keystroke is
  // what makes "only the changed fields" possible at all, and a note is
  // kilobytes (N4) — the 600ms debounce is what limits the host traffic.
  useEffect(() => {
    if (editor === null) return;
    const onUpdate = () => {
      setRevision((current) => current + 1);
      edit({ markdown: docToMarkdown(editor.getJSON()) });
    };
    const onSelection = () => setRevision((current) => current + 1);
    editor.on("update", onUpdate);
    editor.on("selectionUpdate", onSelection);
    editor.on("blur", flushNow);
    return () => {
      editor.off("update", onUpdate);
      editor.off("selectionUpdate", onSelection);
      editor.off("blur", flushNow);
    };
  }, [editor, edit, flushNow]);

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
    if (tabId === null) return;
    if (titleTimer.current !== null) window.clearTimeout(titleTimer.current);
    titleTimer.current = window.setTimeout(() => {
      void shellApi()
        .setTabTitle(tabId, title.trim() === "" ? NOTE_UNTITLED : title)
        .catch((cause: unknown) => useAppStore.getState().noteRefusal("setTabTitle", cause));
    }, TAB_TITLE_MS);
  }, [tabId, title]);

  /* ── pictures ─────────────────────────────────────────────────────── */

  /**
   * Decode, downscale, re-encode, hash, keep, insert (N4). The canvas half
   * lives here because it needs a document; every decision it makes is
   * `lib/notes-images.ts`.
   */
  const addImages = useCallback(
    async (files: readonly File[]) => {
      const current = editorRef.current;
      if (current === null) return;
      const already = noteBlobIdsIn(save.current.local.markdown).length;
      let added = 0;
      for (const file of files) {
        if (already + added >= MAX_NOTE_BLOBS_PER_NOTE) {
          sayRefusal(`A note holds ${String(MAX_NOTE_BLOBS_PER_NOTE)} pictures`);
          break;
        }
        const accepted = acceptNoteImage(file);
        if (!accepted.ok) {
          sayRefusal(accepted.reason);
          continue;
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
            continue;
          }
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const expected = await imageBlobId(bytes);
          const id = await useNotes.getState().putImage(bytes, target.mediaType as NoteBlobMediaType);
          if (id === null) {
            sayRefusal("That picture could not be kept");
            continue;
          }
          if (id !== expected) {
            // The host content-addresses the same way (N3); a mismatch means
            // the bytes changed on the way, which is worth saying out loud.
            sayRefusal("That picture did not arrive intact");
            continue;
          }
          current.chain().focus().setImage({ src: `note-blob:${id}`, alt: file.name }).run();
          added += 1;
        } catch (error) {
          // The person sees one line; the cause goes where a bug report can find it.
          console.warn(`[notes] could not take ${file.name}`, error);
          sayRefusal(`${file.name} could not be read`);
        }
      }
    },
    [sayRefusal],
  );

  /** True when the event carried files and we took them — ProseMirror stops there. */
  const takeFiles = (list: FileList | null, event: Event): boolean => {
    const files = [...(list ?? [])].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return false;
    event.preventDefault();
    void addImages(files);
    return true;
  };

  /* ── the slash menu and the bubble menu ───────────────────────────── */

  const runSlash = useCallback(
    (command: SlashCommand, range: { from: number; to: number }) => {
      const current = editorRef.current;
      if (current === null) return;
      setSlash(null);
      const chain = current.chain().focus().deleteRange(range);
      switch (command.id) {
        case "paragraph":
          chain.setParagraph().run();
          break;
        case "heading1":
          chain.setNode("heading", { level: 1 }).run();
          break;
        case "heading2":
          chain.setNode("heading", { level: 2 }).run();
          break;
        case "heading3":
          chain.setNode("heading", { level: 3 }).run();
          break;
        case "bulletList":
          chain.toggleBulletList().run();
          break;
        case "orderedList":
          chain.toggleOrderedList().run();
          break;
        case "taskList":
          chain.toggleTaskList().run();
          break;
        case "blockquote":
          chain.toggleBlockquote().run();
          break;
        case "codeBlock":
          chain.toggleCodeBlock().run();
          break;
        case "divider":
          chain.setHorizontalRule().run();
          break;
        case "table":
          chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
          break;
        case "image":
          chain.run();
          fileInput.current?.click();
          break;
      }
    },
    [],
  );

  const turnInto = useCallback((id: TurnIntoId) => {
    const current = editorRef.current;
    if (current === null) return;
    const chain = current.chain().focus();
    if (id === "paragraph") chain.setParagraph().run();
    else if (id === "heading1") chain.setNode("heading", { level: 1 }).run();
    else if (id === "heading2") chain.setNode("heading", { level: 2 }).run();
    else if (id === "heading3") chain.setNode("heading", { level: 3 }).run();
    else if (id === "bulletList") chain.toggleBulletList().run();
    else if (id === "orderedList") chain.toggleOrderedList().run();
    else if (id === "taskList") chain.toggleTaskList().run();
    else if (id === "blockquote") chain.toggleBlockquote().run();
    else chain.toggleCodeBlock().run();
  }, []);

  const editLink = useCallback(() => {
    const current = editorRef.current;
    if (current === null) return;
    const existing = (current.getAttributes("link")["href"] as string | undefined) ?? "";
    const href = window.prompt("Link address", existing);
    if (href === null) return;
    if (href.trim() === "") current.chain().focus().unsetLink().run();
    else current.chain().focus().extendMarkRange("link").setLink({ href: href.trim() }).run();
  }, []);

  /* ── the keyboard ─────────────────────────────────────────────────── */

  useEffect(() => {
    if (editor === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || !editor.isFocused) return;
      if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        if (moveBlock(editor, event.key === "ArrowUp" ? -1 : 1)) event.preventDefault();
        return;
      }
      if (event.key === "Enter" && toggleTask(editor)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor]);

  /* ── the page ─────────────────────────────────────────────────────── */

  const shown = title.trim() === "" ? NOTE_UNTITLED : title;
  const goLibrary = () => {
    if (tabId === null) void createTab(NOTES_PAGE_URL);
    else void navigate(tabId, NOTES_PAGE_URL);
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
        const body = save.current.local.markdown.trimEnd();
        void navigator.clipboard.writeText(title.trim() === "" ? body : `# ${title}\n\n${body}`);
        showNotice("Note copied as markdown", { tone: "success" });
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
      className="@container absolute inset-0 overflow-y-auto bg-background-200 text-gray-1000"
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
          autoFocus={active && note.title === "" && note.markdown === ""}
          onChange={(next) => {
            setTitle(next);
            edit({ title: next });
          }}
          onEnterBody={() => editor?.chain().focus("start").run()}
        />
        {/* The shell turns selection off globally; a document being written
            is the one place that has to have it back. `min-h-[50vh]` is what
            makes the space under the last line part of the page, so clicking
            there lands the caret at the end. */}
        <div
          // Pulled left by the gutter `.note-prose` pads, so the text still
          // lines up under the title while the grip has room inside the editor.
          className="mt-4 -ml-8 min-h-[50vh] [&_.ProseMirror]:outline-none"
          style={{ userSelect: "text", cursor: "text" }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) editor?.chain().focus("end").run();
          }}
        >
          {editor === null ? null : <EditorContent editor={editor} />}
        </div>
      </div>

      {editor === null ? null : (
        <>
          {/* A quiet grip in the margin: it is there when the pointer is near
              a block, and it drags that block somewhere else. */}
          <DragHandle editor={editor} className="note-drag-handle">
            <span aria-hidden="true" className="grid size-5 cursor-grab place-items-center rounded text-gray-600 transition-colors hover:bg-alpha-200 hover:text-gray-900">
              <GripVertical className="size-4" strokeWidth={1.75} />
            </span>
          </DragHandle>
          <SlashMenu
            editor={editor}
            state={slash}
            onRun={runSlash}
            onDismiss={() => setSlash(null)}
            registerKeyHandler={registerSlashKey}
          />
          <BubbleMenu editor={editor} revision={revision} onTurnInto={turnInto} onLink={editLink} />
        </>
      )}

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        data-testid="note-image-input"
        className="hidden"
        onChange={(event) => {
          void addImages([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
    </div>
  );
}

/* ------------------------------ commands -------------------------------- */

/**
 * Move the block the caret is in up or down one. The drag handle can do this
 * with a pointer; this is the same move for the keyboard (Mod+Shift+↑/↓),
 * and it works on top-level blocks, which is what a person means by "this
 * paragraph".
 */
function moveBlock(editor: Editor, direction: -1 | 1): boolean {
  const { state, view } = editor;
  const doc = state.doc;
  const $from = state.selection.$from;
  if ($from.depth < 1) return false;
  const index = $from.index(0);
  const target = index + direction;
  if (target < 0 || target >= doc.childCount) return false;
  const startOf = (at: number): number => {
    let position = 0;
    for (let child = 0; child < at; child += 1) position += doc.child(child).nodeSize;
    return position;
  };
  const node: ProseMirrorNode = doc.child(index);
  const from = startOf(index);
  const to = from + node.nodeSize;
  // Deleting first shifts everything after `to` back by the node's size, so
  // moving down inserts at the neighbour's end minus that size.
  const insertAt = direction === -1 ? startOf(target) : startOf(target) + doc.child(target).nodeSize - node.nodeSize;
  const offset = state.selection.from - from;
  const tr = state.tr.delete(from, to).insert(insertAt, node);
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(insertAt + offset, tr.doc.content.size))));
  } catch {
    // The caret ends up wherever the mapping put it; the block still moved.
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Tick or untick the to-do the caret is in. */
function toggleTask(editor: Editor): boolean {
  const $from = editor.state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== "taskItem") continue;
    const position = $from.before(depth);
    editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, checked: node.attrs["checked"] !== true }));
    return true;
  }
  return false;
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
