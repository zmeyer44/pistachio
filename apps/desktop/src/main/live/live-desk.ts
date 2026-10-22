import { MAX_DESK_WINDOWS, MAX_FAVICON_LENGTH, MAX_WINDOW_TITLE_LENGTH, type LiveDeskFrame, type LiveWindow } from "@pistachio/live-share";
import type { LiveDeskReport, LiveShellMark } from "@pistachio/shell-contracts/live-share";
import type { TabGroupColor } from "@pistachio/shell-contracts/tab-groups";

/**
 * The desk as guests rebuild it (docs/live-share.md §4 `lv.desk`, §6.1): the
 * shell's report of the shared space's geometry, with what only main knows
 * laid on it — each window's title, its site (never the address), its icon,
 * whether guests may use it, whether it streams — deduped, and sent at most
 * 30 times a second.
 */

/** What main knows of one window of the shared space. */
export interface LiveWindowFacts {
  title: string;
  /** The page's address (only its host leaves the Mac), or null for a shell-drawn window. */
  url: string | null;
  favicon: string | null;
  /** A tab's own page, which its native view shows and tab capture can stream; false for a shell-drawn window. */
  page: boolean;
  /** A terminal the shell draws: guests let use it type into its shell (live-input.ts), its picture the shell's. */
  terminal: boolean;
}

/** Window tracks at once (§3); past that, by the stack from the top, a window is its frame alone. */
export const MAX_LIVE_TRACKS = 8;
/** The fastest frames go out while the desk moves. */
export const DESK_FRAME_MS = 33;

/**
 * A space's colour as guests see it: the tone the rail draws its tile in
 * (shell.css `--tg-solid`, light), since the protocol carries a #rrggbb.
 */
const SPACE_COLORS: Record<TabGroupColor, string> = {
  gray: "#818da0",
  green: "#00a95c",
  blue: "#388cf0",
  purple: "#9572e7",
  amber: "#c17c00",
  pink: "#d4599b",
  red: "#e15955",
  orange: "#d96700",
};

export function spaceColor(color: TabGroupColor): string {
  return SPACE_COLORS[color];
}

/** The site a window shows, never its address: the host of an http(s) page. */
export function originOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname !== "" ? parsed.hostname.slice(0, 253) : null;
  } catch {
    return null;
  }
}

/** An icon guests may load: an https: URL or a small data:image/ one. */
export function faviconOf(url: string | null): string | null {
  if (url === null || url.length > MAX_FAVICON_LENGTH) return null;
  return url.startsWith("https:") || url.startsWith("data:image/") ? url : null;
}

/**
 * A title within the protocol's bound as its schema counts it — UTF-16 units,
 * not characters: an emoji is two, and one unit over drops the whole frame —
 * cut short with "…", never between the two halves of a character.
 */
function clip(text: string): string {
  if (text.length <= MAX_WINDOW_TITLE_LENGTH) return text;
  let end = MAX_WINDOW_TITLE_LENGTH - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + "…";
}

/**
 * The windows that stream, top of the stack first: pages and shell-drawn
 * windows that are neither minimized nor masked, at most eight. A masked
 * window's capture would be its whole page, what the mask cuts away included
 * (the tab is captured, not the region shown), so it is its frame alone. A
 * shell-drawn window's picture is cut from the shell's own (§6.6).
 */
export function streamedWindows(windows: ReadonlyArray<{ id: string; kind: "page" | "shell"; minimized: boolean; masked: boolean }>): Set<string> {
  const streamed = new Set<string>();
  for (let index = windows.length - 1; index >= 0 && streamed.size < MAX_LIVE_TRACKS; index -= 1) {
    const window = windows[index]!;
    if (!window.minimized && !window.masked) streamed.add(window.id);
  }
  return streamed;
}

/**
 * Whether a streamed window's picture is held now. A page's is its tab's
 * capture, whatever lies over it on the Mac, so only a masked one is (it is
 * not streamed at all). A shell-drawn window's is cut from the shell's own
 * page, which holds whatever the shell draws over it: it is held while the
 * host is away from the space, while something of the shell's that no box
 * holds lies over the desk (`shellCovered`), and while something whose box
 * is known lies over the window itself (its `covered`) — §6.6, §10.
 */
export function pausedWindow(kind: "page" | "shell", window: { masked: boolean; covered: boolean }, streamed: boolean, desk: { hostPresent: boolean; shellCovered: boolean }): boolean {
  if (kind === "page") return window.masked;
  return !streamed || !desk.hostPresent || desk.shellCovered || window.covered;
}

/** The shell's mark a report was painted under, and where it put the stage: what the host app cuts the shell's picture by (§6.6). */
export function shellMarkOf(report: LiveDeskReport): LiveShellMark {
  return { mark: report.mark, stage: { ...report.stageInWindow }, viewport: { ...report.viewport } };
}

export interface DeskFrameInputs {
  report: LiveDeskReport;
  /** What main knows of a window, or null for one it does not (a tab gone since the report). */
  facts: (windowId: string) => LiveWindowFacts | null;
  /** The windows the host lets guests use. */
  controllable: ReadonlySet<string>;
  hostPresent: boolean;
  /** The host's *Guests can draw* (on unless said). */
  guestsCanDraw?: boolean;
  space: { title: string; color: string };
}

