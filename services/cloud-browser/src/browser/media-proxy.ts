/** A media-only range relay through the same policy and egress identity as the
 * source page. Origin credentials never leave the worker. */
import { ProxyAgent, request as fetchResource, type Dispatcher } from "undici";
import type { Page, Request } from "playwright-core";
import type { NetworkGuardOptions } from "./guard.js";

export class PageMediaProxy {
  readonly #seen = new Map<string, Promise<Record<string, string>>>();
  readonly #page: Page;
  readonly #options: NetworkGuardOptions;
  #dispatcher: ProxyAgent | undefined;
  #credential = "";
  #closed = false;
  readonly #observe = (request: Request): void => {
    if (request.resourceType() !== "media") return;
    this.#seen.set(request.url(), request.allHeaders().catch(() => ({})));
    while (this.#seen.size > 256) this.#seen.delete(this.#seen.keys().next().value!);
  };
  constructor(page: Page, options: NetworkGuardOptions) {
    this.#page = page; this.#options = options;
    page.on("request", this.#observe);
  }
  has(url: string): boolean { return this.#seen.has(url); }
  async waitFor(url: string, signal: AbortSignal): Promise<void> {
    if (this.has(url)) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer); this.#page.off("request", observed); signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve();
      };
      const observed = (): void => { if (this.has(url)) finish(); };
      const aborted = (): void => finish(new Error("Media request cancelled"));
      const timer = setTimeout(() => finish(new Error("Source did not request media")), 5000);
      this.#page.on("request", observed); signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted(); else observed();
    });
  }
  async open(url: string, range: string, signal: AbortSignal): Promise<Dispatcher.ResponseData> {
    if (this.#closed || !this.#seen.has(url)) throw new Error("Media was not requested by this page");
    const gateway = this.#options.gateway();
    if (gateway) {
      const credential = this.#options.credential();
      if (!credential) throw new Error("Media egress is unavailable");
      const token = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
      const key = `${gateway.host}:${gateway.port}:${token}`;
      if (key !== this.#credential) {
        void this.#dispatcher?.close();
        this.#dispatcher = new ProxyAgent({ uri: `http://${gateway.host}:${gateway.port}`, token });
        this.#credential = key;
      }
    }
    let target = url;
    for (let redirects = 0; redirects <= 5; redirects++) {
      await this.#options.policy.assertAllowed(target);
      if (this.#closed) throw new Error("Media proxy closed");
      // Reuse only headers the browser actually sent to this exact URL. This
      // preserves cookie partition/SameSite decisions and redirect boundaries.
      const observed = await this.#seen.get(target);
      const headers: Record<string, string> = { range, "accept-encoding": "identity" };
      for (const name of ["accept", "authorization", "cookie", "origin", "referer", "user-agent"]) {
        if (observed?.[name]) headers[name] = observed[name]!;
      }
      const result = await fetchResource(target, { method: "GET", headers, signal,
        ...(gateway ? { dispatcher: this.#dispatcher } : {}), headersTimeout: 15_000, bodyTimeout: 15_000 }).catch((error: unknown) => {
          if (gateway && error instanceof Error && /Proxy.*\(407\)/u.test(error.message)) this.#options.onCredentialRejected?.();
          throw error;
        });
      // Destroying an unread Undici body emits an error on a later turn.
      // Callers still observe stream failures, but early refusal is also safe.
      result.body.on("error", () => undefined);
      if (result.statusCode === 407) this.#options.onCredentialRejected?.();
      if ([301, 302, 303, 307, 308].includes(result.statusCode) && typeof result.headers.location === "string") {
        result.body.destroy(); target = new URL(result.headers.location, target).href; continue;
      }
      return result;
    }
    throw new Error("Too many media redirects");
  }
  close(): void {
    this.#closed = true; this.#page.off("request", this.#observe); this.#seen.clear();
    void this.#dispatcher?.destroy();
  }
}
