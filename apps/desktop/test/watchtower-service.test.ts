import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import {
  DEFAULT_WATCHTOWER_SETTINGS,
  type WatchtowerRegionRule,
  type WatchtowerSettings,
} from "@pistachio/shell-contracts/watchtower";
import type { WatchtowerWireCapture as WatchtowerCapture } from "@pistachio/watchtower/capture";
import { WatchtowerService } from "../src/main/watchtower/service";

const bridge = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("electron", () => ({ utilityProcess: { fork: bridge.fork } }));
vi.mock("../src/main/model-provider.js", () => ({
  configuredIntentModel: () => null,
}));

class Worker extends EventEmitter {
  messages: Record<string, unknown>[] = [];
  readError: { error: string; code?: string } | null = null;
  rules: WatchtowerRegionRule[] = [];
  settings: WatchtowerSettings = {
    ...DEFAULT_WATCHTOWER_SETTINGS,
    enabled: true,
  };
  postMessage(message: Record<string, unknown>): void {
    this.messages.push(message);
    if (message.type === "shutdown") {
      queueMicrotask(() => this.emit("exit", 0));
      return;
    }
    const request = message.request as
      | { type: string; patch?: Partial<WatchtowerSettings> }
      | undefined;
    if (request?.type === "settings")
      Object.assign(this.settings, request.patch);
    queueMicrotask(() =>
      this.emit("message", {
        id: message.id,
        ...(request?.type === "read" ? this.readError : {}),
        value:
          message.type === "rules"
            ? { rules: this.rules }
            : { settings: { ...this.settings }, stats: {}, results: [] },
      }),
    );
  }
  kill(): void {
    this.emit("exit", 0);
  }
}
class Contents extends EventEmitter {
  url = "https://example.com/first";
  title = "Fixture";
  extract = vi.fn<() => Promise<WatchtowerCapture | null>>();
  /** What the page says it has gained since its last capture. */
  dirty = 100000;
  isDestroyed(): boolean {
    return false;
  }
  getURL(): string {
    return this.url;
  }
  getTitle(): string {
    return this.title;
  }
  isLoadingMainFrame(): boolean {
    return false;
  }
  executeJavaScriptInIsolatedWorld(
    _world: number,
    scripts: { code: string }[],
  ): Promise<WatchtowerCapture | number | null> {
    return scripts[0]?.code.startsWith("globalThis.__watchtowerDirty")
      ? Promise.resolve(this.dirty)
      : this.extract();
  }
}
const capture = (url: string): WatchtowerCapture => ({
  url,
  title: "Fixture",
  description: "",
  creator: "",
  kind: "page",
  paths: ["article"],
  blocks: [{ text: "Saved evidence", path: 0, linkChars: 0 }],
  links: [],
  truncated: false,
});

