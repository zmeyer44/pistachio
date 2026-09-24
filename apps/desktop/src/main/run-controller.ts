import { randomUUID } from "node:crypto";
import type { LanguageModel, ModelMessage } from "ai";
import { EvidenceChain, type EvidenceEntry } from "@pistachio/evidence";
import { NotificationRouter } from "@pistachio/notifications";
import {
  integrationOfToolName,
  type AgentAttachment,
  type AgentSubagent,
  type AgentToolCall,
  type PendingApproval,
  type RunSummary,
  type TaskStatus,
  type ThreadListItem,
  isTerminalStatus,
  toolOutputOf,
} from "@pistachio/protocol";
import { ARTIFACT_HOST, artifactToolView, type Artifact, type ArtifactSource, type ArtifactToolView } from "@pistachio/shell-contracts/artifacts";
import { bookmarkToolView, type BookmarkSource } from "@pistachio/shell-contracts/bookmarks";
import { effectiveTimezone, memoryToolView, type MemorySource } from "@pistachio/shell-contracts/memory";
import {
  noteTitle,
  notesUrlId,
  type Note,
  type NoteInput,
  type NotePatch,
  type NoteSource,
  type NoteSummary,
} from "@pistachio/shell-contracts/notes";
import { reminderToolView, systemTimezone, type ReminderSource } from "@pistachio/shell-contracts/reminders";
import { DEFAULT_SETTINGS, type DesktopSettings } from "@pistachio/shell-contracts/settings";
import {
  closeDanglingToolCalls,
  contextBudget,
  decideTurnRoute,
  MAX_TASK_NOTES,
  pageInViewBlock,
  PAGE_ATTACHED_HEADER,
  runAiBrowserAgent,
  TURN_CUT_SHORT,
  userMessage,
  withDeadline,
  type AgentTurnMode,
  type AiAgentRunInput,
  type ArtifactToolHost,
  type BookmarkToolHost,
  type ContextBudget,
  type MemoryToolHost,
  type NotesToolHost,
  type NoteToolHost,
  type ReminderToolHost,
  type TurnLimits,
  type TurnRouteDecision,
  type TurnRouteEvaluation,
  type TurnRouteExchange,
  type TurnRouteRequest,
  type IntegrationToolHost,
} from "@pistachio/agent-runtime";
import { evaluateTurnRoute } from "@pistachio/agent-runtime/turn-route";
import { DesktopBrowserBackend } from "./agent-browser-tools";
import { buildArtifactHtml, type ArtifactBuildRequest } from "./artifact-builder";
import type { ArtifactStore } from "./artifact-store";
import type { BookmarkStore } from "./bookmark-store";
import type { BookmarkService } from "./bookmarks";
import {
  answerModelName,
  artifactModelName,
  configuredAnswerModel,
  configuredIntentModel,
  configuredModel,
  modelName,
  turnRouterEnabled,
} from "./model-provider";
import { BrowserController } from "./browser-controller";
import { describeChanges, learnFromConversation } from "./memory-engine";
import type { MemoryStore } from "./memory-store";
import type { ScheduledAgentOutcome, ScheduledAgentRequest } from "./reminder-scheduler";
import type { ReminderStore } from "./reminder-store";
import { threadListItem, titleFor, type ThreadRecord, type ThreadStore } from "./thread-store";

/** The agent is acting, or about to: nothing else may take the console. */
const ACTIVE_STATUSES: TaskStatus[] = ["capturing", "ready", "running"];

/**
 * A run the cloud browser drives (docs/cloud-sync-design.md §10.4). Its
 * conversation is observed through control and steered through control;
 * nothing here acts on this Mac's tabs for it.
 */
export function isCloudRun(run: Pick<RunSummary, "executor">): boolean {
  return run.executor?.kind === "cloud";
}

/** How a cloud run is steered: every command goes to control (§7.3 runs). */
export interface CloudRunCommands {
  message(runId: string, text: string, attachments: AgentAttachment[]): Promise<void>;
  answer(runId: string, questionId: string, value: string): Promise<void>;
  interrupt(runId: string): Promise<void>;
  release(runId: string): Promise<void>;
  revoke(runId: string): Promise<void>;
  /** Stop following a deleted conversation so its next event cannot restore it. */
  forget(runId: string): void;
  /** Mirror a desktop-owned conversation into hosted encrypted storage. */
  mirrorDesktop?(record: ThreadRecord): void;
  /** Send only an explicit question or final result through the account connector. */
  notifyIMessage?(
    record: ThreadRecord,
    event:
      | { kind: "question"; question: NonNullable<RunSummary["pendingQuestion"]> }
      | { kind: "completion"; text: string; completionId: string }
      | { kind: "resolved"; questionId?: string },
  ): void;
}

/**
 * The note store as this controller uses it (docs/notes.md §3), declared
 * structurally: `main/note-store.ts` is the one implementation, and nothing
 * here needs to import it to call it.
 */
export interface NoteRecordStore {
  list(): NoteSummary[];
  get(id: string): Note | null;
  search(query: string, limit: number): NoteSummary[];
  create(input: NoteInput, source: NoteSource): Note;
  update(id: string, patch: NotePatch, source: NoteSource): Note;
  remove(id: string): void;
}

/** Which surface a tool call touched, for the trace and the evidence chain. */
function toolFamily(name: string): "browser" | "memory" | "reminder" | "artifact" | "bookmark" | "watchtower" | "note" | "notes" | "integration" {
  if (name.startsWith("memory.")) return "memory";
  if (name.startsWith("reminder.")) return "reminder";
  if (name.startsWith("artifact.")) return "artifact";
  if (name.startsWith("watchtower.")) return "watchtower";
  if (name.startsWith("bookmark.")) return "bookmark";
  // `note.` before `notes.`: the person's notes and the run's scratchpad
  // are different surfaces with names one character apart (N7).
  if (name.startsWith("note.")) return "note";
  if (name.startsWith("notes.")) return "notes";
  if (integrationOfToolName(name) !== null) return "integration";
  return "browser";
}

/** The id of the tab a tool made, when its result carries one (tab.open). */
function openedTabId(data: unknown): string | null {
  if (typeof data !== "object" || data === null || !("tabId" in data)) return null;
  const tabId = (data as { tabId: unknown }).tabId;
  return typeof tabId === "string" && tabId.length > 0 ? tabId : null;
}

/**
 * What starts a model turn, and how the model is told about it. The text
 * is the person's own words; the kind adds the one line of situation the
 * model cannot see for itself — that a question was answered, that the
 * browser was handed back.
 */
type TurnInput =
  | { kind: "start"; text: string; attachments: AgentAttachment[]; page: boolean }
  | { kind: "message"; text: string; attachments: AgentAttachment[]; after: "running" | "paused" | "question" | "ended"; page: boolean }
  | { kind: "answer"; text: string }
  | { kind: "takeover-done" }
  | { kind: "resume" };

function turnText(input: TurnInput, scheduled: RunSummary["origin"], mode: AgentTurnMode): string {
  switch (input.kind) {
    case "start": {
      const prefix =
        scheduled?.kind !== "reminder" ? "" : `This is the scheduled reminder “${scheduled.title}”, due ${scheduled.scheduledFor}, running now as planned. `;
      // The answer path is a reply to the person's words as written; only
      // the browser path is handed them as a task.
      return mode === "answer" ? `${prefix}${input.text}` : `${prefix}Complete this browser task: ${input.text}`;
    }
    case "message":
      switch (input.after) {
        case "running": return input.text;
        case "paused": return `[The person paused you and now says]\n${input.text}`;
        case "question": return `[The person replied to your question]\n${input.text}`;
        case "ended": return input.text;
      }
      break;
    case "answer":
      return `[The person answered your question]\n${input.text}`;
    case "takeover-done":
      return "[The person finished the browser step you asked for. Inspect the live page before continuing.]";
    case "resume":
      return "[The person asked you to continue. Inspect the live page and carry on from your notes.]";
  }
}

/**
 * Asks the evaluation model which path a turn takes (docs/console-routing.md).
 * The controller's default asks the account's intent model; a test injects
 * a scripted one. Null is "no opinion", and the browser path.
 */
export type TurnRouter = (request: TurnRouteRequest, abortSignal: AbortSignal) => Promise<TurnRouteEvaluation | null>;

const defaultTurnRouter: TurnRouter = async (request, abortSignal) => {
  const intent = configuredIntentModel();
  if (intent === null) return null;
  return evaluateTurnRoute({ model: intent.model, request, abortSignal });
};

/** The opening line of a browser-path thread; the router's context leaves it out. */
const BROWSE_INTRO = "I’m on it. I’ll show each step here and pause if I need you to step in.";

/**
 * Which turns are routed at all: a new request — the first turn, or a
 * follow-up on a finished thread. A reply to the agent's question, a
 * message steering a running task, a resumed or handed-back turn all
 * continue browser work already under way, and a reminder's turn is the
 * browser task its prompt was written as.
 */
function isRoutable(turn: TurnInput, scheduled: boolean): boolean {
  if (scheduled) return false;
  return turn.kind === "start" || (turn.kind === "message" && turn.after === "ended");
}

/** What the person attached, by kind, for the router: "image", "pdf", "text". */
function attachmentKinds(attachments: AgentAttachment[]): string[] {
  return attachments.map(({ mediaType }) => {
    if (mediaType.startsWith("image/")) return "image";
    if (mediaType === "application/pdf") return "pdf";
    if (mediaType.startsWith("text/")) return "text";
    return mediaType.split("/")[1] ?? mediaType;
  });
}

/**
 * The thread so far as the router reads it: the person's and the
 * assistant's words, without the turn being routed (already the last
 * message of the thread) and without the browser path's opening line.
 */
function recentExchanges(messages: RunSummary["messages"]): TurnRouteExchange[] {
  const spoken = messages.filter((message) => message.role !== "system" && message.content !== BROWSE_INTRO);
  const last = spoken.at(-1);
  const earlier = last?.role === "user" ? spoken.slice(0, -1) : spoken;
  return earlier.map((message) => ({ who: message.role === "user" ? "person" : "assistant", said: message.content }));
}

/** The non-browser abilities the answer path keeps, named for the router in plain words. */
function answerPathTools(input: Pick<AiAgentRunInput, "memory" | "reminders" | "bookmarks" | "userNotes" | "watchtower" | "integrations">): string[] {
  const tools: string[] = [];
  if (input.memory !== undefined) tools.push("recall and remember things about the person");
  if (input.reminders !== undefined) tools.push("set reminders");
  if (input.bookmarks !== undefined) tools.push("search and save the person's bookmarks");
  // Without this line the router sends "add milk to my shopping note" to the
  // browser, which has no note tools at all (docs/notes.md §6).
  if (input.userNotes !== undefined) tools.push("search, read and write the person's notes");
  if (input.watchtower !== undefined) tools.push("search the pages the person viewed before");
  for (const host of input.integrations?.hosts ?? []) {
    if (host.provider === "gmail") tools.push("read and send the person's Gmail");
    if (host.provider === "google_calendar") tools.push("read the person's Google Calendar");
  }
  return tools;
}

/**
 * The tab in view as the router sees it: a web page's title and host, or
 * nothing for the home page and the like. One shell page is an exception —
 * a note (docs/notes.md §6). Its text is the person's own writing and the
 * store holds it, so the turn can be about it without a browser: `note` is
 * the open note when the active tab is one, and then it is what is in view.
 */
