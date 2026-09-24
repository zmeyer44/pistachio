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
  | "openNotes";

export type ShortcutSettings = Record<ShortcutActionId, string | null>;
export type ShortcutPlatform = "darwin" | "other";
export const RUN_SHORTCUT_EVENT = "pistachio:run-shortcut";

export interface ShortcutDefinition {
  id: ShortcutActionId;
  group: "Tabs" | "Page" | "Window" | "Agent";
  label: string;
  note?: string;
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
  { id: "toggleSplit", group: "Window", label: "Toggle split view" },
  { id: "toggleSidebarPinned", group: "Window", label: "Pin or hide sidebar", note: "Used in sidebar layout." },
  { id: "toggleConsole", group: "Agent", label: "Toggle agent chat" },
  { id: "toggleEvidence", group: "Agent", label: "Toggle activity replay" },
  { id: "openSettings", group: "Window", label: "Settings" },
  { id: "openReminders", group: "Agent", label: "Reminders", note: "Scheduled messages and agent tasks." },
  { id: "openBookmarks", group: "Page", label: "Bookmarks", note: "Everything saved." },
  { id: "bookmarkPage", group: "Page", label: "Bookmark this page", note: "Tapping shift twice always works; add a key here too if you like." },
  { id: "delegate", group: "Agent", label: "Ask Pistachio about active tab" },
  { id: "forkSpace", group: "Window", label: "Fork current Space" },
  // Last on purpose: a binding someone gave another action before this one
  // existed keeps it (sanitizeShortcuts resolves duplicates in this order).
  { id: "restoreClosedTab", group: "Tabs", label: "Reopen closed tab", note: "Brings back the last tab you closed, with its history, in the Space it was in." },
  { id: "openDownloads", group: "Page", label: "Downloads", note: "This session's downloads, from every tab." },
  { id: "tidyTabs", group: "Tabs", label: "Tidy tabs", note: "Archives idle tabs and groups related ones, now. One Undo takes it back." },
  { id: "smartFind", group: "Page", label: "Find by meaning", note: "Describe what you're looking for; the page's text is sent to the model." },
  { id: "newNote", group: "Page", label: "New note", note: "Opens a blank note in a tab; there is nothing to save." },
  { id: "openNotes", group: "Page", label: "Open notes", note: "Everything you have written." },
];

export const SHORTCUT_ACTION_IDS = SHORTCUT_DEFINITIONS.map((definition) => definition.id) as readonly ShortcutActionId[];

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

/** Bad or duplicate file entries become unassigned instead of shadowing another action. */
export function sanitizeShortcuts(value: unknown, fallback: ShortcutSettings = DEFAULT_SHORTCUTS): ShortcutSettings {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const out = {} as ShortcutSettings;
  const seen = new Set<string>();
  for (const id of SHORTCUT_ACTION_IDS) {
    const candidate = Object.hasOwn(raw, id) ? raw[id] : fallback[id];
    if (candidate === null) {
      out[id] = null;
      continue;
    }
    const normalized = normalizeShortcut(candidate);
    if (normalized === null || seen.has(normalized)) {
      out[id] = null;
      continue;
    }
    seen.add(normalized);
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

export function shortcutActionForEvent(
  settings: ShortcutSettings,
  input: PortableShortcutEvent,
  platform: ShortcutPlatform,
): ShortcutActionId | null {
  const binding = shortcutFromEvent(input, platform);
  if (binding === null) return null;
  return SHORTCUT_ACTION_IDS.find((id) => settings[id] === binding) ?? null;
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

export function shortcutConflict(settings: ShortcutSettings, binding: string, except: ShortcutActionId): ShortcutDefinition | null {
  const normalized = normalizeShortcut(binding);
  if (normalized === null) return null;
  const id = SHORTCUT_ACTION_IDS.find((candidate) => candidate !== except && settings[candidate] === normalized);
  return id === undefined ? null : (SHORTCUT_DEFINITIONS.find((definition) => definition.id === id) ?? null);
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
