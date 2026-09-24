"use client";

import { CredentialCapture } from "@pistachio/web-account/credential-capture";

/**
 * A cloud run, read as the conversation it actually is.
 *
 * This is the desktop console's thread (AgentConsole.tsx) on the web: the
 * same messages, the same recessed tool trace under each turn, the same
 * working line, the same wording — because the wording comes from the same
 * place (`@pistachio/run-view`). What differs is only what a browser can
 * honestly offer: it holds no tab, so a takeover points at the Mac rather
 * than at a page, and a Space this browser has no key for shows the run's
 * shape with its content missing rather than pretending the run was quiet.
 *
 * The scroll behaviour — anchored turns, the peek at the previous message,
 * jump-to-latest — is shadcn's headless MessageScroller, as in the desktop.
 */

import { memo, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { MessageScroller } from "@shadcn/react/message-scroller";
import { Questionnaire } from "@shadcn/react/questionnaire";
import {
  AlarmClock,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bookmark,
  Bot,
  Brain,
  Check,
  ChevronDown,
  FileText,
  Fingerprint,
  Globe2,
  KeyRound,
  LayoutTemplate,
  ListTree,
  LogIn,
  Monitor,
  MousePointerClick,
  NotebookPen,
  PanelTop,
  ShieldCheck,
  Square,
  X,
  Plug,
} from "lucide-react";
import { isTerminalStatus, type AgentAttachment, type AgentToolCall, type RunSummary } from "@pistachio/protocol";
import {
  contextMeter,
  currentFamily,
  linkify,
  runHeadline,
  statusIndicator,
  statusLabel,
  toolFamily,
  traceLabel,
  traceTurns,
  workingText,
  type StatusTone,
  type ToolFamily,
  type TraceTurn,
} from "@pistachio/run-view";
import { cn } from "../../lib/utils";


/** What a person can do to a run from a browser (control's run commands). */
export interface RunActions {
  answer(questionId: string, value: string): void;
  /** Open the run's live view, when this run has one to open. */
  watch?(): void;
  interrupt(): void;
  release(): void;
  revoke(): void;
  send(text: string): void;
}

/** The console dot's colour per status tone, as on the desktop. */
const TONE_DOT: Record<StatusTone, string> = {
  idle: "bg-green-700",
  working: "bg-green-700",
  attention: "bg-amber-700",
  human: "bg-blue-700",
  stopped: "bg-red-700",
};

/** The brand mark: the same drawing the desktop console wears. */
function PistachioMark({ size }: { size: number }): ReactNode {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} fill="none" aria-hidden="true" className="block shrink-0">
      <rect width="48" height="48" rx="14" fill="#52a862" />
      <path
        d="M115.10 51.50A13.5 13.5 0 0 1 115.10 65.00L93.40 102.60A13.5 13.5 0 0 1 81.71 109.35L38.29 109.35A13.5 13.5 0 0 1 26.60 102.60L4.90 65.00A13.5 13.5 0 0 1 4.90 51.50L27.47 12.40A3.5 3.5 0 0 1 33.53 12.40L56.54 52.25A4 4 0 0 0 63.46 52.25L86.47 12.40A3.5 3.5 0 0 1 92.53 12.40Z"
        transform="translate(9.6 9.6) scale(0.24)"
        fill="#fff"
      />
    </svg>
  );
}

/**
 * Message text with its web links made clickable, inheriting the surrounding
 * colour so it reads the same inside a dark bubble. `pistachio://` links stay
 * plain text here: they address the Mac app, and a browser cannot follow them.
 */
function MessageText({ text }: { text: string }): ReactNode {
  const parts = useMemo(() => linkify(text), [text]);
  return (
    <>
      {parts.map((part, index) =>
        part.type === "text" ? (
          part.value
        ) : part.href.startsWith("pistachio:") ? (
          part.label
        ) : (
          <a
            key={index}
            href={part.href}
            title={part.href}
            target="_blank"
            rel="noreferrer noopener"
            className="underline decoration-current/40 underline-offset-2 transition-colors hover:decoration-current"
          >
            {part.label}
          </a>
        ),
      )}
    </>
  );
}

