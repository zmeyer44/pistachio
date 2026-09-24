/**
 * The double tap of a modifier — shift, shift — that saves a bookmark.
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

export class DoubleTap {
  readonly #key: string;
  readonly #heldKeys = new Set<string>();
  #pressedAt: number | null = null;
  #tappedAt: number | null = null;

  constructor(key = "Shift") {
    this.#key = key;
  }

  /** Feed one key event; true only on the second clean tap's release. */
  press(input: TapInput, now = Date.now()): boolean {
    if (input.type !== "keyDown" && input.type !== "keyUp") return false;
    // `key` can change case while held; `code` identifies the physical key.
    const code = input.code || input.key.toLowerCase();
    const wasHeld = this.#heldKeys.has(code);
    if (input.type === "keyDown") this.#heldKeys.add(code);
    else this.#heldKeys.delete(code);

    const otherModifier = (input.meta ?? input.metaKey ?? false) || (input.control ?? input.ctrlKey ?? false) || (input.alt ?? input.altKey ?? false);
    if (input.key !== this.#key || otherModifier) {
      this.#resetTaps();
      return false;
    }
    if (input.type === "keyDown") {
      if (input.isAutoRepeat === true || wasHeld || this.#heldKeys.size !== 1) {
        this.#resetTaps();
        return false;
      }
      if (this.#tappedAt !== null && now - this.#tappedAt > DOUBLE_TAP_WINDOW_MS) this.#tappedAt = null;
      this.#pressedAt = now;
      return false;
    }

    if (
      !wasHeld ||
      this.#heldKeys.size !== 0 ||
      this.#pressedAt === null ||
      now - this.#pressedAt > MAX_TAP_HOLD_MS
    ) {
      this.#resetTaps();
      return false;
    }
    // Until release, this press could still become ⇧A, a shortcut, or a hold.
    if (this.#tappedAt !== null) {
      this.#resetTaps();
      return true;
    }
    this.#tappedAt = now;
    this.#pressedAt = null;
    return false;
  }

  reset(): void {
    this.#heldKeys.clear();
    this.#resetTaps();
  }

  #resetTaps(): void {
    this.#pressedAt = null;
    this.#tappedAt = null;
  }
}
