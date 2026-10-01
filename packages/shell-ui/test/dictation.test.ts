import { describe, expect, it } from "vitest";
import {
  DICTATION_NEEDS_MIC,
  DICTATION_TOO_SHORT,
  DICTATION_UNHEARD,
  Dictation,
  MAX_DICTATION_SECONDS,
  speechError,
  spokenInsert,
  type DictationIo,
  type DictationPhase,
} from "../src/lib/dictation";
import type { Recorder, Recording } from "../src/lib/recorder";

/** A promise and its settling hands, for steps the test lets happen. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/** A microphone the test drives: how long each recording ran, what it transcribes to, and what became of it. */
function harness(options: { allow?: () => Promise<boolean>; seconds?: number; transcribe?: (recording: Recording) => Promise<string>; record?: () => Promise<void> } = {}) {
  const phases: DictationPhase[] = [];
  const texts: string[] = [];
  const errors: string[] = [];
  const recorders: Array<{ stopped: boolean; cancelled: boolean; autoStop: () => void; maxSeconds: number; level: (level: number) => void }> = [];
  const heard: Recording[] = [];
  const io: DictationIo = {
    allow: options.allow ?? (() => Promise.resolve(true)),
    record: async ({ onLevel, onAutoStop, maxSeconds }) => {
      await options.record?.();
      const entry = { stopped: false, cancelled: false, autoStop: onAutoStop, maxSeconds, level: onLevel };
      recorders.push(entry);
      const recorder: Recorder = {
        stop: () => {
          entry.stopped = true;
          onLevel(0);
          return Promise.resolve({ blob: new Blob(["opus"], { type: "audio/webm" }), mediaType: "audio/webm;codecs=opus", seconds: options.seconds ?? 3 });
        },
        cancel: () => {
          entry.cancelled = true;
        },
      };
      return recorder;
    },
    transcribe: async (recording) => {
      heard.push(recording);
      return (options.transcribe ?? (() => Promise.resolve("  Put the vendor beside the invoice  ")))(recording);
    },
  };
  const dictation = new Dictation(io, {
    onPhase: (phase) => phases.push(phase),
    onText: (text) => texts.push(text),
    onError: (message) => errors.push(message),
  });
  return { dictation, phases, texts, errors, recorders, heard };
}

