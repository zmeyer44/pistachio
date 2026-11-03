/**
 * `project.json` written 500 ms after the last edit (docs/recorder.md §5), one write
 * at a time, the latest state winning. `flush()` writes a pending change now.
 */
export interface AutosaveOptions {
  delay?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onSaved?: () => void;
  onError?: (error: unknown) => void;
}

export interface Autosave {
  schedule(text: string): void;
  flush(): Promise<void>;
  readonly pending: boolean;
}

export function createAutosave(write: (text: string) => Promise<void>, options: AutosaveOptions = {}): Autosave {
  const delay = options.delay ?? 500;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let latest: string | null = null;
  let written: string | null = null;
  let running: Promise<void> = Promise.resolve();

  const run = (): Promise<void> => {
    timer = null;
    running = running.then(async () => {
      const text = latest;
      if (text === null) return;
      // Back to what was written (an edit undone within the delay): nothing to write, and nothing left pending.
      if (text === written) {
        latest = null;
        options.onSaved?.();
        return;
      }
      try {
        await write(text);
        written = text;
        if (latest === text) latest = null;
        options.onSaved?.();
      } catch (error) {
        options.onError?.(error);
      }
    });
    return running;
  };

  return {
    schedule(text: string) {
      latest = text;
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => void run(), delay);
    },
    flush() {
      if (timer !== null) clearTimer(timer);
      return run();
    },
    get pending() {
      return latest !== null;
    },
  };
}
