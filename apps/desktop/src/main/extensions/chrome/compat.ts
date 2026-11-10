/**
 * Chrome extensions in a Profile session (docs/extensions.md §4 "Chrome extensions", X10, §6.5): one
 * `ElectronChromeExtensions` per Profile session, the Web Store's *Add to Chrome* turned into a request for
 * Pistachio's own sheet, and the action API answered in-process for the Ledge. This folder is the only one that
 * touches electron-chrome-extensions and electron-chrome-web-store (both pinned and patched, patches/README.md).
 *
 * The libraries are imported lazily by `loadChromeCompat()`, after `app.whenReady()`: electron-chrome-extensions
 * calls `protocol.registerSchemesAsPrivileged` for `crx` when it is imported before ready, and Electron allows one
 * such call per process — index.ts makes it, `crx` (bypassCSP) included. Nothing here imports them at the top.
 *
 * What the host (BrowserController, through `ChromeCompatHooks`) owns: every tab the libraries make, show, close or
 * navigate goes through its hooks and its guards. What this class owns: which sessions have the libraries, the
 * guard against the libraries selecting or closing tabs while the host is telling them about its own (`#quiet`),
 * pop-ups' links (always a tab of the host's), permission requests (only what the manifest declared), notifications
 * as notices, and action state for the Ledge.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { session as electronSession, type BaseWindow, type BrowserWindow, type ContextMenuParams, type Extension, type MenuItem, type Session, type WebContents } from "electron";
import type { ChromeExtensionOptions, ElectronChromeExtensions } from "electron-chrome-extensions";
import { chromeActionStates, chromeIconUrl, isChromeExtensionId, noticeText, type ChromeActionState, type ChromeNotificationOptions, type RawActionState } from "./actions";
import { chromePatternCovers, type ChromeManifest } from "./verdict";

/** What an extension asked a tab to be (`chrome.tabs.create`, `windows.create`, `runtime.openOptionsPage`). */
export interface ChromeTabRequest {
  url?: string;
  /** Show it (the default); false opens it behind. */
  active?: boolean;
  /** `windows.create`: Pistachio opens a tab — a `popup` window too (an OS window would leave the desk). */
  fromWindowsCreate?: boolean;
}

/** The host's side of the glue: BrowserController's tab life, its guards, and its window. */
export interface ChromeCompatHooks {
  /**
   * A tab in the Profile's current space, shown unless `active` is false; answers its contents and the window it
   * lives in. The host calls `addTab` for it as for any tab (the library also tracks it at once).
   */
  createTab(details: ChromeTabRequest, profileId: string): Promise<[WebContents, BaseWindow]>;
  /** An extension chose a tab (`tabs.update({ active: true })`): show it. Never called for the host's own choices. */
  selectTab(tab: WebContents): void;
  /** An extension closed a tab (`tabs.remove`): close it. Never called for the host's own closes. */
  removeTab(tab: WebContents): void;
  /** `tabs.update({ url })`: navigate through the host's own guards (the library refuses Pistachio's schemes first). */
  navigateTab(tab: WebContents, url: string): Promise<void>;
  /**
   * `permissions.request`, already narrowed to what the manifest declared (required or optional). Answer false to
   * refuse (the host grants within the approved sheet alone).
   */
  requestPermissions(extension: Extension, request: { permissions: string[]; origins: string[] }, profileId: string): Promise<boolean>;
  /** The window tabs live in, or null while there is none. */
  window(): BaseWindow | null;
}

/** A `chrome.notifications` card, for the host to show as a notice. */
export interface ChromeNotice {
  profileId: string;
  extensionId: string;
  extensionName: string;
  /** The extension's own id for it (what `onClicked`/`onClosed` name). */
  id: string;
  title: string;
  body: string;
  iconUrl: string;
  requireInteraction: boolean;
  /** The person clicked it: the extension hears `notifications.onClicked`. */
  click(): void;
  /** It went away: the extension hears `notifications.onClosed`. */
  closed(byUser: boolean): void;
}

