import { EventEmitter } from "node:events";
import type { CDPSession, Page } from "playwright-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MirrorServerMessage } from "@pistachio/dom-mirror";
import { TabMirror } from "../../src/sessions/mirror/tab-mirror.js";
import { AssetBroker } from "../../src/sessions/mirror/asset-broker.js";

const snapshot = {
  kind: "snapshot", documentId: "document", epoch: 1, url: "https://fixture.invalid/", base: "https://fixture.invalid/",
  title: "Fixture", root: { t: "doc", id: 1, c: [] }, focus: null, width: 800, height: 600, nodes: 1,
};
const cleanups: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanups.splice(0).forEach(close => close()); vi.useRealTimers(); });

function setup() {
  const evaluate = vi.fn().mockResolvedValue(snapshot);
  const frame = {};
  const page = Object.assign(new EventEmitter(), { evaluate, mainFrame: () => frame });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const sent: MirrorServerMessage[] = [];
  const mirror = new TabMirror({ page: page as unknown as Page, session: {} as CDPSession,
    tabId: "tab", control: "control", broker: new AssetBroker(), log });
  cleanups.push(() => mirror.dispose());
  const viewer = { send: (message: MirrorServerMessage): void => { sent.push(message); } };
  return { page, frame, evaluate, mirror, sent, viewer, log };
}

it("retries a destroyed execution context even when no later load event arrives", async () => {
  const { evaluate, mirror, viewer, sent } = setup();
  evaluate.mockRejectedValueOnce(new Error("Execution context was destroyed, most likely because of a navigation"));
  const attached = mirror.attach(viewer);
  await vi.advanceTimersByTimeAsync(100);
  await attached;
  expect(evaluate).toHaveBeenCalledTimes(2);
  expect(sent.map(message => message.k)).toEqual(["snapshot"]);
});

it("retries a recorder that is briefly absent from a newly created document", async () => {
  const { evaluate, mirror, viewer, sent } = setup();
  evaluate.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
  const attached = mirror.attach(viewer);
  await vi.advanceTimersByTimeAsync(300);
  await attached;
  expect(evaluate).toHaveBeenCalledTimes(3);
  expect(sent.map(message => message.k)).toEqual(["snapshot"]);
});

it("reports a persistent recorder exception immediately without exposing page text", async () => {
  const { evaluate, mirror, viewer, sent, log } = setup();
  evaluate.mockRejectedValueOnce(new Error("private page text"));
  await mirror.attach(viewer);
  expect(sent).toEqual([{ k: "unsuitable", reason: "error", detail: "startup-record" }]);
  expect(JSON.stringify(log.warn.mock.calls)).not.toContain("private page text");
  expect(evaluate).toHaveBeenCalledTimes(1);
});

it("does not emit a stale snapshot if navigation happens while capture is pending", async () => {
  const { page, frame, evaluate, mirror, viewer, sent } = setup();
  let resolve!: (value: unknown) => void;
  evaluate.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const attached = mirror.attach(viewer);
  await vi.advanceTimersByTimeAsync(0);
  evaluate.mockResolvedValueOnce("new-document");
  page.emit("framenavigated", frame);
  page.emit("domcontentloaded");
  resolve({ ...snapshot, title: "Old private document" });
  await attached;
  await vi.advanceTimersByTimeAsync(0);
  expect(evaluate).toHaveBeenCalledTimes(3); // Includes the document-identity probe.
  expect(sent.filter(message => message.k === "snapshot")).toMatchObject([{ title: "Fixture", epoch: 3 }]);
  expect(JSON.stringify(sent)).not.toContain("Old private document");
});

it("bounds a stalled capture and allows a new resync without waiting for the old evaluation", async () => {
  const { evaluate, mirror, viewer, sent, log } = setup();
  let resolve!: (value: unknown) => void;
  evaluate.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const attached = mirror.attach(viewer);
  await vi.advanceTimersByTimeAsync(8_000);
  await attached;
  expect(sent).toEqual([{ k: "unsuitable", reason: "error", detail: "startup-record" }]);
  expect(log.warn).toHaveBeenCalledWith("DOM mirror startup failed", expect.objectContaining({ timeout: true, stage: "record" }));
  await mirror.handle({ k: "resync" }, viewer);
  resolve({ ...snapshot, title: "Late old result" });
  await vi.advanceTimersByTimeAsync(0);
  expect(sent.filter(message => message.k === "snapshot")).toMatchObject([{ title: "Fixture", epoch: 2 }]);
});

it("abandons pending retries when the last viewer leaves", async () => {
  const { evaluate, mirror, viewer, sent } = setup();
  evaluate.mockResolvedValueOnce(undefined);
  const attached = mirror.attach(viewer);
  await vi.advanceTimersByTimeAsync(0);
  mirror.detach(viewer);
  await vi.advanceTimersByTimeAsync(300);
  await attached;
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(sent).toEqual([]);
});

it("reports an invalid recorder response instead of letting the viewer time out", async () => {
  const { evaluate, mirror, viewer, sent } = setup();
  evaluate.mockResolvedValueOnce({ kind: "snapshot", root: "invalid" });
  await mirror.attach(viewer);
  expect(sent).toEqual([{ k: "unsuitable", reason: "error", detail: "startup-validate" }]);
});

it("does not let a stalled navigation identity probe prevent a fresh snapshot", async () => {
  const { page, frame, evaluate, mirror, viewer, sent } = setup();
  await mirror.attach(viewer);
  evaluate.mockReturnValueOnce(new Promise(() => undefined));
  page.emit("framenavigated", frame);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sent.filter(message => message.k === "snapshot")).toMatchObject([{ epoch: 1 }, { epoch: 2 }]);
});
