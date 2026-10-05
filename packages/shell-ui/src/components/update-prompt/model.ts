import { useEffect, useRef, useState, type RefObject } from "react";
import { shellApi } from "../../api";
import { useAppStore } from "../../store";

/**
 * Everything the update dialog (UpdatePrompt.tsx) shows and does, apart from
 * how it looks.
 */
export type UpdatePromptPhase =
  /** The offer itself: update now, or put it off. */
  | { kind: "offer"; version: string; offersLater: boolean }
  | { kind: "downloading"; version: string; percent: number }
  /** Downloaded after "Update now": the dialog restarts into it. */
  | { kind: "restarting"; version: string }
  /** Downloaded some other way (the pill): the restart is the person's to choose. */
  | { kind: "ready"; version: string }
  | { kind: "checking" }
  | { kind: "error"; message: string };

export interface UpdatePromptModel {
  phase: UpdatePromptPhase;
  /** The running build, once main has said. */
  current: string | null;
  updateNow(): void;
  remindTomorrow(): void;
  later(): void;
  /** Put the dialog down. A download keeps going; the pill offers the restart. */
  close(): void;
  restart(): void;
  retry(): void;
  /** Focused when the dialog opens — the dialog, never a button (see below). */
  dialogRef: RefObject<HTMLDivElement | null>;
  /** False for the dialog's first moments (see below). */
  armed: boolean;
}

/** Long enough to read "Restarting", short enough not to feel like a wait. */
const RESTART_BEAT_MS = 900;
/**
 * The dialog arrives on its own, often mid-click or mid-sentence on the page
 * under it. Until this has passed its buttons take no pointer, so a click
 * meant for the page cannot land on "Update now".
 */
const ARM_MS = 450;

export function useUpdatePrompt(): UpdatePromptModel {
  const update = useAppStore((s) => s.update);
  const restartPending = useAppStore((s) => s.updateRestartPending);
  const updateNow = useAppStore((s) => s.updateNow);
  const snooze = useAppStore((s) => s.snoozeUpdate);
  const close = useAppStore((s) => s.closeUpdatePrompt);
  const install = useAppStore((s) => s.installUpdate);
  const check = useAppStore((s) => s.checkForUpdates);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);

  const phase: UpdatePromptPhase = (() => {
    switch (update.status) {
      case "available":
        return { kind: "offer", version: update.version, offersLater: update.prompt.snoozes > 0 };
      case "downloading":
        return { kind: "downloading", version: update.version, percent: update.percent };
      case "ready":
        return restartPending ? { kind: "restarting", version: update.version } : { kind: "ready", version: update.version };
      case "error":
        return { kind: "error", message: update.message };
      default:
        return { kind: "checking" };
    }
  })();

  useEffect(() => {
    let live = true;
    void shellApi()
      .getAppInfo()
      .then((info) => live && setCurrent(info.version))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Focus goes to the dialog, not its default button: it can open while the
  // person is typing into the page, and a stray Return must not restart the
  // browser. Tab reaches the buttons.
  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
    const timer = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(timer);
  }, []);

  const restarting = phase.kind === "restarting";
  useEffect(() => {
    if (!restarting) return;
    const timer = setTimeout(install, RESTART_BEAT_MS);
    return () => clearTimeout(timer);
  }, [restarting, install]);

  // Escape is the gentlest way out of each phase: an offer is put off until
  // tomorrow, anything else is put down.
  const kind = phase.kind;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || kind === "restarting") return;
      event.preventDefault();
      if (kind === "offer") snooze("tomorrow");
      else close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [kind, snooze, close]);

  return {
    phase,
    current,
    updateNow: () => void updateNow(),
    remindTomorrow: () => snooze("tomorrow"),
    later: () => snooze("later"),
    close,
    restart: install,
    retry: () => void check(),
    dialogRef,
    armed,
  };
}

/** The pointer style that keeps an unarmed dialog's buttons out of reach. */
export function armedStyle(armed: boolean): { pointerEvents?: "none" } {
  return armed ? {} : { pointerEvents: "none" };
}
