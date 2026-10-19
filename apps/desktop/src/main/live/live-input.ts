import { RateLimiter, liveInputEventSchema, toElectronInputEvents, type ElectronInputStep, type LiveInputEvent, type LiveModifier } from "@pistachio/live-share";
import { shortcutActionForEvent, shortcutFromEvent, type ShortcutPlatform, type ShortcutSettings } from "@pistachio/shell-contracts/shortcuts";

/**
 * A guest's hands on a window (docs/live-share.md §6.1, §10): each `lv.input`
 * the host app relays is checked here before it reaches a page — the sender
 * is a guest in the room, the host allowed the window, it streams, it is
 * neither minimized nor masked, the host is on the space, and the guest is
 * within 240 events a second — and only then turned into the page's own
 * events, in its view's DIPs (under desk zoom Chromium maps them to the page
 * itself). A press makes the window the one in use, as the host's press
 * would, and makes its guest the one using it (`lv.grant`).
 *
 * What a guest presses down here is owed its release. Their own release of a
 * press let through goes whatever changed since (it can only end that press),
 * and when their hands come off a window — the host takes it back, it is
 * minimized, masked or no longer streams, the host goes away, the guest
 * leaves or is removed, the share ends — main lets go of whatever they held
 * on it at once: a page left with a button or a key down would drag or
 * repeat for good, and the guest's own release would be refused. A release
 * of nothing held goes nowhere: a guest's page sends its releases again
 * after a drop (one sent as the connection went can be lost), and a page
 * acts on a stray one (a key-up of Enter that searches, a mouseup that
 * shows a selection's toolbar) though Chromium clicks nothing for it.
 *
 * What a guest's page does on its own is held back here too, whatever their
 * page sent: only the left button (a right press opens main's context menu on
 * the host's screen, a middle one opens links in tabs), and none of it
 * pressed or let go with ⌘, Ctrl or Shift held — Chromium makes a Ctrl press
 * the host's context menu, and a click with ⌘ or Shift on a link a tab or
 * window of the host's, asked of main only after sendInputEvent has returned,
 * so nothing there tells them from the host's own (probed, Electron 43). Such
 * a click is refused rather than sent plain, which would take the page to the
 * link instead; ⌥ goes (it opens nothing). No wheel with ⌘ or Ctrl (it zooms
 * the page, and Chromium keeps a site's zoom for the host), and no key that is
 * one of the app's own shortcuts or edit chords.
 */

/** Why an event did not reach its page. */
export type LiveInputRefusal =
  | "invalid"
  | "button"
  | "chord"
  | "zoom"
  | "shortcut"
  | "not-a-guest"
  | "not-allowed"
  | "not-streamed"
  | "minimized"
  | "masked"
  | "host-away"
  | "rate-limited"
  | "too-many-keys"
  | "not-held"
  | "no-page";

/** A guest's events per second, at most; the rest are dropped. */
export const LIVE_INPUT_RATE = 240;
/** Keys one guest holds down in one window that main answers for; a hand holds fewer, and a key-down past them is refused (its release could not be owed). */
const MAX_HELD_KEYS = 16;

/** Held as the button is pressed or let go, these make Chromium open something of the host's: a context menu, a tab, a window. */
const CLICK_CHORDS: readonly LiveModifier[] = ["meta", "control", "shift"];

/** The edit and app chords main keeps from a page's own keys: the clipboard's (never the host's), quit, hide, minimize. */
const KEPT_CHORDS = new Set(["Mod+C", "Mod+X", "Mod+V", "Mod+Shift+V", "Mod+Q", "Mod+H", "Mod+M"]);

/**
 * A key that is one of the app's (docs/live-share.md §10): a binding of the
 * person's shortcuts on this surface (⌘W, ⌘T, ⌘L, ⌘+…), as main's own key
 * handler would take it, or one of the edit and app chords. Main's handlers
 * already let a guest's keys pass (they are flagged while sent); refused here,
 * the page never hears one either.
 */
export function isAppShortcut(settings: ShortcutSettings, platform: ShortcutPlatform, key: { key: string; code: string; modifiers: readonly LiveModifier[] }): boolean {
  const input = { key: key.key, code: key.code, meta: key.modifiers.includes("meta"), control: key.modifiers.includes("control"), alt: key.modifiers.includes("alt"), shift: key.modifiers.includes("shift") };
  if (shortcutActionForEvent(settings, input, platform, "native") !== null) return true;
  const binding = shortcutFromEvent(input, platform);
  return binding !== null && KEPT_CHORDS.has(binding);
}

/** What the gate reads of the share as each event comes. */
export interface LiveInputContext {
  isGuest(identity: string): boolean;
  /** The host lets guests use this window. */
  allowed(windowId: string): boolean;
  /** The window as the desk last had it, or null when it is not on the shared desk. */
  window(windowId: string): { streamed: boolean; minimized: boolean; masked: boolean } | null;
  hostPresent(): boolean;
}

