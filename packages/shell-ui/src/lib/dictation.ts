/**
 * Dictation into a message field: the microphone listens until the person
 * says they are done, what was said is transcribed by the host (the same
 * speech-to-text the walkthrough's spoken introduction uses), and the text
 * lands in the field where the caret was — to be read back and sent, never
 * sent by itself.
 *
 * `Dictation` is the one recording's life, free of React so its races can
 * be tested: a recording discarded while the microphone is still coming up,
 * or while its words are being transcribed, leaves nothing behind.
 * `useDictation` is its hook.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { nativeApi, shellApi } from "../api";
import { blobToBase64, startRecording, type Recorder, type Recording } from "./recorder";

export type DictationPhase = "idle" | "starting" | "recording" | "transcribing";

/** A forgotten microphone stops itself after this long, and what it heard is transcribed. */
export const MAX_DICTATION_SECONDS = 120;
/** Shorter than this is a tap, not speech. */
const MIN_DICTATION_SECONDS = 0.8;

export const DICTATION_TOO_SHORT = "That was too short to hear. Press the microphone, speak, then press Done.";
export const DICTATION_UNHEARD = "Nothing was heard. Check the microphone and try again.";
export const DICTATION_NEEDS_MIC = "Pistachio needs the microphone to dictate. Allow it in System Settings → Privacy & Security → Microphone.";

/** What a recording needs from where it runs. */
export interface DictationIo {
  /** The system's say on the microphone (true where there is none to ask). */
  allow(): Promise<boolean>;
  record(options: { onLevel(level: number): void; onAutoStop(): void; maxSeconds: number }): Promise<Recorder>;
  transcribe(recording: Recording): Promise<string>;
}

export interface DictationEvents {
  onPhase(phase: DictationPhase): void;
  /** What was said, trimmed and never empty. */
  onText(text: string): void;
  onError(message: string): void;
}

export class Dictation {
  phase: DictationPhase = "idle";
  /** Loudness 0–1 while recording, about sixty times a second: read by the waveform, not rendered from. */
  level = 0;
  /** When this recording started listening (performance.now()). */
  startedAt = 0;
  /** Each recording's number: one discarded, or outlived, is no longer the current one, and what it finds is dropped. */
  #turn = 0;
  #recorder: Recorder | null = null;
  #disposed = false;
  readonly #io: DictationIo;
  readonly #events: DictationEvents;

  constructor(io: DictationIo, events: DictationEvents) {
    this.#io = io;
    this.#events = events;
  }

  /** Ask for the microphone and listen. Nothing while a recording is already under way. */
  async start(): Promise<void> {
    if (this.phase !== "idle" || this.#disposed) return;
    const turn = ++this.#turn;
    this.#set("starting");
    try {
      const allowed = await this.#io.allow();
      if (turn !== this.#turn) return;
      if (!allowed) {
        this.#fail(DICTATION_NEEDS_MIC);
        return;
      }
      const recorder = await this.#io.record({
        onLevel: (level) => {
          this.level = level;
        },
        onAutoStop: () => void this.finish(),
        maxSeconds: MAX_DICTATION_SECONDS,
      });
      if (turn !== this.#turn) {
        recorder.cancel();
        return;
      }
      this.#recorder = recorder;
      this.startedAt = performance.now();
      this.#set("recording");
    } catch (caught) {
      if (turn !== this.#turn) return;
      this.#fail(
        caught instanceof Error && caught.name === "NotAllowedError"
          ? "The microphone was refused. Allow it in System Settings → Privacy & Security → Microphone."
          : `Couldn't start the microphone (${caught instanceof Error ? caught.message : String(caught)}).`,
      );
    }
  }

