import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, net, screen, session } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import { IPC } from "@pistachio/shell-contracts/ipc";
import type { LiveHostEvent } from "@pistachio/shell-contracts/live-share";

/**
 * The live share's host window (docs/live-share.md §6.1): a transparent child
 * window exactly over the browser window's content, where LiveHostApp holds
 * the room and draws what must lie over the native page views — the guests'
 * pointers, ink, faces, the Live pill. A WebContentsView cannot let the
 * pointer through, a window can: this one ignores the mouse (forwarding its
 * moves, so the app sees the pointer come onto its own controls) except
 * while the app says the pointer is on one, or while the host draws — then
 * it takes the pointer, and the keyboard so Escape reaches it, and gives the
 * keyboard back to the browser's window after.
 *
 * Its session is its own (`live-host`, in memory, made with the first share):
 * it grants the camera and the microphone to this window's page and to
 * nothing else, and its WebRTC runs on the default policy rather than the
 * proxied-UDP-only one every other page gets (that would push the room onto
 * TCP relays) — set here, after `web-contents-created` gave it that one.
 *
 * Its page reads what strangers send — guests' packets, names and chat come
 * through livekit-client — so it is sandboxed, and its preload is its own
 * (preload/live-host.ts): the room's five members and the theme's
 * appearance, never the shell's API, and each answers this window alone.
 *
 * Its page is the renderer's `live-host.html`, not the shell's index.html:
 * the same bundle, under a policy that lets it compile WebAssembly (the host
 * camera's background runs MediaPipe's segmenter). Packaged, it is served to
 * this session from an origin of its own, `pistachio-app://live-host`, not
 * loaded from `file://` — the segmenter fetches its WASM and model, and
 * Chromium's fetch refuses file URLs.
 */

const PARTITION = "live-host";
/** The scheme main registers as privileged (standard, secure, fetchable) for the shell; here, this session's own handler. */
const SCHEME = "pistachio-app";
const HOST = "live-host";
const PAGE = "live-host.html";

export interface LiveHostWindowOptions {
  parent: BrowserWindow;
  /** The live-host preload (preload/live-host.ts), not the shell's. */
  preload: string;
  /** The dev server's URL, when the renderer comes from one. */
  rendererUrl: string | undefined;
  /** The built renderer's index.html: live-host.html lies beside it. */
  rendererFile: string;
  /** The window went without being asked (its renderer died): the share cannot go on without it. */
  onGone: () => void;
}

export class LiveHostWindow {
  readonly #parent: BrowserWindow;
  readonly #window: BrowserWindow;
  readonly #unfollow: () => void;
  #interactive = false;
  #drawing = false;
  #closing = false;

  constructor(options: LiveHostWindowOptions) {
    const { parent } = options;
    this.#parent = parent;
    const window = new BrowserWindow({
      parent,
      ...parent.getContentBounds(),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // A press on the pill or a face, the browser's window in front: the app's, not a click that only brings this window up.
      acceptFirstMouse: true,
      webPreferences: {
        partition: PARTITION,
        preload: options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The room keeps publishing while the window is covered or the app is in the background.
        backgroundThrottling: false,
        // Guests' voices play as they come: nobody presses anything in this window first.
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    this.#window = window;
    window.excludedFromShownWindowsMenu = true;
    window.setIgnoreMouseEvents(true, { forward: true });
    const contents = window.webContents;
    // (Set after web-contents-created gave every page the proxied-only policy: this one is the room's.)
    contents.setWebRTCIPHandlingPolicy("default");
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("render-process-gone", () => {
      if (!this.#closing) options.onGone();
    });
    grantMediaTo(contents);
    this.#unfollow = this.#follow();
    void loadPage(contents, options.rendererUrl, options.rendererFile);
    if (parent.isVisible() && !parent.isMinimized()) window.showInactive();
  }

  /** A message came from this window's page. */
  owns(sender: Electron.WebContents): boolean {
    return !this.#window.isDestroyed() && sender.id === this.#window.webContents.id;
  }

  send(event: LiveHostEvent): void {
    if (!this.#window.isDestroyed() && !this.#window.webContents.isDestroyed()) this.#window.webContents.send(IPC.liveHostEvent, event);
  }

  /** The pointer is on one of the app's controls: the window takes it while it is. */
  setInteractive(active: boolean): void {
    if (active === this.#interactive) return;
    this.#interactive = active;
    this.#applyPointer();
  }

  /** The host draws over the desk: the window takes the pointer and the keyboard, and gives the keyboard back after. */
  setDrawing(drawing: boolean): void {
    if (drawing === this.#drawing || this.#window.isDestroyed()) return;
    this.#drawing = drawing;
    this.#window.setFocusable(drawing);
    this.#applyPointer();
    if (drawing) {
      this.#window.focus();
      return;
    }
    if (!this.#parent.isDestroyed()) this.#parent.focus();
  }

  destroy(): void {
    this.#closing = true;
    this.#unfollow();
    if (!this.#window.isDestroyed()) this.#window.destroy();
  }

  #applyPointer(): void {
    if (this.#window.isDestroyed()) return;
    if (this.#drawing || this.#interactive) this.#window.setIgnoreMouseEvents(false);
    else this.#window.setIgnoreMouseEvents(true, { forward: true });
  }

  /** Over the parent's content box wherever it goes; down while the parent is minimized or hidden. */
  #follow(): () => void {
    const parent = this.#parent;
    const window = this.#window;
    const place = (): void => {
      if (parent.isDestroyed() || window.isDestroyed()) return;
      window.setBounds(parent.getContentBounds());
      const up = parent.isVisible() && !parent.isMinimized();
      if (up && !window.isVisible()) window.showInactive();
      else if (!up && window.isVisible()) window.hide();
    };
    const events = ["resize", "move", "enter-full-screen", "leave-full-screen", "maximize", "unmaximize", "minimize", "restore", "show", "hide"] as const;
    for (const event of events) parent.on(event as "resize", place);
    screen.on("display-metrics-changed", place);
    return () => {
      for (const event of events) parent.off(event as "resize", place);
      screen.off("display-metrics-changed", place);
    };
  }
}

/** The live-host page: from the dev server, or packaged from this session's own origin over the renderer's folder. */
async function loadPage(contents: Electron.WebContents, rendererUrl: string | undefined, rendererFile: string): Promise<void> {
  const page = `${PAGE}${CHROME_VIEW_HASHES["live-host"]}`;
  if (rendererUrl !== undefined) {
    await contents.loadURL(new URL(page, rendererUrl).href);
    return;
  }
  serveRenderer(dirname(rendererFile));
  await contents.loadURL(`${SCHEME}://${HOST}/${page}`);
}

/** `pistachio-app://live-host/<path>` is `<root>/<path>` (the built renderer: the page, its chunks, the segmenter's files), and nothing outside it. */
function serveRenderer(root: string): void {
  const target = session.fromPartition(PARTITION);
  if (target.protocol.isProtocolHandled(SCHEME)) return;
  target.protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    const file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    const path = relative(root, file);
    if (url.hostname !== HOST || path === "" || path.startsWith("..") || isAbsolute(path)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
}

/** The live-host session lets this one page use the camera and the microphone (and capture the tabs main hands it); nothing else. */
function grantMediaTo(contents: Electron.WebContents): void {
  const target = session.fromPartition(PARTITION);
  target.setPermissionRequestHandler((requester, permission, callback) => {
    callback(permission === "media" && !contents.isDestroyed() && requester.id === contents.id);
  });
  target.setPermissionCheckHandler((requester, permission) => permission === "media" && requester !== null && !contents.isDestroyed() && requester.id === contents.id);
}
