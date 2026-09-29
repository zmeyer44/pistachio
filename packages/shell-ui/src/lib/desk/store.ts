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

export type DeskPhysics = "glide" | "snap" | "free";
export type DeskSpringFeel = "snappy" | "bouncy" | "smooth";
export type DeskMotion = "lifted" | "live";
export type DeskChrome = "bar" | "tab" | "bare";
export type DeskGrab = DeskGrabModifier | "off";

export interface DeskVariants {
  /** What a released window does. */
  physics: DeskPhysics;
  /** The spring every settle rides. */
  spring: DeskSpringFeel;
  /** A carried window: its still, free to lift and tilt — or its live page, flat. */
  motion: DeskMotion;
  /** The frame around each page. */
  chrome: DeskChrome;
  /** The key that grabs a window from anywhere on its page. */
  grab: DeskGrab;
}

interface AxisOption<T extends string> {
  id: T;
  label: string;
  hint: string;
}

interface Axis<K extends keyof DeskVariants> {
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
];

export const DEFAULT_DESK_VARIANTS: DeskVariants = {
  physics: "glide",
  spring: "snappy",
  motion: "lifted",
  chrome: "bar",
  grab: "shift",
};

/** One window as it was left: its tab and its box as fractions of the desk — and, masked, its mask. */
export interface SavedDeskWindow {
  tabId: string;
  rect: Rect;
  mask?: DeskMask;
}

/** A group's desk as it was left, windows bottom to top. */
export interface SavedDesk {
  windows: SavedDeskWindow[];
}

interface DeskStore {
  /** The group whose desk is up, or null. */
  groupId: string | null;
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
  /** Put the desk away — with its closing motion unless `immediate`. */
  leave(options?: { immediate?: boolean }): void;
  /** The surface's closing motion is done. */
  finishLeave(): void;
  setVariant<K extends keyof DeskVariants>(key: K, value: DeskVariants[K]): void;
  cycleVariant(key: keyof DeskVariants): void;
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
  const pick = <K extends keyof DeskVariants>(key: K): DeskVariants[K] => {
    const axis = DESK_AXES.find((candidate) => candidate.key === key)!;
    const chosen = axis.options.find((option) => option.id === raw[key]);
    return (chosen?.id ?? DEFAULT_DESK_VARIANTS[key]) as DeskVariants[K];
  };
  return { physics: pick("physics"), spring: pick("spring"), motion: pick("motion"), chrome: pick("chrome"), grab: pick("grab") };
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
        // A mask that does not hold up is dropped, and the window comes back whole.
        .map(({ tabId, rect, mask }) => (isDeskMask(mask) ? { tabId, rect, mask } : { tabId, rect })),
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
  opening: null,
  leaving: false,
  variants: initial.variants,
  saved: initial.saved,
  open: (groupId, options) =>
    set(options?.afterSidebar === true ? { opening: groupId, groupId: null, leaving: false } : { groupId, opening: null, leaving: false }),
  sidebarGone: () => {
    const opening = get().opening;
    if (opening !== null) set({ groupId: opening, opening: null, leaving: false });
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
