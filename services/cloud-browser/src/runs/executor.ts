/**
 * Runs a claimed hosted run end to end (docs/cloud-sync-design.md §8.2,
 * §8.4): identity and Space keys first (a run without them fails before any
 * context exists), then the Space session, hydration, the start tab, the
 * agent loop with every callback sealed into run events, commands from the
 * long-poll and from steer, and the terminal control call.
 */

import { randomUUID } from "node:crypto";
import { generateText, modelMessageSchema, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import {
  INTEGRATION_TOOL_GROUPS,
  contextBudget,
  runAiBrowserAgent,
  userMessage,
  type AgentRunPolicy,
  type AgentTabInfo,
  type AiAgentRunCallbacks,
  type AiAgentRunResult,
  type ContextBudget,
  type IntegrationToolHost,
} from "@pistachio/agent-runtime";
import { extractArtifactHtml } from "@pistachio/agent-runtime/artifacts";
import {
  bookmarkUrlKey,
  draftFromPage,
  pageSnapshotFromHtml,
  type BookmarkInput,
} from "@pistachio/agent-runtime/bookmarks";
import { EvidenceChain, type EvidenceEntry } from "@pistachio/evidence";
import {
  credentialCaptureSealAad,
  fromBase64,
  fromUtf8,
  liveProofSealAad,
  open,
  openCredentialCapturePayload,
  seal,
  toBase64,
  utf8,
  vaultEntrySealAad,
} from "@pistachio/sync-protocol";
import {
  isVaultStorableField,
  selectVaultEntry,
  type AgentMessage,
  type AgentQuestion,
  type AgentTakeover,
  type CredentialToolRequest,
  type DurablePause,
  type RunContentEvent,
  type RunControlEvent,
  type TaskStatus,
  type VaultEntry,
  type VaultEntryField,
  type VaultEntryPayload,
} from "@pistachio/protocol";
import type { CDPSession } from "playwright-core";
import { ControlError, type ClaimedRunResponse, type ControlClient, type HostedRunRecord } from "../control-client.js";
import { DeviceUnavailableError, WrapperRejectedError, type DeviceIdentityService } from "../identity/provision.js";
import type { DeviceIdentity } from "../identity/device-store.js";
import { DEFAULT_BROWSER_URL, DEFAULT_WEB_URL } from "../config.js";
import { originSet } from "../live/common.js";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import type { LiveRun } from "../live/server.js";
import { fencedBrowser } from "./control-fence.js";
import { EgressUnavailableError, type SessionManager } from "../sync/session-manager.js";
import type { SpaceSession } from "../sync/session.js";
import type { LeaseHandle } from "./claimer.js";
import { openThread, RunEventWriter, sealThread } from "./events.js";
import { integrationHostsFor } from "./integrations.js";

export const DEFAULT_START_URL = "https://www.google.com";
export const DEFAULT_COMMAND_WAIT_SECONDS = 25;
export const DEFAULT_COMMAND_RETRY_DELAY_MS = 2_000;
/** The cloud and desktop expose the same first-party agent tool groups. */
export const CLOUD_TOOL_GROUPS: readonly string[] = [
  "tabs",
  "navigate",
  "read",
  "screenshot",
  "interact",
  "memory",
  "reminders",
  "artifacts",
  "bookmarks",
  "notes",
  "user_notes",
  ...INTEGRATION_TOOL_GROUPS,
];
export const DEFAULT_MAX_STEPS = 200;
/** `hosted_runs.thread` cap (§7.8). */
export const MAX_THREAD_BYTES = 2 * 1024 * 1024;
const PAUSE_TTL_MS = 24 * 60 * 60 * 1000;

export type ModelFactory = (input: {
  userId: string;
  spaceId: string;
  runId: string;
}) => { model: LanguageModel; modelName: string } | Promise<{ model: LanguageModel; modelName: string }>;

export type RunCommandEvent = Extract<
  RunControlEvent,
  { t: "cmd.message" | "cmd.answer" | "cmd.credentials" | "cmd.interrupt" | "cmd.release" | "cmd.revoke" }
>;

const attachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  mediaType: z.string(),
  url: z.string(),
});

export const runCommandSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("cmd.message"), text: z.string(), attachments: z.array(attachmentSchema).default([]) }),
  z.object({ t: z.literal("cmd.answer"), questionId: z.string(), value: z.string() }),
  z.object({ t: z.literal("cmd.credentials"), captureId: z.string() }),
  z.object({ t: z.literal("cmd.interrupt") }),
  z.object({ t: z.literal("cmd.release") }),
  z.object({ t: z.literal("cmd.revoke") }),
]);

export interface ParsedCommand {
  eventId: string | null;
  /** Control's sequence number: a steered command and its long-poll copy share it. */
  seq: number | null;
  command: RunCommandEvent;
}

/**
 * Accepts the long-poll's stored event `{eventId, at, seq, event}` or the
 * steer's bare `cmd.*` event carrying `seq` (control sends `{...event, seq}`).
 */
export function parseRunCommand(value: unknown): ParsedCommand | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { eventId?: unknown; seq?: unknown; event?: unknown };
  const seq = typeof record.seq === "number" && Number.isInteger(record.seq) ? record.seq : null;
  if ("event" in record) {
    const parsed = runCommandSchema.safeParse(record.event);
    if (!parsed.success) return null;
    return { eventId: typeof record.eventId === "string" ? record.eventId : null, seq, command: parsed.data };
  }
  const parsed = runCommandSchema.safeParse(value);
  return parsed.success ? { eventId: null, seq, command: parsed.data } : null;
}

class CommandInbox {
  #items: ParsedCommand[] = [];
  #waiter: ((command: ParsedCommand | null) => void) | null = null;
  readonly #seenIds = new Set<string>();
  readonly #seenSeqs = new Set<number>();
  #closed = false;

