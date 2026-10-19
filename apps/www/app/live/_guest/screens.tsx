/**
 * The guest page's frame and its quiet screens (docs/live-share.md §1 The
 * guest): the ground every screen stands on, the mark, the little desk that
 * says what the link leads to, the loading screen, and every way out —
 * ended, never live, turned away, removed, left, lost.
 */

import type { CSSProperties, ReactNode } from "react";
import { HOST_COLOR } from "@pistachio/live-share";
import type { GuestOverReason, LiveJoinInfo } from "@pistachio/live-share/react";

export function GuestShell({ screen, children }: { screen: string; children: ReactNode }) {
  return (
    <div className="lvg-root lv-theme" data-testid="live-guest" data-screen={screen}>
      {children}
    </div>
  );
}

export function BrandMark() {
  return (
    <div className="lvg-brand" aria-label="Pistachio">
      <svg viewBox="0 0 64 64" width="18" height="18" aria-hidden="true">
        <rect width="64" height="64" rx="18" fill="#52a862" />
        <path
          d="M115.10 51.50A13.5 13.5 0 0 1 115.10 65.00L93.40 102.60A13.5 13.5 0 0 1 81.71 109.35L38.29 109.35A13.5 13.5 0 0 1 26.60 102.60L4.90 65.00A13.5 13.5 0 0 1 4.90 51.50L27.47 12.40A3.5 3.5 0 0 1 33.53 12.40L56.54 52.25A4 4 0 0 0 63.46 52.25L86.47 12.40A3.5 3.5 0 0 1 92.53 12.40Z"
          transform="translate(12.8 12.8) scale(0.32)"
          fill="white"
        />
      </svg>
      <span>Pistachio</span>
    </div>
  );
}

const ARROW_PATH = "M0.6 0.6 L0.6 16.9 L4.6 13.2 L7.4 19.6 L10.4 18.3 L7.7 12.0 L13.2 12.0 Z";

/**
 * The desk in miniature: a well with three windows on it and the host's
 * pointer moving between them. In the lobby the pointer works; while the
 * guest knocks, their own dot waits at the edge; when it is over, the desk
 * goes still and dim.
 */
export function DeskGlyph({ state, host, guestInitial, guestColor }: { state: "lobby" | "waiting" | "over"; host: string; guestInitial?: string; guestColor?: string }) {
  return (
    <div className="lvg-glyph" data-state={state} aria-hidden="true">
      <div className="lvg-glyph-well">
        <div className="lvg-glyph-window" data-n="1">
          <i />
          <i />
          <i />
        </div>
        <div className="lvg-glyph-window" data-n="2">
          <i />
          <i />
        </div>
        <div className="lvg-glyph-window" data-n="3">
          <i />
          <i />
          <i />
          <i />
        </div>
        {state === "over" ? null : (
          <div className="lvg-glyph-cursor" style={{ "--lv-cursor-color": HOST_COLOR } as CSSProperties}>
            <svg width="16" height="18" viewBox="-1.5 -1.5 16 21">
              <path d={ARROW_PATH} fill="currentColor" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" paintOrder="stroke" />
            </svg>
            <span>{host}</span>
          </div>
        )}
        {state === "waiting" ? (
          <div className="lvg-glyph-guest" style={{ "--lvg-guest": guestColor ?? "var(--lv-text-3)" } as CSSProperties}>
            <span>{guestInitial ?? ""}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function LoadingScreen({ text = "Opening the share…" }: { text?: string }) {
  return (
    <GuestShell screen="loading">
      <div className="lvg-center">
        <div className="lvg-loading">
          <DeskGlyph state="over" host="" />
          <p className="lvg-loading-text">{text}</p>
        </div>
      </div>
    </GuestShell>
  );
}

interface OverCopy {
  title: ReactNode;
  body: ReactNode;
  action: string | null;
}

function overCopy(reason: GuestOverReason, share: LiveJoinInfo | null): OverCopy {
  const host = share?.hostName ?? "The host";
  const space = share === null ? "the share" : <em>{share.title}</em>;
  switch (reason) {
    case "ended":
      return { title: "This share has ended", body: <>{host} stopped sharing {space}. Ask them for a new link to join again.</>, action: null };
    case "not_found":
      return { title: "This link isn’t live", body: "The share may have ended, or the link may be incomplete. Check it with the person who sent it.", action: null };
    case "denied":
      return { title: `${share?.hostName ?? "The host"} didn’t let you in`, body: <>You can ask to join {space} again.</>, action: "Ask again" };
    case "removed":
      return { title: "You were removed from the share", body: <>{host} took you out of {space}.</>, action: null };
    case "left":
      return { title: "You left the share", body: <>{space} is still live. You can join again while it is.</>, action: "Rejoin" };
    case "replaced":
      return { title: "You joined from somewhere else", body: "This share is open in another tab or window. Only one can be in the room at a time.", action: "Use this tab" };
    case "lost":
      return { title: "Lost the connection", body: <>Pistachio couldn’t keep you in {space}. Check your connection and try again.</>, action: "Try again" };
    case "unavailable":
      return { title: "Live share isn’t available", body: "Pistachio couldn’t reach the share just now. Try again in a moment.", action: "Try again" };
    case "full":
      return { title: "This share is full", body: <>{space} has as many guests as it can take. Try again in a little while.</>, action: "Try again" };
  }
}

export function OverScreen({ reason, share, onAction }: { reason: GuestOverReason; share: LiveJoinInfo | null; onAction(): void }) {
  const copy = overCopy(reason, share);
  return (
    <GuestShell screen={reason === "ended" ? "ended" : reason === "denied" || reason === "removed" || reason === "left" ? reason : "error"}>
      <header className="lvg-topbar">
        <BrandMark />
      </header>
      <main className="lvg-center">
        <section className="lvg-over" data-reason={reason}>
          <DeskGlyph state="over" host="" />
          <h1 className="lvg-over-title">{copy.title}</h1>
          <p className="lvg-over-body">{copy.body}</p>
          {copy.action === null ? null : (
            <button type="button" className="lvg-button" data-variant="secondary" onClick={onAction}>
              {copy.action}
            </button>
          )}
        </section>
      </main>
    </GuestShell>
  );
}
