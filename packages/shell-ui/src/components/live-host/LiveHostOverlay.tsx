/**
 * What the live-host window draws over the browser's (docs/live-share.md
 * §1 "On the desk while live", §6.3): over the shared stage, the guests'
 * pointers, everyone's ink, pings and the outlines of the windows guests may
 * use — all of it the shared desk's, so none of it shows while the host is
 * away — and, wherever the host is, the faces and the Live pill. The
 * outlines are a window's own, and go under the browser's own surfaces over
 * the desk (a toast, a side card, a menu: WindowMarks); the rest is drawn
 * over everything.
 *
 * The window lets the pointer through to the browser's except where this
 * says it is on something of its own: forwarded moves tell it when the
 * pointer comes onto a face or the pill (anything marked
 * `data-live-interactive`) and leaves it, and main makes the window take the
 * pointer in between. While the host draws, main gives it the whole window
 * and the keyboard: the pen draws over the stage, ⌥-click pings, Escape
 * gives the desk back.
 *
 * Per-frame work stays out of React (§9): the layers draw from the session's
 * feeds in their own frame loops, the outlines follow desk frames by ref;
 * React renders a join, a speaker's turn, a resize, the host coming and going.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CursorLayer, InkLayer, PingLayer, ReactionLayer, createStageBox, type CursorPerson } from "@pistachio/live-share/react";
import type { LiveInkOp } from "@pistachio/live-share";
import type { LiveRect } from "@pistachio/shell-contracts/live-share";
import type { LiveHostSession } from "./host-session";
import { HostFaces } from "./HostFaces";
import { LivePill } from "./LivePill";
import { WindowMarks } from "./WindowMarks";
import { WindowOutlines } from "./WindowOutlines";

/** The pill hangs this far below the stage's top edge. */
const PILL_TOP = 10;

