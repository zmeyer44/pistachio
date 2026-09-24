/**
 * Retry queue for best-effort runner steers (§7.3): when the
 * `POST <CLOUD_BROWSER_URL>/v1/tasks/steer` call at revoke time fails, the
 * steer is queued here and retried until it lands or `MAX_OUTBOX_ATTEMPTS`
 * is reached, so a revoked cloud device's runner eventually learns about it.
 * Drained opportunistically on each revoke and every 60 s by the server.
 */

import type { IMessageThreadRouteRequest, IMessageThreadRouteResult } from "@pistachio/protocol";

export type SteerBody =
  | { kind: "device.revoked"; userId: string; deviceId: string }
  | { kind: "run.command"; runId: string; command: unknown }
  /** A browser session the person ended: the worker tears it down and closes every viewer (§4.3). */
  | { kind: "session.ended"; sessionId: string };

export interface RunnerClient {
  /** `POST /v1/devices/provision {userId, nonce}` (10 s timeout); throws on failure. */
  provision(userId: string, nonce: string): Promise<void>;
  /** `POST /v1/tasks/steer` (2 s timeout); throws on failure. */
  steer(body: SteerBody): Promise<void>;
  /** Classify a linked sender's message against one encrypted candidate thread. */
  routeIMessage(input: IMessageThreadRouteRequest): Promise<IMessageThreadRouteResult>;
}

/** Stop retrying a single steer after this many failed deliveries. */
export const MAX_OUTBOX_ATTEMPTS = 20;

export interface OutboxEntry {
  id: number;
  body: SteerBody;
  attempts: number;
  lastError: string | null;
}

export interface OutboxFlushResult {
  delivered: number;
  pending: number;
}

export class SteerOutbox {
  private readonly entries: OutboxEntry[] = [];
  private nextId = 1;
  private draining: Promise<OutboxFlushResult> | null = null;

  constructor(private readonly runner: () => RunnerClient | null) {}

  get pending(): ReadonlyArray<OutboxEntry> {
    return this.entries;
  }

  enqueue(body: SteerBody, error?: unknown): void {
    this.entries.push({
      id: this.nextId++,
      body,
      attempts: error === undefined ? 0 : 1,
      lastError: error === undefined ? null : errorText(error),
    });
  }

  /** Try the steer now; queue it for retry on failure. */
  async send(body: SteerBody): Promise<boolean> {
    const runner = this.runner();
    if (runner === null) return false;
    try {
      await runner.steer(body);
      return true;
    } catch (err) {
      this.enqueue(body, err);
      return false;
    }
  }

  flush(): Promise<OutboxFlushResult> {
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async drain(): Promise<OutboxFlushResult> {
    const runner = this.runner();
    let delivered = 0;
    if (runner === null) return { delivered, pending: this.entries.length };
    for (const entry of [...this.entries]) {
      if (entry.attempts >= MAX_OUTBOX_ATTEMPTS) {
        this.remove(entry.id);
        continue;
      }
      try {
        await runner.steer(entry.body);
        this.remove(entry.id);
        delivered += 1;
      } catch (err) {
        entry.attempts += 1;
        entry.lastError = errorText(err);
      }
    }
    return { delivered, pending: this.entries.length };
  }

  private remove(id: number): void {
    const index = this.entries.findIndex((e) => e.id === id);
    if (index !== -1) this.entries.splice(index, 1);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Periodic drain loop for the long-running server. Returns a stop function. */
export function startOutboxDrain(
  outbox: SteerOutbox,
  intervalMs = 60_000,
  log: (line: string) => void = console.error,
): () => void {
  const timer = setInterval(() => {
    void outbox.flush().catch((err: unknown) => {
      log(`steer outbox drain failed: ${errorText(err)}`);
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** A non-2xx answer from the runner, with the error code its JSON body carried. */
export class RunnerResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    path: string,
  ) {
    super(`runner responded ${String(status)}${code === null ? "" : ` ${code}`} to ${path}`);
    this.name = "RunnerResponseError";
  }
}

/** HTTP runner client over `CLOUD_BROWSER_URL` with the service bearer. */
export function httpRunnerClient(options: {
  baseUrl: string;
  serviceToken: string;
  fetch?: typeof fetch;
  provisionTimeoutMs?: number;
  steerTimeoutMs?: number;
  routeTimeoutMs?: number;
}): RunnerClient {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  /** Posts JSON; a successful body is discarded unless the caller reads it. */
  const post = async (path: string, body: unknown, timeoutMs: number, read = false): Promise<Response> => {
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.serviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const failure = await res.json().catch(() => null) as { error?: unknown } | null;
      throw new RunnerResponseError(res.status, typeof failure?.error === "string" ? failure.error : null, path);
    }
    if (!read) await res.body?.cancel().catch(() => undefined);
    return res;
  };
  return {
    async provision(userId, nonce) {
      await post("/v1/devices/provision", { userId, nonce }, options.provisionTimeoutMs ?? 10_000);
    },
    async steer(body) {
      await post("/v1/tasks/steer", body, options.steerTimeoutMs ?? 2_000);
    },
    async routeIMessage(input) {
      // Must exceed the runner's whole routing budget (key fetch, decrypts and
      // the model call) so control never abandons an answer that is about to
      // arrive.
      const res = await post("/v1/imessage/route", input, options.routeTimeoutMs ?? 12_000, true);
      const result = await res.json() as Partial<IMessageThreadRouteResult>;
      if (
        (result.decision !== "continue" && result.decision !== "new") ||
        typeof result.confidence !== "number" ||
        !Number.isFinite(result.confidence) ||
        result.confidence < 0 ||
        result.confidence > 1
      ) {
        throw new Error("runner returned an invalid iMessage routing decision");
      }
      return { decision: result.decision, confidence: result.confidence };
    },
  };
}
