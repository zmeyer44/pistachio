/**
 * Checks the release feed (electron-builder's `latest-mac.yml` next to the
 * DMG on R2) and walks one update through available → downloading → ready.
 *
 * Deliberately not automatic past the check: the download starts when the
 * person asks and the install when they choose to restart, so a browser full
 * of signed-in tabs is never yanked out from under them. A downloaded update
 * is also applied on the next ordinary quit.
 *
 * An available update also carries whether the shell's dialog is due
 * (`UpdatePrompt`). The person's "remind me tomorrow" and "later" are kept
 * here, in their own file, so they hold across launches.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, Notification } from "electron";
// electron-updater is CommonJS; a named import fails to load under ESM.
import electronUpdater, { type UpdateInfo } from "electron-updater";
const { autoUpdater } = electronUpdater;
import {
  parseUpdateSnoozeRecord,
  snoozeUpdate,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FIRST_CHECK_DELAY_MS,
  updatePrompt,
  type UpdateSnooze,
  type UpdateSnoozeRecord,
  type UpdateState,
} from "@pistachio/shell-contracts/updates";

/** The person's answers to the update dialog, under userData. */
const SNOOZE_FILE = "update-prompt.json";

export interface UpdateServiceOptions {
  /** Where the current state goes whenever it changes (shell window). */
  publish(state: UpdateState): void;
  /** Bring the window forward, where the shell's update dialog is waiting. */
  focusUpdates(): Promise<void>;
}

export class UpdateService {
  #state: UpdateState;
  #timer: NodeJS.Timeout | null = null;
  /** The delayed first check, held so `stop` can call it off before it fires. */
  #firstCheck: NodeJS.Timeout | null = null;
  #notifiedVersion: string | null = null;
  #checkedAt: string | null = null;
  #snooze: UpdateSnoozeRecord | null = null;
  /** Republishes the offer when a "tomorrow" runs out, so the dialog comes back on time. */
  #snoozeTimer: NodeJS.Timeout | null = null;
  readonly #options: UpdateServiceOptions;

