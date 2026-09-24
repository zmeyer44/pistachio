/**
 * Watching a cloud run from the browser.
 *
 * Control streams a run's events over SSE. The ones that carry what the agent
 * actually saw and said are sealed under the Space key, so control relays
 * ciphertext and this module opens it here. A reader without that Space's key
 * still sees the run's shape — status, steps, which tool ran — and nothing of
 * its content, which is exactly the intended split.
 */

import {
  SseParser,
  foldRunEvent,
  type RunContentEvent,
  type RunControlEvent,
  type RunSummary,
  type SseFrame,
  type StoredRunEvent,
} from "@pistachio/protocol";
import { fromBase64, fromUtf8, open, runEventSealAad, runThreadSealAad, type SpaceKeys } from "@pistachio/sync-protocol";
import { runEventsUrl } from "./control";

export interface RunWatch {
  close(): void;
}

/** Open the whole-thread snapshot written by a desktop executor. */
export async function unsealDesktopThread(
  keys: SpaceKeys | null,
  runId: string,
  thread: { sealed: string } | null,
): Promise<RunSummary | null> {
  if (keys === null || thread === null) return null;
  try {
    const bytes = await open(keys.sealKey, fromBase64(thread.sealed), runThreadSealAad(runId));
    const value = JSON.parse(fromUtf8(bytes)) as { version?: unknown; run?: unknown };
    return value.version === 2 && typeof value.run === "object" && value.run !== null
      ? (value.run as RunSummary)
      : null;
  } catch {
    return null;
  }
}

/** Open one sealed event, or null when this browser cannot read it. */
async function unsealEvent(
  keys: SpaceKeys | null,
  runId: string,
  event: StoredRunEvent,
): Promise<RunContentEvent | null> {
  const wire = event.event as { t?: unknown; sealed?: unknown };
  if (wire.t !== "sealed" || typeof wire.sealed !== "string" || keys === null) return null;
  try {
    const bytes = await open(keys.sealKey, fromBase64(wire.sealed), runEventSealAad(runId, event.eventId));
    return JSON.parse(fromUtf8(bytes)) as RunContentEvent;
  } catch {
    return null;
  }
}

/** The stored events of one chunk of frames, and whether control said goodbye. */
function readFrames(frames: SseFrame[]): { events: StoredRunEvent[]; ended: boolean } {
  const events: StoredRunEvent[] = [];
  let ended = false;
  for (const frame of frames) {
    if (frame.event === "end") {
      ended = true;
      continue;
    }
    // Control names every event frame `run` (§7.8); anything else is a kind
    // of frame this build does not know about.
    if (frame.event !== "run") continue;
    let stored: StoredRunEvent;
    try {
      stored = JSON.parse(frame.data) as StoredRunEvent;
    } catch {
      continue;
    }
    // The stored `seq` and the frame's `id:` are the same number — control
    // writes both — and it is what a reconnect resumes from, so an event
    // that carries neither is not one this stream can be resumed past.
    const seq = Number.isInteger(stored.seq)
      ? stored.seq
      : frame.id === null
        ? Number.NaN
        : Number(frame.id);
    if (!Number.isInteger(seq)) continue;
    events.push({ ...stored, seq });
  }
  return { events, ended };
}

/**
 * Follow a run to its end, folding every event into a summary the page renders.
 * Reconnects from the last sequence it saw if the stream drops mid-run.
 */
export function watchRun(options: {
  runId: string;
  /** The device token as it stands: a long run outlives the one it started with. */
  getToken: () => Promise<string | null>;
  keys: SpaceKeys | null;
  onRun: (run: RunSummary) => void;
  onThreadUpdated?: () => void;
  onError?: (message: string) => void;
}): RunWatch {
  const controller = new AbortController();
  let run: RunSummary | null = null;
  let since = 0;
  let stopped = false;

  /**
   * Fold a whole chunk before the page hears about it once.
   *
   * Opening a sealed event is `crypto.subtle.decrypt`, whose promise settles
   * on a task of its own, so awaiting them one at a time hands React a render
   * between every event: replaying a long run drew the same thread once per
   * event. The chunk is opened in parallel, folded in order, and announced
   * once.
   */
  const applyChunk = async (events: StoredRunEvent[]): Promise<void> => {
    const opened = await Promise.all(
      events.map((event) =>
        event.event.t === "thread.updated" ? Promise.resolve(null) : unsealEvent(options.keys, options.runId, event),
      ),
    );
    let folded = false;
    let threadUpdated = false;
    events.forEach((event, index) => {
      since = Math.max(since, event.seq);
      if (event.event.t === "thread.updated") {
        threadUpdated = true;
        return;
      }
      // A sealed event this browser cannot open is skipped rather than guessed.
      const content: RunContentEvent | RunControlEvent | null =
        opened[index] ?? (event.event.t === "sealed" ? null : (event.event as RunControlEvent));
      if (content === null) return;
      try {
        run = foldRunEvent(run, content, event.at);
        folded = true;
      } catch {
        // An event before `run.created`, or one this build does not know.
      }
    });
    if (folded && run !== null) options.onRun(run);
    if (threadUpdated) options.onThreadUpdated?.();
  };

  const pump = async (): Promise<void> => {
    while (!stopped) {
      try {
        // Asked for on every dial: a device token lives ten minutes and a run
        // can outlast several of them.
        const bearer = await options.getToken();
        if (bearer === null) return;
        const response = await fetch(runEventsUrl(options.runId, since), {
          headers: { authorization: `Bearer ${bearer}` },
          signal: controller.signal,
        });
        if (!response.ok || response.body === null) {
          options.onError?.(`The run stream answered ${String(response.status)}.`);
          // Control refusing the request is final; a 5xx or a rate limit is
          // worth the same retry a dropped socket gets.
          if (response.status < 500 && response.status !== 429) return;
        } else {
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          const parser = new SseParser();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const { events, ended } = readFrames(parser.push(value));
            if (events.length > 0) await applyChunk(events);
            if (ended) return;
          }
        }
      } catch (error) {
        if (stopped || controller.signal.aborted) return;
        options.onError?.(error instanceof Error ? error.message : "The run stream stopped.");
      }
      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  };

  void pump();

  return {
    close: () => {
      stopped = true;
      controller.abort();
    },
  };
}
