/**
 * Whether the host is at the shared desk as far as their window goes
 * (docs/live-share.md §6.1, §10): the browser's window up — not destroyed,
 * visible, not minimized, the app not hidden — and the Mac neither locked nor
 * asleep. While it is not, guests' hands are off every window and the host's
 * pointer is not read.
 *
 * Electron says when most of that changes, not all of it: ⌘H hides the app
 * with no `hide` on the window (Electron 43; `isVisible()` turns false), and
 * the app's resigning active is the one word of it — with the windows perhaps
 * still ordered in at that moment. So every one of these is a moment to look
 * again, and the app's comings and goings once more a moment later.
 */

/** The window as presence reads it. */
export interface PresenceWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  on(event: "show" | "hide" | "minimize" | "restore", listener: () => void): unknown;
  off(event: "show" | "hide" | "minimize" | "restore", listener: () => void): unknown;
}

/** Something that says when things happen: Electron's `app`, `powerMonitor`. */
export interface PresenceEvents<E extends string> {
  on(event: E, listener: () => void): unknown;
  off(event: E, listener: () => void): unknown;
}

type PowerEvent = "lock-screen" | "unlock-screen" | "suspend" | "resume";
type AppEvent = "did-become-active" | "did-resign-active";

/** How long after the app comes or goes the window is looked at again: the order AppKit settles them in is its own. */
export const PRESENCE_SETTLE_MS = 300;

export interface LivePresence {
  /** The window is up and the Mac is awake and unlocked. */
  shown(): boolean;
  dispose(): void;
}

export function watchLivePresence(
  sources: { window: PresenceWindow; power: PresenceEvents<PowerEvent>; app: PresenceEvents<AppEvent> },
  changed: () => void,
): LivePresence {
  const { window, power, app } = sources;
  // (Apart: a Mac woken from sleep may still be locked.)
  let locked = false;
  let asleep = false;
  let later: ReturnType<typeof setTimeout> | null = null;
  const look = (): void => changed();
  const settle = (): void => {
    changed();
    if (later !== null) clearTimeout(later);
    later = setTimeout(() => {
      later = null;
      changed();
    }, PRESENCE_SETTLE_MS);
  };
  const onPower: Record<PowerEvent, () => void> = {
    "lock-screen": () => {
      locked = true;
      changed();
    },
    "unlock-screen": () => {
      locked = false;
      changed();
    },
    suspend: () => {
      asleep = true;
      changed();
    },
    resume: () => {
      asleep = false;
      changed();
    },
  };
  const powerEvents = Object.keys(onPower) as PowerEvent[];
  const windowEvents = ["show", "hide", "minimize", "restore"] as const;
  for (const event of windowEvents) window.on(event, look);
  for (const event of powerEvents) power.on(event, onPower[event]);
  app.on("did-become-active", settle);
  app.on("did-resign-active", settle);
  return {
    shown: () => !locked && !asleep && !window.isDestroyed() && window.isVisible() && !window.isMinimized(),
    dispose() {
      for (const event of windowEvents) window.off(event, look);
      for (const event of powerEvents) power.off(event, onPower[event]);
      app.off("did-become-active", settle);
      app.off("did-resign-active", settle);
      if (later !== null) clearTimeout(later);
      later = null;
    },
  };
}
