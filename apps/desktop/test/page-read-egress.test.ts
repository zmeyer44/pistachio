/**
 * A page read's hop routing (docs/cloud-sync-design.md §10.3, D14): the
 * vetted address is the one dialled, and the only hop allowed to skip that
 * pin is one the Space's session really sends to the identity gateway —
 * which resolves and re-vets the target itself. A Space whose policy says
 * `identity` but whose session is browsing direct (switched to identity
 * after launch, "browse direct for now", signed out, or a bypassed host)
 * must take the pinned path like any other direct read; handing the name to
 * Chromium there lets it resolve a second time, and a rebinding answer would
 * reach a private address with the Space's cookies attached.
 */

import { describe, expect, it, vi } from "vitest";

// browser-controller.ts binds Electron at import time; the routing under
// test is a module function, so a stub module keeps the import from touching
// the runtime.
vi.mock("electron", () => {
  const stub: unknown = new Proxy(() => stub, { get: () => stub, apply: () => stub });
  const names = [
    "app", "BrowserWindow", "Menu", "WebContentsView", "clipboard", "dialog", "nativeTheme",
    "session", "shell", "webContents", "ipcMain", "net", "screen", "protocol", "nativeImage",
    "safeStorage", "systemPreferences", "powerMonitor",
  ];
  return Object.fromEntries([["default", stub], ...names.map((name) => [name, stub])]);
});

// The vetting step's own resolver: a public answer for the page's host, so
// the test turns on the routing decision alone and never on the network.
vi.mock("node:dns/promises", () => ({
  lookup: async (hostname: string) =>
    hostname === "private.test"
      ? [{ address: "127.0.0.1", family: 4 }]
      : [{ address: "93.184.216.34", family: 4 }],
}));

const { hopLeavesThroughProxy, readPageChain } = await import("../src/main/browser-controller");

type Session = Parameters<typeof readPageChain>[1];

/** A Space session that answers `resolveProxy` with a fixed proxy list. */
function sessionResolving(answer: string | Error): Session {
  return {
    resolveProxy: async (_url: string) => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as Session;
}

interface Reads {
  gateway: string[];
  pinned: Array<{ url: string; address: string }>;
}

async function readWith(partition: Session, url = "https://example.com/list"): Promise<{
  html: string;
  reads: Reads;
}> {
  const reads: Reads = { gateway: [], pinned: [] };
  const html = await readPageChain(
    url,
    partition,
    async (vetted) => {
      reads.gateway.push(vetted.href);
      return { html: "<html>gateway</html>" };
    },
    async (vetted, pinned) => {
      reads.pinned.push({ url: vetted.href, address: pinned.address });
      return { html: "<html>pinned</html>" };
    },
  );
  return { html, reads };
}

describe("hopLeavesThroughProxy", () => {
  it("is true only for a list that cannot fall back to a direct connection", async () => {
    const url = new URL("https://example.com/");
    expect(await hopLeavesThroughProxy(sessionResolving("PROXY gateway.test:8443"), url)).toBe(true);
    expect(await hopLeavesThroughProxy(sessionResolving("HTTPS gateway.test:443"), url)).toBe(true);
    expect(await hopLeavesThroughProxy(sessionResolving("DIRECT"), url)).toBe(false);
    // Chromium falls back to the second entry when the proxy is unreachable;
    // that fallback is a direct connection to a re-resolved name.
    expect(await hopLeavesThroughProxy(sessionResolving("PROXY gateway.test:8443;DIRECT"), url)).toBe(false);
    expect(await hopLeavesThroughProxy(sessionResolving(""), url)).toBe(false);
  });

  it("treats an unanswerable session as direct", async () => {
    const partition = sessionResolving(new Error("session closed"));
    expect(await hopLeavesThroughProxy(partition, new URL("https://example.com/"))).toBe(false);
  });
});

describe("readPageChain", () => {
  it("dials the vetted address itself when the session browses direct", async () => {
    // An identity Space whose session is not proxied this run: the read must
    // not hand the name back to Chromium's resolver.
    const { html, reads } = await readWith(sessionResolving("DIRECT"));
    expect(html).toBe("<html>pinned</html>");
    expect(reads.gateway).toEqual([]);
    expect(reads.pinned).toEqual([{ url: "https://example.com/list", address: "93.184.216.34" }]);
  });

  it("takes the session path only when the hop really leaves through the gateway", async () => {
    const { html, reads } = await readWith(sessionResolving("PROXY gateway.test:8443"));
    expect(html).toBe("<html>gateway</html>");
    expect(reads.gateway).toEqual(["https://example.com/list"]);
    expect(reads.pinned).toEqual([]);
  });

  it("falls back to the pinned path for a proxy list that may go direct", async () => {
    const { html, reads } = await readWith(sessionResolving("PROXY gateway.test:8443;DIRECT"));
    expect(html).toBe("<html>pinned</html>");
    expect(reads.gateway).toEqual([]);
  });

  it("clears and routes every redirect hop on its own", async () => {
    const partition = sessionResolving("DIRECT");
    const seen: string[] = [];
    const html = await readPageChain(
      "https://example.com/one",
      partition,
      async () => {
        throw new Error("the gateway path must not be taken for a direct session");
      },
      async (vetted, pinned) => {
        seen.push(`${vetted.href} @ ${pinned.address}`);
        return vetted.pathname === "/one"
          ? { html: "", redirectTo: "https://example.com/two" }
          : { html: "<html>done</html>" };
      },
    );
    expect(html).toBe("<html>done</html>");
    expect(seen).toEqual([
      "https://example.com/one @ 93.184.216.34",
      "https://example.com/two @ 93.184.216.34",
    ]);
  });

  it("refuses a redirect onto a private address on the proxied path too", async () => {
    const partition = sessionResolving("PROXY gateway.test:8443");
    let hops = 0;
    await expect(
      readPageChain(
        "https://example.com/one",
        partition,
        async () => {
          hops += 1;
          return { html: "", redirectTo: "http://private.test/admin" };
        },
        async () => ({ html: "<html>pinned</html>" }),
      ),
    ).rejects.toThrow(/not on the public web/);
    expect(hops).toBe(1);
  });
});
