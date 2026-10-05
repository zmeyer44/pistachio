/**
 * The Library: everything the person keeps, in one place, one row from the
 * sidebar's menu — the pages the agent built (artifacts), the notes they
 * wrote, the pages they saved with shift, shift, and what Watchtower read.
 *
 * A chrome overlay like Watchtower and the archive, and built the same way: a
 * header that says what this is and how much of it there is, a recessed
 * strip to filter, and a list. It is a way IN rather than another manager:
 * each row opens its thing, and each section links to the page that manages
 * that kind (the notes library, Watchtower's Saved view and its timeline).
 * Artifacts have no page of their own, so their view here is the whole list.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppWindow, ArrowRight, Bookmark as BookmarkIcon, FileClock, FileText, LibraryBig, NotebookPen, Search, X } from "lucide-react";
import type { ArtifactListing } from "@pistachio/shell-contracts/artifacts";
import { noteTitle } from "@pistachio/shell-contracts/notes";
import { isShellUnsupported } from "@pistachio/shell-contracts/socket";
import type { WatchtowerHit } from "@pistachio/shell-contracts/watchtower";
import { shellApi } from "../../api";
import { filterArtifacts, filterNotes, filterSaved, LIBRARY_PREVIEW, librarySummary, type LibraryView } from "../../lib/library";
import { WATCHTOWER_COPY } from "../../lib/surface-copy";
import { useAppStore } from "../../store";
import { useSurface } from "../../surface";
import { Favicon } from "../Favicon";
import { useNotes } from "../notes/use-notes";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Note } from "../ui/note";
import { formatDay, formatTime, hostOfUrl } from "../watchtower/format";
import { watchtowerError } from "../watchtower/use-watchtower";

const VIEWS: ReadonlyArray<{ view: LibraryView; label: string }> = [
  { view: "all", label: "All" },
  { view: "artifacts", label: "Artifacts" },
  { view: "notes", label: "Notes" },
  { view: "saved", label: "Saved" },
  { view: "watchtower", label: "Watchtower" },
];

/** The most Watchtower's search answers at once; past it, Watchtower's own page has the rest. */
const WATCHTOWER_PAGE = 50;

/** The time today, "Yesterday", then the date: when a row was last touched. */
function whenLabel(at: number, now: number): string {
  return formatDay(at, now) === "Today" ? formatTime(at) : formatDay(at, now);
}

/** What Watchtower answered for the filter, or why it could not. */
interface WatchtowerState {
  hits: WatchtowerHit[] | null;
  visits: number | null;
  /** Off and never used: there is nothing to show but the way to turn it on. */
  off: boolean;
  error: string | null;
}

