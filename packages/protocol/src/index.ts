import type { IntegrationToolRequest } from "./integrations.js";

export const TASK_STATUSES = [
  "capturing",
  "ready",
  "running",
  "waiting_for_approval",
  "waiting_for_judgment",
  "waiting_for_step_up",
  "interrupted",
  "human_control",
  "completed",
  "rejected",
  "revoked",
  "failed",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type HttpMethod =
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

export interface CapturedTab {
  id: string;
  title: string;
  url: string;
}

export interface CapsuleGrant {
  origins: string[];
  methods: HttpMethod[];
  allowUploads: boolean;
  allowDownloads: boolean;
  allowClipboard: boolean;
  maxInteractions: number;
}

export interface TaskCapsule {
  version: 1;
  id: string;
  taskId: string;
  sponsorId: string;
  purpose: string;
  createdAt: string;
  expiresAt: string;
  policyVersion: string;
  keyId: string;
  tabs: CapturedTab[];
  grant: CapsuleGrant;
}

export interface ApprovalEvidence {
  action: string;
  resource: string;
  summary: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  dataLeaving: string[];
  reversible: boolean;
}

export interface PendingApproval {
  id: string;
  runId: string;
  requestedAt: string;
  expiresAt: string;
  evidence: ApprovalEvidence;
}

/**
 * A file attached to a conversational turn — dropped onto the console and
 * carried with the message it was sent alongside.
 *
 * The bytes travel inline as a data: URL rather than a path: the thread has
 * to render the picture in the renderer, and a file:// path would need a
 * privileged read to get there. Text files never arrive here — they fold
 * into the message body before it is sent, so every model reads them and the
 * transcript shows exactly what was sent.
 */
export interface AgentAttachment {
  id: string;
  name: string;
  mediaType: string;
  /** data:<mediaType>;base64,… — the file's own bytes. */
  url: string;
}

/** A conversational turn rendered in the desktop agent thread. */
export interface AgentMessage {
  id: string;
  at: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** Images and documents sent with this turn. Absent when there were none. */
  attachments?: AgentAttachment[];
  /**
   * Which model turn this message belongs to — the count of user messages
   * that started a turn when it was written. Lets the console group tool
   * calls under the exchange that produced them. Absent on older records.
   */
  turn?: number;
}

/** A browser operation exposed by the main process to the agent runtime. */
export interface AgentToolCall {
  id: string;
  name:
    | "tabs.list"
    | "tab.open"
    | "tab.focus"
    | "page.inspect"
    | "page.navigate"
    | "page.back"
    | "page.forward"
    | "page.reload"
    | "page.click"
    | "page.type"
    | "page.press"
    | "page.scroll"
    | "page.screenshot"
    | "page.submit"
    | "memory.search"
    | "memory.add"
    | "memory.update"
    | "memory.forget"
    | "reminder.create"
    | "reminder.list"
    | "reminder.update"
    | "reminder.cancel"
    | "artifact.create"
    | "artifact.update"
    | "artifact.list"
    | "watchtower.search"
    | "watchtower.read"
    | "bookmark.search"
    | "bookmark.create"
    | "bookmark.update"
    | "bookmark.delete"
    | "note.list"
    | "note.search"
    | "note.read"
    | "note.create"
    | "note.update"
    | "note.delete"
    | "credentials.request"
    | "notes.update"
    | "gmail.search"
    | "gmail.read"
    | "gmail.draft"
    | "gmail.send"
    | "gmail.modify"
    | "google_calendar.calendars"
    | "google_calendar.events"
    | "google_calendar.event"
    | "google_calendar.freebusy"
    | "google_calendar.create"
    | "google_calendar.update"
    | "google_calendar.delete"
    | "google_calendar.respond";
  label: string;
  detail: string;
  status: "running" | "completed" | "paused" | "failed";
  startedAt: string;
  completedAt: string | null;
  tabId: string | null;
  /** The model turn that made this call (see AgentMessage.turn). */
  turn?: number;
  /**
   * What the call made or changed that the person can open — the note it
   * wrote, the page it built. Set when the call completes; absent on calls
   * that leave nothing to look at, and on older records. Content-class: the
   * title is the person's words (docs/cloud-sync-design.md D25).
   */
  output?: AgentToolOutput;
}

/**
 * Something a tool call left behind for the person to open, shown as a card
 * under the reply that finished the turn. `action` is what the call did to it.
 */
export type AgentToolOutput =
  | { kind: "note"; action: "created" | "updated"; id: string; title: string }
  | { kind: "artifact"; action: "created" | "updated"; id: string; title: string; url: string };

/**
 * Keys page.press can strike. Single keys only: enough to submit a search,
 * walk a typeahead or menu, and dismiss an overlay, without becoming a
 * general keyboard.
 */
export const AGENT_PRESSABLE_KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
] as const;
export type AgentPressableKey = (typeof AGENT_PRESSABLE_KEYS)[number];

