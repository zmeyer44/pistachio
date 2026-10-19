/**
 * The faces on the host's desk (docs/live-share.md §1): one bubble per
 * person in the room, the host's own among them, stacked at the top
 * trailing corner of the stage; dragged, they follow the pointer and settle
 * on the edge they were let go nearest (face-dock.ts). Hovering a guest's
 * face shows its controls: mute them for the host alone, or remove them from
 * the share. They stay while the host is away: the call goes on.
 */

import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { UserX, Volume2, VolumeX } from "lucide-react";
import { FaceStack } from "@pistachio/live-share/react";
import type { LiveParticipant } from "@pistachio/live-share/room";
import type { LiveRect } from "@pistachio/shell-contracts/live-share";
import { DEFAULT_FACE_DOCK, dockPlacement, nearestDock, type FaceDock } from "./face-dock";

export interface HostFacesProps {
  participants: readonly LiveParticipant[];
  /** The stage they sit on the edges of (window px). */
  stage: LiveRect;
  /** Guests the host has muted for themself. */
  muted: ReadonlySet<string>;
  onMute(identity: string, muted: boolean): void;
  onRemove(identity: string): void;
  /** A drag began or ended: the window keeps the pointer while it lasts, wherever the pointer goes. */
  onDragging(dragging: boolean): void;
}

interface Grab {
  pointerId: number;
  /** Where in the stack it was taken, px. */
  dx: number;
  dy: number;
  width: number;
  height: number;
}

function place(element: HTMLElement, stage: LiveRect, dock: FaceDock): void {
  const at = dockPlacement(stage, dock);
  element.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px) translate(${String(at.shiftX * 100)}%, ${String(at.shiftY * 100)}%)`;
}

export function HostFaces({ participants, stage, muted, onMute, onRemove, onDragging }: HostFacesProps) {
  const [dock, setDock] = useState<FaceDock>(DEFAULT_FACE_DOCK);
  const ref = useRef<HTMLDivElement>(null);
  const grab = useRef<Grab | null>(null);

  useLayoutEffect(() => {
    if (ref.current !== null && grab.current === null) place(ref.current, stage, dock);
  }, [stage, dock]);

  const down = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const element = ref.current;
    if (element === null || event.button !== 0 || (event.target as Element).closest("button") !== null) return;
    event.preventDefault();
    const box = element.getBoundingClientRect();
    grab.current = { pointerId: event.pointerId, dx: event.clientX - box.left, dy: event.clientY - box.top, width: box.width, height: box.height };
    element.setPointerCapture(event.pointerId);
    element.dataset["dragging"] = "";
    onDragging(true);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const taken = grab.current;
    if (taken === null || event.pointerId !== taken.pointerId || ref.current === null) return;
    ref.current.style.transform = `translate(${(event.clientX - taken.dx).toFixed(1)}px, ${(event.clientY - taken.dy).toFixed(1)}px)`;
  };
  const up = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const taken = grab.current;
    const element = ref.current;
    if (taken === null || event.pointerId !== taken.pointerId || element === null) return;
    grab.current = null;
    delete element.dataset["dragging"];
    const next = nearestDock(stage, event.clientX - taken.dx + taken.width / 2, event.clientY - taken.dy + taken.height / 2);
    // Placed now (it eases there): the same dock again renders nothing new.
    place(element, stage, next);
    setDock(next);
    onDragging(false);
  };

  const direction = dockPlacement(stage, dock).direction;
  return (
    <div
      ref={ref}
      className="live-host-faces"
      data-live-interactive=""
      data-edge={dock.edge}
      data-testid="live-host-faces"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
    >
      <FaceStack
        participants={participants}
        direction={direction}
        renderControls={(participant) => {
          if (participant.isLocal) return undefined;
          const silenced = muted.has(participant.identity);
          return (
            <>
              <button
                type="button"
                className="live-host-face-control"
                onClick={() => onMute(participant.identity, !silenced)}
                title={silenced ? `Hear ${participant.name}` : `Mute ${participant.name} for you`}
                aria-label={silenced ? `Hear ${participant.name}` : `Mute ${participant.name} for you`}
                aria-pressed={silenced}
              >
                {silenced ? <VolumeX /> : <Volume2 />}
              </button>
              <button
                type="button"
                className="live-host-face-control"
                data-danger=""
                onClick={() => onRemove(participant.identity)}
                title={`Remove ${participant.name}`}
                aria-label={`Remove ${participant.name}`}
              >
                <UserX />
              </button>
            </>
          );
        }}
      />
    </div>
  );
}
