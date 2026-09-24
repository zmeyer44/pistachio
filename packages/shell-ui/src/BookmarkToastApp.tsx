/**
 * The bookmark card over the page: what a double tap of shift shows.
 *
 * A utility chrome view of its own (main/chrome-view.ts, id "bookmark"),
 * because the tab views sit above the shell page and a card drawn there
 * would never be seen. It rises at the pane's corner the instant the tap
 * lands — a skeleton wearing the tab's title — and fills in as the page
 * is read: the picture, the thing's own name, what it is, and the first
 * facts. From here the person can fix any field, open the bookmarks page,
 * or take the save back. Main is told the card's height so the view can be
 * sized to it; the card leaves on its own once it has been read, unless
 * it is being hovered, edited, or holds keyboard focus.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bookmark, BookmarkCheck, ExternalLink, Pencil, Trash2, X } from "lucide-react";
import type { Bookmark as BookmarkRecord, BookmarkSnapshot, BookmarkToast } from "@pistachio/shell-contracts/bookmarks";
import { BookmarkEditor } from "./components/bookmarks/BookmarkEditor";
import { BookmarkImage, KindBadge, primaryFact, PROVENANCE_LABEL, siteLabel, SkeletonBlock } from "./components/bookmarks/parts";
import { Button } from "./components/ui/button";
import { cn } from "./lib/cn";
import { nativeApi, shellApi } from "./api";

/** How long a finished card stays once nobody is looking at it. */
const LINGER_MS = 9_000;

export function BookmarkToastApp() {
  const [toast, setToast] = useState<BookmarkToast | null>(null);
  const [snapshot, setSnapshot] = useState<BookmarkSnapshot>({ bookmarks: [] });

  useEffect(() => {
    let active = true;
    void shellApi().getBookmarkToast().then((next) => {
      if (active) setToast(next);
    });
    void shellApi().getBookmarks().then((next) => {
      if (active) setSnapshot(next);
    });
    const offToast = shellApi().onBookmarkToast(setToast);
    const offBookmarks = shellApi().onBookmarks(setSnapshot);
    return () => {
      active = false;
      offToast();
      offBookmarks();
    };
  }, []);

  const bookmark = toast === null ? null : (snapshot.bookmarks.find((candidate) => candidate.id === toast.id) ?? null);
  if (toast === null || bookmark === null) return <div className="h-full w-full" />;
  return <ToastCard key={toast.id} toast={toast} bookmark={bookmark} />;
}

