"use client";

import { useEffect, useRef, useState } from "react";
import {
  DESIGN_W,
  TOUR_HAND_OVER,
  TOUR_MESSAGE,
  TOUR_PAINTED,
  TOUR_READY,
  TOUR_SCENES,
  WALLPAPER,
  type TourMessage,
  type TourScene,
} from "./hero-browser/tour-protocol";

/**
 * The one Pistachio window on the landing page.
 *
 * The hero shows the browser sitting on a desk; "Core features" shows it
 * again beside each step. It is the same window both times — the real shell,
 * running over an in-memory host in an <iframe> (app/hero-browser) — and it
 * travels between the two as the page scrolls. A frame cannot be moved in
 * the DOM without reloading, so it never is: it lives in one layer over
 * <main>, and two empty slots mark where it should be — the hero's
 * (components/hero-desktop.tsx) and the steps' (components/how-it-works.tsx,
 * a desk that sticks while the steps scroll by).
 *
 * Stability comes from never asking script to keep up with the scroll while
 * the window is meant to be still. The window rides a sticky block of its
 * own that copies the steps desk's sticky block exactly — same track, same
 * `top`, same height — so once the desk sticks, the browser holds the two
 * together natively, and when the desk lets go they leave together. Before
 * the landing that block sits unstuck at the top of its track, fixed in the
 * page like the hero, so resting on the hero is native scrolling too. The
 * only thing that changes with the scroll is the window's offset within
 * the block during the flight between the two, which is sampled into a
 * ScrollTimeline where the browser has one (a scroll listener elsewhere).
 * Outside the flight the offset is a constant, so nothing can trail.
 *
 * Speed: the window is placed by an inline script as soon as the page's
 * HTML is parsed, not after hydration; a drawn skeleton of the window shows
 * at once; and the live shell fades in over it only when it has painted.
 *
 * The window is drawn at the shell's own size and scaled, so it keeps its
 * proportions from a phone to a desktop — a smaller picture of the same
 * window, never a rearranged one. Its height is its own, though: each slot
 * is a box it fills (see `placeLiveBrowser`), so beside the steps it can be
 * taller than on the hero and grows into that shape on the way down.
 *
 * Which step the window is beside is posted to the frame (./hero-browser/
 * tour-protocol.ts), which plays that feature on the live chrome.
 */

/** Scroll-offset samples across the flight. Linear between them; the curve is in where they sit. */
const FLIGHT_SAMPLES = 32;

interface WallpaperFit {
  size: string;
  position: string;
}

interface RestBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface LiveLayout {
  /** Scroll positions: the flight starts, and lands (the desk sticks). */
  s0: number;
  s1: number;
  /** The document's scroll range. */
  max: number;
  /** Where the window rests on each slot, in viewport pixels at the moment of measuring. */
  rest: { hero: RestBox; steps: RestBox };
  /** 0 on the hero, 1 on the desk. */
  progress(s: number): number;
  /** The window's transform within its sticky block, and its height in its own pixels, at scroll `s`. */
  at(s: number): { transform: string; height: string };
}

/**
 * Measure the page and set the window's rig: the track and sticky block
 * that mirror the steps desk's, and the window's offset and shape for the
 * current scroll. Returns what the timeline needs, or null when a slot is
 * missing.
 *
 * A slot is the box the window may fill, not the window's shape: the window
 * is always the shell's design width (1200) and takes the height that gives
 * it the slot's proportions — clamped between 5:4 and 16:9 so it stays a
 * browser window — centred in the slot. The shell lays itself out at that
 * size, as a real window would when resized.
 *
 * SELF-CONTAINED ON PURPOSE: its source is inlined into the server HTML
 * (see `BOOT`) so the window is in place before React hydrates. It may use
 * nothing from outside its own body.
 */
