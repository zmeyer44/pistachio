/**
 * CloudRunService — the desktop's window onto runs the cloud browser drives
 * (docs/cloud-sync-design.md §10.4, §7.8).
 *
 * Control keeps every hosted run as an append-only event stream. This
 * service lists the account's runs for every Space (`GET /runs?spaceId=`),
 * subscribes to the live ones over SSE (`GET /runs/:id/events`, read from
 * the fetch body — main has no EventSource), opens the sealed content events
 * with the Space's key (`open` under `runEventSealAad(runId, eventId)`), and
 * folds the whole stream with `foldRunInto` into the same `RunSummary` a
 * local run has. The folded run lands in the ThreadStore as a thread whose
 * `executor` is the cloud, so the console lists and opens it like any other;
 * when it is the open thread, RunController.refreshRemote follows it.
 *
 * Steering goes the other way: message / answer / interrupt / release /
 * revoke are POSTs to control; their effect comes back through the stream.
 * A device without a Space's secret still sees the control-class rows
 * (status, tools, budgets) — never the content.
 *
 * Gating (D22): nothing dials until `start()` is called from the enrolled
 * transition, and every call needs the control client the account holds.
 */

import {
  isTerminalStatus,
  SseParser,
  type AgentAttachment,
  type AgentQuestion,
  type RunContentEvent,
  type RunControlEvent,
  type RunEvent,
  type RunSummary,
  type StoredRunEvent,
  type TaskStatus,
  type ThreadListItem,
} from "@pistachio/protocol";
import {
  deriveSpaceKeys,
  fromBase64,
  fromUtf8,
  open,
  runEventSealAad,
  runThreadSealAad,
  liveProofSealAad,
  seal,
  toBase64,
  utf8,
  type SpaceKeys,
} from "@pistachio/sync-protocol";
import type { CloudStartRunRequest } from "@pistachio/shell-contracts/ipc";
import {
  foldRunInto,
  parseContentEvent,
  parseStoredRunEvent,
  webStartUrl,
} from "@pistachio/shell-contracts/run-fold";
import type { ControlClient } from "../account/control-client";
import type { CloudRunCommands } from "../run-controller";
import { threadListItem, type ThreadRecord } from "../thread-store";

/** A dropped stream of a live run is re-dialed after this, doubling up to the cap. */
export const RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_DESKTOP_ANSWER_ATTEMPTS = 8;
const IMESSAGE_LINK_CACHE_MS = 30_000;
/** Folded events reach the thread store and the console together, on this cadence. */
const PUBLISH_DELAY_MS = 40;

/** The Space store surface the observer reads. */
export interface CloudRunSpaces {
  all(): Array<{ id: string }>;
  activeId(): string;
  get(spaceId: string): { id: string } | null;
}

/** Where a folded run goes besides the thread store: the console, when it is open there. */
export interface RemoteRunSink {
  refreshRemote(run: RunSummary): void;
  answerIMessageQuestion?(runId: string, questionId: string, value: string): Promise<void>;
}

/** The thread store surface the observer writes through. */
export interface CloudRunThreads {
  get(runId: string): ThreadRecord | null;
  list(): ThreadListItem[];
  save(record: ThreadRecord): void;
}

export interface CloudRunServiceDeps {
  /** The control client while enrolled; null otherwise. */
  control(): ControlClient | null;
  spaces: CloudRunSpaces;
  /** The Space root secret this Mac holds, or null (then only control-class rows are readable). */
  spaceSecret(spaceId: string): Uint8Array | null;
  threads: CloudRunThreads;
  /** The run controller, once the window exists. */
  runs(): RemoteRunSink | null;
  /** The active human tab, for a run's `startUrl`. */
  activeTab(): { url: string } | null;
  /** The thread list changed: publish the run snapshot. */
  onChange(): void;
  fetchImpl?: typeof fetch;
  now?(): number;
  reconnectDelayMs?: number;
  publishDelayMs?: number;
}

