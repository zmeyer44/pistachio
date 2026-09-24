/**
 * The tab archive (docs/tab-tidy.md §3.6): tabs Tidy put away for going idle,
 * and groups that were closed, for the active Space — each one a click from
 * being open again, exactly where it was.
 *
 * A chrome overlay like Watchtower and Bookmarks, and built the same way: a
 * header that says what this is and how much of it there is, a recessed strip
 * to filter, and a list under the day each thing was archived. A group is one
 * row that opens to its tabs, restored whole or one tab at a time. How Tidy
 * BEHAVES is not here: that is Settings → Tabs, one click from the header.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, ChevronRight, Search, Settings2, Trash2, X } from "lucide-react";
import { archiveEntryTabCount, type ArchivedTabView, type ArchiveEntryView } from "@pistachio/shell-contracts/tab-archive";
import { isShellUnsupported } from "@pistachio/shell-contracts/socket";
import { shellApi } from "../../api";
import { cn } from "../../lib/cn";
import { prettyUrl } from "../../lib/url";
import { useAppStore } from "../../store";
import { Favicon } from "../Favicon";
import { FaviconCluster } from "../TabGroupRow";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Note } from "../ui/note";
import { formatDay, formatTime, hostOfUrl } from "../watchtower/format";

const count = (n: number, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`;

function hoursLabel(hours: number): string {
  if (hours <= 0) return "";
  return hours < 48 ? `${String(hours)} hours` : `${String(Math.round(hours / 24))} days`;
}

/** Whether an entry answers the filter: any of its tabs' titles or addresses, or its group's title. */
function matches(entry: ArchiveEntryView, needle: string): boolean {
  if (needle === "") return true;
  const hit = (tab: ArchivedTabView): boolean => tab.title.toLowerCase().includes(needle) || tab.url.toLowerCase().includes(needle);
  return entry.kind === "tab" ? hit(entry.tab) : entry.group.title.toLowerCase().includes(needle) || entry.tabs.some(hit);
}

function groupByDay(entries: readonly ArchiveEntryView[]): Array<{ day: string; entries: ArchiveEntryView[] }> {
  const days: Array<{ day: string; entries: ArchiveEntryView[] }> = [];
  for (const entry of entries) {
    const day = formatDay(entry.archivedAt);
    const last = days.at(-1);
    if (last !== undefined && last.day === day) last.entries.push(entry);
    else days.push({ day, entries: [entry] });
  }
  return days;
}

function TabLine({ tab, onRestore, testId }: { tab: ArchivedTabView; onRestore: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onRestore}
      title={`Restore\n${prettyUrl(tab.url)}`}
      data-testid={testId}
      className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Favicon src={tab.faviconUrl} seed={hostOfUrl(tab.url) || tab.title} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-label-13 text-gray-1000">{tab.title || prettyUrl(tab.url)}</span>
        <span className="block truncate text-label-12 text-gray-700">{hostOfUrl(tab.url)}</span>
      </span>
    </button>
  );
}