function placeLiveBrowser(layer: HTMLElement): LiveLayout | null {
  const DESIGN_WIDTH = 1200;
  const shown = (element: Element) => element.getClientRects().length > 0;
  const slotOf = (kind: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(`[data-tour-slot="${kind}"]`)).find(shown) ?? null;
  const fitIn = (box: DOMRect): RestBox => {
    const ratio = Math.min(16 / 9, Math.max(5 / 4, box.width / Math.max(1, box.height)));
    const width = Math.min(box.width, box.height * ratio);
    const height = width / ratio;
    return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
  };
  const main = layer.parentElement;
  const track = layer.querySelector<HTMLElement>("[data-live-track]");
  const sticky = layer.querySelector<HTMLElement>("[data-live-sticky]");
  const win = layer.querySelector<HTMLElement>("[data-live-window]");
  const heroSlot = slotOf("hero");
  const stepsSlot = slotOf("steps");
  const deskSticky = stepsSlot?.closest<HTMLElement>("[data-tour-sticky]") ?? null;
  const deskTrack = deskSticky?.parentElement ?? null;
  if (!main || !track || !sticky || !win || !heroSlot || !stepsSlot || !deskSticky || !deskTrack) return null;

  const scrollY = window.scrollY;
  const m = main.getBoundingClientRect();
  const t = deskTrack.getBoundingClientRect();
  const d = deskSticky.getBoundingClientRect();
  const slot = fitIn(stepsSlot.getBoundingClientRect());
  const hero = fitIn(heroSlot.getBoundingClientRect());
  const stickTop = Number.parseFloat(getComputedStyle(deskSticky).top) || 0;

  // The rig copies the desk's: its track spans the same stretch of <main>,
  // its block sticks at the same `top` and is as tall, so the two stick and
  // let go on the same pixel.
  const trackTop = t.top - m.top;
  track.style.top = `${String(trackTop)}px`;
  track.style.height = `${String(t.height)}px`;
  sticky.style.top = `${String(stickTop)}px`;
  sticky.style.height = `${String(d.height)}px`;

  // The window's two resting places inside the block. On the desk: the
  // slot's place in the desk's block, whether stuck or not. On the hero:
  // where the hero's slot is relative to the block's unstuck place — both
  // fixed in the page, so this holds for as long as the block has not stuck.
  const from = { x: hero.left - m.left, y: hero.top - m.top - trackTop, scale: hero.width / DESIGN_WIDTH, h: (hero.height / hero.width) * DESIGN_WIDTH };
  const to = { x: slot.left - m.left, y: slot.top - d.top, scale: slot.width / DESIGN_WIDTH, h: (slot.height / slot.width) * DESIGN_WIDTH };

  const s1 = Math.max(0, t.top + scrollY - stickTop);
  // The flight begins once the hero's window has started under the nav, or
  // at the latest partway to the landing — never so late that it snaps.
  const s0 = Math.min(Math.max(0, hero.top + scrollY - 96), s1 * 0.6);
  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const progress = (s: number) => (s1 <= s0 ? (s >= s1 ? 1 : 0) : Math.min(1, Math.max(0, (s - s0) / (s1 - s0))));
  const at = (s: number) => {
    const p = progress(s);
    const e = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    const x = from.x + (to.x - from.x) * e;
    const y = from.y + (to.y - from.y) * e;
    const scale = from.scale + (to.scale - from.scale) * e;
    const height = from.h + (to.h - from.h) * e;
    return { transform: `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${scale.toFixed(5)})`, height: `${height.toFixed(1)}px` };
  };
  const now = at(scrollY);
  win.style.transform = now.transform;
  win.style.height = now.height;
  win.setAttribute("data-placed", "");
  return { s0, s1, max, rest: { hero, steps: slot }, progress, at };
}

/** Run once in the server's HTML, right after the rig, before any bundle has loaded. */
const BOOT = `try{(${placeLiveBrowser.toString()})(document.currentScript.parentElement)}catch(e){}`;

