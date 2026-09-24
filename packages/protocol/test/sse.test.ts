import { describe, expect, it } from "vitest";
import { SseParser } from "../src/index.js";

describe("SseParser", () => {
  it("frames id/event/data, joins multi-line data, and drops comments", () => {
    const parser = new SseParser();
    const frames = parser.push('id: 7\nevent: run\ndata: {"a":\ndata: 1}\n\n: ping\n\nid: 8\ndata: x\n\n');
    expect(frames).toEqual([
      { id: "7", event: "run", data: '{"a":\n1}' },
      { id: "8", event: null, data: "x" },
    ]);
  });

  it("completes frames split across chunks at any byte, with CRLF line ends", () => {
    const parser = new SseParser();
    const text = "id: 1\r\nevent: run\r\ndata: {\"seq\":1}\r\n\r\nevent: end\r\ndata: {\"status\":\"completed\"}\r\n\r\n";
    const frames = [];
    for (const chunk of text.match(/.{1,7}/gs) ?? []) frames.push(...parser.push(chunk));
    expect(frames).toEqual([
      { id: "1", event: "run", data: '{"seq":1}' },
      { id: null, event: "end", data: '{"status":"completed"}' },
    ]);
  });

  it("dispatches only on a blank line and only with data", () => {
    const parser = new SseParser();
    expect(parser.push("event: run\n\n")).toEqual([]);
    expect(parser.push("data: pending")).toEqual([]);
    expect(parser.push("\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ id: null, event: null, data: "pending" }]);
  });

  // The SSE spec drops an `id:` field carrying a NUL: the field is ignored
  // rather than the frame, and the last event id simply does not move.
  it("ignores an id that carries a NUL", () => {
    const parser = new SseParser();
    expect(parser.push("id: a\u0000b\ndata: x\n\n")).toEqual([{ id: null, event: null, data: "x" }]);
  });
});