export function LiveHostOverlay({ session }: { session: LiveHostSession }) {
  const view = useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.view(),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const { stage, state, participants, connection, present, volumes } = view;
  const muted = useMemo(() => new Set([...volumes].flatMap(([identity, volume]) => (volume === 0 ? [identity] : []))), [volumes]);
  // Shared from another space, the host has not been on the stage yet: the faces and the pill go by the window.
  const whole = useWindowBox();
  const anchor = view.anchor ?? whole;
  const drawing = state.drawing;
  // The ink draws inside the stage's own box, so the pen draws there and nowhere else.
  const inkBox = useMemo(() => createStageBox(), []);
  const stageSize = useMemo(() => (stage === null ? null : { w: stage.w, h: stage.h }), [stage]);
  useEffect(() => {
    if (stageSize !== null) inkBox.set({ x: 0, y: 0, w: stageSize.w, h: stageSize.h });
  }, [inkBox, stageSize]);

  const people = useMemo(() => new Map<string, CursorPerson>(participants.map((participant) => [participant.identity, { name: participant.name, color: participant.color }])), [participants]);
  const guests = participants.filter((participant) => participant.role === "guest").length;

  // The pointer on something of the app's: the window takes it until the pointer leaves (or a drag ends).
  useEffect(() => {
    let active = false;
    const set = (next: boolean): void => {
      if (next === active) return;
      active = next;
      session.report({ type: "interactive", active: next });
    };
    const moved = (event: MouseEvent): void => {
      if (dragging.current) return;
      set(event.target instanceof Element && event.target.closest("[data-live-interactive]") !== null);
    };
    const left = (): void => {
      if (!dragging.current) set(false);
    };
    document.addEventListener("mousemove", moved);
    document.documentElement.addEventListener("mouseleave", left);
    return () => {
      document.removeEventListener("mousemove", moved);
      document.documentElement.removeEventListener("mouseleave", left);
      set(false);
    };
  }, [session]);

  // The ink in the strokes count, for whoever looks at the window from outside (the specs).
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const count = (): void => {
      root.dataset["strokes"] = String(session.ink.board.size);
    };
    count();
    return session.ink.subscribe(count);
  }, [session]);

  // Drawing: Escape gives the desk back; ⌥-click pings instead of drawing.
  const isDrawing = drawing !== null && present;
  useEffect(() => {
    const container = stageRef.current;
    if (!isDrawing || container === null) return;
    const key = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      session.report({ type: "drawEnded" });
    };
    const press = (event: PointerEvent): void => {
      if (!event.altKey || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const box = container.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      session.ping((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
    };
    window.addEventListener("keydown", key);
    container.addEventListener("pointerdown", press, { capture: true });
    return () => {
      window.removeEventListener("keydown", key);
      container.removeEventListener("pointerdown", press, { capture: true });
    };
  }, [session, isDrawing]);

  // Gone from the shared space mid-drawing: the pen is put down, so the window lets the pointer through again.
  useEffect(() => {
    if (drawing !== null && !present) session.report({ type: "drawEnded" });
  }, [session, drawing, present]);

  const onOp = useCallback((op: LiveInkOp) => session.drawInk(op), [session]);
  const pillAt = { x: anchor.x + anchor.w / 2, y: anchor.y + PILL_TOP };
  const stageAt = stage === null ? undefined : { transform: `translate(${stage.x.toFixed(1)}px, ${stage.y.toFixed(1)}px)`, width: stage.w, height: stage.h };

  return (
    <div
      ref={rootRef}
      className="live-host lv-theme"
      data-testid="live-host"
      data-connection={connection}
      data-present={present ? "" : undefined}
      data-drawing={isDrawing ? drawing.tool : undefined}
      data-guests={guests}
    >
      {/* The shared desk's own: the pointers and pings over the whole window, the rest inside the stage — the windows'
          outlines in a layer of their own, under the browser's surfaces. */}
      <div className="live-host-desk" data-away={present ? undefined : ""}>
        {stage === null || stageSize === null ? null : (
          <>
            <WindowMarks session={session}>
              <div className="live-host-stage" style={stageAt}>
                <WindowOutlines session={session} size={stageSize} using={state.using} people={people} />
              </div>
            </WindowMarks>
            <div ref={stageRef} className="live-host-stage" style={stageAt}>
              <InkLayer store={session.ink} box={inkBox} identity="host" pen={isDrawing ? { tool: drawing.tool, color: drawing.color } : null} onOp={onOp} />
            </div>
          </>
        )}
        <CursorLayer feed={session.cursors} people={people} box={session.stageBox} />
        <PingLayer feed={session.pings} box={session.stageBox} />
      </div>
      <ReactionLayer
        feed={session.reactions}
        originOf={(identity) => {
          const face = rootRef.current?.querySelector(`[data-face="${CSS.escape(identity)}"]`);
          if (face === null || face === undefined) return null;
          const box = face.getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        }}
        fallback={() => pillAt}
      />
      <HostFaces
        participants={participants}
        stage={anchor}
        muted={muted}
        onMute={(identity, mute) => session.setGuestVolume(identity, mute ? 0 : 1)}
        onRemove={(identity) => session.report({ type: "command", command: { type: "remove", identity } })}
        onDragging={(next) => {
          dragging.current = next;
        }}
      />
      <LivePill
        guests={guests}
        connection={connection}
        at={pillAt}
        onOpen={() => session.report({ type: "openCard" })}
        onStop={() => session.report({ type: "command", command: { type: "stop" } })}
      />
      {isDrawing ? (
        <div className="live-host-draw-hint" style={{ transform: `translate(${pillAt.x.toFixed(1)}px, ${(pillAt.y + 44).toFixed(1)}px) translateX(-50%)` }}>
          Drawing · <kbd>Esc</kbd> to stop
        </div>
      ) : null}
    </div>
  );
}

/** The window's own box (CSS px), kept as it resizes. */
function useWindowBox(): LiveRect {
  const [box, setBox] = useState<LiveRect>(() => ({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const resized = (): void => setBox({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, []);
  return box;
}
