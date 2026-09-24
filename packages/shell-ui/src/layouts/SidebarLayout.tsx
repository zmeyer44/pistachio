import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import {
  pointerHoldsSidebar,
  SIDEBAR_DEFAULT_W,
  SIDEBAR_EDGE_W,
  SIDEBAR_MAX_W,
  SIDEBAR_MIN_W,
} from "@pistachio/shell-contracts/chrome";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";
import { AgentConsole } from "../components/AgentConsole";
import { ContentArea } from "../components/ContentArea";
import { ResizeHandle } from "../components/ResizeHandle";
import { SidebarChrome } from "../components/SidebarChrome";
import { SidebarEdge } from "../components/SidebarEdge";
import { useAppStore } from "../store";
import { nativeApi } from "../api";

/**
 * The sidebar layout is one full-height content row. It begins with the
 * sidebar's persistent column. In compact mode its clipped
 * layout slot narrows to the edge trigger and the column translates out with
 * it; after it come the same pieces the top layout has, in the same order:
 * content and console.
 *
 * Pinned and compact are the SAME column in the same place, and the page
 * sits beside it either way: revealing the compact sidebar puts the column
 * back into the layout and the page reflows to make room, exactly as it
 * does when the sidebar is pinned — never a card floating over the page.
 * The only thing compact adds is that the column leaves again once the
 * pointer does (SidebarPane's auto-hide). The column stays mounted across
 * that cycle: its transform and the slot's width run on one clock, so its
 * contents do not reset and the native tab view reflows beside it over the
 * same frames instead of jumping once.
 *
 * The layout places the sidebar and nothing else about it: what the column
 * holds is SidebarChrome's business, and what THAT holds is the manifest's.
 */
export function SidebarLayout() {
  const pinned = useAppStore((state) => state.settings.layout.sidebar === "pinned");
  const revealed = useAppStore((state) => state.sidebarRevealed);
  const width = useAppStore((state) => state.sidebarWidth);
  const slotRef = useRef<HTMLDivElement>(null);
  const expanded = pinned || revealed;
  useLayoutEffect(
    () =>
      nativeApi()?.onSidebarPointerEntered(() => {
        useAppStore.getState().setSidebarRevealed(true);
      }),
    [],
  );
  return (
    <div
      data-testid="chrome-layout-ground"
      className="chrome-container chrome-layout-ground grid h-full w-full grid-rows-[minmax(0,1fr)]"
    >
      <div data-testid="chrome-content-row" className="chrome-layout-ground flex min-h-0 min-w-0">
        <div
          ref={slotRef}
          data-testid="sidebar-motion-slot"
          data-compact={!pinned ? "" : undefined}
          data-hidden={!expanded ? "" : undefined}
          className="sidebar-motion-slot relative h-full shrink-0"
          style={{ width: expanded ? width : SIDEBAR_EDGE_W }}
        >
          <div className="absolute inset-0 overflow-clip">
            <SidebarPane autoHide={!pinned} revealed={expanded} slotRef={slotRef} />
          </div>
          {!expanded ? <SidebarEdge /> : null}
        </div>
        <ContentArea />
        <AgentConsole />
      </div>
    </div>
  );
}

/**
 * How long the column waits after a leave before it checks whether the
 * pointer has really gone: a leave the page reports is often not one
 * (see below), and the check is what decides.
 */
const LEAVE_CHECK_MS = 120;

/**
 * The sidebar's column: the chrome at its stored width, with the handle
 * that edits it. With `autoHide` (the compact presentation) the column
 * leaves the layout again once the pointer has left it.
 *
 * WHO DECIDES THE POINTER HAS LEFT: the OS pointer, read by main, never the
 * page's own leave events on their own. The column is a window drag region,
 * and the native handling of that makes the page see the pointer leave for
 * a moment while it is still in the column; the traffic lights above the
 * toolbar and the tab views above the page take the pointer without any
 * event at all. So: while the column
 * is up, main watches the OS pointer against the column's box
 * (setSidebarWatch) and says when it has stopped holding the column
 * (onSidebarPointerLeft); a leave the page sees is only a prompt to ask main
 * now (getCursorPoint) rather than wait for the next poll. Where main cannot
 * read the pointer (Playwright), the page's leave stands.
 *
 * WHAT COUNTS AS HOLDING: pointerHoldsSidebar (@pistachio/shell-contracts/chrome) — on the
 * column, over the traffic lights, or past the window's edge on the column's
 * side within its vertical span, so sliding off the screen's edge does not
 * lose it. A pane-resize drag on the column's own handle and a row dragged
 * out over the page to split hold it too, for as long as they run.
 */
