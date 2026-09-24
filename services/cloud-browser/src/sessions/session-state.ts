/**
 * The sealed session record (docs/web-browser-design.md §9).
 *
 * A browser session is durable: it exists before, during and after any
 * conversation, and it must survive the worker that happened to be holding it
 * (W4, W9). What makes that true is this one workspace document —
 * `browser-session:<spaceId>`, sealed under the account workspace key like
 * every other personal record — holding the tabs, the split groups, the
 * shelf, the active tab and the per-origin zoom. Portable scroll and bounded
 * textarea checkpoints can be restored; the JavaScript heap and arbitrary
 * application state remain tied to the running Chromium context.
 *
 * Writes are debounced by a second because the state changes on every title
 * tick, and the hub should not see one record per keystroke of a page's
 * `document.title`.
 */

import {
  readBrowserSessionState,
  type BrowserSessionState,
} from "@pistachio/shell-contracts/tab-session";
import type { BrowserSessionRecord } from "@pistachio/sync-protocol";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import type { WorkspaceToolStore } from "../sync/workspace-tools.js";

export const DEFAULT_STATE_DEBOUNCE_MS = 1_000;

export interface SessionStateStoreOptions {
  workspace: WorkspaceToolStore;
  spaceId: string;
  /**
   * Fold anything the STORED record holds that this session has not seen into
   * what is about to be written (§6.3, moving a tab between Spaces). The
   * register has two writers — the Space handing a tab over, and this session
   * — and last-writer-wins with no merge is how the handed tab vanished from
   * both.
   */
  merge?: (stored: unknown, pending: BrowserSessionState) => BrowserSessionState;
  debounceMs?: number;
  now?: () => number;
  log?: Logger;
}

export class SessionStateStore {
  readonly #workspace: WorkspaceToolStore;
  readonly #spaceId: string;
  readonly #debounceMs: number;
  readonly #now: () => number;
  readonly #log: Logger;
  #timer: NodeJS.Timeout | null = null;
  #pending: BrowserSessionState | null = null;
  #stopped = false;
  /** False until `read()` proves publishing cannot lose anything. */
  #writable = false;
  readonly #merge: ((stored: unknown, pending: BrowserSessionState) => BrowserSessionState) | null;

  constructor(options: SessionStateStoreOptions) {
    this.#workspace = options.workspace;
    this.#spaceId = options.spaceId;
    this.#merge = options.merge ?? null;
    this.#debounceMs = options.debounceMs ?? DEFAULT_STATE_DEBOUNCE_MS;
    this.#now = options.now ?? ((): number => Date.now());
    this.#log = options.log ?? silentLogger;
  }

  /**
   * The stored state, or null when there is none this build can use.
   *
   * Reading also decides whether this session may ever WRITE. The record is
   * one last-writer-wins register, so a worker that reads nothing and then
   * publishes an empty session deletes every tab on every device — and
   * "reads nothing" covers three very different things:
   *
   *  - nothing is stored: publishing is right, and this is the only case
   *    that is;
   *  - a record written by a NEWER build (a version this one does not know):
   *    publishing over it loses whatever that build added, so this session
   *    browses but never writes;
   *  - a record this build could read only by dropping something — a
   *    permission name it does not know, a two-hundred-and-first tab: the
   *    tabs are restored, and the pruned copy is never written back.
   */
  read(): BrowserSessionState | null {
    const record = this.#workspace.browserSession(this.#spaceId);
    const read = readBrowserSessionState(record, this.#spaceId);
    if (read.kind === "none") {
      this.#writable = true;
      // The first web visit adopts the native checkpoint after both cookie
      // and workspace hydration. Newer cloud records and unreadable records
      // are protected by the checks below.
      return this.#workspace.desktopSession?.(this.#spaceId) ?? null;
    }
    if (read.kind === "unreadable") {
      this.#writable = false;
      this.#log.warn("browser session record could not be read; this session will not publish", {
        spaceId: this.#spaceId,
        reason: read.reason,
      });
      return null;
    }
    this.#writable = !read.pruned;
    if (read.pruned) {
      this.#log.warn("browser session record carried more than this build knows; it will not be rewritten", {
        spaceId: this.#spaceId,
      });
    }
    const desktop = this.desktopHandoff();
    return desktop === null ? read.state : { ...read.state, tabs: desktop.tabs, activeTabId: desktop.activeTabId, splitGroups: desktop.splitGroups, updatedAt: desktop.updatedAt };
  }

  /** Only a strictly newer desktop checkpoint can replace an idle web session. */
  desktopHandoff(): BrowserSessionState | null {
    if (!this.#writable) return null;
    const desktop = this.#workspace.desktopSession?.(this.#spaceId) ?? null;
    const cloud = this.#workspace.browserSession(this.#spaceId);
    return desktop !== null && desktop.updatedAt > (cloud?.updatedAt ?? 0) ? desktop : null;
  }

  /** Whether a read has proved this session may publish (see `read`). */
  get writable(): boolean {
    return this.#writable;
  }

  /** Queue a publish; repeated calls within the window collapse into one. */
  publish(state: BrowserSessionState): void {
    // No publish before a read has proved there is nothing to lose. A session
    // that reached here without `read()` — a claim that failed halfway, a
    // test — must not be the one that decides what the record says.
    if (this.#stopped || !this.#writable) return;
    this.#pending = { ...state, updatedAt: this.#now() };
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#write();
    }, this.#debounceMs);
    this.#timer.unref();
  }

  /**
   * Write whatever is queued now. The suspend path calls this before it lets
   * go of the lease: a session that is about to stop existing on this worker
   * must have its record on the hub first, or the next claim rebuilds a
   * session a minute out of date.
   */
  async flush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#write();
    await this.#workspace.settled();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  #write(): void {
    const pending = this.#pending;
    this.#pending = null;
    if (pending === null || !this.#writable) return;
    try {
      // Read the register one last time before overwriting it: another
      // Space may have handed this one a tab since the debounce began.
      const merged = this.#merge === null ? pending : this.#merge(this.#workspace.browserSession(this.#spaceId), pending);
      // The record type and this one are held together by the parity test in
      // packages/shell-contracts/test/record-docs.test.ts, so the assignment
      // is checked rather than asserted.
      const record: BrowserSessionRecord = merged;
      this.#workspace.putBrowserSession(record);
    } catch (error) {
      this.#log.warn("browser session record could not be published", {
        spaceId: this.#spaceId,
        error: errorMessage(error),
      });
    }
  }
}