  push(key: { eventId: string | null; seq: number | null }, command: RunCommandEvent): boolean {
    if (this.#closed) return false;
    const duplicate =
      (key.eventId !== null && this.#seenIds.has(key.eventId)) || (key.seq !== null && this.#seenSeqs.has(key.seq));
    if (key.eventId !== null) this.#seenIds.add(key.eventId);
    if (key.seq !== null) this.#seenSeqs.add(key.seq);
    if (duplicate) return false;
    if (this.#waiter !== null) {
      const waiter = this.#waiter;
      this.#waiter = null;
      waiter({ ...key, command });
      return true;
    }
    this.#items.push({ ...key, command });
    return true;
  }

  take(): Promise<ParsedCommand | null> {
    const queued = this.#items.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }

  async next(): Promise<RunCommandEvent | null> {
    return (await this.take())?.command ?? null;
  }

  hasMessage(): boolean {
    return this.#items.some((item) => item.command.t === "cmd.message");
  }

  close(): void {
    this.#closed = true;
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.(null);
  }
}

/** One claimed run while this worker holds it. */
export class ActiveRun implements LiveRun {
  readonly run: HostedRunRecord;
  readonly runId: string;
  readonly userId: string;
  readonly spaceId: string;
  readonly abort = new AbortController();
  readonly inbox = new CommandInbox();
  readonly done: Promise<void>;
  status: TaskStatus;
  control: "agent" | "human";
  session: SpaceSession | null = null;
  /** The lease the run was claimed under (teardown and shutdown call control with it). */
  lease: LeaseHandle | null = null;
  /** The event writer, once the Space keys are known. */
  writer: RunEventWriter | null = null;
  /** The run's Space seal key, once hydrated — what a live viewer must prove it holds too. */
  sealKey: CryptoKey | null = null;
  turnAbort: AbortController | null = null;
  abortReason: string | null = null;
  /**
   * Set by `abandon`: the worker itself is giving the run up (its browser
   * went away, or a turn stalled) and must report it failed, not merely
   * stop. Read where the aborted turn's error is handled.
   */
  failReason: string | null = null;
  /** Last time the current turn showed any sign of life (a tool, a model step, a message). */
  lastProgressAt = Date.now();
  /** A terminal control call (complete/fail/revoke) has been made or the lease is gone. */
  terminal = false;
  /** Last command sequence actually consumed by the drive loop. */
  processedSince = 0;
  /** Last event sequence scanned by the command long-poll. */
  since = 0;
  #ended = false;
  #resolveDone: () => void = () => undefined;
  readonly #listeners = new Set<() => void>();

  constructor(run: HostedRunRecord) {
    this.run = run;
    this.runId = run.id;
    this.userId = run.userId;
    this.spaceId = run.spaceId;
    this.status = run.status === "human_control" ? "human_control" : "running";
    this.control = run.status === "human_control" ? "human" : "agent";
    this.done = new Promise<void>((resolve) => {
      this.#resolveDone = resolve;
    });
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** A command from the long-poll or steer. Interrupt and revoke act on a running turn at once. */
  receive(key: { eventId: string | null; seq: number | null }, command: RunCommandEvent): boolean {
    if (this.#ended) return false;
    const accepted = this.inbox.push(key, command);
    if (!accepted) return false;
    if (command.t === "cmd.interrupt" && this.turnAbort !== null) {
      this.abortReason = "interrupt";
      this.turnAbort.abort(new Error("interrupted"));
    }
    // Revoke is not ended here: the drive loop must still reach its
    // `cmd.revoke` case to record `authority.ended` and `done`. Aborting the
    // turn gets it there at once.
    if (command.t === "cmd.revoke" && this.turnAbort !== null) {
      this.abortReason = "revoked";
      this.turnAbort.abort(new Error("revoked"));
    }
    return true;
  }

  /**
   * Give the run up from the worker's side: the current turn is aborted and
   * the loop reports `reason` as the failure. Answers whether a turn was
   * running; when none is, the caller fails the run directly.
   */
  abandon(reason: string): boolean {
    if (this.#ended || this.failReason !== null) return false;
    this.failReason = reason;
    if (this.turnAbort === null) return false;
    this.abortReason = "abandoned";
    this.turnAbort.abort(new Error(reason));
    return true;
  }

  end(reason: string): void {
    if (this.#ended) return;
    this.#ended = true;
    this.abortReason ??= reason;
    this.abort.abort(new Error(reason));
    this.turnAbort?.abort(new Error(reason));
    this.inbox.close();
    this.notify();
  }

  finish(): void {
    this.#resolveDone();
  }

  setStatus(status: TaskStatus, control?: "agent" | "human"): void {
    this.status = status;
    if (control !== undefined) this.control = control;
    this.notify();
  }

  async nextCommand(): Promise<RunCommandEvent | null> {
    const next = await this.inbox.take();
    if (next?.seq !== null && next?.seq !== undefined) {
      this.processedSince = Math.max(this.processedSince, next.seq);
    }
    return next?.command ?? null;
  }

  /* ------------------------------ LiveRun ------------------------------ */

  tabs(): AgentTabInfo[] {
    return this.session?.browser.backend.listTabs() ?? [];
  }

  activeTabId(): string | null {
    return this.session?.browser.backend.activeTabId ?? null;
  }

  guardSessionFor(tabId: string): CDPSession | null {
    return this.session?.browser.backend.guardFor(tabId)?.session ?? null;
  }

  async focusTab(tabId: string): Promise<void> {
    await this.session?.browser.backend.focusTab(tabId);
  }

  /**
   * Whether a viewer holds this run's Space key (§8.5). The proof is the
   * nonce sealed under that key: only a holder can produce one that opens,
   * and the AAD binds it to this run and this nonce so it cannot be replayed
   * from another socket or from a sealed record.
   */
  async verifySpaceProof(nonce: string, proof: string): Promise<boolean> {
    const sealKey = this.sealKey;
    if (sealKey === null) return false;
    try {
      const opened = await open(sealKey, fromBase64(proof), liveProofSealAad(this.runId, nonce));
      return fromUtf8(opened) === nonce;
    } catch {
      return false;
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }
}

/**
 * The browser sessions this worker holds (web-browser-design.md §6.1, §8).
 * A run attached to one acts in ITS tabs, on ITS Chromium, and feeds ITS
 * `ShellHost` directly — same process, so the console's snapshot never waits
 * on a stream. Narrowed to what a run needs, so a test can supply one.
 */
export interface RunBrowserSessions {
  adopt(input: {
    sessionId: string;
    leaseToken: string;
    generation?: number;
    runId: string;
    userId: string;
    spaceId: string;
  }): Promise<RunBrowserSession | null>;
  /** Re-read the session's fence from control now. */
  refresh(sessionId: string): Promise<void>;
  /**
   * A run of this session has ended: re-read the fence AND let the registry
   * own the transition out of "a run is acting", which is what starts a
   * viewerless session's idle clock (§6.4).
   */
  runEnded(sessionId: string, runId: string): Promise<void>;
}

/** One held session, as a run uses it. */
export interface RunBrowserSession {
  readonly host: {
    receiveRunEvent(runId: string, event: RunControlEvent | RunContentEvent, at: string): void;
    refreshThreads(): Promise<void>;
  };
  /** The session's control fence, as control last moved it (W7). */
  readonly control: { holder: "human" | "agent"; generation: number };
  activeRunId: string | null;
  /** Inputs and tool calls this session refused for being under an old fence. */
  droppedInput: number;
}

export interface RunExecutorOptions {
  control: ControlClient;
  identity: DeviceIdentityService;
  sessions: SessionManager;
  /** The worker's browser sessions, when it serves them (§8). */
  browserSessions?: () => RunBrowserSessions | null;
  modelFactory: ModelFactory;
  workerId: string;
  log?: Logger;
  now?: () => Date;
  policy?: AgentRunPolicy;
  budget?: ContextBudget;
  defaultStartUrl?: string;
  /** `www`: where secure capture forms are served, and artifact tool views point (§15). */
  webUrl?: string;
  /**
   * The browser app (§15). Only the credential guard needs it: nothing here
   * links to the browser, but a capture must not be aimed at it either.
   */
  browserUrl?: string;
  commandWaitSeconds?: number;
  commandRetryDelayMs?: number;
  threadFlushMs?: number;
  eventFlushDelayMs?: number;
  /**
   * A turn that shows no progress for this long — no tool event, no model
   * step, no message — is failed as `turn_stalled`. Per-tool deadlines make
   * this rare; it is the backstop for whatever they do not cover.
   */
  turnStallMs?: number;
}

/** See `RunExecutorOptions.turnStallMs`. */
export const DEFAULT_TURN_STALL_MS = 10 * 60_000;

/**
 * Why a credential may not be typed into this page, or null when it may.
 *
 * A capture is the one moment the agent asks a person for a password, and
 * the pause names the site it is for. Aiming one at a Pistachio page would
 * turn that into the oldest trick there is: a form the person is being told,
 * by Pistachio's own chrome, that Pistachio vouches for. There are two
 * Pistachio sites now (docs/web-browser-design.md §15) — `www`, which serves
 * the capture form itself, and the browser app, which IS the chrome — and
 * neither is ever a site someone signs in to through an agent run, so both
 * are refused outright rather than handled carefully.
 */
export function refuseCredentialTarget(pageUrl: URL, pistachioOrigins: ReadonlySet<string>): string | null {
  if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") {
    return "credentials can only be sent to an HTTP or HTTPS page";
  }
  if (pistachioOrigins.has(pageUrl.origin)) {
    return "credentials cannot be requested for a Pistachio page";
  }
  return null;
}
const STALL_CHECK_MS = 15_000;

type TurnState = "agent" | "waiting" | "human";

interface PendingRunInput {
  question: AgentQuestion | null;
  takeover: AgentTakeover | null;
  budgetQuestionId: string | null;
}

interface CloudRunCheckpoint {
  messages: ModelMessage[];
  notes: string;
  turns: number;
  state: TurnState;
  pending: PendingRunInput;
  since: number;
  evidence: EvidenceEntry[];
  signingKey: string | null;
  legacy: boolean;
}

const questionSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  description: z.string(),
  choices: z.array(z.object({ value: z.string(), label: z.string(), description: z.string() })),
  input: z.object({ type: z.literal("text"), placeholder: z.string() }).optional(),
});

const takeoverBaseSchema = z.object({
  id: z.string(),
  reason: z.string(),
  instructions: z.string(),
  resumeLabel: z.string(),
});
const takeoverSchema = z.union([
  takeoverBaseSchema.extend({ kind: z.literal("credentials"), captureId: z.string().min(1) }),
  takeoverBaseSchema.extend({ kind: z.literal("browser").optional() }),
]);

const legacyThreadSchema = z.object({
  version: z.literal(1),
  messages: z.array(modelMessageSchema),
  notes: z.string(),
});

const checkpointThreadSchema = z.object({
  version: z.literal(2),
  messages: z.array(modelMessageSchema),
  notes: z.string(),
  turns: z.number().int().positive(),
  state: z.enum(["agent", "waiting", "human"]),
  pending: z.object({
    question: questionSchema.nullable(),
    takeover: takeoverSchema.nullable(),
    budgetQuestionId: z.string().nullable(),
  }),
  since: z.number().int().nonnegative(),
  evidence: z.array(z.unknown()),
  signingKey: z.string(),
});

async function restoreCheckpoint(
  claimed: ClaimedRunResponse,
  sealKey: CryptoKey,
): Promise<CloudRunCheckpoint | null> {
  const thread = claimed.thread;
  if (thread == null) return null;
  if (thread.spaceId !== claimed.run.spaceId) throw new Error("run checkpoint belongs to another Space");
  const value = await openThread<unknown>(sealKey, claimed.run.id, thread.sealed);
  const current = checkpointThreadSchema.safeParse(value);
  if (current.success) {
    return {
      ...current.data,
      evidence: current.data.evidence as EvidenceEntry[],
      signingKey: current.data.signingKey,
      legacy: false,
    };
  }
  const legacy = legacyThreadSchema.safeParse(value);
  if (!legacy.success) throw new Error("run checkpoint has an unsupported shape");
  return {
    messages: legacy.data.messages,
    notes: legacy.data.notes,
    turns: 1,
    // Version 1 was only durable at a turn boundary. Waiting lets the
    // command that reopened the run arrive before another model call.
    state: "waiting",
    pending: { question: null, takeover: null, budgetQuestionId: null },
    since: 0,
    evidence: [],
    signingKey: null,
    legacy: true,
  };
}

export class RunExecutor {
  readonly #control: ControlClient;
  readonly #identity: DeviceIdentityService;
  readonly #sessions: SessionManager;
  readonly #browserSessions: () => RunBrowserSessions | null;
  readonly #modelFactory: ModelFactory;
  readonly #workerId: string;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #policy: AgentRunPolicy;
  readonly #budget: ContextBudget | null;
  readonly #defaultStartUrl: string;
  readonly #webUrl: string;
  /** Both Pistachio sites, for `refuseCredentialTarget` (§15). */
  readonly #pistachioOrigins: ReadonlySet<string>;
  readonly #commandWaitSeconds: number;
  readonly #commandRetryDelayMs: number;
  readonly #threadFlushMs: number;
  readonly #eventFlushDelayMs: number | null;
  readonly #active = new Map<string, ActiveRun>();
  readonly #turnStallMs: number;

  constructor(options: RunExecutorOptions) {
    this.#control = options.control;
    this.#identity = options.identity;
    this.#sessions = options.sessions;
    this.#browserSessions = options.browserSessions ?? ((): null => null);
    this.#modelFactory = options.modelFactory;
    this.#workerId = options.workerId;
    this.#log = options.log ?? silentLogger;
    this.#now = options.now ?? ((): Date => new Date());
    this.#policy = options.policy ?? { maxSteps: DEFAULT_MAX_STEPS, enabledToolGroups: [...CLOUD_TOOL_GROUPS] };
    this.#budget = options.budget ?? null;
    this.#defaultStartUrl = options.defaultStartUrl ?? DEFAULT_START_URL;
    this.#webUrl = (options.webUrl ?? DEFAULT_WEB_URL).replace(/\/$/u, "");
    this.#pistachioOrigins = originSet([this.#webUrl, options.browserUrl ?? DEFAULT_BROWSER_URL]);
    this.#commandWaitSeconds = options.commandWaitSeconds ?? DEFAULT_COMMAND_WAIT_SECONDS;
    this.#commandRetryDelayMs = options.commandRetryDelayMs ?? DEFAULT_COMMAND_RETRY_DELAY_MS;
    this.#threadFlushMs = options.threadFlushMs ?? 1_000;
    this.#eventFlushDelayMs = options.eventFlushDelayMs ?? null;
    this.#turnStallMs = options.turnStallMs ?? DEFAULT_TURN_STALL_MS;
  }

  get active(): ReadonlyMap<string, ActiveRun> {
    return this.#active;
  }

  runFor(runId: string): ActiveRun | null {
    return this.#active.get(runId) ?? null;
  }

  runsFor(userId: string): ActiveRun[] {
    return [...this.#active.values()].filter((run) => run.userId === userId);
  }

  /** A steer `run.command`; false when the run is not active here or the command is malformed. */
  command(runId: string, command: unknown): boolean {
    const active = this.#active.get(runId);
    if (active === undefined) return false;
    const parsed = parseRunCommand(command);
    if (parsed === null) return false;
    return active.receive(parsed, parsed.command);
  }

  /** Device revoked: fail every active run of the user and wait for them to unwind. */
  async teardownUser(userId: string, reason = "device_revoked"): Promise<void> {
    const runs = this.runsFor(userId);
    for (const active of runs) {
      await this.#fail(active, reason);
      active.end(reason);
    }
    await Promise.all(runs.map((active) => withTimeout(active.done, 10_000)));
  }

  /**
   * Runner shutdown: hand every active run back to control as `interrupted`
   * (the person's next message reopens it) and wait for the loops to unwind.
   */
  async shutdown(): Promise<void> {
    const runs = [...this.#active.values()];
    for (const active of runs) await this.#interrupt(active);
    await Promise.all(runs.map((active) => withTimeout(active.done, 10_000)));
  }

  /**
   * Fail every run this worker holds, with `reason` (`browser_disconnected`
   * when Chromium went away). A run mid-turn is aborted and its loop reports
   * the failure; an idle one is failed here. Control marks each `failed`, so
   * the person sees it and a follow-up reopens it on a fresh browser instead
   * of waiting behind a lease that would otherwise be renewed indefinitely.
   */
  async failAll(reason: string): Promise<void> {
    const runs = [...this.#active.values()];
    this.#log.warn("failing active runs", { reason, count: runs.length });
    await Promise.all(runs.map(async (active) => {
      if (active.abandon(reason)) return;
      if (active.ended || active.terminal) return;
      await this.#fail(active, reason);
      active.end(reason);
    }));
  }

  async execute(claimed: ClaimedRunResponse, lease: LeaseHandle): Promise<void> {
    const run = claimed.run;
    const active = new ActiveRun(run);
    active.lease = lease;
    this.#active.set(run.id, active);
    const onLost = (): void => {
      active.terminal = true;
      active.end("lease_lost");
    };
    lease.lost.addEventListener("abort", onLost, { once: true });
    if (lease.lost.aborted) onLost();
    let writer: RunEventWriter | null = null;
    let poller: Promise<void> | null = null;
    let unsubscribeTabs: (() => void) | null = null;
    let browserSession: RunBrowserSession | null = null;
    try {
      this.#log.info("run claimed", { runId: run.id, userId: run.userId, spaceId: run.spaceId });
      const identity = await this.#identity.identityFor(run.userId);
      if (identity === null) return await this.#fail(active, "cloud_device_missing");
      try {
        await this.#identity.tokenFor(run.userId);
      } catch {
        return await this.#fail(active, "cloud_device_missing");
      }
      let keys;
      try {
        keys = await this.#identity.spaceKeysFor(run.userId, run.spaceId);
      } catch (error) {
        if (error instanceof WrapperRejectedError) return await this.#fail(active, "no_space_key");
        if (error instanceof DeviceUnavailableError) return await this.#fail(active, "cloud_device_missing");
        throw error;
      }
      active.sealKey = keys.sealKey;
      writer = new RunEventWriter({
        runId: run.id,
        spaceId: run.spaceId,
        sealKey: keys.sealKey,
        append: async (events) => {
          if (!lease.alive) return;
          await this.#control.appendEvents(run.id, lease.token, events);
        },
        now: this.#now,
        ...(this.#eventFlushDelayMs === null ? {} : { flushDelayMs: this.#eventFlushDelayMs }),
        log: this.#log,
      });
      active.writer = writer;
      let checkpoint: CloudRunCheckpoint | null;
      try {
        checkpoint = await restoreCheckpoint(claimed, keys.sealKey);
      } catch (error) {
        this.#log.error("run checkpoint restore failed", { runId: run.id, error: errorMessage(error) });
        return await this.#fail(active, "thread_error");
      }
      active.since = checkpoint?.since ?? 0;
      active.processedSince = checkpoint?.since ?? 0;
      // A run attached to a browser session (§8). The claim took the
      // session's lease in the same transaction, so this worker already holds
      // it: the registry adopts that lease rather than claiming a second one,
      // and there stays exactly one heartbeat loop per session.
      browserSession = await this.#adoptBrowserSession(claimed);
      if (browserSession !== null) {
        // Same process: the console's snapshot folds the run's own callbacks
        // as they happen, and never waits on a stream it could not read.
        writer.mirror = (at, event) => {
          browserSession?.host.receiveRunEvent(run.id, event, at);
        };
      }
      let session: SpaceSession;
      try {
        session = await this.#sessions.acquire(run.userId, run.spaceId, { kind: "run", runId: run.id });
      } catch (error) {
        if (error instanceof DeviceUnavailableError) return await this.#fail(active, "cloud_device_missing");
        if (error instanceof EgressUnavailableError) return await this.#fail(active, "egress_unavailable");
        this.#log.error("session setup failed", { runId: run.id, error: errorMessage(error) });
        return await this.#fail(active, "session_error");
      }
      active.session = session;
      this.#log.info("run session ready", { runId: run.id });
      unsubscribeTabs = session.browser.onTabsChanged(() => active.notify());
      const budget = this.#budget ?? contextBudget();
      // Control appended `run.created` (the control-class projection) when the
      // run was created; the runner's stream starts with its own status.
      writer.emit({ t: "status", status: active.status, completedAt: null });
      writer.emit({ t: "control", control: active.control });
      await writer.flush();
      try {
        await session.ready;
        await session.workspace?.ready;
      } catch {
        return await this.#fail(active, "sync_unavailable");
      }
      if (active.ended) return;
      this.#log.info("run hydrated", { runId: run.id });
      // A run in a browser session acts in the tabs the person already has
      // open (§8): it opens one of its own only when the shell named a start
      // page, and only ever opens a blank one when the session has no tab at
      // all. A standalone run always starts on its own page.
      const startUrl = run.startUrl ?? (browserSession === null ? this.#defaultStartUrl : null);
      const empty = session.browser.backend.listTabs().length === 0;
      if (startUrl !== null ? checkpoint === null || empty : empty) {
        try {
          // The tabs a run opens are the agent's, drawn as such in the shell's
          // strip beside the person's (§6.2).
          await session.browser.backend.openTab(startUrl ?? undefined, { kind: "agent" });
        } catch (error) {
          this.#log.warn("start tab failed", { runId: run.id, error: errorMessage(error) });
          if (session.browser.backend.listTabs().length === 0) {
            await session.browser.backend.openTab(undefined, { kind: "agent" });
          }
        }
      }
      this.#log.info("run start tab opened", { runId: run.id });
      // A follow-up can reopen a completed checkpoint. Pull the command that
      // authorized that new turn before interpreting the checkpoint's state.
      if (!(await this.#pollBeforeDrive(active))) return;
      poller = this.#poll(active);
      await this.#drive(active, lease, writer, session, keys.sealKey, identity, budget, checkpoint, browserSession);
      this.#log.info("run loop ended", { runId: run.id, status: active.status });
    } catch (error) {
      if (active.terminal) return;
      this.#log.error("run failed", { runId: run.id, error: errorMessage(error) });
      await this.#fail(active, active.failReason ?? "agent_error");
    } finally {
      lease.lost.removeEventListener("abort", onLost);
      active.end("ended");
      unsubscribeTabs?.();
      if (poller !== null) await poller.catch(() => undefined);
      if (writer !== null) await writer.flush().catch(() => undefined);
      if (active.session !== null) this.#sessions.release(run.userId, run.spaceId, { kind: "run", runId: run.id });
      if (browserSession !== null && run.sessionId !== null) {
        // The run ended: control moved the fence back to the person in the
        // same transaction. Read it now rather than at the next beat, so the
        // pane stops veiling itself the moment the agent is done — and TELL
        // the registry the run is over rather than clearing `activeRunId`
        // here, which only hid the transition the registry starts a
        // viewerless session's idle clock on (§13, revision 6).
        await this.#browserSessions()
          ?.runEnded(run.sessionId, run.id)
          .catch(() => undefined);
        await browserSession.host.refreshThreads().catch(() => undefined);
      }
      this.#active.delete(run.id);
      active.finish();
    }
  }

  /**
   * The browser session a claimed run belongs to, live on this worker. Null
   * for a standalone run, for a worker that serves no sessions, and when the
   * session could not be built — a run whose session will not open still
   * runs, on its own tabs, rather than failing (§8).
   */
  async #adoptBrowserSession(claimed: ClaimedRunResponse): Promise<RunBrowserSession | null> {
    const run = claimed.run;
    const held = claimed.session;
    if (run.sessionId === null || held === undefined) return null;
    const registry = this.#browserSessions();
    if (registry === null) return null;
    try {
      return await registry.adopt({
        sessionId: held.id,
        leaseToken: held.leaseToken,
        generation: held.generation,
        runId: run.id,
        userId: run.userId,
        spaceId: run.spaceId,
      });
    } catch (error) {
      this.#log.warn("the run's browser session could not be adopted", {
        runId: run.id,
        sessionId: held.id,
        error: errorMessage(error),
      });
      return null;
    }
  }

  /**
   * The run's dedicated integrations (D29) as tool hosts: control's list
   * for the Space, opened with the Space seal key here. Nothing about a
   * connection reaches the model but the account's name and access level;
   * the sealed grant stays on this device. A failure to list is a run
   * without integrations, not a failed run.
   */
  async #integrationHosts(
    run: HostedRunRecord,
    lease: LeaseHandle,
    sealKey: CryptoKey,
    evidence: (type: string, payload: Record<string, unknown>) => void,
  ): Promise<IntegrationToolHost[]> {
    let connections;
    let providers;
    try {
      [connections, providers] = await Promise.all([
        this.#control.lookupIntegrations(run.id, lease.token),
        this.#control.listIntegrationProviders(),
      ]);
    } catch (error: unknown) {
      this.#log.warn("integration lookup failed", { runId: run.id, reason: errorMessage(error) });
      return [];
    }
    if (connections.length === 0) return [];
    const used = new Set<string>();
    const hosts = await integrationHostsFor({
      spaceId: run.spaceId,
      sealKey,
      connections,
      providers,
      now: this.#now,
      // A disconnect made on another device reaches this run through the
      // host's periodic re-read; the lease scopes the read to this Space.
      refetch: async (connection) => {
        if (!lease.alive) return null;
        const current = await this.#control.lookupIntegrations(run.id, lease.token);
        return current.find((candidate) => candidate.id === connection.id) ?? null;
      },
      onRevoked: async (connection) => {
        evidence("integration.revoked", { connectionId: connection.id, provider: connection.provider });
        if (!lease.alive) return;
        await this.#control.deleteRevokedIntegration(run.id, connection.id, lease.token).catch((error: unknown) => {
          this.#log.warn("integration revocation could not be recorded", { runId: run.id, reason: errorMessage(error) });
        });
      },
      onReconnectRequired: (connection, reason) => {
        evidence("integration.reconnect_required", { connectionId: connection.id, provider: connection.provider, reason });
        if (!lease.alive) return;
        this.#control.setIntegrationStatus(run.id, connection.id, lease.token, "reconnect_required").catch((error: unknown) => {
          this.#log.warn("integration status could not be recorded", { runId: run.id, reason: errorMessage(error) });
        });
      },
      onUsed: (connection) => {
        if (used.has(connection.id) || !lease.alive) return;
        used.add(connection.id);
        this.#control.markIntegrationUsed(run.id, connection.id, lease.token).catch((error: unknown) => {
          this.#log.warn("integration use could not be recorded", { runId: run.id, reason: errorMessage(error) });
        });
      },
      onSkipped: (connection, reason) => {
        this.#log.warn("integration skipped", { runId: run.id, connectionId: connection.id, provider: connection.provider, reason });
      },
    });
    for (const host of hosts) evidence("integration.bound", { provider: host.provider, access: host.access });
    return hosts;
  }

  /* ------------------------------ the loop ------------------------------ */

  async #drive(
    active: ActiveRun,
    lease: LeaseHandle,
    writer: RunEventWriter,
    session: SpaceSession,
    sealKey: CryptoKey,
    identity: DeviceIdentity,
    budget: ContextBudget,
    checkpoint: CloudRunCheckpoint | null,
    browserSession: RunBrowserSession | null,
  ): Promise<void> {
    const run = active.run;
    const workspace = session.workspace;
    if (workspace === null) throw new Error("workspace tools are unavailable");
    /**
     * The browser the model drives. A run attached to a browser session gets
     * it through the control fence (W7): the generation is stamped when the
     * tool is dispatched and re-checked before the Playwright call, so an
     * action the model issued a moment before the person took control is
     * refused rather than landing on the page they are now typing into. A run
     * with no session has no person to take control from.
     */
    const agentBrowser =
      browserSession === null
        ? session.browser.backend
        : fencedBrowser(
            session.browser.backend,
            () => browserSession.control,
            () => {
              browserSession.droppedInput += 1;
            },
          );
    const notes = { value: checkpoint?.notes ?? "" };
    const notesHost = { read: (): string => notes.value, write: (content: string): string => (notes.value = content) };
    const signingKey = checkpoint?.signingKey === null || checkpoint?.signingKey === undefined
      ? undefined
      : EvidenceChain.importSigningKey(checkpoint.signingKey);
    const chain = new EvidenceChain(
      run.id,
      { principal: `cloud:${identity.deviceId}`, sponsor: run.userId, task: run.taskId },
      signingKey,
      checkpoint?.evidence ?? [],
    );
    const evidence = (type: string, payload: Record<string, unknown>): void => {
      const entry = chain.append(type, payload, this.#now().toISOString());
      writer.emitContent({ t: "evidence", entry: { id: entry.id, at: entry.at, type: entry.type, payload: entry.payload } });
    };
    const message = (
      role: AgentMessage["role"],
      content: string,
      turn: number,
      attachments?: AgentMessage["attachments"],
      id: string = randomUUID(),
    ): void => {
      writer.emitContent({
        t: "message",
        message: {
          id,
          at: this.#now().toISOString(),
          role,
          content,
          turn,
          ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
        },
      });
    };

    let turns = checkpoint?.turns ?? 1;
    let history: ModelMessage[] = checkpoint?.messages ?? [userMessage(`Complete this browser task: ${run.intent}`)];
    // Set from callbacks (closures), so a holder rather than narrowed locals.
    const pending: PendingRunInput = checkpoint === null
      ? { question: null, takeover: null, budgetQuestionId: null }
      : structuredClone(checkpoint.pending);
    let state: TurnState = checkpoint?.state ?? (active.control === "human" ? "human" : "agent");
    // A command sent before this claim—especially the one that reopened an
    // ended run—must join the prompt before the model takes another action.
    if (active.inbox.hasMessage()) state = "waiting";
    if (checkpoint === null) {
      writer.emit({ t: "turn", turns });
      message("user", run.intent, turns, run.attachments);
      evidence("run.started", { executor: "cloud", workerId: this.#workerId, spaceId: run.spaceId });
    } else {
      evidence("run.resumed", { executor: "cloud", workerId: this.#workerId, spaceId: run.spaceId });
    }

    const thread = { pending: null as ModelMessage[] | null, timer: null as NodeJS.Timeout | null };
    const flushThread = async (): Promise<void> => {
      if (thread.timer !== null) {
        clearTimeout(thread.timer);
        thread.timer = null;
      }
      const messages = thread.pending;
      if (messages === null || !lease.alive) return;
      thread.pending = null;
      try {
        const sealed = await sealThread(
          sealKey,
          run.id,
          capThread({
            version: 2,
            messages: stripMedia(messages),
            notes: notes.value,
            turns,
            state,
            pending: structuredClone(pending),
            since: active.processedSince,
            evidence: chain.entries(),
            signingKey: chain.exportSigningKey(),
          }),
        );
        await this.#control.putThread(run.id, lease.token, { spaceId: run.spaceId, sealed });
      } catch (error) {
        this.#log.warn("thread persist failed", { runId: run.id, error: errorMessage(error) });
      }
    };
    const scheduleThread = (messages: ModelMessage[]): void => {
      thread.pending = messages;
      if (thread.timer !== null) return;
      thread.timer = setTimeout(() => {
        thread.timer = null;
        void flushThread();
      }, this.#threadFlushMs);
      thread.timer.unref();
    };
    const callbacks = trackProgress(writer.callbacks({
      onHistory: scheduleThread,
      onQuestion: (question) => {
        pending.question = question;
        evidence("question.asked", { questionId: question.id });
      },
      onTakeover: (takeover) => {
        pending.takeover = takeover;
        evidence("control.requested", { takeoverId: takeover.id, reason: takeover.reason });
      },
    }), () => {
      active.lastProgressAt = Date.now();
    });
    const { model, modelName } = await this.#modelFactory({ userId: run.userId, spaceId: run.spaceId, runId: run.id });
    const memory = workspace.memory(run.id, run.intent);
    const reminders = workspace.reminders(run.id);
    const artifacts = workspace.artifacts(run.id, async ({ title, brief, content, priorHtml }) => {
      const prompt = priorHtml === null
        ? `Build one complete self-contained HTML document. Answer with HTML only.\n\nTITLE: ${title}\n\nBRIEF:\n${brief}\n\nMATERIAL:\n${content}`
        : `Update this self-contained HTML document while preserving its design. Answer with the complete HTML only.\n\nTITLE: ${title}\n\nBRIEF:\n${brief}\n\nCURRENT DOCUMENT:\n${priorHtml}\n\nNEW MATERIAL:\n${content}`;
      const built = await generateText({
        model,
        system: "You are Pistachio's artifact builder. Produce accessible responsive HTML with inline CSS and optional inline JavaScript. Do not invent facts or URLs. All network-loaded resources, external scripts, stylesheets, fetches, forms, and frames are forbidden; use typography, CSS, inline SVG, and only data URLs already supplied in the material. Source links may use exact URLs from the material.",
        prompt,
        maxOutputTokens: 32_000,
        abortSignal: active.abort.signal,
      });
      if (built.finishReason === "length") throw new Error("the artifact builder ran out of room");
      return { html: extractArtifactHtml(built.text, title), model: modelName };
    });
    const enrichBookmark = async (input: BookmarkInput) => {
      const tab = session.browser.backend.listTabs().find((candidate) => bookmarkUrlKey(candidate.url) === bookmarkUrlKey(input.url));
      if (tab === undefined) return {};
      try {
        const html = await session.browser.backend.pageHtml?.(tab.id);
        if (html === undefined) return {};
        return { ...draftFromPage(pageSnapshotFromHtml(html, tab.url)), provenance: "page" as const };
      } catch {
        return {};
      }
    };
    const bookmarks = workspace.bookmarks(run.id, enrichBookmark);
    const userNotes = workspace.notes(run.id);
    const integrations = await this.#integrationHosts(run, lease, sealKey, evidence);
    // Vault entries this run has already typed. A saved password the site
    // rejects must not be typed again on the model's retry: the second
    // request for the same site goes to the person, whose fresh answer then
    // replaces the stale entry.
    const vaultTried = new Set<string>();
    const vaultPayloadSchema = z.object({
      version: z.literal(1),
      values: z.record(z.string(), z.string().max(4096)),
    }).strict();
    /**
     * Fill a request from the person's vault. Null when the vault holds no
     * entry covering every requested field, or the entry could not be opened
     * or preflighted — nothing was typed, so the secure form is still the
     * right next step. Once typing has begun the outcome is reported as is.
     */
    const fillFromVault = async (
      request: CredentialToolRequest,
      siteOrigin: string,
    ): Promise<{ siteName: string; fieldCount: number; status: "complete" | "partial" } | null> => {
      if (session.browser.backend.fillCredentialFields === undefined) return null;
      let entries: VaultEntry[];
      try {
        entries = await this.#control.lookupVault(run.id, lease.token, siteOrigin);
      } catch (error) {
        this.#log.warn("vault lookup failed", { runId: run.id, reason: errorMessage(error) });
        return null;
      }
      const selected = selectVaultEntry(request.fields, entries, vaultTried);
      if (selected === null) return null;
      const { entry, pairs } = selected;
      vaultTried.add(entry.id);
      let plaintext: Uint8Array | null = null;
      try {
        plaintext = await open(sealKey, fromBase64(entry.sealedPayload), vaultEntrySealAad(run.spaceId, entry.id));
        const payload = vaultPayloadSchema.parse(JSON.parse(fromUtf8(plaintext)));
        const fields = pairs.map(({ requested, saved }) => {
          const value = payload.values[saved.id];
          if (value === undefined) throw new Error("vault entry is missing a value");
          return { target: requested.target, value };
        });
        const injection = await session.browser.backend.fillCredentialFields(request.tabId, siteOrigin, fields);
        evidence(injection.status === "complete" ? "vault.injected" : "vault.partial", {
          entryId: entry.id,
          tabId: request.tabId,
          fieldCount: fields.length,
          attemptedCount: injection.attemptedCount,
          clearedCount: injection.clearedCount,
          ...(injection.status === "partial" ? { failureReason: injection.failureReason } : {}),
          siteOrigin,
        });
        if (injection.status === "complete") {
          this.#control.markVaultEntryUsed(run.id, entry.id, lease.token).catch((error: unknown) => {
            this.#log.warn("vault use could not be recorded", { runId: run.id, reason: errorMessage(error) });
          });
        }
        return { siteName: entry.siteName, fieldCount: fields.length, status: injection.status };
      } catch (error) {
        // Nothing reached the page: a stale ciphertext, a key this device no
        // longer holds, or controls that stopped being safely editable.
        evidence("vault.skipped", { entryId: entry.id, siteOrigin, reason: errorMessage(error) });
        return null;
      } finally {
        plaintext?.fill(0);
      }
    };
    /**
     * Keep what the person just handed over, for the next run on this site.
     * Only when they left "save to vault" on, only fields worth keeping (a
     * one-time code is spent), and only after every field went in — a
     * partial handoff has nothing trustworthy to file.
     */
    const saveToVault = async (
      capture: { siteName: string; siteOrigin: string; fields: Array<VaultEntryField & { target: string }> },
      values: Record<string, string>,
    ): Promise<boolean> => {
      const storable = capture.fields.filter(isVaultStorableField);
      if (storable.length === 0) return false;
      const entryId = randomUUID();
      const fields: VaultEntryField[] = storable.map((field) => ({
        id: randomUUID(),
        label: field.label,
        type: field.type,
        ...(field.autocomplete === undefined ? {} : { autocomplete: field.autocomplete }),
      }));
      const payload: VaultEntryPayload = {
        version: 1,
        values: Object.fromEntries(storable.map((field, index) => [fields[index]?.id ?? "", values[field.id] ?? ""])),
      };
      const plaintext = utf8(JSON.stringify(payload));
      let sealedPayload: string;
      try {
        sealedPayload = toBase64(await seal(sealKey, plaintext, vaultEntrySealAad(run.spaceId, entryId)));
      } finally {
        plaintext.fill(0);
      }
      const saved = await this.#control.saveVaultEntry(run.id, {
        leaseToken: lease.token,
        id: entryId,
        siteOrigin: capture.siteOrigin,
        siteName: capture.siteName,
        fields,
        sealedPayload,
      });
      evidence("vault.saved", {
        entryId,
        siteOrigin: capture.siteOrigin,
        fieldCount: fields.length,
        replaced: saved.replaced,
      });
      return true;
    };
    const credentials = {
      host: {
        create: async (request: CredentialToolRequest) => {
          if (!session.browser.backend.listTabs().some((tab) => tab.id === request.tabId)) {
            throw new Error("credential tab is no longer open");
          }
          const inspection = await session.browser.backend.inspect(request.tabId);
          const pageUrl = new URL(inspection.url);
          const refusal = refuseCredentialTarget(pageUrl, this.#pistachioOrigins);
          if (refusal !== null) throw new Error(refusal);
          const editable = new Set(
            inspection.controls
              .filter(
                (control) =>
                  !control.disabled &&
                  ["input", "textarea", "textbox", "searchbox", "combobox"].includes(control.role),
              )
              .map((control) => control.selector),
          );
          const requestedTargets = request.fields.map((field) => field.target);
          if (
            new Set(requestedTargets).size !== requestedTargets.length ||
            requestedTargets.some((target) => !editable.has(target))
          ) {
            throw new Error("credential targets must be editable selectors from the current page inspection");
          }
          const fill = await fillFromVault(request, pageUrl.origin);
          if (fill !== null) return { kind: "vault" as const, fill };
          const capture = await this.#control.createCredentialCapture(run.id, {
            leaseToken: lease.token,
            tabId: request.tabId,
            siteName: request.siteName,
            siteOrigin: pageUrl.origin,
            fields: request.fields,
          });
          return {
            kind: "form" as const,
            capture: {
              id: capture.id,
              siteName: capture.siteName,
              expiresAt: capture.expiresAt,
            },
          };
        },
      },
    };

    // D25: the payload carries opaque correlators only. Prompts, takeover
    // reasons, and instructions are model-authored text about the page. A
    // question crosses the connector boundary in the clear only after this
    // account opts into iMessage. Credential notifications carry only a
    // host-authored capture id; control loads the inspected origin and field
    // labels and constructs its own web URL. Other takeovers reach control
    // only inside sealed content events the desktop folds.
    const pause = async (
      kind: DurablePause["kind"],
      payload: Record<string, unknown>,
      status: TaskStatus,
      question?: AgentQuestion,
    ): Promise<void> => {
      const now = this.#now();
      const durable: DurablePause = {
        id: randomUUID(),
        kind,
        requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + PAUSE_TTL_MS).toISOString(),
        capability: null,
        payload,
      };
      writer.emit({ t: "pause", pause: durable });
      writer.emit({ t: "status", status, completedAt: null });
      const trailing = await writer.take();
      const credentialCaptureId = pending.takeover?.kind === "credentials"
        ? pending.takeover.captureId
        : undefined;
      const imessageLinked = question !== undefined &&
        await this.#control.imessageLinked(run.userId).catch(() => false);
      const forwardQuestion = question !== undefined && imessageLinked ? question : undefined;
      // Control performs the live link lookup after the pause commits. Do not
      // gate this on the runner's short-lived link cache: a newly linked phone
      // should receive the alert immediately.
      const forwardCredentialCapture = credentialCaptureId !== undefined
        ? { captureId: credentialCaptureId }
        : undefined;
      if (lease.alive) {
        await this.#control.pauseRun(
          run.id,
          lease.token,
          durable,
          trailing,
          forwardQuestion,
          forwardCredentialCapture,
        );
      }
      active.setStatus(status);
    };
    const resume = (): void => {
      writer.emit({ t: "resume" });
      writer.emit({ t: "status", status: "running", completedAt: null });
      active.setStatus("running", "agent");
    };
    const complete = async (text: string): Promise<void> => {
      const answer = text.trim() === "" ? "I finished the browser task and verified the current page state." : text.trim();
      message("assistant", answer, turns);
      evidence("run.completed", { model: modelName });
      evidence("authority.ended", { reason: "completed" });
      writer.emitContent({
        t: "result",
        result: {
          summary: answer.length > 240 ? `${answer.slice(0, 237)}…` : answer,
          changes: [],
          capsuleRevoked: false,
          evidenceEntries: chain.entries().length,
          rootHash: chain.rootHash(),
        },
      });
      // A later sponsor message may reopen this exact checkpoint. Persist it
      // between turns so a reclaimed worker consumes that message first.
      state = "waiting";
      await flushThread();
      writer.emit({ t: "status", status: "completed", completedAt: this.#now().toISOString() });
      writer.emit({ t: "done", ok: true });
      const trailing = await writer.take();
      active.terminal = true;
      const forwardCompletion = await this.#control.imessageLinked(run.userId).catch(() => false)
        ? { text: answer, completionId: String(turns) }
        : undefined;
      if (lease.alive) await this.#control.completeRun(run.id, lease.token, trailing, forwardCompletion);
      active.setStatus("completed");
      active.end("completed");
    };

    while (!active.ended) {
      if (state === "agent") {
        const turnAbort = new AbortController();
        active.turnAbort = turnAbort;
        active.lastProgressAt = Date.now();
        // Backstop for a turn that stops showing any sign of life: without
        // it the lease keeps being renewed and the run can never be reclaimed.
        const stallWatch = setInterval(() => {
          if (active.turnAbort !== turnAbort) return;
          if (Date.now() - active.lastProgressAt < this.#turnStallMs) return;
          this.#log.warn("turn stalled", { runId: run.id, idleMs: Date.now() - active.lastProgressAt });
          active.abandon("turn_stalled");
        }, STALL_CHECK_MS);
        stallWatch.unref();
        const onRunAbort = (): void => turnAbort.abort(active.abort.signal.reason);
        active.abort.signal.addEventListener("abort", onRunAbort, { once: true });
        if (active.abort.signal.aborted) onRunAbort();
        let result: AiAgentRunResult;
        this.#log.info("turn started", { runId: run.id, turns });
        try {
          result = await runAiBrowserAgent({
            messages: history,
            browser: agentBrowser,
            callbacks,
            abortSignal: turnAbort.signal,
            notes: notesHost,
            memory,
            reminders: { host: reminders, timezone: workspace.timezone() },
            artifacts: { host: artifacts },
            bookmarks: { host: bookmarks },
            userNotes: { host: userNotes },
            integrations: { hosts: integrations },
            credentials,
            budget,
            model,
            modelName,
            policy: this.#policy,
            now: this.#now,
          });
        } catch (error) {
          if (!turnAbort.signal.aborted) throw error;
          // The worker gave the run up (browser gone, turn stalled): surface
          // it as the run's failure rather than a quiet exit from the loop.
          if (active.failReason !== null) throw new Error(active.failReason);
          if (active.ended) break;
          if (active.abortReason === "interrupt") {
            active.abortReason = null;
            state = "human";
            continue;
          }
          if (active.abortReason === "revoked") {
            // Straight to the command loop, where cmd.revoke is waiting.
            active.abortReason = null;
            continue;
          }
          break;
        } finally {
          clearInterval(stallWatch);
          active.abort.signal.removeEventListener("abort", onRunAbort);
          active.turnAbort = null;
        }
        history = result.messages;
        this.#log.info("turn finished", { runId: run.id, outcome: result.outcome, steps: result.steps });
        scheduleThread(history);
        if (active.ended) break;
        if (result.outcome === "final") {
          if (active.inbox.hasMessage()) {
            // The person wrote while the agent finished: keep the thread open for their message.
            if (result.text.trim() !== "") message("assistant", result.text.trim(), turns);
            state = "waiting";
            continue;
          }
          await complete(result.text);
          break;
        }
        if (result.outcome === "paused") {
          const question = pending.question;
          const takeover = pending.takeover;
          state = "waiting";
          scheduleThread(history);
          await flushThread();
          if (question !== null) {
            await pause("judgment", { questionId: question.id }, "waiting_for_judgment", question);
          } else if (takeover !== null) {
            await pause("step_up", { takeoverId: takeover.id }, "waiting_for_step_up");
          } else {
            await pause("judgment", {}, "waiting_for_judgment");
          }
          active.end("paused");
          break;
        }
        // budget: the person decides whether the agent goes on.
        const question: AgentQuestion = {
          id: randomUUID(),
          prompt: "I have used my step budget for this turn. Should I keep going?",
          description: "The task is not finished yet. I can continue from my notes or stop here.",
          choices: [
            { value: "continue", label: "Continue", description: "Keep working from the notes" },
            { value: "stop", label: "Stop here", description: "End the task now" },
          ],
        };
        callbacks.questionAsked(question);
        pending.budgetQuestionId = question.id;
        state = "waiting";
        scheduleThread(history);
        await flushThread();
        await pause("judgment", { questionId: question.id, budget: true }, "waiting_for_judgment", question);
        active.end("paused");
        break;
      }

      const command = await active.nextCommand();
      if (command === null || active.ended) break;
      switch (command.t) {
        case "cmd.message": {
          turns += 1;
          const preface =
            state === "waiting" && pending.question !== null
              ? "[The person replied to your question]\n"
              : state === "human"
                ? "[The person paused you and now says]\n"
                : "";
          history = [...history, userMessage(`${preface}${command.text}`)];
          writer.emit({ t: "turn", turns });
          // Same id `foldRunEvent` gives the plaintext cmd.message, so a
          // key-holding client upserts this sealed copy over it instead of
          // rendering the person's message twice.
          message("user", command.text, turns, command.attachments, `cmd.message:${String(turns)}`);
          resume();
          pending.question = null;
          pending.takeover = null;
          pending.budgetQuestionId = null;
          state = "agent";
          scheduleThread(history);
          break;
        }
        case "cmd.answer": {
          const question = pending.question;
          const legacyAnswer = checkpoint?.legacy === true && question === null && state === "waiting";
          if (!legacyAnswer && (question === null || question.id !== command.questionId)) break;
          const choice = question?.choices.find((item) => item.value === command.value);
          const answer = choice?.label ?? command.value.trim();
          turns += 1;
          writer.emit({ t: "turn", turns });
          message("user", answer, turns);
          evidence("question.answered", { questionId: command.questionId, answer });
          history = [...history, userMessage(`[The person answered your question]\n${answer}`)];
          scheduleThread(history);
          if (pending.budgetQuestionId === command.questionId && command.value === "stop") {
            resume();
            await complete("I stopped at your request. My notes hold what was done so far.");
            break;
          }
          resume();
          pending.question = null;
          pending.budgetQuestionId = null;
          state = "agent";
          break;
        }
        case "cmd.credentials": {
          const takeover = pending.takeover;
          if (takeover?.id !== command.captureId) {
            // The server accepted this one-time capture against the active
            // durable pause. A stale/missing local checkpoint must not leave
            // the executor parked after control has already resumed the run.
            evidence("credentials.checkpoint_mismatch", {
              captureId: command.captureId,
              checkpointTakeoverId: takeover?.id ?? null,
            });
          }
          let outcome: "complete" | "partial" | "failed" = "failed";
          let kept = false;
          let plaintext: Uint8Array | null = null;
          try {
            const capture = await this.#control.consumeCredentialCapture(run.id, command.captureId, lease.token);
            plaintext = await openCredentialCapturePayload(
              identity.agreementPrivateKey,
              identity.agreementPublicKeyRaw,
              fromBase64(capture.sealedPayload),
              credentialCaptureSealAad(run.id, command.captureId),
            );
            const payload = z.object({
              version: z.literal(1),
              fields: z.record(z.string(), z.string().max(4096)),
              /** The form's "save to my vault" choice; absent on older forms, which kept nothing. */
              remember: z.boolean().optional(),
            }).strict().parse(JSON.parse(fromUtf8(plaintext)));
            const expectedIds = capture.fields.map((field) => field.id).sort();
            const suppliedIds = Object.keys(payload.fields).sort();
            if (expectedIds.length !== suppliedIds.length || expectedIds.some((id, index) => id !== suppliedIds[index])) {
              throw new Error("credential field set did not match the request");
            }
            if (session.browser.backend.fillCredentialFields === undefined) {
              throw new Error("secure credential injection is unavailable");
            }
            const injection = await session.browser.backend.fillCredentialFields(
              capture.tabId,
              capture.siteOrigin,
              capture.fields.map((field) => {
                const value = payload.fields[field.id];
                if (value === undefined) throw new Error("credential field value was missing");
                return { target: field.target, value };
              }),
            );
            outcome = injection.status;
            evidence(injection.status === "complete" ? "credentials.injected" : "credentials.partial", {
              captureId: command.captureId,
              tabId: capture.tabId,
              fieldCount: capture.fields.length,
              attemptedCount: injection.attemptedCount,
              clearedCount: injection.clearedCount,
              ...(injection.status === "partial" ? { failureReason: injection.failureReason } : {}),
              siteOrigin: capture.siteOrigin,
            });
            if (injection.status === "complete" && payload.remember === true) {
              try {
                kept = await saveToVault(capture, payload.fields);
              } catch (error) {
                // The handoff itself succeeded; failing to keep it is worth a
                // note, not a failed run.
                this.#log.warn("vault save failed", { runId: run.id, reason: errorMessage(error) });
                evidence("vault.save_failed", { captureId: command.captureId, siteOrigin: capture.siteOrigin });
              }
            }
          } catch {
            evidence("credentials.failed", { captureId: command.captureId });
          } finally {
            plaintext?.fill(0);
          }
          turns += 1;
          writer.emit({ t: "turn", turns });
          history = [
            ...history,
            userMessage(
              outcome === "complete"
                ? "[The person securely supplied the requested fields. They were inserted into the page without being shown to you. Inspect the page and continue.]"
                : outcome === "partial"
                  ? "[The secure credential handoff was interrupted after typing began. The worker cleared every touched field it could still verify, but some values may remain if the page navigated or replaced a control. Inspect the page before deciding whether to request a fresh secure form.]"
                  : "[The secure credential handoff could not be applied. Inspect the page and request a new secure form if it is still needed.]",
            ),
          ];
          message(
            "user",
            outcome === "complete"
              ? kept ? "Secure fields supplied and kept in your vault for next time." : "Secure fields supplied."
              : outcome === "partial"
                ? "Secure information handoff was interrupted; touched fields were cleared where possible."
                : "Secure information handoff failed.",
            turns,
          );
          resume();
          pending.takeover = null;
          state = "agent";
          scheduleThread(history);
          break;
        }
        case "cmd.interrupt": {
          evidence("control.taken", { by: "person" });
          writer.emit({ t: "control", control: "human" });
          writer.emit({ t: "status", status: "human_control", completedAt: null });
          active.setStatus("human_control", "human");
          state = "human";
          break;
        }
        case "cmd.release": {
          evidence("control.released", { by: "person" });
          writer.emit({ t: "control", control: "agent" });
          if (state === "waiting") writer.emit({ t: "resume" });
          writer.emit({ t: "status", status: "running", completedAt: null });
          active.setStatus("running", "agent");
          // Re-read the session's fence from control BEFORE the turn resumes.
          // The run learns about the release through its own command stream
          // and the session learns about it through the shell's reply; those
          // are two paths out of one control transaction, and the agent must
          // not dispatch a tool call while the session still says the person
          // holds the wheel — the fence would rightly refuse it (W7).
          if (run.sessionId !== null) {
            await this.#browserSessions()
              ?.refresh(run.sessionId)
              .catch((error: unknown) =>
                this.#log.warn("re-reading the session fence after a release failed", {
                  runId: run.id,
                  error: errorMessage(error),
                }),
              );
          }
          history = [
            ...history,
            userMessage(
              pending.takeover !== null
                ? "[The person finished the browser step you asked for. Inspect the live page before continuing.]"
                : "[The person asked you to continue. Inspect the live page and carry on from your notes.]",
            ),
          ];
          pending.takeover = null;
          state = "agent";
          break;
        }
        case "cmd.revoke": {
          evidence("authority.ended", { reason: "revoked" });
          writer.emit({ t: "status", status: "revoked", completedAt: this.#now().toISOString() });
          writer.emit({ t: "done", ok: false });
          active.terminal = true;
          active.setStatus("revoked", "human");
          await writer.flush().catch(() => undefined);
          active.end("revoked");
          break;
        }
      }
    }
    await flushThread();
  }

  /* ------------------------------ helpers ------------------------------ */

  /**
   * Every `cmd.*` event from seq 0: a message sent before the claim (or the
   * one that reopened an interrupted run) is a turn of this thread, and
   * the inbox drops what a steer already delivered.
   */
  async #poll(active: ActiveRun): Promise<void> {
    while (!active.ended) {
      try {
        await this.#pollOnce(active, this.#commandWaitSeconds);
      } catch (error) {
        if (this.#pollErrorEndsRun(active, error)) break;
        await delay(this.#commandRetryDelayMs, active.abort.signal);
      }
    }
  }

  /** The first command read is just as retryable as every later long-poll. */
  async #pollBeforeDrive(active: ActiveRun): Promise<boolean> {
    while (!active.ended) {
      try {
        await this.#pollOnce(active, 0);
        return true;
      } catch (error) {
        if (this.#pollErrorEndsRun(active, error)) return false;
        this.#log.warn("initial command poll failed; retrying", {
          runId: active.runId,
          error: errorMessage(error),
        });
        await delay(this.#commandRetryDelayMs, active.abort.signal);
      }
    }
    return false;
  }

  #pollErrorEndsRun(active: ActiveRun, error: unknown): boolean {
    if (active.ended) return true;
    if (!(error instanceof ControlError) || ![401, 403, 404, 409, 410].includes(error.status)) return false;
    active.terminal = true;
    active.end("lease_lost");
    return true;
  }

  async #pollOnce(active: ActiveRun, waitSeconds: number): Promise<void> {
    const { events, since } = await this.#control.pollCommands(
      active.runId,
      active.since,
      waitSeconds,
      active.abort.signal,
    );
    active.since = typeof since === "number" ? since : events.reduce((max, event) => Math.max(max, event.seq), active.since);
    for (const event of events) {
      const parsed = parseRunCommand(event);
      if (parsed !== null) active.receive(parsed, parsed.command);
    }
  }