function SidebarPane({ autoHide, revealed, slotRef }: { autoHide: boolean; revealed: boolean; slotRef: RefObject<HTMLDivElement | null> }) {
  const width = useAppStore((state) => state.sidebarWidth);
  const setSidebarWidth = useAppStore((state) => state.setSidebarWidth);
  const paneResizing = useAppStore((state) => state.paneResizing);
  const tabDragging = useAppStore((state) => state.tabDragging);
  const ref = useRef<HTMLElement>(null);
  const box = useRef<ContentBounds | null>(null);
  const check = useRef<number | null>(null);

  const busy = paneResizing || tabDragging;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const revealedRef = useRef(revealed);
  revealedRef.current = revealed;
  // The handle sets the width every frame of a resize drag; the watch below
  // reads the latest through this ref rather than re-arming itself per frame.
  const widthRef = useRef(width);
  widthRef.current = width;

  const hide = () => {
    if (busyRef.current) return;
    useAppStore.getState().setSidebarRevealed(false);
  };

  /** Ask main where the pointer is; hide unless it still holds the column. */
  const verify = async () => {
    const point = (await nativeApi()?.getCursorPoint()) ?? null;
    const current = box.current;
    if (point === null || current === null) {
      hide();
      return;
    }
    if (!pointerHoldsSidebar(point, current)) hide();
  };

  const cancelCheck = () => {
    if (check.current === null) return;
    window.clearTimeout(check.current);
    check.current = null;
  };
  /** A leave the page saw: worth a look, not yet a fact. */
  const scheduleCheck = () => {
    if (!autoHide || !revealedRef.current) return;
    cancelCheck();
    check.current = window.setTimeout(() => {
      check.current = null;
      void verify();
    }, LEAVE_CHECK_MS);
  };

  // The column's box, kept current for main's watch and for the check.
  useLayoutEffect(() => {
    if (!autoHide || !revealed) return;
    const element = ref.current;
    if (element === null) return;
    let frame = 0;
    const report = () => {
      frame = 0;
      const rect = slotRef.current?.getBoundingClientRect() ?? element.getBoundingClientRect();
      // The transform moves the pane during the reveal, but the pointer's
      // holding area is its settled column. Reporting that target avoids a
      // stale transformed x while the compositor is still moving it.
      box.current = { x: rect.x, y: rect.y, width: widthRef.current, height: rect.height };
      nativeApi()?.setSidebarWatch(box.current);
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(report);
    };
    report();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    observer.observe(document.documentElement);
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      box.current = null;
      nativeApi()?.setSidebarWatch(null);
    };
    // `width` is read through widthRef: the pane element resizes with it, and
    // the observer reports that resize.
  }, [autoHide, revealed, slotRef]);

  // Main's verdict, and the page's hints.
  useEffect(() => {
    if (!autoHide) return;
    const offLeft = nativeApi()?.onSidebarPointerLeft(() => {
      cancelCheck();
      hide();
    });
    const onMouseLeave = () => scheduleCheck();
    const onBlur = () => scheduleCheck();
    document.addEventListener("mouseleave", onMouseLeave);
    window.addEventListener("blur", onBlur);
    return () => {
      offLeft?.();
      document.removeEventListener("mouseleave", onMouseLeave);
      window.removeEventListener("blur", onBlur);
      cancelCheck();
    };
    // Handlers close over refs and stable setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoHide]);

  // A gesture that held the column has ended: where the pointer is now is
  // the answer, and main's watch may have already given up its verdict.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy && autoHide) {
      // The watch stopped itself on its verdict; arm it again for the rest.
      if (box.current !== null) nativeApi()?.setSidebarWatch(box.current);
      scheduleCheck();
    }
    wasBusy.current = busy;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, autoHide]);

  return (
    <aside
      ref={ref}
      aria-label="Sidebar"
      data-testid="sidebar-pane"
      data-auto-hide={autoHide ? "" : undefined}
      data-hidden={!revealed ? "" : undefined}
      aria-hidden={!revealed || undefined}
      inert={!revealed || undefined}
      className="sidebar-motion-pane absolute inset-y-0 left-0 shrink-0"
      style={{ width }}
      onPointerEnter={cancelCheck}
      onPointerLeave={scheduleCheck}
    >
      <SidebarChrome />
      <ResizeHandle
        side="right"
        width={width}
        min={SIDEBAR_MIN_W}
        max={SIDEBAR_MAX_W}
        defaultWidth={SIDEBAR_DEFAULT_W}
        label="Resize sidebar"
        setWidth={setSidebarWidth}
      />
    </aside>
  );
}
