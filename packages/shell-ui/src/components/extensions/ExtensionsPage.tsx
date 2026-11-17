/**
 * `pistachio://extensions/` (docs/extensions.md §2, *Find and add them*): a
 * shell-drawn page, as Notes is — opened as a desk window from the Ledge's
 * ⋯, the empty Ledge, ⌘L *Extensions*, Settings → Extensions.
 *
 * Its head is one field, *Search extensions, or describe one to make*,
 * which narrows every list below it and, with something typed, ends them
 * with two ways on: *Make "…" with Pistachio* (the Bar, `/extension …`) and
 * *Search the Chrome Web Store for "…"*. Then **On this Mac** (installed:
 * the mark, a line, where it runs, a switch, ⋯ — and, under one that runs by
 * itself, when, where the clock has it, a *Pause*, and what it did with
 * nobody there, each with *Undo*: docs/primitives.md §3; *Pause all* heads
 * the list while any does; under one that has the shell showing something —
 * a mark on a space, a theme — what, each with *Remove*: §4), **Made for Pistachio** (the
 * library, *Turn on*), **Works in Pistachio** (the curated store extensions
 * with their verdicts, *Add* by id with no visit to the store), **Yours**
 * (the dev folder: *New…*, *Make one with Pistachio*, *Build with Claude
 * Code*, *Load a folder…*, and Developer mode), and a foot: *Browse the
 * Chrome Web Store*, *Load a folder…*. Everything here is the snapshot's and
 * every button a request to main.
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Check, CircleAlert, CircleSlash, FolderPlus, Hammer, MoreHorizontal, Pause, Play, Plus, Puzzle, Search, Sparkles, SquareTerminal, Store } from "lucide-react";
import type { ChromeVerdict, ExtensionInfo, ExtensionJournalEntry, ExtensionShown } from "@pistachio/shell-contracts/extensions";
import { cn } from "../../lib/cn";
import {
  buildWithClaudeCode,
  makeWithPistachio,
  openInTab,
  removeShown,
  setAllTriggersPaused,
  setTriggersPaused,
  undoJournalEntry,
} from "../../lib/extensions/actions";
import {
  ALL_PAUSED_LINE,
  JOURNAL_HEADING,
  RUNS_HEADING,
  TRIGGERS_PAUSED_LINE,
  anyTriggers,
  hasRunsBlock,
  hasTriggers,
  journalNewestFirst,
  journalVerbLine,
  formatWhen,
  triggerStateLine,
} from "../../lib/extensions/triggers";
import { SHOWS_HEADING, scopeOf, shownLine } from "../../lib/extensions/shown";
import {
  CHROME_WEB_STORE_URL,
  chromeWebStoreSearchUrl,
  errorPlace,
  extensionMatches,
  ledgeDotOf,
  statusLabel,
  tildePath,
  whereItRuns,
} from "../../lib/extensions/ledge";
import { extensionsRequest, openExtensionSheet, turnOnFromLibrary, useExtensionsState } from "../../lib/extensions/use-extensions";
import { useAppStore } from "../../store";
import { CONTEXT_MENU_W, useContextMenu } from "../ContextMenu";
import { FOCUS, PILL } from "../notes/parts";
import { Switch } from "../ui/switch";
import { ExtensionMark } from "./LedgeIcon";
import { extensionMenuEntries } from "./menu";

const COLUMN = "mx-auto w-full max-w-[760px] px-6 @max-[481px]:px-4";
const TEMPLATES = [
  { id: "panel", label: "A panel", note: "A card beside the sidebar" },
  { id: "bar-command", label: "A / command", note: "A command in the Bar" },
  { id: "agent-tool", label: "An agent tool", note: "Something Pistachio can call" },
] as const;

type Template = (typeof TEMPLATES)[number]["id"];

export function ExtensionsPage({ tabId }: { tabId: string | null; active: boolean }) {
  const snapshot = useExtensionsState((state) => state.snapshot);
  const loaded = useExtensionsState((state) => state.loaded);
  const unsupported = useExtensionsState((state) => state.unsupported);
  const [query, setQuery] = useState("");
  const typed = query.trim();

  const installed = useMemo(
    () => snapshot.extensions.filter((extension) => extensionMatches(extension, typed)).sort((a, b) => a.name.localeCompare(b.name)),
    [snapshot.extensions, typed],
  );
  const installedIds = useMemo(() => new Set(snapshot.extensions.map((extension) => extension.id)), [snapshot.extensions]);
  const storeIds = useMemo(
    () => new Set(snapshot.extensions.flatMap((extension) => (extension.source.type === "webstore" ? [extension.source.cwsId] : []))),
    [snapshot.extensions],
  );
  const library = snapshot.library.filter((entry) => !installedIds.has(entry.id) && extensionMatches(entry, typed));
  const curated = snapshot.curated.filter((entry) => extensionMatches({ name: entry.name, description: entry.description, id: entry.cwsId }, typed));

  return (
    <div data-testid="extensions-page" data-tab-id={tabId ?? undefined} className="@container absolute inset-0 overflow-y-auto bg-background-200 text-gray-1000">
      <div className={cn(COLUMN, "pt-10 pb-16 @max-[561px]:pt-6")}>
        <header className="flex items-end justify-between gap-4">
          <h1 className="text-[34px] leading-[1.05] font-semibold tracking-[-0.04em]">Extensions</h1>
        </header>

        <label className={cn("mt-6 flex h-10 items-center gap-2 rounded-[10px] bg-alpha-100 px-3 transition-colors focus-within:bg-alpha-200", FOCUS)}>
          <Search className="size-4 shrink-0 text-gray-700" strokeWidth={1.75} aria-hidden="true" />
          <input
            type="text"
            data-testid="extensions-search"
            aria-label="Search extensions, or describe one to make"
            placeholder="Search extensions, or describe one to make"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-gray-1000 placeholder:text-gray-700 focus:outline-none"
          />
        </label>

        {unsupported !== null ? (
          <p className="mt-10 text-center text-[14px] text-gray-800" data-testid="extensions-unsupported">
            {unsupported}
          </p>
        ) : (
          <>
            <Section title="On this Mac" testId="extensions-installed">
              {anyTriggers(snapshot.extensions) ? <PauseAll paused={snapshot.triggersPaused === true} /> : null}
              {!loaded ? (
                <Quiet>Reading what is installed…</Quiet>
              ) : installed.length === 0 ? (
                <Quiet>{typed === "" ? "Nothing installed yet. Add one below, or make your own." : `Nothing installed matches “${typed}”.`}</Quiet>
              ) : (
                installed.map((extension) => <InstalledRow key={extension.id} extension={extension} />)
              )}
            </Section>

            {library.length === 0 ? null : (
              <Section title="Made for Pistachio" testId="extensions-library">
                {library.map((entry) => (
                  <Row key={entry.id} testId="extensions-library-row" mark={<ExtensionMark extension={entry} className="extension-row-mark" />} title={entry.name} line={entry.description} meta="Made by Pistachio">
                    {/* (A library entry is not a record yet: main loads it and offers its sheet — nothing turns itself on.
                        The sheet comes up at once: turnOnFromLibrary.) */}
                    <button type="button" className={PILL} data-testid="extensions-library-on" onClick={() => void turnOnFromLibrary(entry.id)}>
                      Turn on
                    </button>
                  </Row>
                ))}
              </Section>
            )}

            {curated.length === 0 ? null : (
              <Section title="Works in Pistachio" note="Popular extensions from the Chrome Web Store, tried here. Added by id, with no visit to the store." testId="extensions-curated">
                {curated.map((entry) => (
                  <Row
                    key={entry.cwsId}
                    testId="extensions-curated-row"
                    mark={<ExtensionMark extension={{ id: entry.cwsId, name: entry.name, iconUrl: entry.iconUrl }} className="extension-row-mark" />}
                    title={entry.name}
                    line={entry.description}
                    meta={<Verdict verdict={entry.verdict} />}
                  >
                    {storeIds.has(entry.cwsId) ? (
                      <span className="flex items-center gap-1 text-[13px] text-gray-700">
                        <Check className="size-3.5" aria-hidden="true" />
                        Added
                      </span>
                    ) : (
                      <button type="button" className={PILL} disabled={entry.verdict.kind === "wont"} data-testid="extensions-curated-add" onClick={() => void addFromStore(entry.cwsId)}>
                        <Plus className="size-3.5" aria-hidden="true" />
                        Add
                      </button>
                    )}
                  </Row>
                ))}
              </Section>
            )}

            {typed === "" ? null : (
              <Section title="Make it, or find it" testId="extensions-ways">
                <WayRow icon={<Sparkles aria-hidden="true" />} testId="extensions-make" label={`Make “${typed}” with Pistachio`} onClick={() => makeWithPistachio(typed)} />
                <WayRow icon={<Store aria-hidden="true" />} testId="extensions-store-search" label={`Search the Chrome Web Store for “${typed}”`} onClick={() => openInTab(chromeWebStoreSearchUrl(typed))} />
              </Section>
            )}

            <Yours devFolder={snapshot.devFolder} developerMode={snapshot.developerMode} wish={typed} />

            <footer className="mt-10 flex flex-wrap items-center gap-2 border-t border-alpha-400 pt-5">
              <button type="button" className={PILL} data-testid="extensions-browse-store" onClick={() => openInTab(CHROME_WEB_STORE_URL)}>
                <Store className="size-3.5" aria-hidden="true" />
                Browse the Chrome Web Store
                <ArrowUpRight className="size-3.5" aria-hidden="true" />
              </button>
              <button type="button" className={PILL} data-testid="extensions-load-folder" onClick={() => void extensionsRequest({ type: "loadFolder" })}>
                <FolderPlus className="size-3.5" aria-hidden="true" />
                Load a folder…
              </button>
              <span className="ml-auto text-[12.5px] text-gray-700">Its Add to Chrome button adds them here.</span>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

