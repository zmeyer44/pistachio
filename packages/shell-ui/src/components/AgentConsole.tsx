import { TakeoverCard } from "./TakeoverCard";
import {
  type FormEvent,
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MessageScroller } from "@shadcn/react/message-scroller";
import { Questionnaire } from "@shadcn/react/questionnaire";
import {
  AlarmClock,
  ArrowDown,
  ArrowRight,
  Bookmark,
  Bot,
  Brain,
  Check,
  ChevronDown,
  Copy,
  CircleStop,
  Cloud,
  FileClock,
  FileText,
  LayoutTemplate,
  Fingerprint,
  Globe2,
  ListTree,
  Loader2,
  Maximize2,
  Mic,
  Monitor,
  MousePointerClick,
  Navigation,
  NotebookPen,
  PanelRightClose,
  PanelTop,
  Paperclip,
  RotateCcw,
  ArrowUp,
  ShieldCheck,
  Sparkles,
  SquarePen,
  TextQuote,
  Square,
  Volume2,
  X,
  Plug,
} from "lucide-react";
import type { EvidenceEntry } from "@pistachio/evidence";
import type {
  AgentAttachment,
  AgentToolCall,
  AgentToolOutput,
  RunSummary,
  ThreadListItem,
} from "@pistachio/protocol";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import { shortcutLabel } from "@pistachio/shell-contracts/shortcuts";
import {
  composerAttachmentFromInsert,
  formatAttachmentText,
  formatSelectionText,
  selectionChipLabel,
  MAX_COMPOSER_ATTACHMENTS,
  readComposerAttachment,
  toAgentAttachments,
  type ComposerAttachment,
} from "../lib/chat-attachments";
import { cn } from "../lib/cn";
import { blobToBase64, startRecording, type Recorder } from "../lib/recorder";
import {
  agentIsActing,
  contextMeter,
  currentFamily,
  endTaskLabel,
  runHeadline,
  statusIndicator,
  statusLabel,
  toolFamily,
  traceLabel,
  traceTurns,
  turnOutputs,
  turnReplyIndex,
  workingText,
  type ToolFamily,
  type TraceTurn,
} from "../lib/run";
import { cloudReadiness, isCloudRun } from "../lib/cloud";
import { selectActiveTab, useAppStore } from "../store";
import { FeedbackPopover } from "./FeedbackPopover";
import { MessageText } from "./MessageText";
import { OutputCards } from "./OutputCard";
import { PanelShell } from "./PanelShell";
import { PistachioMark } from "./PistachioMark";
import { ReminderInbox } from "./reminders/ReminderInbox";
import { TONE_DOT } from "./StatusDot";
import { RecentThreads, ThreadListPopover } from "./ThreadList";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { nativeApi, shellApi } from "../api";

const TERMINAL = new Set<RunSummary["status"]>([
  "completed",
  "rejected",
  "revoked",
  "failed",
]);

/** A forgotten mic in the composer stops itself, same as the wizard's. */
const MAX_DICTATION_SECONDS = 120;

/** Bars kept in the dictation waveform; older samples scroll off the left. */
const WAVE_BARS = 56;

