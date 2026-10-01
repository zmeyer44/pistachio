/**
 * Shared, deterministic pieces of the tab switcher: the MRU history, the
 * held-modifier gesture main reads from every view's keyboard, and the grid
 * walk the shell does over the cards.
 */

/** The most cards the switcher ever shows; a small window shows fewer. */
export const TAB_SWITCHER_LIMIT = 15;
/**
 * How long ⌥⌘ or ⌥⌃ held on their own wait before they bring the switcher up
 * without a Tab (Settings → Tabs). At once; a beat, short enough to feel
 * instant yet longer than a shortcut typed at speed takes to follow its
 * modifier; or the original, deliberate hold.
 */
export type TabSwitcherHold = "instant" | "short" | "long";
export const TAB_SWITCHER_HOLDS: readonly TabSwitcherHold[] = ["instant", "short", "long"];
export const TAB_SWITCHER_HOLD_MS: Readonly<Record<TabSwitcherHold, number>> = { instant: 0, short: 150, long: 400 };
export const DEFAULT_TAB_SWITCHER_HOLD: TabSwitcherHold = "short";
const TAB_HISTORY_LIMIT = 100;

/**
 * What is held for the switcher, whose release commits the selection: ⌥
 * with ⌘ or with ⌃ (held on their own, or with Tab), or ⌃ alone after ⌃Tab.
 * Either key of a pair let go is the release.
 */
export type TabSwitcherModifier = "alt+meta" | "alt+control" | "control";

/** The flags a key event or a pointer event carries. */
export interface ModifierFlags {
  control: boolean;
  meta: boolean;
  alt: boolean;
}

/** Whether what the switcher is held by is still down, by an event's flags. */
export function tabSwitcherHeld(modifier: TabSwitcherModifier, flags: ModifierFlags): boolean {
  switch (modifier) {
    case "alt+meta":
      return flags.alt && flags.meta;
    case "alt+control":
      return flags.alt && flags.control;
    case "control":
      return flags.control;
  }
}
export type TabSwitcherDirection = "left" | "right" | "up" | "down";

/** Move one visited tab to the front without letting stale history grow forever. */
export function recordTabVisit(history: readonly string[], tabId: string): string[] {
  return [tabId, ...history.filter((candidate) => candidate !== tabId)].slice(0, TAB_HISTORY_LIMIT);
}

/** Turn a signed number of MRU steps into a list index, wrapping both ways. */
export function tabSwitcherIndex(offset: number, count: number): number {
  if (count < 1) return 0;
  return ((offset % count) + count) % count;
}

/**
 * An arrow key's move over cards laid out `columns` to a row (the last row
 * may be short). ←/→ walk the list and wrap, like Tab; ↑/↓ change rows and
 * stop at the edges.
 */
export function tabSwitcherMove(index: number, direction: TabSwitcherDirection, count: number, columns: number): number {
  if (count < 1) return 0;
  const cols = Math.max(1, Math.min(columns, count));
  switch (direction) {
    case "left":
      return tabSwitcherIndex(index - 1, count);
    case "right":
      return tabSwitcherIndex(index + 1, count);
    case "up":
      return index - cols < 0 ? index : index - cols;
    case "down": {
      if (Math.floor(index / cols) === Math.floor((count - 1) / cols)) return index;
      return Math.min(index + cols, count - 1);
    }
  }
}

/** What the switcher needs of a key event; Electron's `Input` has these fields. */
export interface SwitcherKey {
  type: string;
  key: string;
  /** The physical key (`KeyB`), which names a shortcut typed with Option held. */
  code?: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  isAutoRepeat?: boolean;
}

/** Main → shell: the gesture's lifecycle, whichever view had the keyboard. */
export type TabSwitcherInput =
  /** Show the switcher; `step` 0 selects the active tab, ±1 the tab after or before it. */
  | { type: "open"; modifier: TabSwitcherModifier; step: -1 | 0 | 1 }
  | { type: "step"; reverse: boolean }
  | { type: "move"; direction: TabSwitcherDirection }
  | { type: "commit" }
  | { type: "cancel" };

export interface SwitcherOutcome {
  /** The key belongs to the switcher: keep it from the page. */
  consume: boolean;
  /** What to tell the shell, if anything. */
  input: TabSwitcherInput | null;
}

const IGNORE: SwitcherOutcome = { consume: false, input: null };

/** The macOS Edit menu's commands, by the WebContents method that does each. */
export type EditCommand = "undo" | "redo" | "cut" | "copy" | "paste" | "pasteAndMatchStyle" | "selectAll";

/**
 * A key the switcher passed on, as Electron's `sendInputEvent` takes it:
 * the keystroke the page was going to get while the shell had the keyboard.
 */
