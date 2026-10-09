import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  pointerHoldsSidebar,
  SIDEBAR_DEFAULT_W,
  SIDEBAR_EDGE_W,
  SIDEBAR_MAX_W,
  SIDEBAR_MIN_W,
  SIDEBAR_RAIL_W,
} from "@pistachio/shell-contracts/chrome";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";
import { AgentConsole } from "../components/AgentConsole";
import { ContentArea } from "../components/ContentArea";
import { ResizeHandle } from "../components/ResizeHandle";
import { useScreenShares, useScreenShareStartNotice } from "../components/ScreenShareIndicator";
import { SidebarChrome } from "../components/SidebarChrome";
import { revealSidebar, SidebarEdge } from "../components/SidebarEdge";
import { cn } from "../lib/cn";
import { useDeskChrome, useDeskCover } from "../lib/desk/chrome";
import { deskAvailable } from "../lib/desk/open";
import {
  nextSidebarOverlay,
  SIDEBAR_OVERLAY_AWAY,
  sidebarCoverWanted,
  sidebarHeld,
  sidebarOverlays,
  useSidebarColumn,
  useSidebarMode,
} from "../lib/sidebar-mode";
import { useAppStore } from "../store";
import { nativeApi } from "../api";

/**
 * The sidebar layout is one full-height content row. It begins with the
 * sidebar's persistent column (SidebarColumn), then the content and the
 * console.
 *
 * The column has three modes (lib/sidebar-mode.ts, docs/spaces.md §3): the
 * whole sidebar or a rail of its icons, in the layout with the page (or the
 * desk) beside it; or hidden, its layout slot narrowed to the edge's strip
 * and the column translated out with it until the pointer comes to the
 * window's edge. Brought out on the web, the hidden column is back in the
 * layout and the page reflows to make room, exactly as beside the whole
 * sidebar; on the desk it comes out OVER the desk's windows instead — the
 * slot stays its strip, the column slides in by its transform alone, and
 * the windows under it give way to their stills (it is a cover), so no page
 * is laid out anew for a reveal. Either way it leaves again once the
 * pointer does (SidebarPane's auto-hide). The column stays mounted across
 * every change: its transform and the slot's width run on one clock, so its
 * contents do not reset.
 *
 * The layout places the sidebar and nothing else about it: what the column
 * holds is SidebarChrome's business, and what THAT holds is the manifest's.
 */
export function SidebarLayout() {
  return (
    <div
      data-testid="chrome-layout-ground"
      className="chrome-container chrome-layout-ground grid h-full w-full grid-rows-[minmax(0,1fr)]"
    >
      <div data-testid="chrome-content-row" className="chrome-layout-ground flex min-h-0 min-w-0">
        <SidebarColumn />
        <ContentArea />
        <AgentConsole />
      </div>
    </div>
  );
}

/** The overlaid column's cover over the desk (DeskEngine.setCover). */
const SIDEBAR_COVER = "sidebar";
/** The cover reaches this far past the column's trailing edge: its shadow. */
const OVERLAY_SHADOW = 16;

/**
 * The sidebar's column: its layout slot, and the pane in it.
 *
 * Whole and rail (`data-mode`) are the column in the layout at its width, or
 * at the rail's (SIDEBAR_RAIL_W), the same chrome drawn narrow (SidebarChrome's
 * rail; the rail is the desktop's alone). Hidden, the slot is the edge's
 * strip (SIDEBAR_EDGE_W) with the trigger in it (SidebarEdge).
 *
 * Hidden on the desk, the column comes out as an OVERLAY (`data-overlay`,
 * which raises the slot above the desk's surface): its cover goes up over
 * the desk as the pointer arrives — its box the column's settled one, plus
 * its shadow, so it leads every frame of the slide — and the column slides
 * in once the windows under it have given way (useDeskCover's answer). Going,
 * it keeps the cover and its layer until its retreat has ended; a window
 * taken in hand sends it; and a mode chosen while it is out (⌘S, its own
 * button) keeps them until the slot has grown out from under it. The desk
 * never brings it out for a flight: a window going home while it is away
 * goes into the window's edge at its row's height (DeskHost.sidebarAway).
 * (Main hears it is on screen only once it is out: ShellState.sidebarRevealed.)
 */
