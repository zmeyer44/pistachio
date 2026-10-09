/** Portable, serializable keyboard bindings shared by Electron and React. */

export type ShortcutActionId =
  | "newTab"
  | "editAddress"
  | "closeTab"
  | "togglePin"
  | "reload"
  | "back"
  | "forward"
  | "find"
  | "readerView"
  | "print"
  | "copyUrl"
  | "copyUrlMarkdown"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "toggleSplit"
  | "toggleSidebarPinned"
  | "toggleConsole"
  | "toggleEvidence"
  | "openSettings"
  | "openReminders"
  | "openBookmarks"
  | "bookmarkPage"
  | "delegate"
  | "forkSpace"
  | "restoreClosedTab"
  | "openDownloads"
  | "tidyTabs"
  | "smartFind"
  | "newNote"
  | "openNotes"
  | "tileDesk"
  | "cascadeDesk"
  | "arrangeDesk"
  | "toggleDesk"
  | "screenshotView"
  | "screenshotArea";

export type ShortcutSettings = Record<ShortcutActionId, string | null>;
export type ShortcutPlatform = "darwin" | "other";
export const RUN_SHORTCUT_EVENT = "pistachio:run-shortcut";

/** Where the shell runs: the Mac's own window ("native") or a browser tab over a cloud session ("stream"). */
export type ShortcutSurface = "native" | "stream";

export interface ShortcutDefinition {
  id: ShortcutActionId;
  group: "Tabs" | "Page" | "Window" | "Agent";
  label: string;
  note?: string;
  /**
   * The surfaces that offer the action — list it, bind it, run it; absent,
   * both. Empty, it is RETIRED: offered nowhere and holding no key
   * (sanitizeShortcuts), its id kept only because the ids are the keys of
   * everyone's saved shortcuts and of the synced settings record.
   */
  surfaces?: readonly ShortcutSurface[];
}

/** Whether `surface` offers the action (ShortcutDefinition.surfaces). */
export function shortcutOffered(definition: Pick<ShortcutDefinition, "surfaces">, surface: ShortcutSurface): boolean {
  return definition.surfaces === undefined || definition.surfaces.includes(surface);
}

/** An action offered nowhere: its id stays (a key in saved shortcuts), its key never does. */
function retired(definition: Pick<ShortcutDefinition, "surfaces">): boolean {
  return definition.surfaces !== undefined && definition.surfaces.length === 0;
}

