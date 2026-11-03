/**
 * `pistachio.capture` as main keeps it (docs/extensions.md §4 "The web
 * worker", §5 `capture`; docs/recorder.md R1): one arm at a time per
 * extension, the captures live, and the holds — and the pill that says so.
 *
 * - **Arm.** `capture.arm` (what `capture.tab` calls first, from the worker,
 *   on a tab the person granted) arms the extension's session for ONE display
 *   capture within ARM_MS, from the worker's own frame: the session's
 *   permission handler lets that one request through (`mayCapture`), every
 *   other is refused there (the page hears NotAllowedError); its display-media
 *   handler answers it with the tab's main frame, and its sound when asked
 *   (`answer`). MEASURED (Electron 43.4.1, 2026-10-30, the s3 probe): the
 *   worker's own partition capturing a tab of a Profile's partition works
 *   with no question asked of the tab's session, no user gesture and no
 *   macOS permission — 100–116 ms to the first frame, 56–57 fps — and the
 *   capture follows the tab across navigations and ends when its page closes.
 * - **Live.** From the answer until the stream ends. Main cannot see a
 *   MediaStream end, so every second it asks the worker's page which
 *   display tracks it holds live, by source (`__pistachioLiveCaptures`, the
 *   guard the extension preload sets in the page's world before its first
 *   script: each track's `deviceId`, which Chromium spells from the source's
 *   main frame — nothing a script of the page can fake) and reads the page's own
 *   `isBeingCaptured()` (Chromium's count of every capturer there is — a
 *   live share's, Playwright's under e2e — so it says a capture is over,
 *   never that this one runs), and ends the capture when the worker holds
 *   none, its tab closed or woke as another page, went to an address capture
 *   may not see, or left the Profiles the extension is on in — and tells the
 *   worker (`capture.ended`, whose runtime stops the tracks itself).
 * - **Ending.** A capture told to end (the person's Stop, an address it may
 *   not see, its last hold released) stays listed — the pill up, the tab
 *   held — until the worker holds no live track of that source. One still
 *   held CAPTURE_END_GRACE_MS later has that source's tracks ended by main
 *   itself (`enforce` "end": the guard's `__pistachioEndCaptures(key)`,
 *   another capture of the worker's untouched); one still held,
 *   or whose worker does not answer, CAPTURE_KILL_GRACE_MS after that has
 *   its worker's renderer killed (`enforce` "kill"). The runtime told is the
 *   extension's own code, and a stream taken with the raw wire is in no map
 *   of its: the person's Stop rests on main. MEASURED (Electron 43.4.1,
 *   2026-11-02): a capture whose page is closed or whose renderer is killed
 *   stays counted on the captured tab for that tab's life — which is why the
 *   count is never what says a capture runs.
 * - **Holds.** `capture.hold` keeps a tab awake, out of Tidy's reach, at the
 *   desk's 100% and laid out while hidden (BrowserController
 *   holdExtensionTabs); a live capture, and an arm, hold their tab as well.
 *   Releasing an extension's last hold on a tab ends its capture of it. A
 *   hold is the view's that took it, and goes with it (`releaseOwned`); it
 *   lapses with the tab, or with the extension's access to the tab.
 *
 * The status pill: while an extension captures (or watches input) main draws
 * one for it (`● Recording · <name>` with Stop), or marks its own
 * (`statusPillFor`): an extension cannot record quietly.
 */

import { originOf } from "./hosts";
import type { ExtStatus } from "@pistachio/extension-api";
import type { ExtensionStatusPill } from "@pistachio/shell-contracts/extensions";