function ToastCard({ toast, bookmark }: { toast: BookmarkToast; bookmark: BookmarkRecord }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const extracting = bookmark.status === "extracting";
  const dismiss = () => nativeApi()?.dismissBookmarkToast();

  // Main sizes the view to the card: report every change of height.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    let frame = 0;
    const report = () => {
      frame = 0;
      nativeApi()?.resizeBookmarkToast(Math.ceil(root.getBoundingClientRect().height));
    };
    report();
    const observer = new ResizeObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(report);
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  // The card leaves on its own once read — unless it is being looked at:
  // hovered, edited, or holding the keyboard focus a person tabbed into it.
  useEffect(() => {
    if (extracting || editing || hovered || focused) return;
    const timer = window.setTimeout(dismiss, LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [extracting, editing, hovered, focused, bookmark.updatedAt]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (editing) setEditing(false);
      else dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing]);

  const fact = primaryFact(bookmark);
  const caption = extracting
    ? "Reading the page…"
    : toast.existed
      ? "Already saved"
      : PROVENANCE_LABEL[bookmark.provenance];

  return (
    <div ref={rootRef} className="w-full p-3">
      <article
        className={cn("bookmark-toast rounded-lg bg-background-100 text-gray-1000 shadow-modal", extracting && "bookmark-toast-reading")}
        role="status"
        aria-live="polite"
        aria-label={extracting ? "Saving bookmark" : `Bookmarked ${bookmark.title}`}
        data-testid="bookmark-toast"
        data-status={bookmark.status}
        data-existed={toast.existed || undefined}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
        }}
      >
        <header className="flex items-center gap-2 px-3.5 pt-2.5 pb-1">
          <span className={cn("grid size-5 place-items-center rounded-full", extracting ? "bg-alpha-100 text-gray-900" : "bg-green-100 text-green-900")} aria-hidden="true">
            {extracting ? <Bookmark className="size-3 animate-pulse" /> : <BookmarkCheck className="size-3" />}
          </span>
          <span className="text-label-12 font-medium text-gray-1000">{extracting ? "Saving…" : toast.existed ? "Saved earlier" : "Bookmarked"}</span>
          <span className="truncate text-[11px] text-gray-700">{caption}</span>
          <span className="ml-auto flex items-center gap-0.5">
            {extracting || editing ? null : (
              <Button variant="tertiary" size="xs" svgOnly aria-label="Edit bookmark" title="Edit" onClick={() => setEditing(true)} data-testid="bookmark-toast-edit">
                <Pencil aria-hidden="true" />
              </Button>
            )}
            <Button
              variant="tertiary"
              size="xs"
              svgOnly
              aria-label="Show in bookmarks"
              title="Show in bookmarks"
              onClick={() => shellApi().openBookmarksPage(bookmark.id)}
              data-testid="bookmark-toast-open"
            >
              <ExternalLink aria-hidden="true" />
            </Button>
            {editing ? null : (
              <Button
                variant="tertiary"
                size="xs"
                svgOnly
                aria-label={toast.existed ? "Delete bookmark" : "Undo — remove bookmark"}
                title={toast.existed ? "Delete" : "Undo"}
                onClick={() => void shellApi().deleteBookmark(bookmark.id)}
                data-testid="bookmark-toast-remove"
              >
                <Trash2 aria-hidden="true" />
              </Button>
            )}
            <Button variant="tertiary" size="xs" svgOnly aria-label="Dismiss" title="Dismiss" onClick={dismiss} data-testid="bookmark-toast-dismiss">
              <X aria-hidden="true" />
            </Button>
          </span>
        </header>
        {editing ? (
          <div className="px-3.5 pt-1.5 pb-3">
            <BookmarkEditor
              bookmark={bookmark}
              compact
              onSave={async (patch) => {
                try {
                  await shellApi().updateBookmark(bookmark.id, patch);
                  setEditing(false);
                  return null;
                } catch (error: unknown) {
                  return error instanceof Error ? error.message : String(error);
                }
              }}
              onCancel={() => setEditing(false)}
            />
          </div>
        ) : (
          <div className="flex gap-3 px-3.5 pt-1 pb-3">
            {extracting ? (
              <SkeletonBlock className="size-16 shrink-0 rounded-md" />
            ) : (
              <BookmarkImage bookmark={bookmark} className="size-16 shrink-0 rounded-md shadow-border" iconClassName="size-6" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {extracting ? (
                <>
                  <span className="line-clamp-1 text-label-13 font-medium text-gray-900">{bookmark.title}</span>
                  <SkeletonBlock className="h-3 w-3/5" />
                  <SkeletonBlock className="h-3 w-full" />
                  <SkeletonBlock className="h-3 w-4/5" />
                </>
              ) : (
                <>
                  <span className="line-clamp-2 text-label-13 font-medium leading-4 text-gray-1000 wrap-anywhere">{bookmark.title}</span>
                  <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-gray-700">
                    <KindBadge kind={bookmark.kind} />
                    <span className="truncate">{siteLabel(bookmark)}</span>
                    {fact === null ? null : (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="truncate text-gray-900">{fact}</span>
                      </>
                    )}
                  </span>
                  {bookmark.description === "" ? null : (
                    <span className="line-clamp-2 text-label-12 leading-4 text-gray-900 wrap-anywhere">{bookmark.description}</span>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </article>
    </div>
  );
}
