/**
 * The desk's own state (components/desk): how each space's (tab group's)
 * windows were last arranged, and the variants the person is trying. None
 * of it is the browser's — main never hears of an arrangement — so it lives
 * here and in this device's storage, apart from the shell's store and its
 * snapshot.
 *
 * Which space the desk shows is NOT here (since 2026-10-09, docs/spaces.md
 * §2): the desk is always up on the desktop, and main owns the current
 * space (ShellSnapshot.currentGroupId), which the desk follows. Until then
 * this store held the group whose desk was up, and the open/leave/switch
 * handshake with the sidebar.
 */

import { create } from "zustand";
import { isDeskMask, type DeskGrabModifier, type DeskMask } from "@pistachio/shell-contracts/desk";
import type { BrowserTabInfo, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { writeStorageLater } from "../deferred-storage";
import { isFiniteRect, type Rect } from "./geometry";
import { GLIDE_DECELERATION } from "./motion";

export type DeskPhysics = "glide" | "snap" | "free";
export type DeskSpringFeel = "snappy" | "bouncy" | "smooth" | "eased";
export type DeskMotion = "lifted" | "live";
export type DeskGrab = DeskGrabModifier | "off";
/** Whether windows coming and going may move the others (docs/desk-layout.md). */
export type DeskLayoutFeel = "smart" | "hand";
/**
 * How far a page in a window smaller than the desk is zoomed out to suit it (geometry's pageZoom), weakest first:
 * never (Off), and Slight, Medium, Strong, Strongest. Medium and Off keep the ids they had when they were the only
 * two, Fit and Actual size (until 2026-10-11), so what was chosen then, and the specs' pins, still read.
 */
export type DeskPageZoom = "actual" | "slight" | "fit" | "strong" | "strongest";

/** The strength each Page zoom asks of geometry's pageZoom: how many quarters a page loses for each halving of its window's share of the desk. */
export const PAGE_ZOOM_STRENGTH: Record<DeskPageZoom, number> = { actual: 0, slight: 0.5, fit: 1, strong: 1.5, strongest: 2 };

export interface DeskVariants {
  /** What a released window does. */
  physics: DeskPhysics;
  /** The spring every settle rides — or, Eased, a timed ease on transitions.dev's motion tokens instead. */
  spring: DeskSpringFeel;
  /** A carried window: its still, free to lift and tilt — or its live page, flat. */
  motion: DeskMotion;
  /** The key that grabs a window from anywhere on its page. */
  grab: DeskGrab;
  /** Smart: a window coming or going asks the layout model whether the others should move. By hand: they stay put. */
  layout: DeskLayoutFeel;
  /** How far a page is zoomed out as its window takes less of the desk (back to 100% as it fills it), from Off (never) to Strongest. */
  zoom: DeskPageZoom;
  /** Glide's deceleration: the share of its speed a thrown window loses every 100 ms, in percent (GLIDE_DECELERATION). */
  deceleration: number;
}

/** The variants chosen from a list of options (DESK_AXES); `deceleration` is a number instead. */
export type DeskAxisKey = Exclude<keyof DeskVariants, "deceleration">;

interface AxisOption<T extends string> {
  id: T;
  label: string;
  hint: string;
}

interface Axis<K extends DeskAxisKey> {
  key: K;
  label: string;
  options: ReadonlyArray<AxisOption<DeskVariants[K]>>;
}

/** Every variant axis in the order the panel lists them, with words for each choice. */
export const DESK_AXES: readonly [
  Axis<"physics">,
  Axis<"spring">,
  Axis<"motion">,
  Axis<"grab">,
  Axis<"layout">,
  Axis<"zoom">,
] = [
  {
    key: "physics",
    label: "Throw",
    options: [
      { id: "glide", label: "Glide", hint: "Windows keep their momentum and bounce off the edges" },
      { id: "snap", label: "Snap", hint: "Every throw lands in a tile: halves, quarters, full, centre" },
      { id: "free", label: "Free", hint: "Windows stay where they are dropped" },
    ],
  },
  {
    key: "spring",
    label: "Spring",
    options: [
      { id: "snappy", label: "Snappy", hint: "Quick, with a trace of overshoot" },
      { id: "bouncy", label: "Bouncy", hint: "Loose, lands with a wobble" },
      { id: "smooth", label: "Smooth", hint: "Slow and critically damped" },
      { id: "eased", label: "Eased", hint: "Timed eases on the motion tokens: quick, smooth, never past their place" },
    ],
  },
  {
    key: "motion",
    label: "In hand",
    options: [
      { id: "lifted", label: "Lifted", hint: "A carried window lifts, tilts with the throw, and shows its still" },
      { id: "live", label: "Live", hint: "A carried window stays a live page, flat" },
    ],
  },
  {
    key: "grab",
    label: "Grab key",
    options: [
      { id: "shift", label: "⇧ Shift", hint: "Hold Shift and drag anywhere on a page (Shift also snaps: let go of it to place freely)" },
      { id: "alt", label: "⌥ Option", hint: "Hold Option and drag anywhere on a page" },
      { id: "meta", label: "⌘ Command", hint: "Hold Command and drag anywhere on a page" },
      { id: "off", label: "Off", hint: "Only the frame moves a window" },
    ],
  },
  {
    key: "layout",
    label: "Layout",
    options: [
      { id: "smart", label: "Smart", hint: "When a window comes or goes, the desk may lay the others out anew (⌃Z right after puts them back)" },
      { id: "hand", label: "By hand", hint: "Windows stay where they are put; ⌘⌥L still arranges them on request" },
    ],
  },
  {
    key: "zoom",
    label: "Page zoom",
    // Weakest first: the card shows them as the stops of a slider.
    options: [
      { id: "actual", label: "Off", hint: "Every page at 100%, whatever its window's size" },
      { id: "slight", label: "Slight", hint: "A page zooms out a little as its window takes less of the desk: 88% at half of it, 75% at a quarter, 100% filling it" },
      { id: "fit", label: "Medium", hint: "A page zooms out as its window takes less of the desk: 75% at half of it, 50% at a quarter, 100% filling it" },
      { id: "strong", label: "Strong", hint: "A page zooms out further as its window takes less of the desk: 63% at half of it, 50% at a quarter, 100% filling it" },
      { id: "strongest", label: "Strongest", hint: "A page zooms out as far as it goes: 50% at half of the desk or less, 100% filling it" },
    ],
  },
];

export const DEFAULT_DESK_VARIANTS: DeskVariants = {
  physics: "glide",
  spring: "snappy",
  motion: "lifted",
  grab: "shift",
  layout: "smart",
  zoom: "fit",
  deceleration: GLIDE_DECELERATION.default,
};

/** One window as it was left: its tab and its box as fractions of the desk — and, masked, its mask. */
export interface SavedDeskWindow {
  tabId: string;
  rect: Rect;
  mask?: DeskMask;
  /** Minimized (the engine's Minimized): the box it grows back to, as fractions of the desk, and whether it is parked in the shelf at the desk's foot; `own`, that box with no room kept for the chat's place, as `own` below. */
  mini?: { restore: Rect; parked: boolean; own?: Rect };
  /**
   * Its box with no room kept for the chat's place (DeskEngine's #unreserved), as fractions of the whole desk —
   * saved while the room is kept, so the room gone after a relaunch gives the box back exactly (2026-10-10: a window
   * the room had squeezed to its least width came back wider).
   */
  own?: Rect;
}

/** A group's desk as it was left, windows bottom to top. */
export interface SavedDesk {
  windows: SavedDeskWindow[];
  /** How much room was kept for the chat's place (DeskEngine.setReserve), in px: the windows' boxes are of the desk short of it (2026-10-10). Left out: none. */
  reserve?: number;
}

/**
 * A page's own desk's id in what was saved before 2026-10-09 (a tab no
 * group could hold came up on a desk of its own, saved under `tab:<id>`).
 * Every listed tab is in a space now (docs/spaces.md §1), so there is no
 * such desk: its arrangements are dropped as they are read (sanitizeSaved).
 */
const TAB_DESK = "tab:";

/** Every space (tab group) of the Profile in view the desk may show: the ones drawn, the loose tabs', and the pages' (a favorite's, a pin's). */
export function deskGroups(snapshot: ShellSnapshot | null): readonly TabGroupInfo[] {
  if (snapshot === null) return [];
  const loose = snapshot.looseGroups ?? [];
  const pages = snapshot.anchorGroups ?? [];
  return loose.length === 0 && pages.length === 0 ? snapshot.tabGroups : [...snapshot.tabGroups, ...loose, ...pages];
}

/** A page's group's page (TabGroupInfo.anchorId): the tab of it that is its entry's. */
export function groupPageOf(group: TabGroupInfo, tabs: ReadonlyArray<Pick<BrowserTabInfo, "id" | "anchorId">>): string | null {
  if (group.anchorId === undefined) return null;
  return group.tabIds.find((tabId) => tabs.some((tab) => tab.id === tabId && tab.anchorId === group.anchorId)) ?? null;
}

/** A tab a group can hold (main's #groupable): a listed day tab of the person's, not a pinned page's or a favorite's. */
export function isDayTab(tab: BrowserTabInfo): boolean {
  return tab.kind === "human" && !tab.unlisted && tab.anchorId === null;
}

/** A favorite's, preset's or pin's page: the tab a page's group (TabGroupInfo.anchorId) is made for. */
export function isEntryPage(tab: BrowserTabInfo): boolean {
  return tab.kind === "human" && !tab.unlisted && tab.anchorId !== null;
}

/**
 * The tab a group's desk comes up on when the desk passes to it: its top
 * window as it was left, or, none of those still the group's, its tab used last.
 */
export function passedEntry(saved: readonly SavedDeskWindow[], tabs: ReadonlyArray<{ id: string; lastActiveAt: number }>): string | null {
  const top = [...saved].reverse().find((window) => tabs.some((tab) => tab.id === window.tabId))?.tabId;
  return top ?? [...tabs].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id ?? null;
}

interface DeskStore {
  /**
   * Which desk this is: the surface is mounted anew — and its engine starts
   * cold — when this changes, or the Profile (Space) does (ContentArea). A
   * space switch never changes it: the desk passes in place
   * (DeskEngine.switchGroup).
   */
  instance: number;
  variants: DeskVariants;
  saved: Record<string, SavedDesk>;
  /** A screenshot of the desk is being taken: the Bar steps out of the picture (lib/screenshot.ts). */
  capturing: boolean;
  setCapturing(capturing: boolean): void;
  setVariant<K extends keyof DeskVariants>(key: K, value: DeskVariants[K]): void;
  cycleVariant(key: DeskAxisKey): void;
  save(groupId: string, desk: SavedDesk): void;
}

const STORAGE_KEY = "pistachio.desk.v1";
const MAX_SAVED_DESKS = 40;
/**
 * (Until 2026-10-09 this also kept `rail`, whether the desk's sidebar was its
 * rail: the sidebar's mode is a setting now (layout.sidebar, docs/spaces.md
 * §3). A stored one is ignored, not migrated — its `true` was the default,
 * written by every save, not a choice — and no longer written. Until
 * 2026-10-12 the variants also had `chrome`, the frame around each page —
 * Title bar, Tab, Bare or Drawer — and a save its `version`, which read a
 * save from before the Drawer was the default as the Drawer: the Drawer is
 * every window's frame now, and a stored frame or version is ignored.)
 */
interface Persisted {
  variants: DeskVariants;
  saved: Record<string, SavedDesk>;
}

export function readPersistedDesk(raw: string | null): Persisted {
  const fallback: Persisted = { variants: DEFAULT_DESK_VARIANTS, saved: {} };
  if (raw === null) return fallback;
  try {
    const value = JSON.parse(raw) as Partial<Persisted>;
    return { variants: sanitizeVariants(value.variants), saved: sanitizeSaved(value.saved) };
  } catch {
    return fallback;
  }
}

function readPersisted(): Persisted {
  try {
    return readPersistedDesk(typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY));
  } catch {
    return readPersistedDesk(null);
  }
}