/** A turn's attached files: pictures render, everything else names itself. */
function MessageAttachments({
  attachments,
  align,
}: {
  attachments: AgentAttachment[];
  align: "start" | "end";
}): ReactNode {
  return (
    <div
      data-testid="message-attachments"
      className={cn("flex flex-wrap gap-1.5", align === "end" ? "justify-end" : "justify-start")}
    >
      {attachments.map((file) =>
        file.mediaType.startsWith("image/") ? (
          <a key={file.id} href={file.url} target="_blank" rel="noreferrer noopener" className="block w-fit max-w-full">
            <img
              src={file.url}
              alt={file.name}
              draggable={false}
              className="block h-auto max-h-48 w-auto max-w-full rounded-md shadow-border"
            />
          </a>
        ) : (
          <a
            key={file.id}
            href={file.url}
            download={file.name}
            className="flex h-8 max-w-40 items-center gap-1.5 rounded-sm bg-background-200 px-2 text-label-12 text-gray-900 no-underline shadow-border transition-colors hover:bg-gray-100"
          >
            <FileText className="size-3 shrink-0 text-gray-700" aria-hidden="true" />
            <span className="truncate">{file.name}</span>
          </a>
        ),
      )}
    </div>
  );
}

/* --------------------------------- header --------------------------------- */

/**
 * Who is working, on what, and how to stop them. The dot's tone is the
 * console's, so a run that reads "attention" on the Mac reads the same here.
 */
export function RunHeader({
  actions,
  onWatch,
  readOnly = false,
  run,
  title,
  watching = false,
}: {
  actions: RunActions;
  /** Absent when there is nothing to watch: not a cloud run, ended, or sealed. */
  onWatch?: (watching: boolean) => void;
  readOnly?: boolean;
  run: RunSummary | null;
  title: string;
  watching?: boolean;
}): ReactNode {
  const indicator = statusIndicator(run);
  const ended = run !== null && isTerminalStatus(run.status);
  const working = run !== null && !ended && run.status !== "interrupted" && run.status !== "human_control";
  return (
    <header className="flex items-center justify-between gap-4 border-b border-alpha-400 px-6 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          role="img"
          aria-label={`Pistachio — ${indicator.tooltip}`}
          title={indicator.tooltip}
          className="relative grid size-6 shrink-0 place-items-center"
        >
          <PistachioMark size={24} />
          <span
            data-testid="run-indicator"
            data-tone={indicator.tone}
            aria-hidden="true"
            className={cn(
              "absolute right-0 bottom-0 size-2 rounded-full border-2 border-background-100",
              TONE_DOT[indicator.tone],
              indicator.tone === "working" && "animate-pulse",
            )}
          />
        </span>
        {run === null ? (
          // The title arrives with the run, so until then the header holds its
          // place rather than showing a placeholder word that will be replaced.
          <div aria-hidden="true" className="grid min-w-0 gap-1.5 py-1">
            <span className="pa-skeleton h-3.5 w-44" />
            <span className="pa-skeleton h-2.5 w-24" />
          </div>
        ) : (
          <div className="grid min-w-0">
            <span className="truncate text-heading-14 text-gray-1000">{title}</span>
            <span
              data-testid="run-status"
              className={cn("truncate text-[11px] leading-4 text-gray-700", working && "agent-shimmer")}
            >
              {statusLabel(run.status)} · {String(run.turns)} turn{run.turns === 1 ? "" : "s"}
            </span>
          </div>
        )}
      </div>
      {run === null ? null : (
        <div className="flex shrink-0 items-center gap-2">
          {onWatch === undefined ? null : (
            <button
              type="button"
              className="pa-btn"
              aria-pressed={watching}
              data-variant={watching ? "primary" : "default"}
              data-testid="watch-toggle"
              title="Watch the cloud browser this run is working in"
              onClick={() => {
                onWatch(!watching);
              }}
            >
              <Monitor className="size-3.5" aria-hidden="true" />
              {watching ? "Stop watching" : "Watch"}
            </button>
          )}
          {ended || readOnly ? null : (
            <>
              <button
                type="button"
                className="pa-btn"
                data-testid="control-toggle"
                onClick={() => {
                  if (run.control === "human") actions.release();
                  else actions.interrupt();
                }}
              >
                {run.control === "human" ? "Give it back" : "Take control"}
              </button>
              <button
                type="button"
                className="pa-btn"
                data-variant="alert"
                data-testid="revoke-run"
                onClick={() => {
                  actions.revoke();
                }}
              >
                Stop this run
              </button>
            </>
          )}
        </div>
      )}
    </header>
  );
}

/* ------------------------------ the conversation -------------------------- */

/**
 * `locked` means this browser holds no key for the run's Space: control
 * relays the sealed events, nothing here can open them, and what survives is
 * the run's shape — which tool ran, and how it ended.
 */
