/**
 * The Bar's nub in motion (docs/desk-agent.md §1, "The Bar"): its swell
 * under the pointer; for its menu, the nub letting go of the desk's edges —
 * what is of it in the corner draining away as it lifts out, a button of its
 * own — and its droplets fanning out of it over the desk's quarter, each
 * pulling a neck of goo that stretches and snaps, and running back into it
 * as it settles into the corner again; and the pill a droplet becomes, tied
 * to the nub by a thin bridge until it lets go. The goo is the public technique —
 * shapes blurred and their alpha thresholded (DeskNub's filter) — so what
 * is drawn here is only circles, ellipses and lines; where they come close
 * they melt together.
 *
 * Everything is read off the clock, not stepped: the swell is shared with
 * main's notch view, which reads the same wall clock to draw the nub over a
 * live page (NotchApp, `swellAt`), and a slowed clock
 * (`--desk-nub-time-scale` on the document) slows every part alike.
 *
 * Imperative on purpose: one animation frame loop writes the goo's shapes,
 * the droplets' buttons and the pill's glass, and nothing re-renders for
 * it. Coordinates are the corner's: the desk's trailing foot corner is
 * (0, 0), up and left negative — the nub's box (`.desk-nub`) has its own
 * bottom-right corner there, and its goo's viewBox is drawn from it.
 */

import { NUB_DROP_R, NUB_IDLE, NUB_SWELL, nubBetween, nubDrops, nubFace, nubLetGo, nubOutline, type NotchShape, type Point, type Rect } from "../../lib/desk/geometry";
import { EASE_MORPH_OPEN, EASE_SMOOTH_OUT, clamp, springAt, springDone, type SpringConfig } from "../../lib/desk/motion";

/** Swelling under the pointer and settling back: transitions.dev's plus → menu morph's open and its quicker, calm close. */
export const SWELL_IN_MS = 350;
export const SWELL_OUT_MS = 250;

/**
 * The nub letting go of the corner, a little past where it stands free and
 * back, once its fill is in over the hole (FREE_DELAY_MS); and settling into
 * the corner again, calm, as its droplets run back into it.
 */
const FREE_OPEN: SpringConfig = { response: 0.4, damping: 0.7 };
const FREE_CLOSE: SpringConfig = { response: 0.3, damping: 0.95 };
const FREE_DELAY_MS = 40;
/**
 * The droplets pinching off — a small overshoot, swept round the fan from
 * the foot up, each a stagger after the one before, out of the nub as it
 * lifts — and merging back, calm, the last out first back.
 */
const DROP_OPEN: SpringConfig = { response: 0.44, damping: 0.6 };
const DROP_CLOSE: SpringConfig = { response: 0.32, damping: 0.95 };
const DROP_OPEN_STAGGER_MS = [FREE_DELAY_MS, FREE_DELAY_MS + 28, FREE_DELAY_MS + 56];
const DROP_CLOSE_STAGGER_MS = [44, 22, 0];
/** The pill out of its droplet, a little past its size and back; into the nub, calm. */
const PILL_OPEN: SpringConfig = { response: 0.42, damping: 0.78 };
const PILL_CLOSE: SpringConfig = { response: 0.28, damping: 1 };
/**
 * The goo's own: the neck a droplet pulls from the nub, as thick as NECK_W
 * while they touch and gone once they are NECK_SNAP apart (the blur loses it
 * well before: it snaps) — and the one the nub pulls from the corner as it
 * lifts out; the bridge that ties the pill to the nub, gone BRIDGE_SNAP of
 * the way into its morph.
 */
const NECK_W = 14;
const NECK_SNAP = 12;
const BRIDGE_W = 13;
const BRIDGE_SNAP = 0.55;
/** The nub's fill (the card's, at the answer's 94%) comes in as the droplets leave, and goes once they are back. */
const PAINT_IN_MS = 110;
const PAINT_OUT_MS = 160;
const PAINT_ALPHA = 0.94;
/** Reduced motion: no goo travel — the droplets are where they rest, and fade in and out with the fill. */
const CALM_FADE_MS = 150;

