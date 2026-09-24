import { randomUUID } from "node:crypto";
import type {
  AgentAttachment,
  DurablePause,
  PauseKind,
  RunEventInput,
  RunExecutor,
  RunOrigin,
  StoredRunEvent,
  TaskCapsule,
  TaskStatus,
} from "@pistachio/protocol";
import {
  TERMINAL_STATUSES as PROTOCOL_TERMINAL_STATUSES, validateCapsule } from "@pistachio/protocol";

export type { DurablePause, PauseKind } from "@pistachio/protocol";
export { gatewayPrivacyFetch } from "./gateway-privacy.js";

export interface RunLease {
  workerId: string;
  /**
   * Where the worker holding this lease can be reached, for surfaces that
   * have to talk to THAT worker rather than to any of them — the live view,
   * whose run registry is in the worker's own memory (§8.5). Null when the
   * worker did not advertise one; it dies with the lease, so a run reclaimed
   * by another worker carries the new address.
   */
  workerUrl: string | null;
  token: string;
  until: string;
}

/**
 * A run hosted by control and driven by the cloud browser. `sponsorId` is
 * the user who owns it — always equal to `userId`; both names exist because
 * the capsule vocabulary predates accounts.
 */
export interface HostedRunRecord {
  id: string;
  taskId: string;
  sponsorId: string;
  userId: string;
  spaceId: string;
  capsuleId: string;
  /** The capsule the run was created from; null for a run created from an intent (`capsuleId === id`). */
  capsule: TaskCapsule | null;
  purpose: string;
  intent: string;
  attachments: AgentAttachment[];
  origin: RunOrigin | null;
  executor: RunExecutor;
  startUrl: string | null;
  /**
   * The browser session this run acts in (web-browser-design.md §4.1), or
   * null for a run with no session of its own. A run with a session is
   * placed on the worker holding that session and drives its control
   * generation while it runs.
   */
  sessionId: string | null;
  status: TaskStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lease: RunLease | null;
  pause: DurablePause | null;
  authorityEnded: boolean;
  lastApprover: string | null;
}

