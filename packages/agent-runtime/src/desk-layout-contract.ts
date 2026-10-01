/**
 * Whether the desk's windows should be laid out anew — after a window came
 * out, after one left, or because the person asked — as judged by a System
 * One evaluation model (TypeSafe's Jev, through the Vercel AI Gateway:
 * docs/desk-layout.md). The wire shapes, the bounds, and the policy that
 * turns the model's opinion into a move.
 *
 * The desk lays a new window out by rule (placeNewWindow: a tiled desk's
 * hole, or half of the window in use) and leaves a gap where one went. The
 * rules cannot tell what the windows are FOR: that the page just opened
 * belongs beside the spreadsheet, not the mail it split; that a doc being
 * written deserves most of the desk and the three sources beside it a
 * strip each. So the shell offers the moves its geometry allows now —
 * keep, fill the gap, pair the new window with another, tile, give one
 * window the main place — and the model puts a probability on each, on
 * which window is the person's main work, and on which window a new one
 * goes with. The shell's geometry, never the model, works out where each
 * window goes; the worst a wrong (or manipulated — page titles are
 * untrusted) answer can do is lay the desk out another way, which the
 * person can undo.
 *
 * No `ai` import, no Node, no DOM here: the shapes are importable from
 * anywhere, the renderer included. The evaluator beside it —
 * ./desk-layout.ts — is what a host calls.
 */

/** What happened: a window came out, one or more left the desk, or the person asked for a better layout. */
export const DESK_LAYOUT_TRIGGERS = ["opened", "closed", "asked"] as const;
export type DeskLayoutTrigger = (typeof DESK_LAYOUT_TRIGGERS)[number];

/**
 * The moves. Ids are the model's option names.
 *
 *  - `keep`: nothing moves (offered unless the person asked).
 *  - `fill`: the windows beside the gap a closed window left grow into it,
 *    as the other pane of a split view does (only when they can, exactly).
 *  - `pair`: the new window shares the place of the window it goes with,
 *    side by side — rather than wherever it came out.
 *  - `tile`: the desk shared evenly among every window.
 *  - `focus`: the main window takes most of the desk, the rest stacked beside it.
 */
export const DESK_LAYOUT_MOVES = ["keep", "fill", "pair", "tile", "focus"] as const;
export type DeskLayoutMove = (typeof DESK_LAYOUT_MOVES)[number];

/** One window on the desk, as the model is told of it. */
export interface DeskLayoutWindow {
  /** The shell's id. The model never sees it: it reads `w1`, `w2`, … */
  id: string;
  title: string;
  /** The site's host; empty for a document or one of the shell's own pages. */
  site: string;
  kind: "page" | "document";
  /** Where it is, in the shell's words: "the left half of the desk", "a small window at the top right". */
  place: string;
  /** The window in use: the person's last click or keystroke went there. */
  inUse: boolean;
  /** The window that just came out (trigger "opened"). */
  opened: boolean;
}

/** A window that just left the desk, and where it was. */
export interface DeskLayoutGone {
  title: string;
  site: string;
  place: string;
  /** Closed, or put away into the dock (it is still open there). */
  how: "closed" | "collapsed";
}

/**
 * What the model reads. Thin on purpose: titles and hosts, never a URL (a
 * path or a query would distract a literal reader and leak what was
 * browsed), and places in words rather than numbers.
 */
export interface DeskLayoutRequest {
  trigger: DeskLayoutTrigger;
  /** The desk's windows that may be moved, bottom to top. */
  windows: DeskLayoutWindow[];
  /** What just left the desk (trigger "closed"). */
  gone: DeskLayoutGone[];
  /** The moves the shell can make now. `keep` is among them unless the person asked. */
  moves: DeskLayoutMove[];
  /** For `fill`: the titles of the windows that would grow into the gap. */
  fillers: string[];
}

/** What the model thought, before the shell decides. */
export interface DeskLayoutEvaluation {
  /** P(each move); 0 for one not offered. */
  moves: Record<DeskLayoutMove, number>;
  /** P(each window is the person's main work), by the shell's window id. */
  main: Record<string, number>;
  /** P(the new window goes with each other window), by id; `NO_PARTNER` for none. Null unless a window came out. */
  partner: Record<string, number> | null;
  /** How sure the model is of the move, 0–1 (its own figure when it sends one). */
  confidence: number;
  latencyMs: number;
}

/** "Goes with none of them" in `DeskLayoutEvaluation.partner`. */
export const NO_PARTNER = "";

/** The shell's decision: the move, and the windows it is about. */
export interface DeskLayoutDecision {
  move: DeskLayoutMove;
  /** For `focus` (and the order `tile` lays windows in): the main window's id. */
  main: string | null;
  /** For `pair`: the window the new one goes beside. */
  partner: string | null;
  basis: "model" | "unavailable";
}