/** Commands accepted by the desktop's browser-agent tool dispatcher. */
export type BrowserAgentToolRequest =
  | { name: "tabs.list" }
  | { name: "tab.open"; url?: string }
  | { name: "tab.focus"; tabId: string }
  | { name: "page.inspect"; tabId: string }
  | { name: "page.navigate"; tabId: string; url: string }
  | { name: "page.back" | "page.forward" | "page.reload"; tabId: string }
  | { name: "page.click"; tabId: string; target: string }
  | { name: "page.type"; tabId: string; target: string; value: string }
  | { name: "page.press"; tabId: string; key: AgentPressableKey }
  | { name: "page.scroll"; tabId: string; deltaY: number }
  | { name: "page.screenshot"; tabId: string };

export interface BrowserAgentToolResult {
  summary: string;
  data?: unknown;
}

/** Commands against the person's memory (desktop/src/shared/memory.ts). */
export type MemoryToolRequest =
  | { name: "memory.search"; query: string }
  | { name: "memory.add"; content: string }
  | { name: "memory.update"; id: string; content: string }
  | { name: "memory.forget"; id: string; reason: string };

/** Commands against the person's reminders (desktop/src/shared/reminders.ts). */
export type ReminderToolRequest =
  | { name: "reminder.create"; title: string }
  | { name: "reminder.list" }
  | { name: "reminder.update"; id: string; title: string }
  | { name: "reminder.cancel"; id: string; reason: string };

/** Commands against the person's artifact library (desktop/src/shared/artifacts.ts). */
export type ArtifactToolRequest =
  | { name: "artifact.create"; title: string }
  | { name: "artifact.update"; id: string; title: string }
  | { name: "artifact.list" };

/** Commands against the person's bookmarks (desktop/src/shared/bookmarks.ts). */
export type BookmarkToolRequest =
  | { name: "bookmark.search"; query: string }
  | { name: "bookmark.create"; url: string }
  | { name: "bookmark.update"; id: string; title: string }
  | { name: "bookmark.delete"; id: string; reason: string };

/** Commands against the person's notes (docs/notes.md §6). Singular: `notes.*` is the scratchpad's. */
export type NoteToolRequest =
  | { name: "note.list" }
  | { name: "note.search"; query: string }
  | { name: "note.read"; id: string }
  | { name: "note.create"; title: string }
  | { name: "note.update"; id: string; mode: "replace" | "append" | "prepend" | "replace_section" }
  | { name: "note.delete"; id: string };

/** The agent's working notes for the thread (its plan, progress, and facts to keep). */
export type NotesToolRequest = { name: "notes.update"; content: string };

/** Secret fields the cloud agent can ask a person to supply out of band. */
export const CREDENTIAL_FIELD_TYPES = ["text", "email", "password", "otp"] as const;
export type CredentialFieldType = (typeof CREDENTIAL_FIELD_TYPES)[number];