export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  { id: "newTab", group: "Tabs", label: "New tab", note: "Uses the new-tab behavior from General." },
  { id: "editAddress", group: "Tabs", label: "Edit address" },
  { id: "closeTab", group: "Tabs", label: "Close tab", note: "Still asks before closing a tab with a live run." },
  { id: "togglePin", group: "Tabs", label: "Pin or unpin tab" },
  { id: "reload", group: "Page", label: "Reload" },
  { id: "back", group: "Page", label: "Back" },
  { id: "forward", group: "Page", label: "Forward" },
  { id: "find", group: "Page", label: "Find in page" },
  { id: "readerView", group: "Page", label: "Reader view", note: "Shows the article's prose; again returns to the page." },
  { id: "print", group: "Page", label: "Print page" },
  { id: "copyUrl", group: "Page", label: "Copy page URL" },
  { id: "copyUrlMarkdown", group: "Page", label: "Copy page URL as Markdown", note: "A [title](url) link, ready to paste into notes or a doc." },
  { id: "zoomIn", group: "Page", label: "Zoom in" },
  { id: "zoomOut", group: "Page", label: "Zoom out" },
  { id: "zoomReset", group: "Page", label: "Actual size" },
  // Splits are the web's alone since 2026-10-09: a desk tiles windows instead (docs/spaces.md §1).
  { id: "toggleSplit", group: "Window", label: "Toggle split view", surfaces: ["stream"] },
  // (The id predates the three modes: it is a key in everyone's saved shortcuts, so it stays.)
  { id: "toggleSidebarPinned", group: "Window", label: "Cycle sidebar", note: "Whole, a rail of icons, or hidden until the pointer reaches the window's left edge." },
  { id: "toggleConsole", group: "Agent", label: "Toggle agent chat" },
  { id: "toggleEvidence", group: "Agent", label: "Toggle activity replay" },
  { id: "openSettings", group: "Window", label: "Settings" },
  { id: "openReminders", group: "Agent", label: "Reminders", note: "Scheduled messages and agent tasks." },
  { id: "openBookmarks", group: "Page", label: "Bookmarks", note: "Everything saved." },
  { id: "bookmarkPage", group: "Page", label: "Bookmark this page", note: "Tapping shift twice always works; add a key here too if you like." },
  { id: "delegate", group: "Agent", label: "Ask Pistachio about active tab" },
  { id: "forkSpace", group: "Window", label: "Fork current Profile" },
  // Last on purpose: a binding someone gave another action before this one
  // existed keeps it (sanitizeShortcuts resolves duplicates in this order).
  { id: "restoreClosedTab", group: "Tabs", label: "Reopen closed tab", note: "Brings back the last tab you closed, with its history, in the Profile it was in." },
  { id: "openDownloads", group: "Page", label: "Downloads", note: "This session's downloads, from every tab." },
  { id: "tidyTabs", group: "Tabs", label: "Tidy tabs", note: "Archives idle tabs and puts related ones in a space, now. One Undo takes it back." },
  { id: "smartFind", group: "Page", label: "Find by meaning", note: "Describe what you're looking for; the page's text is sent to the model." },
  { id: "newNote", group: "Page", label: "New note", note: "Opens a blank note in a tab; there is nothing to save." },
  { id: "openNotes", group: "Page", label: "Open notes", note: "Everything you have written." },
  // The desk is the Mac's alone (docs/spaces.md): the web keeps the pane surface.
  { id: "tileDesk", group: "Window", label: "Tile the windows", note: "Every window in the space, side by side.", surfaces: ["native"] },
  { id: "cascadeDesk", group: "Window", label: "Cascade the windows", note: "Every window in the space, fanned from the corner.", surfaces: ["native"] },
  { id: "arrangeDesk", group: "Window", label: "Arrange the windows", note: "Every window in the space, laid out the way the layout model judges they are used.", surfaces: ["native"] },
  // Retired: there is no desk to toggle, and its ⌥⌘\ is free for another action.
  { id: "toggleDesk", group: "Window", label: "Toggle desk (retired)", note: "The desk is always up since 2026-10-09.", surfaces: [] },
  { id: "screenshotView", group: "Window", label: "Screenshot the page", note: "The desk, without the sidebar or the window around it. Copied, and saved where your Mac saves screenshots." },
  { id: "screenshotArea", group: "Window", label: "Screenshot an area", note: "Drag over the part of the window to keep; Escape cancels. Copied, and saved where your Mac saves screenshots." },
];

export const SHORTCUT_ACTION_IDS = SHORTCUT_DEFINITIONS.map((definition) => definition.id) as readonly ShortcutActionId[];

const SHORTCUT_SURFACES: readonly ShortcutSurface[] = ["native", "stream"];

/**
 * Whether two actions are ever offered on one surface — and so may not hold
 * one key (since 2026-10-09). The shortcuts are one record that crosses
 * between a Mac and a browser tab (sync's `settings:shell`), and each
 * surface reads only what it offers (shortcutActionForEvent's `surface`):
 * the web's split and a desk key only the Mac offers never meet, so either
 * may take the other's key; an action offered on both meets every other
 * that is offered anywhere. (Until then any two clashed: ⌘\, the split's,
 * could be given to nothing on the desktop, which does not list the split,
 * nor ⌥⌘T and the desk's other keys on the web.)
 */
export function shortcutsMeet(a: ShortcutActionId, b: ShortcutActionId): boolean {
  return SHORTCUT_SURFACES.some((surface) => offeredOn(a, surface) && offeredOn(b, surface));
}

