import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Columns2, Maximize2, X } from "lucide-react";
import type { ContentBounds, GlanceState } from "@pistachio/shell-contracts/ipc";
import { glanceFrame, type GlanceFrame } from "../lib/glance";
import { useAppStore } from "../store";
import { nativeApi, shellApi } from "../api";
import { useSurface } from "../surface";

/** The card settling away on close (styles.css glance-frame-out). */
export const GLANCE_CLOSE_MS = 280;
/** The live preview expanding into the full tab (styles.css glance-promote). */
export const GLANCE_PROMOTE_MS = 300;
/**
 * The most flight time one painted frame may consume. The compositor can
 * stall for 60-140ms right as a flight starts (an empty BeginMainFrame
 * outside the app's control); a free-running clock would skip most of the
 * eased motion across that gap and the flight would read as a cut. Clamped,
 * a stall costs duration, never distance.
 */
const GLANCE_FLIGHT_STEP_MS = 24;

/**
 * The frozen last frame of the live page, already decoded so its first paint
 * is the whole picture. `image` is null when nothing could be captured (the
 * page was never shown): a close then settles the empty card away.
 */
interface GlanceExit {
  image: HTMLImageElement | null;
}

interface GlancePromotionTarget {
  local: ContentBounds;
  window: ContentBounds;
}