/** Browser autocomplete purposes allowed on an out-of-band sensitive field. */
export const CREDENTIAL_AUTOCOMPLETE_VALUES = [
  "name",
  "username",
  "email",
  "current-password",
  "new-password",
  "one-time-code",
  "organization",
  "street-address",
  "address-line1",
  "address-line2",
  "address-level2",
  "address-level1",
  "country",
  "country-name",
  "postal-code",
  "tel",
  "cc-name",
  "cc-given-name",
  "cc-additional-name",
  "cc-family-name",
  "cc-number",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
  "cc-type",
  "transaction-currency",
  "transaction-amount",
  "off",
] as const;
export type CredentialAutocomplete = (typeof CREDENTIAL_AUTOCOMPLETE_VALUES)[number];

/**
 * A credential handoff request. Targets are selectors from `page.inspect`;
 * values never become part of this request or any model-facing tool result.
 */
export interface CredentialToolRequest {
  name: "credentials.request";
  tabId: string;
  siteName: string;
  fields: Array<{
    label: string;
    type: CredentialFieldType;
    target: string;
    autocomplete?: CredentialAutocomplete;
  }>;
}

export type WatchtowerToolRequest =
  | { name: "watchtower.search"; query: string }
  | { name: "watchtower.read"; id: string };

/** Anything the agent can call — browser, memory, reminders, artifacts, bookmarks, notes, integrations, or its scratchpad — for the run's tool trace. */
export type AgentToolRequest =
  | BrowserAgentToolRequest
  | MemoryToolRequest
  | ReminderToolRequest
  | ArtifactToolRequest
  | BookmarkToolRequest
  | NoteToolRequest
  | WatchtowerToolRequest
  | CredentialToolRequest
  | IntegrationToolRequest
  | NotesToolRequest;

/**
 * A reminder the person or the agent scheduled earlier, firing as a turn of
 * its own.
 */
export interface ReminderRunOrigin {
  kind: "reminder";
  reminderId: string;
  occurrenceId: string;
  title: string;
  /** When the schedule said it should run. */
  scheduledFor: string;
}

/**
 * A message that arrived through an authenticated webhook channel bound to
 * one Space (control's `POST /channels/:linkId/inbound`), starting a cloud
 * run. `deliveryId` is the sender's idempotency key for the delivery.
 */
export interface ChannelRunOrigin {
  kind: "channel";
  linkId: string;
  deliveryId: string;
  channelName: string;
}

/**
 * Where a run came from when not from the composer: a reminder firing, or a
 * message delivered through a channel.
 */
export type RunOrigin = ReminderRunOrigin | ChannelRunOrigin;

/**
 * Who drives a run. Absent on a `RunSummary` or `ThreadListItem` means the
 * desktop that holds the record. A cloud run names the cloud device and the
 * worker once they are known; both are null until the run is claimed.
 */
export type RunExecutor =
  | { kind: "desktop" }
  | { kind: "cloud"; deviceId: string | null; workerId: string | null };

export interface AgentSubagent {
  id: string;
  name: string;
  task: string;
  detail: string;
  status: "working" | "completed" | "paused" | "failed";
}

export interface AgentQuestion {
  id: string;
  prompt: string;
  description: string;
  choices: Array<{ value: string; label: string; description: string }>;
  /**
   * Present when the answer must be supplied verbatim rather than selected
   * from `choices`. Absent on the original multiple-choice question shape,
   * so persisted questions from older builds remain valid.
   */
  input?: { type: "text"; placeholder: string };
}

interface AgentTakeoverBase {
  id: string;
  reason: string;
  instructions: string;
  resumeLabel: string;
}

/** A browser barrier that needs the person to briefly operate the live tab. */
export type AgentTakeover =
  | (AgentTakeoverBase & {
      /** Absent on checkpoints written before takeover kinds were introduced. */
      kind?: "browser";
      captureId?: never;
    })
  | (AgentTakeoverBase & {
      /** Host-authored metadata for a same-origin secure credential handoff. */
      kind: "credentials";
      captureId: string;
    });

