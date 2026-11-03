/**
 * `?fake=1` ONLY (main.ts imports this file dynamically behind that flag): the
 * editor in a plain browser. A made-up 44-second recording of a page, a tiny
 * `pistachio` shim over an in-memory data folder, the recorded page drawn per
 * source time (there is no screen.mp4), and an export that records the first
 * seconds of the output for real (MediaRecorder). The solvers and the renderer
 * are the real ones (src/lib). Nothing here ships behaviour: it is for looking
 * at the editor.
 */
import type { ExportEvent, ExportMessage, ExportRequest } from "../export/protocol.js";
import type { MetaEvent, Point, Rect, RecordedEvent, Size } from "../lib/types.js";
import { clamp } from "./model.js";
import type { DevKit, ExportPort } from "./solvers.js";

const VIEW: Size = { w: 1600, h: 900 };
const DURATION = 44;
const REC = "recordings/fake";

// ── The made-up recording ───────────────────────────────────────────────────

interface Click {
  t: number;
  target: Rect & { role: string };
}

const CLICKS: Click[] = [
  { t: 2.6, target: { x: 370, y: 282, w: 120, h: 36, role: "button" } },
  { t: 7.5, target: { x: 1120, y: 448, w: 120, h: 36, role: "button" } },
  { t: 19.2, target: { x: 240, y: 632, w: 150, h: 28, role: "link" } },
  { t: 23.4, target: { x: 30, y: 300, w: 180, h: 30, role: "link" } },
  { t: 25.2, target: { x: 1262, y: 288, w: 52, h: 28, role: "switch" } },
  { t: 26.4, target: { x: 1262, y: 350, w: 52, h: 28, role: "switch" } },
  { t: 35.5, target: { x: 520, y: 260, w: 560, h: 40, role: "option" } },
  { t: 43.4, target: { x: 1380, y: 120, w: 120, h: 36, role: "button" } },
];

const TYPING: { t0: number; t1: number; field: Rect; text: string }[] = [
  { t0: 4.0, t1: 6.8, field: { x: 420, y: 380, w: 760, h: 44 }, text: "Fix the login redirect loop" },
  { t0: 29.0, t1: 35.0, field: { x: 520, y: 160, w: 560, h: 40 }, text: "notification settings for mentions" },
];

const NAVS = [
  { t: 8.2, url: "https://linear.app/acme/issue/LIN-42", title: "LIN-42 · Fix the login redirect" },
  { t: 24.0, url: "https://linear.app/acme/settings/notifications", title: "Settings · Notifications" },
];

/** Pointer waypoints: [t, x, y]; the pointer eases between them and rests otherwise. */
const WAYPOINTS: [number, number, number][] = [
  [0, 820, 540],
  [0.6, 800, 520],
  [2.3, 430, 300],
  [2.9, 432, 302],
  [3.6, 640, 404],
  [7.0, 1172, 468],
  [7.6, 1180, 466],
  [13.4, 1180, 466],
  [14.4, 1000, 490],
  [14.8, 820, 520],
  [18.8, 830, 540],
  [19.1, 310, 646],
  [19.6, 330, 640],
  [22.6, 120, 320],
  [23.5, 118, 315],
  [25.0, 1288, 302],
  [26.2, 1288, 364],
  [27.0, 900, 560],
  [35.2, 760, 280],
  [35.8, 770, 282],
  [42.8, 770, 282],
  [43.3, 1440, 138],
  [43.6, 1442, 140],
  [44, 1050, 460],
];

function smoothstep(x: number): number {
  return x * x * (3 - 2 * x);
}

function waypointAt(t: number): Point {
  let previous = WAYPOINTS[0]!;
  for (const point of WAYPOINTS) {
    if (point[0] >= t) {
      const span = point[0] - previous[0];
      const k = span <= 0 ? 1 : smoothstep(clamp((t - previous[0]) / span, 0, 1));
      return { x: previous[1] + (point[1] - previous[1]) * k, y: previous[2] + (point[2] - previous[2]) * k };
    }
    previous = point;
  }
  return { x: previous[1], y: previous[2] };
}

