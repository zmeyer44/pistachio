/**
 * The live share's host app (docs/live-share.md §6.3), in the transparent
 * window main lays over the browser's (main/live/live-host-window.ts, the
 * "live-host" hash): the one renderer that holds the room. The window lives
 * as long as one share, so the app starts once (`startHost`) — not once per
 * React mount — and ends when main says the share is over; then the window
 * goes. The session (components/live-host/host-session.ts) is the room and
 * the relays; the overlay draws what lies over the desk.
 */

import { useEffect, useState } from "react";
import "@pistachio/live-share/styles.css";
import "./components/live-host/live-host.css";
import { nativeApi } from "./api";
import { LiveHostSession } from "./components/live-host/host-session";
import { LiveHostOverlay } from "./components/live-host/LiveHostOverlay";

let boot: Promise<LiveHostSession | null> | null = null;

/**
 * Join the share main holds. Subscribed before the config is asked for, on
 * the one channel main answers on: whatever main sent before its answer is
 * older than the answer, so it is passed over, and everything after reaches
 * the session in order. Body `data-live-host` says how it went (for the specs).
 */
function startHost(): Promise<LiveHostSession | null> {
  const api = nativeApi();
  if (api === null) return Promise.resolve(null);
  let session: LiveHostSession | null = null;
  let over = false;
  // For the window's life: it closes with the share.
  api.onLiveHostEvent((event) => {
    if (event.type === "end") {
      over = true;
      document.body.dataset["liveHost"] = "ended";
    }
    session?.handle(event);
  });
  return api.liveHostConfig().then(
    (config) => {
      if (config === null || over) {
        document.body.dataset["liveHost"] = "ended";
        return null;
      }
      session = new LiveHostSession(config, api);
      session.start();
      document.body.dataset["liveHost"] = "ready";
      return session;
    },
    (error: unknown) => {
      console.error("[live-host] the share's config did not come", error);
      document.body.dataset["liveHost"] = "ended";
      return null;
    },
  );
}

export function LiveHostApp() {
  const [session, setSession] = useState<LiveHostSession | null>(null);

  useEffect(() => {
    let mounted = true;
    boot ??= startHost();
    void boot.then((started) => {
      if (mounted) setSession(started);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return session === null ? null : <LiveHostOverlay session={session} />;
}
