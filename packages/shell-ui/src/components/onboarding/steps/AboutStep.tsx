import { useEffect, useRef, useState } from "react";
import { Keyboard, Mic, RotateCcw, Square, X } from "lucide-react";
import { MAX_MEMORY_CONTENT, MAX_MEMORY_LABEL } from "@pistachio/shell-contracts/memory";
import { MAX_INTRO_SECONDS, MAX_INTRO_TRANSCRIPT, type OnboardingIntake } from "@pistachio/shell-contracts/onboarding";
import { cn } from "../../../lib/cn";
import { aboutCopy } from "../../../lib/onboarding-steps";
import { blobToBase64, startRecording, type Recorder } from "../../../lib/recorder";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { useSurface } from "../../../surface";
import { MockWindow, StageNotice } from "../parts";
import { nativeApi, shellApi } from "../../../api";

type Phase = "idle" | "starting" | "recording" | "transcribing" | "thinking" | "done" | "failed";
type Voice = "checking" | "ready" | "unavailable";

// The models work without signing in (a Mac nobody signed in on is given an
// anonymous account), so voice is missing only when control was unreachable —
// or on the web, where there is no such thing as signed out.
const NO_VOICE = "Voice isn't available right now. Type your introduction below instead.";
const NO_VOICE_SIGN_IN = "Voice isn't available right now. Type your introduction below, or sign in.";

function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The about step's stage: a microphone that listens for an introduction,
 * the transcript it heard, and the name and bio read out of it — every
 * one editable before it becomes memory. Typing is always an option; it
 * is the only option when no model can transcribe, and the stage says so
 * instead of showing a mic that would fail.
 *
 * Under the introduction sits the walkthrough's one mention of an account:
 * a quiet "Or sign in" where the wizard says signing in could work
 * (`onSignIn`), and who is signed in once someone is (`signedInAs`).
 */
