"use client";

import { RemoteCursor, useLinked } from "./linked-controls";

/**
 * A cloud browser tab, painted into the page (docs/web-browser-design.md §7,
 * W1, W10). One of these goes where the desktop puts a hole for a native
 * `WebContentsView`: the shell's `ContentArea` asks the stream surface to
 * render a pane, and this is what it renders.
 *
 * It is `live-pane.tsx`'s sibling, not its replacement — that one watches one
 * run and belongs to the run page; this one belongs to a session and there is
 * one per visible pane. Both send their pointer and key events through
 * `@pistachio/live-view`, which owns the arithmetic that turns a click on a
 * scaled image into a click in the cloud page. That part fails silently when
 * it is wrong, so it is not written twice.
 *
 * THREE RULES.
 *
 * The frames never travel further than this component. They arrive on the
 * shell socket's per-tab frame channel — deliberately not through the store,
 * which every piece of chrome subscribes to — and are coalesced to one repaint
 * per animation frame.
 *
 * The pane tells the host its own size. A `ResizeObserver` reports the CSS box
 * and this display's device pixel ratio, and the host sizes the page and its
 * screencast to match. Unmounting says `visible: false`, which stops the
 * screencast rather than leaving a tab painting into nothing.
 *
 * Input carries the generation it was issued under (W7), and is sent only
 * while the person holds control. When the agent holds it the last frame stays
 * where it was under a veil that says so: a surface that silently swallows
 * clicks reads as a hung page.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Bot } from "lucide-react";
import {
  frameAspectRatio,
  frameSource,
  heldMouseButton,
  keyInput,
  liveModifiers,
  liveMouseButton,
  livePoint,
  mouseInput,
  type LiveFrame,
  type LiveInput,
  type LiveMouseButton,
  type LivePoint,
} from "@pistachio/live-view";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import type { ShellControl } from "@pistachio/shell-contracts/socket";
import { PanePlaceholder } from "@pistachio/shell-ui";
import type { ShellInputEvent, WsShellApi } from "../lib/shell-socket";
import { cn } from "../lib/utils";
import { PixelAudio } from "./pixel-audio";
import { PaneContextMenu } from "./stream-capabilities";

/** A pane's size settles a beat after a drag stops; the host resizes on it. */
const RESIZE_DEBOUNCE_MS = 100;

/** `mouseInput`/`keyInput` answer a whole live-view frame; the socket wants the event. */
function eventOf(input: LiveInput | null): ShellInputEvent | null {
  return input !== null && input.t === "input" ? input.event : null;
}

/**
 * A pane before its page is on screen: waking, or waiting on the first frame
 * or the mirror's first paint. It is the shell's placeholder, so the tab's
 * favicon sits above the caption rather than under it.
 */
export function PaneWaiting({ tab, testId, className }: { tab: BrowserTabInfo; testId: string; className?: string }): ReactNode {
  return (
    <div className={cn("grid place-items-center px-4", className)} data-testid={testId}>
      <PanePlaceholder tab={tab}>
        <p className="max-w-80 text-center text-balance text-label-13 text-gray-700">
          {tab.title.trim() === "" ? "Opening…" : `Opening ${tab.title}…`}
        </p>
      </PanePlaceholder>
    </div>
  );
}

/** Who holds control right now, kept in this component rather than the store. */
export function useShellControl(api: WsShellApi): ShellControl {
  const [control, setControl] = useState<ShellControl>(api.control);
  useEffect(() => {
    setControl(api.control);
    return api.onControl(setControl);
  }, [api]);
  return control;
}