export interface ChromeNoticeHandler {
  show(notice: ChromeNotice): void;
  /** The extension cleared one (`notifications.clear`). */
  clear?(key: { profileId: string; extensionId: string; id: string }): void;
}

export interface ChromeInstallRequest {
  cwsId: string;
  profileId: string;
  /** The store page's name for it: words for a toast, never the sheet (that reads the downloaded manifest). */
  name: string;
}

export interface ChromeActivation {
  extensionId: string;
  /** The tab it acts on (the Profile's tab in use); null: the library's active tab. */
  tab: WebContents | null;
  /** The Ledge icon's rect in the window's content coordinates; the popup opens under it. */
  anchorRect: { x: number; y: number; width: number; height: number };
  /** "top" opens above the anchor, "right" aligns its leading edge; the default hangs it below, trailing-aligned. */
  alignment?: string;
}

export interface ChromeLibraries {
  ece: typeof import("electron-chrome-extensions");
  ws: typeof import("electron-chrome-web-store");
}

export interface ChromeCompatOptions {
  /** `<userData>/Extensions/chrome` (docs/extensions.md §7). */
  extensionsPath: string;
}

type ChromeImpl = Omit<ChromeExtensionOptions, "session" | "modulePath">;

interface ActionObserver {
  isDestroyed(): boolean;
  send(channel: string): void;
}

/**
 * electron-chrome-extensions 4.10.0's private members this glue reaches — re-checked against its dist on every
 * upgrade (patches/README.md). `api` and `ctx` are private in its types; the action API has no public door from main
 * (its handlers answer IPC from a renderer's `<browser-action-list>`, a channel Pistachio's patch removed).
 */
interface EceInternals {
  ctx: {
    store: { impl: ChromeImpl; windows: Set<BaseWindow>; addWindow(window: BaseWindow): void };
    router: {
      apiHandler(): (name: string, callback: (event: { extension: Extension }, ...args: unknown[]) => unknown, opts?: { permission?: string }) => void;
      sendEvent(extensionId: string, eventName: string, ...args: unknown[]): void;
    };
  };
  api: {
    browserAction: {
      getState(): RawActionState;
      activateClick(details: { extensionId: string; tabId: number; anchorRect: ChromeActivation["anchorRect"]; alignment?: string }): void;
      handleCRXRequest(request: Request): Response;
      observers: Set<ActionObserver>;
    };
  };
}

const internals = (ece: ElectronChromeExtensions): EceInternals => ece as unknown as EceInternals;

/** electron-chrome-extensions' PopupView, the part the glue drives (`browser-action-popup-created` hands it over). */
interface PopupViewLike {
  extensionId: string;
  browserWindow?: BrowserWindow;
  hidden: boolean;
  isDestroyed(): boolean;
  whenReady(): Promise<void>;
  setSize(size: { width: number; height: number }): void;
  updatePosition(): void;
  show(): void;
}

/** An isolated world of the popup's page, for measuring it (the page's own globals never answer). */
const POPUP_MEASURE_WORLD = 1_017;

/**
 * Resolves with the popup page's natural size — its `max-content` width (≤ 800, PopupView's bound) and its height at
 * that width — once it differs from `last`; with `last` after a while unchanged (the loop asks again).
 */
function popupSizeScript(last: { width: number; height: number }): string {
  return `new Promise((resolve) => {
    const last = ${JSON.stringify(last)};
    const measure = () => {
      const html = document.documentElement;
      const before = html.style.width;
      html.style.width = "max-content";
      const width = Math.min(800, Math.max(25, Math.ceil(html.getBoundingClientRect().width)));
      html.style.width = width + "px";
      // The root's own box, not scrollHeight: that is at least the viewport, so a popup whose content shrank would
      // never shrink with it (Chrome's popups do).
      const height = Math.max(25, Math.ceil(html.getBoundingClientRect().height));
      html.style.width = before;
      return { width, height };
    };
    const target = document.body ?? document.documentElement;
    let done = false;
    let timer = 0;
    const finish = (size) => {
      if (done) return;
      done = true;
      resize.disconnect();
      mutation.disconnect();
      clearTimeout(timer);
      resolve(size);
    };
    const check = () => {
      const size = measure();
      if (size.width !== last.width || size.height !== last.height) finish(size);
    };
    const resize = new ResizeObserver(check);
    const mutation = new MutationObserver(check);
    resize.observe(target);
    mutation.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(() => finish(last), 30000);
    check();
  })`;
}

