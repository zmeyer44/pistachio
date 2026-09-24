/**
 * The bookmarks page (pistachio://bookmarks, ⌘⇧B): everything the person
 * has saved, as a grid of the things themselves — the coffee maker, the
 * novel, the recipe — with a search that reads titles, keywords, facts,
 * and notes, a row of kind filters, and a site filter. Selecting a card
 * opens its detail beside the grid: the picture, every fact the page
 * stated, the keywords, the note, and the editor.
 *
 * Rendered by the CHROME renderer over the content hole, the way the
 * reminders and settings pages are: `overlay: "bookmarks"` raises the
 * chrome above the tab views through the store's overlay reporting. The
 * address is real — typing it in the bar lands here — but there is no
 * document behind it: the page is a view over main's bookmarks file, and
 * every change is a request to main.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, BookmarkPlus, Copy, ExternalLink, LoaderCircle, Pencil, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import {
  BOOKMARK_KIND_LABEL,
  BOOKMARK_KIND_PLURAL,
  BOOKMARK_KINDS,
  bookmarkHost,
  bookmarkHosts,
  searchBookmarks,
  type Bookmark as BookmarkRecord,
  type BookmarkKind,
} from "@pistachio/shell-contracts/bookmarks";
import { cn } from "../../lib/cn";
import { copyFor } from "../../lib/surface-copy";
import { useAppStore } from "../../store";
import { useSurface } from "../../surface";
import { relativeTime } from "../reminders/parts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Note } from "../ui/note";
import { Select } from "../ui/select";
import { BookmarkEditor } from "./BookmarkEditor";
import { BookmarkImage, KindBadge, KindIcon, primaryFact, PROVENANCE_LABEL, savedOn, siteLabel, SkeletonBlock } from "./parts";

export function BookmarksPage() {
  const all = useAppStore((state) => state.bookmarks.bookmarks);
  const loaded = useAppStore((state) => state.bookmarksLoaded);
  const focus = useAppStore((state) => state.bookmarksFocus);
  const closeBookmarks = useAppStore((state) => state.closeBookmarks);
  const activeTab = useAppStore((state) => state.snapshot?.tabs.find((tab) => tab.id === state.snapshot?.activeTabId) ?? null);
  const bookmarkTab = useAppStore((state) => state.bookmarkTab);
  const copy = copyFor(useSurface().kind).bookmarks;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<BookmarkKind | null>(null);
  const [host, setHost] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(focus);
  const [adding, setAdding] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Landing on a bookmark from the card: its detail, scrolled into view.
  useEffect(() => {
    if (focus === null) return;
    setSelected(focus);
    const frame = requestAnimationFrame(() => {
      document.getElementById(`bookmark-${focus}`)?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (adding) setAdding(false);
      else if (selected !== null) setSelected(null);
      else closeBookmarks();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [adding, closeBookmarks, selected]);

  const hosts = useMemo(() => bookmarkHosts(all), [all]);
  const counts = useMemo(() => {
    const out = new Map<BookmarkKind, number>();
    for (const bookmark of all) {
      if (host !== null && bookmarkHost(bookmark.url) !== host) continue;
      out.set(bookmark.kind, (out.get(bookmark.kind) ?? 0) + 1);
    }
    return out;
  }, [all, host]);
  const shown = useMemo(() => searchBookmarks(all, query, { kind, host, limit: 2_000 }), [all, query, kind, host]);
  const current = selected === null ? null : (all.find((bookmark) => bookmark.id === selected) ?? null);
  const canSaveTab = activeTab !== null && activeTab.kind === "human" && /^https?:/i.test(activeTab.url) && !all.some((bookmark) => bookmark.url === activeTab.url);

  return (
    <div
      role="dialog"
      aria-label="Bookmarks"
      data-testid="bookmarks-page"
      className="@container animate-backdrop-in absolute inset-0 z-20 flex flex-col overflow-hidden rounded-md bg-background-100 shadow-small"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-alpha-400 px-5 py-3 @max-md:px-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-gray-100 text-gray-1000 shadow-border">
          <Bookmark className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="text-heading-16 text-gray-1000">Bookmarks</h1>
          <p className="truncate text-label-12 text-gray-700">
            {loaded ? `${String(all.length)} saved · tap shift twice on any page to add one · ${copy.scope}` : "Loading…"}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {canSaveTab ? (
            <Button
              size="sm"
              variant="secondary"
              prefix={<BookmarkPlus aria-hidden="true" />}
              onClick={() => {
                if (activeTab !== null) void bookmarkTab(activeTab.id);
              }}
              data-testid="bookmark-current-tab"
              className="@max-md:hidden"
            >
              Save this page
            </Button>
          ) : null}
          <Button size="sm" prefix={<Plus aria-hidden="true" />} onClick={() => setAdding((value) => !value)} data-testid="new-bookmark">
            Add
          </Button>
          <Kbd className="@max-md:hidden">esc</Kbd>
          <Button variant="tertiary" size="sm" svgOnly aria-label="Close bookmarks" onClick={closeBookmarks}>
            <X aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div className="flex shrink-0 flex-col gap-3 border-b border-alpha-400 bg-background-200 px-5 py-3 @max-md:px-3">
        {adding ? <AddByAddress onDone={() => setAdding(false)} /> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            ref={searchRef}
            size="sm"
            aria-label="Search bookmarks"
            placeholder="Search what you saved — a name, a brand, an author, a note…"
            prefix={<Search aria-hidden="true" />}
            affixStyling={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-60 flex-1"
            data-testid="bookmark-search"
          />
          {hosts.length > 1 ? (
            <Select
              aria-label="Site"
              value={host ?? ""}
              items={[{ value: "", label: "All sites" }, ...hosts.map((entry) => ({ value: entry.host, label: `${entry.host} (${String(entry.count)})` }))]}
              onValueChange={(value) => setHost(value === "" ? null : value)}
              className="w-44"
            />
          ) : null}
        </div>
        <div role="tablist" aria-label="Filter by kind" className="scroll-thin flex items-center gap-1 overflow-x-auto pb-0.5">
          <KindPill active={kind === null} label="All" count={all.filter((bookmark) => host === null || bookmarkHost(bookmark.url) === host).length} onClick={() => setKind(null)} />
          {BOOKMARK_KINDS.filter((candidate) => (counts.get(candidate) ?? 0) > 0).map((candidate) => (
            <KindPill
              key={candidate}
              active={kind === candidate}
              label={BOOKMARK_KIND_PLURAL[candidate]}
              icon={<KindIcon kind={candidate} className="size-3" />}
              count={counts.get(candidate) ?? 0}
              onClick={() => setKind(kind === candidate ? null : candidate)}
            />
          ))}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <main className="scroll-thin min-w-0 flex-1 overflow-y-auto p-5 @max-md:p-3" data-testid="bookmark-grid">
          {!loaded ? null : all.length === 0 ? (
            <EmptyState />
          ) : shown.length === 0 ? (
            <Note type="secondary" size="sm">
              Nothing matches. Try fewer words, or clear the filters.
            </Note>
          ) : (
            <ul className="grid gap-x-4 gap-y-6 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
              {shown.map((bookmark) => (
                <BookmarkCard key={bookmark.id} bookmark={bookmark} selected={bookmark.id === selected} onSelect={() => setSelected(bookmark.id === selected ? null : bookmark.id)} />
              ))}
            </ul>
          )}
        </main>
        {current === null ? null : (
          <aside
            aria-label={`Bookmark: ${current.title}`}
            data-testid="bookmark-detail"
            className="scroll-thin w-95 shrink-0 overflow-y-auto border-l border-alpha-400 bg-background-100 @max-3xl:absolute @max-3xl:inset-y-0 @max-3xl:right-0 @max-3xl:shadow-menu @max-md:w-full"
          >
            <BookmarkDetail key={current.id} bookmark={current} now={now} onClose={() => setSelected(null)} />
          </aside>
        )}
      </div>
    </div>
  );
}

function KindPill({ active, label, icon, count, onClick }: { active: boolean; label: string; icon?: React.ReactNode; count: number; onClick(): void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-label-12 whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-gray-1000 text-background-100" : "text-gray-900 hover:bg-alpha-100 hover:text-gray-1000",
      )}
    >
      {icon}
      <span>{label}</span>
      <span className={cn("tabular-nums", active ? "text-background-100/70" : "text-gray-700")}>{count}</span>
    </button>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-lg bg-background-200 text-gray-700 shadow-border">
        <BookmarkPlus className="size-6" aria-hidden="true" />
      </span>
      <h2 className="text-heading-16 text-gray-1000">Nothing saved yet</h2>
      <p className="text-copy-13 text-gray-900">
        On any page, tap <Kbd>⇧</Kbd> <Kbd>⇧</Kbd> — shift twice — and Pistachio saves the thing the page is about: the product, the book, the recipe, the article. Or ask the agent to bookmark something for you.
      </p>
    </div>
  );
}

/** Save an address typed in: for a link from elsewhere, without opening it first. */
function AddByAddress({ onDone }: { onDone(): void }) {
  const addBookmark = useAppStore((state) => state.addBookmark);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const submit = async () => {
    const value = url.trim();
    const address = /^https?:\/\//i.test(value) ? value : value === "" ? "" : `https://${value}`;
    if (address === "") {
      setError("Paste a web address.");
      return;
    }
    setSaving(true);
    const failure = await addBookmark({ url: address });
    setSaving(false);
    if (failure !== null) {
      setError(failure);
      return;
    }
    onDone();
  };
  return (
    <form
      className="flex items-start gap-2"
      data-testid="bookmark-add-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        ref={ref}
        size="sm"
        aria-label="Address to bookmark"
        placeholder="Paste a link to save — the page is read for what it is about"
        value={url}
        inputMode="url"
        onChange={(event) => {
          setUrl(event.target.value);
          setError(null);
        }}
        error={error}
        containerClassName="flex-1"
        className="w-full"
      />
      <Button type="submit" size="sm" loading={saving} data-testid="bookmark-add-submit">
        {saving ? "Reading…" : "Save"}
      </Button>
      <Button type="button" variant="tertiary" size="sm" svgOnly aria-label="Cancel" onClick={onDone}>
        <X aria-hidden="true" />
      </Button>
    </form>
  );
}