/** A store extension by id: main downloads it and reads the real manifest; the sheet comes up (or, won't work, says why). */
async function addFromStore(cwsId: string): Promise<void> {
  const response = await extensionsRequest({ type: "installChrome", cwsId });
  if (response?.type === "verdict" && response.verdict.kind === "wont") useAppStore.getState().showNotice(response.verdict.reason, { tone: "warning" });
}

function Section({ title, note, testId, children }: { title: string; note?: string; testId: string; children: React.ReactNode }) {
  return (
    <section className="mt-9" data-testid={testId}>
      <h2 className="px-3 text-[13px] font-semibold tracking-[-0.005em] text-gray-900">{title}</h2>
      {note === undefined ? null : <p className="mt-0.5 px-3 text-[12.5px] text-gray-700">{note}</p>}
      <ul className="mt-2 flex flex-col">{children}</ul>
    </section>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <li className="px-3 py-3 text-[13.5px] text-gray-700">{children}</li>;
}

function Row({
  testId,
  mark,
  title,
  line,
  meta,
  extensionId,
  children,
}: {
  testId: string;
  mark: React.ReactNode;
  title: string;
  line: React.ReactNode;
  meta?: React.ReactNode;
  extensionId?: string;
  children?: React.ReactNode;
}) {
  return (
    <li data-testid={testId} data-extension-id={extensionId} className="group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-alpha-100">
      <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-background-100 shadow-[0_0_0_1px_var(--color-alpha-300)]">{mark}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14.5px] leading-[20px] font-medium text-gray-1000">{title}</span>
        <span className="truncate text-[13px] leading-[18px] text-gray-800">{line}</span>
        {meta === undefined ? null : <span className="truncate text-[12px] leading-4 text-gray-700">{meta}</span>}
      </span>
      {children === undefined ? null : <span className="flex shrink-0 items-center gap-2">{children}</span>}
    </li>
  );
}

/** An installed extension: what is the matter with it when something is, where it runs, its switch (or *Review*), its ⋯. */
function InstalledRow({ extension }: { extension: ExtensionInfo }) {
  const menu = useContextMenu();
  const dot = ledgeDotOf(extension);
  const place = errorPlace(extension.error);
  const line =
    dot === "red" ? (
      <span className="text-red-900">
        {extension.error?.message ?? statusLabel(extension)}
        {place === null ? null : <span className="ml-1 font-mono text-[11.5px]">{place}</span>}
      </span>
    ) : dot === "amber" ? (
      <span className="text-amber-900">{statusLabel(extension)}</span>
    ) : extension.status === "incompatible" ? (
      <span className="text-gray-700">{extension.verdict?.kind === "wont" ? extension.verdict.reason : statusLabel(extension)}</span>
    ) : (
      extension.description || statusLabel(extension)
    );
  const source = extension.source.type === "dev" ? "Yours" : extension.source.type === "unpacked" ? "Loaded folder" : extension.source.type === "bundled" ? "Made by Pistachio" : "Chrome Web Store";
  return (
    <>
      <Row
        testId="extensions-installed-row"
        extensionId={extension.id}
        mark={<ExtensionMark extension={extension} className="extension-row-mark" />}
        title={extension.name}
        line={line}
        meta={`${whereItRuns(extension)} · ${source}${extension.version === "" ? "" : ` · ${extension.version}`}`}
      >
        {extension.pending !== null ? (
          <button type="button" className={cn(PILL, "bg-amber-100 text-amber-1000 hover:bg-amber-400")} data-testid="extensions-review" onClick={() => openExtensionSheet({ kind: "extension", id: extension.id })}>
            <CircleAlert className="size-3.5" aria-hidden="true" />
            Review
          </button>
        ) : (
          <Switch
            checked={extension.enabled}
            label={`${extension.name} on`}
            disabled={extension.status === "incompatible"}
            onChange={(enabled) => void extensionsRequest({ type: "setEnabled", id: extension.id, enabled })}
          />
        )}
        <button
          type="button"
          aria-label={`${extension.name} menu`}
          data-testid="extensions-row-menu"
          className={cn("grid size-7 cursor-pointer place-items-center rounded-md text-gray-800 hover:bg-alpha-200 hover:text-gray-1000", FOCUS)}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            menu.open({ clientX: box.right - CONTEXT_MENU_W, clientY: box.bottom + 4 }, extensionMenuEntries(extension));
          }}
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </button>
        {menu.menu}
      </Row>
      {hasRunsBlock(extension) ? <RunsByItself extension={extension} /> : null}
      {(extension.shows?.length ?? 0) > 0 ? <WhatItShows extension={extension} /> : null}
    </>
  );
}

