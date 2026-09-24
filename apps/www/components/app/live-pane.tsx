"use client";

/**
 * The cloud browser's screen, in a tab (docs/cloud-sync-design.md §8.5).
 *
 * The desktop's `LiveViewPage` and this pane are the same surface: the
 * screencast painted into an <img>, the pointer and keyboard sent back while
 * the person holds control, the tab strip above it. The arithmetic that turns
 * a click on that image into a click in the cloud page is
 * `@pistachio/live-view`, shared with the desktop — it is the part that fails
 * silently, so it is not written twice.
 *
 * TWO RULES, both inherited from the desktop.
 *
 * The frames never travel further than this component. `useLiveView` holds
 * the current one and coalesces the stream to one repaint per animation
 * frame; this pane is a sibling of the thread, never its parent, so a
 * screencast at 15fps does not repaint the conversation 15 times a second.
 *
 * The coordinates are the frame's, not the element's. The image is scaled to
 * fit the pane, so a click at (120, 90) on screen is not a click at (120, 90)
 * in the cloud page. The element carries the frame's own aspect ratio exactly
 * so its box IS the painted image, with no letterboxing to correct for.
 */

import { useCallback, useEffect, useRef, type PointerEvent, type ReactNode } from "react";
import { Cloud, Hand, Loader2, Monitor, ShieldAlert, X } from "lucide-react";
import {
  frameAspectRatio,
  frameSource,
  heldMouseButton,
  keyInput,
  liveModifiers,
  liveMouseButton,
  livePoint,
  mouseInput,
  type LiveMouseButton,
  type LivePoint,
  type LiveTabInfo,
} from "@pistachio/live-view";
import type { SpaceKeys } from "@pistachio/sync-protocol";
import { type LiveState, useLiveView } from "@pistachio/web-account";
import { cn } from "../../lib/utils";

interface StateView {
  label: string;
  note: string;
  tone: "green" | "amber" | "red" | "gray";
}

/**
 * `driving` is the SAME conjunction that gates input, not the socket's
 * control field on its own: the run's control and the runner's converge a
 * beat apart, and in that beat a badge reading "You have control" over a
 * surface that is dropping every click is the one thing this must not say.
 */
function stateView(state: LiveState, driving: boolean, error: string | null): StateView {
  switch (state) {
    case "open":
      return driving
        ? { label: "You have control", note: "What you click and type here is sent to the cloud page.", tone: "green" }
        : { label: "Watching", note: "The agent is driving. Take control to type or click.", tone: "amber" };
    case "connecting":
      return { label: "Connecting", note: "Dialling the cloud browser with a one-minute ticket.", tone: "amber" };
    case "revoked":
      return { label: "Revoked", note: error ?? "The cloud browser stopped accepting this browser.", tone: "red" };
    case "error":
      return { label: "Disconnected", note: error ?? "The live view ended.", tone: "red" };
    case "closed":
      return { label: "Ended", note: error ?? "This run's live view has ended.", tone: "gray" };
    default:
      return { label: "Closed", note: "Nothing is being watched right now.", tone: "gray" };
  }
}

const TONE_BADGE: Record<StateView["tone"], string> = {
  green: "bg-green-100 text-green-900",
  amber: "bg-amber-100 text-amber-900",
  red: "bg-red-100 text-red-900",
  gray: "bg-gray-100 text-gray-900",
};

