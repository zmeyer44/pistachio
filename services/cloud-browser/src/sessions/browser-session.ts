/**
 * One persistent browser session, live on this worker
 * (docs/web-browser-design.md §6.1).
 *
 * W4 is the whole shape of this object: the session is durable and exists
 * before, during and after any conversation; a run attaches to its tabs and
 * holds authority only while it runs; a viewer is one web tab attached to it,
 * and the session outlives every viewer. So the Chromium context, the sync
 * engine and the `ShellHost` hang off the session, and the sockets come and
 * go against it.
 */

import type { RunContentEvent, RunSummary } from "@pistachio/protocol";
import {
  fromBase64,
  fromUtf8,
  open,
  runEventSealAad,
  runThreadSealAad,
  shellProofSealAad,
  type SpaceKeys,
} from "@pistachio/sync-protocol";
import { desktopThreadRun, parseContentEvent } from "@pistachio/shell-contracts/run-fold";
import type { ShellControl } from "@pistachio/shell-contracts/socket";
import type { WebSocket } from "ws";
import type { ControlClient } from "../control-client.js";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import { ShellHost, type IntentModelFactory, type SessionSpace, type ShellRunGateway } from "./shell-host.js";
import { currentViewer } from "./viewer-context.js";
import { SessionDownloads } from "./downloads.js";
import { SessionStateStore } from "./session-state.js";

export interface BrowserSessionOptions {
  id: string;
  userId: string;
  spaceId: string;
  space: SessionSpace;
  keys: SpaceKeys;
  /** The lease this worker holds, for the heartbeat and the release. */
  leaseToken: string;
  /** Control, for the console's lease-authenticated run routes (§8). */
  controlClient?: ControlClient | null;
  /** The device the viewer attached as: the audit actor for every run command. */
  viewerDeviceId?: string | null;
  control?: ShellControl;
  activeRunId?: string | null;
  /** `CLOUD_BROWSER_STATE_DIR`; a session with none keeps no downloads (§11). */
  stateDir?: string | null;
  version?: string;
  chromeVersion?: () => string;
  /** The address bar's intent model; without one the bar keeps its own order. */
  intentModel?: IntentModelFactory | null;
  stateDebounceMs?: number;
  now?: () => number;
  log?: Logger;
}

export class BrowserSession {
  readonly id: string;
  readonly userId: string;
  readonly spaceId: string;
  readonly space: SessionSpace;
  readonly host: ShellHost;
  readonly state: SessionStateStore;
  /** Where this session's downloads land, and what mints their URLs (§11). */
  readonly downloads: SessionDownloads | null;
  readonly viewers = new Set<WebSocket>();
  leaseToken: string;
  control: ShellControl;
  activeRunId: string | null;
  /**
   * The device whose viewer last proved this Space's key. It is the audit
   * actor for every run command the console issues (§8): control will not
   * take a worker's word for who acted, so the session has to name a real,
   * unrevoked device of its own user.
   */
  viewerDeviceId: string | null;
  /** How many inputs were dropped because they were issued under an older fence (W7). */
  droppedInput = 0;
  readonly #keys: SpaceKeys;
  readonly #control: ControlClient | null;
  readonly #listeners = new Set<() => void>();
  readonly #log: Logger;
  #closed = false;
  #closeReason: string | null = null;

