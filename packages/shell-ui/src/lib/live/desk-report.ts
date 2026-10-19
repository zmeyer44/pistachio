/**
 * The shell's report of the shared space's desk (docs/live-share.md §6.4,
 * `setLiveDesk`): while a share is live, where its windows are, for main to
 * build the desk guests rebuild. The geometry is the desk engine's (its
 * `liveGeometry`, read after each of its renders; its `savedGeometry` for a
 * space not in front), turned into a `LiveDeskReport` here and paced:
 *
 * - the space in front: at most every 33 ms while anything moves, the
 *   latest always — sent from the render that drew it once the interval is
 *   up, so the frame it is painted in shows it — and once more `settled`
 *   when nothing has moved for a moment;
 * - the space not in front: its saved arrangement, laid out on the desk as
 *   it is now, once — and again only if that changes (the arrangement, its
 *   windows, the stage);
 * - a report that covers more than the one sent last, whose stage moved in
 *   the window, or that moves a window the last report called steady, at
 *   once: main stops the shell-drawn windows' pictures on it, and it must be
 *   there before what covers them is painted.
 *
 * What covers what (§6.6): a shell-drawn window's picture is cut from the
 * shell's own page, so whatever the shell draws over a window is in it.
 * Something whose box is known — a side card, a tooltip's band, the Bar's
 * answer, the rail's floating player (`coverReach`) — covers the windows it
 * lies over (padded, and over where the report sent last put them too:
 * that is where a frame painted now is cut until the next report); anything
 * else — a store overlay, a cover drawn where nothing says exactly, a layer
 * in `<body>` that is not a tooltip in its band or off the stage, a passing
 * — covers them all (`shellCovered`). When unsure, all. The boxes go in
 * the report too (`covers`): the live-host app draws no window's marks
 * there, so the outlines go under the shell's own surfaces (§6.3).
 *
 * Every report sent is numbered (`mark`), and the shell paints the number
 * into its own pixels in the same task (lib/live/marker.ts): the live-host
 * app cuts a frame only by the word of the report it was painted under. A
 * render that draws a window where the report sent last did not put it,
 * its own report waiting its turn, paints that number stale in the same
 * task: a frame painted so shows only the windows that report and the one
 * before it put in the same place (`steady`) where it says — a window on the
 * move (carried, resized, gliding, laid out afresh) is cut only from a frame
 * painted in the render its report went from; and a steady one that starts
 * to move sends its report at once. No frame is cut where a window no
 * longer is.
 *
 * Per-frame geometry never enters a React store: the engine calls in, this
 * keeps one string to compare against, and the bridge carries the rest.
 * Pure of the DOM and of timers' sources, so test/live-desk-report.test.ts
 * drives it with a clock of its own.
 */

import { LIVE_SHELL_MARKS, MAX_LIVE_DESK_COVERS, MAX_LIVE_DESK_WINDOWS, type LiveDeskReport, type LiveRect } from "@pistachio/shell-contracts/live-share";
import { FLOAT_COVER, windowTipCover, type DeskLiveWindow } from "../../components/desk/desk-engine";

/** The fastest reports go while the desk moves (as main sends frames on: ≤ 30 a second). */
export const LIVE_DESK_REPORT_MS = 33;
/**
 * A report due within this much goes from the render in hand: renders come
 * a display's frame apart (16.7 ms at 60 Hz) and a little late or early, and
 * the next one would leave a frame more painted under a stale mark.
 */
export const LIVE_DESK_DUE_SLACK_MS = 4;
/**
 * Every other report is due this much past the interval instead: reports
 * then go two renders apart and three by turns at 60 Hz (four and five at
 * 120 Hz, three and four at 90). The capture of the shell takes about every
 * other frame of a 60 Hz desk (≤ 30 a second), steadily; reports a steady
 * two renders apart could fall on the frames it leaves every time, and a
 * window on the move, cut only from a frame painted as its report goes,
 * would get no picture at all while it moves. By turns, some of them fall
 * on frames it takes, whichever it takes.
 */
export const LIVE_DESK_DUE_STAGGER_MS = 8;
/** A report kept back goes this long after it is due, if no render has come to take it (the desk stopped moving). */
export const LIVE_DESK_FLUSH_GRACE_MS = 20;
/** Nothing has moved for this long: the desk has settled, and says so once. */
export const LIVE_DESK_SETTLE_MS = 120;
/** Room kept round a cover's box for what is drawn just past it: a ring, a shadow's edge, a tooltip's arrow. */
export const LIVE_COVER_PAD = 8;