export function SidebarColumn() {
  const mode = useSidebarMode();
  const overlay = sidebarOverlays(mode);
  const revealed = useAppStore((state) => state.sidebarRevealed);
  const width = useAppStore((state) => state.sidebarWidth);
  const slotRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const rail = mode === "rail";
  const paneWidth = rail ? SIDEBAR_RAIL_W : width;
  // In the layout: whole, a rail, or (on the web) hidden and brought out.
  const expanded = mode !== "hidden" || (!overlay && revealed);
  const slotWidth = expanded ? paneWidth : SIDEBAR_EDGE_W;
  // (A whole slot has no transition of its own — its width follows a resize drag frame by frame — so a change of mode,
  // never a reveal, runs on the hidden sidebar's clock.)
  const sliding = useDeskSlide(mode, slotRef);

  const [over, setOver] = useState(SIDEBAR_OVERLAY_AWAY);
  const covering = sidebarCoverWanted(over, overlay, revealed);
  const coverClear = useDeskCover(SIDEBAR_COVER, paneRef, covering, {
    // The column's settled box, wherever its slide has it: the slot's place, the pane's width, and its shadow.
    box: (pane) => {
      const slot = slotRef.current?.getBoundingClientRect() ?? pane.getBoundingClientRect();
      return { x: slot.left, y: slot.top, width: pane.offsetWidth + OVERLAY_SHADOW, height: slot.height };
    },
    // A window taken in hand sends the column away (unless something it opened holds it).
    onGesture: () => {
      if (useAppStore.getState().sidebarRevealed && !sidebarHeldNow()) useAppStore.getState().setSidebarRevealed(false);
    },
  });
  const next = nextSidebarOverlay(over, overlay, revealed, coverClear);
  if (next !== over) setOver(next);
  // Over the desk (or on its way, going, or being left): as wide as itself, on its own ground, above the desk. At
  // rest — and sliding into hidden from another mode, which needs no cover — it fits its slot, as on the web.
  const floating = covering;
  const shown = overlay ? over.out : expanded;

  // Going: its cover and layer stay until the retreat has ended.
  useEffect(() => {
    if (!over.retreating) return;
    const pane = paneRef.current;
    const done = () => setOver((current) => (current.retreating ? { ...current, retreating: false } : current));
    const onEnd = (event: TransitionEvent) => {
      if (event.target === pane && event.propertyName === "transform") done();
    };
    pane?.addEventListener("transitionend", onEnd);
    const timer = window.setTimeout(done, DESK_SLIDE_MS + 80);
    return () => {
      pane?.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
    };
  }, [over.retreating]);
  // Left while it was out: they stay until the slot has grown out from under it.
  useEffect(() => {
    if (over.leaving && !sliding) setOver((current) => (current.leaving ? { ...current, leaving: false } : current));
  }, [over.leaving, sliding]);
  // Main hears it once it is out (ShellState.sidebarRevealed).
  useLayoutEffect(() => {
    useSidebarColumn.getState().setOut(over.out);
  }, [over.out]);
  useEffect(() => () => useSidebarColumn.getState().setOut(false), []);

  useLayoutEffect(() => nativeApi()?.onSidebarPointerEntered(revealSidebar), []);
  return (
    <div
      ref={slotRef}
      data-testid="sidebar-motion-slot"
      data-mode={mode}
      data-hidden={!expanded ? "" : undefined}
      // (The desk's dock in the layout, whole or a rail: what the specs written before the modes look for.)
      data-desk={deskAvailable() && mode !== "hidden" ? "" : undefined}
      data-rail={rail ? "" : undefined}
      data-overlay={floating ? "" : undefined}
      data-desk-slide={sliding ? "" : undefined}
      className="sidebar-motion-slot relative h-full shrink-0"
      style={{ width: slotWidth }}
    >
      {/* Over the desk, the column is as wide as itself and takes the pointer only where it is (its pane, once out).
          In the layout it fits its slot; a resting rail clips nothing, so a menu from its footer can hang out over the desk. */}
      <div
        className={cn(
          "absolute inset-y-0 left-0",
          floating ? "pointer-events-none" : cn("right-0", rail && !sliding ? "overflow-visible" : "overflow-clip"),
        )}
        style={floating ? { width: paneWidth } : undefined}
      >
        <SidebarPane
          paneRef={paneRef}
          autoHide={mode === "hidden"}
          revealed={revealed}
          shown={shown}
          overlay={floating}
          rail={rail}
          width={paneWidth}
          slotRef={slotRef}
        />
      </div>
      {rail ? <AwayShareNotice /> : mode === "hidden" && !revealed ? <SidebarEdge /> : null}
    </div>
  );
}

