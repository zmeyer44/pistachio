import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { awayLine, type AwaySpaceInfo } from "@pistachio/shell-contracts/away";
import { bringSpaceBack } from "../../lib/away-actions";
import { awayTabsLabel } from "../../lib/away-spaces";
import { useAppStore } from "../../store";
import { FaviconCluster, type ClusterTab } from "../TabGroupRow";
import { Button } from "../ui/button";

/** The Away card's width: room for a name, the line under it and Bring back. */
const CARD_W = 300;
/** The rail's Away tile, which opens it (SpaceRail's AwayTile) — and takes the keyboard back when it goes. */
export const AWAY_OPENER = "[data-testid='rail-away']";

const NONE: readonly AwaySpaceInfo[] = [];

/** An away space's first tabs as its mark draws them (FaviconCluster): icons alone are kept of them, so each is seeded by the space's name. */
function clusterOf(space: AwaySpaceInfo): ClusterTab[] {
  return space.favicons.map((faviconUrl) => ({ title: space.title, url: "", faviconUrl }));
}

/**
 * The spaces that are away (docs/primitives.md §2), a desk side card like
 * the More card, the Stack's and the live share's (DeskSideCard: a cover,
 * the pages under it giving way to their stills; it goes on a press
 * elsewhere or Escape), opened by the rail's Away tile and standing beside
 * it, its foot level with the tile's. Each space as it was sent — its mark
 * on its colour, its name, when it is due back and who sent it (awayLine:
 * the shell's words, never the sender's), how many tabs it holds — and
 * Bring back, which brings it back in front and puts the card away.
 *
 * Opened from the keyboard (the tile holds it), the first Bring back takes
 * it, and the tile has it again when the card goes.
 */
export function AwayCard({
  ref,
  left,
  anchorBottom,
  stageHeight,
  shown,
  onClose,
}: {
  ref: React.Ref<HTMLDivElement>;
  /** Its left edge in the stage. */
  left: number;
  /** The foot of its tile, in the stage: the card's foot is level with it where it fits. */
  anchorBottom: number;
  stageHeight: number;
  shown: boolean;
  onClose(): void;
}) {
  const spaces = useAppStore((state) => state.snapshot?.awaySpaces ?? NONE);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (el === null) return;
    const measure = (): void => setHeight(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // None left away (the last brought back, here or by the clock): nothing for the card to show.
  useEffect(() => {
    if (spaces.length === 0) onClose();
  }, [spaces.length, onClose]);
  // The keyboard: in, when the tile that opened it holds it; back to the tile, when the card goes holding it.
  useEffect(() => {
    if (!shown) return;
    const opener = document.querySelector<HTMLElement>(AWAY_OPENER);
    if (opener !== null && document.activeElement === opener) cardRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [shown]);
  useLayoutEffect(
    () => () => {
      const el = cardRef.current;
      if (el !== null && el.contains(document.activeElement)) document.querySelector<HTMLElement>(AWAY_OPENER)?.focus();
    },
    [],
  );

  const now = Date.now();
  const maxHeight = Math.max(160, stageHeight - 16);
  const tall = Math.min(height, maxHeight);
  const top = Math.max(8, Math.min(anchorBottom - tall, stageHeight - tall - 8));
  return (
    <div
      ref={(el) => {
        cardRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref !== null && ref !== undefined) (ref as React.RefObject<HTMLDivElement | null>).current = el;
      }}
      role="dialog"
      aria-label="Spaces that are away"
      data-testid="away-card"
      data-shown={shown ? "" : undefined}
      className="desk-dock-menu away-card"
      style={{ left, top, width: CARD_W, maxHeight }}
    >
      <div className="away-card-head">
        <span>Away</span>
        <span className="away-card-count">{spaces.length}</span>
      </div>
      <ul className="away-card-list scroll-thin">
        {spaces.map((space) => (
          <li key={space.id} data-testid="away-space" data-group-id={space.id} data-group-color={space.color} data-waiting={space.waiting} className="away-card-row tab-group-tone">
            <FaviconCluster tabs={clusterOf(space)} />
            <span className="away-card-text">
              <span className="away-card-title" title={space.title}>
                {space.title}
              </span>
              <span className="away-card-line" data-testid="away-space-line">
                {awayLine(space, now)} · {awayTabsLabel(space.tabCount)}
              </span>
            </span>
            <Button
              variant="secondary"
              size="xs"
              data-testid="away-bring-back"
              aria-label={`Bring back ${space.title}`}
              // (A press leaves the keyboard where it was: a window's page.)
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                // It comes back in front: the card steps out of its way. (Refused — no room for it — the notice says so.)
                onClose();
                bringSpaceBack(space.id);
              }}
            >
              Bring back
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