/** A little seeded noise, so the made-up recording is the same every load. */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function fakeRecording(): { meta: MetaEvent; events: RecordedEvent[] } {
  const meta: MetaEvent = {
    t: 0,
    k: "meta",
    source: { kind: "tab", tabId: "t_fake", title: "My issues", url: "https://linear.app/acme/my-issues" },
    capture: { w: VIEW.w * 2, h: VIEW.h * 2, dpr: 2 },
    view: VIEW,
    fps: 60,
    startedAt: Date.UTC(2026, 9, 30, 22, 4, 12),
  };
  const events: RecordedEvent[] = [];
  const ms = (t: number) => Math.round(t * 10000) / 10;
  // Moves at 60 Hz while the pointer travels.
  let last: Point | null = null;
  for (let i = 0; i <= DURATION * 60; i++) {
    const t = i / 60;
    const p = waypointAt(t);
    if (last === null || Math.hypot(p.x - last.x, p.y - last.y) > 0.6) events.push({ t: ms(t), k: "move", x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });
    last = p;
  }
  for (const click of CLICKS) {
    const p = { x: click.target.x + click.target.w / 2, y: click.target.y + click.target.h / 2 };
    events.push({ t: ms(click.t - 0.45), k: "cursor", type: click.target.role === "option" ? "default" : "pointer" });
    events.push({ t: ms(click.t), k: "down", button: "left", x: p.x, y: p.y, target: click.target });
    events.push({ t: ms(click.t + 0.09), k: "up", button: "left", x: p.x, y: p.y });
    events.push({ t: ms(click.t + 0.4), k: "cursor", type: "default" });
  }
  for (const burst of TYPING) {
    events.push({ t: ms(burst.t0 - 0.3), k: "focus", rect: burst.field, secret: false });
    events.push({ t: ms(burst.t0 - 0.2), k: "cursor", type: "text" });
    const n = burst.text.length;
    for (let i = 0; i < n; i++) {
      const t = burst.t0 + ((burst.t1 - burst.t0) * i) / n + noise(i + burst.t0) * 0.05;
      events.push({ t: ms(t), k: "key", kind: "char" });
      events.push({ t: ms(t + 0.01), k: "caret", rect: { x: burst.field.x + 14 + i * 9.4, y: burst.field.y + 10, w: 2, h: burst.field.h - 20 } });
    }
    events.push({ t: ms(burst.t1 + 0.4), k: "cursor", type: "default" });
  }
  for (let t = 14.8; t < 18.6; t += 0.05) {
    events.push({ t: ms(t), k: "wheel", x: 820, y: 530, dx: 0, dy: 36 + noise(t) * 10 });
    events.push({ t: ms(t + 0.016), k: "scroll", x: 0, y: Math.round((t - 14.8) * 160) });
  }
  for (const nav of NAVS) {
    events.push({ t: ms(nav.t), k: "nav", url: nav.url, title: nav.title });
    events.push({ t: ms(nav.t + 0.01), k: "load", loading: true });
    events.push({ t: ms(nav.t + 0.7), k: "load", loading: false });
  }
  events.push({ t: ms(28.0), k: "key", kind: "chord", chord: "⌘K" });
  events.push({ t: ms(35.7), k: "key", kind: "nav" });
  events.push({ t: ms(DURATION), k: "frame" });
  events.sort((a, b) => a.t - b.t);
  return { meta, events };
}

function fakeLevels(): Float32Array {
  const hz = 50;
  const levels = new Float32Array(DURATION * hz);
  const speech: [number, number][] = [
    [0.3, 7.2],
    [19.5, 27.5],
    [43.0, 43.95],
  ];
  for (let i = 0; i < levels.length; i++) {
    const t = i / hz;
    const talking = speech.some(([a, b]) => t >= a && t <= b);
    const syllable = 0.5 + 0.5 * Math.sin(t * 17 + Math.sin(t * 3.1) * 4);
    const phrase = 0.55 + 0.45 * Math.sin(t * 1.3 + 1);
    levels[i] = talking ? 0.02 + 0.22 * syllable * phrase * (0.7 + 0.3 * noise(i)) : 0.002 + noise(i) * 0.002;
  }
  return levels;
}

