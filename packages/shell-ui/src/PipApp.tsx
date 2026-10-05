/**
 * The desk's floating player on the rail (docs/desk.md, "Now playing"): a
 * utility chrome view of its own (main/chrome-view.ts, id "pip"), over the
 * tab's own view, which main shows in the player's box presenting only its
 * video (the media preview). A video is a page of main's, which nothing the
 * shell draws can lie over, so this view is the player's face: nothing at
 * all over the picture until the pointer comes onto it (or the media is
 * paused), then its controls over it, as a browser's picture in picture has
 * them. The view stands out from the picture all round (DESK_PIP_OUTSET),
 * a clear ring its edges and corners straddle the picture's border on, as a
 * desk window's do. A press on the picture away from the controls, or on an
 * edge, goes back to the shell, which moves or resizes the player while the
 * button is held (components/desk/DeskNowPlaying.tsx; the press's moves stay
 * with this view, and main relays them: main/desk-pip-press.ts); a control
 * goes back to it too, to be run as the media stack's are.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Maximize2 } from "lucide-react";
import { DESK_PIP_OUTSET, type DeskPipEdge, type DeskPipFrame } from "@pistachio/shell-contracts/desk";
import type { MediaControl } from "@pistachio/shell-contracts/media";
import { nativeApi } from "./api";
import { Back15, Forward15, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX, X, type MediaIcon } from "./components/media-icons";
import { PIP_EDGE_CURSORS } from "./lib/desk/pip-box";
import { formatTime, projectedPosition } from "./lib/media-stack";

/** How far the player's back and forward buttons move the playhead, as the media stack's do. */
const SEEK_STEP_SECONDS = 15;
const SEEK_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/**
 * The edges and corners that resize the player, on the picture's box: each
 * over the whole ring outside it, and a little over the picture — less than
 * its controls stand in from its border.
 */
const EDGES: ReadonlyArray<{ edge: DeskPipEdge; style: CSSProperties }> = [
  { edge: "n", style: { top: -6, left: 8, right: 8, height: 9 } },
  { edge: "s", style: { bottom: -6, left: 8, right: 8, height: 9 } },
  { edge: "w", style: { left: -6, top: 8, bottom: 8, width: 9 } },
  { edge: "e", style: { right: -6, top: 8, bottom: 8, width: 9 } },
  { edge: "nw", style: { left: -6, top: -6, width: 14, height: 14 } },
  { edge: "ne", style: { right: -6, top: -6, width: 14, height: 14 } },
  { edge: "sw", style: { left: -6, bottom: -6, width: 14, height: 14 } },
  { edge: "se", style: { right: -6, bottom: -6, width: 14, height: 14 } },
];