export const DEFAULT_SHORTCUTS: ShortcutSettings = {
  newTab: "Mod+T",
  editAddress: "Mod+L",
  closeTab: "Mod+W",
  togglePin: "Mod+D",
  reload: "Mod+R",
  back: "Mod+BracketLeft",
  forward: "Mod+BracketRight",
  find: "Mod+F",
  readerView: "Mod+Shift+A",
  print: "Mod+P",
  copyUrl: "Mod+Shift+C",
  copyUrlMarkdown: "Mod+Alt+Shift+C",
  zoomIn: "Mod+Plus",
  zoomOut: "Mod+Minus",
  zoomReset: "Mod+0",
  toggleSplit: "Mod+Backslash",
  toggleSidebarPinned: "Mod+S",
  toggleConsole: "Mod+I",
  toggleEvidence: "Mod+E",
  openSettings: "Mod+Comma",
  openReminders: "Mod+Shift+R",
  openBookmarks: "Mod+Shift+B",
  bookmarkPage: null,
  delegate: "Mod+Shift+D",
  forkSpace: "Mod+Shift+F",
  restoreClosedTab: "Mod+Shift+T",
  openDownloads: "Mod+Shift+J",
  tidyTabs: "Mod+Shift+K",
  smartFind: "Mod+Alt+F",
  newNote: "Mod+Alt+N",
  openNotes: null,
  tileDesk: "Mod+Alt+T",
  cascadeDesk: "Mod+Alt+C",
  arrangeDesk: "Mod+Alt+L",
  // Retired (2026-10-09): no key — it was ⌥⌘\, beside ⌘\ (split view), which is free again.
  toggleDesk: null,
  // Beside the Mac's own ⌘⇧3 and ⌘⇧4, which take the whole screen.
  screenshotView: "Mod+Shift+1",
  screenshotArea: "Mod+Shift+2",
};

const NAMED_KEYS = new Set([
  "Plus",
  "Minus",
  "Comma",
  "Period",
  "Slash",
  "Backslash",
  "Semicolon",
  "Quote",
  "BracketLeft",
  "BracketRight",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Enter",
  "Backspace",
  "Delete",
  "Space",
]);

const KEY_ALIASES: Record<string, string> = {
  "+": "Plus",
  "=": "Plus",
  "-": "Minus",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  " ": "Space",
};

interface ParsedShortcut {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

function normalizeKey(value: string): string | null {
  const alias = KEY_ALIASES[value];
  if (alias !== undefined) return alias;
  if (/^[a-z]$/i.test(value)) return value.toUpperCase();
  if (/^[0-9]$/.test(value)) return value;
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(value)) return value.toUpperCase();
  const named = [...NAMED_KEYS].find((candidate) => candidate.toLowerCase() === value.toLowerCase());
  return named ?? null;
}

function parseShortcut(value: unknown): ParsedShortcut | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 80) return null;
  const parts = value.split("+");
  const rawKey = parts.pop();
  if (rawKey === undefined) return null;
  const key = normalizeKey(rawKey);
  if (key === null) return null;
  let mod = false;
  let alt = false;
  let shift = false;
  for (const raw of parts) {
    const part = raw.toLowerCase();
    if (part === "mod" && !mod) mod = true;
    else if ((part === "alt" || part === "option") && !alt) alt = true;
    else if (part === "shift" && !shift) shift = true;
    else return null;
  }
  if (!mod && !alt && !/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key)) return null;
  // Plus already describes the shifted equals key. Keeping Shift as a
  // second modifier would make the same physical press have two spellings.
  if (key === "Plus") shift = false;
  return { mod, alt, shift, key };
}

function serializeShortcut(shortcut: ParsedShortcut): string {
  return [...(shortcut.mod ? ["Mod"] : []), ...(shortcut.alt ? ["Alt"] : []), ...(shortcut.shift ? ["Shift"] : []), shortcut.key].join("+");
}

export function normalizeShortcut(value: unknown): string | null {
  const parsed = parseShortcut(value);
  return parsed === null ? null : serializeShortcut(parsed);
}

export function isShortcutActionId(value: unknown): value is ShortcutActionId {
  return typeof value === "string" && (SHORTCUT_ACTION_IDS as readonly string[]).includes(value);
}