/** How long an arm waits for its getDisplayMedia. */
export const ARM_MS = 10_000;
/** How often the live captures are looked at. */
export const CAPTURE_CHECK_MS = 1_000;
/** A capture answered but not yet captured (the stream starting) is not taken as stopped before this. */
export const CAPTURE_START_GRACE_MS = 3_000;
/** A capture told to end (`capture.ended` sent) whose worker still holds a live track this long after is ended by main itself (`enforce` "end"). */
export const CAPTURE_END_GRACE_MS = 3_000;
/** One whose worker still holds one this long after that — or cannot be asked — has its worker killed (`enforce` "kill"). */
export const CAPTURE_KILL_GRACE_MS = 3_000;
/** How often an ending capture is looked at: the pill goes as soon as the tracks are. */
export const CAPTURE_ENDING_CHECK_MS = 250;
/** The id of the Stop action main's pill carries, and that ends the captures when chosen. */
export const STOP_ACTION = "stop";

export type CaptureEndReason = "closed" | "navigated" | "stopped" | "released" | "stop" | "off" | "worker";

/** The reasons the stream is known gone with: the page closed, no longer captured, the worker or the extension stopped. */
const DEAD_REASONS = new Set<CaptureEndReason>(["closed", "stopped", "off", "worker"]);

/** The part of a tab's page capture reads (Electron's webContents, or a test's stand-in). */
export interface CapturePage {
  readonly id: number;
  readonly mainFrame: unknown;
  isDestroyed(): boolean;
  isBeingCaptured(): boolean;
}

export interface CaptureHost {
  /** The tab's live page, or null while it has none. */
  page(tabId: string): CapturePage | null;
  /**
   * The sources of the display tracks the extension's worker holds live, one entry a track (the preload's guard,
   * `__pistachioLiveCaptures`: each track's `deviceId`, `web-contents-media-stream://<process>:<frame>`); empty with
   * no worker page; null when it cannot be asked — a renderer that does not answer — which is taken as holding.
   */
  liveTracks(extensionId: string): Promise<string[] | null>;
  /** How a capture of the page names its source (the main frame's process and routing ids, as `liveTracks` spells them); null with no frame. */
  sourceKey(page: CapturePage): string | null;
  /** Whether the tab is still there (asleep or not). */
  exists(tabId: string): boolean;
  /** Whether the extension may still capture the tab: visible to it, in a Profile it is on in, at a web address. */
  capturable(extensionId: string, tabId: string): boolean;
  /** These tabs held now, the rest let go (BrowserController holdExtensionTabs). */
  hold(tabIds: readonly string[]): void;
  now?(): number;
}

export interface CaptureEvents {
  /** A live capture ended: the worker hears `capture.ended`. */
  ended(extensionId: string, tabId: string, reason: CaptureEndReason): void;
  /** What is captured or held changed: the snapshot (the pill, `captures`) is published again. */
  changed(): void;
  /**
   * A capture told to end whose tracks the worker still holds CAPTURE_END_GRACE_MS later: `"end"`, main stops that
   * source's tracks itself (the preload's guard, `__pistachioEndCaptures(key)`); still held CAPTURE_KILL_GRACE_MS
   * after that: `"kill"`, the worker's renderer is killed. What the person's Stop promises does not rest on the
   * extension's code. `key` is the capture's source as the guard names it (null: every track, the source unknown).
   */
  enforce(extensionId: string, tabId: string, how: "end" | "kill", key: string | null): void;
}

interface Arm {
  extensionId: string;
  tabId: string;
  audio: boolean;
  /** The worker's contents and main frame: the one request answered is from that frame. */
  contentsId: number;
  frame: unknown;
  until: number;
}

interface Live {
  extensionId: string;
  tabId: string;
  /** The page captured: a tab that woke as another page has lost its stream. */
  pageId: number;
  /** The source as the worker's tracks name it (`sourceKey` at the answer: a later navigation of the page keeps the track's name). */
  key: string | null;
  since: number;
  seen: boolean;
  /** Told to end (`capture.ended` sent) at `since`; `ended` once main ended its tracks itself (`since` then that moment). Listed until the worker holds no live track or the graces run out. */
  ending: { since: number; ended: boolean } | null;
}

