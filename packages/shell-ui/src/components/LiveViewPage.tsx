import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Cloud, Hand, Loader2, Monitor, ShieldAlert, X } from "lucide-react";
import { agentRingDelayMs } from "@pistachio/shell-contracts/agent-glow";
import type { CloudFrame, CloudTabInfo } from "@pistachio/shell-contracts/ipc";
import { cloudAgentIsDriving, liveStateView } from "../lib/cloud";
import { cn } from "../lib/cn";
import {
  frameAspectRatio,
  frameIsForRun,
  frameSource,
  heldMouseButton,
  keyInput,
  liveModifiers,
  liveMouseButton,
  livePoint,
  mouseInput,
  type LiveMouseButton,
  type LivePoint,
} from "../lib/live-view";
import { displayHost } from "../lib/url";
import { useAppStore } from "../store";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { shellApi } from "../api";

/**
 * The live view of a run in the cloud browser (docs/cloud-sync-design.md
 * §8.5): the screencast main relays on `cloud:frame`, drawn into an <img>,
 * with the pointer and keyboard sent back as `CloudLiveInput` while the
 * person holds control.
 *
 * TWO RULES SHAPE EVERYTHING HERE.
 *
 * The frames never go through the store. A screencast frame is a base64
 * JPEG arriving several times a second; putting it in zustand would push it
 * through every subscriber and every structural-sharing pass on the way. So
 * this component subscribes to `onCloudFrame` itself, holds the latest frame
 * in component state, and coalesces the stream to one repaint per animation
 * frame — the display cannot show more than that anyway.
 *
 * The coordinates are the frame's, not the element's. The image is scaled to
 * fit the pane, so a click at (120, 90) on screen is not a click at (120, 90)
 * in the cloud page; lib/live-view.ts does the conversion §8.5 specifies.
 * The element carries the frame's own aspect ratio precisely so its box IS
 * the painted image, with no letterboxing to correct for.
 */
