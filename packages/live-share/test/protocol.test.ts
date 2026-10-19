import { describe, expect, it } from "vitest";
import {
  LIVE_COLORS,
  LIVE_REACTIONS,
  LIVE_TOPICS,
  LiveProtocolError,
  MAX_CHAT_HISTORY,
  MAX_STROKES,
  decodeMessage,
  destinationsOf,
  encodeMessage,
  encodeText,
  isLiveTopic,
  parseParticipantMetadata,
  hostNameFrom,
  sanitizeName,
  senderAllowed,
  strokeOwner,
  type LiveDeskFrame,
  type LiveSenderRole,
  type LiveSync,
  type LiveTopic,
} from "../src/index.js";

const desk: LiveDeskFrame = {
  v: 1,
  seq: 7,
  stage: { w: 1440, h: 900 },
  hostPresent: true,
  space: { title: "Launch plan", color: "#46A758" },
  windows: [
    {
      id: "tab-1",
      kind: "page",
      title: "GitHub",
      origin: "github.com",
      favicon: "https://github.com/favicon.ico",
      frame: { x: 40, y: 40, w: 800, h: 600 },
      page: { x: 40, y: 72, w: 800, h: 568 },
      focused: true,
      minimized: false,
      controllable: true,
      track: "win:tab-1",
      paused: false,
    },
  ],
};

/** One valid body per topic, and the roles that may send it. */
const SAMPLES: { [T in LiveTopic]: unknown } = {
  "lv.desk": desk,
  "lv.cursor": { x: 0.5, y: 0.25, tool: "pointer", down: false },
  "lv.ink": { op: "begin", id: "g_abc:1", tool: "pen", color: "#E54D2E", size: 0.0025, pts: [0.1, 0.2, 0.3, 0.4] },
  "lv.ping": { x: 0.1, y: 0.9 },
  "lv.react": { emoji: "🎉" },
  "lv.chat": { id: "m1", text: "hello" },
  "lv.hello": {},
  "lv.sync": { desk, strokes: [], chat: [], grants: [] },
  "lv.guests": { guests: ["g_abc", "g_def"] },
  "lv.input": { w: "tab-1", e: { type: "mouseDown", x: 0.5, y: 0.5, button: "left", buttons: 1, clickCount: 1, modifiers: [] } },
  "lv.ask": { w: "tab-1" },
  "lv.grant": { w: "tab-1", user: "g_abc" },
  "lv.refused": { w: "tab-1" },
  "lv.knock": { requestId: "Rq_123", name: "Ana" },
};

const ROLES: LiveSenderRole[] = ["host", "guest", "server"];

