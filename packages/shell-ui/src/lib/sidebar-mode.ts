/**
 * The sidebar's mode as this shell draws it (docs/spaces.md §3): the whole
 * sidebar, a rail of its icons, or hidden at the window's left edge until the
 * pointer comes — one setting, `layout.sidebar` (SidebarMode). The rail is
 * offered only where the desk is, the desktop (its favorites sheet, its head's
 * buttons and its now playing all need one): elsewhere a stored rail is drawn
 * whole, and never rewritten (effectiveSidebarMode). Hidden on the desk is an
 * OVERLAY — the column brought out over the desk's windows, a cover they give
 * way to, so no page is laid out anew — and on the web a reflow, the page
 * making room as it does beside the whole sidebar (layouts/SidebarLayout.tsx).
 *
 * What the column's pieces share is here too: whether the overlaid column is
 * out (what main hears as ShellState.sidebarRevealed), whether one of its rows
 * is being renamed (which holds it out, as a drag does), and the steps the
 * overlay goes through, kept pure for the unit tests.
 */

import { create } from "zustand";
import { effectiveSidebarMode, type SidebarMode } from "@pistachio/shell-contracts/settings";
import { useAppStore, type AppState } from "../store";
import { deskAvailable } from "./desk/open";

/** The rail is offered here: the desktop, where the desk is (lib/desk/open.ts's predicate, so the two never disagree). */
export function railOffered(): boolean {
  return deskAvailable();
}

/** The sidebar's mode as drawn here: the setting, with a rail drawn whole where none is offered. */
export function sidebarModeOf(settings: Pick<AppState["settings"], "layout">): SidebarMode {
  return effectiveSidebarMode(settings.layout.sidebar, railOffered());
}

/** sidebarModeOf() for a component. */
export function useSidebarMode(): SidebarMode {
  return useAppStore((state) => sidebarModeOf(state.settings));
}

/** Hidden, on the desk: the column comes out OVER the desk, a cover, rather than into the layout. */
export function sidebarOverlays(mode: SidebarMode): boolean {
  return mode === "hidden" && deskAvailable();
}

interface SidebarColumnState {
  /**
   * The overlaid column is out over the desk: brought out, its cover clear
   * and its slide begun (SidebarLayout's SidebarColumn says so). False the
   * moment it starts to go.
   */
  out: boolean;
  /** A row of the column (a tab group's, a folder's) is being renamed: the hidden column stays out until it is done. */
  renaming: boolean;
  setOut(out: boolean): void;
  setRenaming(renaming: boolean): void;
}

export const useSidebarColumn = create<SidebarColumnState>((set, get) => ({
  out: false,
  renaming: false,
  setOut: (out) => {
    if (get().out !== out) set({ out });
  },
  setRenaming: (renaming) => {
    if (get().renaming !== renaming) set({ renaming });
  },
}));

/**
 * The column is ON SCREEN — what main hears as ShellState.sidebarRevealed,
 * which the traffic lights follow: whole or a rail, always; hidden, once
 * brought out (`revealed`, the store's intent) — and over the desk only once
 * it is OUT, never on the intent alone, or the window's buttons would show
 * over a window's live page before the column is there.
 */
export function sidebarOnScreen(mode: SidebarMode, overlay: boolean, revealed: boolean, out: boolean): boolean {
  if (mode !== "hidden") return true;
  return overlay ? out : revealed;
}

/** sidebarOnScreen() for a component. */
export function useSidebarOnScreen(): boolean {
  const mode = useSidebarMode();
  const revealed = useAppStore((state) => state.sidebarRevealed);
  const out = useSidebarColumn((state) => state.out);
  return sidebarOnScreen(mode, sidebarOverlays(mode), revealed, out);
}

/**
 * The overlaid column's life, render by render (SidebarLayout's
 * SidebarColumn). Its cover goes up as the pointer brings it out, and it
 * slides in once the windows under it have given way (`out`); going, it keeps
 * its cover and its layer until its retreat has ended (`retreating`); and a
 * mode left while it is over the desk (⌘S to the whole sidebar) keeps them
 * until the slot has grown out under it (`leaving`), or the live pages would
 * paint over it for the slide.
 */
export interface SidebarOverlay {
  out: boolean;
  retreating: boolean;
  leaving: boolean;
}

export const SIDEBAR_OVERLAY_AWAY: SidebarOverlay = { out: false, retreating: false, leaving: false };

/**
 * The overlay's next state, from the mode (`overlay`: hidden, on the desk),
 * the reveal's intent and whether its cover is clear. The ends of a retreat
 * and of a slide are events of their own (the callers clear `retreating` and
 * `leaving`).
 *
 * The cover being clear is what lets the column IN; once out it stays out
 * for as long as it is wanted, and only the intent going (`revealed` false)
 * starts its retreat. Its cover not clear for a moment while it is out — a
 * window landing under it before its still is up, a space chosen from the
 * column — would otherwise slide it out and back in, the traffic lights
 * flickering with it (until 2026-10-09).
 */
export function nextSidebarOverlay(prev: SidebarOverlay, overlay: boolean, revealed: boolean, coverClear: boolean): SidebarOverlay {
  const over = prev.out || prev.retreating;
  let next: SidebarOverlay;
  if (!overlay) next = { out: false, retreating: false, leaving: prev.leaving || over };
  else if (revealed && (coverClear || prev.out)) next = { out: true, retreating: false, leaving: false };
  else next = { out: false, retreating: prev.retreating || prev.out, leaving: prev.leaving };
  return sameSidebarOverlay(prev, next) ? prev : next;
}

/** The overlay wants its cover over the desk (and its layer above it): brought out or on its way, going, or being left. */
export function sidebarCoverWanted(state: SidebarOverlay, overlay: boolean, revealed: boolean): boolean {
  return (overlay && (revealed || state.retreating)) || state.leaving;
}

export function sameSidebarOverlay(a: SidebarOverlay, b: SidebarOverlay): boolean {
  return a.out === b.out && a.retreating === b.retreating && a.leaving === b.leaving;
}

/**
 * What holds the hidden column out past the pointer, each reaching past it: a
 * resize of it, a row dragged from it, a desk card it opened (the More card,
 * the Stack's), a row's context menu (opened at the pointer, which was on the
 * column), a row being renamed.
 */
export function sidebarHeld(state: Pick<AppState, "paneResizing" | "tabDragging" | "overlay">, card: boolean, renaming: boolean): boolean {
  return state.paneResizing || state.tabDragging || state.overlay === "context-menu" || card || renaming;
}
