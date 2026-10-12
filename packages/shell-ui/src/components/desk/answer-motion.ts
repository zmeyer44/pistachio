/**
 * The Bar's answer taken off the Bar (docs/desk-agent.md, "The answer,
 * detached"): the card lifts as its header is pressed, follows the pointer,
 * and past TEAR_PX tears off into a window — its frame morphing to a
 * window's size and corners under the hand, its content reflowed once and
 * cross-faded from a still copy of how it was. Floating, it is moved and
 * thrown as the desk's windows are (Glide, a rebound off an edge), settles
 * into an anchor as the floating player does, and is resized from its edges
 * and corners. Pushed into an edge it snaps into a tile as a window does;
 * brought toward the trailing side, into the chat's own place, the message
 * field coming into the card. Brought back over the Bar, a ghost of its
 * docked slot comes up; let go there (or its dock button, or a double press
 * of its header) and it morphs back into the slot.
 *
 * Imperative on purpose: one animation frame loop writes the card's
 * transforms and nothing re-renders for it (React draws the card's content;
 * this owns where and how big it is drawn, and its `data-mode`). The pointer
 * is held by the drag layer (lib/pane-drag.ts), so a gesture keeps going over
 * the desk's live pages. Geometry is lib/desk/answer-float.ts's, in the Bar's
 * lane's coordinates.
 */

import type { DragCursor } from "@pistachio/shell-contracts/chrome";
import {
  ANCHOR_SETTLE_PX,
  ANCHOR_THROW_PX,
  ANSWER_SPRINGS,
  CHAT_W,
  FIELD_H,
  FLOAT_EDGE,
  FLOAT_W,
  FLOAT_MIN,
  RADIUS_DOCKED,
  RADIUS_FLOATING,
  TEAR_PX,
  boxFromSpot,
  chatApproach,
  chatBox,
  chatResized,
  dockSlot,
  dockZone,
  dragFloor,
  fitFloatSize,
  nearestAnchor,
  pointerOnBar,
  resizedBox,
  restFor,
  restInStage,
  rubber,
  snapZone,
  spotFromBox,
  stageOf,
  writeFloatSpot,
  zoneBox,
  type AnswerZone,
  type FloatArea,
  type FloatSpot,
} from "../../lib/desk/answer-float";
import { cellZone, nubExtent, nubOutline, rectsOverlap, thirdsCell, type NotchShape, type Rect, type ThirdsCell } from "../../lib/desk/geometry";
import { BOUNCE_RESTITUTION, GLIDE_STOP_SPEED, GLIDE_TAU_S, VelocityTracker, clamp, stepSpring, type SpringConfig } from "../../lib/desk/motion";
import { startPaneDrag } from "../../lib/pane-drag";

export type AnswerEdge = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

const EDGE_CURSORS: Record<AnswerEdge, DragCursor> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
};

/** The pill at one line (DeskBar's BAR_H): the slot is measured from its top. */
const BAR_H = 52;
/** A pressed card grows this much, and a docked one rises this far off the Bar, as it is taken. */
const LIFT_SCALE = 0.01;
const LIFT_RISE = 3;
/** Over the zone, the card shrinks this much toward its slot, and leans at most this far toward it. */
const PREVIEW_SCALE = 0.035;
const PULL_MAX = 14;
/** How far a card in hand gives past its floor, pressed down onto the Bar. */
const BAR_GIVE = 12;
/** Two presses of a floating card's header this close, unmoved, dock it. */
const DOUBLE_PRESS_MS = 400;
/** While it moves, the card's cover reaches this far past it, so the pages it is heading over give way first. */
const COVER_LEAD = 48;
/** The morph's cross-fade: the header's in this long, the old body out in this long, the new one in after this, over this. */
const HEAD_FADE_MS = 160;
const BODY_OUT_MS = 100;
const BODY_IN_DELAY_MS = 80;
const BODY_IN_MS = 200;
/** Shift's snap mode reads the desk in thirds, a cell holding until the pointer is this far past its line (the desk's own). */
const SNAP_HYSTERESIS = 16;
/** The chat's place's hint: a rail this wide, this far in from the desk's trailing edge, and how much of the place's height. */
const HINT_W = 5;
const HINT_INSET = 6;
const HINT_SHARE = 0.32;
/** No nub reaches further than this from the desk's corner (swelled, it reaches ~50px). */
const HOLE_NEAR = 80;

interface Size {
  w: number;
  h: number;
  r: number;
}

interface Scalar {
  x: number;
  v: number;
  target: number;
}

/** The content's parts the morph moves apart: the header's buttons ride the frame's edge, the body cross-fades. */
interface Parts {
  head: HTMLElement | null;
  body: HTMLElement | null;
  actions: HTMLElement | null;
  grab: HTMLElement | null;
  title: HTMLElement | null;
  viewport: HTMLElement | null;
  /** The message field's place at the card's foot, floating (it fades with the body). */
  foot: HTMLElement | null;
}

interface Fade {
  head0: number;
  body0: number;
  headOld: number;
  headNew: number;
  bodyOld: number;
  bodyOldBlur: number;
  bodyNew: number;
  bodyNewBlur: number;
  bodyNewY: number;
}

interface Morph {
  from: Size;
  to: Size;
  p: number;
  vp: number;
  spring: SpringConfig;
  /** Milliseconds since it began (the cross-fade runs on its own clock). */
  t: number;
}

type Motion = { kind: "spring"; tx: number; ty: number; spring: SpringConfig; bounce: boolean } | { kind: "coast" };

interface Gesture {
  kind: "tear" | "move" | "resize";
  x0: number;
  y0: number;
  px: number;
  py: number;
  moved: boolean;
  inZone: boolean;
  cancelled: boolean;
  startMode: "docked" | "detached";
  startRect: Rect;
  /** How far from its slot the card has been in this gesture: the ghost waits for it to come back. */
  farthest?: number;
  /** The zone takes it: not until a card just torn off has been out of it once (it starts beside its slot). */
  armed: boolean;
  edges?: { l: boolean; r: boolean; t: boolean; b: boolean };
  /** The zone it was snapped in when pressed: it lets go of it once it is on the move (`unsnapped`). */
  startZone: AnswerZone | null;
  unsnapped: boolean;
  /** The zone lit for it now, where it lands if let go; Shift held (snap mode, the desk in thirds), and the cell read. */
  zone: AnswerZone | null;
  shift: boolean;
  cell: ThirdsCell | null;
  end: () => void;
}

export interface AnswerMotionHost {
  /** The Bar's lane: the coordinates everything here is in. */
  lane: HTMLElement;
  /** The card (`.desk-answer`), its layers inside it. */
  card: HTMLElement;
  /** The docked slot's ghost, in the lane. */
  ghost: HTMLElement;
  /** Where a card in hand would land, lit; and the chat's place, hinted as a card is carried toward it. In the lane. */
  zone: HTMLElement;
  hint: HTMLElement;
  /** The Bar itself, for how tall it stands. */
  bar(): HTMLElement | null;
  /** The card floats now, or is docked (DeskBar: the Bar's button, what closes it). */
  floating(floating: boolean): void;
  /** The zone it is snapped in, or none. */
  snapped(zone: AnswerZone | null): void;
  /** The chat's place's width while the card is in it, or null (DeskBar: the desk's windows keep out of it). */
  place(width: number | null): void;
  /** The nub as it is cut now — its outline, and the desk's corner radius it rounds into — or null while it is not a hole. */
  notch(): { shape: NotchShape; corner: number } | null;
  /** A card is in hand (DeskBar grows the Bar for it, the slot's home). */
  held(held: boolean): void;
  /** What the card covers on the desk, the ghost while it shows, and the zone lit (or the hint) — in lane coordinates, or null. */
  cover(card: Rect | null, ghost: Rect | null, zone: Rect | null): void;
}

function scalar(): Scalar {
  return { x: 0, v: 0, target: 0 };
}

