/**
 * The worker's browser sessions: claim on demand, heartbeat, idle suspend
 * (docs/web-browser-design.md §6.4).
 *
 * A session is not placed anywhere in advance. A ticket lands on whichever
 * worker the fleet's one public address routed the socket to; if control says
 * nobody holds the session, THIS worker claims it and builds it, and if
 * somebody does, the socket is relayed there. That is what lets a session
 * suspended overnight come back on a completely different machine with the
 * same tabs (§9).
 */

import type { SpaceKeys } from "@pistachio/sync-protocol";
import type { ControlClient, SessionTicketRedemption } from "../control-client.js";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import type { SpaceHolder } from "../sync/session.js";
import type { SessionManager } from "../sync/session-manager.js";
import { BrowserSession } from "./browser-session.js";
import type { IntentModelFactory } from "./shell-host.js";
import type { SessionSpace } from "./shell-host.js";

/**
 * Control's session lease length (web-browser-design.md §4.3). Named here
 * because the worker only ever needs it to pick a heartbeat cadence; control
 * is the one that enforces it.
 */
export const SESSION_LEASE_MS = 60_000;

/** How a claim ended for the socket that asked for one. */
export type ClaimOutcome<S = BrowserSession> =
  | { kind: "session"; session: S }
  /** Another worker holds it; hand the socket over the private network. */
  | { kind: "relay"; workerUrl: string }
  | { kind: "refused"; reason: "ended" | "not_found" | "held_elsewhere" | "unavailable" };

/** Why every viewer of a session is being closed. */
export type SessionClosing = "ended" | "lease_lost" | "shutdown" | "revoked";

/**
 * The half of the `SessionManager` a session registry uses: hold a Space's
 * browser open, and let it go. Narrowed so a test can supply one Space.
 */
export interface SpaceSessions {
  acquire(userId: string, spaceId: string, holder: SpaceHolder): Promise<SessionSpace>;
  release(userId: string, spaceId: string, holder: SpaceHolder): void;
}

const _managerIsSpaceSessions = (manager: SessionManager): SpaceSessions => manager;

export interface SessionRegistryOptions {
  control: ControlClient;
  sessions: SpaceSessions;
  workerId: string;
  /** This worker's private address, put on the lease so a sibling can relay here. */
  workerUrl?: string | null;
  /** The Space keys this device holds for a user, for the socket's proof check. */
  keysFor: (userId: string, spaceId: string) => Promise<SpaceKeys>;
  /** `CLOUD_BROWSER_SESSION_IDLE_MS`: how long a viewerless session stays claimed. */
  idleMs: number;
  heartbeatMs?: number;
  version?: string;
  chromeVersion?: () => string;
  /** The address bar's intent model, for every session this worker holds. */
  intentModel?: IntentModelFactory | null;
  stateDebounceMs?: number;
  /** `CLOUD_BROWSER_STATE_DIR`: where a session's downloads land (§11). */
  stateDir?: string | null;
  now?: () => number;
  log?: Logger;
}

interface Held {
  session: BrowserSession;
  heartbeat: NodeJS.Timeout;
  idle: NodeJS.Timeout | null;
  /**
   * When the lease control LAST CONFIRMED runs out (§6.4, §13 revision 6).
   *
   * Control enforces the lease, but only for the workers that can reach it. A
   * heartbeat that fails as a transport error tells this worker nothing: it
   * used to log, retry, and go on serving a session whose lease had quietly
   * lapsed — while control, seeing no renewal, was free to hand the very same
   * session to a sibling. Two workers driving one person's tabs is the one
   * outcome the lease exists to prevent, so the deadline is enforced locally
   * too, and a session that reaches it is torn down exactly like a
   * `stale_lease`.
   */
  leaseUntil: number;
}

export class SessionRegistry {
  readonly #options: SessionRegistryOptions;
  readonly #log: Logger;
  readonly #held = new Map<string, Held>();
  readonly #pending = new Map<string, Promise<ClaimOutcome>>();
  readonly #adopting = new Map<string, Promise<BrowserSession | null>>();
  /** Retires in flight; a claim of the same session waits for one (#42). */
  readonly #retiring = new Map<string, Promise<void>>();
  readonly #closingListeners = new Set<(sessionId: string, reason: SessionClosing) => void>();
  #stopped = false;

  constructor(options: SessionRegistryOptions) {
    this.#options = options;
    this.#log = options.log ?? silentLogger;
  }