/* --------------------------------- card --------------------------------- */

function BookmarkCard({ bookmark, selected, onSelect }: { bookmark: BookmarkRecord; selected: boolean; onSelect(): void }) {
  const extracting = bookmark.status === "extracting";
  const fact = primaryFact(bookmark);
  return (
    <li id={`bookmark-${bookmark.id}`} data-testid="bookmark-card" data-kind={bookmark.kind} data-status={bookmark.status}>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          "group flex w-full cursor-pointer flex-col gap-2.5 rounded-md text-left outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          selected ? "" : "hover:-translate-y-0.5",
        )}
      >
        <span
          className={cn(
            "relative block aspect-[4/3] w-full overflow-hidden rounded-md bg-background-200 shadow-border transition-shadow",
            selected ? "ring-2 ring-ring ring-offset-2 ring-offset-background" : "group-hover:shadow-small",
          )}
        >
          {extracting ? (
            <SkeletonBlock className="absolute inset-0 rounded-none" />
          ) : (
            <BookmarkImage bookmark={bookmark} className="absolute inset-0 size-full" iconClassName="size-8" />
          )}
          <span className="absolute top-2 left-2 grid size-6 place-items-center rounded-full bg-background-100/90 text-gray-900 shadow-border backdrop-blur-sm" title={BOOKMARK_KIND_LABEL[bookmark.kind]}>
            <KindIcon kind={bookmark.kind} className="size-3.5" />
          </span>
        </span>
        <span className="flex min-w-0 flex-col gap-0.5 px-0.5">
          {extracting ? (
            <>
              <SkeletonBlock className="h-3.5 w-4/5" />
              <SkeletonBlock className="mt-1 h-3 w-2/5" />
            </>
          ) : (
            <>
              <span className="line-clamp-2 text-label-13 font-medium text-gray-1000">{bookmark.title}</span>
              <span className="truncate text-label-12 text-gray-700">
                {siteLabel(bookmark)}
                {fact === null ? null : (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span className="text-gray-900">{fact}</span>
                  </>
                )}
              </span>
            </>
          )}
        </span>
      </button>
    </li>
  );
}

