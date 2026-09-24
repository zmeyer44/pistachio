/**
 * Which renderer a tab's pane uses (docs/web-browser-design.md §16).
 *
 * A pane can be painted two ways: the screencast (`pixels`), which is what
 * every pane has always been, or the live DOM mirror (`dom`), which gives
 * crisp text, local zoom, selection and instant scrolling. The mirror is new
 * and behind a flag, so the default is off unless the deployment turns it on;
 * a person can flip it per tab, and that choice is remembered.
 *
 * The value is read in the pane wrapper, which starts a tab there and falls
 * back to pixels on its own when a page turns out not to be mirrorable.
 */

import type { PaneRenderer } from "@pistachio/dom-mirror";

/** The build-time default: `dom` only where the deployment opts in. */
function envDefault(): PaneRenderer {
  const flag = (typeof process === "undefined" ? undefined : process.env["NEXT_PUBLIC_PISTACHIO_DOM_MIRROR"]?.trim().toLowerCase());
  return flag === "1" || flag === "on" || flag === "true" ? "dom" : "pixels";
}

const KEY = "pistachio.browse.renderer";

/** The saved global preference, if the person set one; otherwise the build default. */
export function preferredRenderer(): PaneRenderer {
  try {
    const saved = window.localStorage.getItem(KEY);
    if (saved === "dom" || saved === "pixels") return saved;
  } catch {
    // Site data blocked: the deployment default stands, which is fine.
  }
  return envDefault();
}

/** Remember a new global preference; a no-op when storage is blocked. */
export function setPreferredRenderer(renderer: PaneRenderer): void {
  try {
    window.localStorage.setItem(KEY, renderer);
  } catch {
    // As above: remembering is a convenience, never a precondition.
  }
}

/** Whether the DOM mirror is available to offer at all in this build. */
export function domMirrorEnabled(): boolean {
  if (envDefault() === "dom") return true;
  const opt = (typeof process === "undefined" ? undefined : process.env["NEXT_PUBLIC_PISTACHIO_DOM_MIRROR"]?.trim().toLowerCase());
  return opt === "opt-in" || opt === "auto";
}
