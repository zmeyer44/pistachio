import type { BrowserWindow } from "electron";
import { IPC, type ContentBounds } from "@pistachio/shell-contracts/ipc";
import {
  DEFAULT_NOTICE_POSITION,
  noticeViewHeight,
  noticeViewSlot,
  type NoticeFootprint,
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
 *
 * What of the window its cards cover is said as it changes (`onCover`): a
 * live share's outlines, drawn in a window of their own over this one, go
 * under it (docs/live-share.md §6.3). That is where the view says it draws
 * them — measured in the view as it is — and, from the moment a card
 * arrives or the view is resized until the view says so again, the whole
 * view: shown before the view even hears of the card, so no frame of it is
 * ever drawn under an outline.
 */
export class NoticeLayer {
  readonly #view: ChromeOverlayView;
  readonly #window: BrowserWindow;
  /** Hand the keyboard back: the view took it with a click and is going away. */
  readonly #releaseFocus: () => void;
  readonly #onCover: (box: ContentBounds | null) => void;
  #items: NoticeItem[] = [];
  #position: NoticePosition = DEFAULT_NOTICE_POSITION;
  #anchor: ContentBounds | null = null;
  #height = REST_HEIGHT;
  #hideTimer: NodeJS.Timeout | null = null;
  /** Where the view lies in the window while it is placed (window content px). */
  #slot: ContentBounds | null = null;
  /** Where the view says it draws its cards, in its own px; null with none. */
  #footprint: ContentBounds | null = null;
  /** A card arrived, or the view was resized, since the view last said where its cards are: all of it may be drawn on. */
  #pending = false;
  #cover: ContentBounds | null = null;

  constructor(view: ChromeOverlayView, window: BrowserWindow, releaseFocus: () => void, onCover: (box: ContentBounds | null) => void = () => undefined) {
    this.#view = view;
    this.#window = window;
    this.#releaseFocus = releaseFocus;
    this.#onCover = onCover;
  }

  get view(): ChromeOverlayView {
    return this.#view;
  }

  state(): NoticeStackState {
    return { items: this.#items, position: this.#position };
  }

  /** The shell's latest word: what is up, and where the browser surface is. */
  setFrame(frame: NoticeFrame): void {
    if (frame.items.some((item) => !this.#items.some((had) => had.id === item.id))) this.#pending = true;
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
    this.#covered();
    this.#send();
  }

  /** Where the view draws its cards now (its report); null with none. */
  footprint(footprint: NoticeFootprint | null): void {
    // (Measured in a view of another size than the one placed: laid out before it was resized, and said again after.)
    const slot = this.#slot;
    if (footprint !== null && (slot === null || footprint.view.width !== slot.width || footprint.view.height !== slot.height)) return;
    this.#footprint = footprint === null ? null : { ...footprint.box };
    this.#pending = false;
    this.#covered();
  }

  /** What of the window the cards cover now (window content px), or null. */
  cover(): ContentBounds | null {
    const slot = this.#slot;
    if (slot === null || !this.#view.shown) return null;
    if (this.#pending) return { ...slot };
    const box = this.#footprint;
    if (box === null) return null;
    const x = Math.max(slot.x, slot.x + box.x);
    const y = Math.max(slot.y, slot.y + box.y);
    const right = Math.min(slot.x + slot.width, slot.x + box.x + box.width);
    const bottom = Math.min(slot.y + slot.height, slot.y + box.y + box.height);
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
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
    this.#slot = null;
    this.#covered();
  }

  #covered(): void {
    const cover = this.cover();
    const was = this.#cover;
    if (cover === was || (cover !== null && was !== null && cover.x === was.x && cover.y === was.y && cover.width === was.width && cover.height === was.height)) return;
    this.#cover = cover;
    this.#onCover(cover);
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
      this.#slot = null;
      this.#covered();
      return;
    }
    // (Resized, the view lays its cards out afresh: what it said of them was of the old size.)
    if (this.#slot === null || slot.width !== this.#slot.width || slot.height !== this.#slot.height) this.#pending = true;
    this.#slot = slot;
    this.#view.setSlot(slot);
    this.#view.setShown(true);
    this.#view.raise();
    this.#covered();
  }

  #hide(): void {
    this.#hideTimer = null;
    if (this.#items.length > 0) return;
    const focused = !this.#view.webContents.isDestroyed() && this.#view.webContents.isFocused();
    this.#view.setShown(false);
    this.#slot = null;
    this.#footprint = null;
    this.#pending = false;
    this.#covered();
    this.#height = REST_HEIGHT;
    // A hidden utility view must never keep keyboard focus.
    if (focused) this.#releaseFocus();
  }
}
