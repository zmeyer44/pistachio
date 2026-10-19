import { Check, Info, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  DEFAULT_NOTICE_POSITION,
  NOTICE_PEEK,
  noticeAlign,
  noticeEdge,
  noticeSpreadHeight,
  type NoticeAlign,
  type NoticeEdge,
  type NoticeEvent,
  type NoticeItem,
  type NoticePosition,
  type NoticeTone,
} from "@pistachio/shell-contracts/notice";
import {
  cardPose,
  isLeaving,
  liveHeights,
  NOTICE_SETTLE_MS,
  promoteCards,
  pruneCard,
  reconcileCards,
  stackFootprint,
  unionBox,
  type NoticeBox,
  type StackCard,
} from "../lib/notices";

/**
 * The notice stack as it is drawn (@pistachio/shell-contracts/notice): the
 * native notice view's whole page on the desktop (NoticeApp), and a layer of
 * the shell's own DOM on a stream surface (NoticeHost). It owns nothing but
 * the motion — which notices are live, and for how long, is the store's.
 *
 * A card arrives held at its entrance pose with transitions off; its height
 * is read (which also flushes that pose into the computed style) and it is
 * promoted in the same task, so the transition starts from the pose without
 * waiting on a frame that a just-shown view may not have yet. A card that
 * has gone from the list stays for its exit and is then pruned. Where each
 * card stands is lib/notices.ts's arithmetic; the CSS only moves it there.
 *
 * It says where its cards are drawn (`onFootprint`): on the desktop main
 * lays a live share's outlines under them (docs/live-share.md §6.3).
 */

/** Longer than the exit transition (shell.css --notice-close), so a card is never pruned mid-fade. */
const PRUNE_AFTER_MS = 320;

const ICONS: Record<NoticeTone, typeof Check> = { neutral: Info, success: Check, warning: TriangleAlert };

export interface NoticeStackProps {
  /** The live notices, oldest first. */
  items: readonly NoticeItem[];
  /** Where the stack stands in its layer, and so which way it moves. */
  position?: NoticePosition;
  onEvent(event: NoticeEvent): void;
  /** The room the cards need spread out, whenever it changes. */
  onMeasure?(stackHeight: number): void;
  /** Where the cards are drawn in the layer (CSS px), or null with none, whenever it changes. */
  onFootprint?(box: NoticeBox | null): void;
}

/** Where the stack's cards are drawn in its layer, as laid out now (stackFootprint), or null with none. */
function footprintOf(stack: HTMLElement | null, edge: NoticeEdge, align: NoticeAlign, moving: boolean): NoticeBox | null {
  if (stack === null) return null;
  let widest = 0;
  let tallest = 0;
  // (Their layout boxes: what each card's own transform only ever shrinks.)
  for (const card of stack.querySelectorAll<HTMLElement>(".notice-card")) {
    widest = Math.max(widest, card.offsetWidth);
    tallest = Math.max(tallest, card.offsetHeight);
  }
  const box = stack.getBoundingClientRect();
  return stackFootprint({ x: box.left, y: box.top, w: box.width, h: box.height }, { widest, tallest }, edge, align, moving);
}

