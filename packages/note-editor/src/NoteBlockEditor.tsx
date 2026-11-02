/**
 * The editor's surface (docs/notes.md §5): a ProseMirror document on the
 * shared schema with everything a Notion-style page has around its blocks —
 * the handle beside each one, the slash menu, the bubble menu, the link and
 * image prompts, the live node views — and nothing of the page around IT: no
 * bar, no title, no save. The host supplies those and answers what the
 * editor asks for in return (`NoteEditorHost`): the desktop shell, the web
 * shell and the account site all mount this one component.
 *
 * The document goes in as HTML once, comes out as HTML on every change
 * (`onUpdate`), and is replaced through the handle (`show`) when the host
 * has a newer version — keeping the caret where it was when the new document
 * is still long enough to hold it.
 */

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { Extension, type JSONContent } from "@tiptap/core";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { Image as ImageIcon, Upload } from "lucide-react";
import { noteExtensions, PastePolicy } from "@pistachio/notes";
import { BlockHandle } from "./BlockHandle";
import { BubbleMenu } from "./BubbleMenu";
import { cn } from "./cn";
import { NoteHostProvider, openLinkElsewhere, type NoteEditorHost } from "./host";
import { safeImageSrc } from "./image-src";
import { LinkPopover } from "./LinkPopover";
import { nodeViewOverrides } from "./nodes";
import { pendingRangeKey, PendingRangeHighlight, setPendingRange } from "./pending-range";
import { PromptPopover } from "./PromptPopover";
import type { SlashCommand } from "./slash";
import { runSlashCommand } from "./slash-actions";
import { SlashMenu, slashExtension, type SlashBridge, type SlashState } from "./SlashMenu";

/** What the empty first line says. */
export const NOTE_EDITOR_PLACEHOLDER = "Type / for commands";

const EMPTY_HOST: NoteEditorHost = {};

/**
 * How the editor reads a note's HTML: runs of spaces kept, as `@pistachio/notes`
 * keeps them (`htmlToDoc`), so what is shown is what is stored. Newlines
 * between blocks are still nothing; only `"full"` would make them text.
 */
const WHITESPACE_KEPT = { preserveWhitespace: true } as const;

/** The overlays a note has besides its menus: the link editor over a range, the image prompt at a position. */
type Overlay = { kind: "link"; from: number; to: number; href: string } | { kind: "image"; pos: number };

export interface NoteBlockEditorHandle {
  readonly editor: Editor | null;
  /** Show a document the host holds, without a keystroke of the person's own. */
  show(html: string): void;
  focus(where?: "start" | "end"): void;
  getHTML(): string;
  getJSON(): JSONContent;
}

export interface NoteBlockEditorProps {
  /** The document, as HTML. Read when the editor is made; later versions arrive through `show`. */
  html: string;
  editable?: boolean;
  placeholder?: string;
  autofocus?: boolean | "start" | "end";
  host?: NoteEditorHost;
  /** On the root, around the document and its menus. */
  className?: string;
  /** On the column the document sits in: the host's measure, and the space under the last line. */
  contentClassName?: string;
  testId?: string;
  /** Every change, as HTML. */
  onUpdate?(html: string): void;
  onBlur?(): void;
  ref?: Ref<NoteBlockEditorHandle>;
}

/**
 * ⌘K opens the link editor on the selection and ⌘↵ ticks the to-do the
 * caret is in. An extension rather than a window listener so they run where
 * the other keys do and claim the key before anything else can.
 */
function noteKeys(open: { current: () => void }): Extension {
  return Extension.create({
    name: "noteEditorKeys",
    addKeyboardShortcuts() {
      return {
        "Mod-k": () => {
          open.current();
          return true;
        },
        "Mod-Enter": () => toggleTask(this.editor),
      };
    },
  });
}