export interface HostedRunStore {
  create(record: HostedRunRecord): Promise<void>;
  get(runId: string): Promise<HostedRunRecord | null>;
  /** Runs a worker may take: `ready`, `running`, or `human_control` with no live lease. */
  listClaimable(now: number, limit: number): Promise<HostedRunRecord[]>;
  claimExpiredPauses(options: {
    workerId: string;
    now: number;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedRun[]>;
  compareAndSet(
    runId: string,
    expectedRevision: number,
    next: HostedRunRecord,
  ): Promise<boolean>;
}

/** Ends a run's authority. Both calls are idempotent: a retried transition may invoke them again. */
export interface AuthorityRevoker {
  destroyCapsuleKey(capsuleId: string, run: HostedRunRecord): Promise<void>;
  cutRuntimeEgress(runId: string, run: HostedRunRecord): Promise<void>;
}

/** Who is appending: the worker holding the lease, or the sponsor issuing a command. */
export interface RunEventAppender {
  leaseToken?: string;
  sponsorId?: string;
}

/**
 * Where a run's events land. The coordinator appends the trailing events a
 * transition carries after it has verified the lease or sponsor itself;
 * the attribution is passed on for the sink's own records, not as a second
 * check the sink must repeat. Appends are idempotent on `(runId, eventId)`.
 */
export interface RunEventSink {
  append(runId: string, events: RunEventInput[], by: RunEventAppender): Promise<{ seqs: number[] }>;
}

export interface ClaimedRun {
  run: HostedRunRecord;
  leaseToken: string;
}

export type CreateHostedRunInput =
  | { capsule: TaskCapsule; spaceId?: string }
  | {
      userId: string;
      spaceId: string;
      intent: string;
      attachments: AgentAttachment[];
      origin: RunOrigin | null;
      startUrl: string | null;
      /** The browser session the run attaches to (§4.3); null or absent for a standalone run. */
      sessionId?: string | null;
    };

export interface CreateDesktopRunInput {
  runId: string;
  taskId: string;
  userId: string;
  spaceId: string;
  intent: string;
  attachments: AgentAttachment[];
  startUrl: string | null;
  startedAt: string;
}

const TERMINAL_STATUSES: readonly TaskStatus[] = PROTOCOL_TERMINAL_STATUSES;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WAITING_STATUSES: readonly TaskStatus[] = [
  "waiting_for_approval",
  "waiting_for_judgment",
  "waiting_for_step_up",
];
const CLAIMABLE_STATUSES: readonly TaskStatus[] = ["ready", "running", "human_control"];

/** The Space a capsule-created run lives in when the caller names none (D8: the default Space converges as `work`). */
const DEFAULT_SPACE_ID = "work";

function leaseLive(lease: RunLease | null, now: number): boolean {
  return lease !== null && new Date(lease.until).getTime() >= now;
}

export class InMemoryHostedRunStore implements HostedRunStore {
  readonly #runs = new Map<string, HostedRunRecord>();

  async create(record: HostedRunRecord): Promise<void> {
    if (this.#runs.has(record.id)) throw new Error(`run ${record.id} already exists`);
    this.#runs.set(record.id, structuredClone(record));
  }

  async get(runId: string): Promise<HostedRunRecord | null> {
    const record = this.#runs.get(runId);
    return record === undefined ? null : structuredClone(record);
  }

  async listClaimable(now: number, limit: number): Promise<HostedRunRecord[]> {
    return [...this.#runs.values()]
      .filter((run) => run.executor.kind === "cloud" && CLAIMABLE_STATUSES.includes(run.status) && !leaseLive(run.lease, now))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, Math.max(0, limit))
      .map((run) => structuredClone(run));
  }

  async claimExpiredPauses(options: {
    workerId: string;
    now: number;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedRun[]> {
    const candidates = [...this.#runs.values()]
      .filter(
        (run) =>
          WAITING_STATUSES.includes(run.status) &&
          run.pause !== null &&
          new Date(run.pause.expiresAt).getTime() <= options.now &&
          !leaseLive(run.lease, options.now),
      )
      .sort((a, b) =>
        (a.pause?.expiresAt ?? "").localeCompare(b.pause?.expiresAt ?? "") ||
        a.id.localeCompare(b.id),
      )
      .slice(0, Math.max(0, options.limit));
    return candidates.map((run) => {
      const leaseToken = randomUUID();
      run.lease = {
        workerId: options.workerId,
        // The pause sweep is control's own maintenance worker; there is no
        // browser behind it for anyone to watch.
        workerUrl: null,
        token: leaseToken,
        until: new Date(options.now + options.leaseMs).toISOString(),
      };
      run.revision += 1;
      run.updatedAt = new Date(options.now).toISOString();
      return { run: structuredClone(run), leaseToken };
    });
  }

  async compareAndSet(
    runId: string,
    expectedRevision: number,
    next: HostedRunRecord,
  ): Promise<boolean> {
    const current = this.#runs.get(runId);
    if (current === undefined || current.revision !== expectedRevision) return false;
    if (next.id !== runId || next.revision !== expectedRevision + 1) {
      throw new Error("compareAndSet requires an unchanged id and incremented revision");
    }
    this.#runs.set(runId, structuredClone(next));
    return true;
  }
}

/** An event log in memory: one sequence per run, idempotent on eventId. */
export class InMemoryRunEventSink implements RunEventSink {
  readonly #events = new Map<string, StoredRunEvent[]>();

  async append(runId: string, events: RunEventInput[], _by: RunEventAppender): Promise<{ seqs: number[] }> {
    const stored = this.#events.get(runId) ?? [];
    const seqs: number[] = [];
    for (const input of events) {
      const existing = stored.find((event) => event.eventId === input.eventId);
      if (existing !== undefined) {
        seqs.push(existing.seq);
        continue;
      }
      const seq = stored.length + 1;
      stored.push({ ...structuredClone(input), seq });
      seqs.push(seq);
    }
    this.#events.set(runId, stored);
    return { seqs };
  }

  /** Events of a run with `seq > since`, in order. */
  list(runId: string, since = 0): StoredRunEvent[] {
    return (this.#events.get(runId) ?? []).filter((event) => event.seq > since).map((event) => structuredClone(event));
  }
}

export class HostedRunCoordinator {
  readonly #store: HostedRunStore;
  readonly #revoker: AuthorityRevoker;
  readonly #events: RunEventSink;

  constructor(store: HostedRunStore, revoker: AuthorityRevoker, events: RunEventSink) {
    this.#store = store;
    this.#revoker = revoker;
    this.#events = events;
  }

  /**
   * A new run, `ready` for a worker. From a capsule (validated, `capsuleId`
   * the capsule's own) or from an intent (`capsuleId = runId`, no capsule).
   * Either way it is executed by the cloud; the device and worker are named
   * once known.
   */
  async create(input: CreateHostedRunInput, now = Date.now()): Promise<HostedRunRecord> {
    const timestamp = new Date(now).toISOString();
    const id = randomUUID();
    const executor: RunExecutor = { kind: "cloud", deviceId: null, workerId: null };
    const base = {
      id,
      sessionId: null as string | null,
      status: "ready" as const,
      executor,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      lease: null,
      pause: null,
      authorityEnded: false,
      lastApprover: null,
    };
    let run: HostedRunRecord;
    if ("capsule" in input) {
      const capsule = input.capsule;
      validateCapsule(capsule, now);
      if (!UUID_RE.test(capsule.taskId)) throw new Error("capsule task id must be a uuid");
      if (input.spaceId === "") throw new Error("run needs a space");
      run = {
        ...base,
        taskId: capsule.taskId,
        sponsorId: capsule.sponsorId,
        userId: capsule.sponsorId,
        spaceId: input.spaceId ?? DEFAULT_SPACE_ID,
        capsuleId: capsule.id,
        capsule: structuredClone(capsule),
        purpose: capsule.purpose,
        intent: capsule.purpose,
        attachments: [],
        origin: null,
        startUrl: capsule.tabs[0]?.url ?? null,
      };
    } else {
      if (input.userId === "") throw new Error("run needs a user");
      if (input.spaceId === "") throw new Error("run needs a space");
      run = {
        ...base,
        taskId: randomUUID(),
        sponsorId: input.userId,
        userId: input.userId,
        spaceId: input.spaceId,
        capsuleId: id,
        capsule: null,
        purpose: input.intent,
        intent: input.intent,
        attachments: structuredClone(input.attachments),
        origin: input.origin === null ? null : structuredClone(input.origin),
        startUrl: input.startUrl,
        sessionId: input.sessionId ?? null,
      };
    }
    await this.#store.create(run);
    return structuredClone(run);
  }

  /**
   * Register a conversation executed by an enrolled desktop. It uses the
   * hosted run/event store for cross-device visibility, but is never eligible
   * for a cloud-worker lease.
   */
  async createDesktop(input: CreateDesktopRunInput): Promise<HostedRunRecord> {
    if (input.userId === "") throw new Error("run needs a user");
    if (input.spaceId === "") throw new Error("run needs a space");
    const record: HostedRunRecord = {
      id: input.runId,
      taskId: input.taskId,
      sponsorId: input.userId,
      userId: input.userId,
      spaceId: input.spaceId,
      capsuleId: input.runId,
      capsule: null,
      purpose: input.intent,
      intent: input.intent,
      attachments: structuredClone(input.attachments),
      origin: null,
      executor: { kind: "desktop" },
      startUrl: input.startUrl,
      sessionId: null,
      status: "ready",
      revision: 1,
      createdAt: input.startedAt,
      updatedAt: input.startedAt,
      completedAt: null,
      lease: null,
      pause: null,
      authorityEnded: false,
      lastApprover: null,
    };
    await this.#store.create(record);
    return structuredClone(record);
  }

  async reattach(runId: string, sponsorId: string): Promise<HostedRunRecord> {
    return this.#requireSponsoredRun(runId, sponsorId);
  }

  /**
   * Take the oldest claimable run under a fresh lease. A run the person is
   * driving (`human_control`) keeps that status: the worker holds the lease
   * to serve it, not to drive.
   */
  async claimNext(
    workerId: string,
    now = Date.now(),
    leaseMs = 30_000,
    /** This worker's own public address, recorded on the lease (§8.5). */
    workerUrl: string | null = null,
    /**
     * Placement (web-browser-design.md §4.3): a caller that knows this worker
     * cannot serve a run — its browser session is held elsewhere under a live
     * lease — skips it here rather than claiming and immediately releasing it.
     * The predicate sees candidates oldest first and must be side-effect free.
     */
    options: { eligible?: (run: HostedRunRecord) => boolean } = {},
  ): Promise<ClaimedRun | null> {
    for (const candidate of await this.#store.listClaimable(now, 20)) {
      if (options.eligible !== undefined && !options.eligible(candidate)) continue;
      const leaseToken = randomUUID();
      const next = this.#next(candidate, now, {
        status: candidate.status === "human_control" ? "human_control" : "running",
        executor:
          candidate.executor.kind === "cloud" ? { ...candidate.executor, workerId } : candidate.executor,
        lease: {
          workerId,
          workerUrl,
          token: leaseToken,
          until: new Date(now + leaseMs).toISOString(),
        },
      });
      if (await this.#store.compareAndSet(candidate.id, candidate.revision, next)) {
        return { run: structuredClone(next), leaseToken };
      }
    }
    return null;
  }

  async heartbeat(runId: string, leaseToken: string, now = Date.now(), leaseMs = 30_000): Promise<void> {
    await this.#mutateLeased(runId, leaseToken, now, (run) => ({
      ...run,
      lease: run.lease === null ? null : { ...run.lease, until: new Date(now + leaseMs).toISOString() },
    }));
  }

  async pause(
    runId: string,
    leaseToken: string,
    pause: DurablePause,
    now = Date.now(),
    events: RunEventInput[] = [],
  ): Promise<HostedRunRecord> {
    const statusByKind: Record<PauseKind, TaskStatus> = {
      approval: "waiting_for_approval",
      judgment: "waiting_for_judgment",
      step_up: "waiting_for_step_up",
    };
    const next = await this.#mutateLeased(runId, leaseToken, now, (run) => ({
      ...run,
      status: statusByKind[pause.kind],
      lease: null,
      pause: structuredClone(pause),
    }));
    await this.#append(runId, events, { leaseToken });
    return next;
  }

  async resume(options: {
    runId: string;
    pauseId: string;
    sponsorId: string;
    now?: number;
    approver?: string;
    isCapabilityAllowed(capability: string): Promise<boolean>;
  }): Promise<HostedRunRecord> {
    const now = options.now ?? Date.now();
    const run = await this.#requireSponsoredRun(options.runId, options.sponsorId);
    if (run.pause?.id !== options.pauseId) throw new Error("pause is no longer pending");
    if (new Date(run.pause.expiresAt).getTime() <= now) throw new Error("pause expired");
    if (
      run.pause.capability !== null &&
      !(await options.isCapabilityAllowed(run.pause.capability))
    ) {
      throw new Error("current policy no longer permits this capability");
    }
    const current = await this.#requireRun(options.runId);
    if (current.revision !== run.revision || current.pause?.id !== options.pauseId) {
      throw new Error("pause changed while permission was being checked");
    }
    const next = this.#next(current, now, {
      status: "ready",
      pause: null,
      lease: null,
      lastApprover: options.approver ?? options.sponsorId,
    });
    if (!(await this.#store.compareAndSet(current.id, current.revision, next))) {
      throw new Error("run changed before it could resume");
    }
    return next;
  }

  /** The person declined a pending pause: the run ends `rejected` and its authority with it. */
  async reject(options: {
    runId: string;
    pauseId: string;
    sponsorId: string;
    now?: number;
  }): Promise<HostedRunRecord> {
    const now = options.now ?? Date.now();
    const run = await this.#requireSponsoredRun(options.runId, options.sponsorId);
    if (!WAITING_STATUSES.includes(run.status) || run.pause?.id !== options.pauseId) {
      throw new Error("pause is no longer pending");
    }
    return this.#end(run, now, "rejected", { lastApprover: options.sponsorId }, (current) =>
      WAITING_STATUSES.includes(current.status) && current.pause?.id === options.pauseId
        ? null
        : "pause changed before it could be rejected",
    );
  }

  async complete(
    runId: string,
    leaseToken: string,
    now = Date.now(),
    events: RunEventInput[] = [],
  ): Promise<HostedRunRecord> {
    const run = await this.#requireLeasedRun(runId, leaseToken, now);
    const next = await this.#end(run, now, "completed", {}, (current) =>
      current.lease?.token === leaseToken ? null : "run lease changed during authority revocation",
    );
    await this.#append(runId, events, { leaseToken });
    return next;
  }

  /**
   * The worker gave up on the run. `reason` is the worker's word for why
   * (`device_revoked`, `no_space_key`, a model error); it belongs in the
   * trailing events and the caller's audit trail, which is where the person
   * reads it — the record keeps only the state.
   */
  async fail(
    runId: string,
    leaseToken: string,
    reason: string,
    now = Date.now(),
    events: RunEventInput[] = [],
  ): Promise<HostedRunRecord> {
    if (reason.trim() === "") throw new Error("a failed run needs a reason");
    const run = await this.#requireLeasedRun(runId, leaseToken, now);
    const next = await this.#end(run, now, "failed", {}, (current) =>
      current.lease?.token === leaseToken ? null : "run lease changed during authority revocation",
    );
    await this.#append(runId, events, { leaseToken });
    return next;
  }

  /**
   * The sponsor pulled the plug. Ends the run whatever the lease says: the
   * worker learns from its next lease check. Idempotent once revoked.
   */
  async revoke(options: { runId: string; sponsorId: string; now?: number }): Promise<HostedRunRecord> {
    const now = options.now ?? Date.now();
    const run = await this.#requireSponsoredRun(options.runId, options.sponsorId);
    if (run.status === "revoked") return run;
    if (TERMINAL_STATUSES.includes(run.status)) throw new Error(`run already ${run.status}`);
    return this.#end(run, now, "revoked", {}, (current) =>
      TERMINAL_STATUSES.includes(current.status) ? `run already ${current.status}` : null,
    );
  }

  /** The person takes the wheel. The worker keeps its lease (heartbeats stay valid) and serves the live view. */
  async takeControl(options: { runId: string; sponsorId: string; now?: number }): Promise<HostedRunRecord> {
    const now = options.now ?? Date.now();
    const run = await this.#requireSponsoredRun(options.runId, options.sponsorId);
    // `waiting_for_step_up` is the agent ASKING for the wheel
    // (`request_takeover`): taking control is the answer to it, and the only
    // way out of that pause. Clearing the pause is what lets `releaseControl`
    // hand the run back to a worker afterwards.
    if (run.status !== "running" && run.status !== "interrupted" && run.status !== "waiting_for_step_up") {
      throw new Error(`cannot take control of a ${run.status} run`);
    }
    return this.#commit(
      run,
      now,
      { status: "human_control", pause: null },
      "run changed before control could be taken",
    );
  }

  /** The person hands the wheel back; the agent continues under whatever lease is live. */
  async releaseControl(options: { runId: string; sponsorId: string; now?: number }): Promise<HostedRunRecord> {
    const now = options.now ?? Date.now();
    const run = await this.#requireSponsoredRun(options.runId, options.sponsorId);
    if (run.status !== "human_control") throw new Error(`cannot release control of a ${run.status} run`);
    return this.#commit(run, now, { status: "running" }, "run changed before control could be released");
  }

  /** The worker stopped at a clean point (a person's interrupt reached it). The run can be reopened. */
  async interrupt(runId: string, leaseToken: string, now = Date.now()): Promise<HostedRunRecord> {
    return this.#mutateLeased(runId, leaseToken, now, (run) => {
      if (TERMINAL_STATUSES.includes(run.status)) throw new Error(`cannot interrupt a ${run.status} run`);
      return { ...run, status: "interrupted", lease: null, pause: null };
    });
  }

  /**
   * An explicit new sponsor message starts another turn in the same thread.
   * Reopening a terminal run is a fresh grant of runtime authority: the
   * worker receives a new lease and egress credential when it claims it.
   */
  async reopen(options: { runId: string; sponsorId: string; now?: number }): Promise<HostedRunRecord> {
    const now = options.now ?? Date.now();
    const run = await this.#requireSponsoredRun(options.runId, options.sponsorId);
    if (run.status !== "interrupted" && !TERMINAL_STATUSES.includes(run.status)) {
      throw new Error(`cannot reopen a ${run.status} run`);
    }
    return this.#commit(
      run,
      now,
      {
        status: "ready",
        completedAt: null,
        lease: null,
        pause: null,
        authorityEnded: false,
      },
      "run changed before it could reopen",
    );
  }

  async expirePauses(options: {
    workerId: string;
    now?: number;
    leaseMs?: number;
    limit?: number;
  }): Promise<number> {
    const now = options.now ?? Date.now();
    const claimed = await this.#store.claimExpiredPauses({
      workerId: options.workerId,
      now,
      leaseMs: options.leaseMs ?? 30_000,
      limit: options.limit ?? 50,
    });
    let expired = 0;
    for (const claim of claimed) {
      await this.#revokeAuthority(claim.run);
      const current = await this.#requireRun(claim.run.id);
      if (
        current.revision !== claim.run.revision ||
        current.lease?.token !== claim.leaseToken ||
        current.pause?.id !== claim.run.pause?.id
      ) {
        continue;
      }
      const next = this.#next(current, now, {
        status: "revoked",
        completedAt: new Date(now).toISOString(),
        lease: null,
        pause: null,
        authorityEnded: true,
      });
      if (await this.#store.compareAndSet(current.id, current.revision, next)) expired += 1;
    }
    return expired;
  }

  async #append(runId: string, events: RunEventInput[], by: RunEventAppender): Promise<void> {
    if (events.length === 0) return;
    await this.#events.append(runId, events, by);
  }

  async #revokeAuthority(run: HostedRunRecord): Promise<void> {
    await this.#revoker.destroyCapsuleKey(run.capsuleId, run);
    await this.#revoker.cutRuntimeEgress(run.id, run);
  }

  /**
   * End a run: revoke its authority first, then commit the terminal status
   * only if nothing moved meanwhile (`stale` names what did).
   */
  async #end(
    run: HostedRunRecord,
    now: number,
    status: TaskStatus,
    changes: Partial<HostedRunRecord>,
    stale: (current: HostedRunRecord) => string | null,
  ): Promise<HostedRunRecord> {
    await this.#revokeAuthority(run);
    const current = await this.#requireRun(run.id);
    const problem = current.revision === run.revision ? stale(current) : "run changed during authority revocation";
    if (problem !== null) throw new Error(problem);
    const next = this.#next(current, now, {
      ...changes,
      status,
      completedAt: new Date(now).toISOString(),
      lease: null,
      pause: null,
      authorityEnded: true,
    });
    if (!(await this.#store.compareAndSet(run.id, current.revision, next))) {
      throw new Error(`run changed before ${status} committed`);
    }
    return next;
  }

  async #commit(
    run: HostedRunRecord,
    now: number,
    changes: Partial<HostedRunRecord>,
    conflict: string,
  ): Promise<HostedRunRecord> {
    const next = this.#next(run, now, changes);
    if (!(await this.#store.compareAndSet(run.id, run.revision, next))) throw new Error(conflict);
    return next;
  }

  async #mutateLeased(
    runId: string,
    leaseToken: string,
    now: number,
    mutate: (run: HostedRunRecord) => HostedRunRecord,
  ): Promise<HostedRunRecord> {
    const run = await this.#requireLeasedRun(runId, leaseToken, now);
    const mutated = mutate(structuredClone(run));
    const next = this.#next(run, now, mutated);
    if (!(await this.#store.compareAndSet(runId, run.revision, next))) {
      throw new Error("run lease was lost before commit");
    }
    return next;
  }

  async #requireLeasedRun(runId: string, leaseToken: string, now: number): Promise<HostedRunRecord> {
    const run = await this.#requireRun(runId);
    if (run.lease?.token !== leaseToken) throw new Error("stale run lease");
    if (new Date(run.lease.until).getTime() < now) throw new Error("run lease expired");
    return run;
  }

  async #requireSponsoredRun(runId: string, sponsorId: string): Promise<HostedRunRecord> {
    const run = await this.#requireRun(runId);
    if (run.sponsorId !== sponsorId) throw new Error("run does not belong to this sponsor");
    return run;
  }

  async #requireRun(runId: string): Promise<HostedRunRecord> {
    const run = await this.#store.get(runId);
    if (run === null) throw new Error(`unknown run ${runId}`);
    return run;
  }

  #next(
    current: HostedRunRecord,
    now: number,
    changes: Partial<HostedRunRecord>,
  ): HostedRunRecord {
    return {
      ...current,
      ...changes,
      id: current.id,
      revision: current.revision + 1,
      updatedAt: new Date(now).toISOString(),
    };
  }
}
