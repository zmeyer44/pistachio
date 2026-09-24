import { AudioLines, CircleAlert } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  MIN_PLAYBACK_RATE,
  MAX_PLAYBACK_RATE,
  type BrowserMediaInfo,
  type MediaControl,
  type ReadAloudStatus,
} from "@pistachio/shell-contracts/media";
import {
  Back15,
  ChevronUp,
  ExternalLink,
  Forward15,
  Gauge,
  Highlighter,
  Music2,
  Pause,
  PictureInPicture2,
  Play,
  RotateBack,
  SkipBack,
  SkipForward,
  Video,
  Volume2,
  VolumeX,
  X,
  type MediaIcon,
} from "./media-icons";
import { Favicon } from "./Favicon";
import { displayHost } from "../lib/url";
import { useChromeTabs } from "../chrome/tabs";
import {
  orderMediaStack,
  READ_ALOUD_LINGER_MS,
  readAloudFinished,
} from "../lib/media-stack";
import { useMediaPresence } from "./useMediaPresence";
import { useAppStore } from "../store";
import { nativeApi } from "../api";
import { useSurface } from "../surface";

/** How far the card's back / forward buttons move the playhead. */
const SEEK_STEP_SECONDS = 15;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const remainder = whole % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`
    : `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function projectedPosition(media: BrowserMediaInfo, now: number): number {
  const elapsed = media.playing
    ? (Math.max(0, now - media.updatedAt) / 1_000) * media.playbackRate
    : 0;
  return Math.min(
    media.duration ?? Number.POSITIVE_INFINITY,
    Math.max(0, media.position + elapsed),
  );
}

function MediaButton({
  label,
  icon: Icon,
  onClick,
  disabled = false,
  pressed,
  testId,
  primary = false,
}: {
  label: string;
  icon: MediaIcon;
  onClick(): void;
  disabled?: boolean;
  /** A toggle's state; leave unset for a plain action. */
  pressed?: boolean;
  testId?: string;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      data-testid={testId}
      className="media-control"
      data-primary={primary || undefined}
      onClick={onClick}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

function VideoMiniView({
  tabId,
  enabled,
}: {
  tabId: string;
  enabled: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const surface = useSurface();

  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || element === null) {
      nativeApi()?.setMediaPreview(null);
      return;
    }

    let frame = 0;
    let followMotionUntil = performance.now() + 420;
    const report = (): void => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        nativeApi()?.setMediaPreview(null);
        return;
      }
      nativeApi()?.setMediaPreview({
        tabId,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
      // Compact-sidebar reveal changes position through a transform, which
      // ResizeObserver does not report. Follow that short motion so the live
      // native video stays visually welded to its sidebar card.
      if (performance.now() < followMotionUntil)
        frame = requestAnimationFrame(report);
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(report);
    };
    const followMotion = (): void => {
      followMotionUntil = performance.now() + 420;
      schedule();
    };

    report();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    observer.observe(document.documentElement);
    const sidebar = element.closest(".sidebar-motion-pane");
    const card = element.closest(".media-card-slot");
    const stack = element.closest(".media-stack");
    sidebar?.addEventListener("transitionrun", followMotion);
    sidebar?.addEventListener("transitionend", schedule);
    card?.addEventListener("transitionrun", followMotion);
    card?.addEventListener("transitionend", schedule);
    stack?.addEventListener("transitionrun", followMotion);
    stack?.addEventListener("media-stack-motion", followMotion);
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      sidebar?.removeEventListener("transitionrun", followMotion);
      sidebar?.removeEventListener("transitionend", schedule);
      card?.removeEventListener("transitionrun", followMotion);
      card?.removeEventListener("transitionend", schedule);
      stack?.removeEventListener("transitionrun", followMotion);
      stack?.removeEventListener("media-stack-motion", followMotion);
      window.removeEventListener("resize", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
      nativeApi()?.setMediaPreview(null);
    };
  }, [enabled, tabId]);

  return (
    <div
      ref={ref}
      className="media-video-viewport"
      data-testid={`media-video-${tabId}`}
      aria-hidden="true"
    >
      {/* A DOM preview sits in the stack's own layer, so a menu over it covers it. */}
      {surface.kind === "stream" ? surface.renderMediaPreview?.(tabId) : null}
    </div>
  );
}