export function LivePane({
  control,
  keys,
  onClose,
  onRelease,
  onTake,
  runId,
  token,
}: {
  /** The run's own control field, which is what the takeover buttons act on. */
  control: "agent" | "human";
  /** This browser's keys for the run's Space; the runner asks for proof of them. */
  keys: SpaceKeys | null;
  onClose(): void;
  onRelease(): void;
  onTake(): void;
  runId: string;
  token: string | null;
}): ReactNode {
  const live = useLiveView({ enabled: true, keys, runId, token });
  const surface = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const moveHandle = useRef(0);
  /** The button currently held down here, so a release can always be sent for it. */
  const held = useRef<{ button: LiveMouseButton; point: LivePoint } | null>(null);
  // The run's own control field is the truth the buttons act on; the socket's
  // is what the runner will honour. They converge within a frame of each
  // other, and driving is offered only when they agree.
  const human = control === "human" && live.control === "human";
  const view = stateView(live.state, human, live.error);
  const frame = live.frame;

  // The keyboard belongs to this surface as soon as control is taken: a
  // person who took it should be able to type without clicking the page.
  useEffect(() => {
    if (human) surface.current?.focus({ preventScroll: true });
  }, [human]);

  useEffect(
    () => () => {
      if (moveHandle.current !== 0) window.cancelAnimationFrame(moveHandle.current);
    },
    [],
  );

  /**
   * Let go of whatever is held, wherever the pointer got to. CDP has no idea
   * the person switched tabs, lost the capture, or handed the page back — it
   * just keeps the button down, and the next click in the cloud page lands
   * inside a drag that never ended.
   */
  const send = live.send;
  const releaseHeld = useCallback(() => {
    const down = held.current;
    if (down === null) return;
    held.current = null;
    send(mouseInput({ type: "mouseReleased", point: down.point, button: down.button, clickCount: 1, modifiers: 0 }));
  }, [send]);

  // Control going back to the agent, or the pane closing, ends any drag.
  useEffect(() => {
    if (!human) releaseHeld();
  }, [human, releaseHeld]);
  useEffect(() => releaseHeld, [releaseHeld]);

  const pointFor = (event: PointerEvent<HTMLImageElement>) =>
    frame === null
      ? null
      : livePoint(frame, event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);

  const onPointerDown = (event: PointerEvent<HTMLImageElement>): void => {
    if (!human) return;
    const point = pointFor(event);
    if (point === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    surface.current?.focus({ preventScroll: true });
    const button = liveMouseButton(event.button);
    held.current = { button, point };
    live.send(
      mouseInput({
        type: "mousePressed",
        point,
        button,
        clickCount: Math.max(1, event.detail),
        modifiers: liveModifiers(event),
      }),
    );
  };

  const onPointerUp = (event: PointerEvent<HTMLImageElement>): void => {
    if (!human) return;
    const point = pointFor(event);
    if (point === null) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    held.current = null;
    live.send(
      mouseInput({
        type: "mouseReleased",
        point,
        button: liveMouseButton(event.button),
        clickCount: Math.max(1, event.detail),
        modifiers: liveModifiers(event),
      }),
    );
  };

  /** Pointer moves are sampled to one per frame; presses and releases never are. */
  const onPointerMove = (event: PointerEvent<HTMLImageElement>): void => {
    if (!human || moveHandle.current !== 0) return;
    const point = pointFor(event);
    if (point === null) return;
    const modifiers = liveModifiers(event);
    // `event.button` names the button that CHANGED, and a move changes none.
    // The held one is in the bitmask; without it a drag reads as a hover.
    const button = heldMouseButton(event.buttons);
    if (held.current !== null) held.current = { button: held.current.button, point };
    moveHandle.current = window.requestAnimationFrame(() => {
      moveHandle.current = 0;
      live.send(mouseInput({ type: "mouseMoved", point, button, clickCount: 0, modifiers }));
    });
  };

  /**
   * The wheel is bound natively rather than through `onWheel`, because React
   * registers wheel listeners as PASSIVE: `preventDefault` inside one is
   * ignored, and the scroll would run twice — once in the cloud page, once in
   * the run page behind it.
   */
  useEffect(() => {
    const element = image.current;
    if (element === null) return;
    const onWheel = (event: globalThis.WheelEvent): void => {
      if (!human || frame === null) return;
      event.preventDefault();
      const point = livePoint(frame, element.getBoundingClientRect(), event.clientX, event.clientY);
      // DOM and CDP agree on the sign: down-and-away is positive in both.
      send(
        mouseInput({
          type: "mouseWheel",
          point,
          clickCount: 0,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          modifiers: liveModifiers(event),
        }),
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [human, frame, send]);

  const onKey = (event: React.KeyboardEvent<HTMLDivElement>, type: "keyDown" | "keyUp"): void => {
    // Escape belongs to this window: it closes the pane. Everything else is
    // the cloud page's, including ⌘-shortcuts, which is why the surface takes
    // the event rather than letting the browser's own bindings see it.
    if (event.key === "Escape") {
      if (type === "keyDown") {
        event.preventDefault();
        onClose();
      }
      return;
    }
    if (!human) return;
    event.preventDefault();
    event.stopPropagation();
    live.send(keyInput(event, type));
  };

  const connecting = live.state === "connecting";
  const stalled = frame !== null && live.state !== "open" && !connecting;

  return (
    <section
      aria-label="Cloud browser live view"
      data-testid="live-pane"
      data-state={live.state}
      data-control={live.control ?? "none"}
      className="flex min-h-0 min-w-0 flex-col overflow-hidden border-alpha-400 bg-background-200 lg:border-l"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-alpha-400 bg-background-100 px-3 py-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-sm bg-blue-100 text-blue-900">
          <Cloud className="size-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-label-13 font-medium text-gray-1000">Cloud browser</span>
          <span className="block truncate text-[10.5px] leading-4 text-gray-700">{view.note}</span>
        </span>
        <span
          data-testid="live-pane-state"
          className={cn("ml-2 shrink-0 rounded-full px-1.5 py-px text-[10px] leading-4 font-medium", TONE_BADGE[view.tone])}
        >
          {view.label}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {live.state === "open" ? (
            <button
              type="button"
              className="pa-btn"
              data-testid={control === "human" ? "live-pane-release" : "live-pane-take"}
              onClick={control === "human" ? onRelease : onTake}
            >
              <Hand className="size-3.5" aria-hidden="true" />
              {control === "human" ? "Give it back" : "Take control"}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Close the live view"
            data-testid="live-pane-close"
            onClick={onClose}
            className="grid size-7 cursor-pointer place-items-center rounded-md text-gray-700 transition-colors hover:bg-alpha-100 hover:text-gray-1000"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </span>
      </header>

      <TabStrip tabs={live.tabs} activeTabId={live.activeTabId} onFocus={(tabId) => live.send({ t: "focus", tabId })} />

      <div
        ref={surface}
        tabIndex={0}
        onKeyDown={(event) => onKey(event, "keyDown")}
        onKeyUp={(event) => onKey(event, "keyUp")}
        className="relative grid min-h-0 flex-1 place-items-center overflow-hidden p-3 outline-none"
      >
        {frame === null ? (
          <p className="flex items-center gap-2 text-label-13 text-gray-700" data-testid="live-pane-waiting">
            {connecting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Monitor className="size-4" aria-hidden="true" />
            )}
            {connecting
              ? "Connecting to the cloud browser…"
              : live.state === "open"
                ? "Waiting for the first frame…"
                : view.note}
          </p>
        ) : (
          <img
            src={frameSource(frame)}
            alt="The cloud browser's screen"
            draggable={false}
            data-testid="live-pane-frame"
            style={{ aspectRatio: frameAspectRatio(frame) }}
            ref={image}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerMove={onPointerMove}
            onPointerCancel={onPointerUp}
            onLostPointerCapture={releaseHeld}
            onContextMenu={(event) => event.preventDefault()}
            className={cn(
              "max-h-full max-w-full rounded-sm bg-background-100 object-contain shadow-small select-none",
              human ? "cursor-default" : "cursor-not-allowed",
            )}
          />
        )}
        {/* The last frame is left where it was, under a veil that says why it
            stopped: a screencast that simply freezes reads as a hung app. */}
        {stalled ? (
          <div className="absolute inset-0 grid place-items-center bg-[oklch(0_0_0/0.4)] p-6">
            <p
              data-testid="live-pane-error"
              className="flex max-w-96 items-start gap-2 rounded-md bg-background-100 px-3.5 py-3 text-copy-13 text-gray-1000 shadow-modal"
            >
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-red-900" aria-hidden="true" />
              <span>{live.error ?? view.note}</span>
            </p>
          </div>
        ) : null}
      </div>

      <footer className="shrink-0 border-t border-alpha-400 bg-background-100 px-3 py-2 text-[10.5px] leading-4 text-gray-700">
        {human
          ? "You are driving the cloud page: what you click and type is sent there, and the agent waits. Esc closes this view."
          : "Watching only. Nothing you click here reaches the cloud page until you take control. Esc closes this view."}
      </footer>
    </section>
  );
}

/** `https://shop.example/cart?x=1` → `shop.example`, or the raw value. */
function displayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function TabStrip({
  activeTabId,
  onFocus,
  tabs,
}: {
  activeTabId: string | null;
  onFocus: (tabId: string) => void;
  tabs: LiveTabInfo[];
}): ReactNode {
  if (tabs.length === 0) return null;
  return (
    <div
      data-testid="live-pane-tabs"
      className="scroll-thin flex shrink-0 gap-1 overflow-x-auto border-b border-alpha-400 bg-background-100 px-2 py-1.5"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          aria-current={tab.id === activeTabId ? "page" : undefined}
          title={tab.url}
          data-testid={`live-tab-${tab.id}`}
          onClick={() => {
            onFocus(tab.id);
          }}
          className={cn(
            "flex h-7 max-w-56 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm px-2 text-label-12 transition-colors",
            tab.id === activeTabId ? "bg-background-200 text-gray-1000 shadow-border" : "text-gray-900 hover:bg-alpha-100",
          )}
        >
          <span
            aria-hidden="true"
            className={cn("size-1.5 shrink-0 rounded-full", tab.kind === "agent" ? "bg-blue-700" : "bg-green-700")}
          />
          <span className="truncate">{tab.title.trim() === "" ? displayHost(tab.url) : tab.title}</span>
        </button>
      ))}
    </div>
  );
}
