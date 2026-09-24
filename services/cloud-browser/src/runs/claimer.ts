/**
 * The claim loop (docs/cloud-sync-design.md §7.3, §8.4): poll
 * `POST /internal/runs/claim`, hand each claimed run to the executor, and
 * heartbeat its lease at less than half the lease length until the run
 * ends. A heartbeat control refuses (stale or expired lease) aborts the
 * run through the lease's `lost` signal.
 */

import { ControlError, type ClaimedRunResponse, type ControlClient } from "../control-client.js";
import { errorMessage, silentLogger, type Logger } from "../logger.js";

export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_CLAIM_INTERVAL_MS = 2_000;
export const DEFAULT_MAX_CONCURRENT_RUNS = 4;

export interface LeaseHandle {
  readonly token: string;
  /** Aborted when control stops accepting the lease. */
  readonly lost: AbortSignal;
  /** Whether the lease is still believed valid. */
  readonly alive: boolean;
}

export interface RunClaimerOptions {
  control: ControlClient;
  workerId: string;
  /** This worker's public address, put on the lease for the live view (§8.5). */
  workerUrl?: string | null;
  execute: (claimed: ClaimedRunResponse, lease: LeaseHandle) => Promise<void>;
  leaseMs?: number;
  claimIntervalMs?: number;
  maxConcurrent?: number;
  log?: Logger;
}

export class RunClaimer {
  readonly #control: ControlClient;
  readonly #workerId: string;
  readonly #workerUrl: string | null;
  readonly #execute: RunClaimerOptions["execute"];
  readonly #leaseMs: number;
  readonly #claimIntervalMs: number;
  readonly #maxConcurrent: number;
  readonly #log: Logger;
  readonly #running = new Set<Promise<void>>();
  #loop: Promise<void> | null = null;
  #stopped = true;
  #wake: (() => void) | null = null;

  constructor(options: RunClaimerOptions) {
    this.#control = options.control;
    this.#workerId = options.workerId;
    this.#workerUrl = options.workerUrl ?? null;
    this.#execute = options.execute;
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.#claimIntervalMs = options.claimIntervalMs ?? DEFAULT_CLAIM_INTERVAL_MS;
    this.#maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_RUNS;
    this.#log = options.log ?? silentLogger;
  }

  get active(): number {
    return this.#running.size;
  }

  get workerId(): string {
    return this.#workerId;
  }

  /** The heartbeat cadence: under half the lease length. */
  get heartbeatMs(): number {
    return Math.max(250, Math.floor(this.#leaseMs / 3));
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#loop = this.#run();
  }

  /** Stop claiming new runs; running executions continue. */
  async stopClaiming(): Promise<void> {
    this.#stopped = true;
    this.#wake?.();
    await this.#loop;
    this.#loop = null;
  }

  /** Stop claiming; resolves once running executions have finished. */
  async stop(): Promise<void> {
    await this.stopClaiming();
    await Promise.all([...this.#running]);
  }

  /** Claim once, now (tests and the steer path). Returns whether a run was started. */
  async claimOnce(): Promise<boolean> {
    if (this.#running.size >= this.#maxConcurrent) return false;
    const claimed = await this.#control.claimRun(this.#workerId, this.#workerUrl);
    if (claimed === null) return false;
    this.#start(claimed);
    return true;
  }

  async #run(): Promise<void> {
    while (!this.#stopped) {
      let claimed = false;
      try {
        claimed = await this.claimOnce();
      } catch (error) {
        this.#log.warn("claim failed", { error: errorMessage(error) });
      }
      if (claimed) continue;
      await this.#sleep(this.#claimIntervalMs);
    }
  }

  #start(claimed: ClaimedRunResponse): void {
    const runId = claimed.run.id;
    const lost = new AbortController();
    let alive = true;
    const beat = async (): Promise<void> => {
      try {
        await this.#control.heartbeat(runId, claimed.leaseToken);
      } catch (error) {
        if (error instanceof ControlError && error.status >= 400 && error.status < 500) {
          alive = false;
          clearInterval(timer);
          this.#log.warn("run lease lost", { runId, status: error.status, code: error.code });
          lost.abort(new Error(`run lease lost (${String(error.status)})`));
          return;
        }
        this.#log.warn("heartbeat failed", { runId, error: errorMessage(error) });
      }
    };
    const timer = setInterval(() => void beat(), this.heartbeatMs);
    timer.unref();
    const lease: LeaseHandle = {
      token: claimed.leaseToken,
      lost: lost.signal,
      get alive() {
        return alive;
      },
    };
    const execution = this.#execute(claimed, lease)
      .catch((error: unknown) => {
        this.#log.error("run execution failed", { runId, error: errorMessage(error) });
      })
      .finally(() => {
        clearInterval(timer);
        this.#running.delete(execution);
        this.#wake?.();
      });
    this.#running.add(execution);
  }

  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#wake = null;
        resolve();
      }, ms);
      timer.unref();
      this.#wake = () => {
        clearTimeout(timer);
        this.#wake = null;
        resolve();
      };
    });
  }
}
