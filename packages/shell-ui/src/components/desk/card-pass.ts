/**
 * The chat's card as the desk passes to another space (docs/desk-agent.md §1,
 * "The card goes and comes with its space"). The chat is its space's, and so
 * is its card on the desk: the space left, the card goes with that space's
 * windows — where it stood until they are dismissed, then on their exit — and
 * the chosen space's card comes with its own, on their entrance
 * (DeskEngine.sendOff, bringIn). The Bar is one, drawn for the space in
 * front, and by the commit of the passing its card is the next space's (or
 * none): what goes is a still copy of the card as it stood, made before that
 * commit (copyCard), in a layer of its own; what comes is the card itself,
 * posed on its `-vis` layer.
 */

import type { Rect } from "../../lib/desk/geometry";
import type { RiderPose } from "./desk-engine";

/** A still copy of the card as it stands: for the eye only. */
export interface CardCopy {
  el: HTMLElement;
  /** Its box on the stage. */
  rect: Rect;
  /** Once it is in the document: what a copy does not carry — how far each list in it was scrolled. */
  settle(): void;
}

/**
 * The card as it is drawn now, copied: placed in the lane by its box (the
 * card's own transform, its place in the column and its share of the desk's
 * height are the live card's), every list in it scrolled as it was and every
 * field holding what it held, and nothing in it there to be found — by the
 * pointer, the keyboard, a reader, or a test.
 */
export function copyCard(card: HTMLElement, lane: HTMLElement): CardCopy | null {
  const stage = lane.closest<HTMLElement>(".desk-stage");
  const box = card.getBoundingClientRect();
  if (stage === null || box.width <= 0 || box.height <= 0) return null;
  const at = lane.getBoundingClientRect();
  const desk = stage.getBoundingClientRect();
  const el = card.cloneNode(true) as HTMLElement;
  const originals = [card, ...card.querySelectorAll("*")];
  const copies = [el, ...el.querySelectorAll("*")];
  const scrolled: Array<{ node: Element; top: number; left: number }> = [];
  originals.forEach((node, index) => {
    const copy = copies[index];
    if (copy === undefined) return;
    if (node.scrollTop !== 0 || node.scrollLeft !== 0) scrolled.push({ node: copy, top: node.scrollTop, left: node.scrollLeft });
    // (What is typed in a field is its value, which a copy starts without.)
    if ((node instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) || (node instanceof HTMLInputElement && copy instanceof HTMLInputElement)) copy.value = node.value;
    for (const name of ["data-testid", "id", "role", "aria-live", "aria-controls", "aria-labelledby", "aria-describedby", "for", "name"]) copy.removeAttribute(name);
  });
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("data-testid", "desk-answer-leaving");
  el.inert = true;
  // Among the windows where the card stood (a floating one's place in the stack: --desk-answer-z).
  const z = getComputedStyle(card).zIndex;
  Object.assign(el.style, {
    position: "absolute",
    left: `${(box.left - at.left).toFixed(2)}px`,
    top: `${(box.top - at.top).toFixed(2)}px`,
    width: `${box.width.toFixed(2)}px`,
    height: `${box.height.toFixed(2)}px`,
    maxHeight: "none",
    margin: "0",
    transform: "none",
    zIndex: z,
    pointerEvents: "none",
  });
  return {
    el,
    rect: { x: box.left - desk.left, y: box.top - desk.top, w: box.width, h: box.height },
    settle: () => {
      for (const { node, top, left } of scrolled) {
        node.scrollTop = top;
        node.scrollLeft = left;
      }
    },
  };
}

/**
 * A pose drawn on an element (the engine's word, each frame of a passing) —
 * or, null, taken off it: as its stylesheet has it. While it is posed its
 * opacity is the pose's alone (`data-switching`: shell.css stands its own
 * fade aside, as a window's does).
 */
export function drawPose(el: HTMLElement, drawn: RiderPose | null): void {
  if (drawn === null) {
    delete el.dataset["switching"];
    for (const name of ["transform", "transform-origin", "opacity", "filter"]) el.style.removeProperty(name);
    return;
  }
  el.dataset["switching"] = "";
  el.style.transform = drawn.transform;
  el.style.transformOrigin = `${drawn.origin.x.toFixed(1)}px ${drawn.origin.y.toFixed(1)}px`;
  el.style.opacity = drawn.opacity.toFixed(3);
  el.style.filter = drawn.blur > 0.05 ? `blur(${drawn.blur.toFixed(2)}px)` : "";
}