/** How swelled the nub is, on its way from `from` to `to` since `at` (wall-clock ms) over `ms`: DeskNotchFrame.swelling. */
export interface Swelling {
  from: number;
  to: number;
  at: number;
  ms: number;
}

/** The swell at `now` (wall-clock ms): 0 at rest, 1 swelled, past it a moment as it overshoots. */
export function swellAt(swelling: Swelling, now = Date.now()): number {
  if (swelling.ms <= 0) return swelling.to;
  const k = clamp((now - swelling.at) / swelling.ms, 0, 1);
  const ease = swelling.to > swelling.from ? EASE_MORPH_OPEN : EASE_SMOOTH_OUT;
  return swelling.from + (swelling.to - swelling.from) * ease(k);
}

export function swellDone(swelling: Swelling, now = Date.now()): boolean {
  return now - swelling.at >= swelling.ms;
}

/** How much slower than life the nub moves (a capture slows it to see the goo): `--desk-nub-time-scale`, 1 unless set. */
export function nubTimeScale(): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return 1;
  const raw = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--desk-nub-time-scale"));
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function reduced(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 0 below a, 1 above b, eased between. */
function smooth(a: number, b: number, x: number): number {
  const k = clamp((x - a) / (b - a), 0, 1);
  return k * k * (3 - 2 * k);
}

function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t };
}

/** One droplet's way out and back: from `from` toward `to` (0 in the nub, 1 where it rests) on a spring let go at `at`, after `delay`. */
interface Track {
  from: number;
  to: number;
  at: number;
  delay: number;
  spring: SpringConfig;
  scale: number;
}

function trackTime(track: Track, now: number): number {
  return (now - track.at - track.delay * track.scale) / 1000 / track.scale;
}

function trackAt(track: Track, now: number): number {
  if (track.from === track.to) return track.to;
  return track.from + (track.to - track.from) * springAt(trackTime(track, now), track.spring);
}

function trackDone(track: Track, now: number): boolean {
  return track.from === track.to || springDone(trackTime(track, now), track.spring);
}

interface Tween {
  from: number;
  to: number;
  at: number;
  ms: number;
}

function tweenAt(tween: Tween, now: number): number {
  if (tween.ms <= 0) return tween.to;
  return tween.from + (tween.to - tween.from) * EASE_SMOOTH_OUT(clamp((now - tween.at) / tween.ms, 0, 1));
}

/** The nub's parts as DeskNub draws them. */
export interface NubParts {
  /** The nub's box: its bottom-right corner is the desk's. */
  root: HTMLElement;
  /**
   * The goo: the nub's own outline (filled while the droplets are out), what is left of it in the corner as it lets
   * go and the neck it pulls from there, the nub's circle, the droplets, their necks, the pill's bridge.
   */
  paint: SVGSVGElement;
  base: SVGPathElement;
  anchor: SVGCircleElement;
  tether: SVGLineElement;
  blob: SVGCircleElement;
  drops: readonly SVGEllipseElement[];
  necks: readonly SVGLineElement[];
  bridge: SVGLineElement;
  bridgeEnd: SVGCircleElement;
  /** The nub's button and its mark, moved with the swell. */
  face: HTMLElement;
  mark: HTMLElement;
  /** The droplets' buttons (the prompt, the microphone, past chats), each where its droplet is. */
  items: readonly HTMLElement[];
}

/** The pill: its box (`.desk-bar`, laid out where it rests), its glass, and its row. */
export interface PillParts {
  bar: HTMLElement;
  frame: HTMLElement;
  body: HTMLElement;
}

export interface NubMotionHost {
  parts: NubParts;
  pill(): PillParts | null;
  /** The desk's corner radius, which the nub's outline rounds into. */
  corner(): number;
  /** What of the nub is in the corner now, or none (it has let go for its menu): DeskBar has the engine cut it through the well and the windows. */
  shape(shape: NotchShape | null): void;
}