export function sanitizeVariants(value: unknown): DeskVariants {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const pick = <K extends DeskAxisKey>(key: K): DeskVariants[K] => {
    const axis = DESK_AXES.find((candidate) => candidate.key === key)!;
    const chosen = axis.options.find((option) => option.id === raw[key]);
    return (chosen?.id ?? DEFAULT_DESK_VARIANTS[key]) as DeskVariants[K];
  };
  const deceleration = raw["deceleration"];
  return {
    physics: pick("physics"),
    spring: pick("spring"),
    motion: pick("motion"),
    grab: pick("grab"),
    layout: pick("layout"),
    zoom: pick("zoom"),
    deceleration:
      typeof deceleration === "number" && Number.isFinite(deceleration)
        ? Math.min(GLIDE_DECELERATION.max, Math.max(GLIDE_DECELERATION.min, Math.round(deceleration)))
        : GLIDE_DECELERATION.default,
  };
}

export function sanitizeSaved(value: unknown): Record<string, SavedDesk> {
  if (typeof value !== "object" || value === null) return {};
  const saved: Record<string, SavedDesk> = {};
  for (const [groupId, desk] of Object.entries(value as Record<string, unknown>).slice(-MAX_SAVED_DESKS)) {
    // A page's own desk (before 2026-10-09): there is none any more, and its tab's space has an arrangement of its own.
    if (groupId.startsWith(TAB_DESK)) continue;
    const windows = (desk as { windows?: unknown } | null)?.windows;
    if (!Array.isArray(windows)) continue;
    const reserve = (desk as { reserve?: unknown }).reserve;
    saved[groupId] = {
      ...(typeof reserve === "number" && Number.isFinite(reserve) && reserve > 0 ? { reserve } : {}),
      windows: windows
        .filter(
          (window): window is SavedDeskWindow =>
            typeof window === "object" && window !== null && typeof (window as SavedDeskWindow).tabId === "string" && isFiniteRect((window as SavedDeskWindow).rect),
        )
        // A mask that does not hold up is dropped, and the window comes back whole; so is a minimized state, and it comes back at its own size.
        .map(({ tabId, rect, mask, mini, own }): SavedDeskWindow => {
          const kept = isFiniteRect(own) ? { own } : {};
          if (isDeskMask(mask)) return { tabId, rect, mask, ...kept };
          if (typeof mini === "object" && mini !== null && isFiniteRect(mini.restore) && typeof mini.parked === "boolean")
            return { tabId, rect, mini: { restore: mini.restore, parked: mini.parked, ...(isFiniteRect(mini.own) ? { own: mini.own } : {}) }, ...kept };
          return { tabId, rect, ...kept };
        }),
    };
  }
  return saved;
}

function persist(state: Persisted): void {
  writeStorageLater(STORAGE_KEY, JSON.stringify(state));
}

const initial = readPersisted();

export const useDeskStore = create<DeskStore>((set, get) => ({
  instance: 0,
  variants: initial.variants,
  saved: initial.saved,
  capturing: false,
  setCapturing: (capturing) => set({ capturing }),
  setVariant: (key, value) => {
    const variants = { ...get().variants, [key]: value };
    set({ variants });
    persist({ variants, saved: get().saved });
  },
  cycleVariant: (key) => {
    const axis = DESK_AXES.find((candidate) => candidate.key === key)!;
    const options = axis.options as ReadonlyArray<{ id: string }>;
    const index = options.findIndex((option) => option.id === get().variants[key]);
    const next = options[(index + 1) % options.length]!.id;
    get().setVariant(key, next as DeskVariants[typeof key]);
  },
  save: (groupId, desk) => {
    const saved = { ...get().saved };
    delete saved[groupId];
    saved[groupId] = desk;
    const keys = Object.keys(saved);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SAVED_DESKS))) delete saved[key];
    set({ saved });
    persist({ variants: get().variants, saved });
  },
}));
