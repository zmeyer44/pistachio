/**
 * The desk's prompt over a live page (docs/desk.md, "The foot"): a view of
 * the shell's own, above the tab views, so the prompt lies on a page as the
 * nub does and no window gives way to it.
 *
 * It is not a page main loads. The shell opens a child window by a name
 * (DESK_BAR_VIEW_FRAME) and main makes the view of it instead of a window
 * (`setWindowOpenHandler`'s `createWindow`): the child keeps its opener, so
 * it lives in the shell's own renderer and the shell draws into its document
 * directly — the same React tree, the same state, nothing sent across to be
 * kept in step. Main only says where the view lies, and hands it the keys.
 */

import { WebContentsView, type BrowserWindow, type BrowserWindowConstructorOptions, type HandlerDetails, type WebContents, type WindowOpenHandlerResponse } from "electron";
import { DESK_BAR_VIEW_FRAME, type DeskBarViewPlace } from "@pistachio/shell-contracts/desk";

export interface DeskBarViewOptions {
  /** The view was made of the shell's child window: its contents, for the hooks main puts on every view of its own. */
  adopted?: (contents: WebContents) => void;
  /** Placed, shown, hidden or raised: what lies over what may have changed. */
  placed?: () => void;
  /** Taken from over the pages while it held the keyboard: the keys are the shell's again. */
  released?: () => void;
  /** It has put itself over every view of the window as it came up: what must lie over it still is put back there. */
  restack?: () => void;
}

export class DeskBarView {
  readonly #window: BrowserWindow;
  readonly #options: DeskBarViewOptions;
  #view: WebContentsView | null = null;
  #shown = false;
  #veiled = false;
  /** Where it was last laid, as said to the view: laid there again, it is not moved. */
  #laid: { x: number; y: number; width: number; height: number } | null = null;

  constructor(window: BrowserWindow, options: DeskBarViewOptions = {}) {
    this.#window = window;
    this.#options = options;
  }

  /** The view's contents, while the shell has it open. */
  get webContents(): WebContents | null {
    return this.#view?.webContents ?? null;
  }

  /** Whether it is over the pages now. */
  get shown(): boolean {
    return this.#view !== null && this.#shown && !this.#veiled;
  }

  /** A full-window veil is up in the shell (the palette, Settings, a dialog): get out from over it. */
  setVeiled(veiled: boolean): void {
    if (veiled === this.#veiled) return;
    this.#veiled = veiled;
    const view = this.#view;
    if (view === null || !this.#shown || this.#window.isDestroyed()) return;
    const held = veiled && !view.webContents.isDestroyed() && view.webContents.isFocused();
    view.setVisible(!veiled);
    if (!veiled) this.#rise();
    if (held) this.#options.released?.();
    this.#options.placed?.();
  }

  /**
   * The shell's `window.open`, answered: the prompt's frame is made a view of this window; anything else is null,
   * for the caller to deny.
   */
  opening(details: Pick<HandlerDetails, "frameName" | "url">): WindowOpenHandlerResponse | null {
    if (details.frameName !== DESK_BAR_VIEW_FRAME || details.url !== "about:blank") return null;
    return { action: "allow", createWindow: (options) => this.#adopt(options) };
  }

  /** Where it lies, or null to take it from over the pages (it stays open, unseen, for the next time). */
  place(place: DeskBarViewPlace | null): void {
    const view = this.#view;
    if (view === null || this.#window.isDestroyed()) return;
    if (place === null) {
      if (!this.#shown) return;
      this.#shown = false;
      const held = !view.webContents.isDestroyed() && view.webContents.isFocused();
      view.setVisible(false);
      // (A view nobody sees must not keep the keys: what is typed next would go nowhere.)
      if (held) this.#options.released?.();
      this.#options.placed?.();
      return;
    }
    const { x, y, width, height } = place.bounds;
    const lay = { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
    const laid = this.#laid;
    // (Not laid again where it lies: to its page a box set is a box changed, and it is drawn again for it — while the
    // pill in it is on its way out of the nub.)
    if (laid === null || laid.x !== lay.x || laid.y !== lay.y || laid.width !== lay.width || laid.height !== lay.height) {
      this.#laid = lay;
      view.setBounds(lay);
    }
    if (!this.#shown) {
      this.#shown = true;
      view.setVisible(!this.#veiled);
      if (!this.#veiled) this.#rise();
    }
    if (place.focus === true && !this.#veiled && !view.webContents.isDestroyed()) view.webContents.focus();
    this.#options.placed?.();
  }

  /**
   * Over the window's other views: a child added later (a tab's view) would otherwise stack above it. (Over the nub's
   * views too — the nub's menu runs back into the nub under the pill, and the pill's end is the pointer's from the
   * moment it is out. It lies beside the nub, its box reaching a few px into the nub's for the pill's shadow: main's
   * notchCovered does not count it as a view lying over the nub.)
   */
  raise(): void {
    const view = this.#view;
    if (view === null || this.#window.isDestroyed()) return;
    const parent = this.#window.contentView;
    const children = parent.children;
    // (On top already, it is left where it is: a view re-added is taken out and put back.)
    if (children[children.length - 1] !== view) parent.addChildView(view);
  }

  destroy(): void {
    this.#drop();
  }

  /**
   * Coming up, it goes over every view of the window. While it was away it was not kept on top (main keeps only the
   * views that are up there, as each tab's view is added), so a tab opened meanwhile lies over it: shown where it
   * stood, the prompt would be behind that page — unseen, out of the pointer's reach, and holding the keyboard.
   */
  #rise(): void {
    this.raise();
    this.#options.restack?.();
  }

  #adopt(windowOptions: BrowserWindowConstructorOptions): WebContents {
    // (Electron hands the child's contents — the one that holds the opener — along in `webContents`; the typings omit it.)
    const { webContents, webPreferences } = windowOptions as BrowserWindowConstructorOptions & { webContents?: WebContents };
    // An earlier one (the shell reloaded, and opened its view again) goes first.
    this.#drop();
    const view = new WebContentsView(webContents === undefined ? { webPreferences: webPreferences ?? {} } : { webContents, webPreferences: webPreferences ?? {} });
    view.setBackgroundColor("#00000000");
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event) => event.preventDefault());
    view.webContents.once("destroyed", () => {
      if (this.#view !== view) return;
      this.#view = null;
      this.#shown = false;
      if (!this.#window.isDestroyed()) this.#window.contentView.removeChildView(view);
    });
    this.#window.contentView.addChildView(view);
    this.#view = view;
    this.#shown = false;
    this.#laid = null;
    this.#options.adopted?.(view.webContents);
    return view.webContents;
  }

  #drop(): void {
    const view = this.#view;
    if (view === null) return;
    this.#view = null;
    this.#shown = false;
    if (!this.#window.isDestroyed()) this.#window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
}
