/**
 * The shell socket's wire shapes (docs/web-browser-design.md §5). The point of
 * these is the refusal path: a decoder must answer null for anything it cannot
 * use, because the alternative is a socket that dies of one bad frame.
 */

import { describe, expect, it } from "vitest";
import { IPC, SHELL_EVENT_CHANNELS, SHELL_METHOD_NAMES } from "../src/ipc.js";
import {
  decodeShellClientFrame,
  decodeShellServerFrame,
  encodeShellClientFrame,
  encodeShellServerFrame,
  MAX_UPLOAD_BYTES,
  shellEventMemberOf,
  SOCKET_EVENT_CHANNELS,
  SOCKET_METHOD_NAMES,
  STREAM_EVENT_CHANNELS,
  STREAM_METHOD_NAMES,
  streamEventMemberOf,
  type ShellClientFrame,
  type ShellServerFrame,
} from "../src/socket.js";

const FRAME = {
  data: "aGVsbG8=",
  width: 800,
  height: 600,
  metadata: {
    deviceWidth: 800,
    deviceHeight: 600,
    pageScaleFactor: 1,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
  },
};

function roundTripServer(frame: ShellServerFrame): ShellServerFrame | null {
  return decodeShellServerFrame(encodeShellServerFrame(frame));
}

function roundTripClient(frame: ShellClientFrame): ShellClientFrame | null {
  return decodeShellClientFrame(encodeShellClientFrame(frame));
}

describe("server frames", () => {
  it("round-trips the challenge that comes before any state", () => {
    const frame = { t: "challenge", spaceId: "work", nonce: "bm9uY2U=" } as const;
    expect(roundTripServer(frame)).toEqual(frame);
  });

  it("round-trips ready with the control holder and generation", () => {
    const frame = {
      t: "ready",
      sessionId: "11111111-1111-4111-8111-111111111111",
      control: { holder: "human", generation: 3 },
    } as const;
    expect(roundTripServer(frame)).toEqual(frame);
  });

  it("round-trips both halves of a reply", () => {
    const ok = { t: "reply", id: "7", ok: true, result: { tabs: [] } } as const;
    expect(roundTripServer(ok)).toEqual(ok);
    const refused = {
      t: "reply",
      id: "8",
      ok: false,
      error: { code: "unsupported", message: "no passkeys on the web" },
    } as const;
    expect(roundTripServer(refused)).toEqual(refused);
  });

  it("round-trips an event on a snapshot channel", () => {
    const frame = {
      t: "event",
      channel: IPC.snapshotChanged,
      payload: { tabs: [], activeTabId: null },
    } as const;
    expect(roundTripServer(frame)).toEqual(frame);
  });

  it("round-trips a pane frame, which is a live frame plus its tab", () => {
    const frame = { t: "frame", tabId: "tab-1", ...FRAME } as const;
    expect(roundTripServer(frame)).toEqual(frame);
  });

  it("round-trips a control change and a socket error", () => {
    const control = { t: "control", holder: "agent", generation: 4 } as const;
    expect(roundTripServer(control)).toEqual(control);
    const error = { t: "error", code: "lease_lost", message: "the worker let go" } as const;
    expect(roundTripServer(error)).toEqual(error);
  });

  it("refuses a channel no on* member of ShellApi listens on", () => {
    // A transport maps events by channel; an unknown one has no listener and
    // must not be passed on as though it did.
    expect(
      decodeShellServerFrame(
        JSON.stringify({ t: "event", channel: "pistachio:drag-sample", payload: 1 }),
      ),
    ).toBeNull();
  });

  it("refuses an error code outside the closed set", () => {
    expect(
      decodeShellServerFrame(JSON.stringify({ t: "error", code: "teapot", message: "no" })),
    ).toBeNull();
  });

  it("answers null for text that is not JSON, and for a frame with no t", () => {
    expect(decodeShellServerFrame("{")).toBeNull();
    expect(decodeShellServerFrame(JSON.stringify({ spaceId: "work" }))).toBeNull();
    expect(decodeShellServerFrame(42)).toBeNull();
  });
});