export function GlanceOverlay({
  glance,
  surfaceRef,
}: {
  glance: GlanceState;
  surfaceRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [frame, setFrame] = useState<GlanceFrame | null>(null);
  const [landed, setLanded] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [exit, setExit] = useState<GlanceExit | null>(null);
  const [promotionTarget, setPromotionTarget] = useState<GlancePromotionTarget | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const staged = useAppStore((state) => state.glanceStaged);
  const closing = useAppStore((state) => state.glanceClosing);
  const setGlanceStaged = useAppStore((state) => state.setGlanceStaged);
  const setGlanceClosing = useAppStore((state) => state.setGlanceClosing);
  const prepareGlanceClose = useAppStore((state) => state.prepareGlanceClose);
  const closeGlance = useAppStore((state) => state.closeGlance);
  const promoteGlance = useAppStore((state) => state.promoteGlance);
  const splitGlance = useAppStore((state) => state.splitGlance);
  const surface = useSurface();
  const alive = useRef(true);
  const frameElement = useRef<HTMLDivElement>(null);
  const pageHost = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const confirmationTimer = useRef<number | null>(null);
  const leavingRef = useRef(false);
  const confirmCloseRef = useRef(confirmClose);
  confirmCloseRef.current = confirmClose;

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;
    let animationFrame = 0;
    const measure = () => {
      animationFrame = 0;
      setFrame(glanceFrame(surface.getBoundingClientRect(), glance.source));
    };
    const schedule = () => {
      if (animationFrame === 0) animationFrame = window.requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(surface);
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (animationFrame !== 0) window.cancelAnimationFrame(animationFrame);
    };
  }, [glance.source, surfaceRef]);

  // Staging. Main keeps the owner's live view up until the still that stands
  // in for it (BrowserSurface's pane stills) is decoded and painted beneath;
  // only then is the owner told to recede, and a frame later the motion —
  // the card's flight and the owner dimming — begins on the still. Hiding the
  // owner any earlier showed a blank pane while a multi-megabyte still decoded.
  useEffect(() => {
    let cancelled = false;
    const stage = async () => {
      const surface = surfaceRef.current;
      const stills = surface === null
        ? []
        : [...surface.querySelectorAll<HTMLImageElement>("img.pane-still")];
      await Promise.all(stills.map((still) => still.decode().catch(() => undefined)));
      if (cancelled) return;
      await afterPaint();
      if (cancelled) return;
      nativeApi()?.recedeGlanceOwner();
      await nextFrame();
      if (cancelled) return;
      setGlanceStaged(true);
    };
    void stage();
    return () => {
      cancelled = true;
    };
  }, [glance.tab.id, setGlanceStaged, surfaceRef]);

  // The card performs its opening flight, growing out of the clicked link.
  // The live page rides inside the card from the first frame — the native
  // view follows the animating frame, so the page shows the moment it has
  // pixels — and the flight lands when the card's own motion completes.
  useEffect(() => {
    if (!staged || frame === null || landed) return;
    let cancelled = false;
    const fly = async () => {
      await followFlightFrame(frameElement.current);
      if (!cancelled) setLanded(true);
    };
    void fly();
    return () => {
      cancelled = true;
    };
    // Starting over on resize would make the preview wait another full beat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staged, frame === null, glance.tab.id]);

  useLayoutEffect(() => {
    if (!landed || closing || frame === null) return;
    nativeApi()?.setGlanceBounds(frame.window);
  }, [closing, frame, landed]);

  // The decoded frame goes into the card as the very element that was
  // decoded, so nothing has to be fetched or decoded again on first paint.
  useLayoutEffect(() => {
    const host = pageHost.current;
    if (host === null || exit?.image == null) return;
    host.replaceChildren(exit.image);
    return () => host.replaceChildren();
  }, [exit]);

  // The closing hand-off, the mirror of staging. The frozen frame is now in
  // the DOM, painted under the live view at the same box; once the compositor
  // has shown it, the view can go without the page changing by a pixel, and
  // the card settles away. A dismissal during the opening flight waits for
  // the card to land first, so the motion reverses from where it stopped.
  useEffect(() => {
    if (exit === null || !landed) return;
    let cancelled = false;
    const handOff = async () => {
      await afterPaint();
      if (cancelled) return;
      nativeApi()?.setGlanceBounds(null);
      setGlanceClosing(true);
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null;
        void closeGlance();
      }, reduced ? 0 : GLANCE_CLOSE_MS);
    };
    void handOff();
    return () => {
      cancelled = true;
    };
  }, [closeGlance, exit, landed, setGlanceClosing]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      if (confirmationTimer.current !== null) window.clearTimeout(confirmationTimer.current);
      nativeApi()?.setGlanceBounds(null);
    };
  }, []);

  const dismiss = useCallback(async (hasFocused = false) => {
    if (leavingRef.current || actionPending) return;
    // An in-progress field edit is protected: the first Escape turns the
    // close control into a three-second confirmation, the second closes.
    if (hasFocused && !confirmCloseRef.current) {
      confirmCloseRef.current = true;
      setConfirmClose(true);
      if (confirmationTimer.current !== null) window.clearTimeout(confirmationTimer.current);
      confirmationTimer.current = window.setTimeout(() => {
        confirmationTimer.current = null;
        confirmCloseRef.current = false;
        setConfirmClose(false);
      }, 3_000);
      return;
    }
    if (confirmationTimer.current !== null) window.clearTimeout(confirmationTimer.current);
    confirmationTimer.current = null;
    setConfirmClose(false);
    leavingRef.current = true;
    setLeaving(true);
    // Nothing moves until the page's last frame is ready to stand in for it:
    // the live view stays up while main captures it and the image decodes.
    const preview = await prepareGlanceClose();
    if (!alive.current) return;
    const image = preview === null ? null : await decodeImage(preview);
    if (!alive.current) return;
    setExit({ image });
  }, [actionPending, prepareGlanceClose]);

  useEffect(
    () => shellApi().onGlanceDismissRequested((hasFocused) => void dismiss(hasFocused)),
    [dismiss],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A request the preview raised is answered in a dialog over it, and
      // Escape there means "decide later" — not "and close the preview".
      if (useAppStore.getState().overlay === "permission") return;
      void dismiss(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dismiss]);

  const promote = async () => {
    if (leaving || actionPending || !landed || frame === null) return;
    const surface = surfaceRef.current;
    const target = surface === null ? null : glancePromotionTarget(surface);
    if (target === null) {
      setActionPending(true);
      void promoteGlance();
      return;
    }
    leavingRef.current = true;
    setActionPending(true);
    setLeaving(true);
    // This is the existing native preview throughout — no screenshot is
    // scaled. Main follows the shell frame's real bounds so the page gets a
    // normal resize/reflow at every animation frame.
    await nativeApi()?.stageGlancePromotion(frame.window);
    if (!alive.current) return;
    setPromotionTarget(target);
    await nextFrame();
    if (!alive.current) return;
    await followFlightFrame(frameElement.current);
    if (!alive.current) return;
    // An invoke here is an ordering barrier after the fire-and-forget frame
    // samples. Promotion therefore inherits the exact final bounds.
    await nativeApi()?.stageGlancePromotion(target.window);
    if (!alive.current) return;
    void promoteGlance();
  };
  const split = () => {
    if (leaving || actionPending) return;
    setActionPending(true);
    void splitGlance();
  };

  if (frame === null) return null;
  const flight = promotionTarget !== null
    ? "promote"
    : closing
      ? "out"
      : !staged
        ? "pending"
        : landed
          ? undefined
          : "in";
  const frameStyle = {
    ...boxStyle(frame.local),
    ...flightVariables(frame),
    ...(promotionTarget === null
      ? {}
      : promotionVariables(frame.local, promotionTarget.local)),
  };
  const actionsStyle = {
    left: frame.local.x + frame.local.width + 12,
    top: frame.local.y + 15,
  };

  return (
    <div
      data-testid="glance-overlay"
      data-closing={closing ? "" : undefined}
      data-leaving={leaving ? "" : undefined}
      data-promoting={promotionTarget === null ? undefined : ""}
      className="glance-overlay no-drag absolute inset-0 z-40"
      onPointerDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget) void dismiss();
      }}
    >
      <div
        ref={frameElement}
        aria-hidden="true"
        className="glance-frame"
        data-flight={flight}
        style={frameStyle}
      >
        {exit?.image != null ? (
          <div ref={pageHost} className="glance-frame-page" />
        ) : surface.kind === "stream" && surface.renderGlance !== undefined ? (
          <div className="glance-frame-page">{surface.renderGlance(glance.tab)}</div>
        ) : null}
      </div>
      {staged ? (
        <div className="glance-actions" style={actionsStyle} aria-label="Glance actions">
          <GlanceAction
            testId="glance-close"
            label={confirmClose ? "Confirm close" : "Close Glance"}
            shortcut="Esc"
            confirm={confirmClose}
            disabled={leaving || actionPending}
            onClick={() => void dismiss(false)}
          >
            <X />
            {confirmClose ? <span>Close?</span> : null}
          </GlanceAction>
          <GlanceAction
            testId="glance-promote"
            label="Open as tab"
            disabled={leaving || actionPending || !landed}
            onClick={() => void promote()}
          >
            <Maximize2 />
          </GlanceAction>
          <GlanceAction
            testId="glance-split"
            label="Open in split view"
            disabled={leaving || actionPending}
            onClick={split}
          >
            <Columns2 />
          </GlanceAction>
        </div>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {glance.tab.loading ? "Loading link preview" : `Previewing ${glance.tab.title}`}
      </span>
    </div>
  );
}