export function LibraryPage() {
  const setOverlay = useAppStore((state) => state.setOverlay);
  const openAddress = useAppStore((state) => state.openAddress);
  const openNotes = useAppStore((state) => state.openNotes);
  const newNote = useAppStore((state) => state.newNote);
  const openBookmarks = useAppStore((state) => state.openBookmarks);
  const openWatchtower = useAppStore((state) => state.openWatchtower);
  const bookmarks = useAppStore((state) => state.bookmarks.bookmarks);
  const bookmarksLoaded = useAppStore((state) => state.bookmarksLoaded);
  const spaceName = useAppStore((state) => state.snapshot?.spaces.find((space) => space.id === state.snapshot?.activeSpaceId)?.name ?? "This Space");
  const native = useSurface().kind === "native";
  const notes = useNotes((state) => state.summaries);
  const notesUnsupported = useNotes((state) => state.unsupported);
  const notesError = useNotes((state) => state.error);

  const [view, setView] = useState<LibraryView>("all");
  const [query, setQuery] = useState("");
  const [artifacts, setArtifacts] = useState<ArtifactListing[] | null>(null);
  const [artifactsProblem, setArtifactsProblem] = useState<{ unavailable: boolean; message: string } | null>(null);
  const [watchtower, setWatchtower] = useState<WatchtowerState>({ hits: null, visits: null, off: false, error: null });
  const searchRef = useRef<HTMLInputElement>(null);
  const now = Date.now();

  useEffect(() => {
    void useNotes.getState().load();
    let cancelled = false;
    void shellApi()
      .getArtifacts()
      .then((listed) => {
        if (!cancelled) setArtifacts(listed);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        const message = failure instanceof Error ? failure.message : String(failure);
        setArtifactsProblem({ unavailable: isShellUnsupported(failure), message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Watchtower answers the filter itself — it searches the pages' words, not
  // only their titles — after a short pause in typing. The overview asks for
  // as many as it shows.
  const watchtowerLimit = view === "watchtower" ? WATCHTOWER_PAGE : LIBRARY_PREVIEW;
  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void shellApi()
        .watchtower({ type: "search", query: query.trim(), offset: 0, limit: watchtowerLimit })
        .then((response) => {
          if (cancelled) return;
          setWatchtower({
            hits: response.results ?? [],
            visits: response.stats.visits,
            off: !response.settings.enabled && response.stats.visits === 0,
            error: null,
          });
        })
        .catch((failure: unknown) => {
          if (!cancelled) setWatchtower((current) => ({ ...current, error: watchtowerError(failure) }));
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [native, query, watchtowerLimit]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setOverlay("none");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setOverlay]);

  const shownArtifacts = useMemo(() => filterArtifacts(artifacts ?? [], query), [artifacts, query]);
  const shownNotes = useMemo(() => filterNotes(notes ?? [], query), [notes, query]);
  const shownSaved = useMemo(() => filterSaved(bookmarks, query), [bookmarks, query]);
  const hits = watchtower.hits ?? [];

  const summary = librarySummary({
    artifacts: artifacts?.length ?? null,
    notes: notes?.length ?? null,
    saved: bookmarksLoaded ? bookmarks.length : null,
    visits: native ? watchtower.visits : null,
  });
  const counts: Partial<Record<LibraryView, number>> = {
    ...(artifacts === null ? {} : { artifacts: shownArtifacts.length }),
    ...(notes === null ? {} : { notes: shownNotes.length }),
    ...(bookmarksLoaded ? { saved: shownSaved.length } : {}),
  };

  const filtering = query.trim() !== "";
  const overview = view === "all";
  /** In the overview, a kind with nothing matching the filter steps aside; its own view says so. */
  const shows = (kind: Exclude<LibraryView, "all">, matching: number | null): boolean =>
    view === kind || (overview && (!filtering || matching === null || matching > 0));
  const limit = <T,>(items: readonly T[]): readonly T[] => (overview ? items.slice(0, LIBRARY_PREVIEW) : items);
  const nothingMatches =
    overview &&
    filtering &&
    shownArtifacts.length === 0 &&
    shownNotes.length === 0 &&
    shownSaved.length === 0 &&
    (watchtower.hits === null || hits.length === 0);

  return (
    <div
      role="dialog"
      aria-label="Library"
      data-testid="library-page"
      className="@container animate-backdrop-in absolute inset-0 z-20 flex flex-col overflow-hidden rounded-md bg-background-100 shadow-small"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-alpha-400 px-5 py-3 @max-md:px-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-gray-100 text-gray-1000 shadow-border">
          <LibraryBig className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="text-heading-16 text-gray-1000">Library</h1>
          <p className="truncate text-label-12 text-gray-700" data-testid="library-summary">
            {summary === "" ? "Loading…" : `${summary} · ${spaceName}`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Kbd className="@max-md:hidden">esc</Kbd>
          <Button variant="tertiary" size="sm" svgOnly aria-label="Close library" onClick={() => setOverlay("none")}>
            <X aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-alpha-400 bg-background-200 px-5 py-3 @max-md:px-3">
        <ViewTabs view={view} counts={counts} onChange={setView} />
        <Input
          ref={searchRef}
          size="sm"
          aria-label="Filter the library"
          placeholder="Filter by title, site, or words from a page"
          prefix={<Search aria-hidden="true" />}
          affixStyling={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-60 flex-1"
          data-testid="library-filter"
        />
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4 @max-md:px-3" data-testid="library-list">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {nothingMatches ? (
            <Empty icon={<Search className="size-5" aria-hidden="true" />} title="Nothing matches" body="Try another word: a title, a site, or something a page said." />
          ) : null}

          {shows("artifacts", artifacts === null ? null : shownArtifacts.length) ? (
            <Section
              kind="artifacts"
              title="Artifacts"
              icon={<AppWindow aria-hidden="true" />}
              total={shownArtifacts.length}
              overview={overview}
              onShowAll={() => setView("artifacts")}
            >
              {artifactsProblem !== null ? (
                <Note type={artifactsProblem.unavailable ? "secondary" : "error"} size="sm">
                  {artifactsProblem.message}
                </Note>
              ) : artifacts === null ? null : artifacts.length === 0 ? (
                <Quiet>Nothing built yet. Ask the agent to build you a page — a news feed, a trip plan — and it is kept here.</Quiet>
              ) : shownArtifacts.length === 0 ? (
                <Quiet>No artifact matches.</Quiet>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {limit(shownArtifacts).map((artifact) => (
                    <Row
                      key={artifact.id}
                      testId="library-artifact"
                      icon={<AppWindow className="size-4" strokeWidth={1.75} aria-hidden="true" />}
                      title={artifact.title}
                      subtitle={artifact.brief === "" ? `Revision ${String(artifact.revision)}` : artifact.brief}
                      when={whenLabel(Date.parse(artifact.updatedAt), now)}
                      onOpen={() => openAddress(artifact.url)}
                    />
                  ))}
                </ul>
              )}
            </Section>
          ) : null}

          {shows("notes", notes === null ? null : shownNotes.length) ? (
            <Section
              kind="notes"
              title="Notes"
              icon={<NotebookPen aria-hidden="true" />}
              total={shownNotes.length}
              overview={overview}
              onShowAll={() => setView("notes")}
              manage={notesUnsupported ? undefined : { label: "Open Notes", run: () => openNotes() }}
            >
              {notesUnsupported ? (
                <Quiet>Notes are not kept here.</Quiet>
              ) : notesError !== null && notes === null ? (
                <Note type="error" size="sm">
                  {notesError}
                </Note>
              ) : notes === null ? null : notes.length === 0 ? (
                <Quiet action={{ label: "New note", run: () => void newNote() }}>No notes yet.</Quiet>
              ) : shownNotes.length === 0 ? (
                <Quiet>No note matches.</Quiet>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {limit(shownNotes).map((note) => (
                    <Row
                      key={note.id}
                      testId="library-note"
                      icon={note.icon ?? <FileText className="size-4" strokeWidth={1.75} aria-hidden="true" />}
                      title={noteTitle(note)}
                      subtitle={note.snippet === "" ? "Empty note" : note.snippet}
                      when={whenLabel(Date.parse(note.updatedAt), now)}
                      onOpen={() => openNotes(note.id)}
                    />
                  ))}
                </ul>
              )}
            </Section>
          ) : null}

          {shows("saved", bookmarksLoaded ? shownSaved.length : null) ? (
            <Section
              kind="saved"
              title="Saved"
              icon={<BookmarkIcon aria-hidden="true" />}
              total={shownSaved.length}
              overview={overview}
              onShowAll={() => setView("saved")}
              manage={{ label: "Open Saved", run: () => openBookmarks() }}
            >
              {!bookmarksLoaded ? null : bookmarks.length === 0 ? (
                <Quiet>Nothing saved yet. Tap shift twice on any page to keep it here.</Quiet>
              ) : shownSaved.length === 0 ? (
                <Quiet>No saved page matches.</Quiet>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {limit(shownSaved).map((bookmark) => (
                    <Row
                      key={bookmark.id}
                      testId="library-saved"
                      icon={<Favicon src={bookmark.faviconUrl} seed={hostOfUrl(bookmark.url) || bookmark.title} />}
                      title={bookmark.title}
                      subtitle={bookmark.siteName || hostOfUrl(bookmark.url)}
                      when={whenLabel(Date.parse(bookmark.createdAt), now)}
                      onOpen={() => openAddress(bookmark.url)}
                    />
                  ))}
                </ul>
              )}
            </Section>
          ) : null}

          {shows("watchtower", native && watchtower.hits !== null ? hits.length : null) ? (
            <Section
              kind="watchtower"
              title={filtering ? "Watchtower" : "Recently read"}
              icon={<FileClock aria-hidden="true" />}
              // Watchtower counts visits, not matches: a full preview is the
              // only sign there are more to show.
              total={null}
              more={hits.length >= LIBRARY_PREVIEW}
              overview={overview}
              onShowAll={() => setView("watchtower")}
              // Off, the line below offers to set it up; one way in is enough.
              manage={native && !watchtower.off ? { label: "Open Watchtower", run: () => openWatchtower() } : undefined}
            >
              {!native ? (
                <Quiet>{WATCHTOWER_COPY.unavailable}</Quiet>
              ) : watchtower.error !== null ? (
                <Note type="error" size="sm">
                  {watchtower.error}
                </Note>
              ) : watchtower.hits === null ? null : watchtower.off ? (
                <Quiet action={{ label: "Set up Watchtower", run: () => openWatchtower() }}>
                  Watchtower is off. Turn it on to find again anything you read.
                </Quiet>
              ) : hits.length === 0 ? (
                <Quiet>{filtering ? "No page Watchtower saved matches." : "Nothing read yet."}</Quiet>
              ) : (
                <>
                  <ul className="flex flex-col gap-0.5">
                    {hits.map((hit) => (
                      <Row
                        key={hit.observationId}
                        testId="library-visit"
                        icon={<Favicon src={null} seed={hostOfUrl(hit.url) || hit.title} />}
                        title={hit.title || hostOfUrl(hit.url)}
                        subtitle={hit.snippet === "" ? hostOfUrl(hit.url) : `${hostOfUrl(hit.url)} · ${hit.snippet}`}
                        when={whenLabel(hit.visitedAt, now)}
                        onOpen={() => openAddress(hit.url)}
                      />
                    ))}
                  </ul>
                  {view === "watchtower" && hits.length === WATCHTOWER_PAGE ? (
                    <Quiet action={{ label: "Open Watchtower", run: () => openWatchtower() }}>Older visits are in Watchtower.</Quiet>
                  ) : null}
                </>
              )}
            </Section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The view switcher: one pill slides under the tabs to the chosen view
 * (transitions.dev "Tabs sliding"; shell.css `.t-tabs`). It is measured
 * after layout, so it lands on the tab whatever width its label and count
 * give it. A change of view slides it; anything else that moves a tab — a
 * count changing as the filter narrows, the page resizing — puts it in
 * place without a slide.
 */
function ViewTabs({ view, counts, onChange }: { view: LibraryView; counts: Partial<Record<LibraryView, number>>; onChange(view: LibraryView): void }) {
  const barRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const placedRef = useRef<LibraryView | null>(null);

  const place = useCallback((slide: boolean) => {
    const pill = pillRef.current;
    const tab = barRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (pill === null || tab === null || tab === undefined) return;
    const write = () => {
      pill.style.transform = `translateX(${tab.offsetLeft}px)`;
      pill.style.width = `${tab.offsetWidth}px`;
    };
    if (slide) {
      write();
      return;
    }
    // Without the tween, or the first paint would slide in from the edge.
    const transition = pill.style.transition;
    pill.style.transition = "none";
    write();
    void pill.offsetWidth;
    pill.style.transition = transition;
  }, []);

  useLayoutEffect(() => {
    place(placedRef.current !== null && placedRef.current !== view);
    placedRef.current = view;
  }, [view, place]);

  useEffect(() => {
    const bar = barRef.current;
    if (bar === null) return;
    const observer = new ResizeObserver(() => place(false));
    for (const tab of bar.querySelectorAll("[role=tab]")) observer.observe(tab);
    return () => observer.disconnect();
  }, [place]);

  return (
    <div ref={barRef} role="tablist" aria-label="Library view" className="t-tabs shrink-0 overflow-x-auto">
      <span ref={pillRef} className="t-tabs-pill" aria-hidden="true" />
      {VIEWS.map((option) => {
        const count = counts[option.view];
        return (
          <button
            key={option.view}
            type="button"
            role="tab"
            aria-selected={view === option.view}
            onClick={() => onChange(option.view)}
            data-testid={`library-view-${option.view}`}
            className="t-tab flex shrink-0 items-center gap-1.5 text-label-12 whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {option.label}
            {count === undefined ? null : <span className="text-gray-700 tabular-nums">{count.toLocaleString()}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One kind's part of the page. In the overview it shows the newest few and
 * offers the rest ("Show all"); in its own view it is the whole list. Either
 * way it links to the page that manages that kind, when there is one.
 */
function Section({
  kind,
  title,
  icon,
  total,
  more = total !== null && total > LIBRARY_PREVIEW,
  overview,
  onShowAll,
  manage,
  children,
}: {
  kind: Exclude<LibraryView, "all">;
  title: string;
  icon: ReactNode;
  /** How many match, when that is known here; null when another page counts them. */
  total: number | null;
  /** There is more than the overview shows; by default, more than its preview of `total`. */
  more?: boolean;
  overview: boolean;
  onShowAll(): void;
  manage?: { label: string; run(): void };
  children: ReactNode;
}) {
  const headingId = `library-section-${kind}`;
  return (
    <section aria-labelledby={headingId} data-testid={`library-section-${kind}`} className="flex flex-col gap-1.5">
      <div className="flex min-h-7 items-center gap-2 px-2">
        <span className="text-gray-700 [&_svg]:size-3.5">{icon}</span>
        <h2 id={headingId} className="text-label-13 font-medium text-gray-1000">
          {title}
        </h2>
        {total === null || total === 0 ? null : <span className="text-label-12 text-gray-700 tabular-nums">{total.toLocaleString()}</span>}
        <span className="ml-auto flex items-center gap-1">
          {overview && more ? (
            <Button size="xs" variant="tertiary" onClick={onShowAll} data-testid={`library-show-${kind}`}>
              Show all
            </Button>
          ) : null}
          {manage === undefined ? null : (
            <Button size="xs" variant="tertiary" suffix={<ArrowRight aria-hidden="true" />} onClick={manage.run} data-testid={`library-manage-${kind}`}>
              {manage.label}
            </Button>
          )}
        </span>
      </div>
      {children}
    </section>
  );
}

function Row({ icon, title, subtitle, when, onOpen, testId }: { icon: ReactNode; title: string; subtitle: string; when: string; onOpen(): void; testId: string }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-testid={testId}
        className="flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-alpha-200 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-alpha-100 text-[15px] text-gray-800">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-label-13 text-gray-1000">{title}</span>
          <span className="block truncate text-label-12 text-gray-700">{subtitle}</span>
        </span>
        <span className="shrink-0 text-label-12 text-gray-700 tabular-nums @max-md:hidden">{when}</span>
      </button>
    </li>
  );
}

/** A section's one line when it has no rows to show. */
function Quiet({ children, action }: { children: ReactNode; action?: { label: string; run(): void } }) {
  return (
    <div className="flex items-center gap-3 px-2 py-1.5">
      <p className="min-w-0 flex-1 text-label-13 text-gray-700">{children}</p>
      {action === undefined ? null : (
        <Button size="xs" variant="secondary" onClick={action.run}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

function Empty({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center justify-center gap-2 py-16 text-center">
      <span className="grid size-10 place-items-center rounded-lg bg-gray-100 text-gray-900 shadow-border">{icon}</span>
      <h2 className="text-heading-14 text-gray-1000">{title}</h2>
      <p className="text-label-13 text-gray-700">{body}</p>
    </div>
  );
}
