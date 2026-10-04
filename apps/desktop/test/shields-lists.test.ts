import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { countRules, listExpiry, ListStore, looksLikeFilterList, type FetchLike } from "../src/main/shields/lists";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-shields-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Served {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

function server(routes: Record<string, Served | ((headers: Record<string, string>) => Served)>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, headers: init.headers });
    const route = routes[url];
    if (route === undefined) return Promise.reject(new Error("offline"));
    const served = typeof route === "function" ? route(init.headers) : route;
    return Promise.resolve(new Response(served.status === 304 ? null : (served.body ?? ""), { status: served.status ?? 200, headers: served.headers ?? {} }));
  };
  return { fetch, calls };
}

const EASYLIST = "https://easylist.to/easylist/easylist.txt";
const EASYLIST_MIRROR = "https://ublockorigin.github.io/uAssets/thirdparties/easylist.txt";
const UBO = "https://ublockorigin.github.io/uAssets/filters/annoyances-others.txt";

describe("list headers", () => {
  it("reads ! Expires in days or hours, clamped", () => {
    expect(listExpiry("! Title: x\n! Expires: 4 days\n||a^")).toBe(4 * 24 * 3600_000);
    expect(listExpiry("! Expires: 8 hours (update frequency)")).toBe(8 * 3600_000);
    expect(listExpiry("! Expires: 1 hour")).toBe(4 * 3600_000);
    expect(listExpiry("! Expires: 90 days")).toBe(14 * 24 * 3600_000);
    expect(listExpiry("||a^")).toBeNull();
  });

  it("counts rules, and refuses error pages", () => {
    expect(countRules("[Adblock Plus 2.0]\n! comment\n\n||a^\nexample.com##.x\n")).toBe(2);
    expect(looksLikeFilterList("<!DOCTYPE html><html>")).toBe(false);
    expect(looksLikeFilterList("! only comments\n")).toBe(false);
    expect(looksLikeFilterList("! Title\n||a^")).toBe(true);
  });
});

