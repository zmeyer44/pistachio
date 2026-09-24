import type { BrowserWindow } from "electron";
import { IPC, type ContentBounds } from "@pistachio/shell-contracts/ipc";
import {
  DEFAULT_NOTICE_POSITION,
  noticeViewHeight,
  noticeViewSlot,
  type NoticeFrame,
  type NoticeItem,
  type NoticePosition,
  type NoticeStackState,
} from "@pistachio/shell-contracts/notice";
import type { ChromeOverlayView } from "./chrome-view";

/**
 * How long the view stays up after the last notice is gone: the card's exit
 * plays inside the view, so taking the view down with the list would cut it.
 */
const HIDE_AFTER_MS = 500;

/** The view's height at rest — a one-line card — so the usual notice never resizes a shown view. */
const REST_HEIGHT = noticeViewHeight(48);

/**
 * The notice stack's native view (@pistachio/shell-contracts/notice): fed
 * the shell's live notices, parked in the browser surface where Settings →
 * Appearance says the stack stands, and taken down once the last card has
 * left.
 *
 * Unlike the find bar and the bookmark card it is never veiled. A notice is
 * about the window, not the page — "Shortcut saved" is said over Settings —
 * and the view stacks above the shell's own page, so it shows over an
 * overlay as well as over a tab.
 *
 * While shown the view only ever GROWS: Chromium stretches a visible view's
 * last frame across a resize (chrome-view.ts), and a card squashed for a
 * frame as its neighbour leaves reads as a glitch. It grows when a card
 * arrives — everything is already moving then — and resets once hidden.
 */
export class NoticeLayer {
  readonly #view: ChromeOverlayView;
  readonly #window: BrowserWindow;
  /** Hand the keyboard back: the view took it with a click and is going away. */
  readonly #releaseFocus: () => void;
  #items: NoticeItem[] = [];
  #position: NoticePosition = DEFAULT_NOTICE_POSITION;
  #anchor: ContentBounds | null = null;
  #height = REST_HEIGHT;
  #hideTimer: NodeJS.Timeout | null = null;

  constructor(view: ChromeOverlayView, window: BrowserWindow, releaseFocus: () => void) {
    this.#view = view;
    this.#window = window;
    this.#releaseFocus = releaseFocus;
  }

  get view(): ChromeOverlayView {
    return this.#view;
  }

  state(): NoticeStackState {
    return { items: this.#items, position: this.#position };
  }

  /** The shell's latest word: what is up, and where the browser surface is. */
  setFrame(frame: NoticeFrame): void {
    this.#items = frame.items;
    this.#position = frame.position;
    this.#anchor = frame.anchor;
    if (this.#items.length > 0) {
      if (this.#hideTimer !== null) clearTimeout(this.#hideTimer);
      this.#hideTimer = null;
      // Placed and shown BEFORE the view hears of the card, so the entrance
      // plays in a view that is already on screen.
      this.#place();
    } else if (this.#view.shown && this.#hideTimer === null) {
      this.#hideTimer = setTimeout(() => this.#hide(), HIDE_AFTER_MS);
      this.#hideTimer.unref();
    }
    this.#send();
  }

  /** The stack's own measure of its cards spread out (the view's report). */
  resize(stackHeight: number): void {
    const next = Math.max(this.#height, noticeViewHeight(stackHeight));
    if (next === this.#height) return;
    this.#height = next;
    if (this.#view.shown) this.#place();
  }

  /** The window moved its furniture with nothing new to say: follow it. */
  reflow(): void {
    if (this.#view.shown) this.#place();
  }

  /** The view finished loading: tell it what it missed. */
  loaded(): void {
    this.#send();
  }

  dispose(): void {
    if (this.#hideTimer !== null) clearTimeout(this.#hideTimer);
    this.#hideTimer = null;
    this.#items = [];
  }

  #send(): void {
    const contents = this.#view.webContents;
    if (!contents.isDestroyed()) contents.send(IPC.noticesChanged, this.state());
  }

  #place(): void {
    if (this.#window.isDestroyed()) return;
    const content = this.#window.getContentBounds();
    const anchor = this.#anchor ?? { x: 0, y: 0, width: content.width, height: content.height };
    const slot = noticeViewSlot(anchor, this.#height, this.#position);
    if (slot === null) {
      this.#view.setShown(false);
      return;
    }
    this.#view.setSlot(slot);
    this.#view.setShown(true);
    this.#view.raise();
  }

  #hide(): void {
    this.#hideTimer = null;
    if (this.#items.length > 0) return;
    const focused = !this.#view.webContents.isDestroyed() && this.#view.webContents.isFocused();
    this.#view.setShown(false);
    this.#height = REST_HEIGHT;
    // A hidden utility view must never keep keyboard focus.
    if (focused) this.#releaseFocus();
  }
}
