import type { WebContents } from "electron";

/**
 * Forced focus: a tab the page believes is the visible, focused one while it
 * sits in the background — for sites that pause, blank out or log you off
 * the moment their tab is not in front.
 *
 * It is Chromium's own "Emulate a focused page" (DevTools → Rendering),
 * driven over the tab's debugger: `Emulation.setFocusEmulationEnabled`
 * makes `document.hasFocus()` true and holds back the `blur` a switched-away
 * tab would get, and — because Chromium keeps an emulating page as if it
 * were being captured — the page stays rendered: `document.visibilityState`
 * is "visible", `document.hidden` false, and requestAnimationFrame and timers
 * run at full rate, even behind another tab or with the window minimized.
 * Nothing is injected into the page, so there is no patched getter for a
 * site to find; turning it off releases the capture and the page hears the
 * real `visibilitychange` and `blur` at once.
 *
 * The setting lives on the WebContents' debugger session, which survives
 * reloads and cross-site navigations. A session something else ends (a
 * crashed renderer) is re-established by calling this again.
 */
const PROTOCOL_VERSION = "1.3";

export async function setFocusEmulation(webContents: WebContents, enabled: boolean): Promise<void> {
  if (webContents.isDestroyed()) return;
  const { debugger: session } = webContents;
  if (!enabled) {
    if (!session.isAttached()) return;
    await session.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => undefined);
    if (!webContents.isDestroyed() && session.isAttached()) session.detach();
    return;
  }
  if (!session.isAttached()) session.attach(PROTOCOL_VERSION);
  await session.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
}

/** Whether the tab's debugger session is still there to hold the emulation. */
export function focusEmulationAttached(webContents: WebContents): boolean {
  return !webContents.isDestroyed() && webContents.debugger.isAttached();
}
