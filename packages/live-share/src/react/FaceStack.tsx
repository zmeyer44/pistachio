/**
 * The faces (docs/live-share.md §1): one bubble per person — their camera,
 * or their initial on their colour — ringed in their colour while they
 * speak, with a slashed mic while muted. `FaceStack` is a column (the
 * guest's trailing edge) or a row, and can fold to a small pill of initials.
 * Each bubble carries `data-face="<identity>"`, which is where a reaction
 * from that person rises from.
 */

import { ChevronDown, ChevronUp, MicOff } from "lucide-react";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import type { LiveParticipant } from "../room.js";

export interface FaceTileProps {
  participant: LiveParticipant;
  /** Extra controls shown over the bubble on hover (the host's mute, remove). */
  controls?: ReactNode;
  /** The name under the bubble: always, or only on hover (the default). */
  showName?: boolean;
}

function initialOf(name: string): string {
  const first = [...name.trim()][0];
  return first === undefined ? "?" : first.toLocaleUpperCase();
}

export function FaceTile({ participant, controls, showName = false }: FaceTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const camera = participant.camera;

  useEffect(() => {
    const video = videoRef.current;
    if (video === null || camera === null) return;
    camera.attach(video);
    return () => {
      camera.detach(video);
    };
  }, [camera]);

  const name = participant.isLocal ? `${participant.name} (you)` : participant.name;
  return (
    <div
      className="lv-face"
      data-face={participant.identity}
      data-speaking={participant.speaking && participant.micOn ? "" : undefined}
      data-camera={camera === null ? undefined : ""}
      data-self={participant.isLocal ? "" : undefined}
      data-connection={participant.connection}
      style={{ "--lv-face-color": participant.color } as CSSProperties}
      title={name}
    >
      <div className="lv-face-bubble">
        {camera === null ? (
          <span className="lv-face-initial">{initialOf(participant.name)}</span>
        ) : (
          <video ref={videoRef} className="lv-face-video" muted playsInline autoPlay />
        )}
      </div>
      {participant.micOn ? null : (
        <span className="lv-face-muted" aria-label="Muted">
          <MicOff aria-hidden="true" />
        </span>
      )}
      <span className="lv-face-name" data-shown={showName ? "" : undefined}>
        {name}
      </span>
      {controls === undefined ? null : <div className="lv-face-controls">{controls}</div>}
    </div>
  );
}

export interface FaceStackProps {
  participants: readonly LiveParticipant[];
  direction?: "column" | "row";
  /** Folded to a pill of initials. Uncontrolled (never folded) without `onCollapsedChange`. */
  collapsed?: boolean;
  onCollapsedChange?(collapsed: boolean): void;
  renderControls?(participant: LiveParticipant): ReactNode;
  className?: string;
}

/** Initials shown in the folded pill before "+n". */
const FOLDED_FACES = 3;

export function FaceStack({ participants, direction = "column", collapsed = false, onCollapsedChange, renderControls, className }: FaceStackProps) {
  const classes = ["lv-faces", className].filter(Boolean).join(" ");
  const folded = collapsed && onCollapsedChange !== undefined;
  const speaking = participants.some((p) => p.speaking && p.micOn);
  return (
    <div className={classes} data-direction={direction} data-collapsed={folded ? "" : undefined} aria-label="People">
      {onCollapsedChange === undefined ? null : (
        <button
          type="button"
          className="lv-faces-fold"
          aria-expanded={!folded}
          aria-label={folded ? "Show faces" : "Hide faces"}
          title={folded ? "Show faces" : "Hide faces"}
          onClick={() => onCollapsedChange(!folded)}
          data-speaking={folded && speaking ? "" : undefined}
        >
          {folded ? (
            <>
              <span className="lv-faces-mini">
                {participants.slice(0, FOLDED_FACES).map((p) => (
                  <span key={p.identity} className="lv-faces-mini-face" data-face={p.identity} style={{ "--lv-face-color": p.color } as CSSProperties}>
                    {initialOf(p.name)}
                  </span>
                ))}
              </span>
              {participants.length > FOLDED_FACES ? <span className="lv-faces-more">+{participants.length - FOLDED_FACES}</span> : null}
              <ChevronDown aria-hidden="true" className="lv-faces-chevron" />
            </>
          ) : (
            <ChevronUp aria-hidden="true" className="lv-faces-chevron" />
          )}
        </button>
      )}
      {folded ? null : (
        <div className="lv-faces-list">
          {participants.map((participant) => (
            <FaceTile key={participant.identity} participant={participant} controls={renderControls?.(participant)} />
          ))}
        </div>
      )}
    </div>
  );
}