/** What the pill comes out of: the prompt's droplet, the microphone's, or the nub itself (⌘I, the field taking the keyboard). */
export type PillSource = "prompt" | "mic" | "nub";

interface PillMorph {
  open: boolean;
  at: number;
  scale: number;
  /** Where it comes from (open) or goes from (closing), in the corner's coordinates. */
  from: Rect;
  /** A droplet it came out of: tied to the nub by the bridge until it lets go. */
  bridged: boolean;
  /** Out of the nub itself: its glass fades in as it leaves (a droplet's is there already). */
  fades: boolean;
  /** Where it is drawn now. */
  now: Rect;
}

export class NubMotion {
  readonly #host: NubMotionHost;
  readonly #rests = nubDrops();
  #swelling: Swelling = { from: 0, to: 0, at: 0, ms: 0 };
  /** The nub's way out of the corner for its menu: 0 in it, 1 free. */
  #free: Track = { from: 0, to: 0, at: 0, delay: 0, spring: FREE_CLOSE, scale: 1 };
  #drops: Track[] = this.#rests.map(() => ({ from: 0, to: 0, at: 0, delay: 0, spring: DROP_CLOSE, scale: 1 }));
  /** Each droplet's way last frame, for how fast it is going (it stretches with its speed). */
  #was: number[] = this.#rests.map(() => 0);
  #wasT = 0;
  /** Droplets something else stands in for: the pill just out of one, the conversations grown from one. */
  #hidden: boolean[] = this.#rests.map(() => false);
  #taken: boolean[] = this.#rests.map(() => false);
  #menuOpen = false;
  #paint: Tween = { from: 0, to: 0, at: 0, ms: 0 };
  #pill: PillMorph | null = null;
  #shapeKey = "";
  #raf = 0;
  #destroyed = false;

  constructor(host: NubMotionHost) {
    this.#host = host;
    this.#render(performance.now(), Date.now());
  }

