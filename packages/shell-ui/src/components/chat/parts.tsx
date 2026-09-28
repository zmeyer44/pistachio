import { type FormEvent, memo, useEffect, useState } from "react";
import { Questionnaire } from "@shadcn/react/questionnaire";
import {
  AlarmClock,
  ArrowRight,
  ArrowUp,
  Bookmark,
  Bot,
  Brain,
  Check,
  ChevronDown,
  Copy,
  FileClock,
  FileText,
  Fingerprint,
  Globe2,
  LayoutTemplate,
  ListTree,
  Loader2,
  Maximize2,
  MousePointerClick,
  NotebookPen,
  PanelTop,
  Plug,
  RotateCcw,
  ShieldCheck,
  Volume2,
  X,
} from "lucide-react";
import type { AgentAttachment, AgentToolCall, AgentToolOutput, RunSummary } from "@pistachio/protocol";
import { cn } from "../../lib/cn";
import type { CitedSource } from "../../lib/chat-sources";
import { currentFamily, toolFamily, traceLabel, type ToolFamily, type TraceTurn } from "../../lib/run";
import { useAppStore } from "../../store";
import { OutputCards } from "../OutputCard";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { MessageText } from "../MessageText";
import { Markdown } from "./Markdown";
import { ReasoningBlock } from "./ReasoningBlock";
import { SourcesRow } from "./Sources";

/**
 * The pieces a conversation is drawn from, shared by the sidebar console
 * (components/AgentConsole.tsx) and the home page's chat
 * (components/home/HomeChat.tsx): the person's bubble and the assistant's
 * reply, the trace of what a turn did, the cards a paused run raises, and
 * what a finished one leaves behind. Each takes a `density`: `panel` is
 * the 13/14px console beside a page, `page` the fuller reading measure of
 * a chat that has the whole pane.
 */

export type ChatDensity = "page" | "panel";

export const TERMINAL = new Set<RunSummary["status"]>(["completed", "rejected", "revoked", "failed"]);

/**
 * An image in the thread — sized by its own aspect ratio (max-w AND max-h
 * caps, never a forced box) so the border hugs the pixels. Hovering reveals
 * the expand button that opens the lightbox; its own group name, so a
 * bubble's hover cannot reveal the button from a distance.
 */
function ChatImage({ src, alt }: { src: string; alt: string }) {
  const openImagePreview = useAppStore((state) => state.openImagePreview);
  return (
    <span className="group/shot relative my-1 block w-fit max-w-full">
      <img
        src={src}
        alt={alt}
        draggable={false}
        className="block h-auto max-h-48 w-auto max-w-full rounded-md shadow-border"
      />
      <Button
        variant="secondary"
        size="xs"
        svgOnly
        title="Expand image"
        aria-label={`Expand ${alt}`}
        onClick={() => openImagePreview({ src, alt })}
        className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover/shot:opacity-100 focus-visible:opacity-100"
      >
        <Maximize2 aria-hidden="true" />
      </Button>
    </span>
  );
}

/** A turn's attached files: pictures render, everything else names itself. */
export function MessageAttachments({
  attachments,
  align,
}: {
  attachments: AgentAttachment[];
  align: "start" | "end";
}) {
  return (
    <div
      data-testid="message-attachments"
      className={cn(
        "flex flex-wrap gap-1.5",
        align === "end" ? "justify-end" : "justify-start",
      )}
    >
      {attachments.map((file) =>
        file.mediaType.startsWith("image/") ? (
          <ChatImage key={file.id} src={file.url} alt={file.name} />
        ) : (
          <span
            key={file.id}
            title={file.name}
            className="my-1 flex max-w-full items-center gap-1.5 rounded-md bg-background-200 px-2 py-1.5 text-label-12 text-gray-900 shadow-border"
          >
            <FileText
              className="size-3.5 shrink-0 text-gray-700"
              aria-hidden="true"
            />
            <span className="truncate">{file.name}</span>
          </span>
        ),
      )}
    </div>
  );
}

/**
 * One message of the thread. Memoized on the message: a publish that did
 * not touch it hands back the same object.
 *
 * The assistant's reply runs the full width: the header already carries
 * the mark, and the user's bubble on the right tells the two voices apart.
 * Its Markdown is drawn (chat/Markdown.tsx); what the model thought first
 * folds above it, the pages the turn read line up under it as sources, and
 * its footer holds what a person does with a reply — hear it, copy it, ask
 * for another. The person's own bubbles carry none of that.
 */