/**
 * How much of the model's context window the thread is using, and how the
 * runtime has managed it. Numbers are the model's own accounting when a
 * step has reported usage, and an estimate before the first one.
 */
export interface RunContext {
  /** Tokens the last model step read as input — the live size of the thread's context. Null before the first step. */
  tokens: number | null;
  /** The context size at which older history is folded into a summary. */
  compactAt: number;
  /** The configured context window the budget is derived from. */
  window: number;
  /** How many times the thread's history has been compacted. */
  compactions: number;
  /** Model steps taken in the current turn. */
  steps: number;
  /** Model steps taken across every turn of the thread. */
  totalSteps: number;
  /** Cumulative token usage across the thread. */
  usage: { inputTokens: number; outputTokens: number };
}

export interface RunSummary {
  runId: string;
  taskId: string;
  status: TaskStatus;
  purpose: string;
  /** A short name for the thread list, taken from the first request. */
  title: string;
  /** The last time anything in the thread changed. */
  updatedAt: string;
  /** How many model turns the person (or a schedule) has started in this thread. */
  turns: number;
  /**
   * The agent's own working notes for the thread — plan, progress, ids and
   * facts it will need later. Re-read by the agent on every step and kept
   * through context compaction, so long tasks do not lose the thread.
   */
  notes: string;
  context: RunContext;
  /**
   * The person's tab the run works in. Always set for a run this desktop
   * started; null for a cloud run, whose tabs live in the cloud browser.
   */
  humanTabId: string | null;
  agentTabId: string | null;
  startedAt: string;
  completedAt: string | null;
  control: "agent" | "human";
  /** Absent for a conversation the person started themselves. */
  origin?: RunOrigin;
  /** Absent means this desktop runs it (see RunExecutor). */
  executor?: RunExecutor;
  pendingApproval: PendingApproval | null;
  pendingQuestion: AgentQuestion | null;
  pendingTakeover: AgentTakeover | null;
  messages: AgentMessage[];
  toolCalls: AgentToolCall[];
  subagents: AgentSubagent[];
  activity: Array<{
    id: string;
    at: string;
    label: string;
    detail: string;
    tone: "neutral" | "safe" | "warning" | "blocked";
  }>;
  result: null | {
    summary: string;
    changes: string[];
    capsuleRevoked: boolean;
    evidenceEntries: number;
    rootHash: string;
  };
}

/** One saved conversation, as the console's thread list shows it. */
export interface ThreadListItem {
  runId: string;
  title: string;
  status: TaskStatus;
  startedAt: string;
  updatedAt: string;
  turns: number;
  messageCount: number;
  /** Present when a reminder or a channel, not the person, started the thread. */
  origin?: RunOrigin;
  /** Absent means this desktop runs it (see RunExecutor). */
  executor?: RunExecutor;
}

export function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "pistachio:") {
    throw new Error(`unsupported capsule origin ${url.protocol}`);
  }
  return url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin;
}

export function validateCapsule(capsule: TaskCapsule, now = Date.now()): void {
  if (capsule.version !== 1) throw new Error("unsupported capsule version");
  if (capsule.tabs.length === 0) throw new Error("capsule must contain a tab");
  if (capsule.grant.origins.length === 0) throw new Error("capsule grant must contain an origin");
  if (new Date(capsule.expiresAt).getTime() <= now) throw new Error("capsule expired");
  const origins = new Set(capsule.grant.origins.map(normalizeOrigin));
  for (const tab of capsule.tabs) {
    if (!origins.has(normalizeOrigin(tab.url))) {
      throw new Error(`tab origin is outside capsule grant: ${tab.url}`);
    }
  }
}

/* ------------------------------- feedback -------------------------------- */

/** The emoji row in the console's feedback popover, best to worst. */
export const FEEDBACK_REACTIONS = ["love", "happy", "sad", "crying"] as const;
export type FeedbackReaction = (typeof FEEDBACK_REACTIONS)[number];