function reduced(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function springOf(name: keyof typeof ANSWER_SPRINGS): SpringConfig {
  const spring = ANSWER_SPRINGS[name];
  return reduced() ? { response: spring.response * 0.8, damping: 1 } : spring;
}

function partsOf(content: HTMLElement): Parts {
  return {
    head: content.querySelector<HTMLElement>(".desk-answer-head"),
    body: content.querySelector<HTMLElement>(".desk-answer-body"),
    actions: content.querySelector<HTMLElement>(".desk-answer-actions"),
    grab: content.querySelector<HTMLElement>(".desk-answer-grab"),
    title: content.querySelector<HTMLElement>(".desk-answer-title"),
    viewport: content.querySelector<HTMLElement>(".desk-answer-viewport"),
    foot: content.querySelector<HTMLElement>(".desk-answer-foot"),
  };
}

export class AnswerMotion {
  readonly #host: AnswerMotionHost;
  readonly #vis: HTMLElement;
  readonly #frame: HTMLElement;
  readonly #lift: HTMLElement | null;
  readonly #sheen: HTMLElement | null;
  readonly #flashEl: HTMLElement | null;
  readonly #content: HTMLElement;
  readonly #snapHost: HTMLElement | null;
  /** The live content's parts (read afresh at each morph: the thread's viewport comes and goes with the conversation). */
  #live: Parts;
  readonly #styles = new WeakMap<HTMLElement, Record<string, string>>();
  readonly #tracker = new VelocityTracker();
  readonly #observer: ResizeObserver;

  #mode: "docked" | "detached" = "docked";
  /** The point the card is held by, and where in the card it is: x as a share of its width (a morph scales about it), y in px from its top or as a share of its height. */
  #B = { x: 0, y: 0 };
  #V = { x: 0, y: 0 };
  #anchor: { u: number; v: number; gy: number | null } = { u: 0.5, v: 0.5, gy: null };
  #size = { w: 0, h: 0 };
  #r = RADIUS_DOCKED;
  /** The card's laid-out box: its size, and where it lies untransformed (docked, its place on the Bar; floating, the lane's corner). */
  #layout = { W: 0, H: 0 };
  #origin = { x: 0, y: 0 };
  #morph: Morph | null = null;
  #fade: Fade | null = null;
  #snap: { el: HTMLElement; W: number; parts: Parts } | null = null;
  #motion: Motion | null = null;
  #gesture: Gesture | null = null;
  #docking = false;
  readonly #lift_ = scalar();
  readonly #rise = scalar();
  readonly #preview = scalar();
  readonly #pulse = scalar();
  #pull = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 };
  #ghost = { x: 0, target: 0, hot: false };
  /** A size change heard while it moved (#relayout), to lay out once it is still. */
  #relayoutPending = false;
  #area: FloatArea = { w: 0, h: 0, barX: 0, barW: 0, barTop: 0 };
  #laneRect = { left: 0, top: 0 };
  /** The docked card's height when it last was: the slot the ghost draws. */
  #dockedH = 0;
  /** The floating size it last had (kept on this device). */
  #floatSize: { w: number; h: number } | null = null;
  /** The zone it is snapped in (its place and size the zone's), and the chat's place's width. */
  #zone: AnswerZone | null = null;
  /**
   * Resized out of a tile, it stands in the DESK's frame — flush with the desk's edges where the tile left it, not
   * the lane's inset — until a hand moves it, or it snaps or docks (2026-10-10: the relayout its new size brought on
   * read it as any floating card, shrank it to the lane and moved it in to the lane's corner).
   */
  #inStage = false;
  #chatW = CHAT_W;
  /** The zone lit for a card in hand (what `host.zone` shows), and the chat's place's hint. */
  #lit: { zone: AnswerZone; rect: Rect; snapping: boolean } | null = null;
  readonly #hint = scalar();
  #lastPress = 0;
  #raf = 0;
  #lastT = 0;
  #destroyed = false;

  constructor(host: AnswerMotionHost, spot: FloatSpot | null) {
    this.#host = host;
    const card = host.card;
    this.#vis = card.querySelector<HTMLElement>(".desk-answer-vis")!;
    this.#frame = card.querySelector<HTMLElement>(".desk-answer-frame")!;
    this.#lift = card.querySelector<HTMLElement>(".desk-answer-lift");
    this.#sheen = card.querySelector<HTMLElement>(".desk-answer-sheen");
    this.#flashEl = card.querySelector<HTMLElement>(".desk-answer-flash");
    this.#content = card.querySelector<HTMLElement>(".desk-answer-content")!;
    this.#snapHost = card.querySelector<HTMLElement>(".desk-answer-snap");
    this.#live = partsOf(this.#content);
    this.#measureArea();
    if (spot !== null) this.#floatSize = { w: spot.w, h: spot.h };
    if (spot?.cw !== undefined) this.#chatW = spot.cw;
    if (spot?.floating === true) {
      // (Left out of a tile by a resize: in the desk's frame still.)
      if (spot.zone === undefined && spot.inStage === true) this.#inStage = true;
      const box = boxFromSpot(this.#area, spot);
      this.#mode = "detached";
      card.dataset.mode = "detached";
      this.#content.dataset["mode"] = "detached";
      if (spot.zone !== undefined) this.#setZone(spot.zone);
      this.#setFloatLayout(box.w, box.h);
      this.#size = { w: box.w, h: box.h };
      this.#r = RADIUS_FLOATING;
      this.#anchor = { u: 0, v: 0, gy: 0 };
      this.#B = { x: box.x, y: box.y };
      this.#dockedH = Math.round(this.#area.h * 0.4);
      host.floating(true);
    } else {
      card.dataset.mode = "docked";
      this.#content.dataset["mode"] = "docked";
      this.#syncDocked();
      host.floating(false);
    }
    this.#render(true);
    this.#observer = new ResizeObserver(() => this.#relayout());
    this.#observer.observe(card);
    this.#observer.observe(host.lane);
    // The Bar too: grown taller (a message of several lines, files), it would cover a card resting just above it.
    const bar = host.bar();
    if (bar !== null) this.#observer.observe(bar);
  }

  get floating(): boolean {
    return this.#mode === "detached";
  }

  destroy(): void {
    this.#destroyed = true;
    if (this.#gesture !== null) {
      const gesture = this.#gesture;
      this.#gesture = null;
      gesture.end();
    }
    window.removeEventListener("keydown", this.#onKey, true);
    window.removeEventListener("keyup", this.#onKeyUp, true);
    if (this.#raf !== 0) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#observer.disconnect();
    this.#removeSnap();
    this.#host.cover(null, null, null);
    this.#host.place(null);
    this.#light(null);
    this.#host.hint.style.opacity = "";
    // Put away on its way home: the slot's ghost (the Bar's, outliving this card) goes too, and it opens docked next time.
    this.#host.ghost.style.opacity = "";
    this.#host.ghost.removeAttribute("data-hot");
    if (this.#docking) this.#keepDocked();
  }

  /* ------------------------------ the press ------------------------------ */

  /** A press on the header (no `edge`: lift and move it) or on an edge or corner of a floating card (resize it). */
  press(event: PointerEvent, edge?: AnswerEdge): void {
    if (this.#gesture !== null || this.#docking || event.button !== 0) return;
    if (edge === undefined && event.target instanceof Element && event.target.closest("button") !== null) return;
    if (edge !== undefined && (this.#mode !== "detached" || this.#morph !== null)) return;
    // In the chat's place, only its leading edge resizes it: it keeps the desk's height and its trailing side.
    if (edge !== undefined && this.#zone === "chat" && edge !== "w") return;
    event.preventDefault();
    const lane = this.#host.lane.getBoundingClientRect();
    this.#laneRect = { left: lane.left, top: lane.top };
    this.#measureArea();
    // Docked and still, it is read where it is laid out; caught on its way back, it is taken from where it is drawn.
    if (this.#mode === "docked" && this.#morph === null && this.#motion === null) this.#syncDocked();
    const p = this.#local(event.clientX, event.clientY);
    this.#motion = null;
    this.#V = { x: 0, y: 0 };
    const rect = this.#rect();
    let cursor: DragCursor = "grabbing";
    let gesture: Omit<Gesture, "end">;
    if (edge !== undefined) {
      this.#anchor = { u: 0, v: 0, gy: 0 };
      this.#B = { x: rect.x, y: rect.y };
      cursor = EDGE_CURSORS[edge];
      gesture = {
        kind: "resize",
        x0: p.x,
        y0: p.y,
        px: p.x,
        py: p.y,
        moved: false,
        inZone: false,
        armed: true,
        cancelled: false,
        startMode: this.#mode,
        startRect: rect,
        edges: { l: edge.includes("w"), r: edge.includes("e"), t: edge.includes("n"), b: edge.includes("s") },
        startZone: this.#zone,
        unsnapped: false,
        zone: null,
        shift: event.shiftKey,
        cell: null,
      };
    } else {
      this.#setHandle(p.x, p.y, true);
      gesture = {
        kind: this.#mode === "docked" ? "tear" : "move",
        x0: p.x,
        y0: p.y,
        px: p.x,
        py: p.y,
        moved: false,
        inZone: false,
        armed: this.#mode !== "docked",
        cancelled: false,
        startMode: this.#mode,
        startRect: rect,
        startZone: this.#zone,
        unsnapped: false,
        zone: null,
        shift: event.shiftKey,
        cell: null,
      };
      this.#lift_.target = 1;
      this.#rise.target = this.#mode === "docked" ? 1 : 0;
      this.#host.held(true);
    }
    this.#tracker.reset();
    this.#tracker.push(p.x, p.y, performance.now());
    const held: Gesture = { ...gesture, end: () => undefined };
    this.#gesture = held;
    held.end = startPaneDrag(
      { x: event.clientX, y: event.clientY },
      {
        cursor,
        onMove: (point, shift) => this.#onMove(held, point, shift),
        onEnd: () => this.#onEnd(held),
      },
    );
    window.addEventListener("keydown", this.#onKey, true);
    window.addEventListener("keyup", this.#onKeyUp, true);
    this.#kick();
  }

  /** Back onto the Bar (its dock button). */
  dock(): void {
    if (this.#mode !== "detached" || this.#gesture !== null || this.#docking) return;
    const rect = this.#rect();
    this.#setHandle(rect.x + rect.w / 2, rect.y + rect.h / 2, false);
    this.#motion = null;
    this.#startDock(null);
  }

  /**
   * Into a zone with no hand on it (the header's side button, 2026-10-09:
   * the chat's own place): from the Bar it tears off and springs into the
   * zone's box as a card dragged there and let go would — the same morph,
   * the same anchor spring — and is kept there as any snapped card is.
   */
  snapInto(zone: AnswerZone): void {
    if (this.#gesture !== null || this.#docking || this.#destroyed) return;
    const lane = this.#host.lane.getBoundingClientRect();
    this.#laneRect = { left: lane.left, top: lane.top };
    this.#measureArea();
    // Docked and still, it sets out from where it is laid out (its centre the point it is carried by, as a drag's
    // #tear leaves it); caught on its way, from where it is drawn.
    if (this.#mode === "docked") {
      if (this.#morph === null && this.#motion === null) this.#syncDocked();
      this.#dockedH = this.#layout.H;
    }
    this.#motion = null;
    this.#V = { x: 0, y: 0 };
    this.#lift_.target = 0;
    this.#rise.target = 0;
    this.#snapTo(zone, null);
  }

  /** The Bar's button pressed while the card floats: it calls out where it is. */
  flash(): void {
    if (!reduced()) this.#pulse.v += 16;
    const el = this.#flashEl;
    if (el !== null) {
      el.classList.remove("desk-answer-flashing");
      void el.offsetWidth;
      el.classList.add("desk-answer-flashing");
    }
    this.#kick();
  }

  #onKey = (event: KeyboardEvent): void => {
    const gesture = this.#gesture;
    if (gesture === null) return;
    // Shift pressed with the pointer still: the snap's tiles light at once, as the desk's do for a window (2026-10-10;
    // until then only a pointer sample carried Shift, so a key pressed or let go without moving changed nothing).
    if (event.key === "Shift") {
      if (!gesture.shift) {
        gesture.shift = true;
        this.#kick();
      }
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    gesture.cancelled = true;
    gesture.end();
  };

  #onKeyUp = (event: KeyboardEvent): void => {
    const gesture = this.#gesture;
    if (gesture === null || event.key !== "Shift" || !gesture.shift) return;
    gesture.shift = false;
    this.#kick();
  };

  #onMove(gesture: Gesture, point: { x: number; y: number }, shift: boolean | undefined): void {
    if (this.#gesture !== gesture) return;
    const p = this.#local(point.x, point.y);
    gesture.px = p.x;
    gesture.py = p.y;
    if (shift !== undefined) gesture.shift = shift;
    if (!gesture.moved && Math.hypot(p.x - gesture.x0, p.y - gesture.y0) > 3) gesture.moved = true;
    this.#tracker.push(p.x, p.y, performance.now());
    this.#kick();
  }

  #onEnd(gesture: Gesture): void {
    window.removeEventListener("keydown", this.#onKey, true);
    window.removeEventListener("keyup", this.#onKeyUp, true);
    if (this.#gesture !== gesture) return;
    this.#gesture = null;
    if (this.#destroyed) return;
    this.#lift_.target = 0;
    this.#rise.target = 0;
    this.#hint.target = 0;
    this.#light(null);
    this.#host.held(false);
    if (gesture.cancelled) this.#cancel(gesture);
    else this.#release(gesture, this.#tracker.velocity(performance.now()));
    this.#kick();
  }

  #release(gesture: Gesture, velocity: { x: number; y: number }): void {
    if (gesture.kind === "tear") {
      this.#goSpring(this.#origin, "back", null);
      return;
    }
    if (gesture.kind === "resize") {
      // (An edge pressed and let go without a move changes nothing — not the size it floats at, 2026-10-10.)
      if (!gesture.moved) return;
      // The chat's place keeps its zone, at its new width.
      if (this.#zone === "chat") {
        this.#chatW = this.#size.w;
        this.#keep();
        return;
      }
      this.#floatSize = { w: this.#size.w, h: this.#size.h };
      const rect = this.#rect();
      // (Resized out of a tile, it stays where the tile left it, flush with the desk's edges.)
      if (gesture.startZone !== null) this.#inStage = true;
      const to = this.#inStage ? restInStage(this.#area, rect) : restFor(this.#area, rect, false);
      if (Math.abs(to.x - rect.x) > 0.5 || Math.abs(to.y - rect.y) > 0.5) this.#goSpring(to, "settle", null);
      else this.#keep();
      return;
    }
    // A floating card's header pressed twice, unmoved: back onto the Bar.
    if (!gesture.moved) {
      const now = performance.now();
      if (gesture.startMode === "detached" && now - this.#lastPress < DOUBLE_PRESS_MS) {
        this.#lastPress = 0;
        this.#preview.target = 0;
        this.#pull.tx = this.#pull.ty = 0;
        this.dock();
        return;
      }
      this.#lastPress = now;
    }
    this.#releaseMove(gesture, velocity);
  }

  #cancel(gesture: Gesture): void {
    this.#preview.target = 0;
    this.#pull.tx = this.#pull.ty = 0;
    if (gesture.kind === "tear") this.#goSpring(this.#origin, "back", null);
    else if (gesture.kind === "move") {
      if (gesture.startMode === "docked") this.#startDock(null);
      else if (gesture.startZone !== null) {
        // Taken out of its zone: back into it (never taken out, it is there still).
        this.#setGhost(0, false);
        if (gesture.unsnapped) this.#snapTo(gesture.startZone, null);
      } else {
        this.#setGhost(0, false);
        this.#goSpring(gesture.startRect, "settle", null);
      }
    } else {
      const from = gesture.startRect;
      this.#startMorph({ w: from.w, h: from.h, r: RADIUS_FLOATING }, "detached", springOf("settle"));
      this.#setZone(gesture.startZone);
      // (The windows go back to where the chat's place was.)
      if (gesture.startZone === "chat") this.#host.place(from.w);
      this.#goSpring(from, "settle", null);
    }
  }

  /* ------------------------------ the frame ------------------------------ */

  #kick(): void {
    if (this.#raf !== 0 || this.#destroyed) return;
    this.#lastT = 0;
    this.#raf = requestAnimationFrame(this.#tick);
  }

  #tick = (now: number): void => {
    this.#raf = 0;
    const dt = this.#lastT === 0 ? 1 / 120 : Math.min(0.064, Math.max(0, (now - this.#lastT) / 1000));
    this.#lastT = now;
    let active = false;
    if (this.#gesture !== null) {
      this.#stepGesture(this.#gesture);
      active = true;
    }
    if (this.#stepMotion(dt)) active = true;
    if (this.#stepMorph(dt)) active = true;
    if (this.#stepScalar(this.#lift_, springOf("lift"), dt)) active = true;
    if (this.#stepScalar(this.#rise, springOf("preview"), dt)) active = true;
    if (this.#stepScalar(this.#preview, springOf("preview"), dt)) active = true;
    if (this.#stepScalar(this.#pulse, ANSWER_SPRINGS.pulse, dt)) active = true;
    if (this.#stepScalar(this.#hint, springOf("preview"), dt)) active = true;
    if (this.#stepPull(dt)) active = true;
    if (this.#stepGhost(dt)) active = true;
    if (this.#docking && this.#morph === null && this.#motion === null) this.#finishDock();
    const moving = active || this.#docking;
    this.#render(!moving);
    if (moving) this.#raf = requestAnimationFrame(this.#tick);
    else if (this.#relayoutPending) this.#relayout();
  };

  #stepScalar(s: Scalar, spring: SpringConfig, dt: number): boolean {
    if (s.x === s.target && s.v === 0) return false;
    const next = stepSpring(s.x, s.v, s.target, spring, dt);
    s.x = next.x;
    s.v = next.v;
    if (Math.abs(s.x - s.target) < 0.0008 && Math.abs(s.v) < 0.01) {
      s.x = s.target;
      s.v = 0;
      return false;
    }
    return true;
  }

  #stepPull(dt: number): boolean {
    const p = this.#pull;
    if (p.x === p.tx && p.y === p.ty && p.vx === 0 && p.vy === 0) return false;
    const spring = springOf("preview");
    const x = stepSpring(p.x, p.vx, p.tx, spring, dt);
    const y = stepSpring(p.y, p.vy, p.ty, spring, dt);
    p.x = x.x;
    p.vx = x.v;
    p.y = y.x;
    p.vy = y.v;
    if (Math.hypot(p.x - p.tx, p.y - p.ty) < 0.05 && Math.hypot(p.vx, p.vy) < 1) {
      this.#pull = { ...p, x: p.tx, y: p.ty, vx: 0, vy: 0 };
      return false;
    }
    return true;
  }

  #stepGhost(dt: number): boolean {
    const g = this.#ghost;
    if (g.x === g.target) return false;
    const tau = g.target > g.x ? 0.08 : this.#docking ? 0.13 : 0.1;
    g.x += (g.target - g.x) * (1 - Math.exp(-dt / tau));
    if (Math.abs(g.target - g.x) < 0.004) g.x = g.target;
    if (g.x === 0 && g.hot) this.#setGhost(0, false);
    return true;
  }

  #stepGesture(gesture: Gesture): void {
    if (gesture.kind === "tear") {
      // Still looking docked, but under the pointer 1:1; far enough, it tears off.
      this.#B = { x: gesture.px, y: gesture.py };
      if (Math.hypot(gesture.px - gesture.x0, gesture.py - gesture.y0) > TEAR_PX) this.#tear(gesture);
      else return;
    }
    if (gesture.kind === "move") {
      // Snapped, it stays where it is until it is on the move; then it lets go of its zone, back to its own size
      // under the hand, as a window spanning the desk does.
      if (gesture.startZone !== null && !gesture.unsnapped) {
        if (!gesture.moved) return;
        this.#unsnap(gesture);
      }
      const s = this.#curSize();
      const g = this.#handleOffset(s.w, s.h);
      const x = rubber(gesture.px - g.x, 0, this.#area.w - s.w);
      // Pressed down onto the Bar, it gives a little and sits on it, never sliding in under it.
      const y = rubber(gesture.py - g.y, 0, dragFloor(this.#area, x, s.w, s.h), 80, BAR_GIVE);
      this.#B = { x: x + g.x, y: y + g.y };
      this.#updateZone(gesture);
      return;
    }
    if (gesture.kind === "resize" && gesture.edges !== undefined) {
      const dx = gesture.px - gesture.x0;
      const dy = gesture.py - gesture.y0;
      let box: Rect;
      if (this.#zone === "chat") {
        box = chatResized(this.#area, gesture.startRect, dx);
        // (The windows give way as it widens, and come back as it narrows.)
        this.#host.place(box.w);
      }
      else {
        // A tile resized is a card of that size, out of the tile — still on the desk wherever the tile reached.
        if (gesture.moved) this.#setZone(null);
        // (And one already out of a tile, on the desk's bounds still — not back to the lane's at its second resize.)
        box = resizedBox(this.#area, gesture.startRect, gesture.edges, dx, dy, gesture.startZone === null && !this.#inStage ? undefined : stageOf(this.#area));
      }
      this.#B = { x: box.x, y: box.y };
      if (box.w !== this.#size.w || box.h !== this.#size.h) {
        this.#size = { w: box.w, h: box.h };
        this.#setFloatLayout(box.w, box.h);
      }
    }
  }

  /** Past the tear: the card becomes a window under the hand. */
  #tear(gesture: Gesture): void {
    this.#dockedH = this.#layout.H;
    const fitted = this.#freeSize();
    this.#startMorph({ w: fitted.w, h: fitted.h, r: RADIUS_FLOATING }, "detached", springOf("tear"));
    gesture.kind = "move";
    this.#rise.target = 0;
  }

  /** Its own size, floating free: the one it was last left at, or (never yet) the pill's width and a little taller than it was docked, its field too. */
  #freeSize(): { w: number; h: number } {
    const size = this.#floatSize ?? { w: FLOAT_W, h: clamp(this.#dockedH + 40 + FIELD_H, FLOAT_MIN.h, Math.min(540, this.#area.h * 0.6)) };
    return fitFloatSize(this.#area, size.w, size.h);
  }

  /** Out of its zone, in hand: back to its own size, held where it was held. */
  #unsnap(gesture: Gesture): void {
    gesture.unsnapped = true;
    const size = this.#freeSize();
    // (The still copy taken first: it carries on in the zone's layout — the message field still in it — as it fades.)
    this.#startMorph({ w: size.w, h: size.h, r: RADIUS_FLOATING }, "detached", springOf("tear"));
    this.#setZone(null);
  }

  /** Into a zone: its size and place the zone's, the spring carrying a throw into it. */
  #snapTo(zone: AnswerZone, v: { x: number; y: number } | null): void {
    const box = zoneBox(this.#area, zone, this.#chatW, this.#freeSize());
    const s = this.#finalSize();
    // (Into the chat's place or out of it, the content is laid out afresh — the message field comes in or goes.)
    if (Math.abs(s.w - box.w) > 0.5 || Math.abs(s.h - box.h) > 0.5 || (zone === "chat") !== (this.#zone === "chat")) {
      this.#startMorph({ w: box.w, h: box.h, r: RADIUS_FLOATING }, "detached", springOf("anchor"));
    }
    this.#setZone(zone);
    this.#goSpring(box, "anchor", v);
  }

  /** The zone it is in: the card says so (its edges), its content too once the still copy is taken (its layout), and DeskBar is told. */
  #setZone(zone: AnswerZone | null): void {
    const card = this.#host.card;
    if (zone === null) {
      delete card.dataset["zone"];
      delete this.#content.dataset["zone"];
    } else {
      card.dataset["zone"] = zone;
      this.#content.dataset["zone"] = zone;
    }
    if (zone !== null) this.#inStage = false;
    if (this.#zone === zone) return;
    this.#zone = zone;
    this.#host.snapped(zone);
    this.#host.place(zone === "chat" ? chatBox(this.#area, this.#chatW).w : null);
  }

  /** The nub re-cut (its swell, its menu): the hole in the card's glass follows, if it is still. */
  nub(): void {
    if (this.#raf === 0 && !this.#destroyed) this.#render(true);
  }

  /** Light where a card in hand would land (null: nothing lit), as the desk lights a tile for a window. */
  #light(zone: AnswerZone | null, snapping = false): void {
    const el = this.#host.zone;
    if (zone === null) {
      this.#lit = null;
      if (el.dataset["on"] !== undefined) delete el.dataset["on"];
      return;
    }
    const rect = zoneBox(this.#area, zone, this.#chatW, this.#freeSize());
    const was = this.#lit;
    this.#lit = { zone, rect, snapping };
    if (was !== null && was.zone === zone && was.snapping === snapping) return;
    el.dataset["kind"] = zone === "chat" ? "chat" : "tile";
    if (snapping) el.dataset["snap"] = "";
    else delete el.dataset["snap"];
    // Lit afresh, it appears where it lands and only fades in; once lit, it glides from one to the next.
    const appearing = el.dataset["on"] === undefined;
    if (appearing) el.style.transition = "opacity 140ms ease";
    el.style.transform = `translate3d(${rect.x.toFixed(2)}px, ${rect.y.toFixed(2)}px, 0)`;
    el.style.width = `${rect.w.toFixed(2)}px`;
    el.style.height = `${rect.h.toFixed(2)}px`;
    if (appearing) {
      void el.offsetWidth;
      el.style.transition = "";
    }
    el.dataset["on"] = "";
  }

  #updateZone(gesture: Gesture): void {
    const rect = this.#rect();
    const slot = this.#slot();
    const pointer = { x: gesture.px, y: gesture.py };
    // Pushed into an edge (or, Shift held, anywhere: the desk in thirds), a tile lights as for a window; brought toward
    // the trailing side, the chat's place. The pointer on the Bar is the Bar's: there, it goes home.
    const onBar = pointerOnBar(this.#area, pointer);
    gesture.cell = gesture.shift && !onBar ? thirdsCell(pointer, stageOf(this.#area), gesture.cell, SNAP_HYSTERESIS) : null;
    gesture.zone = onBar || !gesture.moved ? null : gesture.cell !== null ? cellZone(gesture.cell) : snapZone(this.#area, pointer);
    this.#light(gesture.zone, gesture.cell !== null);
    // The chat's place is hinted as the card comes toward it, until it is lit.
    this.#hint.target = gesture.zone === null && gesture.moved && !gesture.shift ? chatApproach(this.#area, pointer) : 0;
    const zone = gesture.zone === null ? dockZone(this.#area, slot, rect, pointer) : { inZone: false, approach: 0 };
    if (!zone.inZone) gesture.armed = true;
    // (Only once it moves: a card left resting in reach of its slot, pressed and let go where it is, was only taken up.)
    gesture.inZone = zone.inZone && gesture.armed && gesture.moved;
    // The slot comes up as the card comes back toward it, never as it leaves (just torn off, it is still beside it).
    const away = Math.hypot(rect.x + rect.w / 2 - (slot.x + slot.w / 2), rect.y + rect.h - (slot.y + slot.h));
    gesture.farthest = Math.max(gesture.farthest ?? away, away);
    const returning = clamp((gesture.farthest - away) / 60, 0, 1);
    this.#setGhost(gesture.inZone ? 1 : 0.5 * zone.approach * returning, gesture.inZone);
    this.#preview.target = gesture.inZone ? 1 : 0;
    if (gesture.inZone && !reduced()) {
      const gx = slot.x + slot.w / 2 - (rect.x + rect.w / 2);
      const gy = slot.y + slot.h / 2 - (rect.y + rect.h / 2);
      const d = Math.hypot(gx, gy) || 1;
      const m = Math.min(PULL_MAX, d * 0.07);
      this.#pull.tx = (gx / d) * m;
      this.#pull.ty = (gy / d) * m;
    } else {
      this.#pull.tx = 0;
      this.#pull.ty = 0;
    }
  }

  #releaseMove(gesture: Gesture, velocity: { x: number; y: number }): void {
    let v = velocity;
    // (Moved by hand, it is a floating card in the lane again; pressed and let go where it was, it is where it was —
    // in the desk's frame still, if a resize left it there: 2026-10-10.)
    if (gesture.moved) this.#inStage = false;
    this.#preview.target = 0;
    this.#pull.tx = this.#pull.ty = 0;
    const fs = this.#finalSize();
    const g = this.#handleOffset(fs.w, fs.h);
    const r: Rect = { x: this.#B.x - g.x, y: this.#B.y - g.y, w: fs.w, h: fs.h };
    const speed = Math.hypot(v.x, v.y);
    // Over the slot, or thrown down into it: docked.
    const projected: Rect = { x: r.x + v.x * GLIDE_TAU_S * 0.6, y: r.y + v.y * GLIDE_TAU_S * 0.6, w: r.w, h: r.h };
    if (gesture.inZone || (gesture.zone === null && gesture.armed && speed > 700 && v.y > 500 && dockZone(this.#area, this.#slot(), projected, { x: gesture.px + v.x * 0.18, y: gesture.py + v.y * 0.18 }).inZone)) {
      this.#startDock(v);
      return;
    }
    this.#setGhost(0, false);
    // Let go over a lit zone: into it. Taken up in its zone and let go where it was: it is there still.
    if (gesture.zone !== null) {
      this.#snapTo(gesture.zone, v);
      return;
    }
    if (gesture.startZone !== null && !gesture.unsnapped) return;
    // Pressed and let go where it was, in the desk's frame (a resize left it there): it settles there, on the desk's
    // bounds — not the lane's, which would move it in (2026-10-10).
    if (this.#inStage) {
      this.#goSpring(restInStage(this.#area, r), "settle", v);
      return;
    }
    // Let go while pressed past an edge: it has met that edge already, so a throw further out turns back off it.
    const area = this.#area;
    const maxX = Math.max(FLOAT_EDGE, area.w - r.w - FLOAT_EDGE);
    const maxY = Math.max(FLOAT_EDGE, area.h - r.h - FLOAT_EDGE);
    const outX = r.x < FLOAT_EDGE - 0.5 ? -1 : r.x > maxX + 0.5 ? 1 : 0;
    const outY = r.y < FLOAT_EDGE - 0.5 ? -1 : r.y > maxY + 0.5 ? 1 : 0;
    if (outX !== 0 && Math.sign(v.x) === outX) v = { x: -v.x * BOUNCE_RESTITUTION, y: v.y };
    if (outY !== 0 && Math.sign(v.y) === outY) v = { x: v.x, y: -v.y * BOUNCE_RESTITUTION };
    const out = outX !== 0 || outY !== 0;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    if (speed > 600) {
      // Where the throw would land, kept inside: the anchor nearest it catches it.
      const lx = clamp(cx + v.x * GLIDE_TAU_S, FLOAT_EDGE + r.w / 2, maxX + r.w / 2);
      const ly = clamp(cy + v.y * GLIDE_TAU_S, FLOAT_EDGE + r.h / 2, maxY + r.h / 2);
      const near = nearestAnchor(area, lx, ly, r.w, r.h);
      if (near !== null && near.distance < ANCHOR_THROW_PX) this.#goSpring(near.spot, "anchor", v, true);
      else if (out) this.#goSpring(restFor(area, { x: outX !== 0 ? r.x : r.x + v.x * GLIDE_TAU_S, y: outY !== 0 ? r.y : r.y + v.y * GLIDE_TAU_S, w: r.w, h: r.h }), "rebound", v);
      else this.#startCoast(v);
      return;
    }
    const near = nearestAnchor(area, cx, cy, r.w, r.h);
    if (near !== null && near.distance < ANCHOR_SETTLE_PX) this.#goSpring(near.spot, "settle", v);
    else if (speed > 160 && !out) this.#startCoast(v);
    else this.#goSpring(restFor(area, r), out ? "rebound" : "settle", v);
  }

  /* ------------------------------ motion ------------------------------ */

  #goSpring(to: { x: number; y: number }, name: keyof typeof ANSWER_SPRINGS, v: { x: number; y: number } | null, bounce = false): void {
    const fs = this.#finalSize();
    const g = this.#handleOffset(fs.w, fs.h);
    const spring = springOf(name);
    const tx = to.x + g.x;
    const ty = to.y + g.y;
    // The throw carries into the landing, but never more than the spring absorbs without sailing past its spot.
    const omega = (2 * Math.PI) / spring.response;
    const k = spring.damping >= 0.95 ? 1 : 0.8;
    const cap = (vel: number, d: number): number => clamp(vel, -omega * Math.max(Math.abs(d), 40) * k, omega * Math.max(Math.abs(d), 40) * k);
    const speed = v === null ? 0 : Math.hypot(v.x, v.y);
    const scaled = v === null || speed <= 3200 ? (v ?? { x: 0, y: 0 }) : { x: (v.x / speed) * 3200, y: (v.y / speed) * 3200 };
    this.#V = { x: cap(scaled.x, tx - this.#B.x), y: cap(scaled.y, ty - this.#B.y) };
    this.#motion = { kind: "spring", tx, ty, spring, bounce };
    this.#kick();
  }

  #startCoast(v: { x: number; y: number }): void {
    const speed = Math.hypot(v.x, v.y);
    this.#V = speed > 4000 ? { x: (v.x / speed) * 4000, y: (v.y / speed) * 4000 } : { ...v };
    this.#motion = { kind: "coast" };
    this.#kick();
  }

  #stepMotion(dt: number): boolean {
    const motion = this.#motion;
    if (motion === null) return false;
    if (motion.kind === "spring") {
      const x = stepSpring(this.#B.x, this.#V.x, motion.tx, motion.spring, dt);
      const y = stepSpring(this.#B.y, this.#V.y, motion.ty, motion.spring, dt);
      this.#B = { x: x.x, y: y.x };
      this.#V = { x: x.v, y: y.v };
      if (motion.bounce) this.#bounceInside();
      if (Math.hypot(this.#B.x - motion.tx, this.#B.y - motion.ty) < 0.25 && Math.hypot(this.#V.x, this.#V.y) < 5) {
        this.#B = { x: motion.tx, y: motion.ty };
        this.#V = { x: 0, y: 0 };
        this.#motion = null;
        // Kept once it is still: its size may still be on its way (a resize called off springs back from the far corner).
        if (this.#morph === null) this.#settled();
        return false;
      }
      return true;
    }
    // Glide: momentum that fades; meeting an edge ends the coast in a small rebound that settles flush.
    const decay = Math.exp(-dt / GLIDE_TAU_S);
    this.#V = { x: this.#V.x * decay, y: this.#V.y * decay };
    this.#B = { x: this.#B.x + this.#V.x * dt, y: this.#B.y + this.#V.y * dt };
    const r = this.#rect();
    const area = this.#area;
    const maxX = Math.max(FLOAT_EDGE, area.w - r.w - FLOAT_EDGE);
    const maxY = Math.max(FLOAT_EDGE, area.h - r.h - FLOAT_EDGE);
    const hitX = (r.x < FLOAT_EDGE && this.#V.x < 0) || (r.x > maxX && this.#V.x > 0);
    const hitY = (r.y < FLOAT_EDGE && this.#V.y < 0) || (r.y > maxY && this.#V.y > 0);
    if (hitX || hitY) {
      const vx = this.#V.x;
      const vy = this.#V.y;
      this.#keepInside();
      const now = this.#rect();
      const aim: Rect = { x: hitX ? now.x : now.x + vx * GLIDE_TAU_S, y: hitY ? now.y : now.y + vy * GLIDE_TAU_S, w: now.w, h: now.h };
      const bounce = reduced() ? 0 : BOUNCE_RESTITUTION;
      this.#goSpring(restFor(area, aim), "rebound", { x: hitX ? -vx * bounce : vx, y: hitY ? -vy * bounce : vy });
      return true;
    }
    if (Math.hypot(this.#V.x, this.#V.y) < GLIDE_STOP_SPEED) {
      const now = this.#rect();
      const near = nearestAnchor(area, now.x + now.w / 2, now.y + now.h / 2, now.w, now.h);
      this.#goSpring(near !== null && near.distance < ANCHOR_SETTLE_PX ? near.spot : restFor(area, now), "settle", this.#V);
    }
    return true;
  }

  #keepInside(): void {
    const r = this.#rect();
    this.#B = {
      x: this.#B.x - (r.x - clamp(r.x, 0, Math.max(0, this.#area.w - r.w))),
      y: this.#B.y - (r.y - clamp(r.y, 0, Math.max(0, this.#area.h - r.h))),
    };
  }

  #bounceInside(): void {
    const r = this.#rect();
    const maxX = Math.max(0, this.#area.w - r.w);
    const maxY = Math.max(0, this.#area.h - r.h);
    if (r.x < 0) {
      this.#B.x -= r.x;
      if (this.#V.x < 0) this.#V.x = -this.#V.x * BOUNCE_RESTITUTION;
    } else if (r.x > maxX) {
      this.#B.x -= r.x - maxX;
      if (this.#V.x > 0) this.#V.x = -this.#V.x * BOUNCE_RESTITUTION;
    }
    if (r.y < 0) {
      this.#B.y -= r.y;
      if (this.#V.y < 0) this.#V.y = -this.#V.y * BOUNCE_RESTITUTION;
    } else if (r.y > maxY) {
      this.#B.y -= r.y - maxY;
      if (this.#V.y > 0) this.#V.y = -this.#V.y * BOUNCE_RESTITUTION;
    }
  }

  /* ------------------------------ the morph ------------------------------ */

  /**
   * One reflow at the start, then the frame follows: the content is laid
   * out at once at its new size and mode (and clipped to the frame as it
   * goes), a still copy of how it was fading out over it.
   */
  #startMorph(to: Size, mode: "docked" | "detached", spring: SpringConfig): Size {
    const from = this.#curSize();
    this.#live = partsOf(this.#content);
    const viewport = this.#live.viewport;
    const scrollTop = viewport?.scrollTop ?? 0;
    const atBottom = viewport === null || scrollTop + viewport.clientHeight >= viewport.scrollHeight - 4;
    const prev = this.#fade;
    this.#removeSnap();
    if (this.#snapHost !== null && !reduced()) {
      // What is on screen now carries on as a still copy, in the old layout.
      const el = this.#content.cloneNode(true) as HTMLElement;
      el.classList.add("desk-answer-still");
      el.removeAttribute("style");
      for (const node of [el, ...el.querySelectorAll<HTMLElement>("[data-testid], [id], [role], [aria-live]")]) {
        node.removeAttribute("data-testid");
        node.removeAttribute("id");
        node.removeAttribute("role");
        node.removeAttribute("aria-live");
      }
      el.setAttribute("aria-hidden", "true");
      el.inert = true;
      el.style.width = `${String(this.#layout.W)}px`;
      el.style.height = `${String(this.#layout.H)}px`;
      this.#snapHost.appendChild(el);
      const parts = partsOf(el);
      if (parts.viewport !== null) parts.viewport.scrollTop = scrollTop;
      this.#snap = { el, W: this.#layout.W, parts };
    }
    // …while the live content takes its new mode and size, once.
    let target = to;
    if (mode === "detached") {
      this.#setMode("detached");
      this.#setFloatLayout(to.w, to.h);
      this.#origin = { x: 0, y: 0 };
    } else {
      this.#setMode("docked");
      const docked = this.#flowRect();
      target = { w: docked.w, h: docked.h, r: RADIUS_DOCKED };
      this.#origin = { x: docked.x, y: docked.y };
      this.#layout = { W: docked.w, H: docked.h };
      this.#dockedH = docked.h;
    }
    if (viewport !== null) viewport.scrollTop = atBottom ? viewport.scrollHeight : scrollTop;
    this.#fade =
      this.#snap === null
        ? null
        : {
            head0: prev?.headNew ?? 1,
            body0: prev?.bodyNew ?? 1,
            headOld: prev?.headNew ?? 1,
            headNew: 0,
            bodyOld: prev?.bodyNew ?? 1,
            bodyOldBlur: 0,
            bodyNew: 0,
            bodyNewBlur: 2,
            bodyNewY: 6,
          };
    this.#morph = { from, to: target, p: reduced() ? 1 : 0, vp: 0, spring, t: 0 };
    this.#render(false);
    this.#kick();
    return target;
  }

  #stepMorph(dt: number): boolean {
    const m = this.#morph;
    if (m === null) return false;
    m.t += dt * 1000;
    if (!reduced()) {
      const next = stepSpring(m.p, m.vp, 1, m.spring, dt);
      m.p = next.x;
      m.vp = next.v;
    } else {
      m.p = 1;
      m.vp = 0;
    }
    const fade = this.#fade;
    if (fade !== null) {
      const easeOut = (k: number): number => 1 - (1 - k) ** 3;
      const kh = clamp(m.t / HEAD_FADE_MS, 0, 1);
      fade.headOld = fade.head0 * (1 - kh * kh);
      fade.headNew = easeOut(kh);
      const ko = clamp(m.t / BODY_OUT_MS, 0, 1);
      fade.bodyOld = fade.body0 * (1 - easeOut(ko));
      fade.bodyOldBlur = 2 * ko;
      const kn = easeOut(clamp((m.t - BODY_IN_DELAY_MS) / BODY_IN_MS, 0, 1));
      fade.bodyNew = kn;
      fade.bodyNewBlur = 2 * (1 - kn);
      fade.bodyNewY = 6 * (1 - kn);
    }
    // Docking: the ghost dissolves into the card arriving in it.
    if (this.#docking && m.p > 0.55) this.#ghost.target = 0;
    const springDone = Math.abs(m.p - 1) < 0.0015 && Math.abs(m.vp) < 0.02;
    const fadeDone = fade === null || m.t >= BODY_IN_DELAY_MS + BODY_IN_MS;
    if (springDone && fadeDone) {
      this.#morph = null;
      this.#size = { w: m.to.w, h: m.to.h };
      this.#r = m.to.r;
      this.#fade = null;
      this.#removeSnap();
      if (this.#motion === null) this.#settled();
      return false;
    }
    return true;
  }

  #removeSnap(): void {
    this.#snap?.el.remove();
    this.#snap = null;
  }

  /* ------------------------------ docking ------------------------------ */

  #startDock(v: { x: number; y: number } | null): void {
    this.#docking = true;
    this.#inStage = false;
    this.#lift_.target = 0;
    this.#preview.target = 0;
    this.#pull.tx = this.#pull.ty = 0;
    this.#setGhost(Math.max(this.#ghost.x, 0.85), true);
    this.#startMorph({ w: 0, h: 0, r: RADIUS_DOCKED }, "docked", springOf("dock"));
    this.#goSpring(this.#origin, "dock", v === null ? null : { x: v.x * 0.5, y: v.y * 0.5 });
  }

  #finishDock(): void {
    this.#docking = false;
    this.#setGhost(0, false);
    this.#syncDocked();
    this.#keepDocked();
  }

  /* ------------------------------ geometry ------------------------------ */

  #measureArea(): void {
    const lane = this.#host.lane;
    const w = lane.clientWidth;
    const h = lane.clientHeight;
    // The desk the lane stands in at its gutters: the tiles a card snaps into are its, as a window's are.
    const desk = lane.offsetParent;
    const stage: Rect =
      desk instanceof HTMLElement && desk.classList.contains("desk-stage")
        ? { x: -lane.offsetLeft, y: -lane.offsetTop, w: desk.clientWidth, h: desk.clientHeight }
        : { x: 0, y: 0, w, h };
    // The pill where it rests, beside the nub at the desk's foot (its box is laid out there even while it is shut).
    const bar = this.#host.bar();
    const box = bar?.getBoundingClientRect() ?? null;
    if (box === null || box.width < 1) {
      const barW = Math.max(1, Math.min(480, w - 58));
      this.#area = { w, h, barX: w - 46 - barW, barW, barTop: h - 8 - BAR_H, stage };
      return;
    }
    const at = lane.getBoundingClientRect();
    const barH = Math.max(BAR_H, box.height);
    this.#area = { w, h, barX: box.left - at.left, barW: box.width, barTop: box.bottom - at.top - barH, stage };
  }

  #slot(): Rect {
    return dockSlot(this.#area, this.#dockedH > 0 ? this.#dockedH : this.#area.h * 0.4);
  }

  /** The docked card's place on the Bar, as it is laid out (read with nothing of ours on it). */
  #flowRect(): Rect {
    const card = this.#host.card;
    this.#css(card, "transform", "");
    const lane = this.#host.lane.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    return { x: box.left - lane.left, y: box.top - lane.top, w: box.width, h: box.height };
  }

  /** Docked and still: where it lies is its layout. */
  #syncDocked(): void {
    const rect = this.#flowRect();
    this.#origin = { x: rect.x, y: rect.y };
    this.#layout = { W: rect.w, H: rect.h };
    this.#size = { w: rect.w, h: rect.h };
    this.#r = RADIUS_DOCKED;
    this.#anchor = { u: 0.5, v: 0.5, gy: null };
    this.#B = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    this.#V = { x: 0, y: 0 };
    if (rect.h > 0) this.#dockedH = rect.h;
  }

  #setFloatLayout(w: number, h: number): void {
    this.#layout = { W: w, H: h };
    this.#css(this.#host.card, "width", `${String(w)}px`);
    this.#css(this.#host.card, "height", `${String(h)}px`);
  }

  #setMode(mode: "docked" | "detached"): void {
    if (this.#mode === mode && this.#host.card.dataset.mode === mode && this.#content.dataset["mode"] === mode) return;
    this.#mode = mode;
    this.#host.card.dataset.mode = mode;
    // (On the content too, for its layout — the message field at its foot, floating — set once the still copy is taken.)
    this.#content.dataset["mode"] = mode;
    if (mode === "docked") {
      this.#css(this.#host.card, "width", "");
      this.#css(this.#host.card, "height", "");
      // (Docked, it is in no zone: the message field goes back to the pill.)
      this.#setZone(null);
    }
    this.#host.floating(mode === "detached");
  }

  /** Its place and its size both come to rest: floating, and in no one's hand, it is kept as it is. */
  #settled(): void {
    if (!this.#docking && this.#gesture === null && this.#mode === "detached") this.#keep();
  }

  /** Docked: kept so on this device, with the size it floats at next. */
  #keepDocked(): void {
    writeFloatSpot({ floating: false, fx: 0, fy: 0, w: this.#floatSize?.w ?? FLOAT_W, h: this.#floatSize?.h ?? 0, cw: Math.round(this.#chatW) });
  }

  /** A floating card at rest: kept where it is on this device — in a zone, the zone, with its own size for when it is taken out. */
  #keep(): void {
    if (this.#mode !== "detached") return;
    const rect = this.#rect();
    if (this.#zone === null) this.#floatSize = { w: rect.w, h: rect.h };
    const own = this.#zone === null ? rect : { ...rect, ...this.#freeSize() };
    writeFloatSpot({
      ...spotFromBox(this.#area, own, true),
      ...(this.#zone !== null ? { zone: this.#zone } : this.#inStage ? { inStage: true } : {}),
      cw: Math.round(this.#chatW),
    });
  }

  #relayout(): void {
    if (this.#destroyed) return;
    // In hand or on its way: laid out once it is still (#tick), so nothing it changed size by meanwhile is lost.
    if (this.#gesture !== null || this.#morph !== null || this.#motion !== null || this.#docking) {
      this.#relayoutPending = true;
      return;
    }
    this.#relayoutPending = false;
    this.#measureArea();
    if (this.#mode === "docked") this.#syncDocked();
    else if (this.#zone !== null) {
      // In a zone, it is the zone's on a desk of any size.
      const box = zoneBox(this.#area, this.#zone, this.#chatW, this.#freeSize());
      this.#size = { w: box.w, h: box.h };
      this.#setFloatLayout(box.w, box.h);
      this.#anchor = { u: 0, v: 0, gy: 0 };
      this.#B = { x: box.x, y: box.y };
      if (this.#zone === "chat") this.#host.place(box.w);
    } else {
      const rect = this.#rect();
      // In the desk's frame (resized out of a tile): whole in the desk, flush where it stands; else whole in the lane.
      const stage = stageOf(this.#area);
      const size = this.#inStage
        ? { w: clamp(rect.w, Math.min(FLOAT_MIN.w, stage.w), stage.w), h: clamp(rect.h, Math.min(FLOAT_MIN.h, stage.h), stage.h) }
        : fitFloatSize(this.#area, rect.w, rect.h);
      if (size.w !== rect.w || size.h !== rect.h) {
        this.#size = size;
        this.#setFloatLayout(size.w, size.h);
      }
      const to = this.#inStage ? restInStage(this.#area, { x: rect.x, y: rect.y, ...size }) : restFor(this.#area, { x: rect.x, y: rect.y, ...size }, false);
      this.#anchor = { u: 0, v: 0, gy: 0 };
      this.#B = { x: to.x, y: to.y };
    }
    this.#render(true);
  }

  #local(clientX: number, clientY: number): { x: number; y: number } {
    return { x: clientX - this.#laneRect.left, y: clientY - this.#laneRect.top };
  }

  #curSize(): Size {
    const m = this.#morph;
    if (m === null) return { w: this.#size.w, h: this.#size.h, r: this.#r };
    return { w: m.from.w + (m.to.w - m.from.w) * m.p, h: m.from.h + (m.to.h - m.from.h) * m.p, r: m.from.r + (m.to.r - m.from.r) * m.p };
  }

  #finalSize(): Size {
    return this.#morph?.to ?? { w: this.#size.w, h: this.#size.h, r: this.#r };
  }

  #handleOffset(w: number, h: number): { x: number; y: number } {
    const a = this.#anchor;
    return { x: a.u * w, y: a.gy ?? a.v * h };
  }

  #rect(): Rect {
    const s = this.#curSize();
    const g = this.#handleOffset(s.w, s.h);
    return { x: this.#B.x - g.x, y: this.#B.y - g.y, w: s.w, h: s.h };
  }

  /** Hold the card by (px, py) from here on, without moving it. */
  #setHandle(px: number, py: number, fixedY: boolean): void {
    const r = this.#rect();
    this.#anchor = { u: r.w > 0 ? (px - r.x) / r.w : 0.5, v: r.h > 0 ? (py - r.y) / r.h : 0.5, gy: fixedY ? py - r.y : null };
    this.#B = { x: px, y: py };
  }

  #setGhost(target: number, hot: boolean): void {
    this.#ghost.target = target;
    if (this.#ghost.hot !== hot) {
      this.#ghost.hot = hot;
      this.#host.ghost.toggleAttribute("data-hot", hot);
    }
  }

  /* ------------------------------ drawing ------------------------------ */

  #css(el: HTMLElement, prop: string, value: string): void {
    let cache = this.#styles.get(el);
    if (cache === undefined) {
      cache = {};
      this.#styles.set(el, cache);
    }
    if (cache[prop] === value) return;
    cache[prop] = value;
    el.style.setProperty(prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), value);
  }

  /** `still`: nothing moves, so the card sits on whole device pixels (crisp text at rest). */
  #render(still: boolean): void {
    const card = this.#host.card;
    const s = this.#curSize();
    const g = this.#handleOffset(s.w, s.h);
    const x = this.#B.x - g.x;
    const y = this.#B.y - g.y;
    const calm = reduced();
    const sc = calm ? 1 : (1 + LIFT_SCALE * this.#lift_.x) * (1 - PREVIEW_SCALE * this.#preview.x) * (1 + 0.018 * this.#pulse.x);
    let vx = x + g.x * (1 - sc) + this.#pull.x;
    let vy = y + g.y * (1 - sc) + this.#pull.y - (calm ? 0 : LIFT_RISE * this.#rise.x);
    const restingDocked = this.#mode === "docked" && still && !this.#docking && this.#morph === null && this.#gesture === null;
    if (still) {
      const dpr = window.devicePixelRatio || 1;
      vx = Math.round(vx * dpr) / dpr;
      vy = Math.round(vy * dpr) / dpr;
    }
    const tx = vx - this.#origin.x;
    const ty = vy - this.#origin.y;
    const transform =
      restingDocked && Math.abs(tx) < 0.01 && Math.abs(ty) < 0.01 && Math.abs(sc - 1) < 1e-4
        ? ""
        : `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0)${Math.abs(sc - 1) > 1e-4 ? ` scale(${sc.toFixed(5)})` : ""}`;
    // (About its corner: the translate already holds the point it is held by still as it scales.)
    this.#css(card, "transform", transform);
    // The frame drawn at its size of the moment (scaled from the layout, its corners kept round)…
    const { W, H } = this.#layout;
    const sx = W > 0 ? s.w / W : 1;
    const sy = H > 0 ? s.h / H : 1;
    if (Math.abs(sx - 1) > 1e-4 || Math.abs(sy - 1) > 1e-4) {
      this.#css(this.#frame, "transform", `scale(${sx.toFixed(5)}, ${sy.toFixed(5)})`);
      this.#css(this.#frame, "borderRadius", `${(s.r / sx).toFixed(3)}px / ${(s.r / sy).toFixed(3)}px`);
    } else {
      this.#css(this.#frame, "transform", "");
      this.#css(this.#frame, "borderRadius", this.#mode === "docked" && this.#morph === null ? "" : `${s.r.toFixed(3)}px`);
    }
    // Over the desk's foot corner (the chat's place), the nub is a hole in its glass, as in a window there.
    this.#css(this.#frame, "clipPath", Math.abs(sx - 1) > 1e-4 || Math.abs(sy - 1) > 1e-4 ? "" : this.#holed(vx, vy, W, H));
    // …and the content clipped to it, its header's buttons riding the frame's edge.
    const morphing = this.#morph !== null;
    const clip = morphing || Math.abs(sx - 1) > 1e-4 || Math.abs(sy - 1) > 1e-4 ? `xywh(0 0 ${s.w.toFixed(2)}px ${s.h.toFixed(2)}px round ${s.r.toFixed(2)}px)` : "";
    this.#css(this.#content, "clipPath", clip);
    this.#ride(this.#live, s.w - W);
    const fade = this.#fade;
    if (this.#live.head !== null) this.#css(this.#live.head, "opacity", fade === null ? "" : fade.headNew.toFixed(3));
    if (this.#live.body !== null) {
      this.#css(this.#live.body, "opacity", fade === null ? "" : fade.bodyNew.toFixed(3));
      this.#css(this.#live.body, "filter", fade !== null && fade.bodyNewBlur > 0.01 ? `blur(${fade.bodyNewBlur.toFixed(2)}px)` : "");
      this.#css(this.#live.body, "transform", fade !== null && fade.bodyNewY > 0.01 ? `translate3d(0, ${fade.bodyNewY.toFixed(2)}px, 0)` : "");
    }
    if (this.#live.foot !== null) this.#css(this.#live.foot, "opacity", fade === null ? "" : fade.bodyNew.toFixed(3));
    const snap = this.#snap;
    if (snap !== null && fade !== null) {
      this.#css(snap.el, "clipPath", clip === "" ? `xywh(0 0 ${s.w.toFixed(2)}px ${s.h.toFixed(2)}px round ${s.r.toFixed(2)}px)` : clip);
      this.#ride(snap.parts, s.w - snap.W);
      if (snap.parts.head !== null) this.#css(snap.parts.head, "opacity", fade.headOld.toFixed(3));
      if (snap.parts.body !== null) {
        this.#css(snap.parts.body, "opacity", fade.bodyOld.toFixed(3));
        this.#css(snap.parts.body, "filter", fade.bodyOldBlur > 0.01 ? `blur(${fade.bodyOldBlur.toFixed(2)}px)` : "");
      }
      if (snap.parts.foot !== null) this.#css(snap.parts.foot, "opacity", fade.bodyOld.toFixed(3));
    }
    if (this.#lift !== null) this.#css(this.#lift, "opacity", this.#lift_.x.toFixed(3));
    if (this.#sheen !== null) this.#css(this.#sheen, "opacity", (this.#lift_.x * 0.9).toFixed(3));
    this.#css(this.#vis, "willChange", still ? "" : "transform");
    // The ghost: the docked slot, faded in as the card comes back.
    const slot = this.#slot();
    const ghost = this.#host.ghost;
    this.#css(ghost, "opacity", this.#ghost.x.toFixed(3));
    this.#css(ghost, "transform", `translate3d(${slot.x.toFixed(2)}px, ${slot.y.toFixed(2)}px, 0)`);
    this.#css(ghost, "width", `${slot.w.toFixed(2)}px`);
    this.#css(ghost, "height", `${slot.h.toFixed(2)}px`);
    // The chat's place, hinted: a rail at the desk's trailing edge, level with the middle of the place.
    const hint = this.#hint.x;
    let hinted: Rect | null = null;
    if (hint > 0.01) {
      const place = chatBox(this.#area, this.#chatW);
      const h = place.h * HINT_SHARE;
      hinted = { x: place.x + place.w - HINT_INSET - HINT_W, y: place.y + (place.h - h) / 2, w: HINT_W, h };
      this.#css(this.#host.hint, "transform", `translate3d(${hinted.x.toFixed(2)}px, ${hinted.y.toFixed(2)}px, 0) scaleY(${(0.6 + 0.4 * hint).toFixed(4)})`);
      this.#css(this.#host.hint, "height", `${h.toFixed(2)}px`);
    }
    this.#css(this.#host.hint, "opacity", hint > 0.01 ? hint.toFixed(3) : "");
    // What the card covers: as drawn, and a little ahead of it while it moves; and the zone lit (or the hint, with its glow).
    const lead = still ? 0 : COVER_LEAD;
    const drawn: Rect = { x: vx - lead, y: vy - lead, w: s.w * sc + lead * 2, h: s.h * sc + lead * 2 };
    const zone = this.#lit?.rect ?? (hinted === null ? null : { x: hinted.x - 16, y: hinted.y - 16, w: hinted.w + 32, h: hinted.h + 32 });
    this.#host.cover(drawn, this.#ghost.x > 0.01 ? slot : null, zone);
  }

  /**
   * The glass's clip with the nub a hole in it, the card's corner at (x, y)
   * in the lane and W × H its size — or none, where the nub is not over it.
   * Its shadow stops at the desk's edges, as a window's does (the shell
   * round the desk lies over it), but for its leading side, over the desk.
   */
  #holed(x: number, y: number, W: number, H: number): string {
    const stage = stageOf(this.#area);
    const right = stage.x + stage.w;
    const bottom = stage.y + stage.h;
    // (Nowhere near the corner — as it mostly is — the nub is not asked how it is cut.)
    if (x + W < right - HOLE_NEAR || y + H < bottom - HOLE_NEAR) return "";
    const notch = this.#host.notch();
    if (notch === null) return "";
    const span = nubExtent(notch.shape);
    if (!rectsOverlap({ x, y, w: W, h: H }, { x: right - span, y: bottom - span, w: span, h: span })) return "";
    const n = (value: number): string => value.toFixed(2);
    const reach = 120;
    const top = Math.max(-reach, stage.y - y);
    const r = Math.min(W + reach, right - x);
    const b = Math.min(H + reach, bottom - y);
    return `path(evenodd, "M ${n(-reach)} ${n(top)} H ${n(r)} V ${n(b)} H ${n(-reach)} Z ${nubOutline(notch.shape, right - x, bottom - y, notch.corner, 0, 0)}")`;
  }

  /** The header's buttons stay on the frame's right edge and the grab on its centre while the frame is wider or narrower than the layout; the title gives way where they overlap it. */
  #ride(parts: Parts, dx: number): void {
    const on = Math.abs(dx) > 0.01;
    if (parts.actions !== null) this.#css(parts.actions, "transform", on ? `translate3d(${dx.toFixed(2)}px, 0, 0)` : "");
    if (parts.grab !== null) this.#css(parts.grab, "transform", on ? `translate3d(${(dx / 2).toFixed(2)}px, 0, 0)` : "");
    if (parts.title !== null) this.#css(parts.title, "clipPath", dx < -0.01 ? `inset(0 ${(-dx).toFixed(2)}px 0 0)` : "");
  }
}