/** The slot's width changes this fast for a change of mode (`.sidebar-motion-slot[data-desk-slide]`): the hidden sidebar's clock. */
const DESK_SLIDE_MS = 250;

/**
 * The column changing mode — whole, a rail, hidden. For that change the
 * slot's width runs on the hidden sidebar's clock, whatever the mode. True
 * from the render that changes `key` (so the width and the transition
 * change together) until the slide ends. (A reveal is never one: on the
 * desk the slot keeps its strip, and on the web the hidden slot has the
 * clock already.)
 */
function useDeskSlide(key: string, slotRef: RefObject<HTMLDivElement | null>): boolean {
  const [slide, setSlide] = useState({ key, sliding: false });
  if (slide.key !== key) setSlide({ key, sliding: true });
  useEffect(() => {
    if (!slide.sliding) return;
    const slot = slotRef.current;
    const done = () => setSlide((current) => (current.sliding ? { ...current, sliding: false } : current));
    const onEnd = (event: TransitionEvent) => {
      if (event.target === slot && event.propertyName === "width") done();
    };
    slot?.addEventListener("transitionend", onEnd);
    const timer = window.setTimeout(done, DESK_SLIDE_MS + 80);
    return () => {
      slot?.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
    };
  }, [slide, slotRef]);
  return slide.sliding || slide.key !== key;
}

/**
 * A rail shows no screen share card (the media region is not drawn there):
 * a share that begins meanwhile says so as a notice, as it does while the
 * hidden sidebar is away.
 */
function AwayShareNotice() {
  useScreenShareStartNotice(useScreenShares());
  return null;
}

/** What holds the hidden column out (lib/sidebar-mode.ts's sidebarHeld), now. */
function sidebarHeldNow(): boolean {
  return sidebarHeld(useAppStore.getState(), useDeskChrome.getState().card !== null, useSidebarColumn.getState().renaming);
}

/** sidebarHeld() for a component. */
function useSidebarHeld(): boolean {
  const card = useDeskChrome((state) => state.card !== null);
  const renaming = useSidebarColumn((state) => state.renaming);
  return useAppStore((state) => sidebarHeld(state, card, renaming));
}

/**
 * How long the column waits after a leave before it checks whether the
 * pointer has really gone: a leave the page reports is often not one
 * (see below), and the check is what decides.
 */
const LEAVE_CHECK_MS = 120;

