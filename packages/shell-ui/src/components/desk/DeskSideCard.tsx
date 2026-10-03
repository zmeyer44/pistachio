import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { GroupContextView } from "@pistachio/shell-contracts/desk-agent";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { nativeApi } from "../../api";
import { useDeskChrome } from "../../lib/desk/chrome";
import { arrangeDesk } from "../../lib/desk/open";
import { useDeskStore } from "../../lib/desk/store";
import { holdDeskMore, lingerDeskMore } from "./DeskSidebarControls";
import type { DeskEngine, DeskView } from "./desk-engine";
import { DeskMoreCard } from "./DeskMoreCard";
import { StackCard } from "./DeskStack";

/** A card stands this far from the sidebar's edge, over the desk. */
const CARD_GAP = 10;

/**
 * The card a control in the sidebar opened (lib/desk/chrome.ts) — the
 * desk's (DeskMoreButton) or the Stack's (DeskContextRow) — drawn over the
 * desk beside it. It is a cover: the live pages under it give way to their
 * stills, and it shows once they have (`clearCovers`).
 *
 * It goes on a press anywhere else — on a live page too, which main relays —
 * or Escape, and when a window is taken in hand or a menu opens; the desk's
 * card also goes a moment after the pointer leaves both it and its button,
 * unless a click pinned it (or a press is held in it: a slider).
 */
export function DeskSideCard({
  engine,
  view,
  stageRef,
  group,
  context,
  others,
}: {
  engine: DeskEngine;
  view: DeskView;
  stageRef: RefObject<HTMLDivElement | null>;
  /** The desk's group; null on a loose tab's desk, which has no Stack. */
  group: TabGroupInfo | null;
  context: GroupContextView | null;
  others: readonly GroupContextView[];
}) {
  const card = useDeskChrome((state) => state.card);
  const cardRef = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);
  const [rejection, setRejection] = useState<string | null>(null);
  const busy = view.gesture !== null;
  const kind = card?.kind ?? null;

  // A window taken in hand puts it away.
  useEffect(() => {
    if (busy) useDeskChrome.getState().closeCard();
  }, [busy]);
  // A drop the Stack's row could not take is said on its card.
  useEffect(() => {
    setRejection(card?.kind === "stack" ? (card.rejection ?? null) : null);
  }, [card]);

  // Where it is drawn, and the gap to the sidebar, so the pointer crossing it is the shell's.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (kind === null || el === null) {
      engine.setCover("card", null);
      return;
    }
    const measure = (): void => engine.setCover("card", { x: 0, y: el.offsetTop, w: el.offsetLeft + el.offsetWidth, h: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [engine, kind, card]);
  useEffect(() => () => engine.setCover("card", null), [engine]);

  // A press anywhere else (a live page's too), or Escape.
  useEffect(() => {
    if (kind === null) return;
    const opener = kind === "more" ? "[data-testid='desk-more']" : "[data-testid='desk-stack']";
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      if (input === "press" || input === "escape") useDeskChrome.getState().closeCard();
    });
    const onDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      // Its opener toggles it itself.
      if (target !== null && (cardRef.current?.contains(target) === true || target.closest(opener) !== null)) return;
      useDeskChrome.getState().closeCard();
    };
    const onUp = (): void => {
      if (!pressed.current) return;
      pressed.current = false;
      if (kind === "more" && cardRef.current?.matches(":hover") !== true) lingerDeskMore();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") useDeskChrome.getState().closeCard();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("keydown", onKey);
    return () => {
      offPage?.();
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [kind]);

  const stage = stageRef.current?.getBoundingClientRect() ?? null;
  if (card === null || stage === null) return null;
  const left = Math.max(CARD_GAP, card.anchor.x + card.anchor.w - stage.left + CARD_GAP);
  const shown = view.clearCovers.has("card");
  if (card.kind === "stack") {
    if (group === null) return null;
    return (
      <StackCard
        ref={cardRef}
        group={group}
        context={context}
        others={others}
        left={left}
        center={card.anchor.y + card.anchor.h / 2 - stage.top}
        stageHeight={stage.height}
        shown={shown}
        rejection={rejection}
        onRejected={setRejection}
        engine={engine}
        openIds={new Set(view.windows.map((window) => window.tabId))}
        onOpened={() => useDeskChrome.getState().closeCard("stack")}
      />
    );
  }
  const height = cardRef.current?.offsetHeight ?? 0;
  const fromAction = (action: () => void): (() => void) => () => {
    useDeskChrome.getState().closeCard("more");
    action();
  };
  return (
    <DeskMoreCard
      ref={cardRef}
      shown={shown}
      left={left}
      // Level with its button, as far down as it fits.
      top={Math.max(8, Math.min(card.anchor.y - stage.top, stage.height - height - 8))}
      onPointerEnter={holdDeskMore}
      onPointerLeave={() => {
        if (!pressed.current) lingerDeskMore();
      }}
      onPointerDown={() => {
        pressed.current = true;
      }}
      onTile={fromAction(() => engine.arrange("tile"))}
      onCascade={fromAction(() => engine.arrange("cascade"))}
      onArrange={fromAction(() => void arrangeDesk("smart"))}
      onLeave={fromAction(() => useDeskStore.getState().leave())}
    />
  );
}
