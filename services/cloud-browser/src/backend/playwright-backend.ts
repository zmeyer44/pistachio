/**
 * The cloud `BrowserBackend` (docs/cloud-sync-design.md §8.4): Playwright
 * pages in one `BrowserContext`, every page behind its own network guard,
 * the shared `dom-scripts` evaluated as strings, real keystrokes through
 * `page.keyboard`, PNG screenshots. Tab ids are `cloud:<uuid>`.
 */

import { randomUUID } from "node:crypto";
import type { BrowserContext, Frame, Locator, Page } from "playwright-core";
import {
  clickPageScript,
  INSPECT_PAGE_SCRIPT,
  scrollScript,
  typePrepareScript,
  typeReadBackScript,
  type AgentTabInfo,
  type BrowserBackend,
  type PageInspection,
} from "@pistachio/agent-runtime";
import { withDeadline } from "@pistachio/agent-runtime";
import type { AgentPressableKey } from "@pistachio/protocol";
import type { PageNetworkGuard } from "../browser/guard.js";
import type { BrowserNetworkPolicy } from "../browser/network-policy.js";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import { checkActionFence } from "../runs/control-fence.js";
import type {
  CredentialFieldInjectionFailureReason,
  CredentialFieldInjectionResult,
} from "../sync/session.js";

const SAFE_POPUP_BINDING = "__pistachioOpenGuardedPopup";
const SAFE_POPUP_SCRIPT = `(() => {
  const openGuarded = (value) => {
    const raw = value == null ? "" : String(value);
    void globalThis.${SAFE_POPUP_BINDING}(raw).catch(() => undefined);
    return null;
  };
  Object.defineProperty(globalThis, "open", {
    value: openGuarded,
    writable: false,
    configurable: false,
  });
  // A named target, a middle click, or a ctrl/cmd/shift click all make
  // Chromium open a page of its own, which starts loading before the backend
  // can attach that page's network guard. Every one of them is turned into a
  // guarded open instead, from a capture listener the page cannot get ahead of.
  const onActivate = (event) => {
    const path = event.composedPath();
    const anchor = path.find((candidate) => candidate instanceof HTMLAnchorElement);
    if (!anchor) return;
    const baseTarget = document.querySelector("base")?.target || "";
    const target = (anchor.target || baseTarget).toLowerCase();
    const named = target !== "" && target !== "_self" && target !== "_top" && target !== "_parent";
    const opensNewPage = event.type === "auxclick"
      ? event.button === 1
      : named || event.ctrlKey || event.metaKey || event.shiftKey;
    if (!opensNewPage) return;
    event.preventDefault();
    openGuarded(anchor.href);
  };
  document.addEventListener("click", onActivate, true);
  document.addEventListener("auxclick", onActivate, true);
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const target = form.target.toLowerCase();
    if (target !== "" && target !== "_self" && target !== "_top" && target !== "_parent") {
      form.target = "_self";
    }
  }, true);
  const nativeSubmit = HTMLFormElement.prototype.submit;
  Object.defineProperty(HTMLFormElement.prototype, "submit", {
    value: function guardedSubmit() {
      const target = this.target.toLowerCase();
      if (target !== "" && target !== "_self" && target !== "_top" && target !== "_parent") {
        this.target = "_self";
      }
      return nativeSubmit.call(this);
    },
    writable: false,
    configurable: false,
  });
})();`;

export const DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;
/** Viewport bounds: a pane the shell reports as zero must not size a page to zero. */
const MIN_VIEWPORT = 64;
const MAX_VIEWPORT = 8_192;
const FAVICON_TIMEOUT_MS = 5_000;
const MAX_FAVICON_BYTES = 512 * 1024;
const MAX_FAVICON_DATA_URL = 64 * 1024;

/** The page's declared icon, resolved against the document. */
const FAVICON_HREF_SCRIPT = `(() => {
  const rels = ["icon", "shortcut icon", "apple-touch-icon", "apple-touch-icon-precomposed"];
  for (const rel of rels) {
    const link = document.querySelector('link[rel="' + rel + '"][href]');
    if (link) {
      try { return new URL(link.getAttribute("href"), document.baseURI).href; } catch { /* keep looking */ }
    }
  }
  return null;
})()`;
/**
 * Bound on creating a page and installing its network guard. Neither step
 * had one: when Chromium exits under the CDP socket, `newPage` and the
 * guard's CDP calls never settle, and a run that opened four tabs at once
 * stayed `running` for hours with every tool `started` and none finished.
 */