/**
 * Size, place and show a popup by its page's natural size, and keep it so as its page changes. PopupView waits for
 * `preferred-size-changed`, which Electron 43 never emits for it (measured 2026-10-30: the popup stayed 25×25 and
 * hidden; the panel card's own preferred-size mode proved unreliable too, docs/extensions.md §4) — so its page is
 * measured here instead, and PopupView's own `setSize`/`updatePosition`/`show` do the rest, its look untouched (X10).
 */
async function fitPopup(popup: PopupViewLike): Promise<void> {
  try {
    await popup.whenReady();
  } catch {
    return;
  }
  let last = { width: 0, height: 0 };
  while (!popup.isDestroyed()) {
    const contents = popup.browserWindow?.webContents;
    if (contents === undefined || contents.isDestroyed()) return;
    let size: unknown;
    try {
      size = await contents.executeJavaScriptInIsolatedWorld(POPUP_MEASURE_WORLD, [{ code: popupSizeScript(last) }]);
    } catch {
      return;
    }
    if (popup.isDestroyed()) return;
    const { width, height } = (size ?? {}) as { width?: unknown; height?: unknown };
    if (typeof width !== "number" || typeof height !== "number") return;
    if (width === last.width && height === last.height) continue;
    last = { width, height };
    popup.setSize(last);
    popup.updatePosition();
    if (popup.hidden) popup.show();
  }
}

interface Attached {
  profileId: string;
  partition: string;
  ece: ElectronChromeExtensions;
}

interface ChromeCompatEvents {
  "install-requested": [ChromeInstallRequest];
  "actions-changed": [profileId: string];
  /** A popup opened (ECE's child window at the icon): the host may watch it, never restyle it (X10). */
  popup: [{ profileId: string; extensionId: string; window: BrowserWindow }];
}

export class ChromeCompat extends EventEmitter<ChromeCompatEvents> {
  readonly #hooks: ChromeCompatHooks;
  readonly #libs: ChromeLibraries;
  readonly #extensionsPath: string;
  readonly #attached = new Map<Session, Attached>();
  readonly #partitions = new Map<string, Session>();
  /** Inside a call where the host tells the library about its own tabs: the library's echo is not an extension's choice. */
  #quiet = 0;
  #notices: ChromeNoticeHandler | null = null;