describe("a dictation", () => {
  it("listens, then transcribes what was said into the field's text", async () => {
    const run = harness();
    await run.dictation.start();
    expect(run.dictation.phase).toBe("recording");
    expect(run.recorders[0]?.maxSeconds).toBe(MAX_DICTATION_SECONDS);
    run.recorders[0]?.level(0.6);
    expect(run.dictation.level).toBe(0.6);
    await run.dictation.finish();
    expect(run.phases).toEqual(["starting", "recording", "transcribing", "idle"]);
    expect(run.texts).toEqual(["Put the vendor beside the invoice"]);
    expect(run.errors).toEqual([]);
    expect(run.recorders[0]?.stopped).toBe(true);
    expect(run.dictation.level).toBe(0);
  });

  it("starts once: a second press while the microphone comes up or listens does nothing", async () => {
    const run = harness();
    const first = run.dictation.start();
    await run.dictation.start();
    await first;
    await run.dictation.start();
    expect(run.recorders).toHaveLength(1);
    expect(run.phases).toEqual(["starting", "recording"]);
  });

  it("says so when the microphone is not allowed, and records nothing", async () => {
    const run = harness({ allow: () => Promise.resolve(false) });
    await run.dictation.start();
    expect(run.recorders).toHaveLength(0);
    expect(run.errors).toEqual([DICTATION_NEEDS_MIC]);
    expect(run.dictation.phase).toBe("idle");
  });

  it("says the microphone was refused when the recorder is", async () => {
    const run = harness({
      record: () => Promise.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" })),
    });
    await run.dictation.start();
    expect(run.errors[0]).toMatch(/^The microphone was refused/);
    expect(run.dictation.phase).toBe("idle");
  });

  it("does not transcribe a tap", async () => {
    const run = harness({ seconds: 0.3 });
    await run.dictation.start();
    await run.dictation.finish();
    expect(run.heard).toHaveLength(0);
    expect(run.errors).toEqual([DICTATION_TOO_SHORT]);
    expect(run.dictation.phase).toBe("idle");
  });

  it("says nothing was heard when the transcript is empty", async () => {
    const run = harness({ transcribe: () => Promise.resolve("   ") });
    await run.dictation.start();
    await run.dictation.finish();
    expect(run.texts).toEqual([]);
    expect(run.errors).toEqual([DICTATION_UNHEARD]);
  });

  it("reports a failed transcription in the field's words", async () => {
    const run = harness({
      transcribe: () =>
        Promise.reject(
          new Error(
            "Error invoking remote method 'pistachio:speech-transcribe': Error: Voice isn't available right now: Pistachio's models couldn't be reached. Type your introduction instead.",
          ),
        ),
    });
    await run.dictation.start();
    await run.dictation.finish();
    expect(run.errors).toEqual(["Voice isn't available right now: Pistachio's models couldn't be reached."]);
    expect(run.dictation.phase).toBe("idle");
  });

  it("stops on its own at the limit, and transcribes what it heard", async () => {
    const run = harness();
    await run.dictation.start();
    run.recorders[0]?.autoStop();
    await flush();
    expect(run.texts).toEqual(["Put the vendor beside the invoice"]);
    expect(run.dictation.phase).toBe("idle");
  });

  it("discarded while listening, lets the microphone go and transcribes nothing", async () => {
    const run = harness();
    await run.dictation.start();
    run.dictation.cancel();
    expect(run.recorders[0]?.cancelled).toBe(true);
    expect(run.dictation.phase).toBe("idle");
    await run.dictation.finish();
    expect(run.heard).toHaveLength(0);
    expect(run.texts).toEqual([]);
  });

  it("discarded while the microphone comes up, lets go of it the moment it arrives", async () => {
    const allowed = deferred<boolean>();
    const run = harness({ allow: () => allowed.promise });
    const starting = run.dictation.start();
    expect(run.dictation.phase).toBe("starting");
    run.dictation.cancel();
    expect(run.dictation.phase).toBe("idle");
    allowed.resolve(true);
    await starting;
    expect(run.recorders).toHaveLength(0);
    expect(run.dictation.phase).toBe("idle");

    const arriving = deferred<void>();
    const late = harness({ record: () => arriving.promise });
    const coming = late.dictation.start();
    await flush();
    late.dictation.cancel();
    arriving.resolve();
    await coming;
    expect(late.recorders[0]?.cancelled).toBe(true);
    expect(late.dictation.phase).toBe("idle");
    expect(late.phases).toEqual(["starting", "idle"]);
  });

  it("discarded while transcribing, drops the words when they come", async () => {
    const words = deferred<string>();
    const run = harness({ transcribe: () => words.promise });
    await run.dictation.start();
    const finishing = run.dictation.finish();
    await flush();
    expect(run.dictation.phase).toBe("transcribing");
    run.dictation.cancel();
    words.resolve("Too late");
    await finishing;
    expect(run.texts).toEqual([]);
    expect(run.errors).toEqual([]);
    expect(run.dictation.phase).toBe("idle");
    // And the next recording is its own.
    await run.dictation.start();
    expect(run.dictation.phase).toBe("recording");
  });

  it("gone with its field, lets the microphone go and reports nothing more", async () => {
    const words = deferred<string>();
    const run = harness({ transcribe: () => words.promise });
    await run.dictation.start();
    const finishing = run.dictation.finish();
    await flush();
    run.dictation.dispose();
    words.resolve("Nobody to hear it");
    await finishing;
    expect(run.texts).toEqual([]);
    expect(run.phases).toEqual(["starting", "recording", "transcribing"]);
    await run.dictation.start();
    expect(run.recorders).toHaveLength(1);

    const listening = harness();
    await listening.dictation.start();
    listening.dictation.dispose();
    expect(listening.recorders[0]?.cancelled).toBe(true);
  });
});

describe("speechError", () => {
  it("drops the IPC wrapping and the walkthrough's advice to type instead", () => {
    expect(speechError(new Error("Error invoking remote method 'pistachio:speech-transcribe': Error: Couldn't transcribe the recording (timeout). Type your introduction instead."))).toBe(
      "Couldn't transcribe the recording (timeout).",
    );
    expect(speechError(new Error("The recording is too long to send."))).toBe("The recording is too long to send.");
    expect(speechError("offline")).toBe("offline");
  });
});

describe("spokenInsert", () => {
  it("fills an empty field", () => {
    expect(spokenInsert("", 0, 0, "Hello there.")).toEqual({ text: "Hello there.", caret: 12 });
  });

  it("follows what was typed with a space between", () => {
    expect(spokenInsert("Look at @notes.md", 17, 17, "and summarize it")).toEqual({ text: "Look at @notes.md and summarize it", caret: 34 });
    expect(spokenInsert("Look at ", 8, 8, "the invoice")).toEqual({ text: "Look at the invoice", caret: 19 });
  });

  it("goes in where the caret was, spaced from the words either side but not from punctuation", () => {
    expect(spokenInsert("Compare with.", 7, 7, "the vendor")).toEqual({ text: "Compare the vendor with.", caret: 18 });
    expect(spokenInsert("Compare it", 10, 10, "please")).toEqual({ text: "Compare it please", caret: 17 });
    expect(spokenInsert("Compare it.", 10, 10, "now")).toEqual({ text: "Compare it now.", caret: 14 });
  });

  it("replaces a selection", () => {
    expect(spokenInsert("Compare this with that", 8, 12, "the invoice")).toEqual({ text: "Compare the invoice with that", caret: 19 });
  });

  it("clamps a selection past the text's end", () => {
    expect(spokenInsert("Hi", 9, 12, "there")).toEqual({ text: "Hi there", caret: 8 });
  });
});
