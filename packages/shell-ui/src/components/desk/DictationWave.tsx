import { useEffect, useState } from "react";
import type { Dictation, DictationPhase } from "../../lib/dictation";

/** Samples the waveform keeps: enough to fill the Bar's field; the oldest scroll off its leading edge. */
const WAVE_SAMPLES = 120;
/** How often it takes one, and the clock ticks: slow enough to read as speech, not noise. */
const WAVE_TICK_MS = 80;

function clock(totalSeconds: number): string {
  const whole = Math.floor(totalSeconds);
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The Bar's field while it listens: what the microphone hears scrolling in
 * from the trailing end, and how long it has listened — then, while the
 * words are transcribed, held still. Its own component, so the samples
 * re-render only this.
 */
export function DictationWave({ dictation, phase }: { dictation: Dictation | null; phase: DictationPhase }) {
  const [levels, setLevels] = useState<number[]>(() => Array.from({ length: WAVE_SAMPLES }, () => 0));
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (phase !== "recording" || dictation === null) return;
    const timer = window.setInterval(() => {
      setSeconds((performance.now() - dictation.startedAt) / 1000);
      setLevels((prev) => [...prev.slice(1), dictation.level]);
    }, WAVE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [dictation, phase]);

  return (
    <div
      role="img"
      aria-label={phase === "recording" ? `Listening · ${clock(seconds)}` : phase === "transcribing" ? "Transcribing what you said" : "Starting the microphone"}
      data-testid="desk-bar-dictation"
      data-phase={phase}
      className="desk-bar-dictation"
    >
      <div className="desk-bar-wave" aria-hidden="true">
        {levels.map((level, index) => (
          <span key={index} style={{ height: `${String(Math.max(3, Math.round(level * 24)))}px` }} />
        ))}
      </div>
      <span className="desk-bar-dictation-clock" aria-hidden="true">
        {phase === "transcribing" ? (
          "Transcribing…"
        ) : (
          <>
            <span className="desk-bar-dictation-dot" data-live={phase === "recording" ? "" : undefined} />
            {clock(seconds)}
          </>
        )}
      </span>
    </div>
  );
}