export function LiveViewPage() {
  const cloud = useAppStore((state) => state.cloud);
  const closeLiveView = useAppStore((state) => state.closeLiveView);
  const sendLiveInput = useAppStore((state) => state.sendLiveInput);
  const takeControl = useAppStore((state) => state.takeControl);
  const releaseControl = useAppStore((state) => state.releaseControl);
  // Steering goes through the console's OPEN run (main's RunController), so
  // it is offered only when the run being watched is that run. Watching one
  // conversation and interrupting another would be the same click otherwise.
  const openRunId = useAppStore((state) => state.snapshot?.run?.runId ?? null);
  const [frame, setFrame] = useState<CloudFrame | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  const runId = cloud.liveRunId;
  const human = cloud.liveControl === "human";
  const open = cloud.liveState === "open";
  // The agent-control ring (styles.css) goes around the frame while the
  // cloud browser says the agent is driving the page on it — the same light
  // a local run's pane carries, on the same condition, and nowhere else in
  // this app for a cloud run: its page is here and only here. Its phase
  // comes from the wall clock like every other ring's, taken when the ring
  // element appears (there is no frame to ring until the first one lands),
  // so a view opened mid-run lands on the comet's current position rather
  // than restarting it.
  const ringed = frame !== null && cloudAgentIsDriving(cloud);
  const ringDelay = useMemo(
    () => (ringed ? `${String(agentRingDelayMs(Date.now()))}ms` : undefined),
    [ringed],
  );
  const view = liveStateView(cloud);
  const steerable = runId !== null && runId === openRunId;

  // The frame stream: coalesced to one repaint per animation frame, and
  // filtered to the run this view is for — a frame from a run that ended
  // while the socket was being swapped must not paint over the new one.
  const runIdRef = useRef(runId);
  runIdRef.current = runId;
  const pendingFrame = useRef<CloudFrame | null>(null);
  const frameHandle = useRef(0);
  useEffect(() => {
    const off = shellApi().onCloudFrame((next) => {
      if (!frameIsForRun(next, runIdRef.current)) return;
      pendingFrame.current = next;
      if (frameHandle.current !== 0) return;
      frameHandle.current = window.requestAnimationFrame(() => {
        frameHandle.current = 0;
        const queued = pendingFrame.current;
        pendingFrame.current = null;
        // Checked again here: the run can change in the ~16 ms a frame waits
        // for its repaint, and the ref is already the new one by then, so
        // the previous run's last frame is dropped instead of painting over
        // the view that just opened.
        if (queued !== null && frameIsForRun(queued, runIdRef.current)) setFrame(queued);
      });
    });
    return () => {
      off();
      if (frameHandle.current !== 0) window.cancelAnimationFrame(frameHandle.current);
    };
  }, []);

  // A view opened on a different run starts from a blank surface rather than
  // the last frame of the previous one — including a frame already parked in
  // the animation frame, which is cancelled rather than left to fire.
  useEffect(() => {
    if (frameHandle.current !== 0) {
      window.cancelAnimationFrame(frameHandle.current);
      frameHandle.current = 0;
    }
    pendingFrame.current = null;
    setFrame(null);
  }, [runId]);

  // The keyboard belongs to this surface as soon as it is up: a person who
  // took control should be able to type without clicking the page first.
  useEffect(() => {
    if (human) surfaceRef.current?.focus({ preventScroll: true });
  }, [human]);

  const send = useCallback(
    (input: Parameters<typeof sendLiveInput>[0] | null) => {
      if (input !== null) sendLiveInput(input);
    },
    [sendLiveInput],
  );

  /** Pointer moves are sampled to one per frame; presses and releases never are. */
  const moveHandle = useRef(0);
  /** The button currently held down here, so a release can always be sent for it. */
  const held = useRef<{ button: LiveMouseButton; point: LivePoint } | null>(null);
  useEffect(
    () => () => {
      if (moveHandle.current !== 0) window.cancelAnimationFrame(moveHandle.current);
    },
    [],
  );

  /**
   * Let go of whatever is held, wherever the pointer got to. CDP has no idea
   * the person alt-tabbed, lost the capture, or handed the page back — it
   * just keeps the button down, and the next click in the cloud page lands
   * inside a drag that never ended.
   */
  const releaseHeld = useCallback(() => {
    const down = held.current;
    if (down === null) return;
    held.current = null;
    sendLiveInput(
      mouseInput({ type: "mouseReleased", point: down.point, button: down.button, clickCount: 1, modifiers: 0 }),
    );
  }, [sendLiveInput]);

  // Control going back to the agent, or the view closing, ends any drag.
  useEffect(() => {
    if (!human) releaseHeld();
  }, [human, releaseHeld]);
  useEffect(() => releaseHeld, [releaseHeld]);

  const pointFor = (event: React.PointerEvent<HTMLImageElement> | React.WheelEvent<HTMLImageElement>) => {
    if (frame === null) return null;
    return livePoint(frame, event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
    if (!human) return;
    const point = pointFor(event);
    if (point === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    surfaceRef.current?.focus({ preventScroll: true });
    const button = liveMouseButton(event.button);
    held.current = { button, point };
    send(
      mouseInput({
        type: "mousePressed",
        point,
        button,
        clickCount: Math.max(1, event.detail),
        modifiers: liveModifiers(event),
      }),
    );
  };

  const onPointerUp = (event: React.PointerEvent<HTMLImageElement>) => {
    if (!human) return;
    const point = pointFor(event);
    if (point === null) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    held.current = null;
    send(
      mouseInput({
        type: "mouseReleased",
        point,
        button: liveMouseButton(event.button),
        clickCount: Math.max(1, event.detail),
        modifiers: liveModifiers(event),
      }),
    );
  };

  const onPointerMove = (event: React.PointerEvent<HTMLImageElement>) => {
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
      send(mouseInput({ type: "mouseMoved", point, button, clickCount: 0, modifiers }));
    });
  };

  /**
   * The wheel is bound natively rather than through `onWheel`, because React
   * registers wheel listeners as PASSIVE: `preventDefault` inside one is
   * ignored, and the scroll would run twice — once in the cloud page, once in
   * this window behind it.
   */
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = imageRef.current;
    if (image === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (!human || frame === null) return;
      event.preventDefault();
      const point = livePoint(frame, image.getBoundingClientRect(), event.clientX, event.clientY);
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
    image.addEventListener("wheel", onWheel, { passive: false });
    return () => image.removeEventListener("wheel", onWheel);
  }, [human, frame, send]);

  const onKey = (event: React.KeyboardEvent<HTMLDivElement>, type: "keyDown" | "keyUp") => {
    // Escape belongs to this window: it closes the view. Everything else is
    // the cloud page's, including ⌘-shortcuts, which is why the surface takes
    // the event rather than letting the shell's own bindings see it.
    if (event.key === "Escape") {
      if (type === "keyDown") {
        event.preventDefault();
        void closeLiveView();
      }
      return;
    }
    if (!human) return;
    event.preventDefault();
    event.stopPropagation();
    send(keyInput(event, type));
  };

  return (
    <section
      role="dialog"
      aria-label="Cloud browser live view"
      data-testid="live-view"
      data-control={cloud.liveControl ?? "none"}
      className="animate-backdrop-in absolute inset-0 z-20 flex flex-col overflow-hidden rounded-md bg-background-200 shadow-small"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-alpha-400 bg-background-100 px-3 py-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-sm bg-blue-100 text-blue-900">
          <Cloud className="size-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-label-13 font-medium text-gray-1000">Cloud browser</span>
          <span className="block truncate text-[10.5px] text-gray-700">{view.note}</span>
        </span>
        <Badge
          variant={view.tone === "green" ? "green-subtle" : view.tone === "amber" ? "amber-subtle" : view.tone === "red" ? "red-subtle" : "gray-subtle"}
          size="sm"
          className="ml-2"
          data-testid="live-view-state"
        >
          {view.label}
        </Badge>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {steerable && open ? (
            human ? (
              <Button variant="secondary" size="xs" prefix={<Hand aria-hidden="true" />} onClick={() => void releaseControl()} data-testid="live-view-release">
                Give it back
              </Button>
            ) : (
              <Button variant="secondary" size="xs" prefix={<Hand aria-hidden="true" />} onClick={() => void takeControl()} data-testid="live-view-take">
                Take control
              </Button>
            )
          ) : null}
          <Button variant="tertiary" size="xs" svgOnly aria-label="Close live view" data-testid="live-view-close" onClick={() => void closeLiveView()}>
            <X aria-hidden="true" />
          </Button>
        </span>
      </header>

      <TabStrip tabs={cloud.liveTabs} activeTabId={cloud.liveActiveTabId} onFocus={(tabId) => send({ t: "focus", tabId })} />

      <div
        ref={surfaceRef}
        tabIndex={0}
        onKeyDown={(event) => onKey(event, "keyDown")}
        onKeyUp={(event) => onKey(event, "keyUp")}
        className="relative grid min-h-0 flex-1 place-items-center overflow-hidden p-3 outline-none"
      >
        {frame === null ? (
          <p className="flex items-center gap-2 text-label-13 text-gray-700" data-testid="live-view-waiting">
            {cloud.liveState === "connecting" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Monitor className="size-4" aria-hidden="true" />}
            {cloud.liveState === "connecting"
              ? "Connecting to the cloud browser…"
              : cloud.liveState === "closed"
                ? "This live view has ended."
                : "Waiting for the first frame…"}
          </p>
        ) : (
          <img
            src={frameSource(frame)}
            alt="The cloud browser's screen"
            draggable={false}
            data-testid="live-view-frame"
            // The anchor the ring below positions itself on.
            style={{ aspectRatio: frameAspectRatio(frame), anchorName: "--live-frame" } as CSSProperties}
            ref={imageRef}
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
        {ringed ? (
          <div
            aria-hidden="true"
            data-testid="live-view-ring"
            className="agent-ring live-frame-ring"
            style={{ "--agent-ring-delay": ringDelay } as CSSProperties}
          />
        ) : null}
        {/* The last frame is left where it was, under a veil that says why it
            stopped: a screencast that simply freezes reads as a hung app. */}
        {frame !== null && cloud.liveState !== "open" && cloud.liveState !== "connecting" ? (
          <div className="absolute inset-0 grid place-items-center bg-[oklch(0_0_0/0.4)] p-6">
            <p className="flex max-w-96 items-start gap-2 rounded-md bg-background-100 px-3.5 py-3 text-copy-13 text-gray-1000 shadow-modal" data-testid="live-view-error">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-red-900" aria-hidden="true" />
              <span>
                {cloud.liveError ??
                  (cloud.liveState === "closed" ? "This live view has ended — the run may have finished." : view.note)}
              </span>
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

function TabStrip({
  tabs,
  activeTabId,
  onFocus,
}: {
  tabs: CloudTabInfo[];
  activeTabId: string | null;
  onFocus: (tabId: string) => void;
}) {
  if (tabs.length === 0) return null;
  return (
    <div className="scroll-thin flex shrink-0 gap-1 overflow-x-auto border-b border-alpha-400 bg-background-100 px-2 py-1.5" data-testid="live-view-tabs">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          aria-current={tab.id === activeTabId ? "page" : undefined}
          title={tab.url}
          data-testid={`live-tab-${tab.id}`}
          onClick={() => onFocus(tab.id)}
          className={cn(
            "flex h-7 min-w-0 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm px-2 text-label-12 transition-colors",
            tab.id === activeTabId ? "bg-background-200 text-gray-1000 shadow-border" : "text-gray-900 hover:bg-alpha-100",
          )}
        >
          <span className={cn("size-1.5 shrink-0 rounded-full", tab.kind === "agent" ? "bg-blue-700" : "bg-green-700")} aria-hidden="true" />
          <span className="truncate">{tab.title.trim() === "" ? displayHost(tab.url) : tab.title}</span>
        </button>
      ))}
    </div>
  );
}