  async #fail(active: ActiveRun, reason: string): Promise<void> {
    if (active.terminal) return;
    active.terminal = true;
    const writer = active.writer;
    writer?.emit({ t: "status", status: "failed", completedAt: this.#now().toISOString() });
    writer?.emit({ t: "done", ok: false });
    const trailing = writer === null ? [] : await writer.take().catch(() => []);
    this.#log.warn("run failed", { runId: active.runId, reason });
    const lease = active.lease;
    if (lease !== null && lease.alive) {
      await this.#control.failRun(active.runId, lease.token, reason, trailing).catch((error: unknown) => {
        this.#log.warn("fail call rejected", { runId: active.runId, error: errorMessage(error) });
      });
    }
    active.setStatus("failed");
  }

  /** Shutdown: `status interrupted` (+ a human `control` note is not needed; control appends `control` itself on reopen). */
  async #interrupt(active: ActiveRun): Promise<void> {
    if (active.terminal) return;
    active.terminal = true;
    const writer = active.writer;
    writer?.emit({ t: "status", status: "interrupted", completedAt: null });
    const trailing = writer === null ? [] : await writer.take().catch(() => []);
    this.#log.warn("run interrupted by shutdown", { runId: active.runId });
    const lease = active.lease;
    if (lease !== null && lease.alive) {
      await this.#control.interruptRun(active.runId, lease.token, trailing).catch((error: unknown) => {
        this.#log.warn("interrupt call rejected", { runId: active.runId, error: errorMessage(error) });
      });
    }
    active.setStatus("interrupted");
    active.end("interrupted");
  }

}