export const DESK_LAYOUT_LIMITS = {
  /**
   * A window coming or going is laid out anew within this, or not at all —
   * the desk does not move a second after the person has moved on. The
   * model answers in ~250 ms.
   */
  timeoutMs: 1_500,
  /** Asked for by the person, it may take one retry of a transient gateway error (the SDK waits 2 s first). */
  askedTimeoutMs: 4_000,
  /** More windows than this and the desk is not asked about: no layout of so many is a good one. */
  windows: 12,
  gone: 4,
  titleChars: 120,
  siteChars: 100,
  placeChars: 120,
  /**
   * A window coming or going moves the others only when the model's likeliest
   * move is not keep, is at least this likely, and leads keep by `actLead` —
   * the person put the windows where they are. A move that lays out EVERY
   * window (tile, focus) must be surer still (`reshapeFloor`): the bigger
   * the change the person did not ask for, the surer the desk must be of it.
   * Asked (⌘⌥L), none of these apply.
   */
  actFloor: 0.4,
  reshapeFloor: 0.55,
  actLead: 0.15,
  /** The main window or the partner must be at least this likely to be the one, or the move needing it is not made. */
  pickFloor: 0.4,
} as const;

/** The move the shell makes for an evaluation, or for none. */
export function decideDeskLayout(request: DeskLayoutRequest, evaluation: DeskLayoutEvaluation | null): DeskLayoutDecision {
  const asked = request.trigger === "asked";
  if (evaluation === null) {
    // Asked, with no opinion to go on: the plain arrangement. Otherwise nothing moves.
    return { move: asked && request.moves.includes("tile") ? "tile" : "keep", main: null, partner: null, basis: "unavailable" };
  }
  const limits = DESK_LAYOUT_LIMITS;
  const offered = request.moves.filter((move) => !(asked && move === "keep"));
  let move: DeskLayoutMove = offered.reduce<DeskLayoutMove>((best, next) => (evaluation.moves[next] > evaluation.moves[best] ? next : best), offered[0] ?? "keep");
  const main = top(evaluation.main, limits.pickFloor);
  const partner = evaluation.partner === null ? null : top(evaluation.partner, limits.pickFloor);
  const floor = move === "tile" || move === "focus" ? limits.reshapeFloor : limits.actFloor;
  if (!asked && (move === "keep" || evaluation.moves[move] < floor || evaluation.moves[move] - evaluation.moves.keep < limits.actLead)) move = "keep";
  // A move that needs a window the model could not name is not made: asked, the plain arrangement instead.
  if (move === "focus" && main === null) move = asked && offered.includes("tile") ? "tile" : "keep";
  if (move === "pair" && (partner === null || partner === NO_PARTNER)) move = "keep";
  return { move, main, partner: move === "pair" ? partner : null, basis: "model" };
}

/** The likeliest key, if it is at least `floor` likely. */
function top(spread: Record<string, number>, floor: number): string | null {
  let best: string | null = null;
  for (const [key, value] of Object.entries(spread)) if (best === null || value > spread[best]!) best = key;
  return best !== null && spread[best]! >= floor ? best : null;
}

/**
 * Bounded and well-formed, whatever came in (it crosses from the renderer),
 * or null when there is nothing worth asking: no window to lay out, a
 * window count past the limit, a move list with nothing but keep.
 */
export function sanitizeDeskLayoutRequest(value: unknown): DeskLayoutRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const trigger = raw["trigger"];
  if (typeof trigger !== "string" || !(DESK_LAYOUT_TRIGGERS as readonly string[]).includes(trigger)) return null;
  const limits = DESK_LAYOUT_LIMITS;
  if (!Array.isArray(raw["windows"]) || raw["windows"].length === 0 || raw["windows"].length > limits.windows) return null;
  const windows: DeskLayoutWindow[] = [];
  const ids = new Set<string>();
  for (const entry of raw["windows"] as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const window = entry as Record<string, unknown>;
    const id = window["id"];
    if (typeof id !== "string" || id === "" || id.length > 192 || ids.has(id)) return null;
    ids.add(id);
    windows.push({
      id,
      title: text(window["title"], limits.titleChars),
      site: text(window["site"], limits.siteChars),
      kind: window["kind"] === "document" ? "document" : "page",
      place: text(window["place"], limits.placeChars),
      inUse: window["inUse"] === true,
      opened: window["opened"] === true && trigger === "opened",
    });
  }
  if (trigger === "opened" && windows.filter((window) => window.opened).length !== 1) return null;
  const gone: DeskLayoutGone[] = (Array.isArray(raw["gone"]) ? (raw["gone"] as unknown[]) : [])
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .slice(0, limits.gone)
    .map((entry) => ({
      title: text(entry["title"], limits.titleChars),
      site: text(entry["site"], limits.siteChars),
      place: text(entry["place"], limits.placeChars),
      how: entry["how"] === "collapsed" ? "collapsed" : "closed",
    }));
  if (trigger === "closed" && gone.length === 0) return null;
  const moves = DESK_LAYOUT_MOVES.filter(
    (move) =>
      Array.isArray(raw["moves"]) &&
      (raw["moves"] as unknown[]).includes(move) &&
      // Each move only where it means something: keep unless asked, fill after a close, pair after an open (with another window to pair with).
      (move !== "keep" || trigger !== "asked") &&
      (move !== "fill" || trigger === "closed") &&
      (move !== "pair" || (trigger === "opened" && windows.length > 1)),
  );
  if (moves.filter((move) => move !== "keep").length === 0) return null;
  const fillers = moves.includes("fill") && Array.isArray(raw["fillers"]) ? (raw["fillers"] as unknown[]).slice(0, limits.windows).map((title) => text(title, limits.titleChars)) : [];
  return { trigger: trigger as DeskLayoutTrigger, windows, gone, moves, fillers };
}

function text(value: unknown, max: number): string {
  const trimmed = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
