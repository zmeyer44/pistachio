import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { FileWarning, LoaderCircle } from "lucide-react";
import { fileViewerKind, type FileViewerKind, type GroupContextFile, type GroupFileContent } from "@pistachio/shell-contracts/desk-agent";
import { DocumentSession, type SessionState } from "../../../lib/desk/document-session";
import { loadGroupFile, saveGroupFile, useFileWindows } from "../../../lib/desk/group-files";
import { fileItemOf } from "../../../lib/desk/windows";

/** What every viewer is handed (docs/desk-documents.md §2). */
export interface ViewerProps {
  item: GroupContextFile;
  content: GroupFileContent;
  /** The window is the one in use. */
  focused: boolean;
  /** Changes when the viewer's content should take the keyboard (its window chosen). */
  focusSignal: number;
  /** The viewer changed the file: `serialize` gives its bytes as they are now, when the window saves. */
  onEdit(serialize: () => Uint8Array | Promise<Uint8Array>): void;
  /** What the frame says beside the file's name: "12 pages". */
  onDetail(detail: string | null): void;
}

type Viewer = ComponentType<ViewerProps>;

/** Each kind's viewer, loaded the first time one is opened (pdf.js and the editors are large). */
const VIEWERS: Record<FileViewerKind, Viewer> = {
  text: lazy(() => import("./TextViewer")),
  markdown: lazy(() => import("./MarkdownViewer")),
  document: lazy(() => import("./DocumentViewer")),
  sheet: lazy(() => import("./SheetViewer")),
  image: lazy(() => import("./ImageViewer")),
  pdf: lazy(() => import("./PdfViewer")),
};

/**
 * A document window's page: its file loaded, in the viewer for its kind,
 * and its edits saved into the group's context a moment after the person
 * stops — over the version they were made to, so an edit made meanwhile on
 * another Mac is never silently lost (the window asks which to keep). The
 * rules are the session's (lib/desk/document-session.ts), bound to the file
 * the window opened on: put away, or passed to another group, with an edit
 * waiting, the edit is written as it goes, or kept for the next window.
 */
export function FileWindow({ windowId, groupId, item, focused }: { windowId: string; groupId: string; item: (GroupContextFile & { here: boolean }) | null; focused: boolean }) {
  const setStatus = useFileWindows((state) => state.set);
  const forget = useFileWindows((state) => state.forget);
  const focusSignal = useFileWindows((state) => state.focus[windowId] ?? 0);
  const kind = item === null ? null : fileViewerKind(item.mediaType);
  const kindRef = useRef(kind);
  if (kind !== null) kindRef.current = kind;
  const [state, setState] = useState<SessionState | null>(null);
  // Made in an effect, so React's rehearsal unmount in development (StrictMode) disposes one and the mount makes the next.
  const [session, setSession] = useState<DocumentSession | null>(null);
  useEffect(() => {
    const itemId = fileItemOf(windowId) ?? "";
    const created = new DocumentSession(
      { groupId, itemId },
      {
        load: (blobId) => loadGroupFile(groupId, itemId, blobId),
        save: (write) => saveGroupFile({ groupId, itemId, ...write, ...(kindRef.current === "document" ? { as: "docx" as const } : {}) }),
        setTimer: (run, ms) => window.setTimeout(run, ms),
        clearTimer: (id) => window.clearTimeout(id),
      },
      setState,
    );
    setSession(created);
    setState(created.state);
    // Put away, or passed to another group, with an edit waiting: it is written as the window goes.
    return () => created.dispose();
  }, [groupId, windowId]);
  useEffect(() => () => forget(windowId), [forget, windowId]);

  // The frame says where the edits stand.
  useEffect(() => {
    if (state !== null) setStatus(windowId, { save: state.save, message: state.message });
  }, [setStatus, state, windowId]);

  // The version on show follows the file's in the context (null: not known, or no longer in view).
  const blobId = item?.blobId ?? null;
  const here = item?.here ?? false;
  useEffect(() => session?.update(blobId, here), [session, blobId, here]);

  const onEdit = useCallback((serialize: () => Uint8Array | Promise<Uint8Array>) => session?.edit(serialize), [session]);
  const onDetail = useCallback((detail: string | null) => setStatus(windowId, { detail }), [setStatus, windowId]);
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void session?.saveNow();
    }
  };

  if (session === null || state === null) return <Placeholder busy text="Opening…" />;
  const { shown, conflict } = state;
  if (item === null && shown.state !== "ready") return <Placeholder busy text="Opening…" />;
  const shownKind = kindRef.current;
  if (shownKind === null) return <Placeholder text="The desk has no viewer for this kind of file." />;
  if (shown.state === "loading") return <Placeholder busy text="Opening…" />;
  if (shown.state === "missing") return <Placeholder text={shown.reason} />;
  const View = VIEWERS[shownKind];
  const viewed = item ?? { id: shown.content.itemId, kind: "file" as const, name: shown.content.name, mediaType: shown.content.mediaType, byteLength: shown.content.bytes.byteLength, blobId: shown.content.blobId, addedAt: "", addedBy: "person" as const, here: true };
  return (
    <div className="desk-file-window" data-testid="desk-file-window" data-viewer={shownKind} onKeyDown={onKeyDown}>
      {conflict === null ? null : (
        <div role="alert" data-testid="desk-file-conflict" className="desk-file-conflict">
          <span className="min-w-0 flex-1">{conflict}</span>
          <button type="button" className="desk-answer-action" onMouseDown={(event) => event.preventDefault()} onClick={() => void session.saveNow(true)}>
            Keep mine
          </button>
          <button type="button" className="desk-answer-action" onMouseDown={(event) => event.preventDefault()} onClick={() => session.loadTheirs()}>
            Load theirs
          </button>
        </div>
      )}
      <ViewerBoundary key={`${shown.content.blobId}:${String(shown.content.bytes.byteLength)}`}>
        <Suspense fallback={<Placeholder busy text="Opening…" />}>
          <View item={viewed} content={shown.content} focused={focused} focusSignal={focusSignal} onEdit={onEdit} onDetail={onDetail} />
        </Suspense>
      </ViewerBoundary>
    </div>
  );
}

/** A viewer that fails shows so in its own window: the desk, and every other window, goes on. */
class ViewerBoundary extends Component<{ children: ReactNode }, { failed: string | null }> {
  override state: { failed: string | null } = { failed: null };

  static getDerivedStateFromError(error: unknown): { failed: string } {
    return { failed: error instanceof Error ? error.message : "it could not be drawn" };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("[desk] a document's viewer failed", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.failed !== null) return <Placeholder text={`This file could not be shown: ${this.state.failed}.`} />;
    return this.props.children;
  }
}

function Placeholder({ text, busy = false }: { text: string; busy?: boolean }) {
  return (
    <div className="grid size-full place-items-center bg-background-100 p-6" data-testid="desk-file-placeholder">
      <span className="flex max-w-72 flex-col items-center gap-2 text-center text-[12px] leading-[17px] text-gray-800">
        {busy ? <LoaderCircle className="size-4 animate-spin text-gray-700" aria-hidden="true" /> : <FileWarning className="size-5 text-gray-700" aria-hidden="true" />}
        {text}
      </span>
    </div>
  );
}
