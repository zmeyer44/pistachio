/**
 * A guest's hands on a window the host lets them use (docs/live-share.md §1
 * Use a window, §4 Input, §7): pointer, wheel, keys, paste and IME on the
 * window's page box, turned into `lv.input` by the package's helpers.
 *
 * The pointer is the guest's hand over the page: a press there also gives
 * the window the guest's keyboard, held by a hidden textarea inside it (so
 * an IME composes in place and a paste arrives as text); Escape or a press
 * anywhere else gives the keyboard back. Moves and wheel deltas are folded
 * to one event per frame — the host takes at most 240 a second — while
 * presses and releases go at once, after the move before them.
 *
 * Only the left button reaches the page: a right-click would open a menu on
 * the host's screen that the guest cannot see. Copy and cut do nothing (the
 * host's clipboard is never written for a guest); paste sends the guest's own
 * text. Nothing goes out unless `usable()` says so at that moment — the
 * latest desk frame allows this window and the host is on the space.
 *
 * What the guest presses on the page is released there, even when its
 * release never comes here: main holds a guest's press until it hears the
 * release (§6.1), and a key whose up lands elsewhere — the keyboard given to
 * the chat or another window, the browser window or the tab left — would stay
 * down on the host's page. So each key whose press went out is released when
 * the textarea loses the keyboard, and each key and the button when the
 * browser window loses focus, the tab is hidden, or the input is taken down.
 * And what was let go is let go again each time the host may have missed
 * it: a reliable message sent as either side's connection went can be lost
 * (LiveKit lost some across a failed resume, a full reconnect and a
 * migration; probed with livekit-server 1.13), and main would hold that
 * press on the host's page until the guest's hands came off the window.
 * Main sends a page no release of a press it does not have down, so one that
 * did arrive ends nothing more.
 *
 * The guest page's (apps/www), kept in the package to be tested here.
 */

import { ClickCounter, clipboardChord, keyToLive, pointerToLive, textToLive, wheelToLive } from "../input.js";
import type { LiveInputEvent } from "../protocol.js";

export interface WindowInputOptions {
  /** The window's page box: what the pointer acts on. */
  page: HTMLElement;
  /** The hidden textarea that holds the keyboard while the window has it. */
  keys: HTMLTextAreaElement;
  /** Whether input may go to this window now. */
  usable(): boolean;
  send(event: LiveInputEvent): void;
  /** The window took the guest's keyboard, or gave it back. */
  onKeyboard(held: boolean): void;
  /** Calls back each time the host may have missed what was sent: it hears this guest again after a drop on either side. Returns the unsubscribe. */
  onReconnected(listener: () => void): () => void;
}