  /** Use `loadChromeCompat()`, which imports the libraries after ready. */
  constructor(hooks: ChromeCompatHooks, libs: ChromeLibraries, options: ChromeCompatOptions) {
    super();
    this.#hooks = hooks;
    this.#libs = libs;
    this.#extensionsPath = options.extensionsPath;
    // `?partition=` in a crx:// icon address names only a session attached here; anything else resolves to none
    // (the library's default would create a session for any name it is handed).
    libs.ece.setSessionPartitionResolver((partition) => this.#partitions.get(partition) as Session);
  }

  /**
   * Give a Profile session Chrome extensions and the Web Store's install button. Idempotent. Loads no extension:
   * the registry calls `loadExtension` for each one that is on in this Profile.
   */
  async attachSession(ses: Session, profileId: string, partition: string): Promise<void> {
    if (this.#attached.has(ses)) return;
    const { ElectronChromeExtensions } = this.#libs.ece;
    const impl = this.#impl(ses, profileId);
    let ece = ElectronChromeExtensions.fromSession(ses);
    if (ece === undefined) {
      ece = new ElectronChromeExtensions({ session: ses, ...impl });
    } else {
      // A session outlives a controller (a window closed and reopened): the instance stays, its hooks are ours now.
      internals(ece).ctx.store.impl = impl;
    }
    const attached: Attached = { profileId, partition, ece };
    this.#attached.set(ses, attached);
    this.#partitions.set(partition, ses);

    // The Ledge hears every change to an action (badge, title, icon, popup, load, unload, the active tab) as an
    // observer would — the library sends observers `browserAction.update`, coalesced per microtask.
    internals(ece).api.browserAction.observers.add({
      isDestroyed: () => !this.#attached.has(ses),
      send: (channel) => {
        if (channel === "browserAction.update") this.emit("actions-changed", profileId);
      },
    });
    ece.on("browser-action-popup-created", (popup: PopupViewLike) => {
      if (popup.browserWindow === undefined || popup.browserWindow.isDestroyed()) return;
      this.#guardPopup(popup.browserWindow, popup.extensionId, profileId);
      void fitPopup(popup);
      this.emit("popup", { profileId, extensionId: popup.extensionId, window: popup.browserWindow });
    });
    if (this.#notices !== null) this.#routeNotifications(attached);

    await this.#libs.ws.installChromeWebStore({
      session: ses,
      extensionsPath: this.#extensionsPath,
      loadExtensions: false,
      autoUpdate: false,
      // The page's *Add to Chrome* only hands over the id: the sheet is built from the manifest Pistachio downloads.
      beforeInstall: async (details) => {
        if (isChromeExtensionId(details.id)) {
          this.emit("install-requested", { cwsId: details.id, profileId, name: String(details.localizedName ?? "").slice(0, 80) });
        }
        return { action: "deny" };
      },
    });
  }

  isAttached(ses: Session): boolean {
    return this.#attached.has(ses);
  }

  /** Load an approved extension's folder into a Profile session (MV3 workers start on their own). */
  async loadExtension(ses: Session, path: string): Promise<Extension> {
    this.#require(ses);
    return ses.extensions.loadExtension(path, { allowFileAccess: false });
  }

  unload(ses: Session, extensionId: string): void {
    if (ses.extensions.getExtension(extensionId) !== null) ses.extensions.removeExtension(extensionId);
  }

  /**
   * A tab of the host's (a person's tab — never a hidden agent tab, Glance, sign-in pop-up, extension page of
   * Pistachio's or app surface), in `window` (default: the hooks' window).
   */
  addTab(ses: Session, tab: WebContents, window: BaseWindow | null = this.#hooks.window()): void {
    const attached = this.#attached.get(ses);
    if (attached === undefined || window === null || window.isDestroyed() || tab.isDestroyed() || tab.session !== ses) return;
    this.#quietly(() => attached.ece.addTab(tab, window));
  }

  removeTab(ses: Session, tab: WebContents): void {
    const attached = this.#attached.get(ses);
    if (attached === undefined || tab.isDestroyed()) return;
    this.#quietly(() => attached.ece.removeTab(tab));
  }

  /** The host showed a tab: extensions hear `tabs.onActivated`; the action state follows it. */
  selectTab(ses: Session, tab: WebContents): void {
    const attached = this.#attached.get(ses);
    if (attached === undefined || tab.isDestroyed()) return;
    this.#quietly(() => attached.ece.selectTab(tab));
  }

  /** The extensions' items for a page's context menu (appended by the host, grouped under each extension's name). */
  contextMenuItems(ses: Session, tab: WebContents, params: ContextMenuParams): MenuItem[] {
    const attached = this.#attached.get(ses);
    if (attached === undefined || tab.isDestroyed() || tab.session !== ses) return [];
    return attached.ece.getContextMenuItems(tab, params);
  }

  /** Every action in a Profile session as the Ledge draws it, on `tab` (default: the library's active tab). */
  async actions(ses: Session, tab: WebContents | null = null): Promise<ChromeActionState[]> {
    const attached = this.#attached.get(ses);
    if (attached === undefined) return [];
    const raw = internals(attached.ece).api.browserAction.getState();
    return chromeActionStates(raw, attached.partition, tab !== null && !tab.isDestroyed() ? tab.id : (raw.activeTabId ?? null));
  }

  /**
   * The Ledge icon was clicked: the extension's popup opens at the icon (a click on the same icon while its popup is
   * open closes it), or, with none, it hears `action.onClicked` with the tab.
   */
  activate(ses: Session, activation: ChromeActivation): void {
    const attached = this.#require(ses);
    if (!isChromeExtensionId(activation.extensionId) || ses.extensions.getExtension(activation.extensionId) === null) {
      throw new Error(`No Chrome extension ${String(activation.extensionId).slice(0, 64)} in this Profile`);
    }
    // (Never -1: the library's activateClick would take its last active tab for it — a page the click was not made on.)
    if (activation.tab === null || activation.tab.isDestroyed()) throw new Error("A Chrome extension's action runs on the web page in use; none is.");
    const tabId = activation.tab.id;
    internals(attached.ece).api.browserAction.activateClick({
      extensionId: activation.extensionId,
      tabId,
      anchorRect: activation.anchorRect,
      ...(activation.alignment === undefined ? {} : { alignment: activation.alignment }),
    });
  }

  onActionsChanged(listener: (profileId: string) => void): () => void {
    this.on("actions-changed", listener);
    return () => this.off("actions-changed", listener);
  }

  /** Serve `crx://extension-icon/…` on the session that draws the Ledge (the shell's: the default session). */
  handleCRXProtocol(ses: Session = electronSession.defaultSession): void {
    this.#libs.ece.ElectronChromeExtensions.handleCRXProtocol(ses);
  }

  /**
   * Answer a `crx://extension-icon/…?partition=…` request as `handleCRXProtocol` would, for a handler registered
   * before the libraries were imported: Electron binds a page's protocol handlers when the page commits, so the
   * shell — up long before a Chrome extension is — keeps the `crx` handler main gave the default session at launch,
   * which forwards here. Only an attached session's partition answers.
   */
  crxResponse(request: Request): Response {
    let partition: string | null = null;
    try {
      partition = new URL(request.url).searchParams.get("partition");
    } catch {
      partition = null;
    }
    const ses = partition === null ? undefined : this.#partitions.get(partition);
    const attached = ses === undefined ? undefined : this.#attached.get(ses);
    if (attached === undefined) return new Response(null, { status: 404 });
    return internals(attached.ece).api.browserAction.handleCRXRequest(request);
  }

  /**
   * `chrome.notifications` become the host's notices instead of the library's macOS notifications, in every
   * attached session and every one attached later. The library's handlers are replaced for good: the returned
   * function stops the cards (`create` still answers its id), it never brings the macOS notifications back.
   */
  notificationsToNotices(handler: ChromeNoticeHandler): () => void {
    this.#notices = handler;
    for (const attached of this.#attached.values()) this.#routeNotifications(attached);
    return () => {
      if (this.#notices === handler) this.#notices = null;
    };
  }

  #routeNotifications(attached: Attached): void {
    const router = internals(attached.ece).ctx.router;
    const handle = router.apiHandler();
    const { profileId, partition } = attached;
    // Chrome's rule, which the library skipped: no `notifications` permission, no notifications.
    const needs = { permission: "notifications" };
    handle("notifications.create", async ({ extension }, first, second) => {
      const id = typeof first === "string" && first !== "" ? first.slice(0, 256) : randomUUID();
      const options = (typeof first === "string" ? second : first) as ChromeNotificationOptions | undefined;
      if (options === null || typeof options !== "object" || typeof options.title !== "string") throw new Error("Missing required notification options");
      const { title, body } = noticeText(options);
      let open = true;
      this.#notices?.show({
        profileId,
        extensionId: extension.id,
        extensionName: extension.name,
        id,
        title,
        body,
        iconUrl: chromeIconUrl(extension.id, partition),
        requireInteraction: options.requireInteraction === true,
        click: () => {
          if (open) router.sendEvent(extension.id, "notifications.onClicked", id);
        },
        closed: (byUser) => {
          if (!open) return;
          open = false;
          router.sendEvent(extension.id, "notifications.onClosed", id, byUser);
        },
      });
      return id;
    }, needs);
    handle("notifications.clear", ({ extension }, id) => {
      if (typeof id !== "string") return false;
      this.#notices?.clear?.({ profileId, extensionId: extension.id, id });
      return true;
    }, needs);
  }