  destroy(): void {
    this.#destroyed = true;
    if (this.#raf !== 0) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#clearPill();
  }

  /** Swell (the pointer resting on it, its menu out) or settle; what it is on its way to, for the notch view to read off the same clock. */
  swell(to: 0 | 1): Swelling {
    const now = Date.now();
    if (this.#swelling.to === to) return this.#swelling;
    const from = swellAt(this.#swelling, now);
    this.#swelling = { from, to, at: now, ms: reduced() ? 0 : Math.round((to === 1 ? SWELL_IN_MS : SWELL_OUT_MS) * nubTimeScale()) };
    this.#kick();
    return this.#swelling;
  }

  /** The nub out of the corner, a button of its own, and its droplets out of it. */
  openMenu(): void {
    if (this.#menuOpen) return;
    this.#menuOpen = true;
    const now = performance.now();
    const scale = nubTimeScale();
    const calm = reduced();
    this.#free = { from: calm ? 1 : trackAt(this.#free, now), to: 1, at: now, delay: FREE_DELAY_MS, spring: FREE_OPEN, scale };
    this.#drops = this.#drops.map((track, i) => {
      this.#hidden[i] = this.#taken[i] === true;
      const from = calm ? 1 : trackAt(track, now);
      return { from, to: 1, at: now, delay: DROP_OPEN_STAGGER_MS[i] ?? 0, spring: DROP_OPEN, scale };
    });
    this.#kick();
  }

  /** The droplets back into it, and it back into the corner. */
  closeMenu(): void {
    if (!this.#menuOpen) return;
    this.#menuOpen = false;
    const now = performance.now();
    const scale = nubTimeScale();
    // (Reduced motion: they stay where they are while the fill fades, then are gone.)
    if (reduced()) return this.#kick();
    this.#free = { from: trackAt(this.#free, now), to: 0, at: now, delay: 0, spring: FREE_CLOSE, scale };
    this.#drops = this.#drops.map((track, i) => ({ from: trackAt(track, now), to: 0, at: now, delay: DROP_CLOSE_STAGGER_MS[i] ?? 0, spring: DROP_CLOSE, scale }));
    this.#kick();
  }

  /**
   * A droplet the conversations have grown out of (they stand where it was),
   * or given back. While they are out the other droplets run back into the
   * nub, out of their way; given back with the menu still out, they fan out
   * again.
   */
  take(index: number, taken: boolean): void {
    if (this.#taken[index] === taken) return;
    this.#taken[index] = taken;
    if (taken || this.#menuOpen) this.#hidden[index] = taken;
    if (this.#menuOpen && reduced()) {
      // (Reduced motion: no running back — they are gone while the conversations stand there, and back after.)
      this.#hidden = this.#hidden.map((hidden, i) => (i === index ? hidden : taken));
    } else if (this.#menuOpen) {
      const now = performance.now();
      const scale = nubTimeScale();
      this.#drops = this.#drops.map((track, i) =>
        i === index ? track : { from: trackAt(track, now), to: taken ? 0 : 1, at: now, delay: 0, spring: taken ? DROP_CLOSE : DROP_OPEN, scale },
      );
    }
    this.#kick();
  }

  /** The pill out of a droplet (or the nub): its glass from the droplet's box to its own, the bridge between it and the nub. */
  openPill(source: PillSource): void {
    const parts = this.#host.pill();
    if (parts === null) return;
    if (reduced()) {
      this.#clearPill();
      this.#pill = null;
      return;
    }
    const now = performance.now();
    // Out of its droplet if that is out (the menu may already be on its way back in), else out of the nub.
    const drop = source === "prompt" ? 0 : source === "mic" ? 1 : -1;
    const track = this.#drops[drop];
    const fromDrop = track !== undefined && this.#hidden[drop] !== true && trackAt(track, now) > 0.5;
    const from = fromDrop ? this.#dropBox(drop) : this.#faceBox();
    if (fromDrop) this.#hidden[drop] = true;
    this.#pill = { open: true, at: now, scale: nubTimeScale(), from, bridged: fromDrop, fades: !fromDrop, now: from };
    this.#render(now, Date.now());
    this.#kick();
  }

  /** The pill back into the nub. */
  closePill(): void {
    const parts = this.#host.pill();
    if (parts === null || reduced()) {
      this.#clearPill();
      this.#pill = null;
      return;
    }
    const from = this.#pill?.now ?? this.#pillBox(parts);
    const now = performance.now();
    this.#pill = { open: false, at: now, scale: nubTimeScale(), from, bridged: false, fades: true, now: from };
    this.#render(now, Date.now());
    this.#kick();
  }

  /** Something it is drawn from changed (the desk resized, its corners): drawn again as it is. */
  refresh(): void {
    this.#shapeKey = "";
    this.#render(performance.now(), Date.now());
  }

  /* ------------------------------ the frame ------------------------------ */

  #kick(): void {
    if (this.#raf !== 0 || this.#destroyed) return;
    this.#raf = requestAnimationFrame(this.#tick);
  }

  #tick = (): void => {
    this.#raf = 0;
    if (this.#destroyed) return;
    const now = performance.now();
    const moving = this.#render(now, Date.now());
    if (moving) this.#raf = requestAnimationFrame(this.#tick);
  };

  /** One frame of everything; whether anything is still on its way. */
  #render(now: number, wall: number): boolean {
    const parts = this.#host.parts;
    const dt = this.#wasT === 0 ? 1 / 60 : Math.max(1 / 240, (now - this.#wasT) / 1000);
    this.#wasT = now;
    let moving = false;

    // The swell, and the nub letting go of the corner for its menu: what is of it in the corner (the engine's hole, and
    // the fill over it, and its circle in the goo), the neck it pulls from there, its own circle in the goo, its face.
    const s = swellAt(this.#swelling, wall);
    if (!swellDone(this.#swelling, wall)) moving = true;
    const swelled = nubBetween(NUB_IDLE, NUB_SWELL, s);
    const freed = trackAt(this.#free, now);
    if (!trackDone(this.#free, now)) moving = true;
    const { corner, button: shape } = nubLetGo(swelled, freed);
    const key = `${corner === null ? "-" : `${corner.radius.toFixed(2)}|${corner.sink.toFixed(2)}|${corner.fillet.toFixed(2)}`}|${shape.radius.toFixed(2)}|${shape.sink.toFixed(2)}|${this.#host.corner().toFixed(1)}`;
    if (key !== this.#shapeKey) {
      this.#shapeKey = key;
      this.#host.shape(corner);
      parts.base.setAttribute("d", corner === null ? "" : nubOutline(corner, 0, 0, this.#host.corner(), 0, 0));
      parts.anchor.setAttribute("cx", corner === null ? "0" : (-corner.sink).toFixed(2));
      parts.anchor.setAttribute("cy", corner === null ? "0" : (-corner.sink).toFixed(2));
      parts.anchor.setAttribute("r", corner === null || freed <= 0.001 ? "0" : corner.radius.toFixed(2));
      parts.blob.setAttribute("cx", (-shape.sink).toFixed(2));
      parts.blob.setAttribute("cy", (-shape.sink).toFixed(2));
      parts.blob.setAttribute("r", shape.radius.toFixed(2));
      const k = shape.radius / NUB_IDLE.radius;
      const shift = -(shape.sink - NUB_IDLE.sink);
      parts.face.style.transform = s === 0 && freed === 0 ? "" : `translate(${shift.toFixed(2)}px, ${shift.toFixed(2)}px) scale(${k.toFixed(4)})`;
      // (Free, its mark is centred on it: in the corner, it sits where the circle shows, a little up and in — 1px, its
      // margin's half, .desk-nub-mark — so it comes that far back down and out.)
      const centred = clamp(freed, 0, 1);
      parts.mark.style.transform = s === 0 && freed === 0 ? "" : `translate(${centred.toFixed(2)}px, ${centred.toFixed(2)}px) scale(${((1 + 0.08 * s) / k).toFixed(4)})`;
    }
    const centre: Point = { x: -shape.sink, y: -shape.sink };
    // The neck the nub pulls from the corner as it lifts out, until it snaps.
    const tethered = corner !== null && freed > 0.001 && !reduced();
    const tetherGap = corner === null ? Infinity : Math.hypot(centre.x + corner.sink, centre.y + corner.sink) - shape.radius - corner.radius;
    parts.tether.setAttribute("x1", corner === null ? "0" : (-corner.sink).toFixed(2));
    parts.tether.setAttribute("y1", corner === null ? "0" : (-corner.sink).toFixed(2));
    parts.tether.setAttribute("x2", centre.x.toFixed(2));
    parts.tether.setAttribute("y2", centre.y.toFixed(2));
    parts.tether.setAttribute("stroke-width", tethered ? (NECK_W * (1 - clamp(tetherGap / NECK_SNAP, 0, 1))).toFixed(2) : "0");

    // The droplets, and the neck each pulls from the nub.
    const calm = reduced();
    const ways = this.#drops.map((track) => trackAt(track, now));
    if (this.#drops.some((track) => !trackDone(track, now))) moving = true;
    const at: Array<{ p: Point; r: number; shown: boolean }> = [];
    ways.forEach((q, i) => {
      const rest = this.#rests[i]!;
      const p = { x: centre.x + (rest.x - centre.x) * q, y: centre.y + (rest.y - centre.y) * q };
      // Out of the nub smaller, its own size as it leaves.
      const r = NUB_DROP_R * (0.5 + 0.5 * smooth(0, 0.65, q));
      // Stretched along its way by its speed, as a drop falling is.
      const speed = (Math.abs(q - (this.#was[i] ?? q)) / dt) * Math.hypot(rest.x - centre.x, rest.y - centre.y);
      const stretch = calm ? 0 : clamp(speed / 2600, 0, 0.18);
      const shown = q > 0.002 && this.#hidden[i] !== true;
      const drop = parts.drops[i];
      if (drop !== undefined) {
        drop.setAttribute("cx", p.x.toFixed(2));
        drop.setAttribute("cy", p.y.toFixed(2));
        drop.setAttribute("rx", shown ? (r * (1 - stretch * 0.5)).toFixed(2) : "0");
        drop.setAttribute("ry", shown ? (r * (1 + stretch)).toFixed(2) : "0");
      }
      at.push({ p, r, shown });
      const item = parts.items[i];
      if (item !== undefined) {
        const k = this.#hidden[i] === true ? 0 : calm ? 1 : smooth(0.55, 0.92, q);
        item.style.transform = Math.abs(q - 1) < 0.0005 ? "" : `translate(${(p.x - rest.x).toFixed(2)}px, ${(p.y - rest.y).toFixed(2)}px) scale(${(0.6 + 0.4 * k).toFixed(3)})`;
        item.style.opacity = calm ? "" : k.toFixed(3);
        item.style.filter = calm || k > 0.99 ? "" : `blur(${(2 * (1 - k)).toFixed(2)}px)`;
        // On its way it takes no pointer: coming out from under one resting on the nub, it would say it was there.
        item.style.pointerEvents = calm || q > 0.95 ? "" : "none";
      }
    });
    this.#was = ways;
    at.forEach((drop, i) => {
      const neck = parts.necks[i];
      if (neck === undefined) return;
      const before = { p: centre, r: shape.radius, shown: true };
      const gap = Math.hypot(drop.p.x - before.p.x, drop.p.y - before.p.y) - drop.r - before.r;
      const width = drop.shown && before.shown && !calm ? NECK_W * (1 - clamp(gap / NECK_SNAP, 0, 1)) : 0;
      neck.setAttribute("x1", before.p.x.toFixed(2));
      neck.setAttribute("y1", before.p.y.toFixed(2));
      neck.setAttribute("x2", drop.p.x.toFixed(2));
      neck.setAttribute("y2", drop.p.y.toFixed(2));
      neck.setAttribute("stroke-width", width.toFixed(2));
    });

    // The pill's glass and row as it morphs, and the bridge that ties it to the nub.
    let bridged = false;
    const morph = this.#pill;
    const pill = this.#host.pill();
    if (morph !== null && pill !== null) {
      const t = (now - morph.at) / 1000 / morph.scale;
      const spring = morph.open ? PILL_OPEN : PILL_CLOSE;
      const m = springAt(t, spring);
      const home = this.#pillBox(pill);
      const box = morph.open ? lerpRect(morph.from, home, m) : lerpRect(morph.from, this.#faceBox(), m);
      morph.now = box;
      const inset = `${(box.y - home.y).toFixed(2)}px ${(home.x + home.w - box.x - box.w).toFixed(2)}px ${(home.y + home.h - box.y - box.h).toFixed(2)}px ${(box.x - home.x).toFixed(2)}px`;
      pill.frame.style.inset = inset;
      pill.frame.style.opacity = (morph.open ? (morph.fades ? smooth(0, 0.3, m) : 1) : 1 - smooth(0.5, 1, m)).toFixed(3);
      const row = morph.open ? smooth(0.4, 0.9, m) : 1 - smooth(0, 0.35, m);
      pill.body.style.opacity = row.toFixed(3);
      pill.body.style.filter = row > 0.99 ? "" : `blur(${(2 * (1 - row)).toFixed(2)}px)`;
      pill.body.style.clipPath = `inset(${inset} round 26px)`;
      if (morph.open && morph.bridged && m < BRIDGE_SNAP) {
        bridged = true;
        const end = { x: box.x + box.w - box.h / 2, y: box.y + box.h / 2 };
        parts.bridge.setAttribute("x1", centre.x.toFixed(2));
        parts.bridge.setAttribute("y1", centre.y.toFixed(2));
        parts.bridge.setAttribute("x2", end.x.toFixed(2));
        parts.bridge.setAttribute("y2", end.y.toFixed(2));
        parts.bridge.setAttribute("stroke-width", (BRIDGE_W * (1 - m / BRIDGE_SNAP) ** 0.7).toFixed(2));
        // (Inside the glass, so only the bridge shows past it.)
        parts.bridgeEnd.setAttribute("cx", end.x.toFixed(2));
        parts.bridgeEnd.setAttribute("cy", end.y.toFixed(2));
        parts.bridgeEnd.setAttribute("r", Math.max(0, box.h / 2 - 3).toFixed(2));
      }
      if (springDone(t, spring)) {
        this.#pill = null;
        this.#clearPill();
      } else moving = true;
    }
    if (!bridged) {
      parts.bridge.setAttribute("stroke-width", "0");
      parts.bridgeEnd.setAttribute("r", "0");
    }

    // The nub's fill: while the droplets are out (or on their way back), until it is back in the corner, and while the
    // bridge holds.
    const want = this.#menuOpen || bridged || (!calm && (freed > 0.02 || at.some((drop, i) => drop.shown && (ways[i] ?? 0) > 0.04))) ? 1 : 0;
    if (want !== this.#paint.to) {
      const from = tweenAt(this.#paint, now);
      this.#paint = { from, to: want, at: now, ms: (calm ? CALM_FADE_MS : want === 1 ? PAINT_IN_MS : PAINT_OUT_MS) * nubTimeScale() };
    }
    const paint = tweenAt(this.#paint, now);
    if (now - this.#paint.at < this.#paint.ms) moving = true;
    parts.paint.style.opacity = paint < 0.001 ? "" : (paint * PAINT_ALPHA).toFixed(3);
    // (Reduced motion: once the fill is gone, so are the droplets.)
    if (calm && !this.#menuOpen && paint === 0 && (this.#free.to !== 0 || this.#drops.some((track) => track.to !== 0))) {
      this.#free = { ...this.#free, from: 0, to: 0 };
      this.#drops = this.#drops.map((track) => ({ ...track, from: 0, to: 0 }));
      this.#shapeKey = "";
      moving = true;
    }
    // (Reduced motion: the droplets' buttons come and go with the fill.)
    if (calm) parts.items.forEach((item, i) => (item.style.opacity = this.#hidden[i] === true ? "0" : paint.toFixed(3)));
    return moving;
  }

  /** A droplet's box where it rests. */
  #dropBox(index: number): Rect {
    const rest = this.#rests[index]!;
    return { x: rest.x - NUB_DROP_R, y: rest.y - NUB_DROP_R, w: NUB_DROP_R * 2, h: NUB_DROP_R * 2 };
  }

  /** The nub's face as a box: what the pill shrinks into, and grows out of when no droplet is out. */
  #faceBox(): Rect {
    const face = nubFace(nubBetween(NUB_IDLE, NUB_SWELL, swellAt(this.#swelling)));
    return { x: face.x - 14, y: face.y - 14, w: 28, h: 28 };
  }

  /** The pill's box where it rests, from the corner. */
  #pillBox(parts: PillParts): Rect {
    const root = this.#host.parts.root.getBoundingClientRect();
    const box = parts.bar.getBoundingClientRect();
    return { x: box.left - root.right, y: box.top - root.bottom, w: box.width, h: box.height };
  }

  #clearPill(): void {
    const parts = this.#host.pill();
    if (parts === null) return;
    parts.frame.style.inset = "";
    parts.frame.style.opacity = "";
    parts.body.style.opacity = "";
    parts.body.style.filter = "";
    parts.body.style.clipPath = "";
  }
}