export interface PassedKeystroke {
  keyCode: string;
  modifiers: ("shift" | "control" | "alt" | "meta")[];
  /** It types a character, so a `char` event follows the keyDown. */
  char: boolean;
  /** The Edit menu command it stands for on macOS, whose menu a sent key never reaches. */
  edit: EditCommand | null;
}

/** DOM key names `sendInputEvent` knows by another name, or by the same one. */
const SENDABLE_KEYS: Readonly<Record<string, string>> = {
  " ": "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "Return",
  Tab: "Tab",
  Escape: "Escape",
};

/**
 * The keystroke to send on for a key the switcher passed on, or null for
 * one `sendInputEvent` has no name for (a dead key, a media key).
 */
export function passedKeystroke(input: SwitcherKey): PassedKeystroke | null {
  const shortcut = input.meta || input.control;
  // With Option down the character is the composed one (⌥B is "∫"); a
  // shortcut is named by the physical key instead.
  const physical = shortcut && input.alt ? /^(?:Key([A-Z])|Digit([0-9]))$/.exec(input.code ?? "") : null;
  const keyCode =
    physical !== null
      ? (physical[1]?.toLowerCase() ?? physical[2]!)
      : (SENDABLE_KEYS[input.key] ??
        (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(input.key) || [...input.key].length === 1 ? input.key : null));
  if (keyCode === null) return null;
  const modifiers: PassedKeystroke["modifiers"] = [];
  if (input.shift) modifiers.push("shift");
  if (input.control) modifiers.push("control");
  if (input.alt) modifiers.push("alt");
  if (input.meta) modifiers.push("meta");
  return { keyCode, modifiers, char: !shortcut && [...input.key].length === 1, edit: editCommand(input, keyCode) };
}

function editCommand(input: SwitcherKey, keyCode: string): EditCommand | null {
  if (!input.meta || input.control) return null;
  const key = keyCode.toLowerCase();
  if (input.alt) return input.shift && key === "v" ? "pasteAndMatchStyle" : null;
  if (input.shift) return key === "z" ? "redo" : null;
  switch (key) {
    case "z":
      return "undo";
    case "x":
      return "cut";
    case "c":
      return "copy";
    case "v":
      return "paste";
    case "a":
      return "selectAll";
    default:
      return null;
  }
}

/** ⌘-keys only the macOS application menu answers: quit, hide, hide others, minimize, the page's DevTools. */
const MENU_ONLY_KEYS = new Set(["q", "h", "alt+h", "m", "alt+i"]);

/**
 * macOS: the key belongs to the application menu, not the page — ⌘Q, ⌘H,
 * ⌘M, ⌥⌘I, and anything with ⌃⌘ (full screen, and the system's own). The
 * menu only sees a real keystroke, so such a key stays where it was typed.
 */
export function menuKeepsKey(input: SwitcherKey): boolean {
  if (!input.meta) return false;
  if (input.control) return true;
  if (input.shift) return false;
  const keystroke = passedKeystroke(input);
  if (keystroke === null) return false;
  return MENU_ONLY_KEYS.has(`${input.alt ? "alt+" : ""}${keystroke.keyCode.toLowerCase()}`);
}

const ARROWS: Readonly<Record<string, TabSwitcherDirection>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

const MODIFIER_KEYS = new Set(["Shift", "Control", "Meta", "Alt"]);

/** The key is one of those the switcher is held by: its keyUp is a release. */
function holdsSwitcher(modifier: TabSwitcherModifier, key: string): boolean {
  return key === "Control" ? modifier !== "alt+meta" : key === "Meta" ? modifier === "alt+meta" : key === "Alt" && modifier !== "control";
}

/** ⌥⌘ or ⌥⌃ down and nothing else (no ⇧, not all three): the pair that arms the switcher, or null. */
function heldPair(flags: SwitcherKey): TabSwitcherModifier | null {
  if (!flags.alt || flags.shift || flags.meta === flags.control) return null;
  return flags.meta ? "alt+meta" : "alt+control";
}

/** What a Tab opens the switcher with: ⌃ alone, or a pair (⇧ only steps backwards). Null for any other Tab. */
function tabOpener(input: SwitcherKey): TabSwitcherModifier | null {
  if (input.key !== "Tab") return null;
  if (input.control && !input.meta && !input.alt) return "control";
  return heldPair({ ...input, shift: false });
}

type Phase = { name: "idle" } | { name: "armed"; modifier: TabSwitcherModifier } | { name: "open"; modifier: TabSwitcherModifier };