export function NoticeStack({ items, position = DEFAULT_NOTICE_POSITION, onEvent, onMeasure, onFootprint }: NoticeStackProps) {
  const edge = noticeEdge(position);
  const align = noticeAlign(position);
  const [cards, setCards] = useState<StackCard[]>([]);
  const [heights, setHeights] = useState<ReadonlyMap<number, number>>(() => new Map());
  const [hovering, setHovering] = useState(false);
  const bodies = useRef(new Map<number, HTMLDivElement>());
  const pruneTimers = useRef(new Map<number, number>());

  useLayoutEffect(() => {
    setCards((current) => reconcileCards(current, items));
  }, [items]);

  // Measure, then promote: reading a body's height flushes the entrance pose
  // into the computed style, so the promotion that follows in this same task
  // is a change to transition FROM.
  const measure = useCallback(() => {
    setHeights((current) => {
      let changed = current.size !== bodies.current.size;
      const next = new Map<number, number>();
      for (const [id, body] of bodies.current) {
        const height = body.offsetHeight;
        next.set(id, height);
        if (current.get(id) !== height) changed = true;
      }
      return changed ? next : current;
    });
  }, []);
  useLayoutEffect(() => {
    measure();
    if (cards.some((card) => card.phase === "enter")) setCards(promoteCards);
  }, [cards, measure]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  useEffect(() => {
    const timers = pruneTimers.current;
    for (const card of cards) {
      const id = card.item.id;
      if (!isLeaving(card) || timers.has(id)) continue;
      timers.set(
        id,
        window.setTimeout(() => {
          timers.delete(id);
          setCards((current) => pruneCard(current, id));
        }, PRUNE_AFTER_MS),
      );
    }
  }, [cards]);
  useEffect(() => {
    const timers = pruneTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const live = liveHeights(cards, heights);
  const spreadHeight = noticeSpreadHeight(live);
  const spread = hovering && live.length > 1;
  useLayoutEffect(() => {
    if (spreadHeight > 0) onMeasure?.(spreadHeight);
  }, [spreadHeight, onMeasure]);

  // Where the cards are drawn: where they stand — and while they move (NOTICE_SETTLE_MS from a change), wherever
  // they were and are going too. Said in the commit that moves them, again as they come to rest, and as the layer is
  // resized (main sized the view: the stack stands elsewhere in it, and what was said of the old one is let go).
  const stackRef = useRef<HTMLElement>(null);
  const footprint = useRef<{ said: NoticeBox | null; settling: number | null }>({ said: null, settling: null });
  const sayFootprint = useCallback(
    (changed: boolean): void => {
      if (onFootprint === undefined) return;
      const own = footprint.current;
      const now = footprintOf(stackRef.current, edge, align, own.settling !== null);
      own.said = now === null ? null : changed && own.said !== null ? unionBox(own.said, now) : now;
      onFootprint(own.said);
    },
    [onFootprint, edge, align],
  );
  useLayoutEffect(() => {
    if (onFootprint === undefined) return;
    const own = footprint.current;
    const timer = window.setTimeout(() => {
      own.settling = null;
      sayFootprint(false);
    }, NOTICE_SETTLE_MS);
    own.settling = timer;
    sayFootprint(true);
    return () => {
      window.clearTimeout(timer);
      own.settling = null;
    };
  }, [cards, heights, spread, onFootprint, sayFootprint]);
  useEffect(() => {
    if (onFootprint === undefined) return;
    const resized = (): void => sayFootprint(false);
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, [onFootprint, sayFootprint]);

  // The pointer is "over the stack" while it is inside the stack's one box,
  // which grows to the spread column — the gaps between spread cards belong
  // to no card, so the cards' own hover would flicker across them.
  const hover = (next: boolean) => {
    if (next === hovering) return;
    setHovering(next);
    onEvent({ type: "hover", hovering: next });
  };
  // A view taken down under the pointer never hears it leave.
  const empty = items.length === 0;
  useEffect(() => {
    if (!empty || !hovering) return;
    setHovering(false);
    onEvent({ type: "hover", hovering: false });
  }, [empty, hovering, onEvent]);

  if (cards.length === 0) return null;
  const front = live[0] ?? 0;
  const boxHeight = spread ? spreadHeight : front + NOTICE_PEEK * Math.max(0, live.length - 1);

  return (
    <section
      ref={stackRef}
      aria-label="Notifications"
      data-testid="notice-stack"
      data-spread={spread ? "" : undefined}
      data-edge={edge}
      data-align={align}
      className="notice-stack"
      style={{ height: boxHeight }}
      onPointerEnter={() => hover(true)}
      onPointerLeave={() => hover(false)}
    >
      {cards.map((card) => {
        const pose = cardPose(card, spread, live, edge);
        const { item } = card;
        const Icon = ICONS[item.tone];
        const style = {
          "--notice-y": `${String(pose.y)}px`,
          "--notice-scale": String(pose.scale),
          "--notice-opacity": String(pose.opacity),
          "--notice-blur": `${String(pose.blur)}px`,
          zIndex: pose.z,
          // Behind the front card an older one is no taller than it, so a
          // long message does not tower over a short one in front of it.
          maxHeight: spread || card.depth === 0 || front === 0 ? undefined : front,
        } as CSSProperties;
        return (
          <div
            key={item.id}
            role="status"
            data-testid="notice-card"
            data-phase={card.phase}
            data-depth={card.depth}
            data-tone={item.tone}
            className="notice-card"
            style={style}
          >
            <div
              // Said again: remounting replays the nudge.
              key={item.bumps}
              ref={(node) => {
                if (node === null) bodies.current.delete(item.id);
                else bodies.current.set(item.id, node);
              }}
              className="notice-card-body"
              data-bumped={item.bumps > 0 ? "" : undefined}
            >
              <span className="notice-icon" aria-hidden="true">
                <Icon />
              </span>
              <span className="notice-message">{item.message}</span>
              {item.actionLabel === null ? null : (
                <button type="button" className="notice-action" onClick={() => onEvent({ type: "action", id: item.id })}>
                  {item.actionLabel}
                </button>
              )}
              <button
                type="button"
                aria-label="Dismiss"
                title="Dismiss"
                className="notice-close"
                onClick={() => onEvent({ type: "dismiss", id: item.id })}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
