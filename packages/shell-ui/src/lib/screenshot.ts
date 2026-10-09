/**
 * Screenshots of the window (the `screenshotView` and `screenshotArea`
 * shortcuts; @pistachio/shell-contracts/screenshot). The shell picks the box
 * — the panes, the desk, an area dragged out — and main lays up what is on
 * screen there, copies it and saves it. Desktop only: a stream surface has
 * no window to capture.
 */

import { create } from "zustand";
import { MIN_SCREENSHOT_SIZE, type ScreenshotBox, type ScreenshotResult } from "@pistachio/shell-contracts/screenshot";
import { nativeApi } from "../api";
import { useAppStore, type AppState } from "../store";
import { useDeskStore } from "./desk/store";

/** A screenshot is being taken (or an area's window held): a second press waits for it. */
let busy = false;
/** Main holds the window for an area that has not been chosen yet. */
let held = false;
/** The held window, drawn under the area being chosen (ScreenshotOverlay), and the window's size when it was held. */
let picture: string | null = null;
let pictureSize = { width: 0, height: 0 };

/** The area being dragged out, in the window's CSS px: where it was pressed (x0, y0) and where the pointer is. */
export interface AreaDrag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The drag in progress, or null: what ScreenshotOverlay draws. */
export const useAreaDrag = create<{ drag: AreaDrag | null }>(() => ({ drag: null }));

export function areaBox(drag: AreaDrag): ScreenshotBox {
  return {
    x: Math.min(drag.x0, drag.x1),
    y: Math.min(drag.y0, drag.y1),
    width: Math.abs(drag.x1 - drag.x0),
    height: Math.abs(drag.y1 - drag.y0),
  };
}

/**
 * The pages: the whole desk — what is between the sidebar, the window's
 * frame and the agent panel — with its Bar out of the picture. (Until
 * 2026-10-09 a window with no desk up had its panes captured instead: the
 * desk is the desktop's surface now, docs/spaces.md.) False when there is
 * nothing to capture; before the desk's stage is drawn, nothing is.
 */
export function screenshotView(): boolean {
  const api = nativeApi();
  if (api === null || busy || held) return false;
  busy = true;
  void (async () => {
    let capturing = false;
    try {
      await overlaysDown();
      const stage = document.querySelector<HTMLElement>("[data-testid='desk-surface'] .desk-stage");
      if (stage === null) return;
      capturing = true;
      useDeskStore.getState().setCapturing(true);
      await painted();
      announce(await api.screenshot({ type: "page", box: boxOf(stage), ground: windowGround() }));
    } catch {
      announce(null);
    } finally {
      if (capturing) useDeskStore.getState().setCapturing(false);
      busy = false;
    }
  })();
  return true;
}

/**
 * An area of the window: main holds the window as it is when the key is
 * pressed, and the person drags out the part to keep over that picture of
 * it (ScreenshotOverlay, which ends with finishAreaScreenshot) — so what is
 * dragged over is what is kept, though the pages go down under it. The
 * selector lies over whatever is up (a dialog, Settings, the palette), which
 * is as it was once the area is chosen.
 */
export function screenshotArea(): boolean {
  const api = nativeApi();
  if (api === null || busy || held) return false;
  busy = true;
  void (async () => {
    try {
      await overlaysDown();
      const size = { width: window.innerWidth, height: window.innerHeight };
      const hold = await api.screenshot({ type: "hold", ground: windowGround() });
      if (hold === null) {
        announce(null);
        return;
      }
      held = true;
      picture = hold.picture;
      pictureSize = size;
      useAreaDrag.setState({ drag: null });
      useAppStore.getState().setScreenshotSelecting(true);
    } catch {
      announce(null);
    } finally {
      busy = false;
    }
  })();
  return true;
}

/** The held window, as a picture to draw, while an area is being chosen over it. */
export function heldPicture(): string | null {
  return picture;
}

/**
 * The window is no longer the size it was held at: the picture drawn over it
 * would be stretched to it, and an area chosen there would not be the one
 * cut from the picture.
 */
export function heldPictureStale(): boolean {
  return window.innerWidth !== pictureSize.width || window.innerHeight !== pictureSize.height;
}

/**
 * The area dragged out (in the window's CSS px), or null for none: the held
 * window is cut to it, or let go. (A page that had the keyboard is main's to
 * give it back to: Screenshots.)
 */
export function finishAreaScreenshot(box: ScreenshotBox | null): void {
  const wasHeld = held;
  held = false;
  picture = null;
  useAreaDrag.setState({ drag: null });
  useAppStore.getState().setScreenshotSelecting(false);
  const api = nativeApi();
  if (api === null || !wasHeld) return;
  const keep = box !== null && box.width >= MIN_SCREENSHOT_SIZE && box.height >= MIN_SCREENSHOT_SIZE ? box : null;
  void api
    .screenshot({ type: "finish", box: keep })
    .then((result) => {
      if (keep !== null) announce(result);
    })
    .catch(() => announce(null));
}

function announce(result: ScreenshotResult | null): void {
  const store = useAppStore.getState();
  if (result === null || (result.path === null && !result.copied)) {
    store.showNotice("Couldn't take the screenshot", { tone: "warning" });
    return;
  }
  const { path } = result;
  if (path === null) {
    store.showNotice("Screenshot copied, but it couldn't be saved", { tone: "warning" });
    return;
  }
  store.showNotice(result.copied ? "Screenshot copied and saved" : "Screenshot saved", {
    tone: "success",
    action: { label: "Show in Finder", run: () => void nativeApi()?.screenshot({ type: "reveal", path }) },
  });
}

