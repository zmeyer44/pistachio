/**
 * The API seam (docs/web-browser-design.md §3.2). The shell used to reach the
 * bridge through the global the desktop preload installs; it now asks for it
 * here, so the same tree runs over Electron IPC on the desktop and over the
 * shell socket in a browser tab.
 *
 * Two accessors, because there are two kinds of member (W6):
 *
 * - `shellApi()` is everything a host can answer. It throws when nothing has
 *   been set, because a shell with no bridge is a bug in the entry, not a
 *   state to render around.
 * - `nativeApi()` is the geometry: placing native views over holes in the DOM,
 *   polling the OS pointer, native dialogs. It answers null on a stream
 *   surface, and every caller must go on working — a pane must never be left
 *   veiled because there was nothing native to ask.
 */

import {
  NATIVE_SURFACE_MEMBERS,
  type NativeSurfaceApi,
  type ShellApi,
} from "@pistachio/shell-contracts/ipc";

/** What an entry hands in: the whole shell surface, and the native half if it has one. */
export type ShellApiBridge = ShellApi & Partial<NativeSurfaceApi>;

let bridge: ShellApiBridge | null = null;
let native: NativeSurfaceApi | null = null;

/**
 * Whether this bridge carries every native member. A partial one is not a
 * native surface: half the geometry is worse than none, because the callers
 * that check `nativeApi()` once would then break on the missing half.
 */
function nativeSurfaceOf(api: ShellApiBridge): NativeSurfaceApi | null {
  for (const member of Object.keys(NATIVE_SURFACE_MEMBERS) as (keyof NativeSurfaceApi)[]) {
    if (typeof api[member] !== "function") return null;
  }
  return api as NativeSurfaceApi;
}

/** Install the bridge. The entry calls this once, before the first render. */
export function setShellApi(api: ShellApiBridge): void {
  bridge = api;
  native = nativeSurfaceOf(api);
}

export function shellApi(): ShellApi {
  if (bridge === null) throw new Error("shell api not set");
  return bridge;
}

/** The native half, or null on a stream surface (and before any entry ran). */
export function nativeApi(): NativeSurfaceApi | null {
  return native;
}