/** Where accepted events go: the window's tab. */
export interface LiveInputTarget {
  /** The tab view's size in DIPs, or null when it has no page. */
  viewSize(tabId: string): { width: number; height: number } | null;
  /** Hand the steps to the tab's page, past main's own hooks; false when it has none. */
  send(tabId: string, steps: readonly ElectronInputStep[]): boolean;
  /** Make the tab the one in use. */
  activate(tabId: string): void;
  /** The key is one of the app's (a binding of the person's, or an edit or app chord main keeps from pages). */
  isShortcut(key: { key: string; code: string; modifiers: readonly LiveModifier[] }): boolean;
}

/** What one guest holds down in one window, by presses the gate let through. */
interface Held {
  /** The left button: where the guest's pointer last was over the page (0..1), and the press's click count. */
  button: { x: number; y: number; clickCount: number } | null;
  /** Keys down, by the physical key (`code`, or the key's own name where the page sent none). */
  keys: Map<string, { key: string; code: string }>;
}

export class LiveInputGate {
  readonly #context: LiveInputContext;
  readonly #target: LiveInputTarget;
  readonly #used: (windowId: string, identity: string) => void;
  readonly #now: () => number;
  readonly #rate = new RateLimiter({ rate: LIVE_INPUT_RATE, burst: LIVE_INPUT_RATE });
  /** By guest, then window: the presses owed a release. */
  readonly #held = new Map<string, Map<string, Held>>();

  constructor(context: LiveInputContext, target: LiveInputTarget, used: (windowId: string, identity: string) => void, now: () => number = Date.now) {
    this.#context = context;
    this.#target = target;
    this.#used = used;
    this.#now = now;
  }

  /** Apply one guest event to its window; the refusal, or null when it went through. */
  apply(identity: string, windowId: string, raw: unknown): LiveInputRefusal | null {
    const parsed = liveInputEventSchema.safeParse(raw);
    if (!parsed.success) return "invalid";
    const event = parsed.data;
    const refusal = this.#heldBack(event) ?? this.#withdrawn(identity, windowId) ?? this.#pastHeldKeys(identity, windowId, event) ?? this.#notHeld(identity, windowId, event) ?? (this.#rate.take(identity, this.#now()) ? null : "rate-limited");
    if (refusal !== null) {
      const owed = this.#takeOwed(identity, windowId, event);
      return owed === null ? refusal : this.#sendRelease(windowId, owed);
    }
    const size = this.#target.viewSize(windowId);
    if (size === null) return "no-page";
    if (event.type === "mouseDown") {
      this.#target.activate(windowId);
      this.#used(windowId, identity);
    }
    const steps = toElectronInputEvents(event, size);
    if (!this.#target.send(windowId, steps)) return "no-page";
    if (steps.length > 0) this.#track(identity, windowId, event);
    return null;
  }

  /**
   * The share changed under the guests' hands (a window taken back,
   * minimized, masked or gone, the host away, the share over): whatever a
   * guest holds down on a window they may no longer use is let go now.
   */
  releaseWithdrawn(): void {
    for (const [identity, windows] of this.#held) {
      for (const windowId of [...windows.keys()]) if (this.#withdrawn(identity, windowId) !== null) this.#releaseAll(identity, windowId);
    }
  }

  /** A guest left, or was removed: what they held down is let go, and their allowance goes with them. */
  forget(identity: string): void {
    for (const windowId of [...(this.#held.get(identity)?.keys() ?? [])]) this.#releaseAll(identity, windowId);
    this.#rate.forget(identity);
  }

  /** Why a guest's hands are off a window now, whatever the event: null while they may use it. */
  #withdrawn(identity: string, windowId: string): LiveInputRefusal | null {
    const context = this.#context;
    if (!context.isGuest(identity)) return "not-a-guest";
    if (!context.allowed(windowId)) return "not-allowed";
    const window = context.window(windowId);
    if (window === null || !window.streamed) return "not-streamed";
    if (window.minimized) return "minimized";
    if (window.masked) return "masked";
    if (!context.hostPresent()) return "host-away";
    return null;
  }

  /** A key-down that would be one more than main answers for: refused before the page has it down, since its release could not be owed. */
  #pastHeldKeys(identity: string, windowId: string, event: LiveInputEvent): LiveInputRefusal | null {
    if (event.type !== "keyDown") return null;
    const keys = this.#held.get(identity)?.get(windowId)?.keys;
    return keys !== undefined && keys.size >= MAX_HELD_KEYS && !keys.has(keyOf(event)) ? "too-many-keys" : null;
  }

  /** A release of a press the page does not have down from this guest: one refused, dropped, let go already, or sent again. */
  #notHeld(identity: string, windowId: string, event: LiveInputEvent): LiveInputRefusal | null {
    if (event.type !== "mouseUp" && event.type !== "keyUp") return null;
    const held = this.#held.get(identity)?.get(windowId);
    const holds = held !== undefined && (event.type === "mouseUp" ? held.button !== null : held.keys.has(keyOf(event)));
    return holds ? null : "not-held";
  }

  /** The presses an accepted event starts, moves or ends. */
  #track(identity: string, windowId: string, event: LiveInputEvent): void {
    if (event.type === "mouseDown") {
      this.#heldIn(identity, windowId).button = { x: event.x, y: event.y, clickCount: event.clickCount };
      return;
    }
    if (event.type === "keyDown") {
      this.#heldIn(identity, windowId).keys.set(keyOf(event), { key: event.key, code: event.code });
      return;
    }
    const held = this.#held.get(identity)?.get(windowId);
    if (held === undefined) return;
    if (event.type === "mouseMove" && held.button !== null) {
      held.button.x = event.x;
      held.button.y = event.y;
    } else if (event.type === "mouseUp") held.button = null;
    else if (event.type === "keyUp") held.keys.delete(keyOf(event));
    this.#prune(identity, windowId);
  }

  /**
   * The guest's own release of a press the gate let through, as it goes past
   * whatever would refuse it now (it can only end that press): the button at
   * their pointer and the key, both plain — with ⌘ pressed since, the key's
   * would read as one of the app's chords, and the button's would open its
   * click's link in a tab of the host's. Null for any other event.
   */
  #takeOwed(identity: string, windowId: string, event: LiveInputEvent): LiveInputEvent | null {
    const held = this.#held.get(identity)?.get(windowId);
    if (held === undefined) return null;
    let release: LiveInputEvent | null = null;
    if (event.type === "mouseUp" && event.button === "left" && held.button !== null) {
      release = buttonUp(event.x, event.y, held.button.clickCount);
      held.button = null;
    } else if (event.type === "keyUp") {
      const key = held.keys.get(keyOf(event));
      if (key !== undefined) release = keyUp(key);
      held.keys.delete(keyOf(event));
    }
    this.#prune(identity, windowId);
    return release;
  }