/** What a window is to guests: a tab's page, which main captures, or one the shell draws (a document, a shell page). */
export type LiveWindowKind = "page" | "shell";

/** A report before it is sent: the pacer numbers it (`mark`) as it goes. */
export type LiveDeskDraft = Omit<LiveDeskReport, "mark">;

/**
 * How a live share takes a cover of the desk's: as lying in its own box,
 * padded (`box`); in the stage's column up to its trailing edge (`column`:
 * it is anchored to the sidebar and glides along it, its top and height
 * animated with nothing re-measured); or over every window (`global`: where
 * it is drawn is not known well enough to say).
 */
export type CoverReach = "box" | "column" | "global";

/** The side cards' cover (DeskSideCard: the Live card, the More card, the Stack's). */
const CARD_COVER = "card";
/** The hidden sidebar's column brought out over the desk (layouts/SidebarLayout.tsx). */
const SIDEBAR_COVER = "sidebar";
/** The tooltip bands: the Bar's (above its pill, beside its nub) — a frame's are WINDOW_TIP's. */
const BAR_TIPS = new Set(["bar-tip", "nub-tip"]);
/**
 * Covers whose box is where they are drawn: the tooltip bands (their
 * tooltips shown only once the band is a cover, and the band kept a moment
 * after they go), the Bar's answer (its box set in the very task that moves
 * it, and taken down as it is unmounted), the rail's floating player.
 */
const BOXED = new Set([...BAR_TIPS, "answer", FLOAT_COVER]);
const WINDOW_TIP = windowTipCover("");

/**
 * Which covers a live share knows the box of. Not the Bar's own — its nub,
 * pill and menus are goo, drawn past their boxes as they swell — nor the
 * answer's snap ghost and lit zones (they fade out after their covers
 * go), a drop, the layout preview, the mask editor, the media card: those,
 * and any cover not named here, lie over every window.
 */
export function coverReach(key: string): CoverReach {
  if (key === CARD_COVER || key === SIDEBAR_COVER) return "column";
  if (BOXED.has(key) || key.startsWith(WINDOW_TIP)) return "box";
  return "global";
}

/** Where a cover lies as far as a live share goes (stage CSS px, padded), or null: over every window. */
export function coverBox(cover: { key: string; rect: LiveRect }, stage: { w: number; h: number }): LiveRect | null {
  const { rect } = cover;
  switch (coverReach(cover.key)) {
    case "global":
      return null;
    case "column": {
      const left = Math.min(0, rect.x) - LIVE_COVER_PAD;
      return { x: left, y: -LIVE_COVER_PAD, w: rect.x + rect.w + LIVE_COVER_PAD - left, h: stage.h + LIVE_COVER_PAD * 2 };
    }
    case "box":
      return { x: rect.x - LIVE_COVER_PAD, y: rect.y - LIVE_COVER_PAD, w: rect.w + LIVE_COVER_PAD * 2, h: rect.h + LIVE_COVER_PAD * 2 };
  }
}

