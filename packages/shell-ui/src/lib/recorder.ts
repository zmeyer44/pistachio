/**
 * The microphone, for the wizard's spoken introduction: one recording at a
 * time, its level read back for the ring around the button, and the result
 * as a Blob main can transcribe. WebM/Opus is what Chromium's recorder
 * produces natively and what every transcription model accepts.
 */

export interface Recording {
  blob: Blob;
  mediaType: string;
  /** Seconds, from the recorder's clock. */
  seconds: number;
}

export interface Recorder {
  /** Finish and hand back what was said. */
  stop(): Promise<Recording>;
  /** Drop the recording without a result. */
  cancel(): void;
}

const PREFERRED_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function recorderType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return PREFERRED_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

/**
 * Ask for the microphone and start recording. `onLevel` gets a 0–1 loudness
 * about sixty times a second while the recording runs. `maxSeconds` stops
 * it on its own, so a forgotten mic never records forever.
 */
export async function startRecording(options: {
  onLevel?: (level: number) => void;
  onAutoStop?: () => void;
  maxSeconds: number;
}): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const mediaType = recorderType();
  const recorder = mediaType === undefined ? new MediaRecorder(stream) : new MediaRecorder(stream, { mimeType: mediaType });
  const chunks: BlobPart[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });

  // The level meter: RMS of the time-domain signal, eased so the ring breathes.
  let context: AudioContext | null = null;
  let frame = 0;
  if (options.onLevel !== undefined) {
    try {
      context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const onLevel = options.onLevel;
      let smoothed = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const centered = (sample - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / samples.length);
        // Speech sits around 0.05–0.3 RMS; stretch that to fill the ring.
        const level = Math.min(1, rms * 4);
        smoothed = level > smoothed ? level : smoothed * 0.85 + level * 0.15;
        onLevel(smoothed);
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    } catch {
      context = null;
    }
  }

  const startedAt = performance.now();
  let settled = false;
  const release = () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    for (const track of stream.getTracks()) track.stop();
    void context?.close().catch(() => {});
    context = null;
    options.onLevel?.(0);
  };

  const stopped = new Promise<Recording>((resolve, reject) => {
    recorder.addEventListener("stop", () => {
      release();
      resolve({
        blob: new Blob(chunks, { type: recorder.mimeType || mediaType || "audio/webm" }),
        mediaType: recorder.mimeType || mediaType || "audio/webm",
        seconds: (performance.now() - startedAt) / 1000,
      });
    });
    recorder.addEventListener("error", () => {
      release();
      reject(new Error("The microphone stopped unexpectedly."));
    });
  });

  const stop = (): Promise<Recording> => {
    if (!settled) {
      settled = true;
      if (recorder.state !== "inactive") recorder.stop();
      else release();
    }
    return stopped;
  };
  const timer = window.setTimeout(() => {
    if (settled) return;
    void stop();
    options.onAutoStop?.();
  }, options.maxSeconds * 1000);

  recorder.start(250);
  return {
    stop: () => {
      window.clearTimeout(timer);
      return stop();
    },
    cancel: () => {
      window.clearTimeout(timer);
      settled = true;
      if (recorder.state !== "inactive") recorder.stop();
      else release();
    },
  };
}

/** A Blob as base64, the way the recording crosses IPC. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read the recording."));
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}
