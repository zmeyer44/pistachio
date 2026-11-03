/**
 * An extension's three contexts (docs/extensions.md §4, "Views") and the one
 * thing that says who is calling: a map from `webContents.id` to (extension,
 * context, page), written by main when it made the view. A message naming an
 * extension names nothing.
 *
 * Identity is the view AND its origin: a call is answered only from the
 * view's main frame while that frame is at `pistachio-ext://<id>/` — a load
 * main started itself (an address typed over the page, the agent's
 * navigate, a restore) fires no will-navigate, so the origin is read at every
 * call, and the entry is dropped the moment the view starts a navigation
 * anywhere else.
 *
 * - pages are tabs (BrowserController makes the view; `attach` maps it);
 * - the panel is a view main places over the side card's slot the shell
 *   reports (PanelHost, below);
 * - the worker is a view in a hidden window (./web-worker.ts).
 */

import { WebContentsView, type BrowserWindow, type WebContents } from "electron";
import { EXTENSION_SCHEME } from "@pistachio/shell-contracts/extensions";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";
import type { ExtContext } from "@pistachio/extension-api";

export interface ViewIdentity {
  extensionId: string;
  context: ExtContext;
  contents: WebContents;
  /**
   * The document made a subframe at some point in this view's life (an `about:blank` one: its CSP allows no other).
   * Another realm's intrinsics are reachable from then on — a `MediaStreamTrack.prototype.clone` the preload's guard
   * never saw — so the view's word on what it captures (`__pistachioLiveCaptures`) counts for nothing after (MEASURED,
   * Electron 43: such a clone stays live past the original's stop; main sees the frame in `frame-created`).
   */
  framed: boolean;
}

/** The part of an IPC event identity is read from. */
export interface CallerEvent {
  sender: { id: number; mainFrame: unknown };
  senderFrame: { url: string } | null;
}

export function extensionOrigin(extensionId: string): string {
  return `${EXTENSION_SCHEME}://${extensionId}/`;
}

/** Whether `url` is on the extension's own origin. */
export function onExtensionOrigin(extensionId: string, url: string): boolean {
  return url.startsWith(extensionOrigin(extensionId));
}

export interface ViewEvents {
  /** A view's console line or error (for the log and the status file). */
  console(identity: ViewIdentity, level: "debug" | "info" | "warn" | "error", message: string, file: string, line: number): void;
  /** A press or a key in one of the extension's views: a gesture on it. */
  gesture(identity: ViewIdentity): void;
  /** The entry went (the view closed, or left the origin): its subscriptions go with it. */
  dropped(contentsId: number, identity: ViewIdentity): void;
  /** The view's document is being replaced on its own origin (a reload, a link of its own): what the old one held goes, the identity stays. */
  renewed(contentsId: number, identity: ViewIdentity): void;
  /** The view made its first subframe: said once, for the log (`identity.framed` from now on). */
  framed?(identity: ViewIdentity): void;
}

export class ViewRegistry {
  readonly #views = new Map<number, ViewIdentity>();
  readonly #events: ViewEvents;

  constructor(events: ViewEvents) {
    this.#events = events;
  }