  constructor(options: BrowserSessionOptions) {
    this.id = options.id;
    this.userId = options.userId;
    this.spaceId = options.spaceId;
    this.space = options.space;
    this.#keys = options.keys;
    this.leaseToken = options.leaseToken;
    this.control = options.control ?? { holder: "human", generation: 0 };
    this.activeRunId = options.activeRunId ?? null;
    this.viewerDeviceId = options.viewerDeviceId ?? null;
    this.#control = options.controlClient ?? null;
    this.#log = options.log ?? silentLogger;
    this.downloads =
      options.stateDir == null || options.stateDir === ""
        ? null
        : new SessionDownloads({
            userId: options.userId,
            stateDir: options.stateDir,
            ...(options.now === undefined ? {} : { now: options.now }),
            log: this.#log,
          });
    this.host = new ShellHost({
      sessionId: options.id,
      userId: options.userId,
      spaceId: options.spaceId,
      space: options.space,
      control: () => this.control,
      ...(options.version === undefined ? {} : { version: options.version }),
      ...(options.chromeVersion === undefined ? {} : { chromeVersion: options.chromeVersion }),
      ...(options.intentModel == null ? {} : { intentModel: options.intentModel }),
      ...(options.now === undefined ? {} : { now: options.now }),
      runs: this.#control === null ? null : this.#gateway(),
      downloads: this.downloads,
      log: this.#log,
    });
    const workspace = options.space.workspace;
    this.state = new SessionStateStore({
      // A Space without the workspace key wrapped to this device has no store
      // to publish into; the session still browses, it just is not durable.
      workspace: workspace ?? nullWorkspace(),
      spaceId: options.spaceId,
      // A tab another Space handed this one lands in the stored record while
      // this session is live; without folding it back in, this session's very
      // next publish would replace the record that carries it (§6.3).
      merge: (stored, pending) => this.host.mergeStoredState(stored, pending),
      ...(options.stateDebounceMs === undefined ? {} : { debounceMs: options.stateDebounceMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
      log: this.#log,
    });
    if (workspace !== null) {
      this.host.onSessionState((state) => this.state.publish(state));
      const space = workspace.spaces().find((doc) => doc.id === options.spaceId);
      if (space !== undefined) this.host.setSpaceName(space.name);
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  get closeReason(): string | null {
    return this.#closeReason;
  }

  /**
   * Rebuild from the sealed record, if there is one (§9).
   *
   * The read comes first and is what decides whether this session may ever
   * publish: a record it could not understand is not an empty session, and
   * writing over one would lose every tab on every device (`SessionStateStore.read`).
   */
  async restore(): Promise<void> {
    const state = this.state.read();
    await this.host.restore(state);
  }

  #desktopHandoff: Promise<void> | null = null;

  /** Called before the first proved web viewer joins an otherwise idle session. */
  async resumeFromDesktop(): Promise<void> {
    if (this.#desktopHandoff !== null) return this.#desktopHandoff;
    if (this.activeRunId !== null || this.control.holder !== "human" || this.#closed) return;
    const work = (async () => {
      await this.state.flush();
      const desktop = this.state.desktopHandoff();
      if (!desktop || this.#closed || this.activeRunId !== null || this.control.holder !== "human") return;
      await this.host.resumeDesktop(desktop);
      await this.state.flush();
    })();
    this.#desktopHandoff = work;
    try { await work; } finally { this.#desktopHandoff = null; }
  }

  /** Whether the record was read well enough for this session to write it back. */
  get durable(): boolean {
    return this.state.writable;
  }

  /**
   * A device token gets you a socket; the Space key gets you the state (§5).
   * The proof is the nonce sealed under the Space's own key with the shell
   * domain, so it can never be replayed as a live-view proof or vice versa.
   */
  async verifySpaceProof(nonce: string, proof: string): Promise<boolean> {
    try {
      const opened = await open(this.#keys.sealKey, fromBase64(proof), shellProofSealAad(this.id, nonce));
      return fromUtf8(opened) === nonce;
    } catch {
      return false;
    }
  }

  /** Anything a viewer would want re-sent: the control fence, the tabs, a close. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        this.#log.warn("a session listener threw", { error: errorMessage(error) });
      }
    }
  }

  /** Move the control fence, from a control event or a run attaching (W7). */
  setControl(control: ShellControl): void {
    if (control.generation < this.control.generation) return;
    if (control.holder === this.control.holder && control.generation === this.control.generation) return;
    this.control = control;
    this.notify();
  }

  /**
   * A viewer proved the Space key. This is only the FALLBACK actor, for the
   * few things a session does with no viewer's call behind them (a run's own
   * bookkeeping); a command that came in over a socket is audited as the
   * device that socket proved with — see `actor` below. Control still checks
   * that the device is the user's and unrevoked before doing anything on its
   * behalf (§8).
   */
  setViewerDevice(deviceId: string): void {
    this.viewerDeviceId = deviceId;
  }

  /**
   * The console's half of control (§8). Everything the host needs to drive
   * the session's runs, with the lease, the audit actor and the Space key
   * held here rather than in the host — which therefore has no crypto and no
   * HTTP of its own.
   */
  #gateway(): ShellRunGateway {
    const control = (): ControlClient => {
      if (this.#control === null) throw new Error("this session has no control client");
      return this.#control;
    };
    /**
     * Who control is asked to audit this command as (§8).
     *
     * The CALLING viewer's device, not the session's last-known one. A
     * session can have several viewers, and a single remembered device meant
     * every action by one person's laptop was audited as their phone — and
     * that revoking the phone killed the laptop's console with `403
     * viewer_device` while it was still attached and still proving the Space
     * key every minute.
     */
    const actor = (): { leaseToken: string; viewerDeviceId: string } => {
      const viewerDeviceId = currentViewer()?.deviceId ?? this.viewerDeviceId;
      if (viewerDeviceId === null) throw new Error("no viewer has proved this Space's key yet");
      return { leaseToken: this.leaseToken, viewerDeviceId };
    };
    return {
      start: (input) => control().startSessionRun(this.id, { ...actor(), ...input }),
      command: (runId, command, body) =>
        control().sessionRunCommand(this.id, runId, command, { ...actor(), ...body }),
      list: () => control().listSessionRuns(this.id, this.leaseToken),
      events: (runId, since) => control().listSessionRunEvents(this.id, runId, this.leaseToken, since),
      remove: (runId) => control().deleteSessionRun(this.id, runId, actor()),
      openEvent: async (runId, eventId, sealed): Promise<RunContentEvent | null> => {
        try {
          const bytes = await open(this.#keys.sealKey, fromBase64(sealed), runEventSealAad(runId, eventId));
          return parseContentEvent(JSON.parse(fromUtf8(bytes)));
        } catch {
          // Sealed under another key, or tampered: unreadable by design.
          return null;
        }
      },
      openThread: async (runId, sealed): Promise<RunSummary | null> => {
        try {
          const bytes = await open(this.#keys.sealKey, fromBase64(sealed), runThreadSealAad(runId));
          return desktopThreadRun(JSON.parse(fromUtf8(bytes)));
        } catch {
          return null;
        }
      },
      setControl: (control) => this.setControl(control),
    };
  }

  attachViewer(ws: WebSocket): void {
    this.viewers.add(ws);
  }

  detachViewer(ws: WebSocket): void {
    this.viewers.delete(ws);
  }

  /**
   * Whether one forwarded input may act. Human control and the CURRENT
   * generation, both: an input issued a moment before the agent took the
   * wheel is not the person's intent for what is on screen now, so it is
   * dropped and counted rather than replayed into whatever the agent opened.
   */
  mayAct(generation: number): boolean {
    if (this.control.holder === "human" && generation === this.control.generation) return true;
    this.droppedInput += 1;
    return false;
  }

  /** Write the record and let the browser go. The lease is released by the registry. */
  async close(reason: string): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    await this.state.flush().catch((error: unknown) => {
      this.#log.warn("session state flush failed", { sessionId: this.id, error: errorMessage(error) });
    });
    this.state.stop();
    this.host.close();
    this.downloads?.close();
    this.notify();
    this.#listeners.clear();
  }
}

/** A store for a Space with no workspace key: reads nothing, writes nothing. */
function nullWorkspace(): NonNullable<SessionSpace["workspace"]> {
  return {
    browserSession: () => null,
    putBrowserSession: () => undefined,
    spaces: () => [],
    settled: async () => undefined,
  } as unknown as NonNullable<SessionSpace["workspace"]>;
}
