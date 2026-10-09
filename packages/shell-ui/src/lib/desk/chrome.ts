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
 * - What the sidebar lays over the desk — the rail's favorites sheet, the
 *   hidden sidebar's column brought out — is a cover the desk's live pages
 *   give way to (useDeskCover).
 */

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { create } from "zustand";
import type { Rect } from "./geometry";
import { useDeskEngine } from "./open";

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
  /** Of those, the ones behind a window filling the desk: out of sight, as a tab left in the background is. */
  behind: ReadonlySet<string>;
  card: DeskCard | null;
  hovered: string | null;
  agentTab: string | null;
  /** On the rail, the place under the row of the favorite whose desk is up (its anchor's id), for its desk's tabs and Stack. */
  favoriteEntry: { anchorId: string; el: HTMLElement } | null;
  setMarks(marks: ReadonlyMap<string, DeskMark>): void;
  setBehind(behind: ReadonlySet<string>): void;
  openCard(card: DeskCard): void;
  closeCard(kind?: DeskCard["kind"]): void;
  setHovered(tabId: string | null): void;
  setAgentTab(tabId: string | null): void;
  setFavoriteEntry(entry: { anchorId: string; el: HTMLElement } | null): void;
}

const NO_MARKS: ReadonlyMap<string, DeskMark> = new Map();
const NONE_BEHIND: ReadonlySet<string> = new Set();

export const useDeskChrome = create<DeskChromeState>((set, get) => ({
  marks: NO_MARKS,
  behind: NONE_BEHIND,
  card: null,
  hovered: null,
  agentTab: null,
  favoriteEntry: null,
  setMarks: (marks) => {
    const before = get().marks;
    if (before.size === marks.size && [...marks].every(([id, mark]) => before.get(id) === mark)) return;
    set({ marks: marks.size === 0 ? NO_MARKS : marks });
  },
  setBehind: (behind) => {
    const before = get().behind;
    if (before.size === behind.size && [...behind].every((id) => before.has(id))) return;
    set({ behind: behind.size === 0 ? NONE_BEHIND : behind });
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

/** What a cover needs of the desk's engine (DeskEngine: setCover, its view, its changes). */
export interface DeskCoverHost {
  setCover(key: string, rect: Rect | null): void;
  getView(): { gesture: string | null; clearCovers: ReadonlySet<string> };
  subscribe(listener: () => void): () => void;
}

/**
 * A cover over the desk from outside it, as long as the watch lasts: put up
 * at `measure()` (in the stage's coordinates), `clear` told whether the live
 * pages under it have given way (the engine's `clearCovers`), `gesture` told
 * when a window is taken in hand — what covers the desk goes then, as its
 * cards do. Disposed, the cover comes down. (useDeskCover's, apart from React
 * and the DOM.)
 */
export function watchDeskCover(
  engine: DeskCoverHost,
  key: string,
  measure: () => Rect,
  on: { clear(clear: boolean): void; gesture(): void },
): { measure(): void; dispose(): void } {
  const put = (): void => engine.setCover(key, measure());
  const update = (): void => {
    const view = engine.getView();
    if (view.gesture !== null) {
      on.gesture();
      return;
    }
    on.clear(view.clearCovers.has(key));
  };
  put();
  update();
  const off = engine.subscribe(update);
  return {
    measure: put,
    dispose: () => {
      off();
      engine.setCover(key, null);
    },
  };
}

export interface DeskCoverOptions {
  /** The cover's box in the window (client coordinates) — the element's own box when absent. */
  box?(el: HTMLElement): { x: number; y: number; width: number; height: number };
  /** A window was taken in hand: what covers the desk goes. */
  onGesture?(): void;
}

/**
 * Something the sidebar draws over the desk while `active` — the rail's
 * favorites sheet, the hidden sidebar's column brought out (docs/spaces.md
 * §3) — is a cover there (DeskEngine.setCover, under `key`): the live pages
 * under it are native views that would paint over it, so they give way to
 * their stills first, and this says when they have (true: it can be shown).
 * The box is measured against the desk's stage, and again whenever the
 * element or the stage changes size (the stage moves as the sidebar changes
 * mode) or the component renders anew; the cover comes down once inactive or
 * unmounted. The sidebar is not the desk's (the desk is drawn beside it), so
 * the engine is the one the desk lends, never a prop. Where there is no desk
 * to cover (no engine yet), there is nothing to give way, and it shows at
 * once.
 */
export function useDeskCover(key: string, ref: RefObject<HTMLElement | null>, active: boolean, options: DeskCoverOptions = {}): boolean {
  const engine = useDeskEngine();
  const [clear, setClear] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const remeasure = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const stage = document.querySelector<HTMLElement>(".desk-stage");
    if (!active || engine === null || el === null || stage === null) {
      setClear(false);
      return;
    }
    const watch = watchDeskCover(
      engine,
      key,
      () => {
        const box = optionsRef.current.box?.(el) ?? el.getBoundingClientRect();
        const at = stage.getBoundingClientRect();
        return { x: box.x - at.left, y: box.y - at.top, w: box.width, h: box.height };
      },
      { clear: setClear, gesture: () => optionsRef.current.onGesture?.() },
    );
    remeasure.current = watch.measure;
    const observer = new ResizeObserver(watch.measure);
    observer.observe(el);
    observer.observe(stage);
    return () => {
      remeasure.current = null;
      observer.disconnect();
      watch.dispose();
    };
  }, [engine, key, active, ref]);
  // Moved without a change of size (the favorites sheet kept inside the window): measured again as it renders.
  // (setCover takes the same box as no change.)
  useLayoutEffect(() => remeasure.current?.());
  return active && (engine === null || clear);
}