/* -------------------------------- detail -------------------------------- */

function BookmarkDetail({ bookmark, now, onClose }: { bookmark: BookmarkRecord; now: Date; onClose(): void }) {
  const updateBookmark = useAppStore((state) => state.updateBookmark);
  const deleteBookmark = useAppStore((state) => state.deleteBookmark);
  const refreshBookmark = useAppStore((state) => state.refreshBookmark);
  const openLink = useAppStore((state) => state.openLink);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const extracting = bookmark.status === "extracting";

  const open = (event: React.MouseEvent<HTMLElement>) => {
    const { x, y, width, height } = event.currentTarget.getBoundingClientRect();
    void openLink(bookmark.url, { x, y, width, height }, true);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(bookmark.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // The clipboard refused: nothing to show.
    }
  };

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <KindBadge kind={bookmark.kind} size="md" />
        <Button variant="tertiary" size="xs" svgOnly aria-label="Close detail" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      {extracting ? (
        <SkeletonBlock className="aspect-[4/3] w-full rounded-md" />
      ) : (
        <BookmarkImage bookmark={bookmark} fit="contain" className="aspect-[4/3] w-full rounded-md shadow-border" iconClassName="size-10" />
      )}
      {editing ? (
        <BookmarkEditor
          bookmark={bookmark}
          onSave={async (patch) => {
            const failure = await updateBookmark(bookmark.id, patch);
            if (failure === null) setEditing(false);
            return failure;
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="min-w-0">
            {extracting ? (
              <>
                <SkeletonBlock className="h-4 w-4/5" />
                <SkeletonBlock className="mt-2 h-3 w-full" />
                <SkeletonBlock className="mt-1.5 h-3 w-3/5" />
              </>
            ) : (
              <>
                <h2 className="text-heading-16 text-gray-1000 wrap-anywhere">{bookmark.title}</h2>
                {bookmark.description === "" ? null : <p className="mt-1.5 text-copy-13 text-gray-900 wrap-anywhere">{bookmark.description}</p>}
              </>
            )}
          </div>
          <p className="flex flex-wrap items-center gap-x-1.5 text-label-12 text-gray-700">
            <span className="text-gray-900">{siteLabel(bookmark)}</span>
            <span aria-hidden="true">·</span>
            <span title={bookmark.createdAt}>Saved {savedOn(bookmark.createdAt, now)}</span>
            <span aria-hidden="true">·</span>
            <span>{extracting ? "Reading the page…" : PROVENANCE_LABEL[bookmark.provenance]}</span>
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" prefix={<ExternalLink aria-hidden="true" />} onClick={open} data-testid="bookmark-open">
              Open
            </Button>
            <Button variant="secondary" size="sm" prefix={<Copy aria-hidden="true" />} onClick={() => void copy()}>
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Button variant="tertiary" size="sm" svgOnly aria-label="Edit bookmark" title="Edit" onClick={() => setEditing(true)} data-testid="bookmark-edit">
              <Pencil aria-hidden="true" />
            </Button>
            <Button
              variant="tertiary"
              size="sm"
              svgOnly
              aria-label="Read the page again"
              title="Read the page again"
              disabled={extracting}
              onClick={() => void refreshBookmark(bookmark.id)}
            >
              {extracting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            </Button>
            <Button
              variant="tertiary"
              size="sm"
              svgOnly
              aria-label="Delete bookmark"
              title="Delete"
              data-testid="bookmark-delete"
              onClick={() => {
                if (window.confirm(`Delete “${bookmark.title}”?`)) {
                  onClose();
                  void deleteBookmark(bookmark.id);
                }
              }}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
          {bookmark.details.length === 0 ? null : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-md bg-background-200 px-3.5 py-3 text-label-12 shadow-border">
              {bookmark.details.map((detail) => (
                <div key={detail.label} className="contents">
                  <dt className="text-gray-700">{detail.label}</dt>
                  <dd className="min-w-0 text-gray-1000 wrap-anywhere">{detail.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {bookmark.note === "" ? null : (
            <section aria-label="Note">
              <h3 className="mb-1 text-label-12 font-medium text-gray-700">Note</h3>
              <p className="text-copy-13 whitespace-pre-wrap text-gray-1000 wrap-anywhere">{bookmark.note}</p>
            </section>
          )}
          {bookmark.keywords.length === 0 ? null : (
            <ul aria-label="Keywords" className="flex flex-wrap gap-1">
              {bookmark.keywords.map((keyword) => (
                <li key={keyword} className="rounded-full bg-alpha-100 px-2 py-0.5 text-[11px] leading-4 text-gray-900">
                  {keyword}
                </li>
              ))}
            </ul>
          )}
          <p className="truncate text-[11px] text-gray-700" title={bookmark.url}>
            {bookmark.url}
            <span aria-hidden="true"> · </span>
            {relativeTime(bookmark.updatedAt, now)}
          </p>
        </>
      )}
    </div>
  );
}