export function RunThread({
  actions,
  locked,
  run,
}: {
  actions: RunActions;
  locked: boolean;
  run: RunSummary | null;
}): ReactNode {
  // One trace per model turn, keyed by the message each sits under. Grouping
  // walks every message for every turn, so it runs only when the parts it
  // reads changed — not on the status and clock fields every event touches.
  const messages = run?.messages;
  const toolCalls = run?.toolCalls;
  const subagents = run?.subagents;
  const { orphans, tracesAt } = useMemo(() => {
    const at = new Map<number, TraceTurn[]>();
    const loose: TraceTurn[] = [];
    if (messages === undefined || toolCalls === undefined || subagents === undefined) {
      return { orphans: loose, tracesAt: at };
    }
    for (const turn of traceTurns({ messages, toolCalls, subagents })) {
      // A trace whose anchor is past the last message has no message to sit
      // under. On the desktop that cannot happen; here it is the ordinary
      // case for a locked run, whose messages never opened.
      if (turn.anchor >= messages.length) {
        loose.push(turn);
        continue;
      }
      const turns = at.get(turn.anchor);
      if (turns === undefined) at.set(turn.anchor, [turn]);
      else turns.push(turn);
    }
    return { orphans: loose, tracesAt: at };
  }, [messages, toolCalls, subagents]);

  const lastCall = run?.toolCalls.at(-1);

  return (
    <MessageScroller.Provider autoScroll defaultScrollPosition="end" scrollPreviousItemPeek={56}>
      <MessageScroller.Root className="agent-thread relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <MessageScroller.Viewport
          className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
          aria-label="Run conversation"
        >
          <MessageScroller.Content
            className="mx-auto flex min-h-full w-full max-w-3xl shrink-0 flex-col px-6 py-6"
            aria-busy={run === null || run.status === "running"}
          >
            <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
              {run === null ? "Opening this conversation" : run.result == null ? "" : "Task completed"}
            </span>
            {run === null ? (
              <ThreadSkeleton />
            ) : (
              <>
                <div className="mb-5 flex items-center gap-2 text-[11px] font-medium text-gray-700">
                  <span className="h-px flex-1 bg-alpha-400" />
                  {run.origin?.kind === "reminder" ? (
                    <span className="flex min-w-0 items-center gap-1" data-testid="run-origin">
                      <AlarmClock className="size-3 shrink-0" aria-hidden="true" />
                      <span className="truncate">Scheduled · {run.origin.title}</span>
                    </span>
                  ) : run.origin?.kind === "channel" ? (
                    <span className="truncate" data-testid="run-origin">
                      From {run.origin.channelName}
                    </span>
                  ) : (
                    <span data-testid="run-headline">{runHeadline(run)}</span>
                  )}
                  <span className="h-px flex-1 bg-alpha-400" />
                </div>
                {locked ? <LockedNote /> : null}
                {run.notes.trim() === "" ? null : <TaskNotes run={run} />}
                {run.messages.map((message, index) => (
                  <MessageScroller.Item
                    key={message.id}
                    messageId={message.id}
                    scrollAnchor={message.role === "user"}
                    className="mb-4 min-w-0"
                  >
                    <MessageRow message={message} />
                    {(tracesAt.get(index) ?? []).map((turn) => (
                      <WorkTrace
                        key={turn.turn}
                        turn={turn}
                        latest={turn.toolCalls.at(-1) === lastCall}
                        awaitingApproval={run.status === "waiting_for_approval"}
                      />
                    ))}
                  </MessageScroller.Item>
                ))}
                {orphans.map((turn) => (
                  <MessageScroller.Item key={`trace-${String(turn.turn)}`} className="mb-4 min-w-0">
                    <WorkTrace
                      turn={turn}
                      latest={turn.toolCalls.at(-1) === lastCall}
                      awaitingApproval={run.status === "waiting_for_approval"}
                      unanchored
                    />
                  </MessageScroller.Item>
                ))}
                {run.pendingQuestion === null ? null : (
                  <MessageScroller.Item messageId={run.pendingQuestion.id} className="mb-4 min-w-0">
                    <ClarificationCard run={run} onAnswer={actions.answer} />
                  </MessageScroller.Item>
                )}
                {run.pendingTakeover === null ? null : (
                  <MessageScroller.Item messageId={run.pendingTakeover.id} className="mb-4 min-w-0">
                    <TakeoverCard run={run} actions={actions} />
                  </MessageScroller.Item>
                )}
                {run.pendingApproval === null ? null : (
                  <MessageScroller.Item messageId={run.pendingApproval.id} className="mb-4 min-w-0">
                    <ApprovalCard run={run} />
                  </MessageScroller.Item>
                )}
                {run.result === null ? null : (
                  <MessageScroller.Item messageId={`result-${run.runId}`} className="mb-2 min-w-0">
                    <CompletionMeta run={run} />
                  </MessageScroller.Item>
                )}
                {run.status === "running" ? (
                  <MessageScroller.Item messageId={`working-${run.runId}`} className="mb-2 min-w-0">
                    <div className="flex items-center gap-2 pl-9 text-copy-13 text-gray-700">
                      <span className="agent-thinking-dots" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="agent-shimmer" data-testid="working-text">
                        {workingText(run)}
                      </span>
                      <span
                        data-testid="context-meter"
                        className="ml-auto shrink-0 text-[11px] text-gray-700 tabular-nums"
                      >
                        {contextMeter(run.context)}
                      </span>
                    </div>
                  </MessageScroller.Item>
                ) : null}
              </>
            )}
          </MessageScroller.Content>
        </MessageScroller.Viewport>
        <MessageScroller.Button
          direction="end"
          className="absolute bottom-3 left-1/2 z-10 flex h-7 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full bg-gray-1000 px-3 text-label-12 font-medium whitespace-nowrap text-background-100 shadow-menu transition-[opacity,translate] inert:pointer-events-none inert:translate-y-2 inert:opacity-0"
        >
          <ArrowDown className="size-3.5" aria-hidden="true" /> Latest
        </MessageScroller.Button>
      </MessageScroller.Root>
    </MessageScroller.Provider>
  );
}

