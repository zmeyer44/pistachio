/**
 * The one conversation both Watchtower surfaces have with the archive: the
 * page (what was saved) and Settings → Watchtower (how saving behaves).
 *
 * The archive lives in its own process and keeps its own settings beside the
 * data they govern, so neither surface reads them from the settings file.
 * This hook asks for status, keeps it fresh while the surface is open, and
 * reports the capture state to the store so the chrome's Watchtower button
 * can show it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WatchtowerRequest,
  WatchtowerResponse,
  WatchtowerSettings,
  WatchtowerStats,
} from "@pistachio/shell-contracts/watchtower";
import { shellApi } from "../../api";
import { useAppStore } from "../../store";

export const watchtowerError = (error: unknown): string =>
  error instanceof Error ? error.message : "Watchtower could not complete that request.";

export type CaptureState = "off" | "recording" | "paused";

export function captureStateOf(settings: WatchtowerSettings, stats: Pick<WatchtowerStats, "full">): CaptureState {
  return !settings.enabled ? "off" : settings.paused || stats.full ? "paused" : "recording";
}

export type ForgetRequest = Extract<WatchtowerRequest, { type: "forget" }>;

export interface WatchtowerStatus {
  settings: WatchtowerSettings | null;
  stats: WatchtowerStats | null;
  busy: boolean;
  error: string | null;
  /** Bumped after anything that changes what is saved; lists re-read on it. */
  revision: number;
  configure(patch: Partial<WatchtowerSettings>): Promise<boolean>;
  forget(request: ForgetRequest): Promise<boolean>;
  /** Null when cancelled or failed; the folder otherwise. */
  exportMarkdown(): Promise<string | null>;
  /** Fold a response the caller obtained itself (a search) into the status. */
  absorb(response: WatchtowerResponse): void;
  clearError(): void;
}

export function useWatchtower(poll = true): WatchtowerStatus {
  const [settings, setSettings] = useState<WatchtowerSettings | null>(null);
  const [stats, setStats] = useState<WatchtowerStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const setCapture = useAppStore((state) => state.setWatchtowerCapture);
  const alive = useRef(true);

  const absorb = useCallback(
    (response: WatchtowerResponse) => {
      if (!alive.current) return;
      setSettings(response.settings);
      setStats(response.stats);
      setCapture(captureStateOf(response.settings, response.stats));
    },
    [setCapture],
  );

  useEffect(() => {
    alive.current = true;
    const read = (): void => {
      void shellApi()
        .watchtower({ type: "status" })
        .then(absorb)
        .catch((failure: unknown) => {
          if (alive.current) setError(watchtowerError(failure));
        });
    };
    read();
    const timer = poll ? window.setInterval(read, 5000) : undefined;
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [absorb, poll]);

  const run = useCallback(
    async (request: WatchtowerRequest): Promise<WatchtowerResponse | null> => {
      setBusy(true);
      setError(null);
      try {
        const response = await shellApi().watchtower(request);
        absorb(response);
        if (alive.current) setRevision((value) => value + 1);
        return response;
      } catch (failure) {
        if (alive.current) setError(watchtowerError(failure));
        return null;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [absorb],
  );

  return {
    settings,
    stats,
    busy,
    error,
    revision,
    absorb,
    clearError: useCallback(() => setError(null), []),
    configure: useCallback(async (patch) => (await run({ type: "settings", patch })) !== null, [run]),
    forget: useCallback(async (request) => (await run(request)) !== null, [run]),
    exportMarkdown: useCallback(async () => (await run({ type: "export" }))?.exportPath ?? null, [run]),
  };
}
