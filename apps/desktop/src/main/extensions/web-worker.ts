/**
 * An extension's web worker (docs/extensions.md X4, §4 "The web worker"): a
 * sandboxed view on the extension's partition, in a hidden BaseWindow of its
 * own (the nub picture's recipe — a BaseWindow, so nothing that takes the
 * browser's windows from BrowserWindow.getAllWindows ever takes it), with
 * throttling off, loading `pistachio-ext://<id>/__pistachio__/worker.html`.
 *
 * It starts on first need and stops after thirty minutes idle with no page
 * or panel of the extension open and nothing holding it (`runtime.keepAlive`).
 * A crash loop — three in sixty seconds — leaves it stopped in `error` until
 * the extension's files change.
 */

import { BaseWindow, WebContentsView, type WebContents } from "electron";
import { WORKER_PAGE } from "./protocol";
import { extensionOrigin, onExtensionOrigin } from "./views";

export const WORKER_IDLE_MS = 30 * 60_000;
export const CRASH_LOOP_COUNT = 3;
export const CRASH_LOOP_WINDOW_MS = 60_000;
const IDLE_SWEEP_MS = 60_000;

/** Three crashes inside the window: a loop. Pure, for the test. */
export function isCrashLoop(crashes: readonly number[], now: number): boolean {
  return crashes.filter((at) => now - at <= CRASH_LOOP_WINDOW_MS).length >= CRASH_LOOP_COUNT;
}

export interface WorkerHostOptions {
  extensionId: string;
  partition: string;
  preload: string;
  /** The view was made: main maps its contents to the extension (identity, console, gestures). */
  made(contents: WebContents): void;
  /** Whether something keeps the worker up: a page or the panel of the extension open, a `runtime.keepAlive` hold. */
  keptUp(): boolean;
  /** It stopped (idle, a crash, turned off): its invocations fail, its holds go. */
  stopped(reason: "idle" | "crash" | "stop" | "loop"): void;
  log(level: "info" | "warn" | "error", message: string): void;
}

export class WorkerHost {
  readonly #options: WorkerHostOptions;
  #window: BaseWindow | null = null;
  #view: WebContentsView | null = null;
  #ready: Promise<WebContents> | null = null;
  #lastActive = Date.now();
  #crashes: number[] = [];
  #looping = false;
  #sweep: NodeJS.Timeout | null = null;

  constructor(options: WorkerHostOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#view !== null && !this.#view.webContents.isDestroyed();
  }

  /** In a crash loop: stopped until the files change (`clearLoop`). */
  get looping(): boolean {
    return this.#looping;
  }

  get contents(): WebContents | null {
    return this.#view === null || this.#view.webContents.isDestroyed() ? null : this.#view.webContents;
  }

  /** The worker, started if need be; resolves once its page has loaded (its handlers registered). */
  start(): Promise<WebContents> {
    this.touch();
    if (this.#looping) return Promise.reject(new Error("the worker crashed three times in a minute; it starts again once its files change"));
    if (this.#ready !== null && this.running) return this.#ready;
    const window = new BaseWindow({ show: false, frame: false, focusable: false, skipTaskbar: true, width: 1, height: 1 });
    window.excludedFromShownWindowsMenu = true;
    const view = new WebContentsView({
      webPreferences: {
        partition: this.#options.partition,
        preload: this.#options.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        spellcheck: false,
        webviewTag: false,
        backgroundThrottling: false,
      },
    });
    window.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    this.#window = window;
    this.#view = view;
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (!onExtensionOrigin(this.#options.extensionId, url)) event.preventDefault();
    });
    contents.on("will-redirect", (event) => {
      if (!onExtensionOrigin(this.#options.extensionId, event.url)) event.preventDefault();
    });
    contents.on("render-process-gone", (_event, details) => {
      if (this.#view !== view) return;
      const now = Date.now();
      this.#crashes = [...this.#crashes.filter((at) => now - at <= CRASH_LOOP_WINDOW_MS), now];
      this.#options.log("error", `the worker stopped (${details.reason})`);
      const loop = isCrashLoop(this.#crashes, now);
      if (loop) this.#looping = true;
      this.#teardown(loop ? "loop" : "crash");
    });
    this.#options.made(contents);
    const url = `${extensionOrigin(this.#options.extensionId)}${WORKER_PAGE.slice(1)}`;
    this.#ready = contents.loadURL(url).then(
      () => contents,
      (error: unknown) => {
        // A module that failed to load still leaves the page up, its error in the console; a page that never loaded is gone.
        if (contents.isDestroyed()) throw error instanceof Error ? error : new Error(String(error));
        return contents;
      },
    );
    if (this.#sweep === null) {
      this.#sweep = setInterval(() => this.#sweepIdle(), IDLE_SWEEP_MS);
      this.#sweep.unref();
    }
    return this.#ready;
  }

  /** Something used the worker: the idle clock starts again. */
  touch(): void {
    this.#lastActive = Date.now();
  }

  /** The files changed: a worker stopped by a crash loop may start again. */
  clearLoop(): void {
    this.#looping = false;
    this.#crashes = [];
  }

  stop(): void {
    this.#teardown("stop");
  }

  /**
   * Stopped with its renderer process killed first (`forcefullyCrashRenderer`): a close alone deletes the page but
   * leaves a tab capture its page took counted on the captured tab (MEASURED, Electron 43: `isBeingCaptured()` stayed
   * true after the worker's contents was destroyed), while the process's death ends every stream it held. Not a
   * crash of the worker's: `#teardown` forgets the view before the gone event is heard.
   */
  kill(): void {
    const view = this.#view;
    if (view !== null && !view.webContents.isDestroyed()) {
      try {
        view.webContents.forcefullyCrashRenderer();
      } catch {
        // (Already gone.)
      }
    }
    this.#teardown("stop");
  }

  dispose(): void {
    this.#teardown("stop");
    if (this.#sweep !== null) clearInterval(this.#sweep);
    this.#sweep = null;
  }

  #sweepIdle(): void {
    if (!this.running) return;
    if (this.#options.keptUp()) {
      this.touch();
      return;
    }
    if (Date.now() - this.#lastActive >= WORKER_IDLE_MS) this.#teardown("idle");
  }

  #teardown(reason: "idle" | "crash" | "stop" | "loop"): void {
    const view = this.#view;
    const window = this.#window;
    if (view === null && window === null) return;
    this.#view = null;
    this.#window = null;
    this.#ready = null;
    if (view !== null && !view.webContents.isDestroyed()) view.webContents.close();
    if (window !== null && !window.isDestroyed()) window.destroy();
    this.#options.stopped(reason);
  }
}
