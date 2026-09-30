/**
 * Main's line to the desk the shell draws (docs/desk-agent.md §3). Only the
 * shell knows where a desk's windows are — its engine lays them out frame
 * by frame — so the agent's desk tools ask it: a request with an id goes out
 * on `pistachio:desk-request`, and the shell answers with `deskReply(id, …)`.
 * A shell that never answers (reloaded, the desk gone) is a timeout, and a
 * timeout is an ordinary failed reply the tool reports.
 */

import { randomUUID } from "node:crypto";
import { isDeskReply, type DeskReply, type DeskRequest } from "@pistachio/shell-contracts/desk-agent";

/** Long enough for an arrangement to settle in the engine, short enough that a stuck shell does not hold a turn. */
export const DESK_REPLY_TIMEOUT_MS = 5_000;

export class DeskBridge {
  readonly #send: (id: string, request: DeskRequest) => boolean;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, { resolve(reply: DeskReply): void; timer: NodeJS.Timeout }>();

  /** `send` delivers a request to the shell, and says false when there is no shell to deliver it to. */
  constructor(send: (id: string, request: DeskRequest) => boolean, timeoutMs = DESK_REPLY_TIMEOUT_MS) {
    this.#send = send;
    this.#timeoutMs = timeoutMs;
  }

  request(request: DeskRequest): Promise<DeskReply> {
    const id = randomUUID();
    return new Promise<DeskReply>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ ok: false, error: "the desk did not answer" });
      }, this.#timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, timer });
      if (!this.#send(id, request)) this.#settle(id, { ok: false, error: "no desk is open" });
    });
  }

  /** The shell's answer. Anything that is not a reply to a request still waiting is dropped. */
  reply(id: unknown, reply: unknown): void {
    if (typeof id !== "string") return;
    this.#settle(id, isDeskReply(reply) ? reply : { ok: false, error: "the desk sent an unreadable reply" });
  }

  /** Every request still waiting fails now: the shell that would answer them went away. */
  cancelAll(error = "the desk closed"): void {
    for (const id of [...this.#pending.keys()]) this.#settle(id, { ok: false, error });
  }

  #settle(id: string, reply: DeskReply): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(reply);
  }
}
