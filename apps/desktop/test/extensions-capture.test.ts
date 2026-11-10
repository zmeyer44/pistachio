import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtDeskState } from "@pistachio/extension-api";
import { CAPTURE_END_GRACE_MS, CAPTURE_KILL_GRACE_MS, CAPTURE_START_GRACE_MS, CaptureBook, keepStills, panelIsChooser, picturedSources, statusPillFor, type CaptureHost, type CapturePage } from "../src/main/extensions/capture";
import { dispatch } from "../src/main/extensions/methods";
import { captureSize } from "../src/main/extensions/service";
import { harness, manifestOf, recordOf, tabOf } from "./extensions-harness";

const CAPTURING = { permissions: ["capture:tab", "input:events"], worker: { type: "web", main: "worker.js" } };
const granted = (tabs = [tabOf("t1", "https://linear.app/issue/1"), tabOf("t2", "pistachio://notes/"), tabOf("t3", "https://example.com/")]) =>
  harness({ manifest: manifestOf(CAPTURING), record: recordOf({ capabilities: ["capture:tab", "input:events"] }), tabs });

const ARM = { tabId: "t1", audio: true, scale: 2, frameRate: 60 } as const;

describe("capture.arm and capture.hold, input.subscribe: the person's grant", () => {
  it("refuses a tab the person never pointed the extension at", async () => {
    const h = granted();
    expect(await dispatch("capture.arm", ARM, h.scope, h.ctx("worker"), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED", message: expect.stringContaining("choose that window") });
    expect(await dispatch("capture.hold", { tabId: "t1" }, h.scope, h.ctx("worker"), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(await dispatch("input.subscribe", { tabId: "t1", kinds: null }, h.scope, h.ctx("worker"), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(h.runtime.captureArm).not.toHaveBeenCalled();
  });

  it("arms on an invocation's tab, from the worker alone", async () => {
    const h = granted();
    h.scope.grantTab("t1");
    expect(await dispatch("capture.arm", ARM, h.scope, h.ctx("panel"), h.runtime)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT", message: expect.stringContaining("works in the worker") });
    expect(await dispatch("capture.arm", ARM, h.scope, h.ctx("worker"), h.runtime)).toEqual({ ok: true, v: { width: 1600, height: 1200 } });
    expect(h.runtime.captureArm).toHaveBeenCalledWith(expect.objectContaining({ context: "worker" }), "t1", { audio: true, scale: 2, frameRate: 60 });
    // The grant is that tab's: another is still refused, and so is an address no extension records.
    expect(await dispatch("capture.arm", { ...ARM, tabId: "t3" }, h.scope, h.ctx("worker"), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    h.scope.grantTab("t2");
    expect(await dispatch("capture.arm", { ...ARM, tabId: "t2" }, h.scope, h.ctx("worker"), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED", message: expect.stringContaining("web pages only") });
  });

  it("takes the panel's list as the person's pick while the panel is open", async () => {
    const h = granted();
    h.scope.grantListed(["t1", "t2", "t3"]);
    expect(await dispatch("capture.hold", { tabId: "t3" }, h.scope, h.ctx("worker"), h.runtime)).toEqual({ ok: true, v: { holdId: 11 } });
    expect(await dispatch("input.subscribe", { tabId: "t3", kinds: ["down", "key"] }, h.scope, h.ctx("worker"), h.runtime)).toEqual({ ok: true, v: { subscriptionId: 21 } });
    h.scope.panelClosed();
    expect(await dispatch("capture.arm", { ...ARM, tabId: "t3" }, h.scope, h.ctx("worker"), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    // …unless it records the tab already (a capture the panel started goes on).
    h.scope.noteLive(["t3"]);
    expect(await dispatch("capture.arm", { ...ARM, tabId: "t3" }, h.scope, h.ctx("worker"), h.runtime)).toMatchObject({ ok: true });
  });

  it("follows the person: while it records anything, the tab in front is its to record too — not one behind", async () => {
    // (The harness's browser says the first tab is the one in front.)
    const tabs = [tabOf("front", "https://github.com/"), tabOf("recorded", "https://linear.app/"), tabOf("behind", "https://example.com/")];
    const h = granted(tabs);
    h.scope.grantTab("recorded");
    // Nothing recorded yet: the tab in front is no more the extension's than any other.
    expect(await dispatch("capture.arm", { ...ARM, tabId: "front" }, h.scope, h.ctx("worker"), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED", message: expect.stringContaining("in front") });
    h.scope.noteLive(["recorded"]);
    expect(await dispatch("capture.hold", { tabId: "front" }, h.scope, h.ctx("worker"), h.runtime)).toEqual({ ok: true, v: { holdId: 11 } });
    expect(await dispatch("input.subscribe", { tabId: "front", kinds: null }, h.scope, h.ctx("worker"), h.runtime)).toEqual({ ok: true, v: { subscriptionId: 21 } });
    expect(await dispatch("capture.arm", { ...ARM, tabId: "front" }, h.scope, h.ctx("worker"), h.runtime)).toMatchObject({ ok: true });
    expect(await dispatch("capture.arm", { ...ARM, tabId: "behind" }, h.scope, h.ctx("worker"), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    // A shell page in front is never recorded, recording or not.
    tabs[0]!.url = "pistachio://home/";
    expect(await dispatch("capture.arm", { ...ARM, tabId: "front" }, h.scope, h.ctx("worker"), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED", message: expect.stringContaining("web pages only") });
  });

  it("lapses when the tab goes to another site", () => {
    const tabs = [tabOf("t1", "https://linear.app/a")];
    const h = granted(tabs);
    h.scope.grantTab("t1");
    expect(h.scope.captureRefusal("capture.tab", "t1")).toBeNull();
    tabs[0]!.url = "https://evil.example/";
    expect(h.scope.captureRefusal("capture.tab", "t1")).not.toBeNull();
  });

  it("takes only kinds there are", async () => {
    const h = granted();
    h.scope.grantTab("t1");
    expect(await dispatch("input.subscribe", { tabId: "t1", kinds: ["keystrokes"] }, h.scope, h.ctx("worker"), h.runtime)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
  });
});

describe("capture.sources", () => {
  it("lists the desk's web pages — never a hidden tab, a shell page or an extension's page — the one in use first", async () => {
    const tabs = [
      tabOf("shell", "pistachio://notes/"),
      tabOf("web", "https://linear.app/"),
      tabOf("ext", "pistachio-ext://dev.other/page.html", "profile-a", { extensionId: "dev.other" }),
      tabOf("hidden", "https://example.com/", "profile-a", { hiddenFor: "conversation-1" }),
      tabOf("used", "https://github.com/", "profile-a"),
    ];
    const h = granted(tabs);
    const windows = tabs.map((tab, z) => ({ tabId: tab.id, box: { x: 0, y: 0, width: 10, height: 10 }, z, inUse: false, minimized: false, pageKind: tab.extensionId !== undefined ? "extension" : tab.url.startsWith("pistachio:") ? "shell" : "page", title: tab.title })) as ExtDeskState["windows"];
    h.browser.desk = (_profile, spaceId) => ({ spaceId, stage: { width: 100, height: 100 }, windows });
    h.browser.activeTabId = () => "used";
    const reply = await dispatch("capture.sources", {}, h.scope, h.ctx("panel"), h.runtime);
    expect(reply).toMatchObject({ ok: true });
    const sources = (reply as { v: { tabId: string; inUse: boolean; still: string | null }[] }).v;
    expect(sources.map((source) => source.tabId)).toEqual(["used", "web"]);
    expect(sources[0]).toMatchObject({ inUse: true, still: null });
  });
});

/* -------------------------------- the book -------------------------------- */

class FakePage implements CapturePage {
  captured = false;
  destroyed = false;
  readonly mainFrame = { name: "tab frame" };
  constructor(readonly id: number) {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isBeingCaptured(): boolean {
    return this.captured;
  }
}

function book() {
  const pages = new Map<string, FakePage>([
    ["t1", new FakePage(101)],
    ["t2", new FakePage(102)],
  ]);
  const capturable = new Set(["t1", "t2"]);
  let now = 0;
  const holds: string[][] = [];
  /**
   * What each worker says it holds live (the guard's sources, one a track): unless a test says otherwise, a track of
   * every page that reports captured; null a worker that does not answer.
   */
  const tracks = new Map<string, string[] | null>();
  const keyOf = (page: FakePage): string => `source-${String(page.id)}`;
  const host: CaptureHost = {
    page: (tabId) => pages.get(tabId) ?? null,
    exists: (tabId) => pages.has(tabId),
    capturable: (_extensionId, tabId) => capturable.has(tabId),
    hold: (tabIds) => holds.push([...tabIds]),
    liveTracks: async (extensionId) => (tracks.has(extensionId) ? (tracks.get(extensionId) as string[] | null) : [...pages.values()].filter((page) => page.captured).map(keyOf)),
    sourceKey: (page) => keyOf(page as FakePage),
    now: () => now,
  };
  const ended = vi.fn();
  const changed = vi.fn();
  const enforced = vi.fn();
  const captures = new CaptureBook(host, { ended, changed, enforce: enforced });
  const worker = { id: 55, frame: { name: "worker frame" } };
  return { captures, pages, capturable, holds, tracks, ended, changed, enforced, worker, advance: (ms: number) => (now += ms) };
}

describe("the capture book", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets one request through, from the armed worker's frame, answered with the tab's frame and its sound", async () => {
    const b = book();
    expect(b.captures.mayCapture("dev.x", b.worker.id)).toBe(false);
    b.captures.arm({ extensionId: "dev.x", tabId: "t1", audio: true, contentsId: b.worker.id, frame: b.worker.frame });
    // Another contents of the extension's (its panel, a page) is not the one armed.
    expect(b.captures.mayCapture("dev.x", 56)).toBe(false);
    expect(b.captures.mayCapture("dev.y", b.worker.id)).toBe(false);
    expect(b.captures.mayCapture("dev.x", b.worker.id)).toBe(true);
    const answer = b.captures.answer("dev.x", { frame: b.worker.frame, audioRequested: true });
    expect(answer).toEqual({ video: b.pages.get("t1")!.mainFrame, audio: b.pages.get("t1")!.mainFrame, enableLocalEcho: true });
    expect(b.captures.capturing("dev.x")).toEqual(["t1"]);
    // Spent: a second request is refused at the permission and at the handler.
    expect(b.captures.mayCapture("dev.x", b.worker.id)).toBe(false);
    expect(b.captures.answer("dev.x", { frame: b.worker.frame, audioRequested: true })).toBeNull();
    b.captures.dispose();
  });

  it("arms one capture at a time: a second arm while one is pending is refused, and allowed once it is spent or lapsed", async () => {
    const b = book();
    expect(b.captures.arm({ extensionId: "dev.x", tabId: "t1", audio: false, contentsId: b.worker.id, frame: b.worker.frame })).toBe(true);
    expect(b.captures.arm({ extensionId: "dev.x", tabId: "t2", audio: false, contentsId: b.worker.id, frame: b.worker.frame })).toBe(false);
    // (Another extension's arm is its own.)
    expect(b.captures.arm({ extensionId: "dev.y", tabId: "t2", audio: false, contentsId: 56, frame: { name: "y" } })).toBe(true);
    // The first is answered with the tab it was for; then a new arm is taken.
    expect(b.captures.answer("dev.x", { frame: b.worker.frame, audioRequested: false })).toEqual({ video: b.pages.get("t1")!.mainFrame, enableLocalEcho: true });
    expect(b.captures.arm({ extensionId: "dev.x", tabId: "t2", audio: false, contentsId: b.worker.id, frame: b.worker.frame })).toBe(true);
    b.advance(10_001);
    expect(b.captures.arm({ extensionId: "dev.x", tabId: "t1", audio: false, contentsId: b.worker.id, frame: b.worker.frame })).toBe(true);
    b.captures.dispose();
  });

  it("refuses a request from another frame, and spends the arm doing so", async () => {
    const b = book();
    b.captures.arm({ extensionId: "dev.x", tabId: "t1", audio: false, contentsId: b.worker.id, frame: b.worker.frame });
    expect(b.captures.answer("dev.x", { frame: { name: "a subframe" }, audioRequested: false })).toBeNull();
    expect(b.captures.answer("dev.x", { frame: null, audioRequested: false })).toBeNull();
    expect(b.captures.capturing("dev.x")).toEqual([]);
    b.captures.dispose();
  });

  it("gives no sound unless the arm asked for it, and no picture after ten seconds", async () => {
    const b = book();
    b.captures.arm({ extensionId: "dev.x", tabId: "t1", audio: false, contentsId: b.worker.id, frame: b.worker.frame });
    expect(b.captures.answer("dev.x", { frame: b.worker.frame, audioRequested: true })).toEqual({ video: b.pages.get("t1")!.mainFrame, enableLocalEcho: true });
    b.captures.arm({ extensionId: "dev.x", tabId: "t2", audio: true, contentsId: b.worker.id, frame: b.worker.frame });
    b.advance(10_001);
    expect(b.captures.mayCapture("dev.x", b.worker.id)).toBe(false);
    expect(b.captures.answer("dev.x", { frame: b.worker.frame, audioRequested: true })).toBeNull();
    b.captures.dispose();
  });

  it("holds an armed and a captured tab, and lets a closed tab's hold and capture go", async () => {
    const b = book();
    const hold = b.captures.hold("dev.x", "t2");
    expect(b.holds.at(-1)).toEqual(["t2"]);
    b.captures.arm({ extensionId: "dev.x", tabId: "t1", audio: false, contentsId: b.worker.id, frame: b.worker.frame });
    expect(b.holds.at(-1)).toEqual(["t1", "t2"]);
    b.captures.answer("dev.x", { frame: b.worker.frame, audioRequested: false });
    expect(b.captures.held().sort()).toEqual(["t1", "t2"]);
    // Both tabs close.
    b.pages.clear();
    await b.captures.check();
    expect(b.ended).toHaveBeenCalledWith("dev.x", "t1", "closed");
    expect(b.captures.held()).toEqual([]);
    expect(b.holds.at(-1)).toEqual([]);
    // (A release of a hold already gone does nothing.)
    b.captures.release("dev.x", hold);
    expect(b.ended).toHaveBeenCalledTimes(1);
    b.captures.dispose();
  });

  it("ends a capture once the page is no longer captured, or goes where it may not be recorded", async () => {
    const b = book();
    b.captures.arm({ extensionId: "dev.x", tabId: "t1", audio: false, contentsId: b.worker.id, frame: b.worker.frame });
    b.captures.answer("dev.x", { frame: b.worker.frame, audioRequested: false });
    // Starting: not captured yet, within the grace — still live.
    await b.captures.check();
    expect(b.captures.capturing("dev.x")).toEqual(["t1"]);
    b.pages.get("t1")!.captured = true;
    await b.captures.check();
    b.pages.get("t1")!.captured = false;
    await b.captures.check();
    expect(b.ended).toHaveBeenLastCalledWith("dev.x", "t1", "stopped");
    // One that never starts ends after the grace.
    b.captures.arm({ extensionId: "dev.x", tabId: "t2", audio: false, contentsId: b.worker.id, frame: b.worker.frame });
    b.captures.answer("dev.x", { frame: b.worker.frame, audioRequested: false });
    b.pages.get("t2")!.captured = true;
    b.capturable.delete("t2");
    await b.captures.check();
    expect(b.ended).toHaveBeenLastCalledWith("dev.x", "t2", "navigated");
    b.captures.dispose();
  });

  it("ends the capture of a tab whose last hold is released", async () => {
    const b = book();
    const hold = b.captures.hold("dev.x", "t1");
    b.captures.arm({ extensionId: "dev.x", tabId: "t1", audio: false, contentsId: b.worker.id, frame: b.worker.frame });
    b.captures.answer("dev.x", { frame: b.worker.frame, audioRequested: false });
    b.pages.get("t1")!.captured = true;
    b.captures.release("dev.y", hold);
    expect(b.captures.capturing("dev.x")).toEqual(["t1"]);
    b.captures.release("dev.x", hold);
    expect(b.ended).toHaveBeenCalledWith("dev.x", "t1", "released");
    // Still held while its stream runs; let go once the page is no longer captured.
    expect(b.captures.held()).toEqual(["t1"]);
    b.pages.get("t1")!.captured = false;
    await b.captures.check();
    expect(b.captures.held()).toEqual([]);
    b.captures.dispose();
  });

  it("refuses a new capture of a tab whose capture is ending: the ending one keeps its deadline, and Stop ends in the kill", async () => {
    const b = book();
    b.captures.arm({ extensionId: "dev.x", tabId: "t1", audio: false, contentsId: b.worker.id, frame: b.worker.frame });
    b.captures.answer("dev.x", { frame: b.worker.frame, audioRequested: false });
    b.pages.get("t1")!.captured = true;
    await b.captures.check();
    b.captures.end("dev.x", "stop");
    expect(b.captures.ending("dev.x", "t1")).toBe(true);
    // The worker asks for the tab again at once: no arm, and an answer to a request that got through is a refusal.
    expect(b.captures.arm({ extensionId: "dev.x", tabId: "t1", audio: false, contentsId: b.worker.id, frame: b.worker.frame })).toBe(false);
    b.captures.arm({ extensionId: "dev.x", tabId: "t2", audio: false, contentsId: b.worker.id, frame: b.worker.frame });
    b.captures.disarm("dev.x");
    expect(b.captures.ending("dev.x", "t1")).toBe(true);
    // The deadline stands: past the grace main ends the tracks, and past the next kills the worker.
    b.advance(CAPTURE_END_GRACE_MS + 1);
    await b.captures.check();
    expect(b.enforced).toHaveBeenCalledWith("dev.x", "t1", "end", "source-101");
    b.advance(CAPTURE_KILL_GRACE_MS + 1);
    await b.captures.check();
    expect(b.enforced).toHaveBeenCalledWith("dev.x", "t1", "kill", "source-101");
    expect(b.captures.ending("dev.x", "t1")).toBe(false);
    b.captures.dispose();
  });

  it("keeps a capture told to end listed until its worker holds no track; one that goes on is ended by main, then its worker killed", async () => {
    const b = book();
    b.captures.arm({ extensionId: "dev.x", tabId: "t1", audio: false, contentsId: b.worker.id, frame: b.worker.frame });
    b.captures.answer("dev.x", { frame: b.worker.frame, audioRequested: false });
    b.pages.get("t1")!.captured = true;
    await b.captures.check();
    // The person's Stop: the worker is told once, and the capture stays listed (the pill up) while it holds its track.
    b.captures.end("dev.x", "stop");
    expect(b.ended).toHaveBeenCalledWith("dev.x", "t1", "stop");
    expect(b.captures.capturing("dev.x")).toEqual(["t1"]);
    b.captures.end("dev.x", "stop");
    b.advance(1_000);
    await b.captures.check();
    expect(b.ended).toHaveBeenCalledTimes(1);
    expect(b.captures.capturing("dev.x")).toEqual(["t1"]);
    expect(b.enforced).not.toHaveBeenCalled();
    // An honest runtime stopped its tracks: the worker holds none (the page's own count, every capturer's, may say what it likes), and the capture is gone.
    b.tracks.set("dev.x", []);
    await b.captures.check();
    expect(b.captures.capturing("dev.x")).toEqual([]);
    expect(b.enforced).not.toHaveBeenCalled();
    // One that keeps its track past the grace: main ends it itself, and it stays listed until the worker holds none.
    b.tracks.delete("dev.x");
    b.captures.arm({ extensionId: "dev.x", tabId: "t2", audio: false, contentsId: b.worker.id, frame: b.worker.frame });
    b.captures.answer("dev.x", { frame: b.worker.frame, audioRequested: false });
    b.pages.get("t2")!.captured = true;
    b.capturable.delete("t2");
    await b.captures.check();
    expect(b.ended).toHaveBeenLastCalledWith("dev.x", "t2", "navigated");
    expect(b.captures.capturing("dev.x")).toEqual(["t2"]);
    b.advance(CAPTURE_END_GRACE_MS - 1);
    await b.captures.check();
    expect(b.enforced).not.toHaveBeenCalled();
    b.advance(1);
    await b.captures.check();
    expect(b.enforced).toHaveBeenLastCalledWith("dev.x", "t2", "end", "source-102");
    expect(b.captures.capturing("dev.x")).toEqual(["t2"]);
    b.tracks.set("dev.x", []);
    await b.captures.check();
    expect(b.captures.capturing("dev.x")).toEqual([]);
    expect(b.enforced).toHaveBeenCalledTimes(1);
    b.captures.dispose();
  });

  it("kills the worker of a capture still held after main ended its tracks, and one whose worker gives no answer", async () => {
    const b = book();
    const run = async (): Promise<void> => {
      b.captures.arm({ extensionId: "dev.x", tabId: "t1", audio: false, contentsId: b.worker.id, frame: b.worker.frame });
      b.captures.answer("dev.x", { frame: b.worker.frame, audioRequested: false });
      b.pages.get("t1")!.captured = true;
      await b.captures.check();
      b.captures.end("dev.x", "stop");
    };
    await run();
    b.advance(CAPTURE_END_GRACE_MS);
    await b.captures.check();
    expect(b.enforced).toHaveBeenLastCalledWith("dev.x", "t1", "end", "source-101");
    b.advance(CAPTURE_KILL_GRACE_MS - 1);
    await b.captures.check();
    expect(b.enforced).toHaveBeenCalledTimes(1);
    expect(b.captures.capturing("dev.x")).toEqual(["t1"]);
    b.advance(1);
    await b.captures.check();
    expect(b.enforced).toHaveBeenLastCalledWith("dev.x", "t1", "kill", "source-101");
    expect(b.captures.capturing("dev.x")).toEqual([]);
    // A worker that does not answer (hung) is taken as holding: ended, then killed.
    b.tracks.set("dev.x", null);
    await run();
    b.advance(CAPTURE_END_GRACE_MS);
    await b.captures.check();
    expect(b.enforced).toHaveBeenLastCalledWith("dev.x", "t1", "end", "source-101");
    b.advance(CAPTURE_KILL_GRACE_MS);
    await b.captures.check();
    expect(b.enforced).toHaveBeenLastCalledWith("dev.x", "t1", "kill", "source-101");
    expect(b.enforced).toHaveBeenCalledTimes(4);
    b.captures.dispose();
  });

  it("tells one capture's tracks from another's by their source: the one told to end is over when its own are, the other untouched", async () => {
    const b = book();
    for (const tabId of ["t1", "t2"]) {
      b.captures.arm({ extensionId: "dev.x", tabId, audio: false, contentsId: b.worker.id, frame: b.worker.frame });
      b.captures.answer("dev.x", { frame: b.worker.frame, audioRequested: false });
      b.pages.get(tabId)!.captured = true;
    }
    await b.captures.check();
    expect(b.captures.capturing("dev.x").sort()).toEqual(["t1", "t2"]);
    // Told to end t1; the worker stopped t1's track honestly and still holds t2's, while t1's page says captured (another capturer, or Playwright).
    b.captures.end("dev.x", "stop", "t1");
    b.tracks.set("dev.x", ["source-102"]);
    await b.captures.check();
    expect(b.captures.capturing("dev.x")).toEqual(["t2"]);
    expect(b.enforced).not.toHaveBeenCalled();
    // t2 told, its track kept: the enforcement names its source alone.
    b.captures.end("dev.x", "stop", "t2");
    b.advance(CAPTURE_END_GRACE_MS);
    await b.captures.check();
    expect(b.enforced).toHaveBeenLastCalledWith("dev.x", "t2", "end", "source-102");
    b.captures.dispose();
  });

  it("forgets an extension whole when its worker goes", async () => {
    const b = book();
    b.captures.hold("dev.x", "t2");
    b.captures.arm({ extensionId: "dev.x", tabId: "t1", audio: false, contentsId: b.worker.id, frame: b.worker.frame });
    b.captures.answer("dev.x", { frame: b.worker.frame, audioRequested: false });
    b.advance(CAPTURE_START_GRACE_MS);
    b.captures.forget("dev.x", "worker");
    expect(b.ended).toHaveBeenCalledWith("dev.x", "t1", "worker");
    expect(b.captures.held()).toEqual([]);
    b.captures.dispose();
  });

  it("lets a hold lapse with the extension's access to its tab, and releases the holds a view took when the view goes", async () => {
    const b = book();
    b.captures.hold("dev.x", "t1", 77);
    b.captures.hold("dev.x", "t2", 78);
    expect(b.captures.held().sort()).toEqual(["t1", "t2"]);
    // Off in t2's Profile (or t2 at an address it may not see): what it may not record it may not keep awake.
    b.capturable.delete("t2");
    await b.captures.check();
    expect(b.captures.held()).toEqual(["t1"]);
    // The page that took t1's hold closed or reloaded: its release went with its document, so main lets go for it.
    b.captures.releaseOwned("dev.x", 78);
    expect(b.captures.held()).toEqual(["t1"]);
    b.captures.releaseOwned("dev.x", 77);
    expect(b.captures.held()).toEqual([]);
    b.captures.dispose();
  });

  it("takes a worker holding no track as a capture stopped, after the start grace", async () => {
    const b = book();
    b.tracks.set("dev.x", []);
    b.captures.arm({ extensionId: "dev.x", tabId: "t1", audio: false, contentsId: b.worker.id, frame: b.worker.frame });
    b.captures.answer("dev.x", { frame: b.worker.frame, audioRequested: false });
    // Playwright, a live share: the page's own count says captured; the worker holds nothing yet (its stream a few ms behind).
    b.pages.get("t1")!.captured = true;
    await b.captures.check();
    expect(b.captures.capturing("dev.x")).toEqual(["t1"]);
    b.advance(CAPTURE_START_GRACE_MS + 1);
    await b.captures.check();
    expect(b.ended).toHaveBeenLastCalledWith("dev.x", "t1", "stopped");
    expect(b.captures.capturing("dev.x")).toEqual([]);
    b.captures.dispose();
  });
});

describe("the chooser", () => {
  it("is the open panel of the extension's, opened by the person and in view — never one the worker opened on its own, nor one veiled, nor another context", () => {
    const base = { context: "panel", extensionId: "dev.x", openPanel: "dev.x", byPerson: true, shown: true };
    expect(panelIsChooser(base)).toBe(true);
    expect(panelIsChooser({ ...base, byPerson: false })).toBe(false);
    expect(panelIsChooser({ ...base, shown: false })).toBe(false);
    expect(panelIsChooser({ ...base, openPanel: "dev.other" })).toBe(false);
    expect(panelIsChooser({ ...base, openPanel: null })).toBe(false);
    expect(panelIsChooser({ ...base, context: "worker" })).toBe(false);
    expect(panelIsChooser({ ...base, context: "page" })).toBe(false);
  });
});

describe("the pictures capture.sources comes with", () => {
  it("are every window's from the open chooser, and elsewhere only a granted or recorded window's", () => {
    const sources = [{ tabId: "t1" }, { tabId: "t2" }, { tabId: "t3" }];
    const allowed = (tabId: string): boolean => tabId === "t2";
    expect(picturedSources(sources, true, allowed).map((source) => source.tabId)).toEqual(["t1", "t2", "t3"]);
    // The worker, a page, the panel closed: a list of pictures of the desk is a screenshot no one asked for.
    expect(picturedSources(sources, false, allowed).map((source) => source.tabId)).toEqual(["t2"]);
    expect(picturedSources(sources, false, () => false)).toEqual([]);
  });
});

describe("the stills handed back", () => {
  it("go only to a source still allowed once they came, and still on the site that was listed", () => {
    const pictured = [
      { tabId: "t1", url: "https://a.example/one" },
      { tabId: "t2", url: "https://b.example/" },
      { tabId: "t3", url: "https://c.example/" },
      { tabId: "t4", url: "https://d.example/" },
    ];
    const stills = new Map([
      ["t1", "data:1"],
      ["t2", "data:2"],
      ["t3", "data:3"],
    ]);
    const urls: Record<string, string | null> = { t1: "https://a.example/two", t2: "https://elsewhere.example/", t3: "https://c.example/", t4: "https://d.example/" };
    const kept = keepStills(pictured, stills, (source) => source.tabId !== "t3", (tabId) => urls[tabId] ?? null);
    // t1: another page of the same site, still allowed; t2: went to another site; t3: no longer allowed; t4: no picture came.
    expect([...kept]).toEqual([["t1", "data:1"]]);
    // A tab gone meanwhile shows nothing either.
    expect([...keepStills(pictured, stills, () => true, () => null)]).toEqual([]);
  });
});

describe("the status pill", () => {
  it("is main's while an extension records and says nothing of its own", () => {
    expect(statusPillFor(null, "Recorder", { capturing: true, watching: true })).toEqual({ text: "● Recording · Recorder", actions: [{ id: "stop", title: "Stop" }] });
    expect(statusPillFor(null, "Recorder", { capturing: false, watching: true })).toEqual({ text: "● Watching input · Recorder", actions: [{ id: "stop", title: "Stop" }] });
    expect(statusPillFor(null, "Recorder", { capturing: false, watching: false })).toBeNull();
  });

  it("is the extension's own, marked, when it sets one while recording", () => {
    expect(statusPillFor({ text: "0:42", actions: [{ id: "pause", title: "Pause" }] }, "Recorder", { capturing: true, watching: false })).toEqual({
      text: "● 0:42",
      actions: [
        { id: "pause", title: "Pause" },
        { id: "stop", title: "Stop" },
      ],
    });
    expect(statusPillFor({ text: "● 0:42", actions: [{ id: "stop", title: "■" }] }, "Recorder", { capturing: true, watching: false })).toEqual({ text: "● 0:42", actions: [{ id: "stop", title: "■" }] });
    expect(statusPillFor({ text: "Synced" }, "Inbox", { capturing: false, watching: false })).toEqual({ text: "Synced", actions: [] });
  });
});

describe("the size a capture asks for", () => {
  it("is the page's at the scale, at most 3840 on its longest side, in even px", () => {
    expect(captureSize({ width: 800, height: 600 }, 2)).toEqual({ width: 1600, height: 1200 });
    expect(captureSize({ width: 801, height: 601 }, 1)).toEqual({ width: 802, height: 602 });
    expect(captureSize({ width: 2560, height: 1440 }, 2)).toEqual({ width: 3840, height: 2160 });
  });
});