export const DEFAULT_TAB_SETUP_TIMEOUT_MS = 15_000;
const SETTLE_MS = 550;
const SHORT_SETTLE_MS = 180;

export interface PlaywrightBrowserBackendOptions {
  context: BrowserContext;
  spaceId: string;
  policy: BrowserNetworkPolicy;
  /** Installs the per-page network guard before the page loads anything. */
  installGuard: (page: Page) => Promise<PageNetworkGuard>;
  /** Fired after every completed tool action (the cookie capture diffs here). */
  onAction?: () => void;
  /** Fired when the tab list or the active tab changed (the live view re-sends `tabs`). */
  onTabsChanged?: () => void;
  navigationTimeoutMs?: number;
  /** See `DEFAULT_TAB_SETUP_TIMEOUT_MS`. */
  tabSetupTimeoutMs?: number;
  /** Test seam for the settle delays. */
  settle?: (ms: number) => Promise<void>;
  log?: Logger;
}

interface TabState {
  /** Address Chromium replaced with chrome-error://chromewebdata/. */
  failedUrl?: string;
  id: string;
  page: Page;
  guard: PageNetworkGuard;
  title: string;
  loading: boolean;
  history: string[];
  index: number;
  /**
   * Whose tab this is (docs/web-browser-design.md §6.2). A browser session's
   * tabs are the person's; the ones a run opens are the run's. The chrome
   * draws them differently and the session record keeps only the human ones.
   */
  kind: "human" | "agent";
  /** The size this tab's pane last reported, so a repeat resize is a no-op. */
  viewport?: { width: number; height: number };
  /** A backend-driven navigation is in flight; `framenavigated` must not push. */
  busy: boolean;
}

/** A full-control browser session scoped to one user and Space. */
export class PlaywrightBrowserBackend implements BrowserBackend {
  readonly kind = "cloud" as const;
  readonly #context: BrowserContext;
  readonly #spaceId: string;
  readonly #policy: BrowserNetworkPolicy;
  readonly #installGuard: (page: Page) => Promise<PageNetworkGuard>;
  readonly #onAction: () => void;
  readonly #onTabsChanged: () => void;
  readonly #navigationTimeoutMs: number;
  readonly #tabSetupTimeoutMs: number;
  readonly #settle: (ms: number) => Promise<void>;
  readonly #log: Logger;
  readonly #tabs = new Map<string, TabState>();
  readonly #credentialRedactions = new Map<string, { origin: string; targets: Set<string> }>();
  readonly #registrations = new Map<Page, Promise<TabState>>();
  readonly #pageListeners = new Set<(page: Page) => void | Promise<void>>();
  onPage(listener: (page: Page) => void | Promise<void>): () => void {
    this.#pageListeners.add(listener);
    for (const tab of this.#tabs.values()) void Promise.resolve(listener(tab.page)).catch(error => this.#log.warn("page observer failed", { error: errorMessage(error) }));
    return () => { this.#pageListeners.delete(listener); };
  }
  /**
   * Tab order, as the shell shows it. Playwright has no notion of one, so the
   * backend keeps it: ids in order, extended as pages register and compacted
   * as they close. Ids not listed here (a page that registered while a
   * reorder was in flight) sort after the listed ones, in registration order.
   */
  #order: string[] = [];
  /** One icon per origin, shared by every tab on that site. */
  readonly #favicons = new Map<string, Promise<string | null>>();
  /** How many session hosts are keeping this context's downloads (§11). */
  #downloadsClaimed = 0;
  /** The kind a page opened by the page itself (a popup) inherits. */
  #defaultTabKind: "human" | "agent" = "agent";
  #activeTabId: string | null = null;

  private constructor(options: PlaywrightBrowserBackendOptions) {
    this.#context = options.context;
    this.#spaceId = options.spaceId;
    this.#policy = options.policy;
    this.#installGuard = options.installGuard;
    this.#onAction = options.onAction ?? ((): void => undefined);
    this.#onTabsChanged = options.onTabsChanged ?? ((): void => undefined);
    this.#navigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
    this.#tabSetupTimeoutMs = options.tabSetupTimeoutMs ?? DEFAULT_TAB_SETUP_TIMEOUT_MS;
    this.#settle = options.settle ?? defaultSettle;
    this.#log = options.log ?? silentLogger;
  }

  /** Bind the popup guard to the context and start watching for pages. */
  static async attach(options: PlaywrightBrowserBackendOptions): Promise<PlaywrightBrowserBackend> {
    const backend = new PlaywrightBrowserBackend(options);
    const context = options.context;
    await context.exposeBinding(SAFE_POPUP_BINDING, async ({ frame }, rawUrl: unknown) => {
      if (typeof rawUrl !== "string" || rawUrl.trim() === "") return false;
      const url = new URL(rawUrl, frame.url());
      await backend.#policy.assertAllowed(url.href);
      const popup = await context.newPage();
      const tab = await backend.#register(popup);
      backend.#activeTabId = tab.id;
      await backend.#goto(tab, url.href);
      backend.#onTabsChanged();
      return true;
    });
    await context.addInitScript(SAFE_POPUP_SCRIPT);
    // Chromium has already begun a browser-opened page's first navigation by
    // the time this event fires, and installing a guard (a CDP session, then
    // `Fetch.enable`) is asynchronous — so a page the browser opens on its
    // own can fetch before anything vets it. `SAFE_POPUP_SCRIPT` is what
    // keeps that from happening: every way a page can ask for a new page
    // becomes a guarded open, which registers the page before it navigates.
    // This listener is the net for whatever is left, guarded as soon as it
    // appears.
    context.on("page", (page) => {
      void backend.#register(page).catch((error: unknown) => {
        backend.#log.warn("page registration failed", { error: errorMessage(error) });
        if (!page.isClosed()) void page.close().catch(() => undefined);
      });
    });
    for (const page of context.pages()) {
      void backend.#register(page).catch(() => undefined);
    }
    return backend;
  }