export function AboutStep({
  intake,
  onIntake,
  onBusy,
  onSignIn,
  signedInAs = null,
  modelsKey = "",
}: {
  intake: OnboardingIntake;
  onIntake: (next: OnboardingIntake) => void;
  onBusy: (busy: boolean) => void;
  /** Opens the wizard's sign-in form; absent where no sign-in is on offer. */
  onSignIn?: () => void;
  signedInAs?: string | null;
  /**
   * Changes when the models may have become reachable — the account state,
   * since the anonymous account can land a moment after the wizard opens.
   */
  modelsKey?: string;
}) {
  // The caption under the microphone is a promise about where the recording
  // goes, and where it goes depends on the surface (§14): a browser tab is
  // not "this Mac". `aboutCopy` holds both wordings.
  const surface = useSurface().kind;
  const recordingNote = aboutCopy(surface).recording;
  const [voice, setVoice] = useState<Voice>("checking");
  const [phase, setPhase] = useState<Phase>(intake.transcript === "" ? "idle" : "done");
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState(intake.transcript === "" && (intake.name !== "" || intake.about !== ""));
  const recorder = useRef<Recorder | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    const supported = typeof navigator.mediaDevices?.getUserMedia === "function" && typeof MediaRecorder !== "undefined";
    shellApi()
      .getAiStatus()
      .then((status) => {
        if (live) setVoice(supported && status.available ? "ready" : "unavailable");
      })
      .catch(() => {
        if (live) setVoice("unavailable");
      });
    return () => {
      live = false;
    };
  }, [modelsKey]);

  useEffect(() => () => recorder.current?.cancel(), []);

  // The wizard's Continue waits while a recording is being made or read.
  const busy = phase === "starting" || phase === "recording" || phase === "transcribing" || phase === "thinking";
  useEffect(() => onBusy(busy), [busy, onBusy]);

  useEffect(() => {
    if (phase !== "recording") return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => setSeconds((Date.now() - startedAt) / 1000), 250);
    return () => window.clearInterval(timer);
  }, [phase]);

  const fail = (message: string) => {
    setError(message);
    setPhase("failed");
    setTyping(true);
  };

  const finish = async () => {
    const current = recorder.current;
    if (current === null) return;
    recorder.current = null;
    setPhase("transcribing");
    try {
      const recording = await current.stop();
      if (recording.seconds < 0.8) {
        setPhase("idle");
        setError("That was too short to hear — hold the button and say a few sentences.");
        return;
      }
      const data = await blobToBase64(recording.blob);
      const transcript = await shellApi().transcribeSpeech({ data, mediaType: recording.mediaType.split(";")[0] ?? "audio/webm" });
      setPhase("thinking");
      const next = await shellApi().extractOnboardingIntake(transcript);
      onIntake({ ...next, transcript });
      setPhase("done");
      setError(null);
    } catch (caught) {
      fail(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const start = async () => {
    setError(null);
    setPhase("starting");
    try {
      // Only a native window has an OS permission dialog to raise; on a
      // stream surface the browser asks for the microphone itself.
      const allowed = (await nativeApi()?.requestMicrophone()) ?? true;
      if (!allowed) {
        fail("Pistachio needs the microphone for this. Allow it in System Settings → Privacy & Security → Microphone, or type instead.");
        return;
      }
      setSeconds(0);
      recorder.current = await startRecording({
        onLevel: setLevel,
        maxSeconds: MAX_INTRO_SECONDS,
        onAutoStop: () => void finish(),
      });
      setPhase("recording");
    } catch (caught) {
      fail(
        caught instanceof Error && caught.name === "NotAllowedError"
          ? "The microphone was refused. Allow it in System Settings → Privacy & Security → Microphone, or type instead."
          : `Couldn't start the microphone (${caught instanceof Error ? caught.message : String(caught)}). Type instead.`,
      );
    }
  };

  const toggle = () => {
    if (phase === "recording") void finish();
    else if (phase === "idle" || phase === "done" || phase === "failed") void start();
  };

  const edit = (patch: Partial<OnboardingIntake>) => onIntake({ ...intake, ...patch });
  const showFields = typing || phase === "done" || voice === "unavailable";
  const label =
    phase === "starting"
      ? "Getting the microphone…"
      : phase === "recording"
        ? `Listening · ${clock(seconds)}`
        : phase === "transcribing"
          ? "Transcribing what you said…"
          : phase === "thinking"
            ? "Reading it for what to remember…"
            : phase === "done"
              ? "Heard you. Check what's below."
              : "Tap and introduce yourself";

  return (
    <MockWindow testId="onboarding-about" className="max-h-full">
      <div className="scroll-thin flex max-h-[calc(100vh-200px)] flex-col gap-5 overflow-y-auto px-8 pb-8">
        {voice === "unavailable" ? (
          <StageNotice tone="info">{onSignIn === undefined ? NO_VOICE : NO_VOICE_SIGN_IN}</StageNotice>
        ) : (
          <div className="flex flex-col items-center gap-3 py-2">
            <div className="relative grid size-32 place-items-center">
              {phase === "recording" ? (
                <>
                  <span
                    aria-hidden="true"
                    className="onboarding-ring absolute inset-0 rounded-full bg-(--theme-accent)"
                    style={{ transform: `scale(${String(1 + level * 0.55)})`, opacity: 0.16 + level * 0.25 }}
                  />
                  <span
                    aria-hidden="true"
                    className="onboarding-ring absolute inset-3 rounded-full bg-(--theme-accent)"
                    style={{ transform: `scale(${String(1 + level * 0.3)})`, opacity: 0.28 + level * 0.3 }}
                  />
                </>
              ) : null}
              <button
                type="button"
                data-testid="onboarding-mic"
                aria-label={phase === "recording" ? "Stop recording" : "Start recording"}
                aria-pressed={phase === "recording"}
                disabled={voice === "checking" || busy && phase !== "recording"}
                onClick={toggle}
                className={cn(
                  "relative grid size-[88px] cursor-pointer place-items-center rounded-full text-white shadow-modal outline-none transition-[transform,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background active:scale-95 disabled:cursor-default disabled:opacity-60",
                  phase === "recording" ? "bg-red-700 hover:bg-red-900" : "bg-gray-1000 hover:bg-gray-900",
                )}
              >
                {phase === "recording" ? (
                  <Square className="size-7 fill-current" aria-hidden="true" />
                ) : phase === "transcribing" || phase === "thinking" || phase === "starting" ? (
                  <span aria-hidden="true" className="agent-thinking-dots [&_i]:size-2 [&_i]:bg-white">
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  <Mic className="size-8" aria-hidden="true" />
                )}
              </button>
            </div>
            <p aria-live="polite" className="text-label-14 font-medium text-gray-1000">
              {label}
            </p>
            <p className="max-w-[36ch] text-center text-label-12 text-gray-700">
              {phase === "recording"
                ? `Your name, what you do, what you're into. Up to ${String(Math.round(MAX_INTRO_SECONDS / 60))} minutes; tap to finish.`
                : recordingNote}
            </p>
            {!showFields ? (
              <button
                type="button"
                data-testid="onboarding-type-instead"
                onClick={() => {
                  setTyping(true);
                  window.setTimeout(() => nameRef.current?.focus(), 0);
                }}
                className="mt-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1 text-label-12 text-gray-900 hover:bg-alpha-100 hover:text-gray-1000"
              >
                <Keyboard className="size-3.5" aria-hidden="true" />
                I&apos;d rather type
              </button>
            ) : null}
          </div>
        )}

        {error !== null ? <StageNotice tone={phase === "failed" ? "warning" : "info"}>{error}</StageNotice> : null}

        {phase === "done" && intake.transcript !== "" ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="onboarding-transcript" className="text-label-13 text-gray-1000">
                What you said
              </label>
              <button
                type="button"
                onClick={() => void start()}
                className="flex cursor-pointer items-center gap-1 rounded-sm px-1.5 py-0.5 text-label-12 text-gray-900 hover:bg-alpha-100 hover:text-gray-1000"
              >
                <RotateCcw className="size-3" aria-hidden="true" />
                Record again
              </button>
            </div>
            <Textarea
              id="onboarding-transcript"
              value={intake.transcript}
              maxLength={MAX_INTRO_TRANSCRIPT}
              onChange={(event) => edit({ transcript: event.target.value })}
              className="min-h-16 text-copy-13 text-gray-900"
            />
          </div>
        ) : null}

        {showFields ? (
          <div className="flex flex-col gap-4" data-testid="onboarding-about-fields">
            <Input
              ref={nameRef}
              label="What should Pistachio call you?"
              placeholder="Alex"
              autoComplete="off"
              maxLength={MAX_MEMORY_LABEL}
              value={intake.name}
              data-testid="onboarding-name"
              onChange={(event) => edit({ name: event.target.value })}
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="onboarding-about-text" className="text-label-13 text-gray-1000">
                About you
              </label>
              <Textarea
                id="onboarding-about-text"
                data-testid="onboarding-bio"
                placeholder="Product designer at a small studio. Runs most mornings, cooks on weekends, reads a lot of science fiction."
                maxLength={MAX_MEMORY_CONTENT}
                value={intake.about}
                onChange={(event) => edit({ about: event.target.value })}
                className="min-h-22 text-copy-13"
              />
              <p className="text-label-12 text-gray-900">What you do, what you care about, how you like things done — what you&apos;d tell a new assistant on day one.</p>
            </div>
            {intake.facts.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-label-13 text-gray-1000">Also worth remembering</p>
                <ul className="flex flex-wrap gap-1.5">
                  {intake.facts.map((fact) => (
                    <li
                      key={fact.content}
                      className="flex max-w-full items-center gap-1 rounded-full bg-alpha-100 py-1 pr-1 pl-2.5 text-label-12 text-gray-1000"
                    >
                      <span className="truncate">{fact.label === null ? fact.content : `${fact.label}: ${fact.content}`}</span>
                      <button
                        type="button"
                        aria-label={`Don't remember: ${fact.content}`}
                        onClick={() => edit({ facts: intake.facts.filter((candidate) => candidate !== fact) })}
                        className="grid size-4 cursor-pointer place-items-center rounded-full text-gray-700 hover:bg-alpha-200 hover:text-gray-1000"
                      >
                        <X className="size-2.5" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {signedInAs !== null ? (
          <p className="text-center text-label-12 text-gray-700" data-testid="onboarding-signed-in">
            Signed in as {signedInAs}
          </p>
        ) : onSignIn !== undefined ? (
          <button
            type="button"
            data-testid="onboarding-sign-in"
            disabled={busy}
            onClick={onSignIn}
            className="cursor-pointer self-center rounded-sm px-2 py-1 text-label-12 text-gray-900 underline-offset-2 hover:bg-alpha-100 hover:text-gray-1000 hover:underline disabled:cursor-default disabled:opacity-50"
          >
            Or sign in
          </button>
        ) : null}
      </div>
    </MockWindow>
  );
}
