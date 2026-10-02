import { useCallback, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftToLine, X } from "lucide-react";
import type { DockDrop, DockDrops } from "../../lib/desk/geometry";
import type { DeskEngine } from "./desk-engine";

/** The rail stands this far inside the sidebar's column, as the engine lays its segments out (RAIL_INSET). */
const RAIL_INSET = 6;
/** Each segment's inset inside the rail. */
const SEGMENT_INSET = 4;

/**
 * What stands over the sidebar — the desk's dock — while a window is carried
 * near the desk's leading edge (docs/desk.md): a rail of glass sliding in
 * from the window's edge as the pointer nears the desk's, cut in two by a
 * hairline — Collapse above, Close below (the smaller, where the Dock keeps
 * its Trash). Nothing on it is coloured until a release would go somewhere:
 * then that segment fills with its colour, and its mark — filled, a little
 * larger — follows the pointer up and down the segment (`--pointer-y`,
 * written by the engine), so the target is always beside the hand. The
 * segment chosen stays lit as the rail slides away, so the choice is seen to
 * be taken.
 *
 * The engine lays the segments out in the stage's coordinates (the sidebar
 * is left of the stage, at negative x); the rail is drawn over the sidebar,
 * outside the desk, so it is put in the window at the stage's corner and
 * placed from there.
 */
export function DeskDropRail({
  engine,
  drops,
  stage,
  shown,
  drop,
  groupColor,
}: {
  engine: DeskEngine;
  drops: DockDrops;
  /** The group's colour (a `data-group-color` name): Collapse lights in it. */
  groupColor: string;
  /** The stage's corner in the window. */
  stage: { left: number; top: number };
  shown: boolean;
  drop: DockDrop | null;
}) {
  const attach = useCallback((el: HTMLDivElement | null) => engine.attachDrops(el), [engine]);
  const [chosen, setChosen] = useState<DockDrop | null>(null);
  // Held over a segment, it is the chosen one; let go (the rail leaving), it stays chosen until the next carry.
  if (shown && drop !== chosen) setChosen(drop);
  // No sidebar beside the desk: no rail.
  if (drops.away.w <= 0) return null;
  const top = drops.away.y;
  const height = drops.close.y + drops.close.h - top;
  const split = (drops.away.y + drops.away.h + drops.close.y) / 2 - top;
  const lit = shown ? drop : chosen;
  return createPortal(
    <div
      ref={attach}
      className="desk-drops tab-group-tone"
      data-group-color={groupColor}
      data-shown={shown ? "" : undefined}
      aria-hidden="true"
      style={{
        position: "fixed",
        left: stage.left + drops.away.x - RAIL_INSET,
        top: stage.top + top,
        width: drops.away.w + RAIL_INSET * 2,
        height,
      }}
    >
      <div className="desk-drop-rail" style={{ left: RAIL_INSET, width: drops.away.w }}>
        <DropSegment kind="away" top={SEGMENT_INSET} height={split - SEGMENT_INSET * 2} lit={lit === "away"} label="Collapse" railTop={top}>
          <ArrowLeftToLine />
        </DropSegment>
        <span className="desk-drop-divider" style={{ top: split }} />
        <DropSegment kind="close" top={split + SEGMENT_INSET} height={height - split - SEGMENT_INSET * 2} lit={lit === "close"} label="Close" railTop={top}>
          <X />
        </DropSegment>
      </div>
    </div>,
    document.body,
  );
}

function DropSegment({
  kind,
  top,
  height,
  lit,
  label,
  railTop,
  children,
}: {
  kind: DockDrop;
  top: number;
  height: number;
  lit: boolean;
  label: string;
  /** The rail's top in the stage: the pointer's height is the stage's. */
  railTop: number;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={`desk-drop-${kind}`}
      data-kind={kind}
      data-armed={lit ? "" : undefined}
      className="desk-drop"
      style={
        {
          top,
          height,
          "--segment-top": `${railTop + top}px`,
        } as React.CSSProperties
      }
    >
      <span className="desk-drop-mark">
        <span className="desk-drop-badge">{children}</span>
        <span className="desk-drop-label">{label}</span>
      </span>
    </div>
  );
}
