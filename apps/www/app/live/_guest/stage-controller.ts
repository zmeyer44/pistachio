/**
 * The host's desk on the guest's screen, applied by ref (docs/live-share.md
 * §7, §9). Desk frames arrive up to 30 times a second while the host moves a
 * window; each one, a resize of the page, a panel opening or a window brought
 * up to fill the view lays the stage out again here — the well, every
 * window's frame and page box, and the box the overlays draw through —
 * without a React render. React renders the windows that exist; this places
 * them.
 *
 * With a window brought up to fill the view, the others fade out and, once
 * that has played, leave the layout (`data-gone`): the room's adaptive stream
 * only stops a video it sees off screen, so a window merely transparent
 * would go on being sent and decoded behind the filled one.
 */

import type { LiveDeskFrame } from "@pistachio/live-share";
import { createStageBox, placeRect, relativeRect, stageArea, stageLayout, type Insets, type StageLayout } from "@pistachio/live-share/react";

export interface WindowElements {
  /** Positioned at the window's frame. */
  root: HTMLElement;
  /** Positioned at its page box, inside the frame: the video and what takes input. */
  page: HTMLElement;
}

export interface StageElements {
  /** The desk's well, at the stage's box (or the filled window's). */
  well: HTMLElement;
  /** The overlays' clip, at what is visible of the stage. */
  overlays: HTMLElement;
}

/** How long a re-layout the person caused (a panel, filling a window) animates; frames from the host never do. */
const SETTLE_MS = 260;

export class StageController {
  /** Where the stage lies inside the overlays' clip, for the layers. */
  readonly box = createStageBox();
  #frame: LiveDeskFrame | null = null;
  #viewport = { w: 0, h: 0 };
  #insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  #fill: string | null = null;
  #layout: StageLayout | null = null;
  #stage: StageElements | null = null;
  #root: HTMLElement | null = null;
  readonly #windows = new Map<string, WindowElements>();
  readonly #listeners = new Set<() => void>();
  #settleTimer: ReturnType<typeof setTimeout> | null = null;

  frame(): LiveDeskFrame | null {
    return this.#frame;
  }

  layout(): StageLayout | null {
    return this.#layout;
  }

  /** The window brought up to fill the view, if any. */
  filled(): string | null {
    return this.#fill;
  }

  /** The element whose `data-settling` lets CSS animate a re-layout the person caused. */
  attachRoot(root: HTMLElement | null): void {
    this.#root = root;
  }

  attachStage(elements: StageElements | null): void {
    this.#stage = elements;
    this.#apply();
  }

  register(windowId: string, elements: WindowElements): () => void {
    this.#windows.set(windowId, elements);
    this.#placeWindow(windowId, elements);
    return () => {
      if (this.#windows.get(windowId) === elements) this.#windows.delete(windowId);
    };
  }

  /** Called after every layout (the window input reads boxes from the DOM; this is for state that cares). */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setFrame(frame: LiveDeskFrame): void {
    this.#frame = frame;
    // A filled window that closed or was minimized lets go of the view.
    if (this.#fill !== null && !frame.windows.some((window) => window.id === this.#fill && !window.minimized)) this.#fill = null;
    this.#apply();
  }

  setViewport(w: number, h: number): void {
    if (w === this.#viewport.w && h === this.#viewport.h) return;
    this.#viewport = { w, h };
    this.#apply();
  }

  setInsets(insets: Insets, animate: boolean): void {
    const current = this.#insets;
    if (insets.top === current.top && insets.right === current.right && insets.bottom === current.bottom && insets.left === current.left) return;
    this.#insets = insets;
    if (animate) this.#settle();
    this.#apply();
  }

  setFill(windowId: string | null): void {
    if (windowId === this.#fill) return;
    this.#fill = windowId;
    this.#settle();
    this.#apply();
  }

  #settle(): void {
    const root = this.#root;
    if (root === null) return;
    root.dataset["settling"] = "";
    if (this.#settleTimer !== null) clearTimeout(this.#settleTimer);
    this.#settleTimer = setTimeout(() => {
      this.#settleTimer = null;
      delete root.dataset["settling"];
      for (const [windowId, elements] of this.#windows) elements.root.toggleAttribute("data-gone", this.#away(windowId));
    }, SETTLE_MS);
  }

  /** Behind the filled window. */
  #away(windowId: string): boolean {
    return this.#fill !== null && this.#fill !== windowId;
  }

  #apply(): void {
    const frame = this.#frame;
    if (frame === null || this.#viewport.w === 0) return;
    const area = stageArea(this.#viewport, this.#insets);
    const fillFrame = this.#fill === null ? null : (frame.windows.find((window) => window.id === this.#fill)?.frame ?? null);
    const layout = stageLayout(frame.stage, area, fillFrame);
    this.#layout = layout;
    const stage = this.#stage;
    if (stage !== null) {
      place(stage.well, layout.visible);
      place(stage.overlays, layout.visible);
      stage.well.style.setProperty("--lvg-scale", layout.scale.toFixed(4));
    }
    this.box.set(relativeRect(layout.view, layout.visible));
    for (const [windowId, elements] of this.#windows) this.#placeWindow(windowId, elements);
    for (const listener of this.#listeners) listener();
  }

  #placeWindow(windowId: string, elements: WindowElements): void {
    const layout = this.#layout;
    const window = this.#frame?.windows.find((each) => each.id === windowId);
    if (layout === null || window === undefined) return;
    const frame = placeRect(layout, window.frame);
    place(elements.root, frame);
    place(elements.page, relativeRect(placeRect(layout, window.page), frame));
    const away = this.#away(windowId);
    elements.root.toggleAttribute("data-away", away);
    elements.root.toggleAttribute("data-filled", this.#fill === windowId);
    // Back at once; gone only once the fade has played (at the settle's end), or at once when nothing is playing.
    if (!away || this.#settleTimer === null) elements.root.toggleAttribute("data-gone", away);
  }
}

/** A box by transform and size: what moves every frame never touches left/top. */
function place(element: HTMLElement, rect: { x: number; y: number; w: number; h: number }): void {
  element.style.transform = `translate3d(${rect.x.toFixed(2)}px, ${rect.y.toFixed(2)}px, 0)`;
  element.style.width = `${Math.max(0, rect.w).toFixed(2)}px`;
  element.style.height = `${Math.max(0, rect.h).toFixed(2)}px`;
}