describe("topics", () => {
  it("follows the §4 table for who may send what", () => {
    const allowed = Object.fromEntries(
      (Object.keys(LIVE_TOPICS) as LiveTopic[]).map((topic) => [topic, ROLES.filter((role) => senderAllowed(topic, role))]),
    );
    expect(allowed).toEqual({
      "lv.desk": ["host"],
      "lv.cursor": ["host", "guest"],
      "lv.ink": ["host", "guest"],
      "lv.ping": ["host", "guest"],
      "lv.react": ["host", "guest"],
      "lv.chat": ["host", "guest"],
      "lv.hello": ["guest"],
      "lv.sync": ["host"],
      "lv.guests": ["host"],
      "lv.input": ["guest"],
      "lv.ask": ["guest"],
      "lv.grant": ["host"],
      "lv.refused": ["host"],
      "lv.knock": ["server"],
    });
  });

  it("sends what §4 addresses to the host to the host alone, whoever the sender names", () => {
    const topics = Object.keys(LIVE_TOPICS) as LiveTopic[];
    expect(topics.filter((topic) => destinationsOf(topic, ["g_bo"])?.join() === "host")).toEqual(["lv.hello", "lv.input", "lv.ask", "lv.knock"]);
    // Named nobody, or an empty list (everyone, to LiveKit): still the host alone.
    expect(destinationsOf("lv.input", undefined)).toEqual(["host"]);
    expect(destinationsOf("lv.input", [])).toEqual(["host"]);
    // Everything else goes where the sender says.
    expect(destinationsOf("lv.chat", undefined)).toBeUndefined();
    expect(destinationsOf("lv.sync", ["g_ana"])).toEqual(["g_ana"]);
  });

  it("keeps a guest's word within the host and the guests the host lists, whoever it names", () => {
    const within = ["host", "g_ana"];
    // For everyone: those it is with, never everyone in the room.
    expect(destinationsOf("lv.chat", undefined, within)).toEqual(["host", "g_ana"]);
    // Named outside them: left out; nobody left is nobody (the caller sends nothing).
    expect(destinationsOf("lv.ink", ["g_ana", "g_stranger"], within)).toEqual(["g_ana"]);
    expect(destinationsOf("lv.ink", ["g_stranger"], within)).toEqual([]);
    // What is the host's alone stays the host's.
    expect(destinationsOf("lv.input", ["g_ana"], within)).toEqual(["host"]);
  });

  it("is lossy only for cursors", () => {
    const lossy = (Object.keys(LIVE_TOPICS) as LiveTopic[]).filter((topic) => !LIVE_TOPICS[topic].reliable);
    expect(lossy).toEqual(["lv.cursor"]);
  });

  it("knows its own topics and nothing else", () => {
    expect(isLiveTopic("lv.desk")).toBe(true);
    expect(isLiveTopic("lv.nope")).toBe(false);
    expect(isLiveTopic("toString")).toBe(false);
    expect(isLiveTopic(undefined)).toBe(false);
  });
});