/** `1` → "1x", `1.5` → "1.5x". */
function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}x`;
}

/** Fixed-width trigger with a keyboard-accessible speed slider above the cards. */
function RateControl({
  rate,
  onChange,
  onOpenChange,
  closeRequested,
}: {
  rate: number;
  onChange(rate: number): void;
  onOpenChange(open: boolean): void;
  closeRequested: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const dialogId = useId();
  const shown = draft ?? rate;
  const close = useCallback(() => {
    setOpen(false);
    setDraft(null);
  }, []);

  useEffect(() => {
    if (closeRequested) close();
  }, [closeRequested, close]);
  useEffect(() => {
    if (draft !== null && Math.abs(rate - draft) < 0.001) setDraft(null);
  }, [rate, draft]);
  useLayoutEffect(() => {
    if (!open) return;
    onOpenChange(true);
    return () => onOpenChange(false);
  }, [open, onOpenChange]);
  useLayoutEffect(() => {
    if (!open) return;
    sliderRef.current?.focus({ preventScroll: true });
    let frame = 0;
    const position = () => {
      const trigger = triggerRef.current;
      const popup = popupRef.current;
      if (!trigger || !popup) return;
      const bounds = trigger.getBoundingClientRect();
      const stack = trigger.closest(".media-stack")?.getBoundingClientRect();
      const width = Math.min(270, (stack?.width ?? 280) - 12);
      popup.style.width = `${width}px`;
      popup.style.left = `${Math.max(8, Math.min(stack ? stack.left + 6 : bounds.left, window.innerWidth - width - 8))}px`;
      const above = bounds.top - popup.offsetHeight - 8;
      popup.style.top = `${Math.max(8, Math.min(above >= 8 ? above : bounds.bottom + 8, window.innerHeight - popup.offsetHeight - 8))}px`;
      frame = requestAnimationFrame(position);
    };
    position();
    const outside = (event: PointerEvent) => {
      if (
        !popupRef.current?.contains(event.target as Node) &&
        !triggerRef.current?.contains(event.target as Node)
      )
        close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [open, close]);

  const apply = (next: number) => {
    setDraft(next);
    onChange(next);
  };
  return (
    <div className="media-rate" data-open={open || undefined}>
      <button
        ref={triggerRef}
        type="button"
        className="media-rate-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? dialogId : undefined}
        aria-label={`Playback speed: ${formatRate(shown)}`}
        title="Playback speed"
        data-testid="media-rate-trigger"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span>{formatRate(shown)}</span>
        <ChevronUp aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={popupRef}
              id={dialogId}
              className="media-rate-card no-drag"
              role="dialog"
              aria-label="Playback speed"
              data-testid="media-rate-card"
              onBlur={(event) => {
                if (
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  ) &&
                  event.relatedTarget !== triggerRef.current
                )
                  close();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  close();
                  triggerRef.current?.focus({ preventScroll: true });
                }
              }}
            >
              <div className="media-rate-heading">
                <Gauge aria-hidden="true" />
                <div>
                  <output aria-live="off">{formatRate(shown)}</output>
                  <span>
                    {shown === 1 ? "Normal playback speed" : "Playback speed"}
                  </span>
                </div>
                <MediaButton
                  label="Reset playback speed to 1x"
                  icon={RotateBack}
                  onClick={() => apply(1)}
                />
              </div>
              <input
                ref={sliderRef}
                type="range"
                min={MIN_PLAYBACK_RATE}
                max={MAX_PLAYBACK_RATE}
                step={0.25}
                value={shown}
                aria-label="Playback speed"
                aria-valuetext={`${formatRate(shown)}${shown === 1 ? ", normal speed" : ""}`}
                className="media-speed-slider"
                style={
                  {
                    "--media-speed-fill": `${((shown - MIN_PLAYBACK_RATE) / (MAX_PLAYBACK_RATE - MIN_PLAYBACK_RATE)) * 100}%`,
                  } as CSSProperties
                }
                onChange={(event) => apply(Number(event.currentTarget.value))}
              />
              <div className="media-speed-bounds" aria-hidden="true">
                <span>0.25x</span>
                <span>1x</span>
                <span>2x</span>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function MediaArtwork({
  media,
  site,
}: {
  media: BrowserMediaInfo;
  site: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [media.artworkUrl]);
  return (
    <span className="media-artwork">
      {media.artworkUrl && !failed ? (
        <img
          src={media.artworkUrl}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : media.hasVideo ? (
        <Video aria-hidden="true" />
      ) : (
        <Music2 aria-hidden="true" />
      )}
      <span
        className="media-source-favicon"
        data-testid={`media-source-favicon-${media.tabId}`}
        role="img"
        aria-label={site}
        title={site}
      >
        <Favicon src={media.faviconUrl} seed={site || media.title} />
      </span>
    </span>
  );
}

const MediaCard = memo(function MediaCard({
  media,
  index,
  showVideo,
  previewEnabled,
  stackEngaged,
  expanded,
  exiting,
  closePopovers,
  onEngage,
  onRateOpen,
}: {
  media: BrowserMediaInfo;
  index: number;
  showVideo: boolean;
  previewEnabled: boolean;
  stackEngaged: boolean;
  expanded: boolean;
  exiting: boolean;
  closePopovers: boolean;
  onEngage(tabId: string): void;
  onRateOpen(tabId: string | null): void;
}) {
  const controlMedia = useAppStore((state) => state.controlMedia);
  const [clock, setClock] = useState(Date.now);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const seekDraftRef = useRef<number | null>(null);
  const rateOpenChanged = useCallback(
    (open: boolean) => onRateOpen(open ? media.tabId : null),
    [onRateOpen, media.tabId],
  );
  useEffect(() => {
    setClock(Date.now());
    if (!media.playing || exiting) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [media.playing, exiting]);

  const finished = readAloudFinished(media);
  useEffect(() => {
    if (!finished || stackEngaged || exiting) return;
    const timer = window.setTimeout(
      () => void controlMedia(media.tabId, { type: "dismiss" }),
      READ_ALOUD_LINGER_MS,
    );
    return () => window.clearTimeout(timer);
  }, [
    finished,
    stackEngaged,
    exiting,
    media.tabId,
    media.updatedAt,
    controlMedia,
  ]);

  const run = (control: MediaControl) => {
    if (!exiting) void controlMedia(media.tabId, control);
  };
  const commitSeek = () => {
    const position = seekDraftRef.current;
    if (position === null) return;
    seekDraftRef.current = null;
    setSeekDraft(null);
    run({ type: "seek", position });
  };
  const position =
    seekDraft ?? projectedPosition(media, Math.max(clock, media.updatedAt));
  const listed = useChromeTabs().some(
    (candidate) => candidate.id === media.tabId,
  );
  const site = displayHost(media.tabUrl) || media.tabTitle;
  const title = media.title || media.tabTitle || "Media";
  const subtitle =
    media.artist ||
    media.album ||
    (media.followText !== null
      ? "Read aloud"
      : media.kind === "live"
        ? "Live stream"
        : media.hasVideo
          ? "Video"
          : "Audio");
  const utilities =
    listed || media.canPictureInPicture || media.followText !== null;
  const style = {
    "--media-index": index,
    "--media-expanded-height": utilities ? "142px" : "116px",
    "--media-progress": `${media.duration === null || media.duration === 0 ? 0 : Math.min(100, Math.max(0, (position / media.duration) * 100))}%`,
  } as CSSProperties;
  // A playlist keeps its track buttons; they flank the seeks as a pair so the
  // row stays symmetric when only one direction is on offer.
  const trackNav = media.canPrevious || media.canNext;
  const skip = (delta: number) =>
    run({
      type: "seek",
      position: Math.min(
        media.duration ?? Infinity,
        Math.max(0, position + delta),
      ),
    });

  return (
    <div
      className="media-card-slot"
      style={style}
      data-media-id={media.tabId}
      data-exiting={exiting || undefined}
      data-expanded={expanded || undefined}
      data-front={(index === 0 && !exiting) || undefined}
      data-video={showVideo || undefined}
    >
      <article
        className="media-card"
        data-playing={media.playing || undefined}
        data-video={showVideo || undefined}
        data-exiting={exiting || undefined}
        data-testid={`media-card-${media.tabId}`}
        aria-label={`${title} player`}
        inert={exiting}
      >
        {showVideo ? (
          <VideoMiniView
            tabId={media.tabId}
            enabled={previewEnabled && !exiting}
          />
        ) : null}
        <div className="media-card-main">
          <div
            className="media-identity"
            data-testid={`media-identity-${media.tabId}`}
          >
            <div className="media-dismiss">
              <MediaButton
                label="Dismiss media control"
                icon={X}
                onClick={() => run({ type: "dismiss" })}
              />
            </div>
            <button
              type="button"
              className="media-track-select"
              title={listed ? `Show ${title} in ${media.tabTitle}` : title}
              aria-label={
                listed
                  ? `Show ${title} in its tab`
                  : `Show controls for ${title}`
              }
              onClick={() =>
                listed ? run({ type: "focus" }) : onEngage(media.tabId)
              }
            >
              <MediaArtwork media={media} site={site} />
              <span className="media-metadata">
                <span className="media-title">{title}</span>
                <span className="media-subtitle">{subtitle}</span>
              </span>
            </button>
          </div>
          <MediaButton
            label={media.playing ? "Pause" : "Play"}
            icon={media.playing ? Pause : Play}
            primary
            testId={`media-play-${media.tabId}`}
            onClick={() => run({ type: "playPause" })}
          />
        </div>
        <div
          className="media-card-details"
          data-utilities={utilities || undefined}
          inert={!expanded || exiting}
        >
          {media.duration === null ? (
            <div className="media-live-line" aria-label="Live playback">
              <span />
              Live stream
            </div>
          ) : (
            <div className="media-scrub">
              <input
                className="media-progress"
                type="range"
                min={0}
                max={Math.max(0, media.duration)}
                step={0.1}
                value={position}
                disabled={!media.seekable}
                aria-label={`Seek ${title}`}
                onChange={(event) => {
                  const next = Number(event.currentTarget.value);
                  seekDraftRef.current = next;
                  setSeekDraft(next);
                }}
                onPointerUp={commitSeek}
                onPointerCancel={commitSeek}
                onBlur={commitSeek}
                onKeyUp={(event) => {
                  if (
                    [
                      "ArrowLeft",
                      "ArrowRight",
                      "Home",
                      "End",
                      "PageUp",
                      "PageDown",
                    ].includes(event.key)
                  )
                    commitSeek();
                }}
              />
              <div className="media-times">
                <span>{formatTime(position)}</span>
                <span>{formatTime(media.duration)}</span>
              </div>
            </div>
          )}
          <div className="media-actions" data-track-nav={trackNav || undefined}>
            {media.canSetRate && !exiting ? (
              <RateControl
                rate={media.playbackRate}
                onChange={(rate) => run({ type: "setRate", rate })}
                onOpenChange={rateOpenChanged}
                closeRequested={closePopovers}
              />
            ) : (
              <span />
            )}
            <div className="media-skip-controls">
              {trackNav ? (
                <MediaButton
                  label="Previous track"
                  icon={SkipBack}
                  disabled={!media.canPrevious}
                  onClick={() => run({ type: "previous" })}
                />
              ) : null}
              <MediaButton
                label={`Back ${SEEK_STEP_SECONDS} seconds`}
                icon={Back15}
                disabled={!media.seekable}
                testId={`media-back-${media.tabId}`}
                onClick={() => skip(-SEEK_STEP_SECONDS)}
              />
              <MediaButton
                label={`Forward ${SEEK_STEP_SECONDS} seconds`}
                icon={Forward15}
                disabled={!media.seekable}
                testId={`media-forward-${media.tabId}`}
                onClick={() => skip(SEEK_STEP_SECONDS)}
              />
              {trackNav ? (
                <MediaButton
                  label="Next track"
                  icon={SkipForward}
                  disabled={!media.canNext}
                  onClick={() => run({ type: "next" })}
                />
              ) : null}
            </div>
            <MediaButton
              label={media.muted ? "Unmute" : "Mute"}
              icon={media.muted ? VolumeX : Volume2}
              testId={`media-mute-${media.tabId}`}
              onClick={() => run({ type: "mute" })}
            />
          </div>
          {utilities ? (
            <div className="media-utility-controls">
              {media.followText !== null ? (
                <MediaButton
                  label={
                    media.followText === "on"
                      ? "Stop following the text"
                      : "Follow the text on the page"
                  }
                  icon={Highlighter}
                  pressed={media.followText === "on"}
                  testId={`media-follow-${media.tabId}`}
                  onClick={() =>
                    run({
                      type: "followText",
                      enabled: media.followText !== "on",
                    })
                  }
                />
              ) : null}
              {listed ? (
                <MediaButton
                  label="Show playing tab"
                  icon={ExternalLink}
                  onClick={() => run({ type: "focus" })}
                />
              ) : null}
              {media.canPictureInPicture ? (
                <MediaButton
                  label="Picture in Picture"
                  icon={PictureInPicture2}
                  onClick={() => run({ type: "pictureInPicture" })}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        {media.duration !== null ? (
          <div className="media-compact-progress" aria-hidden="true">
            <span />
          </div>
        ) : null}
      </article>
    </div>
  );
});

/** A "Read aloud" job in flight (or just failed), shown as a toast above the stack. */
function ReadAloudToast({ job }: { job: ReadAloudStatus }) {
  const cancelReadAloud = useAppStore((state) => state.cancelReadAloud);
  const failed = job.phase === "failed";
  const title = failed ? "Read aloud failed" : "Reading aloud…";
  const detail = failed
    ? (job.message ?? "The selection could not be spoken.")
    : job.sourceTitle || job.excerpt;
  return (
    <div
      className="media-toast"
      role="status"
      aria-live="polite"
      data-phase={job.phase}
      data-testid={`read-aloud-toast-${job.id}`}
    >
      <span className="media-toast-icon" aria-hidden="true">
        {failed ? <CircleAlert /> : <AudioLines />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-semibold text-gray-1000">
          {title}
        </div>
        <div className="truncate text-[10.5px] text-gray-700">{detail}</div>
      </div>
      <MediaButton
        label={failed ? "Dismiss" : "Cancel read aloud"}
        icon={X}
        testId={`read-aloud-cancel-${job.id}`}
        onClick={() => void cancelReadAloud(job.id)}
      />
    </div>
  );
}

/** A stable empty list: a selector returning a fresh `[]` would re-render on every publish. */
const EMPTY_TAB_IDS: readonly string[] = [];

const STACK_SLOT_H = 66;
const TOAST_H = 50;
const STACK_GAP = 6;
const STACK_MARGIN_BOTTOM = 6;

function videoHeight(sidebarWidth: number): number {
  return Math.max(96, Math.round(((sidebarWidth - 32) * 9) / 16));
}

function stackSlotHeight(
  media: BrowserMediaInfo[],
  sidebarWidth: number,
): number {
  return media[0]?.hasVideo === true
    ? videoHeight(sidebarWidth) + 16 + STACK_SLOT_H
    : STACK_SLOT_H;
}

/** The cards and toasts the stack draws: media playing somewhere other than the visible tabs. */
function useBackgroundMedia(): {
  media: BrowserMediaInfo[];
  readAloud: ReadAloudStatus[];
} {
  const allMedia = useAppStore((state) => state.media);
  const readAloud = useAppStore((state) => state.readAloud);
  const activeTabId = useAppStore(
    (state) => state.snapshot?.activeTabId ?? null,
  );
  const visibleTabIds = useAppStore(
    (state) => state.snapshot?.visibleTabIds ?? EMPTY_TAB_IDS,
  );
  const continuedVideoTabIds = useRef(new Set<string>());
  const visible = new Set(visibleTabIds);
  const known = new Set(allMedia.map((item) => item.tabId));
  for (const tabId of continuedVideoTabIds.current) {
    if (!known.has(tabId) || tabId === activeTabId || visible.has(tabId)) {
      continuedVideoTabIds.current.delete(tabId);
    }
  }
  const background = allMedia.filter((item) => {
    // A call is not a player: its only controls would deafen the person.
    if (item.call) return false;
    const foreground = item.tabId === activeTabId || visible.has(item.tabId);
    if (item.presenting || foreground) {
      if (item.hasVideo) continuedVideoTabIds.current.delete(item.tabId);
      return false;
    }
    if (!item.hasVideo) return true;
    // A video comes along only if it was being WATCHED as its tab went to the
    // background: playing, and with its sound on. A feed's muted autoplay
    // clip is scenery the person scrolled past, not a session to carry into
    // the sidebar — and it is the common case on a timeline. Muting from the
    // card afterwards keeps it: the entry is what this decides, not the stay.
    if (item.playing && !item.muted)
      continuedVideoTabIds.current.add(item.tabId);
    return continuedVideoTabIds.current.has(item.tabId);
  });
  return { media: orderMediaStack(background), readAloud };
}

/**
 * How much of the tab list's bottom the floating stack covers, so the list can
 * pad itself and its last rows can still scroll clear of the cards. Zero when
 * there is no eligible background media.
 */
export function useMediaStackInset(): number {
  const { media, readAloud } = useBackgroundMedia();
  const sidebarWidth = useAppStore((state) => state.sidebarWidth);
  if (media.length === 0 && readAloud.length === 0) return 0;
  const toasts =
    readAloud.length * TOAST_H + Math.max(0, readAloud.length - 1) * STACK_GAP;
  const slot = media.length > 0 ? stackSlotHeight(media, sidebarWidth) : 0;
  const gap = media.length > 0 && readAloud.length > 0 ? STACK_GAP : 0;
  return toasts + gap + slot + STACK_MARGIN_BOTTOM;
}

/**
 * Background media stack: the front card at the bottom, the others peeking
 * above it, and the whole column fanning upward on hover or keyboard focus
 * with every card fully controllable. The column is laid out bottom-up in
 * flow (see `.media-stack` in styles.css): the cards behind the front one
 * sit on its top edge whatever that card's height, so a live picture in
 * front keeps the rest in view instead of covering them. "Read aloud" jobs
 * wait as toasts in the same column until their clip becomes a card; once
 * that clip has played out, the card leaves like a toast too, after a short
 * linger that hovering or focusing the stack holds off.
 */
export function MediaStack() {
  const { media, readAloud } = useBackgroundMedia();
  const entries = useMediaPresence(media);
  const sidebarWidth = useAppStore((state) => state.sidebarWidth);
  const pinned = useAppStore(
    (state) => state.settings.layout.sidebar === "pinned",
  );
  const sidebarRevealed = useAppStore((state) => state.sidebarRevealed);
  // The footer's menus open upward over this stack. The video is a native
  // view above the page, so a menu can only get in front of it by the view
  // coming down; the card keeps its slot and the view returns on close.
  const footerMenuOpen = useAppStore((state) => state.footerMenusOpen > 0);
  // Likewise anything that paints over the sidebar itself: the address bar's
  // window-wide veil, the tab switcher, a context menu (it opens at the
  // pointer, the sidebar's rows included), the footer's status card, and the
  // first-run wizard. A modal over the PAGE — settings, a Glance, a site's
  // permission prompt — leaves the sidebar alone, so the video plays on.
  const sidebarCovered = useAppStore(
    (state) =>
      state.overlay === "url" ||
      state.overlay === "tab-switcher" ||
      state.overlay === "context-menu" ||
      state.overlay === "status" ||
      state.onboardingOpen,
  );
  const [hoveredVideoTabId, setHoveredVideoTabId] = useState<string | null>(
    null,
  );
  const [stackHovered, setStackHovered] = useState(false);
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [rateTabId, setRateTabId] = useState<string | null>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointer = useRef({ x: -1, y: -1 });
  const previousPositions = useRef(new Map<string, DOMRect>());
  const previousOrder = useRef<string[]>([]);

  useEffect(
    () => nativeApi()?.onMediaPreviewHoverChanged(setHoveredVideoTabId),
    [],
  );
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  useEffect(() => {
    // Native video can take pointer ownership between shell events. Reconcile
    // against the real hit target so a missed React leave never pins a card.
    const moved = (event: PointerEvent) => {
      const stack = stackRef.current;
      if (!stack?.contains(event.target as Node)) {
        setStackHovered(false);
        setHoveredCardId(null);
      }
      if (!stack?.matches(":has(:focus-visible)")) setFocusedCardId(null);
    };
    document.addEventListener("pointermove", moved, { passive: true });
    return () => document.removeEventListener("pointermove", moved);
  }, []);
  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    const slots = [...stack.querySelectorAll<HTMLElement>(".media-card-slot")];
    const order = slots.map((slot) => slot.dataset["mediaId"]!);
    const reordered =
      order.length === previousOrder.current.length &&
      order.every((id) => previousOrder.current.includes(id)) &&
      order.some((id, i) => id !== previousOrder.current[i]);
    if (
      reordered &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      for (const slot of slots) {
        const previous = previousPositions.current.get(
          slot.dataset["mediaId"]!,
        );
        if (previous)
          slot.animate(
            [
              {
                translate: `0 ${previous.top - slot.getBoundingClientRect().top}px`,
              },
              { translate: "0 0" },
            ],
            {
              duration: 350,
              easing: "cubic-bezier(.22,1,.36,1)",
            },
          );
      }
      stack.dispatchEvent(new Event("media-stack-motion"));
    }
    previousOrder.current = order;
    const capture = () => {
      previousPositions.current = new Map(
        slots.map((slot) => [
          slot.dataset["mediaId"]!,
          slot.getBoundingClientRect(),
        ]),
      );
    };
    capture();
    stack.addEventListener("transitionend", capture);
    stack.addEventListener("animationend", capture);
    return () => {
      stack.removeEventListener("transitionend", capture);
      stack.removeEventListener("animationend", capture);
    };
  });

  useLayoutEffect(() => {
    if (
      focusedCardId === null ||
      media.some((item) => item.tabId === focusedCardId)
    )
      return;
    setFocusedCardId(null);
    const next = [
      ...(stackRef.current?.querySelectorAll<HTMLElement>(".media-card-slot") ??
        []),
    ].find((slot) =>
      media.some((item) => item.tabId === slot.dataset["mediaId"]),
    );
    next
      ?.querySelector<HTMLButtonElement>(".media-track-select")
      ?.focus({ preventScroll: true });
  }, [focusedCardId, media]);

  if (entries.length === 0 && readAloud.length === 0) return null;
  const hasVideo = entries.some((entry) => entry.showVideo);
  const slotHeight = hasVideo
    ? videoHeight(sidebarWidth) + 16 + STACK_SLOT_H
    : STACK_SLOT_H;
  const videoHovered =
    media[0]?.hasVideo && media[0]?.tabId === hoveredVideoTabId;
  const engaged =
    stackHovered ||
    focusedCardId !== null ||
    rateTabId !== null ||
    Boolean(videoHovered);
  const activeId =
    rateTabId ??
    focusedCardId ??
    hoveredCardId ??
    (videoHovered ? hoveredVideoTabId : null);

  return (
    <section
      className="media-stack-shell no-drag"
      aria-label="Background media"
      data-testid="media-stack"
    >
      {readAloud.length > 0 ? (
        <div className="media-toasts">
          {readAloud.map((job) => (
            <ReadAloudToast key={job.id} job={job} />
          ))}
        </div>
      ) : null}
      {entries.length > 0 ? (
        <div
          className="media-stack-slot"
          style={{ height: slotHeight, flexBasis: slotHeight }}
        >
          <div
            ref={stackRef}
            className="media-stack"
            data-expanded={engaged || undefined}
            data-video-hovered={videoHovered || undefined}
            style={
              {
                "--media-video-height": `${videoHeight(sidebarWidth)}px`,
              } as CSSProperties
            }
            onPointerEnter={(event) => {
              if (closeTimer.current) clearTimeout(closeTimer.current);
              setStackHovered(true);
              const slot = (event.target as HTMLElement).closest<HTMLElement>(
                ".media-card-slot",
              );
              if (slot && !slot.dataset["exiting"])
                setHoveredCardId(slot.dataset["mediaId"] ?? null);
            }}
            onPointerMove={(event) => {
              if (event.pointerType === "touch" || rateTabId || event.buttons)
                return;
              if (
                lastPointer.current.x === event.clientX &&
                lastPointer.current.y === event.clientY
              )
                return;
              lastPointer.current = { x: event.clientX, y: event.clientY };
              const slot = (event.target as HTMLElement).closest<HTMLElement>(
                ".media-card-slot",
              );
              if (slot && !slot.dataset["exiting"]) {
                setHoveredCardId(slot.dataset["mediaId"] ?? null);
                setFocusedCardId(null);
              }
            }}
            onPointerLeave={() => {
              closeTimer.current = setTimeout(() => {
                setStackHovered(false);
                setHoveredCardId(null);
                if (!stackRef.current?.matches(":has(:focus-visible)"))
                  setFocusedCardId(null);
              }, 140);
            }}
            onPointerDown={(event) => {
              setFocusedCardId(null);
              if (event.pointerType === "touch") {
                const slot = (event.target as HTMLElement).closest<HTMLElement>(
                  ".media-card-slot",
                );
                setHoveredCardId(slot?.dataset["mediaId"] ?? null);
                setStackHovered(true);
              }
            }}
            onFocus={(event) => {
              if (event.target.matches(":focus-visible"))
                setFocusedCardId(
                  event.target.closest<HTMLElement>(".media-card-slot")
                    ?.dataset["mediaId"] ?? null,
                );
            }}
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                )
              )
                setFocusedCardId(null);
            }}
          >
            {entries.map((entry, index) => (
              <MediaCard
                key={entry.media.tabId}
                media={entry.media}
                index={
                  entry.exitAt === null
                    ? entries
                        .slice(0, index)
                        .filter((item) => item.exitAt === null).length
                    : index
                }
                showVideo={entry.showVideo}
                exiting={entry.exitAt !== null}
                expanded={engaged && entry.media.tabId === activeId}
                previewEnabled={
                  (pinned || sidebarRevealed) &&
                  !footerMenuOpen &&
                  !sidebarCovered &&
                  rateTabId === null
                }
                closePopovers={
                  footerMenuOpen ||
                  sidebarCovered ||
                  !(pinned || sidebarRevealed)
                }
                stackEngaged={engaged}
                onEngage={setFocusedCardId}
                onRateOpen={setRateTabId}
              />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