// ── The recorded page, drawn ────────────────────────────────────────────────

const FONT = '-apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif';

function typedAt(index: number, t: number): string {
  const burst = TYPING[index]!;
  const k = clamp((t - burst.t0) / (burst.t1 - burst.t0), 0, 1);
  return burst.text.slice(0, Math.round(k * burst.text.length));
}

function drawPage(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, t: number): void {
  const { w, h } = VIEW;
  const chapter = t < NAVS[0]!.t ? 0 : t < NAVS[1]!.t ? 1 : 2;
  ctx.fillStyle = "#fbfbfc";
  ctx.fillRect(0, 0, w, h);
  // Sidebar.
  ctx.fillStyle = "#f3f3f5";
  ctx.fillRect(0, 0, 220, h);
  ctx.fillStyle = "#5e6ad2";
  rr(ctx, 20, 22, 24, 24, 6);
  ctx.fill();
  ctx.font = `600 15px ${FONT}`;
  ctx.fillStyle = "#1b1b1f";
  ctx.fillText("Acme", 54, 39);
  const items = ["Inbox", "My issues", "Projects", "Views", "Settings", "Teams", "Cycles"];
  items.forEach((item, i) => {
    const y = 90 + i * 34;
    const on = (chapter === 0 && i === 1) || (chapter === 2 && i === 4) || (chapter === 1 && i === 2);
    if (on) {
      ctx.fillStyle = "#e6e6ea";
      rr(ctx, 12, y, 196, 30, 6);
      ctx.fill();
    }
    ctx.fillStyle = on ? "#1b1b1f" : "#5c5c66";
    ctx.font = `${on ? 600 : 500} 14px ${FONT}`;
    ctx.fillText(item, 40, y + 20);
    ctx.fillStyle = "#b8b8c0";
    rr(ctx, 20, y + 9, 12, 12, 3);
    ctx.fill();
  });
  // Header.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(220, 0, w - 220, 64);
  ctx.fillStyle = "#e9e9ee";
  ctx.fillRect(220, 64, w - 220, 1);
  ctx.fillStyle = "#1b1b1f";
  ctx.font = `600 18px ${FONT}`;
  ctx.fillText(chapter === 0 ? "My issues" : chapter === 1 ? "LIN-42  Fix the login redirect" : "Notifications", 252, 40);
  ctx.fillStyle = "#5e6ad2";
  rr(ctx, 1380, 120 - 106 + 0, 120, 36, 8);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = `600 14px ${FONT}`;
  ctx.fillText("Share", 1414, 37);
  // Loading bar after a navigation.
  for (const nav of NAVS) {
    if (t >= nav.t && t < nav.t + 0.7) {
      ctx.fillStyle = "#5e6ad2";
      ctx.fillRect(220, 63, (w - 220) * smoothstep((t - nav.t) / 0.7), 3);
    }
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(220, 65, w - 220, h - 65);
  ctx.clip();
  if (chapter === 0) {
    // The issue list, then the new-issue form.
    ctx.fillStyle = t >= 2.6 && t < 2.75 ? "#4954b8" : "#5e6ad2";
    rr(ctx, 370, 282, 120, 36, 8);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `600 14px ${FONT}`;
    ctx.fillText("New issue", 393, 305);
    for (let i = 0; i < 9; i++) {
      const y = 96 + i * 40 + (i >= 4 ? 300 : 0);
      if (y > h) continue;
      ctx.fillStyle = "#ececf0";
      ctx.fillRect(252, y + 39, w - 290, 1);
      ctx.fillStyle = ["#f2994a", "#5e6ad2", "#26b5ce", "#bec2c8"][i % 4]!;
      ctx.beginPath();
      ctx.arc(266, y + 20, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#8a8a94";
      ctx.font = `500 13px ${FONT}`;
      ctx.fillText(`LIN-${String(31 + i)}`, 284, y + 25);
      ctx.fillStyle = "#26262c";
      ctx.font = `500 14px ${FONT}`;
      ctx.fillText(["Polish onboarding emails", "Sync fails on slow networks", "Dark mode for the settings page", "Export to CSV", "Rate limit the webhooks", "Keyboard shortcuts sheet", "Archive old cycles", "Retry failed payments", "Audit log filters"][i]!, 350, y + 25);
    }
    if (t >= 2.6) {
      const k = smoothstep(clamp((t - 2.6) / 0.25, 0, 1));
      ctx.globalAlpha = k;
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#e1e1e8";
      rr(ctx, 400, 344, 860, 170, 12);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = t >= 3.7 ? "#5e6ad2" : "#d9d9e0";
      ctx.lineWidth = t >= 3.7 ? 2 : 1;
      rr(ctx, 420, 380, 760, 44, 8);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
      const typed = typedAt(0, t);
      ctx.fillStyle = typed === "" ? "#a0a0aa" : "#1b1b1f";
      ctx.font = `500 16px ${FONT}`;
      ctx.fillText(typed === "" ? "Issue title" : typed, 434, 408);
      ctx.fillStyle = t >= 7.5 && t < 7.65 ? "#4954b8" : "#5e6ad2";
      rr(ctx, 1120, 448, 120, 36, 8);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = `600 14px ${FONT}`;
      ctx.fillText("Create", 1155, 471);
      ctx.globalAlpha = 1;
    }
  } else if (chapter === 1) {
    const scroll = clamp((t - 14.8) * 160, 0, 600);
    ctx.translate(0, -scroll);
    ctx.fillStyle = "#26262c";
    ctx.font = `500 15px ${FONT}`;
    const lines = [
      "When a session expires mid-flow the app sends people back to /login,",
      "which sends them on to /app, which notices the expired session and",
      "sends them back to /login. Browsers give up after twenty redirects.",
      "",
      "Steps: sign in, wait for the session to lapse, open any issue link.",
      "Expected: the login page, then the issue. Actual: ERR_TOO_MANY_REDIRECTS.",
    ];
    for (let p = 0; p < 4; p++) {
      lines.forEach((line, i) => ctx.fillText(line, 252, 120 + p * 220 + i * 26));
    }
    ctx.fillStyle = "#5e6ad2";
    ctx.font = `600 14px ${FONT}`;
    ctx.fillText("Add a comment →", 252, 652 + scroll * 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    const toggles = [
      { y: 288, label: "Mentions", on: t >= 25.2 },
      { y: 350, label: "Assigned to me", on: t < 26.4 },
      { y: 412, label: "Status changes", on: true },
      { y: 474, label: "Weekly digest", on: false },
    ];
    for (const toggle of toggles) {
      ctx.fillStyle = "#26262c";
      ctx.font = `500 15px ${FONT}`;
      ctx.fillText(toggle.label, 300, toggle.y + 19);
      ctx.fillStyle = toggle.on ? "#5e6ad2" : "#d4d4dc";
      rr(ctx, 1262, toggle.y, 52, 28, 14);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(toggle.on ? 1300 : 1276, toggle.y + 14, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ececf0";
      ctx.fillRect(300, toggle.y + 44, 1020, 1);
    }
    if (t >= 28 && t < 35.6) {
      ctx.fillStyle = "rgba(20,20,30,0.25)";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#ffffff";
      rr(ctx, 500, 140, 600, 300, 14);
      ctx.fill();
      ctx.fillStyle = "#f4f4f7";
      rr(ctx, 520, 160, 560, 40, 8);
      ctx.fill();
      const typed = typedAt(1, t);
      ctx.fillStyle = typed === "" ? "#a0a0aa" : "#1b1b1f";
      ctx.font = `500 16px ${FONT}`;
      ctx.fillText(typed === "" ? "Type a command or search…" : typed, 534, 186);
      ["Notification settings", "Mute mentions in #general", "Email digest"].forEach((label, i) => {
        if (i === 0) {
          ctx.fillStyle = "#eef0ff";
          rr(ctx, 520, 260, 560, 40, 8);
          ctx.fill();
        }
        ctx.fillStyle = "#26262c";
        ctx.font = `500 15px ${FONT}`;
        ctx.fillText(label, 540, 286 + i * 48);
      });
    }
  }
  ctx.restore();
}

function rr(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function screenFrames(): (tSrc: number) => CanvasImageSource {
  const canvas = document.createElement("canvas");
  canvas.width = VIEW.w;
  canvas.height = VIEW.h;
  const ctx = canvas.getContext("2d")!;
  let drawnAt = -1;
  return (tSrc) => {
    const t = Math.round(tSrc * 60) / 60;
    if (t !== drawnAt) {
      drawnAt = t;
      drawPage(ctx, t);
    }
    return canvas;
  };
}

// ── The `pistachio` shim ────────────────────────────────────────────────────

function toast(title: string, body?: string): void {
  let layer = document.querySelector<HTMLElement>(".dev-toasts");
  if (layer === null) {
    layer = document.createElement("div");
    layer.className = "dev-toasts";
    document.body.append(layer);
  }
  const card = document.createElement("div");
  card.className = "dev-toast";
  card.textContent = body === undefined ? title : `${title} — ${body}`;
  layer.append(card);
  setTimeout(() => card.remove(), 3200);
}

function installShim(store: Map<string, Blob>): void {
  const urls = new Map<Blob, string>();
  const notFound = (path: string) => Object.assign(new Error(`NOT_FOUND: ${path}`), { code: "NOT_FOUND" });
  const blobOf = (data: ArrayBuffer | Uint8Array | string | Blob) => (data instanceof Blob ? data : new Blob([data as BlobPart]));
  const shim = {
    runtime: {
      ready: Promise.resolve(),
      id: "com.pistachio.recorder",
      context: "page",
      manifest: { api: 1, id: "com.pistachio.recorder", name: "Recorder", version: "1.0.0" },
      now: () => performance.timeOrigin + performance.now(),
      log: (level: string, message: string, data?: unknown) => console[level === "error" ? "error" : level === "warn" ? "warn" : "info"](`[pistachio.log] ${message}`, data ?? ""),
      // (The export's hold on the worker: there is none here, the page runs it.)
      keepAlive: async () => () => undefined,
    },
    storage: {
      local: {
        get: async (key?: string | string[]) => {
          const keys = key === undefined ? [] : typeof key === "string" ? [key] : key;
          const out: Record<string, unknown> = {};
          for (const k of keys) {
            try {
              const raw = localStorage.getItem(`recorder-dev:${k}`);
              if (raw !== null) out[k] = JSON.parse(raw);
            } catch {
              // Storage refused: nothing kept.
            }
          }
          return out;
        },
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) {
            try {
              localStorage.setItem(`recorder-dev:${k}`, JSON.stringify(v));
            } catch {
              // Storage refused.
            }
          }
        },
        remove: async (key: string | string[]) => {
          for (const k of typeof key === "string" ? [key] : key) {
            try {
              localStorage.removeItem(`recorder-dev:${k}`);
            } catch {
              // Storage refused.
            }
          }
        },
      },
    },
    ui: {
      toast: async (t: { title: string; body?: string }) => toast(t.title, t.body),
      openPanel: async () => toast("pistachio.ui.openPanel()", "the Recorder's panel would open"),
      onToastAction: () => () => undefined,
    },
    files: {
      save: async (_data: unknown, options: { suggestedName: string; folder?: string }) => {
        const path = `/Users/you/Pictures/Screenshots/${options.suggestedName}`;
        toast("files.save", path);
        return path;
      },
      reveal: async (path: string) => toast("files.reveal", path),
      startDrag: async (path: string) => toast("files.startDrag", path),
      data: {
        read: async (path: string) => {
          const blob = store.get(path);
          if (blob === undefined) throw notFound(path);
          return blob.arrayBuffer();
        },
        write: async (path: string, data: ArrayBuffer | Uint8Array | string | Blob) => {
          store.set(path, blobOf(data));
        },
        list: async (dir = "") => {
          const prefix = dir === "" ? "" : `${dir.replace(/\/$/, "")}/`;
          return [...store.entries()].filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/")).map(([path, blob]) => ({ path, size: blob.size, modifiedAt: Date.now(), kind: "file" }));
        },
        remove: async (path: string) => {
          store.delete(path);
        },
        url: (path: string) => {
          const blob = store.get(path);
          if (blob === undefined) return `data:,missing-${encodeURIComponent(path)}`;
          let url = urls.get(blob);
          if (url === undefined) {
            url = URL.createObjectURL(blob);
            urls.set(blob, url);
          }
          return url;
        },
        open: async (path: string) => {
          const parts: BlobPart[] = [];
          return {
            write: async (chunk: ArrayBuffer | Uint8Array) => {
              parts.push(chunk instanceof Uint8Array ? chunk.slice() : chunk);
            },
            close: async () => {
              store.set(path, new Blob(parts, { type: path.endsWith(".gif") ? "image/gif" : "video/webm" }));
            },
            abort: async () => undefined,
          };
        },
        freeSpace: async () => 200e9,
      },
    },
    clipboard: { write: async (content: { filePath?: string; text?: string }) => toast("clipboard.write", content.filePath ?? content.text ?? "") },
    notes: {
      create: async (note: { title: string; markdown: string }) => {
        toast("notes.create", `${note.title}: ${note.markdown}`);
        return { id: "note_dev" };
      },
    },
  };
  (globalThis as { pistachio?: unknown }).pistachio = shim;
}

// ── A stand-in export: renders the first seconds of the output and records them ──

function createExportWorker(draw: (ctx: CanvasRenderingContext2D, tOut: number, width: number, height: number) => void, durationOut: number): ExportPort {
  let listener: (event: ExportEvent) => void = () => undefined;
  let recorder: MediaRecorder | null = null;
  let cancelled = false;
  let raf = 0;
  const emit = (event: ExportEvent) => setTimeout(() => listener(event), 0);
  const start = (_request: ExportRequest) => {
    const width = 960;
    const height = 540;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    const length = Math.min(4, durationOut);
    draw(ctx, 0, width, height);
    const stream = canvas.captureStream(30);
    recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    let seq = 0;
    let bytes = 0;
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      void event.data.arrayBuffer().then((buffer) => {
        bytes += buffer.byteLength;
        emit({ type: "chunk", seq: seq++, bytes: buffer });
      });
    };
    recorder.onstop = () => {
      if (cancelled) {
        emit({ type: "cancelled" });
        return;
      }
      setTimeout(() => emit({ type: "done", bytes, durationSeconds: length }), 50);
    };
    recorder.start(500);
    const began = performance.now();
    const frame = () => {
      const t = (performance.now() - began) / 1000;
      if (cancelled) {
        recorder?.stop();
        return;
      }
      if (t >= length) {
        recorder?.stop();
        return;
      }
      draw(ctx, t, width, height);
      emit({ type: "progress", fraction: t / length, etaSeconds: length - t, frames: Math.round(t * 30) });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  };
  return {
    send(message: ExportMessage) {
      if (message.type === "start") start(message);
      else if (message.type === "cancel") {
        cancelled = true;
        if (recorder === null || recorder.state === "inactive") emit({ type: "cancelled" });
      }
    },
    listen(fn) {
      listener = fn;
    },
    terminate() {
      cancelAnimationFrame(raf);
      if (recorder !== null && recorder.state !== "inactive") {
        cancelled = true;
        recorder.stop();
      }
    },
  };
}

// ── The kit ─────────────────────────────────────────────────────────────────

export function installDevKit(): DevKit {
  const store = new Map<string, Blob>();
  const { meta, events } = fakeRecording();
  const lines = [JSON.stringify(meta), ...events.map((event) => JSON.stringify(event))].join("\n");
  store.set(`${REC}/events.jsonl`, new Blob([lines]));
  store.set(`${REC}/mic.levels`, new Blob([fakeLevels().buffer as ArrayBuffer]));
  if (typeof (globalThis as { pistachio?: unknown }).pistachio === "undefined") installShim(store);
  document.documentElement.dataset["dev"] = "fake";
  return { screenFrame: screenFrames(), createExportWorker };
}
