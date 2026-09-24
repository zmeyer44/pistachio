import { EventEmitter } from "node:events";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { PageMediaProxy } from "../src/browser/media-proxy.js";
import { SafeBrowserNetworkPolicy } from "../src/browser/network-policy.js";
import { startFixture } from "./helpers/fixture-server.js";
import { AuthProxy } from "./helpers/proxy.js";

describe("media range relay", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });
  it("uses authenticated egress and exact observed origin headers, supports ranges, and refuses unobserved URLs", async () => {
    const requests: Array<{ cookie?: string; auth?: string; range?: string; proxy?: string }> = [];
    const origin = await startFixture((request, response) => {
      requests.push({ cookie: request.headers.cookie, auth: request.headers.authorization, range: request.headers.range, proxy: request.headers["proxy-authorization"] as string | undefined });
      response.writeHead(206, { "content-type": "video/mp4", "content-range": "bytes 2-4/6" }); response.end("cde");
    });
    cleanups.push(() => origin.close());
    const gateway = new AuthProxy(); await gateway.start(); cleanups.push(() => gateway.close());
    let credential = { username: "media", password: "first" }; gateway.setCredential(credential.username, credential.password);
    const page = new EventEmitter();
    const media = new PageMediaProxy(page as unknown as Page, { policy: new SafeBrowserNetworkPolicy({ allowedOrigins: [origin.origin] }), gateway: () => gateway, credential: () => credential });
    cleanups.push(() => media.close());
    page.emit("request", { resourceType: () => "media", url: () => `${origin.origin}/movie`, allHeaders: async () => ({ cookie: "private=session", authorization: "Bearer origin-only" }) });
    await expect(media.open(`${origin.origin}/other`, "bytes=2-4", new AbortController().signal)).rejects.toThrow("not requested");
    for (const password of ["first", "rotated"]) {
      credential = { username: "media", password }; gateway.setCredential(credential.username, credential.password);
      const result = await media.open(`${origin.origin}/movie`, "bytes=2-4", new AbortController().signal);
      expect(result.statusCode).toBe(206); expect(await result.body.text()).toBe("cde");
    }
    expect(requests).toEqual(Array.from({ length: 2 }, () => ({ cookie: "private=session", auth: "Bearer origin-only", range: "bytes=2-4", proxy: undefined })));
    expect(gateway.records.length).toBeGreaterThanOrEqual(2);
    expect(gateway.records.every(record => record.accepted)).toBe(true);
    media.close();
    await expect(media.open(`${origin.origin}/movie`, "bytes=0-", new AbortController().signal)).rejects.toThrow();
  });

  it("rechecks policy on redirects without forwarding the original URL's credentials", async () => {
    const seen: Array<string | undefined> = [];
    const other = await startFixture((request, response) => { seen.push(request.headers.cookie); response.end("media"); });
    cleanups.push(() => other.close());
    const origin = await startFixture((request, response) => { response.writeHead(302, { location: request.url === "/blocked" ? "http://169.254.169.254/latest/meta-data" : other.origin }); response.end(); });
    cleanups.push(() => origin.close());
    const page = new EventEmitter();
    const media = new PageMediaProxy(page as unknown as Page, { policy: new SafeBrowserNetworkPolicy({ allowedOrigins: [origin.origin, other.origin] }), gateway: () => null, credential: () => null });
    cleanups.push(() => media.close());
    for (const path of ["/redirect", "/blocked"]) page.emit("request", { resourceType: () => "media", url: () => `${origin.origin}${path}`, allHeaders: async () => ({ cookie: "private=session" }) });
    const result = await media.open(`${origin.origin}/redirect`, "bytes=0-", new AbortController().signal);
    expect(await result.body.text()).toBe("media"); expect(seen).toEqual([undefined]);
    await expect(media.open(`${origin.origin}/blocked`, "bytes=0-", new AbortController().signal)).rejects.toThrow();
  });
});