export function NoteBlockEditor({
  html,
  editable = true,
  placeholder = NOTE_EDITOR_PLACEHOLDER,
  autofocus = false,
  host = EMPTY_HOST,
  className,
  contentClassName,
  testId,
  onUpdate,
  onBlur,
  ref,
}: NoteBlockEditorProps) {
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [blockMenuOpen, setBlockMenuOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const slashKey = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const bridge = useRef<SlashBridge>({ onKey: (event) => slashKey.current(event), set: setSlash });
  const registerSlashKey = useCallback((handler: (event: KeyboardEvent) => boolean) => {
    slashKey.current = handler;
  }, []);
  const linkOpener = useRef<() => void>(() => undefined);
  const editorRef = useRef<Editor | null>(null);
  // The editor's own props are read once, when it is made; the host and the
  // callbacks it reaches for are refs so a later render still gets through.
  const hostRef = useRef(host);
  hostRef.current = host;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;

  /* ── the document ─────────────────────────────────────────────────── */

  const extensions = useMemo(
    () =>
      noteExtensions({
        placeholder,
        overrides: nodeViewOverrides,
        extra: [PendingRangeHighlight, PastePolicy, slashExtension(bridge), noteKeys(linkOpener)],
      }),
    // The placeholder is read when the schema is built; a host that changes it remounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({
    extensions,
    content: html,
    // The document's own whitespace is the document's: two spaces a person
    // wrote stay two, on this load and on every save after it.
    parseOptions: WHITESPACE_KEPT,
    autofocus,
    editable,
    editorProps: {
      attributes: { class: "note-prose", "data-testid": "note-body", spellcheck: "true", role: "textbox", "aria-multiline": "true", "aria-label": "Note" },
      handleDrop: (_view, event) => takeFiles((event as DragEvent).dataTransfer?.files ?? null, event),
      handlePaste: (_view, event) => takeFiles((event as ClipboardEvent).clipboardData?.files ?? null, event),
      handleDOMEvents: {
        // A link in a note is text being written, not a page to leave for —
        // unless the person asks with Mod, which opens it where the host says.
        click: (_view, event) => {
          const anchor = event.target instanceof Element ? event.target.closest("a") : null;
          if (anchor === null || !(event.metaKey || event.ctrlKey)) return false;
          const href = anchor.getAttribute("href");
          if (href === null || href === "") return false;
          event.preventDefault();
          const open = hostRef.current.openLink;
          if (open === undefined) openLinkElsewhere(href);
          else open(href, anchor.getBoundingClientRect());
          return true;
        },
      },
    },
    onUpdate: ({ editor: current }) => {
      setRevision((value) => value + 1);
      onUpdateRef.current?.(current.getHTML());
    },
    onSelectionUpdate: () => setRevision((value) => value + 1),
    onBlur: () => onBlurRef.current?.(),
  });
  editorRef.current = editor;

  useEffect(() => {
    if (editor !== null && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  /** Put a document the host holds into the editor, keeping the caret where it was when it still fits. */
  const show = useCallback((next: string) => {
    const current = editorRef.current;
    if (current === null || current.isDestroyed) return;
    const at = current.state.selection.from;
    current.commands.setContent(next, { emitUpdate: false, parseOptions: WHITESPACE_KEPT });
    try {
      const clamped = Math.min(at, current.state.doc.content.size);
      current.view.dispatch(current.state.tr.setSelection(TextSelection.near(current.state.doc.resolve(clamped))));
    } catch {
      // A position that no longer resolves is not worth a crash; the
      // selection stays where setContent put it.
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      get editor() {
        return editorRef.current;
      },
      show,
      focus: (where) => {
        editorRef.current?.chain().focus(where ?? null).run();
      },
      getHTML: () => editorRef.current?.getHTML() ?? "",
      getJSON: () => editorRef.current?.getJSON() ?? { type: "doc", content: [] },
    }),
    [show],
  );

  /* ── pictures ─────────────────────────────────────────────────────── */

  /** Each file the host takes becomes a picture, in order; the ones it refuses it says so about itself. */
  const addImages = useCallback(async (files: readonly File[]) => {
    const upload = hostRef.current.uploadImage;
    if (upload === undefined) return;
    for (const file of files) {
      const src = await upload(file);
      const current = editorRef.current;
      if (src === null || current === null || current.isDestroyed) continue;
      current.chain().focus().setImage({ src, alt: file.name }).run();
    }
  }, []);

  /** True when the event carried picture files and the host takes them — ProseMirror stops there. */
  const takeFiles = (list: FileList | null, event: Event): boolean => {
    if (hostRef.current.uploadImage === undefined) return false;
    const files = [...(list ?? [])].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return false;
    event.preventDefault();
    void addImages(files);
    return true;
  };

  /* ── the slash menu, the prompts, the bubble menu ─────────────────── */

  const runSlash = useCallback((command: SlashCommand, range: { from: number; to: number }) => {
    const current = editorRef.current;
    if (current === null) return;
    setSlash(null);
    runSlashCommand(current, command, range, {
      promptImage: () => setOverlay({ kind: "image", pos: current.state.selection.from }),
    });
  }, []);

  /** The link editor over the selection, or over the link the caret is in. */
  const openLinkEditor = useCallback(() => {
    const current = editorRef.current;
    if (current === null || !current.isEditable) return;
    let { from, to } = current.state.selection;
    if (from === to) {
      if (!current.isActive("link")) return;
      current.chain().extendMarkRange("link").run();
      ({ from, to } = current.state.selection);
    }
    const href = (current.getAttributes("link")["href"] as string | undefined) ?? "";
    current.view.dispatch(setPendingRange(current.state.tr, { from, to }));
    setOverlay({ kind: "link", from, to, href });
  }, []);
  linkOpener.current = openLinkEditor;

  const overlayRef = useRef<Overlay | null>(null);
  overlayRef.current = overlay;
  const closeOverlay = useCallback((restoreSelection: boolean) => {
    const current = editorRef.current;
    const open = overlayRef.current;
    setOverlay(null);
    if (current === null || current.isDestroyed) return;
    const tr = setPendingRange(current.state.tr, null);
    if (restoreSelection && open?.kind === "link") tr.setSelection(TextSelection.create(tr.doc, open.from, open.to));
    current.view.dispatch(tr);
    current.view.focus();
  }, []);

  const applyLink = useCallback((from: number, to: number, href: string | null) => {
    const current = editorRef.current;
    if (current === null) return;
    setOverlay(null);
    // The highlight goes in a transaction of its own: `setPendingRange` keeps
    // its transaction out of the history, and the link change must stay in
    // it, or ⌘Z would step over the link to the edit before it.
    current.view.dispatch(setPendingRange(current.state.tr, null));
    const chain = current.chain().focus().setTextSelection({ from, to }).extendMarkRange("link");
    (href === null ? chain.unsetLink() : chain.setLink({ href })).setTextSelection(to).run();
  }, []);

  /** A picture by address, where the Image row was. */
  const submitImage = useCallback((pos: number, value: string): string | undefined => {
    const current = editorRef.current;
    if (current === null) return undefined;
    const src = safeImageSrc(value);
    if (src === null) return "Enter the web address of a picture.";
    setOverlay(null);
    current.chain().focus(pos).insertContentAt(pos, { type: "image", attrs: { src } }).run();
    return undefined;
  }, []);

  // Positions held by an overlay go stale if the document changes underneath
  // (our own submit clears the pending range in the same transaction).
  useEffect(() => {
    if (editor === null || overlay === null) return;
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged || transaction.getMeta(pendingRangeKey) !== undefined) return;
      setOverlay(null);
      queueMicrotask(() => {
        if (!editor.isDestroyed) editor.view.dispatch(setPendingRange(editor.state.tr, null));
      });
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor, overlay]);

  /* ── the surface ──────────────────────────────────────────────────── */

  const canUpload = host.uploadImage !== undefined;
  const openLink = (href: string, box: DOMRect) => {
    if (host.openLink === undefined) openLinkElsewhere(href);
    else host.openLink(href, box);
  };

  return (
    <NoteHostProvider value={host}>
      <div className={cn("note-editor", className)} data-editable={editable || undefined} data-testid={testId}>
        {/* The space under the last line is part of the page: clicking there lands the caret at the end. */}
        <div
          className={cn("note-editor__column", contentClassName)}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) editor?.chain().focus("end").run();
          }}
        >
          {editor === null ? null : <EditorContent editor={editor} className="note-editor__content" />}
        </div>

        {editor === null || !editable ? null : (
          <>
            <BlockHandle editor={editor} onMenuOpenChange={setBlockMenuOpen} />
            <SlashMenu editor={editor} state={slash} onRun={runSlash} onDismiss={() => setSlash(null)} registerKeyHandler={registerSlashKey} />
            <BubbleMenu editor={editor} revision={revision} enabled={overlay === null && !blockMenuOpen} onLink={openLinkEditor} />
            {overlay?.kind === "link" ? (
              <LinkPopover
                editor={editor}
                from={overlay.from}
                to={overlay.to}
                initialHref={overlay.href}
                onApply={(href) => applyLink(overlay.from, overlay.to, href)}
                onOpen={openLink}
                onCancel={() => closeOverlay(true)}
              />
            ) : null}
            {overlay?.kind === "image" ? (
              <PromptPopover
                editor={editor}
                pos={overlay.pos}
                label="Image"
                icon={ImageIcon}
                placeholder="Paste the web address of a picture…"
                testId="note-image-prompt"
                onSubmit={(value) => submitImage(overlay.pos, value)}
                onCancel={() => closeOverlay(false)}
                action={
                  canUpload
                    ? {
                        label: "Upload a file",
                        icon: <Upload aria-hidden="true" />,
                        testId: "note-image-upload",
                        onClick: () => {
                          setOverlay(null);
                          fileInput.current?.click();
                        },
                      }
                    : undefined
                }
              />
            ) : null}
          </>
        )}

        {canUpload ? (
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
        ) : null}
      </div>
    </NoteHostProvider>
  );
}

/* ------------------------------ commands -------------------------------- */

/** Tick or untick the to-do the caret is in (⌘↵). */
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
