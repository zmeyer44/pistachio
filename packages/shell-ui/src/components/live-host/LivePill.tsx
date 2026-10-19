/**
 * The Live pill (docs/live-share.md §1): at the top centre of the shared
 * desk, the dot, "Live", how many guests are in, and a stop button. Pressing
 * the pill opens the Live card; it stays while the host is away, since the
 * call goes on. Its dot rings a few times as the room goes live and as
 * someone comes or goes, then is still: the window lies over the whole
 * browser's, and an animation that never ends would have it composite every
 * frame for the whole share (§9).
 */

import { Square, Users } from "lucide-react";
import type { LiveConnectionState } from "@pistachio/live-share/room";

export interface LivePillProps {
  guests: number;
  connection: LiveConnectionState;
  /** Where it hangs: the top centre of the stage (window px). */
  at: { x: number; y: number };
  onOpen(): void;
  onStop(): void;
}

function caption(connection: LiveConnectionState): string {
  switch (connection) {
    case "connected":
      return "Live";
    case "connecting":
      return "Going live…";
    case "reconnecting":
      return "Reconnecting…";
    case "disconnected":
      return "Offline";
  }
}

export function LivePill({ guests, connection, at, onOpen, onStop }: LivePillProps) {
  const people = guests === 1 ? "1 guest" : `${String(guests)} guests`;
  return (
    <div className="live-host-pill" data-live-interactive="" data-connection={connection} data-testid="live-host-pill" style={{ transform: `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px) translateX(-50%)` }}>
      <button type="button" className="live-host-pill-open" onClick={onOpen} title="Open the Live card" aria-label={`${caption(connection)}, ${people}. Open the Live card`}>
        {/* (A new key is a new dot, whose rings start again.) */}
        <span key={`${connection}:${String(guests)}`} className="live-host-pill-dot" aria-hidden="true" />
        <span className="live-host-pill-label">{caption(connection)}</span>
        <span className="live-host-pill-count" aria-hidden="true">
          <Users />
          {guests}
        </span>
      </button>
      <button type="button" className="live-host-pill-stop" onClick={onStop} title="Stop sharing" aria-label="Stop sharing">
        <Square />
      </button>
    </div>
  );
}
