/**
 * Checks the release feed (electron-builder's `latest-mac.yml` next to the
 * DMG on R2) and walks one update through available → downloading → ready.
 *
 * Deliberately not automatic past the check: the download starts when the
 * person asks and the install when they choose to restart, so a browser full
 * of signed-in tabs is never yanked out from under them. A downloaded update
 * is also applied on the next ordinary quit.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, Notification } from "electron";
// electron-updater is CommonJS; a named import fails to load under ESM.
import electronUpdater, { type UpdateInfo } from "electron-updater";
const { autoUpdater } = electronUpdater;
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FIRST_CHECK_DELAY_MS,
  type UpdateState,
} from "@pistachio/shell-contracts/updates";

export interface UpdateServiceOptions {
  /** Where the current state goes whenever it changes (shell window). */
  publish(state: UpdateState): void;
  /** Bring the person to Settings → About, where the update controls live. */
  focusUpdates(): Promise<void>;
}

export class UpdateService {
  #state: UpdateState;
  #timer: NodeJS.Timeout | null = null;
  /** The delayed first check, held so `stop` can call it off before it fires. */
  #firstCheck: NodeJS.Timeout | null = null;
  #notifiedVersion: string | null = null;
  #checkedAt: string | null = null;
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
      this.#set({
        status: "available",
        version: info.version,
        releaseDate: info.releaseDate ?? null,
      });
      this.#notify(info.version);
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
    const notice = new Notification({
      title: `Pistachio ${version} is available`,
      body: "Open Settings → About to download it. Nothing changes until you choose to restart.",
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