export const MAX_FEEDBACK_MESSAGE = 4_000;

/** What the person typed and tapped. */
export interface FeedbackInput {
  message: string;
  reaction: FeedbackReaction | null;
}

/**
 * One feedback submission with the context that lets someone reproduce what
 * the person was looking at: the app build, the page in front of them, and
 * the whole conversation — messages, tool calls, subagents, activity.
 */
export interface FeedbackReport {
  version: 1;
  /** Client-generated, so a retried send is one report, not two. */
  id: string;
  sentAt: string;
  message: string;
  reaction: FeedbackReaction | null;
  app: {
    version: string;
    electron: string;
    chrome: string;
    platform: string;
    model: string;
  };
  browser: {
    activeTab: { url: string; title: string } | null;
    tabCount: number;
  };
  run: RunSummary | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReaction(value: unknown): value is FeedbackReaction {
  return typeof value === "string" && (FEEDBACK_REACTIONS as readonly string[]).includes(value);
}

/** Trim and bound what the popover sends; null when there is nothing to send. */
export function sanitizeFeedbackInput(value: unknown): FeedbackInput | null {
  if (!isRecord(value) || typeof value["message"] !== "string") return null;
  const message = value["message"].trim();
  if (message === "" || message.length > MAX_FEEDBACK_MESSAGE) return null;
  const reaction = value["reaction"];
  return { message, reaction: isReaction(reaction) ? reaction : null };
}

/**
 * The endpoint's guard: the envelope must be well formed, the id must be an
 * id (it becomes a file name), and the run is stored as sent — it is our own
 * app's summary, kept whole so nothing useful for debugging is lost.
 */
export function isFeedbackReport(value: unknown): value is FeedbackReport {
  if (!isRecord(value) || value["version"] !== 1) return false;
  if (typeof value["id"] !== "string" || !UUID_RE.test(value["id"])) return false;
  if (typeof value["sentAt"] !== "string" || Number.isNaN(Date.parse(value["sentAt"]))) return false;
  if (typeof value["message"] !== "string" || value["message"].trim() === "" || value["message"].length > MAX_FEEDBACK_MESSAGE) return false;
  if (value["reaction"] !== null && !isReaction(value["reaction"])) return false;
  const app = value["app"];
  if (!isRecord(app) || !(["version", "electron", "chrome", "platform", "model"] as const).every((key) => typeof app[key] === "string")) return false;
  const browser = value["browser"];
  if (!isRecord(browser) || typeof browser["tabCount"] !== "number") return false;
  const tab = browser["activeTab"];
  if (tab !== null && (!isRecord(tab) || typeof tab["url"] !== "string" || typeof tab["title"] !== "string")) return false;
  const run = value["run"];
  return run === null || (isRecord(run) && typeof run["runId"] === "string" && Array.isArray(run["messages"]) && Array.isArray(run["toolCalls"]));
}

/* -------------------------------- devices -------------------------------- */

/**
 * The kinds of device control knows (its `DevicePlatform`): a Mac running the
 * desktop app, a browser enrolled as a device of its own, and the hosted
 * cloud browser. One owner, so a client cannot label a device by a list of
 * its own that control has since grown past.
 */
export const DEVICE_PLATFORMS = ["macos", "web", "cloud"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** An enrolled device, as control's `/devices` routes render one. */
export interface ControlDevice {
  id: string;
  name: string;
  platform: DevicePlatform;
  /** Base64 raw Ed25519 key: what this device's signatures are checked against. */
  devicePublicKey: string;
  /** Base64 raw X25519 key: what a Space key is sealed to when it is shared. */
  agreementPublicKey: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

/* ------------------------------ run events ------------------------------- */

export * from "./run-events.js";
export * from "./tool-output.js";
export * from "./imessage-routing.js";
export * from "./sse.js";
export * from "./vault.js";
export * from "./integrations.js";

export * from "./credential-capture.js";
