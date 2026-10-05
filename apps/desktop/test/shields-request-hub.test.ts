import type { Session } from "electron";
import { describe, expect, it } from "vitest";
import { RequestHub } from "../src/main/shields/request-hub";

type Listener = ((details: never, callback: (response: unknown) => void) => void) | null;

/** Electron's rule, faithfully: one listener per event, the last one wins. */
function fakeSession() {
  const listeners: Record<string, { filter: unknown; listener: Listener }> = {};
  const register = (name: string) => (filter: unknown, listener?: Listener) => {
    if (filter === null) delete listeners[name];
    else listeners[name] = { filter, listener: listener ?? null };
  };
  const session = {
    webRequest: {
      onBeforeRequest: register("beforeRequest"),
      onBeforeSendHeaders: register("sendHeaders"),
      onHeadersReceived: register("headersReceived"),
      onBeforeRedirect: register("beforeRedirect"),
    },
  } as unknown as Session;
  const fire = (name: string, details: Record<string, unknown>) =>
    new Promise<unknown>((resolve) => {
      const entry = listeners[name];
      if (entry?.listener == null) {
        resolve("no listener");
        return;
      }
      entry.listener(details as never, resolve);
    });
  return { session, listeners, fire };
}

describe("the request hub", () => {
  it("runs every named handler under one listener, policy first, first decision wins", async () => {
    const { session, fire } = fakeSession();
    const hub = RequestHub.for(session);
    const seen: string[] = [];
    hub.onBeforeRequest("shields", {
      priority: 10,
      handler: (details) => {
        seen.push("shields");
        return details.url.includes("ads") ? { cancel: true } : undefined;
      },
    });
    hub.onBeforeRequest("upload-policy", {
      priority: 0,
      types: ["mainFrame", "xhr"],
      handler: (details) => {
        seen.push("policy");
        return details.method === "POST" ? { cancel: true } : undefined;
      },
    });
    expect(await fire("beforeRequest", { url: "https://a.example/ads.js", resourceType: "script", method: "GET" })).toEqual({ cancel: true });
    expect(seen).toEqual(["shields"]);
    seen.length = 0;
    expect(await fire("beforeRequest", { url: "https://a.example/upload", resourceType: "xhr", method: "POST" })).toEqual({ cancel: true });
    expect(seen).toEqual(["policy"]);
    seen.length = 0;
    expect(await fire("beforeRequest", { url: "https://a.example/page", resourceType: "xhr", method: "GET" })).toEqual({});
    expect(seen).toEqual(["policy", "shields"]);
  });

  it("refuses a preflight a handler would redirect, which would crash Electron", async () => {
    const { session, fire } = fakeSession();
    const hub = RequestHub.for(session);
    hub.onBeforeRequest("shields", { priority: 10, handler: () => ({ redirectURL: "data:text/plain;base64," }) });
    expect(await fire("beforeRequest", { url: "https://ads.example/ping", resourceType: "xhr", method: "OPTIONS" })).toEqual({ cancel: true });
    expect(await fire("beforeRequest", { url: "https://ads.example/ping", resourceType: "xhr", method: "GET" })).toEqual({
      redirectURL: "data:text/plain;base64,",
    });
  });

  it("replaces a handler of the same name instead of running both", async () => {
    const { session, fire } = fakeSession();
    const hub = RequestHub.for(session);
    let first = 0;
    let second = 0;
    hub.onBeforeRequest("upload-policy", { priority: 0, handler: () => void (first += 1) });
    hub.onBeforeRequest("upload-policy", { priority: 0, handler: () => void (second += 1) });
    await fire("beforeRequest", { url: "https://a.example/", resourceType: "script" });
    expect([first, second]).toEqual([0, 1]);
    expect(RequestHub.for(session)).toBe(hub);
  });

  it("only sends headers back when a handler changed them, and keeps going past a handler that throws", async () => {
    const { session, fire } = fakeSession();
    const hub = RequestHub.for(session);
    hub.onBeforeSendHeaders("broken", {
      priority: 0,
      handler: () => {
        throw new Error("boom");
      },
    });
    hub.onBeforeSendHeaders("shields", {
      priority: 10,
      handler: (details, headers) => {
        if (details.url.includes("gpc")) headers["Sec-GPC"] = "1";
      },
    });
    expect(await fire("sendHeaders", { url: "https://a.example/", resourceType: "script", requestHeaders: { Accept: "*/*" } })).toEqual({});
    expect(await fire("sendHeaders", { url: "https://a.example/gpc", resourceType: "script", requestHeaders: { Accept: "*/*" } })).toEqual({
      requestHeaders: { Accept: "*/*", "Sec-GPC": "1" },
    });
  });

  it("unregisters the event when its last handler goes", () => {
    const { session, listeners } = fakeSession();
    const hub = RequestHub.for(session);
    hub.onHeadersReceived("shields", { priority: 10, handler: () => undefined });
    expect(listeners["headersReceived"]).toBeDefined();
    hub.onHeadersReceived("shields", null);
    expect(listeners["headersReceived"]).toBeUndefined();
  });
});
