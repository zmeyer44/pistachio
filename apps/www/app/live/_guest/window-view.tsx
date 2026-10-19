/**
 * One of the host's windows on the guest's desk (docs/live-share.md §1 In the
 * room, §7): a rounded card at the window's place with its page live inside,
 * and a slim tab above it — the site's icon, the title, the site — that
 * reads brighter on the window in use on the host. The stage controller
 * places it; this renders what it is.
 *
 * A window the host lets guests use takes the guest's pointer and, once
 * pressed, their keyboard (a ring in the guest's colour says so); any other
 * page offers *Ask to use* on its tab. A window the shell draws on the Mac
 * (home, notes, a terminal) streams like a page — the host cuts its picture
 * out of the shell's — and is only watched; without a picture (a host that
 * does not cut one) it shows its frame and "Only on Zach's screen"; a page
 * past the eight that stream, "Not streamed". A picture held says "Paused".
 * Double-clicking the tab brings the window up to fill the view.
 */

import { Hand, Maximize2, Minimize2, MonitorOff, Pause } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { LiveInputEvent } from "@pistachio/live-share";
import { attachWindowInput, type LiveWindowFacts } from "@pistachio/live-share/react";
import type { LiveRoom } from "@pistachio/live-share/room";
import type { StageController } from "./stage-controller";

export interface WindowUser {
  name: string;
  color: string;
  isMe: boolean;
}

export interface WindowViewProps {
  window: LiveWindowFacts;
  /** Its place in the stack, bottom first. */
  order: number;
  room: LiveRoom;
  controller: StageController;
  hostName: string;
  hostPresent: boolean;
  /** Who is using it now, per the host's last grant. */
  user: WindowUser | null;
  myColor: string;
  filled: boolean;
  /** Input may go to this window now (the latest frame allows it, the pointer tool is in hand). */
  usable(windowId: string): boolean;
  onFill(windowId: string | null): void;
  onAsk(windowId: string, title: string): void;
  asked: boolean;
}

function Favicon({ src, title }: { src: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  if (src === null || failed) {
    const letter = [...title.trim()][0]?.toLocaleUpperCase() ?? "";
    return <span className="lvg-favicon" data-letter="">{letter}</span>;
  }
  return <img className="lvg-favicon" src={src} alt="" referrerPolicy="no-referrer" draggable={false} onError={() => setFailed(true)} />;
}

export function WindowView({ window, order, room, controller, hostName, hostPresent, user, myColor, filled, usable, onFill, onAsk, asked }: WindowViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [painted, setPainted] = useState(false);
  const usableRef = useRef(usable);
  useLayoutEffect(() => {
    usableRef.current = usable;
  });

  const id = window.id;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const page = pageRef.current;
    if (root === null || page === null) return;
    return controller.register(id, { root, page });
  }, [controller, id]);

  // The window's picture, whenever its track is there.
  const streamed = window.track !== null;
  useEffect(() => {
    const video = videoRef.current;
    if (video === null || !streamed) return;
    setPainted(false);
    const shown = (): void => setPainted(true);
    video.addEventListener("loadeddata", shown);
    const detach = room.attachWindow(id, video);
    return () => {
      video.removeEventListener("loadeddata", shown);
      detach();
    };
  }, [room, id, streamed]);

  // The guest's hands on it.
  useEffect(() => {
    const page = pageRef.current;
    const keys = keysRef.current;
    if (page === null || keys === null || window.kind !== "page") return;
    return attachWindowInput({
      page,
      keys,
      usable: () => usableRef.current(id),
      send: (event: LiveInputEvent) => {
        // To the host alone, as the room sends every lv.input: no other guest reads these keys (§4).
        room.send("lv.input", { w: id, e: event }).catch(() => undefined);
      },
      onKeyboard: setKeyboard,
      // The host lists the guests to each of them as its own room comes back, and to a guest back from a drop of
      // theirs as it says hello: whichever side dropped, the host hears this guest again then (§7). (It lists them on
      // a change of who is in too; the releases sent again then are of nothing main holds, and it ignores them.)
      onReconnected: (listener) => room.onMessage("lv.guests", listener),
    });
  }, [room, id, window.kind]);

  const canUse = window.controllable && hostPresent;
  const canAsk = window.kind === "page" && !window.controllable && hostPresent && streamed;
  const usedBy = user !== null && !user.isMe ? user : null;
  const ringColor = usedBy?.color ?? myColor;

  return (
    <div
      ref={rootRef}
      className="lvg-window"
      style={{ zIndex: order + 1, "--lvg-ring": ringColor } as CSSProperties}
      data-window={id}
      data-kind={window.kind}
      data-focused={window.focused ? "" : undefined}
      data-usable={canUse ? "" : undefined}
      data-keyboard={keyboard && canUse ? "" : undefined}
      data-painted={painted ? "" : undefined}
      data-paused={window.paused ? "" : undefined}
    >
      <div
        className="lvg-window-tab"
        title={window.origin === null ? window.title : `${window.title} — ${window.origin}`}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onFill(filled ? null : id);
        }}
      >
        <Favicon src={window.favicon} title={window.title || window.origin || "?"} />
        <span className="lvg-window-title">{window.title || window.origin || "Untitled"}</span>
        {window.origin !== null && window.origin !== window.title ? <span className="lvg-window-origin">{window.origin}</span> : null}
        {window.focused ? <span className="lvg-window-inuse" title={`In use on ${hostName}’s Mac`} aria-label={`In use on ${hostName}’s Mac`} /> : null}
        {usedBy !== null ? (
          <span className="lvg-window-user" style={{ "--lvg-user": usedBy.color } as CSSProperties}>
            {usedBy.name}
          </span>
        ) : canUse ? (
          <span className="lvg-window-use" title={`${hostName} lets guests use this window`}>
            <Hand aria-hidden="true" />
          </span>
        ) : null}
        <span className="lvg-window-actions">
          {canAsk ? (
            <button
              type="button"
              className="lvg-window-ask"
              disabled={asked}
              onClick={(event) => {
                event.stopPropagation();
                onAsk(id, window.title);
              }}
            >
              {asked ? "Asked" : "Ask to use"}
            </button>
          ) : null}
          <button
            type="button"
            className="lvg-window-fill"
            aria-label={filled ? "Back to the desk" : "Fill the view"}
            title={filled ? "Back to the desk (Esc)" : "Fill the view"}
            onClick={(event) => {
              event.stopPropagation();
              onFill(filled ? null : id);
            }}
          >
            {filled ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          </button>
        </span>
      </div>
      <div className="lvg-window-card">
        <div ref={pageRef} className="lvg-window-page" data-page="">
          {!streamed ? (
            <div className="lvg-window-note">
              <MonitorOff aria-hidden="true" />
              <span>{window.kind === "shell" ? `Only on ${hostName}’s screen` : "Not streamed"}</span>
            </div>
          ) : painted ? null : (
            <div className="lvg-window-loading" aria-hidden="true" />
          )}
          {streamed ? <video ref={videoRef} className="lvg-window-video" muted playsInline autoPlay disablePictureInPicture /> : null}
          {window.paused && streamed ? (
            <span className="lvg-window-paused">
              <Pause aria-hidden="true" /> Paused
            </span>
          ) : null}
          <textarea
            ref={keysRef}
            className="lvg-window-keys"
            aria-label={`Type into ${window.title || "the window"}`}
            tabIndex={-1}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </div>
      </div>
    </div>
  );
}
