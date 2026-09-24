/**
 * What a typed address can match, shared by the address modal (UrlBar) and
 * the home page's search (components/home): recent pages, every Space's open
 * tabs, the kept pages, the chrome's actions and the settings sections,
 * fuzzy-ranked as one list behind a "go to" or "search" for the text itself,
 * and the row that draws each result. Each caller adds its own browse face
 * (what shows before anything is typed) and decides where a result goes.
 */

import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowRight, Boxes, ClipboardPaste, ListX, MoveRight, NotebookPen, RotateCcw, Search, Sparkles, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ADDRESS_INTENT_LIMITS, type AddressIntentPage } from "@pistachio/shell-contracts/address-intent";
import type { BrowserTabInfo, CommandPaletteSnapshot, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { NOTE_UNTITLED, searchNotes, type NoteSummary } from "@pistachio/shell-contracts/notes";
import { SETTINGS_SECTIONS, type SettingsSection } from "@pistachio/shell-contracts/settings";
import { DEFAULT_SIDEBAR_STATE, presetAnchorId } from "@pistachio/shell-contracts/sidebar";
import { shortcutLabel, type ShortcutPlatform } from "@pistachio/shell-contracts/shortcuts";
import { actionSnapshotOf, CHROME_ACTIONS, type ActionContext, type ChromeActionId } from "../chrome/actions";
import { useShell } from "../chrome/shell-host";
import { ACTION_INTENT_DETAILS } from "../lib/action-intents";
import { cn } from "../lib/cn";
import { collapseDestinations, destinationKey } from "../lib/destination";
import { rankFuzzy, STRONG_FUZZY_SCORE, type FuzzyCandidate } from "../lib/fuzzy";
import { applyIntentRanking, buildIntentRequest, shouldAskIntentModel, type IntentCandidateSeed } from "../lib/intent-ranking";
import { secondarySearchItems, type UrlItem } from "../lib/search-suggestions";
import { SETTINGS_INTENTS, settingsIntentEntryId, settingsIntentKeywords, type SettingsIntent } from "../lib/settings-intents";
import { useAddressIntent, type IntentRankState, type TypedFace } from "../lib/use-address-intent";
import { displayHost, prettyUrl } from "../lib/url";
import { recentFaviconUrl, type RecentSite } from "../lib/recents";
import { selectActiveTab, useAppStore } from "../store";
import { summaryAsNote, useNotes } from "./notes/use-notes";
import { Favicon, TabMark } from "./Favicon";
import { SearchProviderLogo } from "./SearchProviderLogo";
import { isNavGroup, SETTINGS_NAV, type NavEntry } from "./settings/nav-config";
import { shellApi } from "../api";

export { primaryItemFor, type UrlItem } from "../lib/search-suggestions";

/**
 * One selectable thing in the modal, across every region. `horizontal` rows
 * (chips) are walked with ←/→; vertical lists with ↑/↓.
 */
export type Entry =
  | { kind: "suggestion"; id: string; url: string; item: UrlItem }
  /** "Paste and Go": the address the clipboard holds (CommandPaletteSnapshot.clipboardUrl). */
  | { kind: "paste"; id: string; url: string; title: string; subtitle: string }
  | { kind: "recent"; id: string; url: string; label: string; host: string; faviconUrl: string | null }
  | { kind: "history"; id: string; url: string; site: RecentSite }
  | { kind: "tab"; id: string; url: string; tabId: string; title: string; tab: BrowserTabInfo; note: string }
  /** A kept page — a preset, a favorite, a pin — opened by its anchor (@pistachio/shell-contracts/sidebar). */
  | { kind: "shelf"; id: string; url: string; anchorId: string; title: string; faviconUrl: string | null; note: string }
  /** A non-URL operation surfaced by the unified palette. */
  | {
      kind: "action";
      id: string;
      title: string;
      subtitle?: string;
      hint?: string;
      category: "Action" | "Space" | "Settings" | "Closed" | "Saved";
      icon: React.ReactNode;
      run(): void;
    };

export type ShelfEntry = Extract<Entry, { kind: "shelf" }>;

const ACTION_KEYWORDS: Partial<Record<ChromeActionId, readonly string[]>> = {
  back: ["previous history"],
  forward: ["next history"],
  reload: ["refresh page"],
  newTab: ["open page"],
  delegate: ["agent hand off current tab"],
  editAddress: ["location url bar"],
  copyUrl: ["copy link address clipboard share"],
  copyUrlMarkdown: ["copy link markdown md clipboard share"],
  toggleSplit: ["side by side panes"],
  toggleConsole: ["agent panel"],
  toggleEvidence: ["replay audit run proof"],
  openSettings: ["preferences configuration"],
  openBrief: ["daily brief briefing morning report today my day summary digest pistachio://brief"],
  openNotes: ["notes notebook my writing documents written jot pad pistachio://notes"],
  newNote: ["new note blank note write jot down start writing scratch"],
  openReminders: ["schedule alarm calendar scheduled tasks pistachio://reminders"],
  openWatchtower: ["browsing memory history archive saved pages recall wiki pistachio://watchtower"],
  openArchive: ["archive archived tabs closed groups put away restore old tabs"],
  undoTidy: ["undo tidy bring back archived tabs restore ungroup revert clean up"],
  tidyTabs: ["tidy clean up declutter organize group tabs archive idle old tabs auto group"],
  openBookmarks: ["saved items favorites reading list collection pistachio://bookmarks"],
  bookmarkPage: ["save this page keep add bookmark shift shift"],
  forkSpace: ["branch workspace context"],
  toggleSidebarPinned: ["compact sidebar"],
  togglePin: ["unpin keep page"],
};

interface SettingsPaletteItem {
  section: SettingsSection;
  label: string;
  note: string;
  icon: LucideIcon;
}

function settingsPaletteItems(): SettingsPaletteItem[] {
  const found = new Map<SettingsSection, Omit<SettingsPaletteItem, "label">>();
  const visit = (entries: readonly NavEntry[]) => {
    for (const entry of entries) {
      const note = isNavGroup(entry) ? entry.description : entry.note ?? "Browser preferences";
      if (!found.has(entry.section) || !isNavGroup(entry)) found.set(entry.section, { section: entry.section, note, icon: entry.icon });
      if (isNavGroup(entry)) visit(entry.items);
    }
  };
  for (const group of SETTINGS_NAV) visit(group.items);
  return (Object.entries(SETTINGS_SECTIONS) as Array<[SettingsSection, string]>).flatMap(([section, label]) => {
    const item = found.get(section);
    return item === undefined ? [] : [{ ...item, label }];
  });
}

/**
 * The settings rows, one per ERRAND rather than one per page
 * (lib/settings-intents.ts). "Theme & colors", "Default search engine" and
 * "Clear recent sites" all open a section, and several of them open the same
 * one; what each carries is the vocabulary that finds it — for the fuzzy
 * ranker now, and for the intent model when it is reachable.
 *
 * The icon is still the section's own from the nav tree, so a row looks like
 * the page it opens.
 */
const SETTINGS_ROWS: ReadonlyArray<{ intent: SettingsIntent; id: string; label: string; icon: LucideIcon; keywords: string[] }> =
  (() => {
    const icons = new Map(settingsPaletteItems().map((item) => [item.section, item] as const));
    return SETTINGS_INTENTS.flatMap((intent) => {
      const item = icons.get(intent.section);
      if (item === undefined) return [];
      return [
        {
          intent,
          id: settingsIntentEntryId(intent),
          label: item.label,
          icon: item.icon,
          keywords: settingsIntentKeywords(intent),
        },
      ];
    });
  })();

const EMPTY_TABS: BrowserTabInfo[] = [];
const EMPTY_SPACES: ShellSnapshot["spaces"] = [];
const EMPTY_NOTES: NoteSummary[] = [];

/**
 * Main's inventory — every Space's tabs, the closed ones, the clipboard —
 * fetched while `open` and whenever the SET of tabs changes (a tab closed or
 * opened from the palette). A title or favicon tick refreshes the rows
 * through `paletteTabs` without another round trip.
 */
export function usePaletteInventory(open: boolean): { palette: CommandPaletteSnapshot; paletteTabs: BrowserTabInfo[] } {
  const tabs = useAppStore((s) => s.snapshot?.tabs ?? EMPTY_TABS);
  const [palette, setPalette] = useState<CommandPaletteSnapshot>({ tabs: [], recentlyClosedTabs: [], clipboardUrl: null });
  const tabsKey = useMemo(() => tabs.map((candidate) => candidate.id).join("\0"), [tabs]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setPalette((existing) => ({ ...existing, tabs }));
    void shellApi()
      .getCommandPalette()
      .then((next) => {
        if (current) setPalette(next);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
    // `tabs` is read for the optimistic fill only; the key is what re-fetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tabsKey]);
  const paletteTabs = useMemo(() => {
    const live = new Map(tabs.map((candidate) => [candidate.id, candidate]));
    return palette.tabs.map((candidate) => live.get(candidate.id) ?? candidate);
  }, [palette.tabs, tabs]);
  return { palette, paletteTabs };
}

/**
 * The sidebar's kept pages — the organization's presets, favorites, pins —
 * as rows, so they are reachable from the top layout too (the manifest's
 * reason for hiding the grid there). The page behind `excludeAnchorId` (the
 * tab being edited) is skipped.
 */
export function useShelfRows(excludeAnchorId: string | null | undefined): ShelfEntry[] {
  const shelf = useAppStore((s) => s.snapshot?.sidebar ?? DEFAULT_SIDEBAR_STATE);
  const presets = useAppStore((s) => s.settings.organization.presetLinks);
  return useMemo<ShelfEntry[]>(() => {
    const rows: ShelfEntry[] = [];
    const folderNames = new Map(
      shelf.entries.flatMap((entry) => (entry.kind === "folder" ? [[entry.id, entry.name] as const] : [])),
    );
    for (const link of presets) {
      rows.push({ kind: "shelf", id: `shelf:${presetAnchorId(link.url)}`, url: link.url, anchorId: presetAnchorId(link.url), title: link.title, faviconUrl: null, note: "Organization" });
    }
    for (const favorite of shelf.favorites) {
      rows.push({ kind: "shelf", id: `shelf:${favorite.id}`, url: favorite.url, anchorId: favorite.id, title: favorite.title, faviconUrl: favorite.faviconUrl, note: "Favorite" });
    }
    for (const entry of shelf.entries) {
      if (entry.kind !== "pin") continue;
      rows.push({ kind: "shelf", id: `shelf:${entry.id}`, url: entry.url, anchorId: entry.id, title: entry.title, faviconUrl: entry.faviconUrl, note: (entry.folderId === null ? null : folderNames.get(entry.folderId)) || "Pinned" });
    }
    return rows.filter((row) => row.anchorId !== excludeAnchorId);
  }, [presets, shelf, excludeAnchorId]);
}

/**
 * The typed inventory, before the model has an opinion: the fuzzy-ranked
 * list, every row it could have offered indexed by id, and the same rows
 * described for the intent model.
 */
interface TypedInventory {
  entries: Entry[];
  candidateEntries: Map<string, Entry>;
  seeds: IntentCandidateSeed[];
  /** Ids the fuzzy pass matched, best first. */
  matchedIds: string[];
}

/**
 * The typed face: one fuzzy-ranked inventory behind `primaryItem`, regardless
 * of where an item lives, then reordered by what the words most likely MEAN
 * (lib/intent-ranking.ts) when a model is reachable and the setting is on.
 * Empty while there is no primary item (nothing typed). `tab` is the tab
 * being edited — never offered as a result of its own — and `currentUrl` its
 * address.
 *
 * The heavy memo below is the one that must not grow: it rebuilds on every
 * keystroke and on every store tick it reads. The model's half is two small
 * memos after it, so an answer landing reorders an existing array rather
 * than rebuilding the inventory.
 */
export function useTypedEntries({
  q,
  primaryItem,
  tab,
  currentUrl,
  palette,
  paletteTabs,
  shelfRows,
}: {
  q: string;
  primaryItem: UrlItem | null;
  tab: BrowserTabInfo | null;
  currentUrl: string;
  palette: CommandPaletteSnapshot;
  paletteTabs: BrowserTabInfo[];
  shelfRows: readonly ShelfEntry[];
}): TypedFace {
  const shell = useShell();
  const activeTab = useAppStore(selectActiveTab);
  const spaces = useAppStore((s) => s.snapshot?.spaces ?? EMPTY_SPACES);
  const activeSpaceId = useAppStore((s) => s.snapshot?.activeSpaceId ?? null);
  const hasRun = useAppStore((s) => s.snapshot?.run != null);
  const actionSnapshot = useAppStore(useShallow((s) => actionSnapshotOf(s.snapshot)));
  const settings = useAppStore((s) => s.settings);
  const tabs = useAppStore((s) => s.snapshot?.tabs ?? EMPTY_TABS);
  const closeTab = useAppStore((s) => s.closeTab);
  const switchSpace = useAppStore((s) => s.switchSpace);
  const moveTabToSpace = useAppStore((s) => s.moveTabToSpace);
  const restoreClosedTab = useAppStore((s) => s.restoreClosedTab);
  const clearUnpinnedTabs = useAppStore((s) => s.clearUnpinnedTabs);
  const recentSites = useAppStore((s) => s.recents);
  // The notes' metadata, already in this window once anything has asked for
  // it; a host with no notes answers `unsupported` once and is left alone.
  const noteSummaries = useNotes((s) => s.summaries ?? EMPTY_NOTES);
  useEffect(() => {
    void useNotes.getState().load();
  }, []);

  const inventory = useMemo<TypedInventory>(() => {
    if (primaryItem === null) return { entries: [], candidateEntries: new Map(), seeds: [], matchedIds: [] };
    const candidates: Array<FuzzyCandidate<Entry>> = [];
    const candidateEntries = new Map<string, Entry>();
    const seeds: IntentCandidateSeed[] = [];
    const spaceNames = new Map(spaces.map((space) => [space.id, space.name]));
    const commandTab = tab ?? activeTab;

    /**
     * One row, offered to both rankers at once: to the fuzzy pass as text
     * and keywords, and to the intent model as a label and a plain sentence.
     * The model is told what a row IS, never where it points — no address
     * from this inventory is ever part of a request.
     */
    const offer = (
      entry: Entry,
      fuzzy: Omit<FuzzyCandidate<Entry>, "item">,
      seed: Omit<IntentCandidateSeed, "id">,
    ) => {
      candidates.push({ item: entry, ...fuzzy });
      candidateEntries.set(entry.id, entry);
      seeds.push({ id: entry.id, ...seed });
    };

    for (const site of recentSites) {
      if (site.url === currentUrl) continue;
      const entry: Entry = { kind: "history", id: `typed-history:${site.host}`, url: site.url, site };
      const title = site.title || prettyUrl(site.url);
      offer(
        entry,
        { text: title, keywords: [site.host, site.url, "recent history"], priority: 8 },
        { kind: "page", label: title, detail: site.host },
      );
    }

    for (const candidate of paletteTabs) {
      if (candidate.id === tab?.id) continue;
      const spaceName = spaceNames.get(candidate.spaceId) ?? candidate.spaceId;
      const title = candidate.title || prettyUrl(candidate.url) || "New tab";
      const entry: Entry = {
        kind: "tab",
        id: `typed-tab:${candidate.id}`,
        url: candidate.url,
        tabId: candidate.id,
        title,
        tab: candidate,
        note: `${spaceName}${candidate.lifecycle === "suspended" ? " · Suspended" : ""}`,
      };
      offer(
        entry,
        { text: title, keywords: [candidate.url, displayHost(candidate.url), spaceName, "open tab switch"], priority: 22 },
        { kind: "page", label: title, detail: displayHost(candidate.url) },
      );
    }

    for (const row of shelfRows) {
      const entry: Entry = { ...row, id: `typed-${row.id}` };
      const title = row.title || prettyUrl(row.url);
      offer(
        entry,
        { text: title, keywords: [row.url, displayHost(row.url), row.note, "pin favorite kept page"], priority: 14 },
        { kind: "page", label: title, detail: displayHost(row.url) },
      );
    }

    const actionState = useAppStore.getState();
    const actionContext: ActionContext = {
      tab: activeTab,
      snapshot: actionSnapshot,
      settings,
      shell: shell.state,
      store: actionState,
      run: shell.run,
    };
    const platform: ShortcutPlatform = /Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : "other";
    for (const action of Object.values(CHROME_ACTIONS)) {
      if (action.enabled?.(actionContext) === false) continue;
      const label = action.id === "delegate"
        ? "Ask Pistachio about this tab"
        : action.id === "toggleEvidence" && !shell.state.evidenceOpen && hasRun
          ? "Replay evidence"
          : action.label(actionContext);
      const entry: Entry = {
        kind: "action",
        id: `chrome:${action.id}`,
        title: label,
        category: "Action",
        icon: action.icon(actionContext),
        hint: action.shortcutId === undefined ? undefined : shortcutLabel(settings.shortcuts[action.shortcutId], platform) ?? undefined,
        run: () => {
          const latestStore = useAppStore.getState();
          const latestContext: ActionContext = {
            tab: selectActiveTab(latestStore),
            snapshot: actionSnapshotOf(latestStore.snapshot),
            settings: latestStore.settings,
            shell: shell.state,
            store: latestStore,
            run: shell.run,
          };
          if (action.enabled?.(latestContext) !== false) action.run(latestContext);
        },
      };
      offer(
        entry,
        { text: label, keywords: ACTION_KEYWORDS[action.id], priority: 28 },
        { kind: "command", label, detail: ACTION_INTENT_DETAILS[entry.id] ?? "" },
      );
    }

    if (commandTab !== null) {
      const entry: Entry = {
        kind: "action",
        id: "tab:close-current",
        title: "Close current tab",
        subtitle: commandTab.title || prettyUrl(commandTab.url),
        category: "Action",
        icon: <X aria-hidden="true" />,
        hint: shortcutLabel(settings.shortcuts.closeTab, platform) ?? undefined,
        run: () => void closeTab(commandTab.id),
      };
      offer(
        entry,
        { text: "Close current tab", keywords: ["remove dismiss page"], priority: 25 },
        { kind: "command", label: "Close current tab", detail: ACTION_INTENT_DETAILS["tab:close-current"] ?? "" },
      );
    }

    const closed = palette.recentlyClosedTabs[0];
    if (closed !== undefined) {
      const entry: Entry = {
        kind: "action",
        id: "tab:restore-closed",
        title: "Restore closed tab",
        subtitle: closed.title || prettyUrl(closed.url),
        category: "Closed",
        icon: <RotateCcw aria-hidden="true" />,
        run: () => void restoreClosedTab(),
      };
      offer(
        entry,
        { text: "Restore closed tab", keywords: [closed.title, closed.url, "undo reopen"], priority: 24 },
        { kind: "command", label: "Restore closed tab", detail: ACTION_INTENT_DETAILS["tab:restore-closed"] ?? "" },
      );
    }

    const unpinnedCount = tabs.filter((candidate) => candidate.kind === "human" && candidate.anchorId === null).length;
    if (unpinnedCount > 0) {
      const entry: Entry = {
        kind: "action",
        id: "tabs:clear-unpinned",
        title: "Clear unpinned tabs",
        subtitle: `${unpinnedCount} ${unpinnedCount === 1 ? "tab" : "tabs"} in this Space`,
        category: "Action",
        icon: <ListX aria-hidden="true" />,
        run: () => void clearUnpinnedTabs(),
      };
      offer(
        entry,
        { text: "Clear unpinned tabs", keywords: ["close day tabs clean up"], priority: 20 },
        { kind: "command", label: "Clear unpinned tabs", detail: ACTION_INTENT_DETAILS["tabs:clear-unpinned"] ?? "" },
      );
    }

    for (const space of spaces) {
      if (space.id === activeSpaceId) continue;
      const switchEntry: Entry = {
        kind: "action",
        id: `space:switch:${space.id}`,
        title: `Switch to ${space.name}`,
        subtitle: space.purpose || "Open Space",
        category: "Space",
        icon: <Boxes aria-hidden="true" />,
        run: () => void switchSpace(space.id),
      };
      offer(
        switchEntry,
        { text: `Switch to ${space.name}`, keywords: [space.name, space.purpose, "space workspace open"], priority: 18 },
        { kind: "command", label: `Switch to ${space.name}`, detail: `Move to the ${space.name} Space. ${space.purpose}` },
      );
      if (commandTab?.kind === "human") {
        const moveEntry: Entry = {
          kind: "action",
          id: `space:move:${space.id}`,
          title: `Move current tab to ${space.name}`,
          subtitle: commandTab.anchorId === null ? commandTab.title : "Its pinned page stays in this Space",
          category: "Space",
          icon: <MoveRight aria-hidden="true" />,
          run: () => void moveTabToSpace(commandTab.id, space.id),
        };
        offer(
          moveEntry,
          { text: `Move current tab to ${space.name}`, keywords: [space.name, space.purpose, "space workspace transfer"], priority: 19 },
          { kind: "command", label: `Move current tab to ${space.name}`, detail: `Put the tab you are on into the ${space.name} Space.` },
        );
      }
    }

    // The person's own writing (docs/notes.md §4). Ranked here rather than by
    // the host: the summaries are already in this window, so "pie note" costs
    // no round trip and the list does not flicker a keystroke behind.
    if (q.trim().length >= 2) {
      for (const note of searchNotes(noteSummaries.map(summaryAsNote), q, { limit: 5 })) {
        const title = note.title.trim() === "" ? NOTE_UNTITLED : note.title;
        const entry: Entry = {
          kind: "action",
          id: `note:${note.id}`,
          title: `Note · ${title}`,
          subtitle: note.markdown,
          category: "Saved",
          icon: <NotebookPen aria-hidden="true" />,
          run: () => useAppStore.getState().openNotes(note.id),
        };
        offer(
          entry,
          { text: title, keywords: [note.markdown, "note written writing"], priority: 16 },
          { kind: "page", label: `Note: ${title}`, detail: note.markdown },
        );
      }
    }

    for (const row of SETTINGS_ROWS) {
      const Icon = row.icon;
      const entry: Entry = {
        kind: "action",
        id: row.id,
        title: row.intent.title,
        subtitle: `Settings › ${row.label}`,
        category: "Settings",
        icon: <Icon aria-hidden="true" />,
        run: () => shell.run({ type: "openSettings", section: row.intent.section }),
      };
      offer(
        entry,
        { text: row.intent.title, keywords: row.keywords, priority: 10 },
        { kind: "command", label: row.intent.title, detail: row.intent.description },
      );
    }

    const matches = rankFuzzy(q, candidates);
    // One row per PLACE (lib/destination.ts): a page that is open in a tab,
    // kept as a favorite and visited this morning is one result, not three.
    // The best way there wins — a tab already open in this Space (↵ switches
    // to it, nothing loads), then the kept page, then a tab in another Space
    // (choosing it changes Space, and with it the cookie jar), then history.
    const placeOf = (entry: Entry): string | null =>
      entry.kind === "tab" || entry.kind === "shelf" || entry.kind === "history" ? destinationKey(entry.url) : null;
    const wayThere = (entry: Entry): number => {
      if (entry.kind === "tab")
        return (entry.tab.spaceId === activeSpaceId ? 4 : 2) + (entry.tab.lifecycle === "suspended" ? 0 : 0.5);
      return entry.kind === "shelf" ? 3 : 1;
    };
    const places = collapseDestinations(
      matches.map((match) => match.item),
      candidates.map((candidate) => candidate.item),
      placeOf,
      wayThere,
    );
    const ranked = places.ranked;
    const matchedIds = ranked.map((entry) => entry.id);
    // The intent model is offered the same one-per-place set: three identical
    // options would split one probability three ways, and it must never be
    // able to name a row the list has folded away.
    for (const [id, entry] of candidateEntries) if (!places.kept(entry)) candidateEntries.delete(id);
    const offered = seeds.filter((seed) => candidateEntries.has(seed.id));
    const topScore = matches[0]?.score ?? 0;
    const suggestion = (item: UrlItem): Entry => ({ kind: "suggestion", id: item.id, url: item.url, item });
    const primary = suggestion(primaryItem);
    const searches = secondarySearchItems(q, primaryItem, settings.search).map(suggestion);
    const face = (entries: Entry[]): TypedInventory => ({ entries, candidateEntries, seeds: offered, matchedIds });
    // A typed address goes first and its matches follow it; searching for
    // the address's own letters is the fallback, so it closes the list.
    if (primaryItem.kind === "navigate") return face([primary, ...ranked, ...searches]);
    // A strong fuzzy match may outrank a web search, but never a typed
    // address: ↵ on "google.com" must go to google.com, not to whichever
    // bookmark ("Google Maps") happens to match its letters. The web search
    // and the AI prompt stay together either way — they are one question,
    // "where should these words go".
    const preferMatch = q.length >= 2 && topScore >= STRONG_FUZZY_SCORE;
    return face(preferMatch ? [...ranked, primary, ...searches] : [primary, ...searches, ...ranked]);
  }, [actionSnapshot, activeSpaceId, activeTab, shelfRows, clearUnpinnedTabs, closeTab, currentUrl, hasRun, moveTabToSpace, noteSummaries, palette.recentlyClosedTabs, paletteTabs, primaryItem, q, recentSites, restoreClosedTab, settings, shell, spaces, switchSpace, tab, tabs]);

  // ── What the words most likely MEAN (docs/smart-suggestions.md) ──────
  // Everything below reorders `inventory.entries`; none of it can add a row.

  const commandTab = tab ?? activeTab;
  const currentPage = useMemo<AddressIntentPage | null>(
    () => (commandTab === null ? null : { title: commandTab.title, host: displayHost(commandTab.url) }),
    [commandTab],
  );
  const recentPages = useMemo<AddressIntentPage[]>(
    () => recentSites.slice(0, ADDRESS_INTENT_LIMITS.maxRecentPages).map((site) => ({ title: site.title, host: site.host })),
    [recentSites],
  );

  const ask = shouldAskIntentModel(q, {
    browsing: primaryItem === null,
    primaryKind: primaryItem?.kind ?? null,
    enabled: settings.search.smartSuggestions,
  });
  const request = useMemo(
    () =>
      ask
        ? buildIntentRequest({ query: q, currentPage, recentPages, seeds: inventory.seeds, matchedIds: inventory.matchedIds })
        : null,
    [ask, q, currentPage, recentPages, inventory],
  );
  const intent = useAddressIntent(request);
  const ranking = intent?.ranking ?? null;

  const entries = useMemo(
    () =>
      applyIntentRanking({
        heuristicEntries: inventory.entries,
        candidateEntries: inventory.candidateEntries,
        ranking,
        query: q,
        primaryItem,
      }),
    [inventory, ranking, q, primaryItem],
  );

  const intentState: IntentRankState = request === null ? "none" : intent === null ? "pending" : ranking === null ? "none" : "applied";

  return useMemo<TypedFace>(
    () => ({ entries, heuristicEntries: inventory.entries, candidateEntries: inventory.candidateEntries, ranking, intentState }),
    [entries, inventory, ranking, intentState],
  );
}

/**
 * The metrics every row of the address modal and the home search shares: a
 * 36px line, a 20px mark, then the title and its detail side by side at one
 * size — the detail in the quiet ink, giving way first when the line is short.
 */
export const PALETTE_ROW_CLASS =
  "flex h-9 w-full cursor-pointer items-center gap-3 rounded-[10px] px-2.5 text-left transition-colors duration-100";
export const PALETTE_FAVICON_CLASS = "size-5 rounded-[5px] text-[11px]";
/** A drawn mark (an action's icon, a search's glyph): bare ink in the 20px slot, no tile. */
export const PALETTE_GLYPH_CLASS =
  "grid size-5 shrink-0 place-items-center text-gray-1000 [&_svg]:size-[18px] [&_svg]:stroke-[1.75]";
export const PALETTE_TITLE_CLASS = "max-w-[62%] shrink-0 truncate text-[14px] font-medium text-gray-1000";
export const PALETTE_DETAIL_CLASS = "min-w-0 flex-1 truncate text-[14px] text-gray-700";

/**
 * One result of the typed face. The right-hand source label keeps unlike
 * results scannable without breaking relevance into separate lists.
 */
export function PaletteResultRow({
  entry,
  index,
  selected,
  onSelect,
  onActivate,
}: {
  entry: Entry;
  index: number;
  selected: boolean;
  onSelect: (index: number) => void;
  onActivate: (entry: Entry) => void;
}) {
  const title = entry.kind === "suggestion"
    ? entry.item.title
    : entry.kind === "history"
      ? entry.site.title || prettyUrl(entry.url)
      : entry.kind === "recent"
        ? entry.label
        : entry.title;
  const subtitle = entry.kind === "suggestion"
    ? entry.item.subtitle
    : entry.kind === "history"
      ? prettyUrl(entry.url)
      : entry.kind === "tab" || entry.kind === "shelf"
        ? prettyUrl(entry.url)
        : entry.kind === "action" || entry.kind === "paste"
          ? entry.subtitle
          : undefined;
  const source = entry.kind === "suggestion"
    ? entry.item.hint
    : entry.kind === "history"
      ? "Recent"
      : entry.kind === "tab"
        ? entry.note
        : entry.kind === "shelf"
          ? entry.note
          : entry.kind === "action"
            ? entry.category
            : entry.kind === "paste"
              ? "Clipboard"
              : undefined;
  return (
    <button
      type="button"
      data-testid={
        entry.kind === "action" ? "command-result" : entry.kind === "tab" ? "open-tab-result" : entry.kind === "paste" ? "paste-and-go" : undefined
      }
      data-action-id={entry.kind === "action" ? entry.id : undefined}
      data-tab-id={entry.kind === "tab" ? entry.tabId : undefined}
      data-result-kind={entry.kind}
      data-suggestion-kind={entry.kind === "suggestion" ? entry.item.kind : undefined}
      data-index={index}
      onMouseMove={() => onSelect(index)}
      onClick={() => onActivate(entry)}
      className={cn(PALETTE_ROW_CLASS, selected && "bg-alpha-200")}
    >
      {entry.kind === "tab" ? (
        <TabMark tab={entry.tab} className={PALETTE_FAVICON_CLASS} />
      ) : entry.kind === "history" ? (
        <Favicon src={recentFaviconUrl(entry.site)} seed={entry.site.host} className={PALETTE_FAVICON_CLASS} />
      ) : entry.kind === "shelf" ? (
        <Favicon src={entry.faviconUrl} seed={displayHost(entry.url) || entry.title} className={PALETTE_FAVICON_CLASS} />
      ) : entry.kind === "recent" ? (
        <Favicon src={entry.faviconUrl} seed={entry.host} className={PALETTE_FAVICON_CLASS} />
      ) : (
        <span className={PALETTE_GLYPH_CLASS}>
          {entry.kind === "action" ? (
            entry.icon
          ) : entry.kind === "paste" ? (
            <ClipboardPaste aria-hidden="true" />
          ) : entry.item.provider !== undefined ? (
            // A search names its engine by its mark: which one ↵ is about to use, before the title is read.
            <SearchProviderLogo provider={entry.item.provider} className="size-[18px]" />
          ) : entry.item.kind === "search" ? (
            <Search aria-hidden="true" />
          ) : entry.item.kind === "ai" ? (
            <Sparkles aria-hidden="true" />
          ) : (
            <ArrowRight aria-hidden="true" />
          )}
        </span>
      )}
      <span className={PALETTE_TITLE_CLASS}>{title}</span>
      <span className={PALETTE_DETAIL_CLASS}>{subtitle}</span>
      {source !== undefined ? <span className="max-w-[150px] shrink-0 truncate text-[12px] text-gray-700">{source}</span> : null}
      {entry.kind === "action" && entry.hint !== undefined ? (
        <span className="shrink-0 font-mono text-[11px] text-gray-700">{entry.hint}</span>
      ) : null}
    </button>
  );
}
