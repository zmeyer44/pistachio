/**
 * What the editor reads off a recording besides the solvers and the render state
 * (src/lib): the title, the marks the events lane draws, boxes for the preview,
 * clock text, the export's name. Pure; events' `t` is milliseconds, the rest seconds.
 */
import type { Chapter, MetaEvent, RecordedEvent, Size } from "../lib/types.js";

/** The recording's title: its first chapter's. */
export function recordingTitle(chapters: Chapter[], meta: MetaEvent): string {
  const first = chapters[0];
  const title = first !== undefined && first.tSrc <= 0.5 ? first.title : meta.source.title;
  return title.trim() === "" ? "Recording" : title;
}

export type EventMark =
  | { kind: "click"; t: number; button: "left" | "right" | "middle" }
  | { kind: "typing"; t: number; end: number; keys: number }
  | { kind: "scroll"; t: number; end: number }
  | { kind: "nav"; t: number; title: string }
  | { kind: "chord"; t: number; chord: string };

/** The events lane: clicks, ⌨ bursts (char keys closer than `typingGap`), ↕ scroll runs, navigations, chords. */
export function eventMarks(events: RecordedEvent[], typingGap = 0.45, scrollGap = 0.3): EventMark[] {
  const marks: EventMark[] = [];
  let typing: { t: number; end: number; keys: number } | null = null;
  let scroll: { t: number; end: number } | null = null;
  const closeTyping = () => {
    if (typing !== null) marks.push({ kind: "typing", ...typing });
    typing = null;
  };
  const closeScroll = () => {
    if (scroll !== null) marks.push({ kind: "scroll", ...scroll });
    scroll = null;
  };
  for (const event of events) {
    const t = event.t / 1000;
    if (typing !== null && t - typing.end > typingGap) closeTyping();
    if (scroll !== null && t - scroll.end > scrollGap) closeScroll();
    switch (event.k) {
      case "down":
        marks.push({ kind: "click", t, button: event.button });
        break;
      case "key":
        if (event.kind === "char") {
          if (typing === null) typing = { t, end: t, keys: 1 };
          else {
            typing.end = t;
            typing.keys += 1;
          }
        } else if (event.kind === "chord" && typeof event.chord === "string") marks.push({ kind: "chord", t, chord: event.chord });
        break;
      case "wheel":
      case "scroll":
        if (scroll === null) scroll = { t, end: t };
        else scroll.end = t;
        break;
      case "nav":
        marks.push({ kind: "nav", t, title: event.title });
        break;
      default:
        break;
    }
  }
  closeTyping();
  closeScroll();
  return marks.sort((a, b) => a.t - b.t);
}

/** The last event's time (seconds): the recording's length when the media has not said. */
export function lastEventSeconds(events: RecordedEvent[]): number {
  let last = 0;
  for (const event of events) if (event.t > last) last = event.t;
  return last / 1000;
}

/** The largest box of an aspect inside an area, centred (CSS px). */
export function fitBox(area: Size, aspect: number, margin = 0): { x: number; y: number; w: number; h: number } {
  const aw = Math.max(1, area.w - margin * 2);
  const ah = Math.max(1, area.h - margin * 2);
  let w = aw;
  let h = w / aspect;
  if (h > ah) {
    h = ah;
    w = h * aspect;
  }
  return { x: (area.w - w) / 2, y: (area.h - h) / 2, w, h };
}

/** Export sizes above the source × 1.25 are greyed (the capture's shorter side). */
export function exportSizeAllowed(height: number, capture: Size): boolean {
  return height <= Math.min(capture.w, capture.h) * 1.25 + 0.5;
}

/** A zoom level: `2.0×`, `1.35×`. */
export function levelText(level: number): string {
  const text = level.toFixed(2);
  return `${text.endsWith("0") ? text.slice(0, -1) : text}×`;
}

/** `0:12.40`; past an hour `1:02:03.40`. */
export function formatClock(seconds: number, hundredths = true): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  // Whole hundredths first, so 108.02 is not 108.019999….
  const centis = Math.floor(safe * 100 + 1e-6);
  const whole = Math.floor(centis / 100);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const frac = hundredths ? `.${String(centis % 100).padStart(2, "0")}` : "";
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${String(h)}:${String(m).padStart(2, "0")}:${ss}${frac}` : `${String(m)}:${ss}${frac}`;
}

/** The Mac's own naming: `Screen Recording 2026-10-30 at 3.04.12 PM.mp4` (local time). */
export function exportName(startedAt: number, extension: string): string {
  const date = new Date(startedAt);
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hours = date.getHours();
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `Screen Recording ${String(y)}-${mo}-${d} at ${String(h12)}.${mi}.${s} ${hours < 12 ? "AM" : "PM"}.${extension}`;
}

/** The levels (50 Hz RMS) reduced to one peak a bucket of `bucketSeconds`, for the mic lane. */
export function levelAt(levels: Float32Array, hz: number, t0: number, t1: number): number {
  const a = Math.max(0, Math.floor(t0 * hz));
  const b = Math.min(levels.length, Math.max(a + 1, Math.ceil(t1 * hz)));
  let peak = 0;
  for (let i = a; i < b; i++) {
    const value = levels[i]!;
    if (value > peak) peak = value;
  }
  return peak;
}
