/**
 * Watchtower: what the person read, found again. `pistachio://watchtower`.
 *
 * A chrome overlay like Bookmarks, and built the same way: a header that
 * says what this is and how much of it there is, a recessed strip to search
 * and filter, a list, and a detail pane beside it. The list is a timeline —
 * visits under the day they happened — because "when" is the one thing a
 * person always half-remembers. How capture BEHAVES is not here: that is
 * Settings → Watchtower, one click from the header.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, FileClock, GitCompareArrows, Pause, Play, Search, Settings2, Sparkles, Trash2, X } from "lucide-react";
import type { WatchtowerDocument, WatchtowerHit, WatchtowerResponse } from "@pistachio/shell-contracts/watchtower";
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
import { ForgetDialog, forgetRequest, type ForgetScope } from "./ForgetDialog";
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

export function WatchtowerPage() {
  const setOverlay = useAppStore((state) => state.setOverlay);
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
  const [selected, setSelected] = useState<string | null>(null);
  const [document, setDocument] = useState<WatchtowerDocument | null>(null);
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (selected !== null) setSelected(null);
      else setOverlay("none");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, setOverlay]);

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
            {stats === null || settings === null ? "Loading…" : `${count(stats.visits, "visit")} · ${count(stats.snapshots, "saved version")} · ${spaceName}`}
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
      ) : settings === null || stats === null ? (
        error === null ? null : (
          <div className="p-5">
            <Note type="error" size="sm">
              {error}
            </Note>
          </div>
        )
      ) : !settings.enabled && stats.visits === 0 ? (
        <TurnOn busy={status.busy} error={error} onEnable={(choices) => void status.configure({ enabled: true, ...choices })} />
      ) : (
        <>
          <div className="flex shrink-0 flex-col gap-3 border-b border-alpha-400 bg-background-200 px-5 py-3 @max-md:px-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                ref={searchRef}
                size="sm"
                aria-label="Search Watchtower"
                placeholder="Search what you read — words from the page, a name, “an exact phrase”"
                prefix={<Search aria-hidden="true" />}
                affixStyling={false}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  reset();
                }}
                className="min-w-60 flex-1"
                data-testid="watchtower-search"
              />
              {settings.remoteRerank && query.trim() !== "" ? (
                <Button size="sm" variant="secondary" prefix={<Sparkles aria-hidden="true" />} loading={improving} onClick={() => void improve()}>
                  Improve matches
                </Button>
              ) : null}
            </div>
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
          </div>

          {error !== null || notice !== null || stats.nearFull || !settings.enabled ? (
            <div className="flex shrink-0 flex-col gap-2 border-b border-alpha-400 px-5 py-3 @max-md:px-3">
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
              className={cn("scroll-thin min-w-0 overflow-y-auto", selected === null ? "flex-1" : "w-100 shrink-0 border-r border-alpha-400 @max-3xl:w-full @max-3xl:border-r-0")}
              data-testid="watchtower-list"
            >
              {results === null ? null : results.length === 0 ? (
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
                <div className={cn("mx-auto w-full pb-6", selected === null && "max-w-190")}>
                  {days.map((day, index) => (
                    <section key={`${day.label}-${String(index)}`} aria-label={day.label}>
                      <h2 className="sticky top-0 z-10 border-b border-alpha-400 bg-background-100/95 px-5 py-2 text-label-12 font-medium text-gray-700 backdrop-blur-sm @max-md:px-3">{day.label}</h2>
                      <ul>
                        {day.hits.map((hit) => (
                          <VisitRow key={hit.observationId} hit={hit} selected={hit.observationId === selected} onSelect={() => setSelected(hit.observationId === selected ? null : hit.observationId)} />
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
            {selected === null ? null : (
              <aside
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
                    onBack={() => setSelected(null)}
                    onSelect={setSelected}
                    onOpen={(url) => void openTab(url)}
                    onCompare={(before) => void compare(before, document)}
                    onCloseDiff={() => setDiff(undefined)}
                    onForget={setForgetting}
                  />
                )}
              </aside>
            )}
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
              setSelected(null);
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

function Pill({ active, label, onClick }: { active: boolean; label: string; onClick(): void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
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
function TurnOn({ busy, error, onEnable }: { busy: boolean; error: string | null; onEnable(choices: { smartFilter: boolean; agentAccess: boolean }): void }) {
  const [smartFilter, setSmartFilter] = useState(true);
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
          <Button loading={busy} onClick={() => onEnable({ smartFilter, agentAccess })}>
            Enable Watchtower
          </Button>
          <p className="max-w-105 text-center text-label-12 text-gray-700">{WATCHTOWER_COPY.local} Pause it, exclude sites, or forget anything at any time. The archive is not encrypted by the app.</p>
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
  onOpen,
  onCompare,
  onCloseDiff,
  onForget,
}: {
  document: WatchtowerDocument;
  diff: WatchtowerResponse["diff"];
  onBack(): void;
  onSelect(observationId: string): void;
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
            onClick: () => (link.observationId === undefined ? onOpen(link.url) : onSelect(link.observationId)),
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
            onClick: () => onSelect(hit.observationId),
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