interface TrackedRun {
  runId: string;
  spaceId: string;
  run: RunSummary | null;
  /** The last `seq` folded; the next dial asks for what follows it. */
  seq: number;
  terminal: boolean;
  abort: AbortController | null;
  reconnectTimer: NodeJS.Timeout | null;
  publishTimer: NodeJS.Timeout | null;
  attempts: number;
}

interface DesktopAnswerWatch {
  abort: AbortController;
  seq: number;
  attempts: number;
}

function isTerminal(status: TaskStatus): boolean {
  return isTerminalStatus(status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The stream readers and the fold itself are the pure module both hosts use
 * (`@pistachio/shell-contracts/run-fold`); they are re-exported here because
 * this file is where the desktop's callers already look for them.
 */
export { parseStoredRunEvent, parseContentEvent, webStartUrl };

export class CloudRunService implements CloudRunCommands {
  readonly #deps: CloudRunServiceDeps;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #tracked = new Map<string, TrackedRun>();
  /** Runs the person deleted: never followed again while this Mac runs. */
  readonly #forgotten = new Set<string>();
  readonly #keys = new Map<string, Promise<SpaceKeys | null>>();
  readonly #mirrorChains = new Map<string, Promise<void>>();
  readonly #desktopAnswerWatches = new Map<string, DesktopAnswerWatch>();
  /**
   * The newest run event this Mac has consumed per run, kept across watches.
   * A watch is torn down when its question is answered and a new one opens
   * for the next question; control replays every event after `since`, so a
   * watch that restarted at 0 would re-read the previous question's
   * `cmd.answer` — which the RunController drops as stale — and stop.
   */
  readonly #desktopAnswerSeq = new Map<string, number>();
  #imessageLinkCache: { expiresAt: number; value: Promise<boolean> } | null = null;
  #started = false;
  #refreshing: Promise<void> | null = null;

  constructor(deps: CloudRunServiceDeps) {
    this.#deps = deps;
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#now = deps.now ?? (() => Date.now());
  }

  get started(): boolean {
    return this.#started;
  }

  /** The device is enrolled: list the account's runs and follow the live ones. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.refresh();
    const pendingAnswerRuns: string[] = [];
    for (const item of this.#deps.threads.list()) {
      if (item.executor?.kind === "cloud") continue;
      const record = this.#deps.threads.get(item.runId);
      if (record === null) continue;
      const assigned = record.spaceId === undefined
        ? { ...record, spaceId: this.#deps.spaces.activeId() }
        : record;
      if (record.spaceId === undefined) this.#deps.threads.save(assigned);
      this.mirrorDesktop(assigned);
      if (assigned.run.pendingQuestion !== null) pendingAnswerRuns.push(assigned.run.runId);
    }
    if (pendingAnswerRuns.length > 0) void this.#resumeDesktopAnswerWatches(pendingAnswerRuns);
  }

  /** Sign-out or revocation: every stream closes; nothing dials until `start()`. */
  stop(): void {
    this.#started = false;
    for (const tracked of this.#tracked.values()) this.#release(tracked);
    this.#tracked.clear();
    for (const watch of this.#desktopAnswerWatches.values()) watch.abort.abort();
    this.#desktopAnswerWatches.clear();
    this.#desktopAnswerSeq.clear();
    this.#keys.clear();
    this.#imessageLinkCache = null;
  }

  /**
   * Best-effort E2EE mirror of a locally executed conversation. Local use is
   * never blocked by control being offline; the next save or enrollment
   * retries the newest whole snapshot.
   */
  mirrorDesktop(record: ThreadRecord): void {
    if (!this.#started || record.spaceId === undefined || record.run.executor?.kind === "cloud") return;
    const snapshot = structuredClone(record);
    snapshot.run.executor = { kind: "desktop" };
    const previous = this.#mirrorChains.get(snapshot.run.runId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.#mirrorDesktopNow(snapshot))
      .catch((error: unknown) => {
        console.error(`[threads] could not mirror ${snapshot.run.runId}`, error);
      })
      .finally(() => {
        if (this.#mirrorChains.get(snapshot.run.runId) === next) this.#mirrorChains.delete(snapshot.run.runId);
      });
    this.#mirrorChains.set(snapshot.run.runId, next);
    if (snapshot.run.pendingQuestion === null) this.#stopDesktopAnswers(snapshot.run.runId);
  }

  /**
   * Serialize connector delivery behind the encrypted mirror that creates the
   * hosted desktop run. A status lookup happens first so plaintext never
   * crosses control unless this account actually linked iMessage.
   */
  notifyIMessage(
    record: ThreadRecord,
    event:
      | { kind: "question"; question: AgentQuestion }
      | { kind: "completion"; text: string; completionId: string }
      | { kind: "resolved"; questionId?: string },
  ): void {
    if (!this.#started || record.spaceId === undefined || record.run.executor?.kind === "cloud") return;
    const snapshot = structuredClone(record);
    this.mirrorDesktop(snapshot);
    const runId = snapshot.run.runId;
    const previous = this.#mirrorChains.get(runId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const control = this.#deps.control();
        if (control === null) return;
        if (event.kind !== "resolved" && !(await this.#imessageLinked())) return;
        const delivered = await control.deliverIMessage(runId, event);
        if (delivered && event.kind === "question") this.#watchDesktopAnswers(runId);
        if (event.kind === "resolved") this.#stopDesktopAnswers(runId);
      })
      .catch((error: unknown) => {
        console.error(`[iMessage] could not deliver for ${runId}`, error);
      })
      .finally(() => {
        if (this.#mirrorChains.get(runId) === next) this.#mirrorChains.delete(runId);
      });
    this.#mirrorChains.set(runId, next);
  }

  /**
   * The person deleted this conversation: stop following it and do not pick
   * it up again on the next refresh. Without this the SSE stream folds the
   * next event straight back into the thread store and the row returns.
   */
  forget(runId: string): void {
    const tracked = this.#tracked.get(runId);
    if (tracked !== undefined) {
      this.#release(tracked);
      this.#tracked.delete(runId);
    }
    this.#stopDesktopAnswers(runId);
    this.#desktopAnswerSeq.delete(runId);
    this.#forgotten.add(runId);
  }

  /** Re-list every Space's runs; single-flight. */
  refresh(): Promise<void> {
    if (this.#refreshing !== null) return this.#refreshing;
    const run = this.#refreshOnce().finally(() => {
      if (this.#refreshing === run) this.#refreshing = null;
    });
    this.#refreshing = run;
    return run;
  }

  /** Run ids whose stream is being followed (not yet terminal). */
  liveRunIds(): string[] {
    return [...this.#tracked.values()].filter((tracked) => !tracked.terminal).map((tracked) => tracked.runId);
  }

  /** The folded run as this Mac last saw it, or null. */
  run(runId: string): RunSummary | null {
    const tracked = this.#tracked.get(runId);
    return tracked?.run === null || tracked === undefined ? null : structuredClone(tracked.run);
  }

  /* ------------------------------ starting a run ------------------------------ */

  /** `POST /runs` for the active Space and tab (§10.4), then follow the run. */
  async startRun(request: CloudStartRunRequest): Promise<{ runId: string }> {
    const control = this.#requireControl();
    const spaceId = request.spaceId ?? this.#deps.spaces.activeId();
    if (this.#deps.spaces.get(spaceId) === null) throw new Error("unknown Space");
    const intent = request.intent.trim();
    if (intent === "") throw new Error("say what the cloud browser should do");
    const startUrl = webStartUrl(request.startUrl ?? this.#deps.activeTab()?.url ?? null);
    const { runId } = await control.createRun({
      spaceId,
      intent,
      attachments: request.attachments ?? [],
      ...(startUrl === undefined ? {} : { startUrl }),
    });
    if (typeof runId !== "string" || runId === "") throw new Error("control did not name the run");
    this.#follow(runId, spaceId);
    return { runId };
  }

  /* -------------------------------- steering -------------------------------- */

  async message(runId: string, text: string, attachments: AgentAttachment[]): Promise<void> {
    await this.#requireControl().runMessage(runId, {
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    this.#ensureFollowed(runId);
  }

  async answer(runId: string, questionId: string, value: string): Promise<void> {
    await this.#requireControl().runAnswer(runId, { questionId, value });
  }

  async interrupt(runId: string): Promise<void> {
    await this.#requireControl().runInterrupt(runId);
  }

  async release(runId: string): Promise<void> {
    await this.#requireControl().runRelease(runId);
  }

  async revoke(runId: string): Promise<void> {
    await this.#requireControl().runRevoke(runId);
  }

  /* -------------------------------- internals -------------------------------- */

  #requireControl(): ControlClient {
    const control = this.#deps.control();
    if (control === null) throw new Error("Sign in and enroll this Mac to use the cloud browser.");
    return control;
  }

  async #refreshOnce(): Promise<void> {
    const control = this.#deps.control();
    if (control === null || !this.#started) return;
    for (const space of this.#deps.spaces.all()) {
      let listed: ThreadListItem[];
      try {
        listed = await control.listRuns(space.id);
      } catch (error) {
        console.error(`[cloud] could not list the runs of Space ${space.id}`, error);
        continue;
      }
      if (!this.#started) return;
      for (const item of listed) {
        if (typeof item.runId !== "string" || item.runId === "") continue;
        if (this.#tracked.has(item.runId) || this.#forgotten.has(item.runId)) continue;
        // A local controller owns its desktop run. Its encrypted whole-thread
        // snapshots are not the cloud runner's event stream.
        if (item.executor?.kind === "desktop") continue;
        const stored = this.#deps.threads.get(item.runId);
        // A finished run this Mac already holds in full needs no re-read.
        if (stored !== null && isTerminal(item.status) && stored.run.status === item.status) continue;
        this.#follow(item.runId, space.id);
      }
    }
  }

  async #mirrorDesktopNow(record: ThreadRecord): Promise<void> {
    const control = this.#deps.control();
    const spaceId = record.spaceId;
    if (control === null || spaceId === undefined) return;
    const keys = await this.#keysFor(spaceId);
    if (keys === null) return;
    const run = { ...record.run, executor: { kind: "desktop" } as const };
    await control.createDesktopRun({
      runId: run.runId,
      taskId: run.taskId,
      spaceId,
      intent: run.purpose,
      attachments: run.messages[0]?.attachments ?? [],
      startedAt: run.startedAt,
    });
    const plaintext = utf8(JSON.stringify({ version: 2, run, model: record.model }));
    const sealed = toBase64(await seal(keys.sealKey, plaintext, runThreadSealAad(run.runId)));
    await control.putDesktopRunSnapshot(run.runId, {
      summary: { ...threadListItem(run), executor: { kind: "desktop" } },
      completedAt: run.completedAt,
      thread: { spaceId, sealed },
    });
  }

  #watchDesktopAnswers(runId: string): void {
    if (!this.#started || this.#desktopAnswerWatches.has(runId)) return;
    const watch: DesktopAnswerWatch = {
      abort: new AbortController(),
      seq: this.#desktopAnswerSeq.get(runId) ?? 0,
      attempts: 0,
    };
    this.#desktopAnswerWatches.set(runId, watch);
    void this.#streamDesktopAnswers(runId, watch);
  }

  #stopDesktopAnswers(runId: string): void {
    const watch = this.#desktopAnswerWatches.get(runId);
    if (watch === undefined) return;
    this.#desktopAnswerWatches.delete(runId);
    watch.abort.abort();
  }

  async #streamDesktopAnswers(runId: string, watch: DesktopAnswerWatch): Promise<void> {
    while (this.#started && this.#desktopAnswerWatches.get(runId) === watch && !watch.abort.signal.aborted) {
      const control = this.#deps.control();
      if (control === null) break;
      try {
        // Do not consume and redial the same cmd.answer while main is still
        // constructing the controller that can apply it.
        if (this.#deps.runs()?.answerIMessageQuestion === undefined) throw new Error("run controller is not ready");
        const headers = await control.authorizedHeaders();
        const response = await this.#fetch(control.runEventsUrl(runId, watch.seq), {
          method: "GET",
          headers: { ...headers, accept: "text/event-stream" },
          signal: watch.abort.signal,
        });
        if (!response.ok || response.body === null) throw new Error(`control answered ${String(response.status)}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        let ended = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            if (frame.event === "end") {
              ended = true;
              break;
            }
            if (frame.event !== "run") continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(frame.data);
            } catch {
              continue;
            }
            const stored = parseStoredRunEvent(parsed);
            if (stored === null || stored.seq <= watch.seq) continue;
            if (stored.event.t !== "cmd.answer") {
              this.#advanceDesktopAnswers(runId, watch, stored.seq);
              continue;
            }
            const sink = this.#deps.runs();
            if (sink?.answerIMessageQuestion === undefined) {
              await reader.cancel().catch(() => undefined);
              throw new Error("run controller is not ready");
            }
            this.#advanceDesktopAnswers(runId, watch, stored.seq);
            await sink.answerIMessageQuestion(
              runId,
              stored.event.questionId,
              stored.event.value,
            );
            // Keep reading: the person can be asked again on the same run, and
            // the answer to that next question arrives on this same stream.
            // The watch is torn down by `mirrorDesktop`/`notifyIMessage` once
            // the run has no pending question left.
          }
          if (ended || watch.abort.signal.aborted) break;
        }
        if (ended) break;
        throw new Error("answer stream ended before the question was answered");
      } catch (error) {
        if (watch.abort.signal.aborted) break;
        watch.attempts += 1;
        if (watch.attempts === 1) console.error(`[iMessage] answer stream for ${runId} failed; retrying`, error);
        if (watch.attempts >= MAX_DESKTOP_ANSWER_ATTEMPTS) {
          console.error(`[iMessage] answer stream for ${runId} stopped after ${String(watch.attempts)} attempts`);
          break;
        }
      }
      if (watch.abort.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const base = this.#deps.reconnectDelayMs ?? RECONNECT_DELAY_MS;
        const delay = Math.min(base * 2 ** Math.max(0, watch.attempts - 1), MAX_RECONNECT_DELAY_MS);
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          watch.abort.signal.removeEventListener("abort", onAbort);
          resolve();
        }, delay);
        timer.unref();
        watch.abort.signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (this.#desktopAnswerWatches.get(runId) === watch) this.#desktopAnswerWatches.delete(runId);
  }

  /** Consumed up to `seq`: remember it for the run's next watch too. */
  #advanceDesktopAnswers(runId: string, watch: DesktopAnswerWatch, seq: number): void {
    watch.seq = seq;
    watch.attempts = 0;
    this.#desktopAnswerSeq.set(runId, seq);
  }

  async #resumeDesktopAnswerWatches(runIds: string[]): Promise<void> {
    try {
      if (!(await this.#imessageLinked())) return;
      for (const runId of runIds) this.#watchDesktopAnswers(runId);
    } catch (error) {
      console.error("[iMessage] could not check the linked account before restoring answer streams", error);
    }
  }

  #imessageLinked(): Promise<boolean> {
    const cached = this.#imessageLinkCache;
    const at = this.#now();
    if (cached !== null && cached.expiresAt > at) return cached.value;
    const control = this.#deps.control();
    if (control === null) return Promise.resolve(false);
    const value: Promise<boolean> = control.imessageLink()
      .then((link) => link.available && link.linked)
      .catch((error: unknown) => {
        this.#imessageLinkCache = null;
        throw error;
      });
    this.#imessageLinkCache = { expiresAt: at + IMESSAGE_LINK_CACHE_MS, value };
    return value;
  }

  /** A message to a run that ended reopens it (§7.3): follow it again if it went quiet. */
  #ensureFollowed(runId: string): void {
    const tracked = this.#tracked.get(runId);
    if (tracked === undefined) {
      if (!this.#started || this.#forgotten.has(runId)) return;
      // Current thread records retain their Space, so do not make reopening
      // depend on a possibly stale startup listing that is already in flight.
      const stored = this.#deps.threads.get(runId);
      if (stored?.spaceId !== undefined && this.#deps.spaces.get(stored.spaceId) !== null) {
        this.#follow(runId, stored.spaceId);
        return;
      }
      // Older records did not retain a Space. Join any current listing, then
      // force one genuinely fresh listing if that snapshot did not find it.
      void this.refresh()
        .then(() => {
          if (!this.#started || this.#tracked.has(runId) || this.#forgotten.has(runId)) return;
          return this.refresh();
        })
        .catch((error: unknown) => {
          console.error(`[cloud] could not follow reopened run ${runId}`, error);
        });
      return;
    }
    if (!tracked.terminal) return;
    tracked.terminal = false;
    tracked.attempts = 0;
    void this.#stream(tracked);
  }

  #follow(runId: string, spaceId: string): void {
    if (!this.#started) return;
    const existing = this.#tracked.get(runId);
    if (existing !== undefined) return;
    const tracked: TrackedRun = {
      runId,
      spaceId,
      run: null,
      seq: 0,
      terminal: false,
      abort: null,
      reconnectTimer: null,
      publishTimer: null,
      attempts: 0,
    };
    this.#tracked.set(runId, tracked);
    void this.#stream(tracked);
  }

  #release(tracked: TrackedRun): void {
    tracked.abort?.abort();
    tracked.abort = null;
    if (tracked.reconnectTimer !== null) clearTimeout(tracked.reconnectTimer);
    tracked.reconnectTimer = null;
    if (tracked.publishTimer !== null) {
      clearTimeout(tracked.publishTimer);
      tracked.publishTimer = null;
      this.#publishNow(tracked);
    }
  }

  /** Read the run's stream from the last seq folded until it ends or drops. */
  async #stream(tracked: TrackedRun): Promise<void> {
    const control = this.#deps.control();
    if (control === null || !this.#started || this.#tracked.get(tracked.runId) !== tracked) return;
    const abort = new AbortController();
    tracked.abort?.abort();
    tracked.abort = abort;
    let gone = false;
    try {
      const headers = await control.authorizedHeaders();
      const response = await this.#fetch(control.runEventsUrl(tracked.runId, tracked.seq), {
        method: "GET",
        headers: { ...headers, accept: "text/event-stream" },
        signal: abort.signal,
      });
      if (response.status === 404) {
        gone = true;
        throw new Error("run not found");
      }
      if (!response.ok) throw new Error(`control answered ${String(response.status)}`);
      if (response.body === null) throw new Error("control sent no stream");
      tracked.attempts = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (frame.event === "end") {
            tracked.terminal = true;
            break;
          }
          if (frame.event !== "run") continue;
          await this.#fold(tracked, frame.data);
        }
        if (tracked.terminal || abort.signal.aborted) break;
      }
      if (tracked.terminal) await reader.cancel().catch(() => undefined);
    } catch (error) {
      if (!abort.signal.aborted && !gone) console.error(`[cloud] run ${tracked.runId} stream failed`, error);
    } finally {
      if (tracked.abort === abort) tracked.abort = null;
    }
    if (abort.signal.aborted || this.#tracked.get(tracked.runId) !== tracked) return;
    this.#publishNow(tracked);
    if (gone) {
      this.#tracked.delete(tracked.runId);
      return;
    }
    if (tracked.terminal || !this.#started) return;
    // The stream dropped while the run is live: back off and re-dial from the last seq.
    const base = this.#deps.reconnectDelayMs ?? RECONNECT_DELAY_MS;
    const delay = Math.min(base * 2 ** tracked.attempts, MAX_RECONNECT_DELAY_MS);
    tracked.attempts += 1;
    tracked.reconnectTimer = setTimeout(() => {
      tracked.reconnectTimer = null;
      void this.#stream(tracked);
    }, delay);
    tracked.reconnectTimer.unref();
  }

  async #fold(tracked: TrackedRun, data: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const stored = parseStoredRunEvent(parsed);
    if (stored === null || stored.seq <= tracked.seq) return;
    tracked.seq = stored.seq;
    const event = stored.event.t === "sealed" ? await this.#open(tracked, stored) : (stored.event as RunControlEvent);
    if (event === null) return;
    let run: RunSummary | null;
    try {
      // A stream joined after `run.created` has no shape to fold onto.
      run = foldRunInto(tracked.run, tracked.runId, event, stored.at);
    } catch (error) {
      console.error(`[cloud] run ${tracked.runId}: event ${event.t} could not be folded`, error);
      return;
    }
    if (run === null) return;
    tracked.run = run;
    if (event.t === "status") tracked.terminal = isTerminal(event.status);
    this.#schedulePublish(tracked);
  }

  /** A sealed content event opened with the Space key, or null when this Mac cannot read it. */
  async #open(tracked: TrackedRun, stored: StoredRunEvent): Promise<RunContentEvent | null> {
    if (stored.event.t !== "sealed" || stored.event.spaceId !== tracked.spaceId) return null;
    const keys = await this.#keysFor(tracked.spaceId);
    if (keys === null) return null;
    try {
      const bytes = await open(keys.sealKey, fromBase64(stored.event.sealed), runEventSealAad(tracked.runId, stored.eventId));
      return parseContentEvent(JSON.parse(fromUtf8(bytes)));
    } catch {
      return null; // sealed under another key, or tampered: unreadable by design
    }
  }

  /**
   * Answer a live view's challenge (§8.5): the nonce sealed under that
   * Space's key. Null when this Mac cannot open the Space — the same answer
   * it gives when asked to read the thread.
   */
  async proveSpaceKey(spaceId: string, runId: string, nonce: string): Promise<string | null> {
    const keys = await this.#keysFor(spaceId);
    if (keys === null) return null;
    return toBase64(await seal(keys.sealKey, utf8(nonce), liveProofSealAad(runId, nonce)));
  }

  #keysFor(spaceId: string): Promise<SpaceKeys | null> {
    const cached = this.#keys.get(spaceId);
    if (cached !== undefined) return cached;
    const secret = this.#deps.spaceSecret(spaceId);
    // A Space's secret arrives asynchronously (`ensureSpaceSecrets`, sign-in,
    // enableCloud) while this service runs. Caching the miss would keep every
    // later mirror, open, and proof unreadable until sign-out.
    if (secret === null) return Promise.resolve(null);
    const derived = deriveSpaceKeys(spaceId, secret).catch(() => null);
    this.#keys.set(spaceId, derived);
    return derived;
  }

  #schedulePublish(tracked: TrackedRun): void {
    if (tracked.terminal) {
      if (tracked.publishTimer !== null) clearTimeout(tracked.publishTimer);
      tracked.publishTimer = null;
      this.#publishNow(tracked);
      return;
    }
    if (tracked.publishTimer !== null) return;
    tracked.publishTimer = setTimeout(() => {
      tracked.publishTimer = null;
      this.#publishNow(tracked);
    }, this.#deps.publishDelayMs ?? PUBLISH_DELAY_MS);
    tracked.publishTimer.unref();
  }

  #publishNow(tracked: TrackedRun): void {
    const run = tracked.run;
    if (run === null) return;
    const record: ThreadRecord = {
      version: 1,
      spaceId: tracked.spaceId,
      run: { ...run, updatedAt: run.updatedAt || new Date(this.#now()).toISOString() },
      model: [],
    };
    this.#deps.threads.save(record);
    this.#deps.runs()?.refreshRemote(run);
    this.#deps.onChange();
  }
}