export function titleFor(intent: string): string {
  const line = intent.split("\n").find((candidate) => candidate.trim() !== "")?.trim() ?? "Cloud run";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** Drop image and file parts: media never rides in the stored thread (§7.8). */
export function stripMedia(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "user" || typeof message.content === "string") return message;
    const content = message.content.filter((part) => part.type !== "image" && part.type !== "file");
    return content.length === message.content.length ? message : { ...message, content };
  });
}

/**
 * Keep the thread under `MAX_THREAD_BYTES` by dropping the oldest exchange
 * after the first message. An assistant tool call and the tool results that
 * answer it go together: a thread that starts with orphaned results (or a
 * call with no result) is one the model refuses, and the run could then
 * never resume.
 */
export function capThread<T extends { messages: ModelMessage[] }>(thread: T): T {
  let current = thread;
  while (Buffer.byteLength(JSON.stringify(current), "utf8") > MAX_THREAD_BYTES && current.messages.length > 1) {
    let end = 2;
    while (end < current.messages.length && current.messages[end]?.role === "tool") end += 1;
    current = { ...current, messages: [current.messages[0] as ModelMessage, ...current.messages.slice(end)] };
  }
  return current;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * The same callbacks, each also stamping the run's last progress time, so
 * the stall watchdog sees every tool event, model step, and message.
 */
function trackProgress(callbacks: AiAgentRunCallbacks, touch: () => void): AiAgentRunCallbacks {
  const tracked = { ...callbacks } as Record<string, unknown>;
  for (const [name, value] of Object.entries(callbacks)) {
    if (typeof value !== "function") continue;
    const original = value as (...args: unknown[]) => unknown;
    tracked[name] = (...args: unknown[]): unknown => {
      touch();
      return original.apply(callbacks, args);
    };
  }
  return tracked as unknown as AiAgentRunCallbacks;
}