/**
 * The held-modifier gesture. ⌥⌘ or ⌥⌃ pressed on their own ARM it (⌘ or ⌃
 * alone did, until it opened on every shortcut held a beat too long); held
 * for the chosen TAB_SWITCHER_HOLD_MS with nothing else pressed (the
 * caller's timer calls `holdElapsed`; "instant" is a timer of 0), the
 * switcher opens on the active tab. Tab with the pair held, or ⌃Tab, opens
 * it at once, one step along — ⌘Tab never reaches an app on macOS, which
 * keeps it for switching apps. While open, Tab and the arrows move the
 * selection, Return or letting go (either key of the pair) commits, Escape
 * cancels, and any other key cancels and goes on to wherever it was going
 * (⌥⌘T still tiles a desk).
 *
 * Releases are NOT reliable: once main consumes a keyDown, Chromium drops
 * that view's keyUps until the next keyDown. So a release is also read from
 * the modifier flag of whatever key comes next, and the caller moves the
 * keyboard to the shell as the switcher opens, where the release is seen.
 */
export class TabSwitcherGesture {
  #phase: Phase = { name: "idle" };
  readonly #canOpen: () => boolean;

  constructor(canOpen: () => boolean = () => true) {
    this.#canOpen = canOpen;
  }

  get armed(): boolean {
    return this.#phase.name === "armed";
  }

  get open(): boolean {
    return this.#phase.name === "open";
  }

  key(input: SwitcherKey): SwitcherOutcome {
    if (input.type !== "keyDown" && input.type !== "keyUp") return IGNORE;
    const phase = this.#phase;
    if (phase.name === "open") return this.#whileOpen(phase.modifier, input);
    if (phase.name === "armed") {
      if (input.type === "keyUp") {
        if (holdsSwitcher(phase.modifier, input.key) || !tabSwitcherHeld(phase.modifier, input)) this.#phase = { name: "idle" };
        return IGNORE;
      }
      if (input.isAutoRepeat === true && holdsSwitcher(phase.modifier, input.key)) return IGNORE;
      this.#phase = { name: "idle" };
    }
    if (input.type !== "keyDown") return IGNORE;
    const opener = tabOpener(input);
    if (opener !== null) {
      if (this.#canOpen()) this.#phase = { name: "open", modifier: opener };
      return {
        consume: true,
        input: this.open ? { type: "open", modifier: opener, step: input.shift ? -1 : 1 } : null,
      };
    }
    // The pair's second key going down, with nothing else held.
    const pair = MODIFIER_KEYS.has(input.key) ? heldPair(input) : null;
    if (pair !== null && holdsSwitcher(pair, input.key) && input.isAutoRepeat !== true) this.#phase = { name: "armed", modifier: pair };
    return IGNORE;
  }

  /** The hold timer ran out; opens on the active tab if the gesture is still armed. */
  holdElapsed(): TabSwitcherInput | null {
    const phase = this.#phase;
    if (phase.name !== "armed") return null;
    if (!this.#canOpen()) {
      this.#phase = { name: "idle" };
      return null;
    }
    this.#phase = { name: "open", modifier: phase.modifier };
    return { type: "open", modifier: phase.modifier, step: 0 };
  }

  /** The pointer did something (a click, a scroll): a held modifier is for that, not for switching. */
  disarm(): void {
    if (this.#phase.name === "armed") this.#phase = { name: "idle" };
  }

  /** The window lost focus or the shell closed the switcher. */
  reset(): void {
    this.#phase = { name: "idle" };
  }

  #whileOpen(modifier: TabSwitcherModifier, input: SwitcherKey): SwitcherOutcome {
    const held = tabSwitcherHeld(modifier, input);
    if (input.type === "keyUp") {
      if (!holdsSwitcher(modifier, input.key) && held) return IGNORE;
      this.#phase = { name: "idle" };
      return { consume: true, input: { type: "commit" } };
    }
    if (!held && !holdsSwitcher(modifier, input.key)) {
      // The release went unseen; this key was typed after it.
      this.#phase = { name: "idle" };
      return { consume: false, input: { type: "commit" } };
    }
    if (input.key === "Tab") return { consume: true, input: { type: "step", reverse: input.shift } };
    const direction = ARROWS[input.key];
    if (direction !== undefined) return { consume: true, input: { type: "move", direction } };
    if (input.key === "Enter") {
      this.#phase = { name: "idle" };
      return { consume: true, input: { type: "commit" } };
    }
    if (input.key === "Escape") {
      this.#phase = { name: "idle" };
      return { consume: true, input: { type: "cancel" } };
    }
    if (MODIFIER_KEYS.has(input.key)) return IGNORE;
    this.#phase = { name: "idle" };
    return { consume: false, input: { type: "cancel" } };
  }
}
