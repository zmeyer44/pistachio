/**
 * The double tap of a modifier — shift, shift — that saves the page.
 *
 * A tap is a press and release of the key on its own, quick, with nothing
 * else held. Two completed taps within the window fire. Any other key
 * between them (⇧A is typing, not a tap), a held key (auto-repeat, or a release that
 * comes late), or another modifier down at the time resets the count, so
 * capital letters and ⌘⇧ shortcuts never trigger it.
 *
 * One detector reads the shell window, utility views, and tab views so a
 * keystroke in any view cancels the gesture. Reset it when the window loses
 * focus, since keys pressed outside the app cannot be observed.
 *
 * Releases go missing. When main consumes a key-down (a shortcut pressed
 * on a page: ⌘=, ⌘L, ⌘R), Chromium swallows that key's key-up and every
 * key-up after it until the next key-down, so `before-input-event` never
 * reports them. A detector that waited for each release to clear a "held"
 * key would believe ⌘ and = are still down and refuse every later tap —
 * shift, shift would stop working until the window lost focus. So nothing
 * here depends on seeing a release: other modifiers are read from each
 * event's own flags, and a key counts as held only while it is being
 * pressed or repeating now, not forever after a release that never came.
 */

export interface TapInput {
  type: string;
  key: string;
  /** Physical key identity, so left and right Shift can be tracked separately. */
  code?: string;
  isAutoRepeat?: boolean;
  /** Electron's Input names the modifiers without the `Key` suffix; DOM events with it. */
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/** The second tap's press must land within this of the first tap's release. */
export const DOUBLE_TAP_WINDOW_MS = 400;
/** A press held longer than this is a hold, not a tap. */
export const MAX_TAP_HOLD_MS = 400;
/**
 * How long another key counts as held after its last key-down with no
 * release seen. A key really held down repeats well inside this, which
 * refreshes it; one whose release was swallowed simply ages out.
 */
export const HELD_KEY_MS = 1_000;

/** Keys whose state the event flags already carry, or that toggle rather than hold. */
const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "AltGraph", "OS", "Hyper", "Super", "CapsLock", "Fn", "FnLock", "NumLock", "ScrollLock"]);

export class DoubleTap {
  readonly #key: string;
  /** Other keys pressed and not (yet) seen released, with their last key-down. */
  readonly #others = new Map<string, number>();
  /** The press of the key in progress, if it could still become a tap. */
  #press: { code: string; at: number } | null = null;
  #tappedAt: number | null = null;

  constructor(key = "Shift") {
    this.#key = key;
  }

  /** Feed one key event; true only on the second clean tap's release. */
  press(input: TapInput, now = Date.now()): boolean {
    if (input.type !== "keyDown" && input.type !== "keyUp") return false;
    // `key` can change case while held; `code` identifies the physical key.
    const code = input.code || input.key.toLowerCase();
    if (input.key !== this.#key) {
      // Any other key, pressed or released, is not part of the gesture.
      if (input.type === "keyDown" && !MODIFIER_KEYS.has(input.key)) this.#others.set(code, now);
      else this.#others.delete(code);
      this.#resetTaps();
      return false;
    }
    const otherModifier = (input.meta ?? input.metaKey ?? false) || (input.control ?? input.ctrlKey ?? false) || (input.alt ?? input.altKey ?? false);
    if (otherModifier) {
      this.#resetTaps();
      return false;
    }
    if (input.type === "keyDown") {
      for (const [other, at] of this.#others) if (now - at > HELD_KEY_MS) this.#others.delete(other);
      const pressed = this.#press;
      const overlapping = pressed !== null && now - pressed.at <= MAX_TAP_HOLD_MS;
      // A repeat, a second key-down for a press in progress, the other
      // Shift while this one is down, or a key held under it: not a tap.
      if (input.isAutoRepeat === true || overlapping || this.#others.size > 0) {
        this.#resetTaps();
        return false;
      }
      if (this.#tappedAt !== null && now - this.#tappedAt > DOUBLE_TAP_WINDOW_MS) this.#tappedAt = null;
      this.#press = { code, at: now };
      return false;
    }

    const pressed = this.#press;
    this.#press = null;
    if (pressed === null || pressed.code !== code || now - pressed.at > MAX_TAP_HOLD_MS) {
      this.#resetTaps();
      return false;
    }
    // Until release, this press could still become ⇧A, a shortcut, or a hold.
    if (this.#tappedAt !== null) {
      this.#resetTaps();
      return true;
    }
    this.#tappedAt = now;
    return false;
  }

  reset(): void {
    this.#others.clear();
    this.#resetTaps();
  }

  #resetTaps(): void {
    this.#press = null;
    this.#tappedAt = null;
  }
}
