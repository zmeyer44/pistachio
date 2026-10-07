/**
 * What the sidebar and the desk share while a desk is up (docs/desk.md). The
 * sidebar's column is the desk's dock, but the desk (components/desk) is
 * drawn in the content area beside it: the two meet here.
 *
 * - The desk says what is out on it (`marks`), for the sidebar's rows to
 *   mark the tabs whose windows are out, and the one in use.
 * - The sidebar's desk button opens the desk's card, and its context row the
 *   Stack's (`card`): the desk draws them, over its own windows, beside the
 *   button that opened them (`anchor`, in the window's coordinates).
 * - The sidebar says which of the group's rows is under the pointer
 *   (`hovered`): ⇧⌫ closes that tab, wherever the keyboard is.
 * - The desk says which tab its agent is working in (`agentTab`), for that
 *   row to wear the agent's ring, as the window does.
 * - On the rail, the row of the favorite whose desk is up stands under the
 *   favorites' folder (FavoritesGrid), and the tab list draws that desk's
 *   tabs and Stack under it (`favoriteEntry`, a place in the favorites).
 */

import { create } from "zustand";

export interface DeskAnchor {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A tab's window on the desk, as its row in the sidebar marks it. */
export type DeskMark = "out" | "focused";

export interface DeskCard {
  kind: "more" | "stack";
  anchor: DeskAnchor;
  /** Opened by a click: it stays until a press elsewhere or Escape (the More card otherwise goes once the pointer leaves). */
  pinned: boolean;
  /** The Stack's: what a drop on its row could not take, said on the card (which opens to say it). */
  rejection?: string;
}

interface DeskChromeState {
  /** The tabs whose windows are out on the desk, and which is in use. */
  marks: ReadonlyMap<string, DeskMark>;
  card: DeskCard | null;
  hovered: string | null;
  agentTab: string | null;
  /** On the rail, the place under the row of the favorite whose desk is up (its anchor's id), for its desk's tabs and Stack. */
  favoriteEntry: { anchorId: string; el: HTMLElement } | null;
  setMarks(marks: ReadonlyMap<string, DeskMark>): void;
  openCard(card: DeskCard): void;
  closeCard(kind?: DeskCard["kind"]): void;
  setHovered(tabId: string | null): void;
  setAgentTab(tabId: string | null): void;
  setFavoriteEntry(entry: { anchorId: string; el: HTMLElement } | null): void;
}

const NO_MARKS: ReadonlyMap<string, DeskMark> = new Map();

export const useDeskChrome = create<DeskChromeState>((set, get) => ({
  marks: NO_MARKS,
  card: null,
  hovered: null,
  agentTab: null,
  favoriteEntry: null,
  setMarks: (marks) => {
    const before = get().marks;
    if (before.size === marks.size && [...marks].every(([id, mark]) => before.get(id) === mark)) return;
    set({ marks: marks.size === 0 ? NO_MARKS : marks });
  },
  openCard: (card) => set({ card }),
  closeCard: (kind) => {
    const card = get().card;
    if (card !== null && (kind === undefined || card.kind === kind)) set({ card: null });
  },
  setHovered: (tabId) => {
    if (get().hovered !== tabId) set({ hovered: tabId });
  },
  setAgentTab: (tabId) => {
    if (get().agentTab !== tabId) set({ agentTab: tabId });
  },
  setFavoriteEntry: (entry) => {
    const before = get().favoriteEntry;
    if (before?.anchorId === entry?.anchorId && before?.el === entry?.el) return;
    set({ favoriteEntry: entry });
  },
}));

/** A tab's mark in the sidebar: its window out on the desk, or in use there; null without one (or without a desk). */
export function useDeskMark(tabId: string): DeskMark | null {
  return useDeskChrome((state) => state.marks.get(tabId) ?? null);
}

/** An element's box in the window, for a card to stand beside. */
export function anchorOf(el: Element): DeskAnchor {
  const box = el.getBoundingClientRect();
  return { x: box.left, y: box.top, w: box.width, h: box.height };
}
