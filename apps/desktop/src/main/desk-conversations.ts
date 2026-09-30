/**
 * Which conversation each tab group's desk opens (docs/desk-agent.md §1,
 * "Conversations"): group → thread, one file in user data. A group's own
 * conversation is the one it started or the one the person chose to
 * continue there; one thread may be several groups' (a conversation
 * continued in another group stays the first group's too). Local to this
 * Mac, like the threads themselves.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTabGroupId } from "@pistachio/shell-contracts/tab-groups";

/** Far more groups than a person keeps; past it the oldest bindings go. */
export const MAX_DESK_BINDINGS = 500;

const RUN_ID = /^[a-z0-9][a-z0-9-]{0,127}$/i;

export class DeskConversationStore {
  readonly #path: string | null;
  /** In the order they were made, oldest first: a Map keeps insertion order, and a rebinding moves to the end. */
  readonly #bindings = new Map<string, string>();

  /** `userDataDir` null: bindings live only in memory (tests, the demo). */
  constructor(userDataDir: string | null) {
    this.#path = userDataDir === null ? null : join(userDataDir, "desk-conversations.json");
    this.#load();
  }

  get(groupId: string): string | null {
    return this.#bindings.get(groupId) ?? null;
  }

  bind(groupId: string, runId: string): void {
    if (!isTabGroupId(groupId) || !RUN_ID.test(runId)) return;
    if (this.#bindings.get(groupId) === runId) return;
    this.#bindings.delete(groupId);
    this.#bindings.set(groupId, runId);
    while (this.#bindings.size > MAX_DESK_BINDINGS) this.#bindings.delete(this.#bindings.keys().next().value!);
    this.#save();
  }

  unbind(groupId: string): void {
    if (this.#bindings.delete(groupId)) this.#save();
  }

  /** A thread was deleted: no group opens it any more. */
  forgetRun(runId: string): void {
    let changed = false;
    for (const [groupId, bound] of this.#bindings) {
      if (bound !== runId) continue;
      this.#bindings.delete(groupId);
      changed = true;
    }
    if (changed) this.#save();
  }

  #load(): void {
    if (this.#path === null || !existsSync(this.#path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
      if (typeof raw !== "object" || raw === null || (raw as { version?: unknown }).version !== 1) return;
      const bindings = (raw as { bindings?: unknown }).bindings;
      if (!Array.isArray(bindings)) return;
      for (const entry of bindings) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [groupId, runId] = entry as unknown[];
        if (typeof groupId === "string" && typeof runId === "string" && isTabGroupId(groupId) && RUN_ID.test(runId)) this.#bindings.set(groupId, runId);
      }
    } catch {
      // An unreadable file is no bindings: each desk opens a fresh conversation.
    }
  }

  #save(): void {
    if (this.#path === null) return;
    const temp = `${this.#path}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, bindings: [...this.#bindings] }), { mode: 0o600 });
      renameSync(temp, this.#path);
    } catch {
      // A full disk loses the binding, not the conversation: it is still in the list.
    }
  }
}