export const MessageRow = memo(function MessageRow({
  message,
  outputs,
  sources = NO_SOURCES,
  canRetry = false,
  density = "panel",
  links = "glance",
}: {
  message: RunSummary["messages"][number];
  /** What the turn this reply finished made: shown as cards under its text. */
  outputs?: readonly AgentToolOutput[] | undefined;
  /** The pages the turn this reply finished read, numbered as its citations are. */
  sources?: readonly CitedSource[];
  /** Present on the last reply of a settled thread: the turn can be run again. */
  canRetry?: boolean;
  density?: ChatDensity;
  links?: "glance" | "tab";
}) {
  const attachments = message.attachments ?? [];
  const page = density === "page";
  if (message.role === "system") {
    return (
      <div className="flex min-w-0 items-center gap-2 px-1 text-label-12 text-gray-700">
        <span className="h-px min-w-3 flex-1 bg-alpha-400" />
        <span className="min-w-0 max-w-[84%] text-center leading-4 text-pretty wrap-anywhere select-text">
          {message.content}
        </span>
        <span className="h-px min-w-3 flex-1 bg-alpha-400" />
      </div>
    );
  }
  if (message.role === "user") {
    return (
      <div className={cn("grid min-w-0 justify-items-end gap-1.5", page ? "pl-16" : "pl-10")} data-testid="user-message">
        {attachments.length === 0 ? null : (
          <MessageAttachments attachments={attachments} align="end" />
        )}
        {message.content === "" ? null : (
          <div
            className={cn(
              "max-w-[88%] wrap-anywhere whitespace-pre-wrap text-background-100 shadow-small select-text",
              page ? "rounded-[22px_22px_6px_22px] bg-gray-1000 px-4.5 py-3 text-[15px] leading-[1.5]" : "rounded-[17px_17px_4px_17px] bg-gray-1000 px-3.5 py-2.5 text-copy-14",
            )}
          >
            <MessageText text={message.content} links={links} />
          </div>
        )}
      </div>
    );
  }
  const reasoning = message.reasoning?.trim() ?? "";
  return (
    <div className={cn("grid min-w-0 text-gray-1000", page ? "gap-2.5" : "gap-1.5 text-copy-14 wrap-anywhere")} data-testid="assistant-message">
      {reasoning === "" ? null : (
        <ReasoningBlock reasoning={reasoning} thinking={false} thinkingMs={message.thinkingMs ?? 0} density={density} />
      )}
      {message.content === "" ? null : <Markdown text={message.content} sources={sources} links={links} density={density} />}
      {attachments.length === 0 ? null : (
        <MessageAttachments attachments={attachments} align="start" />
      )}
      {outputs === undefined ? null : (
        <div className="mt-1.5">
          <OutputCards outputs={outputs} />
        </div>
      )}
      {sources.length === 0 ? null : <SourcesRow sources={sources} className={page ? "mt-1" : undefined} />}
      {message.content === "" ? null : <MessageActions text={message.content} canRetry={canRetry} />}
    </div>
  );
});

const NO_SOURCES: readonly CitedSource[] = [];

/** How long the copy button shows its check before going back to the icon. */
const COPIED_MS = 1_500;

/**
 * The reply's footer: read aloud, copy, and — on the last reply of a settled
 * thread — retry. Small, always shown, muted until hovered, so a reply reads
 * as text first and controls second.
 */
export function MessageActions({ text, canRetry }: { text: string; canRetry: boolean }) {
  const readAloudText = useAppStore((state) => state.readAloudText);
  const retryAgentTurn = useAppStore((state) => state.retryAgentTurn);
  const [speaking, setSpeaking] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const speak = async (): Promise<void> => {
    setSpeaking(true);
    try {
      await readAloudText(text);
    } finally {
      setSpeaking(false);
    }
  };
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // The clipboard refused (no focus, no permission): nothing to show.
    }
  };
  return (
    <div className="-ml-1 flex items-center gap-0.5 text-gray-700" data-testid="message-actions">
      <MessageAction
        label={speaking ? "Preparing…" : "Read aloud"}
        disabled={speaking}
        onClick={() => void speak()}
        testId="message-read-aloud"
      >
        {speaking ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Volume2 className="size-3.5" aria-hidden="true" />
        )}
      </MessageAction>
      <MessageAction label={copied ? "Copied" : "Copy"} onClick={() => void copy()} testId="message-copy">
        {copied ? (
          <Check className="size-3.5 text-green-900" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
      </MessageAction>
      {canRetry ? (
        <MessageAction label="Retry" onClick={() => void retryAgentTurn()} testId="message-retry">
          <RotateCcw className="size-3.5" aria-hidden="true" />
        </MessageAction>
      ) : null}
    </div>
  );
}

