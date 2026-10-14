import { Component, createRef, type ReactNode, type RefObject } from "react";
import { useAppStore } from "../../store";

/**
 * A space's way onto the rail and back (docs/double-sidebar.md §1): a Home
 * tab given a second window becomes a space, and its row in Today lifts and
 * flies up to its new tile — the row's content fading into the tile's
 * mosaic on the way — the tile held hidden until it lands; a space left
 * with one window goes back to Home, and its tile flies down into its Today
 * row (into its favorite's tile, or onto Home itself when Home is not the
 * view shown). The lab's `flight()`: a lift, then into place, ~560ms.
 *
 * WHEN is the snapshot's: a space is on the rail in one commit and not in the
 * one before (or the reverse). WHERE FROM is the DOM as it stood before that
 * commit — the row a graduating tab had in Today is gone after it, as is
 * the tile of a space that went back — so this is a class component, for
 * getSnapshotBeforeUpdate, the one moment both pictures exist: the old
 * boxes and copies are taken there, and the new ones in componentDidUpdate,
 * before the frame is painted. The ghost is plain DOM (copies of the row and
 * the tile, stripped of every id a live row is found by) in a layer over the
 * column; nothing of React's moves. Reduced motion: no flights.
 */

/** A space as the flights see it: its id and its tabs. */
export interface FlightSpace {
  id: string;
  tabIds: readonly string[];
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Plan {
  up: Array<{ id: string; from: Box; picture: HTMLElement; radius: number }>;
  down: Array<{ id: string; from: Box; picture: HTMLElement; tabIds: readonly string[] }>;
}

/** A flight's length (the lab's). */
const FLIGHT_MS = 560;
/** A tile's corner and a row's: what the ghost's corners go between. */
const TILE_RADIUS = 11;
const ROW_RADIUS = 8;

/** Attributes a copy must not carry: the shell, the desk and the specs find live rows and tiles by them. */
const LIVE_ATTRIBUTES = ["data-testid", "data-tab-id", "data-live-tab-id", "data-group-id", "data-flip-id", "data-row-kind", "data-rail-key", "data-rail-drop", "data-arriving", "data-landed", "id", "role", "tabindex", "aria-selected", "aria-current"];

/** A still copy of an element, for a ghost: nothing in it is found as the real thing, takes focus or the pointer. */
export function stillOf(el: HTMLElement): HTMLElement {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const node of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) for (const name of LIVE_ATTRIBUTES) node.removeAttribute(name);
  copy.inert = true;
  copy.style.transform = "";
  return copy;
}

function boxIn(root: HTMLElement, el: Element): Box {
  const at = root.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  return { x: box.left - at.left, y: box.top - at.top, w: box.width, h: box.height };
}

const esc = (value: string): string => CSS.escape(value);

/**
 * New spaces made by a drop on the rail's New space (chrome/shelf-drag.tsx,
 * since 2026-10-14): what was let go there was drawn as a tile going into
 * New space already, so the space's tile grows in where it stands (its
 * entrance) with no flight up from Today or a favorite's tile as well.
 * Forgotten after a while: a space that never came is not waited for.
 */
const droppedOnNew = new Set<string>();
const DROPPED_ON_NEW_MS = 3_000;

export function grownByDrop(groupId: string): void {
  droppedOnNew.add(groupId);
  window.setTimeout(() => droppedOnNew.delete(groupId), DROPPED_ON_NEW_MS);
}

/** Whether `groupId` came by a drop on New space (grownByDrop): no flight to wait for, the card turns to it at once. */
export function isGrownByDrop(groupId: string): boolean {
  return droppedOnNew.has(groupId);
}

export class SpaceFlights extends Component<{ spaces: readonly FlightSpace[]; reduced: boolean; rootRef: RefObject<HTMLElement | null> }> {
  private readonly layer = createRef<HTMLDivElement>();
  private readonly running = new Set<{ ghost: HTMLElement; animation: Animation }>();

