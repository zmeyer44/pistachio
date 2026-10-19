/**
 * The windows guests may use, outlined on the host's desk (docs/live-share.md
 * §1): a thin line in the colour of the guest using it, with their name, or
 * a quiet one saying guests can use it before anyone has. Which windows is
 * React's (it changes when the host allows one); where they are follows every
 * desk frame by ref, so a window being dragged takes its outline along
 * without a render.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { CursorPerson } from "@pistachio/live-share/react";
import type { LiveHostDeskFrame, LiveWindowUse } from "@pistachio/shell-contracts/live-share";
import type { LiveHostSession } from "./host-session";

export interface WindowOutlinesProps {
  session: LiveHostSession;
  /** The stage's size in this window, px: a frame's stage px are scaled to it. */
  size: { w: number; h: number };
  using: readonly LiveWindowUse[];
  people: ReadonlyMap<string, CursorPerson>;
}

/** The room the name's tab needs above a window, px. */
const LABEL_ROOM = 22;

/** The windows to outline, bottom to top. */
function outlined(frame: LiveHostDeskFrame | null): string[] {
  return frame === null ? [] : frame.windows.filter((window) => window.controllable && !window.minimized).map((window) => window.id);
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, index) => id === b[index]);

/** Each outline over its window's frame, the frame's stage px scaled to the stage's size here. */
function place(nodes: ReadonlyMap<string, HTMLDivElement>, size: { w: number; h: number }, frame: LiveHostDeskFrame | null): void {
  if (frame === null) return;
  const scale = frame.stage.w > 0 ? size.w / frame.stage.w : 1;
  for (const window of frame.windows) {
    const node = nodes.get(window.id);
    if (node === undefined) continue;
    node.style.transform = `translate(${(window.frame.x * scale).toFixed(1)}px, ${(window.frame.y * scale).toFixed(1)}px)`;
    node.style.width = `${(window.frame.w * scale).toFixed(1)}px`;
    node.style.height = `${(window.frame.h * scale).toFixed(1)}px`;
    // The name rides on the frame's top edge, outside it — inside when the window's top meets the stage's.
    node.toggleAttribute("data-inside", window.frame.y * scale < LABEL_ROOM);
  }
}

export function WindowOutlines({ session, size, using, people }: WindowOutlinesProps) {
  const [ids, setIds] = useState<string[]>(() => outlined(session.frame()));
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const sizeRef = useRef(size);

  useEffect(
    () =>
      session.onFrame((frame) => {
        const next = outlined(frame);
        setIds((previous) => (sameIds(previous, next) ? previous : next));
        place(nodes.current, sizeRef.current, frame);
      }),
    [session],
  );

  // A new outline, or a resized stage: placed from the latest frame now, not at the next one.
  useLayoutEffect(() => {
    sizeRef.current = size;
    place(nodes.current, size, session.frame());
  }, [session, ids, size]);

  return (
    <>
      {ids.map((id) => {
        const user = using.find((use) => use.windowId === id)?.identity;
        const person = user === undefined ? undefined : people.get(user);
        return (
          <div
            key={id}
            ref={(node) => {
              if (node === null) nodes.current.delete(id);
              else nodes.current.set(id, node);
            }}
            className="live-host-outline"
            data-window={id}
            data-used={person === undefined ? undefined : ""}
            style={person === undefined ? undefined : ({ "--live-outline-color": person.color } as CSSProperties)}
          >
            <span className="live-host-outline-label">{person === undefined ? "Guests can use" : person.name}</span>
          </div>
        );
      })}
    </>
  );
}
