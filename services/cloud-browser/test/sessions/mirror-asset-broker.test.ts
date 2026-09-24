import { EventEmitter } from "node:events";
import type { Page, Request, Response } from "playwright-core";
import { describe, expect, it } from "vitest";
import { AssetBroker } from "../../src/sessions/mirror/asset-broker.js";

describe("response-backed mirror asset storage", () => {
  it("scopes identical URLs to separate documents and invalidates old document references", async () => {
    const broker = new AssetBroker({ waitMs: 5 });
    const url = "https://site.example/private.png";
    broker.provide(url, "image/png", new Uint8Array([1]), "one");
    broker.provide(url, "image/png", new Uint8Array([2]), "two");
    const one = broker.assign(url, "image", "one"), two = broker.assign(url, "image", "two");
    expect(one).not.toBe(two);
    expect(broker.belongsTo(one, "two")).toBe(false);
    expect(await broker.bytesFor(one)).toEqual({ type: "image/png", bytes: new Uint8Array([1]) });
    expect(await broker.bytesFor(two)).toEqual({ type: "image/png", bytes: new Uint8Array([2]) });
    broker.dropScope("one");
    expect(await broker.bytesFor(one)).toBeNull();
    expect(broker.cachedBytes).toBe(1);
  });

  it("waits for the page response and resolves missing references without fetching them", async () => {
    const broker = new AssetBroker({ waitMs: 20 });
    const id = broker.assign("https://site.example/later", "font");
    const pending = broker.bytesFor(id);
    broker.provide("https://site.example/later", "font/woff2", new Uint8Array([1, 2]));
    expect(await pending).toEqual({ type: "font/woff2", bytes: new Uint8Array([1, 2]) });
    expect(await broker.bytesFor(broker.assign("http://127.0.0.1/private", "image"))).toBe("pending");
  });

  it("keeps a timed-out capture pending and delivers bytes under the original id later", async () => {
    const broker = new AssetBroker({ waitMs: 1 });
    const id = broker.assign("https://site.example/slow.png", "image");
    expect(await broker.bytesFor(id)).toBe("pending");
    expect(broker.diagnostic(id)).toEqual({ reason: "pending", context: "image" });
    const ready: string[] = [];
    broker.onAvailable(id => ready.push(id));
    broker.provide("https://site.example/slow.png", "image/png", new Uint8Array([7]));
    expect(ready).toEqual([id]);
    expect(await broker.bytesFor(id)).toEqual({ type: "image/png", bytes: new Uint8Array([7]) });
  });

  it("does not let a late response capture failure discard a recorder-provided blob", async () => {
    const events = new EventEmitter();
    const page = events as unknown as Page;
    const broker = new AssetBroker(); broker.observe(page);
    const scope = broker.scopeFor(page);
    const url = "blob:https://site.example/image";
    const request = { isNavigationRequest: () => false, resourceType: () => "image", url: () => url, redirectedFrom: () => null } as unknown as Request;
    let rejectBody!: (error: Error) => void;
    const body = new Promise<Buffer>((_resolve, reject) => { rejectBody = reject; });
    let bodyStarted = false;
    events.emit("request", request);
    events.emit("response", { request: () => request, headers: () => ({ "content-type": "image/png" }), status: () => 200,
      url: () => url, finished: async () => null, body: () => { bodyStarted = true; return body; } } as unknown as Response);
    await expect.poll(() => bodyStarted).toBe(true);
    broker.provideBlob(url, "image/png", new Uint8Array([1, 2]), scope);
    rejectBody(new Error("body unavailable"));
    await body.catch(() => undefined);
    const id = broker.assign(url, "image", scope);
    expect(await broker.bytesFor(id)).toEqual({ type: "image/png", bytes: new Uint8Array([1, 2]) });
    events.emit("close");
  });

  it("reports the size limit without retaining oversized bytes", async () => {
    const broker = new AssetBroker();
    const id = broker.assign("blob:large", "image");
    broker.provideBlob("blob:large", "image/png", new Uint8Array(13 * 1024 * 1024));
    expect(await broker.bytesFor(id)).toBe("missing");
    expect(broker.diagnostic(id)).toEqual({ reason: "too-large", context: "image" });
    expect(broker.cachedBytes).toBe(0);
  });

  it("rewrites nested CSS dependencies using their own document scope and stylesheet base", async () => {
    const broker = new AssetBroker();
    broker.provide("https://cdn.example/css/main.css", "text/css", new TextEncoder().encode('@import "nested.css"; @font-face{src:url(../font.woff2)}'), "doc");
    const result = await broker.bytesFor(broker.assign("https://cdn.example/css/main.css", "style", "doc"));
    expect(result && result !== "missing" && result !== "pending" && new TextDecoder().decode(result.bytes)).toBe(
      `@import url("pa-asset:${broker.assign("https://cdn.example/css/nested.css", "style", "doc")}"); @font-face{src:url("pa-asset:${broker.assign("https://cdn.example/font.woff2", "font", "doc")}")}`,
    );
  });

  it("bounds image, font and blob bytes together and evicts the least recently read asset", async () => {
    const broker = new AssetBroker();
    const size = 10 * 1024 * 1024;
    const ids: string[] = [];
    for (let n = 0; n < 6; n++) {
      broker.provideBlob(`blob:${n}`, n % 2 ? "font/woff2" : "image/png", new Uint8Array(size));
      ids.push(broker.assign(`blob:${n}`, "image"));
    }
    await broker.bytesFor(ids[0]!);
    broker.provideBlob("blob:last", "image/png", new Uint8Array(size));
    expect(broker.cachedBytes).toBeLessThanOrEqual(AssetBroker.MAX_CACHE_BYTES);
    expect(await broker.bytesFor(ids[1]!)).toBe("missing");
    expect(broker.diagnostic(ids[1]!)).toEqual({ reason: "evicted", context: "image" });
    const original = ids[1]!;
    broker.provideBlob("blob:1", "font/woff2", new Uint8Array([9]));
    expect(broker.assign("blob:1", "font")).toBe(original);
    expect(await broker.bytesFor(original)).toEqual({ type: "font/woff2", bytes: new Uint8Array([9]) });
    expect(await broker.bytesFor(ids[0]!)).not.toBeNull();
    broker.dropScope("default");
    expect(broker.cachedBytes).toBe(0);
  });
});