export function StreamedPane({
  active,
  api,
  tab,
  onMediaChange,
  editorInput,
}: {
  /** Whether this pane holds the focused tab; the keyboard follows it. */
  active: boolean;
  api: WsShellApi;
  tab: BrowserTabInfo;
  onMediaChange?(count: number): void;
  editorInput?: RefObject<HTMLTextAreaElement | null>;
}): ReactNode {
  const tabId = tab.id;
  const [audioReady, setAudioReady] = useState(false);
  const audioReadyRef = useRef(audioReady);
  audioReadyRef.current = audioReady;
  const reportPane = useRef<(() => void) | null>(null);
  useEffect(() => { reportPane.current?.(); }, [audioReady]);
  const control = useShellControl(api);
  useLinked(api);
  const human = control.holder === "human" && !api.following;
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  /**
   * How many frames this pane has painted. It is a ref rather than state
   * because it must not cause a render of its own — it is read during the
   * render the frame itself causes — and it is on the element as
   * `data-frame-seq` because "the picture is live" is otherwise unobservable
   * from outside: an end-to-end test can watch this advance and know a FRESH
   * frame arrived, rather than trusting that a stale one on screen is current.
   */
  const painted = useRef(0);
  const surface = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const moveHandle = useRef(0);
  /** The button currently held down here, so a release can always be sent for it. */
  const held = useRef<{ button: LiveMouseButton; point: LivePoint } | null>(null);

  /* ------------------------------- the frames ------------------------------ */

  useEffect(() => {
    let raf = 0;
    let pending: LiveFrame | null = null;
    let live = true;
    const off = api.onFrame(tabId, (next) => {
      pending = next;
      if (raf !== 0) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        if (live && pending !== null) {
          painted.current += 1;
          setFrame(pending);
        }
      });
    });
    return () => {
      live = false;
      if (raf !== 0) window.cancelAnimationFrame(raf);
      off();
    };
  }, [api, tabId]);

  /* -------------------------------- the size ------------------------------- */

  useEffect(() => {
    const element = surface.current;
    if (element === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const report = (): void => {
      const box = element.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return;
      api.pane(tabId, {
        width: Math.round(box.width),
        height: Math.round(box.height),
        dpr: window.devicePixelRatio,
        visible: true,
        renderer: "pixels",
        hybridMedia: audioReadyRef.current,
      });
    };
    reportPane.current = report;
    report();
    const observer = new ResizeObserver(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(report, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(element);
    return () => {
      reportPane.current = null;
      if (timer !== null) clearTimeout(timer);
      observer.disconnect();
      // The pane is gone: stop the screencast rather than leave a tab
      // painting frames nobody is holding.
      api.releasePane(tabId);
    };
  }, [api, tabId]);

  /* ------------------------------- the pointer ----------------------------- */

  const send = useCallback(
    (input: LiveInput | null) => {
      api.input(tabId, eventOf(input));
    },
    [api, tabId],
  );

  /**
   * Let go of whatever is held, wherever the pointer got to. CDP has no idea
   * the person switched panes, lost the capture, or handed control back — it
   * just keeps the button down, and the next click in the cloud page lands
   * inside a drag that never ended.
   */
  const releaseHeld = useCallback(() => {
    const down = held.current;
    if (down === null) return;
    held.current = null;
    send(mouseInput({ type: "mouseReleased", point: down.point, button: down.button, clickCount: 1, modifiers: 0 }));
  }, [send]);

  useEffect(() => {
    if (!human) releaseHeld();
  }, [human, releaseHeld]);
  useEffect(() => releaseHeld, [releaseHeld]);
  useEffect(
    () => () => {
      if (moveHandle.current !== 0) window.cancelAnimationFrame(moveHandle.current);
    },
    [],
  );

  // The keyboard belongs to the focused pane: a person who selects a tab
  // should be able to type in it without clicking the page first.
  useEffect(() => {
    if (active && human) (editorInput?.current ?? surface.current)?.focus({ preventScroll: true });
  }, [active, human, editorInput]);

  const pointFor = (event: ReactPointerEvent<HTMLImageElement>): LivePoint | null =>
    frame === null
      ? null
      : livePoint(frame, event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);

  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>): void => {
    if (!human) return;
    const point = pointFor(event);
    if (point === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    (editorInput?.current ?? surface.current)?.focus({ preventScroll: true });
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

  const onPointerUp = (event: ReactPointerEvent<HTMLImageElement>): void => {
    if (!human) return;
    const point = pointFor(event);
    if (point === null) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
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

  /** Pointer moves are sampled to one per frame; presses and releases never are. */
  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>): void => {
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
   * the shell behind it.
   */
  useEffect(() => {
    const element = image.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent): void => {
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
  }, [frame, human, send]);

  /* ------------------------------ the keyboard ----------------------------- */

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>, type: "keyDown" | "keyUp"): void => {
    if (!human) return;
    // Every key is the cloud page's while this pane has focus, ⌘-shortcuts
    // included: the shell's own bindings live on the chrome, not on a page.
    event.preventDefault();
    event.stopPropagation();
    send(keyInput(event, type));
  };

  return (
    <div
      ref={surface}
      tabIndex={0}
      // THE ACCESSIBILITY FLOOR, NOT THE CEILING. A streamed pane is pixels:
      // there is no DOM here for a screen reader to walk, and building the
      // semantic bridge — mirroring the page's accessibility tree over the
      // socket — is out of scope for S6 and named as such in §11. What IS
      // here is what a browser can honestly offer about a picture: the region
      // has a name that says which page it is showing, and a live region
      // announces when that changes, so moving between tabs is not silent.
      role="region"
      aria-label={`${tab.title.trim() === "" ? "Untitled page" : tab.title} — ${tab.url}`}
      aria-busy={frame === null}
      data-testid={`streamed-pane-${tabId}`}
      data-streamed-pane={tabId}
      data-control={control.holder}
      onKeyDown={(event) => onKey(event, "keyDown")}
      onKeyUp={(event) => onKey(event, "keyUp")}
      className="absolute inset-0 grid place-items-center overflow-hidden bg-background-100 outline-none"
    >
      {frame === null ? (
        <PaneWaiting tab={tab} testId="streamed-pane-waiting" />
      ) : (
        <img
          src={frameSource(frame)}
          alt={tab.title === "" ? "The page in this tab" : tab.title}
          draggable={false}
          data-testid="streamed-pane-frame"
          data-frame-seq={String(painted.current)}
          style={{ aspectRatio: frameAspectRatio(frame) }}
          ref={image}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerMove={onPointerMove}
          onPointerCancel={onPointerUp}
          onLostPointerCapture={releaseHeld}
          onContextMenu={(event) => event.preventDefault()}
          className={cn(
            "max-h-full max-w-full object-contain select-none",
            human ? "cursor-default" : "cursor-not-allowed",
          )}
        />
      )}
      <RemoteCursor api={api} tabId={tabId} image={image} />
      <PixelAudio api={api} tabId={tabId} onReady={setAudioReady} onMediaChange={onMediaChange} />
      <PaneContextMenu api={api} tabId={tabId} surface={surface} />
      {control.holder === "human" ? null : (
        <div className="pa-pane-veil" role="status" aria-live="polite" data-testid="streamed-pane-veil">
          <p className="flex items-center gap-2 rounded-md bg-background-100 px-3 py-2 text-copy-13 text-gray-1000 shadow-modal">
            <Bot className="size-4 shrink-0 text-blue-900" aria-hidden="true" />
            {api.following ? "Following your other device." : "The agent is working in this tab. Take control to type or click."}
          </p>
        </div>
      )}
    </div>
  );
}
