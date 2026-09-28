/**
 * Watchtower: what the person read, found again. `pistachio://watchtower`.
 *
 * A chrome overlay like Bookmarks, and built the same way: a header that
 * says what this is and how much of it there is, a recessed strip to search
 * and filter, a list, and a detail pane beside it. The list is a timeline —
 * visits under the day they happened — because "when" is the one thing a
 * person always half-remembers. Beside it, Saved: the pages kept on purpose
 * with shift, shift — the synced saved records, each also kept here in full
 * and filed under what it is about (the bookmarks library, embedded). And
 * the Index: the same pages as the people, companies, products and ideas
 * they are about, each one entry however many sites named it
 * (`IndexView.tsx`). How capture BEHAVES is not here: that is Settings →
 * Watchtower, one click from the header.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, FileClock, GitCompareArrows, Pause, Play, Plus, Search, Settings2, Sparkles, Trash2, X } from "lucide-react";
import type {
  WatchtowerDocument,
  WatchtowerEntityDocument,
  WatchtowerEntityKind,
  WatchtowerHit,
  WatchtowerIndex,
  WatchtowerResponse,
} from "@pistachio/shell-contracts/watchtower";
import { shellApi } from "../../api";
import { cn } from "../../lib/cn";
import { WATCHTOWER_COPY } from "../../lib/surface-copy";
import { useAppStore } from "../../store";
import { useSurface } from "../../surface";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Note } from "../ui/note";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { BookmarksLibrary, SaveThisPage } from "../bookmarks/BookmarksPage";
import { ForgetDialog, forgetRequest, type ForgetScope } from "./ForgetDialog";
import { EntityChips, EntityReader, EntityRow, IndexNote, indexSummary, KindPills } from "./IndexView";
import { SavedBlock, SavedCard } from "./SavedText";
import { COVERAGE_NOTE, coverageLabel, formatDay, formatMoment, formatTime, hostOfUrl, KIND_LABEL } from "./format";
import { useWatchtower, watchtowerError } from "./use-watchtower";

const PAGE_SIZE = 50;
const KINDS = [
  { value: null, label: "All" },
  { value: "article", label: "Articles" },
  { value: "video", label: "Videos" },
  { value: "page", label: "Pages" },
] as const;
type KindFilter = (typeof KINDS)[number]["value"];
type View = "timeline" | "saved" | "index";
/** What the reader pane shows; following a link or an entry pushes, Back pops. */
type Selection = { type: "page"; id: string } | { type: "entity"; id: number };