/** What getDisplayMedia is answered with: the tab's frame for the picture and (asked for) its sound, heard as it plays. */
export interface CaptureAnswer {
  video: unknown;
  audio?: unknown;
  enableLocalEcho: true;
}

export class CaptureBook {
  readonly #host: CaptureHost;
  readonly #events: CaptureEvents;
  readonly #now: () => number;
  readonly #arms = new Map<string, Arm>();
  #live: Live[] = [];
  /** Holds by id: whose, on what, and the view that took it (null: the service's own) — released with the view. */
  readonly #holds = new Map<number, { extensionId: string; tabId: string; owner: number | null }>();
  #nextHold = 1;
  #checking = false;
  #heldKey = "";
  #timer: ReturnType<typeof setInterval> | null = null;
  #timerMs = 0;

  constructor(host: CaptureHost, events: CaptureEvents) {
    this.#host = host;
    this.#events = events;
    this.#now = host.now ?? Date.now;
  }

  /**
   * Arm `extensionId`'s session for one capture of `tabId`, asked from the frame given. False while an arm of its is
   * pending: one at a time, or a second would take the first's request and hand it the wrong tab's stream.
   */
  arm(arm: { extensionId: string; tabId: string; audio: boolean; contentsId: number; frame: unknown }): boolean {
    if (this.#armOf(arm.extensionId) !== null) return false;
    // (Nor while a capture of the tab is ending: a new one would take the ending one's place, and its deadline with it.)
    if (this.ending(arm.extensionId, arm.tabId)) return false;
    this.#arms.set(arm.extensionId, { ...arm, until: this.#now() + ARM_MS });
    this.#sync();
    return true;
  }

  /**
   * Whether a capture of the tab by the extension was told to end and has not yet (the person's Stop, in its grace):
   * no new capture of that tab until it has — one would replace the ending one, and the deadline that ends its
   * tracks or kills the worker would go with it.
   */
  ending(extensionId: string, tabId: string): boolean {
    return this.#live.some((live) => live.extensionId === extensionId && live.tabId === tabId && live.ending !== null);
  }

  /** An arm that came to nothing (its tab would not wake): let go. */
  disarm(extensionId: string): void {
    if (this.#arms.delete(extensionId)) this.#sync();
  }

  #armOf(extensionId: string): Arm | null {
    const arm = this.#arms.get(extensionId);
    if (arm === undefined) return null;
    if (this.#now() > arm.until) {
      this.#arms.delete(extensionId);
      this.#sync();
      return null;
    }
    return arm;
  }

  /** The session's permission handler: may this contents start a display capture now (an arm waits for it)? */
  mayCapture(extensionId: string, contentsId: number): boolean {
    const arm = this.#armOf(extensionId);
    return arm !== null && arm.contentsId === contentsId;
  }

  /**
   * The session's display-media handler: the streams for this request, or null
   * to refuse it — not armed, not the armed frame, the tab gone or no longer
   * the extension's to capture. The arm is spent either way.
   */
  answer(extensionId: string, request: { frame: unknown; audioRequested: boolean }): CaptureAnswer | null {
    const arm = this.#armOf(extensionId);
    if (arm === null || request.frame === null || request.frame !== arm.frame) return null;
    this.#arms.delete(extensionId);
    const page = this.#host.page(arm.tabId);
    if (page === null || page.isDestroyed() || !this.#host.capturable(extensionId, arm.tabId)) {
      this.#sync();
      return null;
    }
    // One capture of a tab per extension: another of the same tab is the same recording asked again — unless that one
    // is ending, which keeps its deadline (the arm refused this already; the answer refuses it too).
    if (this.ending(extensionId, arm.tabId)) {
      this.#sync();
      return null;
    }
    this.#live = this.#live.filter((live) => !(live.extensionId === extensionId && live.tabId === arm.tabId));
    this.#live.push({ extensionId, tabId: arm.tabId, pageId: page.id, key: this.#host.sourceKey(page), since: this.#now(), seen: false, ending: null });
    this.#sync();
    this.#events.changed();
    const frame = page.mainFrame;
    return arm.audio && request.audioRequested ? { video: frame, audio: frame, enableLocalEcho: true } : { video: frame, enableLocalEcho: true };
  }

  hold(extensionId: string, tabId: string, owner: number | null = null): number {
    const id = this.#nextHold++;
    this.#holds.set(id, { extensionId, tabId, owner });
    this.#sync();
    return id;
  }

  /** A hold let go; the extension's last on its tab takes its capture of the tab with it. */
  release(extensionId: string, holdId: number): void {
    const hold = this.#holds.get(holdId);
    if (hold === undefined || hold.extensionId !== extensionId) return;
    this.#holds.delete(holdId);
    const still = [...this.#holds.values()].some((other) => other.extensionId === extensionId && other.tabId === hold.tabId);
    if (!still) this.#endWhere((live) => live.extensionId === extensionId && live.tabId === hold.tabId, "released");
    this.#sync();
  }

  /** Every hold one view of the extension's took, let go (it closed, crashed, or loads another document): as `release`, each. */
  releaseOwned(extensionId: string, owner: number): void {
    for (const [id, hold] of [...this.#holds]) if (hold.extensionId === extensionId && hold.owner === owner) this.release(extensionId, id);
  }

  /** The tabs an extension is capturing now. */
  capturing(extensionId: string): string[] {
    return [...new Set(this.#live.filter((live) => live.extensionId === extensionId).map((live) => live.tabId))];
  }

  /** Every tab held now: by a hold, a live capture or an arm. */
  held(): string[] {
    const tabs = new Set<string>();
    for (const hold of this.#holds.values()) tabs.add(hold.tabId);
    for (const live of this.#live) tabs.add(live.tabId);
    for (const arm of this.#arms.values()) tabs.add(arm.tabId);
    return [...tabs];
  }

  /** End an extension's captures (all, or of one tab): the person's Stop, the extension turned off. Holds stay unless `forget`. */
  end(extensionId: string, reason: CaptureEndReason, tabId?: string): void {
    this.#endWhere((live) => live.extensionId === extensionId && (tabId === undefined || live.tabId === tabId), reason);
    this.#sync();
  }

  /** Everything of an extension's — arm, captures, holds — gone (its worker stopped, it was turned off or removed). */
  forget(extensionId: string, reason: CaptureEndReason): void {
    this.#arms.delete(extensionId);
    for (const [id, hold] of this.#holds) if (hold.extensionId === extensionId) this.#holds.delete(id);
    this.#endWhere((live) => live.extensionId === extensionId, reason);
    this.#sync();
  }

  /**
   * Look at every capture and hold now (the timer's, and main's publish tick's: a tab closed, went elsewhere). Each
   * capturing extension's worker is asked how many tracks it holds live first; one check at a time.
   */
  async check(): Promise<void> {
    if (this.#checking) return;
    this.#checking = true;
    try {
      const tracks = new Map<string, string[] | null>();
      for (const live of this.#live) if (!tracks.has(live.extensionId)) tracks.set(live.extensionId, await this.#host.liveTracks(live.extensionId));
      const now = this.#now();
      for (const [extensionId, arm] of this.#arms) if (now > arm.until || !this.#host.exists(arm.tabId)) this.#arms.delete(extensionId);
      // A hold lapses with its tab, or with the extension's access to it (off in that Profile, a private address): what
      // it may not record it may not keep awake, out of Tidy's reach and at 100%.
      for (const [id, hold] of this.#holds) if (!this.#host.exists(hold.tabId) || !this.#host.capturable(hold.extensionId, hold.tabId)) this.#holds.delete(id);
      for (const live of [...this.#live]) {
        if (!this.#live.includes(live)) continue;
        const sources = tracks.get(live.extensionId) ?? null;
        // Its own tracks: by its source's name, or every track the worker holds when the source went unnamed.
        const held = sources === null ? null : live.key === null ? sources.length : sources.filter((source) => source === live.key).length;
        if (live.ending !== null) {
          this.#checkEnding(live, now, held);
          continue;
        }
        const reason = this.#endReason(live, now, held);
        if (reason !== null) this.#endWhere((other) => other === live, reason);
      }
      this.#sync();
    } finally {
      this.#checking = false;
    }
  }

  /**
   * An ending capture: gone once its worker holds no live track (or the page reports no capturer, or is gone). Held
   * past the first grace, main ends the worker's tracks itself (`enforce` "end") and it stays listed; held — or not
   * answered — past the second, it is gone and the worker is killed (`enforce` "kill").
   */
  #checkEnding(live: Live, now: number, held: number | null): void {
    const ending = live.ending as { since: number; ended: boolean };
    const page = this.#host.page(live.tabId);
    const gone = !this.#host.exists(live.tabId) || page === null || page.isDestroyed() || page.id !== live.pageId || !pageCaptured(page);
    if (gone || held === 0) {
      this.#drop(live);
      return;
    }
    if (!ending.ended) {
      if (now - ending.since < CAPTURE_END_GRACE_MS) return;
      ending.ended = true;
      ending.since = now;
      this.#events.enforce(live.extensionId, live.tabId, "end", live.key);
      return;
    }
    if (now - ending.since < CAPTURE_KILL_GRACE_MS) return;
    this.#drop(live);
    this.#events.enforce(live.extensionId, live.tabId, "kill", live.key);
  }

  #drop(live: Live): void {
    this.#live = this.#live.filter((other) => other !== live);
    this.#events.changed();
  }

  /**
   * Why a live capture is over, if it is. It runs while its worker holds a live track (`held` — the worker's own word,
   * through the guard; null, a worker that cannot be asked, counts as holding) AND the page reports a capturer
   * (Chromium's word: it counts every capturer there is, so it says a capture is over, never that this one runs).
   * Else stopped — not before the start grace unless it was seen running, a stream being a few ms behind its answer.
   */
  #endReason(live: Live, now: number, held: number | null): CaptureEndReason | null {
    if (!this.#host.exists(live.tabId)) return "closed";
    const page = this.#host.page(live.tabId);
    if (page === null || page.isDestroyed() || page.id !== live.pageId) return "closed";
    if (!this.#host.capturable(live.extensionId, live.tabId)) return "navigated";
    if (pageCaptured(page) && (held === null || held > 0)) {
      live.seen = true;
      return null;
    }
    return live.seen || now - live.since > CAPTURE_START_GRACE_MS ? "stopped" : null;
  }

  /**
   * Captures ended. With a reason the stream is known gone by (DEAD_REASONS) they go at once; told to end — the
   * person's Stop, an address capture may not see, the last hold released — they stay listed, the pill up and the tab
   * held, until the page reports no capture or the grace runs out and `enforce` stops the worker (`#checkEnding`):
   * main cannot see a MediaStream end, and the runtime that is told is the extension's own code. Each is told once.
   */
  #endWhere(which: (live: Live) => boolean, reason: CaptureEndReason): void {
    const matching = this.#live.filter(which);
    if (matching.length === 0) return;
    const told = matching.filter((live) => live.ending === null);
    if (DEAD_REASONS.has(reason)) this.#live = this.#live.filter((live) => !which(live));
    else for (const live of told) live.ending = { since: this.#now(), ended: false };
    for (const live of told) this.#events.ended(live.extensionId, live.tabId, reason);
    this.#events.changed();
  }

  dispose(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#timerMs = 0;
  }

  /** The held tabs told to the browser when they changed, and the timer running while anything is armed, live or held. */
  #sync(): void {
    const held = this.held().sort();
    const key = held.join(" ");
    if (key !== this.#heldKey) {
      this.#heldKey = key;
      this.#host.hold(held);
      this.#events.changed();
    }
    const watching = this.#arms.size > 0 || this.#live.length > 0 || this.#holds.size > 0;
    const every = !watching ? 0 : this.#live.some((live) => live.ending !== null) ? CAPTURE_ENDING_CHECK_MS : CAPTURE_CHECK_MS;
    if (every === this.#timerMs) return;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#timerMs = every;
    if (every > 0) {
      this.#timer = setInterval(() => void this.check(), every);
      this.#timer.unref?.();
    }
  }
}

/**
 * Whether a `capture.sources` call is the person's chooser: from the panel of the extension whose panel is open, that
 * panel opened by the person (the Ledge, a key, the Bar — or the worker within a gesture's few seconds) and in view —
 * never one the worker opened on its own, nor one behind a veil: what no one sees is no one's choice to make.
 */
export function panelIsChooser(call: { context: string; extensionId: string; openPanel: string | null; byPerson: boolean; shown: boolean }): boolean {
  return call.context === "panel" && call.openPanel === call.extensionId && call.byPerson && call.shown;
}

/**
 * The sources a caller of `capture.sources` may have pictures of: every one from the open chooser (the person's pick
 * to make, each); from anywhere else only those `allowed` — granted already, or recorded — since a list of pictures
 * of every window is a screenshot of the desk, which `pages.screenshot` asks a grant for.
 */
export function picturedSources<T extends { tabId: string }>(sources: readonly T[], chooser: boolean, allowed: (tabId: string) => boolean): T[] {
  return chooser ? [...sources] : sources.filter((source) => allowed(source.tabId));
}

/**
 * The stills handed back: a source's picture only if it is still the caller's to see once the pictures came (the
 * chooser still open, the grant still on it, or the tab still recorded) and the tab still shows the site that was
 * listed — a tab that went elsewhere while the picture was taken shows that site, and the grant (origin-bound) is
 * gone with it. `pages.screenshot` checks the same once it is done.
 */
export function keepStills<T extends { tabId: string; url: string }>(
  pictured: readonly T[],
  stills: ReadonlyMap<string, string>,
  allowedNow: (source: T) => boolean,
  urlNow: (tabId: string) => string | null,
): Map<string, string> {
  const kept = new Map<string, string>();
  for (const source of pictured) {
    const still = stills.get(source.tabId);
    if (still === undefined) continue;
    const now = urlNow(source.tabId);
    if (now === null || originOf(now) !== originOf(source.url) || !allowedNow(source)) continue;
    kept.set(source.tabId, still);
  }
  return kept;
}

/** Chromium's word on a page: whether any capturer at all has it (a throw reads as none). */
function pageCaptured(page: CapturePage): boolean {
  try {
    return page.isBeingCaptured();
  } catch {
    return false;
  }
}

/**
 * The pill the shell draws for an extension: its own (`ui.setStatus`), or —
 * while it captures a window or watches input — main's (`● Recording ·
 * <name>`, Stop), or its own marked as main's would be (a leading ●, a Stop
 * when it offers none). Null when there is nothing to show.
 */
export function statusPillFor(own: ExtStatus | null, name: string, live: { capturing: boolean; watching: boolean }): ExtensionStatusPill | null {
  if (!live.capturing && !live.watching) return own === null ? null : { text: own.text, actions: [...(own.actions ?? [])] };
  const stop = { id: STOP_ACTION, title: "Stop" };
  if (own === null) return { text: `● ${live.capturing ? "Recording" : "Watching input"} · ${name}`, actions: [stop] };
  const actions = [...(own.actions ?? [])];
  return { text: own.text.trimStart().startsWith("●") ? own.text : `● ${own.text}`, actions: actions.some((action) => action.id === STOP_ACTION) ? actions : [...actions, stop] };
}