  get context(): BrowserContext {
    return this.#context;
  }

  get activeTabId(): string | null {
    return this.#activeTabId;
  }

  listTabs(): AgentTabInfo[] {
    return this.#ordered().map((tab) => ({
      id: tab.id,
      spaceId: this.#spaceId,
      title: tab.title,
      url: tab.page.url().startsWith("chrome-error:") ? (tab.failedUrl ?? tab.page.url()) : tab.page.url(),
      loading: tab.loading,
      canGoBack: tab.index > 0,
      canGoForward: tab.index < tab.history.length - 1,
      kind: tab.kind,
    }));
  }

  /**
   * Open a tab. `kind` says whose it is: a browser session opens `human`
   * tabs, a run opens `agent` ones, and a popup a page opens on its own
   * inherits whatever the last explicit open was — a link the person clicked
   * gives them a tab of their own, not one the console labels as the agent's.
   */
  async openTab(url?: string, options?: { kind?: "human" | "agent" }): Promise<string> {
    const kind = options?.kind ?? this.#defaultTabKind;
    this.#defaultTabKind = kind;
    checkActionFence();
    const page = await withDeadline(this.#context.newPage(), this.#tabSetupTimeoutMs, "opening a tab");
    const tab = await this.#register(page);
    tab.kind = kind;
    this.#activeTabId = tab.id;
    if (url !== undefined && url.trim() !== "") {
      await this.#goto(tab, url.trim());
    }
    this.#onTabsChanged();
    this.#onAction();
    return tab.id;
  }

  /**
   * Put `tabId` at `index` among the tabs, counted with it lifted out — the
   * shell's own `reorderTab` convention, so one arithmetic serves both hosts.
   */
  /**
   * A session host takes responsibility for this context's downloads: it has
   * somewhere to put them, a policy verdict to apply and a retention sweep
   * behind it. Until one does — and again once it lets go — every download is
   * cancelled where it starts.
   */
  claimDownloads(): () => void {
    this.#downloadsClaimed += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#downloadsClaimed = Math.max(0, this.#downloadsClaimed - 1);
    };
  }

  /** Whether any session host is keeping this context's downloads. */
  get downloadsClaimed(): boolean {
    return this.#downloadsClaimed > 0;
  }

  reorder(tabId: string, index: number): void {
    if (!this.#tabs.has(tabId)) return;
    const rest = this.#ordered()
      .map((tab) => tab.id)
      .filter((id) => id !== tabId);
    const at = Math.min(Math.max(Math.trunc(index), 0), rest.length);
    this.#order = [...rest.slice(0, at), tabId, ...rest.slice(at)];
    this.#onTabsChanged();
  }

  /**
   * Size a tab's viewport to its pane (§6.3). The screencast is capped to the
   * same box, so a page that reflows below a breakpoint reflows in the pane
   * the person actually has, not in a fixed 1280×800 the frame is squeezed
   * into.
   */
  async setViewport(tabId: string, size: { width: number; height: number }): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) return;
    const width = Math.round(Math.min(Math.max(size.width, MIN_VIEWPORT), MAX_VIEWPORT));
    const height = Math.round(Math.min(Math.max(size.height, MIN_VIEWPORT), MAX_VIEWPORT));
    if (tab.viewport?.width === width && tab.viewport.height === height) return;
    tab.viewport = { width, height };
    await tab.page.setViewportSize({ width, height }).catch((error: unknown) => {
      this.#log.warn("viewport resize failed", { error: errorMessage(error) });
    });
  }

  /**
   * The tab's icon as a data URL, fetched THROUGH the context — so it goes
   * out under the Space's cookies and the user's egress identity, like every
   * other request the page makes, and a private site's icon never leaks to a
   * favicon proxy. Cached per origin: one icon serves every tab on a site.
   */
  async favicon(tabId: string): Promise<string | null> {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) return null;
    let origin: string;
    try {
      const url = new URL(tab.page.url());
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      origin = url.origin;
    } catch {
      return null;
    }
    const cached = this.#favicons.get(origin);
    if (cached !== undefined) return cached;
    const pending = this.#fetchFavicon(tab, origin).catch(() => null);
    this.#favicons.set(origin, pending);
    return pending;
  }

  async focusTab(tabId: string): Promise<void> {
    const tab = this.#require(tabId);
    checkActionFence();
    this.#activeTabId = tabId;
    await tab.page.bringToFront();
    this.#onTabsChanged();
  }

  async navigate(tabId: string, url: string): Promise<void> {
    const tab = this.#require(tabId);
    await this.#goto(tab, url.trim());
    this.#onAction();
  }

  async back(tabId: string): Promise<void> {
    const tab = this.#require(tabId);
    await this.#travel(tab, -1);
    await this.#settle(SETTLE_MS);
    this.#onAction();
  }

  async forward(tabId: string): Promise<void> {
    const tab = this.#require(tabId);
    await this.#travel(tab, 1);
    await this.#settle(SETTLE_MS);
    this.#onAction();
  }

  async reload(tabId: string): Promise<void> {
    const tab = this.#require(tabId);
    checkActionFence();
    tab.busy = true;
    tab.loading = true;
    try {
      await tab.page.reload({ waitUntil: "load", timeout: this.#navigationTimeoutMs });
    } finally {
      tab.busy = false;
      tab.loading = false;
    }
    await this.#refreshTitle(tab);
    await this.#settle(SETTLE_MS);
    this.#onAction();
  }

  async inspect(tabId: string): Promise<PageInspection> {
    const tab = this.#require(tabId);
    const inspection = (await tab.page.evaluate(INSPECT_PAGE_SCRIPT)) as PageInspection;
    tab.title = inspection.title;
    const redactions = this.#redactionsFor(tab);
    if (redactions === null) return inspection;
    return {
      ...inspection,
      controls: inspection.controls.map((control) =>
        redactions.targets.has(control.selector) && control.value !== null && control.value !== ""
          ? { ...control, value: "[secure value]" }
          : control,
      ),
    };
  }

  async click(tabId: string, target: string): Promise<void> {
    const tab = this.#require(tabId);
    checkActionFence();
    const found = (await tab.page.evaluate(clickPageScript(target))) as boolean;
    if (!found) throw new Error(`page control not found: ${target}`);
    await this.#settle(SETTLE_MS);
    await this.#refreshTitle(tab);
    this.#onAction();
  }

  async type(tabId: string, target: string, value: string): Promise<string> {
    const tab = this.#require(tabId);
    checkActionFence();
    const ready = (await tab.page.evaluate(typePrepareScript(target))) as boolean;
    if (!ready) throw new Error(`editable page control not found: ${target}`);
    // Preparing the focus is a round trip, and a person taking control during
    // it is the whole reason W7 exists: without this the keystrokes below
    // arrive in whatever the person has just clicked into.
    checkActionFence();
    await tab.page.keyboard.type(value);
    const written = (await tab.page.evaluate(typeReadBackScript(target, value))) as string;
    await this.#settle(SHORT_SETTLE_MS);
    this.#onAction();
    return written;
  }

  async fillCredentialFields(
    tabId: string,
    expectedOrigin: string,
    fields: Array<{ target: string; value: string }>,
  ): Promise<CredentialFieldInjectionResult> {
    const tab = this.#require(tabId);
    if (new URL(tab.page.url()).origin !== expectedOrigin) {
      throw new Error("credential page origin changed before injection");
    }
    const targets = fields.map((field) => field.target);
    const ready = (await tab.page.evaluate(credentialPreflightScript(targets))) as boolean;
    if (!ready) throw new Error("one or more credential page controls are no longer safely editable");

    this.#credentialRedactions.set(tabId, {
      origin: expectedOrigin,
      targets: new Set(targets),
    });
    const attempted: string[] = [];
    try {
      for (const field of fields) {
        if (new URL(tab.page.url()).origin !== expectedOrigin) {
          throw new CredentialInjectionError("origin_changed");
        }
        const focused = (await tab.page.evaluate(credentialPrepareScript(field.target))) as boolean;
        if (!focused) throw new CredentialInjectionError("focus_failed");
        attempted.push(field.target);

        // Real keystrokes are the most compatible path, but some sign-in
        // controls suppress modifier-backed characters such as uppercase
        // letters or punctuation. If the stable readback differs, select the
        // same verified control again and use Chromium's exact text insertion
        // path before declaring the handoff partial.
        let written: string | null = null;
        try {
          await tab.page.keyboard.type(field.value);
          await this.#settle(SHORT_SETTLE_MS);
          if (new URL(tab.page.url()).origin !== expectedOrigin) {
            throw new CredentialInjectionError("origin_changed");
          }
          written = (await tab.page.evaluate(credentialReadBackScript(field.target))) as string | null;
        } catch (error: unknown) {
          if (error instanceof CredentialInjectionError) throw error;
          // A partially typed value is replaced by the exact fallback below.
        }

        if (written !== field.value) {
          if (new URL(tab.page.url()).origin !== expectedOrigin) {
            throw new CredentialInjectionError("origin_changed");
          }
          const refocused = (await tab.page.evaluate(credentialPrepareScript(field.target))) as boolean;
          if (!refocused) throw new CredentialInjectionError("focus_failed");
          try {
            await tab.page.keyboard.insertText(field.value);
          } catch {
            throw new CredentialInjectionError("write_failed");
          }
          await this.#settle(SHORT_SETTLE_MS);
          if (new URL(tab.page.url()).origin !== expectedOrigin) {
            throw new CredentialInjectionError("origin_changed");
          }
          written = (await tab.page.evaluate(credentialReadBackScript(field.target))) as string | null;
          if (written !== field.value) throw new CredentialInjectionError("value_mismatch");
        }
      }
      this.#onAction();
      return { status: "complete", attemptedCount: attempted.length, clearedCount: 0 };
    } catch (error: unknown) {
      if (attempted.length === 0) throw error;
      let clearedTargets: string[] = [];
      try {
        if (new URL(tab.page.url()).origin === expectedOrigin) {
          clearedTargets = (await tab.page.evaluate(credentialClearScript(attempted))) as string[];
        }
      } catch {
        // The page may have navigated or replaced a control; the result below
        // records exactly how much cleanup could be confirmed.
      }
      const redactions = this.#credentialRedactions.get(tabId);
      if (redactions !== undefined) {
        const attemptedSet = new Set(attempted);
        const clearedSet = new Set(clearedTargets);
        for (const target of redactions.targets) {
          if (!attemptedSet.has(target) || clearedSet.has(target)) redactions.targets.delete(target);
        }
        if (redactions.targets.size === 0) this.#credentialRedactions.delete(tabId);
      }
      this.#onAction();
      return {
        status: "partial",
        attemptedCount: attempted.length,
        clearedCount: clearedTargets.length,
        failureReason: credentialFailureReason(error),
      };
    }
  }

  async press(tabId: string, key: AgentPressableKey): Promise<void> {
    const tab = this.#require(tabId);
    checkActionFence();
    await tab.page.keyboard.press(key);
    await this.#settle(SETTLE_MS);
    await this.#refreshTitle(tab);
    this.#onAction();
  }

  async scroll(tabId: string, deltaY: number): Promise<void> {
    const tab = this.#require(tabId);
    checkActionFence();
    await tab.page.evaluate(scrollScript(deltaY));
    await this.#settle(SHORT_SETTLE_MS);
    this.#onAction();
  }

  async screenshot(tabId: string): Promise<string> {
    const tab = this.#require(tabId);
    const redactions = this.#redactionsFor(tab);
    const mask: Locator[] = redactions === null
      ? []
      : [...redactions.targets].map((target) => tab.page.locator(target));
    const png = await tab.page.screenshot({
      type: "png",
      ...(mask.length === 0 ? {} : { mask, maskColor: "#173c2b" }),
    });
    return `data:image/png;base64,${png.toString("base64")}`;
  }

  async pageHtml(tabId: string): Promise<string> {
    return this.#require(tabId).page.content();
  }

  /** The page behind a tab id, for the live view and tests. */
  pageFor(tabId: string): Page | null {
    return this.#tabs.get(tabId)?.page ?? null;
  }

  /** The guard session behind a tab id (the live view screencasts on it). */
  guardFor(tabId: string): PageNetworkGuard | null {
    return this.#tabs.get(tabId)?.guard ?? null;
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) return;
    await tab.page.close().catch(() => undefined);
  }

  /* ------------------------------ ordering ------------------------------ */

  /** Live tabs in shell order: the kept order first, then anything newer. */
  #ordered(): TabState[] {
    const seen = new Set<string>();
    const ordered: TabState[] = [];
    for (const id of this.#order) {
      const tab = this.#tabs.get(id);
      if (tab === undefined || seen.has(id)) continue;
      seen.add(id);
      ordered.push(tab);
    }
    for (const tab of this.#tabs.values()) {
      if (!seen.has(tab.id)) ordered.push(tab);
    }
    return ordered;
  }

  async #fetchFavicon(tab: TabState, origin: string): Promise<string | null> {
    let href: string | null = null;
    try {
      href = (await tab.page.evaluate(FAVICON_HREF_SCRIPT)) as string | null;
    } catch {
      // The page closed or navigated mid-read; fall back to the default path.
    }
    const candidate = href ?? `${origin}/favicon.ico`;
    let resolved: URL;
    try {
      resolved = new URL(candidate, origin);
    } catch {
      return null;
    }
    if (resolved.protocol === "data:") return resolved.href.slice(0, MAX_FAVICON_DATA_URL);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    try {
      await this.#policy.assertAllowed(resolved.href);
      const response = await this.#context.request.get(resolved.href, { timeout: FAVICON_TIMEOUT_MS });
      if (!response.ok()) return null;
      const body = await response.body();
      if (body.byteLength === 0 || body.byteLength > MAX_FAVICON_BYTES) return null;
      const type = (response.headers()["content-type"] ?? "image/x-icon").split(";")[0]?.trim() ?? "image/x-icon";
      if (!type.startsWith("image/")) return null;
      return `data:${type};base64,${body.toString("base64")}`;
    } catch {
      return null;
    }
  }

  /* ------------------------------ internals ------------------------------ */

  #require(tabId: string): TabState {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) throw new Error(`unknown tab id "${tabId}"; call tabs_list for current ids`);
    return tab;
  }

  #redactionsFor(tab: TabState): { origin: string; targets: Set<string> } | null {
    const redactions = this.#credentialRedactions.get(tab.id);
    if (redactions === undefined) return null;
    try {
      return new URL(tab.page.url()).origin === redactions.origin ? redactions : null;
    } catch {
      return null;
    }
  }

  #register(page: Page): Promise<TabState> {
    const existing = this.#registrations.get(page);
    if (existing !== undefined) return existing;
    const registration = (async (): Promise<TabState> => {
      let guard: PageNetworkGuard;
      try {
        guard = await withDeadline(this.#installGuard(page), this.#tabSetupTimeoutMs, "installing the page's network guard");
      } catch (error) {
        // A page without its guard must not survive: close it so nothing can
        // navigate it, and let the caller see the failure.
        if (!page.isClosed()) void page.close().catch(() => undefined);
        throw error;
      }
      try {
        for (const listener of this.#pageListeners) await withDeadline(Promise.resolve(listener(page)), this.#tabSetupTimeoutMs, "installing page observers");
      } catch (error) {
        await guard.detach().catch(() => undefined);
        if (!page.isClosed()) void page.close().catch(() => undefined);
        throw error;
      }
      // A fresh page's initial about:blank is not a history entry Chromium can go back to.
      const initial = page.url();
      const tab: TabState = {
        id: `cloud:${randomUUID()}`,
        page,
        guard,
        title: "",
        loading: false,
        history: initial === "about:blank" ? [] : [initial],
        index: initial === "about:blank" ? -1 : 0,
        kind: this.#defaultTabKind,
        busy: false,
      };
      this.#tabs.set(tab.id, tab);
      this.#order.push(tab.id);
      this.#activeTabId ??= tab.id;
      // A download nobody has claimed is CANCELLED (§11,
      // cloud-sync-design.md §8). The context is shared by this Space's runs
      // and its browser session, and `acceptDownloads` is on for the
      // session's sake — so a hostile page an agent visits on the ordinary
      // hosted-run path would otherwise write into Playwright's temp
      // directory with no policy check, no record, and no cleanup until the
      // context closes.
      page.on("download", (download) => {
        if (this.#downloadsClaimed > 0) return;
        void download.cancel().catch(() => undefined);
      });
      page.on("close", () => {
        this.#remove(tab);
        void guard.detach();
      });
      page.on("crash", () => {
        this.#log.warn("browser page crashed", { hostname: safeHostname(page.url()) });
        this.#remove(tab);
        void guard.detach();
        if (!page.isClosed()) void page.close().catch(() => undefined);
      });
      page.on("framenavigated", (frame: Frame) => {
        if (frame !== page.mainFrame()) return;
        this.#noteNavigation(tab, frame.url());
        void this.#refreshTitle(tab);
      });
      page.on("load", () => {
        void this.#refreshTitle(tab);
      });
      page.on("domcontentloaded", () => {
        // A new document cannot contain values typed into the prior one. Clear
        // selector masks so a later visit to the same origin is not over-redacted.
        this.#credentialRedactions.delete(tab.id);
      });
      this.#onTabsChanged();
      return tab;
    })();
    this.#registrations.set(page, registration);
    registration.catch(() => this.#registrations.delete(page));
    return registration;
  }

  #remove(tab: TabState): void {
    if (this.#tabs.get(tab.id) === tab) this.#tabs.delete(tab.id);
    this.#order = this.#order.filter((id) => id !== tab.id);
    this.#credentialRedactions.delete(tab.id);
    this.#registrations.delete(tab.page);
    if (this.#activeTabId === tab.id) {
      this.#activeTabId = this.#tabs.keys().next().value ?? null;
    }
    this.#onTabsChanged();
  }

  async #goto(tab: TabState, rawUrl: string): Promise<void> {
    const url = new URL(rawUrl);
    checkActionFence();
    await this.#policy.assertAllowed(url.href);
    // The policy is a round trip of its own; the fence may have moved while
    // it was deciding.
    checkActionFence();
    tab.busy = true;
    tab.loading = true;
    try {
      await tab.page.goto(url.href, { waitUntil: "load", timeout: this.#navigationTimeoutMs });
    } catch (error) {
      tab.failedUrl = url.href;
      await this.#refreshTitle(tab);
      throw error;
    } finally {
      tab.busy = false;
      tab.loading = false;
    }
    this.#push(tab, tab.page.url());
    await this.#refreshTitle(tab);
  }

  async #travel(tab: TabState, direction: -1 | 1): Promise<void> {
    checkActionFence();
    tab.busy = true;
    tab.loading = true;
    try {
      const before = tab.page.url();
      const response =
        direction === -1
          ? await tab.page.goBack({ waitUntil: "load", timeout: this.#navigationTimeoutMs })
          : await tab.page.goForward({ waitUntil: "load", timeout: this.#navigationTimeoutMs });
      // No response is also what an entry with no network request answers —
      // a `data:` document (the home page's placeholder, a welcome page, a
      // reader view) or a same-document step — so only an address that did
      // not move means there was nowhere to go.
      if (response === null && tab.page.url() === before) {
        throw new Error(direction === -1 ? "the tab has no previous page" : "the tab has no next page");
      }
    } finally {
      tab.busy = false;
      tab.loading = false;
    }
    tab.index = Math.min(Math.max(tab.index + direction, 0), tab.history.length - 1);
    await this.#refreshTitle(tab);
    this.#onTabsChanged();
  }

  #push(tab: TabState, url: string): void {
    if (tab.index >= 0 && tab.history[tab.index] === url) return;
    if (url === "about:blank" && tab.history.length === 0) return;
    tab.history = [...tab.history.slice(0, tab.index + 1), url];
    tab.index = tab.history.length - 1;
    this.#onTabsChanged();
  }

  /** A navigation the page made on its own (a link, a redirect, a script). */
  #noteNavigation(tab: TabState, url: string): void {
    if (tab.busy) return;
    this.#push(tab, url);
  }

  async #refreshTitle(tab: TabState): Promise<void> {
    try {
      const title = await tab.page.title();
      if (title !== tab.title) {
        tab.title = title;
        this.#onTabsChanged();
      }
    } catch {
      // The page navigated away or closed mid-read; the next read wins.
    }
  }
}

function credentialPreflightScript(targets: string[]): string {
  return `(() => {
    const targets = ${JSON.stringify(targets)};
    const editable = (element) => {
      if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) return false;
      if (element instanceof HTMLInputElement) {
        return !element.disabled && !element.readOnly && !["hidden", "button", "checkbox", "radio", "reset", "submit", "file", "image", "range", "color"].includes(element.type);
      }
      if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
      return element.isContentEditable;
    };
    return targets.every((target) => {
      try {
        const matches = document.querySelectorAll(target);
        return matches.length === 1 && editable(matches[0]);
      } catch {
        return false;
      }
    });
  })()`;
}

function credentialPrepareScript(target: string): string {
  return `(() => {
    let element;
    try {
      const matches = document.querySelectorAll(${JSON.stringify(target)});
      if (matches.length !== 1) return false;
      element = matches[0];
    } catch {
      return false;
    }
    const input = element instanceof HTMLInputElement;
    const textarea = element instanceof HTMLTextAreaElement;
    const editable = input
      ? !element.disabled && !element.readOnly && !["hidden", "button", "checkbox", "radio", "reset", "submit", "file", "image", "range", "color"].includes(element.type)
      : textarea
        ? !element.disabled && !element.readOnly
        : element instanceof HTMLElement && element.isContentEditable;
    if (!editable || !(element instanceof HTMLElement) || element.getClientRects().length === 0) return false;
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus();
    const active = document.activeElement;
    if (active !== element && !(element.isContentEditable && active !== null && element.contains(active))) return false;
    if (input || textarea) element.select();
    else window.getSelection()?.selectAllChildren(element);
    return true;
  })()`;
}

function credentialReadBackScript(target: string): string {
  return `(() => {
    try {
      const matches = document.querySelectorAll(${JSON.stringify(target)});
      if (matches.length !== 1) return null;
      const element = matches[0];
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return String(element.value);
      return element instanceof HTMLElement && element.isContentEditable ? String(element.textContent ?? "") : null;
    } catch {
      return null;
    }
  })()`;
}

function credentialClearScript(targets: string[]): string {
  return `(() => {
    const targets = ${JSON.stringify(targets)};
    const cleared = [];
    for (const target of targets) {
      try {
        const matches = document.querySelectorAll(target);
        if (matches.length !== 1) continue;
        const element = matches[0];
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
          setter?.call(element, "");
        } else if (element instanceof HTMLElement && element.isContentEditable) {
          element.textContent = "";
        } else {
          continue;
        }
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.value
          : element.textContent ?? "";
        if (value === "") cleared.push(target);
      } catch {
        // Continue clearing the remaining fields without exposing selector details.
      }
    }
    return cleared;
  })()`;
}

class CredentialInjectionError extends Error {
  constructor(readonly reason: CredentialFieldInjectionFailureReason) {
    super(reason);
    this.name = "CredentialInjectionError";
  }
}

function credentialFailureReason(error: unknown): CredentialFieldInjectionFailureReason {
  return error instanceof CredentialInjectionError ? error.reason : "write_failed";
}

function defaultSettle(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function safeHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "unknown";
  }
}