/** Keyframes over the whole scroll range: still on the hero, the eased flight, still on the desk. */
function keyframes(layout: LiveLayout): Keyframe[] {
  const { s0, s1, max } = layout;
  const offsets = new Set<number>([0, s0, s1, max]);
  for (let i = 1; i < FLIGHT_SAMPLES; i += 1) offsets.add(s0 + ((s1 - s0) * i) / FLIGHT_SAMPLES);
  return [...offsets]
    .filter((s) => s >= 0 && s <= max)
    .sort((a, b) => a - b)
    .map((s) => ({ offset: max === 0 ? 0 : s / max, ...layout.at(s) }));
}

function shown(element: Element): boolean {
  return element.getClientRects().length > 0;
}

/** The slot of a kind that is laid out at this width (phones and desktops have their own). */
function slotOf(kind: "hero" | "steps"): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>(`[data-tour-slot="${kind}"]`)].find(shown) ?? null;
}

/**
 * The desk's wallpaper as the frame must draw it to continue the desk under
 * the chrome's glass: `cover`-fitted to the desk, offset by where the slot
 * sits on it, in the frame's unscaled pixels.
 */
function wallpaperFit(slot: HTMLElement, f: RestBox): WallpaperFit {
  const desk = slot.closest<HTMLElement>("[data-tour-desk]") ?? slot;
  const d = desk.getBoundingClientRect();
  const scale = f.width / DESIGN_W;
  const fit = Math.max(d.width / WALLPAPER.width, d.height / WALLPAPER.height);
  const w = WALLPAPER.width * fit;
  const h = WALLPAPER.height * fit;
  const ox = (d.width - w) / 2;
  const oy = (d.height - h) / 2;
  return {
    size: `${String(w / scale)}px ${String(h / scale)}px`,
    position: `${String((d.left - f.left + ox) / scale)}px ${String((d.top - f.top + oy) / scale)}px`,
  };
}

/**
 * Which step the window is beside: the last step whose heading has come up
 * past the reading line. On a desktop the steps slide up in viewport-high
 * panels over the one before, heading at the panel's foot, so the line sits
 * low — a step starts once its heading is clearly in view. On a phone the
 * steps run up under the sticky window, so the line is halfway down what is
 * left below it.
 */
function activeStep(layout: LiveLayout): TourScene | null {
  if (layout.progress(window.scrollY) < 0.85) return null;
  const stuck = slotOf("steps")?.closest("[data-tour-sticky]")?.getBoundingClientRect().bottom ?? 0;
  const wide = stuck < window.innerHeight * 0.5;
  const line = wide ? window.innerHeight * 0.78 : stuck + (window.innerHeight - stuck) * 0.5;
  let active: TourScene = TOUR_SCENES[0];
  for (const step of document.querySelectorAll<HTMLElement>("[data-tour-step]")) {
    if (!shown(step)) continue;
    const scene = step.dataset["tourStep"] as TourScene | undefined;
    const mark = step.querySelector("[data-tour-mark]") ?? step;
    if (scene !== undefined && TOUR_SCENES.includes(scene) && mark.getBoundingClientRect().top < line) active = scene;
  }
  return active;
}

/** Whether the frame's shell has drawn its chrome — asked directly, for a paint that beat hydration. */
function framePainted(frame: HTMLIFrameElement): boolean {
  try {
    return frame.contentDocument?.querySelector('[data-testid="sidebar-pane"]') != null;
  } catch {
    return false;
  }
}

/**
 * What stands in the window until the live shell has painted: the chrome's
 * shape — traffic lights, the sidebar's address field, favorites and tabs,
 * the page card — in the window's own pixels, on the desk's glass.
 */
