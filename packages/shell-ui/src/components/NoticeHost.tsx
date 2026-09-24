import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";
import {
  EMPTY_NOTICE_STACK,
  NOTICE_ACTION_MS,
  NOTICE_MS,
  NOTICE_RESUME_MS,
  type NoticeEvent,
  type NoticeFrame,
} from "@pistachio/shell-contracts/notice";
import { nativeApi } from "../api";
import { noticeItem, type ShellNotice } from "../lib/notices";
import { useAppStore } from "../store";
import { useSurface } from "../surface";
import { NoticeStack } from "./NoticeStack";

/**
 * The shell's end of the notice stack (@pistachio/shell-contracts/notice).
 * It keeps each notice's clock — stopped while the pointer is on the stack —
 * and gets the notices drawn: handed to main for the native notice view on
 * the desktop, where a card in this page would sit under the tab views, and
 * drawn right here on a stream surface, where the panes are DOM.
 *
 * It renders nothing into the chrome, so no layout, and no state of the
 * sidebar, decides whether a notice is seen.
 */
export function NoticeHost() {
  const notices = useAppStore((state) => state.notices);
  const dismissNotice = useAppStore((state) => state.dismissNotice);
  const runNoticeAction = useAppStore((state) => state.runNoticeAction);
  const position = useAppStore((state) => state.settings.appearance.toastPosition);
  const surface = useSurface();
  const [hovering, setHovering] = useState(false);
  const items = useMemo(() => notices.map(noticeItem), [notices]);

  const onEvent = useCallback(
    (event: NoticeEvent) => {
      if (event.type === "hover") setHovering(event.hovering);
      else if (event.type === "dismiss") dismissNotice(event.id);
      else runNoticeAction(event.id);
    },
    [dismissNotice, runNoticeAction],
  );

  useNoticeClocks(notices, hovering, dismissNotice);
  // Nothing left to hover: a view that was taken down never says "left".
  useEffect(() => {
    if (notices.length === 0) setHovering(false);
  }, [notices.length]);

  // Both surfaces stand the stack in the browser surface — the page, not
  // the window — so its box is measured here, and again whenever it moves
  // while something is up. The desktop hands it to main with the notices,
  // for the native view; a stream surface lays its own layer over it.
  const native = surface.kind === "native" ? nativeApi() : null;
  const [box, setBox] = useState<ContentBounds | null>(null);
  const showing = items.length > 0;
  useEffect(() => {
    const surfaceElement = document.querySelector<HTMLElement>(".browser-surface");
    const measure = () => {
      const rect = surfaceElement?.getBoundingClientRect() ?? null;
      const next = rect === null || rect.width < 1 || rect.height < 1 ? null : { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      setBox((current) =>
        current !== null && next !== null && current.x === next.x && current.y === next.y && current.width === next.width && current.height === next.height
          ? current
          : next,
      );
    };
    measure();
    if (!showing || surfaceElement === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(surfaceElement);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [showing, position]);

  useEffect(() => {
    if (native === null) return;
    const frame: NoticeFrame = { items, position, anchor: box };
    native.setNotices(frame);
  }, [native, items, position, box]);
  useEffect(() => {
    if (native === null) return;
    const off = native.onNoticeEvent(onEvent);
    return () => {
      off();
      native.setNotices({ ...EMPTY_NOTICE_STACK, anchor: null });
    };
  }, [native, onEvent]);

  if (native !== null) return null;
  return (
    <div
      className="notice-layer"
      data-surface="stream"
      style={box === null ? undefined : { left: box.x, top: box.y, width: box.width, height: box.height, right: "auto", bottom: "auto" }}
    >
      <NoticeStack items={items} position={position} onEvent={onEvent} />
    </div>
  );
}

/**
 * Each notice leaves when its time is up. The clock runs from when it was
 * said — or said again — and stands still while the pointer is on the
 * stack; when the pointer leaves, every card is owed what it had left, and
 * never less than a moment to be read.
 */
function useNoticeClocks(notices: readonly ShellNotice[], paused: boolean, dismiss: (id: number) => void): void {
  const deadlines = useRef(new Map<number, { at: number; bumps: number }>());
  const pausedAt = useRef<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const now = Date.now();
    const clocks = deadlines.current;
    const live = new Set(notices.map((notice) => notice.id));
    for (const id of clocks.keys()) if (!live.has(id)) clocks.delete(id);
    for (const notice of notices) {
      const clock = clocks.get(notice.id);
      if (clock === undefined || clock.bumps !== notice.bumps)
        clocks.set(notice.id, { at: now + (notice.action === null ? NOTICE_MS : NOTICE_ACTION_MS), bumps: notice.bumps });
    }
    if (paused) {
      pausedAt.current ??= now;
      return;
    }
    if (pausedAt.current !== null) {
      const stood = now - pausedAt.current;
      pausedAt.current = null;
      for (const clock of clocks.values()) clock.at = Math.max(clock.at + stood, now + NOTICE_RESUME_MS);
    }
    let soonest = Infinity;
    for (const clock of clocks.values()) soonest = Math.min(soonest, clock.at);
    if (soonest === Infinity) return;
    const timer = window.setTimeout(() => {
      const due = Date.now();
      let dismissed = false;
      for (const [id, clock] of clocks) {
        if (clock.at > due) continue;
        dismissed = true;
        dismiss(id);
      }
      // An early timer changes nothing the effect depends on: run it again.
      if (!dismissed) setTick((value) => value + 1);
    }, Math.max(0, soonest - now));
    return () => window.clearTimeout(timer);
  }, [notices, paused, dismiss, tick]);
}
