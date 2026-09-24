import { create } from "zustand";
import type { ReportRequest, ReportResponse } from "@pistachio/shell-contracts/reports";
import { isShellUnsupported } from "@pistachio/shell-contracts/socket";
import { shellApi } from "../../api";
import { profileView } from "@pistachio/shell-contracts/memory";
import { loadTodos } from "../../lib/home";
import { localDayOf, reportLocalOf } from "../../lib/reports";
import { useAppStore } from "../../store";

/** A stored brief does not change behind the page's back; this only spares a disk read per mount. */
export const BRIEF_TTL_MS = 60_000;

interface Entry {
  response: ReportResponse;
  at: number;
}

interface BriefState {
  /** Keyed by Space and day: `space|2026-09-21`. */
  entries: Record<string, Entry>;
  generating: Record<string, boolean>;
  error: string | null;
  /** The host has no reports (a cloud session): asked once, then left alone. */
  unsupported: boolean;
  load(spaceId: string, date: string, options?: { force?: boolean }): Promise<ReportResponse | null>;
  generate(spaceId: string, date: string, name: string): Promise<void>;
  tick(spaceId: string, date: string, changes: { path: string; value: boolean }[]): Promise<void>;
}

export function briefKey(spaceId: string, date: string): string {
  return `${spaceId}|${date}`;
}

/** What only this window knows: the home page's to-dos and recents live in its storage. */
function localMaterials(name: string): Extract<ReportRequest, { type: "generate" }>["local"] {
  const state = useAppStore.getState();
  return reportLocalOf({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: typeof navigator === "undefined" ? "en-US" : navigator.language,
    name,
    todos: loadTodos(new Date()),
    recents: state.settings.privacy.rememberRecents ? state.recents : [],
  });
}

export const useBriefStore = create<BriefState>((set, get) => ({
  entries: {},
  generating: {},
  error: null,
  unsupported: false,

  load: async (spaceId, date, options) => {
    const key = briefKey(spaceId, date);
    const cached = get().entries[key];
    if (get().unsupported) return null;
    if (options?.force !== true && cached !== undefined && Date.now() - cached.at < BRIEF_TTL_MS) return cached.response;
    try {
      const response = await shellApi().reports({ type: "get", spaceId, date });
      set((state) => ({ entries: { ...state.entries, [key]: { response, at: Date.now() } }, error: null }));
      return response;
    } catch (error) {
      if (isShellUnsupported(error)) set({ unsupported: true });
      else set({ error: error instanceof Error ? error.message : "The brief could not be read." });
      return null;
    }
  },

  generate: async (spaceId, date, name) => {
    if (get().generating[spaceId] === true || get().unsupported) return;
    set((state) => ({ generating: { ...state.generating, [spaceId]: true }, error: null }));
    try {
      const response = await shellApi().reports({ type: "generate", spaceId, local: localMaterials(name) });
      // Main files the brief under ITS reading of today; normally the same day the page asked for.
      const filed = response.report?.date ?? date;
      set((state) => ({
        entries: { ...state.entries, [briefKey(spaceId, filed)]: { response, at: Date.now() }, [briefKey(spaceId, date)]: { response, at: Date.now() } },
      }));
    } catch (error) {
      if (isShellUnsupported(error)) set({ unsupported: true });
      else set({ error: error instanceof Error ? error.message : "The brief could not be made." });
    } finally {
      set((state) => ({ generating: { ...state.generating, [spaceId]: false } }));
    }
  },

  tick: async (spaceId, date, changes) => {
    if (changes.length === 0) return;
    try {
      const response = await shellApi().reports({ type: "state", spaceId, date, changes });
      if (response.report !== null) set((state) => ({ entries: { ...state.entries, [briefKey(spaceId, date)]: { response, at: Date.now() } } }));
    } catch {
      // A tick that did not save is still ticked on the page; the next one carries on.
    }
  },
}));

/**
 * The morning schedule's request (main's `BriefScheduler`): make today's brief
 * for this Space now. It is made here rather than in main because the home
 * page's to-dos and recents live in this window's storage; main announces it.
 */
export function prepareBrief(spaceId: string): void {
  const name = profileView(useAppStore.getState().memory.entries, new Date()).name;
  void useBriefStore.getState().generate(spaceId, localDayOf(new Date()), name);
}