function pageInView(
  tab: { kind: string; title: string; url: string } | null,
  note: Pick<Note, "title"> | null = null,
): { title: string; host: string } | null {
  if (tab === null || tab.kind !== "human") return null;
  if (note !== null) return { title: noteTitle(note), host: "notes" };
  try {
    const parsed = new URL(tab.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return { title: tab.title, host: parsed.host };
  } catch {
    return null;
  }
}

/** How long reading the page in view may take before the turn goes to the browser path instead. */
const PAGE_READ_TIMEOUT_MS = 10_000;

/**
 * The line a browse-path turn carries about the page in view
 * (docs/console-routing.md §5.1): which tab it is, and that the request is
 * about it unless it names another — or, when the person dismissed it in
 * the composer, that no open tab is the subject. Empty when there is no web
 * page in view, or the turn is not a new request.
 */
function pageContextLine(
  page: boolean,
  tab: { id: string; kind: string; title: string; url: string } | null,
  note: Pick<Note, "title"> | null = null,
): string {
  if (pageInView(tab, note) === null || tab === null) return "";
  if (!page) return "\n\n[The person removed the page in view from this message: do not assume the request is about any open tab.]";
  // A note is not a page the browser can read: the line says so, and the
  // address carries the id the note tools take (docs/notes.md §6).
  return note !== null
    ? `\n\n[${PAGE_ATTACHED_HEADER}: the person's own note “${noteTitle(note)}” — ${tab.url} (tab ${tab.id}). This is a note in Pistachio, not a web page: read and change it with the note tools, using the id in its address. Unless the request names another page or site, it is about this note.]`
    : `\n\n[${PAGE_ATTACHED_HEADER}: “${tab.title}” — ${tab.url} (tab ${tab.id}). Unless the request names another page or site, it is about this page.]`;
}

function freshContext(budget: ContextBudget): RunSummary["context"] {
  return { tokens: null, compactAt: budget.compactAt, window: budget.window, compactions: 0, steps: 0, totalSteps: 0, usage: { inputTokens: 0, outputTokens: 0 } };
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${String(Math.round(count / 1000))}k` : String(count);
}

/**
 * Owns the open collaborative browser conversation — the thread — and the
 * store of every earlier one. Unlike the original handoff controller, it
 * never creates or hydrates a second browser partition: tool calls act on
 * the person's existing tabs and authenticated sessions.
 *
 * A thread is two things kept together: the `RunSummary` the console
 * renders, and the model history (`ModelMessage[]`) the next turn continues
 * from. A turn is one call into the runner; a thread has as many as the
 * person wants — a finished task takes a follow-up, an interrupted one a
 * resume — and it survives restarts through the thread store.
 */
export class RunController {
  readonly #browser: BrowserController;
  readonly #tools: DesktopBrowserBackend;
  readonly #notifications: NotificationRouter;
  readonly #onChange: () => void;
  readonly #settings: () => DesktopSettings;
  readonly #memory: MemoryStore | null;
  readonly #reminders: ReminderStore | null;
  readonly #artifacts: ArtifactStore | null;
  readonly #watchtower: import("./watchtower/service.js").WatchtowerService | null;
  readonly #bookmarks: { store: BookmarkStore; service: BookmarkService } | null;
  /**
   * The person's notes (docs/notes.md §6). Set rather than constructed: the
   * note store is built after this controller in `index.ts`, so it arrives
   * through `setNoteStore` once it exists.
   */
  #notes: NoteRecordStore | null = null;
  readonly #integrations: { hostsFor(spaceId: string): Promise<IntegrationToolHost[]> } | null;
  readonly #onRunEnded: ((run: RunSummary) => void) | null;
  readonly #threads: ThreadStore | null;
  readonly #cloud: CloudRunCommands | null;
  readonly #model: (() => LanguageModel) | null;
  readonly #router: TurnRouter;
  readonly #summarize: ((prompt: string) => Promise<string>) | null;
  readonly #limits: Partial<TurnLimits>;
  readonly #budget: ContextBudget;
  readonly #spaceId: () => string;
  /** The account's web origin, or null when this Mac has no account to render on. */
  readonly #artifactWebUrl: () => string | null;
  #run: RunSummary | null = null;
  /** The open thread's model history: what the next turn continues from. */
  #history: ModelMessage[] = [];
  /** How many of a thread's messages the memory learner has already read. */
  readonly #learnedThrough = new Map<string, number>();
  /** A reopened thread's activity record when its chain could not be resumed. */
  #storedEvidence: EvidenceEntry[] = [];
  /** A reopened thread's signing key when its chain could not be resumed, kept for the record. */
  #storedSigningKey: string | null = null;
  /** The running turn is the one a reminder started — its answer is the reminder's output. */
  #scheduledTurn = false;
  /** The last turn as it was started, and the history it started from: what `retry` runs again. */
  #lastTurn: { input: TurnInput; base: ModelMessage[]; messagesBefore: number } | null = null;
  #persistTimer: NodeJS.Timeout | null = null;
  /** The running turn's usage so far, so the thread total adds only the delta. */
  #turnUsage = { inputTokens: 0, outputTokens: 0 };
  /** The scheduler waiting on a reminder-started run, until it ends. */
  #scheduledWaiter: { runId: string; resolve(outcome: ScheduledAgentOutcome): void } | null = null;
  #chain: EvidenceChain | null = null;
  #timers = new Set<NodeJS.Timeout>();
  #statusBeforeTakeover: TaskStatus | null = null;
  #aiAbort: AbortController | null = null;
  #aiGeneration = 0;
  #aiMode = false;
  #runSpaceId: string | null = null;

  constructor(options: {
    browser: BrowserController;
    notifications: NotificationRouter;
    onChange: () => void;
    settings?: () => DesktopSettings;
    memory?: MemoryStore | null;
    reminders?: ReminderStore | null;
    artifacts?: ArtifactStore | null;
    /** Local saved-page retrieval, scoped to this run's Space. */
    watchtower?: import("./watchtower/service.js").WatchtowerService | null;
    /** The bookmark store and the service that reads pages for it. */
    bookmarks?: { store: BookmarkStore; service: BookmarkService } | null;
    /**
     * The dedicated integrations the person connected (D29), as tool hosts
     * for a Space. Read per run, so a connection made in Settings applies
     * to the next turn; absent under E2E and before enrollment.
     */
    integrations?: { hostsFor(spaceId: string): Promise<IntegrationToolHost[]> } | null;
    /** Every terminal transition — the scheduler retries queued tasks on it. */
    onRunEnded?: (run: RunSummary) => void;
    /** Where threads persist. Absent in the demo and some tests: then a thread lives only in memory. */
    threads?: ThreadStore | null;
    /** Where a cloud run's commands go; absent before enrollment and under PISTACHIO_E2E. */
    cloud?: CloudRunCommands | null;
    /** The model to run turns on; the configured one when absent. Tests inject a mock. */
    model?: () => LanguageModel;
    /**
     * Decides whether a new request is a reply or browser work
     * (docs/console-routing.md); the account's intent model when absent,
     * which answers null — the browser path — until this Mac is enrolled.
     * Tests inject a scripted one.
     */
    router?: TurnRouter;
    /** Writes compaction summaries; the model itself when absent. */
    summarize?: (prompt: string) => Promise<string>;
    limits?: Partial<TurnLimits>;
    budget?: ContextBudget;
    /** The Space a new local conversation belongs to. */
    spaceId?: () => string;
    /**
     * Origin of the web app that privately renders and publicly shares
     * artifacts, or null while this Mac has no account. Read per call:
     * enrollment comes and goes while the controller lives.
     */
    artifactWebUrl?: () => string | null;
  }) {
    this.#settings = options.settings ?? (() => DEFAULT_SETTINGS);
    this.#threads = options.threads ?? null;
    this.#cloud = options.cloud ?? null;
    this.#model = options.model ?? null;
    this.#router = options.router ?? defaultTurnRouter;
    this.#summarize = options.summarize ?? null;
    this.#limits = options.limits ?? {};
    this.#budget = options.budget ?? contextBudget();
    this.#spaceId = options.spaceId ?? (() => "work");
    this.#artifactWebUrl = options.artifactWebUrl ?? (() => null);
    this.#memory = options.memory ?? null;
    this.#reminders = options.reminders ?? null;
    this.#artifacts = options.artifacts ?? null;
    this.#watchtower = options.watchtower ?? null;
    this.#bookmarks = options.bookmarks ?? null;
    this.#integrations = options.integrations ?? null;
    this.#onRunEnded = options.onRunEnded ?? null;
    this.#browser = options.browser;
    this.#tools = new DesktopBrowserBackend(options.browser);
    this.#notifications = options.notifications;
    this.#onChange = options.onChange;
  }

  /**
   * Give the agent the person's notes: the note tools on every turn from
   * here on, and a note open in the active tab as the page in view. Called
   * once from `index.ts` after the store is built.
   */
  setNoteStore(store: NoteRecordStore | null): void {
    this.#notes = store;
  }

  snapshot(): RunSummary | null {
    return this.#run === null ? null : structuredClone(this.#run);
  }

  /**
   * The live run, uncloned, for readers that only serialize or inspect it —
   * IPC serializes at send time, so publishing needs no defensive copy of a
   * conversation that grows for the length of a thread. Never mutate it.
   */
  peek(): Readonly<RunSummary> | null {
    return this.#run;
  }

  evidence(): EvidenceEntry[] {
    return this.#chain?.entries() ?? this.#storedEvidence;
  }

  /**
   * The console holds a conversation that is running or waiting on the
   * person. A thread the person paused is not busy: a scheduled task may
   * take the console, and the paused thread waits in the list.
   */
  busy(): boolean {
    if (this.#run === null || isCloudRun(this.#run)) return false;
    return !isTerminalStatus(this.#run.status) && this.#run.status !== "interrupted";
  }

  /** The agent is acting right now (or about to) — on this Mac; a cloud run never occupies its tabs. */
  #active(): boolean {
    if (this.#run === null || isCloudRun(this.#run)) return false;
    return ACTIVE_STATUSES.includes(this.#run.status) && this.#run.control === "agent";
  }

  /**
   * The artifact as the agent reports it. The web app renders an artifact out
   * of the signed-in account's sync session, so a Mac with no account links to
   * its own copy — which the pistachio protocol serves — instead of sending
   * the person to a page that cannot show their build.
   */
  #artifactView(artifact: Artifact): ArtifactToolView {
    const web = this.#artifactWebUrl();
    if (web === null || web === "") {
      return { ...artifactToolView(artifact), url: `pistachio://${ARTIFACT_HOST}/${artifact.id}` };
    }
    return artifactToolView(artifact, web);
  }

  /** The open thread is a cloud run: its commands go to control. */
  #cloudFor(run: RunSummary): CloudRunCommands | null {
    if (!isCloudRun(run)) return null;
    if (this.#cloud === null) throw new Error("this cloud run can only be steered once this Mac is signed in and enrolled");
    return this.#cloud;
  }

  /**
   * The cloud run observer folded more of a run's event stream (§10.4). When
   * that run is the open thread, the console follows it; otherwise the
   * thread store already has it and nothing changes here.
   */
  refreshRemote(run: RunSummary): void {
    if (this.#run?.runId !== run.runId) return;
    this.#run = structuredClone(run);
    this.#onChange();
  }

  /** A command from this desktop run's iMessage watcher, never from the model. */
  async answerIMessageQuestion(runId: string, questionId: string, value: string): Promise<void> {
    const run = this.#run;
    if (run === null || isCloudRun(run) || run.runId !== runId || run.pendingQuestion?.id !== questionId) return;
    await this.answerQuestion(questionId, value);
  }

  /** Every saved thread, newest first, with the open one reflecting its live state. */
  threads(): ThreadListItem[] {
    const saved = this.#threads?.list() ?? [];
    const open = this.#run;
    if (open === null) return saved;
    const live = threadListItem(open);
    return [live, ...saved.filter((item) => item.runId !== open.runId)];
  }

  /**
   * On launch: reopen the thread that was open when the app last quit. A
   * turn that was running then is marked interrupted — the model calls
   * did not survive the restart, but the history did, so a resume picks
   * up from the last finished step.
   */
  restore(): void {
    const latest = this.#threads?.latest() ?? null;
    if (latest === null) return;
    this.#adopt(latest);
    const run = this.#run;
    if (run === null) return;
    // A cloud run kept running without this Mac: its status is control's
    // truth, which the cloud run observer will fold in shortly (§10.4).
    if (!isCloudRun(run) && (ACTIVE_STATUSES.includes(run.status) || run.status === "waiting_for_approval" || run.status === "waiting_for_step_up")) {
      run.status = "interrupted";
      run.control = "human";
      run.pendingApproval = null;
      for (const tool of run.toolCalls) if (tool.status === "running") tool.status = "paused";
      for (const subagent of run.subagents) if (subagent.status === "working") subagent.status = "paused";
      this.#message("system", "Pistachio restarted while the agent was working. Press Resume or send a message to continue.");
      this.#activity("Restored after restart", "The thread was reopened from disk; the turn in progress was paused", "warning");
      this.#persistNow();
    }
    this.#onChange();
  }

  /** Open a saved thread in the console. The current one must not be acting. */
  openThread(runId: string): void {
    if (this.#run?.runId === runId) return;
    if (this.#active()) throw new Error("pause or end the current task before opening another conversation");
    const record = this.#threads?.get(runId) ?? null;
    if (record === null) throw new Error("that conversation is no longer available");
    this.#adopt(record);
    this.#onChange();
  }

  /** Clear the console for a fresh conversation. A task still acting is stopped first. */
  async newThread(): Promise<void> {
    const before = this.#run;
    if (this.#active()) await this.revoke();
    // Something else took the console while the stop was in flight.
    if (this.#run !== before) return;
    this.#setAside();
    this.#run = null;
    this.#runSpaceId = null;
    this.#history = [];
    this.#chain = null;
    this.#storedEvidence = [];
    this.#storedSigningKey = null;
    this.#onChange();
  }

  /** Forget a saved thread. The open one can go too, unless it is acting. */
  deleteThread(runId: string): void {
    const deleting = this.#run?.runId === runId ? this.#record() : this.#threads?.get(runId) ?? null;
    if (
      this.#run?.runId !== runId &&
      deleting !== null &&
      deleting.run.executor?.kind !== "cloud" &&
      deleting.run.pendingQuestion !== null
    ) {
      this.#cloud?.notifyIMessage?.(deleting, { kind: "resolved", questionId: deleting.run.pendingQuestion.id });
    }
    if (this.#run?.runId === runId) {
      if (this.#active()) throw new Error("end the task before deleting its conversation");
      this.#setAside();
      this.#run = null;
      this.#runSpaceId = null;
      this.#history = [];
      this.#chain = null;
      this.#storedEvidence = [];
    this.#storedSigningKey = null;
    }
    // A cloud run keeps streaming after the row is gone: without this its
    // next folded event re-saves the thread and the conversation returns.
    this.#cloud?.forget(runId);
    this.#threads?.remove(runId);
    this.#onChange();
  }

  /** Write the open thread now — the app is quitting. */
  flush(): void {
    this.#persistNow();
    this.#threads?.flushSync();
  }

  /**
   * The window is closing: stop acting, mark a running turn paused so the
   * next window restores it as such, and write everything. Equivalent to
   * what `restore()` would otherwise infer from a crash.
   */
  shutdown(): void {
    const run = this.#run;
    this.#abortAi();
    this.#clearTimers();
    if (run !== null && (ACTIVE_STATUSES.includes(run.status) || run.status === "waiting_for_approval")) {
      run.status = "interrupted";
      run.control = "human";
      run.pendingApproval = null;
      for (const tool of run.toolCalls) if (tool.status === "running") tool.status = "paused";
      for (const subagent of run.subagents) if (subagent.status === "working") subagent.status = "paused";
      this.#message("system", "The window closed while the agent was working. Press Resume or send a message to continue.");
      this.#activity("Paused with the window", "The turn in progress stopped; the thread was saved", "warning");
      this.#settleWaiter(run, "Paused when the window closed");
    }
    this.flush();
  }

  /**
   * The open thread is being set aside — replaced, closed, or deleted. It
   * is written first, and a reminder waiting on it hears that it will not
   * finish here, so the scheduler moves on.
   */
  #setAside(): void {
    const run = this.#run;
    if (run === null) return;
    this.#clearTimers();
    const pendingQuestionId = run.pendingQuestion?.id;
    if (pendingQuestionId !== undefined) {
      run.pendingQuestion = null;
      if (run.status === "waiting_for_judgment") {
        run.status = "interrupted";
        run.control = "human";
      }
      this.#chain?.append("question.cancelled", { questionId: pendingQuestionId, reason: "set aside" });
      this.#notifyIMessage({ kind: "resolved", questionId: pendingQuestionId });
    }
    // An approval is a decision about the page as it is now; it does not
    // survive being set aside. The thread comes back paused instead.
    if (run.pendingApproval !== null || run.status === "waiting_for_approval" || run.status === "waiting_for_step_up") {
      run.pendingApproval = null;
      run.status = "interrupted";
      run.control = "human";
      for (const tool of run.toolCalls) if (tool.status === "running") tool.status = "paused";
      this.#message("system", "The pending approval was cancelled when this conversation was set aside. Send a message to continue.");
      this.#activity("Approval cancelled", "The conversation was set aside before a decision", "warning");
      this.#chain?.append("approval.cancelled", { reason: "set aside" });
    }
    this.#persistNow();
    this.#settleWaiter(run, "Set aside before it finished");
  }

  /** A reminder's task ended without completing: resolve the scheduler's wait and free the console. */
  #settleWaiter(run: RunSummary, error: string): void {
    const waiter = this.#scheduledWaiter;
    if (waiter === null || waiter.runId !== run.runId) return;
    this.#scheduledWaiter = null;
    waiter.resolve({ status: "failed", error, runId: run.runId });
    this.#onRunEnded?.(run);
  }

  #adopt(record: ThreadRecord): void {
    this.#setAside();
    this.#abortAi();
    this.#run = record.run;
    this.#history = closeDanglingToolCalls(record.model, TURN_CUT_SHORT);
    this.#runSpaceId = record.spaceId ?? (isCloudRun(record.run) ? null : this.#spaceId());
    this.#learnedThrough.set(record.run.runId, record.learnedThrough ?? 0);
    this.#aiMode = this.#shouldUseAi();
    this.#statusBeforeTakeover = null;
    // The chain continues where it left off when its key came with the
    // record and the entries still verify; otherwise the record is kept as
    // read, and nothing further is signed into it.
    this.#chain = null;
    this.#storedEvidence = record.evidence ?? [];
    this.#storedSigningKey = record.signingKey ?? null;
    if (record.signingKey !== undefined) {
      try {
        this.#chain = new EvidenceChain(
          record.run.runId,
          { principal: "pistachio-browser-agent", sponsor: "local-user", task: record.run.taskId },
          EvidenceChain.importSigningKey(record.signingKey),
          record.evidence ?? [],
        );
        this.#chain.append("thread.reopened", { entries: record.evidence?.length ?? 0 });
        this.#storedEvidence = [];
    this.#storedSigningKey = null;
        this.#storedSigningKey = null;
      } catch {
        this.#chain = null;
      }
    }
  }

  #record(): ThreadRecord | null {
    if (this.#run === null) return null;
    const signingKey = this.#chain?.exportSigningKey() ?? this.#storedSigningKey;
    return {
      version: 1,
      ...(this.#runSpaceId === null ? {} : { spaceId: this.#runSpaceId }),
      run: this.#run,
      model: this.#history,
      evidence: this.#chain?.entries() ?? this.#storedEvidence,
      learnedThrough: this.#learnedThrough.get(this.#run.runId) ?? 0,
      ...(signingKey === null ? {} : { signingKey }),
    };
  }

  #notifyIMessage(
    event:
      | { kind: "question"; question: NonNullable<RunSummary["pendingQuestion"]> }
      | { kind: "completion"; text: string; completionId: string }
      | { kind: "resolved"; questionId?: string },
  ): void {
    const record = this.#record();
    if (record === null || record.run.executor?.kind === "cloud") return;
    this.#cloud?.notifyIMessage?.(record, event);
  }

  /** Save soon: each tool call is a change, and the store coalesces them. */
  #persist(): void {
    if (this.#persistTimer !== null) return;
    const timer = setTimeout(() => {
      this.#persistTimer = null;
      const record = this.#record();
      if (record !== null) {
        this.#threads?.save(record);
        this.#cloud?.mirrorDesktop?.(record);
      }
    }, 200);
    timer.unref();
    this.#persistTimer = timer;
  }

  /** Save now: a turn boundary, a switch, a quit. */
  #persistNow(): void {
    if (this.#persistTimer !== null) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
    }
    const record = this.#record();
    if (record !== null) {
      this.#threads?.saveNow(record);
      this.#cloud?.mirrorDesktop?.(record);
    }
  }

  #touch(): void {
    if (this.#run !== null) this.#run.updatedAt = new Date().toISOString();
  }

  /**
   * A reminder's agent task, as a conversation of its own in the console:
   * visible, interruptible, and steerable like any other. Resolves `busy`
   * at once when another conversation is live — the scheduler asks again
   * later — and otherwise when the run reaches a terminal state, however
   * it gets there (finished, failed, stopped by the person).
   */
  async startScheduled(request: ScheduledAgentRequest): Promise<ScheduledAgentOutcome> {
    if (this.busy()) return { status: "busy" };
    if (!this.#shouldUseAi()) return { status: "failed", error: "Scheduled agent tasks need the live model", runId: null };
    this.#clearTimers();
    this.#abortAi();
    this.#scheduledWaiter?.resolve({ status: "failed", error: "Replaced by a newer scheduled task", runId: null });
    this.#scheduledWaiter = null;
    let tabId = this.#humanTabId();
    if (tabId === null) tabId = await this.#browser.createTab();
    const tab = this.#browser.tab(tabId);
    const taskId = randomUUID();
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const purpose = request.prompt.trim() || request.title;
    this.#chain = new EvidenceChain(runId, {
      principal: "pistachio-browser-agent",
      sponsor: "local-user",
      task: taskId,
    });
    this.#setAside();
    this.#runSpaceId = this.#spaceId();
    this.#history = [];
    this.#storedEvidence = [];
    this.#storedSigningKey = null;
    this.#run = {
      runId,
      taskId,
      status: "ready",
      purpose,
      title: titleFor(request.title),
      updatedAt: startedAt,
      turns: 1,
      notes: "",
      context: freshContext(this.#budget),
      humanTabId: tabId,
      agentTabId: null,
      startedAt,
      completedAt: null,
      control: "agent",
      origin: {
        kind: "reminder",
        reminderId: request.reminderId,
        occurrenceId: request.occurrenceId,
        title: request.title,
        scheduledFor: request.scheduledFor,
      },
      pendingApproval: null,
      pendingQuestion: null,
      pendingTakeover: null,
      messages: [{ id: randomUUID(), at: startedAt, role: "user", content: purpose, turn: 1 }],
      toolCalls: [],
      subagents: [],
      activity: [
        {
          id: randomUUID(),
          at: startedAt,
          label: "Scheduled task started",
          detail: `“${request.title}” came due; running it in your browser session`,
          tone: "safe",
        },
      ],
      result: null,
      executor: { kind: "desktop" },
    };
    this.#chain.append("interaction.started", {
      tabId,
      url: tab?.url ?? "",
      purpose,
      sessionMode: "user-session",
      forkCreated: false,
      origin: "reminder",
      reminderId: request.reminderId,
      occurrenceId: request.occurrenceId,
      scheduledFor: request.scheduledFor,
    });
    this.#aiMode = true;
    const outcome = new Promise<ScheduledAgentOutcome>((resolve) => {
      this.#scheduledWaiter = { runId, resolve };
    });
    request.onStarted(runId);
    this.#onChange();
    // A reminder runs on its own prompt, whatever tab happens to be in view.
    await this.#beginAiExecution(runId, { kind: "start", text: purpose, attachments: [], page: false });
    return outcome;
  }

  async start(intent: string, attachments: AgentAttachment[] = [], options: { page: boolean } = { page: true }): Promise<void> {
    // A fresh intent over an open cloud run starts a conversation of its own here.
    if (this.#run !== null && !isCloudRun(this.#run) && (!isTerminalStatus(this.#run.status) || this.#shouldUseAi())) {
      await this.message(intent, attachments, options);
      return;
    }
    this.#startFresh(intent, attachments);
    await this.#launch(options.page);
  }

  /** A new thread from the composer. Any open thread is saved and set aside. */
  #startFresh(intent: string, attachments: AgentAttachment[]): void {
    this.#abortAi();
    this.#setAside();
    this.#storedEvidence = [];
    this.#storedSigningKey = null;
    const activeTab = this.#browser.activeTab();
    if (activeTab === null || activeTab.kind !== "human") {
      throw new Error("select a browser tab before starting a conversation");
    }
    const purpose = intent.trim() || "Help me with the page in front of me";
    const taskId = randomUUID();
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    this.#runSpaceId = this.#spaceId();
    this.#chain = new EvidenceChain(runId, {
      principal: "pistachio-browser-agent",
      sponsor: "local-user",
      task: taskId,
    });
    this.#history = [];
    this.#run = {
      runId,
      taskId,
      status: "ready",
      purpose,
      title: titleFor(purpose),
      updatedAt: startedAt,
      turns: 1,
      notes: "",
      context: freshContext(this.#budget),
      humanTabId: activeTab.id,
      // Retained for protocol compatibility; direct-control runs do not own
      // a separate agent tab.
      agentTabId: null,
      startedAt,
      completedAt: null,
      control: "agent",
      pendingApproval: null,
      pendingQuestion: null,
      pendingTakeover: null,
      messages: [
        {
          id: randomUUID(),
          at: startedAt,
          role: "user",
          content: purpose,
          turn: 1,
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      ],
      toolCalls: [],
      subagents: [],
      activity: [
        {
          id: randomUUID(),
          at: startedAt,
          label: "Conversation started",
          detail: `Connected to ${activeTab.title} in your existing browser session`,
          tone: "safe",
        },
      ],
      result: null,
      executor: { kind: "desktop" },
    };
    this.#chain.append("interaction.started", {
      tabId: activeTab.id,
      url: activeTab.url,
      purpose,
      sessionMode: "user-session",
      forkCreated: false,
    });

    this.#aiMode = this.#shouldUseAi();
  }

  /** The first turn of a fresh thread, in whichever mode applies. `page`: whether the page in view is attached. */
  async #launch(page = true): Promise<void> {
    const run = this.#requireRun();
    const runId = run.runId;
    const purpose = run.purpose;
    const attachments = run.messages[0]?.attachments ?? [];
    if (!this.#aiMode && this.#needsTextClarification(purpose)) {
      run.status = "waiting_for_judgment";
      run.pendingQuestion = {
        id: randomUUID(),
        prompt: "What ZIP code should I use?",
        description: "Enter the ZIP code you want the agent to use for this task.",
        choices: [],
        input: { type: "text", placeholder: "ZIP code" },
      };
      this.#message("assistant", "I’m ready for the ZIP code whenever you are.");
      this.#persistNow();
      this.#notifyIMessage({ kind: "question", question: run.pendingQuestion });
      this.#onChange();
      return;
    }
    if (!this.#aiMode && this.#needsClarification(purpose)) {
      run.status = "waiting_for_judgment";
      run.pendingQuestion = {
        id: randomUUID(),
        prompt: "How should I help on this page?",
        description: "Choose a direction or tell me something more specific.",
        choices: [
          {
            value: "complete-current-work",
            label: "Complete the current work",
            description: "Inspect the page, make progress, and ask before the final action.",
          },
          {
            value: "inspect-and-report",
            label: "Inspect and report",
            description: "Read the current page and summarize what needs attention.",
          },
          {
            value: "organize-tabs",
            label: "Organize my tabs",
            description: "Review open tabs and help focus the workspace.",
          },
        ],
      };
      this.#message("assistant", "I can take it from here. One quick question so I act in the right direction.");
      this.#persistNow();
      this.#notifyIMessage({ kind: "question", question: run.pendingQuestion });
      this.#onChange();
      return;
    }

    this.#onChange();
    if (this.#aiMode) await this.#beginAiExecution(runId, { kind: "start", text: purpose, attachments, page });
    else await this.#beginDemoExecution(runId);
  }

  /**
   * A message into the console. With no thread open it starts one; into a
   * live thread it steers; into a finished thread it continues — the
   * follow-up after a completed task is the same conversation, with
   * everything the agent learned still in its context and notes.
   */
  async message(content: string, attachments: AgentAttachment[] = [], options: { page: boolean } = { page: true }): Promise<void> {
    const text = content.trim();
    // An attachment alone is a sendable turn — "what about this?" implied.
    if (text === "" && attachments.length === 0) return;
    const run = this.#run;
    if (run !== null && isCloudRun(run)) {
      // Control reopens an ended cloud run on an explicit sponsor message,
      // so the checkpoint and browser session stay with this conversation.
      await this.#cloudFor(run)?.message(run.runId, text, attachments);
      return;
    }
    // No thread, or the demo's scripted flow after it ended: start over.
    // The live agent continues a finished thread below.
    if (run === null || (isTerminalStatus(run.status) && !this.#shouldUseAi())) {
      this.#startFresh(text, attachments);
      await this.#launch(options.page);
      return;
    }
    const ended = isTerminalStatus(run.status);
    const after: Extract<TurnInput, { kind: "message" }>["after"] = ended
      ? "ended"
      : run.pendingQuestion !== null
        ? "question"
        : run.status === "interrupted" || run.status === "human_control"
          ? "paused"
          : "running";
    if (this.#aiMode) run.turns += 1;
    this.#message("user", text, attachments);
    this.#chain?.append("user.steered", {
      content: text,
      status: run.status,
      // The bytes stay out of the record; the record says what was attached.
      attachments: attachments.map(({ name, mediaType }) => ({ name, mediaType })),
    });

    if (this.#aiMode) {
      const pendingQuestionId = run.pendingQuestion?.id;
      run.pendingQuestion = null;
      run.pendingTakeover = null;
      run.pendingApproval = null;
      run.status = "running";
      run.control = "agent";
      run.completedAt = null;
      run.result = null;
      this.#abortAi();
      if (pendingQuestionId !== undefined) this.#notifyIMessage({ kind: "resolved", questionId: pendingQuestionId });
      this.#activity(
        after === "ended" ? "Conversation continued" : after === "running" ? "Steering received" : "Agent resumed",
        after === "ended" ? "Picking the thread back up with your follow-up" : "Continuing from the current browser state with your latest direction",
        "safe",
      );
      this.#onChange();
      await this.#beginAiExecution(run.runId, { kind: "message", text, attachments, after, page: options.page });
      return;
    }

    if (run.pendingQuestion !== null) {
      const questionId = run.pendingQuestion.id;
      await this.answerQuestion(questionId, text);
      return;
    }
    if (run.status === "interrupted" || run.status === "human_control") {
      run.status = "running";
      run.control = "agent";
      for (const tool of run.toolCalls) {
        if (tool.status === "paused") tool.status = "running";
      }
      for (const subagent of run.subagents) {
        if (subagent.status === "paused") subagent.status = "working";
      }
      this.#message("assistant", "Got it. I’m resuming from the page exactly as you left it and applying that direction.");
      this.#activity("Agent resumed", "Continued in the current tab with your latest instruction", "safe");
      this.#schedule(520, () => this.#requestApproval(run.runId));
    } else if (run.pendingApproval !== null) {
      this.#message("assistant", "I’ve added that to the plan. The current action is still paused for your approval.");
      this.#activity("Steering received", "Updated the plan while the approval checkpoint stays paused", "neutral");
    } else {
      this.#message("assistant", "Understood — I’m adjusting the current approach now.");
      this.#activity("Steering received", "The active plan was updated without opening another tab", "neutral");
    }
    this.#onChange();
  }

  async answerQuestion(questionId: string, answer: string): Promise<void> {
    const run = this.#requireRun();
    if (run.pendingQuestion?.id !== questionId) throw new Error("question is no longer pending");
    const cloud = this.#cloudFor(run);
    if (cloud !== null) {
      const choice = run.pendingQuestion.choices.find((item) => item.value === answer);
      await cloud.answer(run.runId, questionId, choice?.value ?? answer.trim());
      return;
    }
    const choice = run.pendingQuestion.choices.find((item) => item.value === answer);
    const response = choice?.label ?? answer.trim();
    if (this.#aiMode) run.turns += 1;
    if (run.messages.at(-1)?.role !== "user" || run.messages.at(-1)?.content !== response) {
      this.#message("user", response);
    }
    run.pendingQuestion = null;
    run.purpose = `${run.purpose} — ${response}`;
    this.#chain?.append("question.answered", { questionId, answer: response });
    this.#notifyIMessage({ kind: "resolved", questionId });
    if (this.#aiMode) {
      run.status = "running";
      run.control = "agent";
      this.#activity("Question answered", "Resuming with your selection in the same browser state", "safe");
      this.#onChange();
      await this.#beginAiExecution(run.runId, { kind: "answer", text: response });
      return;
    }
    this.#message("assistant", "Perfect. I’ll start with the current tab and keep every action visible here.");
    this.#onChange();
    await this.#beginDemoExecution(run.runId);
  }

  /**
   * Run the last turn again, as if its reply had never come: the summary
   * loses what the turn wrote — its messages, its tool calls — the history
   * goes back to where the turn began, and the same input goes through the
   * router once more. Only a settled local thread has a turn to retry; a
   * running one is steered, and a cloud run's turns are control's record.
   */
  async retry(): Promise<void> {
    const run = this.#run;
    const last = this.#lastTurn;
    if (run === null || last === null || isCloudRun(run) || !this.#aiMode) return;
    if (run.status !== "completed" && run.status !== "failed" && run.status !== "interrupted") return;
    this.#abortAi();
    run.messages = run.messages.slice(0, last.messagesBefore);
    run.toolCalls = run.toolCalls.filter((tool) => (tool.turn ?? 1) < Math.max(1, run.turns));
    const learned = this.#learnedThrough.get(run.runId);
    if (learned !== undefined && learned > run.messages.length) this.#learnedThrough.set(run.runId, run.messages.length);
    this.#history = last.base;
    run.status = "running";
    run.control = "agent";
    run.completedAt = null;
    run.result = null;
    run.pendingQuestion = null;
    run.pendingTakeover = null;
    run.pendingApproval = null;
    this.#activity("Retrying", "Running the last turn again from where it began", "neutral");
    this.#chain?.append("turn.retried", { turn: run.turns });
    this.#onChange();
    await this.#beginAiExecution(run.runId, last.input);
  }

  interrupt(): void {
    const run = this.#requireRun();
    if (isTerminalStatus(run.status) || run.status === "interrupted") return;
    const cloud = this.#cloudFor(run);
    if (cloud !== null) {
      void cloud.interrupt(run.runId).catch((error: unknown) => console.error("[cloud] interrupt failed", error));
      return;
    }
    this.#clearTimers();
    this.#abortAi();
    const pendingQuestionId = run.pendingQuestion?.id;
    run.pendingQuestion = null;
    this.#statusBeforeTakeover = run.status;
    run.status = "interrupted";
    run.control = "human";
    for (const tool of run.toolCalls) {
      if (tool.status === "running") tool.status = "paused";
    }
    for (const subagent of run.subagents) {
      if (subagent.status === "working") subagent.status = "paused";
    }
    this.#message("system", "You interrupted the agent. The page is yours; send a message to steer and resume.");
    this.#activity("Agent interrupted", "All in-flight work paused at the current browser state", "warning");
    this.#chain?.append("control.interrupted", { actor: "local-user" });
    if (pendingQuestionId !== undefined) this.#notifyIMessage({ kind: "resolved", questionId: pendingQuestionId });
    this.#settleWaiter(run, "Interrupted by the person");
    this.#persistNow();
    this.#onChange();
  }

  async approve(approvalId: string): Promise<void> {
    const run = this.#requireRun();
    if (isCloudRun(run)) throw new Error("a cloud run pauses through its own questions; approvals are not bound on the cloud path");
    if (run.status !== "waiting_for_approval" || run.pendingApproval?.id !== approvalId) {
      throw new Error("approval is no longer pending");
    }
    const approval = run.pendingApproval;
    run.pendingApproval = null;
    run.status = "running";
    this.#message("system", `You approved “${approval.evidence.action}” once.`);
    this.#chain?.append("approval.decided", {
      approvalId,
      decision: "approved",
      approver: "local-user",
    });
    const tool = this.#startTool("page.submit", "Submit reconciliation", "Clicking the final submit control", run.humanTabId);
    this.#activity("Approval granted", "The requested action may run once", "safe");
    this.#onChange();
    try {
      const tabId = run.humanTabId;
      if (tabId === null) throw new Error("the conversation has no browser tab to submit in");
      const submission = await this.#browser.submitAgentAction(tabId);
      if (submission !== "completed") throw new Error(`submission was ${submission}`);
      this.#completeTool(tool.id, "Submitted in your current authenticated tab");
      this.#chain?.append("browser.action", {
        tool: "page.submit",
        tabId: run.humanTabId,
        result: "completed",
      });
      this.#schedule(420, () => this.#complete(run.runId));
    } catch (error: unknown) {
      this.#failTool(tool.id, error);
      await this.#failRun(run.runId, error);
    }
  }

  async reject(approvalId: string): Promise<void> {
    const run = this.#requireRun();
    if (isCloudRun(run)) throw new Error("a cloud run pauses through its own questions; approvals are not bound on the cloud path");
    if (run.pendingApproval?.id !== approvalId) throw new Error("approval is no longer pending");
    this.#chain?.append("approval.decided", {
      approvalId,
      decision: "rejected",
      approver: "local-user",
    });
    run.pendingApproval = null;
    run.status = "rejected";
    run.completedAt = new Date().toISOString();
    this.#message("assistant", "Understood. I left the draft in place and did not submit anything.");
    this.#activity("Action declined", "No remote state was changed", "blocked");
    this.#endInteraction("rejected");
  }

  takeControl(): void {
    const run = this.#requireRun();
    if (isTerminalStatus(run.status)) return;
    const cloud = this.#cloudFor(run);
    if (cloud !== null) {
      // Control's interrupt IS the takeover on a cloud run (§7.3: running → human_control).
      void cloud.interrupt(run.runId).catch((error: unknown) => console.error("[cloud] take control failed", error));
      return;
    }
    this.#clearTimers();
    this.#abortAi();
    this.#statusBeforeTakeover = run.status;
    run.status = "human_control";
    run.control = "human";
    this.#message("system", "You took control of the page. The agent is watching and will not interact.");
    this.#activity("You took control", "Agent input paused immediately", "warning");
    this.#chain?.append("control.transferred", { from: "agent", to: "human" });
    this.#settleWaiter(run, "The person took control");
    this.#persistNow();
    this.#onChange();
  }

  async releaseControl(): Promise<void> {
    const run = this.#requireRun();
    // `waiting_for_step_up` is a cloud-only pause: the local takeover path
    // folds straight to `human_control` (see `takeoverRequested`).
    if (run.status !== "human_control" && run.status !== "interrupted" && run.status !== "waiting_for_step_up") return;
    const cloud = this.#cloudFor(run);
    if (cloud !== null) {
      // Control releases a run only from `human_control`
      // (app.ts sponsorRoute("release")). A cloud takeover request parks at
      // `waiting_for_step_up` and a stopped cloud run at `interrupted`; for
      // both, taking control is the documented exit — the runtime's
      // takeControl accepts running/interrupted/waiting_for_step_up and
      // clears the pause — and only then does release hand the wheel back.
      if (run.status !== "human_control") await cloud.interrupt(run.runId);
      await cloud.release(run.runId);
      return;
    }
    if (run.status === "waiting_for_step_up") return;
    if (this.#aiMode) {
      const kind: TurnInput["kind"] = run.pendingTakeover !== null ? "takeover-done" : "resume";
      run.pendingTakeover = null;
      run.status = "running";
      run.control = "agent";
      run.turns += 1;
      this.#message("system", kind === "takeover-done" ? "Control returned to the agent in the same tab." : "Resumed.");
      this.#activity("Control returned", "Inspecting the page state you left behind", "safe");
      this.#chain?.append("control.transferred", { from: "human", to: "agent" });
      this.#onChange();
      await this.#beginAiExecution(run.runId, { kind });
      return;
    }
    run.status = this.#statusBeforeTakeover ?? (run.pendingApproval === null ? "running" : "waiting_for_approval");
    run.control = "agent";
    this.#message("system", "Control returned to the agent in the same tab.");
    this.#activity("Control returned", "Resumed from your updated browser state", "safe");
    this.#chain?.append("control.transferred", { from: "human", to: "agent" });
    this.#statusBeforeTakeover = null;
    if (run.status === "running" && run.pendingApproval === null) {
      this.#schedule(520, () => this.#requestApproval(run.runId));
    }
    this.#onChange();
  }

  async revoke(): Promise<void> {
    const run = this.#requireRun();
    if (isTerminalStatus(run.status)) return;
    const cloud = this.#cloudFor(run);
    if (cloud !== null) {
      await cloud.revoke(run.runId);
      return;
    }
    run.pendingApproval = null;
    const pendingQuestionId = run.pendingQuestion?.id;
    run.pendingQuestion = null;
    run.pendingTakeover = null;
    this.#abortAi();
    run.status = "revoked";
    run.completedAt = new Date().toISOString();
    this.#message("assistant", "Stopped. I won’t take any more actions in your browser.");
    this.#activity("Agent stopped", "Browser control returned to you", "blocked");
    this.#chain?.append("run.revoked", { actor: "local-user", sessionPreserved: true });
    this.#endInteraction("stopped");
    if (pendingQuestionId !== undefined) this.#notifyIMessage({ kind: "resolved", questionId: pendingQuestionId });
  }

  async #beginAiExecution(runId: string, turn: TurnInput): Promise<void> {
    const run = this.#run;
    if (run?.runId !== runId || isTerminalStatus(run.status)) return;
    this.#abortAi();
    const abort = new AbortController();
    const generation = ++this.#aiGeneration;
    this.#aiAbort = abort;
    run.status = "running";
    run.control = "agent";
    run.pendingApproval = null;
    const pendingQuestionId = run.pendingQuestion?.id;
    run.pendingQuestion = null;
    run.pendingTakeover = null;
    if (pendingQuestionId !== undefined) this.#notifyIMessage({ kind: "resolved", questionId: pendingQuestionId });
    run.context.steps = 0;
    this.#turnUsage = { inputTokens: 0, outputTokens: 0 };
    // Only the turn the reminder started is the reminder's: a follow-up on
    // that thread is the person's conversation like any other.
    this.#scheduledTurn = run.origin?.kind === "reminder" && turn.kind === "start";
    // The summary's messages up to and including this turn's user message,
    // and the history before it: a retry cuts back to exactly here.
    this.#lastTurn = { input: turn, base: this.#history, messagesBefore: run.messages.length };
    this.#persistNow();
    this.#onChange();

    // A callback from a turn that has since been replaced touches nothing.
    const current = (): boolean => generation === this.#aiGeneration && this.#run?.runId === runId;

    try {
      // Read at run time, not at construction: an edit in Settings applies
      // to the next run without restarting anything. Read once for the turn:
      // the browser path that follows a hand-off works from the same inputs.
      const extras = {
        ...(await this.#memoryInput(run)),
        ...this.#reminderInput(run),
        ...this.#artifactInput(run),
        ...this.#bookmarkInput(run),
        ...this.#noteInput(run),
        ...this.#watchtowerInput(),
        ...(await this.#integrationInput()),
      };
      if (!current() || abort.signal.aborted) return;

      // Which path: the router's call for a new request, the browser's for
      // everything else. Recorded before a model step is spent, so the
      // trace says why a turn went the way it did.
      const attachments = turn.kind === "start" || turn.kind === "message" ? turn.attachments : [];
      const decision = await this.#route(run, turn, attachments, extras, abort.signal);
      if (!current() || abort.signal.aborted) return;
      this.#chain?.append("turn.routed", {
        route: decision.route,
        basis: decision.basis,
        ...(decision.evaluation === null
          ? {}
          : { answer: decision.evaluation.routes.answer, page: decision.evaluation.routes.page, confidence: decision.evaluation.confidence, latencyMs: decision.evaluation.latencyMs }),
      });
      // The page in view is attached to a new request unless the person
      // dismissed it in the composer (§5.1). On a quick path it is read
      // here, once — not as a tool step, since nothing is done to the page
      // — and carried in the turn, whether the router saw a question about
      // it or not: attached means in context. When the read fails, a
      // question about the page goes to the browser path, which reads it;
      // any other reply goes ahead without it.
      const newRequest = isRoutable(turn, this.#scheduledTurn);
      const pageAttached = newRequest && (turn.kind === "start" || turn.kind === "message") && turn.page;
      let page: { title: string; url: string; text: string } | null = null;
      if (decision.route !== "browse" && pageAttached) page = await this.#readPageInView(abort.signal);
      if (!current() || abort.signal.aborted) return;
      let mode: AgentTurnMode = decision.route === "browse" || (decision.route === "page" && page === null) ? "browse" : "answer";
      // The browser path is told which tab the person has in view and
      // whether it is the subject — it reads pages itself, so a line, not
      // the text. Fixed for the turn: a hand-off carries the same line.
      const pointer = newRequest && (turn.kind === "start" || turn.kind === "message") ? pageContextLine(turn.page, this.#browser.activeTab(), this.#noteInView()) : "";
      if (mode === "browse" && run.messages.filter((message) => message.role === "assistant").length === 0) {
        this.#message("assistant", BROWSE_INTRO);
      }
      const fromPage = decision.route === "page" ? page : null;
      this.#activity(
        fromPage !== null ? "Answering from the page" : mode === "answer" ? "Answering directly" : turn.kind === "start" ? "Agent started" : "Agent continuing",
        fromPage !== null
          ? `Read “${fromPage.title}” without taking any browser action`
          : mode === "answer"
            ? page !== null
              ? `Replying with “${page.title}” in context; the browser is not needed for this`
              : "Replying from the conversation; the browser is not needed for this"
            : turn.kind === "start" ? "Connected the model to your live browser tabs" : "Continuing from the thread's history and notes",
        "safe",
      );
      // The turn as the model reads it: the person's words, plus the one
      // line of situation they imply, plus the page in view when it was
      // read for this turn, plus their attachments as file parts. `base` is
      // the thread before this turn — what a hand-off restarts from, with
      // no page carried: the browser path reads pages itself.
      const base = this.#history;
      const pageBlock = page !== null ? `\n\n${pageInViewBlock(page)}` : mode === "browse" ? pointer : "";
      this.#history = [...base, userMessage(`${turnText(turn, run.origin, mode)}${pageBlock}`, attachments)];
      this.#persistNow();
      this.#onChange();

      const notes: NotesToolHost = {
        read: () => this.#run?.notes ?? "",
        write: (content) => {
          const live = this.#requireRun();
          const trimmed = content.trim();
          live.notes = trimmed.length > MAX_TASK_NOTES ? trimmed.slice(0, MAX_TASK_NOTES) : trimmed;
          this.#touch();
          return live.notes;
        },
      };

      const runTurn = (turnMode: AgentTurnMode) => runAiBrowserAgent({
        mode: turnMode,
        messages: this.#history,
        browser: this.#tools,
        abortSignal: abort.signal,
        notes,
        budget: this.#budget,
        limits: this.#limits,
        model: this.#model === null ? (turnMode === "answer" ? configuredAnswerModel() : configuredModel()) : this.#model(),
        modelName: turnMode === "answer" ? answerModelName() : modelName(),
        ...(this.#summarize === null ? {} : { summarize: this.#summarize }),
        ...extras,
        timezone: this.timezone(),
        ...(this.#scheduledTurn && run.origin?.kind === "reminder" ? { scheduled: { title: run.origin.title, scheduledFor: run.origin.scheduledFor } } : {}),
        callbacks: {
          toolStarted: (request, label, detail) => {
            const tabId = "tabId" in request ? request.tabId : null;
            const call = this.#startTool(request.name, label, detail, tabId);
            this.#chain?.append(`${toolFamily(request.name)}.tool.started`, {
              tool: request.name,
              tabId,
            });
            return call.id;
          },
          toolCompleted: (toolId, toolResult) => {
            this.#completeTool(toolId, toolResult.summary);
            const toolCall = this.#requireRun().toolCalls.find((item) => item.id === toolId);
            // A tab.open names no tab when it starts — the tab does not exist
            // yet — and the browser makes the new tab active as it opens. Its
            // id is in the result, so the call records it: the agent's light
            // (@pistachio/shell-contracts/agent-glow `agentDrivenTabId`) moves to the tab the
            // person is now looking at, rather than staying on the old one
            // through the model's next think.
            if (toolCall !== undefined && toolCall.tabId === null) {
              const opened = openedTabId(toolResult.data);
              if (opened !== null) toolCall.tabId = opened;
            }
            // What the call left to open — the note it wrote, the page it
            // built — rides on the record, so the console can offer it
            // under the reply as a card rather than as a line in the trace.
            const output = toolCall === undefined ? null : toolOutputOf(toolCall.name, toolResult.data);
            if (toolCall !== undefined && output !== null) toolCall.output = output;
            this.#chain?.append(`${toolFamily(toolCall?.name ?? "")}.action`, {
              tool: toolCall?.name ?? "unknown",
              tabId: toolCall?.tabId ?? null,
              result: "completed",
              summary: toolResult.summary,
            });
          },
          toolFailed: (toolId, error) => {
            this.#failTool(toolId, error);
            const toolCall = this.#requireRun().toolCalls.find((item) => item.id === toolId);
            this.#chain?.append(`${toolFamily(toolCall?.name ?? "")}.action`, {
              tool: toolCall?.name ?? "unknown",
              tabId: toolCall?.tabId ?? null,
              result: "failed",
              message: error instanceof Error ? error.message : String(error),
            });
          },
          questionAsked: (question) => {
            const live = this.#requireRun();
            live.pendingQuestion = question;
            live.status = "waiting_for_judgment";
            live.control = "human";
            this.#message("assistant", question.prompt);
            this.#activity("Your input is needed", question.description, "warning");
            this.#chain?.append("question.asked", { questionId: question.id, prompt: question.prompt });
            this.#persistNow();
            this.#notifyIMessage({ kind: "question", question });
          },
          takeoverRequested: (takeover) => {
            const live = this.#requireRun();
            this.#statusBeforeTakeover = "running";
            live.pendingTakeover = takeover;
            live.status = "human_control";
            live.control = "human";
            this.#message("assistant", takeover.reason);
            this.#activity("Takeover requested", takeover.instructions, "warning");
            this.#chain?.append("control.requested", { takeoverId: takeover.id, reason: takeover.reason });
            this.#persistNow();
          },
          historyChanged: (messages) => {
            if (!current()) return;
            this.#history = messages;
            this.#touch();
            this.#persist();
          },
          stepFinished: ({ usage, contextTokens }) => {
            if (!current()) return;
            const live = this.#requireRun();
            live.context.steps += 1;
            live.context.totalSteps += 1;
            if (contextTokens !== null) live.context.tokens = contextTokens;
            live.context.usage = {
              inputTokens: live.context.usage.inputTokens + usage.inputTokens - this.#turnUsage.inputTokens,
              outputTokens: live.context.usage.outputTokens + usage.outputTokens - this.#turnUsage.outputTokens,
            };
            this.#turnUsage = usage;
            this.#touch();
            this.#onChange();
          },
          compacted: ({ before, after, summary }) => {
            if (!current()) return;
            const live = this.#requireRun();
            live.context.compactions += 1;
            live.context.tokens = after;
            this.#message("system", `Context compacted: earlier steps were folded into a summary (about ${formatTokens(before)} → ${formatTokens(after)} tokens). Notes and recent steps are kept in full.`);
            this.#activity("Context compacted", summary.length > 200 ? `${summary.slice(0, 197)}…` : summary, "neutral");
            this.#chain?.append("context.compacted", { before, after });
            this.#persist();
            this.#onChange();
          },
          changed: this.#onChange,
        },
      });
      let result = await runTurn(mode);
      const live = (): boolean =>
        generation === this.#aiGeneration &&
        this.#run?.runId === runId &&
        !abort.signal.aborted &&
        this.#run.status === "running";
      if (!live()) return;
      if (result.outcome === "handoff" && mode === "answer") {
        // The reply found it needs a page. The thread restarts from where
        // this turn began, with the words now handed over as a task; the
        // attempt's steps stay counted, its messages do not stay in the
        // history — the browser path reads the request fresh.
        mode = "browse";
        this.#activity("Switching to the browser", result.text || "This needs a live page", "neutral");
        this.#chain?.append("turn.handoff", { reason: result.text });
        if (run.messages.filter((message) => message.role === "assistant").length === 0) this.#message("assistant", BROWSE_INTRO);
        this.#history = [...base, userMessage(`${turnText(turn, run.origin, mode)}${pointer}`, attachments)];
        // The rerun's usage counts from zero; the thread total keeps the attempt's.
        this.#turnUsage = { inputTokens: 0, outputTokens: 0 };
        this.#persistNow();
        this.#onChange();
        result = await runTurn(mode);
        if (!live()) return;
      }
      this.#aiAbort = null;
      this.#history = result.messages;
      this.#turnUsage = { inputTokens: 0, outputTokens: 0 };
      switch (result.outcome) {
        case "handoff":
          // Only the answer path hands off, and it was rerun above; a
          // browse turn ending this way is a stop without an answer.
          this.#pauseTurn(runId, "I stopped without a final answer. Press Resume or send a message to continue.", "Turn ended without an answer");
          break;
        case "paused":
          // The question or takeover callbacks already moved the run; a
          // "running" status here means one fired without a pause — not
          // expected, but not a completion either.
          this.#pauseTurn(runId, "I stopped to ask you something but the request did not register. Send a message to continue.", "Turn paused");
          break;
        case "budget":
          this.#pauseTurn(
            runId,
            `I’ve taken ${String(result.steps)} steps this turn and the task is not finished yet. Press Resume or send a message to keep going, or end the task.`,
            "Turn checkpoint reached",
          );
          break;
        case "final":
          if (result.text === "") {
            this.#pauseTurn(runId, "I stopped without a final answer. Press Resume or send a message to continue.", "Turn ended without an answer");
            break;
          }
          await this.#completeAiRun(runId, result.text, result.model);
          break;
      }
    } catch (error: unknown) {
      if (abort.signal.aborted || generation !== this.#aiGeneration) return;
      this.#aiAbort = null;
      this.#turnUsage = { inputTokens: 0, outputTokens: 0 };
      await this.#failRun(runId, error);
    }
  }

  /**
   * Which path this turn takes. Three cheap refusals before anything is
   * spent — not a new request, the router turned off, no model — and then
   * one bounded call to the router; every failure is the browser path.
   */
  async #route(
    run: RunSummary,
    turn: TurnInput,
    attachments: AgentAttachment[],
    extras: Pick<AiAgentRunInput, "memory" | "reminders" | "bookmarks" | "userNotes" | "watchtower" | "integrations">,
    abortSignal: AbortSignal,
  ): Promise<TurnRouteDecision> {
    if (!isRoutable(turn, this.#scheduledTurn) || !turnRouterEnabled()) {
      return { route: "browse", basis: "skipped", evaluation: null };
    }
    const text = turn.kind === "start" || turn.kind === "message" ? turn.text : "";
    // A page the person dismissed in the composer is not offered: the turn
    // is judged as if it were sent from the home page.
    const attached = (turn.kind === "start" || turn.kind === "message") && turn.page;
    const request: TurnRouteRequest = {
      message: text,
      attachments: attachmentKinds(attachments),
      conversation: recentExchanges(run.messages),
      browserUsed: run.toolCalls.some((call) => toolFamily(call.name) === "browser"),
      currentPage: attached ? pageInView(this.#browser.activeTab(), this.#noteInView()) : null,
      tools: answerPathTools(extras),
    };
    let evaluation: TurnRouteEvaluation | null = null;
    try {
      evaluation = await this.#router(request, abortSignal);
    } catch {
      evaluation = null;
    }
    return decideTurnRoute(evaluation);
  }

  /**
   * The page in view, read once for a `page`-routed turn. Null when there
   * is no web page in view or the read fails or takes too long — then the
   * browser path, which reads pages as tool steps, takes the turn.
   */
  async #readPageInView(abortSignal: AbortSignal): Promise<{ title: string; url: string; text: string } | null> {
    const tab = this.#browser.activeTab();
    const note = this.#noteInView();
    if (pageInView(tab, note) === null || tab === null) return null;
    // A note is already here: its markdown is the page, no inspection and no
    // web page involved. An empty note still counts — the model is told the
    // address, which is how it edits the note the person is looking at.
    if (note !== null) {
      this.#chain?.append("page.read", { tabId: tab.id, url: tab.url, chars: note.markdown.length });
      return { title: noteTitle(note), url: tab.url, text: note.markdown };
    }
    try {
      const inspection = await withDeadline(this.#tools.inspect(tab.id), PAGE_READ_TIMEOUT_MS, "Read the current page", { signal: abortSignal });
      if (inspection.text.trim() === "") return null;
      this.#chain?.append("page.read", { tabId: tab.id, url: inspection.url, chars: inspection.text.length });
      return { title: inspection.title, url: inspection.url, text: inspection.text };
    } catch {
      return null;
    }
  }

  /**
   * The turn stopped short of an answer — its step allowance ran out, or
   * the model fell silent — and the person decides what happens next. The
   * thread stays whole: a resume or a message continues it with every
   * step and note intact. This is never presented as completion.
   */
  #pauseTurn(runId: string, message: string, label: string): void {
    const run = this.#run;
    if (run?.runId !== runId || run.status !== "running") return;
    run.status = "interrupted";
    run.control = "human";
    for (const tool of run.toolCalls) if (tool.status === "running") tool.status = "paused";
    this.#message("assistant", message);
    this.#activity(label, "Waiting for you before taking more steps", "warning");
    this.#chain?.append("turn.paused", { reason: label, steps: run.context.steps });
    this.#settleWaiter(run, `${label} after ${String(run.context.steps)} steps; the thread is open in the console`);
    this.#persistNow();
    this.#onChange();
  }

  async #completeAiRun(runId: string, response: string, model: string): Promise<void> {
    const run = this.#run;
    if (run?.runId !== runId || run.status !== "running") return;
    const answer = this.#plainModelText(response) || "I finished the browser task and verified the current page state.";
    run.status = "completed";
    run.control = "human";
    run.completedAt = new Date().toISOString();
    this.#message("assistant", answer);
    this.#activity("Task complete", `Finished with ${model}`, "safe");
    this.#chain?.append("run.completed", {
      model,
      toolCalls: run.toolCalls.length,
      sessionMode: "user-session",
    });
    this.#chain?.append("authority.ended", {
      reason: "completed",
      browserSessionPreserved: true,
      separateSessionCreated: false,
    });
    run.result = {
      summary: answer.length > 240 ? `${answer.slice(0, 237)}…` : answer,
      changes: run.toolCalls
        .filter((tool) => tool.status === "completed")
        .slice(-5)
        .map((tool) => tool.detail),
      capsuleRevoked: false,
      evidenceEntries: this.#chain?.entries().length ?? 0,
      rootHash: this.#chain?.rootHash() ?? "",
    };
    this.#persistNow();
    this.#onChange();
    // A reminder's run is announced by the reminder, under its own title,
    // once the scheduler has recorded the outcome — not twice.
    if (!this.#scheduledTurn) {
      await this.#notifications.deliver({
        id: `completed:${runId}`,
        userId: "local-user",
        runId,
        kind: "completion",
        title: run.toolCalls.some((tool) => toolFamily(tool.name) === "browser") ? "Browser task completed" : "Task completed",
        body: run.result.summary,
        actionUrl: `pistachio://runs/${runId}`,
        capabilityCeiling: [],
      });
    }
    this.#ended(run);
    this.#notifyIMessage({ kind: "completion", text: answer, completionId: run.completedAt ?? String(run.turns) });
    void this.#learn(run);
  }

  /**
   * The reminder tools for this run, and the zone the person keeps time
   * in: the profile's if they set one, this Mac's otherwise. Nothing when
   * reminders are off — the tools go too.
   */
  #reminderInput(run: RunSummary): Pick<AiAgentRunInput, "reminders"> {
    const store = this.#reminders;
    if (store === null || !this.#settings().reminders.enabled) return {};
    const source: ReminderSource = { kind: "agent", runId: run.runId };
    const host: ReminderToolHost = {
      list: () => store.all().filter((reminder) => reminder.status === "active" || reminder.status === "paused").map(reminderToolView),
      create: (input) => reminderToolView(store.add({ ...input, timezone: input.timezone ?? this.timezone() }, source)),
      update: (id, patch) => reminderToolView(store.update(id, patch, source)),
      cancel: (id) => reminderToolView(store.cancel(id, source)),
    };
    return { reminders: { host, timezone: this.timezone() } };
  }

  /**
   * The artifact tools for this run. The agent commissions; the builder —
   * a specialist model with no tools of its own — writes the page while
   * the console shows it as a subagent at work; the store keeps it. The
   * HTML never enters the agent's context in either direction.
   */
  #artifactInput(run: RunSummary): Pick<AiAgentRunInput, "artifacts"> {
    const store = this.#artifacts;
    if (store === null) return {};
    const source: ArtifactSource = { kind: "agent", runId: run.runId };
    const build = async (task: string, request: Omit<ArtifactBuildRequest, "abortSignal">) => {
      const subagent: AgentSubagent = {
        id: randomUUID(),
        name: "Artifact builder",
        task,
        detail: `Writing the page with ${artifactModelName()}`,
        status: "working",
      };
      this.#requireRun().subagents.push(subagent);
      this.#onChange();
      try {
        const built = await buildArtifactHtml({ ...request, ...(this.#aiAbort === null ? {} : { abortSignal: this.#aiAbort.signal }) });
        subagent.status = "completed";
        subagent.detail = `Wrote ${String(Math.round(Buffer.byteLength(built.html, "utf8") / 1024))} KB of HTML with ${built.model}`;
        this.#onChange();
        return built;
      } catch (error: unknown) {
        subagent.status = "failed";
        subagent.detail = error instanceof Error ? error.message : String(error);
        this.#onChange();
        throw error;
      }
    };
    const host: ArtifactToolHost = {
      list: () => store.all().map((artifact) => this.#artifactView(artifact)),
      create: async ({ title, brief, content }) => {
        const built = await build(`Design “${title}”`, { title, brief, content, priorHtml: null });
        return this.#artifactView(store.create({ title, brief, html: built.html, builtWith: built.model }, source));
      },
      update: async (id, { title, instructions, content }) => {
        const existing = store.get(id);
        const priorHtml = store.html(id);
        if (existing === null || priorHtml === null) throw new Error(`no artifact ${id}; artifact_list shows what exists`);
        const nextTitle = title ?? existing.title;
        const built = await build(`Refresh “${nextTitle}”`, {
          title: nextTitle,
          brief: `${existing.brief}\n\nThis refresh: ${instructions}`,
          content,
          priorHtml,
        });
        return this.#artifactView(store.update(id, { title: nextTitle, html: built.html, builtWith: built.model }, source));
      },
    };
    return { artifacts: { host } };
  }

  /** Saved-page tools are available only after opt-in or for existing history. */
  #watchtowerInput(): Pick<AiAgentRunInput, "watchtower"> {
    const service = this.#watchtower;
    const spaceId = this.#runSpaceId ?? this.#spaceId();
    if (!service?.agentAvailable(spaceId)) return {};
    const check = (): void => { if (!service.settings().agentAccess) throw new Error("Watchtower agent access is disabled."); };
    return { watchtower: { host: {
      search: async (query) => { check(); return (await service.request(spaceId, { type: "search", query })).results?.slice(0, 12) ?? []; },
      read: async (observationId, offset, maxChars) => {
        check();
        const doc = (await service.request(spaceId, { type: "read", observationId })).document;
        if (!doc) throw new Error("Saved observation unavailable.");
        const { markdown, blocks: _blocks, history: _history, links: _links, backlinks: _backlinks, ...source } = doc;
        const end = offset + Math.min(20000, maxChars);
        return { source, text: markdown.slice(offset, end), nextOffset: end < markdown.length ? end : null };
      },
    } } };
  }

  /**
   * The bookmark tools for this run. The agent searches and saves; the
   * service reads the page (through its tab when one is open, so the
   * agent's own tab is what is read) and the model fills the card.
   */
  #bookmarkInput(run: RunSummary): Pick<AiAgentRunInput, "bookmarks"> {
    const bookmarks = this.#bookmarks;
    if (bookmarks === null) return {};
    const source: BookmarkSource = { kind: "agent", runId: run.runId };
    const host: BookmarkToolHost = {
      search: (query, kind) => bookmarks.store.search(query, { kind, limit: 12 }).map(bookmarkToolView),
      create: async (input) => bookmarkToolView(await bookmarks.service.create(input, source)),
      update: (id, patch) => bookmarkToolView(bookmarks.store.update(id, patch, source)),
      remove: (id) => {
        const bookmark = bookmarks.store.get(id);
        if (bookmark === null) throw new Error(`no bookmark ${id}; bookmark_search shows what exists`);
        bookmarks.store.remove(id);
        return bookmark;
      },
    };
    return { bookmarks: { host } };
  }

  /**
   * The note tools for this run: the person's own markdown documents, which
   * the agent lists, searches, reads whole, writes and removes. Every write
   * is sourced here — the model never says who it is.
   */
  #noteInput(run: RunSummary): Pick<AiAgentRunInput, "userNotes"> {
    const store = this.#notes;
    if (store === null) return {};
    const source: NoteSource = { kind: "agent", runId: run.runId };
    const host: NoteToolHost = {
      list: () => store.list(),
      search: (query, limit) => store.search(query, limit),
      get: (id) => store.get(id),
      create: (input) => store.create(input, source),
      update: (id, patch) => store.update(id, patch, source),
      remove: (id) => {
        const note = store.get(id);
        if (note === null) throw new Error(`no note ${id}; note_list shows what exists`);
        store.remove(id);
        return note;
      },
    };
    return { userNotes: { host } };
  }

  /**
   * The note the person is looking at, when the active tab is one of theirs
   * (`pistachio://notes/<id>`) and the store still has it. Null for every
   * other tab, and whenever there is no note store — then a note tab is
   * just another shell page nothing can be asked about.
   */
  #noteInView(): Note | null {
    const store = this.#notes;
    const tab = this.#browser.activeTab();
    if (store === null || tab === null || tab.kind !== "human") return null;
    const id = notesUrlId(tab.url);
    if (typeof id !== "string") return null;
    try {
      return store.get(id);
    } catch {
      return null;
    }
  }

  /**
   * The integration tools for this run: every account connected for the
   * run's Space, each minting its own API tokens on this Mac. Nothing when
   * nothing is connected or control cannot be reached — the run goes on
   * without them rather than not at all.
   */
  async #integrationInput(): Promise<Pick<AiAgentRunInput, "integrations">> {
    const integrations = this.#integrations;
    if (integrations === null) return {};
    try {
      const hosts = await integrations.hostsFor(this.#runSpaceId ?? this.#spaceId());
      return hosts.length === 0 ? {} : { integrations: { hosts } };
    } catch {
      return {};
    }
  }

  /** The zone the person keeps time in: their profile's, else this Mac's. */
  timezone(): string {
    const store = this.#memory;
    if (store === null || !this.#settings().memory.enabled) return systemTimezone();
    return effectiveTimezone(store.profile());
  }

  /** The tab a scheduled run starts against: the active one if it is a person's, else any. */
  #humanTabId(): string | null {
    const active = this.#browser.activeTab();
    if (active !== null && active.kind === "human") return active.id;
    return this.#browser.allTabs().find((tab) => tab.kind === "human")?.id ?? null;
  }

  /**
   * A run reached a terminal state. Whoever was waiting on it — the
   * scheduler, for a reminder's task — hears how it went; main hears that
   * the console is free.
   */
  #ended(run: RunSummary): void {
    this.#persistNow();
    const waiter = this.#scheduledWaiter;
    if (waiter !== null && waiter.runId === run.runId) {
      this.#scheduledWaiter = null;
      if (run.status === "completed") {
        const answer = [...run.messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
        waiter.resolve({ status: "completed", output: answer || run.result?.summary || "Finished.", runId: run.runId });
      } else {
        const failure = run.status === "failed" ? run.activity.at(-1)?.detail ?? "The run failed" : "Stopped before it finished";
        waiter.resolve({ status: "failed", error: failure, runId: run.runId });
      }
    }
    this.#onRunEnded?.(run);
  }

  /**
   * What this run knows about the person: the standing profile plus what
   * bears on the task, and the tools to add to it. Nothing when memory is
   * off — the tools go too, so "off" means off.
   */
  async #memoryInput(run: RunSummary): Promise<Pick<AiAgentRunInput, "memory">> {
    const store = this.#memory;
    if (store === null || !this.#settings().memory.enabled) return {};
    const source: MemorySource = { kind: "agent", runId: run.runId };
    const lastUser = [...run.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const recalled = await store.search(`${run.purpose}\n${lastUser}`, { limit: 8 });
    const host: MemoryToolHost = {
      search: async (query) => (await store.search(query, { limit: 8 })).map(memoryToolView),
      add: (input) => memoryToolView(store.add(input, source)),
      update: (id, patch) => memoryToolView(store.update(id, patch, source)),
      forget: (id, reason) => memoryToolView(store.forget(id, reason, source)),
    };
    return { memory: { prompt: store.prompt({ recalled }), host } };
  }

  /**
   * After a run: read the conversation for facts worth keeping. Best
   * effort and off the run's critical path — the run is already complete
   * by the time this starts, and nothing here can fail it.
   */
  async #learn(run: RunSummary): Promise<void> {
    const store = this.#memory;
    const memory = this.#settings().memory;
    if (store === null || !memory.enabled || !memory.learnFromRuns) return;
    // Only what the learner has not read: a continued thread completes
    // more than once, and the earlier exchanges were already learned from.
    const from = this.#learnedThrough.get(run.runId) ?? 0;
    const unread = run.messages.slice(from);
    this.#learnedThrough.set(run.runId, run.messages.length);
    if (!unread.some((message) => message.role === "user")) return;
    const changes = await learnFromConversation(store, {
      runId: run.runId,
      purpose: run.purpose,
      conversation: unread.map(({ role, content }) => ({ role, content })),
    });
    const count = changes.added.length + changes.updated.length + changes.forgotten.length;
    // A newer run may own the console by now; then the record is the file.
    if (count === 0 || this.#run?.runId !== run.runId) return;
    this.#activity("Memory updated", describeChanges(changes), "neutral");
    this.#chain?.append("memory.learned", {
      added: changes.added.length,
      updated: changes.updated.length,
      forgotten: changes.forgotten.length,
      pending: changes.added.filter((entry) => entry.review === "pending").length,
    });
    this.#onChange();
  }

  #abortAi(): void {
    this.#aiAbort?.abort();
    this.#aiAbort = null;
  }

  #shouldUseAi(): boolean {
    if (process.env["PISTACHIO_AGENT_LIVE"] === "1") return true;
    return process.env["PISTACHIO_E2E"] !== "1";
  }

  #plainModelText(value: string): string {
    return value
      .replace(/\[([^\]]+)]\(((?:https?|pistachio):\/\/[^)]+)\)/g, "$1 ($2)")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^[-*]\s+/gm, "• ")
      .trim();
  }

  async #beginDemoExecution(runId: string): Promise<void> {
    const run = this.#run;
    if (run?.runId !== runId || isTerminalStatus(run.status)) return;
    run.status = "running";
    run.control = "agent";
    this.#message("assistant", "I’m on it. I’ll work in your current tab and keep tool calls, specialists, and decisions in this thread.");
    const tabs = this.#tools.listTabs();
    this.#recordCompletedTool(
      "tabs.list",
      "Review open tabs",
      `${String(tabs.length)} tab${tabs.length === 1 ? "" : "s"} available across your browser`,
      null,
    );
    const tabId = run.humanTabId;
    if (tabId === null) {
      await this.#failRun(runId, new Error("the conversation has no browser tab"));
      return;
    }
    const inspect = this.#startTool("page.inspect", "Read current page", "Inspecting visible content and controls", tabId);
    this.#onChange();
    try {
      const page = await this.#tools.inspect(tabId);
      this.#completeTool(inspect.id, `${page.controls.length} controls found on ${page.title}`);
      run.subagents.push({
        id: randomUUID(),
        name: "Invoice analyst",
        task: "Check the invoice against the purchase order",
        detail: "Comparing totals, freight, and reconciliation state",
        status: "working",
      });
      this.#chain?.append("browser.inspected", {
        tabId,
        title: page.title,
        controls: page.controls.length,
      });
      this.#onChange();
    } catch (error: unknown) {
      this.#failTool(inspect.id, error);
      await this.#failRun(runId, error);
      return;
    }

    this.#schedule(360, async () => {
      if (!this.#isRunning(runId)) return;
      const tool = this.#startTool("page.type", "Draft variance note", "Typing into the reconciliation memo", tabId);
      this.#onChange();
      await this.#browser.applyAgentDraft(tabId);
      this.#completeTool(tool.id, "Added a note for the $20 freight variance");
      this.#activity("Draft updated", "Documented the freight difference in the live page", "neutral");
      this.#chain?.append("browser.action", {
        tool: "page.type",
        tabId,
        result: "completed",
      });
      this.#onChange();
    });
    this.#schedule(880, () => this.#requestApproval(runId));
  }

  async #requestApproval(runId: string): Promise<void> {
    const run = this.#run;
    if (run?.runId !== runId || !this.#isRunning(runId) || run.pendingApproval !== null) return;
    for (const subagent of run.subagents) {
      if (subagent.status === "working") {
        subagent.status = "completed";
        subagent.detail = "Matched the PO; isolated a $20 freight variance";
      }
    }
    const requestedAt = new Date();
    const approval: PendingApproval = {
      id: randomUUID(),
      runId,
      requestedAt: requestedAt.toISOString(),
      expiresAt: new Date(
        requestedAt.getTime() + this.#settings().approvals.expiryMinutes * 60_000,
      ).toISOString(),
      evidence: {
        action: "Submit reconciliation",
        resource: "Northstar Finance · Invoice #NS-2048",
        summary: "Document the $20 freight variance and route the invoice for payment.",
        before: { status: "Draft", variance: "$20.00", paymentRouted: false },
        after: { status: "Submitted", variance: "$20.00", paymentRouted: true },
        dataLeaving: ["Invoice number", "Purchase order", "Variance note"],
        reversible: false,
      },
    };
    run.pendingApproval = approval;
    run.status = "waiting_for_approval";
    this.#message("assistant", "I found one $20 freight difference, documented it, and matched everything else. The reconciliation is ready to submit.");
    this.#activity("Approval required", "Submission would change financial state", "warning");
    this.#chain?.append("approval.requested", {
      approvalId: approval.id,
      action: approval.evidence.action,
      expiresAt: approval.expiresAt,
    });
    this.#onChange();
    await this.#notifications.deliver({
      id: approval.id,
      userId: "local-user",
      runId,
      kind: "approval",
      title: "Pistachio needs your approval",
      body: approval.evidence.summary,
      actionUrl: `pistachio://runs/${runId}`,
      capabilityCeiling: ["invoice.submit_reconciliation"],
    });
  }

  async #complete(runId: string): Promise<void> {
    if (this.#run?.runId !== runId || this.#run.status !== "running") return;
    const run = this.#run;
    run.status = "completed";
    run.completedAt = new Date().toISOString();
    this.#activity("Task complete", "Reconciliation submitted in the current tab", "safe");
    this.#chain?.append("run.completed", {
      changes: ["Reconciliation note added", "Invoice routed for payment"],
      sessionMode: "user-session",
    });
    this.#chain?.append("authority.ended", {
      reason: "completed",
      browserSessionPreserved: true,
      separateSessionCreated: false,
    });
    run.result = {
      summary: "Invoice #NS-2048 was reconciled and submitted for payment.",
      changes: [
        "Added a note explaining the $20 freight variance",
        "Changed reconciliation status from Draft to Submitted",
        "Kept the result open in your original tab",
      ],
      capsuleRevoked: false,
      evidenceEntries: this.#chain?.entries().length ?? 0,
      rootHash: this.#chain?.rootHash() ?? "",
    };
    this.#message("assistant", "Done — the invoice is reconciled and submitted. I left the finished result open in your tab.");
    this.#onChange();
    this.#ended(run);
    this.#notifyIMessage({
      kind: "completion",
      text: run.result.summary,
      completionId: run.completedAt ?? String(run.turns),
    });
    await this.#notifications.deliver({
      id: `completed:${runId}`,
      userId: "local-user",
      runId,
      kind: "completion",
      title: "Browser task completed",
      body: run.result.summary,
      actionUrl: `pistachio://runs/${runId}`,
      capabilityCeiling: [],
    });
  }

  async #failRun(runId: string, error: unknown): Promise<void> {
    const run = this.#run;
    if (run?.runId !== runId || isTerminalStatus(run.status)) return;
    const message = error instanceof Error ? error.message : String(error);
    this.#clearTimers();
    run.pendingApproval = null;
    const pendingQuestionId = run.pendingQuestion?.id;
    run.pendingQuestion = null;
    run.status = "failed";
    run.completedAt = new Date().toISOString();
    const failedTool = [...run.toolCalls].reverse().find((tool) => tool.status === "failed");
    const what = failedTool === undefined ? "something" : `the ${toolFamily(failedTool.name) === "browser" ? "browser action" : failedTool.label.toLowerCase()} step`;
    this.#message("assistant", `I stopped because ${what} failed: ${message}`);
    this.#activity("Task failed", message, "blocked");
    this.#chain?.append("run.failed", { message });
    this.#onChange();
    this.#ended(run);
    if (pendingQuestionId !== undefined) this.#notifyIMessage({ kind: "resolved", questionId: pendingQuestionId });
  }

  #endInteraction(reason: string): void {
    this.#clearTimers();
    this.#chain?.append("authority.ended", {
      reason,
      browserSessionPreserved: true,
      separateSessionCreated: false,
    });
    this.#onChange();
    if (this.#run !== null) this.#ended(this.#run);
  }

  #schedule(delay: number, operation: () => void | Promise<void>): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      void Promise.resolve(operation()).catch((error: unknown) => {
        if (this.#run !== null) void this.#failRun(this.#run.runId, error);
      });
    }, Math.max(0, delay));
    timer.unref();
    this.#timers.add(timer);
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  #message(
    role: RunSummary["messages"][number]["role"],
    content: string,
    attachments: AgentAttachment[] = [],
  ): void {
    const run = this.#requireRun();
    run.messages.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      role,
      content,
      turn: Math.max(1, run.turns),
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    this.#touch();
  }

  #activity(label: string, detail: string, tone: RunSummary["activity"][number]["tone"]): void {
    this.#requireRun().activity.push({ id: randomUUID(), at: new Date().toISOString(), label, detail, tone });
    this.#touch();
  }

  #startTool(
    name: AgentToolCall["name"],
    label: string,
    detail: string,
    tabId: string | null,
  ): AgentToolCall {
    const run = this.#requireRun();
    const tool: AgentToolCall = {
      id: randomUUID(),
      name,
      label,
      detail,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      tabId,
      turn: Math.max(1, run.turns),
    };
    run.toolCalls.push(tool);
    this.#touch();
    return tool;
  }

  #recordCompletedTool(
    name: AgentToolCall["name"],
    label: string,
    detail: string,
    tabId: string | null,
  ): void {
    const tool = this.#startTool(name, label, detail, tabId);
    this.#completeTool(tool.id, detail);
  }

  #completeTool(toolId: string, detail: string): void {
    const tool = this.#requireRun().toolCalls.find((item) => item.id === toolId);
    if (tool === undefined) return;
    tool.status = "completed";
    tool.detail = detail;
    tool.completedAt = new Date().toISOString();
    this.#touch();
  }

  #failTool(toolId: string, error: unknown): void {
    const tool = this.#requireRun().toolCalls.find((item) => item.id === toolId);
    if (tool === undefined) return;
    tool.status = "failed";
    tool.detail = error instanceof Error ? error.message : String(error);
    tool.completedAt = new Date().toISOString();
    this.#touch();
  }

  #requireRun(): RunSummary {
    if (this.#run === null) throw new Error("no agent conversation exists");
    return this.#run;
  }

  #isRunning(runId: string): boolean {
    return this.#run?.runId === runId && this.#run.status === "running" && this.#run.control === "agent";
  }

  #needsClarification(purpose: string): boolean {
    const normalized = purpose.trim().toLowerCase();
    return normalized.length < 14 || ["help", "do this", "take care of this", "handle it"].includes(normalized);
  }

  /** A deterministic no-provider path used by the demo and its UI journey. */
  #needsTextClarification(purpose: string): boolean {
    const normalized = purpose.trim().toLowerCase();
    const offersValue = /\b(?:give|provide|share|supply|enter)\b/.test(normalized);
    const namesPostalCode = /\b(?:zip|postal) code\b/.test(normalized);
    const alreadyIncludesPostalCode = /\b\d{5}(?:-\d{4})?\b/.test(normalized);
    return offersValue && namesPostalCode && !alreadyIncludesPostalCode;
  }
}