export function WatchtowerPage({ initialView = "timeline" }: { initialView?: View } = {}) {
  const setOverlay = useAppStore((state) => state.setOverlay);
  const savedCount = useAppStore((state) => state.bookmarks.bookmarks.length);
  const focusEntity = useAppStore((state) => state.watchtowerFocus);
  const openSettings = useAppStore((state) => state.openSettings);
  const spaceName = useAppStore((state) => state.snapshot?.spaces.find((space) => space.id === state.snapshot?.activeSpaceId)?.name ?? "This Space");
  const native = useSurface().kind === "native";
  const status = useWatchtower(false);
  const { absorb } = status;

  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>(null);
  const [offset, setOffset] = useState(0);
  const [results, setResults] = useState<WatchtowerHit[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [improving, setImproving] = useState(false);
  const [view, setView] = useState<View>(initialView);
  const [addingSaved, setAddingSaved] = useState(false);
  const [trail, setTrail] = useState<Selection[]>([]);
  const shown = trail.at(-1) ?? null;
  const selected = shown?.type === "page" ? shown.id : null;
  const selectedEntity = shown?.type === "entity" ? shown.id : null;
  const [document, setDocument] = useState<WatchtowerDocument | null>(null);
  const [indexQuery, setIndexQuery] = useState("");
  const [entityKind, setEntityKind] = useState<WatchtowerEntityKind | null>(null);
  const [indexOffset, setIndexOffset] = useState(0);
  const [index, setIndex] = useState<WatchtowerIndex | null>(null);
  const [entity, setEntity] = useState<WatchtowerEntityDocument | null>(null);
  const [indexRevision, setIndexRevision] = useState(0);
  const [editing, setEditing] = useState(false);
  const [diff, setDiff] = useState<WatchtowerResponse["diff"]>();
  const [forgetting, setForgetting] = useState<ForgetScope | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const fullQuery = kind === null ? query : `${query} kind:${kind}`.trim();
  const current = useRef(fullQuery);
  current.current = fullQuery;

  // The list: searched after a short pause in typing, and — with nothing
  // typed — re-read every few seconds so a visit appears as it is saved.
  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    const read = (): void => {
      void shellApi()
        .watchtower({ type: "search", query: fullQuery, offset })
        .then((response) => {
          if (cancelled) return;
          absorb(response);
          setResults(response.results ?? []);
          setSearchError(null);
        })
        .catch((failure: unknown) => {
          if (!cancelled) setSearchError(watchtowerError(failure));
        });
    };
    const timer = window.setTimeout(read, 180);
    const poll = fullQuery === "" && offset === 0 ? window.setInterval(read, 5000) : undefined;
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearInterval(poll);
    };
  }, [fullQuery, offset, status.revision, native, absorb]);

  // The index: entries matching the typed name, re-read every few seconds
  // while nothing is typed, so entries appear as pages are read.
  useEffect(() => {
    if (!native || view !== "index") return;
    let cancelled = false;
    const read = (): void => {
      void shellApi()
        .watchtower({ type: "entities", query: indexQuery, ...(entityKind === null ? {} : { kind: entityKind }), offset: indexOffset })
        .then((response) => {
          if (cancelled) return;
          absorb(response);
          setIndex(response.index ?? null);
          setSearchError(null);
        })
        .catch((failure: unknown) => {
          if (!cancelled) setSearchError(watchtowerError(failure));
        });
    };
    const timer = window.setTimeout(read, 150);
    const poll = indexQuery === "" && indexOffset === 0 ? window.setInterval(read, 5000) : undefined;
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearInterval(poll);
    };
  }, [native, view, indexQuery, entityKind, indexOffset, indexRevision, status.revision, absorb]);

  useEffect(() => {
    setEntity(null);
    if (selectedEntity === null) return;
    let cancelled = false;
    void shellApi()
      .watchtower({ type: "entity", entityId: selectedEntity })
      .then((response) => {
        if (!cancelled) setEntity(response.entity ?? null);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setSearchError(watchtowerError(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedEntity, indexRevision]);

  useEffect(() => {
    setDocument(null);
    setDiff(undefined);
    if (selected === null) return;
    let cancelled = false;
    void shellApi()
      .watchtower({ type: "read", observationId: selected })
      .then((response) => {
        if (!cancelled) setDocument(response.document ?? null);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setSearchError(watchtowerError(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  // Landing on an entry a save's card named.
  useEffect(() => {
    if (focusEntity === null) return;
    setView("index");
    setTrail([{ type: "entity", id: focusEntity }]);
    useAppStore.setState({ watchtowerFocus: null });
  }, [focusEntity]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // In Saved the library owns Escape: its detail and form, then the page.
      // (Both listen on the window; which registered last changes with every
      // render, so neither may rely on running first.)
      if (event.key !== "Escape" || event.defaultPrevented || view === "saved") return;
      event.preventDefault();
      if (trail.length > 0) setTrail(trail.slice(0, -1));
      else setOverlay("none");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [trail, setOverlay, view]);

  const push = (selection: Selection): void => setTrail((path) => [...path, selection].slice(-20));
  const back = (): void => setTrail((path) => path.slice(0, -1));
  /** The version selector replaces what is shown rather than stacking on it. */
  const replace = (selection: Selection): void => setTrail((path) => [...path.slice(0, -1), selection]);
  const switchView = (next: View): void => {
    setView(next);
    setTrail([]);
    setNotice(null);
  };
  const viewTabs = (
    <div role="tablist" aria-label="Watchtower view" className="flex shrink-0 items-center gap-0.5 rounded-full bg-background-100 p-0.5 shadow-border">
      <Pill active={view === "timeline"} label="Timeline" onClick={() => switchView("timeline")} testId="watchtower-view-timeline" />
      <Pill active={view === "saved"} label="Saved" onClick={() => switchView("saved")} testId="watchtower-view-saved" />
      <Pill active={view === "index"} label="Index" onClick={() => switchView("index")} testId="watchtower-view-index" />
    </div>
  );
  const editEntity = async (id: number, edit: { merge?: number; kind?: WatchtowerEntityKind; remove?: boolean }): Promise<void> => {
    setEditing(true);
    try {
      const response = await shellApi().watchtower({ type: "entity-edit", entityId: id, ...edit });
      absorb(response);
      setIndexRevision((value) => value + 1);
      if (edit.remove) {
        setNotice(`Removed ${entity?.name ?? "the entry"} from the index.`);
        back();
      } else if (edit.merge !== undefined) replace({ type: "entity", id: edit.merge });
      else setEntity(response.entity ?? null);
    } catch (failure) {
      setSearchError(watchtowerError(failure));
    } finally {
      setEditing(false);
    }
  };

  const openTab = async (url: string): Promise<void> => {
    await shellApi().createTab(url);
    setOverlay("none");
  };
  const improve = async (): Promise<void> => {
    setImproving(true);
    setNotice(null);
    try {
      const response = await shellApi().watchtower({ type: "search", query: fullQuery, offset, enhance: true });
      if (current.current !== fullQuery) return;
      absorb(response);
      setResults(response.results ?? []);
      setNotice(
        response.rerankStatus === "enhanced"
          ? "Ordered by how closely each saved excerpt matches your description."
          : response.rerankStatus === "unconfigured"
            ? "Improving matches needs an account with a decision model. Showing local results."
            : "Improving matches is unavailable right now. Showing local results.",
      );
    } catch (failure) {
      setSearchError(watchtowerError(failure));
    } finally {
      setImproving(false);
    }
  };
  const compare = async (before: WatchtowerHit, after: WatchtowerDocument): Promise<void> => {
    try {
      const response = await shellApi().watchtower({ type: "diff", beforeId: before.observationId, afterId: after.observationId });
      setDiff(response.diff);
    } catch (failure) {
      setSearchError(watchtowerError(failure));
    }
  };

  const { settings, stats } = status;
  const days = useMemo(() => groupByDay(results ?? []), [results]);
  const summary = index === null ? "" : indexSummary(index.counts);
  const error = searchError ?? status.error;
  const reset = (): void => {
    setOffset(0);
    setNotice(null);
  };

  return (
    <div
      role="dialog"
      aria-label="Watchtower"
      data-testid="watchtower-page"
      className="@container animate-backdrop-in absolute inset-0 z-20 flex flex-col overflow-hidden rounded-md bg-background-100 shadow-small"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-alpha-400 px-5 py-3 @max-md:px-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-gray-100 text-gray-1000 shadow-border">
          <FileClock className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="text-heading-16 text-gray-1000">Watchtower</h1>
          <p className="truncate text-label-12 text-gray-700">
            {view === "saved"
              ? `${count(savedCount, "saved page")} · tap shift twice on any page to save it`
              : stats === null || settings === null
              ? "Loading…"
              : view === "index" && summary !== ""
                ? `${summary} · ${spaceName}`
                : `${count(stats.visits, "visit")} · ${count(stats.snapshots, "saved version")} · ${spaceName}`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {settings?.enabled ? (
            <>
              <CaptureBadge paused={settings.paused} full={stats?.full ?? false} />
              <Button
                size="sm"
                variant="secondary"
                prefix={settings.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                disabled={status.busy}
                onClick={() => void status.configure({ paused: !settings.paused })}
                className="@max-md:hidden"
              >
                {settings.paused ? "Resume" : "Pause"}
              </Button>
            </>
          ) : null}
          <Button variant="tertiary" size="sm" svgOnly aria-label="Watchtower settings" onClick={() => openSettings("watchtower")}>
            <Settings2 aria-hidden="true" />
          </Button>
          <Kbd className="@max-md:hidden">esc</Kbd>
          <Button variant="tertiary" size="sm" svgOnly aria-label="Close Watchtower" onClick={() => setOverlay("none")}>
            <X aria-hidden="true" />
          </Button>
        </div>
      </header>

      {!native ? (
        <Centered icon={<FileClock className="size-6" aria-hidden="true" />} title="Watchtower is on your desktop" body={WATCHTOWER_COPY.unavailable} />
      ) : view === "saved" ? (
        <BookmarksLibrary
          adding={addingSaved}
          onAddingChange={setAddingSaved}
          onClose={() => setOverlay("none")}
          leading={viewTabs}
          trailing={
            <>
              <SaveThisPage />
              <Button size="sm" variant="secondary" prefix={<Plus aria-hidden="true" />} onClick={() => setAddingSaved((value) => !value)} data-testid="new-bookmark">
                Add
              </Button>
            </>
          }
          watchtower={{
            openEntity: (id) => {
              switchView("index");
              setTrail([{ type: "entity", id }]);
            },
            openPage: (id) => {
              switchView("timeline");
              setTrail([{ type: "page", id }]);
            },
          }}
        />
      ) : settings === null || stats === null ? (
        error === null ? null : (
          <div className="p-5">
            <Note type="error" size="sm">
              {error}
            </Note>
          </div>
        )
      ) : !settings.enabled && stats.visits === 0 ? (
        <TurnOn
          busy={status.busy}
          error={error}
          saved={savedCount}
          onSaved={() => switchView("saved")}
          onEnable={(choices) => void status.configure({ enabled: true, ...choices })}
        />
      ) : (
        <>
          <div className="flex shrink-0 flex-col gap-3 border-b border-alpha-400 bg-background-200 px-5 py-3 @max-md:px-3">
            <div className="flex flex-wrap items-center gap-2">
              {viewTabs}
              <Input
                ref={searchRef}
                size="sm"
                aria-label={view === "index" ? "Find in the index" : "Search Watchtower"}
                placeholder={view === "index" ? "Find a person, company, product, place or idea" : "Search what you read — words from the page, a name, “an exact phrase”"}
                prefix={<Search aria-hidden="true" />}
                affixStyling={false}
                value={view === "index" ? indexQuery : query}
                onChange={(event) => {
                  if (view === "index") {
                    setIndexQuery(event.target.value);
                    setIndexOffset(0);
                  } else {
                    setQuery(event.target.value);
                    reset();
                  }
                }}
                className="min-w-60 flex-1"
                data-testid="watchtower-search"
              />
              {view === "timeline" && settings.remoteRerank && query.trim() !== "" ? (
                <Button size="sm" variant="secondary" prefix={<Sparkles aria-hidden="true" />} loading={improving} onClick={() => void improve()}>
                  Improve matches
                </Button>
              ) : null}
            </div>
            {view === "index" ? (
              <KindPills
                counts={index?.counts ?? {}}
                kind={entityKind}
                Pill={Pill}
                onChange={(kind) => {
                  setEntityKind(kind);
                  setIndexOffset(0);
                }}
              />
            ) : (
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div role="tablist" aria-label="Filter by kind" className="flex items-center gap-1">
                {KINDS.map((option) => (
                  <Pill
                    key={option.label}
                    active={kind === option.value}
                    label={option.label}
                    onClick={() => {
                      setKind(option.value);
                      reset();
                    }}
                  />
                ))}
              </div>
              <p className="text-label-12 text-gray-700">
                Narrow with <code className="font-mono text-gray-900">site:example.com</code>, <code className="font-mono text-gray-900">after:2026-09-01</code>,{" "}
                <code className="font-mono text-gray-900">before:</code> · dates are UTC
              </p>
            </div>
            )}
          </div>

          {error !== null || notice !== null || stats.nearFull || !settings.enabled || (view === "index" && (!settings.smartIndex || (index?.pending ?? 0) > 0)) ? (
            <div className="flex shrink-0 flex-col gap-2 border-b border-alpha-400 px-5 py-3 @max-md:px-3">
              {view === "index" ? <IndexNote smartIndex={settings.smartIndex} pending={index?.pending ?? 0} busy={status.busy} onEnable={() => void status.configure({ smartIndex: true })} /> : null}
              {error === null ? null : (
                <Note type="error" size="sm">
                  {error}
                </Note>
              )}
              {notice === null ? null : (
                <Note type="secondary" size="sm">
                  {notice}
                </Note>
              )}
              {!settings.enabled ? (
                <Note type="secondary" size="sm" action={<NoteAction label="Settings" onClick={() => openSettings("watchtower")} />}>
                  Watchtower is off. What it already saved stays readable here.
                </Note>
              ) : stats.full ? (
                <Note type="warning" size="sm" action={<NoteAction label="Storage settings" onClick={() => openSettings("watchtower")} />} data-testid="watchtower-full">
                  The archive reached its storage limit, so new pages are not being saved. Everything already saved is kept.
                </Note>
              ) : stats.nearFull ? (
                <Note type="warning" size="sm" action={<NoteAction label="Storage settings" onClick={() => openSettings("watchtower")} />} data-testid="watchtower-near-full">
                  The archive is within a tenth of its storage limit. Saving pauses when it is reached.
                </Note>
              ) : null}
            </div>
          ) : null}

          <div className="relative flex min-h-0 flex-1">
            <main
              className={cn("scroll-thin min-w-0 overflow-y-auto", shown === null ? "flex-1" : "w-100 shrink-0 border-r border-alpha-400 @max-3xl:w-full @max-3xl:border-r-0")}
              data-testid="watchtower-list"
            >
              {view === "index" ? (
                index === null ? null : index.entities.length === 0 ? (
                  indexQuery === "" && entityKind === null ? (
                    <Centered
                      icon={<FileClock className="size-6" aria-hidden="true" />}
                      title="Nothing indexed yet"
                      body={settings.smartIndex ? "People, companies, products and ideas appear here as saved pages are read." : "Pages that declare what they are about — a product, an event, a repository — appear here as you save them."}
                    />
                  ) : (
                    <div className="p-5">
                      <Note type="secondary" size="sm">
                        No entry matches. Try another spelling, or search the saved pages themselves.
                      </Note>
                    </div>
                  )
                ) : (
                  <div className={cn("mx-auto w-full pb-6", shown === null && "max-w-190")}>
                    <ul aria-label="Index">
                      {index.entities.map((item) => (
                        <EntityRow
                          key={item.id}
                          entity={item}
                          selected={item.id === selectedEntity && trail.length === 1}
                          onSelect={() => setTrail(item.id === selectedEntity && trail.length === 1 ? [] : [{ type: "entity", id: item.id }])}
                        />
                      ))}
                    </ul>
                    {indexOffset > 0 || index.entities.length === PAGE_SIZE ? (
                      <div className="flex items-center justify-center gap-2 px-5 pt-5">
                        <Button size="sm" variant="secondary" disabled={indexOffset === 0} onClick={() => setIndexOffset(Math.max(0, indexOffset - PAGE_SIZE))}>
                          Previous
                        </Button>
                        <Button size="sm" variant="secondary" disabled={index.entities.length < PAGE_SIZE} onClick={() => setIndexOffset(indexOffset + PAGE_SIZE)}>
                          More
                        </Button>
                      </div>
                    ) : null}
                  </div>
                )
              ) : results === null ? null : results.length === 0 ? (
                fullQuery === "" ? (
                  <Centered icon={<FileClock className="size-6" aria-hidden="true" />} title="Nothing saved yet" body="Pages you read in this Space appear here a moment after you open them." />
                ) : (
                  <div className="p-5">
                    <Note type="secondary" size="sm">
                      Nothing matches. Try fewer or different words, or clear the filters.
                    </Note>
                  </div>
                )
              ) : (
                <div className={cn("mx-auto w-full pb-6", shown === null && "max-w-190")}>
                  {days.map((day, index) => (
                    <section key={`${day.label}-${String(index)}`} aria-label={day.label}>
                      <h2 className="sticky top-0 z-10 border-b border-alpha-400 bg-background-100/95 px-5 py-2 text-label-12 font-medium text-gray-700 backdrop-blur-sm @max-md:px-3">{day.label}</h2>
                      <ul>
                        {day.hits.map((hit) => (
                          <VisitRow
                            key={hit.observationId}
                            hit={hit}
                            selected={hit.observationId === selected && trail.length === 1}
                            onSelect={() => setTrail(hit.observationId === selected && trail.length === 1 ? [] : [{ type: "page", id: hit.observationId }])}
                          />
                        ))}
                      </ul>
                    </section>
                  ))}
                  {offset > 0 || results.length === PAGE_SIZE ? (
                    <div className="flex items-center justify-center gap-2 px-5 pt-5">
                      <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                        Newer
                      </Button>
                      <Button size="sm" variant="secondary" disabled={results.length < PAGE_SIZE} onClick={() => setOffset(offset + PAGE_SIZE)}>
                        Older
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
            </main>
            {shown?.type === "entity" ? (
              <aside
                key={`entity-${String(shown.id)}`}
                aria-label={entity === null ? "Index entry" : `Index entry: ${entity.name}`}
                data-testid="watchtower-entity-pane"
                className="scroll-thin min-w-0 flex-1 overflow-y-auto bg-background-100 @max-3xl:absolute @max-3xl:inset-0"
              >
                {entity === null ? (
                  <p className="p-6 text-copy-13 text-gray-700">Opening entry…</p>
                ) : (
                  <EntityReader
                    entity={entity}
                    busy={editing}
                    onBack={back}
                    onOpenPage={(id) => push({ type: "page", id })}
                    onOpenEntity={(id) => push({ type: "entity", id })}
                    onSearch={(name) => {
                      switchView("timeline");
                      setQuery(`"${name.replace(/"/gu, "")}"`);
                      reset();
                    }}
                    onEdit={(edit) => void editEntity(entity.id, edit)}
                  />
                )}
              </aside>
            ) : shown?.type === "page" ? (
              <aside
                key={`page-${shown.id}`}
                aria-label={document === null ? "Saved page" : `Saved page: ${document.title}`}
                data-testid="watchtower-document"
                className="scroll-thin min-w-0 flex-1 overflow-y-auto bg-background-100 @max-3xl:absolute @max-3xl:inset-0"
              >
                {document === null ? (
                  <p className="p-6 text-copy-13 text-gray-700">Opening saved text…</p>
                ) : (
                  <Reader
                    document={document}
                    diff={diff}
                    onBack={back}
                    onSelect={(id) => replace({ type: "page", id })}
                    onFollow={(id) => push({ type: "page", id })}
                    onOpenEntity={(id) => push({ type: "entity", id })}
                    onOpen={(url) => void openTab(url)}
                    onCompare={(before) => void compare(before, document)}
                    onCloseDiff={() => setDiff(undefined)}
                    onForget={setForgetting}
                  />
                )}
              </aside>
            ) : null}
          </div>
        </>
      )}

      {forgetting === null ? null : (
        <ForgetDialog
          scope={forgetting}
          busy={status.busy}
          error={status.error}
          onClose={() => {
            status.clearError();
            setForgetting(null);
          }}
          onConfirm={() => {
            void status.forget(forgetRequest(forgetting)).then((done) => {
              if (!done) return;
              setForgetting(null);
              setTrail([]);
            });
          }}
        />
      )}
    </div>
  );
}

/* --------------------------------- pieces -------------------------------- */

const count = (n: number, noun: string): string => `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;

function groupByDay(hits: WatchtowerHit[]): { label: string; hits: WatchtowerHit[] }[] {
  const days: { label: string; hits: WatchtowerHit[] }[] = [];
  const now = Date.now();
  for (const hit of hits) {
    const label = formatDay(hit.visitedAt, now);
    // Ranked results are not in date order: a day may come up more than once,
    // and a second heading is truer than pretending the list is a calendar.
    const last = days[days.length - 1];
    if (last !== undefined && last.label === label) last.hits.push(hit);
    else days.push({ label, hits: [hit] });
  }
  return days;
}

function CaptureBadge({ paused, full }: { paused: boolean; full: boolean }) {
  if (full)
    return (
      <Badge variant="amber-subtle" size="sm">
        Storage full
      </Badge>
    );
  if (paused)
    return (
      <Badge variant="gray-subtle" size="sm">
        Paused
      </Badge>
    );
  return (
    <Badge variant="green-subtle" size="sm" icon={<span className="size-1.5 rounded-full bg-green-700" />}>
      Saving
    </Badge>
  );
}

function NoteAction({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <Button size="xs" variant="secondary" onClick={onClick}>
      {label}
    </Button>
  );
}

function Pill({ active, label, onClick, testId }: { active: boolean; label: string; onClick(): void; testId?: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "flex h-7 shrink-0 cursor-pointer items-center rounded-full px-3 text-label-12 whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-gray-1000 text-background-100" : "text-gray-900 hover:bg-alpha-100 hover:text-gray-1000",
      )}
    >
      {label}
    </button>
  );
}

function Centered({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-5 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-lg bg-background-200 text-gray-700 shadow-border">{icon}</span>
      <h2 className="text-heading-16 text-gray-1000">{title}</h2>
      <p className="text-copy-13 text-gray-900">{body}</p>
    </div>
  );
}

/**
 * Turning Watchtower on. The two choices here are the two ways saved text
 * can leave the machine, so they are made where capture starts, not found
 * later in settings.
 */
function TurnOn({
  busy,
  error,
  saved,
  onSaved,
  onEnable,
}: {
  busy: boolean;
  error: string | null;
  saved: number;
  onSaved(): void;
  onEnable(choices: { smartFilter: boolean; smartIndex: boolean; agentAccess: boolean }): void;
}) {
  const [smartFilter, setSmartFilter] = useState(true);
  const [smartIndex, setSmartIndex] = useState(true);
  const [agentAccess, setAgentAccess] = useState(false);
  return (
    <div className="scroll-thin flex-1 overflow-y-auto" data-testid="watchtower-onboarding">
      <div className="mx-auto flex max-w-130 flex-col gap-5 px-5 py-14">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="grid size-12 place-items-center rounded-lg bg-background-200 text-gray-700 shadow-border">
            <FileClock className="size-6" aria-hidden="true" />
          </span>
          <h2 className="text-heading-20 text-gray-1000">Find what you read</h2>
          <p className="max-w-105 text-copy-14 text-gray-900">
            Watchtower saves the readable text of pages you view, so you can search by what you remember and open the version you saw — even after the page changes.
          </p>
        </div>
        <div className="divide-y divide-alpha-400 rounded-md bg-background-100 shadow-border">
          <Choice
            label="Leave out ads, sidebars and menus with Jev"
            note={`The first time a site’s layout is seen, short excerpts of the page’s regions go to the Jev decision model through your Pistachio account. ${WATCHTOWER_COPY.filterOff}`}
          >
            <Switch checked={smartFilter} onChange={setSmartFilter} label="Filter ads and page furniture with Jev" />
          </Choice>
          <Choice
            label="Index people, companies and ideas with Jev"
            note={`So “Stripe” read on three sites is one entry with three sources. Names found on a page and the sentence around each go to the Jev decision model through your Pistachio account. ${WATCHTOWER_COPY.indexOff}`}
          >
            <Switch checked={smartIndex} onChange={setSmartIndex} label="Index people, companies and ideas with Jev" />
          </Choice>
          <Choice label="Let the agent search what you saved" note="Only when you ask it to. Text it retrieves is sent to your agent’s model.">
            <Switch checked={agentAccess} onChange={setAgentAccess} label="Let the agent search saved pages" />
          </Choice>
        </div>
        {error === null ? null : (
          <Note type="error" size="sm">
            {error}
          </Note>
        )}
        <div className="flex flex-col items-center gap-3">
          <Button loading={busy} onClick={() => onEnable({ smartFilter, smartIndex, agentAccess })}>
            Enable Watchtower
          </Button>
          <p className="max-w-105 text-center text-label-12 text-gray-700">{WATCHTOWER_COPY.local} Pause it, exclude sites, or forget anything at any time. The archive is not encrypted by the app.</p>
          <p className="max-w-105 text-center text-label-12 text-gray-700">
            Tapping shift twice on a page saves it either way, and keeps its text here.
            {saved > 0 ? (
              <>
                {" "}
                <button type="button" onClick={onSaved} className="cursor-pointer text-gray-1000 underline decoration-gray-500 underline-offset-2 outline-none hover:decoration-gray-1000 focus-visible:ring-2 focus-visible:ring-ring">
                  See {count(saved, "saved page")}
                </button>
              </>
            ) : null}
          </p>
        </div>
      </div>
    </div>
  );
}

function Choice({ label, note, children }: { label: string; note: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-5 px-4 py-3.5">
      <div className="min-w-0">
        <p className="text-label-14 text-gray-1000">{label}</p>
        <p className="mt-1 text-copy-13 leading-4.5 text-gray-900">{note}</p>
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

function VisitRow({ hit, selected, onSelect }: { hit: WatchtowerHit; selected: boolean; onSelect(): void }) {
  const coverage = coverageLabel(hit.coverage);
  return (
    <li data-testid="watchtower-result" data-kind={hit.kind}>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          "flex w-full cursor-pointer flex-col gap-1 border-b border-alpha-200 px-5 py-3 text-left outline-none transition-colors focus-visible:bg-gray-100 @max-md:px-3",
          selected ? "bg-gray-100" : "hover:bg-alpha-100",
        )}
      >
        <span className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-label-14 font-medium text-gray-1000">{hit.title || hostOfUrl(hit.url)}</span>
          <time className="shrink-0 text-label-12 text-gray-700 tabular-nums">{formatTime(hit.visitedAt)}</time>
        </span>
        {hit.snippet === "" ? null : <span className="line-clamp-2 text-copy-13 text-gray-900">{hit.snippet}</span>}
        <span className="mt-0.5 flex items-center gap-2 text-label-12 text-gray-700">
          <span className="truncate font-mono">{hostOfUrl(hit.url)}</span>
          <span aria-hidden="true">·</span>
          <span>{KIND_LABEL[hit.kind]}</span>
          {hit.kept ? (
            <Badge variant="blue-subtle" size="sm" data-testid="watchtower-kept">
              Saved
            </Badge>
          ) : null}
          {coverage === null ? null : (
            <Badge variant="gray-subtle" size="sm">
              {coverage}
            </Badge>
          )}
        </span>
      </button>
    </li>
  );
}

function Reader({
  document,
  diff,
  onBack,
  onSelect,
  onFollow,
  onOpenEntity,
  onOpen,
  onCompare,
  onCloseDiff,
  onForget,
}: {
  document: WatchtowerDocument;
  diff: WatchtowerResponse["diff"];
  onBack(): void;
  /** Another version of this page, in place. */
  onSelect(observationId: string): void;
  /** Another saved page, stacked on this one. */
  onFollow(observationId: string): void;
  onOpenEntity(id: number): void;
  onOpen(url: string): void;
  onCompare(before: WatchtowerHit): void;
  onCloseDiff(): void;
  onForget(scope: ForgetScope): void;
}) {
  // Versions that hold text, newest first; "what changed" compares with the one before.
  const versions = document.history.filter((hit) => hit.snapshotId !== null);
  const at = versions.findIndex((hit) => hit.observationId === document.observationId);
  const older = at === -1 ? undefined : versions.slice(at + 1).find((hit) => hit.snapshotId !== document.snapshotId);
  const [card, ...body] = document.blocks;
  const host = hostOfUrl(document.url);
  return (
    <article className="mx-auto flex w-full max-w-180 flex-col gap-5 px-8 pt-5 pb-16 @max-md:px-4">
      <div className="flex items-center gap-2">
        <Button variant="tertiary" size="sm" svgOnly aria-label="Back to results" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </Button>
        <span className="truncate font-mono text-label-12 text-gray-700">{host}</span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="secondary" suffix={<ArrowUpRight aria-hidden="true" />} onClick={() => onOpen(document.url)}>
            Open live
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onOpen(`pistachio://watchtower/v/${document.observationId}`)}>
            Open saved tab
          </Button>
        </div>
      </div>

      <header className="flex flex-col gap-2">
        <h2 className="text-heading-24 text-gray-1000">{document.title || host}</h2>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label-13 text-gray-900">
          <span>Visited {formatMoment(document.visitedAt)}</span>
          <span aria-hidden="true" className="text-gray-600">
            ·
          </span>
          <span>{KIND_LABEL[document.kind]}</span>
          {document.coverage === "complete" ? null : (
            <Badge variant="amber-subtle" size="sm">
              {coverageLabel(document.coverage)}
            </Badge>
          )}
        </p>
      </header>

      <EntityChips label="About" entities={document.entities.slice(0, 10)} onOpen={onOpenEntity} />

      {versions.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-background-200 px-3 py-2 shadow-border">
          <span className="text-label-13 text-gray-900">Saved version</span>
          <Select
            aria-label="Saved version"
            value={document.observationId}
            items={versions.map((hit) => ({ value: hit.observationId, label: new Date(hit.capturedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" }) }))}
            onValueChange={onSelect}
            className="w-60"
          />
          <Button
            size="sm"
            variant="tertiary"
            prefix={<GitCompareArrows aria-hidden="true" />}
            disabled={older === undefined}
            onClick={() => (older === undefined ? undefined : onCompare(older))}
            className="ml-auto"
          >
            What changed
          </Button>
        </div>
      ) : null}

      {diff === undefined ? (
        <>
          {document.coverage === "complete" ? null : (
            <Note type={document.coverage === "partial" ? "warning" : "secondary"} size="sm">
              {COVERAGE_NOTE[document.coverage]}
            </Note>
          )}
          {card === undefined ? null : <SavedCard block={card} />}
          <div className="flex flex-col gap-3.5">
            {body.map((block, index) => (
              <SavedBlock key={index} block={block} />
            ))}
          </div>
        </>
      ) : (
        <section className="flex flex-col gap-3" data-testid="watchtower-diff" aria-label="What changed">
          <div className="flex items-center gap-2">
            <h3 className="text-heading-14 text-gray-1000">Changes since {formatMoment(diff.before.capturedAt)}</h3>
            <Button variant="tertiary" size="xs" svgOnly aria-label="Close comparison" onClick={onCloseDiff} className="ml-auto">
              <X aria-hidden="true" />
            </Button>
          </div>
          {diff.removed.length === 0 && diff.added.length === 0 ? (
            <Note type="secondary" size="sm">
              The saved text is the same in both versions.
            </Note>
          ) : (
            <>
              {diff.removed.length === 0 ? null : (
                <div className="flex flex-col gap-2">
                  <p className="text-label-12 font-medium text-gray-700">Before</p>
                  {diff.removed.map((block, index) => (
                    <SavedBlock key={index} block={block} tone="removed" />
                  ))}
                </div>
              )}
              {diff.added.length === 0 ? null : (
                <div className="flex flex-col gap-2">
                  <p className="text-label-12 font-medium text-gray-700">Now</p>
                  {diff.added.map((block, index) => (
                    <SavedBlock key={index} block={block} tone="added" />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {document.links.length === 0 ? null : (
        <LinkList
          title={`Links on this page (${String(document.links.length)})`}
          items={document.links.map((link) => ({
            key: link.url,
            label: link.text || link.url,
            saved: link.observationId !== undefined,
            onClick: () => (link.observationId === undefined ? onOpen(link.url) : onFollow(link.observationId)),
          }))}
        />
      )}
      {document.backlinks.length === 0 ? null : (
        <LinkList
          title="Saved pages that link here"
          items={document.backlinks.map((hit) => ({
            key: hit.observationId,
            label: hit.title || hostOfUrl(hit.url),
            detail: formatMoment(hit.visitedAt),
            saved: true,
            onClick: () => onFollow(hit.observationId),
          }))}
        />
      )}

      <footer className="mt-2 flex flex-wrap items-center gap-2 border-t border-alpha-400 pt-4">
        <p className="min-w-0 flex-1 truncate font-mono text-label-12 text-gray-700">{document.url}</p>
        <Button size="sm" variant="tertiary" prefix={<Trash2 aria-hidden="true" />} onClick={() => onForget({ kind: "page", pageId: document.pageId, title: document.title || host })}>
          Forget this page
        </Button>
        <Button size="sm" variant="tertiary" onClick={() => onForget({ kind: "site", host })}>
          Forget this site
        </Button>
      </footer>
    </article>
  );
}

function LinkList({ title, items }: { title: string; items: { key: string; label: string; detail?: string; saved: boolean; onClick(): void }[] }) {
  return (
    <details className="rounded-md shadow-border">
      <summary className="cursor-pointer list-none px-3.5 py-2.5 text-label-13 text-gray-1000 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring">{title}</summary>
      <ul className="divide-y divide-alpha-200 border-t border-alpha-400">
        {items.map((item) => (
          <li key={item.key}>
            <button type="button" onClick={item.onClick} className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-2 text-left outline-none hover:bg-alpha-100 focus-visible:bg-gray-100">
              <span className="min-w-0 flex-1 truncate text-label-13 text-gray-1000">{item.label}</span>
              {item.detail === undefined ? null : <span className="shrink-0 text-label-12 text-gray-700">{item.detail}</span>}
              {item.saved ? (
                <Badge variant="gray-subtle" size="sm">
                  Saved
                </Badge>
              ) : (
                <ArrowUpRight className="size-3.5 shrink-0 text-gray-700" aria-hidden="true" />
              )}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
