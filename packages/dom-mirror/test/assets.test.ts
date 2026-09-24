import { describe, expect, it } from "vitest";
import {
  AssetAssembler,
  decodeAssetChunk,
  encodeAssetChunk,
  isStylesheetType,
  mirrorClientMessageSchema,
  mirrorServerMessageSchema,
  recorderReportSchema,
} from "../src/index.js";

describe("asset chunks", () => {
  it("round-trips a chunk and refuses anything that is not one", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const encoded = encodeAssetChunk({ tabId: "t", id: "a1", type: "image/png", offset: 0, total: 4 }, bytes);
    const decoded = decodeAssetChunk(encoded);
    expect(decoded?.header).toEqual({ tabId: "t", id: "a1", type: "image/png", offset: 0, total: 4 });
    expect([...(decoded?.bytes ?? [])]).toEqual([1, 2, 3, 4]);
    expect(decodeAssetChunk(new Uint8Array([0, 1]))).toBeNull();
    expect(decodeAssetChunk(new TextEncoder().encode("PMA1xxxx{}"))).toBeNull();
    // A chunk that claims more than its total.
    const lying = encodeAssetChunk({ tabId: "t", id: "a1", type: "", offset: 3, total: 4 }, bytes);
    expect(decodeAssetChunk(lying)).toBeNull();
  });

  it("reassembles chunks that arrive out of order and interleaved", () => {
    const assembler = new AssetAssembler();
    const a = new TextEncoder().encode("hello world");
    const b = new TextEncoder().encode("xy");
    const chunk = (id: string, whole: Uint8Array, from: number, to: number): Uint8Array =>
      encodeAssetChunk({ tabId: "t", id, type: "text/plain", offset: from, total: whole.byteLength }, whole.subarray(from, to));
    expect(assembler.receive(chunk("a", a, 6, 11))).toBeNull();
    expect(assembler.receive(chunk("b", b, 0, 2))?.id).toBe("b");
    expect(assembler.inFlight).toBe(1);
    const done = assembler.receive(chunk("a", a, 0, 6));
    expect(done?.id).toBe("a");
    expect(new TextDecoder().decode(done?.bytes)).toBe("hello world");
    expect(assembler.inFlight).toBe(0);
  });

  it("knows a stylesheet by its content type", () => {
    expect(isStylesheetType("text/css; charset=utf-8")).toBe(true);
    expect(isStylesheetType("image/png")).toBe(false);
  });
});

describe("schemas", () => {
  it("accepts a recorder snapshot and refuses a node without an id", () => {
    const ok = recorderReportSchema.safeParse({
      kind: "snapshot",
      url: "https://a.example/",
      base: "https://a.example/",
      title: "A",
      root: { t: "doc", id: 1, c: [{ t: "e", id: 2, tag: "html", c: [{ t: "t", id: 3, s: "hi" }] }] },
      focus: null,
      width: 800,
      height: 600,
      nodes: 3,
    });
    expect(ok.success).toBe(true);
    const bad = recorderReportSchema.safeParse({ kind: "patch", ops: [{ o: "add", p: 1, b: null, n: { t: "e", tag: "div" } }] });
    expect(bad.success).toBe(false);
  });

  it("bounds the client's pointer message", () => {
    const base = { k: "pointer", frame: "main", epoch: 1, id: 4, type: "mousePressed", fx: 0.5, fy: 0.5, x: 1, y: 1, button: "left", clickCount: 1, modifiers: 0 };
    expect(mirrorClientMessageSchema.safeParse(base).success).toBe(true);
    expect(mirrorClientMessageSchema.safeParse({ ...base, fx: 9 }).success).toBe(false);
    expect(mirrorClientMessageSchema.safeParse({ ...base, button: "trigger" }).success).toBe(false);
  });

  it("accepts every server message kind", () => {
    for (const message of [
      { k: "patch", frame: "main", epoch: 1, seq: 1, ops: [{ o: "txt", id: 3, s: "x" }] },
      { k: "frameGone", frame: "f1" },
      { k: "edited", frame: "main", epoch: 1, seq: 1, id: 3, rev: 2, v: "edited" },
      { k: "unsuitable", reason: "webgl" },
      { k: "assetMissing", id: "a" },
      { k: "stopped" },
    ]) {
      expect(mirrorServerMessageSchema.safeParse(message).success, JSON.stringify(message)).toBe(true);
    }
  });
});