describe("the list store", () => {
  it("fetches, keeps the validators, and answers a 304 without rewriting", async () => {
    const dir = scratch();
    let round = 0;
    const { fetch, calls } = server({
      [EASYLIST]: (headers) => {
        round += 1;
        if (round > 1 && headers["If-None-Match"] === '"v1"') return { status: 304 };
        return { body: "! Expires: 4 days\n||ads.example^\n", headers: { etag: '"v1"' } };
      },
    });
    const store = new ListStore(dir, fetch);
    expect(store.due(["easylist"])).toEqual(["easylist"]);
    expect(await store.refresh(["easylist"])).toEqual(["easylist"]);
    expect(store.status("easylist", true)).toMatchObject({ state: "ready", rules: 1, error: null });
    expect(store.due(["easylist"])).toEqual([]);
    // Forced, the second fetch is conditional and changes nothing.
    expect(await store.refresh(["easylist"])).toEqual([]);
    expect(calls[1]?.headers["If-None-Match"]).toBe('"v1"');
    expect(readFileSync(store.pathFor("easylist"), "utf8")).toContain("||ads.example^");
    // A new store reads the same state back from disk.
    expect(new ListStore(dir, fetch).has("easylist")).toBe(true);
  });

  it("falls back to a mirror, and records a failure without losing the cached copy", async () => {
    const dir = scratch();
    const first = server({ [EASYLIST]: { status: 503 }, [EASYLIST_MIRROR]: { body: "||mirror.example^\n" } });
    const store = new ListStore(dir, first.fetch);
    expect(await store.refresh(["easylist"])).toEqual(["easylist"]);
    expect(await store.text("easylist")).toContain("mirror.example");

    const broken = new ListStore(dir, server({ [EASYLIST]: { body: "<html>oops</html>" }, [EASYLIST_MIRROR]: { status: 404 } }).fetch);
    expect(await broken.refresh(["easylist"])).toEqual([]);
    expect(broken.status("easylist", true)).toMatchObject({ state: "failed", error: "HTTP 404" });
    expect(await broken.text("easylist")).toContain("mirror.example");
    expect(broken.due(["easylist"])).toEqual([]);
  });

  it("keeps a list's own cadence across unchanged (304) answers", async () => {
    const dir = scratch();
    let round = 0;
    const { fetch } = server({
      [UBO]: () => {
        round += 1;
        return round === 1 ? { body: "! Expires: 8 hours\n||a.example^\n", headers: { etag: '"v1"' } } : { status: 304 };
      },
    });
    const store = new ListStore(dir, fetch);
    const hours = (ms: number) => Math.round(ms / 3600_000);
    const meta = () => JSON.parse(readFileSync(join(dir, "lists", "lists.json"), "utf8"))["ubo-annoyances"] as { expiresAt: number };
    let now = Date.UTC(2026, 9, 3, 12);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(now);
      await store.refresh(["ubo-annoyances"]);
      for (let check = 0; check < 3; check += 1) {
        // Each check comes when the list said it would be stale.
        now += 8 * 3600_000;
        vi.setSystemTime(now);
        expect(store.due(["ubo-annoyances"])).toEqual(["ubo-annoyances"]);
        await store.refresh(["ubo-annoyances"]);
        expect(hours(meta().expiresAt - now)).toBe(8);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a server that sends headers and then stalls, and tries the mirror", async () => {
    const dir = scratch();
    const fetch: FetchLike = (url, init) => {
      if (url === EASYLIST_MIRROR) return Promise.resolve(new Response("||mirror.example^\n"));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    const store = new ListStore(dir, fetch, { timeoutMs: 50 });
    expect(await store.refresh(["easylist"])).toEqual(["easylist"]);
    expect(await store.text("easylist")).toContain("mirror.example");
  });

  it("fetches a list with includes again in full, so a changed include is not hidden behind the parent's 304", async () => {
    const dir = scratch();
    let includeVersion = 1;
    const { fetch } = server({
      [UBO]: (headers) => (headers["If-None-Match"] === '"p1"' ? { status: 304 } : { body: "||top.example^\n!#include part.txt\n", headers: { etag: '"p1"' } }),
      "https://ublockorigin.github.io/uAssets/filters/part.txt": () => ({ body: `||part-v${String(includeVersion)}.example^\n` }),
    });
    const store = new ListStore(dir, fetch);
    await store.refresh(["ubo-annoyances"]);
    expect(await store.text("ubo-annoyances")).toContain("part-v1");
    includeVersion = 2;
    expect(await store.refresh(["ubo-annoyances"])).toEqual(["ubo-annoyances"]);
    expect(await store.text("ubo-annoyances")).toContain("part-v2");
  });

  it("keeps a list's version when a full download brings the same text", async () => {
    const dir = scratch();
    const { fetch } = server({ [EASYLIST]: { body: "||same.example^\n" } });
    const store = new ListStore(dir, fetch);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 3, 12));
      await store.refresh(["easylist"]);
      const version = store.version("easylist");
      vi.setSystemTime(Date.UTC(2026, 9, 7, 12));
      expect(await store.refresh(["easylist"])).toEqual([]);
      expect(store.version("easylist")).toBe(version);
      expect(new ListStore(dir, fetch).version("easylist")).toBe(version);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves !#include against the list's own origin only", async () => {
    const dir = scratch();
    const { fetch } = server({
      [UBO]: { body: "||top.example^\n!#include part.txt\n!#include https://evil.example/x.txt\n" },
      "https://ublockorigin.github.io/uAssets/filters/part.txt": { body: "||included.example^\n" },
      "https://evil.example/x.txt": { body: "@@*$document\n" },
    });
    const store = new ListStore(dir, fetch);
    await store.refresh(["ubo-annoyances"]);
    const text = (await store.text("ubo-annoyances")) ?? "";
    expect(text).toContain("||included.example^");
    expect(text).not.toContain("@@*$document");
    expect(text).not.toContain("!#include");
  });
});