describe("encode / decode", () => {
  for (const topic of Object.keys(SAMPLES) as LiveTopic[]) {
    it(`round-trips ${topic} from every allowed sender and drops it from the rest`, () => {
      const bytes = encodeMessage(topic, SAMPLES[topic] as never);
      for (const role of ROLES) {
        const decoded = decodeMessage(topic, bytes, role);
        if (senderAllowed(topic, role)) expect(decoded).toEqual(SAMPLES[topic]);
        else expect(decoded).toBeNull();
      }
    });
  }

  it("decodes the text of a text stream as well as packet bytes", () => {
    const text = encodeText("lv.sync", SAMPLES["lv.sync"] as LiveSync);
    expect(decodeMessage("lv.sync", text, "host")).toEqual(SAMPLES["lv.sync"]);
  });

  it("refuses to encode a body that breaks its schema", () => {
    expect(() => encodeMessage("lv.ping", { x: 2, y: 0 })).toThrow(LiveProtocolError);
    expect(() => encodeMessage("lv.react", { emoji: "💩" as never })).toThrow(LiveProtocolError);
  });

  it("drops bad JSON, bad UTF-8 and wrong shapes", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(decodeMessage("lv.ping", bytes("{"), "guest")).toBeNull();
    expect(decodeMessage("lv.ping", new Uint8Array([0x7b, 0xff, 0x7d]), "guest")).toBeNull();
    expect(decodeMessage("lv.ping", bytes('{"x":0.5}'), "guest")).toBeNull();
    expect(decodeMessage("lv.ping", bytes('{"x":-0.1,"y":0.5}'), "guest")).toBeNull();
    expect(decodeMessage("lv.cursor", bytes('{"x":0.5,"y":0.5,"tool":"brush"}'), "guest")).toBeNull();
    expect(decodeMessage("lv.ink", bytes('{"op":"add","id":"g_a:1","pts":[0.1]}'), "guest")).toBeNull();
    expect(decodeMessage("lv.ink", bytes('{"op":"begin","id":"no-number","tool":"pen","color":"#000000","size":0.01,"pts":[0,0]}'), "guest")).toBeNull();
    expect(decodeMessage("lv.chat", bytes('{"id":"m1","text":"   "}'), "guest")).toBeNull();
    expect(decodeMessage("lv.desk", bytes(JSON.stringify({ ...desk, v: 2 })), "host")).toBeNull();
  });

  it("drops a body over its topic's size before reading it", () => {
    const huge = JSON.stringify({ id: "m1", text: "x".repeat(20_000) });
    expect(decodeMessage("lv.chat", huge, "guest")).toBeNull();
    const tooLong = JSON.stringify({ id: "m1", text: "x".repeat(2001) });
    expect(decodeMessage("lv.chat", tooLong, "guest")).toBeNull();
    expect(decodeMessage("lv.chat", JSON.stringify({ id: "m1", text: "x".repeat(2000) }), "guest")).not.toBeNull();
  });

  it("bounds ink messages to 64 pairs and syncs to the board and history caps", () => {
    const pts = Array.from({ length: 130 }, () => 0.5);
    expect(decodeMessage("lv.ink", JSON.stringify({ op: "add", id: "g_a:1", pts }), "guest")).toBeNull();
    expect(decodeMessage("lv.ink", JSON.stringify({ op: "add", id: "g_a:1", pts: pts.slice(0, 128) }), "guest")).not.toBeNull();
    const stroke = { id: "host:1", tool: "pen", color: "#3E63DD", size: 0.002, pts: [0.1, 0.1], done: true };
    const entry = { id: "m", from: "g_a", name: "Ana", color: "#E54D2E", text: "hi", at: 1 };
    const sync = (strokes: number, chat: number) =>
      JSON.stringify({ desk: null, strokes: Array.from({ length: strokes }, () => stroke), chat: Array.from({ length: chat }, () => entry), grants: [] });
    expect(decodeMessage("lv.sync", sync(MAX_STROKES, MAX_CHAT_HISTORY), "host")).not.toBeNull();
    expect(decodeMessage("lv.sync", sync(MAX_STROKES + 1, 0), "host")).toBeNull();
    expect(decodeMessage("lv.sync", sync(0, MAX_CHAT_HISTORY + 1), "host")).toBeNull();
  });

  it("only takes https: and data:image/ favicons", () => {
    const withFavicon = (favicon: string) => JSON.stringify({ ...desk, windows: [{ ...desk.windows[0], favicon }] });
    expect(decodeMessage("lv.desk", withFavicon("data:image/png;base64,AAAA"), "host")).not.toBeNull();
    expect(decodeMessage("lv.desk", withFavicon("javascript:alert(1)"), "host")).toBeNull();
    expect(decodeMessage("lv.desk", withFavicon("http://example.com/x.ico"), "host")).toBeNull();
    expect(decodeMessage("lv.desk", withFavicon(`data:image/png;base64,${"A".repeat(5000)}`), "host")).toBeNull();
  });

  it("takes only the reactions on the list", () => {
    for (const emoji of LIVE_REACTIONS) expect(decodeMessage("lv.react", JSON.stringify({ emoji }), "guest")).toEqual({ emoji });
    expect(decodeMessage("lv.react", JSON.stringify({ emoji: "🦄" }), "guest")).toBeNull();
  });

  it("takes input events of every kind and rejects bad ones", () => {
    const input = (e: unknown) => JSON.stringify({ w: "tab-1", e });
    const mods = { modifiers: ["meta"] };
    expect(decodeMessage("lv.input", input({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 120, ...mods }), "guest")).not.toBeNull();
    expect(decodeMessage("lv.input", input({ type: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 5000, ...mods }), "guest")).toBeNull();
    expect(decodeMessage("lv.input", input({ type: "keyDown", key: "a", code: "KeyA", ...mods }), "guest")).not.toBeNull();
    expect(decodeMessage("lv.input", input({ type: "keyDown", key: "a", code: "KeyA", modifiers: ["hyper"] }), "guest")).toBeNull();
    expect(decodeMessage("lv.input", input({ type: "char", text: "é" }), "guest")).not.toBeNull();
    expect(decodeMessage("lv.input", input({ type: "char", text: "👍🏽" }), "guest")).not.toBeNull();
    expect(decodeMessage("lv.input", input({ type: "char", text: "\r" }), "guest")).not.toBeNull();
    expect(decodeMessage("lv.input", input({ type: "char", text: "ab" }), "guest")).toBeNull();
    expect(decodeMessage("lv.input", input({ type: "char", text: "\u0007" }), "guest")).toBeNull();
    // A char carries Shift alone: never ⌥, ⌘ or Ctrl, and Shift once.
    expect(decodeMessage("lv.input", input({ type: "char", text: "\r", modifiers: ["shift"] }), "guest")?.e).toEqual({ type: "char", text: "\r", modifiers: ["shift"] });
    for (const modifiers of [["alt"], ["meta"], ["control"], ["shift", "meta"], ["shift", "shift"]]) {
      expect(decodeMessage("lv.input", input({ type: "char", text: "v", modifiers }), "guest")).toBeNull();
    }
    expect(decodeMessage("lv.input", input({ type: "insertText", text: "y".repeat(2000) }), "guest")).not.toBeNull();
    expect(decodeMessage("lv.input", input({ type: "insertText", text: "y".repeat(2001) }), "guest")).toBeNull();
    expect(decodeMessage("lv.input", input({ type: "mouseDown", x: 1.5, y: 0, buttons: 1, clickCount: 1, modifiers: [] }), "guest")).toBeNull();
    expect(decodeMessage("lv.input", input({ type: "drop", x: 0, y: 0 }), "guest")).toBeNull();
  });
});

