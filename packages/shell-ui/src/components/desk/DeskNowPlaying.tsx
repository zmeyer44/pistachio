/**
 * The desk's now playing on its rail (docs/desk.md, "Now playing"): the
 * media stack, drawn for a column with no room for its cards. What plays
 * with no window out on the desk — a tab whose window was sent here from its
 * frame (Pop out), or put away playing — is:
 *
 * - a video, the floating player: the page's own picture over the desk
 *   (main's media preview, presenting only its video), with no frame or
 *   controls around it. Its controls are the "pip" view's, over the picture
 *   while the pointer is on it (PipApp.tsx); a press on it away from them
 *   moves it, wherever it is let go (kept on this device). A cover over it —
 *   a card, a menu, the address palette — takes the picture down while it
 *   lies there, its place drawn here instead;
 * - anything else, a button in the rail: bars that move with how loud it is
 *   as it plays (its page measures it: setMediaMeters), a play button while
 *   it does not; a click plays or pauses it, and the pointer resting on it
 *   opens a card beside the rail with the media stack's own controls.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { DeskPipMedia } from "@pistachio/shell-contracts/desk";
import type { BrowserMediaInfo } from "@pistachio/shell-contracts/media";
import { nativeApi } from "../../api";
import { showOnDesk, useDeskEngine, useDeskWindowKey } from "../../lib/desk/open";
import { useNowPlaying, type PipSpot } from "../../lib/desk/now-playing";
import { useAppStore } from "../../store";
import { MediaCard, useBackgroundMedia } from "../MediaStack";
import { Play } from "../media-icons";
import type { DeskEngine, DeskView } from "./desk-engine";

/** The floating player's picture: a widescreen frame, as a browser's picture in picture opens at. */
const PIP_W = 320;
const PIP_H = 180;
/** Its first place: beside the rail, clear of the desk's foot (the notch, a shelf of parked windows). */
const PIP_GAP = 12;
const PIP_FOOT = 64;
/** A press on the picture that travels less than this is no move. */
const PIP_SLOP = 3;
/** The pointer resting on a rail button opens its card; leaving both, the card goes a moment after (the desk's cards' grace). */
const CARD_OPEN_MS = 120;
const CARD_LINGER_MS = 300;
const CARD_W = 300;
const CARD_COVER = "now-playing";
/** The card is the stack's, every control out already: nothing to engage. */
const NO_ENGAGE = (): void => undefined;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function useDeskView(engine: DeskEngine | null): DeskView | null {
  return useSyncExternalStore(
    useCallback((listener: () => void) => engine?.subscribe(listener) ?? (() => undefined), [engine]),
    () => engine?.getView() ?? null,
    () => null,
  );
}

function useWindowSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const measure = (): void => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return size;
}

function stageBox(): DOMRect | null {
  return document.querySelector<HTMLElement>(".desk-stage")?.getBoundingClientRect() ?? null;
}

/** The player kept whole in the window. */
function clampBox(box: Box, size: { width: number; height: number }): Box {
  return {
    ...box,
    x: Math.round(Math.min(Math.max(0, box.x), Math.max(0, size.width - box.width))),
    y: Math.round(Math.min(Math.max(0, box.y), Math.max(0, size.height - box.height))),
  };
}

/** Where the player stands: where it was left, or its first place. */
function placedBox(spot: PipSpot | null, size: { width: number; height: number }): Box {
  if (spot !== null) return clampBox({ x: spot.x * size.width, y: spot.y * size.height, width: PIP_W, height: PIP_H }, size);
  const stage = stageBox();
  const x = stage === null ? 60 : stage.left + PIP_GAP;
  const y = (stage === null ? size.height : stage.bottom) - PIP_H - PIP_FOOT;
  return clampBox({ x, y, width: PIP_W, height: PIP_H }, size);
}

function pipMedia(media: BrowserMediaInfo): DeskPipMedia {
  return {
    tabId: media.tabId,
    title: media.title || media.tabTitle || "Video",
    playing: media.playing,
    muted: media.muted,
    position: media.position,
    duration: media.duration,
    updatedAt: media.updatedAt,
    playbackRate: media.playbackRate,
    seekable: media.seekable,
    canPrevious: media.canPrevious,
    canNext: media.canNext,
  };
}