function boxOf(element: HTMLElement): ScreenshotBox {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * While an area is being chosen the selector has every key and press in the
 * window, and nothing under it hears of them: a dialog, a menu, the palette
 * under it are as they were once it is gone (a menu that closes on Escape or
 * on a press outside it stays open). So these listeners are installed as the
 * shell loads, on the window and capturing, ahead of any a component adds
 * later — a later one on the same target would still run — and each stops
 * the event there. The drag is read from them too: Escape or a press of
 * another button lets the area go (the press once it is released: the whole
 * click, and the context menu it asks for, is the selector's); a drag that
 * ends too small keeps nothing.
 */
function guardInput(): void {
  if (typeof window === "undefined") return;
  const take = (event: Event): boolean => {
    if (!useAppStore.getState().screenshotSelecting) return false;
    event.stopImmediatePropagation();
    if (event.cancelable) event.preventDefault();
    return true;
  };
  /** A press of another button is letting the area go, once it is released. */
  let cancelling = false;
  const point = (event: PointerEvent): { x: number; y: number } => ({
    x: Math.min(Math.max(0, event.clientX), window.innerWidth),
    y: Math.min(Math.max(0, event.clientY), window.innerHeight),
  });
  window.addEventListener(
    "keydown",
    (event) => {
      if (take(event) && event.key === "Escape") finishAreaScreenshot(null);
    },
    true,
  );
  for (const type of ["keyup", "keypress", "mousedown", "mouseup", "click", "auxclick", "dblclick", "contextmenu", "wheel"])
    window.addEventListener(type, take, { capture: true, passive: false });
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (!take(event)) return;
      if (event.target instanceof Element) event.target.setPointerCapture(event.pointerId);
      if (event.button !== 0) {
        cancelling = true;
        useAreaDrag.setState({ drag: null });
        return;
      }
      if (!useAppStore.getState().overlayReady) return;
      const { x, y } = point(event);
      useAreaDrag.setState({ drag: { x0: x, y0: y, x1: x, y1: y } });
    },
    true,
  );
  window.addEventListener(
    "pointermove",
    (event) => {
      if (!take(event) || cancelling) return;
      const drag = useAreaDrag.getState().drag;
      if (drag !== null) useAreaDrag.setState({ drag: { ...drag, x1: point(event).x, y1: point(event).y } });
    },
    true,
  );
  window.addEventListener(
    "pointerup",
    (event) => {
      if (!take(event)) return;
      if (cancelling) {
        cancelling = false;
        window.setTimeout(() => finishAreaScreenshot(null), 0);
        return;
      }
      const drag = useAreaDrag.getState().drag;
      if (drag === null) return;
      const box = areaBox({ ...drag, x1: point(event).x, y1: point(event).y });
      // After this press's mouseup and click, which are the selector's too: nothing under it hears the release.
      window.setTimeout(() => finishAreaScreenshot(box.width >= MIN_SCREENSHOT_SIZE && box.height >= MIN_SCREENSHOT_SIZE ? box : null), 0);
    },
    true,
  );
  window.addEventListener(
    "pointercancel",
    (event) => {
      if (!take(event)) return;
      useAreaDrag.setState({ drag: null });
      if (cancelling) {
        cancelling = false;
        finishAreaScreenshot(null);
      }
    },
    true,
  );
}

guardInput();

/** How long a closing overlay is waited for (an error toast keeps the pages down while it shows). */
const OVERLAY_DOWN_MS = 1_500;

/** An overlay was put away and the pages under it are not live again yet. */
function overlayGoingDown(state: AppState): boolean {
  return state.overlay === "none" && (state.overlayActive || state.paneStills.length > 0);
}

/**
 * An overlay just put away is down — the pages under it live again and the
 * shell drawn without it — so it is out of the picture: the address palette
 * a screenshot was chosen from closes as the screenshot starts. An overlay
 * still up (Settings, say) stays in it: that is what is on screen.
 */
async function overlaysDown(): Promise<void> {
  if (!overlayGoingDown(useAppStore.getState())) return;
  await new Promise<void>((done) => {
    const finish = (): void => {
      window.clearTimeout(timer);
      unsubscribe();
      done();
    };
    const timer = window.setTimeout(finish, OVERLAY_DOWN_MS);
    const unsubscribe = useAppStore.subscribe((state) => {
      if (!overlayGoingDown(state)) finish();
    });
  });
  await painted();
}

/** Two frames: the change before this has been drawn, and its frame handed over, before main captures it. */
function painted(): Promise<void> {
  return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
}

/**
 * The window's own material as one opaque colour, for main to lay the shell
 * page over where it is see-through: what the desk's notch view paints for
 * it (shell.css .desk-notch-view) — the shell's ground, or with the desktop
 * glass on, the stand-in for the glass, which no capture can see.
 */
export function windowGround(): string {
  const probe = document.createElement("div");
  probe.className = "desk-notch-view";
  probe.style.display = "none";
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return "#ffffff";
  // Opaque white first: a colour that does not parse leaves it, and a translucent one is laid over it.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r = 255, g = 255, b = 255] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}
