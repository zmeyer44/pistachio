import { useEffect } from "react";
import { create } from "zustand";
import type { CalendarAgenda } from "@pistachio/shell-contracts/ipc";
import { isShellUnsupported } from "@pistachio/shell-contracts/socket";
import { shellApi } from "../../api";
import { loadCalendarPromptDismissed, saveCalendarPromptDismissed, todayWindow } from "../../lib/home";
import { useAppStore } from "../../store";

/** How long a read of the calendar stands before the schedule asks again. */
export const CALENDAR_AGENDA_TTL_MS = 5 * 60_000;
/**
 * An answer with no events in it — nothing connected, a grant to renew, a
 * calendar that could not be reached — stands only this long, so the next
 * home page after the person fixes it in Settings shows their day.
 */
export const CALENDAR_AGENDA_RETRY_MS = 15_000;

interface CalendarAgendaState {
  /** The last answer per Space, with the window it was for. */
  bySpace: Record<string, { agenda: CalendarAgenda; from: string; fetchedAt: number }>;
  /** The Space a read is in flight for, so a second one is not started beside it. */
  loading: string | null;
  /** This host keeps no calendar (the cloud browser's shell): asked once, never again. */
  unsupported: boolean;
  /** Bumped by `invalidate`, so a home page already showing asks again rather than waiting for its next tick. */
  epoch: number;
  /** The person waved away the invitation to connect a calendar. */
  promptDismissed: boolean;
  dismissPrompt(): void;
  refresh(spaceId: string, options?: { force?: boolean }): Promise<void>;
  /** Forget every answer: a calendar was connected, changed, or disconnected. */
  invalidate(): void;
}

/**
 * Shared by every home page in the window, like the weather: three new tabs
 * are one read of the calendar, not three.
 */
export const useCalendarAgendaStore = create<CalendarAgendaState>((set, get) => ({
  bySpace: {},
  loading: null,
  unsupported: false,
  epoch: 0,
  promptDismissed: loadCalendarPromptDismissed(),
  dismissPrompt: () => {
    saveCalendarPromptDismissed();
    set({ promptDismissed: true });
  },
  refresh: async (spaceId, options = {}) => {
    const state = get();
    if (state.unsupported || state.loading === spaceId) return;
    const now = new Date();
    const window = todayWindow(now);
    const held = state.bySpace[spaceId];
    // A new day is a new window, whatever the clock says about the last read.
    const ttl = held?.agenda.status === "ok" ? CALENDAR_AGENDA_TTL_MS : CALENDAR_AGENDA_RETRY_MS;
    const current = held !== undefined && held.from === window.from && now.getTime() - held.fetchedAt < ttl;
    if (current && options.force !== true) return;
    set({ loading: spaceId });
    try {
      const agenda = await shellApi().integrationCalendarEvents(spaceId, window.from, window.to);
      // A read that could not reach the calendar keeps the day already on
      // screen rather than blanking it; the next one tries again.
      const keep = agenda.status === "unreachable" && held !== undefined && held.from === window.from;
      set((s) => ({ bySpace: { ...s.bySpace, [spaceId]: keep ? { ...held, fetchedAt: now.getTime() } : { agenda, from: window.from, fetchedAt: now.getTime() } } }));
    } catch (error: unknown) {
      if (isShellUnsupported(error)) set({ unsupported: true });
    } finally {
      if (get().loading === spaceId) set({ loading: null });
    }
  },
  invalidate: () => set((s) => ({ bySpace: {}, epoch: s.epoch + 1 })),
}));

/**
 * Today on the active Space's connected calendar, kept fresh while a home
 * page is showing: on arrival, when the Space changes, when the window
 * comes back into view, and every few minutes. Null until the first answer
 * and on a host with no calendar; the schedule then shows reminders alone.
 * The host is asked whoever is signed in — it answers `not_connected` for
 * a Mac with no account — and again when that changes.
 */
export function useCalendarAgenda(): CalendarAgenda | null {
  const spaceId = useAppStore((s) => s.snapshot?.activeSpaceId ?? null);
  const enrolled = useAppStore((s) => s.account.state === "enrolled");
  const agenda = useCalendarAgendaStore((s) => (spaceId === null ? null : (s.bySpace[spaceId]?.agenda ?? null)));
  const epoch = useCalendarAgendaStore((s) => s.epoch);

  useEffect(() => {
    if (spaceId === null) return;
    const refresh = () => void useCalendarAgendaStore.getState().refresh(spaceId);
    refresh();
    const interval = window.setInterval(refresh, CALENDAR_AGENDA_TTL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [spaceId, enrolled, epoch]);

  return agenda;
}
