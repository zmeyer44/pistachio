import { describe, expect, it } from "vitest";
import { gateAllows, installIpcGate, type GateEvent, type GateIpc } from "../src/main/ipc-gate";

/** An ipcMain stand-in: registered listeners by channel, and a way to deliver a message to them. */
function fakeIpc() {
  const handlers = new Map<string, (event: GateEvent, ...args: unknown[]) => unknown>();
  const listeners = new Map<string, Array<(event: GateEvent, ...args: unknown[]) => unknown>>();
  const ipc = {
    handle: (channel: string, listener: (event: GateEvent, ...args: unknown[]) => unknown) => void handlers.set(channel, listener),
    handleOnce: (channel: string, listener: (event: GateEvent, ...args: unknown[]) => unknown) => void handlers.set(channel, listener),
    on: (channel: string, listener: (event: GateEvent, ...args: unknown[]) => unknown) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      return ipc;
    },
    once: (channel: string, listener: (event: GateEvent, ...args: unknown[]) => unknown) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      return ipc;
    },
    addListener: (channel: string, listener: (event: GateEvent, ...args: unknown[]) => unknown) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      return ipc;
    },
  };
  return {
    ipc: ipc as unknown as GateIpc,
    invoke: (channel: string, event: GateEvent, ...args: unknown[]) => handlers.get(channel)!(event, ...args),
    send: (channel: string, event: GateEvent, ...args: unknown[]) => {
      for (const listener of listeners.get(channel) ?? []) listener(event, ...args);
    },
  };
}

const MAIN_FRAME = { name: "main" };
const SUBFRAME = { name: "sub" };
const shellEvent = (frame: unknown): GateEvent => ({ sender: { id: 1, mainFrame: MAIN_FRAME }, senderFrame: frame });
const tabEvent = (frame: unknown): GateEvent => ({ sender: { id: 2, mainFrame: MAIN_FRAME }, senderFrame: frame });

describe("the IPC gate", () => {
  const judge = { shellId: () => 1, isExtension: (id: number) => id === 3 };

  it("lets the shell's main frame through and refuses its subframes", () => {
    expect(gateAllows("pistachio:snapshot", shellEvent(MAIN_FRAME), judge)).toBe(true);
    expect(gateAllows("pistachio:snapshot", shellEvent(SUBFRAME), judge)).toBe(false);
    expect(gateAllows("pistachio:snapshot", shellEvent(null), judge)).toBe(false);
  });

  it("leaves other senders and other channels to their handlers", () => {
    // A tab's subframe on the Shields channel is the tab preload's own question.
    expect(gateAllows("pistachio:shields-frame", tabEvent(SUBFRAME), judge)).toBe(true);
    expect(gateAllows("pistachio-ext:call", shellEvent(SUBFRAME), judge)).toBe(true);
  });

  it("refuses an extension context on every pistachio: channel", () => {
    expect(gateAllows("pistachio:snapshot", { sender: { id: 3, mainFrame: MAIN_FRAME }, senderFrame: MAIN_FRAME }, judge)).toBe(false);
  });

  it("throws for a refused handle and runs an allowed one", async () => {
    const fake = fakeIpc();
    installIpcGate(fake.ipc, judge);
    fake.ipc.handle("pistachio:notes", (() => "answer") as never);
    expect(fake.invoke("pistachio:notes", shellEvent(MAIN_FRAME))).toBe("answer");
    expect(() => fake.invoke("pistachio:notes", shellEvent(SUBFRAME))).toThrow(/refused/);
  });

  it("drops a refused on() and answers a sync one null", () => {
    const fake = fakeIpc();
    installIpcGate(fake.ipc, judge);
    const heard: unknown[] = [];
    fake.ipc.on("pistachio:bounds", ((_event: GateEvent, value: unknown) => heard.push(value)) as never);
    fake.send("pistachio:bounds", shellEvent(MAIN_FRAME), 1);
    const refused = shellEvent(SUBFRAME);
    refused.returnValue = "unset";
    fake.send("pistachio:bounds", refused, 2);
    expect(heard).toEqual([1]);
    expect(refused.returnValue).toBeNull();
  });

  it("does not wrap channels outside pistachio:", () => {
    const fake = fakeIpc();
    installIpcGate(fake.ipc, judge);
    const listener = () => "ext";
    fake.ipc.handle("pistachio-ext:call", listener as never);
    expect(fake.invoke("pistachio-ext:call", shellEvent(SUBFRAME))).toBe("ext");
  });

  it("undoes itself", () => {
    const fake = fakeIpc();
    const before = fake.ipc.handle;
    const undo = installIpcGate(fake.ipc, judge);
    expect(fake.ipc.handle).not.toBe(before);
    undo();
    expect(fake.ipc.handle).toBe(before);
  });
});