  override getSnapshotBeforeUpdate(previous: Readonly<{ spaces: readonly FlightSpace[] }>): Plan | null {
    const root = this.props.rootRef.current;
    if (this.props.reduced || root === null || previous.spaces === this.props.spaces) return null;
    const before = new Set(previous.spaces.map((space) => space.id));
    const now = new Set(this.props.spaces.map((space) => space.id));
    const plan: Plan = { up: [], down: [] };
    for (const space of this.props.spaces) {
      if (before.has(space.id) || droppedOnNew.has(space.id)) continue;
      // Its row in Today (or its favorite's tile), as Home drew it a moment ago.
      for (const tabId of space.tabIds) {
        const row =
          root.querySelector<HTMLElement>(`[data-testid='home-view'] [role='tab'][data-tab-id='${esc(tabId)}']`) ??
          root.querySelector<HTMLElement>(`[data-testid='home-view'] [data-live-tab-id='${esc(tabId)}']`);
        if (row === null || row.getBoundingClientRect().width === 0) continue;
        const radius = Number.parseFloat(getComputedStyle(row).borderTopLeftRadius) || ROW_RADIUS;
        plan.up.push({ id: space.id, from: boxIn(root, row), picture: stillOf(row), radius });
        break;
      }
    }
    // Tabs a space on the rail holds now: a space gone whose tabs are there was merged into it (2026-10-14), and its tile
    // settled into that one as it was let go (SpaceRail's carry) — it has no way back to Home to fly.
    const onRail = new Set(this.props.spaces.flatMap((space) => space.tabIds));
    for (const space of previous.spaces) {
      if (now.has(space.id)) continue;
      if (space.tabIds.length > 0 && space.tabIds.every((tabId) => onRail.has(tabId))) continue;
      const tile = root.querySelector<HTMLElement>(`[data-testid='rail-space'][data-group-id='${esc(space.id)}']`);
      if (tile === null || tile.getBoundingClientRect().width === 0) continue;
      plan.down.push({ id: space.id, from: boxIn(root, tile), picture: stillOf(tile), tabIds: space.tabIds });
    }
    return plan.up.length === 0 && plan.down.length === 0 ? null : plan;
  }

  override componentDidUpdate(_props: unknown, _state: unknown, plan: Plan | null): void {
    const root = this.props.rootRef.current;
    if (plan === null || root === null) return;
    for (const flight of plan.up) {
      const tile = root.querySelector<HTMLElement>(`[data-testid='rail-space'][data-group-id='${esc(flight.id)}']`);
      if (tile === null) continue;
      // Its flight is its entrance: it does not grow in as well (`data-landed`, for good — taken away, the entrance
      // would play again as it is shown, a blink), and its box is read as it will stand, not at the entrance's 0.6.
      tile.dataset["landed"] = "";
      tile.dataset["arriving"] = "";
      const picture = stillOf(tile);
      this.fly(flight.from, boxIn(root, tile), [flight.picture, picture], "up", flight.radius, () => reveal(tile));
    }
    for (const flight of plan.down) {
      // Back into Home: its row in Today (or its favorite's tile), or, Home not shown, Home's own button.
      let dest: HTMLElement | null = null;
      for (const tabId of flight.tabIds) {
        dest =
          root.querySelector<HTMLElement>(`[data-testid='home-view'] [role='tab'][data-tab-id='${esc(tabId)}']`) ??
          root.querySelector<HTMLElement>(`[data-testid='home-view'] [data-live-tab-id='${esc(tabId)}']`);
        if (dest !== null) break;
      }
      // (Closed altogether — no tab of it left — it simply goes.)
      const tabs = useAppStore.getState().snapshot?.tabs ?? [];
      if (!flight.tabIds.some((tabId) => tabs.some((tab) => tab.id === tabId))) continue;
      const target = dest !== null && dest.getBoundingClientRect().width > 0 ? dest : root.querySelector<HTMLElement>("[data-testid='rail-home']");
      if (target === null) continue;
      const picture = stillOf(target);
      if (target === dest) target.dataset["arriving"] = "";
      const radius = Number.parseFloat(getComputedStyle(target).borderTopLeftRadius) || ROW_RADIUS;
      this.fly(flight.from, boxIn(root, target), [flight.picture, picture], "down", radius, () => reveal(target));
    }
  }