/**
 * Bad or duplicate file entries become unassigned instead of shadowing another action, and so does a retired action's
 * (ShortcutDefinition.surfaces empty), whatever the file says: a key it held — ⌥⌘\ for Toggle desk, saved in every
 * file written before 2026-10-09 — is free for another. A duplicate is a key held by two actions some surface offers
 * both of (shortcutsMeet): the web's split may keep ⌘\ while a desk key on the Mac has it too.
 */
export function sanitizeShortcuts(value: unknown, fallback: ShortcutSettings = DEFAULT_SHORTCUTS): ShortcutSettings {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const out = {} as ShortcutSettings;
  const kept: Array<{ id: ShortcutActionId; binding: string }> = [];
  for (const definition of SHORTCUT_DEFINITIONS) {
    const id = definition.id;
    const candidate = retired(definition) ? null : Object.hasOwn(raw, id) ? raw[id] : fallback[id];
    if (candidate === null) {
      out[id] = null;
      continue;
    }
    const normalized = normalizeShortcut(candidate);
    if (normalized === null || kept.some((other) => other.binding === normalized && shortcutsMeet(other.id, id))) {
      out[id] = null;
      continue;
    }
    kept.push({ id, binding: normalized });
    out[id] = normalized;
  }
  return out;
}

export interface PortableShortcutEvent {
  key: string;
  /**
   * The physical key (`KeyC`, `Digit0`), read when `key` is not a portable
   * name: with Option held, macOS reports the composed character ("ç", "Ç")
   * as the key, and a binding could never match on that.
   */
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** Electron Input names the modifier fields without the `Key` suffix. */
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** The portable key a physical-key code names, or null for one no binding can hold. */
function keyFromCode(code: string | undefined): string | null {
  if (code === undefined) return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) return letter[1]!;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit !== null) return digit[1]!;
  if (code === "Equal") return "Plus";
  return normalizeKey(code);
}

export function shortcutFromEvent(input: PortableShortcutEvent, platform: ShortcutPlatform): string | null {
  const meta = input.metaKey ?? input.meta ?? false;
  const control = input.ctrlKey ?? input.control ?? false;
  const alt = input.altKey ?? input.alt ?? false;
  // With Option down the character is the composed one (⌥⇧C is "Ç"), so the
  // physical key names the binding; otherwise the character does, so a
  // binding follows the person's keyboard layout, and the code is only a
  // fallback for a character no binding can hold.
  const key = (alt ? keyFromCode(input.code) : null) ?? normalizeKey(input.key) ?? keyFromCode(input.code);
  if (key === null) return null;
  let shift = input.shiftKey ?? input.shift ?? false;
  const mod = platform === "darwin" ? meta : control;
  // An explicit Control modifier on macOS is intentionally not stored: the
  // binding remains portable, and browser/editor control keys stay intact.
  if ((platform === "darwin" && control) || (platform !== "darwin" && meta)) return null;
  if (key === "Plus") shift = false;
  const parsed = { mod, alt, shift, key };
  if (!mod && !alt && !/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key)) return null;
  return serializeShortcut(parsed);
}

/**
 * The action a key event runs. Given `surface`, an action that surface does
 * not offer (shortcutOffered) holds no key there: its key reaches the page
 * instead — ⌘\ (Toggle split view, the web's alone) on the desktop. Unsaid,
 * every action is matched, as before 2026-10-09. (A key two actions hold is
 * one surface's each — they never meet, shortcutsMeet — so given a surface,
 * the one found is that surface's own.)
 */
export function shortcutActionForEvent(
  settings: ShortcutSettings,
  input: PortableShortcutEvent,
  platform: ShortcutPlatform,
  surface?: ShortcutSurface,
): ShortcutActionId | null {
  const binding = shortcutFromEvent(input, platform);
  if (binding === null) return null;
  return SHORTCUT_ACTION_IDS.find((id) => settings[id] === binding && (surface === undefined || offeredOn(id, surface))) ?? null;
}

/** Whether `surface` offers the action `id` (its definition's surfaces). */
function offeredOn(id: ShortcutActionId, surface: ShortcutSurface): boolean {
  const definition = SHORTCUT_DEFINITIONS.find((candidate) => candidate.id === id);
  return definition === undefined || shortcutOffered(definition, surface);
}