  #sendRelease(windowId: string, release: LiveInputEvent): LiveInputRefusal | null {
    const size = this.#target.viewSize(windowId);
    return size !== null && this.#target.send(windowId, toElectronInputEvents(release, size)) ? null : "no-page";
  }

  /** Let go of everything one guest holds down in one window: the button where their pointer last was, then each key. */
  #releaseAll(identity: string, windowId: string): void {
    const windows = this.#held.get(identity);
    const held = windows?.get(windowId);
    if (windows === undefined || held === undefined) return;
    windows.delete(windowId);
    if (windows.size === 0) this.#held.delete(identity);
    const size = this.#target.viewSize(windowId);
    if (size === null) return;
    const releases = [...(held.button === null ? [] : [buttonUp(held.button.x, held.button.y, held.button.clickCount)]), ...[...held.keys.values()].map(keyUp)];
    const steps = releases.flatMap((release) => toElectronInputEvents(release, size));
    if (steps.length > 0) this.#target.send(windowId, steps);
  }

  #heldIn(identity: string, windowId: string): Held {
    let windows = this.#held.get(identity);
    if (windows === undefined) this.#held.set(identity, (windows = new Map()));
    let held = windows.get(windowId);
    if (held === undefined) windows.set(windowId, (held = { button: null, keys: new Map() }));
    return held;
  }

  /** Nothing held any more is nothing kept. */
  #prune(identity: string, windowId: string): void {
    const windows = this.#held.get(identity);
    const held = windows?.get(windowId);
    if (windows === undefined || held === undefined || held.button !== null || held.keys.size > 0) return;
    windows.delete(windowId);
    if (windows.size === 0) this.#held.delete(identity);
  }

  /** What no guest's event may do, whichever window it is for. */
  #heldBack(event: LiveInputEvent): LiveInputRefusal | null {
    switch (event.type) {
      case "mouseDown":
      case "mouseUp":
      case "mouseMove":
        // (A move names the button held, if any; a press or release, its own — always the left.)
        if ((event.type !== "mouseMove" && event.button !== "left") || (event.button !== undefined && event.button !== "left") || (event.buttons & ~1) !== 0) return "button";
        // (A move with them held opens nothing.)
        return event.type !== "mouseMove" && event.modifiers.some((modifier) => CLICK_CHORDS.includes(modifier)) ? "chord" : null;
      case "wheel":
        return event.modifiers.includes("control") || event.modifiers.includes("meta") ? "zoom" : null;
      case "keyDown":
      case "keyUp":
        return this.#target.isShortcut(event) ? "shortcut" : null;
      default:
        return null;
    }
  }
}

/** A key's identity across its press and release: the physical key, or its name where the page sent no code. */
function keyOf(event: { key: string; code: string }): string {
  return event.code === "" ? `key:${event.key}` : event.code;
}

function buttonUp(x: number, y: number, clickCount: number): LiveInputEvent {
  return { type: "mouseUp", x, y, button: "left", buttons: 0, clickCount, modifiers: [] };
}

function keyUp(key: { key: string; code: string }): LiveInputEvent {
  return { type: "keyUp", key: key.key, code: key.code, modifiers: [] };
}