/** A clock for lines that say "today" and "Next …": read again each minute, so a row left open does not go stale. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * *Pause all* (docs/primitives.md §3), heading the installed list while anything there runs by itself: one press and
 * no extension does, until *Resume* — each still runs when the person runs it. Paused, it is a banner, not a button
 * that reads the same as before: the state must be seen.
 */
function PauseAll({ paused }: { paused: boolean }) {
  if (paused)
    return (
      <li className="mx-3 mb-1 flex items-center justify-between gap-3 rounded-xl bg-amber-100 px-3 py-2 text-amber-1000" data-testid="extensions-paused-all" role="status">
        <span className="flex min-w-0 items-center gap-2 text-[13.5px] font-medium">
          <Pause className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{ALL_PAUSED_LINE}</span>
        </span>
        <button type="button" className={cn(PILL, "bg-background-100 text-gray-1000")} data-testid="extensions-resume-all" onClick={() => setAllTriggersPaused(false)}>
          <Play className="size-3.5" aria-hidden="true" />
          Resume
        </button>
      </li>
    );
  return (
    <li className="flex items-center justify-between gap-3 px-3 pb-1">
      <span className="min-w-0 truncate text-[12.5px] text-gray-700">Some of these run by themselves.</span>
      <button type="button" className={PILL} data-testid="extensions-pause-all" onClick={() => setAllTriggersPaused(true)}>
        <Pause className="size-3.5" aria-hidden="true" />
        Pause all
      </button>
    </li>
  );
}