/**
 * Before the first event lands there is a run id and nothing else — but the
 * shape of what is coming is known, so the thread opens on its own furniture:
 * a request where the request will be, an answer under it, a fold beneath
 * that. The alternative was a paragraph explaining that a stream was being
 * followed, which the reader then watched get replaced by the conversation it
 * was standing in for.
 */
function ThreadSkeleton(): ReactNode {
  return (
    <div aria-hidden="true" className="flex min-w-0 flex-col" data-testid="thread-skeleton">
      <div className="mb-5 flex items-center gap-2">
        <span className="h-px flex-1 bg-alpha-400" />
        <span className="pa-skeleton h-3 w-36" />
        <span className="h-px flex-1 bg-alpha-400" />
      </div>
      <div className="mb-4 grid justify-items-end pl-10">
        <span className="pa-skeleton h-10 w-2/3 max-w-80 rounded-[17px_17px_4px_17px]" />
      </div>
      <div className="mb-4 grid grid-cols-[26px_1fr] gap-2.5">
        <span className="pa-skeleton size-6 rounded-lg" />
        <div className="grid gap-2 pt-1.5">
          <span className="pa-skeleton h-3 w-[94%]" />
          <span className="pa-skeleton h-3 w-[81%]" />
          <span className="pa-skeleton h-3 w-[43%]" />
        </div>
      </div>
      <span className="pa-skeleton ml-8 h-9 rounded-md" />
    </div>
  );
}

/** The run is readable in shape but not in content: this browser has no key. */
function LockedNote(): ReactNode {
  return (
    <div
      data-testid="locked-note"
      className="mb-5 flex min-w-0 items-start gap-2.5 rounded-md border border-alpha-400 bg-background-200/70 px-3 py-2.5"
    >
      <span className="mt-px grid size-5 shrink-0 place-items-center rounded-sm bg-background-100 text-gray-900 shadow-border">
        <KeyRound className="size-3" aria-hidden="true" />
      </span>
      <p className="text-copy-13 text-gray-900">
        This browser holds no key for this run&rsquo;s Space, so what it read and said stays sealed. What it did is
        below. Unlock with the password that Space was created under to see the rest.
      </p>
    </div>
  );
}