function GlanceAction({
  children,
  confirm = false,
  disabled,
  label,
  onClick,
  shortcut,
  testId,
}: {
  children: React.ReactNode;
  confirm?: boolean;
  disabled: boolean;
  label: string;
  onClick(): void;
  shortcut?: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-confirm={confirm ? "" : undefined}
      className="glance-action"
      aria-label={label}
      title={`${label}${shortcut === undefined ? "" : ` (${shortcut})`}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

/** Resolves once whatever is committed now has been painted and composited. */
async function afterPaint(): Promise<void> {
  await nextFrame();
  await nextFrame();
}

/** Decode off the critical path so the first painted frame is the whole image. */
async function decodeImage(src: string): Promise<HTMLImageElement | null> {
  const image = new Image();
  image.alt = "";
  image.draggable = false;
  image.src = src;
  try {
    await image.decode();
    return image;
  } catch {
    // An unusable capture: closing can still settle the empty card away.
    return null;
  }
}

/** Resize the native preview to the shell frame CSS is currently painting. */
async function followFlightFrame(element: HTMLElement | null): Promise<void> {
  if (element === null) return;
  // React commits the data-flight attribute on its own schedule; under load
  // the next animation frame can beat that commit. Falling through then
  // would skip the flight entirely — the final state applies in one paint. A
  // few frames of patience costs nothing when the commit already happened.
  let animation: Animation | undefined;
  for (let attempt = 0; attempt < 10 && animation === undefined; attempt += 1) {
    animation = element.getAnimations()[0];
    if (animation === undefined) await nextFrame();
  }
  if (animation === undefined) return;
  let animationFrame = 0;
  let finished = false;
  let previous = "";
  // The clamp leaves a paused animation alone: tests (and devtools) hold the
  // flight by pausing and seeking it, and that seek must stand.
  let clock = 0;
  const clampFlightClock = () => {
    const now = Number(animation.currentTime ?? clock);
    if (!Number.isFinite(now)) return;
    if (animation.playState !== "running") {
      clock = now;
      return;
    }
    if (now - clock > GLANCE_FLIGHT_STEP_MS) {
      clock += GLANCE_FLIGHT_STEP_MS;
      animation.currentTime = clock;
    } else {
      clock = now;
    }
  };
  const sample = () => {
    animationFrame = 0;
    if (finished) return;
    clampFlightClock();
    const bounds = rectBounds(element.getBoundingClientRect());
    const key = `${String(bounds.x)}:${String(bounds.y)}:${String(bounds.width)}:${String(bounds.height)}`;
    if (key !== previous) {
      previous = key;
      nativeApi()?.setGlanceBounds(bounds);
    }
    animationFrame = window.requestAnimationFrame(sample);
  };
  sample();
  await animation.finished.catch(() => undefined);
  finished = true;
  if (animationFrame !== 0) window.cancelAnimationFrame(animationFrame);
}

function boxStyle(bounds: ContentBounds): React.CSSProperties {
  return { left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height };
}

function rectBounds(rect: DOMRect): ContentBounds {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

function flightVariables(frame: GlanceFrame): React.CSSProperties {
  return {
    "--glance-source-x": `${frame.sourceLocal.x}px`,
    "--glance-source-y": `${frame.sourceLocal.y}px`,
    "--glance-source-w": `${frame.sourceLocal.width}px`,
    "--glance-source-h": `${frame.sourceLocal.height}px`,
    "--glance-target-x": `${frame.local.x}px`,
    "--glance-target-y": `${frame.local.y}px`,
    "--glance-target-w": `${frame.local.width}px`,
    "--glance-target-h": `${frame.local.height}px`,
  } as React.CSSProperties;
}

/** The pane grid's layout box is untransformed even while Glance dims/scales it. */
function glancePromotionTarget(surface: HTMLElement): GlancePromotionTarget | null {
  const paneGrid = surface.querySelector<HTMLElement>(".browser-pane-grid");
  if (paneGrid === null) return null;
  const surfaceRect = surface.getBoundingClientRect();
  const local: ContentBounds = {
    x: Math.round(paneGrid.offsetLeft),
    y: Math.round(paneGrid.offsetTop),
    width: Math.max(1, Math.round(paneGrid.offsetWidth)),
    height: Math.max(1, Math.round(paneGrid.offsetHeight)),
  };
  return {
    local,
    window: {
      x: Math.round(surfaceRect.left + local.x),
      y: Math.round(surfaceRect.top + local.y),
      width: local.width,
      height: local.height,
    },
  };
}

function promotionVariables(
  from: ContentBounds,
  to: ContentBounds,
): React.CSSProperties {
  return {
    "--glance-promote-start-x": `${String(from.x)}px`,
    "--glance-promote-start-y": `${String(from.y)}px`,
    "--glance-promote-start-w": `${String(from.width)}px`,
    "--glance-promote-start-h": `${String(from.height)}px`,
    "--glance-promote-end-x": `${String(to.x)}px`,
    "--glance-promote-end-y": `${String(to.y)}px`,
    "--glance-promote-end-w": `${String(to.width)}px`,
    "--glance-promote-end-h": `${String(to.height)}px`,
  } as React.CSSProperties;
}
