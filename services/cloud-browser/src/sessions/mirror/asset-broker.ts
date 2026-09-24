/** Response-backed assets. This store never makes a network request. Every byte
 * came through the page's existing network guard and egress authentication. */
import { randomBytes } from "node:crypto";
import type { Page, Response, Request } from "playwright-core";
import { MAX_ASSET_BYTES, rewriteCss, type AssetContext, type AssetFailure } from "@pistachio/dom-mirror";
import { silentLogger, type Logger } from "../../logger.js";

interface RecordEntry {
  id: string;
  scope: string;
  url: string;
  base: string;
  context: AssetContext;
  type: string;
  bytes: Uint8Array | null;
  missing: boolean;
  failure?: AssetFailure;
  requested: boolean;
  delayedLogged?: boolean;
  loading: Promise<void> | null;
}
const rank = (context: AssetContext): number => ({ style: 0, font: 1, image: 2, media: 3, other: 4 })[context];

export class AssetBroker {
  static readonly MAX_CACHE_BYTES = 64 * 1024 * 1024;
  readonly #records = new Map<string, RecordEntry>();
  readonly #urls = new Map<string, string>();
  readonly #scopes = new WeakMap<Page, string>();
  readonly #observed = new WeakSet<Page>();
  readonly #requestScopes = new WeakMap<Request, string>();
  readonly #listeners = new Set<() => void>();
  readonly #available = new Set<(id: string) => void>();
  readonly #waitMs: number;
  #bytes = 0;
  readonly #log: Logger;
  constructor(options: { log?: Logger; waitMs?: number } = {}) { this.#waitMs = options.waitMs ?? 5_000; this.#log = options.log ?? silentLogger; }

  scopeFor(page: Page): string {
    let scope = this.#scopes.get(page);
    if (scope === undefined) { scope = randomBytes(12).toString("base64url"); this.#scopes.set(page, scope); }
    return scope;
  }

  /** Install before navigation, including in pixel mode: switching renderers
   * must not repeat signed, cookie-dependent, or one-time asset requests. */
  observe(page: Page): void {
    if (this.#observed.has(page)) return;
    this.#observed.add(page);
    this.scopeFor(page);
    const onRequest = (request: import("playwright-core").Request): void => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && request.redirectedFrom() === null) {
        this.dropScope(this.scopeFor(page));
        this.#scopes.set(page, randomBytes(12).toString("base64url"));
      }
      this.#requestScopes.set(request, this.scopeFor(page));
      const kind = request.resourceType();
      if (["stylesheet", "image", "font", "media"].includes(kind)) {
        const context = kind === "stylesheet" ? "style" : kind as AssetContext;
        const id = this.assign(request.url(), context, this.scopeFor(page));
        const entry = this.#records.get(id)!;
        entry.requested = true;
        if (entry.bytes === null) { entry.missing = false; entry.failure = undefined; }
      }
    };
    const failRequest = (request: Request, failure: AssetFailure): void => {
      const scope = this.#requestScopes.get(request);
      if (!scope || scope !== this.scopeFor(page)) return;
      for (let current: Request | null = request; current; current = current.redirectedFrom()) {
        const id = this.#urls.get(`${scope}\n${current.url()}`);
        const entry = id ? this.#records.get(id) : undefined;
        if (entry) this.#fail(entry, failure);
      }
    };
    const onResponse = (response: Response): void => {
      const request = response.request();
      if (!["stylesheet", "image", "font", "media", "other", "fetch", "xhr"].includes(request.resourceType())) return;
      const type = (response.headers()["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (response.status() >= 400) {
        failRequest(request, { reason: "source-http", status: response.status() });
        return;
      }
      if (!/^(image\/|font\/|text\/css$|application\/(font|x-font|vnd\.ms-fontobject|octet-stream))/u.test(type)) return;
      const scope = this.#requestScopes.get(request);
      if (scope === undefined || scope !== this.scopeFor(page)) return;
      const previousId = this.#urls.get(`${scope}\n${response.url()}`);
      if (previousId && this.#records.get(previousId)?.bytes) this.#urls.delete(`${scope}\n${response.url()}`);
      const context: AssetContext = type === "text/css" ? "style" : type.startsWith("font/") ? "font" : "image";
      const id = this.assign(response.url(), context, scope);
      const entry = this.#records.get(id)!;
      // Keep ids already issued for a redirect's original URL alive. Remapping
      // only the URL index strands any CSS tokens waiting on the original id.
      const entries = [entry];
      for (let previous = request.redirectedFrom(); previous !== null; previous = previous.redirectedFrom()) {
        const alias = this.#records.get(this.assign(previous.url(), context, scope))!;
        if (!entries.includes(alias)) entries.push(alias);
      }
      for (const item of entries) item.base = response.url();
      const loading = (async () => {
        try {
          if (Number(response.headers()["content-length"] ?? 0) > MAX_ASSET_BYTES) { for (const item of entries) this.#fail(item, { reason: "too-large" }); return; }
          const finished = await response.finished();
          if (finished) { for (const item of entries) this.#fail(item, { reason: "source-network" }); return; }
          const bytes = await response.body();
          for (const item of entries) if (this.#records.get(item.id) === item) this.provide(item.url, type, bytes, scope);
        } catch { for (const item of entries) this.#fail(item, { reason: "capture" }); }
        finally { for (const item of entries) item.loading = null; this.#notify(); }
      })();
      for (const item of entries) item.loading = loading;
    };
    const onFailed = (request: Request): void => {
      failRequest(request, { reason: "source-network" });
    };
    page.on("requestfailed", onFailed);
    page.on("request", onRequest);
    page.on("response", onResponse);
    page.once("close", () => { page.off("requestfailed", onFailed); page.off("request", onRequest); page.off("response", onResponse); this.dropScope(this.scopeFor(page)); });
  }

  assign(url: string, context: AssetContext, scope = "default"): string {
    const key = `${scope}\n${url}`;
    const old = this.#urls.get(key);
    const existing = old === undefined ? undefined : this.#records.get(old);
    if (existing !== undefined) {
      if (rank(context) < rank(existing.context)) existing.context = context;
      return existing.id;
    }
    const id = randomBytes(18).toString("base64url");
    this.#urls.set(key, id);
    this.#records.set(id, { id, scope, url, base: url, context, type: "", bytes: null, missing: false, requested: false, loading: null });
    // Metadata is bounded too. Evicted references fail closed and trigger fallback.
    while (this.#records.size > 4096) this.#drop(this.#records.keys().next().value!);
    return id;
  }
  resolver(scope = "default"): (url: string, context: AssetContext) => string {
    return (url, context) => `pa-asset:${this.assign(url, context, scope)}`;
  }
  contextOf(id: string): AssetContext | null { return this.#records.get(id)?.context ?? null; }
  urlOf(id: string): string | null { return this.#records.get(id)?.url ?? null; }
  belongsTo(id: string, scope: string): boolean { return this.#records.get(id)?.scope === scope; }
  /** CSS alternatives and lazy images can be named before the browser needs them. */
  unrequested(id: string): boolean {
    const entry = this.#records.get(id);
    return entry !== undefined && !entry.requested && !entry.missing && entry.loading === null
      && /^https?:/u.test(entry.url);
  }
  onAvailable(listener: (id: string) => void): () => void {
    this.#available.add(listener);
    return () => { this.#available.delete(listener); };
  }

  provide(url: string, type: string, bytes: Uint8Array, scope = "default"): void {
    const id = this.assign(url, type === "text/css" ? "style" : "image", scope);
    const entry = this.#records.get(id)!;
    this.#bytes -= entry.bytes?.byteLength ?? 0;
    entry.bytes = bytes.byteLength <= MAX_ASSET_BYTES ? bytes : null;
    entry.type = type;
    entry.missing = entry.bytes === null;
    entry.failure = undefined;
    if (entry.missing) this.#fail(entry, { reason: "too-large" });
    entry.requested = true;
    this.#bytes += entry.bytes?.byteLength ?? 0;
    // Evict bytes, preserving the issued id and its diagnostic. A later observed
    // response can refill the same reference without another origin request.
    for (const item of this.#records.values()) {
      if (this.#bytes <= AssetBroker.MAX_CACHE_BYTES) break;
      if (!item.bytes) continue;
      this.#bytes -= item.bytes.byteLength; item.bytes = null;
      this.#fail(item, { reason: "evicted" });
    }
    this.#notify();
    for (const listener of this.#available) listener(id);
  }
  provideBlob(url: string, type: string, bytes: Uint8Array, scope = "default"): void { this.provide(url, type, bytes, scope); }

  async bytesFor(id: string): Promise<{ type: string; bytes: Uint8Array } | "missing" | "pending" | null> {
    const entry = this.#records.get(id);
    if (entry === undefined) return null;
    if (entry.bytes === null && !entry.missing) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          if (entry.bytes === null && !entry.missing && this.#records.has(id)) return;
          clearTimeout(timer); this.#listeners.delete(done); resolve();
        };
        const timer = setTimeout(() => { this.#listeners.delete(done); resolve(); }, this.#waitMs);
        this.#listeners.add(done);
        done();
      });
    }
    if (this.#records.get(id) !== entry || entry.missing) return "missing";
    if (entry.bytes === null) {
      if (!entry.delayedLogged) {
        entry.delayedLogged = true;
        let hostname = "";
        try { hostname = new URL(entry.url).hostname; } catch { /* opaque blob */ }
        this.#log.warn("DOM mirror asset delayed", { id, scope: entry.scope, hostname, context: entry.context, waitMs: this.#waitMs });
      }
      return "pending";
    }
    // Touch LRU. Rewrite CSS when read, once its dependencies can be assigned.
    this.#records.delete(id); this.#records.set(id, entry);
    const bytes = entry.type === "text/css"
      ? new TextEncoder().encode(rewriteCss(new TextDecoder().decode(entry.bytes), entry.base, this.resolver(entry.scope)))
      : entry.bytes;
    if (bytes.byteLength > MAX_ASSET_BYTES) { this.#fail(entry, { reason: "too-large" }); return "missing"; }
    return { type: entry.type, bytes };
  }
  diagnostic(id: string): AssetFailure {
    const entry = this.#records.get(id);
    return entry?.failure ?? { reason: entry ? "pending" : "unknown", ...(entry ? { context: entry.context } : {}) };
  }
  #fail(entry: RecordEntry, failure: AssetFailure): void {
    if (this.#records.get(entry.id) !== entry) return;
    // A late capture error (notably blob response.body) cannot invalidate bytes
    // already delivered through the recorder or another successful response.
    if (entry.bytes !== null && failure.reason !== "too-large") return;
    if ((entry.failure?.reason === "source-http" && failure.reason === "source-network")
      || ((entry.failure?.reason === "source-http" || entry.failure?.reason === "source-network") && failure.reason === "capture")) return;
    const changed = entry.failure?.reason !== failure.reason;
    entry.missing = true; entry.failure = { ...failure, context: entry.context };
    if (changed) {
      let hostname = "";
      try { hostname = new URL(entry.url).hostname; } catch { /* opaque blob */ }
      this.#log.warn("DOM mirror asset unavailable", { id: entry.id, scope: entry.scope, hostname, ...entry.failure });
    }
    this.#notify();
    if (changed) for (const listener of this.#available) listener(entry.id);
  }
  dropScope(scope: string): void {
    for (const [id, entry] of this.#records) if (entry.scope === scope) this.#drop(id);
    this.#notify();
  }
  #drop(id: string): void {
    const entry = this.#records.get(id);
    if (entry === undefined) return;
    this.#bytes -= entry.bytes?.byteLength ?? 0;
    this.#records.delete(id);
    for (const [key, value] of this.#urls) if (value === id) this.#urls.delete(key);
  }
  #notify(): void { for (const listener of [...this.#listeners]) listener(); }
  get cachedBytes(): number { return this.#bytes; }
}
