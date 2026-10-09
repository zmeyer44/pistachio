import { TakeoverCard } from "./TakeoverCard";
import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { MessageScroller } from "@shadcn/react/message-scroller";
import {
  AlarmClock,
  ArrowDown,
  ArrowRight,
  CircleStop,
  Cloud,
  FileClock,
  FileText,
  Globe2,
  ListTree,
  Loader2,
  Mic,
  Monitor,
  MousePointerClick,
  Navigation,
  PanelRightClose,
  Paperclip,
  RotateCcw,
  ArrowUp,
  Sparkles,
  SquarePen,
  TextQuote,
  Square,
  X,
} from "lucide-react";
import type { EvidenceEntry } from "@pistachio/evidence";
import type {
  AgentAttachment,
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
  toAgentAttachments,
  type ComposerAttachment,
} from "../lib/chat-attachments";
import { cn } from "../lib/cn";
import { blobToBase64, startRecording, type Recorder } from "../lib/recorder";
import {
  agentIsActing,
  contextMeter,
  endTaskLabel,
  runHeadline,
  statusIndicator,
  statusLabel,
} from "../lib/run";
import { cloudReadiness, isCloudRun } from "../lib/cloud";
import { selectActiveTab, useAppStore } from "../store";
import { AttachmentDropVeil, useAttachmentDrop } from "./chat/attachment-drop";
import { LiveReply } from "./chat/LiveReply";
import { useThreadLayout } from "./chat/use-thread-layout";
import {
  ApprovalCard,
  ClarificationCard,
  CompletionMeta,
  MessageRow,
  TERMINAL,
  TaskNotes,
  WorkTrace,
  formatTime,
} from "./chat/parts";
import { FeedbackPopover } from "./FeedbackPopover";
import { OutputCards } from "./OutputCard";
import { PanelShell } from "./PanelShell";
import { PistachioMark } from "./PistachioMark";
import { ReminderInbox } from "./reminders/ReminderInbox";
import { TONE_DOT } from "./StatusDot";
import { RecentThreads, ThreadListPopover } from "./ThreadList";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { nativeApi, shellApi } from "../api";

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
  const drop = useConsoleAttachments();

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
          {drop.dragging ? (
            <AttachmentDropVeil data-testid="attachment-drop-veil" />
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

/** The console's field, found by id: the Composer below owns it. */
function focusIntent(): void {
  document.getElementById("delegation-intent")?.focus({ preventScroll: true });
}

/**
 * Files dropped anywhere on the panel, staged for the next message
 * (chat/attachment-drop.tsx) — and the page's "Add … to Chat" items too.
 */
function useConsoleAttachments() {
  const drop = useAttachmentDrop(focusIntent);
  const { staged, setStaged, reject } = drop;
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
    if (inbox.rejection !== null) reject(inbox.rejection);
    else if (accepted.length < inbox.inserts.length)
      reject(
        `At most ${String(MAX_COMPOSER_ATTACHMENTS)} files per message`,
      );
    if (accepted.length > 0)
      setStaged((prev) => [
        ...prev,
        ...accepted.map(composerAttachmentFromInsert),
      ]);
    focusIntent();
  }, [chatInbox, staged.length, takeChatInbox, reject, setStaged]);

  return drop;
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
  const { tracesAt, outputsAt, pendingOutputs, sourcesAt, pendingSources } = useThreadLayout(run);
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
                      sources={sourcesAt.get(index)}
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
                    <LiveReply
                      run={run}
                      sources={pendingSources}
                      density="panel"
                      trailing={
                        <span
                          data-testid="context-meter"
                          className="ml-auto shrink-0 text-[11px] text-gray-700 tabular-nums"
                        >
                          {contextMeter(run.context)}
                        </span>
                      }
                    />
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
                      "New tasks run in the cloud browser, in its own copy of this Profile's sessions.")
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