  override componentWillUnmount(): void {
    for (const flight of this.running) {
      flight.animation.cancel();
      flight.ghost.remove();
    }
    this.running.clear();
  }

  /**
   * One ghost from `from` to `to` (the column's coordinates): lifted a few
   * pixels and tilted a hair for the first fifth, then into place, its first
   * picture fading out as the second fades in (the lab's keyframes).
   */
  private fly(from: Box, to: Box, pictures: [HTMLElement, HTMLElement], way: "up" | "down", radius: number, done: () => void): void {
    const layer = this.layer.current;
    if (layer === null) {
      done();
      return;
    }
    const ghost = document.createElement("div");
    ghost.className = "space-flight";
    ghost.dataset["way"] = way;
    for (const picture of pictures) {
      picture.classList.add("space-flight-picture");
      ghost.appendChild(picture);
    }
    layer.appendChild(ghost);
    const r0 = way === "up" ? radius : TILE_RADIUS;
    const r1 = way === "up" ? TILE_RADIUS : radius;
    const lift = "0 10px 22px -10px oklch(0 0 0 / 0.38), 0 0 0 1px oklch(0 0 0 / 0.08)";
    const flat = "0 0 0 0 oklch(0 0 0 / 0), 0 0 0 0 oklch(0 0 0 / 0)";
    const px = (n: number): string => `${String(Math.round(n * 100) / 100)}px`;
    const animation = ghost.animate(
      [
        { offset: 0, left: px(from.x), top: px(from.y), width: px(from.w), height: px(from.h), borderRadius: px(r0), boxShadow: flat, transform: "none", easing: "cubic-bezier(0.3, 0.7, 0.4, 1)" },
        { offset: 0.2, left: px(from.x + 2), top: px(from.y - 4), width: px(from.w), height: px(from.h), borderRadius: px(r0), boxShadow: lift, transform: `rotate(${way === "up" ? -1.2 : 1.2}deg)`, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" },
        { offset: 1, left: px(to.x), top: px(to.y), width: px(to.w), height: px(to.h), borderRadius: px(r1), boxShadow: flat, transform: "none" },
      ],
      { duration: FLIGHT_MS, fill: "forwards" },
    );
    pictures[0].animate([{ opacity: 1, offset: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0, offset: 0.62 }, { opacity: 0, offset: 1 }], { duration: FLIGHT_MS, fill: "forwards" });
    pictures[1].animate([{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.32 }, { opacity: 1, offset: 0.66 }, { opacity: 1, offset: 1 }], { duration: FLIGHT_MS, fill: "forwards" });
    const record = { ghost, animation };
    this.running.add(record);
    const end = (): void => {
      this.running.delete(record);
      done();
      ghost.remove();
    };
    animation.finished.then(end, end);
  }

  override render(): ReactNode {
    return <div ref={this.layer} className="space-flights" aria-hidden="true" />;
  }
}

/**
 * The tile (or row) a ghost landed on, shown at once where it is: no fade of its own after the flight's (`data-snap`
 * holds its transitions for a frame). Its animations are left alone — stopping them for the frame would start them
 * again after it: a tile's entrance replayed, a blink (until 2026-10-13).
 */
function reveal(el: HTMLElement): void {
  if (!el.isConnected) return;
  el.dataset["snap"] = "";
  delete el.dataset["arriving"];
  void el.offsetWidth;
  requestAnimationFrame(() => delete el.dataset["snap"]);
}
