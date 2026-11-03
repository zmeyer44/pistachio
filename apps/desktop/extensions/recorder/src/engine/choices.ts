/** What the person chose last in the panel; `/record` and ⌘⇧6 use it too. Kept in `storage.local` under `choices`. Pure. */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Choices {
  /** A mic's deviceId ("default" for the system's), or null for none. */
  mic: string | null;
  camera: boolean;
  pageAudio: boolean;
  quality: "crisp" | "native";
  /** Seconds: 0, 3 or 5. */
  countdown: number;
}

export const CHOICES_KEY = "choices";
export const COUNTDOWNS = [0, 3, 5] as const;

/** The stored choices over the settings' defaults (`scale`, `countdown`); the mic off and the camera off unless chosen. */
export function choicesFrom(stored: unknown, settings: Record<string, Json | undefined>): Choices {
  const s = (stored ?? {}) as Partial<Record<keyof Choices, unknown>>;
  const countdownSetting = Number(settings["countdown"] ?? 3);
  const quality = s.quality === "crisp" || s.quality === "native" ? s.quality : settings["scale"] === "native" ? "native" : "crisp";
  const allowed = (value: unknown): value is number => typeof value === "number" && (COUNTDOWNS as readonly number[]).includes(value);
  return {
    mic: typeof s.mic === "string" && s.mic !== "" ? s.mic : null,
    camera: s.camera === true,
    pageAudio: s.pageAudio !== false,
    quality,
    countdown: allowed(s.countdown) ? s.countdown : allowed(countdownSetting) ? countdownSetting : 3,
  };
}

/** Crisp is 2× at the frame-rate setting (60 unless set to 30); Native is 1× at 30. */
export function qualityOf(quality: Choices["quality"], fpsSetting: Json | undefined): { scale: 1 | 2; fps: 30 | 60 } {
  if (quality === "native") return { scale: 1, fps: 30 };
  return { scale: 2, fps: String(fpsSetting ?? "60") === "30" ? 30 : 60 };
}