  /** Map a view main made to its extension and context. */
  register(contents: WebContents, extensionId: string, context: ExtContext): void {
    if (contents.isDestroyed()) return;
    const id = contents.id;
    if (this.#views.has(id)) {
      // (A woken page's view is a new contents; the same contents registered again is one already listened to.)
      this.#views.set(id, { extensionId, context, contents, framed: this.#views.get(id)?.framed ?? false });
      return;
    }
    const identity: ViewIdentity = { extensionId, context, contents, framed: false };
    this.#views.set(id, identity);
    const drop = (): void => {
      const known = this.#views.get(id);
      if (known === undefined) return;
      this.#views.delete(id);
      this.#events.dropped(id, known);
    };
    contents.on("did-start-navigation", (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      if (!onExtensionOrigin(extensionId, details.url)) {
        drop();
        return;
      }
      const known = this.#views.get(id);
      if (known !== undefined) this.#events.renewed(id, known);
    });
    contents.once("destroyed", drop);
    // Its renderer went (a crash, a kill) and the contents lives on: what the document held goes, as on a reload — the
    // keep-alives, the holds, the open writes, the subscriptions — and the identity stays for the page that comes back.
    contents.on("render-process-gone", () => {
      const known = this.#views.get(id);
      if (known !== undefined) this.#events.renewed(id, known);
    });
    contents.on("console-message", (event) => {
      const known = this.#views.get(id);
      if (known === undefined) return;
      this.#events.console(known, event.level === "warning" ? "warn" : event.level, event.message, event.sourceId, event.lineNumber);
    });
    contents.on("input-event", (_event, input) => {
      if (input.type !== "mouseDown" && input.type !== "keyDown") return;
      const known = this.#views.get(id);
      if (known !== undefined) this.#events.gesture(known);
    });
    // (A frame of the document's: sticky, a reload of the document included — only a new contents starts clean.)
    contents.on("frame-created", (_event, details) => {
      const known = this.#views.get(id);
      if (known === undefined || known.framed || details.frame === null || details.frame === contents.mainFrame) return;
      known.framed = true;
      this.#events.framed?.(known);
    });
  }

  /** Map again a view that came back to its origin after leaving it (a reload of its own page from elsewhere is not one). */
  get(contentsId: number): ViewIdentity | null {
    return this.#views.get(contentsId) ?? null;
  }

  isExtension(contentsId: number): boolean {
    return this.#views.has(contentsId);
  }

  /**
   * The caller of an IPC message, or null to refuse it: a view main made, its
   * main frame, at its extension's origin.
   */
  caller(event: CallerEvent): ViewIdentity | null {
    const identity = this.#views.get(event.sender.id);
    if (identity === undefined || identity.contents.isDestroyed()) return null;
    const frame = event.senderFrame;
    if (frame === null || frame !== event.sender.mainFrame) return null;
    let url: string;
    try {
      url = frame.url;
    } catch {
      return null;
    }
    return onExtensionOrigin(identity.extensionId, url) ? identity : null;
  }

  /** Every live view of an extension, of one context or all. */
  of(extensionId: string, context?: ExtContext): ViewIdentity[] {
    return [...this.#views.values()].filter((view) => view.extensionId === extensionId && (context === undefined || view.context === context) && !view.contents.isDestroyed());
  }

  forget(contentsId: number): void {
    const known = this.#views.get(contentsId);
    if (known === undefined) return;
    this.#views.delete(contentsId);
    this.#events.dropped(contentsId, known);
  }
}

/** The page name a view's address is, by its file (`pages` in the manifest), or null. */
export function pageNameOf(pages: Record<string, { file: string }> | undefined, extensionId: string, url: string): string | null {
  if (!onExtensionOrigin(extensionId, url)) return null;
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  for (const [name, page] of Object.entries(pages ?? {})) if (page.file === path) return name;
  return null;
}

/** How long a closed panel's view is kept before it is destroyed (§4, "The panel"). */
export const PANEL_KEEP_MS = 60_000;

export interface PanelHostOptions {
  window: BrowserWindow;
  /** Made: identity, key relay, console. */
  made(view: WebContentsView, extensionId: string): void;
  /** Whether a full-window veil is up in the shell (a sheet, ⌘L, Settings). */
  veiled(): boolean;
  /** Told after the view is placed, shown, hidden or raised (main's notch-cover check). */
  placed?: () => void;
}

/**
 * The panel: one extension's `panel` page in a view on the shell window, at
 * the bounds the shell reports for its side card's slot. The shell draws the
 * card and its head; main places the page in it, its height fitted to what
 * the page says it needs (`ui.preferredSize`), never past the slot.
 */
export class PanelHost {
  readonly #options: PanelHostOptions;
  #view: WebContentsView | null = null;
  #extensionId: string | null = null;
  #slot: ContentBounds | null = null;
  #preferredHeight: number | null = null;
  #destroyTimer: NodeJS.Timeout | null = null;

