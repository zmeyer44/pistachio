/**
 * The shell's IPC gate (docs/extensions.md §6.2, "The shell's IPC"): defence
 * in depth under every `pistachio:*` handler main registers.
 *
 * The shell's preload runs in the shell's main frame alone, so a frame inside
 * the shell (a note's widget, an embed) has no way to send on a `pistachio:*`
 * channel — today. The gate keeps that true whatever changes later: a
 * message on one of those channels whose sender is the shell but whose frame
 * is not the shell's main frame is refused, and so is one from any extension
 * context (an extension's preload exposes `pistachio-ext:*` alone). A refused
 * `handle` throws to the caller; a refused `on` is dropped (a synchronous one
 * is answered null, so no renderer is left blocked on it).
 *
 * Installed once, BEFORE installIpc(): it wraps `ipcMain`'s registration
 * methods, so every handler registered afterwards — in index.ts or in any
 * module — passes through it. Only registration is wrapped; nothing in main
 * removes a `pistachio:*` listener by reference.
 */

export const GATED_PREFIX = "pistachio:";

/** The part of an IPC event the gate reads. */
export interface GateEvent {
  sender: { id: number; mainFrame: unknown };
  senderFrame: unknown;
  returnValue?: unknown;
}

/** The part of `ipcMain` the gate wraps. */
export interface GateIpc {
  handle(channel: string, listener: (event: never, ...args: never[]) => unknown): void;
  handleOnce(channel: string, listener: (event: never, ...args: never[]) => unknown): void;
  on(channel: string, listener: (event: never, ...args: never[]) => void): unknown;
  once(channel: string, listener: (event: never, ...args: never[]) => void): unknown;
  addListener(channel: string, listener: (event: never, ...args: never[]) => void): unknown;
}

export interface GateJudge {
  /** The shell window's contents id, or null while there is none. */
  shellId(): number | null;
  /** A sender that is an extension's context (main/extensions/views.ts). */
  isExtension?(senderId: number): boolean;
}

/** Whether a message on `channel` from this event may reach its handler. */
export function gateAllows(channel: string, event: GateEvent, judge: GateJudge): boolean {
  if (!channel.startsWith(GATED_PREFIX)) return true;
  const sender = event.sender;
  if (judge.isExtension?.(sender.id) === true) return false;
  const shell = judge.shellId();
  if (shell === null || sender.id !== shell) return true;
  return event.senderFrame !== null && event.senderFrame !== undefined && event.senderFrame === sender.mainFrame;
}

type Listener = (event: GateEvent, ...args: unknown[]) => unknown;

/** Wrap `ipc`'s registration methods so every gated channel's handler is guarded. Returns the undo (for tests). */
export function installIpcGate(ipc: GateIpc, judge: GateJudge): () => void {
  const target = ipc as unknown as Record<string, (channel: string, listener: Listener) => unknown>;
  const originals = new Map<string, (channel: string, listener: Listener) => unknown>();
  const invoked = (name: string): ((channel: string, listener: Listener) => unknown) => {
    const original = target[name]!.bind(ipc);
    originals.set(name, target[name]!);
    return original;
  };
  for (const name of ["handle", "handleOnce"] as const) {
    const original = invoked(name);
    target[name] = (channel: string, listener: Listener) =>
      original(channel, channel.startsWith(GATED_PREFIX)
        ? (event: GateEvent, ...args: unknown[]) => {
            if (!gateAllows(channel, event, judge)) throw new Error(`${channel} is refused from this frame.`);
            return listener(event, ...args);
          }
        : listener);
  }
  for (const name of ["on", "once", "addListener"] as const) {
    const original = invoked(name);
    target[name] = (channel: string, listener: Listener) =>
      original(channel, channel.startsWith(GATED_PREFIX)
        ? (event: GateEvent, ...args: unknown[]) => {
            if (gateAllows(channel, event, judge)) return listener(event, ...args);
            // A synchronous message waits on a reply: it gets null, never the handler's answer.
            try {
              event.returnValue = null;
            } catch {
              // An asynchronous message has no reply to give.
            }
            return undefined;
          }
        : listener);
  }
  return () => {
    for (const [name, original] of originals) target[name] = original;
  };
}
