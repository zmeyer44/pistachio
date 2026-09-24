import { EventEmitter } from "node:events";
import type { Browser } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { PlaywrightBrowserRuntime } from "../src/browser/runtime.js";

/** Just enough of a Playwright Browser for the runtime's bookkeeping. */
function fakeBrowser(): Browser & { drop(): void } {
  const emitter = new EventEmitter();
  let connected = true;
  const browser = {
    on: (event: string, listener: () => void) => emitter.on(event, listener),
    isConnected: () => connected,
    close: vi.fn(async () => {
      connected = false;
    }),
    newBrowserCDPSession: vi.fn(async () => ({}) as never),
    drop(): void {
      connected = false;
      emitter.emit("disconnected");
    },
  };
  return browser as unknown as Browser & { drop(): void };
}

describe("PlaywrightBrowserRuntime", () => {
  it("reports the browser's state and tells listeners once when it goes away", async () => {
    const launched: ReturnType<typeof fakeBrowser>[] = [];
    const runtime = new PlaywrightBrowserRuntime({
      proxyMode: "direct",
      launch: async () => {
        const browser = fakeBrowser();
        launched.push(browser);
        return browser;
      },
    });
    const disconnects = vi.fn();
    runtime.onDisconnected(disconnects);
    expect(runtime.isConnected()).toBeNull();

    const first = await runtime.browser();
    expect(runtime.isConnected()).toBe(true);
    expect(await runtime.browser()).toBe(first);

    launched[0]?.drop();
    expect(disconnects).toHaveBeenCalledTimes(1);
    expect(runtime.isConnected()).toBeNull();

    // The next use launches afresh; the dead browser's late events are ignored.
    const second = await runtime.browser();
    expect(second).not.toBe(first);
    expect(runtime.isConnected()).toBe(true);
    launched[0]?.drop();
    expect(disconnects).toHaveBeenCalledTimes(1);

    // A deliberate close is not a disconnect.
    await runtime.close();
    expect(disconnects).toHaveBeenCalledTimes(1);
    expect(runtime.isConnected()).toBeNull();
  });
});