  constructor(options: PanelHostOptions) {
    this.#options = options;
  }

  get extensionId(): string | null {
    return this.#extensionId;
  }

  get contents(): WebContents | null {
    return this.#view === null || this.#view.webContents.isDestroyed() ? null : this.#view.webContents;
  }

  /** Whether the panel is in view: a view, in a slot of some size, with no veil over the window. */
  shown(): boolean {
    const slot = this.#slot;
    return this.contents !== null && slot !== null && slot.width >= 1 && slot.height >= 1 && !this.#options.veiled();
  }

  /** Make (or keep) the panel of `extensionId`, loading `url`; another extension's panel goes. */
  open(extensionId: string, url: string, partition: string, preload: string): void {
    if (this.#destroyTimer !== null) clearTimeout(this.#destroyTimer);
    this.#destroyTimer = null;
    if (this.#view !== null && this.#extensionId === extensionId && !this.#view.webContents.isDestroyed()) return;
    this.destroy();
    const view = new WebContentsView({
      webPreferences: {
        partition,
        preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        spellcheck: false,
        webviewTag: false,
        backgroundThrottling: true,
      },
    });
    view.setBackgroundColor("#00000000");
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event, target) => {
      if (!onExtensionOrigin(extensionId, target)) event.preventDefault();
    });
    view.webContents.on("will-redirect", (event) => {
      if (!onExtensionOrigin(extensionId, event.url)) event.preventDefault();
    });
    this.#view = view;
    this.#extensionId = extensionId;
    this.#preferredHeight = null;
    this.#options.window.contentView.addChildView(view);
    this.#options.made(view, extensionId);
    void view.webContents.loadURL(url).catch(() => undefined);
    this.#apply();
  }

  /** The slot the shell reports (null: the card is closed). */
  setSlot(slot: ContentBounds | null): void {
    this.#slot = slot;
    this.#apply();
  }

  /** The page's own height, from `ui.preferredSize`. */
  setPreferredHeight(height: number): void {
    this.#preferredHeight = height > 0 ? Math.ceil(height) : null;
    this.#apply();
  }

  /** Hidden at once; the view (and its page's state) kept a minute, in case it opens again. */
  close(): void {
    this.#slot = null;
    this.#apply();
    if (this.#view === null || this.#destroyTimer !== null) return;
    this.#destroyTimer = setTimeout(() => {
      this.#destroyTimer = null;
      this.destroy();
    }, PANEL_KEEP_MS);
    this.#destroyTimer.unref();
  }

  /** Re-add to the window: a view added later would stack over it. */
  raise(): void {
    const view = this.#view;
    if (view === null || this.#options.window.isDestroyed() || !view.getVisible()) return;
    this.#options.window.contentView.addChildView(view);
    this.#options.placed?.();
  }

  /** The veil came or went. */
  reveil(): void {
    this.#apply();
  }

  reload(): void {
    const contents = this.contents;
    if (contents !== null) contents.reload();
  }

  destroy(): void {
    if (this.#destroyTimer !== null) clearTimeout(this.#destroyTimer);
    this.#destroyTimer = null;
    const view = this.#view;
    this.#view = null;
    this.#extensionId = null;
    if (view === null) return;
    if (!this.#options.window.isDestroyed()) this.#options.window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
    this.#options.placed?.();
  }

  #apply(): void {
    const view = this.#view;
    if (view === null) return;
    const slot = this.#slot;
    const shown = slot !== null && slot.width >= 1 && slot.height >= 1 && !this.#options.veiled();
    if (slot !== null && slot.width >= 1 && slot.height >= 1) {
      const height = this.#preferredHeight === null ? slot.height : Math.max(1, Math.min(slot.height, this.#preferredHeight));
      view.setBounds({ x: Math.round(slot.x), y: Math.round(slot.y), width: Math.max(1, Math.round(slot.width)), height: Math.round(height) });
    }
    const was = view.getVisible();
    view.setVisible(shown);
    if (shown && !was) this.#options.window.contentView.addChildView(view);
    this.#options.placed?.();
  }
}