describe("client frames", () => {
  it("round-trips the Space-key proof", () => {
    const frame = { t: "auth", proof: "cHJvb2Y=" } as const;
    expect(roundTripClient(frame)).toEqual(frame);
  });

  it("round-trips a call over a ShellApi method", () => {
    const frame: ShellClientFrame = {
      t: "call",
      id: "1",
      method: "createTab",
      args: ["https://example.com"],
    };
    expect(roundTripClient(frame)).toEqual(frame);
  });

  it("refuses a method that is not in ShellApi", () => {
    // The host answers an unknown method `unsupported` rather than closing, so
    // a client that sends one is the one that must be stopped here.
    expect(
      decodeShellClientFrame(JSON.stringify({ t: "call", id: "1", method: "setLayout", args: [] })),
    ).toBeNull();
    expect(
      decodeShellClientFrame(JSON.stringify({ t: "call", id: "1", method: "onSnapshot", args: [] })),
    ).toBeNull();
  });

  it("round-trips a pane's CSS size and its visibility", () => {
    const frame = {
      t: "pane",
      tabId: "tab-1",
      width: 640,
      height: 480,
      dpr: 2,
      visible: false,
    } as const;
    expect(roundTripClient(frame)).toEqual(frame);
  });

  it("round-trips mouse and key input under a generation", () => {
    const mouse = {
      t: "input",
      tabId: "tab-1",
      generation: 2,
      event: {
        kind: "mouse",
        type: "mousePressed",
        x: 10,
        y: 20,
        button: "left",
        clickCount: 1,
        modifiers: 0,
      },
    } as const;
    expect(roundTripClient(mouse)).toEqual(mouse);
    const key = {
      t: "input",
      tabId: "tab-1",
      generation: 2,
      event: { kind: "key", type: "keyDown", key: "a", code: "KeyA", modifiers: 0 },
    } as const;
    expect(roundTripClient(key)).toEqual(key);
  });

  it("refuses input with no generation, which the host could not date", () => {
    expect(
      decodeShellClientFrame(
        JSON.stringify({
          t: "input",
          tabId: "tab-1",
          event: { kind: "key", type: "keyDown", key: "a", code: "KeyA", modifiers: 0 },
        }),
      ),
    ).toBeNull();
  });
});

describe("shellEventMemberOf", () => {
  it("names the member a channel belongs to", () => {
    expect(shellEventMemberOf(IPC.snapshotChanged)).toBe("onSnapshot");
    expect(shellEventMemberOf(IPC.runChanged)).toBe("onRun");
  });

  it("answers null for a channel no member listens on", () => {
    expect(shellEventMemberOf(IPC.dragSample)).toBeNull();
    expect(shellEventMemberOf("nothing")).toBeNull();
  });
});

describe("the method list the RPC envelope is built from", () => {
  it("is the one exported from the contract", () => {
    expect(SHELL_METHOD_NAMES).toContain("createTab");
    expect(SHELL_METHOD_NAMES).not.toContain("setLayout");
  });
});

describe("the stream surface (docs/web-browser-design.md §11)", () => {
  it("carries every StreamShellApi call over the same envelope", () => {
    for (const method of STREAM_METHOD_NAMES) {
      const frame: ShellClientFrame = { t: "call", id: "7", method, args: [] };
      expect(roundTripClient(frame), method).toEqual(frame);
    }
  });

  it("carries every StreamShellApi event on its own channel", () => {
    for (const entry of STREAM_EVENT_CHANNELS) {
      const frame: ShellServerFrame = {
        t: "event",
        channel: entry.channel,
        payload: { tabId: "web:1" },
      };
      expect(roundTripServer(frame), entry.channel).toEqual(frame);
    }
  });

  it("round-trips an upload the pane collected from a native file input", () => {
    const frame: ShellClientFrame = {
      t: "call",
      id: "9",
      method: "provideFiles",
      args: ["req-1", [{ name: "note.txt", type: "text/plain", base64: "aGk=" }]],
    };
    expect(roundTripClient(frame)).toEqual(frame);
  });

  it("names the member a stream channel belongs to, and nothing else", () => {
    expect(streamEventMemberOf("pistachio:file-request")).toBe("onFileRequest");
    expect(streamEventMemberOf("pistachio:clipboard-copy")).toBe("onClipboardCopy");
    expect(streamEventMemberOf("pistachio:context-menu")).toBe("onContextMenu");
    expect(streamEventMemberOf(IPC.snapshotChanged)).toBeNull();
    // The two surfaces stay separable: a ShellApi channel is not a stream one.
    expect(shellEventMemberOf("pistachio:file-request")).toBeNull();
  });

  it("keeps the two method lists disjoint, and the union is what the socket accepts", () => {
    const shell = new Set<string>(SHELL_METHOD_NAMES);
    for (const method of STREAM_METHOD_NAMES) {
      expect(shell.has(method), `${method} is in both surfaces`).toBe(false);
    }
    expect(SOCKET_METHOD_NAMES).toEqual([...SHELL_METHOD_NAMES, ...STREAM_METHOD_NAMES]);
    expect(SOCKET_EVENT_CHANNELS).toHaveLength(SHELL_EVENT_CHANNELS.length + STREAM_EVENT_CHANNELS.length);
  });

  it("still refuses a method in neither surface", () => {
    expect(
      decodeShellClientFrame(JSON.stringify({ t: "call", id: "1", method: "provideFile", args: [] })),
    ).toBeNull();
  });

  it("bounds one upload at 32 MiB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(32 * 1024 * 1024);
  });
});