  #impl(ses: Session, profileId: string): ChromeImpl {
    return {
      createTab: async (details) => this.#hooks.createTab({ ...(typeof details.url === "string" ? { url: details.url } : {}), active: details.active !== false }, profileId),
      selectTab: (tab) => {
        if (this.#quiet === 0 && !tab.isDestroyed()) this.#hooks.selectTab(tab);
      },
      removeTab: (tab) => {
        if (this.#quiet === 0 && !tab.isDestroyed()) this.#hooks.removeTab(tab);
      },
      navigateTab: (tab, url) => this.#hooks.navigateTab(tab, url),
      createWindow: async (details) => {
        const url = Array.isArray(details.url) ? details.url[0] : details.url;
        const [, window] = await this.#hooks.createTab({ ...(typeof url === "string" ? { url } : {}), active: details.focused !== false, fromWindowsCreate: true }, profileId);
        return window;
      },
      // `windows.remove` never closes Pistachio's window. The library forgot the window before asking; it is put back
      // so the Profile keeps a current window (each put-back adds the library's window listeners once more).
      removeWindow: (window) => {
        queueMicrotask(() => {
          const attached = this.#attached.get(ses);
          if (attached !== undefined && !window.isDestroyed() && !internals(attached.ece).ctx.store.windows.has(window)) {
            internals(attached.ece).ctx.store.addWindow(window);
          }
        });
      },
      requestPermissions: async (extension, request) => this.#requestPermissions(extension, request as { permissions?: unknown; origins?: unknown }, profileId),
    };
  }

  /** Only what the manifest declared, required or optional (the library checks permissions, never origins). */
  async #requestPermissions(extension: Extension, request: { permissions?: unknown; origins?: unknown }, profileId: string): Promise<boolean> {
    const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
    const manifest = extension.manifest as ChromeManifest;
    const declared = [...strings(manifest.host_permissions), ...strings(manifest.optional_host_permissions), ...strings(manifest.permissions), ...strings(manifest.optional_permissions)].filter(
      (p) => p === "<all_urls>" || p.includes("://"),
    );
    const origins = strings(request.origins);
    if (origins.some((origin) => !declared.some((pattern) => chromePatternCovers(pattern, origin)))) return false;
    return this.#hooks.requestPermissions(extension, { permissions: strings(request.permissions), origins }, profileId);
  }