  /** Stop listening and transcribe what was said. */
  async finish(): Promise<void> {
    const recorder = this.#recorder;
    if (recorder === null || this.phase !== "recording") return;
    this.#recorder = null;
    const turn = this.#turn;
    this.#set("transcribing");
    try {
      const recording = await recorder.stop();
      if (turn !== this.#turn) return;
      if (recording.seconds < MIN_DICTATION_SECONDS) {
        this.#fail(DICTATION_TOO_SHORT);
        return;
      }
      const text = (await this.#io.transcribe(recording)).trim();
      if (turn !== this.#turn) return;
      this.#set("idle");
      if (text === "") this.#events.onError(DICTATION_UNHEARD);
      else this.#events.onText(text);
    } catch (caught) {
      if (turn === this.#turn) this.#fail(speechError(caught));
    }
  }

  /** Drop the recording: nothing is transcribed, or what is being transcribed is not used. */
  cancel(): void {
    this.#turn += 1;
    this.#recorder?.cancel();
    this.#recorder = null;
    this.#set("idle");
  }

  /** The field is gone: the microphone is let go, and nothing more is heard from this recording. */
  dispose(): void {
    this.#disposed = true;
    this.#turn += 1;
    this.#recorder?.cancel();
    this.#recorder = null;
    this.phase = "idle";
  }

  #fail(message: string): void {
    this.#set("idle");
    this.#events.onError(message);
  }

  #set(phase: DictationPhase): void {
    if (phase !== "recording") this.level = 0;
    if (this.phase === phase || this.#disposed) return;
    this.phase = phase;
    this.#events.onPhase(phase);
  }
}

/**
 * A transcription failure, readable where the message is written: without
 * the IPC wrapping, and without the walkthrough's own advice (its speech
 * errors end by offering to type the introduction instead).
 */
export function speechError(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  return message
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, "")
    .replace(/\s*Type your introduction instead\.?$/, "")
    .trim();
}

/**
 * What was said, put in a field's text where its selection was, as if
 * typed there: a space between it and the words either side, none before
 * punctuation or at the text's ends. The caret goes after it.
 */
export function spokenInsert(value: string, start: number, end: number, spoken: string): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  const before = value.slice(0, from);
  const after = value.slice(to);
  const lead = before === "" || /\s$/u.test(before) ? "" : " ";
  const trail = after === "" || /^[\s.,;:!?)\]}]/u.test(after) ? "" : " ";
  return { text: `${before}${lead}${spoken}${trail}${after}`, caret: before.length + lead.length + spoken.length };
}

/** Where a microphone can be recorded from at all. */
export function dictationSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function" && typeof MediaRecorder !== "undefined";
}

/** The host's microphone and speech-to-text. */
const hostIo: DictationIo = {
  // Only a native window has a system permission dialog to raise; on a stream surface the browser asks itself.
  allow: async () => (await nativeApi()?.requestMicrophone()) ?? true,
  record: (options) => startRecording(options),
  transcribe: async (recording) =>
    shellApi().transcribeSpeech({ data: await blobToBase64(recording.blob), mediaType: recording.mediaType.split(";")[0] ?? "audio/webm" }),
};

/**
 * A field's dictation. `onText` gets what was said, `onError` what went
 * wrong; the recording stops with the component, unheard.
 */
export function useDictation(handlers: { onText(text: string): void; onError(message: string): void }): {
  phase: DictationPhase;
  /** The recording under way, for its level and clock. */
  dictation: Dictation | null;
  start(): void;
  finish(): void;
  cancel(): void;
} {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [phase, setPhase] = useState<DictationPhase>("idle");
  // Made in an effect, so React's rehearsal unmount in development (StrictMode) disposes one and the mount makes the next.
  const [dictation, setDictation] = useState<Dictation | null>(null);
  useEffect(() => {
    const made = new Dictation(hostIo, {
      onPhase: setPhase,
      onText: (text) => handlersRef.current.onText(text),
      onError: (message) => handlersRef.current.onError(message),
    });
    setDictation(made);
    setPhase("idle");
    return () => made.dispose();
  }, []);
  const start = useCallback(() => void dictation?.start(), [dictation]);
  const finish = useCallback(() => void dictation?.finish(), [dictation]);
  const cancel = useCallback(() => dictation?.cancel(), [dictation]);
  return { phase, dictation, start, finish, cancel };
}