/** Editing, app-lifecycle, and OS window bindings we refuse to steal. */
export function reservedShortcutReason(binding: string): string | null {
  const normalized = normalizeShortcut(binding);
  if (normalized === null) return "Use Command/Ctrl, Option/Alt, or a function key.";
  const reserved = new Set([
    "Mod+A",
    "Mod+C",
    "Mod+X",
    "Mod+V",
    "Mod+Z",
    "Mod+Shift+Z",
    "Mod+Q",
    "Mod+H",
    "Mod+M",
  ]);
  return reserved.has(normalized) ? "That shortcut is reserved for editing or the operating system." : null;
}

/**
 * The action already holding `binding` that keeps `except` from it: one it
 * meets on some surface (shortcutsMeet). Given `surface` (Settings ›
 * Shortcuts passes its own), only one that surface offers — the page lists
 * nothing else, so a key held elsewhere alone is free here; a holder that
 * meets `except` only elsewhere gives it up in the same write
 * (shortcutsGivingUp).
 */
export function shortcutConflict(settings: ShortcutSettings, binding: string, except: ShortcutActionId, surface?: ShortcutSurface): ShortcutDefinition | null {
  const normalized = normalizeShortcut(binding);
  if (normalized === null) return null;
  const id = SHORTCUT_ACTION_IDS.find(
    (candidate) => candidate !== except && settings[candidate] === normalized && shortcutsMeet(candidate, except) && (surface === undefined || offeredOn(candidate, surface)),
  );
  return id === undefined ? null : (SHORTCUT_DEFINITIONS.find((definition) => definition.id === id) ?? null);
}

/**
 * The actions `surface` does not offer that hold `binding` and meet
 * `except` elsewhere. `except` given `binding` on that surface (Settings ›
 * Shortcuts, which does not list them: no conflict there, shortcutConflict)
 * takes the key from them in the same write — the record is one, and two
 * actions that meet may not share a key (sanitizeShortcuts; the settings
 * writer refuses the clash). The Mac's Reload given ⌘\ takes it from the
 * web's split; a desk key given it leaves the split its key (2026-10-09).
 */
export function shortcutsGivingUp(settings: ShortcutSettings, binding: string, except: ShortcutActionId, surface: ShortcutSurface): ShortcutActionId[] {
  const normalized = normalizeShortcut(binding);
  if (normalized === null) return [];
  return SHORTCUT_ACTION_IDS.filter(
    (candidate) => candidate !== except && settings[candidate] === normalized && !offeredOn(candidate, surface) && shortcutsMeet(candidate, except),
  );
}

const KEY_LABELS: Record<string, string> = {
  Plus: "+",
  Minus: "−",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Backspace: "⌫",
  Delete: "Del",
  Enter: "↩",
  Space: "Space",
};

export function shortcutParts(binding: string | null, platform: ShortcutPlatform): string[] {
  if (binding === null) return [];
  const shortcut = parseShortcut(binding);
  if (shortcut === null) return [];
  return [
    ...(shortcut.mod ? [platform === "darwin" ? "⌘" : "Ctrl"] : []),
    ...(shortcut.alt ? [platform === "darwin" ? "⌥" : "Alt"] : []),
    ...(shortcut.shift ? [platform === "darwin" ? "⇧" : "Shift"] : []),
    KEY_LABELS[shortcut.key] ?? shortcut.key,
  ];
}

export function shortcutLabel(binding: string | null, platform: ShortcutPlatform): string | null {
  const parts = shortcutParts(binding, platform);
  if (parts.length === 0) return null;
  return platform === "darwin" ? parts.join("") : parts.join("+");
}

/** Electron's application-menu spelling of a portable binding. */
export function shortcutAccelerator(binding: string | null): string | undefined {
  if (binding === null) return undefined;
  const shortcut = parseShortcut(binding);
  if (shortcut === null) return undefined;
  return [
    ...(shortcut.mod ? ["CommandOrControl"] : []),
    ...(shortcut.alt ? ["Alt"] : []),
    ...(shortcut.shift ? ["Shift"] : []),
    shortcut.key,
  ].join("+");
}