  /** A popup's links open as the host's tabs; it never navigates off its own extension. */
  #guardPopup(window: BrowserWindow, extensionId: string, profileId: string): void {
    const contents = window.webContents;
    const own = `chrome-extension://${extensionId}/`;
    contents.setWindowOpenHandler(({ url }) => {
      void this.#hooks.createTab({ url, active: true }, profileId).catch(() => undefined);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (url.startsWith(own)) return;
      event.preventDefault();
      void this.#hooks.createTab({ url, active: true }, profileId).catch(() => undefined);
    });
  }

  #quietly(run: () => void): void {
    this.#quiet += 1;
    try {
      run();
    } finally {
      this.#quiet -= 1;
    }
  }

  #require(ses: Session): Attached {
    const attached = this.#attached.get(ses);
    if (attached === undefined) throw new Error("Chrome extensions aren't attached to this session");
    return attached;
  }
}

/** Import the libraries (after `app.whenReady()`) and make the glue. */
export async function loadChromeCompat(hooks: ChromeCompatHooks, options: ChromeCompatOptions): Promise<ChromeCompat> {
  const [ece, ws] = await Promise.all([import("electron-chrome-extensions"), import("electron-chrome-web-store")]);
  return new ChromeCompat(hooks, { ece, ws }, options);
}
