import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RenderProcessGoneDetails } from "electron";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";

/**
 * A page that stopped answering, or died: what main does to get it back, and
 * the record it keeps of it.
 *
 * Three things went wrong on 0.0.46 (Electron 43.4.1, Chromium 150), October
 * 2026. A page whose renderer ran out of memory stayed blank until the person
 * reloaded it. A drag over that page as it died took the whole app down:
 * AppKit's next drag update went to the dead page's view, and Chromium's
 * `-[WebDragDest draggingUpdated:]` dereferences the RenderWidgetHostView the
 * page no longer has (its `draggingEntered:` checks; reproduced with a real
 * drag and `forcefullyCrashRenderer`). And pages went deaf — no hover, no
 * click, scrolling still worked — until reloaded: Blink drops all input while
 * a drag the page began has not been told it ended, and a drag begun by input
 * main sent (sendInputEvent: a live share guest's, a masked window's) is
 * never told. What else loses that end is not known; the log says when it
 * happens.
 */

/** What the window says of a page whose renderer died: out of memory, or anything else. */
export type PageCrash = NonNullable<BrowserTabInfo["crashed"]>;

export function crashKind(reason: RenderProcessGoneDetails["reason"]): PageCrash {
  return reason === "oom" || reason === "memory-eviction" ? "memory" : "crashed";
}

/**
 * A page that dies on screen is reloaded at once — but one that dies again
 * this soon after is left for the person to reload: a page that runs out of
 * memory may only do it again.
 */
export const CRASH_RELOAD_WINDOW_MS = 120_000;

export class CrashReloads {
  readonly #last = new Map<string, number>();

  /** Whether the tab is to be reloaded now; if so, the reload is counted. */
  take(tabId: string, now: number): boolean {
    const last = this.#last.get(tabId);
    if (last !== undefined && now - last < CRASH_RELOAD_WINDOW_MS) return false;
    this.#last.set(tabId, now);
    return true;
  }

  forget(tabId: string): void {
    this.#last.delete(tabId);
  }
}

/** A point in a page's main frame, CSS px from its viewport's top left. */
export interface PagePoint {
  x: number;
  y: number;
}

/** A drag a page began and has not heard the end of: since when, and from where. */
export interface PageDrag {
  since: number;
  point: PagePoint;
}

/**
 * Moves the page hears this long after its drag began say the drag is over:
 * while one is on, the OS gives the drag session the pointer and the page
 * hears no mouse event at all. (The first moves after a press may still come
 * before the drag session starts, hence the wait.)
 */
export const DRAG_HOVER_GRACE_MS = 1500;
/** And they keep coming this long — one stray move is not the pointer moving over a deaf page. */
export const DRAG_HOVER_SPAN_MS = 400;

/**
 * Each page's drag, as its preload reports it (dragstart a page did not
 * cancel, dragend), keyed by its WebContents id — and when the pointer's own
 * events reaching that page say the drag cannot still be on: a press (no
 * press reaches a page while the OS runs a drag), or moves well after it
 * began. Input main itself sent a page is no evidence (it never goes through
 * the OS) and is not shown here.
 */
export class DragWatch {
  readonly #drags = new Map<number, PageDrag & { movedAt: number | null }>();

  started(id: number, point: PagePoint, now: number): void {
    this.#drags.set(id, { since: now, point, movedAt: null });
  }

  ended(id: number): void {
    this.#drags.delete(id);
  }

  forget(id: number): void {
    this.#drags.delete(id);
  }

  /** The page's drag, while it has one. */
  drag(id: number): PageDrag | null {
    const drag = this.#drags.get(id);
    return drag === undefined ? null : { since: drag.since, point: drag.point };
  }

  /** The OS pointer's own event reached the page: its drag, if this says that drag is over and unheard of. */
  stuck(id: number, type: string, now: number): PageDrag | null {
    const drag = this.#drags.get(id);
    if (drag === undefined) return null;
    if (type === "mouseDown") return { since: drag.since, point: drag.point };
    if (type !== "mouseMove" || now - drag.since < DRAG_HOVER_GRACE_MS) return null;
    if (drag.movedAt === null) {
      drag.movedAt = now;
      return null;
    }
    return now - drag.movedAt >= DRAG_HOVER_SPAN_MS ? { since: drag.since, point: drag.point } : null;
  }
}

/** A page's drag report from its preload (preload/tab.ts), checked. */
export function readPageDragReport(report: unknown): { dragging: true; point: PagePoint } | { dragging: false } | null {
  if (typeof report !== "object" || report === null) return null;
  const { dragging, x, y } = report as Record<string, unknown>;
  if (dragging === false) return { dragging: false };
  if (dragging !== true || typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { dragging: true, point: { x, y } };
}

/** What the page-health log records. Pages are named by their site alone: the log never holds a page's address. */
export type PageHealthEvent =
  | { event: "crashed"; site: string; reason: string; exitCode: number; shown: boolean; reloaded: boolean }
  | { event: "unresponsive"; site: string }
  | { event: "responsive"; site: string; afterMs: number }
  | { event: "drag-released"; site: string; trigger: "press" | "hover"; draggingMs: number; released: boolean }
  | { event: "drag-refused"; site: string; source: "live-share" | "mask"; released: boolean };

/** A page's site for the log: an http(s) page's host, otherwise its scheme. */
export function pageSite(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : parsed.protocol.replace(/:$/, "");
  } catch {
    return "";
  }
}

/** Past this the log is moved aside (one older file kept) and begun again. */
export const PAGE_HEALTH_LOG_LIMIT = 512 * 1024;

/**
 * `logs/page-health.log` in the profile: one JSON line an event, oldest
 * first, written in order. A write that fails is dropped — the log never
 * holds anything up.
 */
export class PageHealthLog {
  readonly #dir: string;
  readonly #limit: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(dir: string, limit = PAGE_HEALTH_LOG_LIMIT) {
    this.#dir = dir;
    this.#limit = limit;
  }

  get path(): string {
    return join(this.#dir, "page-health.log");
  }

  record(event: PageHealthEvent, now = new Date()): Promise<void> {
    const line = `${JSON.stringify({ at: now.toISOString(), ...event })}\n`;
    this.#queue = this.#queue.then(() => this.#write(line)).catch(() => undefined);
    return this.#queue;
  }

  async #write(line: string): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const size = await stat(this.path).then((info) => info.size, () => 0);
    if (size > 0 && size + line.length > this.#limit) await rename(this.path, join(this.#dir, "page-health.1.log"));
    await appendFile(this.path, line);
  }
}