function WindowSkeleton() {
  return (
    <div aria-hidden="true" className="absolute inset-0 bg-[#eef3ea]/60 backdrop-blur-2xl">
      <div className="absolute top-[15px] left-4 flex gap-2">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
      </div>
      <div className="absolute top-[42px] left-2 flex w-[232px] flex-col gap-2">
        <div className="h-8 rounded-lg bg-black/[0.06]" />
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-10 rounded-lg bg-black/[0.05]" />
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-3 px-2">
          {[70, 52, 84, 60].map((width, i) => (
            <div key={i} className="h-3 rounded bg-black/[0.07]" style={{ width: `${String(width)}%` }} />
          ))}
        </div>
      </div>
      <div className="absolute top-2 right-2 bottom-2 left-[248px] rounded-[10px] bg-[#f7f7f5] shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">
        <div className="mx-auto mt-[130px] h-12 w-[320px] rounded-xl bg-black/[0.06]" />
        <div className="mx-auto mt-10 h-14 w-[700px] rounded-full bg-black/[0.04] shadow-[0_0_0_1px_rgba(0,0,0,0.08)]" />
        <div className="mx-auto mt-10 flex w-[560px] justify-between">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="size-[60px] rounded-2xl bg-black/[0.05]" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function LiveBrowser() {
  const layerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [painted, setPainted] = useState(false);
  /** The step the window is playing, while it is the tour's and not the visitor's. */
  const [touring, setTouring] = useState(false);

  useEffect(() => {
    const layer = layerRef.current;
    const frame = frameRef.current;
    const win = layer?.querySelector<HTMLElement>("[data-live-window]") ?? null;
    if (layer === null || frame === null || win === null) return;

    let layout: LiveLayout | null = null;
    let animation: Animation | null = null;
    let fits: { hero: WallpaperFit; steps: WallpaperFit } | null = null;
    let frameRequest = 0;
    let scene: TourScene | null = null;
    let wallpaper: "hero" | "steps" | null = null;
    const Timeline = (window as unknown as { ScrollTimeline?: new (options: { source: Element; axis: "block" }) => AnimationTimeline }).ScrollTimeline;

    const post = (next: TourScene | null) => {
      const message: TourMessage = { type: TOUR_MESSAGE, scene: next };
      frame.contentWindow?.postMessage(message, window.location.origin);
    };

    /** The desk under the chrome's glass: the hero's until halfway, then the steps'. */
    const paintWallpaper = (force = false) => {
      if (layout === null || fits === null) return;
      const side = layout.progress(window.scrollY) < 0.5 ? "hero" : "steps";
      if (side === wallpaper && !force) return;
      let body: HTMLElement | null = null;
      try {
        body = frame.contentDocument?.body ?? null;
      } catch {
        return;
      }
      if (body === null || frame.contentWindow?.location.pathname !== "/hero-browser") return;
      wallpaper = side;
      const fit = fits[side];
      body.style.transition = "background-size 500ms ease, background-position 500ms ease";
      body.style.backgroundImage = `url("${WALLPAPER.src}")`;
      body.style.backgroundSize = fit.size;
      body.style.backgroundPosition = fit.position;
      body.style.backgroundRepeat = "no-repeat";
    };

    const onScroll = () => {
      if (frameRequest !== 0) return;
      frameRequest = window.requestAnimationFrame(() => {
        frameRequest = 0;
        if (layout === null) return;
        // Without a timeline, the offset follows here. It only changes during
        // the flight, so a late frame can only ever cost the moving window.
        if (animation === null) Object.assign(win.style, layout.at(window.scrollY));
        paintWallpaper();
        const next = activeStep(layout);
        if (next !== scene) {
          scene = next;
          post(next);
          setTouring(next !== null);
        }
      });
    };

    const rebuild = () => {
      layout = placeLiveBrowser(layer);
      animation?.cancel();
      animation = null;
      if (layout === null) return;
      const hero = slotOf("hero");
      const steps = slotOf("steps");
      fits = hero === null || steps === null ? null : { hero: wallpaperFit(hero, layout.rest.hero), steps: wallpaperFit(steps, layout.rest.steps) };
      if (Timeline !== undefined && layout.max > 0) {
        animation = win.animate(keyframes(layout), {
          timeline: new Timeline({ source: document.documentElement, axis: "block" }),
          fill: "both",
        } as KeyframeAnimationOptions);
      }
      paintWallpaper(true);
      onScroll();
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
      const type = (event.data as { type?: unknown } | null)?.type;
      // The frame asks for its scene once its director is listening.
      if (type === TOUR_READY) {
        post(scene);
        wallpaper = null;
        paintWallpaper(true);
      }
      if (type === TOUR_PAINTED) setPainted(true);
    };
    if (framePainted(frame)) setPainted(true);

    let resizeRequest = 0;
    const scheduleRebuild = () => {
      if (resizeRequest !== 0) return;
      resizeRequest = window.requestAnimationFrame(() => {
        resizeRequest = 0;
        rebuild();
      });
    };
    const observer = new ResizeObserver(scheduleRebuild);
    const main = layer.parentElement;
    if (main !== null) observer.observe(main);
    for (const slot of document.querySelectorAll("[data-tour-slot]")) observer.observe(slot);
    window.addEventListener("resize", scheduleRebuild);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("message", onMessage);
    void document.fonts?.ready.then(scheduleRebuild);
    rebuild();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleRebuild);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("message", onMessage);
      if (frameRequest !== 0) window.cancelAnimationFrame(frameRequest);
      if (resizeRequest !== 0) window.cancelAnimationFrame(resizeRequest);
      animation?.cancel();
    };
  }, []);

  // `overflow: clip`, not hidden: a hidden overflow would make this layer a
  // scroll container and the sticky block would stick to it, not the page.
  // The rig's elements take their geometry from script (the boot script
  // writes it into the server's HTML before hydration), hence no `style`
  // props and suppressHydrationWarning.
  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-20 [overflow:clip]">
      <div data-live-track="" className="absolute inset-x-0 top-0 h-0" suppressHydrationWarning>
        <div data-live-sticky="" className="sticky top-0" suppressHydrationWarning>
          <div
            data-live-window=""
            data-testid="live-browser-window"
            className="pointer-events-auto invisible absolute top-0 left-0 h-[720px] w-[1200px] origin-top-left overflow-hidden rounded-[14px] shadow-[0_0_0_1px_rgba(0,0,0,0.12),0_30px_80px_-20px_rgba(20,50,30,0.45),0_12px_28px_-12px_rgba(0,0,0,0.3)] data-placed:visible"
            suppressHydrationWarning
          >
            <WindowSkeleton />
            <iframe
              ref={frameRef}
              src="/hero-browser"
              title="Pistachio, running in this page"
              data-testid="hero-browser-frame"
              className="absolute inset-0 size-full border-0"
              style={{ opacity: painted ? 1 : 0, transition: "opacity 350ms ease-out" }}
            />
            {/*
              During the tour a shield sits over the frame: the wheel then scrolls
              the page past the steps rather than the pane under the pointer, and
              the scene is not interrupted by a stray hover. A click hands the
              window over — the scene stops and the shell is the visitor's.
            */}
            {touring ? (
              <button
                type="button"
                data-testid="live-browser-take-over"
                aria-label="Try the browser yourself"
                className="group absolute inset-0 flex cursor-pointer items-end justify-center pb-8"
                onClick={() => {
                  frameRef.current?.contentWindow?.postMessage({ type: TOUR_HAND_OVER }, window.location.origin);
                  setTouring(false);
                  frameRef.current?.focus();
                }}
              >
                <span className="translate-y-2 rounded-full bg-ink/85 px-6 py-3 text-[22px] text-white opacity-0 shadow-lg backdrop-blur transition duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
                  Click to try it yourself
                </span>
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <script dangerouslySetInnerHTML={{ __html: BOOT }} suppressHydrationWarning />
    </div>
  );
}
