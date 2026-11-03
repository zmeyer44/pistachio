/** The editor's keys (docs/recorder.md §2 "Edit"): a key press → a command. No DOM. */

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export type Command =
  | { type: "togglePlay" }
  /** ←/→: a frame. */
  | { type: "stepFrames"; frames: number }
  /** ⇧←/⇧→: a second. */
  | { type: "stepSeconds"; seconds: number }
  /** J/K/L: back, stop, forward (again: faster). */
  | { type: "shuttle"; direction: -1 | 0 | 1 }
  | { type: "split" }
  | { type: "delete" }
  | { type: "addZoom" }
  | { type: "addSpeed" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "deselect" }
  | { type: "home" }
  | { type: "end" };

const SLIDER_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/**
 * A key a focused control uses itself: everything in a text field or a menu, a
 * slider's arrows, a switch's Space. The rest (Space on a slider, S, Z…) is the editor's.
 */
export function keyBelongsToField(tagName: string | undefined, inputType?: string, key?: string): boolean {
  if (tagName === undefined) return false;
  const tag = tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag !== "input") return false;
  if (inputType === "range") return key === undefined || SLIDER_KEYS.has(key);
  if (inputType === "checkbox" || inputType === "radio") return key === " ";
  return inputType !== "button" && inputType !== "color";
}

export function commandFor(event: KeyLike): Command | null {
  const command = event.metaKey || event.ctrlKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (command) {
    if (event.altKey) return null;
    if (key === "z") return event.shiftKey ? { type: "redo" } : { type: "undo" };
    if (key === "y" && !event.shiftKey) return { type: "redo" };
    return null;
  }
  if (event.altKey) return null;
  switch (key) {
    case " ":
      return { type: "togglePlay" };
    case "ArrowLeft":
      return event.shiftKey ? { type: "stepSeconds", seconds: -1 } : { type: "stepFrames", frames: -1 };
    case "ArrowRight":
      return event.shiftKey ? { type: "stepSeconds", seconds: 1 } : { type: "stepFrames", frames: 1 };
    case "j":
      return { type: "shuttle", direction: -1 };
    case "k":
      return { type: "shuttle", direction: 0 };
    case "l":
      return { type: "shuttle", direction: 1 };
    case "s":
      return { type: "split" };
    case "Backspace":
    case "Delete":
      return { type: "delete" };
    case "z":
      return { type: "addZoom" };
    case "x":
      return { type: "addSpeed" };
    case "Escape":
      return { type: "deselect" };
    case "Home":
      return { type: "home" };
    case "End":
      return { type: "end" };
    default:
      return null;
  }
}

/** J/L pressed again run faster: 1×, 2×, 4×, 8×. */
export function nextShuttleRate(current: number, sameDirection: boolean): number {
  if (!sameDirection) return 1;
  return Math.min(8, current * 2);
}
