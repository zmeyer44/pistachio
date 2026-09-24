/**
 * Bound a promise by wall time and by an abort signal.
 *
 * A browser call that never settles (Chromium exited under the CDP socket,
 * a page that never finishes attaching) would otherwise hold its turn open
 * for ever: the run keeps heartbeating its lease, the person's follow-up
 * waits behind the stuck tool, and nothing can time out, fail, or reclaim
 * it. Every browser tool call and every tab set-up step runs through this.
 */

export class DeadlineError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not finish within ${String(Math.round(ms / 1000))}s; the browser may be unresponsive`);
    this.name = "DeadlineError";
  }
}

export interface DeadlineOptions {
  /** Rejects at once with the signal's reason when it aborts. */
  signal?: AbortSignal | undefined;
}

export function withDeadline<T>(work: Promise<T>, ms: number, what: string, options: DeadlineOptions = {}): Promise<T> {
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new DeadlineError(what, ms));
    }, ms);
    timer.unref?.();
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "aborted");
}