const MessageRow = memo(function MessageRow({ message }: { message: RunSummary["messages"][number] }): ReactNode {
  const attachments = message.attachments ?? [];
  if (message.role === "system") {
    return (
      <div className="flex min-w-0 items-center gap-2 px-1 text-label-12 text-gray-700">
        <span className="h-px min-w-3 flex-1 bg-alpha-400" />
        <span className="max-w-[84%] min-w-0 text-center leading-4 text-pretty wrap-anywhere">{message.content}</span>
        <span className="h-px min-w-3 flex-1 bg-alpha-400" />
      </div>
    );
  }
  if (message.role === "user") {
    return (
      <div className="grid min-w-0 justify-items-end gap-1.5 pl-10">
        {attachments.length === 0 ? null : <MessageAttachments attachments={attachments} align="end" />}
        {message.content === "" ? null : (
          <div className="max-w-[88%] rounded-[17px_17px_4px_17px] bg-gray-1000 px-3.5 py-2.5 text-copy-14 whitespace-pre-wrap wrap-anywhere text-background-100 shadow-small">
            <MessageText text={message.content} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="grid min-w-0 grid-cols-[26px_1fr] gap-2.5">
      <span className="grid size-6 place-items-center">
        <PistachioMark size={24} />
      </span>
      <div className="grid min-w-0 gap-1.5 pt-0.5 text-copy-14 wrap-anywhere text-gray-1000">
        {message.content === "" ? null : (
          <div className="whitespace-pre-wrap">
            <MessageText text={message.content} />
          </div>
        )}
        {attachments.length === 0 ? null : <MessageAttachments attachments={attachments} align="start" />}
      </div>
    </div>
  );
});

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

/* ---------------------------------- folds --------------------------------- */

/**
 * The recessed disclosures on the operational rail: a turn's tool trace, the
 * agent's pinned plan.
 *
 * Two rules here, and both are about not moving the conversation under the
 * reader. The summary is one fixed-height row whatever is happening inside, so
 * a turn that calls twenty tools stands exactly as tall as one that calls
 * none. And the body transitions open and shut rather than snapping — which is
 * why this is not the `<details>` it used to be: that element renders its body
 * only while open, so its collapse is a cut no transition can reach.
 *
 * What went with the `<details>` is the run driving `open`. A fold that springs
 * open on a turn's first tool call and slams shut on its last is the largest
 * jump in a live thread, and it happened once per turn.
 */
function Fold({
  badge,
  children,
  className,
  count,
  label,
  labelTestId,
  live = false,
  onOpenChange,
  open,
  testId,
  turn,
}: {
  /** The 12px glyph in the row's leading tile. */
  badge: ReactNode;
  children: ReactNode;
  className?: string;
  /** How many things are inside, when the closed row is worth counting. */
  count?: number;
  label: string;
  labelTestId?: string;
  /** Something inside is running, so the label reads as the ticker it is. */
  live?: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  testId?: string;
  turn?: number;
}): ReactNode {
  return (
    <div
      className={cn("agent-fold min-w-0 rounded-md border border-alpha-400 bg-background-200/70", className)}
      data-open={open ? "" : undefined}
      data-testid={testId}
      data-turn={turn}
    >
      <button
        type="button"
        aria-expanded={open}
        className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-label-12 font-medium text-gray-900 transition-colors hover:bg-alpha-100"
        onClick={() => {
          onOpenChange(!open);
        }}
      >
        <span
          className={cn(
            "grid size-5 shrink-0 place-items-center rounded-sm bg-background-100 shadow-border transition-colors",
            live ? "text-blue-900" : "text-gray-900",
          )}
        >
          {badge}
        </span>
        <span className={cn("truncate", live && "agent-shimmer")} data-testid={labelTestId}>
          {label}
        </span>
        {count === undefined ? null : (
          <span className="ml-auto shrink-0 text-gray-700 tabular-nums">{count}</span>
        )}
        <ChevronDown
          aria-hidden="true"
          className={cn("agent-fold-chevron size-3.5 shrink-0", count === undefined && "ml-auto")}
        />
      </button>
      {/* Kept mounted while closed — a body that unmounts has no height to
          transition from — and inert, so it is out of the tab order and out of
          the accessibility tree until it is actually open. */}
      <div className="agent-fold-body" inert={!open}>
        <div>
          <div className="border-t border-alpha-400">{children}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * The agent's pinned plan: what it wrote to keep for itself across steps and
 * compactions. It opens itself once, on a run that is still going, and after
 * that it is the reader's — a fold that re-decides on every publish is a fold
 * that moves on its own.
 */
function TaskNotes({ run }: { run: RunSummary }): ReactNode {
  const [open, setOpen] = useState(!isTerminalStatus(run.status));
  return (
    <Fold
      badge={<NotebookPen className="size-3" aria-hidden="true" />}
      className="mb-5"
      label="Plan & notes"
      onOpenChange={setOpen}
      open={open}
      testId="task-notes"
    >
      <div
        data-testid="task-notes-text"
        className="scroll-thin max-h-64 overflow-y-auto px-3 py-2.5 text-copy-13 whitespace-pre-wrap wrap-anywhere text-gray-1000"
      >
        <MessageText text={run.notes} />
      </div>
    </Fold>
  );
}

/**
 * One model turn's work, on the recessed operational rail: what ran, on which
 * surface, and how each call ended. Memoized on the turn rather than the run —
 * the run object changes on every event, the turn only when one of its tool
 * calls does.
 *
 * Closed is the resting state, even while the turn is working. The summary row
 * already names the tool that is running, so an open list of them buys the
 * reader nothing but a conversation that walks down the screen one row at a
 * time. It opens for a run that has stopped in front of something, and then
 * stays open: this never latches shut, because closing itself is the jump.
 */
const WorkTrace = memo(function WorkTrace({
  awaitingApproval,
  latest,
  turn,
  unanchored = false,
}: {
  awaitingApproval: boolean;
  latest: boolean;
  turn: TraceTurn;
  /** No message to sit under, so it carries no indent of its own. */
  unanchored?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const attention = latest && awaitingApproval;
  useEffect(() => {
    if (attention) setOpen(true);
  }, [attention]);

  const running = turn.toolCalls.filter((tool) => tool.status === "running");
  const family = currentFamily(turn);
  const TraceIcon = family === null ? ListTree : FAMILY_ICON[family];
  // A running tool names itself on the closed row, the way it would on the row
  // it occupies inside. A sealed run has no label to give, so both it and a
  // turn at rest fall back to the shared summary wording.
  const active = running.at(-1);
  const label = active !== undefined && active.label !== "" ? active.label : traceLabel(turn);

  return (
    <Fold
      badge={<TraceIcon className="size-3" aria-hidden="true" />}
      className={cn("mt-3", unanchored ? "mt-0" : "ml-8")}
      count={turn.toolCalls.length + turn.subagents.length}
      label={label}
      labelTestId="trace-label"
      live={running.length > 0}
      onOpenChange={setOpen}
      open={open}
      testId="work-trace"
      turn={turn.turn}
    >
      <div className="px-2.5 py-1.5">
        {turn.toolCalls.map((tool) => (
          <ToolRow key={tool.id} tool={tool} />
        ))}
        {turn.subagents.map((agent) => (
          <div key={agent.id} className="grid min-w-0 grid-cols-[20px_1fr_auto] gap-2 py-2">
            <span className="grid size-5 place-items-center rounded-full bg-blue-100 text-blue-900">
              <Bot className="size-3" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <strong className="block truncate text-label-12 font-medium text-gray-1000">{agent.name}</strong>
              <span className="block truncate text-[11px] leading-4 text-gray-700">{agent.detail}</span>
            </div>
            <span
              className={cn(
                "shrink-0 self-start rounded-full px-1.5 py-px text-[10px] leading-4 font-medium",
                agent.status === "completed" ? "bg-green-100 text-green-900" : "bg-blue-100 text-blue-900",
              )}
            >
              {agent.status}
            </span>
          </div>
        ))}
      </div>
    </Fold>
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

const ToolRow = memo(function ToolRow({ tool }: { tool: AgentToolCall }): ReactNode {
  // Non-browser families wear the badge their trace does; the browser family
  // keeps its own set so a click and a submit read differently.
  const family = toolFamily(tool.name);
  const Icon = family === "browser" ? browserToolIcon(tool.name) : FAMILY_ICON[family];
  return (
    <div className="grid min-w-0 grid-cols-[20px_1fr_auto] gap-2 py-2">
      <span className="grid size-5 place-items-center text-gray-700">
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <strong className="block truncate text-label-12 font-medium text-gray-1000">{tool.label}</strong>
        {/* Sealed for a reader without the key, which is why it can be empty. */}
        {tool.detail === "" ? null : (
          <span className="block truncate text-[11px] leading-4 text-gray-700">{tool.detail}</span>
        )}
      </div>
      <ToolStatus status={tool.status} />
    </div>
  );
});

function ToolStatus({ status }: { status: AgentToolCall["status"] }): ReactNode {
  if (status === "completed") return <Check className="mt-0.5 size-3.5 text-green-900" aria-label="Completed" />;
  if (status === "running")
    return <span className="mt-1 size-2 animate-pulse rounded-full bg-blue-700" aria-label="Running" />;
  if (status === "paused") return <span className="mt-1 size-2 rounded-full bg-amber-700" aria-label="Paused" />;
  return <X className="mt-0.5 size-3.5 text-red-900" aria-label="Failed" />;
}

/* --------------------------------- the pauses ----------------------------- */

/** The agent asked which way to go. Answering resumes the run. */
function ClarificationCard({
  onAnswer,
  run,
}: {
  onAnswer: (questionId: string, value: string) => void;
  run: RunSummary;
}): ReactNode {
  const question = run.pendingQuestion;
  const items = useMemo(
    () => [{ name: "direction", required: true, choices: question?.choices ?? [] }],
    [question?.choices],
  );
  if (question === null) return null;
  const textInput = question.input?.type === "text" ? question.input : null;
  const wantsText = textInput !== null;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("direction") ?? "").trim();
    if (value !== "") onAnswer(question.id, value);
  };
  return (
    <div
      className="agent-ask ml-8 min-w-0 rounded-lg border border-alpha-500 bg-background-100 p-3.5 shadow-small"
      data-testid="questionnaire-card"
    >
      <Questionnaire.Root items={items} shortcuts={wantsText ? undefined : "numbers"} onSubmit={submit}>
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
                    className="grid min-w-0 cursor-pointer grid-cols-[16px_1fr_auto] items-start gap-2 rounded-md border border-alpha-400 px-2.5 py-2.5 transition-colors has-checked:border-gray-1000 has-checked:bg-gray-100"
                  >
                    <Questionnaire.ChoiceInput className="mt-0.5 size-3.5 appearance-none rounded-full border border-gray-700 bg-background-100 checked:border-[4px] checked:border-gray-1000" />
                    <Questionnaire.ChoiceLabel className="grid min-w-0">
                      <span className="text-label-13 font-medium wrap-anywhere text-gray-1000">{choice.label}</span>
                      <span className="mt-0.5 text-[11px] leading-4 wrap-anywhere text-gray-700">{choice.description}</span>
                    </Questionnaire.ChoiceLabel>
                    <Questionnaire.ChoiceShortcut className="font-mono text-[10px] text-gray-700" />
                  </Questionnaire.Choice>
                ))}
                <Questionnaire.Input
                  aria-label="Another direction"
                  placeholder="Or describe another direction…"
                  className="h-9 rounded-md border border-alpha-400 bg-background-100 px-2.5 text-label-13 text-gray-1000 outline-none transition-shadow placeholder:text-gray-700 hover:border-gray-500 focus:border-gray-1000 focus:shadow-[0_0_0_3px_var(--color-alpha-200)]"
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

/**
 * The agent either needs a model-blind sensitive-field handoff or hit a
 * person-bound browser action it cannot operate. A browser takeover uses the
 * run's live view; a credential handoff keeps the agent in control.
 */
function TakeoverCard({ actions, run }: { actions: RunActions; run: RunSummary }): ReactNode {
  const takeover = run.pendingTakeover;
  if (takeover === null) return null;
  if (takeover.kind === "credentials") {
    return (
      <section data-testid="takeover-card" aria-label="Secure information requested"
        className="ml-8 min-w-0 overflow-hidden rounded-lg border border-blue-400 bg-background-100 shadow-small">
        <CredentialCapture captureId={takeover.captureId} inline />
      </section>
    );
  }
  return (
    <section
      data-testid="takeover-card"
      className="ml-8 min-w-0 overflow-hidden rounded-lg border border-blue-400 bg-background-100 shadow-small"
    >
      <div className="flex items-start gap-2.5 bg-blue-100 px-3.5 py-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-blue-700 text-white">
          <LogIn className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <span className="block text-[11px] font-medium tracking-wide text-blue-900 uppercase">
            Your turn in the browser
          </span>
          <strong className="mt-0.5 block text-heading-14 wrap-anywhere text-gray-1000">
            {takeover.reason}
          </strong>
        </div>
      </div>
      <div className="p-3.5">
        <p className="text-copy-13 wrap-anywhere text-gray-900">
          {takeover.instructions}
        </p>
        <p className="mt-2 text-[11px] leading-4 text-gray-700">
          This run works in the cloud browser, so its page is not one of your tabs.{" "}
          {actions.watch === undefined
            ? "Take control and do this on a device that can see it, then hand it back."
            : "Take control, do it in the live view, then hand it back."}{" "}
          Don&rsquo;t share passwords, verification codes, or payment details in chat.
        </p>
        {actions.watch === undefined ? null : (
          <button
            type="button"
            className="pa-btn mt-2.5 w-full"
            data-testid="takeover-live-view"
            onClick={() => {
              actions.watch?.();
            }}
          >
            <Monitor className="size-3.5" aria-hidden="true" />
            Open the live view
          </button>
        )}
        {run.control === "human" ? (
          <button
            type="button"
            className="pa-btn mt-3 w-full"
            data-variant="primary"
            data-testid="resume-after-takeover"
            onClick={() => {
              actions.release();
            }}
          >
            {takeover.resumeLabel}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="pa-btn mt-3 w-full"
            data-testid="take-control"
            onClick={() => {
              actions.interrupt();
            }}
          >
            Take control
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * A consequential action the run stopped in front of. Approving is the Mac's
 * to give — the policy that judges it, and the key that seals the evidence,
 * both live there — so here it says what is pending and who can answer it.
 */
function ApprovalCard({ run }: { run: RunSummary }): ReactNode {
  const approval = run.pendingApproval;
  if (approval === null) return null;
  const evidence = approval.evidence;
  return (
    <section
      data-testid="approval-card"
      className="ml-8 min-w-0 overflow-hidden rounded-lg border border-amber-400 bg-background-100 shadow-small"
    >
      <div className="flex items-start gap-2.5 bg-amber-100 px-3.5 py-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-amber-700 text-black">
          <Fingerprint className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <span className="block text-[11px] font-medium tracking-wide text-amber-900 uppercase">
            Needs approval
          </span>
          <strong className="mt-0.5 block text-heading-14 wrap-anywhere text-gray-1000">
            {evidence.action === "" ? "An action is waiting" : evidence.action}
          </strong>
        </div>
      </div>
      <div className="p-3.5">
        {evidence.summary === "" ? null : (
          <p className="text-copy-13 wrap-anywhere text-gray-900">{evidence.summary}</p>
        )}
        <div className="mt-3 flex items-center gap-2 text-[11px] text-gray-700">
          <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
          One action · {evidence.reversible ? "Reversible" : "Cannot be undone"}
        </div>
        <p className="mt-3 text-[11px] leading-4 text-gray-700">
          Approve it on your Mac, where the policy that judges it runs. From here you can stop the run instead.
        </p>
      </div>
    </section>
  );
}

/**
 * Completion is metadata for the answer above it, not a second answer: the
 * summary is already in the conversation, so this is the status and the
 * trail it left.
 */
function CompletionMeta({ run }: { run: RunSummary }): ReactNode {
  const result = run.result;
  if (result === null) return null;
  const records = `${String(result.evidenceEntries)} activity ${result.evidenceEntries === 1 ? "record" : "records"}`;
  return (
    <div
      data-testid="completion-meta"
      className="ml-9 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-label-12 text-gray-700"
    >
      <span className="flex h-6 shrink-0 items-center gap-1.5 font-medium text-green-900">
        <Check className="size-3.5" aria-hidden="true" />
        Completed
      </span>
      <span className="text-alpha-800" aria-hidden="true">
        ·
      </span>
      <span>{records}</span>
      {result.capsuleRevoked ? (
        <>
          <span className="text-alpha-800" aria-hidden="true">
            ·
          </span>
          <span>Authority revoked</span>
        </>
      ) : null}
    </div>
  );
}

/* -------------------------------- the composer ---------------------------- */

/**
 * The same box whether the run is working or waiting: what you type steers it
 * mid-flight, and an explicit follow-up reopens an interrupted or ended run
 * in this same conversation.
 */
export function RunComposer({ actions, run }: { actions: RunActions; run: RunSummary | null }): ReactNode {
  const [value, setValue] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  // Nothing typed before the run opens can be sent anywhere, and a box that
  // accepts what it will drop is worse than one that waits.
  const loading = run === null;
  const ended = run !== null && isTerminalStatus(run.status);
  const live = run !== null && !ended && run.control === "agent" && run.status !== "interrupted";

  const submit = (): void => {
    const text = value.trim();
    if (text === "") return;
    setValue("");
    actions.send(text);
  };

  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pt-2 pb-6">
      {/* The box, not the textarea inside it, carries the focus state for the
          whole control — app.css suppresses the second, blue outline the
          dashboard used to draw around the textarea on top of this one. That
          makes this the only thing a keyboard user has to go on, so it states
          focus at full contrast rather than the hairline it was. */}
      <form
        className="agent-composer rounded-[14px] border border-alpha-500 bg-background-100 p-1.5 shadow-small focus-within:border-gray-1000 focus-within:shadow-[0_0_0_3px_var(--color-alpha-300)]"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={input}
          rows={1}
          data-testid="run-message"
          aria-label={live ? "Steer the agent" : "Message the agent"}
          disabled={loading}
          placeholder={
            loading ? "Opening this conversation…" : live ? "Steer the agent…" : "Follow up in this conversation…"
          }
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          className="scroll-thin field-sizing-content max-h-32 w-full resize-none overflow-y-auto border-0 bg-transparent px-2 py-1.5 text-copy-14 text-gray-1000 outline-none placeholder:text-gray-700 disabled:cursor-not-allowed"
        />
        <div className="flex items-center justify-between gap-2 px-0.5 pb-0.5">
          {run === null ? (
            <span aria-hidden="true" className="pa-skeleton ml-1.5 h-3 w-40" />
          ) : (
            <span className="pl-1.5 text-[11px] leading-4 text-gray-700">
              {ended
                ? "Send to continue this conversation"
                : run.control === "human"
                  ? "You have control"
                  : "Enter to send"}
            </span>
          )}
          <div className="flex items-center gap-1">
            {live ? (
              <button
                type="button"
                aria-label="Stop this run"
                title="Stop this run"
                data-testid="composer-stop"
                onClick={() => {
                  actions.revoke();
                }}
                className="grid size-7 cursor-pointer place-items-center rounded-md text-gray-700 transition-colors hover:bg-alpha-100 hover:text-gray-1000"
              >
                <Square className="size-3.5 fill-current" aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="submit"
              aria-label="Send"
              disabled={value.trim() === ""}
              className="grid size-7 cursor-pointer place-items-center rounded-md bg-gray-1000 text-background-100 transition-opacity disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ArrowUp className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