export function PipApp() {
  const [frame, setFrame] = useState<DeskPipFrame | null>(null);

  useEffect(() => {
    const api = nativeApi();
    if (api === null) return;
    let active = true;
    let heard = false;
    void api.getDeskPip().then((next) => {
      // A change that arrived while this was in flight is the newer word.
      if (active && !heard) setFrame(next);
    });
    const off = api.onDeskPip((next) => {
      heard = true;
      setFrame(next);
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  if (frame === null) return null;
  return <PipFace frame={frame} />;
}

function PipButton({ label, icon: Icon, primary = false, disabled = false, testId, onClick }: { label: string; icon: MediaIcon; primary?: boolean; disabled?: boolean; testId?: string; onClick(): void }) {
  return (
    <button
      type="button"
      className="desk-pip-button"
      data-primary={primary || undefined}
      data-testid={testId}
      aria-label={label}
      title={label}
      disabled={disabled}
      // The page under the player keeps the keyboard.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

function PipFace({ frame }: { frame: DeskPipFrame }) {
  const { media, bounds } = frame;
  const [hovered, setHovered] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const seekDraftRef = useRef<number | null>(null);
  useEffect(() => {
    setClock(Date.now());
    if (!media.playing) return;
    const timer = window.setInterval(() => setClock(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [media.playing, media.updatedAt]);

  const send = (control: MediaControl): void => nativeApi()?.sendDeskPipInput({ type: "control", control });
  const position = seekDraft ?? projectedPosition(media, Math.max(clock, media.updatedAt));
  const skip = (delta: number): void => send({ type: "seek", position: Math.min(media.duration ?? Infinity, Math.max(0, position + delta)) });
  const commitSeek = (): void => {
    const next = seekDraftRef.current;
    if (next === null) return;
    seekDraftRef.current = null;
    setSeekDraft(null);
    send({ type: "seek", position: next });
  };
  const trackNav = media.canPrevious || media.canNext;
  const progress = media.duration === null || media.duration === 0 ? 0 : Math.min(100, Math.max(0, (position / media.duration) * 100));
  // A press to move the player by, or to resize it by from an edge: at its point in the window's coordinates,
  // where the shell moves it from (the view stands out from the picture by its ring).
  const grab = (event: React.PointerEvent, edge?: DeskPipEdge): void => {
    event.preventDefault();
    const x = bounds.x - DESK_PIP_OUTSET + event.clientX;
    const y = bounds.y - DESK_PIP_OUTSET + event.clientY;
    nativeApi()?.sendDeskPipInput(edge === undefined ? { type: "grab", x, y } : { type: "grab", x, y, edge });
  };

  return (
    <div
      className="desk-pip"
      onPointerEnter={() => setHovered(true)}
      // (A player that came back up under a still pointer hears no enter: a move over it is as good.)
      onPointerMove={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <div
        className="desk-pip-view"
        data-testid="desk-pip-view"
        data-tab-id={media.tabId}
        // Shown while the pointer is on it (its edges too), and while nothing plays: a still picture wants its play button.
        data-shown={hovered || !media.playing || seekDraft !== null ? "" : undefined}
        aria-label={`${media.title} player`}
        style={{ inset: DESK_PIP_OUTSET }}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as Element).closest("button, input") !== null) return;
          grab(event);
        }}
      >
        <div className="desk-pip-top">
          <PipButton label="Back to the desk" icon={PipExpand} testId="desk-pip-return" onClick={() => send({ type: "focus" })} />
          <span className="desk-pip-title">{media.title}</span>
          <PipButton label="Close the player" icon={X} testId="desk-pip-close" onClick={() => send({ type: "dismiss" })} />
        </div>
        <div className="desk-pip-middle">
          {trackNav ? <PipButton label="Previous track" icon={SkipBack} disabled={!media.canPrevious} onClick={() => send({ type: "previous" })} /> : null}
          <PipButton label={`Back ${String(SEEK_STEP_SECONDS)} seconds`} icon={Back15} disabled={!media.seekable} onClick={() => skip(-SEEK_STEP_SECONDS)} />
          <PipButton label={media.playing ? "Pause" : "Play"} icon={media.playing ? Pause : Play} primary testId="desk-pip-play" onClick={() => send({ type: "playPause" })} />
          <PipButton label={`Forward ${String(SEEK_STEP_SECONDS)} seconds`} icon={Forward15} disabled={!media.seekable} onClick={() => skip(SEEK_STEP_SECONDS)} />
          {trackNav ? <PipButton label="Next track" icon={SkipForward} disabled={!media.canNext} onClick={() => send({ type: "next" })} /> : null}
        </div>
        <div className="desk-pip-bottom">
          {media.duration === null ? (
            <span className="desk-pip-live">Live</span>
          ) : (
            <>
              <span className="desk-pip-time">{formatTime(position)}</span>
              <input
                className="desk-pip-progress"
                type="range"
                min={0}
                max={Math.max(0, media.duration)}
                step={0.1}
                value={position}
                disabled={!media.seekable}
                aria-label={`Seek ${media.title}`}
                style={{ "--desk-pip-progress": `${String(progress)}%` } as React.CSSProperties}
                onChange={(event) => {
                  const next = Number(event.currentTarget.value);
                  seekDraftRef.current = next;
                  setSeekDraft(next);
                }}
                onPointerUp={commitSeek}
                onPointerCancel={commitSeek}
                onBlur={commitSeek}
                // A key that moves it seeks at once, as the media stack's does.
                onKeyUp={(event) => {
                  if (SEEK_KEYS.has(event.key)) commitSeek();
                }}
              />
              <span className="desk-pip-time">{formatTime(media.duration)}</span>
            </>
          )}
          <PipButton label={media.muted ? "Unmute" : "Mute"} icon={media.muted ? VolumeX : Volume2} testId="desk-pip-mute" onClick={() => send({ type: "mute" })} />
        </div>
      </div>
      <div className="desk-pip-edges" aria-hidden="true" style={{ inset: DESK_PIP_OUTSET }}>
        {EDGES.map(({ edge, style }) => (
          <div
            key={edge}
            className="desk-pip-edge"
            data-edge={edge}
            data-testid={`desk-pip-edge-${edge}`}
            style={{ ...style, cursor: PIP_EDGE_CURSORS[edge] }}
            onPointerDown={(event) => {
              if (event.button === 0) grab(event, edge);
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** The media icons' size and weight for lucide's expand, which they have no glyph for. */
const PipExpand: MediaIcon = (props) => <Maximize2 strokeWidth={2.4} {...(props as object)} />;