function MessageAction({
  label,
  onClick,
  disabled = false,
  testId,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className="grid size-6 cursor-pointer place-items-center rounded-md transition-colors hover:bg-alpha-300 hover:text-gray-1000 disabled:cursor-default disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

/** The trace's badge: the surface the run is acting on right now. */
const FAMILY_ICON: Record<ToolFamily, typeof PanelTop> = {
  browser: PanelTop,
  memory: Brain,
  reminder: AlarmClock,
  bookmark: Bookmark,
  watchtower: NotebookPen,
  note: FileText,
  notes: NotebookPen,
  integration: Plug,
};

/**
 * The agent's pinned plan: what it wrote to keep for itself across steps
 * and compactions. Open while the run is live so progress reads at a
 * glance; a finished thread folds it away under the headline.
 */
export function TaskNotes({ run }: { run: RunSummary }) {
  const live = !TERMINAL.has(run.status);
  return (
    <details
      data-testid="task-notes"
      className="agent-trace mb-5 min-w-0 rounded-md border border-alpha-400 bg-background-200/70"
      open={live}
    >
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 px-2.5 text-label-12 font-medium text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="grid size-5 place-items-center rounded-sm bg-background-100 text-gray-900 shadow-border">
          <NotebookPen className="size-3" aria-hidden="true" />
        </span>
        <span className="truncate">Plan &amp; notes</span>
        <ChevronDown
          className="ml-auto size-3.5 shrink-0 transition-transform"
          aria-hidden="true"
        />
      </summary>
      <div
        data-testid="task-notes-text"
        className="scroll-thin max-h-64 overflow-y-auto border-t border-alpha-400 px-3 py-2.5 text-copy-13 wrap-anywhere whitespace-pre-wrap text-gray-1000 select-text"
      >
        <MessageText text={run.notes} />
      </div>
    </details>
  );
}

/**
 * Memoized on the turn and two facts about the run, rather than the run
 * itself: the run object changes on every publish, the turn only when one of
 * its tool calls does.
 */
export const WorkTrace = memo(function WorkTrace({
  turn,
  latest,
  awaitingApproval,
}: {
  turn: TraceTurn;
  latest: boolean;
  awaitingApproval: boolean;
}) {
  const running = turn.toolCalls.filter(
    (tool) => tool.status === "running",
  ).length;
  const family = currentFamily(turn);
  const TraceIcon = family === null ? ListTree : FAMILY_ICON[family];
  return (
    <details
      className="agent-trace mt-3 min-w-0 rounded-md border border-alpha-400 bg-background-200/70"
      data-testid="work-trace"
      data-turn={turn.turn}
      open={running > 0 || (latest && awaitingApproval)}
    >
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 px-2.5 text-label-12 font-medium text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="grid size-5 place-items-center rounded-sm bg-background-100 text-gray-900 shadow-border">
          <TraceIcon className="size-3" aria-hidden="true" />
        </span>
        <span className="truncate" data-testid="trace-label">
          {traceLabel(turn)}
        </span>
        <span className="ml-auto shrink-0 text-gray-700">
          {turn.toolCalls.length + turn.subagents.length}
        </span>
        <ChevronDown
          className="size-3.5 shrink-0 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t border-alpha-400 px-2.5 py-1.5">
        {turn.toolCalls.map((tool) => (
          <ToolRow key={tool.id} tool={tool} />
        ))}
        {turn.subagents.map((agent) => (
          <div
            key={agent.id}
            className="grid min-w-0 grid-cols-[20px_1fr_auto] gap-2 py-2"
          >
            <span className="grid size-5 place-items-center rounded-full bg-blue-100 text-blue-900">
              <Bot className="size-3" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <strong className="block truncate text-label-12 font-medium text-gray-1000">
                {agent.name}
              </strong>
              <span className="block truncate text-[11px] leading-4 text-gray-700">
                {agent.detail}
              </span>
            </div>
            <Badge
              variant={
                agent.status === "completed" ? "green-subtle" : "blue-subtle"
              }
              size="sm"
            >
              {agent.status}
            </Badge>
          </div>
        ))}
      </div>
    </details>
  );
});

/** A browser tool's icon: a few named actions, else the globe. */
function browserToolIcon(name: AgentToolCall["name"]): typeof Globe2 {
  if (name.startsWith("artifact.")) return LayoutTemplate;
  if (name === "page.type") return MousePointerClick;
  if (name === "page.press") return ArrowUp;
  if (name === "tabs.list") return ListTree;
  if (name === "page.submit") return ArrowUp;
  return Globe2;
}

const ToolRow = memo(function ToolRow({ tool }: { tool: AgentToolCall }) {
  // Non-browser families wear the badge their trace does; the browser
  // family keeps its own set so a click and a submit read differently.
  const family = toolFamily(tool.name);
  const Icon =
    family === "browser" ? browserToolIcon(tool.name) : FAMILY_ICON[family];
  return (
    <div className="grid min-w-0 grid-cols-[20px_1fr_auto] gap-2 py-2">
      <span className="grid size-5 place-items-center text-gray-700">
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <strong className="block truncate text-label-12 font-medium text-gray-1000">
          {tool.label}
        </strong>
        <span className="block truncate text-[11px] leading-4 text-gray-700">
          {tool.detail}
        </span>
      </div>
      <ToolStatus status={tool.status} />
    </div>
  );
});

function ToolStatus({ status }: { status: AgentToolCall["status"] }) {
  if (status === "completed")
    return (
      <Check
        className="mt-0.5 size-3.5 text-green-900"
        aria-label="Completed"
      />
    );
  if (status === "running")
    return (
      <span
        className="mt-1 size-2 animate-pulse rounded-full bg-blue-700"
        aria-label="Running"
      />
    );
  if (status === "paused")
    return (
      <span
        className="mt-1 size-2 rounded-full bg-amber-700"
        aria-label="Paused"
      />
    );
  return <X className="mt-0.5 size-3.5 text-red-900" aria-label="Failed" />;
}

export function ClarificationCard({ run }: { run: RunSummary }) {
  const question = run.pendingQuestion!;
  const answer = useAppStore((state) => state.answerAgentQuestion);
  const textInput = question.input?.type === "text" ? question.input : null;
  const wantsText = textInput !== null;
  const items = [
    { name: "direction", required: true, choices: question.choices },
  ] as const;
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = String(
      new FormData(event.currentTarget).get("direction") ?? "",
    ).trim();
    if (value !== "") void answer(question.id, value);
  };
  return (
    <div
      className="min-w-0 rounded-lg border border-alpha-500 bg-background-100 p-3.5 shadow-small"
      data-testid="questionnaire-card"
    >
      <Questionnaire.Root
        items={items}
        shortcuts={wantsText ? undefined : "numbers"}
        onSubmit={handleSubmit}
      >
        <Questionnaire.Item name="direction" required>
          <Questionnaire.Title className="text-heading-14 wrap-anywhere text-gray-1000">
            {question.prompt}
          </Questionnaire.Title>
          <Questionnaire.Description className="mt-1 text-copy-13 wrap-anywhere text-gray-700">
            {question.description}
          </Questionnaire.Description>
          <Questionnaire.Choices className="mt-3 grid gap-1.5">
            {wantsText ? (
              <Questionnaire.Input
                aria-label="Your answer"
                data-testid="question-text-input"
                placeholder={textInput.placeholder}
                autoComplete="off"
                maxLength={16_384}
                className="h-10 rounded-md border border-alpha-500 bg-background-100 px-3 text-copy-14 text-gray-1000 outline-none transition-shadow placeholder:text-gray-700 hover:border-gray-500 focus:border-gray-1000 focus:shadow-[0_0_0_3px_var(--color-alpha-200)]"
              />
            ) : (
              <>
                {question.choices.map((choice) => (
                  <Questionnaire.Choice
                    key={choice.value}
                    value={choice.value}
                    className="group grid min-w-0 cursor-pointer grid-cols-[16px_1fr_auto] items-start gap-2 rounded-md border border-alpha-400 px-2.5 py-2.5 transition-colors has-checked:border-gray-1000 has-checked:bg-gray-100"
                  >
                    <Questionnaire.ChoiceInput className="mt-0.5 size-3.5 appearance-none rounded-full border border-gray-700 bg-background-100 checked:border-[4px] checked:border-gray-1000" />
                    <Questionnaire.ChoiceLabel className="grid min-w-0">
                      <span className="text-label-13 font-medium wrap-anywhere text-gray-1000">
                        {choice.label}
                      </span>
                      <span className="mt-0.5 text-[11px] leading-4 wrap-anywhere text-gray-700">
                        {choice.description}
                      </span>
                    </Questionnaire.ChoiceLabel>
                    <Questionnaire.ChoiceShortcut className="font-mono text-[10px] text-gray-700" />
                  </Questionnaire.Choice>
                ))}
                <Questionnaire.Input
                  aria-label="Another direction"
                  placeholder="Or describe another direction…"
                  className="h-9 rounded-md border border-alpha-400 bg-background-100 px-2.5 text-label-13 text-gray-1000 outline-none focus:border-gray-700"
                />
              </>
            )}
          </Questionnaire.Choices>
          <Questionnaire.Error className="mt-2 text-label-12 text-red-900">
            {wantsText ? "Enter an answer to continue." : "Choose a direction to continue."}
          </Questionnaire.Error>
        </Questionnaire.Item>
        <Questionnaire.Submit className="mt-3 h-8 w-full cursor-pointer rounded-sm bg-gray-1000 px-3 text-label-13 font-medium text-background-100 disabled:opacity-40">
          Continue
        </Questionnaire.Submit>
      </Questionnaire.Root>
    </div>
  );
}

export function ApprovalCard({ run }: { run: RunSummary }) {
  const approval = run.pendingApproval!;
  const approve = useAppStore((state) => state.approve);
  const reject = useAppStore((state) => state.reject);
  const evidence = approval.evidence;
  return (
    <section
      data-testid="approval-card"
      className="min-w-0 overflow-hidden rounded-lg border border-amber-400 bg-background-100 shadow-small"
    >
      <div className="flex items-start gap-2.5 bg-amber-100 px-3.5 py-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-amber-700 text-black">
          <Fingerprint className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <span className="block text-[11px] font-medium tracking-wide text-amber-900 uppercase">
            Needs your approval
          </span>
          <strong className="mt-0.5 block text-heading-14 wrap-anywhere text-gray-1000">
            {evidence.action}
          </strong>
        </div>
      </div>
      <div className="p-3.5">
        <p className="text-copy-13 wrap-anywhere text-gray-900">
          {evidence.summary}
        </p>
        <div className="mt-3 grid grid-cols-[1fr_20px_1fr] items-center rounded-md bg-background-200 p-2.5 shadow-border">
          <span className="grid min-w-0">
            <small className="text-[11px] text-gray-700">Before</small>
            <strong className="truncate text-label-12 font-medium text-gray-1000">
              {String(evidence.before["status"])}
            </strong>
          </span>
          <ArrowRight className="size-3.5 text-gray-700" aria-hidden="true" />
          <span className="grid min-w-0">
            <small className="text-[11px] text-gray-700">After</small>
            <strong className="truncate text-label-12 font-medium text-gray-1000">
              {String(evidence.after["status"])}
            </strong>
          </span>
        </div>
        <div className="mt-3 flex items-center gap-2 text-[11px] text-gray-700">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          One action · {evidence.reversible ? "Reversible" : "Cannot be undone"}
        </div>
        <div className="mt-3 grid grid-cols-[0.75fr_1.25fr] gap-2">
          <Button
            variant="secondary"
            size="sm"
            data-testid="reject-button"
            onClick={() => void reject(approval.id)}
          >
            Not now
          </Button>
          <Button
            size="sm"
            data-testid="approve-button"
            suffix={<ArrowRight aria-hidden="true" />}
            onClick={() => void approve(approval.id)}
          >
            Approve & run
          </Button>
        </div>
      </div>
    </section>
  );
}

/**
 * Completion is metadata for the answer above it, not a second answer.
 * Keep the status and evidence trail discoverable without repeating the
 * result summary the assistant has already added to the conversation.
 */
export function CompletionMeta({ run }: { run: RunSummary }) {
  const result = run.result!;
  const loadEvidence = useAppStore((state) => state.loadEvidence);
  const recordLabel = `${String(result.evidenceEntries)} activity ${result.evidenceEntries === 1 ? "record" : "records"}`;
  return (
    <div
      data-testid="completion-meta"
      className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-label-12 text-gray-700"
    >
      <span className="flex h-6 shrink-0 items-center gap-1.5 font-medium text-green-900">
        <Check className="size-3.5" aria-hidden="true" />
        Completed
      </span>
      <span className="text-alpha-800" aria-hidden="true">
        ·
      </span>
      <Button
        variant="tertiary"
        size="xs"
        onClick={() => void loadEvidence()}
        className="px-1.5 text-gray-700 hover:text-gray-1000"
      >
        <FileClock aria-hidden="true" /> View {recordLabel}
      </Button>
    </div>
  );
}

// One formatter for the module: building one per call is the expensive part.
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

export function formatTime(value: string): string {
  return TIME_FORMAT.format(new Date(value));
}