/**
 * The sidebar's column: the chrome at its stored width, with the handle
 * that edits it. With `autoHide` (the hidden mode) the column leaves again
 * once the pointer has left it: brought out (`revealed`, the store's intent)
 * it is SHOWN at once on the web, and on the desk once its cover is clear
 * (SidebarColumn), and the two are told apart here only by what is drawn.
 *
 * WHO DECIDES THE POINTER HAS LEFT: the OS pointer, read by main, never the
 * page's own leave events on their own. The column is a window drag region,
 * and the native handling of that makes the page see the pointer leave for
 * a moment while it is still in the column; the traffic lights above the
 * toolbar and the tab views above the page take the pointer without any
 * event at all. So: from the moment the column is brought out, main watches
 * the OS pointer against the column's box (setSidebarWatch) and says when it
 * has stopped holding the column (onSidebarPointerLeft) — a pointer gone
 * while the desk's stills were on their way calls the reveal off before it
 * shows; a leave the page sees is only a prompt to ask main now
 * (getCursorPoint) rather than wait for the next poll. Where main cannot
 * read the pointer (Playwright), the page's leave stands.
 *
 * WHAT COUNTS AS HOLDING: pointerHoldsSidebar (@pistachio/shell-contracts/chrome) — on the
 * column, over the traffic lights, or past the window's edge on the column's
 * side within its vertical span, so sliding off the screen's edge does not
 * lose it. And for as long as they last, whatever reaches past the column
 * from it (lib/sidebar-mode.ts's sidebarHeld): a resize on its own handle, a
 * row dragged out of it, a desk card or a row's menu it opened, a row being
 * renamed.
 */
function SidebarPane({
  paneRef,
  autoHide,
  revealed,
  shown,
  overlay,
  rail,
  width,
  slotRef,
}: {
  paneRef: RefObject<HTMLElement | null>;
  autoHide: boolean;
  /** Brought out: the reveal's intent (the store's `sidebarRevealed`). */
  revealed: boolean;
  /** Drawn: in the layout, or (over the desk) out once its cover is clear. */
  shown: boolean;
  /** Laid over the desk (hidden mode on the desk), on a ground of its own. */
  overlay: boolean;
  /** Drawn as a rail of its icons. */
  rail: boolean;
  width: number;
  slotRef: RefObject<HTMLDivElement | null>;
}) {
  const setSidebarWidth = useAppStore((state) => state.setSidebarWidth);
  const box = useRef<ContentBounds | null>(null);
  const check = useRef<number | null>(null);

  const busy = useSidebarHeld();
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
    const element = paneRef.current;
    if (element === null) return;
    let frame = 0;
    const report = () => {
      frame = 0;
      const rect = slotRef.current?.getBoundingClientRect() ?? element.getBoundingClientRect();
      // The transform moves the pane during the reveal, but the pointer's
      // holding area is its settled column. Reporting that target avoids a
      // stale transformed x while the compositor is still moving it. (Over
      // the desk the slot is the strip, the column as wide as itself from
      // the same place.)
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
  }, [autoHide, revealed, slotRef, paneRef]);

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

  // A gesture that held the column has ended (a row handed off to the desk,
  // a card closed): where the pointer is now is the answer, and main's watch
  // may have already given up its verdict.
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
      ref={paneRef}
      aria-label="Sidebar"
      data-testid="sidebar-pane"
      data-auto-hide={autoHide ? "" : undefined}
      data-hidden={!shown ? "" : undefined}
      data-rail={rail ? "" : undefined}
      data-overlay={overlay ? "" : undefined}
      aria-hidden={!shown || undefined}
      inert={!shown || undefined}
      className="sidebar-motion-pane absolute inset-y-0 left-0 shrink-0"
      style={{ width }}
      onPointerEnter={cancelCheck}
      onPointerLeave={scheduleCheck}
    >
      <SidebarChrome rail={rail} />
      {rail ? null : (
        <ResizeHandle
          side="right"
          width={width}
          min={SIDEBAR_MIN_W}
          max={SIDEBAR_MAX_W}
          defaultWidth={SIDEBAR_DEFAULT_W}
          label="Resize sidebar"
          setWidth={setSidebarWidth}
        />
      )}
    </aside>
  );
}
