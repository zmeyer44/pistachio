/**
 * One Chromium per runner process (docs/cloud-sync-design.md §8.1). Every
 * context sets its own proxy (`per-context`), QUIC is off, and WebRTC may
 * not leak a non-proxied UDP path.
 */

import { chromium, type Browser, type CDPSession } from "playwright-core";

export const CHROMIUM_LAUNCH_ARGS: readonly string[] = [
  "--disable-quic",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-dev-shm-usage",
];

/**
 * `per-context` (production): every context names its own gateway proxy and a
 * context without one cannot reach the network. `direct`: the browser has no
 * proxy at all and contexts must not set one (development without a gateway,
 * and the local test suites).
 */
export type ProxyMode = "per-context" | "direct";

export interface PlaywrightBrowserRuntimeOptions {
  executablePath?: string;
  headless?: boolean;
  proxyMode?: ProxyMode;
  /** Test seam; production always uses Playwright's Chromium launcher. */
  launch?: () => Promise<Browser>;
}

export class PlaywrightBrowserRuntime {
  readonly #options: PlaywrightBrowserRuntimeOptions;
  #browserPromise: Promise<Browser> | null = null;
  #cdp: { browser: Browser; session: Promise<CDPSession> } | null = null;
  #current: Browser | null = null;
  readonly #disconnectListeners = new Set<() => void>();

  constructor(options: PlaywrightBrowserRuntimeOptions = {}) {
    this.#options = options;
  }

  get proxyMode(): ProxyMode {
    return this.#options.proxyMode ?? "per-context";
  }

  /**
   * Whether the launched Chromium is still attached: `null` before the first
   * launch, `false` once it exited or the CDP socket dropped. The health
   * endpoint reports this; a Node process that answers while its browser is
   * gone is not healthy.
   */
  isConnected(): boolean | null {
    if (this.#current === null) return null;
    return typeof this.#current.isConnected !== "function" || this.#current.isConnected();
  }

  /**
   * The launched Chromium's version string, or "" before the first launch.
   * `getAppInfo` on a shell host reports it where the desktop reports
   * Electron's (web-browser-design.md §6.3).
   */
  version(): string {
    return this.#current === null ? "" : this.#current.version();
  }

  /**
   * Called once each time a launched Chromium goes away. Runs that hold a
   * page in it can never finish their current tool; the executor fails them
   * so they do not sit `running` behind a lease that keeps being renewed.
   */
  onDisconnected(listener: () => void): () => void {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  async browser(): Promise<Browser> {
    if (this.#browserPromise !== null) {
      const current = await this.#browserPromise;
      if (typeof current.isConnected !== "function" || current.isConnected()) return current;
      this.#browserPromise = null;
      this.#cdp = null;
      this.#current = null;
    }
    this.#browserPromise ??= (
      this.#options.launch?.() ??
      chromium.launch({
        executablePath: this.#options.executablePath,
        headless: this.#options.headless ?? true,
        ...(this.proxyMode === "per-context" ? { proxy: { server: "per-context" } } : {}),
        args: [...CHROMIUM_LAUNCH_ARGS],
      })
    )
      .then((browser) => {
        this.#current = browser;
        if (typeof browser.on === "function") {
          browser.on("disconnected", () => {
            if (this.#current !== browser) return;
            this.#current = null;
            this.#browserPromise = null;
            this.#cdp = null;
            for (const listener of [...this.#disconnectListeners]) listener();
          });
        }
        return browser;
      })
      .catch((error: unknown) => {
        this.#browserPromise = null;
        throw error;
      });
    return this.#browserPromise;
  }

  /** The one browser-level CDP session per runner (raw cookie reads, §8.3). */
  async cdp(): Promise<CDPSession> {
    const browser = await this.browser();
    if (this.#cdp === null || this.#cdp.browser !== browser) {
      const session = browser.newBrowserCDPSession();
      this.#cdp = { browser, session };
      session.catch(() => {
        if (this.#cdp?.session === session) this.#cdp = null;
      });
    }
    return this.#cdp.session;
  }

  async close(): Promise<void> {
    const browserPromise = this.#browserPromise;
    this.#browserPromise = null;
    this.#cdp = null;
    // A deliberate close is not a disconnect anyone needs to hear about.
    this.#current = null;
    if (browserPromise !== null) await (await browserPromise).close();
  }
}