export function ArchivePage() {
  const setOverlay = useAppStore((state) => state.setOverlay);
  const openSettings = useAppStore((state) => state.openSettings);
  const spaceId = useAppStore((state) => state.snapshot?.activeSpaceId ?? null);
  const spaceName = useAppStore((state) => state.snapshot?.spaces.find((space) => space.id === state.snapshot?.activeSpaceId)?.name ?? "This Space");
  const archiveAfterHours = useAppStore((state) => state.settings.tabs.archiveAfterHours);

  const [entries, setEntries] = useState<ArchiveEntryView[] | null>(null);
  const [retentionDays, setRetentionDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (): Promise<void> => {
    if (spaceId === null) return;
    try {
      const response = await shellApi().tabArchive({ type: "list", spaceId });
      if (response.type !== "list") return;
      setEntries(response.entries);
      setRetentionDays(response.retentionDays);
      setError(null);
    } catch (failure: unknown) {
      const message = failure instanceof Error ? failure.message : String(failure);
      if (isShellUnsupported(failure)) setUnavailable(message);
      else setError(message);
    }
  }, [spaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOverlay("none");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setOverlay]);

  /** Restoring shows the tab, so the page gets out of its way. */
  const restore = async (entryId: string, tabIndex?: number): Promise<void> => {
    try {
      const response = await shellApi().tabArchive({ type: "restore", entryId, ...(tabIndex === undefined ? {} : { tabIndex }) });
      if (response.type === "done" && response.ok) setOverlay("none");
      else await load();
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const remove = async (entryId: string): Promise<void> => {
    setEntries((current) => current?.filter((entry) => entry.id !== entryId) ?? null);
    try {
      await shellApi().tabArchive({ type: "remove", entryId });
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : String(failure));
      await load();
    }
  };
  const clear = async (): Promise<void> => {
    if (spaceId === null || entries === null || entries.length === 0) return;
    const total = entries.reduce((sum, entry) => sum + archiveEntryTabCount(entry), 0);
    if (!window.confirm(`Forget ${count(total, "archived tab")} in ${spaceName}? This cannot be undone.`)) return;
    try {
      await shellApi().tabArchive({ type: "clear", spaceId });
      await load();
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => (entries ?? []).filter((entry) => matches(entry, needle)), [entries, needle]);
  const days = useMemo(() => groupByDay(shown), [shown]);
  const total = (entries ?? []).reduce((sum, entry) => sum + archiveEntryTabCount(entry), 0);
  const rule = archiveAfterHours > 0 ? `Tabs you have not looked at for ${hoursLabel(archiveAfterHours)} are archived` : "Tabs are archived only when you tidy";

  return (
    <div
      role="dialog"
      aria-label="Archived tabs"
      data-testid="archive-page"
      className="@container animate-backdrop-in absolute inset-0 z-20 flex flex-col overflow-hidden rounded-md bg-background-100 shadow-small"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-alpha-400 px-5 py-3 @max-md:px-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-gray-100 text-gray-1000 shadow-border">
          <Archive className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="text-heading-16 text-gray-1000">Archived tabs</h1>
          <p className="truncate text-label-12 text-gray-700" data-testid="archive-summary">
            {entries === null ? (unavailable === null ? "Loading…" : spaceName) : `${count(total, "tab")} · ${spaceName}`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {entries !== null && entries.length > 0 ? (
            <Button size="sm" variant="secondary" prefix={<Trash2 aria-hidden="true" />} onClick={() => void clear()} className="@max-md:hidden" data-testid="archive-clear">
              Clear archive
            </Button>
          ) : null}
          <Button variant="tertiary" size="sm" svgOnly aria-label="Tab settings" onClick={() => openSettings("tabs")}>
            <Settings2 aria-hidden="true" />
          </Button>
          <Kbd className="@max-md:hidden">esc</Kbd>
          <Button variant="tertiary" size="sm" svgOnly aria-label="Close archive" onClick={() => setOverlay("none")}>
            <X aria-hidden="true" />
          </Button>
        </div>
      </header>

      {unavailable !== null ? (
        <Empty title="The archive is on your desktop" body={unavailable} />
      ) : (
        <>
          <div className="flex shrink-0 flex-col gap-2 border-b border-alpha-400 bg-background-200 px-5 py-3 @max-md:px-3">
            <Input
              ref={searchRef}
              size="sm"
              aria-label="Filter archived tabs"
              placeholder="Filter by title, site, or group"
              prefix={<Search aria-hidden="true" />}
              affixStyling={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              data-testid="archive-filter"
            />
            <p className="text-label-12 text-gray-700">
              {rule}, and kept here for {count(retentionDays, "day")}.{" "}
              <button type="button" onClick={() => openSettings("tabs")} className="cursor-pointer text-gray-1000 underline decoration-alpha-500 underline-offset-2 outline-none hover:decoration-gray-1000 focus-visible:ring-2 focus-visible:ring-ring">
                Change
              </button>
            </p>
          </div>

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4 @max-md:px-3">
            {error !== null ? (
              <Note type="error" size="sm" className="mb-3">
                {error}
              </Note>
            ) : null}
            {entries === null ? null : entries.length === 0 ? (
              <Empty
                title="Nothing archived yet"
                body="When a tab has gone unlooked-at for a while, Tidy closes it and keeps it here, so your sidebar stays short and nothing is lost. Closed tab groups land here too."
              />
            ) : shown.length === 0 ? (
              <Empty title="No archived tab matches" body="Try a word from the page's title, or the site it was on." />
            ) : (
              <div className="mx-auto flex max-w-3xl flex-col gap-5">
                {days.map((day) => (
                  <section key={day.day} aria-label={day.day}>
                    <h2 className="mb-1.5 px-2 text-label-12 font-medium text-gray-700">{day.day}</h2>
                    <ul className="flex flex-col gap-0.5">
                      {day.entries.map((entry) => (
                        <EntryRow
                          key={entry.id}
                          entry={entry}
                          open={open.has(entry.id) || (needle !== "" && entry.kind === "group")}
                          onToggle={() =>
                            setOpen((current) => {
                              const next = new Set(current);
                              if (next.has(entry.id)) next.delete(entry.id);
                              else next.add(entry.id);
                              return next;
                            })
                          }
                          onRestore={(tabIndex) => void restore(entry.id, tabIndex)}
                          onRemove={() => void remove(entry.id)}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function RowActions({ onRestore, onRemove, restoreLabel }: { onRestore: () => void; onRemove: () => void; restoreLabel: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-focus-within/entry:opacity-100 group-hover/entry:opacity-100 motion-reduce:transition-none">
      <Button size="sm" variant="secondary" prefix={<ArchiveRestore aria-hidden="true" />} onClick={onRestore} data-testid="archive-restore">
        {restoreLabel}
      </Button>
      <Button size="sm" variant="tertiary" svgOnly aria-label="Remove from archive" onClick={onRemove} data-testid="archive-remove">
        <X aria-hidden="true" />
      </Button>
    </span>
  );
}

function EntryRow({
  entry,
  open,
  onToggle,
  onRestore,
  onRemove,
}: {
  entry: ArchiveEntryView;
  open: boolean;
  onToggle: () => void;
  onRestore: (tabIndex?: number) => void;
  onRemove: () => void;
}) {
  const when = `${entry.reason === "closed" ? "Closed" : "Archived"} ${formatTime(entry.archivedAt)}`;
  if (entry.kind === "tab") {
    return (
      <li data-testid="archive-entry" className="group/entry flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-alpha-200">
        <TabLine tab={entry.tab} onRestore={() => onRestore()} testId="archive-entry-open" />
        <span className="shrink-0 text-label-12 text-gray-700 @max-md:hidden">{when}</span>
        <RowActions onRestore={() => onRestore()} onRemove={onRemove} restoreLabel="Restore" />
      </li>
    );
  }
  return (
    <li data-testid="archive-entry" data-group-color={entry.group.color} className="tab-group-tone flex flex-col rounded-md">
      <div className="group/entry flex items-center gap-3 rounded-md bg-(--tg-tint) px-2 py-1.5 hover:bg-(--tg-tint-strong)">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          data-testid="archive-group-toggle"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <FaviconCluster tabs={entry.tabs} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-label-13 font-medium text-(--tg-text)">{entry.group.title}</span>
            <span className="block truncate text-label-12 text-gray-700">
              {count(entry.tabs.length, "tab")} · {[...new Set(entry.tabs.map((tab) => hostOfUrl(tab.url)))].slice(0, 3).join(", ")}
            </span>
          </span>
          <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 text-gray-700 transition-transform duration-150", open && "rotate-90")} />
        </button>
        <span className="shrink-0 text-label-12 text-gray-700 @max-md:hidden">{when}</span>
        <RowActions onRestore={() => onRestore()} onRemove={onRemove} restoreLabel="Restore group" />
      </div>
      {open ? (
        <ul className="mt-0.5 ml-[15px] flex flex-col gap-0.5 border-l-2 border-(--tg-tint-strong) pl-2">
          {entry.tabs.map((tab, index) => (
            <li key={index} className="group/entry flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-alpha-200">
              <TabLine tab={tab} onRestore={() => onRestore(index)} testId="archive-group-tab" />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex max-w-sm flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
      <span className="grid size-10 place-items-center rounded-lg bg-gray-100 text-gray-900 shadow-border">
        <Archive className="size-5" aria-hidden="true" />
      </span>
      <h2 className="text-heading-14 text-gray-1000">{title}</h2>
      <p className="text-label-13 text-gray-700">{body}</p>
    </div>
  );
}