/**
 * Under an extension that declares triggers (docs/primitives.md §3): when it runs by itself — main's line for each,
 * and where the clock has it — a *Pause* of its own, and what it did with nobody there: main's journal, in the
 * shell's words, each with the way back. Nothing here is the extension's own text.
 */
function RunsByItself({ extension }: { extension: ExtensionInfo }) {
  const now = useNow();
  const paused = extension.triggersPaused === true;
  // (Under *Pause all* nothing is "next": the banner above says why, and the lines say only when it would.)
  const quiet = useExtensionsState((state) => state.snapshot.triggersPaused === true) || paused;
  const journal = journalNewestFirst(extension.journal);
  // (An update took its triggers out: nothing runs by itself any more, and nothing is left to pause — what it did
  // stays, each line with its Undo. hasRunsBlock.)
  if (!hasTriggers(extension))
    return (
      <li data-testid="extension-triggers" data-extension-id={extension.id} data-paused="false" className="mb-2 ml-[60px] mr-3 rounded-xl bg-alpha-100 px-3 py-2.5 @max-[481px]:ml-3">
        <div data-testid="extension-journal">
          <h3 className="text-[12.5px] font-semibold text-gray-900">{JOURNAL_HEADING}</h3>
          <ul className="mt-1 flex flex-col gap-0.5">
            {journal.map((entry) => (
              <JournalRow key={entry.id} entry={entry} now={now} />
            ))}
          </ul>
        </div>
      </li>
    );
  return (
    <li data-testid="extension-triggers" data-extension-id={extension.id} data-paused={paused ? "true" : "false"} className="mb-2 ml-[60px] mr-3 rounded-xl bg-alpha-100 px-3 py-2.5 @max-[481px]:ml-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[12.5px] font-semibold text-gray-900">{RUNS_HEADING}</h3>
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-gray-800">
          Pause
          <span className="inline-flex" data-testid="extension-triggers-pause">
            <Switch checked={paused} label={`Pause ${extension.name}`} onChange={(value) => setTriggersPaused(extension.id, value)} />
          </span>
        </label>
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {(extension.triggers ?? []).map((trigger) => {
          const state = quiet ? null : triggerStateLine(trigger, now);
          return (
            <li key={trigger.id} data-testid="extension-trigger-line" data-trigger-id={trigger.id} data-holds={trigger.holds === undefined ? undefined : String(trigger.holds)} data-unknown={trigger.unknown === true ? "true" : undefined} className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className={cn("text-[13.5px]", quiet ? "text-gray-700" : "text-gray-1000")}>{trigger.text}</span>
              {state === null ? null : (
                <span className="text-[12.5px] text-gray-700" data-testid="extension-trigger-state">
                  {state}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {paused ? (
        <p className="mt-1.5 text-[12.5px] text-amber-900" data-testid="extension-triggers-paused">
          {TRIGGERS_PAUSED_LINE}
        </p>
      ) : null}
      {journal.length === 0 ? null : (
        <div className="mt-2.5 border-t border-alpha-300 pt-2" data-testid="extension-journal">
          <h4 className="text-[12px] font-medium text-gray-700">{JOURNAL_HEADING}</h4>
          <ul className="mt-1 flex flex-col gap-0.5">
            {journal.map((entry) => (
              <JournalRow key={entry.id} entry={entry} now={now} />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/** One thing it did with nobody there, and the way back — *Undo*, once; undone, the line says so. */
function JournalRow({ entry, now }: { entry: ExtensionJournalEntry; now: number }) {
  const [busy, setBusy] = useState(false);
  const undone = entry.undone !== undefined;
  const undo = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    await undoJournalEntry(entry.id);
    setBusy(false);
  };
  return (
    <li data-testid="extension-journal-entry" data-entry-id={entry.id} data-verb={entry.verb} data-undone={undone ? "true" : "false"} className="flex min-h-[26px] items-center justify-between gap-3">
      <span className={cn("min-w-0 truncate text-[13px]", undone ? "text-gray-700" : "text-gray-1000")}>
        {journalVerbLine(entry)}
        <span className="text-gray-700"> · {formatWhen(entry.at, now)}</span>
      </span>
      {undone ? (
        <span className="shrink-0 text-[12.5px] text-gray-700" data-testid="extension-journal-undone">
          Undone
        </span>
      ) : (
        <button
          type="button"
          disabled={busy}
          data-testid="extension-journal-undo"
          className={cn("shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-[12.5px] font-medium text-gray-900 hover:bg-alpha-200 hover:text-gray-1000 disabled:cursor-default disabled:opacity-60", FOCUS)}
          onClick={() => void undo()}
        >
          Undo
        </button>
      )}
    </li>
  );
}

/**
 * Under an extension that has the shell showing something (docs/primitives.md §4): its marks on spaces and its
 * themes, each in the shell's words with what the extension called it, and the one press that takes it off.
 */
function WhatItShows({ extension }: { extension: ExtensionInfo }) {
  return (
    <li data-testid="extension-shows" data-extension-id={extension.id} className="mb-2 ml-[60px] mr-3 rounded-xl bg-alpha-100 px-3 py-2.5 @max-[481px]:ml-3">
      <h3 className="text-[12.5px] font-semibold text-gray-900">{SHOWS_HEADING}</h3>
      <ul className="mt-1 flex flex-col gap-0.5">
        {(extension.shows ?? []).map((shown) => (
          <ShownRow key={`${shown.what} ${scopeOf(shown.spaceId)}`} extensionId={extension.id} shown={shown} />
        ))}
      </ul>
    </li>
  );
}

/** One thing it shows, and *Remove*: the mark comes off the tile, the theme off the space (or off every space). */
function ShownRow({ extensionId, shown }: { extensionId: string; shown: ExtensionShown }) {
  const [busy, setBusy] = useState(false);
  const remove = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    await removeShown(extensionId, shown.what, shown.spaceId);
    setBusy(false);
  };
  return (
    <li data-testid="extension-shown" data-what={shown.what} data-space-id={scopeOf(shown.spaceId)} className="flex min-h-[26px] items-center justify-between gap-3">
      <span className="min-w-0 truncate text-[13px] text-gray-1000">{shownLine(shown)}</span>
      <button
        type="button"
        disabled={busy}
        data-testid="extension-shown-remove"
        className={cn("shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-[12.5px] font-medium text-gray-900 hover:bg-alpha-200 hover:text-gray-1000 disabled:cursor-default disabled:opacity-60", FOCUS)}
        onClick={() => void remove()}
      >
        Remove
      </button>
    </li>
  );
}

function Verdict({ verdict }: { verdict: ChromeVerdict }) {
  if (verdict.kind === "works")
    return (
      <span className="inline-flex items-center gap-1 text-green-900" data-verdict="works">
        <Check className="size-3" aria-hidden="true" />
        Works
      </span>
    );
  if (verdict.kind === "partly")
    return (
      <span className="text-amber-900" data-verdict="partly" title={verdict.notes.join("\n")}>
        ◐ Works in part{verdict.notes.length > 0 ? `: ${verdict.notes[0] ?? ""}` : ""}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-gray-800" data-verdict="wont" title={verdict.alternative ?? verdict.reason}>
      <CircleSlash className="size-3" aria-hidden="true" />
      {verdict.reason}
    </span>
  );
}

function WayRow({ icon, label, testId, onClick }: { icon: React.ReactNode; label: string; testId: string; onClick: () => void }) {
  return (
    <li>
      <button type="button" data-testid={testId} className={cn("flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-alpha-100", FOCUS)} onClick={onClick}>
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-alpha-100 text-gray-900 [&_svg]:size-4">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[14px] text-gray-1000">{label}</span>
      </button>
    </li>
  );
}

/** The dev folder (docs/extensions.md §2, X7): where the person's own extensions are written, watched while Developer mode is on. */
function Yours({ devFolder, developerMode, wish }: { devFolder: string | null; developerMode: boolean; wish: string }) {
  const [making, setMaking] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<Template>("panel");
  const [busy, setBusy] = useState(false);
  const create = async (): Promise<void> => {
    if (name.trim() === "" || busy) return;
    setBusy(true);
    const response = await extensionsRequest({ type: "newFolder", name: name.trim(), template });
    setBusy(false);
    if (response?.type !== "folder") return;
    setMaking(false);
    setName("");
    useAppStore.getState().showNotice(`Made ${tildePath(response.path)}`, { tone: "success" });
  };
  return (
    <Section
      title="Yours"
      note={devFolder === null ? "Extensions you or your coding agent write, in a folder on this Mac." : `Extensions you or your coding agent write, in ${tildePath(devFolder)}.`}
      testId="extensions-yours"
    >
      <li className="flex items-center justify-between gap-4 rounded-xl px-3 py-2.5">
        <span className="min-w-0">
          <span className="block text-[14px] font-medium text-gray-1000">Developer mode</span>
          <span className="block text-[13px] text-gray-800">Watches the folder and reloads an extension as you save it.</span>
        </span>
        <Switch checked={developerMode} label="Developer mode" onChange={(on) => void extensionsRequest({ type: "setDeveloperMode", on })} />
      </li>
      <li className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button type="button" className={PILL} data-testid="extensions-new" aria-expanded={making} onClick={() => setMaking((value) => !value)}>
          <Puzzle className="size-3.5" aria-hidden="true" />
          New…
        </button>
        <button type="button" className={PILL} data-testid="extensions-make-with-pistachio" onClick={() => makeWithPistachio(wish)}>
          <Sparkles className="size-3.5" aria-hidden="true" />
          Make one with Pistachio
        </button>
        <button type="button" className={PILL} data-testid="extensions-claude-code" onClick={() => void buildWithClaudeCode(wish)}>
          <SquareTerminal className="size-3.5" aria-hidden="true" />
          Build with Claude Code
        </button>
        <button type="button" className={PILL} onClick={() => void extensionsRequest({ type: "loadFolder" })}>
          <FolderPlus className="size-3.5" aria-hidden="true" />
          Load a folder…
        </button>
      </li>
      {making ? (
        <li className="mx-3 mt-1 rounded-xl bg-background-100 p-3 shadow-[0_0_0_1px_var(--color-alpha-300)]" data-testid="extensions-new-form">
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <input
              type="text"
              aria-label="Name"
              placeholder="Name it"
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              className="h-9 rounded-lg bg-alpha-100 px-3 text-[14px] text-gray-1000 placeholder:text-gray-700 focus:bg-alpha-200 focus:outline-none"
            />
            <div role="radiogroup" aria-label="Start from" className="grid grid-cols-3 gap-2 @max-[481px]:grid-cols-1">
              {TEMPLATES.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  role="radio"
                  aria-checked={template === choice.id}
                  data-template={choice.id}
                  className={cn(
                    "flex cursor-pointer flex-col items-start rounded-lg px-3 py-2 text-left transition-colors",
                    template === choice.id ? "bg-gray-1000 text-background-100" : "bg-alpha-100 text-gray-1000 hover:bg-alpha-200",
                    FOCUS,
                  )}
                  onClick={() => setTemplate(choice.id)}
                >
                  <span className="text-[13px] font-medium">{choice.label}</span>
                  <span className={cn("text-[12px]", template === choice.id ? "text-background-200" : "text-gray-700")}>{choice.note}</span>
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className={PILL} onClick={() => setMaking(false)}>
                Cancel
              </button>
              <button type="submit" className={cn(PILL, "bg-gray-1000 text-background-100 hover:bg-gray-900 hover:text-background-100")} disabled={busy || name.trim() === ""}>
                <Hammer className="size-3.5" aria-hidden="true" />
                Make the folder
              </button>
            </div>
          </form>
        </li>
      ) : null}
    </Section>
  );
}
