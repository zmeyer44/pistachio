/**
 * The desk's own state (components/desk): which tab group has its desk up,
 * how each group's windows were last arranged, and the variants the person
 * is trying. None of it is the browser's — main never hears of an
 * arrangement — so it lives here and in this device's storage, apart from
 * the shell's store and its snapshot.
 */

import { create } from "zustand";
import { isDeskMask, type DeskGrabModifier, type DeskMask } from "@pistachio/shell-contracts/desk";
import { writeStorageLater } from "../deferred-storage";
import { isFiniteRect, type Rect } from "./geometry";
import { GLIDE_DECELERATION } from "./motion";

export type DeskPhysics = "glide" | "snap" | "free";
export type DeskSpringFeel = "snappy" | "bouncy" | "smooth" | "eased";
export type DeskMotion = "lifted" | "live";
export type DeskChrome = "bar" | "tab" | "bare";
export type DeskGrab = DeskGrabModifier | "off";
/** Whether windows coming and going may move the others (docs/desk-layout.md). */
export type DeskLayoutFeel = "smart" | "hand";

export interface DeskVariants {
  /** What a released window does. */
  physics: DeskPhysics;
  /** The spring every settle rides — or, Eased, a timed ease on transitions.dev's motion tokens instead. */
  spring: DeskSpringFeel;
  /** A carried window: its still, free to lift and tilt — or its live page, flat. */
  motion: DeskMotion;
  /** The frame around each page. */
  chrome: DeskChrome;
  /** The key that grabs a window from anywhere on its page. */
  grab: DeskGrab;
  /** Smart: a window coming or going asks the layout model whether the others should move. By hand: they stay put. */
  layout: DeskLayoutFeel;
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
  Axis<"chrome">,
  Axis<"grab">,
  Axis<"layout">,
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
    key: "chrome",
    label: "Frame",
    options: [
      { id: "bar", label: "Title bar", hint: "A title bar above each page" },
      { id: "tab", label: "Tab", hint: "A folder tab on each page's shoulder" },
      { id: "bare", label: "Bare", hint: "Just the page, with a handle above it" },
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
      { id: "smart", label: "Smart", hint: "When a window comes or goes, the desk may lay the others out anew (Undo in the notice)" },
      { id: "hand", label: "By hand", hint: "Windows stay where they are put; ⌘⌥L still arranges them on request" },
    ],
  },
];

export const DEFAULT_DESK_VARIANTS: DeskVariants = {
  physics: "glide",
  spring: "snappy",
  motion: "lifted",
  chrome: "bar",
  grab: "shift",
  layout: "smart",
  deceleration: GLIDE_DECELERATION.default,
};

/** One window as it was left: its tab and its box as fractions of the desk — and, masked, its mask. */
export interface SavedDeskWindow {
  tabId: string;
  rect: Rect;
  mask?: DeskMask;
  /** Minimized (the engine's Minimized): the box it grows back to, as fractions of the desk, and whether it is parked in the shelf at the desk's foot. */
  mini?: { restore: Rect; parked: boolean };
}

/** A group's desk as it was left, windows bottom to top. */
export interface SavedDesk {
  windows: SavedDeskWindow[];
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
  /** The group whose desk is up, or null. */
  groupId: string | null;
  /**
   * Which desk this is: a desk opened afresh is a new one (the surface is
   * mounted anew), while one passed to another group in place (switchTo)
   * stays the same desk, which runs the passing itself.
   */
  instance: number;
  /**
   * The group whose desk is waiting for the sidebar to go (sidebarGone): the
   * sidebar is put away while a desk is up, and the desk opens over the
   * whole row only once it has, so the page it lifts off is already there.
   */
  opening: string | null;
  /** The desk is putting itself away; the surface finishes it (finishLeave). */
  leaving: boolean;
  variants: DeskVariants;
  saved: Record<string, SavedDesk>;
  /** Open the group's desk — once the sidebar has gone, with `afterSidebar` (the sidebar layout). */
  open(groupId: string, options?: { afterSidebar?: boolean }): void;
  /** The sidebar has gone: the desk waiting for it opens. */
  sidebarGone(): void;
  /** The desk that is up passes to another group, in place: its surface runs the passing (DeskEngine.switchGroup). */
  switchTo(groupId: string): void;
  /** Put the desk away — with its closing motion unless `immediate`. */
  leave(options?: { immediate?: boolean }): void;
  /** The surface's closing motion is done. */
  finishLeave(): void;
  setVariant<K extends keyof DeskVariants>(key: K, value: DeskVariants[K]): void;
  cycleVariant(key: DeskAxisKey): void;
  save(groupId: string, desk: SavedDesk): void;
}

const STORAGE_KEY = "pistachio.desk.v1";
const MAX_SAVED_DESKS = 40;

interface Persisted {
  variants: DeskVariants;
  saved: Record<string, SavedDesk>;
}

function readPersisted(): Persisted {
  const fallback: Persisted = { variants: DEFAULT_DESK_VARIANTS, saved: {} };
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    if (raw === null) return fallback;
    const value = JSON.parse(raw) as Partial<Persisted>;
    return { variants: sanitizeVariants(value.variants), saved: sanitizeSaved(value.saved) };
  } catch {
    return fallback;
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
    chrome: pick("chrome"),
    grab: pick("grab"),
    layout: pick("layout"),
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
    const windows = (desk as { windows?: unknown } | null)?.windows;
    if (!Array.isArray(windows)) continue;
    saved[groupId] = {
      windows: windows
        .filter(
          (window): window is SavedDeskWindow =>
            typeof window === "object" && window !== null && typeof (window as SavedDeskWindow).tabId === "string" && isFiniteRect((window as SavedDeskWindow).rect),
        )
        // A mask that does not hold up is dropped, and the window comes back whole; so is a minimized state, and it comes back at its own size.
        .map(({ tabId, rect, mask, mini }): SavedDeskWindow => {
          if (isDeskMask(mask)) return { tabId, rect, mask };
          if (typeof mini === "object" && mini !== null && isFiniteRect(mini.restore) && typeof mini.parked === "boolean")
            return { tabId, rect, mini: { restore: mini.restore, parked: mini.parked } };
          return { tabId, rect };
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
  groupId: null,
  instance: 0,
  opening: null,
  leaving: false,
  variants: initial.variants,
  saved: initial.saved,
  open: (groupId, options) =>
    set(
      options?.afterSidebar === true
        ? { opening: groupId, groupId: null, leaving: false }
        : { groupId, instance: get().instance + 1, opening: null, leaving: false },
    ),
  sidebarGone: () => {
    const opening = get().opening;
    if (opening !== null) set({ groupId: opening, instance: get().instance + 1, opening: null, leaving: false });
  },
  switchTo: (groupId) => {
    const state = get();
    if (state.groupId === null || state.leaving || state.groupId === groupId) return;
    set({ groupId });
  },
  leave: (options) => {
    // Still waiting for the sidebar: it never opened.
    if (get().opening !== null) set({ opening: null });
    if (get().groupId === null) return;
    set(options?.immediate === true ? { groupId: null, leaving: false } : { leaving: true });
  },
  finishLeave: () => set({ groupId: null, leaving: false }),
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