/**
 * A frame of the desk, `seq` aside. A window is a page only if the shell says
 * so AND main knows it as a tab's own page: no other tab is ever captured.
 * Any other window is the shell's to draw, and its picture is cut from the
 * shell's own page.
 */
export function deskFrame(inputs: DeskFrameInputs): Omit<LiveDeskFrame, "seq"> {
  const known = inputs.report.windows.flatMap((window) => {
    const facts = inputs.facts(window.id);
    return facts === null ? [] : [{ window, facts, kind: window.kind === "page" && facts.page ? ("page" as const) : ("shell" as const) }];
  }).slice(-MAX_DESK_WINDOWS);
  const streamed = streamedWindows(known.map(({ window, kind }) => ({ id: window.id, kind, minimized: window.minimized, masked: window.masked })));
  const windows = known.map(({ window, facts, kind }): LiveWindow => ({
    id: window.id,
    kind,
    title: clip(facts.title),
    origin: kind === "page" ? originOf(facts.url) : null,
    favicon: faviconOf(facts.favicon),
    frame: window.frame,
    page: window.page,
    focused: window.focused,
    minimized: window.minimized,
    // Only a window that streams (minimized, masked and those past the eight do not): a guest's hands reach only what they see,
    // and the input gate lets nothing through to any other. Of the shell's windows, a terminal alone takes them (§6.6).
    controllable: inputs.hostPresent && (kind === "page" || facts.terminal) && inputs.controllable.has(window.id) && streamed.has(window.id),
    ...(kind === "shell" && facts.terminal ? { terminal: true } : {}),
    track: streamed.has(window.id) ? `win:${window.id}` : null,
    paused: pausedWindow(kind, window, streamed.has(window.id), { hostPresent: inputs.hostPresent, shellCovered: inputs.report.shellCovered }),
  }));
  return {
    v: 1,
    stage: { w: inputs.report.stage.w, h: inputs.report.stage.h },
    hostPresent: inputs.hostPresent,
    guestsCanDraw: inputs.guestsCanDraw ?? true,
    space: { title: clip(inputs.space.title), color: inputs.space.color },
    windows,
  };
}

/**
 * The frames that go out: a frame equal to the last is dropped, and they leave
 * at most every 33 ms — the latest one, once the interval is up — except one
 * that holds a picture the last let run, which goes at once: the host app
 * stops cutting a shell-drawn window's picture the moment something covers it.
 * Each goes with the shell's mark it was built under (§6.6): the host app
 * cuts a frame of the shell's picture only by the word of the report it was
 * painted under. A new mark on a frame guests already have goes too — the
 * same frame, its `seq` kept, the mark alone new — at the same pace.
 */
export class LiveDeskFrames {
  readonly #send: (frame: LiveDeskFrame, shell: LiveShellMark | null) => void;
  readonly #now: () => number;
  #seq = 0;
  #sentKey: string | null = null;
  #sentShell: string | null = null;
  #latest: LiveDeskFrame | null = null;
  #latestShell: LiveShellMark | null = null;
  #pending: { frame: Omit<LiveDeskFrame, "seq">; key: string; shell: LiveShellMark | null; shellKey: string } | null = null;
  #lastSentAt = -Infinity;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(send: (frame: LiveDeskFrame, shell: LiveShellMark | null) => void, now: () => number = Date.now) {
    this.#send = send;
    this.#now = now;
  }

  /** The last frame sent, for the host app that asks for it as it starts. */
  get latest(): LiveDeskFrame | null {
    return this.#latest;
  }

  /** The shell's mark the last frame went with. */
  get latestShell(): LiveShellMark | null {
    return this.#latestShell;
  }

  update(frame: Omit<LiveDeskFrame, "seq">, shell: LiveShellMark | null = null): void {
    const key = JSON.stringify(frame);
    const shellKey = JSON.stringify(shell);
    // Back to what went out last: whatever was waiting is not news any more.
    this.#pending = key === this.#sentKey && shellKey === this.#sentShell ? null : { frame, key, shell, shellKey };
    if (this.#pending === null) return;
    if (holdsMore(this.#latest, frame)) {
      if (this.#timer !== null) clearTimeout(this.#timer);
      this.#flush();
      return;
    }
    if (this.#timer !== null) return;
    const wait = this.#lastSentAt + DESK_FRAME_MS - this.#now();
    if (wait <= 0) this.#flush();
    else this.#timer = setTimeout(() => this.#flush(), wait);
  }

  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending = null;
  }

  #flush(): void {
    this.#timer = null;
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    // (Guests number frames: one that says nothing new to them keeps its number.)
    if (pending.key !== this.#sentKey || this.#latest === null) {
      this.#seq += 1;
      this.#sentKey = pending.key;
      this.#latest = { ...pending.frame, seq: this.#seq };
    }
    this.#sentShell = pending.shellKey;
    this.#latestShell = pending.shell;
    this.#lastSentAt = this.#now();
    this.#send(this.#latest, pending.shell);
  }
}

/** `next` holds a streamed window's picture that `sent` let run. */
function holdsMore(sent: LiveDeskFrame | null, next: Omit<LiveDeskFrame, "seq">): boolean {
  if (sent === null) return false;
  const running = new Set(sent.windows.filter((window) => window.track !== null && !window.paused).map((window) => window.id));
  return next.windows.some((window) => window.paused && running.has(window.id));
}