  get size(): number {
    return this.#held.size;
  }

  get(sessionId: string): BrowserSession | null {
    return this.#held.get(sessionId)?.session ?? null;
  }

  /** Every session this worker holds, for teardown and for tests. */
  sessions(): BrowserSession[] {
    return [...this.#held.values()].map((held) => held.session);
  }

  /** Told when a session's viewers must all go, and why. */
  onClosing(listener: (sessionId: string, reason: SessionClosing) => void): () => void {
    this.#closingListeners.add(listener);
    return () => this.#closingListeners.delete(listener);
  }

  /**
   * Claim on demand. Answers the live session when this worker took (or
   * already had) the lease, a relay target when another worker holds it, or a
   * refusal the socket turns into a close code.
   */
  async claim(sessionId: string, redemption: SessionTicketRedemption): Promise<ClaimOutcome> {
    if (this.#stopped) return { kind: "refused", reason: "unavailable" };
    // A retire of the same session may still be flushing its record and
    // letting go of the Space holder. The holder key is `session:<id>`, so a
    // claim that overtook it would acquire the very holder the retire is
    // about to release — and the Space would close under the new session.
    await this.#settleRetire(sessionId);
    const existing = this.#held.get(sessionId);
    if (existing !== undefined) return { kind: "session", session: existing.session };
    const pending = this.#pending.get(sessionId);
    if (pending !== undefined) return pending;
    const work = this.#claim(sessionId, redemption).finally(() => {
      if (this.#pending.get(sessionId) === work) this.#pending.delete(sessionId);
    });
    this.#pending.set(sessionId, work);
    return work;
  }

  /**
   * Adopt a session this worker already holds the lease of because it took
   * it WITH a run (§4.3: the run and its session are claimed in one
   * transaction). The lease is not claimed again — control handed it over
   * with the claim — so there is exactly one lease and exactly one heartbeat
   * loop for a session, whichever way the worker came by it.
   */
  async adopt(input: {
    sessionId: string;
    leaseToken: string;
    generation?: number;
    runId: string;
    userId: string;
    spaceId: string;
  }): Promise<BrowserSession | null> {
    if (this.#stopped) return null;
    await this.#settleRetire(input.sessionId);
    const held = this.#held.get(input.sessionId);
    if (held !== undefined) {
      held.session.activeRunId = input.runId;
      // The same lease, renewed by the claim: keep the token control now
      // expects and hand back the live session with its browser and its host.
      held.session.leaseToken = input.leaseToken;
      if (input.generation !== undefined) {
        held.session.setControl({ holder: "agent", generation: input.generation });
      }
      return held.session;
    }
    const pending = this.#adopting.get(input.sessionId);
    if (pending !== undefined) return pending;
    const work = this.#adopt(input).finally(() => {
      if (this.#adopting.get(input.sessionId) === work) this.#adopting.delete(input.sessionId);
    });
    this.#adopting.set(input.sessionId, work);
    return work;
  }

  /**
   * Read the session from control now rather than at the next beat. A run
   * ending moves the fence back to the person in control's transaction, and
   * the pane should stop showing the agent's veil at once.
   */
  async refresh(sessionId: string): Promise<void> {
    await this.#beat(sessionId);
  }

  /**
   * A run this worker was driving has ended (`runs/executor.ts`). The registry
   * owns the transition: the caller says the run is over, and the idle clock
   * for a session nobody is watching starts here rather than being inferred
   * from a field the caller may already have cleared.
   */
  async runEnded(sessionId: string, runId: string): Promise<void> {
    const held = this.#held.get(sessionId);
    if (held !== undefined && held.session.activeRunId === runId) held.session.activeRunId = null;
    await this.#beat(sessionId);
    this.viewerDetached(sessionId);
  }

  /** A viewer attached: the idle clock stops. */
  viewerAttached(sessionId: string): void {
    const held = this.#held.get(sessionId);
    if (held === undefined) return;
    if (held.idle !== null) {
      clearTimeout(held.idle);
      held.idle = null;
    }
  }

  /**
   * A viewer went. When it was the last one and no run is acting, the idle
   * clock starts: at the end of it the record is published, the lease is
   * released as `suspended`, and the Chromium context goes (§6.4).
   */
  viewerDetached(sessionId: string): void {
    const held = this.#held.get(sessionId);
    if (held === undefined || held.idle !== null) return;
    if (held.session.viewers.size > 0 || held.session.activeRunId !== null) return;
    const timer = setTimeout(() => {
      held.idle = null;
      void this.suspend(sessionId).catch((error: unknown) => {
        this.#log.warn("idle suspend failed", { sessionId, error: errorMessage(error) });
      });
    }, this.#options.idleMs);
    timer.unref();
    held.idle = timer;
  }

  /** Publish, release the lease, close the browser holder. Keeps no viewers. */
  async suspend(sessionId: string): Promise<void> {
    const held = this.#held.get(sessionId);
    if (held === undefined) return;
    if (held.session.viewers.size > 0 || held.session.activeRunId !== null) return;
    await this.#retire(sessionId, "shutdown", { release: true });
  }

  /** The person ended the session (steer `session.ended`, §4.3). */
  async ended(sessionId: string): Promise<void> {
    await this.#retire(sessionId, "ended", { release: false });
  }

  /** Every session of a revoked user goes at once, with its viewers. */
  async closeUser(userId: string): Promise<void> {
    for (const [sessionId, held] of [...this.#held]) {
      if (held.session.userId === userId) await this.#retire(sessionId, "revoked", { release: false });
    }
  }

  async close(): Promise<void> {
    this.#stopped = true;
    for (const sessionId of [...this.#held.keys()]) {
      await this.#retire(sessionId, "shutdown", { release: true });
    }
  }

  /* ------------------------------ internals ------------------------------ */

  async #claim(sessionId: string, redemption: SessionTicketRedemption): Promise<ClaimOutcome> {
    const workerUrl = this.#options.workerUrl ?? null;
    // Control named another worker: hand the socket over rather than fighting
    // for a lease that is alive somewhere else.
    if (redemption.workerUrl !== null && !sameWorker(redemption.workerUrl, workerUrl)) {
      return { kind: "relay", workerUrl: redemption.workerUrl };
    }
    const claimed = await this.#options.control.claimSession(sessionId, this.#options.workerId, workerUrl);
    if ("refused" in claimed) {
      if (claimed.refused === "session_ended") return { kind: "refused", reason: "ended" };
      if (claimed.refused === "not_found") return { kind: "refused", reason: "not_found" };
      // A sibling claimed it between the redemption and this call. Ask
      // control where the session actually went and hand the socket over
      // (§6.4): until S6 there was no service route to re-read a session, so
      // this could only be refused and the client had to dial again with a
      // fresh ticket — one extra round trip through the person's browser for
      // something the fleet already knew.
      const placement = await this.#options.control.readSession(sessionId).catch(() => null);
      if (placement !== null && placement.workerUrl !== null && !sameWorker(placement.workerUrl, workerUrl)) {
        return { kind: "relay", workerUrl: placement.workerUrl };
      }
      return { kind: "refused", reason: "held_elsewhere" };
    }
    let session: BrowserSession;
    try {
      const space = await this.#options.sessions.acquire(redemption.userId, redemption.spaceId, {
        kind: "session",
        sessionId,
      });
      await space.ready;
      // The WORKSPACE's own hydration, not only the Space's. `space.ready` is
      // the Space's `hydrate.done`; the workspace registers — where the
      // session record lives — arrive on an independent message with no
      // ordering guarantee. Restoring before it lands reads `null`, brings the
      // session up empty, and the first publish writes that emptiness over
      // every tab on every device. `RunExecutor` already awaits both.
      await space.workspace?.ready;
      const keys = await this.#options.keysFor(redemption.userId, redemption.spaceId);
      session = new BrowserSession({
        id: sessionId,
        userId: redemption.userId,
        spaceId: redemption.spaceId,
        space,
        keys,
        leaseToken: claimed.leaseToken,
        controlClient: this.#options.control,
        viewerDeviceId: redemption.deviceId,
        control: claimed.session.control,
        activeRunId: claimed.session.activeRunId,
        ...(this.#options.version === undefined ? {} : { version: this.#options.version }),
        ...(this.#options.chromeVersion === undefined ? {} : { chromeVersion: this.#options.chromeVersion }),
        ...(this.#options.intentModel == null ? {} : { intentModel: this.#options.intentModel }),
        ...(this.#options.stateDebounceMs === undefined ? {} : { stateDebounceMs: this.#options.stateDebounceMs }),
        ...(this.#options.stateDir == null ? {} : { stateDir: this.#options.stateDir }),
        ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
        log: this.#log,
      });
      await session.restore();
    } catch (error) {
      this.#log.error("browser session could not be built", { sessionId, error: errorMessage(error) });
      await this.#options.control.releaseSession(sessionId, claimed.leaseToken).catch(() => undefined);
      this.#options.sessions.release(redemption.userId, redemption.spaceId, { kind: "session", sessionId });
      return { kind: "refused", reason: "unavailable" };
    }
    const heartbeat = setInterval(() => {
      void this.#beat(sessionId);
    }, this.#options.heartbeatMs ?? Math.max(1_000, Math.floor(SESSION_LEASE_MS / 3)));
    heartbeat.unref();
    this.#held.set(sessionId, {
      session,
      heartbeat,
      idle: null,
      leaseUntil: this.#deadline(claimed.session),
    });
    // Nothing has attached yet; if no viewer ever does, the idle clock still
    // has to run or a claimed-and-abandoned session holds a browser for ever.
    this.viewerDetached(sessionId);
    return { kind: "session", session };
  }

  async #adopt(input: {
    sessionId: string;
    leaseToken: string;
    generation?: number;
    runId: string;
    userId: string;
    spaceId: string;
  }): Promise<BrowserSession | null> {
    const { sessionId, userId, spaceId } = input;
    let session: BrowserSession;
    try {
      const space = await this.#options.sessions.acquire(userId, spaceId, { kind: "session", sessionId });
      await space.ready;
      await space.workspace?.ready;
      const keys = await this.#options.keysFor(userId, spaceId);
      session = new BrowserSession({
        id: sessionId,
        userId,
        spaceId,
        space,
        keys,
        leaseToken: input.leaseToken,
        controlClient: this.#options.control,
        activeRunId: input.runId,
        control:
          input.generation === undefined
            ? { holder: "agent", generation: 0 }
            : { holder: "agent", generation: input.generation },
        ...(this.#options.version === undefined ? {} : { version: this.#options.version }),
        ...(this.#options.chromeVersion === undefined ? {} : { chromeVersion: this.#options.chromeVersion }),
        ...(this.#options.intentModel == null ? {} : { intentModel: this.#options.intentModel }),
        ...(this.#options.stateDebounceMs === undefined ? {} : { stateDebounceMs: this.#options.stateDebounceMs }),
        ...(this.#options.stateDir == null ? {} : { stateDir: this.#options.stateDir }),
        ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
        log: this.#log,
      });
      await session.restore();
    } catch (error) {
      this.#log.error("a run's browser session could not be built", { sessionId, error: errorMessage(error) });
      // The lease came WITH the run's claim, so this worker holds it whether
      // or not the session could be built. Without the release, control keeps
      // pointing viewers at a worker that has no session for a whole minute.
      await this.#options.control
        .releaseSession(sessionId, input.leaseToken)
        .catch((releaseError: unknown) =>
          this.#log.warn("releasing an unbuilt session failed", { sessionId, error: errorMessage(releaseError) }),
        );
      this.#options.sessions.release(userId, spaceId, { kind: "session", sessionId });
      return null;
    }
    const heartbeat = setInterval(() => {
      void this.#beat(sessionId);
    }, this.#options.heartbeatMs ?? Math.max(1_000, Math.floor(SESSION_LEASE_MS / 3)));
    heartbeat.unref();
    // The run's claim renewed the lease in control's own transaction (§8.1),
    // so a full lease is what this worker holds from now.
    this.#held.set(sessionId, { session, heartbeat, idle: null, leaseUntil: this.#now() + SESSION_LEASE_MS });
    // No viewer has attached; if none ever does, the idle clock still has to
    // run, and it will not fire while the run is the session's active one.
    this.viewerDetached(sessionId);
    return session;
  }

  async #beat(sessionId: string): Promise<void> {
    const held = this.#held.get(sessionId);
    if (held === undefined) return;
    // Before anything else: a lease that has run out with no renewal is a
    // lease this worker does not hold, whatever control is or is not saying.
    if (await this.#enforceLease(sessionId, held)) return;
    try {
      const session = await this.#options.control.heartbeatSession(sessionId, held.session.leaseToken);
      if (session === null) {
        this.#log.warn("browser session lease lost", { sessionId });
        await this.#retire(sessionId, "lease_lost", { release: false });
        return;
      }
      held.leaseUntil = this.#deadline(session);
      held.session.setControl(session.control);
      held.session.activeRunId = session.activeRunId;
      // A run ending is the moment a viewerless session becomes idle. Nothing
      // else calls `viewerDetached` again — the last viewer left while the run
      // was still going, and that call returned early — so without this the
      // lease, the heartbeat and the Chromium context are held for ever.
      //
      // The REGISTRY owns that transition, rather than inferring it from a
      // change it happens to witness: the executor clears the session's
      // `activeRunId` on its way out, and a beat that only acted on
      // "something became nothing" was blind to a run whose end somebody else
      // had already recorded. `viewerDetached` is a no-op when a viewer is
      // attached or the clock is already running.
      if (held.session.activeRunId === null) this.viewerDetached(sessionId);
    } catch (error) {
      // A transport blip is not a lost lease; the next beat decides — until
      // the lease control last confirmed has run out, and then it is.
      this.#log.warn("session heartbeat failed", { sessionId, error: errorMessage(error) });
      await this.#enforceLease(sessionId, held);
    }
  }

  /**
   * Tear the session down when its confirmed lease has expired. Answers
   * whether it did, so the caller stops touching a session that is gone.
   */
  async #enforceLease(sessionId: string, held: Held): Promise<boolean> {
    if (this.#now() < held.leaseUntil) return false;
    this.#log.warn("browser session lease expired without a renewal", { sessionId });
    await this.#retire(sessionId, "lease_lost", { release: false });
    return true;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  /** The deadline control's answer confirms, and one lease from now when it names none. */
  #deadline(session: { worker: { until: string } | null }): number {
    const until = session.worker === null ? Number.NaN : Date.parse(session.worker.until);
    return Number.isNaN(until) ? this.#now() + SESSION_LEASE_MS : until;
  }

  /** Wait out a retire of this session, so a claim never overtakes one. */
  async #settleRetire(sessionId: string): Promise<void> {
    const pending = this.#retiring.get(sessionId);
    if (pending === undefined) return;
    await pending.catch(() => undefined);
  }

  async #retire(sessionId: string, reason: SessionClosing, options: { release: boolean }): Promise<void> {
    const running = this.#retiring.get(sessionId);
    if (running !== undefined) return running;
    const work = this.#retireNow(sessionId, reason, options).finally(() => {
      if (this.#retiring.get(sessionId) === work) this.#retiring.delete(sessionId);
    });
    this.#retiring.set(sessionId, work);
    return work;
  }

  async #retireNow(sessionId: string, reason: SessionClosing, options: { release: boolean }): Promise<void> {
    const held = this.#held.get(sessionId);
    if (held === undefined) return;
    clearInterval(held.heartbeat);
    if (held.idle !== null) clearTimeout(held.idle);
    for (const listener of [...this.#closingListeners]) {
      try {
        listener(sessionId, reason);
      } catch (error) {
        this.#log.warn("a session-closing listener threw", { error: errorMessage(error) });
      }
    }
    try {
      await held.session.close(reason);
      if (options.release) {
        await this.#options.control
          .releaseSession(sessionId, held.session.leaseToken)
          .catch((error: unknown) => this.#log.warn("session release failed", { sessionId, error: errorMessage(error) }));
      }
    } finally {
      // The registry lets go of the session HERE — after the record is
      // flushed and the lease is back — and not before it.
      //
      // `get()` answering null is what every caller reads as "this worker is
      // done with that session", and it used to answer null the instant a
      // retire STARTED: the record was still being written and the lease
      // still belonged to this worker for as long as the flush and the
      // release took, which on a loaded machine is a round trip to control.
      // A test that waits for the registry to let go and then asks control
      // what the session says was therefore reading the row before the
      // release reached it.
      //
      // Nothing can see a half-retired session in the window this opens:
      // `BrowserSession.close()` marks the session closed on its first
      // synchronous line, before any await, and both readers of `get()` —
      // the download route and the socket upgrade — refuse a closed session
      // exactly as they refuse a missing one. `claim()` never raced it in
      // the first place: it waits out `#settleRetire` before it looks.
      this.#held.delete(sessionId);
      this.#options.sessions.release(held.session.userId, held.session.spaceId, { kind: "session", sessionId });
    }
  }
}

/** Two worker addresses that name the same worker, trailing slashes aside. */
function sameWorker(a: string, b: string | null): boolean {
  if (b === null) return false;
  return a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");
}