  constructor(options: UpdateServiceOptions) {
    this.#options = options;
    // A release engineer's escape hatch: point any build, a dev run included,
    // at a local feed to rehearse the whole flow (docs/releasing.md).
    const feed = process.env["PISTACHIO_UPDATE_FEED"]?.trim() ?? "";
    if (!app.isPackaged && feed === "") {
      this.#state = {
        status: "unsupported",
        reason: "Updates apply to the installed app, not a development run.",
      };
      return;
    }
    this.#state = { status: "idle", checkedAt: null };
    this.#snooze = this.#readSnooze();
    if (feed !== "") {
      // electron-updater reads its provider config from a yml next to the app
      // in dev; write one into userData so a dev run needs no checked-in file.
      const config = join(app.getPath("userData"), "dev-app-update.yml");
      writeFileSync(config, `provider: generic\nurl: ${feed}\n`);
      autoUpdater.updateConfigPath = config;
      autoUpdater.forceDevUpdateConfig = true;
      autoUpdater.setFeedURL({ provider: "generic", url: feed });
    }
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on("checking-for-update", () => this.#set({ status: "checking" }));
    autoUpdater.on("update-not-available", () => {
      this.#checkedAt = new Date().toISOString();
      this.#set({ status: "up-to-date", checkedAt: this.#checkedAt });
    });
    autoUpdater.on("update-available", (info: UpdateInfo) => {
      this.#checkedAt = new Date().toISOString();
      this.#offer(info.version, info.releaseDate ?? null);
      // Put off is put off: no system notification while the dialog waits.
      if (this.#state.status === "available" && this.#state.prompt.due) this.#notify(info.version);
    });
    autoUpdater.on("download-progress", (progress) => {
      const version = this.#version() ?? "";
      this.#set({
        status: "downloading",
        version,
        percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
      });
    });
    autoUpdater.on("update-downloaded", (info: UpdateInfo) =>
      this.#set({ status: "ready", version: info.version }),
    );
    autoUpdater.on("error", (error: Error) => {
      // A failed background check should not shout; the About page shows it.
      this.#set({
        status: "error",
        message: friendlyError(error),
        checkedAt: this.#checkedAt,
      });
    });
  }

  state(): UpdateState {
    return this.#state;
  }

  /**
   * Check shortly, then keep checking on the interval. Both timers are held:
   * during the opening delay there is no interval yet, so a `start` that only
   * looked at the interval would set a second delay running, and a `stop`
   * that only cleared the interval could not call the first check off at all.
   */
  start(): void {
    if (this.#state.status === "unsupported") return;
    if (this.#timer !== null || this.#firstCheck !== null) return;
    this.#firstCheck = setTimeout(() => {
      this.#firstCheck = null;
      void this.check();
      this.#timer = setInterval(() => void this.check(), UPDATE_CHECK_INTERVAL_MS);
      this.#timer.unref();
    }, UPDATE_FIRST_CHECK_DELAY_MS);
    this.#firstCheck.unref();
  }

  stop(): void {
    if (this.#firstCheck !== null) clearTimeout(this.#firstCheck);
    this.#firstCheck = null;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#snoozeTimer !== null) clearTimeout(this.#snoozeTimer);
    this.#snoozeTimer = null;
  }

  async check(): Promise<UpdateState> {
    if (this.#state.status === "unsupported") return this.#state;
    // A download in flight, or one waiting to install, outranks a re-check.
    if (this.#state.status === "downloading" || this.#state.status === "ready")
      return this.#state;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error: unknown) {
      // Usually also reported through the "error" event above; a throw before
      // the first event would otherwise leave the state at "idle".
      const failure = error instanceof Error ? error : new Error(String(error));
      console.error("[updates] check threw:", failure.stack ?? failure.message);
      if (this.#state.status === "checking" || this.#state.status === "idle")
        this.#set({
          status: "error",
          message: friendlyError(failure),
          checkedAt: this.#checkedAt,
        });
    }
    return this.#state;
  }

  async download(): Promise<UpdateState> {
    if (this.#state.status !== "available") return this.#state;
    this.#set({ status: "downloading", version: this.#state.version, percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch {
      // Reported through the "error" event above.
    }
    return this.#state;
  }

  /** Quit and relaunch into the downloaded version. */
  install(): void {
    if (this.#state.status !== "ready") return;
    autoUpdater.quitAndInstall();
  }

  /** Put the dialog off for the release on offer; the sidebar pill stays. */
  snooze(choice: UpdateSnooze): UpdateState {
    if (this.#state.status !== "available") return this.#state;
    this.#snooze = snoozeUpdate(this.#snooze, app.getVersion(), this.#state.version, choice, new Date());
    this.#writeSnooze(this.#snooze);
    this.#offer(this.#state.version, this.#state.releaseDate);
    return this.#state;
  }

  /** Publish the release on offer with whether its dialog is due now. */
  #offer(version: string, releaseDate: string | null): void {
    const prompt = updatePrompt(this.#snooze, app.getVersion(), version, new Date());
    this.#set({ status: "available", version, releaseDate, prompt });
    if (this.#snoozeTimer !== null) clearTimeout(this.#snoozeTimer);
    this.#snoozeTimer = null;
    const until = prompt.due ? null : (this.#snooze?.until ?? null);
    if (until === null) return;
    this.#snoozeTimer = setTimeout(() => {
      this.#snoozeTimer = null;
      const s = this.#state;
      if (s.status === "available") this.#offer(s.version, s.releaseDate);
    }, Math.max(0, Date.parse(until) - Date.now()));
    this.#snoozeTimer.unref();
  }

  #readSnooze(): UpdateSnoozeRecord | null {
    try {
      return parseUpdateSnoozeRecord(JSON.parse(readFileSync(join(app.getPath("userData"), SNOOZE_FILE), "utf8")));
    } catch {
      return null;
    }
  }

  #writeSnooze(record: UpdateSnoozeRecord): void {
    const path = join(app.getPath("userData"), SNOOZE_FILE);
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      // The answer still holds for this run; only the next launch asks again.
      console.error("[updates] could not save the snooze:", error instanceof Error ? error.message : error);
    }
  }

  #version(): string | null {
    const s = this.#state;
    return s.status === "available" || s.status === "downloading" || s.status === "ready"
      ? s.version
      : null;
  }

  #set(state: UpdateState): void {
    this.#state = state;
    // One line per transition on stderr: enough to debug a field report.
    const detail =
      state.status === "error"
        ? state.message
        : state.status === "downloading"
          ? `${state.version} ${state.percent}%`
          : (this.#version() ?? "");
    console.error(`[updates] ${state.status} ${detail}`.trimEnd());
    this.#options.publish(state);
  }

  #notify(version: string): void {
    if (this.#notifiedVersion === version) return;
    this.#notifiedVersion = version;
    if (process.env["PISTACHIO_E2E"] === "1" || !Notification.isSupported()) return;
    // In front, the shell's dialog is the notice.
    if (BrowserWindow.getFocusedWindow() !== null) return;
    const notice = new Notification({
      title: `Pistachio ${version} is available`,
      body: "Update now or pick a time. Nothing changes until Pistachio restarts.",
      silent: true,
    });
    notice.on("click", () => void this.#options.focusUpdates());
    notice.show();
  }
}

function friendlyError(error: Error): string {
  const text = error.message;
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR|network/i.test(text))
    return "Could not reach the update server. Check your connection and try again.";
  if (/404|latest-mac\.yml/i.test(text))
    return "The release feed is not available right now.";
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}