export function attachWindowInput({ page, keys, usable, send, onKeyboard, onReconnected }: WindowInputOptions): () => void {
  const clicks = new ClickCounter();
  let pressed: number | null = null;
  let lastPoint: PointerEvent | null = null;
  let pendingMove: PointerEvent | null = null;
  let pendingWheel: { event: WheelEvent; dx: number; dy: number } | null = null;
  let frame = 0;
  let composing = false;
  /** Keys whose press went out and whose release has not, by the physical key as main tells them apart. */
  const keysDown = new Map<string, Extract<LiveInputEvent, { type: "keyDown" }>>();
  /** The last release sent of each key that is up now, and of the button: what is sent again after a drop (one for each key at most). */
  const keysUp = new Map<string, Extract<LiveInputEvent, { type: "keyUp" }>>();
  let buttonUp: Extract<LiveInputEvent, { type: "mouseUp" }> | null = null;

  /** Send an event, keeping account of what it presses and lets go of. */
  const sendInput = (event: LiveInputEvent): void => {
    send(event);
    switch (event.type) {
      case "mouseDown":
        buttonUp = null;
        return;
      case "mouseUp":
        buttonUp = event;
        return;
      case "keyDown":
        keysDown.set(keyId(event), event);
        keysUp.delete(keyId(event));
        return;
      case "keyUp":
        keysDown.delete(keyId(event));
        keysUp.set(keyId(event), event);
        return;
    }
  };

  const box = (): DOMRect => page.getBoundingClientRect();

  const flush = (): void => {
    frame = 0;
    if (pendingMove !== null) {
      const event = pendingMove;
      pendingMove = null;
      if (usable()) {
        const move = pointerToLive(event, box(), "mouseMove");
        if (move !== null) send(move);
      }
    }
    if (pendingWheel !== null) {
      const { event, dx, dy } = pendingWheel;
      pendingWheel = null;
      if (usable()) send(wheelToLive({ clientX: event.clientX, clientY: event.clientY, deltaX: dx, deltaY: dy, deltaMode: 0, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey }, box()));
    }
  };
  const schedule = (): void => {
    if (frame === 0) frame = requestAnimationFrame(flush);
  };
  const flushNow = (): void => {
    if (frame !== 0) cancelAnimationFrame(frame);
    flush();
  };

  const release = (): void => {
    if (document.activeElement === keys) keys.blur();
  };

  const onPointerDown = (event: PointerEvent): void => {
    // ⌥-click is a ping wherever it lands; the stage handles it.
    if (!usable() || event.altKey || event.button !== 0 || pressed !== null) return;
    event.preventDefault();
    pressed = event.pointerId;
    lastPoint = event;
    page.setPointerCapture(event.pointerId);
    // The IME's candidates open where the guest clicked.
    const rect = box();
    keys.style.transform = `translate(${(event.clientX - rect.left).toFixed(0)}px, ${(event.clientY - rect.top).toFixed(0)}px)`;
    keys.focus({ preventScroll: true });
    flushNow();
    const down = pointerToLive(event, rect, "mouseDown", clicks.press(event, event.timeStamp));
    if (down !== null) sendInput(down);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!usable()) {
      pendingMove = null;
      return;
    }
    lastPoint = event;
    pendingMove = event;
    schedule();
  };

  const finish = (event: PointerEvent | null): void => {
    if (pressed === null) return;
    const id = pressed;
    pressed = null;
    flushNow();
    const at = event ?? lastPoint;
    if (page.hasPointerCapture(id)) page.releasePointerCapture(id);
    // Released even when input stopped being allowed mid-press: a button left down on the host would stick.
    if (at === null) return;
    const up = pointerToLive({ clientX: at.clientX, clientY: at.clientY, button: 0, buttons: 0, shiftKey: at.shiftKey, ctrlKey: at.ctrlKey, altKey: at.altKey, metaKey: at.metaKey }, box(), "mouseUp", clicks.release());
    if (up !== null) sendInput(up);
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId === pressed && event.button === 0) finish(event);
  };
  const onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === pressed) finish(null);
  };

  const onWheel = (event: WheelEvent): void => {
    if (!usable()) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? box().height : 1;
    pendingWheel = { event, dx: (pendingWheel?.dx ?? 0) + event.deltaX * unit, dy: (pendingWheel?.dy ?? 0) + event.deltaY * unit };
    schedule();
  };

  const onContextMenu = (event: MouseEvent): void => {
    if (usable()) event.preventDefault();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!usable()) {
      release();
      return;
    }
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (event.key === "Escape" && plain) {
      event.preventDefault();
      event.stopPropagation();
      release();
      return;
    }
    if (composing || event.isComposing) return;
    // Paste (⌘V, Ctrl+V, Shift+Insert) is left to this browser, whose paste event below sends the
    // guest's own text; copy and cut never reach the host, nor does any other clipboard chord.
    const chord = event.altKey ? null : clipboardChord(event);
    if (chord === "paste") return;
    if (chord !== null || event.key === "Insert") {
      event.preventDefault();
      return;
    }
    const events = keyToLive(event, "keyDown");
    if (events.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    for (const each of events) sendInput(each);
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (!usable() || composing || event.isComposing) return;
    for (const each of keyToLive(event, "keyUp")) sendInput(each);
    event.stopPropagation();
  };

  /**
   * Release every key whose press went out, with the modifiers its press had:
   * a chord main refused stays refused, and main sends a release it owes
   * plain whatever this says (§6.1).
   */
  const releaseKeys = (): void => {
    for (const { key, code, modifiers } of [...keysDown.values()]) sendInput({ type: "keyUp", key, code, modifiers });
  };
  /** The guest's page lost the focus: no release from here on reaches it, so let go of everything held. */
  const letGo = (): void => {
    finish(null);
    releaseKeys();
  };
  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") letGo();
  };
  /** The host may have missed what was let go: all of it again, the button first (what was pressed again since is down, and stays so). */
  const releaseAgain = (): void => {
    if (buttonUp !== null) send(buttonUp);
    for (const up of keysUp.values()) send(up);
  };

  const onPaste = (event: ClipboardEvent): void => {
    event.preventDefault();
    if (!usable()) return;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    for (const each of textToLive(text)) send(each);
  };

  const onCompositionStart = (): void => {
    composing = true;
  };
  const onCompositionEnd = (event: CompositionEvent): void => {
    composing = false;
    keys.value = "";
    if (usable() && event.data !== "") for (const each of textToLive(event.data)) send(each);
  };
  // What the textarea collects outside a composition was sent key by key already.
  const onInput = (): void => {
    if (!composing) keys.value = "";
  };
  const onFocus = (): void => onKeyboard(true);
  const onBlur = (): void => {
    releaseKeys();
    onKeyboard(false);
  };

  page.addEventListener("pointerdown", onPointerDown);
  page.addEventListener("pointermove", onPointerMove);
  page.addEventListener("pointerup", onPointerUp);
  page.addEventListener("pointercancel", onPointerCancel);
  page.addEventListener("lostpointercapture", onPointerCancel);
  page.addEventListener("wheel", onWheel, { passive: false });
  page.addEventListener("contextmenu", onContextMenu);
  keys.addEventListener("keydown", onKeyDown);
  keys.addEventListener("keyup", onKeyUp);
  keys.addEventListener("paste", onPaste);
  keys.addEventListener("compositionstart", onCompositionStart);
  keys.addEventListener("compositionend", onCompositionEnd);
  keys.addEventListener("input", onInput);
  keys.addEventListener("focus", onFocus);
  keys.addEventListener("blur", onBlur);
  window.addEventListener("blur", letGo);
  document.addEventListener("visibilitychange", onVisibility);
  const offReconnected = onReconnected(releaseAgain);

  return () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    offReconnected();
    letGo();
    release();
    page.removeEventListener("pointerdown", onPointerDown);
    page.removeEventListener("pointermove", onPointerMove);
    page.removeEventListener("pointerup", onPointerUp);
    page.removeEventListener("pointercancel", onPointerCancel);
    page.removeEventListener("lostpointercapture", onPointerCancel);
    page.removeEventListener("wheel", onWheel);
    page.removeEventListener("contextmenu", onContextMenu);
    keys.removeEventListener("keydown", onKeyDown);
    keys.removeEventListener("keyup", onKeyUp);
    keys.removeEventListener("paste", onPaste);
    keys.removeEventListener("compositionstart", onCompositionStart);
    keys.removeEventListener("compositionend", onCompositionEnd);
    keys.removeEventListener("input", onInput);
    keys.removeEventListener("focus", onFocus);
    keys.removeEventListener("blur", onBlur);
    window.removeEventListener("blur", letGo);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** A key as main's input gate tells keys apart: its physical key, or its name where there is none. */
function keyId(event: { key: string; code: string }): string {
  return event.code === "" ? `key:${event.key}` : event.code;
}