describe("Watchtower lifecycle", () => {
  let worker: Worker;
  let contents: Contents;
  let service: WatchtowerService;
  let visible: boolean;
  beforeEach(async () => {
    vi.useFakeTimers({
      toFake: [
        "Date",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
      ],
    });
    vi.setSystemTime(100000);
    worker = new Worker();
    contents = new Contents();
    visible = true;
    contents.extract.mockImplementation(async () => capture(contents.url));
    bridge.fork.mockReturnValue(worker);
    service = new WatchtowerService("/unused", "/worker.js", () => [
      {
        id: "tab",
        spaceId: "personal",
        visible,
        contents: contents as unknown as WebContents,
      },
    ]);
    service.attach("tab", contents as unknown as WebContents);
    worker.emit("message", { ready: true });
    await vi.advanceTimersByTimeAsync(0);
  });
  afterEach(() => {
    service.close();
    vi.useRealTimers();
  });
  const count = (worker: Worker, type: string): number =>
    worker.messages.filter((message) => message.type === type).length;

  it("skips background pages and drops a capture hidden before extraction finishes", async () => {
    visible = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(count(worker, "visit")).toBe(0);
    visible = true;
    let finish!: (value: WatchtowerCapture) => void;
    contents.extract.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(2100);
    expect(contents.extract).toHaveBeenCalledOnce();
    visible = false;
    finish(capture(contents.url));
    await vi.advanceTimersByTimeAsync(0);
    expect(count(worker, "ingest")).toBe(0);
  });
  it("drops stale extraction across same-URL navigation", async () => {
    let finish!: (value: WatchtowerCapture) => void;
    contents.extract.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(2100);
    contents.emit("did-start-navigation", { isMainFrame: true });
    finish(capture(contents.url));
    await vi.advanceTimersByTimeAsync(0);
    expect(count(worker, "ingest")).toBe(0);
  });
  it("forgets without immediately recapturing the still-open page; navigation permits a new visit", async () => {
    await vi.advanceTimersByTimeAsync(2100);
    expect(count(worker, "ingest")).toBe(1);
    await service.request("personal", { type: "forget", all: true });
    const before = count(worker, "visit");
    await vi.advanceTimersByTimeAsync(35000);
    expect(count(worker, "visit")).toBe(before);
    contents.emit("did-start-navigation", { isMainFrame: true });
    contents.emit("did-navigate");
    await vi.advanceTimersByTimeAsync(2100);
    expect(count(worker, "visit")).toBe(before + 1);
  });
  it("records returning to an old open tab as a fresh dated visit", async () => {
    await vi.advanceTimersByTimeAsync(2100);
    visible = false;
    await vi.advanceTimersByTimeAsync(65000);
    visible = true;
    await vi.advanceTimersByTimeAsync(2100);
    const visits = worker.messages
      .filter((message) => message.type === "visit")
      .map((message) => message.visit as { id: string; at: number });
    expect(visits).toHaveLength(2);
    expect(visits[1]?.id).not.toBe(visits[0]?.id);
    expect(visits[1]!.at - visits[0]!.at).toBeGreaterThan(60000);
  });
  it("decodes metadata reader addresses and enforces their Space at the worker boundary", async () => {
    const response = await service.respond(
      new URL("pistachio://watchtower/v/visit%3Ametadata/markdown"),
      "personal",
    );
    expect(response?.status).toBe(404); // The fake worker returns no document.
    const read = worker.messages.find(
      (message) =>
        (message.request as { type?: string } | undefined)?.type === "read",
    );
    expect(read).toMatchObject({
      spaceId: "personal",
      request: { type: "read", observationId: "visit:metadata" },
    });
    expect(
      (
        await service.respond(
          new URL("pistachio://watchtower/v/%ZZ"),
          "personal",
        )
      )?.status,
    ).toBe(404);
  });
  it("pause cancels pending capture and leaves ordinary browsing untouched", async () => {
    let finish!: (value: WatchtowerCapture) => void;
    contents.extract.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(2100);
    await service.request("personal", {
      type: "settings",
      patch: { paused: true },
    });
    finish(capture(contents.url));
    await vi.advanceTimersByTimeAsync(35000);
    expect(count(worker, "ingest")).toBe(0);
    expect(contents.url).toBe("https://example.com/first");
  });
  it("keeps a visit and its dwell across canceled navigation and anchor/replaceState churn", async () => {
    await vi.advanceTimersByTimeAsync(1000);
    contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    for (let i = 0; i < 100; i++) {
      contents.url = `https://example.com/first#section${i}`;
      contents.emit("did-start-navigation", {
        isMainFrame: true,
        isSameDocument: true,
      });
      contents.emit("did-navigate-in-page", {}, contents.url, true);
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(count(worker, "visit")).toBe(1);
    expect(count(worker, "ingest")).toBe(1);
    const message = worker.messages.find(
      (message) => message.type === "ingest",
    );
    expect(message?.capture).toMatchObject({
      url: "https://example.com/first",
    });
  });
  it("coalesces changing SPA routes, retains foreground dwell and captures their final URL", async () => {
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 100; i++) {
      contents.url = `https://example.com/first#/item/${i}`;
      contents.emit("did-start-navigation", {
        isMainFrame: true,
        isSameDocument: true,
      });
      contents.emit("did-navigate-in-page", {}, contents.url, true);
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(1100);
    expect(count(worker, "visit")).toBe(2);
    expect(count(worker, "ingest")).toBe(1);
    expect(
      worker.messages.find((message) => message.type === "ingest")?.visit,
    ).toMatchObject({ url: contents.url });
  });
  it("makes progress even when a SPA never stops replacing its route", async () => {
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 350; i++) {
      contents.url = `https://example.com/first?position=${i}`;
      contents.emit("did-navigate-in-page", {}, contents.url, true);
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(count(worker, "visit")).toBe(2);
    expect(count(worker, "ingest")).toBe(1);
  });
  it("starts a fresh visit only when a full navigation commits and updates late titles", async () => {
    await vi.advanceTimersByTimeAsync(1000);
    const original = worker.messages.find(
      (message) => message.type === "visit",
    )?.visit;
    contents.emit("did-start-navigation", { isMainFrame: true });
    await vi.advanceTimersByTimeAsync(2100);
    expect(count(worker, "visit")).toBe(1);
    contents.emit("did-navigate");
    contents.title = "New document title";
    contents.emit("page-title-updated");
    await vi.advanceTimersByTimeAsync(0);
    expect(count(worker, "visit")).toBe(2);
    const update = worker.messages.find(
      (message) => message.type === "title",
    )?.visit;
    expect(update).toMatchObject({ title: "New document title" });
    expect(update).not.toMatchObject({ id: (original as { id: string }).id });
  });
  it("distinguishes a missing saved observation from transient reader failures and offers retry", async () => {
    worker.readError = { error: "Watchtower is restarting." };
    const transient = await service.respond(
      new URL("pistachio://watchtower/v/saved"),
      "personal",
    );
    expect(transient?.status).toBe(503);
    expect(transient?.headers.get("retry-after")).toBe("3");
    expect(await transient?.text()).toContain("Retrying");
    worker.readError = { error: "Removed", code: "NOT_FOUND" };
    expect(
      (
        await service.respond(
          new URL("pistachio://watchtower/v/saved"),
          "personal",
        )
      )?.status,
    ).toBe(404);
  });
  it("runs long exports separately while ordinary requests remain responsive", async () => {
    const exporter = new Worker();
    bridge.fork.mockReturnValueOnce(exporter);
    const exported = service.export("personal", "/export");
    let finished = false;
    void exported.then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(20000);
    expect(finished).toBe(false);
    expect(
      (await service.request("personal", { type: "search", query: "fixture" }))
        .results,
    ).toEqual([]);
    expect(worker.messages.some((message) => message.type === "export")).toBe(
      false,
    );
    exporter.emit("message", { value: { exportPath: "/export" } });
    exporter.emit("exit", 0);
    expect((await exported).exportPath).toBe("/export");
  });
  it("offers agent retrieval only after opt-in or for existing history in that Space", async () => {
    // Off until the person says yes, even with saved history.
    worker.emit("message", { spaces: ["personal"] });
    await service.request("personal", {
      type: "settings",
      patch: { enabled: false },
    });
    expect(service.agentAvailable("personal")).toBe(false);
    await service.request("personal", {
      type: "settings",
      patch: { agentAccess: true },
    });
    expect(service.agentAvailable("personal")).toBe(true);
    expect(service.agentAvailable("work")).toBe(false);
    await service.request("personal", {
      type: "settings",
      patch: { agentAccess: false },
    });
    expect(service.agentAvailable("personal")).toBe(false);
  });
  const prose = (n: number): string =>
    `Paragraph ${n}. ${"The restored lathe needed new bearings and a careful alignment. ".repeat(4)}`;
  const layoutPage = (url: string): WatchtowerCapture => ({
    ...capture(url),
    paths: ["div.layout>div.col-a", "div.layout>div.col-b"],
    blocks: [
      ...[1, 2, 3, 4].map((n) => ({ text: prose(n), path: 0, linkChars: 0 })),
      ...Array.from({ length: 10 }, (_, n) => ({
        text: `Another headline worth a click, number ${n}`,
        path: 1,
        linkChars: 38,
      })),
    ],
    links: [{ url: "https://example.com/other", text: "Another headline", block: 6 }],
  });
  const ingested = (worker: Worker): { blocks: string[]; links: unknown[] }[] =>
    worker.messages
      .filter((message) => message.type === "ingest")
      .map((message) => message.capture as { blocks: string[]; links: unknown[] });

  it("asks the decision model only about undecided regions, sends excerpts not pages, and remembers the verdict", async () => {
    contents.extract.mockImplementation(async () => layoutPage(contents.url));
    const asked: { host: string; signatures: string[]; excerpts: string[] }[] = [];
    service.useDecisionModel(
      () => ({ id: "jev", model: "scripted" as never }),
      async (page, regions) => {
        asked.push({
          host: page.host,
          signatures: regions.map((region) => region.signature),
          excerpts: regions.map((region) => region.excerpt),
        });
        return regions.map(() => ({ role: "recommendations" as const, confidence: 0.93 }));
      },
    );
    contents.emit("did-navigate");
    await vi.advanceTimersByTimeAsync(2000);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.host).toBe("example.com");
    expect(asked[0]!.signatures).toEqual(["div.layout>div.col-b"]);
    expect(asked[0]!.excerpts.every((excerpt) => excerpt.length <= 200)).toBe(true);
    const saved = ingested(worker).at(-1)!;
    expect(saved.blocks).toHaveLength(4);
    expect(saved.blocks.join(" ")).not.toContain("headline");
    expect(saved.links).toEqual([]);
    const learned = worker.messages.find((message) => message.type === "learn") as
      | { host: string; rules: WatchtowerRegionRule[] }
      | undefined;
    expect(learned?.host).toBe("example.com");
    expect(learned?.rules.find((rule) => rule.signature === "div.layout>div.col-b")).toMatchObject({
      keep: false,
      role: "recommendations",
      source: "model",
    });

    // The next page of the same layout is settled by the remembered rule.
    contents.url = "https://example.com/second";
    contents.emit("did-navigate");
    await vi.advanceTimersByTimeAsync(2000);
    expect(asked).toHaveLength(1);
    expect(ingested(worker).at(-1)!.blocks).toHaveLength(4);
  });

  it("keeps the text when the model is unsure, unavailable, failing, or switched off", async () => {
    contents.extract.mockImplementation(async () => layoutPage(contents.url));
    let calls = 0;
    service.useDecisionModel(
      () => ({ id: "jev", model: "scripted" as never }),
      async (_page, regions) => {
        calls++;
        if (calls === 2) throw new Error("gateway down");
        return regions.map(() => null);
      },
    );
    contents.emit("did-navigate");
    await vi.advanceTimersByTimeAsync(2000);
    // Unsure: the text is kept, and the doubt is remembered so the same
    // layout gets the same answer next time instead of another coin toss.
    expect(calls).toBe(1);
    expect(ingested(worker).at(-1)!.blocks).toHaveLength(14);
    const learned = worker.messages.find((message) => message.type === "learn") as { rules: WatchtowerRegionRule[] };
    expect(learned.rules.find((rule) => rule.signature === "div.layout>div.col-b")).toMatchObject({
      keep: true,
      role: "undecided",
      source: "model",
    });
    contents.url = "https://example.com/second";
    contents.emit("did-navigate");
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(1);

    // A failing model keeps the text and rests for that host.
    contents.url = "https://failing.example/one";
    contents.emit("did-navigate");
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(2);
    expect(ingested(worker).at(-1)!.blocks.length).toBeGreaterThanOrEqual(4);
    contents.url = "https://failing.example/two";
    contents.emit("did-navigate");
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(2);

    await service.request("personal", { type: "settings", patch: { smartFilter: false } });
    contents.url = "https://other.example/page";
    contents.emit("did-navigate");
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(2);
    expect(ingested(worker).at(-1)!.blocks.length).toBeGreaterThanOrEqual(4);
  });

  it("looks again only when the page gained text, and less often each time", async () => {
    contents.emit("did-navigate");
    await vi.advanceTimersByTimeAsync(2000);
    expect(contents.extract).toHaveBeenCalledTimes(1);
    // A ticking clock: nothing substantial was added.
    contents.dirty = 12;
    await vi.advanceTimersByTimeAsync(120000);
    expect(contents.extract).toHaveBeenCalledTimes(1);
    contents.dirty = 5000;
    await vi.advanceTimersByTimeAsync(31000);
    expect(contents.extract).toHaveBeenCalledTimes(2);
    // Still changing: the second look waits a minute, not thirty seconds.
    await vi.advanceTimersByTimeAsync(31000);
    expect(contents.extract).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(31000);
    expect(contents.extract).toHaveBeenCalledTimes(3);
  });

  it("does not record a page the agent loaded, during the run or after it", async () => {
    let agentDriven = true;
    service.close();
    worker = new Worker();
    bridge.fork.mockReturnValue(worker);
    const reading = new Contents();
    reading.url = "https://example.com/my-own-reading";
    reading.extract.mockImplementation(async () => capture(reading.url));
    service = new WatchtowerService("/unused", "/worker.js", () => [
      { id: "tab", spaceId: "personal", visible: !agentDriven, agentDriven, contents: contents as unknown as WebContents },
      { id: "mine", spaceId: "personal", visible: true, contents: reading as unknown as WebContents },
    ]);
    service.attach("tab", contents as unknown as WebContents);
    service.attach("mine", reading as unknown as WebContents);
    worker.emit("message", { ready: true });
    await vi.advanceTimersByTimeAsync(0);
    contents.url = "https://example.com/agent-opened";
    contents.emit("did-navigate");
    reading.emit("did-navigate");
    await vi.advanceTimersByTimeAsync(3000);
    const visits = (): string[] =>
      worker.messages.filter((message) => message.type === "visit").map((message) => (message.visit as { url: string }).url);
    // The person's own tab is still recorded while the agent works beside it.
    expect(visits()).toEqual(["https://example.com/my-own-reading"]);
    agentDriven = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(visits()).toEqual(["https://example.com/my-own-reading"]);
    // Once the person navigates that tab themselves, it is theirs.
    contents.url = "https://example.com/human-click";
    contents.emit("did-navigate");
    await vi.advanceTimersByTimeAsync(3000);
    expect(visits()).toContain("https://example.com/human-click");
  });

  it("requests graceful worker shutdown", () => {
    service.close();
    expect(count(worker, "shutdown")).toBe(1);
  });
  it("waits for committed Forget completion beyond the normal RPC deadline", async () => {
    const post = worker.postMessage.bind(worker);
    let deletion: Record<string, unknown> | undefined;
    vi.spyOn(worker, "postMessage").mockImplementation((message) => {
      if ((message.request as { type?: string } | undefined)?.type === "forget")
        deletion = message;
      else post(message);
    });
    const forgetting = service.request("personal", {
      type: "forget",
      all: true,
    });
    let finished = false;
    void forgetting.then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(20000);
    expect(finished).toBe(false);
    expect(deletion).toBeDefined();
    expect(count(worker, "ingest")).toBe(0);
    worker.emit("message", {
      id: deletion!.id,
      value: { settings: worker.settings, stats: { visits: 0, full: false } },
      spaces: [],
    });
    expect((await forgetting).stats.visits).toBe(0);
  });
});