describe("hostNameFrom", () => {
  it("reads whose Mac it is off the name macOS gives it, and nobody's from a name that says none", () => {
    expect(hostNameFrom("Zach's MacBook Pro")).toBe("Zach");
    expect(hostNameFrom("Claudius’s Mac mini")).toBe("Claudius");
    expect(hostNameFrom("Ana  María’s iMac")).toBe("Ana María");
    // The network name macOS derives (what Node's hostname() gives) has lost the apostrophe: no one to name.
    expect(hostNameFrom("Claudiuss-Mac-mini")).toBeNull();
    expect(hostNameFrom("Studio")).toBeNull();
    expect(hostNameFrom(`${"x".repeat(41)}'s Mac`)).toBeNull();
  });
});

describe("sanitizeName", () => {
  it("trims, strips controls and bidi overrides, collapses spaces", () => {
    expect(sanitizeName("  Ana  ")).toBe("Ana");
    expect(sanitizeName("A\u0000n\u0007a")).toBe("Ana");
    expect(sanitizeName("Zach‮gnp.exe")).toBe("Zachgnp.exe");
    expect(sanitizeName("Mary \t\n Jane")).toBe("Mary Jane");
    expect(sanitizeName("Zoë 🦊")).toBe("Zoë 🦊");
  });

  it("takes 1 to 40 characters, counted as characters", () => {
    expect(sanitizeName("")).toBeNull();
    expect(sanitizeName(" \u0000 ")).toBeNull();
    expect(sanitizeName("x".repeat(40))).toBe("x".repeat(40));
    expect(sanitizeName("x".repeat(41))).toBeNull();
    // 40 astral characters are 80 UTF-16 units and still fit.
    expect(sanitizeName("🦊".repeat(40))).toBe("🦊".repeat(40));
  });
});

describe("participant metadata", () => {
  it("reads control's metadata and nothing else", () => {
    expect(parseParticipantMetadata('{"role":"guest","color":"#E54D2E"}')).toEqual({ role: "guest", color: "#E54D2E" });
    expect(parseParticipantMetadata('{"role":"admin","color":"#E54D2E"}')).toBeNull();
    expect(parseParticipantMetadata('{"role":"host","color":"red"}')).toBeNull();
    expect(parseParticipantMetadata("not json")).toBeNull();
    expect(parseParticipantMetadata("")).toBeNull();
    expect(parseParticipantMetadata(undefined)).toBeNull();
  });
});

describe("palette", () => {
  it("has eight distinct colours, the host's first", () => {
    expect(LIVE_COLORS).toHaveLength(8);
    expect(new Set(LIVE_COLORS.map((color) => color.toLowerCase())).size).toBe(8);
    for (const color of LIVE_COLORS) expect(color).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("reads a stroke's owner from its id", () => {
    expect(strokeOwner("g_abc:12")).toBe("g_abc");
    expect(strokeOwner("host:0")).toBe("host");
    expect(strokeOwner("nocolon")).toBeNull();
  });
});
