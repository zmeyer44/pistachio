/**
 * A microphone or camera switch with its menu behind a chevron (devices; the
 * camera's backgrounds too), as the guest's toolbar and the lobby's preview
 * show it (docs/live-share.md §1). Off reads as off at a glance: the slashed
 * glyph on a tinted face. A microphone that is on can show its level as a
 * fill rising inside the glyph, read every frame from `level`. One that is
 * off because it could not come on says why — a mark on it, the line as its
 * tooltip — and stays a click from trying again.
 */

import { ChevronDown, LoaderCircle, Mic, MicOff, Video, VideoOff } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Popover } from "./Popover.js";

export interface MediaButtonProps {
  kind: "microphone" | "camera";
  on: boolean;
  onToggle(): void;
  /** A switch is under way: a spinner, and no second switch — but one that reads as on can still be turned off (one coming on, `switchReadsOn`, §7). */
  busy?: boolean;
  /** Why it did not come on the last time (blocked, missing, busy): said while it is off, never a reason to disable it. */
  problem?: string | null;
  /** The key that toggles it, for the tooltip. */
  shortcut?: string;
  /** The menu behind the chevron. */
  menu?: ReactNode;
  /** The microphone's level now, 0..1. */
  level?: () => number;
  /** "glass" on the toolbar; "overlay" over a camera preview. */
  variant?: "glass" | "overlay";
}

const NAMES = { microphone: "microphone", camera: "camera" } as const;

function MicLevel({ level }: { level: () => number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame = 0;
    let shown = 0;
    const tick = (): void => {
      // Rise fast, fall slowly: speech reads as a steady glow, not a flicker.
      const next = Math.min(1, level() * 2.2);
      shown = next > shown ? next : shown * 0.86 + next * 0.14;
      ref.current?.style.setProperty("--lv-level", shown.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [level]);
  return <span ref={ref} className="lv-media-level" aria-hidden="true" />;
}

export function MediaButton({ kind, on, onToggle, busy = false, problem = null, shortcut, menu, level, variant = "glass" }: MediaButtonProps) {
  const [open, setOpen] = useState(false);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const name = NAMES[kind];
  const Icon = kind === "microphone" ? (on ? Mic : MicOff) : on ? Video : VideoOff;
  const action = `Turn ${on ? "off" : "on"} ${name}${shortcut === undefined ? "" : ` (${shortcut})`}`;
  // A problem is why it is off; a switch on, or coming on, has none to tell.
  const said = on ? null : problem;

  return (
    <div className="lv-media lv-popover-anchor" data-variant={variant} data-on={on ? "" : undefined} data-problem={said === null ? undefined : ""}>
      <button
        type="button"
        className="lv-media-toggle"
        aria-pressed={on}
        aria-label={`${kind === "microphone" ? "Microphone" : "Camera"} ${on ? "on" : "off"}`}
        title={said === null ? action : `${said} ${action}`}
        disabled={busy && !on}
        onClick={onToggle}
        data-kind={kind}
      >
        {busy ? <LoaderCircle aria-hidden="true" className="lv-spin" /> : <Icon aria-hidden="true" />}
        {on && level !== undefined && !busy ? <MicLevel level={level} /> : null}
      </button>
      {menu === undefined ? null : (
        <>
          <button
            ref={chevronRef}
            type="button"
            className="lv-media-more"
            aria-label={`${kind === "microphone" ? "Microphone" : "Camera"} options`}
            aria-expanded={open}
            title={`${kind === "microphone" ? "Microphone" : "Camera"} options`}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronDown aria-hidden="true" />
          </button>
          <Popover open={open} onClose={() => setOpen(false)} anchor={chevronRef} label={`${kind === "microphone" ? "Microphone" : "Camera"} options`} align="start">
            {menu}
          </Popover>
        </>
      )}
    </div>
  );
}