function overlaps(a: LiveRect, b: LiveRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function inside(inner: LiveRect, outer: LiveRect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

function padded(rect: LiveRect): LiveRect {
  return { x: rect.x - LIVE_COVER_PAD, y: rect.y - LIVE_COVER_PAD, w: rect.w + LIVE_COVER_PAD * 2, h: rect.h + LIVE_COVER_PAD * 2 };
}

/**
 * What of the shell's own state puts something over the page area (the
 * desk's stage included): App's overlay — the address palette, a context
 * menu, the tab switcher, a dialog, Settings — the overlay raised over the
 * content, the error toast, onboarding, a screenshot's selector, a Glance.
 * Each dims, blurs or fills the whole window: over every window.
 */
export interface ShellLayers {
  overlay: string;
  overlayActive: boolean;
  error: unknown;
  onboardingOpen: boolean;
  screenshotSelecting: boolean;
  glance: unknown;
  tabSwitcher: unknown;
}

/** Something of `ShellLayers` is up (or on its way up). */
export function layersCover(state: ShellLayers): boolean {
  return (
    state.overlay !== "none" ||
    state.overlayActive ||
    state.error !== null ||
    state.onboardingOpen ||
    state.screenshotSelecting ||
    state.glance !== null ||
    state.tabSwitcher !== null
  );
}

/**
 * A layer of its own in `<body>`, beside the app's root (a portal: a
 * tooltip, a popover, a menu, a dialog), as the report measured it: if it
 * holds tooltips (Base UI's popup, `[data-slot="tooltip-content"]`) and
 * nothing else, the box they are drawn in, in the window; null for any
 * other layer.
 */
export interface BodyLayer {
  /** Window CSS px, as laid out now (an animation's scale included). */
  tooltip: LiveRect | null;
}

/**
 * Whether `<body>`'s own layers lie over the stage with nothing to say
 * where: any layer at all, but a tooltip drawn wholly inside a band its
 * frame or the Bar keeps for it (a cover, `bands`, stage CSS px, padded) or
 * wholly off the stage. Where a portal is drawn is its own business —
 * positioned a frame later, animating out — so a layer that is not a
 * tooltip counts as over every window, and a tooltip as it lies now
 * (measured again as anything in it changes).
 */
export function layersOverStage(layers: readonly BodyLayer[], stage: LiveRect, bands: readonly LiveRect[]): boolean {
  return layers.some((layer) => {
    if (layer.tooltip === null) return true;
    const box = padded(layer.tooltip);
    if (!overlaps(box, padded(stage))) return false;
    return !bands.some((band) => inside(box, { x: stage.x + band.x, y: stage.y + band.y, w: band.w, h: band.h }));
  });
}

/** The tooltip bands among the covers (stage CSS px, padded): where a tooltip of a frame's buttons or of the Bar's is drawn. */
export function tooltipBands(covers: ReadonlyArray<{ key: string; rect: LiveRect }>): LiveRect[] {
  return covers.filter((cover) => BAR_TIPS.has(cover.key) || cover.key.startsWith(WINDOW_TIP)).map((cover) => padded(cover.rect));
}

export interface DeskReportInputs {
  groupId: string;
  /** The stage's box in the window (CSS px). */
  stage: LiveRect;
  /** The window's content box (the shell's viewport), CSS px. */
  viewport: { w: number; h: number };
  /** Bottom to top, in the stage's coordinates. */
  windows: readonly DeskLiveWindow[];
  kindOf(windowId: string): LiveWindowKind;
  /** What the shell draws over the stage where its owner says (the engine's covers), stage CSS px. */
  covers: ReadonlyArray<{ key: string; rect: LiveRect }>;
  /** Something of the shell's lies over the stage that no box holds (a passing, an overlay, a layer of its own). */
  covered: boolean;
  /** The report sent last: a window is covered over where that put it too, since a frame painted now is cut by it until the next. */
  sent: LiveDeskReport | null;
}

/**
 * The report for `inputs`: the stage's size and place, and each window (the
 * top ones, past what a report holds) with whether something whose box is
 * known lies over its page box — or over where the report sent last put it —
 * or it is drawn grown or turned (`covered`); and those boxes (`covers`).
 * Anything over the stage whose box is not known — or more boxes than a
 * report holds — is `shellCovered`.
 */
export function deskReport(inputs: DeskReportInputs, settled: boolean): LiveDeskDraft {
  const stage = { w: Math.max(1, inputs.stage.w), h: Math.max(1, inputs.stage.h) };
  const boxes = inputs.covers.map((cover) => coverBox(cover, stage));
  const known = boxes.filter((box): box is LiveRect => box !== null);
  const sentPages = new Map((inputs.sent?.windows ?? []).map((window) => [window.id, window.page]));
  return {
    groupId: inputs.groupId,
    stage,
    stageInWindow: { ...inputs.stage },
    viewport: { w: inputs.viewport.w, h: inputs.viewport.h },
    windows: inputs.windows.slice(-MAX_LIVE_DESK_WINDOWS).map((window) => {
      const was = sentPages.get(window.id);
      return {
        id: window.id,
        kind: inputs.kindOf(window.id),
        frame: { ...window.frame },
        page: { ...window.page },
        focused: window.focused,
        minimized: window.minimized,
        masked: window.masked,
        // (Drawn grown or turned, its box is not where its page is drawn: held as a covered one is.)
        covered: window.transformed || known.some((box) => overlaps(box, window.page) || (was !== undefined && overlaps(box, was))),
      };
    }),
    settled,
    shellCovered: inputs.covered || boxes.some((box) => box === null) || known.length > MAX_LIVE_DESK_COVERS,
    covers: known.slice(0, MAX_LIVE_DESK_COVERS),
  };
}

/** A report's geometry as one string: two reports with the same key say the same thing (`settled` and the mark aside). */
export function reportKey(report: LiveDeskDraft): string {
  const box = (rect: LiveRect): string => `${String(rect.x)},${String(rect.y)},${String(rect.w)},${String(rect.h)}`;
  const windows = report.windows.map(
    (window) => `${window.id}|${window.kind}|${box(window.frame)}|${box(window.page)}|${window.focused ? "f" : ""}${window.minimized ? "m" : ""}${window.masked ? "k" : ""}${window.covered ? "c" : ""}`,
  );
  return [
    report.groupId,
    `${String(report.stage.w)}x${String(report.stage.h)}`,
    box(report.stageInWindow),
    `${String(report.viewport.w)}x${String(report.viewport.h)}`,
    report.shellCovered ? "covered" : "clear",
    `over:${report.covers.map(box).join(";")}`,
    ...windows,
  ].join(" ");
}

/** `next` covers something `sent` did not: the stage, or one of its windows. */
export function coversMore(sent: LiveDeskDraft | null, next: LiveDeskDraft): boolean {
  if (sent === null) return next.shellCovered || next.windows.some((window) => window.covered);
  if (next.shellCovered && !sent.shellCovered) return true;
  const was = new Set(sent.windows.filter((window) => window.covered).map((window) => window.id));
  return next.windows.some((window) => window.covered && !was.has(window.id));
}

/**
 * `next` cannot wait its turn: it covers more than `sent`, or the stage lies
 * elsewhere in the window, or the window changed size — a frame of the
 * shell painted so is cut by the report it was painted under, and one of
 * the old layout would be cut wrong.
 */
export function urgent(sent: LiveDeskDraft | null, next: LiveDeskDraft): boolean {
  if (coversMore(sent, next)) return true;
  if (sent === null) return false;
  const a = sent.stageInWindow;
  const b = next.stageInWindow;
  return a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h || sent.viewport.w !== next.viewport.w || sent.viewport.h !== next.viewport.h;
}

/**
 * Where a report puts each window's page: what a frame of the shell's
 * picture is cut at. Every window's, not only those it calls shell-drawn:
 * main cuts any window it does not know as a tab's own page from the shell's
 * picture too (§6.1), and a page's moving costs nothing here.
 */
export function pagesOf(report: LiveDeskDraft): Map<string, LiveRect> {
  return new Map(report.windows.map((window) => [window.id, window.page]));
}

function samePage(a: LiveRect, b: LiveRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** `next` draws a window other than where `sent` put it: one moved, come or gone. */
export function pagesMoved(sent: LiveDeskDraft, next: LiveDeskDraft): boolean {
  const was = pagesOf(sent);
  const now = pagesOf(next);
  if (was.size !== now.size) return true;
  for (const [id, page] of now) {
    const before = was.get(id);
    if (before === undefined || !samePage(before, page)) return true;
  }
  return false;
}

/**
 * The windows `sent` put where `before` (the report sent just before it)
 * did, and where: a frame painted under `sent`'s stale mark shows these
 * where `sent` says, since one of them moving sends a report at once.
 */
export function steadyPages(before: LiveDeskDraft | null, sent: LiveDeskDraft): Map<string, LiveRect> {
  const was = before === null ? new Map<string, LiveRect>() : pagesOf(before);
  return new Map([...pagesOf(sent)].filter(([id, page]) => {
    const then = was.get(id);
    return then !== undefined && samePage(then, page);
  }));
}

/** `next` moves one of the steady windows (`steadyPages`), or has it no more. */
export function movesSteady(steady: ReadonlyMap<string, LiveRect>, next: LiveDeskDraft): boolean {
  if (steady.size === 0) return false;
  const now = pagesOf(next);
  for (const [id, page] of steady) {
    const then = now.get(id);
    if (then === undefined || !samePage(then, page)) return true;
  }
  return false;
}

export interface PacerClock {
  now(): number;
  later(run: () => void, ms: number): () => void;
}

/** Where the pacer's reports go: to main with their marks painted fresh, and the last one's painted stale. */
export interface PacerOutlet {
  /** Send `report` to main, and paint its mark in this task: what the shell draws now is where it says. */
  send(report: LiveDeskReport): void;
  /** Paint report `mark`'s mark stale in this task: the shell draws a window elsewhere now, its report kept back. */
  stale(mark: number): void;
}

/**
 * Paces reports to main: `moving` ones at most every LIVE_DESK_REPORT_MS
 * (the latest wins) — sent from the render that drew them once the interval
 * is up (within LIVE_DESK_DUE_SLACK_MS; every other one
 * LIVE_DESK_DUE_STAGGER_MS past it), or on their own a moment after if no
 * render comes — and once nothing has changed for LIVE_DESK_SETTLE_MS,
 * that report again as `settled`; a `still` one (a saved arrangement) goes
 * at once, settled; so does one that cannot wait (`urgent`, or moving a
 * window the last report called steady), whatever the interval. A report
 * equal to the last one is no news. Each goes numbered (`mark`, counting on
 * from `firstMark` and wrapping), its mark painted fresh as it goes; a
 * render kept back that draws a window elsewhere paints the last mark
 * stale, in its own task, before anything of it is painted.
 */
export class LiveDeskPacer {
  readonly #outlet: PacerOutlet;
  readonly #clock: PacerClock;
  #key: string | null = null;
  #latest: LiveDeskDraft | null = null;
  #sent: LiveDeskReport | null = null;
  #sentKey: string | null = null;
  #sentSettled = false;
  /** The windows the report sent last put where the one before it did. */
  #steady: ReadonlyMap<string, LiveRect> = new Map();
  /** The mark painted is the last report's, stale. */
  #stale = false;
  #mark: number;
  #lastSentAt = Number.NEGATIVE_INFINITY;
  /** How long after the last report the next one moving is due (LIVE_DESK_DUE_STAGGER_MS: by turns). */
  #dueIn = 0;
  #staggered = false;
  #cancelFlush: (() => void) | null = null;
  #cancelSettle: (() => void) | null = null;

  constructor(outlet: PacerOutlet, clock: PacerClock, firstMark = 0) {
    this.#outlet = outlet;
    this.#clock = clock;
    this.#mark = (firstMark + LIVE_SHELL_MARKS - 1) % LIVE_SHELL_MARKS;
  }

  /** The report sent last, as it went (its mark too); null before the first. */
  get sent(): LiveDeskReport | null {
    return this.#sent;
  }

  /** The desk in front as it stands this frame, from the render that drew it. */
  moving(report: LiveDeskDraft): void {
    const key = reportKey(report);
    if (key === this.#key) return;
    this.#key = key;
    this.#latest = report;
    this.#cancelSettle?.();
    this.#cancelSettle = this.#clock.later(() => this.#settle(), LIVE_DESK_SETTLE_MS);
    const now = this.#clock.now();
    if (urgent(this.#sent, report) || movesSteady(this.#steady, report) || now - this.#lastSentAt >= this.#dueIn) {
      this.#flush();
      return;
    }
    // Kept back: a frame painted from here on shows a window elsewhere than the mark's report says — unless it is stale.
    if (!this.#stale && this.#sent !== null && pagesMoved(this.#sent, report)) {
      this.#stale = true;
      this.#outlet.stale(this.#sent.mark);
    }
    this.#cancelFlush ??= this.#clock.later(() => this.#flush(), this.#lastSentAt + this.#dueIn + LIVE_DESK_FLUSH_GRACE_MS - now);
  }

  /** A desk that does not move (a saved arrangement): sent at once, settled, unless it says nothing new. */
  still(report: LiveDeskDraft): void {
    const key = reportKey(report);
    this.#cancelTimers();
    this.#key = key;
    this.#latest = report;
    if (key === this.#sentKey && this.#sentSettled) return;
    this.#out(report, true, key);
  }

  /** Stop: nothing more goes out (the share ended, the desk went). */
  dispose(): void {
    this.#cancelTimers();
    this.#latest = null;
  }

  #flush(): void {
    this.#cancelFlush?.();
    this.#cancelFlush = null;
    const report = this.#latest;
    if (report === null || this.#key === this.#sentKey) return;
    this.#out(report, false, this.#key!);
  }

  #settle(): void {
    this.#cancelSettle = null;
    const report = this.#latest;
    if (report === null || (this.#key === this.#sentKey && this.#sentSettled)) return;
    this.#cancelFlush?.();
    this.#cancelFlush = null;
    this.#out(report, true, this.#key!);
  }

  #out(report: LiveDeskDraft, settled: boolean, key: string): void {
    this.#mark = (this.#mark + 1) % LIVE_SHELL_MARKS;
    const sent: LiveDeskReport = { ...report, settled, mark: this.#mark };
    this.#steady = steadyPages(this.#sent, sent);
    this.#sent = sent;
    this.#sentKey = key;
    this.#sentSettled = settled;
    this.#stale = false;
    this.#lastSentAt = this.#clock.now();
    this.#dueIn = this.#staggered ? LIVE_DESK_REPORT_MS + LIVE_DESK_DUE_STAGGER_MS : LIVE_DESK_REPORT_MS - LIVE_DESK_DUE_SLACK_MS;
    this.#staggered = !this.#staggered;
    this.#outlet.send(sent);
  }

  #cancelTimers(): void {
    this.#cancelFlush?.();
    this.#cancelFlush = null;
    this.#cancelSettle?.();
    this.#cancelSettle = null;
  }
}
