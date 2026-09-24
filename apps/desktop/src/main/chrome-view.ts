import { BrowserWindow, WebContentsView } from "electron";
import { CHROME_VIEW_HASHES, type ChromeViewId } from "@pistachio/shell-contracts/chrome";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";

export interface ChromeOverlayViewOptions {
  id: ChromeViewId;
  preload: string;
}

/**
 * A utility chrome view stacked above the live tab views. It loads the same
 * renderer bundle with a hash naming it (@pistachio/shell-contracts/chrome
 * CHROME_VIEW_HASHES): the drag layer captures pane-resize gestures and the
 * find layer hosts controls above the active page.
 *
 * A view is laid out at its slot before it is shown. It is never resized as
 * part of show/hide, because Chromium briefly stretches the last frame before
 * repainting after a visible resize.
 */
export class ChromeOverlayView {
  readonly id: ChromeViewId;
  readonly #window: BrowserWindow;
  readonly #view: WebContentsView;
  #slot: ContentBounds | null = null;
  #shown = false;
  #veiled = false;

  constructor(window: BrowserWindow, options: ChromeOverlayViewOptions) {
    this.id = options.id;
    this.#window = window;
    this.#view = new WebContentsView({
      webPreferences: {
        preload: options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        // Same trusted, app-owned CommonJS preload as the shell (see index.ts).
        sandbox: false,
        // Utility views are hidden most of the time. Keep their interaction
        // timers responsive as soon as main shows them.
        backgroundThrottling: false,
      },
    });
    this.#view.setBackgroundColor("#00000000");
    this.#view.setVisible(false);
    this.#view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.#view.webContents.on("will-navigate", (event) => event.preventDefault());
    window.contentView.addChildView(this.#view);
  }

  get webContents(): Electron.WebContents {
    return this.#view.webContents;
  }

  /** Whether the view has been requested above the page (unless veiled). */
  get shown(): boolean {
    return this.#shown;
  }

  async load(rendererUrl: string | undefined, file: string): Promise<void> {
    const hash = CHROME_VIEW_HASHES[this.id];
    if (rendererUrl !== undefined) await this.#view.webContents.loadURL(`${rendererUrl}${hash}`);
    else await this.#view.webContents.loadFile(file, { hash: hash.slice(1) });
  }

  /** Re-add to the window: a child added later would otherwise stack above this view. */
  raise(): void {
    if (this.#window.isDestroyed()) return;
    this.#window.contentView.addChildView(this.#view);
  }

  /** The window-relative box this view occupies while shown. */
  setSlot(slot: ContentBounds | null): void {
    this.#slot = slot;
    this.#apply();
  }

  /** Show the view over the page or hide it. */
  setShown(shown: boolean): void {
    if (shown === this.#shown) return;
    this.#shown = shown;
    this.#apply();
  }

  /** The window-relative box the view covers while shown, or null if it cannot. */
  bounds(): ContentBounds | null {
    const slot = this.#slot;
    if (slot === null || slot.width < 1 || slot.height < 1) return null;
    return {
      x: Math.max(0, Math.round(slot.x)),
      y: Math.max(0, Math.round(slot.y)),
      width: Math.max(1, Math.round(slot.width)),
      height: Math.max(1, Math.round(slot.height)),
    };
  }

  /** A full-window veil is up in the shell: get out from over it. */
  setVeiled(veiled: boolean): void {
    if (veiled === this.#veiled) return;
    this.#veiled = veiled;
    this.#apply();
  }

  destroy(): void {
    if (!this.#window.isDestroyed()) this.#window.contentView.removeChildView(this.#view);
    // The window closing may already have torn the contents down with it.
    if (!this.#view.webContents.isDestroyed()) this.#view.webContents.close();
  }

  #apply(): void {
    const bounds = this.bounds();
    if (bounds !== null) this.#view.setBounds(bounds);
    this.#view.setVisible(bounds !== null && this.#shown && !this.#veiled);
  }
}