function dictationClock(totalSeconds: number): string {
  const whole = Math.floor(totalSeconds);
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, "0")}`;
}

/** A persistent chat beside the live page. Work never leaves for another tab. */
const EMPTY_THREADS: ThreadListItem[] = [];

/**
 * The console selects the run, the thread list, and the active tab on its
 * own. The store keeps every unchanged reference across publishes
 * (lib/share.ts), so a title tick in another tab, a favicon, or a pane
 * resize reaches none of the conversation below — AgentPanel is memoized on
 * exactly these three.
 */
export function AgentConsole() {
  const consoleOpen = useAppStore((state) => state.consoleOpen);
  const run = useAppStore((state) => state.snapshot?.run ?? null);
  const threads = useAppStore((state) => state.snapshot?.threads ?? EMPTY_THREADS);
  const activeTab = useAppStore(selectActiveTab);
  return (
    <PanelShell
      open={consoleOpen}
      label="Pistachio agent"
      data-testid="agent-panel"
    >
      <AgentPanel run={run} threads={threads} activeTab={activeTab} />
    </PanelShell>
  );
}

const AgentPanel = memo(function AgentPanel({
  run,
  threads,
  activeTab,
}: {
  run: RunSummary | null;
  threads: ThreadListItem[];
  activeTab: BrowserTabInfo | null;
}) {
  const evidence = useAppStore((state) => state.evidence);
  const closeEvidence = useAppStore((state) => state.closeEvidence);
  const newThread = useAppStore((state) => state.newThread);
  const drop = useAttachmentDrop();

  // A fresh conversation starts from a clean console: no replay left open,
  // nothing staged from the one before.
  const startNewThread = () => {
    closeEvidence();
    drop.setStaged([]);
    void newThread();
  };

  return (
    <>
      <AgentHeader run={run} threads={threads} onNewThread={startNewThread} />
      {evidence !== null ? (
        <EvidenceReplay entries={evidence} onClose={closeEvidence} />
      ) : (
        <div
          {...drop.handlers}
          className="relative grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-background-100"
        >
          {/* Drop feedback. pointer-events-none so the drop still lands on
              the panel underneath rather than on this veil. */}
          {drop.dragging ? (
            <div
              data-testid="attachment-drop-veil"
              className="animate-backdrop-in pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-lg border-2 border-dashed border-blue-700 bg-blue-100/70"
            >
              <span className="flex items-center gap-1.5 rounded-full bg-background-100 px-3 py-1.5 text-label-13 font-medium text-blue-900 shadow-menu">
                <Paperclip className="size-3.5" aria-hidden="true" />
                Drop files to attach
              </span>
            </div>
          ) : null}
          <Conversation run={run} threads={threads} activeTab={activeTab} />
          <Composer
            run={run}
            activeTab={activeTab}
            staged={drop.staged}
            setStaged={drop.setStaged}
            addFiles={drop.addFiles}
            rejection={drop.rejection}
            reject={drop.reject}
            dismissRejection={drop.dismissRejection}
          />
        </div>
      )}
    </>
  );
});

/**
 * Files dropped anywhere on the panel, staged for the next message.
 *
 * `depth` counts enter/leave pairs — dragging across the panel's children
 * fires leave/enter at every element boundary, and a plain boolean would
 * flicker the veil off each time. Rejections surface in the composer rather
 * than as a global error: the shell's error banner has no dismissal and
 * pushes the native tab views down, which is far too much for "that file is
 * too big".
 */
function useAttachmentDrop() {
  const [staged, setStaged] = useState<ComposerAttachment[]>([]);
  const [depth, setDepth] = useState(0);
  const [rejection, setRejection] = useState<string | null>(null);
  const chatInbox = useAppStore((state) => state.chatInbox);
  const takeChatInbox = useAppStore((state) => state.takeChatInbox);

  // "Add … to Chat" from a page's right-click menu lands here, staged like a
  // drop. The inbox is drained on arrival — and on mount, for the case where
  // choosing the item is what opened the console.
  useEffect(() => {
    if (chatInbox.inserts.length === 0 && chatInbox.rejection === null) return;
    const inbox = takeChatInbox();
    const room = Math.max(0, MAX_COMPOSER_ATTACHMENTS - staged.length);
    const accepted = inbox.inserts.slice(0, room);
    if (inbox.rejection !== null) setRejection(inbox.rejection);
    else if (accepted.length < inbox.inserts.length)
      setRejection(
        `At most ${String(MAX_COMPOSER_ATTACHMENTS)} files per message`,
      );
    if (accepted.length > 0)
      setStaged((prev) => [
        ...prev,
        ...accepted.map(composerAttachmentFromInsert),
      ]);
    document
      .getElementById("delegation-intent")
      ?.focus({ preventScroll: true });
  }, [chatInbox, staged.length, takeChatInbox]);

  const addFiles = async (list: FileList): Promise<void> => {
    const dropped = Array.from(list);
    // Read against the count at drop time; `staged` is stale inside the loop.
    let room = MAX_COMPOSER_ATTACHMENTS - staged.length;
    if (room <= 0) {
      setRejection(
        `At most ${String(MAX_COMPOSER_ATTACHMENTS)} files per message`,
      );
      return;
    }
    setRejection(
      dropped.length > room
        ? `Attached the first ${String(room)} — at most ${String(MAX_COMPOSER_ATTACHMENTS)} files per message`
        : null,
    );
    for (const file of dropped) {
      if (room <= 0) break;
      try {
        const result = await readComposerAttachment(file);
        if (result.ok) {
          room -= 1;
          setStaged((prev) => [...prev, result.attachment]);
        } else {
          setRejection(result.reason);
        }
      } catch {
        setRejection(`Could not read ${file.name}`);
      }
    }
    document
      .getElementById("delegation-intent")
      ?.focus({ preventScroll: true });
  };

  const carriesFiles = (event: React.DragEvent): boolean =>
    event.dataTransfer.types.includes("Files");

  return {
    staged,
    setStaged,
    addFiles,
    rejection,
    reject: (message: string) => setRejection(message),
    dismissRejection: () => setRejection(null),
    dragging: depth > 0,
    handlers: {
      onDragEnter: (event: React.DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDepth((current) => current + 1);
      },
      onDragOver: (event: React.DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (event: React.DragEvent) => {
        if (!carriesFiles(event)) return;
        setDepth((current) => Math.max(0, current - 1));
      },
      onDrop: (event: React.DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDepth(0);
        void addFiles(event.dataTransfer.files);
      },
    },
  };
}

function AgentHeader({
  run,
  threads,
  onNewThread,
}: {
  run: RunSummary | null;
  threads: ThreadListItem[];
  onNewThread(): void;
}) {
  const loadEvidence = useAppStore((state) => state.loadEvidence);
  const openLiveView = useAppStore((state) => state.openLiveView);
  // A host that cannot open a live view at all keeps the button off the
  // header rather than offering one that raises a dead overlay (§11): on a
  // streamed surface the PANE is the live view, so `openLiveView` answers
  // `unsupported` and the store remembers it the first time anything asks.
  const liveViewUnavailable = useAppStore((state) => state.unavailable["openLiveView"] ?? null);
  const openReminders = useAppStore((state) => state.openReminders);
  const scheduled = useAppStore((state) =>
    state.reminders.reminders.some((reminder) => reminder.status === "active"),
  );
  const setConsoleOpen = useAppStore((state) => state.setConsoleOpen);
  const closeShortcut = useAppStore(
    (state) => state.settings.shortcuts.toggleConsole,
  );
  const closeHint = shortcutLabel(
    closeShortcut,
    /Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : "other",
  );
  const working =
    run !== null &&
    !TERMINAL.has(run.status) &&
    run.status !== "interrupted" &&
    run.status !== "human_control";
  const label = run === null ? "Ready" : statusLabel(run.status);
  const indicator = statusIndicator(run);
  return (
    <header className="relative flex items-center justify-between border-b border-alpha-400 px-3.5">
      <div className="flex min-w-0 items-center gap-2.5">
        {/* The mark and its dot are one thing to a reader, so they carry one
            label; the bubble below is the sighted half of the same sentence. */}
        <span
          role="img"
          aria-label={`Pistachio — ${indicator.tooltip}`}
          className="group/status relative grid size-6 shrink-0 place-items-center"
        >
          <PistachioMark size={24} />
          <span
            data-testid="run-indicator"
            data-tone={indicator.tone}
            className={cn(
              "absolute right-0 bottom-0 size-2 rounded-full border-2 border-background-100",
              TONE_DOT[indicator.tone],
              indicator.tone === "working" && "animate-pulse",
            )}
            aria-hidden="true"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-full left-0 z-20 mt-1.5 w-max max-w-56 rounded-sm bg-gray-1000 px-2 py-1 text-[11px] leading-4 text-background-100 opacity-0 shadow-menu transition-opacity duration-150 group-hover/status:opacity-100"
          >
            {indicator.tooltip}
          </span>
        </span>
        <div className="grid min-w-0">
          <span className="truncate text-heading-14 text-gray-1000">
            Pistachio
          </span>
          <span
            data-testid="run-status"
            className={cn(
              "truncate text-[11px] leading-3 text-gray-700",
              working && "agent-shimmer",
            )}
          >
            {label}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="tertiary"
          size="xs"
          svgOnly
          aria-label="Open reminders"
          title="Reminders"
          data-testid="console-reminders"
          className="relative"
          onClick={() => openReminders()}
        >
          <AlarmClock aria-hidden="true" />
          {scheduled ? (
            <span
              aria-hidden="true"
              className="absolute top-1 right-1 size-1.5 rounded-full bg-green-700"
            />
          ) : null}
        </Button>
        {run === null || !isCloudRun(run) || liveViewUnavailable !== null ? null : (
          <Button
            variant="tertiary"
            size="xs"
            svgOnly
            aria-label="Watch this run in the cloud browser"
            title="This run works in the cloud browser — watch it live"
            data-testid="open-live-view"
            onClick={() => void openLiveView(run.runId)}
          >
            <Monitor aria-hidden="true" />
          </Button>
        )}
        {run === null ? null : (
          <Button
            variant="tertiary"
            size="xs"
            svgOnly
            aria-label="View activity record"
            onClick={() => void loadEvidence()}
          >
            <FileClock aria-hidden="true" />
          </Button>
        )}
        <ThreadListPopover
          threads={threads}
          currentRunId={run === null ? null : run.runId}
          // A cloud run holds no tab and no console lock on this Mac, so main
          // does not refuse to swap away from it — and neither does the list.
          busy={agentIsActing(run) && !isCloudRun(run)}
        />
        <Button
          variant="tertiary"
          size="xs"
          svgOnly
          aria-label="New conversation"
          title="New conversation"
          data-testid="new-conversation"
          onClick={onNewThread}
        >
          <SquarePen aria-hidden="true" />
        </Button>
        <Button
          variant="tertiary"
          size="xs"
          svgOnly
          aria-label="Close agent panel"
          title={
            closeHint === null
              ? "Close agent panel"
              : `Close agent panel · ${closeHint}`
          }
          data-testid="console-close"
          onClick={() => setConsoleOpen(false)}
        >
          <PanelRightClose aria-hidden="true" />
        </Button>
        <FeedbackPopover />
      </div>
    </header>
  );
}

function Conversation({
  run,
  threads,
  activeTab,
}: {
  run: RunSummary | null;
  threads: ThreadListItem[];
  activeTab: BrowserTabInfo | null;
}) {
  // One trace per model turn, keyed by the message each sits under. Grouping
  // walks every message for every turn, so it runs only when the parts it
  // reads changed — not on the status and clock fields every publish touches.
  const messages = run?.messages;
  const toolCalls = run?.toolCalls;
  const subagents = run?.subagents;
  const { tracesAt, outputsAt, pendingOutputs } = useMemo(() => {
    const tracesAt = new Map<number, TraceTurn[]>();
    // What each turn made sits under the reply that finished it; until that
    // reply is written, under the turn's own trace.
    const outputsAt = new Map<number, AgentToolOutput[]>();
    const pendingOutputs = new Map<number, AgentToolOutput[]>();
    if (messages === undefined || toolCalls === undefined || subagents === undefined) return { tracesAt, outputsAt, pendingOutputs };
    for (const turn of traceTurns({ messages, toolCalls, subagents })) {
      const turns = tracesAt.get(turn.anchor);
      if (turns === undefined) tracesAt.set(turn.anchor, [turn]);
      else turns.push(turn);
      const outputs = turnOutputs(turn.toolCalls);
      if (outputs.length === 0) continue;
      const reply = turnReplyIndex(messages, turn.turn);
      if (reply === -1) pendingOutputs.set(turn.turn, outputs);
      else outputsAt.set(reply, [...(outputsAt.get(reply) ?? []), ...outputs]);
    }
    return { tracesAt, outputsAt, pendingOutputs };
  }, [messages, toolCalls, subagents]);
  return (
    <MessageScroller.Provider
      autoScroll
      defaultScrollPosition="end"
      scrollPreviousItemPeek={56}
    >
      <MessageScroller.Root className="agent-thread relative flex min-h-0 min-w-0 flex-col overflow-hidden">
        <MessageScroller.Viewport
          className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
          aria-label="Agent conversation"
        >
          <MessageScroller.Content
            className="flex min-h-full min-w-0 shrink-0 flex-col px-4 py-5"
            aria-busy={run?.status === "running"}
          >
            <span
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="sr-only"
            >
              {run?.result === null || run?.result === undefined
                ? ""
                : "Task completed"}
            </span>
            <ReminderInbox />
            {run === null ? (
              <Welcome activeTab={activeTab} threads={threads} />
            ) : (
              <>
                <div className="mb-5 flex items-center gap-2 text-[11px] font-medium text-gray-700">
                  <span className="h-px flex-1 bg-alpha-400" />
                  {run.origin?.kind !== "reminder" ? (
                    <span data-testid="run-headline">{runHeadline(run)}</span>
                  ) : (
                    <span
                      className="flex min-w-0 items-center gap-1"
                      data-testid="run-origin"
                      title={`Scheduled for ${formatTime(run.origin.scheduledFor)}`}
                    >
                      <AlarmClock
                        className="size-3 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="truncate">
                        Scheduled · {run.origin.title}
                      </span>
                    </span>
                  )}
                  <span className="h-px flex-1 bg-alpha-400" />
                </div>
                {run.notes.trim() === "" ? null : <TaskNotes run={run} />}
                {run.messages.map((message, index) => (
                  <MessageScroller.Item
                    key={message.id}
                    messageId={message.id}
                    scrollAnchor={message.role === "user"}
                    className="mb-4 min-w-0"
                  >
                    <MessageRow
                      message={message}
                      outputs={outputsAt.get(index)}
                      // Retry belongs to the last reply of a settled local
                      // thread, as regenerate does elsewhere: while the
                      // agent acts the turn is steered, not redone.
                      canRetry={
                        message.role === "assistant" &&
                        index === run.messages.length - 1 &&
                        !agentIsActing(run) &&
                        run.status !== "waiting_for_judgment" &&
                        run.status !== "waiting_for_approval" &&
                        run.status !== "human_control" &&
                        !isCloudRun(run)
                      }
                    />
                    {(tracesAt.get(index) ?? []).map((turn) => (
                      <Fragment key={turn.turn}>
                        <WorkTrace
                          turn={turn}
                          latest={turn.toolCalls.at(-1) === run.toolCalls.at(-1)}
                          awaitingApproval={run.status === "waiting_for_approval"}
                        />
                        {pendingOutputs.has(turn.turn) ? (
                          <div className="mt-3">
                            <OutputCards outputs={pendingOutputs.get(turn.turn)!} />
                          </div>
                        ) : null}
                      </Fragment>
                    ))}
                  </MessageScroller.Item>
                ))}
                {run.pendingQuestion === null ? null : (
                  <MessageScroller.Item
                    messageId={run.pendingQuestion.id}
                    className="mb-4 min-w-0"
                  >
                    <ClarificationCard run={run} />
                  </MessageScroller.Item>
                )}
                {run.pendingTakeover === null ? null : (
                  <MessageScroller.Item
                    messageId={run.pendingTakeover.id}
                    className="mb-4 min-w-0"
                  >
                    <TakeoverCard run={run} />
                  </MessageScroller.Item>
                )}
                {run.pendingApproval === null ? null : (
                  <MessageScroller.Item
                    messageId={run.pendingApproval.id}
                    className="mb-4 min-w-0"
                  >
                    <ApprovalCard run={run} />
                  </MessageScroller.Item>
                )}
                {run.result === null ? null : (
                  <MessageScroller.Item
                    messageId={`result-${run.runId}`}
                    className="mb-2 min-w-0"
                  >
                    <CompletionMeta run={run} />
                  </MessageScroller.Item>
                )}
                {run.status === "running" ? (
                  <MessageScroller.Item
                    messageId={`working-${run.runId}`}
                    className="mb-2 min-w-0"
                  >
                    <div className="flex items-center gap-2 text-copy-13 text-gray-700">
                      <span className="agent-thinking-dots" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span
                        className="agent-shimmer"
                        data-testid="working-text"
                      >
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

function Welcome({
  activeTab,
  threads,
}: {
  activeTab: BrowserTabInfo | null;
  threads: ThreadListItem[];
}) {
  return (
    <div className="flex flex-1 flex-col justify-end pb-2">
      <div className="agent-orbit mb-5 grid size-12 place-items-center rounded-[18px] bg-gray-100 text-gray-1000 shadow-small">
        <Sparkles className="size-5" aria-hidden="true" />
      </div>
      <h2 className="max-w-[310px] text-[25px] leading-[30px] font-semibold tracking-[-0.035em] text-gray-1000">
        What can I do in your browser?
      </h2>
      <p className="mt-2 max-w-[330px] text-copy-14 text-gray-900">
        I can work across your tabs, use the sessions you’re already signed
        into, and pause whenever you step in.
      </p>
      <div className="mt-5 grid gap-2">
        <PromptSuggestion
          icon={<MousePointerClick />}
          text="Finish the task on this page"
        />
        <PromptSuggestion
          icon={<ListTree />}
          text="Compare information across my open tabs"
        />
        <PromptSuggestion
          icon={<Navigation />}
          text="Find the right page and take me there"
        />
      </div>
      <RecentThreads threads={threads} />
      {activeTab === null ? null : (
        <div className="mt-5 flex items-center gap-2 text-label-12 text-gray-700">
          <span
            className="size-1.5 rounded-full bg-green-700"
            aria-hidden="true"
          />
          Connected to{" "}
          <strong className="max-w-44 truncate font-medium text-gray-900">
            {activeTab.title}
          </strong>
        </div>
      )}
    </div>
  );
}

function PromptSuggestion({
  icon,
  text,
}: {
  icon: React.ReactNode;
  text: string;
}) {
  const start = useAppStore((state) => state.startDelegation);
  return (
    <button
      type="button"
      className="group grid w-full cursor-pointer grid-cols-[28px_1fr_16px] items-center gap-2 rounded-md border border-alpha-400 bg-background-100 px-2.5 py-2.5 text-left outline-none transition-[background-color,border-color,transform] hover:-translate-y-px hover:border-alpha-500 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => void start(text)}
    >
      <span className="grid size-7 place-items-center rounded-sm bg-background-200 text-gray-900 [&_svg]:size-3.5">
        {icon}
      </span>
      <span className="text-label-13 font-medium text-gray-1000">{text}</span>
      <ArrowRight
        className="size-3.5 text-gray-700 transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </button>
  );
}

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
function MessageAttachments({
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

/** Memoized on the message: a publish that did not touch it hands back the same object. */
const MessageRow = memo(function MessageRow({
  message,
  outputs,
  canRetry = false,
}: {
  message: RunSummary["messages"][number];
  /** What the turn this reply finished made: shown as cards under its text. */
  outputs?: readonly AgentToolOutput[] | undefined;
  /** Present on the last reply of a settled thread: the turn can be run again. */
  canRetry?: boolean;
}) {
  const attachments = message.attachments ?? [];
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
      <div className="grid min-w-0 justify-items-end gap-1.5 pl-10">
        {attachments.length === 0 ? null : (
          <MessageAttachments attachments={attachments} align="end" />
        )}
        {message.content === "" ? null : (
          <div className="max-w-[88%] rounded-[17px_17px_4px_17px] bg-gray-1000 px-3.5 py-2.5 text-copy-14 wrap-anywhere whitespace-pre-wrap text-background-100 shadow-small select-text">
            <MessageText text={message.content} />
          </div>
        )}
      </div>
    );
  }
  // The assistant's reply runs the full width: the header already carries
  // the mark, and the user's bubble on the right tells the two voices apart.
  // Its footer holds what a person does with a reply — hear it, copy it,
  // ask for another — and the person's own bubbles carry none.
  return (
    <div className="grid min-w-0 gap-1.5 text-copy-14 wrap-anywhere text-gray-1000">
      {message.content === "" ? null : (
        <div className="whitespace-pre-wrap select-text">
          <MessageText text={message.content} />
        </div>
      )}
      {attachments.length === 0 ? null : (
        <MessageAttachments attachments={attachments} align="start" />
      )}
      {outputs === undefined ? null : (
        <div className="mt-1.5">
          <OutputCards outputs={outputs} />
        </div>
      )}
      {message.content === "" ? null : <MessageActions text={message.content} canRetry={canRetry} />}
    </div>
  );
});

/** How long the copy button shows its check before going back to the icon. */
const COPIED_MS = 1_500;

/**
 * The reply's footer: read aloud, copy, and — on the last reply of a settled
 * thread — retry. Small, always shown, muted until hovered, so a reply reads
 * as text first and controls second.
 */
function MessageActions({ text, canRetry }: { text: string; canRetry: boolean }) {
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
function TaskNotes({ run }: { run: RunSummary }) {
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
const WorkTrace = memo(function WorkTrace({
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

function ClarificationCard({ run }: { run: RunSummary }) {
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

function ApprovalCard({ run }: { run: RunSummary }) {
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
function CompletionMeta({ run }: { run: RunSummary }) {
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

/**
 * Whether the tab in view is a web page the console can attach — the same
 * test main applies (run-controller.ts `pageInView`): the home page and
 * other pistachio:// tabs have nothing to attach.
 */
function isWebPage(tab: BrowserTabInfo | null): tab is BrowserTabInfo {
  if (tab === null || tab.kind !== "human") return false;
  return tab.url.startsWith("https://") || tab.url.startsWith("http://");
}

function Composer({
  run,
  activeTab,
  staged,
  setStaged,
  addFiles,
  rejection,
  reject,
  dismissRejection,
}: {
  run: RunSummary | null;
  activeTab: BrowserTabInfo | null;
  staged: ComposerAttachment[];
  setStaged: React.Dispatch<React.SetStateAction<ComposerAttachment[]>>;
  addFiles: (files: FileList) => Promise<void>;
  rejection: string | null;
  reject: (message: string) => void;
  dismissRejection: () => void;
}) {
  const defaultIntent = useAppStore(
    (state) => state.settings.delegation.defaultIntent,
  );
  const start = useAppStore((state) => state.startDelegation);
  const startCloudRun = useAppStore((state) => state.startCloudRun);
  const cloud = useAppStore((state) => state.cloud);
  const activeSpaceId = useAppStore(
    (state) => state.snapshot?.activeSpaceId ?? null,
  );
  const activeSpaceName = useAppStore(
    (state) =>
      state.snapshot?.spaces.find(
        (space) => space.id === state.snapshot?.activeSpaceId,
      )?.name ?? null,
  );
  const runByDefault = useAppStore((state) => state.settings.cloud.runByDefault);
  const sendMessage = useAppStore((state) => state.sendAgentMessage);
  const interrupt = useAppStore((state) => state.interruptAgent);
  const releaseControl = useAppStore((state) => state.releaseControl);
  const consoleWidth = useAppStore((state) => state.consoleWidth);
  const [value, setValue] = useState(defaultIntent);
  // Where the NEXT task goes. Seeded from the stored preference and kept as
  // the person's answer for this composer afterwards, so a task typed right
  // after flipping it goes where the button says it will.
  const [cloudMode, setCloudMode] = useState(runByDefault);
  /** A cloud run is being created: the send button waits for the answer. */
  const [sending, setSending] = useState(false);
  const [dictation, setDictation] = useState<
    "idle" | "starting" | "recording" | "transcribing"
  >("idle");
  const [levels, setLevels] = useState<number[]>([]);
  const [seconds, setSeconds] = useState(0);
  // The page in view is attached to what is sent unless the person
  // dismisses it with the X on its chip (docs/console-routing.md §5.1).
  // Dismissal belongs to that page: another tab or a navigation attaches
  // the new page again, with nothing to reset.
  const [dismissedPage, setDismissedPage] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const levelRef = useRef(0);
  const live = run !== null && !TERMINAL.has(run.status);
  const running =
    live &&
    run.control === "agent" &&
    !["waiting_for_approval", "waiting_for_judgment", "interrupted"].includes(
      run.status,
    );
  const paused =
    run?.status === "interrupted" || run?.status === "human_control";
  // A cloud run's tabs are in the cloud browser (RunSummary.humanTabId is
  // null), so this Mac's active tab is not its context and must not be
  // presented as one.
  const runsInCloud = run !== null && isCloudRun(run);
  const readiness = cloudReadiness(cloud, activeSpaceId);
  /** Only a fresh conversation can choose: an open one already has an executor. */
  const toCloud = run === null && cloudMode && readiness.ready;
  const pageKey =
    runsInCloud || toCloud || !isWebPage(activeTab)
      ? null
      : `${activeTab.id} ${activeTab.url}`;
  const pageAttached = pageKey !== null && dismissedPage !== pageKey;

  // The preference is what a new composer starts from; changing it in
  // Settings while the console is open moves this one with it.
  useEffect(() => {
    setCloudMode(runByDefault);
  }, [runByDefault]);

  useEffect(() => {
    if (run === null)
      setValue((current) => (current === "" ? defaultIntent : current));
  }, [defaultIntent, run]);

  // The composer grows with its content: one line empty, taller as the message
  // wraps, clamped by its max-h (past that it scrolls). Measured from
  // scrollHeight in a layout effect so the height lands before paint — and
  // re-measured when the panel is resized, since width changes the wrapping.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${String(el.scrollHeight)}px`;
    // `dictation` is a dep because the waveform replaces the textarea while
    // recording; when it comes back it needs its height measured again.
  }, [value, consoleWidth, dictation]);

  // A recording left running when the console unmounts is dropped, not sent.
  useEffect(() => () => recorderRef.current?.cancel(), []);

  // The waveform: the recorder reports loudness ~60×/sec into levelRef; a
  // slower tick samples it into `levels` so the bars scroll at a readable
  // pace instead of re-rendering every frame. The clock rides the same tick.
  useEffect(() => {
    if (dictation !== "recording") return;
    setLevels([]);
    setSeconds(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setSeconds((Date.now() - startedAt) / 1000);
      setLevels((prev) => [...prev.slice(1 - WAVE_BARS), levelRef.current]);
    }, 80);
    return () => window.clearInterval(timer);
  }, [dictation]);

  // Dictation lands in the textarea as text, joining whatever was typed —
  // the user reads it back and sends it themselves. Failures surface in the
  // composer's rejection banner, same as a refused attachment.
  const finishDictation = async () => {
    const current = recorderRef.current;
    if (current === null) return;
    recorderRef.current = null;
    setDictation("transcribing");
    try {
      const recording = await current.stop();
      if (recording.seconds < 0.8) {
        reject(
          "That was too short to hear — tap the mic and speak, then tap again to stop.",
        );
        return;
      }
      const data = await blobToBase64(recording.blob);
      const transcript = (
        await shellApi().transcribeSpeech({
          data,
          mediaType: recording.mediaType.split(";")[0] ?? "audio/webm",
        })
      ).trim();
      if (transcript !== "")
        setValue((prev) =>
          prev.trim() === "" ? transcript : `${prev.trimEnd()} ${transcript}`,
        );
    } catch (caught) {
      reject(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDictation("idle");
      inputRef.current?.focus({ preventScroll: true });
    }
  };

  const startDictation = async () => {
    dismissRejection();
    setDictation("starting");
    try {
      // Only a native window has an OS permission dialog to raise; on a
      // stream surface the browser asks for the microphone itself.
      const allowed = (await nativeApi()?.requestMicrophone()) ?? true;
      if (!allowed) {
        reject(
          "Pistachio needs the microphone for this. Allow it in System Settings → Privacy & Security → Microphone.",
        );
        setDictation("idle");
        return;
      }
      recorderRef.current = await startRecording({
        onLevel: (level) => {
          levelRef.current = level;
        },
        maxSeconds: MAX_DICTATION_SECONDS,
        onAutoStop: () => void finishDictation(),
      });
      setDictation("recording");
    } catch (caught) {
      reject(
        caught instanceof Error && caught.name === "NotAllowedError"
          ? "The microphone was refused. Allow it in System Settings → Privacy & Security → Microphone."
          : `Couldn't start the microphone (${caught instanceof Error ? caught.message : String(caught)}).`,
      );
      setDictation("idle");
    }
  };

  // An attachment alone is a sendable turn — "what about this?" implied.
  const empty = value.trim() === "" && staged.length === 0;

  const submit = () => {
    // The button is disabled while a send is in flight, but the Enter key is
    // not: on the cloud path the composer stays populated until the run
    // exists, so a second Enter would start a second run for the same task.
    if (empty || sending) return;
    // Text files fold into the body so every model reads them and the
    // transcript shows what was sent; images and PDFs travel as attachments.
    const blocks = [
      value.trim(),
      ...staged.flatMap((file) => {
        if (file.kind === "text")
          return [formatAttachmentText(file.name, file.text ?? "")];
        if (file.kind === "selection")
          return [formatSelectionText(file.name, file.url, file.text ?? "")];
        return [];
      }),
    ].filter((block) => block !== "");
    const content = blocks.join("\n\n");
    const attachments = toAgentAttachments(staged);
    dismissRejection();
    // The cloud path clears the composer only once the run exists; the two
    // local paths hand off to main, which cannot refuse them from here.
    if (toCloud && run === null) {
      void startInCloud(content, attachments);
      return;
    }
    setValue("");
    setStaged([]);
    // A finished thread is still a conversation: a follow-up continues it
    // with its history intact rather than starting a new task. Main routes a
    // message to a cloud run through the control plane by itself.
    const options = { page: pageAttached };
    if (run !== null) void sendMessage(content, attachments, options);
    else void start(content, attachments, options);
  };

  /**
   * Hand the task to the cloud browser. Main fills in the Space and the
   * start address from what is active here (§10.4), so the intent and its
   * attachments are all this has to send.
   *
   * This is the one send that can be refused where it stands — the Space
   * lost its key, control is unreachable — so the composer keeps what was
   * typed until the control plane has actually taken it, and shows the
   * refusal in its own banner rather than the shell's error toast.
   */
  const startInCloud = async (
    content: string,
    attachments: AgentAttachment[],
  ) => {
    setSending(true);
    const result = await startCloudRun({
      intent: content,
      ...(attachments.length === 0 ? {} : { attachments }),
    });
    setSending(false);
    if (!result.ok) {
      reject(result.error);
      return;
    }
    setValue("");
    setStaged([]);
  };

  return (
    <footer className="min-w-0 border-t border-alpha-400 bg-background-100 px-3 pb-3 pt-2.5">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-gray-700">
          {runsInCloud || toCloud ? (
            <Cloud className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <Globe2 className="size-3 shrink-0" aria-hidden="true" />
          )}
          <span
            className={cn(
              "truncate",
              pageKey !== null && !pageAttached && "text-gray-600 line-through",
            )}
            data-testid="composer-context"
            data-page-attached={pageAttached ? "true" : "false"}
            title={
              pageKey === null
                ? undefined
                : pageAttached
                  ? `${activeTab?.url ?? ""} is attached: questions are about this page`
                  : "Not attached: this message is not about the page"
            }
          >
            {runsInCloud
              ? `Cloud browser${activeSpaceName === null ? "" : ` · ${activeSpaceName}`}`
              : toCloud
                ? `Runs in the cloud${activeSpaceName === null ? "" : ` · ${activeSpaceName}`}`
                : (activeTab?.title ?? "No active tab")}
          </span>
          {pageKey === null ? null : pageAttached ? (
            <button
              type="button"
              data-testid="composer-context-dismiss"
              title="Don't attach this page"
              aria-label="Don't attach this page"
              onClick={() => setDismissedPage(pageKey)}
              className="grid size-4 shrink-0 cursor-pointer place-items-center rounded-xs text-gray-700 hover:bg-alpha-200 hover:text-gray-1000"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              data-testid="composer-context-attach"
              onClick={() => setDismissedPage(null)}
              className="shrink-0 cursor-pointer rounded-xs px-1 font-medium text-gray-900 hover:bg-alpha-200"
            >
              Attach
            </button>
          )}
        </div>
        {/* Connection now reads off the header dot; only the action stays. */}
        {paused ? (
          <button
            type="button"
            className="flex cursor-pointer items-center gap-1 text-[11px] font-medium text-blue-900"
            onClick={() => void releaseControl()}
          >
            <RotateCcw className="size-3" aria-hidden="true" /> Resume
          </button>
        ) : null}
      </div>
      {rejection === null ? null : (
        <div
          role="status"
          data-testid="attachment-rejection"
          className="mb-2 flex items-start gap-1.5 rounded-md bg-amber-100 px-2 py-1.5 text-[11px] leading-4 text-amber-900"
        >
          <span className="min-w-0 flex-1">{rejection}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={dismissRejection}
            className="shrink-0 cursor-pointer rounded-xs p-0.5 hover:bg-amber-400"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </div>
      )}
      {staged.length === 0 ? null : (
        <div
          className="mb-2 flex flex-wrap items-end gap-2"
          data-testid="staged-attachments"
        >
          {staged.map((file) => (
            <span key={file.id} className="group/chip relative">
              {file.kind === "image" ? (
                <img
                  src={file.url}
                  alt={file.name}
                  title={file.name}
                  draggable={false}
                  className="block h-12 w-auto max-w-24 rounded-sm object-cover shadow-border"
                />
              ) : file.kind === "selection" ? (
                <span
                  title={
                    file.name === "" ? file.text : `Selected on ${file.name}`
                  }
                  data-testid="staged-selection"
                  className="flex h-8 max-w-48 items-center gap-1.5 rounded-sm bg-background-200 px-2 text-label-12 text-gray-900 shadow-border"
                >
                  <TextQuote
                    className="size-3 shrink-0 text-gray-700"
                    aria-hidden="true"
                  />
                  <span className="truncate">
                    {selectionChipLabel(file.text ?? "")}
                  </span>
                </span>
              ) : (
                <span
                  title={file.name}
                  className="flex h-8 max-w-40 items-center gap-1.5 rounded-sm bg-background-200 px-2 text-label-12 text-gray-900 shadow-border"
                >
                  <FileText
                    className="size-3 shrink-0 text-gray-700"
                    aria-hidden="true"
                  />
                  <span className="truncate">{file.name}</span>
                </span>
              )}
              <button
                type="button"
                title="Remove file"
                aria-label={
                  file.kind === "selection"
                    ? "Remove selection"
                    : `Remove ${file.name}`
                }
                onClick={() =>
                  setStaged((prev) =>
                    prev.filter((entry) => entry.id !== file.id),
                  )
                }
                className="absolute -top-1.5 -right-1.5 grid size-4 cursor-pointer place-items-center rounded-full bg-gray-1000 text-background-100 opacity-0 transition-opacity group-hover/chip:opacity-100 focus-visible:opacity-100"
              >
                <X className="size-2.5" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="agent-composer rounded-[14px] border border-alpha-500 bg-background-100 p-1.5 shadow-small focus-within:border-gray-700 focus-within:shadow-[0_0_0_3px_var(--color-alpha-200)]">
        {dictation === "idle" ? (
          <Textarea
            ref={inputRef}
            id="delegation-intent"
            data-testid="delegation-intent"
            aria-label={live ? "Steer the agent" : "Message the agent"}
            placeholder={
              live
                ? "Steer the agent…"
                : run !== null
                  ? "Follow up in this conversation…"
                  : "Ask Pistachio to do anything in your browser…"
            }
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            className="scroll-thin max-h-32 overflow-y-auto px-2 py-1.5"
            variant="bare"
            rows={1}
          />
        ) : (
          <div
            data-testid="dictation-waveform"
            role="img"
            aria-label={
              dictation === "recording"
                ? `Recording · ${dictationClock(seconds)}`
                : dictation === "transcribing"
                  ? "Transcribing what you said"
                  : "Getting the microphone"
            }
            className={cn(
              "flex h-[38px] items-center gap-2 px-2 text-gray-1000",
              dictation !== "recording" && "opacity-50",
            )}
          >
            <div className="flex min-w-0 flex-1 items-center justify-end gap-[3px] overflow-hidden">
              {levels.length === 0 ? (
                <span className="h-[3px] w-full rounded-full bg-alpha-400" />
              ) : (
                levels.map((level, index) => (
                  <span
                    key={index}
                    className="w-[3px] shrink-0 rounded-full bg-current transition-[height] duration-100"
                    style={{
                      height: `${String(Math.max(3, Math.round(level * 26)))}px`,
                    }}
                  />
                ))
              )}
            </div>
            <span className="shrink-0 text-label-12 text-gray-700 tabular-nums">
              {dictationClock(seconds)}
            </span>
          </div>
        )}
        <div className="flex items-center justify-between px-0.5 pb-0.5">
          <div className="flex items-center gap-1">
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              data-testid="attach-input"
              onChange={(event) => {
                const files = event.currentTarget.files;
                if (files !== null && files.length > 0) void addFiles(files);
                event.currentTarget.value = "";
              }}
            />
            <Button
              variant="tertiary"
              size="xs"
              svgOnly
              aria-label="Attach files"
              data-testid="attach-button"
              onClick={() => fileRef.current?.click()}
            >
              <Paperclip aria-hidden="true" />
            </Button>
            {cloud.available ? (
              <Button
                variant={toCloud ? "secondary" : "tertiary"}
                size="xs"
                aria-pressed={toCloud}
                aria-label="Run in cloud"
                disabled={run !== null || !readiness.ready}
                title={
                  run !== null
                    ? runsInCloud
                      ? "This conversation is already running in the cloud browser."
                      : "This conversation runs on this Mac. Start a new one to run in the cloud."
                    : (readiness.reason ??
                      "New tasks run in the cloud browser, in its own copy of this Space's sessions.")
                }
                data-testid="run-in-cloud"
                prefix={<Cloud aria-hidden="true" />}
                onClick={() => setCloudMode((current) => !current)}
              >
                Cloud
              </Button>
            ) : null}
            <Button
              variant="tertiary"
              size="xs"
              svgOnly
              aria-label={
                dictation === "recording" ? "Stop dictation" : "Dictate message"
              }
              data-testid="dictate-button"
              disabled={
                dictation === "starting" || dictation === "transcribing"
              }
              className={
                dictation === "recording"
                  ? "text-red-900 hover:text-red-900"
                  : undefined
              }
              onClick={() => {
                if (dictation === "recording") void finishDictation();
                else if (dictation === "idle") void startDictation();
              }}
            >
              {dictation === "transcribing" ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : dictation === "recording" ? (
                <Square className="fill-current" aria-hidden="true" />
              ) : (
                <Mic aria-hidden="true" />
              )}
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            {running ? (
              <Button
                variant="secondary"
                size="xs"
                svgOnly
                aria-label="Interrupt agent"
                data-testid="interrupt-button"
                onClick={() => void interrupt()}
              >
                <Square className="fill-current" aria-hidden="true" />
              </Button>
            ) : null}
            <Button
              size="xs"
              shape="circle"
              svgOnly
              aria-label="Send message"
              data-testid="delegate-button"
              disabled={empty || sending}
              loading={sending}
              onClick={submit}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
      {live ? (
        <div className="mt-2 flex justify-center">
          <button
            type="button"
            className="flex cursor-pointer items-center gap-1 text-[11px] text-gray-700 hover:text-red-900"
            onClick={() => void useAppStore.getState().revokeRun()}
          >
            <CircleStop className="size-3" aria-hidden="true" />{" "}
            {endTaskLabel(run)}
          </button>
        </div>
      ) : null}
    </footer>
  );
}

function EvidenceReplay({
  entries,
  onClose,
}: {
  entries: EvidenceEntry[];
  onClose(): void;
}) {
  const showPayloads = useAppStore(
    (state) => state.settings.evidence.showPayloads,
  );
  return (
    <div
      data-testid="evidence-replay"
      className="scroll-thin min-h-0 overflow-y-auto px-4 py-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="text-label-12 font-medium text-gray-700">
            Activity record
          </span>
          <h2 className="mt-1 text-heading-20 text-gray-1000">
            Conversation replay
          </h2>
        </div>
        <Button
          variant="tertiary"
          size="sm"
          svgOnly
          aria-label="Close replay"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <p className="mt-2 mb-4 text-copy-13 text-gray-900">
        A signed timeline of the messages, browser actions, decisions, and
        control changes in this task.
      </p>
      <ol className="grid">
        {entries.map((entry, index) => (
          <li
            key={entry.id}
            className="relative grid grid-cols-[24px_1fr] gap-2.5 py-2.5"
          >
            {index < entries.length - 1 ? (
              <span
                aria-hidden="true"
                className="absolute top-8 -bottom-2 left-3 w-px bg-alpha-400"
              />
            ) : null}
            <span className="relative z-1 grid size-6 place-items-center rounded-full bg-background-100 font-mono text-[10px] font-medium tabular-nums text-gray-900 shadow-border">
              {String(entry.sequence).padStart(2, "0")}
            </span>
            <div className="min-w-0">
              <strong className="block text-label-12 font-medium text-gray-1000">
                {entry.type}
              </strong>
              <small className="font-mono text-[10px] text-gray-700">
                {formatTime(entry.at)} · {entry.hash.slice(0, 10)}…
              </small>
              {showPayloads ? (
                <pre className="scroll-thin mt-1.5 max-h-24 overflow-auto rounded-sm bg-background-200 p-2 font-mono text-[10px] leading-4 whitespace-pre-wrap text-gray-900 shadow-border">
                  {JSON.stringify(entry.payload, null, 2)}
                </pre>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// One formatter for the module: building one per call is the expensive part.
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function formatTime(value: string): string {
  return TIME_FORMAT.format(new Date(value));
}