export function RailNowPlaying() {
  const { media } = useBackgroundMedia();
  // The stack puts the video playing first: that one floats; the rest are the rail's.
  const video = media[0]?.hasVideo === true ? media[0] : null;
  const rest = video === null ? media : media.slice(1);
  const meterKey = rest.map((item) => item.tabId).join(" ");
  useEffect(() => {
    nativeApi()?.setMediaMeters(meterKey === "" ? [] : meterKey.split(" "));
  }, [meterKey]);
  useEffect(() => () => nativeApi()?.setMediaMeters([]), []);
  return (
    <>
      {rest.length === 0 ? null : (
        <div className="rail-now-playing no-drag" data-testid="rail-now-playing">
          {rest.map((item) => (
            <RailMediaButton key={item.tabId} media={item} />
          ))}
        </div>
      )}
      {video === null ? null : <DeskPip media={video} />}
    </>
  );
}

/* ----------------------------- the floating player ----------------------------- */

function DeskPip({ media }: { media: BrowserMediaInfo }) {
  const engine = useDeskEngine();
  const view = useDeskView(engine);
  const size = useWindowSize();
  const spot = useNowPlaying((state) => state.pip);
  // Anything the shell raises over the window (a menu, the address palette, settings, the tab switcher) may lie over it.
  const raised = useAppStore((state) => state.overlay !== "none" || state.onboardingOpen);
  // Its window still on its way into its row: the page is the desk's until it has gone.
  const leaving = useDeskWindowKey().split(" ").includes(media.tabId);
  const covered = raised || leaving || view?.floatCovered === true;
  const [held, setHeld] = useState<Box | null>(null);
  const box = held ?? placedBox(spot, size);
  const pip = pipMedia(media);
  const pipKey = JSON.stringify(pip);

  // Its picture there, and the pip view's face over it — or both down while something lies over it.
  useLayoutEffect(() => {
    const api = nativeApi();
    if (api === null) return;
    if (covered) {
      api.setMediaPreview(null);
      api.setDeskPip(null);
      return;
    }
    api.setMediaPreview({ tabId: media.tabId, bounds: box });
    api.setDeskPip({ bounds: box, media: JSON.parse(pipKey) as DeskPipMedia });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [covered, media.tabId, box.x, box.y, box.width, box.height, pipKey]);
  // (Layout effects, so the sidebar's card — the whole sidebar back — takes the picture after this lets it go.)
  useLayoutEffect(
    () => () => {
      nativeApi()?.setMediaPreview(null);
      nativeApi()?.setDeskPip(null);
    },
    [],
  );
  // The desk knows where it floats: a cover over it waits for its picture to come down.
  useLayoutEffect(() => {
    const stage = stageBox();
    if (engine === null || stage === null) return;
    engine.setFloat({ x: box.x - stage.left, y: box.y - stage.top, w: box.width, h: box.height }, !covered);
  }, [engine, covered, box.x, box.y, box.width, box.height]);
  useLayoutEffect(() => () => engine?.setFloat(null), [engine]);

  // The pip view's word: a control to run, or a press to move the player by.
  const latest = useRef({ media, box, size });
  latest.current = { media, box, size };
  useEffect(() => {
    const api = nativeApi();
    if (api === null) return;
    return api.onDeskPipInput((input) => {
      const { media: playing, box: from, size: area } = latest.current;
      if (input.type === "control") {
        if (input.control.type === "focus" && showOnDesk(playing.tabId)) return;
        void useAppStore.getState().controlMedia(playing.tabId, input.control);
        return;
      }
      // Held: the drag layer has the pointer until the button comes up, wherever it goes.
      api.setDragCapture("grabbing");
      let moved = false;
      const off = api.onDragSample((sample) => {
        if (sample.phase === "move") {
          if (!moved && Math.hypot(sample.x - input.x, sample.y - input.y) < PIP_SLOP) return;
          moved = true;
          setHeld(clampBox({ ...from, x: from.x + sample.x - input.x, y: from.y + sample.y - input.y }, area));
          return;
        }
        off();
        api.setDragCapture(null);
        if (moved) {
          const end = clampBox({ ...from, x: from.x + sample.x - input.x, y: from.y + sample.y - input.y }, area);
          useNowPlaying.getState().placePip({ x: end.x / area.width, y: end.y / area.height });
        }
        setHeld(null);
      });
    });
  }, []);

  return createPortal(
    <div
      className="desk-pip-backdrop"
      data-testid="desk-pip"
      data-tab-id={media.tabId}
      // What lies over it: something the shell raised over the window, or a cover on the desk.
      data-covered={raised ? "raised" : view?.floatCovered === true ? "cover" : undefined}
      data-pending={leaving ? "" : undefined}
      data-held={held !== null ? "" : undefined}
      aria-hidden="true"
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    />,
    document.body,
  );
}

/* ----------------------------- the rail's buttons ----------------------------- */

/** The bars' shape, tallest second, as a sound meter's. */
const BAR_SHAPE = [0.62, 1, 0.78, 0.9];

/**
 * The bars move with the page's measured loudness; with none to be had (a
 * protected stream, or a capture that hears nothing though Chromium says it
 * sounds), they move as sound would.
 */
function useLevelBars(media: BrowserMediaInfo, button: React.RefObject<HTMLButtonElement | null>, bars: React.RefObject<Array<HTMLElement | null>>): void {
  useEffect(() => {
    if (!media.playing) return;
    const api = nativeApi();
    let target: number | null = 0;
    let shown = 0;
    let flatSince = performance.now();
    const off = api?.onMediaLevel((next) => {
      if (next.tabId !== media.tabId) return;
      target = next.level;
      if (next.level !== 0) flatSince = performance.now();
      if (button.current !== null) button.current.dataset["level"] = next.level === null ? "unknown" : String(next.level);
    });
    let frame = 0;
    const draw = (now: number): void => {
      const suggested = target === null || (target === 0 && media.audible && now - flatSince > 1_500);
      shown += ((target ?? 0) - shown) * 0.35;
      bars.current.forEach((bar, index) => {
        if (bar === null) return;
        const wobble = 0.5 + 0.5 * Math.sin(now / (150 + index * 41) + index * 1.7);
        const height = suggested ? 0.28 + 0.5 * wobble : Math.max(0.14, Math.min(1, shown * BAR_SHAPE[index]! * (0.78 + 0.3 * wobble)));
        bar.style.transform = `scaleY(${height.toFixed(3)})`;
      });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      off?.();
      cancelAnimationFrame(frame);
    };
  }, [media.playing, media.tabId, media.audible, button, bars]);
}

function RailMediaButton({ media }: { media: BrowserMediaInfo }) {
  const controlMedia = useAppStore((state) => state.controlMedia);
  const button = useRef<HTMLButtonElement>(null);
  const bars = useRef<Array<HTMLElement | null>>([]);
  useLevelBars(media, button, bars);
  const [open, setOpen] = useState(false);
  const timer = useRef(0);
  const rateOpen = useRef(false);
  const card = useRef<HTMLDivElement | null>(null);
  const title = media.title || media.tabTitle || (media.hasVideo ? "Video" : "Audio");
  // The pointer on the button or its card keeps the card; off both, it goes a moment after (unless a rate is being set).
  const hover = useCallback((over: boolean): void => {
    window.clearTimeout(timer.current);
    if (over) timer.current = window.setTimeout(() => setOpen(true), card.current === null ? CARD_OPEN_MS : 0);
    else if (!rateOpen.current)
      timer.current = window.setTimeout(() => {
        if (button.current?.matches(":hover") !== true && card.current?.matches(":hover") !== true) setOpen(false);
      }, CARD_LINGER_MS);
  }, []);
  // Heard from the elements themselves: the card is a portal into the desk, and React's enter and leave across it
  // went unheard as the pointer left for the desk.
  useEffect(() => {
    const el = button.current;
    if (el === null) return;
    const enter = (): void => hover(true);
    const leave = (): void => hover(false);
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
    };
  }, [hover]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // The rate's popup open holds the card (the pointer is then over a popup of the body's, not the card): any close
  // already on its way is called off. Closed, the card may go. One function throughout — the card's rate control
  // hears it as closed and open again whenever it changes.
  const rateChanged = useCallback(
    (isOpen: boolean): void => {
      rateOpen.current = isOpen;
      if (isOpen) window.clearTimeout(timer.current);
      else hover(false);
    },
    [hover],
  );
  return (
    <div className="rail-media">
      <button
        ref={button}
        type="button"
        className="rail-media-button"
        data-testid={`rail-media-${media.tabId}`}
        data-playing={media.playing || undefined}
        aria-label={`${media.playing ? "Pause" : "Play"} ${title}`}
        title={title}
        onClick={() => void controlMedia(media.tabId, { type: "playPause" })}
      >
        {media.playing ? (
          <span className="rail-media-bars" aria-hidden="true">
            {BAR_SHAPE.map((_, index) => (
              <i
                key={index}
                ref={(el) => {
                  bars.current[index] = el;
                }}
              />
            ))}
          </span>
        ) : (
          <Play aria-hidden="true" />
        )}
      </button>
      {open ? (
        <RailMediaCard
          media={media}
          anchor={button}
          cardRef={card}
          onHover={hover}
          onRateOpen={rateChanged}
        />
      ) : null}
    </div>
  );
}

/**
 * Beside the rail at its button, over the desk: the media stack's card, all
 * its controls out. A cover (CARD_COVER), so the pages under it give way
 * first, and it shows once they have.
 */
function RailMediaCard({
  media,
  anchor,
  cardRef,
  onHover,
  onRateOpen,
}: {
  media: BrowserMediaInfo;
  anchor: React.RefObject<HTMLButtonElement | null>;
  cardRef: React.RefObject<HTMLDivElement | null>;
  onHover(over: boolean): void;
  onRateOpen(open: boolean): void;
}) {
  const engine = useDeskEngine();
  const view = useDeskView(engine);
  const card = cardRef;
  // Its own: moving from one button straight to the next, the card closing still holds its cover a moment.
  const cover = `${CARD_COVER}:${media.tabId}`;
  const [place, setPlace] = useState<{ left: number; bottom: number } | null>(null);
  const stage = document.querySelector<HTMLElement>(".desk-stage");
  useLayoutEffect(() => {
    const at = anchor.current?.getBoundingClientRect();
    const box = stage?.getBoundingClientRect();
    if (at === undefined || box === undefined) return;
    // Its foot level with the button's, as far down as the desk goes.
    setPlace({ left: Math.max(PIP_GAP, at.right - box.left + PIP_GAP), bottom: Math.max(PIP_GAP, box.bottom - at.bottom) });
  }, [anchor, stage]);
  useLayoutEffect(() => {
    const el = card.current;
    if (engine === null || el === null || place === null) return;
    const measure = (): void => engine.setCover(cover, { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [engine, place, card, cover]);
  useLayoutEffect(() => () => engine?.setCover(cover, null), [engine, cover]);
  // The rate's popup (MediaCard's, in the body, above the card) is a cover of its own while it is open.
  const [rateUp, setRateUp] = useState(false);
  const rateChanged = useCallback(
    (tabId: string | null): void => {
      setRateUp(tabId !== null);
      onRateOpen(tabId !== null);
    },
    [onRateOpen],
  );
  useLayoutEffect(() => {
    const popup = rateUp ? document.querySelector<HTMLElement>('[data-testid="media-rate-card"]') : null;
    const box = stage?.getBoundingClientRect();
    if (engine === null || popup === null || box === undefined) return;
    const rateCover = `${cover}:rate`;
    const measure = (): void => {
      const at = popup.getBoundingClientRect();
      engine.setCover(rateCover, { x: at.left - box.left, y: at.top - box.top, w: at.width, h: at.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(popup);
    return () => {
      observer.disconnect();
      engine.setCover(rateCover, null);
    };
  }, [engine, rateUp, cover, stage]);
  useEffect(() => {
    const el = card.current;
    if (el === null) return;
    const enter = (): void => onHover(true);
    const leave = (): void => onHover(false);
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
    };
  }, [card, onHover, place]);
  if (stage === null || place === null) return null;
  const shown = view?.clearCovers.has(cover) === true;
  return createPortal(
    <div
      ref={card}
      className="rail-media-card no-drag"
      data-testid="rail-media-card"
      data-shown={shown ? "" : undefined}
      style={{ left: place.left, bottom: place.bottom, width: CARD_W }}
    >
      <MediaCard
        media={media}
        index={0}
        showVideo={false}
        previewEnabled={false}
        stackEngaged
        expanded
        exiting={false}
        closePopovers={false}
        onEngage={NO_ENGAGE}
        onRateOpen={rateChanged}
      />
    </div>,
    stage,
  );
}
