/**
 * What of a desk frame a page renders with React, and what changed between
 * two frames that is worth telling a person (docs/live-share.md §1, §7, §9).
 *
 * Frames arrive up to 30 times a second while the host drags a window, and
 * their geometry is applied by ref. Everything else — which windows there
 * are, their titles, which one is in use, which a guest may use — changes
 * rarely; `windowFacts` is that part alone, and `sameFacts` says whether a
 * render is due. `deskNotices` compares what guests may do before and after
 * a frame, for the banners: the host gave a window over or took it back,
 * came back to the space, turned drawing off or on.
 */

import type { LiveDeskFrame, LiveWindow } from "../protocol.js";

/** A window without its geometry. */
export type LiveWindowFacts = Omit<LiveWindow, "frame" | "page">;

export interface LiveDeskFacts {
  hostPresent: boolean;
  guestsCanDraw: boolean;
  space: LiveDeskFrame["space"];
  /** Bottom to top. */
  windows: LiveWindowFacts[];
}

export function deskFacts(frame: LiveDeskFrame): LiveDeskFacts {
  return {
    hostPresent: frame.hostPresent,
    guestsCanDraw: frame.guestsCanDraw ?? true,
    space: frame.space,
    windows: frame.windows.map((window) => ({
      id: window.id,
      kind: window.kind,
      title: window.title,
      origin: window.origin,
      favicon: window.favicon,
      focused: window.focused,
      minimized: window.minimized,
      controllable: window.controllable,
      // (Only where it is one: a frame without it said nothing, and a page's facts stay as they were.)
      ...(window.terminal === true ? { terminal: true } : {}),
      track: window.track,
      paused: window.paused,
    })),
  };
}

const WINDOW_KEYS = ["id", "kind", "title", "origin", "favicon", "focused", "minimized", "controllable", "terminal", "track", "paused"] as const;

export function sameFacts(a: LiveDeskFacts | null, b: LiveDeskFacts | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.hostPresent !== b.hostPresent || a.guestsCanDraw !== b.guestsCanDraw) return false;
  if (a.space.title !== b.space.title || a.space.color !== b.space.color) return false;
  if (a.windows.length !== b.windows.length) return false;
  return a.windows.every((window, index) => {
    const other = b.windows[index];
    return other !== undefined && WINDOW_KEYS.every((key) => window[key] === other[key]);
  });
}

export type LiveDeskNotice =
  | { kind: "back" }
  | { kind: "granted"; windowId: string; title: string }
  | { kind: "revoked"; windowId: string; title: string }
  | { kind: "drawing"; allowed: boolean };

/** What guests may do as of a frame, carried from one frame to the next. */
export interface LiveDeskAllowance {
  hostPresent: boolean;
  guestsCanDraw: boolean;
  /**
   * The windows the host lets guests use. A frame says none are while the
   * host is away (`controllable` includes "the host is present"), so this is
   * kept from the last frame with the host there: coming back is not news
   * about every window.
   */
  usable: ReadonlySet<string>;
}

/**
 * The allowance after `frame`, and what changed since `previous` (null for
 * the first frame, which says nothing: the room simply shows as it is).
 */
export function deskNotices(previous: LiveDeskAllowance | null, frame: LiveDeskFrame): { allowance: LiveDeskAllowance; notices: LiveDeskNotice[] } {
  const guestsCanDraw = frame.guestsCanDraw ?? true;
  const usable = frame.hostPresent ? new Set(frame.windows.filter((window) => window.controllable).map((window) => window.id)) : (previous?.usable ?? new Set<string>());
  const allowance: LiveDeskAllowance = { hostPresent: frame.hostPresent, guestsCanDraw, usable };
  if (previous === null) return { allowance, notices: [] };

  const notices: LiveDeskNotice[] = [];
  if (frame.hostPresent && !previous.hostPresent) notices.push({ kind: "back" });
  if (frame.hostPresent) {
    const titles = new Map(frame.windows.map((window) => [window.id, window.title]));
    for (const id of usable) {
      if (!previous.usable.has(id)) notices.push({ kind: "granted", windowId: id, title: titles.get(id) ?? "" });
    }
    // A window that closed was not taken back; it is simply gone.
    for (const id of previous.usable) {
      const title = titles.get(id);
      if (!usable.has(id) && title !== undefined) notices.push({ kind: "revoked", windowId: id, title });
    }
  }
  if (guestsCanDraw !== previous.guestsCanDraw) notices.push({ kind: "drawing", allowed: guestsCanDraw });
  return { allowance, notices };
}
