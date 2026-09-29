import type { WebContents } from "electron";

/**
 * A tab's debugger session, shared by what drives it. Forced focus
 * (./forced-focus.ts) and the desk's masks (browser-controller) each hold a
 * tab's session while they need it: it is attached for the first holder and
 * detached when the last lets go, so one turning off never ends the other's
 * emulation.
 */
const PROTOCOL_VERSION = "1.3";
const holders = new WeakMap<WebContents, Set<string>>();

export function holdDebugger(webContents: WebContents, holder: string): void {
  let held = holders.get(webContents);
  if (held === undefined) {
    held = new Set();
    holders.set(webContents, held);
  }
  held.add(holder);
  if (!webContents.debugger.isAttached()) webContents.debugger.attach(PROTOCOL_VERSION);
}

export function releaseDebugger(webContents: WebContents, holder: string): void {
  const held = holders.get(webContents);
  held?.delete(holder);
  if ((held?.size ?? 0) > 0 || webContents.isDestroyed() || !webContents.debugger.isAttached()) return;
  webContents.debugger.detach();
}
